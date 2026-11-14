// Reference-only transitions. Physical qpos, velocities and policy memory are
// never overwritten by a motion change. All angles below use wxyz quaternions.
export function yaw(q) {return Math.atan2(2*(q[0]*q[3]+q[1]*q[2]),1-2*(q[2]*q[2]+q[3]*q[3]));}
export function yawQuat(angle,q) {
  const c=Math.cos(angle/2),s=Math.sin(angle/2);
  return [c*q[0]-s*q[3],c*q[1]-s*q[2],c*q[2]+s*q[1],c*q[3]+s*q[0]];
}
export function slerp(a,b,t) {
  let dot=a.reduce((s,v,i)=>s+v*b[i],0),sign=dot<0?-1:1;dot=Math.min(1,Math.abs(dot));
  const angle=Math.acos(dot),den=Math.sin(angle);
  const x=dot>.9995?1-t:Math.sin((1-t)*angle)/den,y=dot>.9995?t:Math.sin(t*angle)/den;
  const q=a.map((v,i)=>x*v+y*sign*b[i]),norm=Math.hypot(...q);return q.map(v=>v/norm);
}
export function blendPose(a,b,t) {
  const u=Math.max(0,Math.min(1,t)),w=u*u*u*(10+u*(-15+6*u));
  const out=Float64Array.from(a,(x,i)=>x+(b[i]-x)*w);
  out.set(slerp(Array.from(a.subarray(3,7)),Array.from(b.subarray(3,7)),w),3);return out;
}
export function referenceFrame(q,qposIds) {
  const [w,x,y,z]=q.subarray(3,7),s=2/(w*w+x*x+y*y+z*z);
  return Float32Array.from([q[0],q[1],q[2],1-s*(y*y+z*z),s*(x*y+z*w),s*(x*z-y*w),
    s*(x*y-z*w),1-s*(x*x+z*z),s*(y*z+x*w),...qposIds.map(i=>q[i])]);
}

export class MotionPlayer {
  constructor(manifest,clips) {this.manifest=manifest;this.clips=clips;this.reset();}
  reset(){this.idle=Float64Array.from(this.manifest.idleQpos);this.active=null;this.frame=0;this.completed=0;}
  get locked(){return this.active!==null;}
  select(id) {
    if(this.locked)throw new Error('The current motion is still active. Wait for T-pose idle or use Reset.');
    const entry=this.manifest.motions.find(m=>m.id===id),source=this.clips.get(id);
    if(!entry||!source)throw new Error('Unknown motion');
    const nq=this.manifest.nq,start=source.subarray(0,nq),angle=yaw(this.idle.subarray(3,7))-yaw(start.subarray(3,7));
    const c=Math.cos(angle),s=Math.sin(angle),aligned=source.slice();
    for(let i=0;i<entry.frames;i++){
      const offset=i*nq,q=aligned.subarray(offset,offset+nq),x=q[0]-start[0],y=q[1]-start[1];
      q[0]=this.idle[0]+c*x-s*y;q[1]=this.idle[1]+s*x+c*y;q.set(yawQuat(angle,q.subarray(3,7)),3);
    }
    const last=aligned.subarray(aligned.length-nq),end=Float64Array.from(this.manifest.idleQpos);
    end[0]=last[0];end[1]=last[1];end.set(yawQuat(yaw(last.subarray(3,7)),[1,0,0,0]),3);
    // Use the same quaternion hemisphere at the return-to-idle seam.
    if(last.subarray(3,7).reduce((sum,v,i)=>sum+v*end[i+3],0)<0)for(let i=3;i<7;i++)end[i]*=-1;
    this.active={entry,aligned,start:this.idle.slice(),end};this.frame=0;
  }
  pose(offset=0) {
    const a=this.active;if(!a)return this.idle;
    const i=this.frame+offset,nq=this.manifest.nq,t=this.manifest.transitionSteps,n=a.entry.frames;
    if(i<=0)return a.start;
    if(i<t)return blendPose(a.start,a.aligned.subarray(0,nq),i/t);
    if(i<=t+n-1)return a.aligned.subarray((i-t)*nq,(i-t+1)*nq);
    return blendPose(a.aligned.subarray((n-1)*nq),a.end,(i-(t+n-1))/t);
  }
  advance(){
    if(!this.active)return;
    this.frame++;
    // Retain the last 42 reference samples through the end of the transition.
    // After this point the complete encoder window is the stationary pose.
    if(this.frame>=2*this.manifest.transitionSteps+this.active.entry.frames-1+42){
      this.idle=this.active.end;this.active=null;this.frame=0;this.completed++;
    }
  }
  status(){
    const a=this.active,t=this.manifest.transitionSteps;
    if(!a)return {id:'idle',label:'T-pose idle',phase:'idle',locked:false,progress:0,elapsed:0,duration:0,completed:this.completed};
    const n=a.entry.frames,phase=this.frame<t?'enter':this.frame<t+n-1?'motion':'exit';
    return {id:a.entry.id,label:a.entry.label,phase,locked:true,progress:Math.min(1,this.frame/(2*t+n-1+42)),
      elapsed:Math.max(0,Math.min(n-1,this.frame-t))*.02,duration:(n-1)*.02,completed:this.completed};
  }
}
