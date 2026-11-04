import {validationCode, escape} from './protocol.js';

const VERSION='2026.11.04-cloud-1';
const CLIENT='6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const VOICES=new Set(['ru-RU-DmitryNeural','ru-RU-SvetlanaNeural']);
const ROUTES={
  bing:'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=',
  edge:'https://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key='
};
const encoder=new TextEncoder(), decoder=new TextDecoder();
const inflight=new Map(), clients=new Map();
let preferred='edge', preferUntil=0;

class TtsError extends Error {
  constructor(message,status=502,retryable=true,retryAfter=0){super(message);Object.assign(this,{status,retryable,retryAfter});}
}

export function splitParts(text,maxBytes=6000) {
  const result=[];let piece='',length=0;
  for(const char of text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,' ')) {
    const size=encoder.encode(escape(char)).length;
    if(length+size>maxBytes) {
      const space=piece.lastIndexOf(' '),cut=space>piece.length/2?space+1:piece.length;
      result.push(piece.slice(0,cut));piece=piece.slice(cut);length=encoder.encode(escape(piece)).length;
    }
    piece+=char;length+=size;
  }
  if(piece.trim())result.push(piece);
  return result;
}

export function validateInput(input) {
  if(!input||!VOICES.has(input.voice)||typeof input.text!=='string'||!input.text.trim())throw new TtsError('Некорректный текст или голос.',400,false);
  if(input.text.length>12000)throw new TtsError('Одно предложение превышает 12 000 символов.',413,false);
  const rate=input.rate??1,pitch=input.pitch??1;
  if(typeof rate!=='number'||!Number.isFinite(rate)||rate<0.8||rate>1.5||typeof pitch!=='number'||!Number.isFinite(pitch)||pitch<0.7||pitch>1.3)throw new TtsError('Некорректные скорость или высота.',400,false);
  const route=input.route??'auto';
  if(!['auto','bing','edge'].includes(route))throw new TtsError('Неизвестный маршрут.',400,false);
  const parts=splitParts(input.text);
  if(!parts.length||parts.length>8)throw new TtsError('Предложение слишком длинное для одной записи.',413,false);
  return {voice:input.voice,text:input.text,rate,pitch,route,parts};
}

function retrySeconds(value) {
  if(!value)return 0;
  const n=Number(value);return Number.isFinite(n)?Math.max(0,n):Math.max(0,Math.ceil((Date.parse(value)-Date.now())/1000))||0;
}

