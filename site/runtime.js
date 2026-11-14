import {loadBytes} from './asset-loader.js?v=20261113-online';
// Audited native observation/action contract, ported without policy approximations.
import loadMujoco from './vendor/mujoco.js';
import {MotionPlayer,referenceFrame} from './motion.js';
import {HdrNoise} from './hdr-noise.js';
export const NOMINAL_FRICTION = .6;
export const widths = {robot_root_quat:4, estimator_history:6100, reference_encoder_input:1900, robot_key_body:195,
  short_interactions:13650, short_valid:50, long_interactions:81900, long_valid:30, previous_latents:256};
const f = Math.fround;
const cross = (a,b) => [f(f(a[1]*b[2])-f(a[2]*b[1])),f(f(a[2]*b[0])-f(a[0]*b[2])),f(f(a[0]*b[1])-f(a[1]*b[0]))];
function normalized(q) { const n=f(Math.sqrt(q.reduce((s,x)=>f(s+f(x*x)),0))); return q.map(x=>f(x/n)); }
function rotate(q,v,inverse=false) {
  const xyz=q.slice(1), c=cross(xyz,v), dot=xyz.reduce((s,x,i)=>f(s+f(x*v[i])),0), a=f(f(2*f(q[0]*q[0]))-1);
  return v.map((x,i)=>f(f(f(x*a)+(inverse?-1:1)*f(f(c[i]*q[0])*2))+f(f(xyz[i]*dot)*2)));
}
function rot6(q) {const [w,x,y,z]=normalized(q), s=f(2/q.reduce((a,v)=>f(a+f(v*v)),0));
  return [f(1-f(s*f(f(y*y)+f(z*z)))),f(s*f(f(x*y)+f(z*w))),f(s*f(f(x*z)-f(y*w))),
    f(s*f(f(x*y)-f(z*w))),f(1-f(s*f(f(x*x)+f(z*z)))),f(s*f(f(y*z)+f(x*w)))];}
export async function fetchJSON(url) {const r=await fetch(url);if(!r.ok)throw new Error(`${url}: HTTP ${r.status}`);return r.json();}
export async function fetchArray(url, type=Float32Array,options={}) {const bytes=await loadBytes(url,options);return new type(bytes.buffer,bytes.byteOffset,bytes.byteLength/type.BYTES_PER_ELEMENT);}
export async function verifiedBytes(url,expected,options={}) {
  const bytes=await fetchArray(url,Uint8Array,options);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  if(hash!==expected)throw new Error(`Asset SHA-256 mismatch: ${url}`);return bytes;
}

