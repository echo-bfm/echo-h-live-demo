import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {LatentAtlas} from './latent-atlas.js';
const $=id=>document.getElementById(id),startup=window.echoStartup,worker=startup?.worker??new Worker('./worker.js?v=20261113-online',{type:'module'}),pending=new Map();let nextId=1,editSequence=0,playing=false,ready=false,lastFrame=null,lastWall=0,lastSim=0,selecting=false,resetting=false;
window.echo={ready:false,errors:[],frames:0,call:(type,extra={})=>new Promise((resolve,reject)=>{const id=nextId++;pending.set(id,{resolve,reject});worker.postMessage({type,id,...extra});})};
const atlasView=new LatentAtlas($('latent'),window.echo);
const startupAssets=new Map();
const setText=(id,value)=>{const element=$(id);if(element&&element.textContent!==value)element.textContent=value;};
const showRuntimeError=message=>{setText('status',message);let notice=$('runtime-error');if(!notice){notice=document.createElement('p');notice.id='runtime-error';notice.className='runtime-error';notice.setAttribute('role','alert');document.querySelector('.scene-panel').appendChild(notice);}notice.textContent=message;notice.hidden=false;};
const clearRuntimeError=()=>{const notice=$('runtime-error');if(notice){notice.hidden=true;notice.textContent='';}};
let nextOverlayUpdate=0;
const view=$('viewport'),scene=new THREE.Scene();scene.fog=new THREE.Fog('#f5f5f7',10,25);
const camera=new THREE.PerspectiveCamera(38,1,.01,60);camera.up.set(0,0,1);camera.position.set(2.3,-2.5,1.7);
let renderer,isLightweight=false,bodyParents=[];
const renderCanvas=document.createElement('canvas');
const gl=new URLSearchParams(location.search).get('view')==='2d'?null:renderCanvas.getContext('webgl2',{antialias:true,alpha:true});
if(gl){renderer=new THREE.WebGLRenderer({canvas:renderCanvas,context:gl});window.echo.renderer='WebGL2';}
else{
  isLightweight=true;window.echo.renderer='Canvas2D';document.getElementById('simulation-title').textContent='Live simulation · 2D';
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  renderer={domElement:canvas,setPixelRatio(){},setClearColor(){},setSize(w,h){canvas.width=w;canvas.height=h;},render(){
    const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);if(!lastFrame)return;camera.updateMatrixWorld();
    const project=(x,y,z)=>{const v=new THREE.Vector3(x,y,z).project(camera);return [(v.x+1)*w/2,(1-v.y)*h/2];};
    const line=(a,b,color,width)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();};
    const root=lastFrame.qpos;for(let i=-5;i<=5;i++){
      line(project(root[0]-3,root[1]+i*.5,0),project(root[0]+3,root[1]+i*.5,0),'#dedee4',1);
      line(project(root[0]+i*.5,root[1]-3,0),project(root[0]+i*.5,root[1]+3,0),'#dedee4',1);
    }
    const skeleton=(positions,color)=>{for(let id=1;id<bodyParents.length;id++){const parent=bodyParents[id];if(parent>0)line(project(...positions.subarray(id*3,id*3+3)),project(...positions.subarray(parent*3,parent*3+3)),color,5);}for(let id=1;id<bodyParents.length;id++){ctx.fillStyle=color;ctx.beginPath();ctx.arc(...project(...positions.subarray(id*3,id*3+3)),3,0,Math.PI*2);ctx.fill();}};
    if($('ghost').checked)skeleton(lastFrame.ghostBodyPos,'#8aafd966');skeleton(lastFrame.bodyPos,'#424245');
    for(const [i,id] of payloadBodies.entries()){if(lastFrame.payloadMasses[i]<=0)continue;const [x,y]=project(...lastFrame.bodyPos.subarray(id*3,id*3+3));ctx.fillStyle=i%2===0?'#eda76a':'#85aaff';ctx.fillRect(x-6,y-6,12,12);}
  }};
}
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0,0);view.appendChild(renderer.domElement);
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.5;
scene.add(new THREE.HemisphereLight('#ffffff','#c7c9d1',2.1));const light=new THREE.DirectionalLight('#ffffff',3.2);light.position.set(3,-4,7);scene.add(light);const rim=new THREE.DirectionalLight('#e1e8f4',2);rim.position.set(-3,2,4);scene.add(rim);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(50,50),new THREE.MeshStandardMaterial({color:'#f0f0f3',roughness:1}));ground.position.z=-.006;scene.add(ground);
const grid=new THREE.GridHelper(50,100,'#b9bbc4','#d5d6de');grid.rotation.x=Math.PI/2;grid.position.z=-.004;grid.material.transparent=true;grid.material.opacity=.5;scene.add(grid);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,0,.85);controls.enableDamping=true;controls.maxDistance=9;controls.minDistance=1.5;controls.maxPolarAngle=Math.PI*.49;
let geoms=[],ghosts=[],payload=[],payloadBodies=[],previousRoot=null,renderDirty=true;
const ghostMaterial=new THREE.MeshBasicMaterial({color:'#9dc8f4',transparent:true,opacity:.13,depthWrite:false});
async function createRobot(model){payloadBodies=model.payloadBodies;bodyParents=model.bodyParents;if(isLightweight)return;let batchStart=performance.now();for(const g of model.geoms){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(g.vertices,3));geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(g.faces),1));geometry.computeVertexNormals();const color=new THREE.Color(...g.rgba.slice(0,3));const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color,metalness:.3,roughness:.46}));mesh.matrixAutoUpdate=false;scene.add(mesh);geoms.push({id:g.id,mesh});const ghost=new THREE.Mesh(geometry,ghostMaterial);ghost.matrixAutoUpdate=false;ghost.visible=$('ghost').checked;scene.add(ghost);ghosts.push({id:g.id,mesh:ghost});
    // Yield between mesh batches so the loading UI and page remain responsive.
    if(performance.now()-batchStart>8){await new Promise(resolve=>setTimeout(resolve,0));batchStart=performance.now();}}
  payload=payloadBodies.map((_,i)=>{const box=new THREE.Mesh(new THREE.BoxGeometry(.10,.08,i<2?.08:.10),new THREE.MeshStandardMaterial({color:i%2===0?'#eda76a':'#85aaff',metalness:.3,roughness:.4}));scene.add(box);return box;});}
