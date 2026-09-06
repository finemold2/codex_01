import { Game } from '/js/game.js';
function buildDom(){const mk=(id,cls)=>{let el=document.getElementById(id);if(!el){el=document.createElement('div');el.id=id;document.body.appendChild(el);}if(cls)el.className=cls;return el;};
const loading=mk('loading-screen');const fill=document.createElement('div');fill.id='load-fill';loading.appendChild(fill);
const status=document.createElement('p');status.id='load-status';loading.appendChild(status);
const tip=document.createElement('p');tip.id='load-tip';loading.appendChild(tip);
const fatal=mk('fatal','hidden');const fatalMsg=document.createElement('p');fatalMsg.id='fatal-msg';fatal.appendChild(fatalMsg);
return{hudRoot:mk('hud-root','layer'),menuRoot:mk('menu-root','layer'),mapRoot:mk('map-root','layer hidden'),loading,loadFill:fill,loadStatus:status,loadTip:tip,fatal,fatalMsg};}
export default async function run({canvas}){
  const out={notes:[],trace:[]};
  const dom=buildDom();dom.canvas=canvas;
  const game=new Game(canvas,dom);await game.init(()=>{});
  game.startNewGame({skipPointerLock:true});
  const P=game.police;
  const sp=game.city.spawns.missionPoints[2];
  game.player.reset(sp.x,game.worldToGround(sp.x,sp.z)+0.1,sp.z,0);
  for(let i=0;i<120;i++)game.update(1/60);
  P.addWanted(3,'t');
  let minD=1e9;
  for(let i=0;i<60*60;i++){
    game.update(1/60);
    const p=game.player.position;
    if(i%150===0){
      const rows=P.cars.map(u=>{const v=u.vehicle;if(!v)return 'novehicle';
        const d=Math.hypot(v.position[0]-p[0],v.position[2]-p[2]);
        const sped=Math.hypot(v.velocity[0],v.velocity[2]);
        return `${u.state} d=${d.toFixed(0)} sp=${sped.toFixed(1)} thr=${v.input.throttle.toFixed(2)} brk=${v.input.brake.toFixed(2)} str=${v.input.steer.toFixed(2)} lane=${u.laneId} stuck=${u.stuck.toFixed(1)} age=${u.age.toFixed(0)}`;});
      out.trace.push(`f=${i} vis=${P.playerVisible} search=${P.searching}/${P.searchTimer.toFixed(0)} w=${P.wanted} cars=${P.cars.length} cops=${P.cops.length} | ${rows.join(' || ')}`);
    }
    for(const u of P.cars){const v=u.vehicle;if(!v)continue;
      const d=Math.hypot(v.position[0]-p[0],v.position[2]-p[2]); if(d<minD)minD=d;}
  }
  out.notes.push(`min cruiser distance over 60s: ${minD.toFixed(1)} m; cops=${P.cops.length}; wanted=${P.wanted}`);
  return out;
}
