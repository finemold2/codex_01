// ============================================================
//  단일 파일 빌드
//  ES 모듈로 나뉜 게임을 의존 순서대로 묶어 하나의 HTML로 만든다.
//  (아티팩트·오프라인 배포용 — 원본 모듈 구조는 그대로 둔다)
//
//  실행:  node tools/bundle.mjs
//  결과:  standalone.html
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'js/main.js';

const modules = new Map();   // key → { code, deps }

/** './x.js' 를 저장소 기준 경로로 바꾼다 */
function resolve(spec, fromKey) {
  return normalize(join(dirname(fromKey), spec)).split('\\').join('/');
}

function load(key) {
  if (modules.has(key)) return;
  let src = readFileSync(join(ROOT, key), 'utf8');
  // 여러 줄에 걸친 import 를 한 줄로 접는다 (줄 단위 파싱을 위해)
  src = src.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g,
    (m) => m.replace(/\s+/g, ' '));
  const deps = [];
  const exported = new Set();
  const lines = src.split('\n');
  const out = [];

  for (const line of lines) {
    // import { a, b as c } from './x.js';
    let m = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/.exec(line);
    if (m) {
      const dep = resolve(m[2], key);
      deps.push(dep);
      const names = m[1].split(',').map(s => s.trim()).filter(Boolean)
        .map(s => {
          const as = /^(\S+)\s+as\s+(\S+)$/.exec(s);
          return as ? `${as[1]}: ${as[2]}` : s;
        });
      out.push(`  const { ${names.join(', ')} } = __req('${dep}');`);
      continue;
    }
    // 부수효과만 있는 import
    m = /^\s*import\s*['"]([^'"]+)['"]\s*;?\s*$/.exec(line);
    if (m) {
      const dep = resolve(m[1], key);
      deps.push(dep);
      out.push(`  __req('${dep}');`);
      continue;
    }
    // export { a, b };
    m = /^\s*export\s*\{([^}]*)\}\s*;?\s*$/.exec(line);
    if (m) {
      for (const n of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
        exported.add(n.includes(' as ') ? n.split(/\s+as\s+/)[1].trim() : n);
      }
      continue;
    }
    // export function / class / const / let / var
    m = /^\s*export\s+(async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) {
      exported.add(m[3]);
      out.push(line.replace(/^(\s*)export\s+/, '$1'));
      continue;
    }
    out.push(line);
  }

  let code = out.join('\n');
  // 동적 import 는 동기 요청으로 바꾼다
  code = code.replace(/import\(\s*['"]([^'"]+)['"]\s*\)/g, (_, spec) => {
    const dep = resolve(spec, key);
    deps.push(dep);
    return `Promise.resolve(__req('${dep}'))`;
  });

  modules.set(key, { code, exported: [...exported], deps: [...new Set(deps)] });
  for (const d of deps) load(d);
}

load(ENTRY);

// ── 모듈 등록 코드 생성 ──
const regs = [...modules.entries()].map(([key, m]) => `
__def(${JSON.stringify(key)}, function (__x, __req) {
${m.code}
${m.exported.length ? `  Object.assign(__x, { ${m.exported.join(', ')} });` : ''}
});`).join('\n');

const runtime = `
(function () {
  'use strict';
  var __f = Object.create(null), __c = Object.create(null);
  function __def(id, fn) { __f[id] = fn; }
  function __req(id) {
    if (__c[id]) return __c[id];
    var fn = __f[id];
    if (!fn) throw new Error('모듈을 찾을 수 없다: ' + id);
    var x = (__c[id] = {});
    fn(x, __req);
    return x;
  }
${regs}
  __req(${JSON.stringify(ENTRY)});
})();
`;

const css = readFileSync(join(ROOT, 'css/style.css'), 'utf8');

const head = `<title>삼국연의 · 난세기</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;600;700;900&family=Noto+Sans+KR:wght@400;500;700&display=swap">
<style>
${css}
</style>
`;

const bodyContent = `${head}
<div id="app"></div>

<script>
${runtime}
</script>
`;

// ① 완전한 문서 — 파일을 그대로 열거나 정적 서버로 띄울 때.
//    charset 선언이 없으면 브라우저가 한글을 latin-1 로 읽어 스크립트가 깨진다.
const standalone = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1b140f">
<meta name="description" content="매번 새로 생성되는 중원에서 벌이는 절차적 삼국지 전략 시뮬레이션.">
${head}</head>
<body>
<div id="app"></div>
<noscript><p style="color:#e8dcc0;font-family:sans-serif;padding:40px">이 게임은 자바스크립트가 필요합니다.</p></noscript>
<script>
${runtime}
</script>
</body>
</html>
`;

writeFileSync(join(ROOT, 'standalone.html'), standalone);
// ② 아티팩트용 — 바깥 문서 골격은 호스트가 씌운다
writeFileSync(join(ROOT, 'artifact.html'), bodyContent);
const kb = (Buffer.byteLength(standalone) / 1024).toFixed(0);

console.log(`모듈 ${modules.size}개 · standalone.html ${kb}KB · artifact.html ${(Buffer.byteLength(bodyContent)/1024).toFixed(0)}KB`);