function transform(list,pos,mat){for(const {id,mesh} of list){const p=id*3,r=id*9;mesh.matrix.set(mat[r],mat[r+1],mat[r+2],pos[p],mat[r+3],mat[r+4],mat[r+5],pos[p+1],mat[r+6],mat[r+7],mat[r+8],pos[p+2],0,0,0,1);mesh.matrixWorldNeedsUpdate=true;}}
function renderFrame(s){renderDirty=true;lastFrame=s;window.echo.last=s;window.echo.frames++;transform(geoms,s.geomPos,s.geomMat);transform(ghosts,s.ghostPos,s.ghostMat);
  payload.forEach((mesh,i)=>{const id=payloadBodies[i],p=id*3,q=id*4;const mass=s.payloadMasses[i];mesh.visible=mass>0;mesh.scale.setScalar(.75+Math.cbrt(mass)*.35);mesh.quaternion.set(s.bodyQuat[q+1],s.bodyQuat[q+2],s.bodyQuat[q+3],s.bodyQuat[q]);mesh.position.set(s.bodyPos[p],s.bodyPos[p+1],s.bodyPos[p+2]);mesh.position.add(new THREE.Vector3((i<2?.12:0)+s.payloadOffsets[i][0],s.payloadOffsets[i][1],(i<2?0:-.15)+s.payloadOffsets[i][2]).applyQuaternion(mesh.quaternion));});
  const root=new THREE.Vector3(s.qpos[0],s.qpos[1],0);if(previousRoot){const delta=root.clone().sub(previousRoot);camera.position.add(delta);controls.target.add(delta);}else {camera.position.add(root);controls.target.add(root);}previousRoot=root;
  if($('environment').value!==s.environment)$('environment').value=s.environment;
  setText('environment-status',`Changing this preset resets the session. Reset restores ${s.environment}.`);
  const now=performance.now();if(s.step===0||now>=nextOverlayUpdate){
    nextOverlayUpdate=now+100;setText('sim-time',`${s.time.toFixed(2)} s`);setText('mode',s.warmup?'Building history':'Adapting live');setText('mpjpe',`${s.mpjpe.toFixed(1)} mm`);setText('memory',`${Math.min(s.step,350)} / 350`);
    const historyProgress=$('history-progress'),historySteps=Math.min(s.step,350);
    historyProgress.value=historySteps;historyProgress.setAttribute('aria-valuetext',s.warmup?`${Math.round(historySteps/350*100)}% of interaction history collected`:'History complete; adapting live');
  }syncMotion(s.motion);
  if(s.step===0){atlasView.reset();clearRuntimeError();lastWall=0;setText('inference','—');setText('speed','—');setText('status','Ready — choose a motion, then press Start.');setText('applied','Applied');syncControls(s.leftMass,s.rightMass);}atlasView.update(s);}
