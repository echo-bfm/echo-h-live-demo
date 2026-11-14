import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../site/startup.js',import.meta.url),'utf8');
const app=await fs.readFile(new URL('../site/app.js',import.meta.url),'utf8');
function boot({constructorError=false,viewFailure=false,search='?threads=2'}={}){
  const calls=[],elements=new Map(),instances=[];
  let finishView,diagnosticImports=0;
  for(const id of ['loading','loading-title','loading-detail','loading-progress','runtime-error'])elements.set(id,{textContent:'',hidden:false,dataset:{}});
  class Worker{
    constructor(url,options){
      if(constructorError)throw new Error('Worker unavailable');
      this.url=url;this.options=options;this.posts=[];instances.push(this);calls.push('worker');
    }
    postMessage(message){this.posts.push(message);calls.push(message.type);}
    terminate(){this.terminated=true;}
  }
  const context=vm.createContext({window:{},Worker,performance:{now:()=>5},document:{getElementById:id=>elements.get(id)},navigator:{hardwareConcurrency:8},location:{search},URL,URLSearchParams,importDiagnostics(){diagnosticImports++;return Promise.resolve();},importView(){calls.push('view');return viewFailure?Promise.reject(new Error('View download failed')):new Promise(resolve=>{finishView=resolve;});}});
  const script=source.replaceAll('import.meta.url',JSON.stringify('https://test.invalid/demo/startup.js'))
    .replace(/import\('\.\/app\.js[^']*'\)/,'importView()')
    .replace(/import\('\.\/startup-diagnostics\.js[^']*'\)/,'importDiagnostics()');
  vm.runInContext(script,context);
  return {context,calls,elements,instances,get startup(){return context.window.echoStartup;},get diagnosticImports(){return diagnosticImports;},finishView:()=>finishView?.()};
}

test('starts the worker and sends init before the view dependency graph completes',()=>{
  const result=boot();
  assert.deepEqual(result.calls,['worker','init','view']);
  assert.equal(result.instances.length,1);
  const worker=result.instances[0];
  assert.equal(worker.posts.length,1);assert.equal(worker.posts[0].threads,2);
  assert.equal(worker.posts[0].cpuBudget,8);
  assert.equal(worker.url.searchParams.has('startup-test'),false);
  assert.equal(result.diagnosticImports,0);
});

test('cold startup diagnostics are forwarded to the worker while preserving its revision',()=>{
  const result=boot({search:'?threads=2&startup-test=cold'}),worker=result.instances[0];
  assert.equal(worker.url.origin,'https://test.invalid');
  assert.equal(worker.url.pathname,'/demo/worker.js');
  assert.equal(worker.url.searchParams.get('startup-test'),'cold');
  assert(worker.url.searchParams.get('v'));
  assert.equal(result.diagnosticImports,1);
  assert.equal(worker.posts.length,1);assert.equal(worker.posts[0].threads,2);
});

test('hands off status, errors and transferred scene buffers exactly once and in order',()=>{
  const result=boot(),worker=result.startup.worker,buffer=new ArrayBuffer(16),seen=[];
  const early=[{data:{type:'load-plan'}},{data:{type:'load-progress'}},{data:{type:'ready',buffer}}];
  worker.onmessage(early[0]);worker.onerror({message:'early error'});worker.onmessage(early[1]);worker.onmessage(early[2]);
  result.startup.attach(event=>seen.push(event),event=>seen.push(event));
  assert.equal(seen.length,4);
  assert.equal(seen[0],early[0]);assert.equal(seen[1].message,'early error');assert.equal(seen[2],early[1]);assert.equal(seen[3].data.buffer,buffer);
  const live={data:{type:'frame'}};worker.onmessage(live);assert.equal(seen.at(-1),live);
  result.startup.attach(()=>assert.fail('duplicate handoff'),()=>{});
  worker.onmessage(live);assert.equal(seen.length,6);assert.equal(worker.posts.length,1);
});

test('app handoff reuses the early worker without posting a second init',()=>{
  const result=boot(),worker=result.startup.worker,events=[];
  worker.onmessage({data:{type:'ready'}});
  result.context.startup=result.startup;result.context.worker=worker;
  worker.onmessage=event=>events.push(event);worker.onerror=()=>{};
  vm.runInContext(app.slice(app.indexOf('if(startup)startup.attach')),result.context);
  assert.equal(worker.posts.length,1);assert.equal(events[0].data.type,'ready');
});

test('direct app loading still initializes its worker when there is no bootstrap',()=>{
  const result=boot(),worker=result.startup.worker;
  worker.posts=[];result.context.startup=undefined;result.context.worker=worker;
  vm.runInContext(app.slice(app.indexOf('if(startup)startup.attach')),result.context);
  assert.equal(worker.posts.length,1);assert.equal(worker.posts[0].type,'init');
});

test('view import failure stops the worker and replaces Preparing with an actionable error',async()=>{
  const result=boot({viewFailure:true});await Promise.resolve();await Promise.resolve();
  assert.equal(result.instances[0].terminated,true);
  assert.equal(result.elements.get('loading-title').textContent,'Unable to load the demo');
  assert.equal(result.elements.get('loading').dataset.error,'View download failed');
  assert.equal(result.elements.get('runtime-error').hidden,false);
});

test('worker construction failure is displayed without trying to initialize the view',()=>{
  const result=boot({constructorError:true});
  assert.deepEqual(result.calls,[]);
  assert.equal(result.elements.get('loading').dataset.error,'Worker unavailable');
});
