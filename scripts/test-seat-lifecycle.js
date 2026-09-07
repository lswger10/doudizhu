// Permanent referee regression: active retention, next match, identity-safe recovery.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DoudizhuService} from '../src/doudizhu-service.js';
import {legalPlays} from '../src/doudizhu-rules.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddz-lifecycle-'));
const owner = {owner:'trusted-user-a', session:'conversation-a'};
const other = {owner:'trusted-user-b', session:'conversation-b'};
const adapter = {async decide() { throw Error('No live models in lifecycle test'); }, cancel() {}};
let game;
mock.timers.enable({apis:['Date'], now:Date.now()});
try {
  game = new DoudizhuService({dataDir:dir, adapter});
  await game.ready();
  game.runAiTurn = async () => {};
  const instance = crypto.randomUUID();
  const first = await game.joinOfficial(owner, instance);
  assert.equal((await game.joinOfficial(owner, instance)).lease_id, first.lease_id, 'lost join receipt is retryable');
  assert.equal((await game.joinOfficial(owner, crypto.randomUUID())).status, 'controller_active');
  await assert.rejects(game.joinOfficial(other, crypto.randomUUID()), /identity/);
  await game.startMatch(4, ['chatgpt','juhua'], 'official');
  game.clearTimers();
  const matchId = game.state.match.id;
  // More than a day of reading must not impose a total session duration cap.
  for (let n=0; n<150; n++) {
    mock.timers.tick(10*60_000);
    assert.equal((await game.readOfficial(first.lease_id)).match_id, matchId);
    assert.equal((await game.leaveOfficial(first.lease_id, true)).left, false);
  }
  const snapshot = await game.readOfficial(first.lease_id);
  const waiting = game.waitOfficial(first.lease_id, snapshot.cursor, 10);
  await game.enqueue(() => {});
  mock.timers.tick(3*60_000);
  assert.equal((await game.joinOfficial(owner, crypto.randomUUID())).status, 'controller_active', 'pending wait pins control');
  await waiting;
  assert.equal((await game.joinOfficial(owner, crypto.randomUUID())).status, 'controller_active', 'wait completion renews control');

  // Same owner, new conversation/instance, no old lease. No other owner can recover it.
  mock.timers.tick(121_000);
  await assert.rejects(game.joinOfficial(other, crypto.randomUUID()), /identity/);
  const nextOwner = {...owner, session:'conversation-new'};
  const resumed = await game.joinOfficial(nextOwner, crypto.randomUUID());
  assert.equal(resumed.status, 'resumed');
  assert.notEqual(resumed.lease_id, first.lease_id);
  assert.equal(game.state.match.id, matchId);
  await assert.rejects(game.readOfficial(first.lease_id), /lease/);
  await assert.rejects(game.leaveOfficial(first.lease_id), /lease/);
  assert.throws(() => game.assertOfficialIdentity(resumed.lease_id, other), /identity/);

  // Actual referee finishes all rounds; reservation survives round and match boundaries.
  for (let round=0; round<4; round++) {
    await game.applyBid(game.state.round.currentPlayerId, 3);
    for (let n=0; game.state.phase==='play' && n<400; n++) {
      game.clearTimers();
      const id = game.state.round.currentPlayerId;
      const cards = legalPlays(game.state.round.hands[id], game.state.round.leadingMove?.move)[0];
      if (cards) await game.applyPlay(id, cards); else await game.applyPass(id);
    }
    game.clearTimers();
    assert.equal((await game.readOfficial(resumed.lease_id)).phase, round===3 ? 'match_end' : 'round_end');
    if (round<3) await game.startNextRound();
  }
  await game.returnLobby();
  await game.startMatch(4, ['chatgpt','juhua'], 'official');
  game.clearTimers();
  assert.notEqual(game.state.match.id, matchId);
  const restartedMatch = game.state.match.id;
  // Process restart keeps the reservation/state, but does not reuse controller credentials.
  await game.saveState();
  clearTimeout(game.officialLeaseTimer);
  game = new DoudizhuService({dataDir:dir, adapter});
  await game.ready();
  game.runAiTurn = async () => {};
  game.clearTimers();
  assert.equal(game.state.match.id, restartedMatch);
  await assert.rejects(game.readOfficial(resumed.lease_id), /lease/);
  const restored = await game.joinOfficial(nextOwner, crypto.randomUUID());
  assert.equal(restored.status, 'resumed');
  assert.equal((await game.readOfficial(restored.lease_id)).match_id, restartedMatch);
  assert.equal(JSON.stringify(game.publicSnapshot()).includes('trusted-user'), false);

  mock.timers.tick(29*60_000);
  await game.handleClientMessage({type:'emote', emote:'emoji_01'});
  mock.timers.tick(2*60_000);
  assert.equal((await game.leaveOfficial(restored.lease_id, true)).left, false, 'real table interaction retains reservation');
  mock.timers.tick(31*60_000);
  assert.equal((await game.leaveOfficial(restored.lease_id, true)).left, true, 'complete inactivity releases');
  assert.equal(game.state.phase, 'lobby');
  const final = await game.joinOfficial(owner, crypto.randomUUID());
  await game.handleClientMessage({type:'stop_model_match'});
  await assert.rejects(game.readOfficial(final.lease_id), /lease/, 'explicit user stop releases even in lobby');
  console.log('Seat lifecycle: 25h active, four rounds + next match, fenced recovery, restart, genuine idle and explicit stop passed');
} finally {
  game?.clearTimers();
  clearTimeout(game?.officialLeaseTimer);
  mock.timers.reset();
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(dir, {recursive:true, force:true});
}
