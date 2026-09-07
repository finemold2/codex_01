// ============================================================
//  DOM 유틸 — 가벼운 요소 생성 헬퍼
// ============================================================
export function el(tag, opts = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(opts)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v === false) continue;              // 불리언 속성: false면 아예 달지 않는다
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function num(n) { return (n ?? 0).toLocaleString('ko-KR'); }

export function shortNum(n) {
  n = Math.round(n || 0);
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '억';
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '만';
  return n.toLocaleString('ko-KR');
}

/** 0~100 값을 막대로 */
export function bar(value, max = 100, color = '#c8a24a', label = null) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return el('div', { class: 'bar' }, [
    el('div', { class: 'bar-fill', style: { width: pct + '%', background: color } }),
    label ? el('span', { class: 'bar-label', text: label }) : null,
  ]);
}

export function statChip(name, value, cls = '') {
  return el('div', { class: 'stat-chip ' + cls }, [
    el('span', { class: 'sc-name', text: name }),
    el('span', { class: 'sc-val', text: String(value) }),
  ]);
}

/** 잠깐 나타났다 사라지는 알림 */
let toastRoot = null;
export function toast(text, kind = 'info', ms = 2600) {
  if (!toastRoot) {
    toastRoot = el('div', { class: 'toast-root' });
    document.body.appendChild(toastRoot);
  }
  const t = el('div', { class: 'toast toast-' + kind, text });
  toastRoot.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, ms);
  while (toastRoot.children.length > 6) toastRoot.firstChild.remove();
}

/** 모달 */
export function modal(title, body, actions = [], opt = {}) {
  const back = el('div', { class: 'modal-back' + (opt.wide ? ' wide' : '') });
  const box = el('div', { class: 'modal' + (opt.cls ? ' ' + opt.cls : '') }, [
    el('div', { class: 'modal-title' }, [
      el('span', { class: 'mt-mark', text: '❖' }),
      el('span', { text: title }),
    ]),
    el('div', { class: 'modal-body' }, [].concat(body)),
    actions.length ? el('div', { class: 'modal-actions' },
      actions.map(a => el('button', {
        class: 'btn ' + (a.cls || ''),
        onclick: () => { if (a.onClick) a.onClick(close); if (a.close !== false) close(); },
      }, [a.label]))) : null,
  ]);
  back.appendChild(box);
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add('show'));
  function close() {
    back.classList.remove('show');
    setTimeout(() => back.remove(), 260);
  }
  if (opt.dismissible !== false) {
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
  }
  return { close, box, back };
}

export function confirmBox(title, text, onYes, yesLabel = '실행', noLabel = '취소') {
  return modal(title, [el('p', { class: 'confirm-text', text })], [
    { label: noLabel, cls: 'ghost' },
    { label: yesLabel, cls: 'primary', onClick: onYes },
  ]);
}
