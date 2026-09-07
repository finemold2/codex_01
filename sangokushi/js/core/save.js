// ============================================================
//  세이브 / 로드
//  지형은 시드로부터 다시 만들어지므로 가변 상태만 저장한다.
// ============================================================
import { Game, rebuildWorld } from './state.js';
import { RNG } from './rng.js';
import { generateWorld } from './worldgen.js';
import { setOfficerSeq, resetOfficerSeq } from './officergen.js';
import { setItemSeq } from './itemgen.js';

const PREFIX = 'sgk6.save.';
const VERSION = 1;

/** 도시에서 저장할 가변 필드 */
const CITY_FIELDS = [
  'realm', 'agri', 'comm', 'tech', 'flood', 'wall', 'pop', 'maxPop',
  'order', 'loyalty', 'gold', 'food', 'troops', 'train', 'morale',
  'officers', 'items', 'spied', 'famous',
];

export function serialize(g) {
  let maxOff = 0, maxItem = 0;
  for (const o of g.officers) { const n = +String(o.id).slice(1); if (n > maxOff) maxOff = n; }
  for (const it of g.items) { const n = +String(it.uid).slice(2); if (n > maxItem) maxItem = n; }
  return {
    v: VERSION,
    seed: g.seed,
    worldOpt: g.worldOpt,
    rng: g.rng.serialize(),
    year: g.year, month: g.month, turnNo: g.turnNo,
    difficulty: g.difficulty,
    playerRealm: g.playerRealm, playerOfficer: g.playerOfficer,
    gameOver: g.gameOver,
    officers: g.officers,
    realms: g.realms,
    items: g.items,
    freeOfficers: g.freeOfficers,
    playerAttacks: g.playerAttacks || [],
    log: g.log.slice(-320),
    cities: g.cities.map(c => {
      const o = { id: c.id };
      for (const f of CITY_FIELDS) o[f] = c[f];
      if (c.resource) o.resourceId = c.resource.id;
      return o;
    }),
    seq: { officer: maxOff, item: maxItem },
    usedNames: Array.from(g.world.registry.used),
  };
}

export function deserialize(data) {
  if (!data || data.v !== VERSION) throw new Error('저장 형식이 다르다');
  const g = Object.create(Game.prototype);
  g.seed = data.seed;
  g.opt = { worldOpt: data.worldOpt };
  g.worldOpt = data.worldOpt;
  g.difficulty = data.difficulty ?? 2;

  // 지형은 시드에서 그대로 다시 만든다
  g.world = rebuildWorld(data.seed, data.worldOpt);
  g.cities = g.world.cities;
  g.cityById = Object.fromEntries(g.cities.map(c => [c.id, c]));
  g.provinces = g.world.provinces;
  for (const saved of data.cities) {
    const c = g.cityById[saved.id];
    if (!c) continue;
    for (const f of CITY_FIELDS) if (saved[f] !== undefined) c[f] = saved[f];
  }
  // 이름 중복 방지 레지스트리 복원
  g.world.registry.used = new Set(data.usedNames || []);

  // 난수 상태 복원
  g.rng = RNG.deserialize(data.rng);

  g.year = data.year; g.month = data.month; g.turnNo = data.turnNo;
  g.officers = data.officers;
  g.officerById = Object.fromEntries(g.officers.map(o => [o.id, o]));
  g.realms = data.realms;
  g.realmById = Object.fromEntries(g.realms.map(r => [r.id, r]));
  g.items = data.items;
  g.itemById = Object.fromEntries(g.items.map(i => [i.uid, i]));
  g.freeOfficers = data.freeOfficers || [];
  g.playerAttacks = data.playerAttacks || [];
  g.playerRealm = data.playerRealm;
  g.playerOfficer = data.playerOfficer;
  g.gameOver = data.gameOver || null;
  g.log = data.log || [];
  g.pendingBattle = null;

  setOfficerSeq((data.seq?.officer || 0) + 1);
  setItemSeq((data.seq?.item || 0) + 1);
  return g;
}

export function saveGame(slot, g, label) {
  const data = serialize(g);
  const wrapped = {
    label: label || `${g.year}년`,
    date: new Date().toLocaleString('ko-KR'),
    data,
  };
  const json = JSON.stringify(wrapped);
  try {
    localStorage.setItem(PREFIX + slot, json);
  } catch (e) {
    throw new Error('저장 공간이 부족하다 (' + Math.round(json.length / 1024) + 'KB)');
  }
  return true;
}

export function loadGame(slot) {
  const raw = localStorage.getItem(PREFIX + slot);
  if (!raw) throw new Error('기록이 없다');
  const wrapped = JSON.parse(raw);
  return deserialize(wrapped.data);
}

export function listSaves() {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const raw = localStorage.getItem(PREFIX + i);
    if (!raw) { out.push(null); continue; }
    try {
      const w = JSON.parse(raw);
      out.push({ label: w.label, date: w.date, size: raw.length });
    } catch (e) { out.push(null); }
  }
  return out;
}

export function deleteSave(slot) { localStorage.removeItem(PREFIX + slot); }
