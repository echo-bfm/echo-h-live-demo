import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';

const source=await readFile(new URL('../site/asset-loader.js',import.meta.url),'utf8');
let instance=0;
function fixture(name,count=6){
  const chunks=Array.from({length:count},(_,i)=>new Uint8Array(128+i).fill(i+1));
  const expected=new Uint8Array(Buffer.concat(chunks));
  return {name,expected,chunks,entry:{bytes:expected.length,sha256:createHash('sha256').update(expected).digest('hex'),parts:chunks.map((bytes,i)=>({file:`asset-parts/${name}-${i}.bin`,bytes:bytes.length}))}};
}
async function setup(fixtures,{cache,delay=()=>15,corrupt=false,stallOnce=false}={}){
  const entries=Object.fromEntries(fixtures.map(f=>[`assets/${f.name}.bin`,f.entry]));
  const chunks=new Map(fixtures.flatMap(f=>f.entry.direct?[[`/demo/assets/${f.name}.bin`,{bytes:f.expected,index:0,direct:true}]]:f.entry.parts.map((part,i)=>[`/demo/${part.file}`,{bytes:f.chunks[i],index:i}])));
  const messages=[],calls=[];
  let active=0,maximum=0;
  globalThis.WorkerGlobalScope=class{static [Symbol.hasInstance](){return true;}};
  globalThis.postMessage=message=>messages.push(message);
  globalThis.caches=cache;
  globalThis.fetch=(url,{signal}={})=>new Promise((resolve,reject)=>{
    const path=new URL(url).pathname,chunk=chunks.get(path);
    calls.push(path);active++;maximum=Math.max(maximum,active);
    if(!chunk){active--;reject(new Error(`Unexpected fetch: ${url}`));return;}
    let ended=false;
    const finish=()=>{if(ended)return false;ended=true;active--;signal?.removeEventListener('abort',abort);return true;};
    const abort=()=>{clearTimeout(timer);if(finish())reject(signal.reason);};
    const shouldStall=stallOnce&&calls.filter(p=>p===path).length===1;
    const timer=setTimeout(()=>{
      if(!finish())return;
      const bytes=chunk.bytes.slice();
      if(corrupt)bytes[0]^=255;
      resolve(new Response(chunk.direct?bytes:gzipSync(bytes)));
    },shouldStall?1000:delay(chunk.index));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
  });
  let code=source.replace(/import \{assets\} from '.\/asset-map\.js[^']*';/,`const assets=${JSON.stringify(entries)};`).replace("new URL('./',import.meta.url)","new URL('https://test.invalid/demo/')");
  if(stallOnce)code=code.replace('STALL_TIMEOUT=15000','STALL_TIMEOUT=50');
  const module=await import(`data:text/javascript;base64,${Buffer.from(`${code}\n// test instance ${instance++}`).toString('base64')}`);
  return {...module,messages,calls,get maximum(){return maximum;},get active(){return active;}};
}
function memoryCache({denyOpen=false,denyPut=false}={}){
  const entries=new Map();
  const store={
    async match(key){return entries.get(key)?.clone();},
    async put(key,response){if(denyPut)throw new Error('quota exceeded');entries.set(key,response);},
    async delete(key){return entries.delete(key);}
  };
  return {entries,store,async open(){if(denyOpen)throw new Error('storage denied');return store;}};
}

test('chunks complete out of order, assemble exactly, and share a six-request limit across assets',async()=>{
  const a=fixture('a'),b=fixture('b',5);
  const loader=await setup([a,b],{delay:i=>i===0?60:10});
  const [first,second]=await Promise.all([loader.loadBytes('assets/a.bin'),loader.loadBytes('assets/b.bin')]);
  assert.deepEqual(first,a.expected);assert.deepEqual(second,b.expected);
  assert.equal(loader.maximum,6);assert.equal(loader.calls.length,11);
  for(const asset of ['assets/a.bin','assets/b.bin']){
    const updates=loader.messages.filter(m=>m.asset===asset);
    assert.equal(updates.at(-1).phase,'ready');
    assert.equal(updates.at(-1).loaded,updates.at(-1).total);
    assert(updates.every((m,i)=>!i||m.loaded>=updates[i-1].loaded));
  }
});

test('duplicate uncancellable loads share transport but return separate buffers',async()=>{
  const data=fixture('duplicate',2),loader=await setup([data]);
  const [a,b]=await Promise.all([loader.loadBytes('assets/duplicate.bin'),loader.loadBytes('assets/duplicate.bin')]);
  assert.equal(loader.calls.length,2);assert.deepEqual(a,b);assert.notEqual(a.buffer,b.buffer);
  a[0]=99;assert.equal(b[0],1);
});

test('corrupt downloaded data is rejected and never persisted',async()=>{
  const data=fixture('corrupt',2),cache=memoryCache(),loader=await setup([data],{cache,corrupt:true});
  await assert.rejects(loader.loadBytes('assets/corrupt.bin'),/integrity check failed/);
  assert.equal(cache.entries.size,0);
});

test('truncated chunks are rejected before hash verification',async()=>{
  const data=fixture('truncated',1);
  data.entry.bytes++;data.entry.parts[0].bytes++;
  const loader=await setup([data]);
  await assert.rejects(loader.loadBytes('assets/truncated.bin'),/Invalid asset chunk length/);
});

test('abort removes queued chunks and leaves an independent caller usable',async()=>{
  const a=fixture('cancelled',9),b=fixture('survivor',2),loader=await setup([a,b],{delay:()=>35});
  const controller=new AbortController();
  const cancelled=loader.loadBytes('assets/cancelled.bin',{signal:controller.signal});
  const check=assert.rejects(cancelled,{name:'AbortError'});
  const survivor=loader.loadBytes('assets/survivor.bin');
  setTimeout(()=>controller.abort(),5);
  await check;
  assert.deepEqual(await survivor,b.expected);
  assert.equal(loader.calls.filter(path=>path.includes('cancelled')).length,6);
  assert(loader.maximum<=6);
});

test('cancelling one request does not cancel another request for the same asset',async()=>{
  const data=fixture('shared',2),loader=await setup([data],{delay:()=>35});
  const controller=new AbortController();
  const cancelled=loader.loadBytes('assets/shared.bin',{signal:controller.signal});
  const check=assert.rejects(cancelled,{name:'AbortError'});
  const survivor=loader.loadBytes('assets/shared.bin');
  setTimeout(()=>controller.abort(),5);
  await check;
  assert.deepEqual(await survivor,data.expected);
  assert.equal(loader.calls.length,4);
});

test('verified bytes are reused across loader instances without downloading again',async()=>{
  const data=fixture('cached',2),cache=memoryCache();
  const first=await setup([data],{cache});
  assert.deepEqual(await first.loadBytes('assets/cached.bin'),data.expected);
  const second=await setup([data],{cache});
  assert.deepEqual(await second.loadBytes('assets/cached.bin'),data.expected);
  assert.equal(second.calls.length,0);assert.equal(second.messages.at(-1).phase,'cached');
});

test('corrupt persistent bytes are discarded and replaced with verified data',async()=>{
  const data=fixture('repair',2),cache=memoryCache();
  await cache.store.put('https://test.invalid/demo/assets/repair.bin',new Response(new Uint8Array(data.entry.bytes),{headers:{'X-Echo-SHA256':data.entry.sha256}}));
  const loader=await setup([data],{cache});
  assert.deepEqual(await loader.loadBytes('assets/repair.bin'),data.expected);
  assert.equal(loader.calls.length,2);
});

test('unavailable storage and full storage do not prevent loading',async()=>{
  for(const options of [{denyOpen:true},{denyPut:true}]){
    const data=fixture('fallback',1),loader=await setup([data],{cache:memoryCache(options)});
    assert.deepEqual(await loader.loadBytes('assets/fallback.bin'),data.expected);
  }
});

test('already aborted requests do not fetch, and no-store skips persistent caching',async()=>{
  const data=fixture('options',1),cache=memoryCache(),loader=await setup([data],{cache});
  const controller=new AbortController();controller.abort();
  await assert.rejects(loader.loadBytes('assets/options.bin',{signal:controller.signal}),{name:'AbortError'});
  assert.equal(loader.calls.length,0);
  await loader.loadBytes('assets/options.bin',{cache:'no-store'});
  assert.equal(cache.entries.size,0);
});

test('decoded WASM bytes use the shared hash cache without another network request',async()=>{
  const data=fixture('runtime',1);data.entry.direct=true;delete data.entry.parts;
  const cache=memoryCache(),first=await setup([data],{cache});
  assert.deepEqual(await first.loadBytes('assets/runtime.bin'),data.expected);
  assert(cache.entries.has(`https://test.invalid/.echo-cache/${data.entry.sha256}-${data.entry.bytes}`));
  const second=await setup([data],{cache});
  assert.deepEqual(await second.loadBytes('assets/runtime.bin'),data.expected);
  assert.equal(second.calls.length,0);
});

test('another demo can populate the shared runtime cache without a custom header',async()=>{
  const data=fixture('shared-runtime',1);data.entry.direct=true;delete data.entry.parts;
  const cache=memoryCache(),key=`https://test.invalid/.echo-cache/${data.entry.sha256}-${data.entry.bytes}`;
  await cache.store.put(key,new Response(data.expected));
  const loader=await setup([data],{cache});
  assert.deepEqual(await loader.loadBytes('assets/shared-runtime.bin'),data.expected);
  assert.equal(loader.calls.length,0);assert.equal(loader.assetLoadStats.cacheHits,1);
});

test('cache flush settles background writes while a quota failure remains non-fatal',async()=>{
  for(const denyPut of [false,true]){
    const data=fixture('flush',1),cache=memoryCache({denyPut});
    const put=cache.store.put;
    cache.store.put=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,25));return put(...args);};
    const loader=await setup([data],{cache});
    assert.deepEqual(await loader.loadBytes('assets/flush.bin'),data.expected);
    await loader.flushAssetCache();
    assert.equal(loader.assetLoadStats.cacheWrites,denyPut?0:1);
    assert.equal(loader.assetLoadStats.cacheWriteFailures,denyPut?1:0);
  }
});

test('an idle connection is aborted and retried without losing verified asset data',async()=>{
  const data=fixture('stalled',1),loader=await setup([data],{stallOnce:true});
  assert.deepEqual(await loader.loadBytes('assets/stalled.bin'),data.expected);
  assert.equal(loader.calls.length,2);
});
