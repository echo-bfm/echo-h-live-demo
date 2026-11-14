import * as ort from './vendor/ort.wasm.bundle.min.mjs';
import {fetchJSON,verifiedBytes,widths} from './runtime.js?v=20261113-online';
import {loadBytes} from './asset-loader.js?v=20261113-online';

let runtimePreparation;

export class CpuPolicy {
  static prepareRuntime(){
    // ORT normally downloads WASM only when the first complete model arrives.
    // Fetch it alongside the weights and reuse verified bytes on later visits.
    return runtimePreparation??=(loadBytes('./vendor/ort-wasm-simd-threaded.wasm').then(bytes=>{ort.env.wasm.wasmBinary=bytes;return bytes;}));
  }
  static async prepare(config,{baseline=false}={}) {
    if(baseline)return {models:[['baseline',await verifiedBytes('./assets/policy.onnx',config.onnxSha256)]]};
    const manifest=await fetchJSON('./assets/optimized/manifest.json');
    if(manifest.checkpointSha256!==config.checkpointSha256||manifest.oracleSha256!==config.onnxSha256)throw new Error('Optimized model and checkpoint differ');
    const [referenceBytes,cached,models]=await Promise.all([
      verifiedBytes('./assets/reference.f32',manifest.referenceSha256),
      verifiedBytes('./assets/optimized/reference-cache.f32',manifest.referenceCacheSha256),
      Promise.all(Object.entries(manifest.models).map(async ([name,contract])=>[name,await verifiedBytes(`./assets/optimized/${contract.file}`,contract.sha256)]))
    ]);
    if(referenceBytes.length!==config.frames*38*4)throw new Error('Reference length mismatch');
    return {manifest,cached,models};
  }
  static async create(config,{threads=0,baseline=false,cpuBudget=navigator.hardwareConcurrency||1,status=()=>{},prepared=null}={}) {
    // No WebGPU import, adapter request or GPU execution provider.
    const cpus=Math.max(1,Math.min(navigator.hardwareConcurrency||1,cpuBudget));
    // One control Worker, one projection Worker when available, and N-1 ORT
    // helpers: total compute workers must not exceed advertised CPU capacity.
    const requested=Math.min(threads||(cpus>=4?2:1),Math.max(1,cpus-1));
    ort.env.wasm.numThreads=globalThis.crossOriginIsolated&&typeof SharedArrayBuffer!=='undefined'?requested:1;
    ort.env.wasm.proxy=false;
    ort.env.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
    await CpuPolicy.prepareRuntime();
    const self=new CpuPolicy();self.baseline=baseline;self.sessions={};
    const options={executionProviders:['wasm'],graphOptimizationLevel:'all',executionMode:'sequential'};
    const data=prepared??await CpuPolicy.prepare(config,{baseline});
    if(!baseline){
      self.manifest=data.manifest;
      self.reference=new Float32Array(data.cached.buffer,data.cached.byteOffset,data.cached.byteLength/4);
    }
    // Keep session construction sequential: ORT shares one WASM runtime.
    for(let i=0;i<data.models.length;i++){
      const [name,bytes]=data.models[i];status(`Preparing controller · ${i+1}/${data.models.length}`);
      self.sessions[name]=await ort.InferenceSession.create(bytes,options);
      data.models[i]=null;
    }
    self.backend=`WASM CPU · ${ort.env.wasm.numThreads} thread${ort.env.wasm.numThreads>1?'s':''} · ${baseline?'baseline':'cached FP32'}`;
    self.reset();return self;
  }
  reset(){this.chunks=new WeakMap();this.lastLong=null;this.memory=null;this.lastReference=null;this.dynamicReference=null;this.stats={chunkEncodes:0,memoryEncodes:0,trackerRuns:0,policyRuns:0,referenceRuns:0};}
  async run(name,values) {
    const shapes=name==='baseline'?Object.fromEntries(Object.entries(widths).map(([k,n])=>[k,[1,n]])):this.manifest.models[name].inputs;
    const feeds=Object.fromEntries(Object.entries(shapes).map(([k,shape])=>[k,new ort.Tensor('float32',values[k],shape)]));
    const result=await this.sessions[name].run(feeds),out={};
    for(const [k,tensor] of Object.entries(result)){out[k]=Float32Array.from(tensor.data);tensor.dispose();}
    Object.values(feeds).forEach(t=>t.dispose());return out;
  }
  async refreshMemory(long,valid,needSummary) {
    const width=this.manifest.width;
    for(const chunk of long)if(!this.chunks.has(chunk)){
      const result=await this.run('chunk',{interaction:chunk});this.chunks.set(chunk,result.chunk_feature);this.stats.chunkEncodes++;
    }
    const changed=this.lastLong===null||long.length!==this.lastLong.length||long.some((chunk,i)=>chunk!==this.lastLong[i]);
    if(needSummary&&(changed||!this.memory)){
      const features=new Float32Array(30*width);
      long.forEach((chunk,i)=>features.set(this.chunks.get(chunk),(30-long.length+i)*width));
      this.memory=(await this.run('memory',{chunk_features:features,long_valid:valid})).memory_feature;
      this.stats.memoryEncodes++;this.lastLong=[...long];
    }
  }
  async infer(inputs,step,{long=null,warmup=false,dynamic=false}={}) {
    const start=performance.now();
    if(this.baseline)return {output:await this.run('baseline',inputs),inferenceMs:performance.now()-start};
    if(long===null){
      // Arbitrary native fixture: rebuild once; live rollouts preserve chunk identities.
      this.reset();long=[];
      for(let i=0;i<30;i++)if(inputs.long_valid[i]>.5)long.push(inputs.long_interactions.slice(i*2730,(i+1)*2730));
    }
    await this.refreshMemory(long,inputs.long_valid,!warmup);const afterCache=performance.now();
    const rw=this.manifest.referenceWidth;
    let referenceCache=this.reference.subarray(step*rw,(step+1)*rw);
    if(dynamic){
      const current=inputs.reference_encoder_input;
      if(!this.lastReference||current.some((v,i)=>v!==this.lastReference[i])){
        this.dynamicReference=(await this.run('reference',{reference_input:current})).reference_cache;
        this.lastReference=current.slice();this.stats.referenceRuns++;
      }
      referenceCache=this.dynamicReference;
    }
    if(referenceCache.length!==rw)throw new Error('Invalid reference cache frame');
    const afterReference=performance.now();
    const tracker=await this.run('tracker',{...inputs,reference_cache:referenceCache});
    this.stats.trackerRuns++;const afterTracker=performance.now();
    let output=tracker;
    if(!warmup){output=await this.run('policy',{...inputs,features:tracker.features,base_action:tracker.tracker_action,memory_feature:this.memory});this.stats.policyRuns++;}
    return {output,inferenceMs:performance.now()-start,phases:{cacheMs:afterCache-start,referenceMs:afterReference-afterCache,trackerMs:afterTracker-afterReference,policyMs:performance.now()-afterTracker}};
  }
}

