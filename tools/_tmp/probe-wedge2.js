import { Game } from '/js/game.js';
function buildDom(){const mk=(id,cls)=>{let el=document.getElementById(id);if(!el){el=document.createElement('div');el.id=id;document.body.appendChild(el);}if(cls)el.className=cls;return el;};
const loading=mk('loading-screen');const fill=document.createElement('div');fill.id='load-fill';loading.appendChild(fill);
const status=document.createElement('p');status.id='load-status';loading.appendChild(status);
const tip=document.createElement('p');tip.id='load-tip';loading.appendChild(tip);
const fatal=mk('fatal','hidden');const fatalMsg=document.createElement('p');fatalMsg.id='fatal-msg';fatal.appendChild(fatalMsg);
return{hudRoot:mk('hud-root','layer'),menuRoot:mk('menu-root','layer'),mapRoot:mk('map-root','layer hidden'),loading,loadFill:fill,loadStatus:status,loadTip:tip,fatal,fatalMsg};}
export default async function run({canvas}){
  const out={notes:[]};
  const dom=buildDom();dom.canvas=canvas;
  const game=new Game(canvas,dom);await game.init(()=>{});
  game.startNewGame({skipPointerLock:true});
  const T=game.traffic;
  const report=(tag)=>{
    let offNet=0,wall=0,lightStop=0,queue=0,other=0,moving=0;
    const samples=[];
    for(const v of T.vehicles){
      const ai=v.ai; if(!ai) continue;
      const s=Math.hypot(v.velocity[0],v.velocity[2]);
      if(s>0.3){moving++;continue;}
      const yaw=v.yaw,fx=-Math.sin(yaw),fz=-Math.cos(yaw);
      const h=game.collision.raycast([v.position[0]+fx*2.6,v.position[1],v.position[2]+fz*2.6],[fx,0,fz],3,null);
      const off=Math.sqrt(T.lanes.project(ai.laneId,v.position[0],v.position[2])>=0?T.lanes.projDist2:0);
      const lane=T.city.lanes[ai.laneId];
      const tl=lane?T._lightFor(lane.toNode):null;
      const stopDist=lane?T.lanes.length(ai.laneId)-ai.laneDist:99;
      const lead=T._leadGap(v,v.position[0],v.position[2],fx,fz);
      if(h&&h.body&&h.body.tag==='building'){wall++; if(samples.length<4) samples.push(`wall off=${off.toFixed(1)} idle=${ai.idle.toFixed(0)} stuck=${ai.stuck.toFixed(1)} lost=${ai.lost.toFixed(1)}`);}
      else if(off>6){offNet++; if(samples.length<4) samples.push(`offnet off=${off.toFixed(1)} idle=${ai.idle.toFixed(0)} stuck=${ai.stuck.toFixed(1)}`);}
      else if(lead>=0&&lead<4)queue++;
      else if(tl&&stopDist<40)lightStop++;
      else {other++; if(samples.length<6) samples.push(`other off=${off.toFixed(1)} idle=${ai.idle.toFixed(0)} stuck=${ai.stuck.toFixed(1)} lead=${lead.toFixed(1)} tl=${!!tl} sd=${stopDist.toFixed(0)} thr=${v.input.throttle.toFixed(2)} brk=${v.input.brake.toFixed(2)}`);}
    }
    out.notes.push(`${tag}: moving=${moving} wall=${wall} offnet=${offNet} queue=${queue} light=${lightStop} other=${other} | ${samples.join(' ; ')}`);
  };
  for(let k=0;k<18;k++){for(let i=0;i<300;i++)game.update(1/60);report(`t=${(k+1)*5}s`);}
  return out;
}
