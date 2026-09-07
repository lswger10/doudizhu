import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DoudizhuService } from '../src/doudizhu-service.js';
import { startMcpServer } from '../src/doudizhu-mcp.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddz-mcp-'));
const adapter = { async decide() { throw new Error('No live provider in test'); }, cancel() {} };
const game = new DoudizhuService({dataDir: dir, adapter, modelAdapter: adapter});
const client = new Client({name: 'seat-test', version: '1.0.0'});
let server;
try {
  await game.ready();
  server = await startMcpServer(game, 0);
  assert.equal(server.address().address, '127.0.0.1');
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url));
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['interact_table','join_table','leave_table','read_turn','submit_action','wait_for_event']);
  assert.equal(tools.find(t => t.name === 'submit_action').annotations.readOnlyHint, false);
  const invoke = (name, args = {}) => client.callTool({name, arguments: args});
  const joined = await invoke('join_table');
  assert.ok(!joined.isError);
  const {lease_id} = joined.structuredContent;
  assert.equal((await invoke('join_table')).isError, true);
  assert.equal((await invoke('read_turn', {lease_id: 'invalid'})).isError, true);
  await game.startMatch(4, ['aevi','vex'], 'official');
  game.clearTimers();
  game.state.round.currentPlayerId = 'aevi';
  await game.scheduleTurn();
  game.clearTimers();
  const view = (await invoke('read_turn', {lease_id})).structuredContent;
  assert.equal((await invoke('wait_for_event', {lease_id, cursor:'invalid'})).isError, true);
  // Delayed real referee broadcast must complete the HTTP wait without locking other operations.
  const pending = invoke('wait_for_event', {lease_id, cursor:view.cursor});
  const eventTimer = setTimeout(() => { void game.enqueue(() => game.applyEmote('aurex','emoji_01')); }, 100);
  const event = (await pending).structuredContent;
  clearTimeout(eventTimer);
  assert.ok(event.table_events.some(e => e.emote === 'emoji_01'));
  assert.deepEqual(event.hand, game.state.round.hands.aevi);
  const interaction = {lease_id, match_id:event.match_id, cursor:event.cursor, interaction:{type:'chat',text:'来啦'}};
  assert.equal((await invoke('interact_table', {...interaction, interaction:{...interaction.interaction, player_id:'aurex'}})).isError,true);
  assert.equal((await invoke('interact_table', interaction)).structuredContent.accepted,true);
  assert.equal((await invoke('interact_table', interaction)).isError,true);
  assert.deepEqual(view.hand, game.state.round.hands.aevi);
  assert.equal(JSON.stringify(view).includes('"hands"'), false);
  const args = {lease_id, match_id: view.match_id, turn_id: view.turn_id, action: {type: 'bid', value: 3}};
  assert.equal((await invoke('submit_action', {...args, action: {type:'bid',value:3, player_id:'aurex'}})).isError, true);
  assert.equal(game.state.round.bidHistory.length, 0);
  assert.equal((await invoke('submit_action', args)).structuredContent.accepted, true);
  assert.equal((await invoke('submit_action', args)).isError, true);
  game.clearTimers();
  assert.equal(game.state.round.bidHistory[0].source, 'mcp');
  assert.equal((await invoke('leave_table', {lease_id})).structuredContent.left, true);
  assert.equal((await invoke('read_turn', {lease_id})).isError, true);
  for (const headers of [{Origin:'https://untrusted.example'}, {Host:'untrusted.example'}]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(url, {method:'POST', headers}, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(status, 403);
  }
  assert.equal((await fetch(url, {method:'POST', body:'x'.repeat(32769)})).status, 413);
  assert.equal((await fetch(url, {method:'POST', body:'{'})).status, 400);
  assert.equal((await fetch(url)).status, 405);
  console.log('MCP HTTP: SDK handshake, four tools, seat privacy, strict actions and loopback boundary passed');
} finally {
  await client.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  game.clearTimers();
  clearTimeout(game.officialLeaseTimer);
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(dir, {recursive:true, force:true});
}
