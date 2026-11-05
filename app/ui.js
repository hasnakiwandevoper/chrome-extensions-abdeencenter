// Small DOM helpers + reusable widgets (brand picker, category tree, toasts, modal).
import { flattenTree } from '../shared/model.js';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') value = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (typeof v === 'boolean' || (k in el && typeof v !== 'string')) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

export const fmtMoney = (n, cur = 'JOD') => (n == null || n === '' || !isFinite(n) ? '—' : `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} ${cur}`);

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------- toasts ----------
let toastBox;
export function toast(msg, kind = 'ok', ms) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts' });
    document.body.append(toastBox);
  }
  const el = h('div', { class: `toast ${kind}` }, msg);
  el.addEventListener('click', () => el.remove());
  toastBox.append(el);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
  setTimeout(() => el.remove(), ms || (kind === 'error' ? 9000 : 3500));
}

// ---------- modal ----------
export function modal(title, body, actions = []) {
  const close = () => back.remove();
  const back = h(
    'div',
    { class: 'modal-back', onclick: (e) => e.target === back && close() },
    h(
      'div',
      { class: 'modal', role: 'dialog' },
      h('div', { class: 'modal-head' }, h('b', {}, title), h('button', { class: 'icon-btn', title: 'Close', onclick: close }, '×')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => h('button', { class: a.primary ? 'btn primary' : 'btn', onclick: () => a.onClick(close) }, a.label))) : null
    )
  );
  document.body.append(back);
  return close;
}

export function jsonBlock(obj, max = 60000) {
  let s;
  try {
    s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  } catch {
    s = String(obj);
  }
  if (s && s.length > max) s = s.slice(0, max) + '\n… (truncated)';
  const pre = h('pre', { class: 'json' }, s ?? 'null');
  const copy = h('button', { class: 'btn tiny', onclick: () => navigator.clipboard.writeText(s).then(() => toast('Copied')) }, 'Copy');
  return h('div', { class: 'json-wrap' }, copy, pre);
}

// ---------- brand picker (single select with search) ----------
export function BrandPicker({ brands = [], value = null, onChange, placeholder = 'Select brand…', hint }) {
  let cur = value;
  const input = h('input', { type: 'text', class: 'combo-input', placeholder, autocomplete: 'off' });
  const chip = h('div', { class: 'combo-chip' });
  const list = h('div', { class: 'combo-list', hidden: true });
  const wrap = h('div', { class: 'combo' }, h('div', { class: 'combo-box' }, chip, input), list, hint ? h('div', { class: 'hint' }, hint) : null);

  const find = (id) => brands.find((b) => String(b.id) === String(id));
  function showChip() {
    chip.textContent = '';
    const b = find(cur);
    if (cur != null && cur !== '') {
      chip.append(
        h(
          'span',
          { class: 'chip' },
          b ? b.label : `#${cur}`,
          h('button', { type: 'button', class: 'chip-x', title: 'Clear', onclick: (e) => (e.stopPropagation(), set(null)) }, '×')
        )
      );
      input.placeholder = 'Change…';
    } else input.placeholder = placeholder;
  }
  function set(id) {
    cur = id;
    showChip();
    onChange?.(id);
  }
  let matches = [];
  function renderList() {
    const t = input.value.trim().toLowerCase();
    matches = brands.filter((b) => !t || `${b.label} ${b.nameAr} ${b.slug} ${b.id}`.toLowerCase().includes(t)).slice(0, 80);
    list.textContent = '';
    for (const b of matches) {
      list.append(
        h(
          'div',
          {
            class: 'combo-opt' + (String(b.id) === String(cur) ? ' sel' : ''),
            onmousedown: (e) => {
              e.preventDefault();
              set(b.id);
              input.value = '';
              list.hidden = true;
              input.blur();
            },
          },
          h('span', {}, b.label),
          b.nameAr && b.nameAr !== b.label ? h('span', { class: 'muted ar' }, b.nameAr) : null,
          h('span', { class: 'muted id' }, `#${b.id}`)
        )
      );
    }
    if (!matches.length) list.append(h('div', { class: 'combo-empty' }, brands.length ? 'No match' : 'No brands loaded — check Settings → Lookups'));
  }
  input.addEventListener('focus', () => {
    renderList();
    list.hidden = false;
  });
  input.addEventListener('input', renderList);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && matches[0]) {
      e.preventDefault();
      set(matches[0].id);
      input.value = '';
      list.hidden = true;
    } else if (e.key === 'Escape') input.blur();
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 120));
  showChip();
  return wrap;
}

