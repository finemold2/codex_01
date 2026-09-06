import { Game } from '/js/game.js';
function buildDom(){const mk=(id,cls)=>{let el=document.getElementById(id);if(!el){el=document.createElement('div');el.id=id;document.body.appendChild(el);}if(cls)el.className=cls;return el;};
const loading=mk('loading-screen');const fill=document.createElement('div');fill.id='load-fill';loading.appendChild(fill);
const status=document.createElement('p');status.id='load-status';loading.appendChild(status);
const tip=document.createElement('p');tip.id='load-tip';loading.appendChild(tip);
const fatal=mk('fatal','hidden');const fatalMsg=document.createElement('p');fatalMsg.id='fatal-msg';fatal.appendChild(fatalMsg);
return{hudRoot:mk('hud-root','layer'),menuRoot:mk('menu-root','layer'),mapRoot:mk('map-root','layer hidden'),loading,loadFill:fill,loadStatus:status,loadTip:tip,fatal,fatalMsg};}
export default async function run({canvas}){
  const out={notes:[],log:[]};
  const dom=buildDom();dom.canvas=canvas;
  const game=new Game(canvas,dom);await game.init(()=>{});
  const P=game.police;
  const aw=P.addWanted.bind(P);
  P.addWanted=function(a,r){
    if(out.log.length<40) out.log.push(`ADDWANTED f=${game.time.frame} amt=${a} reason=${r} w=${this.wanted} @${new Error().stack.split('\n').slice(2,6).map(s=>s.trim().replace(/https?:\/\/[^ )]*\//g,'')).join(' <- ')}`);
    return aw(a,r);
  };
  const rc=P.reportCrime.bind(P);
  P.reportCrime=function(k,p){
    if(out.log.length<40) out.log.push(`CRIME f=${game.time.frame} ${k} w=${this.wanted} @${new Error().stack.split('\n').slice(2,6).map(s=>s.trim().replace(/https?:\/\/[^ )]*\//g,'')).join(' <- ')}`);
    return rc(k,p);
  };
  game.startNewGame({skipPointerLock:true});
  for(let i=0;i<600;i++)game.update(1/60);
  out.notes.push(`w after 10s idle: ${P.wanted}`);
  return out;
}
