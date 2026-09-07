import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DoudizhuService } from '../src/doudizhu-service.js';
import {legalPlays} from '../src/doudizhu-rules.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ddz-modes-'));
let local=0, paid=0;
const service=new DoudizhuService({dataDir:dir,adapter:{decide:async()=>{local++;return {action:{type:'bid',value:1}}}},modelAdapter:{decide:async()=>{paid++;return {action:{type:'bid',value:1}}},cancel(){}}});
try {
 await service.ready();
 assert.equal(service.publicSnapshot().modelAvailable,true);
 await service.decide(service.players[1],{phase:'bid'});
 assert.equal(local,1);assert.equal(paid,0);
 await service.handleClientMessage({type:'start_match',totalRounds:4,aiPlayers:['aevi','vex'],mode:'model'});
 service.clearTimers();
 assert.equal(service.publicSnapshot().match.mode,'model');
 await assert.rejects(service.handleClientMessage({type:'start_match',totalRounds:4,mode:'local'}));
 await service.decide(service.players[1],{phase:'bid'});
 assert.ok(paid>=1);
 await service.handleClientMessage({type:'stop_model_match'});
 assert.equal(service.state.phase,'lobby');
 const restored=new DoudizhuService({dataDir:dir});await restored.ready();restored.clearTimers();
 assert.equal(restored.state.phase,'lobby');
 assert.equal(restored.history.at(-1).status,'stopped');
 // Every pair uses the selected seat's controller, including two different Jiaos.
 const roster=['aevi','vex','chatgpt','juhua'];
 service.runAiTurn=async()=>{};
 const lease=await service.joinOfficial({owner:'test-owner',session:'test-session'}, crypto.randomUUID());
 for(let a=0;a<roster.length;a++) for(let b=a+1;b<roster.length;b++) {
   const pair=[roster[a],roster[b]];
   await service.startMatch(4,pair,'mixed');service.clearTimers();
   assert.deepEqual(service.activePlayerIds(),['aurex',...pair]);
   for(const id of pair) {
     const before={local,paid};
     if(id==='chatgpt') await assert.rejects(service.decide(service.playerConfig(id),{}),/MCP/);
     else await service.decide(service.playerConfig(id),{});
     assert.equal(paid-before.paid,['aevi','vex'].includes(id)?1:0);
     assert.equal(local-before.local,id==='juhua'?1:0);
   }
   await service.applyBid(service.state.round.currentPlayerId,3);
   for(let n=0;service.state.phase==='play' && n<400;n++) {
     service.clearTimers();
     const id=service.state.round.currentPlayerId;
     const cards=legalPlays(service.state.round.hands[id],service.state.round.leadingMove?.move)[0];
     if(cards) await service.applyPlay(id,cards);else await service.applyPass(id);
   }
   service.clearTimers();assert.equal(service.state.phase,'round_end');
   assert.ok(service.activePlayerIds().includes(service.state.round.result.winnerId));
   assert.equal(Object.values(service.state.round.scoreDelta).reduce((a,b)=>a+b,0),0);
   await service.stopModelMatch();
 }
 service.modelAdapter=null;
 await service.startMatch(4,['chatgpt','juhua'],'mixed');service.clearTimers();
 await service.stopModelMatch();
 await assert.rejects(service.startMatch(4,['chatgpt','aevi'],'mixed'),/Gateway/);
 await assert.rejects(service.startMatch(4,['chatgpt','chatgpt'],'mixed'),/不同/);
 await service.leaveOfficial(lease.lease_id);
} finally {service.clearTimers();await fs.rm(dir,{recursive:true,force:true});}
console.log('Mode selection, local no-cost, stop and persistence passed');
