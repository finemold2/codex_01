/**
 * Browser-side contract checker: imports every game module and verifies that the exports and
 * instance methods promised by docs/ARCHITECTURE.md actually exist.
 *
 * Run with:  node tools/gl-probe.mjs tools/contract-check.js
 */

const REQUIRED = {
  '/js/core/math.js': ['clamp', 'lerp', 'smoothstep', 'damp', 'wrapAngle', 'angleLerp', 'angleDamp',
    'moveTowards', 'vec2', 'vec3', 'vec4', 'quat', 'mat3', 'mat4', 'aabb', 'Rand'],
  '/js/core/gl.js': ['createGLContext', 'Shader', 'GpuMesh', 'Texture2D', 'RenderTarget', 'drawFullscreen'],
  '/js/core/geometry.js': ['box', 'roundedBox', 'plane', 'sphere', 'cylinder', 'cone', 'capsule',
    'torus', 'wedge', 'extrudePolygon', 'polygonFan', 'tube', 'quadStrip', 'transformGeometry',
    'translateGeometry', 'scaleGeometry', 'colorizeGeometry', 'mergeGeometries', 'computeBounds',
    'computeNormals', 'geometryTriangleCount'],
  '/js/core/input.js': ['Input'],
  '/js/render/renderer.js': ['Renderer', 'Camera'],
  '/js/render/materials.js': ['createMaterial'],
  '/js/render/shaders.js': [],
  '/js/render/sky.js': ['Sky'],
  '/js/render/postfx.js': ['PostFX'],
  '/js/render/particles.js': ['ParticleSystem'],
  '/js/render/textures.js': ['buildTextureLibrary', 'makeNoiseCanvas', 'normalMapFromHeight'],
  '/js/world/citygen.js': ['generateCity', 'laneAt', 'walkAt', 'isOnRoad', 'districtAt', 'cityStats'],
  '/js/world/worldbuild.js': ['buildWorld'],
  '/js/world/collision.js': ['CollisionWorld'],
  '/js/entities/character.js': ['Character', 'buildCharacterMeshes', 'BONES'],
  '/js/entities/vehicle.js': ['Vehicle', 'buildVehicleAssets', 'VEHICLE_TYPES'],
  '/js/entities/player.js': ['Player'],
  '/js/entities/ped.js': ['PedManager'],
  '/js/entities/traffic.js': ['TrafficManager'],
  '/js/entities/police.js': ['PoliceSystem'],
  '/js/entities/weapons.js': ['WeaponSystem', 'WEAPONS'],
  '/js/missions.js': ['MissionManager', 'MISSIONS'],
  '/js/audio/audio.js': ['AudioEngine'],
  '/js/audio/sfx.js': ['SFX'],
  '/js/audio/music.js': ['MusicPlayer'],
  '/js/audio/scores.js': ['SCORES', 'STATIONS', 'getScore', 'scoreDurationSeconds'],
  '/js/ui/hud.js': ['HUD'],
  '/js/ui/menu.js': ['Menu'],
  '/js/ui/map.js': ['MapScreen'],
  '/js/game.js': ['Game'],
};

/** Instance/prototype methods the integration layer actually calls. */
const METHODS = {
  '/js/core/input.js': ['Input', ['attach', 'detach', 'update', 'endFrame', 'isDown', 'justPressed',
    'justReleased', 'axis', 'consumeMouseDelta', 'requestPointerLock', 'exitPointerLock',
    'injectKey', 'injectMouseDelta']],
  '/js/render/renderer.js': ['Renderer', ['setQuality', 'resize', 'createMesh', 'addStatic',
    'addInstanced', 'submit', 'submitLight', 'setSun', 'setFog', 'render', 'createMaterial']],
  '/js/world/collision.js': ['CollisionWorld', ['addBox', 'addCylinder', 'remove', 'queryAABB',
    'querySphere', 'moveCapsule', 'sweepSphere', 'raycast', 'groundHeight']],
  '/js/entities/character.js': ['Character', ['setState', 'update', 'getBoneMatrix',
    'getMuzzleOrigin', 'submit', 'playRagdoll']],
  '/js/entities/vehicle.js': ['Vehicle', ['update', 'applyDamage', 'getSeatMatrix',
    'getDoorPosition', 'submit', 'setLights', 'explode']],
  '/js/entities/weapons.js': ['WeaponSystem', ['switchTo', 'nextWeapon', 'prevWeapon', 'tryFire',
    'reload', 'update', 'applyHit']],
  '/js/entities/ped.js': ['PedManager', ['spawnAround', 'update', 'alertGunshot', 'damagePed',
    'raycastPeds']],
  '/js/entities/traffic.js': ['TrafficManager', ['update', 'spawnAround', 'despawnFar', 'alert']],
  '/js/entities/police.js': ['PoliceSystem', ['addWanted', 'clearWanted', 'update']],
  '/js/missions.js': ['MissionManager', ['update', 'start', 'abort', 'complete', 'getAvailable']],
  '/js/audio/audio.js': ['AudioEngine', ['resume', 'setVolume', 'getVolume', 'setListener',
    'createPositional', 'suspend', 'duck']],
  '/js/audio/sfx.js': ['SFX', ['gunshot', 'reload', 'bulletImpact', 'ricochet', 'footstep', 'jump',
    'land', 'punch', 'bodyFall', 'carCollision', 'glassBreak', 'explosion', 'tireScreech', 'horn',
    'doorOpen', 'doorClose', 'pickup', 'uiClick', 'siren', 'wanted', 'missionSuccess',
    'missionFail', 'createEngine', 'ambience']],
  '/js/audio/music.js': ['MusicPlayer', ['play', 'stop', 'pause', 'resume', 'next', 'prev',
    'setStation', 'nextStation', 'update', 'setIntensity']],
  '/js/ui/hud.js': ['HUD', ['show', 'hide', 'update', 'notify', 'subtitle', 'setMissionText',
    'flashDamage', 'showWasted', 'showBusted', 'hideBigMessage', 'setWaypoint']],
  '/js/ui/menu.js': ['Menu', ['showMain', 'showPause', 'showSettings', 'showControls', 'hide',
    'loadSettings', 'saveSettings']],
  '/js/ui/map.js': ['MapScreen', ['toggle', 'show', 'hide', 'update']],
};

export default async function run() {
  const report = { missingModules: [], missingExports: [], missingMethods: [], importErrors: [], ok: [] };

  for (const [path, names] of Object.entries(REQUIRED)) {
    let mod;
    try {
      mod = await import(path);
    } catch (err) {
      report.importErrors.push(`${path}: ${err.message}`);
      continue;
    }
    const missing = names.filter((n) => mod[n] === undefined);
    if (missing.length) report.missingExports.push(`${path}: ${missing.join(', ')}`);
    else report.ok.push(path);

    const spec = METHODS[path];
    if (spec) {
      const [cls, methods] = spec;
      const C = mod[cls];
      if (typeof C === 'function') {
        const absent = methods.filter((m) => typeof C.prototype[m] !== 'function');
        if (absent.length) report.missingMethods.push(`${path} ${cls}: ${absent.join(', ')}`);
      }
    }
  }
  report.summary = {
    modules: Object.keys(REQUIRED).length,
    importErrors: report.importErrors.length,
    exportGaps: report.missingExports.length,
    methodGaps: report.missingMethods.length,
  };
  return report;
}