async function turn(input,text,route,signal) {
  const id=crypto.randomUUID().replaceAll('-','');
  const url=ROUTES[route]+CLIENT+'&ConnectionId='+id+'&Sec-MS-GEC='+validationCode()+'&Sec-MS-GEC-Version=2-143.0.3650.75';
  let response;
  try {
    response=await fetch(url,{
      headers:{Upgrade:'websocket','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0','Accept-Language':'en-US,en;q=0.9','Cache-Control':'no-cache'},
      signal:AbortSignal.any([signal,AbortSignal.timeout(7000)])
    });
  }catch(error){throw new TtsError('Microsoft: подключение не установлено ('+route+').',502,true);}
  if(response.status!==101||!response.webSocket){
    const code=response.status;
    await response.body?.cancel().catch(()=>{});
    throw new TtsError('Microsoft: HTTP '+code+' ('+route+').',code===429?429:502,code!==400,retrySeconds(response.headers.get('Retry-After')));
  }
  const ws=response.webSocket;
  ws.binaryType='arraybuffer';
  return new Promise((resolve,reject)=>{
    let done=false,size=0,metadata=false,timer,totalTimer;
    const chunks=[];
    const finish=(error)=>{
      if(done)return;done=true;clearTimeout(timer);clearTimeout(totalTimer);
      ws.removeEventListener('message',message);ws.removeEventListener('close',closed);ws.removeEventListener('error',failed);signal.removeEventListener('abort',aborted);
      try{ws.close(1000,'finished');}catch(_){}
      if(error)reject(error);else resolve(new Blob(chunks,{type:'audio/mpeg'}));
    };
    const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(new TtsError('Microsoft: передача аудио не завершена ('+route+').')),8000);};
    const aborted=()=>finish(new TtsError('Запрос отменён.',499,false));
    const closed=()=>finish(new TtsError('Microsoft: соединение закрыто до конца записи ('+route+').'));
    const failed=()=>finish(new TtsError('Microsoft: ошибка передачи ('+route+').'));
    const message=event=>{
      if(done)return;touch();
      if(typeof event.data==='string'){
        if(event.data.includes('Path:audio.metadata'))metadata=true;
        if(event.data.includes('Path:turn.end'))finish(size>=1000&&metadata?null:new TtsError('Microsoft: неполная запись ('+route+').'));
        return;
      }
      const data=new Uint8Array(event.data);
      if(data.length<2)return finish(new TtsError('Microsoft: повреждённый пакет.'));
      const length=(data[0]<<8)|data[1];
      if(length+2>data.length)return finish(new TtsError('Microsoft: неполный пакет.'));
      const headers=decoder.decode(data.subarray(2,2+length));
      if(!headers.includes('Path:audio'))return;
      const audio=data.slice(2+length);
      if(!audio.length)return;
      if(!headers.includes('audio/mpeg'))return finish(new TtsError('Microsoft: неожиданный формат записи.'));
      chunks.push(audio);size+=audio.length;
      if(size>4*1024*1024)finish(new TtsError('Microsoft: запись слишком велика.',413,false));
    };
    ws.addEventListener('message',message);ws.addEventListener('close',closed);ws.addEventListener('error',failed);signal.addEventListener('abort',aborted,{once:true});
    touch();totalTimer=setTimeout(()=>finish(new TtsError('Microsoft: превышено время синтеза.')),25000);
    ws.accept();
    if(signal.aborted)return aborted();
    const stamp=new Date().toISOString().replace(/[-:.]/g,'').slice(0,-1);
    const signed=n=>(n>=0?'+':'')+n;
    const name='Microsoft Server Speech Text to Speech Voice ('+input.voice.slice(0,5)+', '+input.voice.slice(6)+')';
    const ssml="<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ru-RU'><voice name='"+name+"'><prosody pitch='"+signed(Math.round((input.pitch-1)*80))+"Hz' rate='"+signed(Math.round((input.rate-1)*100))+"%' volume='+0%'>"+escape(text)+"</prosody></voice></speak>";
    try{
      ws.send('X-Timestamp:'+stamp+'\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'+JSON.stringify({context:{synthesis:{audio:{metadataoptions:{sentenceBoundaryEnabled:'true',wordBoundaryEnabled:'false'},outputFormat:'audio-24khz-48kbitrate-mono-mp3'}}}})+'\r\n');
      ws.send('X-RequestId:'+id+'\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:'+stamp+'Z\r\nPath:ssml\r\n\r\n'+ssml);
    }catch(_){failed();}
  });
}

export async function synthesize(input,signal,runTurn=turn) {
  const audio=[],used=new Set();let size=0;
  for(const text of input.parts){
    const first=Date.now()<preferUntil?preferred:'edge';
    const routes=input.route==='auto'?[first,first==='bing'?'edge':'bing']:[input.route];
    let complete,lastError;
    for(const route of routes){
      if(signal.aborted)throw new TtsError('Запрос отменён.',499,false);
      try{complete=await runTurn(input,text,route,signal);used.add(route);preferred=route;preferUntil=Date.now()+60000;break;}
      catch(error){lastError=error;if(error.status===429||error.retryable===false)throw error;}
    }
    if(!complete)throw lastError;
    audio.push(complete);size+=complete.size;
    if(size>4*1024*1024)throw new TtsError('Запись слишком велика.',413,false);
  }
  return {blob:new Blob(audio,{type:'audio/mpeg'}),route:[...used].join(','),parts:audio.length};
}

