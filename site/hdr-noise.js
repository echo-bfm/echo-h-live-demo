// Paper observation corruption. Seeded per session, independent of HDR identity.
// Same distributions and widths; JS and Torch random streams are not bit-identical.
const f=Math.fround;
const normalize=q=>{const n=Math.hypot(...q);return q.map(v=>f(v/n));};
function multiply(a,b){return [a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];}
export class HdrNoise{
  constructor(cfg,seed=20260922){this.cfg=cfg;this.state=seed>>>0;const c=cfg.reference,p=c.root_pos_drift,r=c.root_rot_drift;
    this.zOffset=this.uniform(...p.root_z_offset_range_m);this.xyDirection=this.unit(2);this.xyOmega=this.omega(p.xy_freq_range_hz);this.xyAmplitude=this.uniform(...p.xy_speed_range)/this.xyOmega;this.xyPhase=this.uniform(0,2*Math.PI);
    this.zOmega=this.omega(p.z_freq_range_hz);this.zAmplitude=this.uniform(...p.z_amplitude_range_m);this.zPhase=this.uniform(0,2*Math.PI);
    this.rotAxis=this.unit(3);this.rotOmega=this.omega(r.freq_range_hz);this.rotAmplitude=this.uniform(...r.amplitude_range_rad);this.rotPhase=this.uniform(0,2*Math.PI);
    this.jointBias=cfg.jointNames.map(n=>{let width=0;for(const [pattern,value] of Object.entries(c.joint_pos_bias_std))if(new RegExp(`^(?:${pattern})$`).test(n))width=value;return this.uniform(-width,width);});
  }
  random(){let t=this.state=(this.state+0x6D2B79F5)>>>0;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;}
  uniform(a,b){return a+(b-a)*this.random();}
  unit(n){const x=Array.from({length:n},()=>Math.sqrt(-2*Math.log(Math.max(this.random(),1e-12)))*Math.cos(2*Math.PI*this.random())),norm=Math.max(Math.hypot(...x),1e-6);return x.map(v=>v/norm);}
  omega(bounds){return 2*Math.PI*Math.exp(this.uniform(...bounds.map(Math.log)));}
  vector(x,width){return x.map(v=>f(v+this.uniform(-width,width)));}
  quat(q,radius){const axis=this.unit(3),angle=this.uniform(-radius,radius)/2;return normalize(multiply([Math.cos(angle),...axis.map(v=>v*Math.sin(angle))],q));}
  reference(pose,jointIds,time){const c=this.cfg.reference,q=Float64Array.from(pose),xy=this.xyAmplitude*Math.sin(this.xyOmega*time+this.xyPhase),z=this.zAmplitude*Math.sin(this.zOmega*time+this.zPhase)+this.zOffset;
    const direction=this.unit(3),radius=this.uniform(0,c.root_pos_noise_std);q[0]+=xy*this.xyDirection[0];q[1]+=xy*this.xyDirection[1];q[2]+=z;for(let i=0;i<3;i++)q[i]+=direction[i]*radius;
    const angle=this.rotAmplitude*Math.sin(this.rotOmega*time+this.rotPhase)/2;
    q.set(this.quat(multiply([Math.cos(angle),...this.rotAxis.map(v=>v*Math.sin(angle))],Array.from(q.subarray(3,7))),c.root_ori_noise_std),3);
    jointIds.forEach((id,i)=>{q[id]+=this.jointBias[i]+this.uniform(-c.joint_pos_noise_std,c.joint_pos_noise_std);});return q;
  }
}
