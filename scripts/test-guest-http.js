// Real HTTP + WebSocket boundary tests. No live services, keys or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddz-http-'));
const listener = net.createServer();
await new Promise(r => listener.listen(0,'127.0.0.1',r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const origin = `http://127.0.0.1:${port}`;
let child, output = '';
const sockets = [];
async function start() {
  child = spawn(process.execPath, ['src/server.js'], {env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DOUDIZHU_DATA_DIR:tmp,DOUDIZHU_MCP_PORT:'',DOUDIZHU_GATEWAY_URL:'',DOUDIZHU_SERVICE_KEY:''},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  for(let i=0;i<100;i++) { try {if((await fetch(origin+'/api/doudizhu/health')).ok) return;}catch{} await new Promise(r=>setTimeout(r,50)); }
  throw Error(output);
}
async function stop() { for(const socket of sockets) socket.terminate(); child.kill(); await new Promise(r=>child.exitCode!==null?r():child.once('exit',r)); }
async function request(cookie, endpoint, body, status = 200, headers = {}) {
  const response = await fetch(origin+'/api/doudizhu/'+endpoint, {method:body===undefined?'GET':'POST',headers:{cookie:cookie||'',origin,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const payload = await response.json();
  assert.equal(response.status,status,JSON.stringify(payload));
  return { data:payload.data, error:payload.error, cookie:response.headers.get('set-cookie') };
}
async function guest() { const r = await request(null,'guest',{}); assert.match(r.cookie,/HttpOnly/); assert.match(r.cookie,/SameSite=Strict/); return r.cookie.split(';')[0]; }
async function socket(cookie, code, denied = false) {
  const ws = new WebSocket(origin.replace('http','ws')+'/api/doudizhu/ws?room='+code,{headers:{cookie,origin}});
  sockets.push(ws); ws.messages = [];
  if(denied) { await new Promise((resolve,reject)=>{ws.on('unexpected-response',(_,res)=>{try{assert.equal(res.statusCode,403);res.resume();ws.terminate();resolve();}catch(e){reject(e);}});ws.on('open',()=>reject(Error('unauthorized WS accepted')));ws.on('error',()=>{});}); return; }
  ws.on('message',raw=>ws.messages.push(JSON.parse(raw)));
  await until(()=>ws.messages.length);
  return ws;
}
async function until(predicate) { for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));} throw Error('condition timed out'); }
try {
  await start();
  await request(null,'state',undefined,401);
  const a=await guest(), b=await guest(), c=await guest(), d=await guest();
  await request(a,'guest',{},403,{origin:'https://attacker.invalid'});
  assert.equal((await request(a,'guest',{})).cookie,null,'refresh retains session');
  const one=(await request(a,'rooms',{nickname:'A',kind:'friends'},201)).data.code;
  const two=(await request(c,'rooms',{nickname:'C',kind:'friends'},201)).data.code;
  await request(b,'join?room='+one,{nickname:'B'});
  await request(d,'join?room='+one,{nickname:'D'});
  await request(c,'join?room='+one,{nickname:'第四位'},409);
  assert.deepEqual((await request(b,'rooms')).data.map(room=>room.code),[one]);
  const wa=await socket(a,one), wb=await socket(b,one), wc=await socket(c,two);
  await socket(c,one,true);
  await request(c,'state?room='+one,undefined,403);
  await request(a,'state?room='+one+'&player_id=aevi',undefined,403);
  await request(a,'state?room='+two,undefined,403);
  await request(a,'avatar/aurex?room='+two,undefined,403);
  await request(a,'action?room='+two,{type:'sync'},403);
  await request(a,'action?room='+one,{type:'start_match',totalRounds:4});
  await until(()=>wa.messages.some(m=>m.data?.round)&&wb.messages.some(m=>m.data?.round));
  const va=(await request(a,'state?room='+one)).data, vb=(await request(b,'state?room='+one)).data;
  assert.notEqual(va.selfSeat,vb.selfSeat);
  assert.deepEqual(wb.messages.at(-1).data.round.hand,vb.round.hand);
  assert.deepEqual(wa.messages.at(-1).data.round.hand,va.round.hand);
  assert.ok(!wa.messages.some(m=>m.data?.round?.hands));
  assert.equal(wc.messages.length,1,'room 1 broadcasts must not reach room 2');
  await request(a,'action?room='+one,{type:'bid',value:3,player_id:vb.selfSeat},403);
  wb.send(JSON.stringify({type:'bid',value:3,player_id:va.selfSeat}));
  await until(()=>wb.messages.some(m=>m.error==='IDENTITY_OVERRIDE'));
  const wrong=va.controls.isYourTurn?b:a;
  await request(wrong,'action?room='+one,{type:'bid',value:3,match_id:va.match.id,turn_id:va.timer.token},400);
  const right={aurex:a,aevi:b,vex:d}[va.round.currentPlayerId];
  await request(right,'action?room='+one,{type:'bid',value:3,match_id:va.match.id,turn_id:va.timer.token});
  await request(right,'action?room='+one,{type:'bid',value:3,match_id:va.match.id,turn_id:va.timer.token},409);
  const now=(await request(right,'state?room='+one)).data;
  const other=right===a?vb:va;
  await request(right,'action?room='+one,{type:'play',cards:[other.round.hand[0].id],match_id:now.match.id,turn_id:now.timer.token},400);
  await request(right,'action?room='+one,{type:'play',cards:[now.round.hand.at(-1).id],match_id:now.match.id,turn_id:now.timer.token});
  for(let i=0;i<2;i++) {
    const next=(await request(a,'state?room='+one)).data;
    const actor={aurex:a,aevi:b,vex:d}[next.round.currentPlayerId];
    await request(actor,'action?room='+one,{type:'pass',match_id:next.match.id,turn_id:next.timer.token});
  }
  assert.equal((await request(right,'state?room='+one)).data.controls.isYourTurn,true,'all three authenticated humans complete a turn cycle');
  wb.close(); await until(()=>wb.readyState===WebSocket.CLOSED);
  assert.equal((await request(a,'state?room='+one)).data.match.id,va.match.id);
  const wb2=await socket(b,one); assert.equal(wb2.messages[0].data.selfSeat,vb.selfSeat);
  await request(b,'leave?room='+one,{});
  await until(()=>wb2.readyState===WebSocket.CLOSED);
  await request(b,'state?room='+one,undefined,403);
  await request(b,'join?room='+one,{nickname:'B回来'});
  assert.equal((await request(b,'state?room='+one)).data.selfSeat,vb.selfSeat);
  await request(c,'action?room='+two,{type:'start_match',totalRounds:4});
  const twoState=(await request(c,'state?room='+two)).data;
  assert.notEqual(twoState.match.id,va.match.id);
  assert.notEqual(twoState.timer.token,(await request(a,'state?room='+one)).data.timer.token);
  // Two live local bots finish bidding when owner passes in the separate room.
  if(twoState.controls.isYourTurn) await request(c,'action?room='+two,{type:'bid',value:0,match_id:twoState.match.id,turn_id:twoState.timer.token});
  let botState;
  for(let i=0;i<100;i++){botState=(await request(c,'state?room='+two)).data;if(botState.feed.some(e=>e.playerId!=='aurex'&&e.type==='bid'))break;await new Promise(r=>setTimeout(r,30));}
  assert.ok(botState.feed.some(e=>e.playerId!=='aurex'&&e.type==='bid'),'Local AI must still act');
  await request(b,'end?room='+one,{},403);
  await request(a,'end?room='+one,{});
  const ended=await fs.readFile(path.join(tmp,'rooms',one,'state.json'),'utf8');
  await new Promise(r=>setTimeout(r,200));
  assert.equal(await fs.readFile(path.join(tmp,'rooms',one,'state.json'),'utf8'),ended,'ended room stops background writes');
  await request(a,'state?room='+one,undefined,410);
  assert.equal((await request(c,'state?room='+two)).data.match.id,twoState.match.id);
  await stop(); await start();
  assert.equal((await request(c,'state?room='+two)).data.selfSeat,'aurex');
  await request(a,'state?room='+one,undefined,410);
  assert.equal((await request(b,'guest',{})).cookie,null);
  console.log('HTTP/WS: two private viewers, cookie restart, spoof/cross-room/origin denial, reconnect, independent broadcasts/timers/files, Local AI and owner-only end passed');
} finally {
  if(child?.exitCode===null) await stop();
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())+path.sep));
  await fs.rm(tmp,{recursive:true,force:true});
}
