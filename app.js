(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const synth = window.speechSynthesis || null;
  const cloudMicrosoft=typeof window.TisheMicrosoftCloud==='function';
  const directMicrosoft=cloudMicrosoft?new window.TisheMicrosoftCloud():new window.TisheMicrosoftDirect();
  const ios=/iPad|iPhone|iPod/i.test(navigator.userAgent)||navigator.maxTouchPoints>1&&/Mac/i.test(navigator.platform);
  const mobileEdge=/EdgA\/|EdgiOS\//i.test(navigator.userAgent)||/Edg\//i.test(navigator.userAgent)&&navigator.maxTouchPoints>1&&/Mac/i.test(navigator.platform);
  const microsoftVoices=[{id:'ru-RU-DmitryNeural',name:'Дмитрий'},{id:'ru-RU-SvetlanaNeural',name:'Светлана'}];
  const bridgeConfig = window.__TISHE_BRIDGE__;
  const bridge = bridgeConfig?.baseUrl==='http://127.0.0.1:17843/' && /^[A-F0-9]{64}$/.test(bridgeConfig.token||'') ? bridgeConfig : null;
  let bridgeVoices=[], bridgeError='', bridgeState=bridge?'loading':'offline';
  const KEY = 'aura_reader_state_v4';
  const LIMIT = 1000000;
  const MAX_CHUNK = 180;
  const MAX_BLOCK_SENTENCES = 20;
  const RETRY_LIMIT = 20;
  const RETRY_DELAY_MS = 2000;
  const decks = [$('neuralAudioA'), $('neuralAudioB')];
  const overlapping = new Set();
  const cache = new Map();
  const inflight = new Map();
  let networkController = new AbortController();
  let doc = {title:'Рукопись не загружена',text:''};
  let draft = {title:'',text:''};
  let settings = {voice:bridge?'edge:ru-RU-DmitryNeural':cloudMicrosoft?'online:ru-RU-DmitryNeural':'auto',rate:0.95,pitch:1,volume:1,trim:140,pauseMs:400,blockSize:20,fontSize:21,autoScroll:true,theme:0};
  let readingBlock=null, nextBlock=null;
  let segments = [], voices = [], index = 0, completed = false;
  let mode = 'IDLE', generation = 0, job = null, preview = null, deck = 0;
  let saveTimer, draftTimer, sleepInterval, sleepDeadline = 0, wake = null;
  let savedFocus = null, cloudDeadUntil = 0, storageFailed = false;
  let sourceLabel = '', sourceWarning = '', holdTimer = null, importVersion = 0;
  const armed = new Map();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v,min,max,fallback) => Number.isFinite(Number(v)) ? Math.max(min,Math.min(max,Number(v))) : fallback;
  const active = () => mode === 'PLAYING' || mode === 'LOADING' || mode === 'RECONNECTING';
  const allowedLanguage = lang => /^(?:ru|en)(?:[-_]|$)/i.test(lang);
  const googleSelected = () => /^google_(?:ru|en)$/.test(settings.voice);
  const edgeSelected = () => settings.voice.startsWith('edge:');
  const directSelected = () => settings.voice.startsWith('online:')||settings.voice==='auto'&&mobileEdge&&!bridge&&!(ios&&voices.some(v=>nativeEdgeId(v)));
  const directVoiceId = () => settings.voice.startsWith('online:')?settings.voice.slice(7):'ru-RU-DmitryNeural';
  const networkSelected = () => directSelected()||edgeSelected()||googleSelected();
  const selectedLanguage = () => directSelected()?'ru':edgeSelected()?settings.voice.slice(5,7):settings.voice==='google_en'?'en':settings.voice==='google_ru'?'ru':chooseVoice()?.lang?.split(/[-_]/)[0]||'ru';

  function notice(message, error=false, showDock=error) {
    $('appNotice').textContent = message;
    $('appNotice').classList.toggle('is-error',error);
    const dockMessage=$('dockAudioMessage');
    if(dockMessage){dockMessage.textContent=showDock?message:'';dockMessage.hidden=!showDock;dockMessage.classList.toggle('is-error',error);}
  }
  function fill(el) {
    const min=Number(el.min),max=Number(el.max);
    el.style.setProperty('--val-pct', (max>min ? (Number(el.value)-min)/(max-min)*100 : 0)+'%');
  }
  function layout() {
    document.documentElement.style.setProperty('--layout-top-pad',($('topHeaderBar').offsetHeight+24)+'px');
    document.documentElement.style.setProperty('--layout-bottom-pad',($('bottomDockWrapper').offsetHeight+36)+'px');
  }
  function persistNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(KEY,JSON.stringify({version:6,doc,draft,settings,index,completed}));
      storageFailed=false;
      $('storageStatus').textContent='Черновик сохраняется отдельно; текст применяется кнопкой ниже.';
    } catch (_) {
      storageFailed=true;
      $('storageStatus').textContent='Браузер не сохранил текст. Скачай копию перед закрытием.';
      notice('Локальное сохранение недоступно или память заполнена. Скачай копию текста.',true);
    }
  }
  function persist() { clearTimeout(saveTimer);saveTimer=setTimeout(persistNow,250); }
  function restore() {
    try {
      const raw=localStorage.getItem(KEY);
      let saved=raw?JSON.parse(raw):null;
      if (!saved) {
        const old=JSON.parse(localStorage.getItem('aura_reader_state_v3')||'null');
        if(old) saved={doc:old.customDoc,draft:old.customDoc,index:old.currentIndex,
          settings:{rate:old.rate,pitch:old.pitch,volume:old.volume,trim:old.trimOverlapMs,fontSize:old.fontSize,autoScroll:old.autoScroll,theme:old.themeIdx,voice:'auto'}};
      }
      if(!saved || typeof saved!=='object')return;
      if(typeof saved.doc?.text==='string')doc={text:saved.doc.text.slice(0,LIMIT),title:String(saved.doc.title||'Рукопись').slice(0,200)};
      draft=typeof saved.draft?.text==='string'?{text:saved.draft.text.slice(0,LIMIT),title:String(saved.draft.title||'').slice(0,200)}:{...doc};
      const s=saved.settings||{};
      settings={voice:typeof s.voice==='string'?s.voice:'auto',rate:clamp(s.rate,0.8,1.5,0.95),pitch:clamp(s.pitch,0.7,1.3,1),volume:clamp(s.volume,0,1,1),trim:clamp(s.trim,0,280,140),pauseMs:clamp(s.pauseMs,-2000,2000,400),blockSize:Math.trunc(clamp(s.blockSize,1,MAX_BLOCK_SENTENCES,1)),fontSize:clamp(s.fontSize,16,28,21),autoScroll:typeof s.autoScroll==='boolean'?s.autoScroll:true,theme:Math.trunc(clamp(s.theme,0,2,0))};
      if(saved.version<6)settings.theme=0;
      index=saved.version>=5?Math.trunc(clamp(saved.index,0,100000,0)):0;
      completed=saved.version>=5&&saved.completed===true;
      if(saved.version<5&&doc.text)notice('Рукопись сохранена. После перехода на целые предложения позиция чтения сброшена к началу.');
    }catch(_){notice('Не удалось прочитать сохранение. Исходная запись не изменена.',true);}
  }

  // Visible blocks are complete sentences, not transport-size fragments.
  function splitText(text) {
    let segmenter=null;
    try {segmenter=new Intl.Segmenter('ru',{granularity:'sentence'});}catch(_){}
    const result=[];
    text.replace(/\r\n?/g,'\n').split(/\n[\t ]*\n+/).forEach((paragraph,p) => {
      paragraph=paragraph.replace(/\s+/gu,' ').trim();if(!paragraph)return;
      const sentences=segmenter?Array.from(segmenter.segment(paragraph),s=>s.segment):(paragraph.match(/[^.!?…]+[.!?…»"]*|[.!?…]+/gu)||[paragraph]);
      for(const sentence of sentences) {
        const clean=sentence.trim();
        if(clean)result.push({text:clean,p});
      }
    });
    return result;
  }
  function render() {
    segments=splitText(doc.text);
    index=Math.min(Math.max(0,index),Math.max(0,segments.length-1));
    const container=$('bookReadingContainer');container.replaceChildren();
    const fragment=document.createDocumentFragment();let paragraph=null,last=-1;
    segments.forEach((s,i)=>{
      if(s.p!==last){paragraph=document.createElement('p');paragraph.className='reading-paragraph';fragment.append(paragraph);last=s.p;}
      const span=document.createElement('span');span.id='seg-node-'+i;span.className='sentence-node';
      span.textContent=s.text+' ';span.tabIndex=0;span.setAttribute('role','button');span.setAttribute('aria-label','Читать: '+s.text);
      span.addEventListener('click',()=>seek(i,true));
      span.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();seek(i,true);}});
      paragraph.append(span);
    });
    container.append(fragment);
    $('zeroStateMatrix').hidden=segments.length>0;container.hidden=!segments.length;
    $('bookTitleHeading').textContent=segments.length?doc.title:'Рукопись не загружена';
    $('headerDocPill').textContent=segments.length?doc.title:'Ожидание рукописи';
    const words=doc.text.trim()?doc.text.trim().split(/\s+/u).length:0;
    $('metaSentences').textContent='Фраз: '+segments.length;
    $('metaWords').textContent='Слов: '+words;
    $('metaTime').textContent='Звучание: ~'+(words?Math.max(1,Math.round(words/(140*settings.rate))):0)+' мин';
    $('dockProgressSlider').max=Math.max(0,segments.length-1);
    $('dockProgressSlider').disabled=!segments.length;
    $('btnPlayFromSelected').disabled=!segments.length;
    highlight(false);layout();
  }
  function highlight(scroll=true) {
    document.querySelectorAll('.sentence-node.active').forEach(el=>{el.classList.remove('active');el.removeAttribute('aria-current');});
    document.querySelectorAll('.active-paragraph').forEach(el=>el.classList.remove('active-paragraph'));
    const node=$('seg-node-'+index);
    if(node){node.classList.add('active');node.setAttribute('aria-current','true');node.parentElement.classList.add('active-paragraph');}
    const total=segments.length,digits=Math.max(2,String(total).length);
    $('lblProgressCounter').textContent=String(total?index+1:0).padStart(digits,'0')+' / '+String(total).padStart(digits,'0');
    $('lblProgressPercent').textContent=(completed?100:total?Math.floor(index/total*100):0)+'%';
    $('dockProgressSlider').value=index;fill($('dockProgressSlider'));
    const phrase=segments[index]?.text||'Загрузи рукопись или вставь текст для начала чтения';
    $('lblCurrentSentence').textContent=phrase;$('oledCurrentPhrase').textContent=phrase;
    if(scroll && settings.autoScroll && active() && node && $('editorDrawer').hidden && $('studioDrawer').hidden && $('oledOverlay').hidden) {
      const rect=node.getBoundingClientRect(),top=document.body.classList.contains('focus-mode')?24:$('topHeaderBar').getBoundingClientRect().bottom+20;
      const bottom=innerHeight-$('bottomDockWrapper').offsetHeight-24;
      if(rect.top<top||rect.bottom>bottom)window.scrollBy({top:rect.top-top-Math.max(0,(bottom-top-rect.height)/3),behavior:reducedMotion?'instant':'smooth'});
    }
  }
  async function wakeLock() {
    if(!navigator.wakeLock)return;
    if(!active()||document.visibilityState!=='visible') {if(wake){const w=wake;wake=null;try{await w.release();}catch(_){}}return;}
    if(wake)return;
    try {
      const w=await navigator.wakeLock.request('screen');
      if(!active()||document.visibilityState!=='visible'||wake){await w.release();return;}
      wake=w;w.addEventListener('release',()=>{if(wake===w)wake=null;});
    }catch(_){}
  }
  function status(next,label='') {
    mode=next;
    const playing=active();
    $('lblStateText').textContent=label||({IDLE:'ГОТОВО К ЧТЕНИЮ',LOADING:'ЗАГРУЗКА АУДИО',PLAYING:'ЧТЕНИЕ',PAUSED:'ПАУЗА',DONE:'ЧТЕНИЕ ЗАВЕРШЕНО',ERROR:'ОШИБКА ОЗВУЧИВАНИЯ'}[mode]);
    $('lblStateBadge').classList.toggle('is-playing',playing);
    $('lblStateBadge').classList.toggle('is-paused',mode==='PAUSED'||mode==='ERROR');
    $('bookReadingContainer').classList.toggle('is-playing',playing);
    for(const id of ['icoMainPlaySvg','icoOledPlaySvg'])$(id).querySelector('use').setAttribute('href',playing?'#ico-pause':'#ico-play');
    $('lblOledPlayText').textContent=playing?'Пауза':'Старт';
    $('btnMainPlay').setAttribute('aria-label',playing?'Приостановить чтение':'Начать или продолжить чтение');
    $('btnPlayFromSelected').querySelector('span').textContent=playing?'Приостановить':'Слушать с выбранной фразы';
    $('btnPlayFromSelected').querySelector('use').setAttribute('href',playing?'#ico-pause':'#ico-play');
    if(navigator.mediaSession){try{navigator.mediaSession.playbackState=playing?'playing':mode==='PAUSED'?'paused':'none';}catch(_){}}
    wakeLock();
  }
  function clearJob(j) {
    if(!j)return;
    clearTimeout(j.watchdog);clearTimeout(j.gapTimer);clearTimeout(j.retryTimer);clearInterval(j.trimTimer);j.dead=true;
    if(j.audio){j.audio.onended=j.audio.onerror=j.audio.onloadedmetadata=null;j.audio.pause();}
    if(j.utterance){j.utterance.onend=j.utterance.onerror=j.utterance.onstart=j.utterance.onboundary=null;}
  }
  function stopPreview() {
    const wasSynth=!!preview?.utterance;clearJob(preview);preview=null;
    $('previewAudio').pause();$('btnPreviewVoice').classList.remove('is-previewing');
    if(wasSynth&&synth){synth.cancel();synth.resume();}
    $('previewStatusText').textContent='Проба голоса остановлена';
  }
  function cancelReading() {
    generation++;
    networkController.abort();networkController=new AbortController();
    inflight.clear();
    readingBlock=nextBlock=null;
    const wasSynth=!!job?.utterance;clearJob(job);job=null;
    if(wasSynth&&synth){synth.cancel();synth.resume();}
    for(const a of decks){a.onended=a.onerror=a.onloadedmetadata=null;a.pause();}
    overlapping.clear();
    $('deckSlotA').classList.remove('standby-ready');$('deckSlotB').classList.remove('standby-ready');
  }
  function stop() {stopPreview();cancelReading();status('IDLE','ОСТАНОВЛЕНО · ПОЗИЦИЯ СОХРАНЕНА');highlight(false);persist();}
  function fail(j,message) {
    if(j!==job||j.dead)return;
    const code=message.match(/^\[([A-Z0-9-]+)\]/)?.[1];
    cancelReading();status('ERROR',code?'ОШИБКА · '+code:'');notice(message+' Текущая фраза не пропущена. Нажми «Старт», чтобы повторить.',true);persist();
  }
  function retryableError(error) {
    if(error?.retryable!==undefined)return error.retryable;
    const message=String(error?.message||error);
    if(/\[(?:GOOGLE-LENGTH|MS-INIT|MS-REQUEST|MS-FRAME-INIT|MS-ISOLATED-AUDIO|HTTP-(?:400|401|403|404|413))\]/.test(message))return false;
    return /\[(?:MS-(?:CONNECT|TRANSFER|CLOSE|TIMEOUT|INCOMPLETE|PACKET|SEND|ISOLATED-TIMEOUT)|AUDIO-(?:1|2|TIMEOUT|AbortError|NetworkError)|SPEECH-NETWORK|HTTP-(?:408|425|429|5\d\d))\]/.test(message)||['TypeError','TimeoutError','AbortError','NetworkError'].includes(error?.name);
  }
  function retryReading(j,error) {
    if(j!==job||j.dead||j.type==='retry')return;
    const message=String(error?.message||error);
    if(!retryableError(error)){fail(j,message+' Выбранный голос не заменён.');return;}
    clearTimeout(j.watchdog);clearInterval(j.trimTimer);
    j.watchdog=null;
    if(j.audio){j.audio.onended=j.audio.onerror=j.audio.onloadedmetadata=null;j.audio.pause();j.audio=null;}
    if(j.utterance){j.utterance.onend=j.utterance.onerror=j.utterance.onstart=j.utterance.onboundary=null;synth?.cancel();j.utterance=null;}
    const offline=navigator.onLine===false;
    j.retryAttempts=(j.retryAttempts||0)+(offline?0:1);
    if(j.retryAttempts>RETRY_LIMIT){fail(j,'[RETRY-LIMIT] Сервис не восстановился после '+RETRY_LIMIT+' попыток. '+message);return;}
    const delay=Math.max(RETRY_DELAY_MS,error?.retryAfterMs||0);
    j.type='retry';j.retryAt=Date.now()+delay;
    j.retryNotBefore=error?.retryAfterMs?j.retryAt:0;
    j.retryMessage=message;
    if(mode==='PAUSED'){persist();return;}
    status('RECONNECTING',offline?'НЕТ СЕТИ · ЖДУ ПОДКЛЮЧЕНИЯ':'ПЕРЕПОДКЛЮЧЕНИЕ · '+j.retryAttempts+' / '+RETRY_LIMIT);
    notice(message+' '+(offline?'Проверю подключение автоматически.':'Повтор через '+Math.ceil(delay/1000)+' с.')+' Позиция и выбранный голос сохранены. «Пауза» отменяет автоматическое продолжение.',false,true);
    j.retryTimer=setTimeout(()=>retryNow(),delay);persist();
  }
  function retryNow(fromOnline=false) {
    const j=job;if(!j||j.dead||j.type!=='retry'||!active())return;
    if(sleepDeadline&&Date.now()>=sleepDeadline){pause();return;}
    if(Date.now()<(fromOnline?j.retryNotBefore:j.retryAt))return;
    const attempts=j.retryAttempts;
    clearJob(j);job=null;speak(attempts);
  }
  function finish(j) {
    if(j!==job||j.dead||j.type==='gap'||j.type==='retry')return;
    clearTimeout(j.watchdog);clearInterval(j.trimTimer);
    if(mode==='PAUSED'){j.endedWhilePaused=true;return;}
    if(!active())return;
    clearJob(j);job=null;
    if(index+1>=segments.length){completed=true;status('DONE');highlight(false);persistNow();return;}
    job={id:generation,type:'gap',dead:false,elapsed:0};
    status('PLAYING','ПАУЗА МЕЖДУ ПРЕДЛОЖЕНИЯМИ');
    scheduleGap(job);
  }
  function scheduleGap(j) {
    clearTimeout(j.gapTimer);
    j.gapStarted=performance.now();
    j.gapTimer=setTimeout(()=>{
      if(j!==job||j.dead||!active())return;
      clearJob(j);job=null;index++;highlight();persist();speak();
    },Math.max(0,settings.pauseMs-j.elapsed));
  }
  function armWatchdog(j,ms) {
    clearTimeout(j.watchdog);j.remaining=ms;j.startedAt=Date.now();
    j.watchdog=setTimeout(()=>{
      if(j!==job||j.dead||!active())return;
      if(!j.utterance&&(j.type==='loading'||j.type==='audio'))audioFallback(j,'[AUDIO-TIMEOUT] Сетевой источник не завершил загрузку или воспроизведение вовремя.');
      else if(j.utterance?.voice&&!j.utterance.voice.localService)retryReading(j,'[SPEECH-NETWORK] Сетевой голос браузера не завершил фразу.');
      else fail(j,'Голос не завершил фразу или источник аудио не ответил.');
    },ms);
  }
  function pause() {
    if(!active())return;
    status('PAUSED');
    for(const audio of overlapping)audio.pause();
    if(job){
      clearTimeout(job.retryTimer);job.retryTimer=null;
      if(job.type==='retry')notice('Переподключение приостановлено. Нажми ▶, чтобы продолжить чтение.',false,true);
      if(job.type==='gap'){job.elapsed+=performance.now()-job.gapStarted;clearTimeout(job.gapTimer);}
      if(job.watchdog){clearTimeout(job.watchdog);job.watchdog=null;job.remaining=Math.max(1000,(job.remaining||30000)-(Date.now()-job.startedAt));}
      clearInterval(job.trimTimer);
      if(job.audio)job.audio.pause();
      if(job.utterance&&synth)synth.pause();
    }
    persist();
  }
  function resume() {
    if(!job){start();return;}
    for(const audio of overlapping)audio.play().catch(()=>notice('Не удалось продолжить предыдущую фразу.',true));
    const j=job;
    if(j.type==='retry'){
      status('RECONNECTING','ПЕРЕПОДКЛЮЧЕНИЕ');j.retryAt=Math.max(Date.now(),j.retryNotBefore||0);
      if(j.retryAt>Date.now())j.retryTimer=setTimeout(()=>retryNow(),j.retryAt-Date.now());else retryNow();
      return;
    }
    if(j.type==='gap'){status('PLAYING','ПАУЗА МЕЖДУ ПРЕДЛОЖЕНИЯМИ');scheduleGap(j);return;}
    if(j.endedWhilePaused){status('PLAYING');finish(j);return;}
    if(j.type==='loading'){status('LOADING');armWatchdog(j,j.remaining||20000);return;}
    if(j.type==='ready'){status('PLAYING');playAudio(j,j.source);return;}
    if(j.type==='fallback'){speakNative(j,segments[index].text);return;}
    status('PLAYING',sourceLabel);
    armWatchdog(j,j.remaining||30000);
    if(j.audio)playReadingAudio(j);
    else if(j.utterance&&synth){synth.resume();if(!synth.speaking&&!synth.pending)start();}
  }
  function togglePlay() {if(active())pause();else {stopPreview();if(mode==='PAUSED')resume();else start();}}
  function primeNetworkAudio() {
    // A loaded recording can be started by a real tap; silent priming is not proof of permission.
    if(!networkSelected()||ios)return;
    const data=new Uint8Array(1004),view=new DataView(data.buffer);
    for(const [offset,value] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])for(let i=0;i<value.length;i++)data[offset+i]=value.charCodeAt(i);
    view.setUint32(4,data.length-8,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,data.length-44,true);
    const silence='data:audio/wav;base64,'+btoa(String.fromCharCode(...data));
    // iOS authorizes each media element during the click, before the network await.
    for(const audio of [...decks,$('previewAudio')]) {
      if(audio.dataset.tishePrimed)continue;
      audio.dataset.tishePrimed='1';audio.setAttribute('playsinline','');audio.src=silence;
      audio.play().then(()=>{if(audio.src===silence){audio.pause();audio.currentTime=0;}}).catch(()=>{delete audio.dataset.tishePrimed;});
    }
  }
  function start() {
    if(!$('editorDrawer').hidden){saveEditorText(true);return;}
    stopPreview();
    if(!segments.length){toggleEditor(true);notice('Вставь текст и нажми «Применить и слушать».');return;}
    cancelReading();primeNetworkAudio();if(completed){index=0;completed=false;}
    sourceWarning='';status('PLAYING');setupMediaSession();speak();
  }
  function chooseVoice() {
    if(directSelected())return null;
    const chosen=voices.find(v=>voiceKey(v)===settings.voice);
    if(chosen)return chosen;
    if(settings.voice.startsWith('voice:')||settings.voice.startsWith('native:')||edgeSelected())return null;
    if(settings.voice==='auto') {
      const natural=voices.find(v=>nativeEdgeId(v)==='ru-RU-DmitryNeural')||voices.find(v=>nativeEdgeId(v)==='ru-RU-SvetlanaNeural');
      if(natural)return natural;
    }
    const lang=settings.voice==='google_en'?'en':'ru';
    const match=v=>v.lang.split(/[-_]/)[0].toLowerCase()===lang;
    return voices.find(v=>match(v)&&v.localService)||voices.find(match)||null;
  }
  function nativeEdgeId(v) {
    if(!v||v.localService||!/^ru(?:[-_]RU)?$/i.test(v.lang||''))return null;
    const name=(v.name||'')+' '+(v.voiceURI||'');
    if(!/Microsoft/i.test(name))return null;
    if(/Дмитрий|Dmitry/i.test(name))return 'ru-RU-DmitryNeural';
    if(/Светлана|Svetlana/i.test(name))return 'ru-RU-SvetlanaNeural';
    return null;
  }
  const voiceKey = v => nativeEdgeId(v)?'native:'+nativeEdgeId(v):'voice:'+v.voiceURI+'|'+v.lang+'|'+(v.localService?'local':'network');
  function populateVoices() {
    const seen=new Set();
    voices=(synth?synth.getVoices():[]).filter(v=>{
      if(!allowedLanguage(v.lang)||seen.has(voiceKey(v)))return false;
      seen.add(voiceKey(v));return true;
    });
    // A bridge selection or a localized old voice URI must not hide Edge's own same voice.
    const oldNative=settings.voice.startsWith('voice:')&&settings.voice.endsWith('|network')?nativeEdgeId({name:settings.voice,lang:'ru-RU',localService:false}):null;
    const directId=!bridge&&/^(edge:|native:)/.test(settings.voice)?settings.voice.slice(settings.voice.indexOf(':')+1):oldNative;
    if(directId&&microsoftVoices.some(v=>v.id===directId)&&(cloudMicrosoft||mobileEdge||voices.some(v=>nativeEdgeId(v)===directId))) {
      const browserVoice=voices.some(v=>nativeEdgeId(v)===directId);
      const keepNative=ios&&(browserVoice||settings.voice.startsWith('native:'));
      const resolved=(cloudMicrosoft||mobileEdge&&!keepNative?'online:':'native:')+directId;
      if(resolved!==settings.voice){settings.voice=resolved;persist();}
    }
    if(settings.voice!=='auto'&&!googleSelected()&&!edgeSelected()&&!settings.voice.startsWith('native:')&&!directSelected()) {
      const parts=settings.voice.split('|');
      if(!settings.voice.startsWith('voice:')||!allowedLanguage(parts[parts.length-2]||''))settings.voice='auto';
    }
    const select=$('selectVoiceEngine');select.replaceChildren();
    const native=mobileEdge&&!ios?[]:voices.filter(v=>nativeEdgeId(v));
    if(native.length) {
      const group=document.createElement('optgroup');group.label=ios?'Microsoft · предоставлены браузером (Web Speech API)':'Microsoft Edge · напрямую, без моста';
      for(const id of ['ru-RU-DmitryNeural','ru-RU-SvetlanaNeural']) {
        const v=native.find(v=>nativeEdgeId(v)===id);
        if(v)group.append(new Option((id.includes('Dmitry')?'Дмитрий':'Светлана')+' · Microsoft Edge Online · ru-RU',voiceKey(v)));
      }
      select.append(group);
    }
    const directGroup=document.createElement('optgroup');directGroup.label=cloudMicrosoft?'Microsoft · облачный мост · любой браузер':ios?'Microsoft · отдельное сетевое подключение (не Read Aloud)':'Microsoft Online · телефон и компьютер · без моста';
    microsoftVoices.forEach(v=>directGroup.append(new Option(v.name+(cloudMicrosoft?' · Microsoft · облачный мост':' · прямое подключение Microsoft'),'online:'+v.id)));
    select.append(directGroup);
    if(bridgeVoices.length) {
      const group=document.createElement('optgroup');group.label='Microsoft · через голосовой мост';
      bridgeVoices.forEach(v=>group.append(new Option(v.name+' · '+v.lang,'edge:'+v.id)));
      select.append(group);
    }
    select.add(new Option('Авто · русский голос браузера','auto'));
    for(const local of [true,false]) {
      const list=voices.filter(v=>v.localService===local&&!nativeEdgeId(v));if(!list.length)continue;
      const group=document.createElement('optgroup');group.label=local?'Голоса на устройстве':'Сетевые голоса браузера';
      list.sort((a,b)=>Number(/^ru/i.test(b.lang))-Number(/^ru/i.test(a.lang))||a.name.localeCompare(b.name,'ru')).forEach(v=>group.append(new Option(v.name+' · '+v.lang,voiceKey(v))));
      select.append(group);
    }
    const cloud=document.createElement('optgroup');cloud.label='Внешний MP3 · текст отправляется Google';
    cloud.append(new Option('Google MP3 · русский · экспериментальный','google_ru'),new Option('Google MP3 · English · экспериментальный','google_en'));select.append(cloud);
    if(![...select.options].some(o=>o.value===settings.voice))select.add(new Option('Сохранённый голос недоступен · выбери другой',settings.voice));
    select.value=settings.voice;
    $('selectPreviewVoice').replaceChildren(...[...select.children].map(el=>el.cloneNode(true)));
    $('selectPreviewVoice').value=settings.voice;
    const edgeStatus=$('edgeVoiceStatus');
    const russian=bridgeVoices.filter(v=>v.lang.startsWith('ru')).map(v=>v.name);
    if(edgeStatus)edgeStatus.textContent=!bridge?'Для телефона выбирай Дмитрия или Светлану в группе Microsoft Online. Этот способ не зависит от списка голосов iOS и Android и не требует включённого компьютера. Открывай файл в Microsoft Edge; нужен интернет.':bridgeState==='ready'?'Локальный мост подключён. Microsoft: '+russian.join(', ')+'. Для озвучки нужен интернет.':bridgeState==='loading'?'Подключаю локальный мост…':bridgeError;
    if(edgeStatus&&ios&&!bridge&&!cloudMicrosoft){
      const available=voices.filter(v=>/^ru(?:[-_]|$)/i.test(v.lang));
      edgeStatus.textContent='Браузерный API · '+(!synth?'speechSynthesis отсутствует.':!voices.length?'Список пока пуст. Нажми «Обновить список голосов».':native.length?'Microsoft предоставлен странице: '+native.map(v=>v.name).join(', ')+'. Выбери голос из группы «предоставлены браузером».':'Светлана и Дмитрий не обнаружены среди голосов, предоставленных странице. Встроенное «Читать вслух» Edge использует отдельный список.')+' Русские голоса API: '+(available.map(v=>v.name+' ['+v.voiceURI+'; '+(v.localService?'local':'network')+']').join('; ')||'не обнаружены')+'. Пункты «отдельное сетевое подключение» добавлены читалкой; они не подтверждают доступность голоса в браузерном API.';
    }
    if(edgeStatus&&cloudMicrosoft&&!bridge)edgeStatus.textContent='Дмитрий и Светлана доступны через собственный облачный мост. Нужен интернет, включённый компьютер не нужен. Текст для синтеза передаётся Cloudflare и Microsoft. Готовое аудио кэшируется в этом браузере; при ошибке голос не меняется.';
    if($('browserVoicesRefresh'))$('browserVoicesRefresh').hidden=!ios;
    $('bridgeOpenLink').hidden=!bridge||!!native.length||bridgeState!=='offline';
    $('bridgeRetry').hidden=!bridge;
    updateSourceHint();
  }
  async function refreshBridge() {
    if(!bridge)return;
    bridgeState='loading';bridgeError='';populateVoices();
    try {
      const response=await fetch(bridge.baseUrl+'api/voices',{headers:{'X-Tishe-Session':bridge.token},signal:AbortSignal.timeout(18000),cache:'no-store'});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'Мост недоступен.');
      const english=new Set(['en-US-AriaNeural','en-US-GuyNeural','en-GB-SoniaNeural','en-GB-RyanNeural']);
      bridgeVoices=data.voices.filter(v=>allowedLanguage(v.lang)&&(/^ru-/i.test(v.lang)||english.has(v.id)));
      if(!bridgeVoices.length)throw new Error('Microsoft не вернул русские и английские голоса.');
      bridgeVoices.sort((a,b)=>Number(b.lang.startsWith('ru'))-Number(a.lang.startsWith('ru'))||a.name.localeCompare(b.name,'ru'));
      bridgeState='ready';
    }catch(error){bridgeVoices=[];bridgeState='offline';bridgeError=error.name==='TimeoutError'?'Microsoft не вернул каталог вовремя. Нажми «Обновить подключение».':error.message;}
    populateVoices();
  }
  function updateSourceHint() {
    const google=googleSelected(),edge=edgeSelected(),direct=directSelected(),v=chooseVoice(),remote=bridgeVoices.find(v=>'edge:'+v.id===settings.voice);
    $('rangePitch').disabled=google;
    $('rangePitch').title=google?'Для MP3 независимое изменение высоты тона недоступно':'Высота тона выбранного голоса';
    $('lblPitch').textContent=google?'Недоступно для MP3':settings.pitch.toFixed(2);
    $('rangePauseMs').disabled=false;
    $('lblPauseMs').textContent=settings.pauseMs+' мс';
    updateBlockControl();
    $('metaEngineBadge').textContent=direct?(cloudMicrosoft?'MICROSOFT · ОБЛАЧНЫЙ МОСТ':'MICROSOFT · НАПРЯМУЮ'):edge?'MICROSOFT · ГОЛОСОВОЙ МОСТ':google?'GOOGLE · СЕТЕВОЙ MP3':nativeEdgeId(v)?'MICROSOFT EDGE · БЕЗ МОСТА':'ГОЛОС УСТРОЙСТВА';
    $('sourceHint').textContent=direct?'Microsoft · '+(microsoftVoices.find(v=>v.id===directVoiceId())?.name||'выбранный голос')+' · прямой сетевой синтез, без EXE и компьютера-посредника. Текст передаётся только Microsoft. Нужен Edge и интернет; другой голос при ошибке не включается.':edge?remote?'Microsoft · '+remote.name+' · через локальный мост. Текст для озвучки отправляется Microsoft. Голос при ошибке не подменяется.':bridgeState==='loading'?'Подключаю голосовой мост…':bridgeError||'Для сохранённого голоса моста нет подключения. Выбери прямое подключение Microsoft Online.':google?'Экспериментальный сетевой MP3 · '+(selectedLanguage()==='en'?'English':'русский')+': фразы передаются Google, доступность зависит от сервиса. Системный голос вместо Google не включается. Лимит — 180 символов на предложение. Если звук заблокирован, запись сохраняется до повторного нажатия ▶.':v?'Выбран: '+v.name+(nativeEdgeId(v)?' · напрямую через Edge, без EXE и отдельного моста. Нужен интернет; текст передаётся Microsoft.':v.localService?' · локальный, без передачи текста в сеть.':' · сетевой голос браузера, требует интернета.'):'Выбранный браузерный голос не обнаружен. Обнови список в настройках звука. Отдельное сетевое подключение Microsoft не означает доступность голоса через браузерный API.';
    $('deckSlotA').textContent=google?'ДЕКА A':'РЕЧЬ';$('deckSlotB').textContent=google?'ДЕКА B':'СИНТЕЗ';
    if(direct&&cloudMicrosoft)$('sourceHint').textContent='Microsoft · '+(microsoftVoices.find(v=>v.id===directVoiceId())?.name||'выбранный голос')+' · собственный облачный мост, основной и резервный маршруты с тем же голосом. Текст передаётся Cloudflare и Microsoft; полное аудио кэшируется в браузере. Работает по интернету без включённого компьютера. При ошибке другой голос не включается.';
    $('deckSlotA').classList.toggle('active-deck',!google||deck===0);$('deckSlotB').classList.toggle('active-deck',google&&deck===1);
  }
  function speakNative(j,text,voice=chooseVoice()) {
    if(j!==job||j.dead)return;
    if(!synth||!window.SpeechSynthesisUtterance){fail(j,'В этом браузере нет синтеза речи.');return;}
    if(!voice){fail(j,'Голос нужного языка не найден. Выбери доступный русский или английский голос либо Google MP3.');return;}
    j.type='synth';
    const u=new SpeechSynthesisUtterance(text);j.utterance=u;
    u.voice=voice;u.lang=voice.lang;u.rate=settings.rate;u.pitch=settings.pitch;u.volume=settings.volume;
    sourceLabel=voice.name;status(ios?'LOADING':'PLAYING',(ios?'ОЖИДАНИЕ ГОЛОСА · ':'ЧТЕНИЕ · ')+sourceLabel);
    notice(sourceWarning||'Источник: '+voice.name+(voice.localService?' · локальный голос':' · сетевой голос браузера'));
    u.onstart=()=>{if(j!==job||j.dead)return;if(mode==='PAUSED')synth.pause();else {status('PLAYING','ЧТЕНИЕ · '+voice.name);if(ios)armWatchdog(j,Math.max(20000,text.length*220/settings.rate+10000));}};
    u.onend=()=>finish(j);
    u.onerror=e=>{if(j!==job||j.dead)return;if(e.error==='network')retryReading(j,'[SPEECH-NETWORK] Прервано подключение к сетевому голосу браузера.');else fail(j,'Синтез речи: '+(e.error||'неизвестная ошибка')+'.');};
    armWatchdog(j,ios?45000:Math.max(20000,text.length*220/settings.rate+10000));
    synth.resume();synth.speak(u);
  }
  async function silenceTail(blob) {
    const Context=window.AudioContext||window.webkitAudioContext;if(!Context)return 0;
    const context=new Context();
    try {
      const buffer=await context.decodeAudioData(await blob.arrayBuffer());
      const pcm=buffer.getChannelData(0),step=Math.max(1,Math.round(buffer.sampleRate*0.01));
      let samples=0;
      for(let end=pcm.length;end>0;end-=step){
        const start=Math.max(0,end-step);let sum=0;
        for(let i=start;i<end;i++)sum+=pcm[i]*pcm[i];
        if(Math.sqrt(sum/(end-start))>0.002)break;
        samples+=end-start;if(samples>buffer.sampleRate*0.5)break;
      }
      return Math.max(0,samples/buffer.sampleRate-0.06);
    }catch(_){return 0;}finally{await context.close().catch(()=>{});}
  }
  function cacheSource(key,source) {
    cache.set(key,source);
    for(const [oldKey,old] of cache) {
      if(cache.size<=MAX_BLOCK_SENTENCES*2+4)break;
      const buffered=[readingBlock,nextBlock].some(block=>block&&[...block.sources.values()].includes(old));
      if(buffered||decks.some(a=>a.src===old.url)||$('previewAudio').src===old.url)continue;
      cache.delete(oldKey);if(old.blob)URL.revokeObjectURL(old.url);
    }
  }
  async function getCloud(text,lang=selectedLanguage()) {
    const key=lang+'|'+text;
    if(cache.has(key))return cache.get(key);
    if(inflight.has(key))return inflight.get(key);
    const promise=(async()=>{
      const direct='https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl='+encodeURIComponent(lang)+'&q='+encodeURIComponent(text);
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),4000);
      let source={url:direct,tail:0,blob:false};
      try {
        const r=await fetch(direct,{signal:controller.signal,referrerPolicy:'no-referrer'});
        if(!r.ok)throw new Error('HTTP '+r.status);
        const blob=await r.blob();if(blob.size<100||!blob.type.startsWith('audio/'))throw new Error('Нет аудио');
        source={url:URL.createObjectURL(blob),tail:await silenceTail(blob),blob:true};
      }catch(error){source.fetchError=error.name==='AbortError'?'Google не ответил на загрузку MP3 за 4 секунды.':'Загрузка MP3 Google через fetch: '+(/^HTTP \d+$|^Нет аудио$/.test(error.message)?error.message:error.name)+'.';}
      finally{clearTimeout(timer);}
      cacheSource(key,source);
      return source;
    })();
    inflight.set(key,promise);
    try{return await promise;}finally{inflight.delete(key);}
  }
  async function getEdgeAudio(text) {
    if(!bridge)throw new Error('Запусти «Голосовой мост.exe» и открой читалку через мост.');
    if(!bridgeVoices.some(v=>'edge:'+v.id===settings.voice))throw new Error(bridgeError||'Голос ещё не подключён. Обнови подключение в настройках звука.');
    const voice=settings.voice.slice(5),rate=settings.rate,pitch=settings.pitch;
    const key=['edge',voice,rate,pitch,text].join('|');
    if(cache.has(key))return cache.get(key);
    if(inflight.has(key))return inflight.get(key);
    const promise=(async()=>{
      const response=await fetch(bridge.baseUrl+'api/tts',{method:'POST',headers:{'Content-Type':'application/json','X-Tishe-Session':bridge.token},body:JSON.stringify({voice,text,rate,pitch}),signal:AbortSignal.timeout(95000)});
      if(!response.ok){
        const data=await response.json().catch(()=>({}));
        const error=new Error('[HTTP-'+response.status+'] '+(data.error||'Microsoft не завершил синтез.'));
        const retryAfter=response.headers.get('Retry-After');
        error.retryAfterMs=retryAfter?Math.max(0,Number.isFinite(Number(retryAfter))?Number(retryAfter)*1000:Date.parse(retryAfter)-Date.now())||0:0;
        throw error;
      }
      if(response.headers.get('X-Tishe-Complete')!=='1'||response.headers.get('X-Tishe-Voice')!==voice)throw new Error('Мост не подтвердил выбранный голос и завершение синтеза.');
      const audio=await response.blob();
      if(!audio.type.startsWith('audio/')||audio.size<1000)throw new Error('Мост не вернул аудио.');
      const source={url:URL.createObjectURL(audio),blob:true,tail:0,engine:'edge',playbackRate:1,label:'Microsoft · '+bridgeVoices.find(v=>v.id===voice)?.name};
      cacheSource(key,source);
      return source;
    })();
    inflight.set(key,promise);
    try{return await promise;}finally{inflight.delete(key);}
  }
  async function getDirectAudio(text) {
    const voice=directVoiceId(),rate=settings.rate,pitch=settings.pitch,signal=networkController.signal;
    const key=['direct-ms',voice,rate,pitch,text].join('|');
    if(cache.has(key))return cache.get(key);
    if(inflight.has(key))return inflight.get(key);
    const promise=(async()=>{
      const audio=await directMicrosoft.synthesize(voice,text,rate,pitch,signal);
      if(signal.aborted)throw new DOMException('Reading cancelled','AbortError');
      const source={url:URL.createObjectURL(audio.blob),blob:true,tail:0,engine:'microsoft-direct',playbackRate:1,label:'Microsoft · '+microsoftVoices.find(v=>v.id===voice)?.name,transport:audio.transport,route:audio.route};
      cacheSource(key,source);
      return source;
    })();
    inflight.set(key,promise);
    try{return await promise;}finally{if(inflight.get(key)===promise)inflight.delete(key);}
  }
  const getNetworkAudio = text => directSelected()?getDirectAudio(text):edgeSelected()?getEdgeAudio(text):getCloud(text);
  const blockSupported = () => directSelected()||edgeSelected();
  function makeBlock(start) {
    return {start,end:Math.min(segments.length,start+settings.blockSize),id:generation,sources:new Map(),pending:null,cancelled:false,prefetched:false};
  }
  function loadBlock(block) {
    if(block.pending)return block.pending;
    block.pending=(async()=>{
      for(let i=block.start;i<block.end;i++) {
        if(block.cancelled||block.id!==generation)throw new DOMException('Reading cancelled','AbortError');
        if(block.sources.has(i))continue;
        block.onProgress?.();
        const source=await getNetworkAudio(segments[i].text);
        if(block.cancelled||block.id!==generation)throw new DOMException('Reading cancelled','AbortError');
        block.sources.set(i,source);block.onProgress?.();
      }
      return block;
    })().finally(()=>{block.pending=null;});
    return block.pending;
  }
  async function getReadingAudio(j) {
    if(!blockSupported())return getNetworkAudio(segments[index].text);
    if(!readingBlock||index<readingBlock.start||index>=readingBlock.end) {
      readingBlock=nextBlock?.start===index?nextBlock:makeBlock(index);nextBlock=null;
    }
    const block=readingBlock,current=index;
    block.onProgress=()=>{
      if(j!==job||j.dead||!active()||j.type!=='loading')return;
      armWatchdog(j,98000);
      status('LOADING','ЗАГРУЗКА БЛОКА · '+block.sources.size+' / '+(block.end-block.start));
    };
    block.onProgress();
    await loadBlock(block);
    prefetchNextBlock(block);
    return block.sources.get(current);
  }
  function prefetchNextBlock(block) {
    if(!block||block!==readingBlock||block.cancelled||block.id!==generation||block.end>=segments.length)return null;
    if(!nextBlock)nextBlock=makeBlock(block.end);
    const next=nextBlock;
    // Start the next sequential batch without waiting for playback or a sentence gap.
    if(!next.prefetched){next.prefetched=true;loadBlock(next).catch(()=>{});}
    return next;
  }
  function prefetchReadingAudio(j) {
    const position=index+1;if(!segments[position])return;
    const ready=source=>{
      if(j!==job||j.dead||!active())return;
      j.nextReady=true;
      const standby=decks[1-deck];if(!overlapping.has(standby)){standby.src=source.url;standby.load();}
      $('deckSlot'+(deck?'A':'B')).classList.add('standby-ready');
    };
    if(!blockSupported()){getNetworkAudio(segments[position].text).then(ready).catch(()=>{});return;}
    if(readingBlock?.sources.has(position))ready(readingBlock.sources.get(position));
    const block=prefetchNextBlock(readingBlock);if(!block)return;
    if(position===block.start&&block.pending)block.pending.then(()=>ready(block.sources.get(position))).catch(()=>{});
    else if(position===block.start&&block.sources.has(position))ready(block.sources.get(position));
  }
  function startTrimTimer(j) {
    clearInterval(j.trimTimer);
    const tail=Math.min(settings.trim/1000,j.source?.tail||0);
    j.trimTimer=setInterval(()=>{
      const a=j.audio;
      if(j!==job||!active()||!a||a.paused||!Number.isFinite(a.duration))return;
      const remaining=(a.duration-a.currentTime)/(a.playbackRate||1);
      if(settings.pauseMs<0&&j.nextReady&&index+1<segments.length&&remaining<=-settings.pauseMs/1000&&!overlapping.has(decks[1-deck])){
        overlapping.add(a);a.onended=a.onerror=()=>overlapping.delete(a);
        j.audio=null;clearJob(j);job=null;index++;highlight();persist();speak();
      }else if(tail>0&&a.duration>1&&a.currentTime>=a.duration-tail)finish(j);
    },25);
  }
  function audioFallback(j,message) {
    if(j!==job||j.dead||j.fallback)return;
    if(networkSelected()||['edge','microsoft-direct'].includes(j.source?.engine)){retryReading(j,message);return;}
    j.fallback=true;clearTimeout(j.watchdog);clearInterval(j.trimTimer);
    if(j.audio){j.audio.onended=j.audio.onerror=j.audio.onloadedmetadata=null;j.audio.pause();j.audio=null;}
    cloudDeadUntil=Date.now()+60000;
    sourceWarning=message+' Продолжаю голосом: '+(chooseVoice()?.name||'голос нужного языка недоступен');
    if(mode==='PAUSED'){j.type='fallback';return;}
    speakNative(j,segments[index].text);
  }
  function playAudio(j,source) {
    if(j!==job||j.dead)return;
    j.source=source;j.type='audio';deck=1-deck;
    const a=decks[deck];j.audio=a;
    a.onended=a.onerror=a.onloadedmetadata=null;a.pause();
    if(a.src!==source.url||a.error||j.retryAttempts){a.src=source.url;a.load();}else{try{a.currentTime=0;}catch(_){}}
    a.volume=settings.volume;a.playbackRate=source.playbackRate??settings.rate;a.preservesPitch=true;
    updateSourceHint();sourceLabel=source.label||'Google MP3';
    status('LOADING','ЗАГРУЗКА · '+sourceLabel);
    notice(['edge','microsoft-direct'].includes(source.engine)?sourceLabel+' · полная запись фразы, без подмены голоса.':source.tail?'Google MP3 · удаляется только измеренная тишина в конце фразы.':'Google MP3 · окончания слов сохраняются.');
    a.onended=()=>finish(j);a.onerror=()=>audioFallback(j,mediaErrorMessage(a,source));
    playReadingAudio(j);
  }
  function mediaErrorMessage(audio,source,error) {
    const code=audio.error?.code;
    const reason=({1:'Загрузка записи прервана.',2:'Браузер не загрузил MP3 из сети.',3:'Браузер не смог декодировать полученный MP3.',4:'Браузер не принял источник или формат MP3.'})[code]||'Не удалось воспроизвести MP3.';
    return '[AUDIO-'+(code||error?.name||'UNKNOWN')+'] '+reason+(source?.fetchError?' '+source.fetchError:'');
  }
  function playReadingAudio(j) {
    const a=j.audio;
    const playToken=Symbol();a.tishePlayToken=playToken;
    const wasWaiting=j.needsTap;
    j.needsTap=false;
    armWatchdog(j,8000);
    // Keep play() directly in this call stack: resume() is entered from the user's tap.
    a.play().then(()=>{
      if(a.tishePlayToken!==playToken)return;
      if(j!==job||j.dead||mode==='PAUSED'||j.type==='retry'){a.pause();return;}
      if(j.fallback){a.pause();return;}
      armWatchdog(j,Math.max(20000,segments[index].text.length*220/settings.rate+12000));
      if(wasWaiting)notice('Источник: '+(j.source.label||'Google MP3')+' · выбранный голос сохранён.');
      status('PLAYING','ЧТЕНИЕ · '+sourceLabel);startTrimTimer(j);
      prefetchReadingAudio(j);
    }).catch(e=>{
      if(a.tishePlayToken!==playToken||j!==job||j.dead||mode==='PAUSED'||j.type==='retry')return;
      if(e.name==='NotAllowedError'){
        pause();j.needsTap=true;status('PAUSED','ЗАПИСЬ ГОТОВА · НАЖМИ ▶');
        notice('[AUDIO-TAP] Браузер требует прямого нажатия для '+(j.source.label||'Google MP3')+'. Нажми ▶ ещё раз: источник сохранён, повторный запрос синтеза и смена голоса не нужны.',false,true);
      }else audioFallback(j,mediaErrorMessage(a,j.source,e));
    });
  }
  function speak(retryAttempts=0) {
    if(!active()||!segments[index])return;
    const j={id:generation,type:'loading',dead:false,retryAttempts};job=j;
    highlight();persist();
    if(googleSelected()&&segments[index].text.length>MAX_CHUNK) {
      fail(j,'[GOOGLE-LENGTH] Предложение длиннее ограничения этого режима Google MP3 (180 символов). Раздели предложение или выбери другой источник; системный голос не включён.');return;
    }
    if(!networkSelected()) {speakNative(j,segments[index].text);return;}
    status('LOADING');armWatchdog(j,directSelected()||edgeSelected()?98000:8000);
    getReadingAudio(j).then(source=>{
      if(j!==job||j.dead||j.id!==generation||j.fallback||j.type==='retry')return;
      if(mode==='PAUSED'){j.source=source;j.type='ready';return;}
      if(active())playAudio(j,source);
    }).catch(error=>audioFallback(j,error));
  }
  function seek(value,autoStart=false) {
    if(!segments.length)return;
    const was=active(),paused=mode==='PAUSED';cancelReading();stopPreview();
    index=Math.trunc(clamp(value,0,segments.length-1,0));completed=false;
    status(paused?'PAUSED':'IDLE');highlight(false);persist();
    if(was||autoStart)start();
  }
  function previous(){if(index>0)seek(index-1);}
  function next(){if(index+1<segments.length)seek(index+1);}
  function restartSettings() {
    const was=active(),paused=mode==='PAUSED';stopPreview();cancelReading();
    status(paused?'PAUSED':'IDLE');persist();if(was)start();
  }
  function setRate(v){settings.rate=clamp(v,0.8,1.5,0.95);$('selectRate').value=settings.rate.toFixed(2);restartSettings();}
  function setPitch(v){settings.pitch=clamp(v,0.7,1.3,1);$('rangePitch').value=settings.pitch;fill($('rangePitch'));updateSourceHint();restartSettings();}
  function setVolume(v){settings.volume=clamp(v,0,1,1);$('rangeVolume').value=settings.volume;$('lblVolume').textContent=Math.round(settings.volume*100)+'%';fill($('rangeVolume'));for(const a of [...decks,$('previewAudio')])a.volume=settings.volume;if(job?.utterance||preview?.utterance)restartSettings();else persist();}
  function setPauseMs(v){
    settings.pauseMs=clamp(v,-2000,2000,400);
    $('rangePauseMs').value=settings.pauseMs;fill($('rangePauseMs'));$('lblPauseMs').textContent=settings.pauseMs+' мс';
    if(job?.type==='gap'&&active()){job.elapsed+=performance.now()-job.gapStarted;scheduleGap(job);}
    persist();
  }
  function updateBlockControl() {
    const control=$('rangeBlockSize');if(!control)return;
    control.value=settings.blockSize;control.disabled=!blockSupported();fill(control);
    const n=settings.blockSize,label=n===1?'предложение':n<5?'предложения':'предложений';
    $('lblBlockSize').textContent=n+' '+label;
    control.setAttribute('aria-valuetext',n+' '+label);
    $('blockSizeHelp').textContent=blockSupported()?'Запас аудио: от 1 до 20 предложений. Больше — дольше первая загрузка, но больше готового звука при обрыве сети. Паузы и переходы остаются по предложениям. Новый размер применяется со следующего блока.':'Запас целых записей доступен для Microsoft Online и голосового моста. Голоса браузера и Google MP3 продолжают читать по одному предложению.';
  }
  function setBlockSize(v) {
    settings.blockSize=Math.trunc(clamp(v,1,MAX_BLOCK_SENTENCES,1));
    if(nextBlock){nextBlock.cancelled=true;nextBlock=null;}
    updateBlockControl();persist();
  }
  function setFontSize(v){settings.fontSize=clamp(v,16,28,21);document.documentElement.style.setProperty('--reader-font-size',settings.fontSize+'px');$('rangeFontSize').value=settings.fontSize;$('lblFontSize').textContent=settings.fontSize+'px';fill($('rangeFontSize'));persist();}
  function setAutoScroll(v){settings.autoScroll=!!v;$('chkAutoScroll').checked=settings.autoScroll;persist();}
  function theme(){const name=['dark','light','oled'][settings.theme];document.documentElement.dataset.theme=name;$('lblCycleTheme').textContent='Свет: '+({dark:'Тёмная',light:'Светлая',oled:'OLED'}[name]);}
  function cycleTheme(){settings.theme=(settings.theme+1)%3;theme();persist();}

  function editorStats() {
    const text=$('editorTextarea').value;
    $('editorLiveStats').textContent=(text.trim()?text.trim().split(/\s+/u).length:0)+' слов · '+splitText(text).length+' фраз';
  }
  function syncDraft() {
    clearTimeout(draftTimer);
    draft={title:$('editDocTitle').value.slice(0,200),text:$('editorTextarea').value.slice(0,LIMIT)};
    persistNow();
  }
  function draftChanged() {clearTimeout(draftTimer);draftTimer=setTimeout(()=>{syncDraft();editorStats();},350);}
  function setDialog(id,open) {
    const el=$(id);
    if(!open){if(id==='editorDrawer'&&!el.hidden)syncDraft();el.hidden=true;}
    else {
      savedFocus=document.activeElement;
      if(id==='editorDrawer'){setDialog('studioDrawer',false);$('editorTextarea').value=draft.text;$('editDocTitle').value=draft.title;editorStats();}
      else setDialog('editorDrawer',false);
      el.hidden=false;
    }
    $('btnToggleEditor').classList.toggle('active',!$('editorDrawer').hidden);
    $('btnToggleStudio').classList.toggle('active',!$('studioDrawer').hidden);
    const modal=!$('editorDrawer').hidden||!$('studioDrawer').hidden||!$('oledOverlay').hidden;
    for(const target of ['topHeaderBar','mainStage','bottomDockWrapper'])$(target).inert=modal||(target==='topHeaderBar'&&document.body.classList.contains('focus-mode'));
    document.body.style.overflow=modal?'hidden':'';
    if(open)queueMicrotask(()=>{if(!el.hidden)(id==='editorDrawer'?$('editorTextarea'):el.querySelector('button')).focus();});
    else if(!modal&&savedFocus?.isConnected)savedFocus.focus({preventScroll:true});
  }
  function toggleEditor(force){setDialog('editorDrawer',typeof force==='boolean'?force:$('editorDrawer').hidden);}
  function toggleStudio(force){setDialog('studioDrawer',typeof force==='boolean'?force:$('studioDrawer').hidden);}
  function saveEditorText(play) {
    syncDraft();stop();
    doc={text:draft.text.trim(),title:draft.title.trim()||'Рукопись'};
    draft={...doc};index=0;completed=false;render();persistNow();toggleEditor(false);
    notice(storageFailed?'Текст применён, но не сохранён браузером. Скачай копию.':'Рукопись применена.');
    if(play&&segments.length)start();
  }
  function confirmButton(id,label,action) {
    const button=$(id),text=button.querySelector('span:last-child');
    if(armed.has(id)){clearTimeout(armed.get(id).timer);text.textContent=armed.get(id).label;button.classList.remove('is-armed-danger');armed.delete(id);action();return;}
    const original=text.textContent;text.textContent=label;button.classList.add('is-armed-danger');
    const timer=setTimeout(()=>{text.textContent=original;button.classList.remove('is-armed-danger');armed.delete(id);},3000);
    armed.set(id,{timer,label:original});
  }
  function clearAllText(){confirmButton('btnClearTop','Подтвердить сброс?',()=>{
    importVersion++;clearTimeout(draftTimer);stop();doc={title:'Рукопись не загружена',text:''};draft={title:'',text:''};index=0;completed=false;
    $('editorTextarea').value='';$('editDocTitle').value='';toggleEditor(false);render();persistNow();notice('Рукопись и черновик очищены.');
  });}
  function clearEditorArea(){confirmButton('btnClearEditor','Очистить черновик?',()=>{$('editorTextarea').value='';$('editDocTitle').value='';syncDraft();editorStats();$('editorTextarea').focus();});}
  async function pasteIntoEditorArea() {
    try {if(!navigator.clipboard?.readText)throw new Error();const text=await navigator.clipboard.readText();if(text.length>LIMIT)throw new Error('large');$('editorTextarea').value=text;syncDraft();editorStats();}
    catch(e){notice(e.message==='large'?'Текст слишком большой (лимит — 1 млн символов).':'Браузер не дал доступ к буферу. Вставь текст в поле сочетанием Ctrl+V.',true);}
    $('editorTextarea').focus();
  }
  async function pasteFromClipboardAndRead() {
    toggleEditor(true);await pasteIntoEditorArea();
    // Applying is a deliberate click: denied clipboard access must not start an old draft.
  }
  function htmlText(content) {
    const template=document.createElement('template');template.innerHTML=content;
    template.content.querySelectorAll('script,style,noscript,template,iframe,object,svg,head').forEach(n=>n.remove());
    template.content.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));
    template.content.querySelectorAll('p,div,section,article,li,h1,h2,h3,h4,h5,h6,blockquote,tr').forEach(n=>n.append('\n\n'));
    return template.content.textContent.replace(/[\t ]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  }
  async function processFile(file) {
    if(!file)return;
    const version=++importVersion;
    if(!/\.(txt|md|html?|markdown)$/i.test(file.name)){notice('Поддерживаются только TXT, MD, HTML и HTM.',true);return;}
    if(file.size>5*1024*1024){notice('Файл больше 5 МБ. Импорт отменён; текущий текст сохранён.',true);return;}
    try {
      const bytes=await file.arrayBuffer();if(version!==importVersion)return;
      let content;
      try {content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
      catch(_){content=new TextDecoder('windows-1251').decode(bytes);}
      if(/\.html?$/i.test(file.name))content=htmlText(content);
      content=content.replace(/^\uFEFF/,'').trim();
      if(content.length>LIMIT)throw new Error('В тексте больше 1 млн символов.');
      if(!content)throw new Error('В файле не найден текст.');
      // Import into the draft first; the current reading position remains intact until Apply.
      toggleEditor(true);clearTimeout(draftTimer);
      $('editorTextarea').value=content;$('editDocTitle').value=file.name.replace(/\.[^.]+$/,'').slice(0,200);
      syncDraft();editorStats();notice('Файл загружен в редактор. Нажми «Применить текст» или «Применить и слушать».');
    }catch(e){notice('Импорт не выполнен: '+e.message,true);}
  }
  function importTextFile(e){const f=e.target.files?.[0];e.target.value='';processFile(f);}
  function exportText() {
    const editing=!$('editorDrawer').hidden;if(editing)syncDraft();
    const d=editing?draft:doc;
    const blob=new Blob([d.title+'\n\n'+d.text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=(d.title||'Рукопись').replace(/[<>:"/\\|?*]/g,'_').slice(0,100)+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function toggleFocus(){toggleEditor(false);toggleStudio(false);document.body.classList.toggle('focus-mode');const on=document.body.classList.contains('focus-mode');$('btnToggleFocus').classList.toggle('active',on);$('topHeaderBar').inert=on;layout();}
  function toggleOled(show) {
    clearTimeout(holdTimer);$('btnHoldUnlock').classList.remove('is-holding');$('lblHoldUnlockText').textContent='Удерживай 1 сек для разблокировки';
    if(show){toggleEditor(false);toggleStudio(false);savedFocus=document.activeElement;}
    $('oledOverlay').hidden=!show;
    for(const id of ['topHeaderBar','mainStage','bottomDockWrapper'])$(id).inert=show||(id==='topHeaderBar'&&document.body.classList.contains('focus-mode'));
    document.body.style.overflow=show?'hidden':'';
    if(show)$('oledPlayBtn').focus();else if(savedFocus?.isConnected)savedFocus.focus({preventScroll:true});
  }
  function setSleepTimer(minutes) {
    clearInterval(sleepInterval);sleepDeadline=minutes>0?Date.now()+minutes*60000:0;
    document.querySelectorAll('.sleep-pill').forEach(b=>b.classList.toggle('active',Number(b.dataset.sleep)===minutes));
    const tick=()=>{
      if(!sleepDeadline){$('lblSleepTimer').textContent='Выкл';return;}
      const seconds=Math.max(0,Math.ceil((sleepDeadline-Date.now())/1000));
      $('lblSleepTimer').textContent=Math.floor(seconds/60).toString().padStart(2,'0')+':'+(seconds%60).toString().padStart(2,'0');
      if(!seconds){clearInterval(sleepInterval);sleepDeadline=0;pause();stopPreview();$('lblSleepTimer').textContent='Таймер завершён';notice('Таймер сна завершён. Чтение приостановлено.');}
    };
    tick();if(sleepDeadline)sleepInterval=setInterval(tick,1000);
  }
  async function previewSelectedVoice() {
    if(preview?.needsTap&&preview.retry){preview.retry();return;}
    pause();stopPreview();primeNetworkAudio();
    const p={dead:false};preview=p;$('btnPreviewVoice').classList.add('is-previewing');
    const text=selectedLanguage()==='en'?'Voice preview. Adjust the volume and reading speed for comfortable listening.':'Проверка голоса. Настрой громкость и темп так, чтобы слушать было удобно.';
    const end=(message,error=false)=>{if(preview!==p||p.dead)return;clearJob(p);preview=null;$('btnPreviewVoice').classList.remove('is-previewing');$('previewStatusText').textContent=message;if(error)notice(message,true);};
    const native=()=>{
      if(p.nativeStarted||preview!==p||p.dead)return;
      p.nativeStarted=true;clearTimeout(p.watchdog);
      if(p.audio){p.audio.onended=p.audio.onerror=null;p.audio.pause();p.audio=null;}
      const v=chooseVoice();if(!synth||!v){end('Нет доступного голоса нужного языка. Выбери голос в плеере.');return;}
      const u=new SpeechSynthesisUtterance(text);p.utterance=u;u.voice=v;u.lang=v.lang;u.rate=settings.rate;u.pitch=settings.pitch;u.volume=settings.volume;
      u.onend=()=>end('Проба завершена · '+v.name);u.onerror=e=>end('Ошибка пробы: '+e.error);
      $('previewStatusText').textContent='Проба · '+v.name;
      p.watchdog=setTimeout(()=>{if(preview===p){stopPreview();$('previewStatusText').textContent='Голос не ответил. Выбери другой источник.';}},30000);
      // The reader's paused synth job cannot coexist with the preview synth queue.
      if(job?.utterance){cancelReading();status('PAUSED');}
      synth.resume();synth.speak(u);
    };
    const playNetworkPreview=source=>{
      const a=$('previewAudio');p.audio=a;p.source=source;
      a.src=source.url;a.playbackRate=source.playbackRate??settings.rate;a.volume=settings.volume;a.preservesPitch=true;
      const label=source.label||'Google MP3';
      const failed=error=>{
        if(preview!==p||p.dead)return;
        end(mediaErrorMessage(a,source,error)+' Голос не заменён.',true);
      };
      a.onended=()=>end('Проба завершена · '+label);a.onerror=()=>failed();
      p.retry=()=>{
        if(preview!==p||p.dead)return;
        p.needsTap=false;clearTimeout(p.watchdog);$('btnPreviewVoice').classList.add('is-previewing');
        p.watchdog=setTimeout(()=>{if(preview===p)end('[AUDIO-TIMEOUT] Браузер не запустил пробу вовремя. Голос не заменён.',true);},15000);
        a.play().then(()=>{
          if(preview!==p||p.dead){a.pause();return;}
          clearTimeout(p.watchdog);p.watchdog=setTimeout(()=>end('[AUDIO-TIMEOUT] Проба не завершилась вовремя.',true),45000);
          notice('Проба · '+label+' · выбранный голос сохранён.');
          $('previewStatusText').textContent='Проба · '+label;
        }).catch(error=>{
          if(preview!==p||p.dead)return;
          if(error.name==='NotAllowedError'){
            clearTimeout(p.watchdog);p.needsTap=true;$('btnPreviewVoice').classList.remove('is-previewing');
            $('previewStatusText').textContent='[AUDIO-TAP] Браузер требует прямого нажатия для '+label+'. Нажми «Прослушать пробу голоса» ещё раз: источник сохранён, голос не изменится.';
          }else failed(error);
        });
      };
      p.retry();
    };
    if(directSelected()||edgeSelected()) {
      $('previewStatusText').textContent='Microsoft · синтез пробы…';
      try {
        const source=await getNetworkAudio(text);if(preview!==p||p.dead)return;
        playNetworkPreview(source);
      }catch(error){end(error.message+' Голос не заменён.',true);}
      return;
    }
    if(!googleSelected()){native();return;}
    $('previewStatusText').textContent='Загрузка сетевой пробы…';
    try {
      const source=await getCloud(text);if(preview!==p||p.dead)return;
      playNetworkPreview(source);
    }catch(error){if(preview===p&&!p.dead)end('[GOOGLE-LOAD] '+error.message+' Голос не заменён.',true);}
  }
  function setupMediaSession() {
    if(!navigator.mediaSession)return;
    try {navigator.mediaSession.metadata=new MediaMetadata({title:doc.title,artist:'Тише'});}catch(_){}
    const handlers={play:()=>{if(!active())mode==='PAUSED'?resume():start();},pause,stop,previoustrack:previous,nexttrack:next};
    for(const [action,handler] of Object.entries(handlers))try{navigator.mediaSession.setActionHandler(action,handler);}catch(_){}
  }

  window.AuraApp={togglePlay,stop,prev:previous,next,seekToIndex:v=>seek(v),toggleEditor,toggleStudio,saveEditorText,clearAllText,clearEditorArea,pasteFromClipboardAndRead,pasteIntoEditorArea,importTextFile,exportText,toggleFocus,cycleTheme,toggleOled,setRate,setPitch,setVolume,setPauseMs,setFontSize,setAutoScroll,setSleepTimer,previewSelectedVoice,stopPreview,refreshBridge,onVoiceChange(v){settings.voice=v;cloudDeadUntil=0;sourceWarning='';populateVoices();restartSettings();}};
  window.AuraApp.setBlockSize=setBlockSize;
  window.AuraApp.refreshBrowserVoices=populateVoices;

  for(const id of ['editorTextarea','editDocTitle'])$(id).addEventListener('input',draftChanged);
  $('editorTextarea').maxLength=LIMIT;$('editDocTitle').maxLength=200;
  window.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();$('bookSheet').classList.add('drag-over');$('editorDropZone').classList.add('drag-over');}});
  window.addEventListener('dragleave',e=>{if(!e.relatedTarget){$('bookSheet').classList.remove('drag-over');$('editorDropZone').classList.remove('drag-over');}});
  window.addEventListener('drop',e=>{if(!e.dataTransfer.files.length)return;e.preventDefault();$('bookSheet').classList.remove('drag-over');$('editorDropZone').classList.remove('drag-over');if(e.dataTransfer.files.length>1)notice('Импортируется первый файл.');processFile(e.dataTransfer.files[0]);});
  const cancelHold=()=>{clearTimeout(holdTimer);holdTimer=null;$('btnHoldUnlock').classList.remove('is-holding');$('lblHoldUnlockText').textContent='Удерживай 1 сек для разблокировки';};
  function beginHold(e){if(e.type==='pointerdown'&&e.button!==0)return;if(holdTimer)return;e.preventDefault();$('btnHoldUnlock').classList.add('is-holding');holdTimer=setTimeout(()=>{cancelHold();toggleOled(false);},900);}
  $('btnHoldUnlock').addEventListener('pointerdown',beginHold);
  for(const event of ['pointerup','pointerleave','pointercancel','blur'])$('btnHoldUnlock').addEventListener(event,cancelHold);
  $('btnHoldUnlock').addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat)beginHold(e);});
  $('btnHoldUnlock').addEventListener('keyup',cancelHold);
  window.addEventListener('blur',cancelHold);
  window.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();if(!$('oledOverlay').hidden)toggleOled(false);else if(!$('editorDrawer').hidden)toggleEditor(false);else if(!$('studioDrawer').hidden)toggleStudio(false);else if(document.body.classList.contains('focus-mode'))toggleFocus();return;}
    const modal=!$('oledOverlay').hidden?$('oledOverlay'):!$('editorDrawer').hidden?$('editorDrawer'):!$('studioDrawer').hidden?$('studioDrawer'):null;
    if(e.key==='Tab'&&modal){const items=[...modal.querySelectorAll('button:not([disabled]),input:not([disabled]):not([type=hidden]),textarea,select:not([disabled]),[tabindex="0"]')].filter(el=>el.getClientRects().length);const first=items[0],last=items[items.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}return;}
    if(modal||e.altKey||e.ctrlKey||e.metaKey||e.repeat||e.target.closest('button,input,textarea,select,[contenteditable="true"],[role="button"]'))return;
    if(e.code==='Space'){e.preventDefault();togglePlay();}else if(e.key==='ArrowLeft'){e.preventDefault();previous();}else if(e.key==='ArrowRight'){e.preventDefault();next();}
  });
  window.addEventListener('online',()=>retryNow(true));
  document.addEventListener('visibilitychange',()=>{cancelHold();wakeLock();if(document.visibilityState==='visible')retryNow();});
  window.addEventListener('resize',layout);
  if(window.ResizeObserver){const observer=new ResizeObserver(layout);observer.observe($('topHeaderBar'));observer.observe($('bottomDockWrapper'));}
  if(synth)synth.addEventListener('voiceschanged',populateVoices);
  window.addEventListener('pagehide',()=>{if(!$('editorDrawer').hidden)syncDraft();else persistNow();stopPreview();cancelReading();status('IDLE');for(const source of cache.values())if(source.blob)URL.revokeObjectURL(source.url);cache.clear();});
  restore();
  $('selectRate').value=settings.rate.toFixed(2);
  if(!$('selectRate').value){$('selectRate').add(new Option(settings.rate.toFixed(2)+'x',settings.rate.toFixed(2)));$('selectRate').value=settings.rate.toFixed(2);}
  for(const [id,value] of [['rangePitch',settings.pitch],['rangeVolume',settings.volume],['rangePauseMs',settings.pauseMs],['rangeFontSize',settings.fontSize]]){$(id).value=value;fill($(id));}
  $('lblVolume').textContent=Math.round(settings.volume*100)+'%';$('lblFontSize').textContent=settings.fontSize+'px';$('chkAutoScroll').checked=settings.autoScroll;
  document.documentElement.style.setProperty('--reader-font-size',settings.fontSize+'px');
  theme();populateVoices();render();status('IDLE');
  refreshBridge();
  setTimeout(populateVoices,200);setTimeout(populateVoices,1000);
})();