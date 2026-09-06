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
  const trial=(idx)=>{
    P.clearWanted();
    game.missions.abort && game.missions.abort();
    for(let i=0;i<60;i++)game.update(1/60);
    const s=game.city.spawns.peds[(idx*97)%game.city.spawns.peds.length];
    game.player.reset(s.x, game.worldToGround(s.x,s.z)+0.1, s.z, 0);
    game.player.invincible = true;
    for(let i=0;i<90;i++)game.update(1/60);
    P.clearWanted();
    P.addWanted(3,'test');
    const busts0=P.busts;
    let near=-1, cop=-1, bust=-1, minD=1e9, visFrames=0;
    for(let i=0;i<60*70;i++){
      game.update(1/60);
      if(P.playerVisible) visFrames++;
      const p=game.player.position;
      for(const u of P.cars){const v=u.vehicle;if(!v)continue;
        const d=Math.hypot(v.position[0]-p[0],v.position[2]-p[2]);
        if(d<minD)minD=d;
        if(near<0&&d<30)near=i;}
      if(cop<0&&P.cops.length>0)cop=i;
      if(P.busts>busts0){bust=i;break;}
      if(P.wanted===0)break;
    }
    out.notes.push(`trial${idx}: firstCruiser<30m ${near<0?'never':(near/60).toFixed(1)+'s'}, firstCop ${cop<0?'never':(cop/60).toFixed(1)+'s'}, busted ${bust<0?'no':(bust/60).toFixed(1)+'s'}, minDist ${minD.toFixed(0)}m, visible ${(visFrames/60).toFixed(0)}s, wanted=${P.wanted}`);
    game.player.invincible = false;
  };
  for(let k=0;k<5;k++) trial(k);
  P.clearWanted();
  for(let i=0;i<120;i++)game.update(1/60);
  out.notes.push(`after clearWanted: cars=${P.cars.length} cops=${P.cops.length} heli=${!!P.helicopter} wanted=${P.wanted}`);
  return out;
}
