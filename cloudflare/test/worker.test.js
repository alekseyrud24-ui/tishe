import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{validateInput,splitParts,synthesize} from '../worker.js';

const input={voice:'ru-RU-DmitryNeural',text:'Проверка полного предложения.',rate:0.95,pitch:1};
const signal=()=>new AbortController().signal;
test('accepts both exact Microsoft voices without substituting them',()=>{
  for(const voice of ['ru-RU-DmitryNeural','ru-RU-SvetlanaNeural'])assert.equal(validateInput({...input,voice}).voice,voice);
  assert.throws(()=>validateInput({...input,voice:'other'}));
});
test('rejects bad pitch, rate, empty text and oversized input',()=>{
  for(const change of [{pitch:2},{rate:0.5},{rate:'1'},{pitch:NaN},{text:'  '},{text:'a'.repeat(12001)},{route:'https://example.com'}])assert.throws(()=>validateInput({...input,...change}));
});
test('splits Unicode by escaped UTF-8 size without losing characters',()=>{
  const text=('Слово & <текст> 😀 '.repeat(400)).trim();
  const chunks=splitParts(text);
  assert.equal(chunks.join(''),text);
  for(const chunk of chunks)assert.ok(new TextEncoder().encode(chunk.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}[c]))).length<=6000);
});
test('fallback switches routes while preserving voice, rate, pitch and sentence',async()=>{
  const calls=[],data=validateInput(input),blob=new Blob([new Uint8Array(1500)],{type:'audio/mpeg'});
  const result=await synthesize(data,signal(),async(...args)=>{
    calls.push(args.slice(0,3));if(calls.length===1)throw new Error('upstream interrupted');return blob;
  });
  assert.equal(calls.length,2);assert.notEqual(calls[0][2],calls[1][2]);
  assert.strictEqual(calls[0][0],calls[1][0]);assert.equal(calls[1][0].voice,input.voice);
  assert.equal(calls[1][0].rate,input.rate);assert.equal(calls[1][0].pitch,input.pitch);
  assert.equal(calls[1][1],input.text);assert.equal(result.blob.size,1500);
});
test('does not switch routes to get around an upstream 429',async()=>{
  let calls=0;
  await assert.rejects(synthesize(validateInput(input),signal(),async()=>{calls++;throw Object.assign(new Error('rate limit'),{status:429,retryAfter:20});}),{status:429});
  assert.equal(calls,1);
});
test('cancellation does not start another upstream request',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(synthesize(validateInput(input),controller.signal,async()=>{calls++;}),{status:499});
  assert.equal(calls,0);
});
test('health describes configuration rather than claiming a synthesis probe',async()=>{
  const response=await worker.fetch(new Request('https://test/health'),{},{}),data=await response.json();
  assert.equal(response.status,200);assert.deepEqual(data.voices,['ru-RU-DmitryNeural','ru-RU-SvetlanaNeural']);
});
test('rejects requests from an unrelated browser origin',async()=>{
  const response=await worker.fetch(new Request('https://test/api/tts',{method:'POST',headers:{Origin:'https://other.example'}}),{},{});
  assert.equal(response.status,403);
});
test('preflight permits the real reader origin',async()=>{
  const response=await worker.fetch(new Request('https://test/api/tts',{method:'OPTIONS',headers:{Origin:'https://alekseyrud24-ui.github.io'}}),{},{});
  assert.equal(response.status,204);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://alekseyrud24-ui.github.io');
});
test('explicitly requests ArrayBuffer websocket frames before accepting audio',async()=>{
  const previousFetch=globalThis.fetch,previousCaches=globalThis.caches;
  class Socket extends EventTarget {
    binaryType='blob';
    accept(){}
    close(){}
    send(message){
      if(!message.includes('Path:ssml'))return;
      const header=new TextEncoder().encode('Path:audio\r\nContent-Type:audio/mpeg\r\n');
      const data=new Uint8Array(2+header.length+1500);new DataView(data.buffer).setUint16(0,header.length);data.set(header,2);
      this.dispatchEvent(new MessageEvent('message',{data:'Path:audio.metadata\r\n\r\n{}'}));
      this.dispatchEvent(new MessageEvent('message',{data:this.binaryType==='arraybuffer'?data.buffer:new Blob([data])}));
      this.dispatchEvent(new MessageEvent('message',{data:'Path:turn.end\r\n\r\n'}));
    }
  }
  globalThis.fetch=async()=>({status:101,webSocket:new Socket()});
  globalThis.caches={default:{match:async()=>undefined,put:async()=>{}}};
  try{
    const response=await worker.fetch(new Request('https://test/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),{},{waitUntil:()=>{}});
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('X-Tishe-Complete'),'1');assert.equal((await response.blob()).size,1500);
  }finally{globalThis.fetch=previousFetch;globalThis.caches=previousCaches;}
});