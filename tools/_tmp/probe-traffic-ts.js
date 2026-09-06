import { Game } from '/js/game.js';
function buildDom() {
  const mk = (id, cls) => { let el = document.getElementById(id);
    if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
    if (cls) el.className = cls; return el; };
  const loading = mk('loading-screen');
  const fill = document.createElement('div'); fill.id='load-fill'; loading.appendChild(fill);
  const status = document.createElement('p'); status.id='load-status'; loading.appendChild(status);
  const tip = document.createElement('p'); tip.id='load-tip'; loading.appendChild(tip);
  const fatal = mk('fatal','hidden'); const fatalMsg = document.createElement('p'); fatalMsg.id='fatal-msg'; fatal.appendChild(fatalMsg);
  return { hudRoot: mk('hud-root','layer'), menuRoot: mk('menu-root','layer'), mapRoot: mk('map-root','layer hidden'),
    loading, loadFill: fill, loadStatus: status, loadTip: tip, fatal, fatalMsg };
}
export default async function run({ canvas }) {
  const out = { notes: [], series: [] };
  const dom = buildDom(); dom.canvas = canvas;
  const game = new Game(canvas, dom); await game.init(()=>{});
  game.startNewGame({ skipPointerLock: true });
  const T = game.traffic;
  const snap = (tag) => {
    let n=0,sum=0,stopped=0; const why={lead:0,light:0,haz:0,yield:0,stuck:0,free:0};
    for (const v of T.vehicles) { const ai=v.ai; if(!ai) continue; n++;
      const s=Math.hypot(v.velocity[0],v.velocity[2]); sum+=s; if(s<0.3){stopped++;
        const x=v.position[0],z=v.position[2],yaw=v.yaw,fx=-Math.sin(yaw),fz=-Math.cos(yaw);
        const lead=T._leadGap(v,x,z,fx,fz);
        const hz=T._hazardLimit(v,ai,x,z,fx,fz,v.forwardSpeed);
        const lane=T.city.lanes[ai.laneId]; const tl=lane?T._lightFor(lane.toNode):null;
        const stopDist = lane? T.lanes.length(ai.laneId)-ai.laneDist : 99;
        const axis = 'x';
        if (ai.stuck>1) why.stuck++;
        else if (lead>=0 && lead-2.6<=0.6) why.lead++;
        else if (hz<1) why.haz++;
        else if (tl && stopDist<40) why.light++;
        else if (lane && !tl && stopDist<24) why.yield++;
        else why.free++;
      }}
    out.series.push(`${tag}: n=${n} mean=${(sum/Math.max(1,n)).toFixed(2)} stopped=${stopped} why=${JSON.stringify(why)}`);
  };
  for (let k=0;k<12;k++){ for(let i=0;i<300;i++) game.update(1/60); snap(`t=${(k*5+5)}s`); }
  // now teleport the player like the soak does
  const spots = game.city.spawns.missionPoints;
  for (let k=0;k<6;k++){
    const p = spots[k % spots.length];
    game.player.reset(p.x, game.worldToGround(p.x,p.z)+0.1, p.z, 0);
    for(let i=0;i<300;i++) game.update(1/60); snap(`tp${k} t=${(60+k*5+5)}s`);
  }
  return out;
}
