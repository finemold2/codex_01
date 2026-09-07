// ============================================================
//  랜덤 이벤트 엔진
//  매달 조건·가중치에 따라 사건이 일어난다. 천재지변부터
//  인재 등장, 모반, 요괴 소문까지 — 같은 게임은 두 번 없다.
// ============================================================
import { generateItem, makeLegend } from './itemgen.js';
import { generateOfficer } from './officergen.js';
import { compatDistance, DREAMS } from './traits.js';

/**
 * 이벤트 정의
 *  when(g, ctx) → 발생 가능 여부
 *  weight(g, ctx) → 가중치
 *  run(g, ctx) → { text, kind, sfx, bgm, portrait }
 *  scope: 'world' | 'realm' | 'city' | 'officer'
 */
export const EVENTS = [

  // ───────────────────────── 천재지변 ─────────────────────────
  {
    id: 'flood', name: '대홍수', scope: 'city', tag: 'disaster',
    when: (g, c) => c.riverside && [4, 5, 6].includes(g.month),
    weight: (g, c) => 16 * (1 - c.flood / Math.max(1, c.maxFlood)),
    run: (g, c) => {
      const r = g.rng;
      const sev = r.range(15, 45) * (1 - c.flood / Math.max(1, c.maxFlood) * 0.7);
      c.agri = Math.max(0, Math.round(c.agri * (1 - sev / 100)));
      c.food = Math.max(0, Math.round(c.food * (1 - sev / 130)));
      c.pop = Math.round(c.pop * (1 - sev / 400));
      c.loyalty = Math.max(0, c.loyalty - Math.round(sev / 3));
      return { text: `${c.name}에 큰물이 졌다. 전답이 잠기고 백성이 흩어졌다. (농업 -${Math.round(sev)}%)`,
        kind: 'bad', sfx: 'flood', bgm: 'disaster' };
    },
  },
  {
    id: 'drought', name: '가뭄', scope: 'city', tag: 'disaster',
    when: (g, c) => [5, 6, 7].includes(g.month),
    weight: () => 11,
    run: (g, c) => {
      const sev = g.rng.range(12, 38);
      c.agri = Math.max(0, Math.round(c.agri * (1 - sev / 100)));
      c.loyalty = Math.max(0, c.loyalty - Math.round(sev / 4));
      c.food = Math.round(c.food * 0.9);
      return { text: `${c.name} 일대에 비가 오지 않는다. 논밭이 갈라졌다. (농업 -${sev}%)`, kind: 'bad', sfx: 'wind' };
    },
  },
  {
    id: 'locust', name: '황충', scope: 'city', tag: 'disaster',
    when: (g, c) => [5, 6, 7, 8].includes(g.month),
    weight: () => 8,
    run: (g, c) => {
      const sev = g.rng.range(20, 50);
      c.agri = Math.max(0, Math.round(c.agri * (1 - sev / 100)));
      c.food = Math.round(c.food * (1 - sev / 150));
      c.loyalty = Math.max(0, c.loyalty - 8);
      return { text: `${c.name}에 메뚜기 떼가 하늘을 덮었다. 곡식이 남지 않았다. (농업 -${sev}%)`, kind: 'bad', sfx: 'wind', bgm: 'disaster' };
    },
  },
  {
    id: 'plague', name: '역병', scope: 'city', tag: 'disaster',
    when: (g, c) => c.pop > 20000,
    weight: (g, c) => 7 + (c.order < 45 ? 6 : 0),
    run: (g, c) => {
      const offs = g.officersIn(c.id);
      const healer = offs.find(o => o.traits.includes('healer'));
      if (healer) {
        return { text: `${c.name}에 역병이 돌았으나 ${healer.name}이(가) 의술로 막아냈다.`, kind: 'good', sfx: 'confirm', focus: healer.id };
      }
      const dead = g.rng.range(4, 14);
      c.pop = Math.round(c.pop * (1 - dead / 100));
      c.troops = Math.round(c.troops * (1 - dead / 130));
      c.loyalty = Math.max(0, c.loyalty - dead);
      let extra = '';
      if (offs.length && g.rng.percent(16)) {
        const v = g.rng.pick(offs);
        if (v.id !== g.realmById[c.realm]?.ruler || g.rng.percent(40)) {
          killOfficer(g, v, '역병');
          extra = ` ${v.name}이(가) 병으로 세상을 떠났다.`;
        }
      }
      return { text: `${c.name}에 역병이 창궐했다. 인구 -${dead}%.${extra}`, kind: 'bad', sfx: 'plague', bgm: 'disaster' };
    },
  },
  {
    id: 'quake', name: '지진', scope: 'city', tag: 'disaster',
    when: (g, c) => c.mountainous,
    weight: () => 5,
    run: (g, c) => {
      const sev = g.rng.range(10, 32);
      c.wall = Math.max(0, Math.round(c.wall * (1 - sev / 100)));
      c.comm = Math.max(0, Math.round(c.comm * (1 - sev / 160)));
      c.pop = Math.round(c.pop * (1 - sev / 500));
      c.loyalty = Math.max(0, c.loyalty - 6);
      return { text: `${c.name}에 지진이 일어났다. 성벽이 무너졌다. (성벽 -${sev}%)`, kind: 'bad', sfx: 'quake', bgm: 'disaster' };
    },
  },
  {
    id: 'fireCity', name: '대화재', scope: 'city', tag: 'disaster',
    when: (g, c) => true, weight: (g, c) => 6 + (c.order < 40 ? 5 : 0),
    run: (g, c) => {
      const sev = g.rng.range(12, 35);
      c.comm = Math.max(0, Math.round(c.comm * (1 - sev / 100)));
      c.gold = Math.round(c.gold * (1 - sev / 150));
      c.food = Math.round(c.food * (1 - sev / 200));
      return { text: `${c.name} 저잣거리에 불이 났다. 상가가 잿더미가 되었다. (상업 -${sev}%)`, kind: 'bad', sfx: 'fire' };
    },
  },
  {
    id: 'snowstorm', name: '폭설', scope: 'city', tag: 'disaster',
    when: (g, c) => [10, 11, 0, 1].includes(g.month), weight: () => 7,
    run: (g, c) => {
      c.food = Math.round(c.food * 0.90);
      c.troops = Math.round(c.troops * 0.97);
      c.morale = Math.max(0, c.morale - g.rng.range(4, 12));
      return { text: `${c.name}에 폭설이 내렸다. 병사들이 얼어 죽고 병량이 축났다.`, kind: 'bad', sfx: 'wind' };
    },
  },
  {
    id: 'harvest', name: '풍작', scope: 'city', tag: 'blessing',
    when: (g, c) => [7, 8, 9].includes(g.month), weight: (g, c) => 12 + c.flood / Math.max(1, c.maxFlood) * 10,
    run: (g, c) => {
      const bonus = g.rng.range(15, 45);
      const add = Math.round(c.agri * bonus);
      c.food += add;
      c.loyalty = Math.min(100, c.loyalty + g.rng.range(3, 9));
      return { text: `${c.name}에 유례없는 풍작이 들었다. 병량 +${add.toLocaleString()}`, kind: 'good', sfx: 'cheer' };
    },
  },
  {
    id: 'comet', name: '혜성', scope: 'world', tag: 'omen',
    when: () => true, weight: () => 4,
    run: (g) => {
      const bad = g.rng.percent(60);
      for (const c of g.cities) {
        if (bad) c.loyalty = Math.max(0, c.loyalty - g.rng.range(1, 5));
        else c.loyalty = Math.min(100, c.loyalty + g.rng.range(1, 4));
      }
      return { text: bad
        ? '밤하늘에 꼬리별이 나타났다. 사람들이 흉조라 수군거린다. (전국 민심 하락)'
        : '상서로운 별이 자미원에 들었다. 백성이 태평을 노래한다. (전국 민심 상승)',
        kind: bad ? 'bad' : 'good', sfx: 'bell', bgm: bad ? 'disaster' : 'peace' };
    },
  },
  {
    id: 'eclipse', name: '일식', scope: 'world', tag: 'omen',
    when: () => true, weight: () => 2.5,
    run: (g) => {
      for (const c of g.cities) c.order = Math.max(0, c.order - g.rng.range(2, 8));
      return { text: '대낮에 해가 검게 먹혔다. 천하가 술렁인다. (전국 치안 하락)', kind: 'bad', sfx: 'gong', bgm: 'doom' };
    },
  },

  // ───────────────────────── 인재 ─────────────────────────
  {
    id: 'wanderer', name: '유랑 인재', scope: 'city', tag: 'person',
    when: (g, c) => !!c.realm, weight: (g, c) => 9 + (c.loyalty > 70 ? 5 : 0),
    run: (g, c) => {
      const o = generateOfficer(g.rng, { registry: g.world.registry, year: g.year, ageRange: [17, 45] });
      o.realm = null; o.city = c.id;
      g.officers.push(o); g.officerById[o.id] = o; g.freeOfficers.push(o.id);
      return { text: `${c.name}에 재야의 인물 ${o.name}(${o.courtesy})이(가) 나타났다. 등용을 시도할 수 있다.`,
        kind: 'good', sfx: 'confirm', bgm: 'person', focus: o.id };
    },
  },
  {
    id: 'prodigyBorn', name: '기재 출현', scope: 'city', tag: 'person',
    when: (g, c) => !!c.realm, weight: () => 3,
    run: (g, c) => {
      const o = generateOfficer(g.rng, {
        registry: g.world.registry, year: g.year,
        quality: 0.88 + g.rng.next() * 0.12, ageRange: [16, 26],
      });
      o.realm = null; o.city = c.id;
      g.officers.push(o); g.officerById[o.id] = o; g.freeOfficers.push(o.id);
      return { text: `${c.name}에 소문난 기재 ${o.name}(${o.courtesy})이(가) 은거해 있다 한다. 그 이름이 벌써 사방에 퍼졌다.`,
        kind: 'great', sfx: 'levelup', bgm: 'person', focus: o.id };
    },
  },
  {
    id: 'sonBorn', name: '자식 출생', scope: 'officer', tag: 'person',
    when: (g, o) => o.realm && o.age >= 20 && o.age <= 52,
    weight: () => 5,
    run: (g, o) => {
      const child = generateOfficer(g.rng, {
        registry: g.world.registry, year: g.year, ageRange: [0, 0],
        quality: Math.min(1, Math.max(0.15, (o.lead + o.war + o.int + o.pol + o.cha) / 500 + g.rng.gauss(0, 0.14))),
      });
      child.age = 0; child.born = g.year;
      child.realm = null; child.city = o.city;
      child.bonds[o.id] = 'kin'; o.bonds[child.id] = 'kin';
      child.compat = (o.compat + g.rng.range(-10, 10) + 150) % 150;
      g.officers.push(child); g.officerById[child.id] = child;
      return { text: `${o.name}에게 아이가 태어났다. 이름을 ${child.name}이라 지었다.`, kind: 'good', sfx: 'bell', focus: o.id };
    },
  },
  {
    id: 'recommend', name: '천거', scope: 'officer', tag: 'person',
    when: (g, o) => o.realm && o.pol > 60,
    weight: (g, o) => 4 + (o.traits.includes('headhunt') ? 8 : 0),
    run: (g, o) => {
      const cand = generateOfficer(g.rng, { registry: g.world.registry, year: g.year, ageRange: [18, 48] });
      const realm = g.realmById[o.realm];
      cand.realm = o.realm; cand.city = o.city;
      cand.loyalty = g.rng.range(55, 82);
      cand.bonds[o.id] = 'friend'; o.bonds[cand.id] = 'friend';
      g.officers.push(cand); g.officerById[cand.id] = cand;
      g.cityById[o.city].officers.push(cand.id);
      return { text: `${o.name}이(가) 벗 ${cand.name}(${cand.courtesy})을(를) 천거했다. 《${realm.name}》에 출사했다.`,
        kind: 'good', sfx: 'confirm', bgm: 'person', focus: cand.id };
    },
  },
  {
    id: 'hermitFound', name: '은자 발견', scope: 'city', tag: 'person',
    when: (g, c) => c.mountainous || c.famous, weight: () => 4,
    run: (g, c) => {
      const o = generateOfficer(g.rng, {
        registry: g.world.registry, year: g.year, archetype: 'sage',
        quality: 0.72 + g.rng.next() * 0.28, ageRange: [30, 62],
      });
      o.realm = null; o.city = c.id;
      o.personality = 'reclusive'; o.personalityName = '은둔';
      g.officers.push(o); g.officerById[o.id] = o; g.freeOfficers.push(o.id);
      return { text: `${c.name} 깊은 산중에 ${o.name}(${o.courtesy})이라는 은자가 산다 한다. 삼고의 예를 갖추면 나올지도 모른다.`,
        kind: 'good', sfx: 'bell', bgm: 'person', focus: o.id };
    },
  },
  {
    id: 'illness', name: '와병', scope: 'officer', tag: 'person',
    when: (g, o) => o.age > 34, weight: (g, o) => 3 + (o.age - 34) * 0.35,
    run: (g, o) => {
      if (o.traits.includes('healer') || o.traits.includes('longevity')) {
        return { text: `${o.name}이(가) 병으로 자리에 누웠으나 곧 털고 일어났다.`, kind: 'info', focus: o.id };
      }
      o.injury = Math.min(100, o.injury + g.rng.range(25, 55));
      o.lifespan -= g.rng.range(0, 3);
      return { text: `${o.name}이(가) 중병으로 자리에 누웠다. 당분간 일을 볼 수 없다.`, kind: 'bad', sfx: 'plague', focus: o.id };
    },
  },
  {
    id: 'dreamAchieved', name: '꿈의 성취', scope: 'officer', tag: 'person',
    when: (g, o) => o.realm && !o.dreamDone && checkDream(g, o),
    weight: () => 40,
    run: (g, o) => {
      o.dreamDone = true;
      o.loyalty = Math.min(100, o.loyalty + 25);
      o.fame += 60;
      const d = DREAMS.find(x => x.id === o.dream);
      return { text: `${o.name}이(가) 오랜 꿈 「${d.name}」을(를) 이루었다. 감격하여 충성을 맹세한다.`,
        kind: 'great', sfx: 'levelup', bgm: 'victory', focus: o.id };
    },
  },

  // ───────────────────────── 보물 ─────────────────────────
  {
    id: 'treasureFound', name: '보물 발견', scope: 'city', tag: 'treasure',
    when: (g, c) => !!c.realm, weight: (g, c) => 6 + (c.famous ? 6 : 0) + (c.resource?.id === 'jade' ? 8 : 0),
    run: (g, c) => {
      const it = generateItem(g.rng, {
        minRarity: c.resource?.id === 'jade' ? 2 : 0,
        maxRarity: 4, powerScale: 1,
      });
      g.items.push(it); g.itemById[it.uid] = it;
      c.items.push(it.uid); it.city = c.id;
      return { text: `${c.name}에서 「${it.name}」(${it.rarityName})을(를) 얻었다.`, kind: 'good', sfx: 'treasure', item: it.uid };
    },
  },
  {
    id: 'merchantVisit', name: '상인 방문', scope: 'city', tag: 'treasure',
    when: (g, c) => !!c.realm && c.comm > c.maxComm * 0.3, weight: () => 7,
    run: (g, c) => {
      const it = generateItem(g.rng, { minRarity: 1, maxRarity: 5 });
      g.items.push(it); g.itemById[it.uid] = it;
      c.pendingTrade = { item: it.uid, price: Math.round(it.value * g.rng.range(80, 160) / 100) };
      return { text: `서역 상인이 ${c.name}에 들렀다. 「${it.name}」을(를) 팔겠다 한다. (${c.pendingTrade.price}금)`,
        kind: 'info', sfx: 'coin', item: it.uid };
    },
  },
  {
    id: 'goldVein', name: '금맥', scope: 'city', tag: 'treasure',
    when: (g, c) => !!c.realm && c.mountainous, weight: () => 5,
    run: (g, c) => {
      const gold = g.rng.range(500, 3200);
      const r = g.realmById[c.realm];
      if (r) r.gold += gold;
      return { text: `${c.name} 산중에서 금맥이 터졌다. 금 +${gold}`, kind: 'good', sfx: 'coin' };
    },
  },

  // ───────────────────────── 민심·반란 ─────────────────────────
  {
    id: 'bandits', name: '도적 봉기', scope: 'city', tag: 'unrest',
    when: (g, c) => c.order < 55, weight: (g, c) => (55 - c.order) * 0.55,
    run: (g, c) => {
      const sheriff = g.officersIn(c.id).find(o => o.traits.includes('sheriff'));
      if (sheriff) {
        c.order = Math.min(100, c.order + 8);
        return { text: `${c.name} 근방에 도적이 일었으나 ${sheriff.name}이(가) 곧 평정했다.`, kind: 'good', sfx: 'sword', focus: sheriff.id };
      }
      const loss = g.rng.range(200, 1800);
      c.gold = Math.max(0, c.gold - Math.round(loss / 3));
      c.food = Math.max(0, c.food - loss);
      c.order = Math.max(0, c.order - g.rng.range(5, 15));
      c.troops = Math.max(0, c.troops - g.rng.range(100, 800));
      return { text: `${c.name}에 도적 떼가 일어나 창고를 털었다. (병량 -${loss}, 치안 하락)`, kind: 'bad', sfx: 'warDrum', bgm: 'scheme' };
    },
  },
  {
    id: 'revolt', name: '민란', scope: 'city', tag: 'unrest',
    when: (g, c) => !!c.realm && c.loyalty < 30, weight: (g, c) => (30 - c.loyalty) * 1.4,
    run: (g, c) => {
      const lost = Math.round(c.troops * g.rng.range(10, 30) / 100);
      c.troops = Math.max(0, c.troops - lost);
      c.pop = Math.round(c.pop * 0.94);
      c.order = Math.max(0, c.order - 20);
      // 도시가 이탈해 독립할 수도
      if (c.loyalty < 12 && g.rng.percent(28)) {
        const r = g.realmById[c.realm];
        if (r) {
          r.cities = r.cities.filter(x => x !== c.id);
          const prev = c.name;
          c.realm = null; c.loyalty = 45; c.order = 40;
          for (const o of g.officersIn(c.id)) { o.realm = null; }
          if (!r.cities.length) g.destroyRealm(r);
          return { text: `${prev}의 백성이 관을 몰아내고 독립을 선언했다!`, kind: 'bad', sfx: 'crowd', bgm: 'crisis' };
        }
      }
      return { text: `${c.name}에서 백성이 봉기했다. 병력 -${lost}`, kind: 'bad', sfx: 'crowd', bgm: 'crisis' };
    },
  },
  {
    id: 'defection', name: '이탈', scope: 'officer', tag: 'unrest',
    when: (g, o) => o.realm && o.loyalty < 45 && g.realmById[o.realm]?.ruler !== o.id
      && !o.traits.includes('loyalist'),
    weight: (g, o) => (45 - o.loyalty) * 0.7 + o.ambition * 1.2,
    run: (g, o) => {
      const from = g.realmById[o.realm];
      // 인접 세력으로 감 / 재야로 감
      const city = g.cityById[o.city];
      const neigh = [...new Set(city.links.map(l => g.cityById[l.to]?.realm).filter(x => x && x !== o.realm))];
      const target = neigh.length && g.rng.percent(65) ? g.realmById[g.rng.pick(neigh)] : null;
      removeFromCity(g, o);
      if (target) {
        o.realm = target.id;
        const tc = g.cityById[g.rng.pick(target.cities)];
        o.city = tc.id; tc.officers.push(o.id);
        o.loyalty = g.rng.range(55, 78);
        return { text: `${o.name}이(가) 《${from.name}》을(를) 버리고 《${target.name}》으로 달아났다.`,
          kind: 'bad', sfx: 'cancel', bgm: 'scheme', focus: o.id };
      }
      o.realm = null; g.freeOfficers.push(o.id);
      city.officers.push(o.id);
      return { text: `${o.name}이(가) 벼슬을 버리고 초야로 물러났다.`, kind: 'bad', sfx: 'cancel', focus: o.id };
    },
  },
  {
    id: 'coup', name: '모반', scope: 'officer', tag: 'unrest',
    when: (g, o) => o.realm && o.loyalty < 25 && o.ambition >= 8
      && g.realmById[o.realm]?.ruler !== o.id,
    weight: (g, o) => o.ambition * 1.4,
    run: (g, o) => {
      const realm = g.realmById[o.realm];
      const city = g.cityById[o.city];
      if (city.id === realm.capital && realm.cities.length > 1) {
        // 수도 반란은 위험 — 세력 분열
        realm.cities = realm.cities.filter(x => x !== city.id);
        realm.capital = realm.cities[0];
      } else {
        realm.cities = realm.cities.filter(x => x !== city.id);
      }
      const nid = 'r' + (g.realms.length + 1) + '_' + g.turnNo;
      const nr = {
        id: nid, name: o.name.slice(0, 1) + '군', hanja: '',
        color: '#8a8f95', ruler: o.id, cities: [city.id],
        gold: Math.round(city.gold), food: Math.round(city.food),
        fame: Math.round(o.fame), aiStyle: 'raider', aiName: '유격',
        diplo: {}, truce: {}, ally: {}, isPlayer: false, dead: false,
        corps: [], capital: city.id, tribute: {},
        stats: { battlesWon: 0, battlesLost: 0, citiesTaken: 0 },
      };
      for (const r2 of g.realms) { r2.diplo[nid] = 10; nr.diplo[r2.id] = r2.id === realm.id ? 0 : 25; }
      g.realms.push(nr); g.realmById[nid] = nr;
      city.realm = nid; o.realm = nid; o.loyalty = 100;
      for (const x of g.officersIn(city.id)) {
        if (x.id === o.id) continue;
        if (g.rng.percent(45 + (60 - compatDistance(x.compat, o.compat)))) { x.realm = nid; x.loyalty = g.rng.range(50, 80); }
        else { x.prisoner = true; x.realm = nid; }
      }
      if (!realm.cities.length) g.destroyRealm(realm);
      return { text: `${o.name}이(가) ${city.name}에서 반기를 들었다! 《${nr.name}》을(를) 세우고 독립했다.`,
        kind: 'bad', sfx: 'gong', bgm: 'crisis', focus: o.id };
    },
  },

  // ───────────────────────── 군사 ─────────────────────────
  {
    id: 'desertion', name: '탈영', scope: 'city', tag: 'military',
    when: (g, c) => !!c.realm && c.morale < 35 && c.troops > 1000, weight: (g, c) => (35 - c.morale) * 0.8,
    run: (g, c) => {
      const lost = Math.round(c.troops * g.rng.range(4, 14) / 100);
      c.troops -= lost;
      return { text: `${c.name}의 병사들이 사기를 잃고 달아났다. 병력 -${lost}`, kind: 'bad', sfx: 'cancel' };
    },
  },
  {
    id: 'volunteers', name: '의병 참집', scope: 'city', tag: 'military',
    when: (g, c) => !!c.realm && c.loyalty > 72, weight: (g, c) => (c.loyalty - 72) * 0.6,
    run: (g, c) => {
      const add = Math.round(c.pop * g.rng.range(1, 4) / 1000) * 10 + g.rng.range(200, 1200);
      c.troops += add;
      return { text: `${c.name}의 백성이 스스로 창을 들고 모였다. 병력 +${add}`, kind: 'good', sfx: 'cheer' };
    },
  },
  {
    id: 'horseTrade', name: '이민족 교역', scope: 'city', tag: 'military',
    when: (g, c) => !!c.realm && (c.resource?.id === 'horse' || c.type === 'frontier'), weight: () => 6,
    run: (g, c) => {
      const r = g.realmById[c.realm];
      const cost = g.rng.range(300, 1200);
      if (r && r.gold >= cost) {
        r.gold -= cost;
        const it = generateItem(g.rng, { slot: 'horse', minRarity: 1, maxRarity: 4 });
        g.items.push(it); g.itemById[it.uid] = it; c.items.push(it.uid); it.city = c.id;
        return { text: `북방의 상인이 ${c.name}에 명마를 가져왔다. 「${it.name}」을(를) ${cost}금에 사들였다.`, kind: 'good', sfx: 'gallop', item: it.uid };
      }
      return { text: `북방의 상인이 ${c.name}에 왔으나 살 돈이 없어 돌려보냈다.`, kind: 'info' };
    },
  },
  {
    id: 'raidBarbarian', name: '이민족 침입', scope: 'city', tag: 'military',
    when: (g, c) => !!c.realm && (c.type === 'frontier' || c.type === 'fortress'), weight: () => 7,
    run: (g, c) => {
      const enemy = g.rng.range(2000, 12000);
      const defOff = g.officersIn(c.id).sort((a, b) => (b.lead + b.war) - (a.lead + a.war))[0];
      const defPow = c.troops * (1 + (defOff ? (defOff.lead + defOff.war) / 200 : 0)) * (1 + c.train / 200);
      if (defPow > enemy * 1.1) {
        const loss = Math.round(c.troops * g.rng.range(2, 8) / 100);
        c.troops -= loss;
        if (defOff) { defOff.fame += g.rng.range(10, 35); defOff.exp.war += 20; }
        return { text: `이민족 ${enemy.toLocaleString()}이 ${c.name}을(를) 침범했으나 ${defOff ? defOff.name + '이(가) ' : ''}격퇴했다. (아군 -${loss})`,
          kind: 'good', sfx: 'victory', bgm: 'battle' };
      }
      const loss = Math.round(c.troops * g.rng.range(10, 30) / 100);
      c.troops -= loss;
      c.gold = Math.round(c.gold * 0.7);
      c.food = Math.round(c.food * 0.8);
      c.loyalty = Math.max(0, c.loyalty - 10);
      return { text: `이민족 ${enemy.toLocaleString()}이 ${c.name}을(를) 짓밟고 물러갔다. (병력 -${loss})`, kind: 'bad', sfx: 'warDrum', bgm: 'battle' };
    },
  },

  // ───────────────────────── 조정·외교 ─────────────────────────
  {
    id: 'imperialEdict', name: '조서', scope: 'realm', tag: 'court',
    when: (g, r) => r.fame > 200, weight: (g, r) => 3 + r.fame / 220,
    run: (g, r) => {
      const gain = g.rng.range(30, 120);
      r.fame += gain;
      const ruler = g.officerById[r.ruler];
      ruler.fame += Math.round(gain * 0.6);
      return { text: `조정에서 《${r.name}》에 조서를 내렸다. 명성 +${gain}`, kind: 'good', sfx: 'seal', bgm: 'court' };
    },
  },
  {
    id: 'tributeGift', name: '헌상', scope: 'realm', tag: 'court',
    when: (g, r) => r.cities.length >= 3, weight: () => 4,
    run: (g, r) => {
      const gold = g.rng.range(400, 2400);
      r.gold += gold;
      return { text: `주변 호족들이 《${r.name}》에 예물을 보내왔다. 금 +${gold}`, kind: 'good', sfx: 'coin' };
    },
  },
  {
    id: 'envoyPeace', name: '화친 제의', scope: 'realm', tag: 'court',
    when: (g, r) => g.realms.filter(x => !x.dead && x !== r).length > 0, weight: () => 5,
    run: (g, r) => {
      const others = g.realms.filter(x => !x.dead && x !== r);
      const t = g.rng.pick(others);
      const months = g.rng.range(6, 30);
      if (r.isPlayer) {
        g.pendingOffer = { type: 'truce', from: t.id, to: r.id, months };
        return { text: `《${t.name}》이(가) ${months}개월 정전을 제의해 왔다.`, kind: 'info', sfx: 'scroll', bgm: 'court', offer: true };
      }
      if (g.rng.percent(50)) {
        r.truce[t.id] = g.turnNo + months; t.truce[r.id] = g.turnNo + months;
        return { text: `《${r.name}》과 《${t.name}》이(가) ${months}개월 정전에 합의했다.`, kind: 'info', sfx: 'seal' };
      }
      return { text: `《${t.name}》의 화친 제의를 《${r.name}》이(가) 거절했다.`, kind: 'info' };
    },
  },
  {
    id: 'feast', name: '연회', scope: 'realm', tag: 'court',
    when: (g, r) => r.gold > 800, weight: () => 5,
    run: (g, r) => {
      const cost = g.rng.range(300, 900);
      r.gold -= cost;
      const offs = g.officersOf(r.id);
      let poet = offs.find(o => o.traits.includes('poet'));
      const gain = poet ? g.rng.range(6, 14) : g.rng.range(3, 8);
      for (const o of offs) o.loyalty = Math.min(100, o.loyalty + gain);
      return { text: `《${r.name}》이(가) 연회를 열었다.${poet ? ` ${poet.name}의 시가 좌중을 울렸다.` : ''} 무장 충성도 +${gain}`,
        kind: 'good', sfx: 'cheer', bgm: 'feast' };
    },
  },

  // ───────────────────────── 기담 ─────────────────────────
  {
    id: 'taoist', name: '도사의 예언', scope: 'city', tag: 'legend',
    when: (g, c) => !!c.realm, weight: () => 3,
    run: (g, c) => {
      const good = g.rng.percent(50);
      const r = g.realmById[c.realm];
      if (good) { if (r) r.fame += g.rng.range(20, 70); c.loyalty = Math.min(100, c.loyalty + 10); }
      else { c.loyalty = Math.max(0, c.loyalty - 10); c.order = Math.max(0, c.order - 8); }
      return { text: good
        ? `${c.name}에 이인(異人)이 나타나 "이 땅에 왕기가 서렸다" 하고 사라졌다.`
        : `${c.name}에 도사가 나타나 "머지않아 큰 난이 있으리라" 하니 백성이 동요한다.`,
        kind: good ? 'good' : 'bad', sfx: 'bell', bgm: good ? 'peace' : 'scheme' };
    },
  },
  {
    id: 'legendRelic', name: '신물 출현', scope: 'city', tag: 'legend',
    when: (g, c) => !!c.realm && c.famous, weight: () => 1.6,
    run: (g, c) => {
      const unowned = g.items.filter(i => i.legend && !i.owner && !i.city);
      let it;
      if (unowned.length) it = g.rng.pick(unowned);
      else { it = generateItem(g.rng, { minRarity: 4, maxRarity: 5 }); g.items.push(it); g.itemById[it.uid] = it; }
      c.items.push(it.uid); it.city = c.id;
      return { text: `${c.name}의 옛 무덤에서 「${it.name}」이(가) 나왔다!${it.lore ? ' — ' + it.lore : ''}`,
        kind: 'great', sfx: 'treasure', bgm: 'victory', item: it.uid };
    },
  },
  {
    id: 'ghost', name: '괴이', scope: 'city', tag: 'legend',
    when: (g, c) => true, weight: () => 2.5,
    run: (g, c) => {
      c.order = Math.max(0, c.order - g.rng.range(3, 12));
      return { text: `${c.name} 밤거리에 귀화(鬼火)가 떠돈다는 소문이 돌아 민심이 흉흉하다.`, kind: 'bad', sfx: 'plague', bgm: 'night' };
    },
  },
  {
    id: 'whiteTiger', name: '백호 출현', scope: 'city', tag: 'legend',
    when: (g, c) => c.mountainous || c.terrain === 6, weight: () => 2,
    run: (g, c) => {
      const offs = g.officersIn(c.id).filter(o => o.war > 55);
      if (!offs.length) {
        c.pop = Math.round(c.pop * 0.99);
        return { text: `${c.name} 산에 흰 범이 나타나 사람을 해친다. 잡을 자가 없다.`, kind: 'bad', sfx: 'wind' };
      }
      const hero = offs.sort((a, b) => b.war - a.war)[0];
      hero.fame += g.rng.range(20, 60);
      hero.exp.war += 30;
      c.loyalty = Math.min(100, c.loyalty + 6);
      return { text: `${c.name} 산의 흰 범을 ${hero.name}이(가) 맨손으로 때려잡았다. 이름이 크게 났다.`,
        kind: 'great', sfx: 'sword', bgm: 'victory', focus: hero.id };
    },
  },
  {
    id: 'oath', name: '결의', scope: 'city', tag: 'legend',
    when: (g, c) => g.officersIn(c.id).length >= 3, weight: () => 3,
    run: (g, c) => {
      const offs = g.rng.sample(g.officersIn(c.id).filter(o => !o.dead), 3);
      if (offs.length < 2) return null;
      for (const a of offs) for (const b of offs) {
        if (a === b) continue;
        a.bonds[b.id] = 'brother';
      }
      for (const o of offs) { o.loyalty = Math.min(100, o.loyalty + 12); o.fame += 20; }
      return { text: `${c.name}에서 ${offs.map(o => o.name).join(' · ')}이(가) 의형제의 연을 맺었다.`,
        kind: 'great', sfx: 'gong', bgm: 'ceremony', focus: offs[0].id };
    },
  },
  {
    id: 'duelChallenge', name: '무예 시합', scope: 'city', tag: 'legend',
    when: (g, c) => g.officersIn(c.id).filter(o => o.war > 50).length >= 2, weight: () => 4,
    run: (g, c) => {
      const cand = g.officersIn(c.id).filter(o => o.war > 50);
      const [a, b] = g.rng.sample(cand, 2);
      const wa = a.war + g.rng.range(-20, 20), wb = b.war + g.rng.range(-20, 20);
      const win = wa >= wb ? a : b, lose = wa >= wb ? b : a;
      win.fame += g.rng.range(8, 25); win.exp.war += 15; lose.exp.war += 8;
      return { text: `${c.name}에서 ${a.name}과(와) ${b.name}이(가) 무예를 겨루었다. ${win.name}의 승리.`,
        kind: 'info', sfx: 'clash', focus: win.id };
    },
  },
  {
    id: 'sworn', name: '적장의 귀순', scope: 'realm', tag: 'legend',
    when: (g, r) => r.fame > 400, weight: (g, r) => 1.5 + r.fame / 900,
    run: (g, r) => {
      const others = g.realms.filter(x => !x.dead && x !== r);
      if (!others.length) return null;
      const t = g.rng.pick(others);
      const cand = g.officersOf(t.id).filter(o => o.id !== t.ruler && o.loyalty < 70);
      if (!cand.length) return null;
      const o = g.rng.weighted(cand, x => Math.max(1, 80 - x.loyalty));
      removeFromCity(g, o);
      o.realm = r.id;
      const c = g.cityById[g.rng.pick(r.cities)];
      o.city = c.id; c.officers.push(o.id); o.loyalty = g.rng.range(65, 88);
      return { text: `《${r.name}》의 덕망을 흠모한 ${o.name}이(가) 《${t.name}》을(를) 떠나 귀순했다.`,
        kind: 'great', sfx: 'confirm', bgm: 'person', focus: o.id };
    },
  },
];

