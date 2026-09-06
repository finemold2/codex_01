import { createGLContext } from '/js/core/gl.js';
import { Sky } from '/js/render/sky.js';

export default async function run({ canvas }) {
  const out = { notes: [] };
  const gl = createGLContext(canvas, {});
  const sky = new Sky(gl, { quality: { name: 'high' }, hdr: { width: 320, height: 180 } });
  const f = (a) => Array.from(a).map((v) => v.toFixed(3)).join(', ');
  for (const h of [12, 18.5, 19.5, 21, 0, 3]) {
    sky.setTimeOfDay(h);
    sky.update(1 / 60, 0);
    out.notes.push(`h=${String(h).padEnd(4)} sunI=${sky.sunIntensity.toFixed(3)} night=${sky.nightFactor.toFixed(2)} ambSky=[${f(sky.ambientSky)}] ambGround=[${f(sky.ambientGround)}] fog=[${f(sky.fogColor)}]`);
  }
  return out;
}
