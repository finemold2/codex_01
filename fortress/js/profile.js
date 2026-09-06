'use strict';
/* profile.js — 크레딧 지갑 · 인벤토리 · 전적 · 진행(런) 상태
 * localStorage 에 저장되며, 저장이 막힌 브라우저에서도 메모리로 동작합니다.
 */
const Profile = (() => {
  const KEY = 'fortress.profile.v1';
  const INV_MAX = 10;
  const MOD_MAX = 4;      // 영구 장착 모듈 슬롯

  const DEFAULT = {
    credits: 350,
    inventory: [],
    modules: [],
    stats: { matches: 0, wins: 0, kills: 0, damage: 0, bestEndless: 0, credits: 0 },
    run: null,
    shop: null,
  };

  /** 예전 저장본(문자열 id)도 인스턴스로 바꿔 받아줍니다 */
  function normalizeItem(v) {
    if (typeof v === 'string') {
      const def = ITEMS[v];
      return def ? { id: v, roll: 1, price: def.price } : null;
    }
    if (v && v.id && ITEMS[v.id]) {
      const out = { id: v.id, roll: typeof v.roll === 'number' ? v.roll : 1, price: typeof v.price === 'number' ? v.price : ITEMS[v.id].price };
      if (v.perm) out.perm = true;
      return out;
    }
    return null;
  }

  let data = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT));
      const d = JSON.parse(raw);
      const base = JSON.parse(JSON.stringify(DEFAULT));
      return {
        credits: typeof d.credits === 'number' ? d.credits : base.credits,
        inventory: Array.isArray(d.inventory) ? d.inventory.map(normalizeItem).filter(Boolean).slice(0, INV_MAX) : [],
        modules: Array.isArray(d.modules) ? d.modules.map(normalizeItem).filter(Boolean).slice(0, MOD_MAX) : [],
        stats: Object.assign(base.stats, d.stats || {}),
        run: d.run || null,
        shop: d.shop || null,
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT));
    }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 저장 불가 */ }
  }

  /* ───────── 진행 모드 ───────── */

  const MODES = {
    single: { id: 'single', label: '단판', total: 1, desc: '한 판만 겨룹니다.' },
    camp3: { id: 'camp3', label: '3판 원정', total: 3, desc: '세 판을 연달아 이겨야 완주입니다.' },
    camp5: { id: 'camp5', label: '5판 원정', total: 5, desc: '다섯 판 원정. 판마다 적이 강해집니다.' },
    endless: { id: 'endless', label: '무한 모드', total: Infinity, desc: '질 때까지 계속됩니다. 최고 기록에 도전하세요.' },
  };

  /** 스테이지(0부터)별 적 강화 */
  function scaling(stage) {
    return {
      hp: 1 + stage * 0.09,
      dmg: 1 + stage * 0.055,
      tier: stage >= 8 ? 2 : stage >= 4 ? 1 : 0,   // 난이도 상승 단계
    };
  }

  function tierUp(base, tier) {
    const order = ['easy', 'normal', 'hard'];
    const i = Math.min(order.length - 1, Math.max(0, order.indexOf(base)) + tier);
    return order[i];
  }

  /* ───────── 보상 계산 ───────── */

  /**
   * 판이 끝났을 때 크레딧 산정.
   * @returns { total, lines: [[라벨, 값]], won }
   */
  function reward(game, myTank, opts) {
    opts = opts || {};
    const won = !!(myTank && myTank.team === game.winnerTeam);
    const lines = [];
    let sum = 0;
    const add = (label, v) => { if (v) { lines.push([label, Math.round(v)]); sum += v; } };

    add('참전 수당', 45);
    if (won) add('승리 보너스', 150);
    if (myTank) {
      add(`격파 ${myTank.kills}대`, myTank.kills * 50);
      add('누적 피해', myTank.damageDealt * 0.35);
      const hpFrac = Math.max(0, myTank.hp / myTank.maxHp);
      if (myTank.alive) add('생존 (남은 체력)', hpFrac * 70);
      const rate = myTank.shots ? myTank.hits / myTank.shots : 0;
      add(`명중률 ${Math.round(rate * 100)}%`, rate * 60);
    }
    if (won) add('속전속결', Math.max(0, 15 - game.round) * 8);
    if (opts.stage) add(`${opts.stage + 1}판째 보너스`, opts.stage * 30);
    if (game.bonusCredits) add('전리품', game.bonusCredits);

    const diffMul = { easy: 0.75, normal: 1, hard: 1.35 }[game.difficulty] || 1;
    if (diffMul !== 1) {
      const d = sum * (diffMul - 1);
      lines.push([`난이도 ×${diffMul}`, Math.round(d)]);
      sum += d;
    }

    const itemMul = (myTank && myTank.buffs.credit) || 1;
    if (itemMul !== 1) {
      const d = sum * (itemMul - 1);
      lines.push([`아이템 ×${itemMul.toFixed(2)}`, Math.round(d)]);
      sum += d;
    }

    if (!won) {
      const keep = (myTank && myTank.buffs.insurance) || 0.4;
      const d = sum * (keep - 1);
      lines.push([keep > 0.4 ? `패배 (보험 ${Math.round(keep * 100)}%)` : '패배', Math.round(d)]);
      sum += d;
    }

    return { total: Math.max(0, Math.round(sum)), lines, won };
  }

  /* ───────── 공개 API ───────── */

  return {
    MODES, scaling, tierUp, INV_MAX, MOD_MAX,

    get credits() { return data.credits; },
    get inventory() { return data.inventory; },
    get modules() { return data.modules; },
    get stats() { return data.stats; },
    get run() { return data.run; },
    get shop() { return data.shop; },

    addCredits(n) { data.credits = Math.max(0, data.credits + Math.round(n)); data.stats.credits += Math.max(0, Math.round(n)); save(); },
    spend(n) {
      if (data.credits < n) return false;
      data.credits -= n; save(); return true;
    },
    canHold() { return data.inventory.length < INV_MAX; },
    addItem(inst) {
      const it = normalizeItem(inst);
      if (!it || data.inventory.length >= INV_MAX) return false;
      data.inventory.push(it); save(); return true;
    },
    removeItem(i) {
      if (i < 0 || i >= data.inventory.length) return null;
      const it = data.inventory.splice(i, 1)[0];
      save();
      return it;
    },
    /** 전투에 들고 나간 아이템을 인벤토리에서 제거 (영구 모듈은 남습니다) */
    consumeAll() { data.inventory = []; save(); },

    canInstall() { return data.modules.length < MOD_MAX; },
    installModule(inst) {
      const it = normalizeItem(inst);
      if (!it || data.modules.length >= MOD_MAX) return false;
      it.perm = true;
      data.modules.push(it); save(); return true;
    },
    removeModule(i) {
      if (i < 0 || i >= data.modules.length) return null;
      const it = data.modules.splice(i, 1)[0];
      save();
      return it;
    },

    setShop(stock) { data.shop = stock ? { stock } : null; save(); },
    setRun(run) { data.run = run; save(); },

    recordMatch(game, myTank, won) {
      data.stats.matches++;
      if (won) data.stats.wins++;
      if (myTank) { data.stats.kills += myTank.kills; data.stats.damage += myTank.damageDealt; }
      save();
    },
    recordEndless(stage) {
      if (stage > data.stats.bestEndless) { data.stats.bestEndless = stage; save(); }
    },
    reward,
    resetAll() { data = JSON.parse(JSON.stringify(DEFAULT)); save(); },
  };
})();
