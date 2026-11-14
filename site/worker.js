import {CpuPolicy,CpuObserver} from './cpu-policy.js?v=20261113-online';
import {EchoRuntime,fetchJSON,fetchArray,widths} from './runtime.js?v=20261113-online';
import {assets} from './asset-map.js?v=20261113-online';
import {assetLoadStats,flushAssetCache} from './asset-loader.js?v=20261113-online';
let runtime,policy,backend='loading',running=false,busy=false,pendingPhysics=null,timer=null;
let pendingMotion=null,resetting=false;
let observer=null;
const times=[],events=[];
const send=(type,data,transfer=[])=>postMessage({type,...data},transfer);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function resetModels(){policy.reset();observer?.reset();}
const maxError=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
async function initialize({baseline=false,threads=0,cpuBudget=navigator.hardwareConcurrency||1}={}) {
  const started=performance.now(),config=await fetchJSON('./assets/config.json');
  const sceneAssets=['assets/scene.mjb','assets/kinematics.mjb','assets/reference.f32','assets/reference-qpos.f64','vendor/mujoco.wasm','vendor/ort-wasm-simd-threaded.wasm'];
  const startupAssets=Object.entries(assets).filter(([key])=>sceneAssets.includes(key)||(baseline?key==='assets/policy.onnx':key.startsWith('assets/optimized/'))||(config.mapEncoderSha256&&key.startsWith('assets/observer/')&&key.endsWith('.onnx')));
  send('load-plan',{assets:startupAssets.map(([asset,{bytes}])=>({asset,total:bytes}))});
  send('status',{text:'Loading simulation and model data…'});
  // Fetch model weights alongside scene/WASM loading; compile only after verification.
  const [simulation,policyData,observerData]=await Promise.all([
    EchoRuntime.create(config),CpuPolicy.prepare(config,{baseline}),config.mapEncoderSha256?CpuObserver.prepare(config):null,CpuPolicy.prepareRuntime()
  ]);
  runtime=simulation;
  const downloaded=performance.now(),status=text=>send('status',{text});
  policy=await CpuPolicy.create(config,{baseline,threads,cpuBudget,status,prepared:policyData});backend=policy.backend;
  if(observerData)observer=await CpuObserver.create(config,{status,prepared:observerData});
  status('Warming up the controller…');await infer();resetModels();
  await flushAssetCache();
  send('startup-timing',{dataAndPhysicsMs:downloaded-started,runtime:runtime.startupPhases,assets:{...assetLoadStats},totalMs:performance.now()-started});
  // renderModel owns these copies; never transfer the simulation's WASM memory.
  const model=runtime.renderModel(),transfer=model.geoms.flatMap(g=>[g.vertices.buffer,g.faces.buffer]);
  send('ready',{backend,config:runtime.config,environments:runtime.hdr.profiles.map(({id,bankRow,mu,masses})=>({id,bankRow,mu,masses})),motions:runtime.motion.manifest.motions,model,snapshot:runtime.snapshot(),gpu:null},transfer);
}
async function infer(inputs=runtime.inputs,step=runtime.step,fixture=false) {
  return policy.infer(inputs,step,{long:fixture?null:runtime.long,warmup:!fixture&&step<350,dynamic:!fixture&&!runtime.legacy});
}
function applyMotion(){if(!pendingMotion?.poses)return;const request=pendingMotion;pendingMotion=null;
  try{const result=runtime.selectMotion(request.motion,request.poses);send('frame',{snapshot:runtime.snapshot()});request.resolve(result);}catch(e){request.reject(e);}}
function cancelMotion(message){if(!pendingMotion)return;const request=pendingMotion;pendingMotion=null;request.controller.abort();request.reject(Object.assign(new Error(message),{code:'MOTION_CANCELED'}));}
function requestMotion(motion){
  return new Promise((resolve,reject)=>{
    const request={motion,resolve,reject,controller:new AbortController()};pendingMotion=request;
    runtime.loadMotion(motion,{signal:request.controller.signal}).then(poses=>{
      if(pendingMotion!==request)return;request.poses=poses;if(!busy)applyMotion();
    }).catch(error=>{if(pendingMotion===request){pendingMotion=null;reject(error);}});
  });
}
function applyPending() {if(pendingPhysics){const edit=pendingPhysics;pendingPhysics=null;
  const event=runtime.applyPhysics(edit.mu??runtime.mu,edit.leftMass??edit.mass??runtime.leftMass,edit.rightMass??edit.mass??runtime.rightMass,edit.leftShinMass??runtime.leftShinMass,edit.rightShinMass??runtime.rightShinMass);event.requestId=edit.requestId??null;event.waitMs=performance.now()-edit.requestTime;events.push(event);if(events.length>2000)events.shift();send('physics',{event});}}