// ---------- category tree (multi select) ----------
export function CategoryTree({ roots = [], selected = [], onChange, selectParents = true }) {
  const sel = new Set((selected || []).map(String));
  const flat = flattenTree(roots);
  const byId = new Map(flat.map((n) => [String(n.id), n]));
  const open = new Set();
  for (const id of sel) {
    let n = byId.get(id);
    while (n && n.parentId != null && byId.has(String(n.parentId))) {
      open.add(String(n.parentId));
      n = byId.get(String(n.parentId));
    }
  }
  const chips = h('div', { class: 'chips' });
  const search = h('input', { type: 'search', class: 'tree-search', placeholder: `Search ${flat.length} categories…` });
  const body = h('div', { class: 'tree-body' });
  const wrap = h('div', { class: 'tree' }, chips, search, body);

  const emit = () => onChange?.([...sel].map((x) => (isNaN(x) ? x : Number(x))));
  function toggle(id, on) {
    if (on) {
      sel.add(id);
      if (selectParents) {
        let n = byId.get(id);
        while (n && n.parentId != null && byId.has(String(n.parentId))) {
          sel.add(String(n.parentId));
          n = byId.get(String(n.parentId));
        }
      }
    } else sel.delete(id);
    emit();
    renderAll();
  }
  const selfMatch = (n, f) => `${n.label} ${n.nameAr} ${n.id}`.toLowerCase().includes(f);
  const matches = (n, f) => selfMatch(n, f) || (n.children || []).some((k) => matches(k, f));

  function nodeEl(n, f) {
    const id = String(n.id);
    const kids = n.children || [];
    let showKids = open.has(id) ? kids : [];
    let expanded = open.has(id);
    if (f && !selfMatch(n, f)) {
      showKids = kids.filter((k) => matches(k, f));
      expanded = true;
    }
    const row = h(
      'div',
      { class: 'tree-row' + (sel.has(id) ? ' on' : '') },
      kids.length
        ? h(
            'button',
            {
              type: 'button',
              class: 'caret' + (expanded ? ' open' : ''),
              onclick: () => {
                open.has(id) ? open.delete(id) : open.add(id);
                renderAll();
              },
            },
            '▸'
          )
        : h('span', { class: 'caret-sp' }),
      h(
        'label',
        { class: 'tree-label', title: n.nameAr || '' },
        h('input', { type: 'checkbox', checked: sel.has(id), onchange: (e) => toggle(id, e.target.checked) }),
        h('span', {}, n.label),
        h('span', { class: 'muted id' }, ` #${n.id}`)
      )
    );
    const el = h('div', { class: 'tree-node' }, row);
    if (showKids.length) el.append(h('div', { class: 'tree-kids' }, showKids.map((k) => nodeEl(k, f))));
    return el;
  }
  function renderAll() {
    chips.textContent = '';
    for (const id of sel) {
      const n = byId.get(id);
      chips.append(h('span', { class: 'chip', title: n?.path?.join(' › ') || '' }, n ? n.label : `#${id}`, h('button', { type: 'button', class: 'chip-x', onclick: () => toggle(id, false) }, '×')));
    }
    if (!sel.size) chips.append(h('span', { class: 'muted' }, 'No categories selected'));
    const f = search.value.trim().toLowerCase();
    const top = body.scrollTop;
    body.textContent = '';
    if (!roots.length) body.append(h('div', { class: 'muted pad' }, 'No categories loaded — check Settings → Lookups'));
    (f ? roots.filter((r) => matches(r, f)) : roots).forEach((r) => body.append(nodeEl(r, f)));
    body.scrollTop = top;
  }
  search.addEventListener('input', renderAll);
  renderAll();
  return wrap;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', () => {
      resolve(inp.files[0] || null);
      inp.remove();
    });
    document.body.append(inp);
    inp.click();
  });
}
