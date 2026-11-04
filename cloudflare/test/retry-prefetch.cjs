const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const filename = process.argv[2];
const selected = process.argv[3] || 'all';
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
if (filename.endsWith('.html')) {
  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  source = scripts.find(s => s.includes('function retryReading(j,error)'));
  assert.ok(source, 'Inline reader script exists');
  source = source.slice(source.indexOf("(() => {\n  'use strict';\n  const $"));
}
const marker = source.indexOf('  window.AuraApp=');
assert.ok(marker > 0, 'Application definitions located');
const instrumented = source.slice(0, marker) + `
  globalThis.test = {
    speak, retryReading, retryNow, pause, resume, stop, setBlockSize, prefetchReadingAudio,
    configure(count=60) {
      settings.voice='online:ru-RU-DmitryNeural'; settings.blockSize=20;
      segments=Array.from({length:count},(_,i)=>({text:'Sentence '+i,p:0}));
      mode='LOADING';
    },
    snapshot:()=>({job,mode,index,generation,readingBlock,nextBlock,voice:settings.voice}),
    move(i){clearJob(job);job=null;index=i;mode='LOADING';speak();},
    cancel:cancelReading
  };
})();`;

function environment(transport) {
  const timers = new Map(), nodes = new Map(), events = [];
  let serial=0, now=100000;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      src:'', textContent:'', hidden:true, paused:true, dataset:{}, value:0, min:0, max:20,
      style:{setProperty(){}}, classList:{add(){},remove(){},toggle(){},contains(){return false;}},
      querySelector(){return {setAttribute(){},textContent:''};},
      setAttribute(){}, removeAttribute(){}, load(){}, pause(){this.paused=true;},
      play(){this.paused=false;events.push({type:'play',id});return new Promise(()=>{});}
    });
    return nodes.get(id);
  }
  const FakeDate = class extends Date { static now(){return now;} };
  const context = vm.createContext({
    console, Date:FakeDate, performance:{now:()=>now}, navigator:{userAgent:'test',platform:'test',onLine:true},
    window:{TisheMicrosoftDirect:class {synthesize(...args){return transport(...args);}}},
    document:{getElementById:id=>id.startsWith('seg-node-')?null:node(id), querySelectorAll:()=>[], body:node('body'),visibilityState:'visible'},
    matchMedia:()=>({matches:true}),
    setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);}, setInterval(){return ++serial;},clearInterval(){},
    URL:{createObjectURL:()=> 'blob:test-'+(++serial),revokeObjectURL(){}},
    DOMException, AbortController, AbortSignal, localStorage:{setItem(){}},
    innerHeight:1000
  });
  vm.runInContext(instrumented,context,{filename});
  context.test.configure();
  return {api:context.test, context,timers,events,nodes,
    fire(id){const timer=timers.get(id);assert.ok(timer,'Scheduled retry exists');timers.delete(id);now+=timer.ms;timer.fn();return timer.ms;}
  };
}
async function flush(){for(let i=0;i<40;i++)await Promise.resolve();}

async function retryChecks() {
  let requests=0;
  const e=environment(async()=>{requests++;throw new Error('[MS-CONNECT] Interrupted');});
  e.api.speak();await flush();
  const delays=[];
  for(let attempt=1;attempt<=20;attempt++) {
    const s=e.api.snapshot();
    assert.equal(s.mode,'RECONNECTING','Retry '+attempt+' must be offered');
    assert.equal(s.job.retryAttempts,attempt);
    const delay=e.timers.get(s.job.retryTimer)?.ms;
    assert.equal(delay,2000,'Retry '+attempt+' must keep the minimum 2000 ms delay');
    delays.push(e.fire(s.job.retryTimer));await flush();
  }
  assert.equal(requests,21,'One initial request plus exactly 20 retries');
  assert.equal(e.api.snapshot().mode,'ERROR','Stop after exhausting 20 retries');
  assert.match(e.nodes.get('appNotice').textContent,/20/);
  assert.equal(e.api.snapshot().index,0,'Do not skip the failed sentence');
  console.log('PASS retry limit: 20 retries, every delay 2000 ms; 21 total requests; position preserved');

  const limited=environment(async()=>{const err=new Error('[HTTP-429] Rate limited');err.retryAfterMs=15000;throw err;});
  limited.api.speak();await flush();
  const s=limited.api.snapshot();assert.equal(limited.timers.get(s.job.retryTimer).ms,15000);
  limited.api.retryNow(true);await flush();assert.equal(limited.api.snapshot().job,s.job,'Online event respects Retry-After');
  limited.api.pause();assert.equal(limited.api.snapshot().mode,'PAUSED');assert.ok(!limited.timers.has(s.job.retryTimer));
  limited.api.resume();assert.equal(limited.api.snapshot().mode,'RECONNECTING');
  assert.equal(limited.timers.get(limited.api.snapshot().job.retryTimer).ms,15000);
  console.log('PASS Retry-After and pause/resume guards');

  const offline=environment(async()=>{throw new Error('[MS-CONNECT] Offline');});
  offline.context.navigator.onLine=false;offline.api.speak();await flush();
  const off=offline.api.snapshot();assert.equal(off.job.retryAttempts,0,'Offline waiting does not consume connection attempts');
  assert.equal(offline.timers.get(off.job.retryTimer).ms,2000,'Offline checks also keep minimum delay');
  offline.api.cancel();assert.equal(offline.api.snapshot().job,null);
  console.log('PASS offline delay and cancellation');
}