async function tick(publish=true) {
  const start=performance.now(),{output,inferenceMs,phases}=await infer();
  const mapStart=performance.now();
  if(observer&&(runtime.step+1)%5===0){
    runtime.mapLatent=await observer.read(runtime.inputs,runtime.long,{warmup:runtime.step<350});
    runtime.mapLatentStep=runtime.step;
  }
  const observerMs=performance.now()-mapStart;
  // A UI edit received during async inference is applied before the next physics interval.
  applyPending();runtime.advance(runtime.step<350?output.tracker_action:output.action,runtime.step<350?null:output.context_latent);
  const frame=runtime.snapshot(),elapsed=performance.now()-start;
  times.push({step:runtime.step,inferenceMs,observerMs,totalMs:elapsed,...phases});if(times.length>2000)times.shift();
  if(publish)send('frame',{snapshot:frame,inferenceMs:inferenceMs+observerMs,totalMs:elapsed});
  // Tracking thresholds remain diagnostic; they never pause the interactive loop.
  return {frame,elapsed};
}
async function loop() {
  if(!running||busy)return;busy=true;
  try {const {elapsed}=await tick();applyMotion();
    busy=false;if(running)timer=setTimeout(loop,Math.max(0,20-elapsed));
  }catch(e){busy=false;running=false;cancelMotion(String(e));send('error',{message:String(e),stack:e.stack});}
}
async function verifyFixtures() {
  if(running||busy||pendingMotion||resetting)throw new Error('Pause before verification');busy=true;runtime.reset({legacy:true});
  try {
    const fixtures=await fetchJSON('./assets/fixtures.json'),rows=[];
    for(const fixture of fixtures){
      const expected=Object.fromEntries(await Promise.all(Object.keys(widths).map(async k=>[k,await fetchArray(`./assets/fixtures/${fixture.step}/${k}.f32`)])));
      const r=runtime,{mj,model:m,data:d}=r;
      r.applyPhysics(fixture.mu,fixture.mass);mj.mj_resetData(m,d);
      d.qpos.set(fixture.qpos);d.qvel.set(fixture.qvel);d.ctrl.set(fixture.ctrl);d.time=fixture.step*.02;mj.mj_forward(m,d);d.qacc_warmstart.set(fixture.qaccWarmstart);
      r.step=fixture.step;r.prev.set(fixture.previousCommand);r.history.set(expected.estimator_history);r.observe(false,false);
      const obsErrors=Object.fromEntries(['robot_root_quat','estimator_history','reference_encoder_input','robot_key_body'].map(k=>[k,maxError(r.inputs[k],expected[k])]));
      obsErrors.proprio=maxError(r.proprio,fixture.proprio);
      const {output,inferenceMs}=await infer(expected,fixture.step,true);
      const policyErrors=Object.fromEntries(Object.keys(fixture.outputs).map(k=>[k,maxError(output[k],fixture.outputs[k])]));
      const dynamic=await policy.infer(expected,fixture.step,{dynamic:true});
      const dynamicErrors=Object.fromEntries(Object.keys(fixture.outputs).map(k=>[k,maxError(dynamic.output[k],fixture.outputs[k])]));
      const command=Float32Array.from(fixture.outputs[fixture.step<350?'tracker_action':'action']);
      r.advance(command,null);
      rows.push({step:fixture.step,obsErrors,policyErrors,dynamicErrors,inferenceMs,physics:{qpos:maxError(d.qpos,fixture.nextQpos),qvel:maxError(d.qvel,fixture.nextQvel),ctrl:maxError(d.ctrl,fixture.nextCtrl)}});
    }
    return {backend,rows,passed:rows.every(r=>Object.values(r.obsErrors).every(x=>x<2e-4)&&[...Object.values(r.policyErrors),...Object.values(r.dynamicErrors)].every(x=>x<2e-3)&&r.physics.qpos<1e-7&&r.physics.qvel<1e-5&&r.physics.ctrl<1e-5)};
  }finally{runtime.reset();resetModels();busy=false;send('frame',{snapshot:runtime.snapshot()});}
}
async function rollout(steps=1300,motion=null) {
  if(running||busy||pendingMotion||resetting)throw new Error('Pause before verification');busy=true;runtime.reset({legacy:!motion});resetModels();times.length=0;events.length=0;
  const samples=[],trace=[];let failed=null;
  try {
    let poses,entry;
    if(motion){poses=await runtime.loadMotion(motion);entry=runtime.motion.manifest.motions.find(m=>m.id===motion);
      steps=400+2*runtime.motion.manifest.transitionSteps+entry.frames-1+42+500;}
    for(let i=0;i<steps;i++){
    if(motion&&resetting)throw new Error('Verification canceled by Reset');
    if(motion&&i===400)runtime.selectMotion(motion,poses);
    const loadStep=motion?1100:500,restoreStep=motion?1500:900;
    if(i===loadStep||i===restoreStep){pendingPhysics={...(!motion?{mu:i===loadStep?.3:1.2}:{}),mass:i===loadStep?1.5:0,requestTime:performance.now()};}
    const {frame}=await tick(i%10===0);
    if(frame.failed&&failed===null)failed=i;
    if(i%50===0||[349,350,499,500,501,899,900,901,steps-1].includes(i))samples.push({step:frame.step,time:frame.time,motion:frame.motion,mu:frame.mu,mass:frame.mass,mpjpe:frame.mpjpe,long:frame.long,contacts:frame.contacts,latent:Array.from(frame.latent)});
    if(!motion)trace.push({step:frame.step,qpos:Array.from(frame.qpos),latent:Array.from(frame.latent),mpjpe:frame.mpjpe});
    if(motion&&frame.failed)break;
    if(i%10===0)await delay(0);
  }
  const sorted=times.filter(t=>t.step>350).map(t=>t.totalMs).sort((a,b)=>a-b),inferSorted=times.filter(t=>t.step>350).map(t=>t.inferenceMs).sort((a,b)=>a-b);
  return {backend,steps:runtime.step,expectedSteps:steps,finalMotion:runtime.snapshot().motion,failed,samples,events:[...events],trace,timings:[...times],cache:{...policy.stats},performance:{totalP50:sorted[Math.floor(sorted.length*.5)],totalP95:sorted[Math.floor(sorted.length*.95)],inferenceP50:inferSorted[Math.floor(inferSorted.length*.5)],inferenceP95:inferSorted[Math.floor(inferSorted.length*.95)]}};
  }finally{busy=false;runtime.reset();resetModels();send('frame',{snapshot:runtime.snapshot()});}
}
onmessage=async ({data:m})=>{
  try{
    let result;
    if(m.type==='init')await initialize(m);
    else if(m.type==='play'){if(!runtime||resetting||runtime.legacy)throw new Error('Runtime busy');running=true;if(!busy){clearTimeout(timer);loop();}}
    else if(m.type==='pause'){running=false;clearTimeout(timer);}
    else if(m.type==='physics'){if(m.mu!==undefined&&!runtime.legacy&&m.mu!==runtime.mu)throw new Error('Friction is fixed by the selected HDR profile');pendingPhysics={...pendingPhysics,...m,requestTime:performance.now()};if(!busy){applyPending();send('frame',{snapshot:runtime.snapshot()});}}
    else if(m.type==='environment'){
      if(!runtime.hdr.profiles.some(e=>e.id===m.environment))throw new Error('Unknown HDR profile');
      resetting=true;running=false;clearTimeout(timer);cancelMotion('Environment reset');while(busy)await delay(5);pendingPhysics=null;
      runtime.environment=runtime.hdr.profiles.find(e=>e.id===m.environment);runtime.reset();resetModels();times.length=0;events.length=0;send('frame',{snapshot:runtime.snapshot()});resetting=false;
    }
    else if(m.type==='hdr-audit'){
      if(running||busy||pendingMotion||resetting)throw new Error('Pause before audit');
      const previous=runtime.environment.id,rows=[];
      try{for(const env of runtime.hdr.profiles){runtime.applyEnvironment(env.id);const errors=Object.fromEntries(Object.entries(env.fields).map(([k,v])=>[k,v.reduce((e,x,i)=>Math.max(e,Math.abs(x-runtime.model[k][i])),0)]));
        const contacts=[],c=runtime.data.contact;for(let i=0;i<c.size();i++){const t=c.get(i);contacts.push({geom1:t.geom1,geom2:t.geom2,friction:Array.from(t.friction)});t.delete();}c.delete();
        rows.push({id:env.id,bankRow:env.bankRow,errors,priority:Array.from(runtime.model.geom_priority),contacts});}
        result={bankSha256:runtime.hdr.bankSha256,rows};
      }finally{runtime.environment=runtime.hdr.profiles.find(e=>e.id===previous);runtime.reset();resetModels();send('frame',{snapshot:runtime.snapshot()});}
    }
    else if(m.type==='hdr-dynamics'){
      if(running||busy||pendingMotion||resetting)throw new Error('Pause before audit');
      const previous=runtime.environment.id,rows=[],{mj,model,data,config}=runtime;
      try{for(const env of runtime.hdr.profiles){
        runtime.environment=env;runtime.reset();data.qpos[2]-=.03;
        for(let i=0;i<model.nv;i++)data.qvel[i]=Math.sin(i)*.02;
        const command=config.actuatorIds.map((_,i)=>Math.fround(Math.fround(config.offset[i])+Math.fround(Math.fround(config.scale[i])*Math.fround(Math.sin(i)*.1))));
        config.actuatorIds.forEach((id,i)=>data.ctrl[id]=command[i]);mj.mj_forward(model,data);
        const before={qpos:Array.from(data.qpos),qvel:Array.from(data.qvel),ctrl:Array.from(data.ctrl),qaccWarmstart:Array.from(data.qacc_warmstart)};
        for(let j=0;j<4;j++)mj.mj_step(model,data);mj.mj_forward(model,data);
        const contact=data.contact,contacts=[];for(let j=0;j<contact.size();j++){const c=contact.get(j);contacts.push({geom1:c.geom1,geom2:c.geom2,friction:Array.from(c.friction)});c.delete();}contact.delete();
        rows.push({id:env.id,before,qpos:Array.from(data.qpos),qvel:Array.from(data.qvel),contacts});
      }result=rows;}finally{runtime.environment=runtime.hdr.profiles.find(e=>e.id===previous);runtime.reset();resetModels();send('frame',{snapshot:runtime.snapshot()});}
    }
    else if(m.type==='motion'){
      if(!runtime||resetting||runtime.legacy||runtime.motion.locked||pendingMotion)throw new Error('The current motion is still active. Wait for T-pose idle or use Reset.');
      result=await requestMotion(m.motion);
    }
    else if(m.type==='reset'){resetting=true;running=false;clearTimeout(timer);cancelMotion('Reset');while(busy)await delay(5);pendingPhysics=null;runtime.reset();resetModels();times.length=0;events.length=0;send('frame',{snapshot:runtime.snapshot()});resetting=false;}
    else if(m.type==='verify')result=await verifyFixtures();
    else if(m.type==='verify-observer'){
      if(running||busy||pendingMotion||resetting)throw new Error('Pause before verification');
      if(!observer)throw new Error('No map observer configured');busy=true;
      try{result=await observer.verify();}finally{busy=false;}
    }
    else if(m.type==='rollout')result=await rollout(m.steps,m.motion);
    else if(m.type==='sample-atlas')throw new Error('Legacy payload-only sampling is retired; the active atlas uses verified paper HDR windows.');
    else if(m.type==='stats')result={backend,times,events};
    if(m.id)send('reply',{id:m.id,result});
  }catch(e){if(m.id)send('reply',{id:m.id,error:String(e),code:e.code});else send('error',{message:String(e),stack:e.stack});}
};
