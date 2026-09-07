import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DoudizhuService } from '../src/doudizhu-service.js';
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
} finally {service.clearTimers();await fs.rm(dir,{recursive:true,force:true});}
console.log('Mode selection, local no-cost, stop and persistence passed');
