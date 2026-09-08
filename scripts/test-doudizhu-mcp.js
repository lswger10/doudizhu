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
  game.playerConfig('vex').kind = 'human'; // Drive the other seats locally; no provider requests.
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
  // One controller/session continues after successful actions and while others play.
  // Real HTTP waits and referee transitions; this is not a live ChatGPT response test.
  for (let cycle=0; cycle<4; cycle++) {
    const turn = (await invoke('read_turn', {lease_id})).structuredContent;
    assert.equal(turn.is_your_turn, true);
    const action = turn.legal_actions.find(a => a.type==='play' && a.cards.length===1);
    assert.ok(action);
    const receipt = await invoke('submit_action', {lease_id, match_id:turn.match_id, turn_id:turn.turn_id, action});
    assert.equal(receipt.structuredContent.accepted, true);
    assert.match(receipt.structuredContent.next.instruction, /After a successful submit_action.*next.cursor and next.last_event_id/);
    game.clearTimers();
    let next = receipt.structuredContent.next;
    assert.equal(next.is_your_turn, false);
    for (let other=0; other<2; other++) {
      const pending = invoke('wait_for_event', {lease_id, cursor:next.cursor, last_event_id:next.last_event_id});
      const timer = setTimeout(() => void game.enqueue(async () => {
        await game.applyPass(game.state.round.currentPlayerId);
        game.clearTimers();
      }), 100);
      const update = await pending;
      clearTimeout(timer);
      assert.ok(!update.isError);
      assert.notEqual(update.structuredContent.cursor, next.cursor);
      next = update.structuredContent;
      assert.equal(next.is_your_turn, other===1);
      assert.equal('hand' in next, false);
    }
    assert.equal(game.officialLease.id, lease_id, 'the active controller is retained across all calls');
  }
  const idleView = (await invoke('read_turn', {lease_id})).structuredContent;
  const idleUpdate = (await invoke('wait_for_event', {lease_id, cursor:idleView.cursor, last_event_id:idleView.last_event_id})).structuredContent;
  assert.equal(idleUpdate.cursor, idleView.cursor, '15-second empty waits remain usable, not terminal errors');
  // Model-facing continuation is part of the tool contract, not just README prose.
  assert.match(tools.find(t => t.name==='submit_action').description, /SAME response/);
  assert.match(idleView.instruction, /no fixed total response duration/);
  assert.match(idleUpdate.instruction, /no fixed total response duration/);
  assert.match(idleView.instruction, /Do not end.*successful submit_action/);
  assert.match(tools.find(t => t.name==='read_turn').description, /Next:.*submit_action.*otherwise.*wait_for_event/);
  assert.match(tools.find(t => t.name==='wait_for_event').description, /Next:.*read_turn.*otherwise.*wait_for_event again/);
  assert.match(tools.find(t => t.name==='submit_action').description, /Next after success: continue wait_for_event/);
  for (const phase of ['round_end','match_end','lobby']) {
    const before = game.state.phase;
    game.state.phase = phase;
    const result = (await invoke('read_turn', {lease_id})).structuredContent;
    assert.match(result.instruction, /At round_end, match_end or lobby stay seated and continue waiting/);
    assert.equal(game.officialLease.id, lease_id);
    game.state.phase = before;
  }
  // Host ends the response while HTTP wait is pending: cancel work, retain the seat.
  const cancel = new AbortController();
  const disconnected = fetch(url, {method:'POST', signal:cancel.signal,
    headers:{'Content-Type':'application/json', Accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:91,method:'tools/call',params:{name:'wait_for_event',
      arguments:{lease_id,cursor:idleUpdate.cursor,last_event_id:idleUpdate.last_event_id},_meta:identity}})});
  const cancelledCheck = assert.rejects(disconnected, /abort/i);
  for (let n=0; n<100 && !game.officialWaiting; n++) await new Promise(r => setTimeout(r,10));
  assert.equal(game.officialWaiting, true);
  cancel.abort();
  await cancelledCheck;
  for (let n=0; n<100 && game.officialWaiting; n++) await new Promise(r => setTimeout(r,10));
  assert.equal(game.officialWaiting, false);
  assert.equal(game.officialLease.id, lease_id, 'response termination must not leave or rotate control');
  assert.equal((await invoke('read_turn', {lease_id})).structuredContent.match_id, view.match_id);
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
  console.log('MCP HTTP: four repeated wait/read/act cycles, latest cursors, empty wait, response cancellation retains seat, tool next-hop contract, identity/fencing and loopback boundary passed');
} finally {
  mock.timers.reset();
  await client.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  game.clearTimers();
  clearTimeout(game.officialLeaseTimer);
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(dir, {recursive:true, force:true});
}
