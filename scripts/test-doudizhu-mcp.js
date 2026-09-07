import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {mock} from 'node:test';
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
  const identity = {'openai/subject':'test-user','openai/session':'test-chat'};
  const invoke = (name, args = {}, meta = identity) => client.callTool({name, arguments: args, _meta:meta});
  assert.equal((await invoke('join_table', {instance_id:crypto.randomUUID()}, {})).isError, true, 'missing trusted identity fails closed');
  assert.equal((await invoke('join_table', {instance_id:crypto.randomUUID(), owner:'test-user'})).isError, true, 'self-reported identity is not a tool argument');
  const joined = await invoke('join_table', {instance_id:crypto.randomUUID()});
  assert.ok(!joined.isError);
  const {lease_id} = joined.structuredContent;
  assert.equal((await invoke('read_turn', {lease_id}, {...identity,'openai/subject':'other-user'})).isError, true);
  assert.equal((await invoke('read_turn', {lease_id}, {...identity,'openai/session':'other-chat'})).isError, true);
  assert.equal((await invoke('join_table', {instance_id:crypto.randomUUID()})).structuredContent.status, 'controller_active');
  assert.equal((await invoke('read_turn', {lease_id: 'invalid'})).isError, true);
  await game.startMatch(4, ['chatgpt','vex'], 'official');
  game.clearTimers();
  game.state.round.currentPlayerId = 'chatgpt';
  await game.scheduleTurn();
  game.clearTimers();
  const view = (await invoke('read_turn', {lease_id})).structuredContent;
  assert.equal((await invoke('wait_for_event', {lease_id, cursor:'invalid'})).isError, true);
  // Delayed real referee broadcast must complete the HTTP wait without locking other operations.
  const pending = invoke('wait_for_event', {lease_id, cursor:view.cursor, last_event_id:view.last_event_id});
  const eventTimer = setTimeout(() => { void game.enqueue(() => game.applyEmote('aurex','emoji_01')); }, 100);
  const event = (await pending).structuredContent;
  clearTimeout(eventTimer);
  assert.ok(event.new_events.some(e => e.emote === 'emoji_01'));
  assert.equal('hand' in event, false);
  assert.equal('legal_actions' in event, false);
  const interaction = {lease_id, match_id:event.match_id, interaction_id:crypto.randomUUID(), interaction:{type:'chat',text:'来啦'}};
  assert.equal((await invoke('interact_table', {...interaction, interaction:{...interaction.interaction, player_id:'aurex'}})).isError,true);
  assert.equal((await invoke('interact_table', interaction)).structuredContent.accepted,true);
  assert.equal((await invoke('interact_table', interaction)).structuredContent.duplicate,true);
  assert.deepEqual(view.hand, game.state.round.hands.chatgpt);
  assert.equal(JSON.stringify(view).includes('"hands"'), false);
  const args = {lease_id, match_id: view.match_id, turn_id: view.turn_id, action: {type: 'bid', value: 3}};
  assert.equal((await invoke('submit_action', {...args, action: {type:'bid',value:3, player_id:'aurex'}})).isError, true);
  assert.equal(game.state.round.bidHistory.length, 0);
  assert.equal((await invoke('submit_action', args)).structuredContent.accepted, true);
  assert.equal((await invoke('submit_action', args)).isError, true);
  game.clearTimers();
  assert.equal(game.state.round.bidHistory[0].source, 'mcp');
  mock.timers.enable({apis:['Date'], now:Date.now()});
  mock.timers.tick(121_000);
  assert.equal((await invoke('join_table', {instance_id:crypto.randomUUID()}, {...identity,'openai/subject':'other-user'})).isError, true);
  const replacementMeta = {...identity,'openai/session':'new-chat'};
  const candidates = await Promise.all([1,2].map(() => invoke('join_table', {instance_id:crypto.randomUUID()}, replacementMeta)));
  assert.equal(candidates.filter(r => r.structuredContent?.status==='resumed').length, 1, 'only one recovery wins');
  assert.equal(candidates.filter(r => r.structuredContent?.status==='controller_active').length, 1);
  const replacement = candidates.find(r => r.structuredContent?.status==='resumed').structuredContent.lease_id;
  assert.notEqual(replacement, lease_id);
  assert.equal((await invoke('read_turn', {lease_id:replacement}, replacementMeta)).structuredContent.match_id, view.match_id);
  assert.equal((await invoke('interact_table', {...interaction,lease_id:replacement}, replacementMeta)).structuredContent.duplicate, true, 'recovery preserves interaction receipts');
  for (const [name, parameters] of [['read_turn',{lease_id}],['submit_action',args],['interact_table',interaction],['leave_table',{lease_id}]]) {
    assert.equal((await invoke(name, parameters)).isError, true, `old controller cannot ${name}`);
  }
  assert.equal((await invoke('leave_table', {lease_id:replacement}, replacementMeta)).structuredContent.left, true);
  mock.timers.reset();
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
  console.log('MCP HTTP: six tools, host identity, concurrent recovery, old-controller fencing, idempotency and loopback boundary passed');
} finally {
  mock.timers.reset();
  await client.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  game.clearTimers();
  clearTimeout(game.officialLeaseTimer);
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(dir, {recursive:true, force:true});
}
