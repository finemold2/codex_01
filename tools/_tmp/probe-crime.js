import { Game } from '/js/game.js';
function buildDom(){const mk=(id,cls)=>{let el=document.getElementById(id);if(!el){el=document.createElement('div');el.id=id;document.body.appendChild(el);}if(cls)el.className=cls;return el;};
const loading=mk('loading-screen');const fill=document.createElement('div');fill.id='load-fill';loading.appendChild(fill);
const status=document.createElement('p');status.id='load-status';loading.appendChild(status);
const tip=document.createElement('p');tip.id='load-tip';loading.appendChild(tip);
const fatal=mk('fatal','hidden');const fatalMsg=document.createElement('p');fatalMsg.id='fatal-msg';fatal.appendChild(fatalMsg);
return{hudRoot:mk('hud-root','layer'),menuRoot:mk('menu-root','layer'),mapRoot:mk('map-root','layer hidden'),loading,loadFill:fill,loadStatus:status,loadTip:tip,fatal,fatalMsg};}
export default async function run({canvas}){
  const out={notes:[],crimes:[]};
  const dom=buildDom();dom.canvas=canvas;
  const game=new Game(canvas,dom);await game.init(()=>{});
  game.startNewGame({skipPointerLock:true});
  const P=game.police;
  const rc=P.reportCrime.bind(P);
  P.reportCrime=function(kind,pos){
    if(out.crimes.length<60) out.crimes.push(`f=${game.time.frame} ${kind} w=${this.wanted} @${new Error().stack.split('\n').slice(1,5).map(s=>s.trim().replace(/https?:\/\/[^ )]*\//g,'')).join(' <- ')}`);
    return rc(kind,pos);
  };
  const kp = game.peds.killPed.bind(game.peds);
  let kills=0;
  game.peds.killPed=function(ped,dir,att,hs){kills++;return kp(ped,dir,att,hs);};
  const sp=game.city.spawns.missionPoints[2];
  game.player.reset(sp.x,game.worldToGround(sp.x,sp.z)+0.1,sp.z,0);
  for(let i=0;i<120;i++)game.update(1/60);
  out.notes.push(`before addWanted: w=${P.wanted} pedKills=${kills}`);
  P.addWanted(3,'t');
  for(let i=0;i<60*40;i++)game.update(1/60);
  out.notes.push(`after 40s: w=${P.wanted} pedKills=${kills} playerKills=${game.player.kills}`);
  return out;
}