export const EVENT_BY_ID = Object.fromEntries(EVENTS.map(e => [e.id, e]));

// ------------------------------------------------------------------
export function removeFromCity(g, o) {
  const c = g.cityById[o.city];
  if (c) c.officers = c.officers.filter(x => x !== o.id);
  g.freeOfficers = g.freeOfficers.filter(x => x !== o.id);
}

export function killOfficer(g, o, cause = '병사') {
  if (o.dead) return;
  o.dead = true; o.deathYear = g.year; o.deathCause = cause;
  removeFromCity(g, o);
  // 소지품은 도시로
  const c = g.cityById[o.city];
  if (c) for (const u of o.items) { const it = g.itemById[u]; if (it) { it.owner = null; it.city = c.id; c.items.push(u); } }
  o.items = [];
  // 군주가 죽으면 후계
  const r = g.realmById[o.realm];
  if (r && r.ruler === o.id) succeed(g, r, o);
}

export function succeed(g, realm, dead) {
  const cand = g.officersOf(realm.id).filter(o => !o.dead && o.id !== dead.id && o.age >= 15);
  if (!cand.length) { g.destroyRealm(realm); return null; }
  // 혈연 > 충성·명성·능력
  const heir = cand.sort((a, b) => score(b) - score(a))[0];
  function score(o) {
    let s = o.cha * 1.6 + o.lead + o.fame * 0.12 + o.loyalty * 0.6;
    if (dead.bonds[o.id] === 'kin') s += 120;
    if (dead.bonds[o.id] === 'brother') s += 80;
    if (o.age > 60) s -= 40;
    return s;
  }
  realm.ruler = heir.id;
  heir.loyalty = 100;
  realm.fame = Math.round(realm.fame * 0.75);
  // 계승 혼란 — 충성도 흔들림
  for (const o of g.officersOf(realm.id)) {
    if (o.id === heir.id) continue;
    const d = compatDistance(o.compat, heir.compat);
    o.loyalty = Math.max(5, Math.min(100, o.loyalty - Math.round(d * 0.35) + g.rng.range(-6, 6)));
  }
  g.pushLog(`《${realm.name}》의 군주가 죽고 ${heir.name}이(가) 뒤를 이었다.`, 'succeed');
  return heir;
}