function queuedEnvironment() {
  const requests=[],pending=[];let concurrent=0,maxConcurrent=0;
  const e=environment((voice,text)=>new Promise((resolve,reject)=>{
    concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
    requests.push({text,voice});
    pending.push({resolve(){concurrent--;resolve({blob:{}});},reject(){concurrent--;reject(new Error('[MS-CONNECT] Interrupted'));}});
  }));
  return {...e,requests,pending,maxConcurrent:()=>maxConcurrent};
}
async function complete(e,n){for(let i=0;i<n;i++){assert.ok(e.pending.length,'Request waiting for completion');e.pending.shift().resolve();await flush();}}
async function prefetchChecks() {
  const e=queuedEnvironment();e.api.speak();await flush();
  assert.equal(e.requests.length,1);
  await complete(e,19);assert.equal(e.requests.length,20,'No parallel batch before first 20 complete');
  assert.equal(e.api.snapshot().readingBlock.sources.size,19);
  await complete(e,1);
  assert.equal(e.requests.length,21,'Sentence 21 must start immediately after sentence 20 completes, without waiting for play()');
  assert.equal(e.requests[20].text,'Sentence 20');
  assert.equal(e.api.snapshot().nextBlock.start,20);
  assert.equal(e.api.snapshot().nextBlock.end,40);
  assert.equal(e.api.snapshot().readingBlock.sources.size,20);
  assert.ok(e.events.some(event=>event.type==='play'),'Playback was requested but its promise is still unresolved');
  await complete(e,20);
  assert.equal(e.requests.length,40,'Keep only current and next 20-sentence blocks');
  assert.equal(e.maxConcurrent(),1,'Sequential transport, no request burst');
  e.api.move(20);await flush();
  assert.equal(e.requests.length,41,'Third block starts as soon as ready second block becomes current');
  await complete(e,20);assert.equal(e.requests.length,60);
  assert.equal(e.api.snapshot().nextBlock.sources.size,20);
  e.api.move(40);await flush();assert.equal(e.requests.length,60,'No requests beyond end of document');
  assert.equal(e.api.snapshot().nextBlock,null);
  console.log('PASS 20+20 prefetch before play() completion, sequential downloads, rolling third block, document end');

  const stopped=queuedEnvironment();stopped.api.speak();await flush();await complete(stopped,19);
  stopped.api.cancel();await complete(stopped,1);assert.equal(stopped.requests.length,20,'No next block after stop');
  console.log('PASS cancellation at block boundary');

  const partial=queuedEnvironment();partial.api.speak();await flush();await complete(partial,20);
  await complete(partial,4);partial.pending.shift().reject();await flush();
  assert.equal(partial.api.snapshot().nextBlock.sources.size,4,'Preserve downloaded sentences after background failure');
  partial.api.move(20);await flush();
  assert.equal(partial.requests.at(-1).text,'Sentence 24','Resume at failed sentence, do not redownload completed audio');
  await complete(partial,16);assert.equal(partial.api.snapshot().readingBlock.sources.size,20);
  console.log('PASS partial next-block recovery without redownloading completed sentences');
}
(async()=>{
  if(selected==='all'||selected==='retry')await retryChecks();
  if(selected==='all'||selected==='prefetch')await prefetchChecks();
})().catch(error=>{console.error(error);process.exitCode=1;});