export class EchoRuntime {
  static async create(configPromise=fetchJSON('./assets/config.json')) {
    const started=performance.now(),startupPhases={};
    // Download independent scene data while WASM initializes in this worker.
    const [mj,config,reference,refQpos,sceneBytes,kinBytes,manifest] = await Promise.all([
      loadBytes('./vendor/mujoco.wasm').then(wasmBinary=>loadMujoco({wasmBinary})).then(mj=>{startupPhases.wasmMs=performance.now()-started;return mj;}),configPromise,fetchArray('./assets/reference.f32'),fetchArray('./assets/reference-qpos.f64',Float64Array),
      fetchArray('./assets/scene.mjb',Uint8Array),fetchArray('./assets/kinematics.mjb',Uint8Array),fetchJSON('./assets/motions/manifest.json')
    ]);
    startupPhases.assetsMs=performance.now()-started;
    const vfs=new mj.MjVFS();
    let model,kin;const files=[];
    try{
      // MjVFS.addBuffer boxes every byte through Embind. MEMFS writes the exact
      // verified arrays in bulk; an empty VFS lets MuJoCo read these local files.
      for(const [path,bytes] of [['/tmp/echo-scene.mjb',sceneBytes],['/tmp/echo-kinematics.mjb',kinBytes]]){
        mj.FS.writeFile(path,bytes);files.push(path);
      }
      startupPhases.vfsMs=performance.now()-started-startupPhases.assetsMs;
      model=mj.MjModel.from_binary_path(files[0],vfs);kin=mj.MjModel.from_binary_path(files[1],vfs);
    }finally{for(const path of files)mj.FS.unlink(path);vfs.delete();}
    startupPhases.modelsMs=performance.now()-started-startupPhases.assetsMs;
    const clips=new Map();
    if(manifest.schema!==2||manifest.motions.length!==40||manifest.motions.some(m=>!m.fullSequence)||manifest.checkpointSha256!==config.checkpointSha256||manifest.nq!==model.nq||manifest.dt!==config.dt)throw new Error('Motion contract mismatch');
    const hdr=JSON.parse(new TextDecoder().decode(await verifiedBytes('./assets/hdr.json',config.hdrSha256)));
    if(config.environmentMode==='nominal-payload-only'){
      const numericValues=value=>typeof value==='number'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(numericValues):[];
      const expected={delay:0,alpha:1,jointOffset:0,bootDelay:0,encoderBias:0,pushes:false};
      if(hdr.environmentMode!==config.environmentMode||hdr.noise.enabled!==false||hdr.noise.reference.enable!==false||numericValues(hdr.noise).some(v=>v!==0)||Object.entries(expected).some(([k,v])=>hdr.nuisance[k]!==v))throw new Error('Nominal environment includes noise or delays');
    }
    if(hdr.kind==='hand9'){
      if(hdr.bankSha256!==config.physicsBankSha256||hdr.profiles.length!==9||hdr.profiles.some((p,i)=>p.bankRow!==i*9||hdr.selectedRows[i]!==i*9||p.masses.some((m,j)=>m!==[Math.floor(i/3),i%3,0,0][j])||p.offsets.flat().some(v=>v!==0)))throw new Error('Hand payload grid mismatch');
    }else if(hdr.kind==='payload81'){
      if(hdr.bankSha256!==config.physicsBankSha256||hdr.profiles.length!==81||hdr.profiles.some((p,i)=>p.bankRow!==i||p.masses.some((m,j)=>m!==[Math.floor(i/27),Math.floor(i/9)%3,2*(Math.floor(i/3)%3),2*(i%3)][j])||p.offsets.flat().some(v=>v!==0)))throw new Error('Payload grid mismatch');
    }else if(hdr.bankSha256!=='24e53bbc5e45074f668119a745dfcaef2cbbe3edaf1fa10b30632a0f0fc1f6fa'||hdr.profiles.length!==16)throw new Error('Paper HDR bank mismatch');
    const runtime=new EchoRuntime(mj,config,reference,refQpos,model,kin,new MotionPlayer(manifest,clips),hdr);
    runtime.startupPhases={...startupPhases,totalMs:performance.now()-started};return runtime;
  }
  constructor(mj,config,reference,refQpos,model,kin,motion,hdr) {
    Object.assign(this,{mj,config,reference,refQpos,model,kin,motion,hdr});
    if(mj.mj_versionString()!==config.mujocoVersion || Math.abs(model.opt.timestep-.005)>1e-12)throw new Error('MuJoCo version/timebase mismatch');
    this.data=new mj.MjData(model);this.kinData=new mj.MjData(kin);this.scratch=new mj.MjData(model);this.ghost=new mj.MjData(model);
    this.jp=new mj.DoubleBuffer(3*kin.nv);this.jr=new mj.DoubleBuffer(3*kin.nv);
    this.history=new Float32Array(6100);this.prev=new Float32Array(29);this.latents=new Float32Array(256);
    this.inputs=Object.fromEntries(Object.entries(widths).map(([k,n])=>[k,new Float32Array(n)]));
    this.legacyFields=Object.fromEntries(Object.keys(hdr.nominalFields).map(k=>[k,Array.from(model[k])]));this.legacyPriority=Array.from(model.geom_priority);
    this.environment=hdr.profiles[0];this.mu=NOMINAL_FRICTION;this.mass=0;this.reset();
  }
  reset({legacy=false}={}) {
    const {mj,model:m,data:d,config:c}=this;
    this.legacy=legacy;this.motion.reset();
    this.noise=legacy||this.hdr.noise.enabled===false?null:new HdrNoise(this.hdr.noise,crypto.getRandomValues(new Uint32Array(1))[0]);
    this.sensorCache=null;
    if(legacy){for(const [key,values] of Object.entries(this.legacyFields))m[key].set(values);m.geom_priority.set(this.legacyPriority);this.applyPhysics(1.2,0);}
    else this.applyEnvironment(this.environment.id);
    mj.mj_resetData(m,d);d.qpos.set(legacy?this.refQpos.subarray(0,m.nq):this.motion.pose());
    c.actuatorIds.forEach((id,i)=>{d.ctrl[id]=c.offset[i];});mj.mj_forward(m,d);
    this.step=0;this.short=[];this.pending=[];this.long=[];this.memoryRevision=0;this.packedLongRevision=-1;this.history.fill(0);this.prev.fill(0);this.latents.fill(0);this.proprio=null;
    this.mapLatent=null;this.mapLatentStep=-1;
    this.observe(true);this.updateMemoryInputs();
  }
  async loadMotion(id,options={}){
    const entry=this.motion.manifest.motions.find(m=>m.id===id);
    if(!entry)throw new Error('Unknown motion');
    if(this.motion.clips.has(id))return this.motion.clips.get(id);
    const bytes=await verifiedBytes(`./assets/motions/${entry.file}`,entry.sha256,options);
    if(bytes.byteLength!==entry.frames*this.model.nq*8)throw new Error('Motion length mismatch');
    return new Float64Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/8);
  }
  selectMotion(id,poses){
    if(this.legacy||this.motion.locked)throw new Error('Motion selection unavailable');
    // Keep at most one source sequence; a canceled load never enters this cache.
    this.motion.clips.clear();this.motion.clips.set(id,poses);
    this.motion.select(id);this.observe(false,false);return this.motion.status();
  }
  applyPhysics(mu,leftMass,rightMass=leftMass,leftShinMass=this.leftShinMass??0,rightShinMass=this.rightShinMass??0) {
    const handsOnly=!this.legacy&&this.hdr.kind==='hand9';
    if(handsOnly&&(leftShinMass!==0||rightShinMass!==0))throw new Error('Shin loads are fixed at zero');
    const allLimbs=!this.legacy&&['payload81','hand9'].includes(this.hdr.kind);
    const masses=allLimbs?[leftMass,rightMass,leftShinMass,rightShinMass]:[leftMass,rightMass];
    if(!Number.isFinite(mu)||mu<.3||mu>2||masses.some((mass,i)=>!Number.isFinite(mass)||mass<0||mass>(i<2?(allLimbs?2:2.5):4)||(mass!==this.environment.masses[i]&&Math.abs(mass*10-Math.round(mass*10))>1e-6)))throw new Error('Invalid physics parameters');
    if(!this.legacy&&mu!==this.environment.mu)throw new Error('Friction belongs to the selected paper HDR profile');
    const exactGrid=allLimbs?this.hdr.profiles.find(e=>masses.every((v,i)=>v===e.masses[i])):null;
    const {mj,model:m,data:d,config:c}=this;
    const before=[...d.qpos,...d.qvel,...d.ctrl,...d.qacc_warmstart,d.time];
    if(this.legacy)m.geom_friction[c.floor*3]=mu;
    for(const [hand,mass] of masses.entries()) {
      const exact=!!exactGrid||!this.legacy&&mass===this.environment.masses[hand],body=this.hdr.payloadBodies[hand],fields=(exactGrid??this.environment).fields;
      const row=exact?{body,body_mass:fields.body_mass[body],...Object.fromEntries(['body_ipos','body_inertia','body_iquat'].map(k=>{const n=k==='body_iquat'?4:3;return [k,fields[k].slice(body*n,(body+1)*n)];}))}:(allLimbs?this.hdr.limbPayload:this.legacy?c.payload:this.environment.payload)[Math.round(mass*10)][hand];
      m.body_mass[row.body]=row.body_mass;
      for(const key of ['body_ipos','body_inertia','body_iquat'])m[key].set(row[key],row.body*(key==='body_iquat'?4:3));
    }
    mj.mj_setConst(m,this.scratch);
    if(exactGrid)for(const [key,values] of Object.entries(exactGrid.fields))m[key].set(values);
    mj.mj_forward(m,d);
    const after=[...d.qpos,...d.qvel,...d.ctrl,...d.qacc_warmstart,d.time];
    if(before.some((v,i)=>v!==after[i]))throw new Error('Live edit changed integration state');
    this.mu=mu;this.leftMass=leftMass;this.rightMass=rightMass;this.mass=leftMass===rightMass?leftMass:null;
    if(allLimbs){this.leftShinMass=leftShinMass;this.rightShinMass=rightShinMass;}
    this.currentGridId=exactGrid?.id??null;
    this.hdrEdited=!this.legacy&&masses.some((v,i)=>v!==this.environment.masses[i]);
    return {step:this.step,time:d.time,mu,leftMass,rightMass,leftShinMass:this.leftShinMass,rightShinMass:this.rightShinMass,mass:this.mass,environment:this.environment.id,currentGridId:this.currentGridId,hdrEdited:this.hdrEdited,statePreserved:true,memorySteps:this.step,
      addedBodyMass:c.payload[0].map(row=>m.body_mass[row.body]-row.body_mass)};
  }
  applyEnvironment(id){
    const env=this.hdr.profiles.find(e=>e.id===id);if(!env)throw new Error('Unknown paper HDR environment');
    const {model:m,mj,data:d}=this;this.environment=env;
    for(const [k,v] of Object.entries(env.fields))m[k].set(v);m.geom_priority.set(this.hdr.geomPriority);
    // Populate CPU-specific constants, then retain all source bank fields verbatim.
    mj.mj_setConst(m,this.scratch);for(const [k,v] of Object.entries(env.fields))m[k].set(v);mj.mj_forward(m,d);
    this.mu=env.mu;[this.leftMass,this.rightMass,this.leftShinMass,this.rightShinMass]=env.masses;this.mass=this.leftMass===this.rightMass?this.leftMass:null;this.hdrEdited=false;this.currentGridId=env.id;
  }
  keyBodies(joints,vel,gyro) {
    const {mj,kin:m,kinData:d,config:c}=this;
    d.qpos.fill(0);d.qpos[3]=1;d.qvel.fill(0);d.qvel.set(gyro,3);
    c.kinQposIds.forEach((id,i)=>{d.qpos[id]=joints[i];});c.kinQvelIds.forEach((id,i)=>{d.qvel[id]=vel[i];});mj.mj_forward(m,d);
    const cache=new Map();
    for(const id of new Set(c.keypoints.flatMap(s=>[s.body,s.correction]))) {
      mj.mj_jacBody(m,d,this.jp,this.jr,id);const jp=this.jp.GetView(),jr=this.jr.GetView();
      const lv=[0,0,0],av=[0,0,0];
      for(let r=0;r<3;r++)for(let j=0;j<m.nv;j++){lv[r]+=jp[r*m.nv+j]*d.qvel[j];av[r]+=jr[r*m.nv+j]*d.qvel[j];}
      cache.set(id,{p:Array.from(d.xpos.subarray(id*3,id*3+3),f),q:Array.from(d.xquat.subarray(id*4,id*4+4),f),lv:lv.map(f),av:av.map(f)});
    }
    const out=this.inputs.robot_key_body;
    c.keypoints.forEach((s,i)=>{
      const b=cache.get(s.body),bc=cache.get(s.correction),offset=rotate(b.q,s.offset.map(f)),correction=rotate(bc.q,s.correctionOffset.map(f));
      out.set(b.p.map((x,j)=>f(f(x+offset[j])+correction[j])),i*3);
      out.set(rot6(b.q),39+i*6);
      const a=cross(b.av,offset),ac=cross(bc.av,correction);
      out.set(b.lv.map((x,j)=>f(f(x+a[j])+ac[j])),117+i*3);
      out.set(b.av.map((x,j)=>f(x-gyro[j])),156+i*3);
    });
  }
  observe(initial=false, append=true) {
    const {data:d,config:c,inputs:o}=this;
    let joints=c.qposIds.map(id=>f(d.qpos[id])),vel=c.qvelIds.map(id=>f(d.qvel[id]));
    const q=normalized(Array.from(d.qpos.subarray(3,7),f));let gyro=Array.from(d.qvel.subarray(3,6),f),gravity=rotate(q,[0,0,-1],true),torque=c.qvelIds.map(id=>f(d.qfrc_actuator[id]));
    let observedRoot=q;
    if(this.noise){
      if(!append&&this.sensorCache)({joints,vel,gravity,gyro,torque,observedRoot}=this.sensorCache);
      else{const n=this.noise,w=n.cfg;joints=n.vector(joints,w.joint_pos);vel=n.vector(vel,w.joint_vel);gravity=n.vector(gravity,w.projected_gravity);gyro=n.vector(gyro,w.base_ang_vel);torque=torque.map(v=>f(v+n.uniform(...w.torque)));observedRoot=n.quat(q,w.root);this.sensorCache={joints,vel,gravity,gyro,torque,observedRoot};}
    }
    const parts=[joints.map((x,i)=>f(x-f(c.offset[i]))),vel,gravity,gyro,Array.from(this.prev),torque];
    if(append){let offset=0;for(const part of parts){const n=part.length;
      if(initial)for(let t=0;t<50;t++)this.history.set(part,offset+t*n);
      else {this.history.copyWithin(offset,offset+n,offset+50*n);this.history.set(part,offset+49*n);}offset+=50*n;}}
    this.proprio=Float32Array.from(parts.flat());o.robot_root_quat.set(observedRoot);o.estimator_history.set(this.history);
    c.referenceSteps.forEach((delta,i)=>{if(this.legacy){const frame=Math.max(0,Math.min(c.frames-1,this.step+delta));o.reference_encoder_input.set(this.reference.subarray(frame*38,(frame+1)*38),i*38);}
      else {const pose=this.motion.pose(delta);o.reference_encoder_input.set(referenceFrame(this.noise?this.noise.reference(pose,c.qposIds,(this.step+delta)*c.dt):pose,c.qposIds),i*38);}});
    this.keyBodies(joints,vel,gyro);
    if([o.robot_root_quat,o.estimator_history,o.reference_encoder_input,o.robot_key_body,this.proprio].some(a=>!a.every(Number.isFinite)))throw new Error('Nonfinite observation');
  }
  updateMemoryInputs() {
    const o=this.inputs;for(const k of ['short_interactions','short_valid'])o[k].fill(0);
    this.short.forEach((a,i)=>{o.short_interactions.set(a,(50-this.short.length+i)*273);o.short_valid[50-this.short.length+i]=1;});
    if(this.packedLongRevision!==this.memoryRevision){o.long_interactions.fill(0);o.long_valid.fill(0);this.long.forEach((a,i)=>{o.long_interactions.set(a,(30-this.long.length+i)*2730);o.long_valid[30-this.long.length+i]=1;});this.packedLongRevision=this.memoryRevision;}
    o.previous_latents.set(this.latents);
  }
  advance(action,latent) {
    const {config:c,model:m,data:d,mj}=this;
    if(action.length!==29||!action.every(Number.isFinite)||latent&&!latent.every(Number.isFinite))throw new Error('Invalid policy output');
    const before=this.proprio.slice();
    // Same nominal ActionChain (zero delay, alpha=1) with float32 target arithmetic.
    c.actuatorIds.forEach((id,i)=>{d.ctrl[id]=f(f(c.offset[i])+f(f(c.scale[i])*action[i]));});
    const oldTime=d.time;for(let i=0;i<c.substeps;i++)mj.mj_step(m,d);
    if(Math.abs(d.time-oldTime-c.dt)>1e-8||!d.qpos.every(Number.isFinite)||!d.qvel.every(Number.isFinite))throw new Error('MuJoCo diverged or reset');
    mj.mj_forward(m,d);this.prev.set(action);this.step++;if(!this.legacy)this.motion.advance();this.observe();
    if(this.short.length===50){this.pending.push(this.short.shift());if(this.pending.length===10){this.long.push(Float32Array.from(this.pending.flatMap(a=>Array.from(a))));if(this.long.length>30)this.long.shift();this.pending=[];this.memoryRevision++;}}
    const interaction=new Float32Array(273);interaction.set(before);interaction.set(action,122);interaction.set(this.proprio,151);this.short.push(interaction);
    if(latent){this.latents.copyWithin(0,64);this.latents.set(latent,192);}
    this.updateMemoryInputs();
  }
  contacts() {
    const c=this.data.contact;let count=0;
    for(let i=0;i<c.size();i++){const contact=c.get(i);if(contact.geom1===this.config.floor||contact.geom2===this.config.floor){count++;if(this.legacy&&Math.abs(contact.friction[0]-this.mu)>1e-12)throw new Error('Contact friction mismatch');}contact.delete();}c.delete();return count;
  }
  snapshot() {
    const {model:m,data:d,mj,ghost:g}=this;
    const index=Math.min(this.step,this.config.frames-1);
    g.qpos.set(this.legacy?this.refQpos.subarray(index*m.nq,(index+1)*m.nq):this.motion.pose());mj.mj_forward(m,g);
    let error=0;for(const id of this.config.bodyIds){let ss=0;for(let k=0;k<3;k++){const e=(d.xpos[id*3+k]-d.qpos[k])-(g.xpos[id*3+k]-g.qpos[k]);ss+=e*e;}error+=Math.sqrt(ss);}
    const ids=this.config.bodyIds,selected=[0,3,6,10,13],threshold=[.25,.5,.5,.25,.25];
    const failed=selected.some((ix,i)=>Math.abs(d.xpos[ids[ix]*3+2]-g.xpos[ids[ix]*3+2])>threshold[i]);
    return {step:this.step,time:d.time,warmup:this.step<350,motion:this.legacy?null:this.motion.status(),environment:this.environment.id,currentGridId:this.currentGridId,hdrEdited:this.hdrEdited,mu:this.mu,mass:this.mass,leftMass:this.leftMass,rightMass:this.rightMass,payloadMasses:[this.leftMass,this.rightMass,...(this.legacy?[0,0]:[this.leftShinMass,this.rightShinMass])],payloadOffsets:this.legacy?Array.from({length:4},()=>[0,0,0]):this.environment.offsets,short:this.short.length,long:this.long.length,
      qpos:d.qpos.slice(),geomPos:d.geom_xpos.slice(),geomMat:d.geom_xmat.slice(),bodyPos:d.xpos.slice(),bodyQuat:d.xquat.slice(),
      ghostPos:g.geom_xpos.slice(),ghostMat:g.geom_xmat.slice(),ghostBodyPos:g.xpos.slice(),latent:this.latents.slice(192),mapLatent:this.mapLatent,mapLatentStep:this.mapLatentStep,mapEncoderSha256:this.config.mapEncoderSha256,contacts:this.contacts(),mpjpe:error/ids.length*1000,failed};
  }
  renderModel() {
    const m=this.model,geoms=[];
    for(let i=0;i<m.ngeom;i++)if(m.geom_group[i]===2){
      const mesh=m.geom_dataid[i],start=m.mesh_vertadr[mesh]*3,end=start+m.mesh_vertnum[mesh]*3,fa=m.mesh_faceadr[mesh]*3;
      const mat=m.geom_matid[i],rgba=mat<0?m.geom_rgba.subarray(i*4,i*4+4):m.mat_rgba.subarray(mat*4,mat*4+4);
      geoms.push({id:i,vertices:m.mesh_vert.slice(start,end),faces:m.mesh_face.slice(fa,fa+m.mesh_facenum[mesh]*3),rgba:Array.from(rgba)});
    }
    return {geoms,payloadBodies:this.hdr.payloadBodies,bodyParents:Array.from(m.body_parentid)};
  }
}