function checkDream(g, o) {
  const d = DREAMS.find(x => x.id === o.dream);
  if (!d) return false;
  const r = g.realmById[o.realm];
  switch (d.check) {
    case 'realmCities': return r && r.cities.length / g.cities.length >= d.need;
    case 'becomeRuler': return r && r.ruler === o.id;
    case 'ownFame': return o.fame >= d.need;
    case 'realmFame': return r && r.fame >= d.need;
    case 'realmLoyalty': {
      if (!r || !r.cities.length) return false;
      const avg = r.cities.reduce((s, id) => s + g.cityById[id].loyalty, 0) / r.cities.length;
      return avg >= d.need;
    }
    case 'nemesisDead': return o.nemesis && g.officerById[o.nemesis]?.dead;
    case 'duelWins': return o.stats.duelWins >= d.need;
    case 'ownItems': return o.items.length >= d.need;
    case 'homeSafe': return false;
    case 'friendSame': {
      for (const [id, k] of Object.entries(o.bonds)) {
        if ((k === 'friend' || k === 'brother') && g.officerById[id] && !g.officerById[id].dead
          && g.officerById[id].realm === o.realm) return true;
      }
      return false;
    }
    case 'ownRank': return o.rankLv >= d.need;
    case 'battleWins': return o.stats.wins >= d.need;
    case 'ownLead': return o.lead >= d.need;
    default: return false;
  }
}