function resize(){renderDirty=true;renderer.setSize(view.clientWidth,view.clientHeight);camera.aspect=view.clientWidth/view.clientHeight;camera.updateProjectionMatrix();atlasView.resize();}new ResizeObserver(resize).observe(view);
function animate(){requestAnimationFrame(animate);const changed=controls.update();if(changed||renderDirty){renderer.render(scene,camera);renderDirty=false;}}animate();
function syncControls(leftMass,rightMass){
  for(const [id,value] of [['left-mass',leftMass],['right-mass',rightMass]]){$(id).value=value;$(id+'-value').textContent=Number(value).toFixed(1);}
  document.querySelectorAll('[data-left]').forEach(button=>button.setAttribute('aria-pressed',String(+button.dataset.left===+leftMass&&+button.dataset.right===+rightMass)));
}
let displayedMotionId=null;
const motionTime=seconds=>`${Math.floor(seconds/60)}:${(seconds%60).toFixed(1).padStart(4,'0')}`;
function syncMotion(motion){
  if(!motion){$('motion').disabled=true;$('motion-status').textContent='Validating runtime consistency';return;}
  $('motion').disabled=!ready||motion.locked||selecting||resetting;
  // Do not rewrite a native select while the user is browsing its options.
  if(!selecting&&displayedMotionId!==motion.id){$('motion').value=motion.id;displayedMotionId=motion.id;}
  const phase={idle:'Ready to select a motion.',enter:'Blending in · Reset to choose another',motion:'Selection unlocks when playback finishes.',exit:'Returning to rest · Selection unlocks next'};
  setText('motion-status',selecting?'Loading motion… Reset to cancel.':phase[motion.phase]);
  setText('duration',motion.locked?`${motionTime(motion.elapsed)} / ${motionTime(motion.duration)}`:'At rest');
  $('progress').style.width=`${motion.progress*100}%`;
}
$('motion').onchange=async()=>{
  const motion=$('motion').value;if(motion==='idle')return;
  selecting=true;$('motion').disabled=true;$('motion-status').textContent='Loading full motion… (Reset to cancel)';
  try{await window.echo.call('motion',{motion});clearRuntimeError();setText('status',playing?'Motion started. Returns to T-pose when complete.':'Motion selected. Press Start or Resume to play.');}
  catch(e){if(!resetting&&e.code!=='MOTION_CANCELED')showRuntimeError(`Motion loading failed: ${e.message}`);}
  finally{selecting=false;displayedMotionId=null;if(lastFrame)syncMotion(lastFrame.motion);}
};
function edit(hand=null){
  const keys={'left-mass':'leftMass','right-mass':'rightMass'};
  const changes=hand?{[keys[hand]]:+$(hand).value}:{leftMass:+$('left-mass').value,rightMass:+$('right-mass').value};
  for(const id of Object.keys(keys))$(id+'-value').textContent=Number($(id).value).toFixed(1);
  $('applied').textContent='Applying';worker.postMessage({type:'physics',...changes,requestId:++editSequence});
}
for(const id of ['left-mass','right-mass'])$(id).addEventListener('input',()=>edit(id));
document.querySelectorAll('[data-left]').forEach(b=>b.onclick=()=>{syncControls(+b.dataset.left,+b.dataset.right);edit();});
$('environment').onchange=async()=>{if(resetting)return;resetting=true;playing=false;$('play').textContent='Start';$('environment').disabled=true;$('play').disabled=true;$('reset').disabled=true;if(lastFrame)syncMotion(lastFrame.motion);try{await window.echo.call('environment',{environment:$('environment').value});}catch(e){showRuntimeError(String(e));}finally{resetting=false;$('environment').disabled=false;$('play').disabled=false;$('reset').disabled=false;if(lastFrame)syncMotion(lastFrame.motion);}};
$('play').onclick=()=>{playing=!playing;worker.postMessage({type:playing?'play':'pause'});$('play').textContent=playing?'Pause':'Resume';lastWall=0;};
$('reset').onclick=async()=>{if(resetting)return;resetting=true;playing=false;$('play').disabled=true;$('reset').disabled=true;$('environment').disabled=true;try{await window.echo.call('reset');$('play').textContent='Start';}catch(e){showRuntimeError(String(e));}finally{resetting=false;$('reset').disabled=false;$('play').disabled=false;$('environment').disabled=false;if(lastFrame)syncMotion(lastFrame.motion);}};$('ghost').onchange=()=>{ghosts.forEach(g=>g.mesh.visible=$('ghost').checked);renderDirty=true;};
worker.onmessage=async({data:m})=>{if(m.type==='reply'){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(Object.assign(new Error(m.error),{code:m.code}));else p?.resolve(m.result);return;}
  if(m.type==='load-plan'){for(const item of m.assets)startupAssets.set(item.asset,{loaded:0,total:item.total});}
  else if(m.type==='load-progress'&&!ready&&startupAssets.has(m.asset)){
    const item=startupAssets.get(m.asset);item.loaded=Math.max(item.loaded,m.loaded);
    const entries=[...startupAssets.values()],total=entries.reduce((sum,a)=>sum+a.total,0),loaded=entries.reduce((sum,a)=>sum+a.loaded,0);
    $('loading-progress').value=loaded;$('loading-progress').max=total;
    setText('loading-detail',loaded<total?`${Math.round(loaded/total*100)}% of scene and model data loaded`:'Data loaded. Preparing the simulation…');
  }
  else if(m.type==='startup-timing'){window.echo.startupTiming=m;$('loading').dataset.workerTiming=JSON.stringify(m);}
  else if(m.type==='status'){if(!ready)setText('loading-title',m.text);else setText('status',m.text);}
  else if(m.type==='ready'){
    setText('loading-title','Preparing the 3D view…');await createRobot(m.model);
    ready=true;window.echo.backend=m.backend;window.echo.gpu=m.gpu;window.echo.environments=m.environments;
    for(const e of m.environments){const option=document.createElement('option');option.value=e.id;option.textContent=`${e.id} · Left ${e.masses[0]} / Right ${e.masses[1]} kg`;$('environment').appendChild(option);}
    $('environment').disabled=false;setText('backend',m.backend);
    for(const motion of m.motions){const option=document.createElement('option');option.value=motion.id;option.textContent=motion.label;$('motion').appendChild(option);}
    window.echo.motions=m.motions;document.querySelectorAll('button,input[type=range]').forEach(e=>e.disabled=false);renderFrame(m.snapshot);
    $('loading').style.display='none';window.echo.ready=true;window.echo.readyMs=performance.now();$('loading').dataset.readyMs=String(window.echo.readyMs);performance.mark('echo-ready');
  }
  else if(m.type==='frame'){renderFrame(m.snapshot);if(m.inferenceMs!==undefined)setText('inference',`${m.inferenceMs.toFixed(1)} ms`);if(playing){const now=performance.now();if(lastWall&&now-lastWall>=500){setText('speed',`${((m.snapshot.time-lastSim)/(now-lastWall)*1000).toFixed(2)}×`);lastWall=now;lastSim=m.snapshot.time;}else if(!lastWall){lastWall=now;lastSim=m.snapshot.time;}}}
  else if(m.type==='physics'){if(m.event.requestId==null||m.event.requestId===editSequence)syncControls(m.event.leftMass,m.event.rightMass);setText('applied','Applied');setText('status','Payloads updated — playback and history preserved.');}
  else if(m.type==='error'){window.echo.errors.push(m);showRuntimeError(`Runtime failed: ${m.message}`);playing=false;if(!ready){setText('loading-title','Unable to load the demo');setText('loading-detail',`${m.message}. Reload to try again.`);$('loading-progress').hidden=true;}}
};
worker.onerror=e=>{window.echo.errors.push(String(e.message));showRuntimeError(`Worker error: ${e.message}`);if(!ready){setText('loading-title','Unable to load the demo');setText('loading-detail',`${e.message}. Reload to try again.`);$('loading-progress').hidden=true;}};
if(startup)startup.attach(worker.onmessage,worker.onerror);
else{
  const options=new URLSearchParams(location.search);
  worker.postMessage({type:'init',cpuBudget:navigator.hardwareConcurrency||1,baseline:false,threads:[1,2,4].includes(Number(options.get('threads')))?Number(options.get('threads')):0});
}