function headersFor(origin){
  return {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST,GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Expose-Headers':'X-Tishe-Complete,X-Tishe-Voice,X-Tishe-Route,X-Tishe-Cache,X-Tishe-Parts,Retry-After','Vary':'Origin','X-Content-Type-Options':'nosniff'};
}

function wrap(response,origin,extra={}){
  const headers=new Headers(response.headers);
  for(const [k,v] of Object.entries({...headersFor(origin),...extra}))headers.set(k,v);
  return new Response(response.body,{status:response.status,headers});
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url),origin=request.headers.get('Origin')||'';
    const allowed=(env.ALLOWED_ORIGINS||'https://alekseyrud24-ui.github.io').split(',');
    if(origin&&!allowed.includes(origin)&&origin!==url.origin)return new Response('Origin not allowed',{status:403});
    const corsOrigin=origin||allowed[0];
    try{
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers:headersFor(corsOrigin)});
      if(url.pathname==='/health'&&request.method==='GET')return wrap(Response.json({ok:true,version:VERSION,voices:[...VOICES],routes:Object.keys(ROUTES)}),corsOrigin);
      if(url.pathname!=='/api/tts')return wrap(new Response('Not found',{status:404}),corsOrigin);
      if(request.method!=='POST')return wrap(new Response('Method not allowed',{status:405,headers:{Allow:'POST,OPTIONS'}}),corsOrigin);
      if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new TtsError('Требуется JSON.',415,false);
      const ip=request.headers.get('CF-Connecting-IP')||'local',now=Date.now();
      let client=clients.get(ip);
      if(!client||now>client.until){client={n:0,until:now+60000};clients.set(ip,client);}
      if(++client.n>180)throw new TtsError('Слишком много запросов. Подожди минуту.',429,true,Math.ceil((client.until-now)/1000));
      if(clients.size>512)for(const [key,value] of clients)if(now>value.until)clients.delete(key);
      if(Number(request.headers.get('Content-Length'))>65536)throw new TtsError('Запрос слишком большой.',413,false);
      const reader=request.body?.getReader();if(!reader)throw new TtsError('Пустой запрос.',400,false);
      const chunks=[];let size=0;
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new TtsError('Запрос слишком большой.',413,false);}chunks.push(value);}
      let body;try{body=JSON.parse(await new Blob(chunks).text());}catch(_){throw new TtsError('Некорректный JSON.',400,false);}
      const input=validateInput(body);
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify([VERSION,input.voice,input.rate,input.pitch,input.text,input.route])))),v=>v.toString(16).padStart(2,'0')).join('');
      const key=new Request(url.origin+'/__audio/'+hash),store=caches.default;
      const cached=await store.match(key);
      if(cached)return wrap(cached,corsOrigin,{'X-Tishe-Cache':'HIT','Cache-Control':'private, max-age=86400'});
      let pending=inflight.get(hash);
      if(!pending){pending=synthesize(input,request.signal).finally(()=>inflight.delete(hash));inflight.set(hash,pending);}
      const result=await pending;
      const response=new Response(result.blob,{headers:{'Content-Type':'audio/mpeg','X-Tishe-Complete':'1','X-Tishe-Voice':input.voice,'X-Tishe-Route':result.route,'X-Tishe-Parts':String(result.parts),'X-Tishe-Version':VERSION,'Cache-Control':'public, max-age=86400'}});
      ctx.waitUntil(store.put(key,response.clone()).catch(()=>{}));
      return wrap(response,corsOrigin,{'X-Tishe-Cache':'MISS','Cache-Control':'private, max-age=86400'});
    }catch(error){
      const status=error instanceof TtsError?error.status:502;
      const response=Response.json({error:error instanceof TtsError?error.message:'Не удалось завершить синтез Microsoft.',retryable:error.retryable!==false},{status,headers:{'Cache-Control':'no-store',...(error.retryAfter?{'Retry-After':String(error.retryAfter)}:{})}});
      return wrap(response,corsOrigin);
    }
  }
};