// A separate, frozen readout for the map. Its latent never enters the actor.
export class CpuObserver extends CpuPolicy {
  static async prepare(config) {
    const manifest=JSON.parse(new TextDecoder().decode(await verifiedBytes('./assets/observer/manifest.json',config.mapObserverManifestSha256)));
    if(manifest.encoderSha256!==config.mapEncoderSha256)throw new Error('Map observer encoder mismatch');
    const models=await Promise.all(Object.entries(manifest.models).map(async ([name,contract])=>[name,await verifiedBytes(`./assets/observer/${contract.file}`,contract.sha256)]));
    return {manifest,models};
  }
  static async create(config,{status=()=>{},prepared=null}={}) {
    const self=new CpuObserver();self.sessions={};
    const data=prepared??await CpuObserver.prepare(config);self.manifest=data.manifest;
    const options={executionProviders:['wasm'],graphOptimizationLevel:'all',executionMode:'sequential'};
    for(let i=0;i<data.models.length;i++){
      const [name,bytes]=data.models[i];status(`Preparing live atlas · ${i+1}/${data.models.length}`);
      self.sessions[name]=await ort.InferenceSession.create(bytes,options);
      data.models[i]=null;
    }
    self.reset();return self;
  }
  async read(inputs,long,{warmup=false}={}) {
    await this.refreshMemory(long,inputs.long_valid,!warmup);
    if(warmup)return null;
    return (await this.run('readout',{...inputs,memory_feature:this.memory})).context_latent;
  }
  async verify(){
    const rows=[];
    try{for(const fixture of this.manifest.fixtures){
      this.reset();const bytes=await verifiedBytes(`./assets/observer/${fixture.file}`,fixture.sha256);
      const values=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4),inputs={};let offset=0;
      for(const [key,size] of Object.entries({short_interactions:13650,short_valid:50,long_interactions:81900,long_valid:30})){
        inputs[key]=values.slice(offset,offset+size);offset+=size;
      }
      if(offset!==values.length)throw new Error('Observer fixture size mismatch');
      const long=[];for(let i=0;i<30;i++)if(inputs.long_valid[i]>.5)long.push(inputs.long_interactions.slice(i*2730,(i+1)*2730));
      const result=await this.read(inputs,long),maxError=Math.max(...result.map((v,i)=>Math.abs(v-fixture.expected[i])));
      rows.push({short:fixture.short,long:fixture.long,maxError});
    }return {encoderSha256:this.manifest.encoderSha256,rows,passed:rows.every(r=>r.maxError<2e-5)};
    }finally{this.reset();}
  }
}
