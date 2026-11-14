// Lossless transport for large static assets. Model/state bytes stay unchanged.
import {assets} from './asset-map.js?v=20261113-online';
const root=new URL('./',import.meta.url);
const coldProbe=new URLSearchParams(globalThis.location?.search??'').get('startup-test')==='cold';
const CACHE_NAME='echo-h-verified-assets-v1',RUNTIME_CACHE_NAME='echo-runtime-verified-v1',MAX_PARALLEL=6,STALL_TIMEOUT=15000;
const inFlight=new Map(),queue=[],cacheWrites=new Set();
export const assetLoadStats={cacheHits:0,cacheMisses:0,cacheWrites:0,cacheWriteFailures:0,cacheUnavailable:0,retries:0};
let active=0;

function persist(cache,key,bytes,headers){
  if(!cache)return;
  const write=cache.put(key,new Response(bytes,{headers})).then(()=>{assetLoadStats.cacheWrites++;},()=>{assetLoadStats.cacheWriteFailures++;});
  cacheWrites.add(write);void write.finally(()=>cacheWrites.delete(write));
}
// Cache writes run alongside session compilation, then settle before Ready.
export async function flushAssetCache(){await Promise.allSettled([...cacheWrites]);}

async function digest(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');}

// Retry a stalled connection, rather than leaving the loading screen pending.
// The timeout is renewed for every received chunk, so slow downloads can finish.
async function download(url,options={}){
  for(let attempt=0;;attempt++){
    options.signal?.throwIfAborted();
    const controller=new AbortController(),cancel=()=>controller.abort(options.signal.reason);
    options.signal?.addEventListener('abort',cancel,{once:true});
    let timer;
    const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(new Error('Download connection stalled')),STALL_TIMEOUT);};
    try{
      touch();const response=await fetch(url,{...options,...(coldProbe?{cache:'reload'}:{}),signal:controller.signal});
      if(!response.ok){const error=new Error(`${url}: HTTP ${response.status}`);error.retryable=response.status>=500||response.status===408||response.status===429;throw error;}
      const reader=response.body.getReader(),chunks=[];let length=0;
      for(;;){const {done,value}=await reader.read();if(done)break;touch();chunks.push(value);length+=value.length;}
      const bytes=new Uint8Array(length);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      return bytes;
    }catch(error){
      if(options.signal?.aborted)throw options.signal.reason;
      if(attempt>=2||error.retryable===false)throw error;
      assetLoadStats.retries++;
      await new Promise(resolve=>setTimeout(resolve,250*2**attempt));
    }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);}
  }
}
function progress(asset,loaded,total,phase){
  if(typeof WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope)postMessage({type:'load-progress',asset,loaded,total,phase});
}

// One queue is shared by all assets, keeping parallel startup bounded in memory.
function drain(){
  while(active<MAX_PARALLEL&&queue.length){
    const job=queue.shift();
    job.signal?.removeEventListener('abort',job.cancel);
    if(job.signal?.aborted){job.reject(job.signal.reason);continue;}
    active++;
    Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{active--;drain();});
  }
}
function scheduled(task,signal){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const job={task,signal,resolve,reject,cancel:()=>{
      const index=queue.indexOf(job);
      if(index!==-1){queue.splice(index,1);reject(signal.reason);}
    }};
    signal?.addEventListener('abort',job.cancel,{once:true});
    queue.push(job);drain();
  });
}

async function openCache(options,entry){
  // Storage is an optimization: private browsing and quota limits must not block use.
  if(options.cache==='no-store'||typeof caches==='undefined')return null;
  try{return await caches.open(entry?.direct?RUNTIME_CACHE_NAME:CACHE_NAME);}catch{assetLoadStats.cacheUnavailable++;return null;}
}
async function cachedBytes(cache,url,entry,signal){
  if(!cache||coldProbe)return null;
  try{
    const response=await cache.match(url);
    if(!response)return null;
    const storedHash=response.headers.get('X-Echo-SHA256');
    if(storedHash===entry.sha256||(entry.direct&&!storedHash)){
      const bytes=new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      if(bytes.length===entry.bytes&&await digest(bytes)===entry.sha256)return bytes;
    }
    // An interrupted, stale, or corrupt cache entry is never used for inference.
    await cache.delete(url);
  }catch(error){if(signal?.aborted)throw error;}
  return null;
}

