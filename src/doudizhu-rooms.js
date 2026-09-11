import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { atomicWriteJson } from './json-file-store.js';
import { DoudizhuService } from './doudizhu-service.js';

const SEATS = ['aurex', 'aevi', 'vex']; // Referee seat keys, never guest identities.
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (key, status = 403) => { throw Object.assign(new Error(key), { status, code: key }); };
async function read(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function nickname(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 12 || /[\x00-\x1f\x7f]/.test(value)) fail('NICKNAME_INVALID', 400);
  return value.trim();
}

// One transport boundary owns guest credentials and room membership; the referee owns all game state.
export class DoudizhuRooms {
  constructor({ rootDir, dataDir }) {
    this.rootDir = rootDir;
    this.dataDir = dataDir;
    this.games = new Map();
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.readyPromise = this.initialize();
  }
  async initialize() {
    this.sessions = await read(path.join(this.dataDir, 'guests.json'), {});
    const registry = await read(path.join(this.dataDir, 'rooms.json'), null);
    this.records = registry?.rooms || {};
    this.legacyUnowned = registry ? registry.legacyUnowned : Boolean(await read(path.join(this.dataDir, 'state.json'), null));
    await this.saveRooms();
    this.classic = new DoudizhuService({ rootDir: this.rootDir, dataDir: this.dataDir });
    if (this.classic.modelAdapter) this.classic.modelAdapter.isConnected = () => false;
    await this.classic.ready();
    if (this.classic.state.match?.mode !== 'official') await this.classic.stopModelMatch();
    for (const room of Object.values(this.records)) if (!room.closed) await this.loadGame(room);
  }
  ready() { return this.readyPromise; }
  // ponytail: one membership queue for this small single-process service; shard only if measured contention requires it.
  serial(operation) {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }
  saveRooms(records = this.records) { return atomicWriteJson(path.join(this.dataDir, 'rooms.json'), { version: 1, legacyUnowned: this.legacyUnowned, rooms: records }); }
  async commitRoom(room) {
    const next = { ...this.records, [room.code]: room };
    await this.saveRooms(next);
    this.records = next;
  }
  async guest(token) {
    await this.ready();
    if (token) return { id: this.authenticate(token) };
    return this.serial(async () => {
      const secret = randomBytes(32).toString('base64url');
      const id = randomUUID();
      this.sessions[hash(secret)] = { id, expires: Date.now() + 30 * 86400000 };
      try { await atomicWriteJson(path.join(this.dataDir, 'guests.json'), this.sessions); }
      catch (error) { delete this.sessions[hash(secret)]; throw error; }
      return { id, token: secret };
    });
  }
  authenticate(token) {
    const session = typeof token === 'string' && this.sessions[hash(token)];
    if (!session || session.expires <= Date.now()) fail('SESSION_INVALID', 401);
    return session.id;
  }
  requireGuest(id) {
    if (!Object.values(this.sessions).some(s => s.id === id && s.expires > Date.now())) fail('SESSION_INVALID', 401);
  }
  list(id) {
    this.requireGuest(id);
    return Object.values(this.records).filter(room => !room.closed).flatMap(room => {
      const member = Object.values(room.seats).find(seat => seat.guest === id);
      return member ? [{ code: room.code, kind: room.kind, nickname: member.nickname }] : [];
    });
  }
  room(code) {
    if (typeof code !== 'string' || !/^[A-F0-9]{12}$/.test(code) || !Object.hasOwn(this.records, code)) fail('ROOM_NOT_FOUND', 404);
    const room = this.records[code];
    if (room.closed) fail('ROOM_CLOSED', 410);
    return room;
  }
  async loadGame(room) {
    const game = room.kind === 'classic' ? this.classic : new DoudizhuService({
      rootDir: this.rootDir, dataDir: path.join(this.dataDir, 'rooms', room.code),
      humanSeats: Object.keys(room.seats),
    });
    await game.ready();
    this.games.set(room.code, game);
    this.configure(room, game);
    game.onBroadcast(() => { for (const listener of this.listeners) listener(room.code); });
    return game;
  }
  configure(room, game) {
    if (room.kind === 'friends') for (const player of game.players) {
      if (SEATS.includes(player.id)) player.kind = room.seats[player.id] ? 'human' : 'cmd';
    }
    for (const [seat, member] of Object.entries(room.seats)) game.profiles.players[seat].name = member.nickname;
  }
  async create(id, options = {}) {
    this.requireGuest(id);
    const name = nickname(options.nickname);
    if (!['friends', 'classic'].includes(options.kind)) fail('ROOM_KIND_INVALID', 400);
    return this.serial(async () => {
      if (options.kind === 'classic') {
        if (this.legacyUnowned) fail('CLASSIC_OWNER_SETUP_REQUIRED');
        if (Object.values(this.records).some(r => r.kind === 'classic')) fail('CLASSIC_ALREADY_ASSIGNED');
      }
      if (Object.values(this.records).filter(r => !r.closed && r.owner === id).length >= 8) fail('ROOM_LIMIT', 409);
      let code;
      do { code = randomBytes(6).toString('hex').toUpperCase(); } while (this.records[code]);
      const room = { code, kind: options.kind, owner: id, seats: { aurex: { guest: id, nickname: name, left: false } }, closed: false };
      const game = await this.loadGame(room);
      try { await this.commitRoom(room); } catch (error) { game.clearTimers(); this.games.delete(code); throw error; }
      return { code };
    });
  }
  async join(id, code, options = {}) {
    this.requireGuest(id);
    const name = nickname(options.nickname);
    return this.serial(async () => {
      const room = structuredClone(this.room(code)), game = this.games.get(code);
      let seat = Object.keys(room.seats).find(s => room.seats[s].guest === id);
      if (!seat) {
        if (room.kind === 'classic') fail('ROOM_FORBIDDEN');
        if (game.state.phase !== 'lobby') fail('ROOM_ALREADY_STARTED', 409);
        seat = SEATS.find(s => !room.seats[s]);
        if (!seat) fail('ROOM_FULL', 409);
      }
      room.seats[seat] = { guest: id, nickname: name, left: false };
      await this.commitRoom(room);
      this.configure(room, game);
      game.broadcast();
      return { code };
    });
  }
  binding(id, code) {
    this.requireGuest(id);
    const room = this.room(code);
    const seat = Object.keys(room.seats).find(s => room.seats[s].guest === id && !room.seats[s].left);
    if (!seat) fail('ROOM_FORBIDDEN');
    return { room, seat, game: this.games.get(code) };
  }
  snapshot(id, code) {
    const { room, seat, game } = this.binding(id, code);
    const view = game.publicSnapshot(seat);
    const owner = room.owner === id;
    view.tableId = code;
    view.selfSeat = seat;
    view.room = { code, kind: room.kind, isOwner: owner };
    // Adapter diagnostics can contain private model output; keep them in the private game archive.
    view.feed = view.feed.map(({ detail, ...event }) => event);
    if (room.kind === 'friends') view.players = view.players.filter(p => SEATS.includes(p.id));
    view.players = view.players.map(p => ({ ...p,
      seatIndex: (p.seatIndex - SEATS.indexOf(seat) + 3) % 3,
      avatar: p.avatar?.startsWith('/api/') ? p.avatar + '&room=' + code : p.avatar,
      ...(room.seats[p.id] ? { name: room.seats[p.id].nickname, present: !room.seats[p.id].left } : {}),
    }));
    view.controls.canStartNextRound &&= owner;
    view.controls.canReturnLobby &&= owner;
    if (room.kind === 'friends') view.controls.canDissolve = false;
    return view;
  }
  async action(id, code, message) {
    return this.serial(async () => {
      const { room, seat, game } = this.binding(id, code);
      if (!message || typeof message !== 'object' || Array.isArray(message)) fail('ACTION_INVALID', 400);
      if (['player_id', 'actorId', 'actor_id', 'seat', 'seat_id', 'selfSeat', 'room', 'room_id', 'roomId', 'guest_id'].some(k => k in message) || ('playerId' in message && message.type !== 'update_profile')) fail('IDENTITY_OVERRIDE');
      const owner = room.owner === id;
      if (['start_match', 'start_next_round', 'return_lobby', 'stop_model_match', 'request_dissolve', 'set_theme'].includes(message.type) && !owner) fail('OWNER_REQUIRED');
      if (room.kind === 'friends' && ['stop_model_match', 'request_dissolve'].includes(message.type)) fail('ACTION_NOT_AVAILABLE', 400);
      if (message.type === 'update_profile') {
        if (message.playerId !== seat && !(room.kind === 'classic' && owner && ['aevi','vex','juhua','chatgpt'].includes(message.playerId))) fail('SEAT_FORBIDDEN');
        if (message.name !== undefined && room.seats[message.playerId]) {
          const next = structuredClone(room);
          next.seats[message.playerId].nickname = nickname(message.name);
          await this.commitRoom(next);
        }
      }
      let payload = message;
      if (room.kind === 'friends' && message.type === 'start_match') {
        payload = { type: 'start_match', totalRounds: message.totalRounds, aiPlayers: ['aevi','vex'], mode: 'local' };
      }
      // Check turn versions inside the referee queue, so timer expiry cannot race the check.
      await game.handleClientMessage(payload, seat, () => {
        this.binding(id, code);
        if (['bid','play','pass'].includes(message.type) && (message.match_id !== game.state.match?.id || message.turn_id !== game.state.timer?.token)) fail('STALE_TURN', 409);
      });
      return this.snapshot(id, code);
    });
  }
  async leave(id, code) {
    return this.serial(async () => {
      const { room, seat, game } = this.binding(id, code);
      // Reserve the human seat. No bot takeover and no match/official-lease termination.
      const next = structuredClone(room);
      next.seats[seat].left = true;
      await this.commitRoom(next);
      game.broadcast();
      return { code };
    });
  }
  async end(id, code) {
    return this.serial(async () => {
      const { room, game } = this.binding(id, code);
      if (room.owner !== id) fail('OWNER_REQUIRED');
      if (room.kind === 'classic') fail('USE_CLASSIC_STOP', 400);
      await game.enqueue(async () => {
        await this.commitRoom({ ...room, closed: true });
        game.suspended = true;
        game.clearTimers();
        game.broadcast();
      });
      return { code };
    });
  }
  onBroadcast(listener) { this.listeners.add(listener); }
  close() {
    for (const game of new Set([this.classic, ...this.games.values()])) if (game) {
      game.suspended = true;
      game.clearTimers();
      clearTimeout(game.officialLeaseTimer);
    }
  }
}
