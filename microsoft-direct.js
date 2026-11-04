// Direct Microsoft Read Aloud transport. No account keys, relay or external scripts.
(function microsoftRuntime(frameChannel) {
  'use strict';
  const client='6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const endpoints=[
    'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=',
    'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken='
  ];
  const known=new Set(['ru-RU-DmitryNeural','ru-RU-SvetlanaNeural']);
  const encoder=new TextEncoder(),decoder=new TextDecoder();
  const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  const multiply=(a,b)=>Math.imul(a,b)>>>0;
  const swap=n=>((n<<16)|(n>>>16))>>>0;
  const rotate=(n,b)=>(n>>>b)|(n<<(32-b));

  // The small SHA-256 implementation also works in local-file WebViews without crypto.subtle.
  function sha256(input) {
    const constants=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const state=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const padded=new Uint8Array(Math.ceil((input.length+9)/64)*64),view=new DataView(padded.buffer),words=new Uint32Array(64);
    padded.set(input);padded[input.length]=0x80;view.setUint32(padded.length-4,input.length*8);
    for(let offset=0;offset<padded.length;offset+=64) {
      for(let i=0;i<16;i++)words[i]=view.getUint32(offset+i*4);
      for(let i=16;i<64;i++) {
        const x=words[i-15],y=words[i-2];
        words[i]=(words[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+words[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10)))>>>0;
      }
      let [a,b,c,d,e,f,g,h]=state;
      for(let i=0;i<64;i++) {
        const t=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+words[i])>>>0;
        const u=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
        h=g;g=f;f=e;e=(d+t)>>>0;d=c;c=b;b=a;a=(t+u)>>>0;
      }
      [a,b,c,d,e,f,g,h].forEach((n,i)=>{state[i]=(state[i]+n)>>>0;});
    }
    const result=new Uint8Array(32),out=new DataView(result.buffer);
    state.forEach((n,i)=>out.setUint32(i*4,n));return result;
  }
  function validationCode(milliseconds=Date.now()) {
    let seconds=Math.floor(milliseconds/1000)+11644473600;seconds-=seconds%300;
    const data=encoder.encode('Copyright (C) Microsoft Corporation. All rights reserved.'+String(BigInt(seconds)*10000000n)+client);
    const hash=sha256(data),digest=new DataView(hash.buffer);
    const a=digest.getUint32(0,true)|1,b=digest.getUint32(4,true)|1;
    const padded=new Uint8Array(Math.ceil(data.length/8)*8);padded.set(data);const words=new DataView(padded.buffer);
    let total=0,last=0,state=0,chain=0;
    for(let i=0;i<padded.length;i+=8) {
      const x=words.getUint32(i,true),y=words.getUint32(i+4,true);
      let q=multiply(swap((multiply(swap(x),0xef0569fb)+multiply(x,a))>>>0),0x76f50f34);
      total=(total+multiply(swap(q),0xc3efea97)+q)>>>0;
      q=multiply(swap((multiply(swap(y),0xc31713db)+multiply(y,b))>>>0),0x1881ce3c);
      last=(multiply(swap(q),0x35bd1ec9)+q)>>>0;total=(total+last)>>>0;
      state=multiply((state+x)>>>0,a);
      for(const coefficient of [0xcf98b111,0x87085b9f,0x12ceb96d,0x257e1d83])state=multiply(swap(state),coefficient);
      let t=multiply((state+y)>>>0,b);t=multiply(swap(t),0xa27416f5);t=swap(multiply(swap(t),0xd38396ff));
      chain=(chain+state)>>>0;state=multiply(swap(multiply(t,0x7c932b89)),0xbfa49f69);chain=(chain+state)>>>0;
    }
    const prefix=new Uint8Array(8),view=new DataView(prefix.buffer);view.setUint32(0,(last^state)>>>0,true);view.setUint32(4,(total^chain)>>>0,true);
    return hex(prefix)+'-'+hex(hash);
  }
  function requestId() {
    const bytes=new Uint8Array(16);
    if(globalThis.crypto?.getRandomValues)crypto.getRandomValues(bytes);
    else for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
    return hex(bytes);
  }
  const escape=text=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}[c]));
  function parts(text) {
    const result=[];let piece='',bytes=0;
    for(const char of text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'')) {
      const count=encoder.encode(escape(char)).length;
      if(bytes+count>400) {
        const space=piece.lastIndexOf(' ');
        const cut=space>0&&encoder.encode(escape(piece.slice(space+1))).length+count<=400?space+1:piece.length;
        result.push(piece.slice(0,cut));piece=piece.slice(cut);bytes=encoder.encode(escape(piece)).length;
      }
      piece+=char;bytes+=count;
    }
    if(piece.trim())result.push(piece);return result;
  }
  function turn(voice,text,rate,pitch,route) {
    return new Promise((resolve,reject)=>{
      const id=requestId(),chunks=[];let settled=false,opened=false,metadata=false,size=0,timer,totalTimer;
      let socket;
      try{socket=new WebSocket(endpoints[route]+client+'&ConnectionId='+requestId()+'&Sec-MS-GEC='+validationCode()+'&Sec-MS-GEC-Version=2-143.0.3650.75');}
      catch(error){reject(new Error('[MS-INIT] Браузер не создал подключение Microsoft: '+error.name+'.'));return;}
      socket.binaryType='arraybuffer';
      const finish=(error,result)=>{
        if(settled)return;settled=true;clearTimeout(timer);clearTimeout(totalTimer);
        socket.onmessage=socket.onerror=socket.onclose=socket.onopen=null;socket.close();
        if(error)reject(error);else resolve(result);
      };
      const wait=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(new Error('[MS-TIMEOUT] '+(opened?'Microsoft не завершил передачу аудио.':'Нет ответа при подключении к Microsoft.'))),18000);};
      wait();totalTimer=setTimeout(()=>finish(new Error('[MS-TIMEOUT] Превышено время синтеза фразы Microsoft.')),45000);
      socket.onopen=()=>{
        opened=true;wait();const stamp=new Date().toUTCString();
        try {
          socket.send('X-Timestamp:'+stamp+'\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'+JSON.stringify({context:{synthesis:{audio:{metadataoptions:{sentenceBoundaryEnabled:'true',wordBoundaryEnabled:'false'},outputFormat:'audio-24khz-48kbitrate-mono-mp3'}}}})+'\r\n');
          const name='Microsoft Server Speech Text to Speech Voice ('+voice.slice(0,5)+', '+voice.slice(6)+')';
          const signed=n=>(n>=0?'+':'')+n;
          const ssml="<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='"+name+"'><prosody pitch='"+signed(Math.round((pitch-1)*80))+"Hz' rate='"+signed(Math.round((rate-1)*100))+"%' volume='+0%'>"+escape(text)+"</prosody></voice></speak>";
          socket.send('X-RequestId:'+id+'\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:'+stamp+'Z\r\nPath:ssml\r\n\r\n'+ssml);
        }catch(_){finish(new Error('[MS-SEND] Не удалось отправить запрос озвучки Microsoft.'));}
      };
      socket.onmessage=event=>{
        wait();
        if(typeof event.data==='string') {
          if(event.data.includes('Path:audio.metadata'))metadata=true;
          if(event.data.includes('Path:turn.end')) {
            if(size<1000||!metadata)finish(new Error('[MS-INCOMPLETE] Microsoft завершил запрос без полной записи выбранного голоса. Получено аудио: '+size+' байт; метаданные: '+(metadata?'да':'нет')+'.'));
            else finish(null,new Blob(chunks,{type:'audio/mpeg'}));
          }
          return;
        }
        const data=new Uint8Array(event.data);
        if(data.length<2){finish(new Error('[MS-PACKET] Повреждён аудиопакет Microsoft.'));return;}
        const length=(data[0]<<8)|data[1];
        if(length+2>data.length){finish(new Error('[MS-PACKET] Неполный аудиопакет Microsoft.'));return;}
        const header=decoder.decode(data.subarray(2,2+length));
        if(header.includes('Path:audio')&&header.includes('audio/mpeg')) {
          const audio=data.slice(2+length);chunks.push(audio);size+=audio.length;
          if(size>8*1024*1024)finish(new Error('Аудиозапись Microsoft слишком большая.'));
        }
      };
      socket.onerror=()=>finish(new Error(opened?'[MS-TRANSFER] Соединение открыто, но передача аудио Microsoft прервана.':'[MS-CONNECT] Прямое соединение с Microsoft не установлено. Это ошибка подключения, а не разрешения на воспроизведение.'));
      socket.onclose=event=>finish(new Error('[MS-CLOSE] Microsoft закрыл соединение до окончания фразы. Код закрытия: '+event.code+'. Получено аудио: '+size+' байт.'));
    });
  }
  class DirectMicrosoft {
    static validationCode=validationCode;
    constructor(paced=false){this.queue=Promise.resolve();this.paced=paced;this.nextRequestAt=0;}
    synthesize(voice,text,rate=1,pitch=1) {
      if(!known.has(voice))return Promise.reject(new Error('Этот голос Microsoft не поддерживается.'));
      if(!text.trim())return Promise.reject(new Error('Нет текста для озвучки.'));
      const perform=async()=>{
        const audio=[];let size=0;
        for(const piece of parts(text)) {
          let complete;const errors=[];
          for(const route of (this.paced?[0,1,0]:[0,1])) {
            if(this.paced){const delay=Math.max(0,this.nextRequestAt-Date.now());if(delay)await new Promise(resolve=>setTimeout(resolve,delay));}
            try{complete=await turn(voice,piece,rate,pitch,route);break;}catch(error){errors.push(error.message+' Маршрут: '+(route===0?'Microsoft Edge':'Bing')+'.');}
            finally{if(this.paced)this.nextRequestAt=Date.now()+3000;}
          }
          if(!complete)throw new Error([...new Set(errors)].join(' | '));
          audio.push(complete);size+=complete.size;
          if(size>24*1024*1024)throw new Error('Предложение слишком длинное для одной записи.');
        }
        return {blob:new Blob(audio,{type:'audio/mpeg'}),parts:audio.length};
      };
      const result=this.queue.then(perform,perform);this.queue=result.catch(()=>{});return result;
    }
  }
  // A sandboxed document has its own opaque origin, independent of Edge's external-file page.
  const framePrefix='tishe-microsoft-';
  const child=window.parent!==window&&typeof frameChannel==='string'&&frameChannel.startsWith(framePrefix);
  if(child){
    const channel=frameChannel,engine=new DirectMicrosoft(true);
    const reply=data=>window.parent.postMessage({channel,...data},'*');
    window.addEventListener('message',event=>{
      const data=event.data;
      if(event.source!==window.parent||!data||data.channel!==channel||data.type!=='synthesize'||!Number.isSafeInteger(data.id))return;
      if(typeof data.text!=='string'||!known.has(data.voice)||!Number.isFinite(data.rate)||!Number.isFinite(data.pitch)){
        reply({type:'result',id:data.id,error:'[MS-REQUEST] Некорректный запрос озвучки.'});return;
      }
      engine.synthesize(data.voice,data.text,data.rate,data.pitch).then(async result=>{
        const buffer=await result.blob.arrayBuffer();
        window.parent.postMessage({channel,type:'result',id:data.id,buffer,parts:result.parts},'*',[buffer]);
      }).catch(error=>reply({type:'result',id:data.id,error:error.message}));
    });
    reply({type:'ready'});
    return;
  }
  class MicrosoftClient {
    static validationCode=validationCode;
    constructor(){
      this.direct=new DirectMicrosoft();this.pending=new Map();this.sequence=0;this.frameReady=null;
      const ios=/iPhone|iPad|iPod/i.test(navigator.userAgent)||navigator.maxTouchPoints>1&&/Mac/i.test(navigator.platform);
      this.isolated=ios&&(/^(?:file|edge):$/.test(location.protocol)||/external-file/i.test(location.href));
    }
    ensureFrame(){
      if(this.frameReady)return this.frameReady;
      this.frameReady=new Promise((resolve,reject)=>{
        const channel=framePrefix+requestId(),frame=document.createElement('iframe');
        this.frame=frame;this.channel=channel;
        frame.name=channel;frame.title='Сетевой синтез Microsoft';frame.hidden=true;
        frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('aria-hidden','true');
        const listener=event=>{
          const data=event.data;
          if(event.source!==frame.contentWindow||event.origin!=='null'||!data||data.channel!==channel)return;
          if(data.type==='ready'){clearTimeout(timer);resolve();return;}
          if(data.type!=='result')return;
          const pending=this.pending.get(data.id);if(!pending)return;
          clearTimeout(pending.timer);this.pending.delete(data.id);
          if(typeof data.error==='string'){pending.reject(new Error('[MS-ISOLATED] '+data.error));return;}
          if(!(data.buffer instanceof ArrayBuffer)||data.buffer.byteLength<1000||data.buffer.byteLength>24*1024*1024||!Number.isSafeInteger(data.parts)||data.parts<1){
            pending.reject(new Error('[MS-ISOLATED-AUDIO] Изолированный канал не вернул полную запись.'));return;
          }
          pending.resolve({blob:new Blob([data.buffer],{type:'audio/mpeg'}),parts:data.parts,transport:'isolated-document'});
        };
        window.addEventListener('message',listener);
        const timer=setTimeout(()=>{
          window.removeEventListener('message',listener);frame.remove();this.frameReady=null;
          reject(new Error('[MS-FRAME-INIT] Edge не запустил изолированную сетевую страницу.'));
        },8000);
        const markup='<!doctype html><meta charset="utf-8"><script>('+microsoftRuntime.toString()+')('+JSON.stringify(channel)+');<'+'/script>';
        frame.src='data:text/html;charset=utf-8,'+encodeURIComponent(markup);
        document.body.append(frame);
      });
      return this.frameReady;
    }
    async synthesize(voice,text,rate=1,pitch=1){
      if(!this.isolated)return this.direct.synthesize(voice,text,rate,pitch);
      if(!known.has(voice))throw new Error('Этот голос Microsoft не поддерживается.');
      if(typeof text!=='string'||!text.trim())throw new Error('Нет текста для озвучки.');
      await this.ensureFrame();
      return new Promise((resolve,reject)=>{
        const id=++this.sequence;
        const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('[MS-ISOLATED-TIMEOUT] Изолированный канал не завершил синтез вовремя.'));},95000);
        this.pending.set(id,{resolve,reject,timer});
        try{this.frame.contentWindow.postMessage({channel:this.channel,type:'synthesize',id,voice,text,rate,pitch},'*');}
        catch(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('[MS-FRAME-SEND] Не удалось передать запрос в сетевой канал: '+error.name+'.'));}
      });
    }
  }
  window.TisheMicrosoftDirect=MicrosoftClient;
})();