async function loadAsset(resolved,key,entry,options){
  options.signal?.throwIfAborted();
  if(!entry)return scheduled(async()=>{
    const response=await fetch(resolved,options);
    if(!response.ok)throw new Error(`${key}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },options.signal);

  progress(key,0,entry.bytes,'download');
  const cacheKey=entry.direct?new URL(`/.echo-cache/${entry.sha256}-${entry.bytes}`,root).href:resolved.href;
  const cache=await openCache(options,entry),cached=await cachedBytes(cache,cacheKey,entry,options.signal);
  options.signal?.throwIfAborted();
  if(cached){assetLoadStats.cacheHits++;progress(key,entry.bytes,entry.bytes,'cached');return cached;}
  assetLoadStats.cacheMisses++;
  // Runtime WASM already uses HTTP gzip on Pages. Cache its verified decoded
  // bytes without introducing a second compression format or another URL.
  if(entry.direct){
    const bytes=await scheduled(()=>download(resolved,options),options.signal);
    if(bytes.length!==entry.bytes||await digest(bytes)!==entry.sha256)throw new Error(`Asset integrity check failed: ${key}`);
    options.signal?.throwIfAborted();progress(key,entry.bytes,entry.bytes,'ready');
    persist(cache,cacheKey,bytes,{'Content-Type':'application/wasm','X-Echo-SHA256':entry.sha256});
    return bytes;
  }
  if(typeof DecompressionStream==='undefined')throw new Error('Please use a modern browser with streaming decompression, such as a recent Chrome, Edge or Firefox.');

  let length=0;
  const offsets=entry.parts.map(part=>{const offset=length;length+=part.bytes;return offset;});
  if(length!==entry.bytes)throw new Error(`Invalid asset chunk length: ${key}`);
  const result=new Uint8Array(entry.bytes),controller=new AbortController();
  const cancel=()=>controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort',cancel,{once:true});
  let loaded=0;
  try{
    await Promise.all(entry.parts.map((part,i)=>scheduled(async()=>{
      const compressed=await download(new URL(part.file,root),{...options,signal:controller.signal});
      const raw=new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      controller.signal.throwIfAborted();
      if(raw.length!==part.bytes)throw new Error(`Invalid asset chunk length: ${key}`);
      result.set(raw,offsets[i]);loaded+=raw.length;
      progress(key,loaded,entry.bytes,'download');
    },controller.signal)));
    controller.signal.throwIfAborted();
    progress(key,entry.bytes,entry.bytes,'verify');
    if(await digest(result)!==entry.sha256)throw new Error(`Asset integrity check failed: ${key}`);
    controller.signal.throwIfAborted();
    progress(key,entry.bytes,entry.bytes,'ready');
    // Cache only after verification. Persisting never delays model initialization.
    persist(cache,resolved.href,result,{'Content-Type':'application/octet-stream','X-Echo-SHA256':entry.sha256});
    return result;
  }catch(error){controller.abort(error);throw error;}
  finally{options.signal?.removeEventListener('abort',cancel);}
}

export async function loadBytes(url,options={}){
  const resolved=new URL(url,root);
  const local=resolved.origin===root.origin&&resolved.pathname.startsWith(root.pathname);
  const key=local?resolved.pathname.slice(root.pathname.length):resolved.href,entry=local?assets[key]:null;
  // Cancellable requests stay independent: resetting a motion cannot cancel another caller.
  const share=Object.keys(options).length===0;
  if(!share)return loadAsset(resolved,key,entry,options);
  const cacheKey=resolved.href;
  if(inFlight.has(cacheKey))return inFlight.get(cacheKey).then(bytes=>bytes.slice());
  const promise=loadAsset(resolved,key,entry,options);
  inFlight.set(cacheKey,promise);
  try{return await promise;}finally{inFlight.delete(cacheKey);}
}
