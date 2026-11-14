// Start physics and model loading without waiting for the Three.js dependency graph.
// Keep transferred scene buffers and early status messages until the view is ready.
const messages=[],probeMode=new URLSearchParams(location.search).get('startup-test');
if(probeMode)import('./startup-diagnostics.js').catch(()=>{});
function failed(error){
  const message=String(error?.message??error),loading=document.getElementById('loading');
  const title=document.getElementById('loading-title'),detail=document.getElementById('loading-detail');
  if(title)title.textContent='Unable to load the demo';
  if(detail)detail.textContent=`${message}. Reload to try again.`;
  if(loading)loading.dataset.error=message;
  const progress=document.getElementById('loading-progress');if(progress)progress.hidden=true;
  const notice=document.getElementById('runtime-error');if(notice){notice.textContent=message;notice.hidden=false;}
}
try{
  const workerURL=new URL('./worker.js?v=20261113-online',import.meta.url);
  if(probeMode)workerURL.searchParams.set('startup-test',probeMode);
  const worker=new Worker(workerURL,{type:'module'});
  worker.onmessage=event=>messages.push({type:'message',event});
  worker.onerror=event=>messages.push({type:'error',event});
  let attached=false;
  window.echoStartup={worker,startedAt:performance.now(),attach(onMessage,onError){
    if(attached)return;
    attached=true;worker.onmessage=onMessage;worker.onerror=onError;
    // JavaScript runs this handoff atomically: new Worker events cannot interleave.
    for(const {type,event} of messages.splice(0)){if(type==='message')onMessage(event);else onError(event);}
  }};
  const options=new URLSearchParams(location.search);
  worker.postMessage({type:'init',cpuBudget:navigator.hardwareConcurrency||1,baseline:false,threads:[1,2,4].includes(Number(options.get('threads')))?Number(options.get('threads')):0});
  import('./app.js?v=20261113-online').catch(error=>{worker.terminate();failed(error);});
}catch(error){failed(error);}
