// Out-of-sample approximation on a fixed t-SNE map. Environment labels and
// slider settings never enter the projection; only the actual 64D latent does.
export function projectLatent(latent,atlas){
  const x=Array.from(latent,(v,j)=>(v-atlas.mean[j])/atlas.scale[j]);
  // Scan contiguous FP32 anchors, keeping only k best. No O(n log n) full sort.
  const nearest=[],k=atlas.projection.neighbors,features=atlas.featureBuffer;
  for(let i=0;i<atlas.points.length;i++){
    let distance=0;const offset=i*64;
    for(let j=0;j<64;j++){const delta=x[j]-features[offset+j];distance+=delta*delta;}
    if(nearest.length===k&&distance>=nearest[k-1].distance)continue;
    let at=nearest.length;while(at>0&&distance<nearest[at-1].distance)at--;
    nearest.splice(at,0,{i,distance});if(nearest.length>k)nearest.pop();
  }
  if(!nearest.length)throw new Error('Atlas has no anchors');
  let xy=[0,0];
  if(nearest[0].distance<1e-10)xy=[...atlas.points[nearest[0].i].xy];
  else{
    const bandwidth=Math.max(nearest[Math.min(7,nearest.length-1)].distance,1e-8);let sum=0;
    for(const item of nearest){const w=Math.exp(-(item.distance-nearest[0].distance)/bandwidth)/(item.distance+1e-6),p=atlas.points[item.i];sum+=w;xy[0]+=w*p.xy[0];xy[1]+=w*p.xy[1];}
    xy=xy.map(v=>v/sum);
  }
  return {xy,distance:Math.sqrt(nearest[0].distance),covered:Math.sqrt(nearest[0].distance)<=atlas.projection.coverageRadius};
}

export function insidePolygon(point,polygon){let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const [x,y]=polygon[i],[u,v]=polygon[j];
    if((y>point[1])!==(v>point[1])&&point[0]<(u-x)*(point[1]-y)/(v-y)+x)inside=!inside;
  }return inside;
}
