import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DoudizhuService } from '../src/doudizhu-service.js';
import * as rules from '../src/doudizhu-rules.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddz-official-'));
const calls = [];
const adapter = { async decide(player) { calls.push(player.id); throw new Error('test provider unavailable'); }, cancel() {} };
const service = new DoudizhuService({ dataDir: dir, adapter, modelAdapter: adapter });
try {
  await service.ready();
  assert.equal(typeof service.joinOfficial, 'function', 'an external player must be able to claim an independent seat');
  const { lease_id: lease } = await service.joinOfficial();
  await service.updateProfile('chatgpt', {name:'椒椒测试名'});
  assert.equal(service.profiles.players.chatgpt.name, '椒椒测试名', 'display alias must not swallow stored profile edits');
  assert.equal(service.profile('chatgpt').name, '椒椒测试名');
  assert.equal(service.profile('aevi').name, '椒椒');
  assert.equal((await service.leaveOfficial(lease, true)).left, false, 'an obsolete expiry callback must not release a renewed lease');
  await assert.rejects(service.joinOfficial(), /occupied/);
  await assert.rejects(service.readOfficial('wrong'), /lease/);
  assert.equal(JSON.stringify(service.publicSnapshot()).includes(lease), false);
  service.playerConfig('vex').kind = 'human';
  await service.startMatch(4, ['chatgpt', 'vex'], 'official');
  service.clearTimers();
  await service.runAiTurn('chatgpt', service.state.timer?.token, Date.now() + 1000);
  await service.runAiChatReply('chatgpt', 'aurex', 'hello');
  await service.runAiInteractionReply('chatgpt', {playerId: 'aurex'});
  await service.runDissolveVote('chatgpt', 'test', Date.now() + 1000);
  assert.equal(calls.includes('chatgpt'), false, 'no provider may drive the official seat');
  assert.equal(service.publicSnapshot().players.find(p => p.id === 'chatgpt').name, '椒椒测试名');

  // A waiting controller must not hold the referee queue or miss real chat events.
  // Keep the other seat manually driven so an unrelated provider failure cannot race the cursor.
  service.playerConfig('vex').kind = 'human';
  const initial = await service.readOfficial(lease);
  assert.equal(typeof initial.cursor, 'string');
  const beforeListeners = service.listeners.size;
  const waiting = service.waitOfficial(lease, initial.cursor, 1000, undefined, initial.last_event_id);
  await service.enqueue(() => service.applyChat('aurex', '轮到你啦'));
  const changed = await waiting;
  assert.notEqual(changed.cursor, initial.cursor);
  assert.ok(changed.new_events.some(e => e.type === 'chat' && e.text === '轮到你啦'));
  assert.equal(service.listeners.size, beforeListeners);
  const timeout = await service.waitOfficial(lease, changed.cursor, 10);
  assert.equal(timeout.cursor, changed.cursor);
  const abort = new AbortController();
  const cancelled = service.waitOfficial(lease, changed.cursor, 1000, abort.signal);
  const cancelledCheck = assert.rejects(cancelled, /abort/i);
  await service.enqueue(() => {});
  abort.abort();
  await cancelledCheck;
  assert.equal(service.listeners.size, beforeListeners);
  const reply = {type:'chat', text:'来啦'};
  const social = await service.interactOfficial(lease, changed.match_id, changed.cursor, reply);
  assert.equal(social.accepted, true);
  assert.equal(service.state.feed.at(-1).playerId, 'chatgpt');
  assert.equal((await service.interactOfficial(lease, changed.match_id, changed.cursor, reply)).duplicate, true);
  await assert.rejects(service.interactOfficial(lease, changed.match_id, changed.cursor, {type:'chat',text:'不同'}), /different/);
  const afterChat = await service.readOfficial(lease);
  const thrown = await service.interactOfficial(lease, afterChat.match_id, afterChat.cursor, {type:'prop', prop:'tomato', target_id:'aurex'});
  assert.equal(thrown.accepted, true);
  assert.equal(service.state.round.propUses.chatgpt, 1);
  assert.ok(service.publicSnapshot().match.chatTranscript.some(e => e.prop === 'tomato'));
  assert.equal(service.publicSnapshot().match.chatTranscript.filter(e => e.text === '来啦').length, 1);
  service.state.phase = 'match_end';
  assert.equal((await service.interactOfficial(lease, changed.match_id, changed.cursor, reply)).duplicate, true);
  await assert.rejects(service.interactOfficial(lease, changed.match_id, crypto.randomUUID(), reply), /not active/);
  service.state.phase = 'bid';

  // Drive the real referee into Jiao's bidding turn without a live model.
  service.state.round.currentPlayerId = 'chatgpt';
  await service.scheduleTurn();
  service.clearTimers();
  const view = await service.readOfficial(lease);
  assert.deepEqual(view.hand, service.state.round.hands.chatgpt);
  assert.equal(view.hand.some(card => service.state.round.hands.aurex.includes(card)), false);
  assert.deepEqual(view.landlord_cards, [], 'bottom cards are hidden before bidding ends');
  assert.equal(view.is_your_turn, true);
  assert.deepEqual(view.legal_actions.map(a => a.value), [0, 1, 2, 3]);
  const action = {type: 'bid', value: 3};
  const outcomes = await Promise.allSettled([
    service.submitOfficial(lease, view.match_id, view.turn_id, action),
    service.submitOfficial(lease, view.match_id, view.turn_id, action),
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(service.state.round.bidHistory.length, 1);
  assert.equal(service.state.round.bidHistory[0].source, 'mcp');
  service.clearTimers();
  const play = await service.readOfficial(lease);
  await assert.rejects(service.submitOfficial(lease, play.match_id, play.turn_id, {type: 'play', cards: [service.state.round.hands.aurex[0]]}), /手牌/);
  await assert.rejects(service.submitOfficial(lease, play.match_id, play.turn_id, {type: 'stop_model_match'}), /action/);
  service.state.timer.deadlineAt = Date.now() - 1;
  await assert.rejects(service.submitOfficial(lease, play.match_id, play.turn_id, play.legal_actions[0]), /expired/);

  assert.equal(typeof rules.legalPlays, 'function');
  const hand = ['S3','H3','D3','C3','S4','H4','S5','S6','S7','S8','LJ','BJ'];
  const legal = rules.legalPlays(hand);
  for (const cards of legal) {
    assert.ok(rules.cardsBelongToHand(cards, hand));
    assert.ok(rules.classifyMove(cards));
  }
  assert.ok(legal.some(cards => rules.classifyMove(cards).type === 'straight'));
  assert.ok(legal.some(cards => rules.classifyMove(cards).type === 'rocket'));
  const target = rules.classifyMove(['S2']);
  for (const cards of rules.legalPlays(hand, target)) assert.ok(rules.canBeat(rules.classifyMove(cards), target));

  const last = await service.readOfficial(lease);
  const onLeave = service.waitOfficial(lease, last.cursor, 1000);
  await service.leaveOfficial(lease);
  assert.equal((await onLeave).match_id, null);
  assert.equal(service.state.phase, 'lobby');
  assert.equal(service.history.at(-1).status, 'stopped');
  await assert.rejects(service.readOfficial(lease), /lease/);
  await assert.rejects(service.startMatch(4, ['chatgpt','vex'], 'official'), /connected/);
  const second = await service.joinOfficial();
  await service.startMatch(4, ['chatgpt','vex'], 'official');
  service.clearTimers();
  service.state.phase = 'match_end';
  service.history.push({...service.state.match, status:'completed'});
  const completedCount = service.history.length;
  await service.stopModelMatch();
  assert.equal(service.history.length, completedCount, 'closing a completed match must not append a false stopped result');
  assert.equal(service.state.phase, 'lobby');
  await service.leaveOfficial(second.lease_id);
  console.log('Official seat: privacy, exclusive control, legality, stale/duplicate actions and leave passed');
} finally {
  service.clearTimers();
  clearTimeout(service.officialLeaseTimer);
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(dir, {recursive: true, force: true});
}
