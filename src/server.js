import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { DoudizhuRooms } from "./doudizhu-rooms.js";
import { startMcpServer } from "./doudizhu-mcp.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.resolve(process.env.DOUDIZHU_DATA_DIR || path.join(rootDir, "data/doudizhu"));
const host = process.env.HOST || "127.0.0.1";
const port = Math.max(1, Number(process.env.PORT) || 8788);
const maxBodyBytes = 3 * 1024 * 1024; // 2 MiB avatar plus base64 and JSON overhead.

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
]);

const rooms = new DoudizhuRooms({ rootDir, dataDir });
await rooms.ready();
const doudizhu = rooms.classic;
const mcpServer = process.env.DOUDIZHU_MCP_PORT
  ? await startMcpServer(doudizhu, Number(process.env.DOUDIZHU_MCP_PORT)) : null;

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function sendOk(res, data, status = 200) {
  sendJson(res, status, { ok: true, data });
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

async function sendStatic(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded === "/doudizhu" || decoded === "/doudizhu/") decoded = "/doudizhu/index.html";
  const relative = decoded.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relative);
  const publicPrefix = `${path.resolve(publicDir)}${path.sep}`;
  if (!filePath.startsWith(publicPrefix)) return false;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    const body = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const immutable = /\/assets\//.test(decoded);
    res.writeHead(200, {
      "content-type": contentTypes.get(extension) || "application/octet-stream",
      "content-length": body.length,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/doudizhu/health") {
      return sendOk(res, { service: 'doudizhu', ok: true });
    }
    checkOrigin(req);
    if (req.method === 'POST' && url.pathname === '/api/doudizhu/guest') {
      const guest = await rooms.guest(cookieToken(req));
      if (guest.token) res.setHeader('set-cookie', 'ddz_guest=' + guest.token + '; HttpOnly; SameSite=Strict; Path=/api/doudizhu; Max-Age=2592000' + (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));
      return sendOk(res, { id: guest.id });
    }
    const guestId = rooms.authenticate(cookieToken(req));
    const code = url.searchParams.get('room');
    // URL parameters select a room only; viewer/actor overrides have no legitimate consumer.
    if ([...url.searchParams.keys()].some(key => !['room', 'v'].includes(key))) throw Object.assign(new Error('IDENTITY_OVERRIDE'), {status:403, code:'IDENTITY_OVERRIDE'});
    if (req.method === 'GET' && url.pathname === '/api/doudizhu/rooms') return sendOk(res, rooms.list(guestId));
    if (req.method === 'POST' && url.pathname === '/api/doudizhu/rooms') return sendOk(res, await rooms.create(guestId, await readJsonBody(req)), 201);
    if (req.method === 'POST' && url.pathname === '/api/doudizhu/join') return sendOk(res, await rooms.join(guestId, code, await readJsonBody(req)));
    if (req.method === 'POST' && url.pathname === '/api/doudizhu/leave') return sendOk(res, await rooms.leave(guestId, code));
    if (req.method === 'POST' && url.pathname === '/api/doudizhu/end') return sendOk(res, await rooms.end(guestId, code));
    if (req.method === "GET" && url.pathname === "/api/doudizhu/state") {
      return sendOk(res, rooms.snapshot(guestId, code));
    }
    if (req.method === "POST" && url.pathname === "/api/doudizhu/action") {
      return sendOk(res, await rooms.action(guestId, code, await readJsonBody(req)));
    }
    const avatarMatch = url.pathname.match(/^\/api\/doudizhu\/avatar\/([a-z0-9_-]+)$/i);
    if (req.method === "GET" && avatarMatch) {
      const avatar = await rooms.binding(guestId, code).game.avatarFile(avatarMatch[1]);
      if (!avatar) return sendError(res, 404, "AVATAR_NOT_FOUND", "头像不存在");
      res.writeHead(200, {
        "content-type": avatar.type,
        "content-length": avatar.data.length,
        "cache-control": "no-store",
      });
      res.end(avatar.data);
      return;
    }
    return sendError(res, 404, "NOT_FOUND", "斗地主接口不存在");
  } catch (error) {
    return sendError(res, error.status || 400, error.code || "DOUDIZHU_ACTION_FAILED", error.code || error.message || "ACTION_FAILED");
  }
}

function cookieToken(req) {
  const tokens = String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith('ddz_guest='));
  if (tokens.length > 1) throw Object.assign(new Error('SESSION_INVALID'), {status:401, code:'SESSION_INVALID'});
  return tokens[0]?.slice('ddz_guest='.length);
}
function checkOrigin(req) {
  if (req.headers.origin) {
    let valid = false;
    try { const origin = new URL(req.headers.origin); valid = ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host; } catch {}
    if (!valid) throw Object.assign(new Error('ORIGIN_DENIED'), {status:403, code:'ORIGIN_DENIED'});
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('ORIGIN_DENIED'), {status:403, code:'ORIGIN_DENIED'});
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/") {
    res.writeHead(302, { location: "/doudizhu/" });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/api/doudizhu/")) return handleApi(req, res, url);
  if (req.method === "GET" || req.method === "HEAD") {
    if (await sendStatic(res, url.pathname)) return;
  }
  sendError(res, 404, "NOT_FOUND", "页面不存在");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
if (doudizhu.modelAdapter) doudizhu.modelAdapter.isConnected = () => [...wss.clients].some(client => client.readyState === WebSocket.OPEN && rooms.games.get(client.roomCode) === doudizhu);

function sendSocket(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

wss.on("connection", async (ws) => {
  ws.on("close", () => {
    if (rooms.records[ws.roomCode]?.seats.aurex?.left) return;
    if (rooms.games.get(ws.roomCode) === doudizhu && ![...wss.clients].some(client => client.readyState === WebSocket.OPEN && client.roomCode === ws.roomCode)) void doudizhu.enqueue(() => {
      if (doudizhu.state.match?.mode !== 'official') return doudizhu.stopModelMatch();
    });
  });
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", async (raw) => {
    try {
      const guestId = rooms.authenticate(ws.guestToken);
      await rooms.action(guestId, ws.roomCode, JSON.parse(raw.toString("utf8")));
    } catch (error) {
      sendSocket(ws, { type: "error", error: error.code || error.message || "ACTION_FAILED" });
    }
  });
  sendPrivate(ws);
});

function sendPrivate(client) {
  try { sendSocket(client, { type: 'snapshot', data: rooms.snapshot(rooms.authenticate(client.guestToken), client.roomCode) }); }
  catch (error) { sendSocket(client, {type:'error', error:error.code || 'SESSION_INVALID'}); client.close(1008); }
}
rooms.onBroadcast((code) => {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.roomCode === code) sendPrivate(client);
  }
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/doudizhu/ws") return socket.destroy();
    checkOrigin(req);
    if ([...url.searchParams.keys()].some(key => key !== 'room')) throw new Error('IDENTITY_OVERRIDE');
    const token = cookieToken(req), code = url.searchParams.get('room');
    rooms.binding(rooms.authenticate(token), code);
    wss.handleUpgrade(req, socket, head, (ws) => { ws.guestToken = token; ws.roomCode = code; wss.emit("connection", ws, req); });
  } catch {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  }
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30_000);
heartbeat.unref?.();

server.listen(port, host, () => {
  console.log(`Aevi 家庭斗地主已启动：http://${host}:${port}/doudizhu/`);
});

function shutdown() {
  rooms.close();
  mcpServer?.close();
  mcpServer?.closeAllConnections();
  clearInterval(heartbeat);
  for (const client of wss.clients) client.close(1001, "server shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
