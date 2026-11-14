// Projection runs outside both the rendering thread and the control worker.
import {projectLatent} from './atlas-projection.js';
let atlas;
onmessage=({data})=>{
  if(data.type==='init'){atlas=data.atlas;postMessage({type:'ready'});return;}
  if(data.type==='project'){
    const start=performance.now();
    const result=projectLatent(data.latent,atlas);
    postMessage({type:'projection',generation:data.generation,step:data.step,result,elapsedMs:performance.now()-start});
  }
};
