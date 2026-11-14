import {insidePolygon,projectLatent} from './atlas-projection.js';
const $=id=>document.getElementById(id);
class MainThreadProjector {
  postMessage(data){
    setTimeout(()=>{try{
      if(data.type==='init'){this.atlas=data.atlas;this.onmessage({data:{type:'ready'}});return;}
      const start=performance.now(),result=projectLatent(data.latent,this.atlas);
      this.onmessage({data:{type:'projection',generation:data.generation,step:data.step,result,elapsedMs:performance.now()-start}});
    }catch(error){this.onerror?.({message:String(error)});}},0);
  }
}
export class LatentAtlas{
  constructor(canvas,debug){
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.debug=debug;this.trail=[];this.lastStep=-1;this.active=null;this.pinned=null;this.atlas=null;
    this.background=document.createElement('canvas');this.bg=this.background.getContext('2d');this.dirty=true;
    this.fontFamily=getComputedStyle(canvas).fontFamily;document.fonts.ready.then(()=>{this.dirty=true;this.draw();});
    this.generation=0;this.projecting=false;this.projectionReady=false;this.queued=null;
    this.projector=(navigator.hardwareConcurrency||1)>1?new Worker('./atlas-worker.js',{type:'module'}):new MainThreadProjector();
    this.projector.onmessage=({data})=>{
      if(data.type==='ready'){this.projectionReady=true;this.flushProjection();return;}
      this.projecting=false;
      if(data.generation===this.generation){
        this.current=data.result;this.trail.push(this.current.xy);if(this.trail.length>1000)this.trail.shift();
        $('atlas-live').textContent=this.current.covered?'Dark point · Current latent':'Hollow point · Outside sampled coverage';
        this.debug.atlas.current=this.current;this.debug.atlas.projectionMs=data.elapsedMs;this.draw();
      }
      this.flushProjection();
    };
    this.projector.onerror=e=>{this.debug.atlasError=e.message;$('atlas-live').textContent='Live projection unavailable';};
    canvas.addEventListener('pointermove',e=>this.pointer(e));canvas.addEventListener('pointerleave',()=>{if(this.pinned===null)this.select(null);$('atlas-tooltip').hidden=true;});
    canvas.addEventListener('click',e=>{const group=this.hit(e);this.pinned=this.pinned===group?null:group;this.select(this.pinned);});
    canvas.addEventListener('keydown',e=>{if(e.key==='Escape'){this.pinned=null;this.select(null);}});
    new ResizeObserver(()=>this.resize()).observe(canvas);
    this.load().catch(e=>{$('atlas-summary').textContent=`Atlas loading failed: ${e.message}`;debug.atlasError=String(e);});
  }
  async load(){
    const r=await fetch('./assets/atlas.json');if(!r.ok)throw new Error(`HTTP ${r.status}`);const atlas=await r.json();
    const c=await (await fetch('./assets/config.json')).json();if(atlas.checkpointSha256!==c.checkpointSha256||atlas.onnxSha256!==c.onnxSha256)throw new Error('Sampled model does not match the current checkpoint');
    if(c.environmentMode==='nominal-payload-only'&&(atlas.protocol.environmentMode!==c.environmentMode||atlas.protocol.observationNoise!=='disabled'||atlas.protocol.referenceNoise!=='disabled'))throw new Error('Background and live noise conditions do not match');
    const payload81=['payload81','hand9'].includes(atlas.protocol.kind),handsOnly=atlas.protocol.kind==='hand9';
    if(atlas.schema!==3||(!payload81&&atlas.protocol.kind!=='paper-hdr')||atlas.groups.length!==(handsOnly?9:payload81?81:16)||atlas.encoderSha256!==(payload81?c.mapEncoderSha256:c.encoderSha256))throw new Error('Atlas and live encoder do not match');
    const hdr=await (await fetch('./assets/hdr.json')).json();if(atlas.protocol.bankSha256!==hdr.bankSha256||atlas.groups.some((g,i)=>g.bankRow!==hdr.selectedRows[i]))throw new Error('HDR atlas and simulation parameter bank do not match');
    const featureResponse=await fetch(`./assets/${atlas.features.file}`);if(!featureResponse.ok)throw new Error('Failed to load projection samples');
    const bytes=await featureResponse.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==atlas.features.sha256||bytes.byteLength!==atlas.points.length*64*4)throw new Error('Projection sample verification failed');
    this.projector.postMessage({type:'init',atlas:{points:atlas.points.map(p=>({xy:p.xy})),mean:atlas.mean,scale:atlas.scale,projection:atlas.projection,featureBuffer:new Float32Array(bytes)}},[bytes]);
    this.atlas=atlas;const validMotions=new Set(atlas.points.map(p=>p.motion)).size;
    this.debug.atlas={ready:true,kind:atlas.kind,groups:atlas.groups.length,points:atlas.points.length,motions:atlas.motions.length,validMotions};
    $('atlas-summary').textContent=`${atlas.groups.length} ${payload81?'payload groups':'HDR conditions'} · ${atlas.points.length.toLocaleString()} samples · ${validMotions} motions`;
    atlas.groups.forEach((g,index)=>{
      if(payload81)g.label=`${handsOnly?"Hand":"Limb"} payloads ${g.masses.slice(0,handsOnly?2:4).join(" / ")} kg`;
      const button=document.createElement('button');button.type='button';button.dataset.group=g.id;button.style.setProperty('--color',g.color);button.setAttribute('aria-pressed','false');
      const dot=document.createElement('span'),masses=handsOnly?g.masses.slice(0,2):g.masses;button.append(dot,document.createTextNode(`${g.id}  ${payload81?masses.join(' / '):g.label}`));button.title=`${g.id} · ${handsOnly?'Left / right hand':'Left hand / right hand / left leg / right leg'}: ${masses.join(' / ')} kg`;
      button.addEventListener('pointerenter',()=>{if(this.pinned===null)this.select(index);});button.addEventListener('focus',()=>{if(this.pinned===null)this.select(index);});
      button.addEventListener('pointerleave',()=>{if(this.pinned===null)this.select(null);});button.addEventListener('click',()=>{this.pinned=this.pinned===index?null:index;this.select(this.pinned);});
      button.addEventListener('keydown',e=>{if(e.key==='Escape'){this.pinned=null;this.select(null);}});$('atlas-legend').appendChild(button);
    });this.resize();this.select(null);
  }
  resize(){const rect=this.canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
    this.w=rect.width;this.h=rect.height;this.dpr=Math.min(devicePixelRatio||1,2);
    for(const canvas of [this.canvas,this.background]){canvas.width=Math.round(this.w*this.dpr);canvas.height=Math.round(this.h*this.dpr);}
    this.ctx.setTransform(this.dpr,0,0,this.dpr,0,0);this.bg.setTransform(this.dpr,0,0,this.dpr,0,0);this.layers=null;this.dirty=true;this.draw();
  }
  map([x,y]){const [xmin,xmax,ymin,ymax]=this.atlas.bounds;const scale=Math.min((this.w-36)/(xmax-xmin),(this.h-60)/(ymax-ymin));return [this.w/2+(x-(xmin+xmax)/2)*scale,(this.h-20)/2-(y-(ymin+ymax)/2)*scale];}
  unmap([x,y]){const [xmin,xmax,ymin,ymax]=this.atlas.bounds,scale=Math.min((this.w-36)/(xmax-xmin),(this.h-60)/(ymax-ymin));return [(x-this.w/2)/scale+(xmin+xmax)/2,((this.h-20)/2-y)/scale+(ymin+ymax)/2];}
  reset(){this.generation++;this.queued=null;this.trail=[];this.lastStep=-1;this.current=null;if(this.debug.atlas)this.debug.atlas.current=null;$('atlas-live').textContent='Waiting for interaction history';this.draw();}
  update(frame){
    if(!this.atlas||frame.step===this.lastStep)return;
    if(frame.warmup||frame.step<=350){const text=`Live point in ${(Math.max(0,350-frame.step)*.02).toFixed(1)} s of simulation`;
      if($('atlas-live').textContent!==text)$('atlas-live').textContent=text;return;}
    if(frame.step%5!==0)return;
    const payload81=['payload81','hand9'].includes(this.atlas.protocol.kind),latent=payload81?frame.mapLatent:frame.latent;
    if(!latent||payload81&&(frame.mapEncoderSha256!==this.atlas.encoderSha256||frame.mapLatentStep!==frame.step-1))return;
    this.lastStep=frame.step;
    // At most one in flight plus the newest latent, even on slower CPUs.
    this.queued={type:'project',generation:this.generation,step:frame.step,latent};this.flushProjection();
  }
  flushProjection(){if(this.projecting||!this.projectionReady||!this.queued)return;this.projecting=true;this.projector.postMessage(this.queued);this.queued=null;}
  select(index){this.active=index;this.debug.atlasActive=index===null?null:this.atlas.groups[index].id;this.dirty=true;
    const g=index===null?null:this.atlas.groups[index];
    $('atlas-title').textContent=g?`${g.id} · ${g.label}`:'Explore the atlas';$('atlas-swatch').style.background=g?g.color:'#86868b';
    $('atlas-pin').textContent=this.pinned===null?'':'Pinned';$('atlas-description').textContent=g?'Background samples in this region use the following physical conditions.':'Hover to highlight a region. Click to pin its details.';
    $('atlas-left').textContent=g?`${g.leftMass.toFixed(3)} kg`:'—';$('atlas-right').textContent=g?`${g.rightMass.toFixed(3)} kg`:'—';$('atlas-total').textContent=g?`${g.masses.reduce((s,m)=>s+m,0).toFixed(3)} kg`:'—';
    const torsoDelta=g&&Math.abs(g.torsoMassDelta)>=.0005?g.torsoMassDelta:0;
    if($('atlas-shins'))$('atlas-shins').textContent=g?`L ${g.masses[2].toFixed(3)} / R ${g.masses[3].toFixed(3)} kg`:'—';
    if($('atlas-friction'))$('atlas-friction').textContent=g?g.mu.toFixed(4):'—';
    if($('atlas-torso'))$('atlas-torso').textContent=g?`${torsoDelta>0?'+':''}${torsoDelta.toFixed(3)} kg`:'—';
    [...$('atlas-legend').children].forEach((b,i)=>{b.classList.toggle('active',i===index);b.setAttribute('aria-pressed',String(i===this.pinned));});this.draw();
  }
  position(event){const r=this.canvas.getBoundingClientRect();return [event.clientX-r.left,event.clientY-r.top];}
  hit(event){if(!this.atlas)return null;const pixel=this.position(event),point=this.unmap(pixel);let nearest=null,best=Infinity;
    for(let i=0;i<this.atlas.points.length;i++){const d=(this.pixels[i*2]-pixel[0])**2+(this.pixels[i*2+1]-pixel[1])**2;
      if(d<best){best=d;nearest=this.atlas.points[i].group;}}
    if(best<100)return nearest;
    const candidates=this.atlas.groups.flatMap((g,i)=>g.contours.some(poly=>insidePolygon(point,poly))?[i]:[]);
    if(candidates.includes(nearest))return nearest;return candidates[0]??null;
  }
  pointer(event){if(!this.atlas)return;const index=this.hit(event);if(this.pinned===null&&this.active!==index)this.select(index);
    const tooltip=$('atlas-tooltip');if(index===null){tooltip.hidden=true;return;}
    const g=this.atlas.groups[index],p=this.position(event);tooltip.textContent=`${g.id} · ${g.label}\nL ${g.leftMass.toFixed(3)} kg  /  R ${g.rightMass.toFixed(3)} kg  /  Total ${g.masses.reduce((s,m)=>s+m,0).toFixed(3)} kg\n${g.count} samples · Click to pin`;
    tooltip.hidden=false;tooltip.style.left=`${Math.max(6,Math.min(p[0]+12,this.w-225))}px`;tooltip.style.top=`${Math.max(6,Math.min(p[1]+10,this.h-90))}px`;
  }
  buildLayers(){
    const canvas=document.createElement('canvas');canvas.width=this.canvas.width;canvas.height=this.canvas.height;
    const ctx=canvas.getContext('2d');ctx.setTransform(this.dpr,0,0,this.dpr,0,0);
    this.layers={canvas,groups:this.atlas.groups.map(()=>[])};
    this.pixels=new Float32Array(this.atlas.points.length*2);
    const dense=this.atlas.points.length>5000,radius=dense?1.05:1.8;
    this.atlas.points.forEach((p,i)=>{const [x,y]=this.map(p.xy);this.pixels.set([x,y],i*2);this.layers.groups[p.group].push([x,y]);
      ctx.globalAlpha=dense?.5:.8;ctx.fillStyle=this.atlas.groups[p.group].color;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();});
  }
  drawBackground(){const ctx=this.bg;ctx.clearRect(0,0,this.w,this.h);if(!this.atlas)return;if(!this.layers)this.buildLayers();
    this.atlas.groups.forEach((g,i)=>{
      const selected=this.active===i,dim=this.active!==null&&!selected;
      ctx.fillStyle=g.color;ctx.strokeStyle=g.color;ctx.lineWidth=selected?1.4:.7;
      for(const poly of g.contours){ctx.beginPath();poly.forEach((p,j)=>{const [x,y]=this.map(p);if(j===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.closePath();ctx.globalAlpha=dim?.015:selected?.15:.055;ctx.fill();ctx.globalAlpha=dim?.05:selected?.8:.22;ctx.stroke();}
    });
    // One cached cloud; hover redraws only the selected group's ~320 points.
    // Avoid allocating 81 full-resolution canvases on reviewer laptops.
    ctx.globalAlpha=this.active!==null?.09:.9;ctx.drawImage(this.layers.canvas,0,0,this.w,this.h);
    if(this.active!==null){ctx.globalAlpha=.9;ctx.fillStyle=this.atlas.groups[this.active].color;
      for(const [x,y] of this.layers.groups[this.active]){ctx.beginPath();ctx.arc(x,y,1.8,0,Math.PI*2);ctx.fill();}}
    ctx.globalAlpha=1;ctx.font=`500 10px ${this.fontFamily}`;const labels=[];
    this.atlas.groups.forEach((g,i)=>{
      if(this.active!==null&&this.active!==i||this.atlas.groups.length>30&&this.active===null)return;const origin=this.map(g.labelPosition);let [x,y]=origin;
      for(const [dx,dy] of [[0,0],[0,-19],[0,19],[-30,0],[30,0],[0,-38],[0,38]]){
        const candidate=[origin[0]+dx,origin[1]+dy];
        if(!labels.some(p=>Math.abs(p[0]-candidate[0])<30&&Math.abs(p[1]-candidate[1])<17)){[x,y]=candidate;break;}
      }
      labels.push([x,y]);if(x!==origin[0]||y!==origin[1]){ctx.strokeStyle=g.color;ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(...origin);ctx.lineTo(x,y);ctx.stroke();}
      ctx.fillStyle='#ffffffdd';ctx.fillRect(x-13,y-7,26,14);ctx.fillStyle='#424245';ctx.textAlign='center';ctx.fillText(g.id,x,y+3);
    });ctx.textAlign='left';
    this.dirty=false;
  }
  draw(){if(!this.w||!this.atlas)return;if(this.dirty)this.drawBackground();const ctx=this.ctx;ctx.clearRect(0,0,this.w,this.h);ctx.drawImage(this.background,0,0,this.w,this.h);
    if(this.trail.length){ctx.save();ctx.beginPath();ctx.rect(0,0,this.w,this.h-25);ctx.clip();ctx.strokeStyle='#1d1d1fcc';ctx.lineWidth=1.3;ctx.beginPath();this.trail.forEach((p,i)=>{const [x,y]=this.map(p);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();const [x,y]=this.map(this.trail.at(-1));ctx.shadowColor='#ffffff';ctx.shadowBlur=14;ctx.fillStyle='#1d1d1f';ctx.strokeStyle='#1d1d1f';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x,y,4.3,0,Math.PI*2);if(this.current?.covered)ctx.fill();else ctx.stroke();ctx.restore();}
  }
}
