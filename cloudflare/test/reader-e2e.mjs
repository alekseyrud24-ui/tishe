import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const dest=path.join(process.env.LOCALAPPDATA,'hermes/cache/scratch/tishe-browser-check');
mkdirSync(dest,{recursive:true});
const target=process.argv[2]||'candidate';
let server;
if(target==='candidate'){
  const html=readFileSync(path.join(root,existsSync(path.join(root,'index.html'))?'index.html':'Тише — облачный мост.html'));
  server=createServer((req,res)=>{if(!['/','/index.html'].includes(req.url)){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);});
  await new Promise(resolve=>server.listen(17844,'127.0.0.1',resolve));
}
const url=target==='candidate'?'http://127.0.0.1:17844/':target;
const proxyUrl=process.env.HTTPS_PROXY||process.env.HTTP_PROXY;
const proxy=proxyUrl?(()=>{const u=new URL(proxyUrl);return {server:u.origin,username:decodeURIComponent(u.username),password:decodeURIComponent(u.password),bypass:'127.0.0.1,localhost'};})():undefined;
const browser=await chromium.launch({channel:'chrome',headless:true,proxy});
const context=await browser.newContext({viewport:{width:1280,height:900}});
const errors=[],report={target:url};
await context.addInitScript(()=>{
  window.__ttsChecks={requests:[],plays:[],native:0};
  const originalFetch=window.fetch;
  window.fetch=async(...args)=>{
    if(!String(args[0]).includes('/api/tts'))return originalFetch(...args);
    const request={...JSON.parse(args[1].body),start:performance.now()};window.__ttsChecks.requests.push(request);
    try{
      const response=await originalFetch(...args);request.status=response.status;request.route=response.headers.get('X-Tishe-Route');
      response.clone().blob().then(blob=>{request.bytes=blob.size;request.end=performance.now();});return response;
    }catch(error){request.error=error.name;request.end=performance.now();throw error;}
  };
  for(const type of ['playing','ended'])document.addEventListener(type,event=>{
    if(event.target instanceof HTMLMediaElement)window.__ttsChecks.plays.push({type,id:event.target.id,time:performance.now(),position:document.querySelector('.sentence-node.active')?.id,src:event.target.src.slice(0,5)});
  },true);
  if(window.speechSynthesis){const speak=speechSynthesis.speak.bind(speechSynthesis);speechSynthesis.speak=(...args)=>{window.__ttsChecks.native++;return speak(...args);};}
});
const page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
async function loaded(){await page.waitForFunction(()=>typeof window.AuraApp?.togglePlay==='function');}
async function playing(){await page.waitForFunction(()=>[...document.querySelectorAll('#neuralAudioA,#neuralAudioB')].some(a=>!a.paused&&a.currentTime>0.1),{},{timeout:150000});}
async function applyText(text,title='Проверка облачной версии'){
  await page.evaluate(()=>AuraApp.toggleEditor(true));
  await page.locator('#editDocTitle').fill(title);await page.locator('#editorTextarea').fill(text);
  await page.locator('[onclick="window.AuraApp.saveEditorText(false)"]').click();
}
try{
  await page.goto(url,{waitUntil:'domcontentloaded'});await loaded();
  assert.equal(await page.locator('#selectVoiceEngine').inputValue(),'online:ru-RU-DmitryNeural');
  assert.match(await page.locator('#sourceHint').textContent(),/Cloudflare/);
  report.initialCloudVoice=true;
  for(const voice of ['ru-RU-DmitryNeural','ru-RU-SvetlanaNeural']){
    await page.evaluate(()=>AuraApp.toggleStudio(true));
    await page.locator('#selectPreviewVoice').selectOption('online:'+voice);
    await page.locator('#btnPreviewVoice').click();
    await page.waitForFunction(()=>document.querySelector('#previewStatusText').textContent.startsWith('Проба завершена'),{},{timeout:60000});
    assert.ok(await page.locator('#previewAudio').evaluate(a=>a.duration>1&&a.currentTime>1));
    report[voice]={preview:'completed',seconds:await page.locator('#previewAudio').evaluate(a=>a.duration)};
    await page.evaluate(()=>AuraApp.toggleStudio(false));
  }
  await page.evaluate(()=>AuraApp.onVoiceChange('online:ru-RU-DmitryNeural'));
  const cacheResult=await page.evaluate(async()=>{
    const text='Проверка голоса. Настрой громкость и темп так, чтобы слушать было удобно.';
    const before=__ttsChecks.requests.length,result=await new TisheMicrosoftCloud().synthesize('ru-RU-DmitryNeural',text,0.95,1);
    return {extraRequests:__ttsChecks.requests.length-before,transport:result.transport,bytes:result.blob.size};
  });
  assert.equal(cacheResult.extraRequests,0);assert.equal(cacheResult.transport,'browser-cache');report.persistentCache=cacheResult;
  await applyText(Array.from({length:40},(_,i)=>'Предложение номер '+(i+1)+'.').join(' '));
  await page.evaluate(()=>{AuraApp.setBlockSize(20);AuraApp.setPauseMs(0);});
  await page.locator('#btnMainPlay').click();
  await page.waitForFunction(()=>__ttsChecks.requests.some(r=>r.text==='Предложение номер 3.'),{},{timeout:60000});
  await page.locator('#btnMainPlay').click();
  await page.waitForFunction(()=>__ttsChecks.requests.filter(r=>r.text.startsWith('Предложение номер ')&&r.status===200&&r.end).length===40,{},{timeout:180000});
  assert.match(await page.locator('#lblStateText').textContent(),/ПАУЗА/);
  assert.ok(await page.evaluate(()=>[...document.querySelectorAll('#neuralAudioA,#neuralAudioB')].every(a=>a.paused)));
  report.pauseDuringLoading='remained paused after both blocks completed';
  const batches=await page.evaluate(()=>__ttsChecks.requests.filter(r=>r.text.startsWith('Предложение номер ')));
  assert.equal(batches.length,40);assert.ok(batches.every(r=>r.status===200&&r.bytes>1000&&r.voice==='ru-RU-DmitryNeural'));
  const byText=n=>batches.find(r=>r.text==='Предложение номер '+n+'.');
  const gap=byText(21).start-byText(20).end;
  assert.ok(gap<300,'Next block must start immediately; gap='+gap);
  report.blocks={requests:40,prefetchGapMs:Math.round(gap),voicesPreserved:true};
  await page.locator('#btnMainPlay').click();await playing();
  await page.locator('#btnMainPlay').click();
  const paused=await page.evaluate(()=>[...document.querySelectorAll('#neuralAudioA,#neuralAudioB')].find(a=>a.src.startsWith('blob:')&&a.currentTime>0)?.currentTime);
  await page.waitForTimeout(700);
  const still=await page.evaluate(()=>[...document.querySelectorAll('#neuralAudioA,#neuralAudioB')].find(a=>a.src.startsWith('blob:')&&a.currentTime>0)?.currentTime);
  assert.equal(paused,still);
  await page.locator('#btnMainPlay').click();await playing();report.pauseResume='same recording, position retained';
  await page.waitForFunction(()=>Number(document.querySelector('.sentence-node.active')?.id.replace('seg-node-',''))>=20,{},{timeout:100000});
  const transition=await page.evaluate(()=>__ttsChecks.plays);
  const p21=transition.find(e=>e.type==='playing'&&e.position==='seg-node-20');
  if(!p21)await page.waitForFunction(()=>__ttsChecks.plays.some(e=>e.type==='playing'&&e.position==='seg-node-20'),{},{timeout:5000});
  const transitions=await page.evaluate(()=>__ttsChecks.plays),start21=transitions.find(e=>e.type==='playing'&&e.position==='seg-node-20');
  const end20=transitions.filter(e=>e.type==='ended'&&e.position==='seg-node-19').at(-1);
  assert.ok(start21&&end20);report.blocks.playbackBoundaryGapMs=Math.round(start21.time-end20.time);
  assert.ok(start21.time-end20.time<1000);
  await page.evaluate(()=>AuraApp.stop());
  await page.waitForTimeout(300);await page.reload({waitUntil:'domcontentloaded'});await loaded();
  assert.equal(await page.locator('#selectVoiceEngine').inputValue(),'online:ru-RU-DmitryNeural');
  assert.equal(await page.locator('.sentence-node').count(),40);
  assert.equal(await page.locator('.sentence-node.active').getAttribute('id'),'seg-node-20');report.restore='text, voice and position retained';
  // Exercise a real fetch failure at the browser seam; the successful retry still uses the public Worker.
  await applyText('После сбоя читается та же фраза. Следующая фраза.');
  await page.evaluate(()=>AuraApp.setBlockSize(1));
  let failFirst=true;
  await page.route('**/api/tts',async route=>{if(failFirst){failFirst=false;await route.fulfill({status:503,contentType:'application/json',headers:{'Access-Control-Allow-Origin':new URL(url).origin},body:JSON.stringify({error:'Injected transient test failure',retryable:true})});}else await route.continue();});
  await page.locator('#btnMainPlay').click();
  await page.waitForFunction(()=>document.querySelector('#lblStateText').textContent.includes('ПЕРЕПОДКЛЮЧЕНИЕ'),{},{timeout:10000});
  assert.match(await page.locator('#lblStateText').textContent(),/1 \/ 20/);
  await playing();
  const retry=await page.evaluate(()=>__ttsChecks.requests.filter(r=>r.text==='После сбоя читается та же фраза.'));
  assert.equal(retry.length,2);assert.equal(retry[0].voice,retry[1].voice);assert.ok(retry[1].start-retry[0].end>=1950);
  report.retry={attempts:retry.length-1,delayMs:Math.round(retry[1].start-retry[0].end),sameSentence:true,sameVoice:true};
  await page.evaluate(()=>AuraApp.stop());await page.unroute('**/api/tts');
  assert.equal(await page.evaluate(()=>__ttsChecks.native),0);report.nativeFallbackCalls=0;
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const phone=await mobile.newPage();await phone.goto(url,{waitUntil:'domcontentloaded'});await phone.waitForFunction(()=>window.AuraApp);
  await phone.evaluate(()=>{AuraApp.toggleEditor(true);document.querySelector('#editorTextarea').value='Проверка на узком экране.';AuraApp.saveEditorText(false);});
  const layout=await phone.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,voice:document.querySelector('#selectVoiceEngine').value}));
  assert.ok(layout.scroll<=layout.width+1);assert.equal(layout.voice,'online:ru-RU-DmitryNeural');report.mobileViewport=layout;
  await phone.screenshot({path:path.join(dest,'reader-mobile.png'),fullPage:true});await mobile.close();
  assert.deepEqual(errors,[]);report.pageErrors=errors;
  console.log(JSON.stringify(report,null,2));
  writeFileSync(path.join(dest,target==='candidate'?'candidate-results.json':'published-results.json'),JSON.stringify(report,null,2));
}catch(error){
  report.failure=error.message;report.state=await page.evaluate(()=>({status:document.querySelector('#lblStateText')?.textContent,notice:document.querySelector('#appNotice')?.textContent,requests:window.__ttsChecks?.requests})).catch(()=>null);
  writeFileSync(path.join(dest,'failure.json'),JSON.stringify(report,null,2));
  console.error(JSON.stringify(report,null,2));throw error;
}finally{await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}