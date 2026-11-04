// Own HTTPS relay. Persistent audio cache is local to this browser, never a voice fallback.
(() => {
  'use strict';
  const BASE='https://tishe-voice.aleksey-rud24.workers.dev';
  const VERSION='2026.11.04-cloud-1';
  const MAX_BYTES=48*1024*1024,MAX_RECORDS=160;
  let database;
  function openDatabase(){
    if(database)return database;
    database=new Promise(resolve=>{
      if(!window.indexedDB){resolve(null);return;}
      const request=indexedDB.open('tishe-audio-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('audio',{keyPath:'key'});
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();database=null;};resolve(db);};
      request.onerror=request.onblocked=()=>resolve(null);
    });
    return database;
  }
  async function cached(key){
    const db=await openDatabase();if(!db)return null;
    return new Promise(resolve=>{
      try{
        const tx=db.transaction('audio','readonly'),request=tx.objectStore('audio').get(key);
        request.onsuccess=()=>{const item=request.result;resolve(item&&Date.now()-item.created<7*86400000&&item.blob instanceof Blob&&item.blob.size>=1000?item:null);};
        request.onerror=()=>resolve(null);
      }catch(_){resolve(null);}
    });
  }
  async function saveCached(item){
    const db=await openDatabase();if(!db)return;
    return new Promise(resolve=>{
      try{
        const tx=db.transaction('audio','readwrite'),store=tx.objectStore('audio');
        store.put(item);
        const all=store.getAll();
        all.onsuccess=()=>{
          const records=all.result.sort((a,b)=>a.created-b.created);
          let size=records.reduce((n,r)=>n+r.blob.size,0),count=records.length;
          for(const record of records){if(size<=MAX_BYTES&&count<=MAX_RECORDS&&Date.now()-record.created<7*86400000)break;store.delete(record.key);size-=record.blob.size;count--;}
        };
        tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();
      }catch(_){resolve();}
    });
  }
  const check=signal=>{if(signal?.aborted)throw new DOMException('Reading cancelled','AbortError');};
  class CloudMicrosoft {
    async synthesize(voice,text,rate=1,pitch=1,signal){
      check(signal);
      const raw=JSON.stringify([VERSION,voice,rate,pitch,text]);
      let key;
      try{key=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');}catch(_){key=null;}
      if(key){const hit=await cached(key);check(signal);if(hit)return {...hit,transport:'browser-cache'};}
      const controller=new AbortController(),abort=()=>controller.abort();
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
      const timer=setTimeout(()=>controller.abort(),90000);
      try{
        const response=await fetch(BASE+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice,text,rate,pitch}),signal:controller.signal,referrerPolicy:'no-referrer',cache:'no-store'});
        if(!response.ok){
          const data=await response.json().catch(()=>({}));
          const error=new Error('[HTTP-'+response.status+'] '+(data.error||'Облачный мост Microsoft недоступен.'));
          error.retryable=data.retryable??[408,425,429,500,502,503,504].includes(response.status);
          const after=response.headers.get('Retry-After');
          error.retryAfterMs=after?(Number.isFinite(Number(after))?Number(after)*1000:Math.max(0,Date.parse(after)-Date.now()))||0:0;
          throw error;
        }
        if(response.headers.get('X-Tishe-Complete')!=='1'||response.headers.get('X-Tishe-Voice')!==voice)throw new Error('[MS-INCOMPLETE] Мост не подтвердил полный синтез выбранного голоса.');
        const blob=await response.blob();check(signal);
        if(blob.type!=='audio/mpeg'||blob.size<1000||blob.size>4*1024*1024)throw new Error('[MS-INCOMPLETE] Мост не вернул полную MP3-запись.');
        const item={key,blob,voice,rate,pitch,parts:Number(response.headers.get('X-Tishe-Parts'))||1,route:response.headers.get('X-Tishe-Route')||'',created:Date.now()};
        if(key)saveCached(item).catch(()=>{});
        return {...item,transport:response.headers.get('X-Tishe-Cache')==='HIT'?'edge-cache':'cloud-worker'};
      }catch(error){
        if(signal?.aborted)throw new DOMException('Reading cancelled','AbortError');
        if(controller.signal.aborted)throw new Error('[MS-TIMEOUT] Облачный мост не ответил вовремя.');
        throw error;
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    }
  }
  window.TisheMicrosoftCloud=CloudMicrosoft;
})();