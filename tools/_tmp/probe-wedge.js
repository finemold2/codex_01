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
  const P=game.police;
  const sp=game.city.spawns.missionPoints[2];
  game.player.reset(sp.x,game.worldToGround(sp.x,sp.z)+0.1,sp.z,0);
  for(let i=0;i<120;i++)game.update(1/60);
  P.addWanted(3,'t');
  for(let i=0;i<60*35;i++)game.update(1/60);
  const p=game.player.position;
  const describe=(v,tag)=>{
    const yaw=v.yaw, fx=-Math.sin(yaw), fz=-Math.cos(yaw);
    const o=[v.position[0]+fx*2.6, v.position[1], v.position[2]+fz*2.6];
    const h=game.collision.raycast(o,[fx,0,fz],8,null);
    let nearest='none';
    if(h) nearest=`${h.body&&h.body.tag}@${h.t.toFixed(1)}`;
    const bodies=game.collision.querySphere(v.position[0],v.position[1],v.position[2],4,[]);
    const tags={}; for(const b of bodies) tags[b.tag]=(tags[b.tag]||0)+1;
    // nearby vehicles
    let nv=0; for(const o2 of game.vehicles){ if(o2===v) continue;
      const d=Math.hypot(o2.position[0]-v.position[0],o2.position[2]-v.position[2]); if(d<6) nv++; }
    const wheelContact = v.wheels ? v.wheels.map(w=>w.contact?1:0).join('') : '?';
    const ground = game.worldToGround(v.position[0],v.position[2]);
    return `${tag} d=${Math.hypot(v.position[0]-p[0],v.position[2]-p[2]).toFixed(0)} pos=[${v.position.map(n=>n.toFixed(1)).join(',')}] ground=${ground.toFixed(2)} pitch=${(v.pitch||0).toFixed(2)} roll=${(v.roll||0).toFixed(2)} wheels=${wheelContact} fwdRay=${nearest} near=${JSON.stringify(tags)} nearVeh=${nv} sp=${Math.hypot(v.velocity[0],v.velocity[2]).toFixed(2)} thr=${v.input.throttle.toFixed(2)} rpm=${(v.rpm||0).toFixed(0)} gear=${v.gear} destroyed=${v.isDestroyed} hp=${(v.health||0).toFixed(0)}`;
  };
  for(const u of P.cars){ const v=u.vehicle; if(!v) continue;
    out.notes.push(describe(v, `unit state=${u.state} lane=${u.laneId} stuck=${u.stuck.toFixed(1)} noProg=${u.noProgress.toFixed(1)} best=${u.bestDist.toFixed(0)}`)); }
  // also a couple of stuck traffic cars
  let k=0;
  for(const v of game.traffic.vehicles){
    if(Math.hypot(v.velocity[0],v.velocity[2])>0.3) continue;
    out.notes.push(describe(v,`traffic stuck=${v.ai.stuck.toFixed(1)}`)); if(++k>=4) break; }
  out.notes.push(`wanted=${P.wanted} cars=${P.cars.length} cops=${P.cops.length}`);
  return out;
}
