import { Game } from '/js/game.js';
function buildDom(){const mk=(id,cls)=>{let el=document.getElementById(id);if(!el){el=document.createElement('div');el.id=id;document.body.appendChild(el);}if(cls)el.className=cls;return el;};
const loading=mk('loading-screen');const fill=document.createElement('div');fill.id='load-fill';loading.appendChild(fill);
const status=document.createElement('p');status.id='load-status';loading.appendChild(status);
const tip=document.createElement('p');tip.id='load-tip';loading.appendChild(tip);
const fatal=mk('fatal','hidden');const fatalMsg=document.createElement('p');fatalMsg.id='fatal-msg';fatal.appendChild(fatalMsg);
return{hudRoot:mk('hud-root','layer'),menuRoot:mk('menu-root','layer'),mapRoot:mk('map-root','layer hidden'),loading,loadFill:fill,loadStatus:status,loadTip:tip,fatal,fatalMsg};}
export default async function run({canvas}){
  const out={notes:[],history:[]};
  const dom=buildDom();dom.canvas=canvas;
  const game=new Game(canvas,dom);await game.init(()=>{});
  game.startNewGame({skipPointerLock:true});
  const T=game.traffic;
  const ring=new Map();  // vehicle -> ring buffer
  let captured=null;
  for(let f=0;f<60*70 && !captured;f++){
    game.update(1/60);
    for(const v of T.vehicles){
      const ai=v.ai; if(!ai) continue;
      let r=ring.get(v); if(!r){r=[];ring.set(v,r);}
      const off=Math.sqrt((T.lanes.project(ai.laneId,v.position[0],v.position[2]),T.lanes.projDist2));
      const sp=Math.hypot(v.velocity[0],v.velocity[2]);
      r.push(`f=${f} p=[${v.position[0].toFixed(1)},${v.position[2].toFixed(1)}] yaw=${v.yaw.toFixed(2)} sp=${sp.toFixed(1)} off=${off.toFixed(1)} lane=${ai.laneId} kind=${(T.city.lanes[ai.laneId]||{}).kind} ld=${ai.laneDist.toFixed(1)}/${T.lanes.length(ai.laneId).toFixed(1)} rt=${Array.from(ai.route.slice(0,ai.routeLen)).join(',')} str=${v.input.steer.toFixed(2)} thr=${v.input.throttle.toFixed(2)} stuck=${ai.stuck.toFixed(1)} lost=${ai.lost.toFixed(1)} swerve=${ai.swerve.toFixed(1)} crash=${ai.crash.toFixed(1)}`);
      if(r.length>260) r.shift();
      if(f>600 && sp<0.25 && off>5){
        const yaw=v.yaw,fx=-Math.sin(yaw),fz=-Math.cos(yaw);
        const h=game.collision.raycast([v.position[0]+fx*2.6,v.position[1],v.position[2]+fz*2.6],[fx,0,fz],3,null);
        if(h&&h.body&&h.body.tag==='building'){ captured=r.slice(-240); break; }
      }
    }
  }
  out.notes.push(captured?`captured ${captured.length} ticks`:'none captured');
  out.history=captured?captured.filter((_,i)=>i%6===0):[];
  return out;
}
