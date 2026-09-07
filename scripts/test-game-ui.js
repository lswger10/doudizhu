// Permanent browser regression. Uses a locally installed Playwright (PLAYWRIGHT_MODULE), no live providers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const freePort=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ddz-ui-'));
const port=await freePort(), mcpPort=await freePort(), origin=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DOUDIZHU_MCP_PORT:String(mcpPort),DOUDIZHU_DATA_DIR:dir,DOUDIZHU_GATEWAY_URL:'',DOUDIZHU_SERVICE_KEY:''},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
const client=new Client({name:'ui-regression',version:'1'});
let browser;
const request=async(payload)=>{const r=await fetch(origin+'/api/doudizhu/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const b=await r.json();assert.equal(b.ok,true,JSON.stringify(b));return b.data;};
try {
  for(let i=0;;i++){try{if((await fetch(origin+'/api/doudizhu/health')).ok)break;}catch{}if(i>100)throw Error(output);await new Promise(r=>setTimeout(r,50));}
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)));
  const invoke=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent;};
  const {lease_id}=await invoke('join_table');
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge'});
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/doudizhu/');
  await page.locator('[data-ai-player="chatgpt"]').click();
  await page.locator('[data-ai-player="juhua"]').click();
  assert.equal(await page.locator('[data-ai-player][aria-pressed="true"]').count(),2);
  await page.getByText('更换头像与昵称',{exact:true}).click();
  await page.locator('[data-name-input="chatgpt"]').fill('灯笼椒椒');
  await page.locator('[data-save-name="chatgpt"]').click();
  // More than the old 256 KiB HTTP limit, but within the advertised 2 MiB upload limit.
  const png=Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUxkAAAAASUVORK5CYII=','base64'),Buffer.alloc(300000)]);
  await page.locator('[data-avatar-input="chatgpt"]').setInputFiles({name:'avatar.png',mimeType:'image/png',buffer:png});
  await page.waitForFunction(()=>document.querySelector('[data-profile-avatar="chatgpt"]').getAttribute('src').startsWith('/api/doudizhu/avatar/'));
  await page.locator('[data-close-settings-button]').click();
  await page.reload();
  await page.locator('[data-ai-player="chatgpt"]').filter({hasText:'灯笼椒椒'}).waitFor();
  await page.locator('[data-start]').click();
  await page.locator('[data-open-chat]').waitFor();
  let turn;
  for(let i=0;i<100;i++){
    turn=await invoke('read_turn',{lease_id});
    if(turn.is_your_turn)break;
    const state=(await (await fetch(origin+'/api/doudizhu/state')).json()).data;
    if(state.controls.isYourTurn)await request({type:'bid',value:0});
    await new Promise(r=>setTimeout(r,25));
  }
  assert.equal(turn.is_your_turn,true);
  await page.locator('[data-open-chat]').click();
  const input=page.locator('[data-chat-input]');await input.fill('还在输入');
  await input.evaluate(el=>{window.testInput=el;el.setSelectionRange(1,3);el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'输'}));});
  await invoke('submit_action',{lease_id,match_id:turn.match_id,turn_id:turn.turn_id,action:{type:'bid',value:3}});
  await page.locator('[data-player="chatgpt"] .role-badge').filter({hasText:'地主'}).waitFor();
  assert.deepEqual(await input.evaluate(el=>[el===window.testInput,document.activeElement===el,el.value,el.selectionStart,el.selectionEnd]),[true,true,'还在输入',1,3]);
  await input.dispatchEvent('keydown',{key:'Enter',isComposing:true,keyCode:229});
  assert.equal(await input.inputValue(),'还在输入');
  await input.dispatchEvent('compositionend',{data:'输'});
  await input.press('Enter');
  await page.waitForFunction(()=>document.querySelector('[data-chat-input]').value==='');
  await invoke('interact_table',{lease_id,match_id:turn.match_id,interaction_id:crypto.randomUUID(),interaction:{type:'chat',text:'收到啦'}});
  await request({type:'emote',emote:'emoji_01'});
  await invoke('interact_table',{lease_id,match_id:turn.match_id,interaction_id:crypto.randomUUID(),interaction:{type:'prop',prop:'tomato',target_id:'aurex'}});
  const log=page.getByRole('log');await log.getByText('收到啦',{exact:true}).waitFor();await log.getByText(/扔番茄/).waitFor();
  assert.ok((await log.innerText()).includes('表情 1'));
  if(process.env.DDZ_SCREENSHOT_DIR) { await fs.mkdir(process.env.DDZ_SCREENSHOT_DIR,{recursive:true}); await page.screenshot({path:path.join(process.env.DDZ_SCREENSHOT_DIR,'table-chat.png')}); }
  await input.fill('保留草稿');await request({type:'set_theme',theme:'sakura'});
  await page.waitForFunction(()=>document.body.dataset.theme==='sakura');assert.equal(await input.inputValue(),'保留草稿');
  await page.locator('[data-close-chat-button]').click();await page.locator('[data-open-chat]').click();
  assert.ok((await page.getByRole('log').innerText()).includes('收到啦'));
  // Test the actual navigation target for both a direct page and the entertainment iframe.
  await page.route(origin+'/',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>小家主页</h1>'}));
  await page.locator('[data-close-chat-button]').click();await page.getByRole('link',{name:'返回小家'}).click();await page.getByRole('heading',{name:'小家主页'}).waitFor();
  await page.route(origin+'/test-house',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<iframe src="/doudizhu/" style="width:100%;height:700px"></iframe>'}));
  await page.goto(origin+'/test-house');await page.frameLocator('iframe').getByRole('link',{name:'返回小家'}).click();await page.getByRole('heading',{name:'小家主页'}).waitFor();
  await page.setViewportSize({width:360,height:800});await page.goto(origin+'/doudizhu/');
  await page.locator('[data-ai-player="chatgpt"]').waitFor();
  assert.ok(await page.locator('[data-start]').isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.DDZ_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.DDZ_SCREENSHOT_DIR,'lobby-mobile.png')});
  assert.deepEqual(errors,[]);
  console.log('Browser: independent selection, persisted name/avatar, live play during IME, social history, desktop/mobile and direct/iframe home navigation passed');
} finally {
  await client.close();await browser?.close();
  child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});
}
