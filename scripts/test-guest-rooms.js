// Permanent session/seat/room boundary regression; synthetic guests and temporary storage only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DoudizhuRooms } from '../src/doudizhu-rooms.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddz-rooms-'));
let rooms;
try {
  rooms = new DoudizhuRooms({ rootDir: process.cwd(), dataDir: dir });
  await rooms.ready();
  const a = await rooms.guest(), b = await rooms.guest(), c = await rooms.guest();
  assert.notEqual(a.token, b.token);
  assert.equal(rooms.authenticate(a.token), a.id);
  assert.throws(() => rooms.authenticate('invented'), /SESSION_INVALID/);
  const first = await rooms.create(a.id, { nickname: '相同昵称', kind: 'friends' });
  const second = await rooms.create(c.id, { nickname: 'C', kind: 'friends' });
  await rooms.join(b.id, first.code, { nickname: '相同昵称' });
  const sa = rooms.snapshot(a.id, first.code), sb = rooms.snapshot(b.id, first.code);
  assert.notEqual(sa.selfSeat, sb.selfSeat);
  assert.equal(sa.players.find(p => p.id === sa.selfSeat).name, sb.players.find(p => p.id === sb.selfSeat).name);
  assert.throws(() => rooms.snapshot(c.id, first.code), /ROOM_FORBIDDEN/);
  assert.throws(() => rooms.snapshot(a.id, second.code), /ROOM_FORBIDDEN/);
  await assert.rejects(rooms.action(b.id, first.code, { type: 'start_match', totalRounds: 4 }), /OWNER_REQUIRED/);
  const random = Math.random;
  try { Math.random = () => 0.1; await rooms.action(a.id, first.code, { type: 'start_match', totalRounds: 4 }); }
  finally { Math.random = random; }
  const va = rooms.snapshot(a.id, first.code), vb = rooms.snapshot(b.id, first.code);
  assert.equal(va.round.hand.length, 17);
  assert.equal(vb.round.hand.length, 17);
  assert.ok(va.round.hand.every(card => !vb.round.hand.some(other => other.id === card.id)));
  assert.equal(vb.players.find(p => p.id === vb.selfSeat).seatIndex, 0);
  await assert.rejects(rooms.action(a.id, first.code, { type: 'bid', value: 3, player_id: vb.selfSeat }), /IDENTITY_OVERRIDE/);
  await assert.rejects(rooms.action(a.id, first.code, { type: 'update_profile', playerId: vb.selfSeat, name: '劫持' }), /SEAT_FORBIDDEN/);
  await assert.rejects(rooms.action(a.id, second.code, { type: 'sync' }), /ROOM_FORBIDDEN/);
  const turnGuest = va.controls.isYourTurn ? a : b;
  const turn = rooms.snapshot(turnGuest.id, first.code);
  await assert.rejects(rooms.action(turnGuest.id, first.code, {type:'bid',value:3,match_id:turn.match.id,turn_id:'old'}), /STALE_TURN/);
  await rooms.action(turnGuest.id, first.code, {type:'bid',value:3,match_id:turn.match.id,turn_id:turn.timer.token});
  await rooms.leave(b.id, first.code);
  assert.throws(() => rooms.snapshot(b.id, first.code), /ROOM_FORBIDDEN/);
  assert.equal(rooms.snapshot(a.id, first.code).match.id, va.match.id);
  await rooms.join(b.id, first.code, {nickname:'回来'});
  assert.equal(rooms.snapshot(b.id, first.code).selfSeat, vb.selfSeat);
  assert.equal(rooms.snapshot(c.id, second.code).phase, 'lobby');
  const gameTwo = rooms.binding(c.id,second.code).game;
  await rooms.action(c.id,second.code,{type:'start_match',totalRounds:4});
  const savedOne = await fs.readFile(path.join(dir,'rooms',first.code,'state.json'),'utf8');
  await rooms.binding(a.id,first.code).game.enqueue(()=>rooms.binding(a.id,first.code).game.handleTurnTimeout(gameTwo.state.timer.token));
  assert.equal(await fs.readFile(path.join(dir,'rooms',first.code,'state.json'),'utf8'),savedOne,'another room timer cannot advance this game');
  assert.notEqual(rooms.binding(a.id, first.code).game, rooms.binding(c.id, second.code).game);
  assert.notEqual(rooms.binding(a.id, first.code).game.turnTimer, rooms.binding(c.id, second.code).game.turnTimer);
  assert.ok((await fs.stat(path.join(dir,'rooms',first.code,'state.json'))).isFile());
  assert.ok((await fs.stat(path.join(dir,'rooms',second.code,'state.json'))).isFile());
  // Ablation: the old fixed viewer is evaluated against the same real referee/hands.
  // Replacing session -> seat with fixed aurex loses B's privacy and stable identity.
  const game = rooms.binding(b.id, first.code).game;
  await game.addFeed({type:'adapter_error',text:'synthetic diagnostic',detail:'private synthetic model output'},false);
  assert.ok(rooms.snapshot(b.id,first.code).feed.every(event=>!('detail' in event)));
  assert.notDeepEqual(game.publicSnapshot('aurex').round.hand, rooms.snapshot(b.id,first.code).round.hand);
  assert.deepEqual(game.publicSnapshot('aurex').round.hand, rooms.snapshot(a.id,first.code).round.hand);
  const bindingProbe = resolve => {
    const aBinding = resolve(a.id, first.code), bBinding = resolve(b.id, first.code);
    let crossRoomDenied = false;
    try { resolve(a.id, second.code); } catch { crossRoomDenied = true; }
    return {
      separateSeats: aBinding.seat !== bBinding.seat,
      ownHand: JSON.stringify(bBinding.game.publicSnapshot(bBinding.seat).round.hand) === JSON.stringify(rooms.snapshot(b.id,first.code).round.hand),
      crossRoomDenied,
      independentGame: aBinding.game !== resolve(c.id, second.code).game,
      reconnectSeat: resolve(rooms.authenticate(b.token),first.code).seat === vb.selfSeat,
    };
  };
  assert.deepEqual(bindingProbe((id,code)=>rooms.binding(id,code)), {separateSeats:true,ownHand:true,crossRoomDenied:true,independentGame:true,reconnectSeat:true});
  const oldFixedBinding = rooms.binding(a.id,first.code);
  assert.deepEqual(bindingProbe(()=>oldFixedBinding), {separateSeats:false,ownHand:false,crossRoomDenied:false,independentGame:false,reconnectSeat:false});
  assert.equal(game.state.round.currentPlayerId, va.selfSeat);
  assert.throws(()=>game.assertTurn(rooms.binding(b.id,first.code).seat));
  assert.doesNotThrow(()=>game.assertTurn(oldFixedBinding.seat),'old transport would allow B to act as A');
  assert.deepEqual(rooms.list(c.id).map(room=>room.code), [second.code]);
  rooms.close();
  rooms = new DoudizhuRooms({ rootDir: process.cwd(), dataDir: dir });
  await rooms.ready();
  assert.equal(rooms.authenticate(b.token), b.id);
  assert.equal(rooms.snapshot(b.id, first.code).selfSeat, vb.selfSeat);
  assert.equal(rooms.binding(b.id,first.code).game.playerConfig(vb.selfSeat).kind, 'human');
  await assert.rejects(rooms.end(b.id, first.code), /OWNER_REQUIRED/);
  const closingGame = rooms.binding(a.id,first.code).game;
  await rooms.end(a.id, first.code);
  const closedState = await fs.readFile(closingGame.stateFile,'utf8');
  await closingGame.enqueue(()=>closingGame.handleTurnTimeout(closingGame.state.timer.token));
  assert.equal(await fs.readFile(closingGame.stateFile,'utf8'),closedState,'an already queued timeout cannot revive an ended room');
  assert.throws(() => rooms.snapshot(b.id, first.code), /ROOM_CLOSED/);
  assert.ok(rooms.snapshot(c.id, second.code).match, 'ending one room preserves the other active game');
  const fresh = await rooms.guest();
  const saveRooms = rooms.saveRooms.bind(rooms);
  const spare = await rooms.create(c.id,{kind:'friends',nickname:'持久化测试'});
  rooms.saveRooms = async () => { throw Error('synthetic disk failure'); };
  await assert.rejects(rooms.join(fresh.id,spare.code,{nickname:'未落盘'}), /synthetic disk failure/);
  assert.throws(()=>rooms.snapshot(fresh.id,spare.code), /ROOM_FORBIDDEN/);
  await assert.rejects(rooms.end(c.id,spare.code), /synthetic disk failure/);
  assert.equal(rooms.snapshot(c.id,spare.code).phase,'lobby');
  rooms.saveRooms = saveRooms;
  let rejectWrite, writeStarted;
  const started = new Promise(resolve => { writeStarted = resolve; });
  rooms.saveRooms = async () => { writeStarted(); await new Promise((_,reject)=>{rejectWrite=reject;}); };
  const pendingJoin = rooms.join(fresh.id,spare.code,{nickname:'仍在写入'});
  const pendingFailure = assert.rejects(pendingJoin,/synthetic pending write failure/);
  await started;
  assert.throws(()=>rooms.snapshot(fresh.id,spare.code),/ROOM_FORBIDDEN/,'pending persistence must not grant access');
  rejectWrite(Error('synthetic pending write failure'));
  await pendingFailure;
  rooms.saveRooms = saveRooms;
  const legacyDir = path.join(dir,'legacy-fixture');
  await fs.mkdir(legacyDir);
  await fs.writeFile(path.join(legacyDir,'state.json'),'{}');
  let legacy = new DoudizhuRooms({rootDir:process.cwd(),dataDir:legacyDir});
  try {
    await legacy.ready();
    legacy.classic.scores.players.aurex.score=37;
    legacy.classic.profiles.players.aurex.name='旧桌主人';
    await legacy.classic.saveScores();await legacy.classic.saveProfiles();
    const guest = await legacy.guest();
    await assert.rejects(legacy.create(guest.id,{kind:'classic',nickname:'不能认领旧桌'}), /CLASSIC_OWNER_SETUP_REQUIRED/);
    const source = await legacy.create(guest.id,{kind:'friends',nickname:'独立新桌'});
    const stranger = await legacy.guest();
    const claimFile = path.join(legacyDir,'classic-owner-claim.json');
    const before = structuredClone(legacy.classic.state);
    const scores = structuredClone(legacy.classic.scores);
    legacy.close();
    await fs.writeFile(claimFile, JSON.stringify({sourceRoom:source.code}));
    legacy = new DoudizhuRooms({rootDir:process.cwd(),dataDir:legacyDir});
    await legacy.ready();
    const classic = legacy.list(guest.id).find(room=>room.kind==='classic');
    assert.ok(classic, 'administrator migration binds the existing guest, not the first public visitor');
    assert.equal(legacy.snapshot(guest.id,classic.code).selfSeat,'aurex');
    assert.throws(()=>legacy.snapshot(stranger.id,classic.code),/ROOM_FORBIDDEN/);
    assert.equal(legacy.binding(guest.id,classic.code).game,legacy.classic);
    assert.deepEqual(legacy.classic.state.match,before.match);
    assert.deepEqual(legacy.classic.scores.players,scores.players);
    assert.equal(legacy.classic.scores.players.aurex.score,37);
    assert.equal(legacy.snapshot(guest.id,classic.code).players.find(p=>p.id==='aurex').name,'旧桌主人');
    await assert.rejects(fs.stat(claimFile), {code:'ENOENT'});
    await assert.rejects(legacy.create(stranger.id,{kind:'classic',nickname:'抢桌'}),/CLASSIC_ALREADY_ASSIGNED/);
    // A crash between committing membership and deleting the request is idempotent.
    legacy.close();
    await fs.writeFile(claimFile,JSON.stringify({sourceRoom:source.code}));
    legacy = new DoudizhuRooms({rootDir:process.cwd(),dataDir:legacyDir});
    await legacy.ready();
    assert.equal(legacy.list(guest.id).find(room=>room.kind==='classic').code,classic.code);
    await assert.rejects(fs.stat(claimFile),{code:'ENOENT'});
    legacy.close();
    // Never start the referee (which can resume timers) for an invalid migration request.
    const registryFile=path.join(legacyDir,'rooms.json');
    const registry=JSON.parse(await fs.readFile(registryFile,'utf8'));
    delete registry.rooms[classic.code];registry.legacyUnowned=true;
    await fs.writeFile(registryFile,JSON.stringify(registry));
    for (const saved of [{...before,phase:'play'}, {...before,officialSeat:{owner:'synthetic'}}]) {
      await fs.writeFile(path.join(legacyDir,'state.json'),JSON.stringify(saved));
      await fs.writeFile(claimFile,JSON.stringify({sourceRoom:source.code}));
      legacy=new DoudizhuRooms({rootDir:process.cwd(),dataDir:legacyDir});
      await assert.rejects(legacy.ready(),/CLASSIC_MIGRATION_REQUIRES_IDLE/);
      assert.equal(legacy.classic,undefined);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(legacyDir,'state.json'),'utf8')),saved);
    }
  } finally { legacy.close(); }
  console.log('Guest rooms: independent identities, private hands, spoof rejection, reconnect/restart, leave/end, room files/timers and fixed-view ablation passed');
} finally {
  rooms?.close();
  await fs.rm(dir, { recursive: true, force: true });
}