/**
 * 한 달 동안 일어날 이벤트를 굴린다.
 * @returns {Array} 발생한 이벤트 결과 목록
 */
export function rollEvents(g, count = null) {
  const rng = g.rng;
  const n = count ?? rng.range(1, 4) + Math.floor(g.cities.length / 18);
  const results = [];
  const usedCity = new Set();

  for (let i = 0; i < n * 3 && results.length < n; i++) {
    const ev = rng.weighted(EVENTS, e => 10);
    if (!ev) break;
    let ctx = null;
    if (ev.scope === 'world') ctx = null;
    else if (ev.scope === 'city') {
      const pool = g.cities.filter(c => !usedCity.has(c.id));
      if (!pool.length) continue;
      ctx = rng.pick(pool);
    } else if (ev.scope === 'realm') {
      const pool = g.realms.filter(r => !r.dead);
      if (!pool.length) continue;
      ctx = rng.pick(pool);
    } else if (ev.scope === 'officer') {
      const pool = g.officers.filter(o => !o.dead && o.age >= 14 && !o.prisoner);
      if (!pool.length) continue;
      ctx = rng.pick(pool);
    }
    try {
      if (ev.when && !ev.when(g, ctx)) continue;
      const w = ev.weight ? ev.weight(g, ctx) : 10;
      if (!rng.percent(Math.min(95, w * 2.2))) continue;
      const out = ev.run(g, ctx);
      if (!out) continue;
      out.id = ev.id; out.name = ev.name; out.tag = ev.tag;
      out.cityId = ev.scope === 'city' ? ctx.id : null;
      out.realmId = ev.scope === 'realm' ? ctx.id : (ev.scope === 'city' ? ctx.realm : (ctx?.realm ?? null));
      results.push(out);
      if (ev.scope === 'city') usedCity.add(ctx.id);
    } catch (err) {
      console.warn('event error', ev.id, err);
    }
  }
  return results;
}
