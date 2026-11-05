import {
  ITEM_PREFIX,
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATE,
  loadSettings,
  deepClone,
  deepMerge,
  normalizeBrands,
  normalizeCategories,
  flattenTree,
  editFromScraped,
  matchBrand,
  hostOf,
  slugify,
} from '../shared/model.js';
import { registerSource, unregisterSource, originsFor, cleanHost } from '../shared/sources.js';
import { apiFetch, ApiError, fillId, unwrapProduct, productIdOf, extractMedia, errorInfo, errorLines } from './api.js';
import { buildPayload, validate } from './payload.js';
import { h, BrandPicker, CategoryTree, toast, modal, jsonBlock, fmtMoney, timeAgo, download, pickFile } from './ui.js';
import { exportExcel, readProductRows, applyRows } from './excel.js';

// ------------------------------------------------------------------ state
const S = {
  settings: null,
  env: 'production',
  sessions: {},
  lookups: {},
  lookupRaw: {},
  lookupErrors: {},
  lookupsLoading: false,
  importDefaults: { brandId: null, categories: [] },
  items: new Map(),
  selected: new Set(),
  filter: 'all',
  search: '',
  tab: 'products',
  editId: null,
  busy: null,
  lastPhone: '',
  apiLog: [],
};
const refs = {};
let inlineEdits = Promise.resolve();
const app = document.getElementById('app');
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const envCfg = () => S.settings.envs[S.env] || Object.values(S.settings.envs)[0];
const baseUrl = () => envCfg().baseUrl;
const session = () => S.sessions[S.env] || null;
const brands = () => S.lookups[S.env]?.brands || [];
const categories = () => S.lookups[S.env]?.categories || [];
let catMemo = { key: null, flat: [], byId: new Map() };
function catIndex() {
  const l = S.lookups[S.env];
  const key = `${S.env}|${l?.fetchedAt}`;
  if (catMemo.key !== key) {
    const flat = flattenTree(l?.categories || []);
    catMemo = { key, flat, byId: new Map(flat.map((c) => [String(c.id), c])) };
  }
  return catMemo;
}
const itemName = (it) => it?.edit?.nameEn || it?.edit?.nameAr || it?.scraped?.nameEn || it?.scraped?.nameAr || it?.id;

// ------------------------------------------------------------------ storage
async function loadItems() {
  const all = await chrome.storage.local.get(null);
  S.items = new Map();
  for (const [k, v] of Object.entries(all)) if (k.startsWith(ITEM_PREFIX) && v?.id) S.items.set(v.id, v);
}
async function putItem(item) {
  item.updatedAt = now();
  S.items.set(item.id, item);
  await chrome.storage.local.set({ [ITEM_PREFIX + item.id]: item });
}
// read the freshest copy, mutate, write back
async function patchItem(id, fn) {
  const key = ITEM_PREFIX + id;
  const cur = (await chrome.storage.local.get(key))[key] || S.items.get(id);
  if (!cur) return null;
  await fn(cur);
  await putItem(cur);
  return cur;
}
async function deleteItems(ids) {
  await chrome.storage.local.remove(ids.map((id) => ITEM_PREFIX + id));
  ids.forEach((id) => {
    S.items.delete(id);
    S.selected.delete(id);
  });
}
async function saveSettings(next) {
  await chrome.storage.local.set({ settings: next });
  S.settings = deepMerge(DEFAULT_SETTINGS, next);
}

let renderTimer = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  let changed = false;
  for (const [k, { newValue }] of Object.entries(ch)) {
    if (!k.startsWith(ITEM_PREFIX)) continue;
    changed = true;
    const id = k.slice(ITEM_PREFIX.length);
    if (newValue) S.items.set(id, newValue);
    else S.items.delete(id);
  }
  if (changed) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => updateList(true), 150);
  }
});

// ------------------------------------------------------------------ API
const trimForLog = (v) => {
  try {
    const t = typeof v === 'string' ? v : JSON.stringify(v);
    return t && t.length > 15000 ? t.slice(0, 15000) + ' …(truncated)' : v;
  } catch {
    return String(v);
  }
};
let logTimer = null;
function recordApi(entry) {
  S.apiLog.unshift({ ...entry, env: S.env, response: trimForLog(entry.response) });
  S.apiLog.length = Math.min(S.apiLog.length, 60);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => chrome.storage.local.set({ apiLog: S.apiLog }).catch(() => {}), 300);
  if (refs.logBtn) refs.logBtn.textContent = `API log (${S.apiLog.length})`;
}

async function api(path, opts = {}) {
  try {
    return await apiFetch(baseUrl(), path, { token: session()?.token, onLog: recordApi, ...opts });
  } catch (e) {
    if (e.status === 401 && session()) {
      delete S.sessions[S.env];
      await chrome.storage.local.set({ sessions: S.sessions });
      toast('Session expired — please log in again', 'error');
      render();
    }
    throw e;
  }
}

async function login({ iso, code, number, password }) {
  let n = String(number || '').replace(/\D/g, '').replace(/^0+/, '');
  if (n.startsWith(code) && n.length > 9) n = n.slice(code.length);
  const body = { phone: { iso: iso.trim().toUpperCase(), code: String(code).replace(/\D/g, ''), number: n }, password };
  const resp = await apiFetch(baseUrl(), S.settings.endpoints.login, { method: 'POST', json: body, onLog: recordApi });
  const token = resp?.accessToken || resp?.access_token || resp?.data?.accessToken || resp?.data?.access_token;
  if (!token) throw new ApiError('Login response did not contain an accessToken', 200, resp);
  const user = resp.user || resp.data?.user || null;
  S.sessions[S.env] = {
    token,
    user,
    tokenInfo: resp.token && typeof resp.token === 'object' ? { id: resp.token.id, expires_at: resp.token.expires_at } : null,
    at: now(),
  };
  S.lastPhone = n;
  await chrome.storage.local.set({ sessions: S.sessions, lastPhone: n });
  return user;
}

async function logout() {
  delete S.sessions[S.env];
  await chrome.storage.local.set({ sessions: S.sessions });
  toast('Logged out — token removed');
  render();
}

async function loadLookups(force = false) {
  if (!session()) return;
  if (!force && S.lookups[S.env]?.fetchedAt) return;
  const ep = S.settings.endpoints;
  S.lookupsLoading = true;
  renderLookupStatus();
  const [b, c] = await Promise.allSettled([api(ep.brands), api(ep.categories)]);
  const next = { ...(S.lookups[S.env] || {}), fetchedAt: now() };
  S.lookupErrors = {};
  if (b.status === 'fulfilled') {
    S.lookupRaw.brands = b.value;
    next.brands = normalizeBrands(b.value, ep.brandsPath);
    if (!next.brands.length) S.lookupErrors.brands = new Error('Brands response had no items — check the JSON path in Settings');
  } else S.lookupErrors.brands = b.reason;
  if (c.status === 'fulfilled') {
    S.lookupRaw.categories = c.value;
    next.categories = normalizeCategories(c.value, ep.categoriesPath);
    if (!next.categories.length) S.lookupErrors.categories = new Error('Categories response had no items — check the JSON path in Settings');
  } else S.lookupErrors.categories = c.reason;
  S.lookups[S.env] = next;
  S.lookupsLoading = false;
  await chrome.storage.local.set({ lookups: S.lookups });
  const errs = Object.entries(S.lookupErrors);
  if (errs.length) toast(`Lookups: ${errs.map(([k, e]) => `${k} — ${e.message}`).join(' · ')}`, 'error');
  else toast(`Loaded ${next.brands.length} brands and ${flattenTree(next.categories).length} categories`);
  // auto-match brands for items that have none yet
  for (const it of S.items.values()) {
    if (it.edit?.brandId == null && it.scraped?.brand) {
      const m = matchBrand(it.scraped.brand, next.brands);
      if (m) await patchItem(it.id, (cur) => (cur.edit.brandId = m.id));
    }
  }
  render();
}

// ------------------------------------------------------------------ images & save
function fileNameFor(url, type) {
  let name = 'image';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
  } catch {
    /* ignore */
  }
  const ext = (type || '').split('/')[1]?.replace('jpeg', 'jpg').replace(/\+.*/, '');
  if (!/\.[a-z0-9]{2,5}$/i.test(name) && ext) name += `.${ext}`;
  return name.replace(/[^\w.\-]+/g, '_').slice(-120);
}

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

async function uploadOne(url) {
  let blob;
  try {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    blob = await r.blob();
  } catch (e) {
    throw new ApiError(`Could not download the image (${e.message}). If it is on another domain, add that domain in Settings → Sources. ${url}`);
  }
  if (!/^image\//.test(blob.type)) {
    const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    if (!MIME_BY_EXT[ext]) throw new ApiError(`Not an image (${blob.type || 'unknown type'}): ${url}`);
    blob = new Blob([blob], { type: MIME_BY_EXT[ext] });
  }
  const fd = new FormData();
  fd.append(S.settings.endpoints.uploadField || 'file', blob, fileNameFor(url, blob.type));
  const resp = await api(S.settings.endpoints.upload, { method: 'POST', form: fd });
  const media = extractMedia(resp);
  if (!media) throw new ApiError('The image was sent, but the response has no media id, path or URL — open “API log” to see what the server returned', 200, resp);
  delete media._raw;
  return { media, raw: resp };
}

async function uploadImagesFor(id, { onlyMissing = true } = {}) {
  const env = S.env;
  const it = S.items.get(id);
  if (!it) return;
  let failed = 0;
  let lastErr = null;
  for (const img of [...(it.images || [])]) {
    if (onlyMissing && img.uploads?.[env]) continue;
    if (S.busy) S.busy.sub = `image ${it.images.indexOf(img) + 1}/${it.images.length}`;
    renderBusy();
    try {
      const { media, raw } = await uploadOne(img.url);
      await patchItem(id, (cur) => {
        const t = cur.images.find((x) => x.url === img.url);
        if (t) {
          t.uploads = { ...(t.uploads || {}), [env]: media };
          t.uploadResponses = { ...(t.uploadResponses || {}), [env]: trimForLog(raw) };
          t.error = null;
        }
      });
    } catch (e) {
      failed++;
      lastErr = e;
      await patchItem(id, (cur) => {
        const t = cur.images.find((x) => x.url === img.url);
        if (t) {
          t.error = e.message;
          if (e.body != null) t.uploadResponses = { ...(t.uploadResponses || {}), [env]: trimForLog(e.body) };
        }
      });
    }
  }
  if (failed) {
    await patchItem(id, (cur) => (cur.lastError = errorInfo(lastErr, 'upload')));
    throw new ApiError(`${failed} image(s) failed to upload: ${lastErr.message}`, lastErr.status, lastErr.body);
  }
  await patchItem(id, (cur) => {
    if (cur.lastError?.op === 'upload') cur.lastError = null;
  });
}

async function saveOne(id) {
  await inlineEdits;
  const env = S.env;
  const ep = S.settings.endpoints;
  let it = S.items.get(id);
  const v = validate(it, S.settings);
  if (v.errors.length) {
    await patchItem(id, (cur) => (cur.lastError = { op: 'validate', message: v.errors.join(' · '), at: now() }));
    throw new Error(v.errors.join(' · '));
  }
  if (S.settings.payload.autoUploadOnSave && (it.images || []).some((i) => !i.uploads?.[env])) {
    await uploadImagesFor(id);
    it = S.items.get(id);
  }
  let pid = it.backend?.[env]?.productId ?? null;
  let base = null;
  if (pid != null) {
    try {
      base = unwrapProduct(await api(fillId(ep.get, pid)));
    } catch (e) {
      if (e.status === 404) pid = null; // deleted on the server → create again
      else base = it.backend[env].product || null;
    }
    if (pid != null && !base) base = it.backend[env].product || deepClone(S.settings.template);
  }
  const payload = buildPayload(pid != null ? base : S.settings.template, it, S.settings, env, { productId: pid });
  const cover = payload.media?.cover?.[0];
  if (!cover || !(cover.src || cover.mediaId || cover.id)) {
    const message = 'An uploaded product cover is required. Add an image in Edit and upload it, then save again.';
    await patchItem(id, (cur) => (cur.lastError = { op: 'validate', message, at: now() }));
    throw new Error(message);
  }
  try {
    const resp = pid != null ? await api(fillId(ep.update, pid), { method: ep.updateMethod || 'PUT', json: payload }) : await api(ep.create, { method: 'POST', json: payload });
    const prod = unwrapProduct(resp);
    const newId = productIdOf(prod) ?? pid;
    await patchItem(id, (cur) => {
      cur.backend = { ...(cur.backend || {}), [env]: { productId: newId, savedAt: now(), product: prod && typeof prod === 'object' ? prod : null, response: trimForLog(resp) } };
      cur.lastError = null;
    });
    if (newId == null) toast('Saved, but the response had no productId — the next save will create a new product.', 'warn');
    return newId;
  } catch (e) {
    await patchItem(id, (cur) => (cur.lastError = { ...errorInfo(e, pid != null ? 'update' : 'create'), payloadPreview: null }));
    throw e;
  }
}

// Ask for permission to download images from hosts we don't have yet (must run inside the click).
function requestImageHosts(ids) {
  const origins = new Set();
  for (const id of ids)
    for (const img of S.items.get(id)?.images || []) {
      try {
        const u = new URL(img.url);
        origins.add(`${u.protocol}//${u.hostname}/*`);
      } catch {
        /* ignore */
      }
    }
  if (!origins.size) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [...origins] }).catch(() => false);
}

async function runBulk(label, ids, fn, before) {
  if (S.busy) return toast('Another task is still running', 'warn');
  if (!ids.length) return toast('Select at least one product', 'warn');
  S.busy = { label, total: ids.length, done: 0, ok: 0, fail: 0, current: '', sub: '', stop: false };
  renderBusy();
  if (before) await before;
  for (const id of ids) {
    if (S.busy.stop) break;
    S.busy.current = itemName(S.items.get(id));
    S.busy.sub = '';
    renderBusy();
    try {
      await fn(id);
      S.busy.ok++;
    } catch (e) {
      S.busy.fail++;
      console.warn(label, id, e);
    }
    S.busy.done++;
    renderBusy();
    updateList();
  }
  const b = S.busy;
  S.busy = null;
  renderBusy();
  updateList();
  if (S.editId) render();
  toast(`${label}: ${b.ok} done${b.fail ? `, ${b.fail} failed (see the red messages)` : ''}${b.stop ? ' — stopped' : ''}`, b.fail ? 'warn' : 'ok');
}

// ------------------------------------------------------------------ import from tab / sources
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function importFromTab(all = false) {
  const tab = await activeTab();
  if (!tab || !/^https?:/.test(tab.url || '')) return toast('Open a product page in the browser tab first', 'warn');
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: all ? 'IMPORT_ALL' : 'IMPORT_ACTIVE' });
    if (!r?.ok) throw new Error(r?.error || 'Import failed');
    if (all) toast('Importing every product on the page — progress is shown on the page');
    else toast(r.created ? `Imported: ${r.name}` : r.priceChanged ? `Price changed: ${r.name}` : `Updated: ${r.name}`, r.priceChanged ? 'warn' : 'ok');
  } catch (e) {
    if (/Receiving end does not exist|Could not establish connection/i.test(e.message)) offerAddSource(hostOf(tab.url), tab);
    else toast(e.message, 'error');
  }
}

function offerAddSource(host, tab) {
  if (!host) return toast('This page cannot be used', 'warn');
  const known = S.settings.sources.some((s) => s.host === host || host.endsWith('.' + s.host));
  modal(
    known ? 'Reload the page' : 'Add this site as a source?',
    h(
      'p',
      {},
      known
        ? `The importer is not running on this tab yet. Reload the ${host} page and try again.`
        : `${host} is not in your source list. Add it so the Import buttons appear on its product pages? (Works best with Magento stores; other shops are read through their product data.)`
    ),
    known
      ? [{ label: 'Reload tab', primary: true, onClick: (close) => (chrome.tabs.reload(tab.id), close()) }]
      : [
          { label: 'Cancel', onClick: (close) => close() },
          { label: `Add ${host}`, primary: true, onClick: (close) => addSource(host, tab).then(close) },
        ]
  );
}

async function addSource(input, tab) {
  const host = cleanHost(input);
  if (!host || !host.includes('.')) return toast('Enter a domain like example.com', 'warn');
  const granted = await chrome.permissions.request({ origins: originsFor(host) }).catch((e) => (toast(e.message, 'error'), false));
  if (!granted) return toast('Permission was not granted', 'warn');
  await registerSource(host);
  const next = deepClone(S.settings);
  if (!next.sources.some((s) => s.host === host)) next.sources.push({ host });
  await saveSettings(next);
  const target = tab || (await activeTab());
  if (target && hostOf(target.url).endsWith(host)) {
    await chrome.scripting.insertCSS({ target: { tabId: target.id }, files: ['content/inject.css'] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['content/scraper.js', 'content/inject.js'] }).catch(() => {});
  }
  toast(`${host} added — Import buttons will show on its pages`);
  render();
}

async function removeSource(host) {
  await unregisterSource(host);
  await chrome.permissions.remove({ origins: originsFor(host) }).catch(() => {});
  const next = deepClone(S.settings);
  next.sources = next.sources.filter((s) => s.host !== host || s.builtIn);
  await saveSettings(next);
  render();
}

// ------------------------------------------------------------------ rendering
function render() {
  app.textContent = '';
  if (!session()) {
    app.append(renderLogin());
    renderBusy();
    return;
  }
  app.append(renderHeader());
  if (S.editId && S.items.has(S.editId)) app.append(renderEditor(S.items.get(S.editId)));
  else {
    S.editId = null;
    app.append(renderTabs(), S.tab === 'settings' ? renderSettings() : renderProducts());
  }
  renderBusy();
}

function envSelect(onChange) {
  return h(
    'select',
    {
      class: 'env-select',
      value: S.env,
      onchange: async (e) => {
        S.env = e.target.value;
        S.editId = null;
        await chrome.storage.local.set({ env: S.env });
        onChange?.();
        render();
        if (session()) loadLookups(false);
      },
    },
    Object.entries(S.settings.envs).map(([k, v]) => h('option', { value: k }, v.label || k))
  );
}

// ---------- login ----------
function renderLogin() {
  const st = { iso: S.settings.phone.iso, code: S.settings.phone.code };
  const err = h('div', { class: 'error-box', hidden: true });
  const number = h('input', { type: 'tel', placeholder: '7XXXXXXXX', autocomplete: 'username', value: S.lastPhone || '', required: true });
  const pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const iso = h('input', { class: 'iso', value: st.iso, maxlength: 2, title: 'Country ISO' });
  const code = h('input', { class: 'code', value: st.code, title: 'Country code' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Log in');
  const show = h('button', { type: 'button', class: 'icon-btn', title: 'Show password', onclick: () => (pass.type = pass.type === 'password' ? 'text' : 'password') }, '👁');
  const baseLine = h('div', { class: 'muted small' }, baseUrl());

  const form = h(
    'form',
    {
      class: 'login',
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        btn.disabled = true;
        btn.textContent = 'Logging in…';
        try {
          const user = await login({ iso: iso.value, code: code.value, number: number.value, password: pass.value });
          toast(`Welcome ${user?.fullName || user?.firstName || ''}`.trim());
          if (user?.roles && !user.roles.includes('admin')) toast('This account is not an admin — saving products may be refused.', 'warn');
          render();
          loadLookups(true);
        } catch (ex) {
          err.hidden = false;
          err.textContent = '';
          err.append(
            h('b', {}, ex.message || 'Login failed'),
            ex.status ? h('div', { class: 'muted small' }, `HTTP ${ex.status}`) : null,
            ...errorLines(ex.body).map((l) => h('div', {}, l)),
            ex.body ? h('details', { open: true }, h('summary', {}, 'Response JSON'), jsonBlock(ex.body)) : null
          );
        } finally {
          btn.disabled = false;
          btn.textContent = 'Log in';
        }
      },
    },
    h('div', { class: 'brand' }, h('img', { src: '../icons/icon48.png', alt: '' }), h('div', {}, h('b', {}, 'Action Product Importer'), h('div', { class: 'muted small' }, 'Log in with your Action admin account'))),
    h('label', { class: 'field' }, h('span', {}, 'Environment'), envSelect(() => (baseLine.textContent = baseUrl())), baseLine),
    h('label', { class: 'field' }, h('span', {}, 'Phone'), h('div', { class: 'phone' }, iso, h('span', { class: 'plus' }, '+'), code, number)),
    h('label', { class: 'field' }, h('span', {}, 'Password'), h('div', { class: 'pass' }, pass, show)),
    btn,
    err,
    h('button', { type: 'button', class: 'link', onclick: () => openSettingsBeforeLogin() }, 'Settings (API URLs)…')
  );
  return form;
}

function openSettingsBeforeLogin() {
  modal('Settings', renderSettings(true), []);
}

// ---------- header & tabs ----------
function renderHeader() {
  const u = session()?.user;
  return h(
    'header',
    { class: 'top' },
    h('img', { src: '../icons/icon32.png', alt: '', class: 'logo' }),
    h('div', { class: 'grow' }, h('b', {}, 'Action Importer'), h('div', { class: 'muted small ellipsis', title: baseUrl() }, u ? `${u.fullName || u.firstName || ''} · ${(u.roles || []).join(', ')}` : baseUrl())),
    envSelect(),
    (refs.logBtn = h('button', { class: 'btn small', title: 'Every request and the server response', onclick: showApiLog }, `API log (${S.apiLog.length})`)),
    h('button', { class: 'btn small', title: 'Log out and remove the token', onclick: logout }, 'Log out')
  );
}

function renderTabs() {
  const tab = (key, label) => h('button', { class: 'tab' + (S.tab === key ? ' on' : ''), onclick: () => ((S.tab = key), render()) }, label);
  refs.lookupStatus = h('span', { class: 'muted small lookup-status' });
  renderLookupStatus();
  return h('nav', { class: 'tabs' }, tab('products', `Products (${S.items.size})`), tab('settings', 'Settings'), h('span', { class: 'grow' }), refs.lookupStatus);
}

function renderLookupStatus() {
  const el = refs.lookupStatus;
  if (!el) return;
  el.textContent = '';
  if (S.lookupsLoading) return el.append('Loading lookups…');
  const l = S.lookups[S.env];
  el.append(
    l?.fetchedAt ? `${l.brands?.length || 0} brands · ${flattenTree(l.categories || []).length} cats` : 'No lookups',
    ' ',
    h('button', { class: 'link', title: 'Reload brands & categories', onclick: () => loadLookups(true) }, '↻')
  );
}

function showApiLog() {
  const list = h(
    'div',
    { class: 'apilog' },
    S.apiLog.length
      ? S.apiLog.map((e) =>
          h(
            'details',
            { class: 'apilog-row' },
            h(
              'summary',
              {},
              h('span', { class: `status ${e.ok ? 'ok' : 'err'}` }, e.status || 'ERR'),
              h('b', {}, ` ${e.method} `),
              h('span', { class: 'ellipsis' }, e.url.replace(/^https?:\/\/[^/]+/, '')),
              h('span', { class: 'muted small' }, ` · ${new Date(e.at).toLocaleTimeString()} · ${e.ms} ms · ${e.env}`)
            ),
            e.request ? h('div', {}, h('div', { class: 'small muted' }, 'Request'), jsonBlock(e.request, 20000)) : null,
            h('div', { class: 'small muted' }, 'Response'),
            jsonBlock(e.response, 20000)
          )
        )
      : h('div', { class: 'muted' }, 'No requests yet.')
  );
  modal('API log — latest first', list, [
    { label: 'Clear', onClick: async (c) => ((S.apiLog = []), await chrome.storage.local.set({ apiLog: [] }), recordApi && refs.logBtn && (refs.logBtn.textContent = 'API log (0)'), c()) },
    { label: 'Close', primary: true, onClick: (c) => c() },
  ]);
}

function tagsOf(it) {
  const env = S.env;
  const imgs = it.images || [];
  const up = imgs.filter((i) => i.uploads?.[env]).length;
  const failed = imgs.filter((i) => i.error && !i.uploads?.[env]).length;
  const be = it.backend?.[env];
  const tags = [['tag-done', 'Imported']];
  if (!imgs.length) tags.push(['tag-off', 'No images']);
  else if (up === imgs.length) tags.push(['tag-done', `Images ${up}/${imgs.length} ✓`]);
  else if (failed) tags.push(['tag-err', `Images ${up}/${imgs.length} · ${failed} failed`]);
  else tags.push(['tag-todo', `Images ${up}/${imgs.length}`]);
  if (be?.savedAt) tags.push(['tag-done', be.productId != null ? `Saved #${be.productId}` : 'Saved']);
  else tags.push(['tag-todo', 'Not saved']);
  if (it.lastError && !(it.lastError.op === 'upload' && be?.savedAt)) tags.push(['tag-err', it.lastError.op === 'validate' ? 'Needs info' : it.lastError.op === 'upload' ? 'Image problem' : 'Error']);
  return h('div', { class: 'tags' }, tags.map(([c, t]) => h('span', { class: `tag ${c}` }, t)));
}

// ---------- products ----------
function counts() {
  const env = S.env;
  const c = { all: 0, unsaved: 0, saved: 0, errors: 0, changed: 0 };
  for (const it of S.items.values()) {
    c.all++;
    if (it.backend?.[env]?.savedAt) c.saved++;
    else c.unsaved++;
    if (it.lastError) c.errors++;
    if (it.priceChangedAt && (!it.backend?.[env]?.savedAt || it.priceChangedAt > it.backend[env].savedAt)) c.changed++;
  }
  return c;
}

function filteredItems() {
  const env = S.env;
  const q = S.search.trim().toLowerCase();
  return [...S.items.values()]
    .filter((it) => {
      if (S.filter === 'unsaved' && it.backend?.[env]?.savedAt) return false;
      if (S.filter === 'saved' && !it.backend?.[env]?.savedAt) return false;
      if (S.filter === 'errors' && !it.lastError) return false;
      if (S.filter === 'changed' && !(it.priceChangedAt && (!it.backend?.[env]?.savedAt || it.priceChangedAt > it.backend[env].savedAt))) return false;
      if (q) {
        const hay = `${it.edit?.nameEn} ${it.edit?.nameAr} ${it.scraped?.sku} ${it.edit?.sku} ${it.source?.url} ${it.scraped?.brand}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function renderProducts() {
  const wrap = h('div', { class: 'view' });

  // import defaults
  const d = S.importDefaults;
  const brandLabel = brands().find((b) => String(b.id) === String(d.brandId))?.label;
  const summary = h('summary', {}, h('b', {}, 'Defaults for new imports'), h('span', { class: 'muted small' }, ` — ${brandLabel || 'no brand'} · ${(d.categories || []).length} categories`));
  const saveDefaults = async () => {
    await chrome.storage.local.set({ importDefaults: S.importDefaults });
    summary.lastChild.textContent = ` — ${brands().find((b) => String(b.id) === String(S.importDefaults.brandId))?.label || 'no brand'} · ${(S.importDefaults.categories || []).length} categories`;
  };
  wrap.append(
    h(
      'details',
      { class: 'card defaults', open: S.defaultsOpen, ontoggle: (e) => (S.defaultsOpen = e.target.open) },
      summary,
      h('div', { class: 'muted small' }, 'Products you import get this brand and these categories (a matching brand found on the page wins). You can change each product later.'),
      h('label', { class: 'field' }, h('span', {}, 'Brand'), BrandPicker({ brands: brands(), value: d.brandId, onChange: (id) => ((S.importDefaults.brandId = id), saveDefaults()) })),
      h(
        'div',
        { class: 'field' },
        h('span', {}, 'Categories'),
        CategoryTree({ roots: categories(), selected: d.categories, selectParents: S.settings.payload.selectParentCategories, onChange: (ids) => ((S.importDefaults.categories = ids), saveDefaults()) })
      ),
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            const ids = [...S.selected];
            if (!ids.length) return toast('Select products in the list first', 'warn');
            for (const id of ids)
              await patchItem(id, (cur) => {
                if (S.importDefaults.brandId != null) cur.edit.brandId = S.importDefaults.brandId;
                if (S.importDefaults.categories?.length) cur.edit.categories = [...S.importDefaults.categories];
              });
            toast(`Applied to ${ids.length} products`);
            updateList();
          },
        },
        'Apply brand & categories to selected'
      )
    )
  );

  // import bar
  wrap.append(
    h(
      'div',
      { class: 'card importbar' },
      h('button', { class: 'btn primary', onclick: () => importFromTab(false) }, '⬇ Import product in current tab'),
      h('button', { class: 'btn', onclick: () => importFromTab(true) }, 'Import all on page'),
      h('div', { class: 'muted small' }, 'Or use the purple “Import to Action” button on ', h('a', { href: 'https://abdeencenter.com/', target: '_blank' }, 'abdeencenter.com'), ' product and category pages.')
    )
  );

  // toolbar
  refs.toolbar = h('div', { class: 'toolbar' });
  refs.filters = h('div', { class: 'filters' });
  refs.list = h('div', { class: 'list' });
  wrap.append(refs.toolbar, refs.filters, refs.list);
  updateList();
  return wrap;
}

function selectedIds() {
  return [...S.selected].filter((id) => S.items.has(id));
}

function renderToolbar() {
  const tb = refs.toolbar;
  if (!tb) return;
  tb.textContent = '';
  const visible = filteredItems();
  const sel = selectedIds();
  const allOn = visible.length && visible.every((it) => S.selected.has(it.id));
  tb.append(
    h(
      'label',
      { class: 'selall', title: 'Select all shown' },
      h('input', {
        type: 'checkbox',
        checked: !!allOn,
        onchange: (e) => {
          visible.forEach((it) => (e.target.checked ? S.selected.add(it.id) : S.selected.delete(it.id)));
          updateList();
        },
      }),
      h('span', {}, sel.length ? `${sel.length} selected` : 'Select all')
    ),
    h(
      'button',
      {
        class: 'btn',
        disabled: !sel.length,
        title: 'Upload all images of the selected products to /upload-media',
        onclick: () => {
          const ids = selectedIds();
          runBulk('Upload images', ids, (id) => uploadImagesFor(id), requestImageHosts(ids));
        },
      },
      '⬆ Upload images'
    ),
    h(
      'button',
      {
        class: 'btn primary',
        disabled: !sel.length,
        title: 'Create new products / update saved ones',
        onclick: () => {
          const ids = selectedIds();
          runBulk('Save', ids, (id) => saveOne(id), requestImageHosts(ids));
        },
      },
      '💾 Save'
    ),
    h(
      'div',
      { class: 'menu' },
      h('button', { class: 'btn', onclick: (e) => e.currentTarget.parentElement.classList.toggle('open') }, '⋯'),
      h(
        'div',
        { class: 'menu-list', onclick: (e) => e.currentTarget.parentElement.classList.remove('open') },
        h('button', { onclick: () => doExport(sel.length ? sel : [...S.items.keys()]) }, `Export to Excel (${sel.length || 'all'})`),
        h('button', { onclick: doImportExcel }, 'Import from Excel / CSV…'),
        h(
          'button',
          {
            disabled: !sel.length,
            onclick: async () => {
              for (const id of selectedIds())
                await patchItem(id, (cur) => {
                  cur.lastError = null;
                });
              updateList();
            },
          },
          'Clear errors of selected'
        ),
        h(
          'button',
          {
            class: 'danger',
            disabled: !sel.length,
            onclick: () =>
              modal('Delete products?', h('p', {}, `Remove ${sel.length} products from this list? (Nothing is deleted on the website.)`), [
                { label: 'Cancel', onClick: (c) => c() },
                { label: 'Delete', primary: true, onClick: async (c) => (await deleteItems(selectedIds()), c(), updateList()) },
              ]),
          },
          'Delete selected from list'
        )
      )
    )
  );
}

function renderFilters() {
  const f = refs.filters;
  if (!f) return;
  const c = counts();
  const chip = (key, label, n) => h('button', { class: 'fchip' + (S.filter === key ? ' on' : ''), onclick: () => ((S.filter = key), updateList()) }, `${label} ${n}`);
  if (!f.firstChild) {
    refs.chipBox = h('div', { class: 'chipbox' });
    refs.searchInput = h('input', {
      type: 'search',
      placeholder: 'Search name, SKU, URL…',
      value: S.search,
      oninput: (e) => {
        S.search = e.target.value;
        updateList(true);
      },
    });
    f.append(refs.chipBox, refs.searchInput);
  }
  refs.chipBox.textContent = '';
  refs.chipBox.append(chip('all', 'All', c.all), chip('unsaved', 'Not saved', c.unsaved), chip('saved', 'Saved', c.saved), chip('errors', 'Errors', c.errors), chip('changed', 'Price changed', c.changed));
}

function updateList(preservePickers = false) {
  if (!refs.list || !refs.list.isConnected) return;
  // Keep an active picker intact while storage notifications arrive.
  if (preservePickers && (refs.list.querySelector('.item-taxonomy details[open]') || document.activeElement?.closest('.item-taxonomy'))) return;
  renderToolbar();
  renderFilters();
  const list = refs.list;
  list.textContent = '';
  const items = filteredItems();
  if (!items.length) {
    list.append(
      h(
        'div',
        { class: 'empty' },
        S.items.size
          ? 'No products match this filter.'
          : h('div', {}, h('b', {}, 'No products yet.'), h('p', {}, 'Open a product on abdeencenter.com and click “Import to Action”, or use “Import all on page” on a category page.'))
      )
    );
    return;
  }
  for (const it of items) list.append(itemCard(it));
  const tabBtn = document.querySelector('.tab');
  if (tabBtn) tabBtn.textContent = `Products (${S.items.size})`;
}

function statusOf(it) {
  const env = S.env;
  const be = it.backend?.[env];
  const imgs = it.images || [];
  const up = imgs.filter((i) => i.uploads?.[env]).length;
  if (it.lastError) return ['err', it.lastError.op === 'validate' ? 'Needs info' : 'Error'];
  if (be?.savedAt) return ['ok', be.productId != null ? `Saved #${be.productId}` : 'Saved'];
  if (imgs.length && up === imgs.length) return ['info', 'Images ready'];
  return ['new', 'Not saved'];
}

function itemCard(it) {
  const env = S.env;
  const s = it.scraped || {};
  const e = it.edit || {};
  const imgs = it.images || [];
  const up = imgs.filter((i) => i.uploads?.[env]).length;
  const thumb = imgs[0]?.uploads?.[env]?.preview || imgs[0]?.url;
  const ph = it.priceHistory || [];
  const prev = ph.length > 1 ? ph[ph.length - 2].price : null;
  const [cls, label] = statusOf(it);
  const brand = brands().find((b) => String(b.id) === String(e.brandId));
  const cats = (e.categories || []).map((id) => catIndex().byId.get(String(id))?.label || `#${id}`);
  const open = () => {
    S.editId = it.id;
    render();
  };
  const taxonomyStatus = h('span', { class: 'small muted', role: 'status' });
  const changeTaxonomy = (key, value) => {
    taxonomyStatus.textContent = 'Saving selection…';
    const write = () => patchItem(it.id, (cur) => {
      cur.edit[key] = value;
      cur.dirty = [...new Set([...(cur.dirty || []), key])];
      if (cur.lastError?.op === 'validate') cur.lastError = null;
    });
    inlineEdits = inlineEdits.catch(() => {}).then(write);
    inlineEdits.then(() => {
      taxonomyStatus.textContent = 'Selection saved locally';
    }).catch((error) => {
      taxonomyStatus.textContent = `Could not save selection: ${error.message}`;
    });
  };
  const categorySummary = h('summary', {}, `Categories (${(e.categories || []).length})`);
  const taxonomy = h('div', {
    class: 'item-taxonomy',
    onfocusout: () => setTimeout(() => updateList(true), 150),
  },
  h('label', { class: 'field' }, h('span', {}, 'Brand'), BrandPicker({
    brands: brands(), value: e.brandId,
    onChange: (id) => changeTaxonomy('brandId', id),
  })),
  h('details', { ontoggle: (event) => { if (!event.target.open) updateList(true); } },
    categorySummary,
    CategoryTree({
      roots: categories(), selected: e.categories,
      selectParents: S.settings.payload.selectParentCategories,
      onChange: (ids) => {
        categorySummary.textContent = `Categories (${ids.length})`;
        changeTaxonomy('categories', ids);
      },
    })
  ), taxonomyStatus);
  return h(
    'div',
    { class: 'item' + (S.selected.has(it.id) ? ' sel' : '') },
    h('input', {
      type: 'checkbox',
      class: 'pick',
      checked: S.selected.has(it.id),
      onchange: (ev) => {
        ev.target.checked ? S.selected.add(it.id) : S.selected.delete(it.id);
        ev.target.closest('.item').classList.toggle('sel', ev.target.checked);
        renderToolbar();
      },
    }),
    h('div', { class: 'cover-preview' },
      h('button', { type: 'button', class: 'thumb', onclick: open, title: 'Edit images and choose product cover' }, thumb ? h('img', { src: thumb, loading: 'lazy', alt: 'Product cover' }) : h('span', {}, 'Add cover')),
      h('span', { class: 'small ' + (imgs[0]?.uploads?.[env] ? 'ok-t' : 'warn-t') }, imgs[0]?.uploads?.[env] ? 'Cover ready' : imgs.length ? 'Cover not uploaded' : 'Cover required')
    ),
    h(
      'div',
      { class: 'info' },
      h('div', { class: 'row1' }, h('a', { class: 'name', href: '#', onclick: (ev) => (ev.preventDefault(), open()) }, e.nameEn || e.nameAr || '(no name)')),
      tagsOf(it),
      e.nameAr && e.nameAr !== e.nameEn ? h('div', { class: 'ar small' }, e.nameAr) : null,
      h(
        'div',
        { class: 'prices small' },
        h('b', {}, fmtMoney(e.price, S.settings.defaults.currency)),
        e.priceBeforeOffer ? h('s', { class: 'muted' }, ` ${fmtMoney(e.priceBeforeOffer, '')}`) : null,
        h('span', { class: 'muted' }, ` · source ${fmtMoney(s.price, s.currency)}`),
        prev != null && prev !== s.price ? h('span', { class: s.price > prev ? 'up' : 'down' }, ` ${s.price > prev ? '▲' : '▼'} from ${fmtMoney(prev, '')}`) : null,
        s.inStock === false ? h('span', { class: 'down' }, ' · out of stock') : null
      ),
      h(
        'div',
        { class: 'meta small muted' },
        brand ? `${brand.label}` : h('span', { class: 'warn-t' }, s.brand ? `brand? (${s.brand})` : 'no brand'),
        ' · ',
        cats.length ? cats.slice(0, 3).join(', ') + (cats.length > 3 ? ` +${cats.length - 3}` : '') : h('span', { class: 'warn-t' }, 'no category'),
        (s.langs || []).length ? ` · ${(s.langs || []).join('+').toUpperCase()}` : ''
      ),
      it.lastError ? h('div', { class: 'err small', title: JSON.stringify(it.lastError.body || '') }, `${it.lastError.op}: ${it.lastError.message}`, ...errorLines(it.lastError.body).slice(0, 3).map((l) => h('div', {}, '• ' + l))) : null,
      taxonomy,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn tiny', onclick: open }, 'Edit'),
        h('button', { class: 'btn tiny', onclick: () => runBulk('Upload images', [it.id], (id) => uploadImagesFor(id), requestImageHosts([it.id])) }, 'Upload images'),
        h('button', { class: 'btn tiny primary', onclick: () => runBulk('Save', [it.id], (id) => saveOne(id), requestImageHosts([it.id])) }, it.backend?.[env]?.savedAt ? 'Update' : 'Save'),
        s.url ? h('a', { class: 'btn tiny', href: s.url, target: '_blank', title: 'Open source page' }, '↗') : null
      )
    )
  );
}

// ---------- busy bar ----------
function renderBusy() {
  if (!refs.busy) {
    refs.busy = h('div', { class: 'busy', hidden: true });
    document.body.append(refs.busy);
  }
  const b = S.busy;
  refs.busy.hidden = !b;
  if (!b) return;
  refs.busy.textContent = '';
  const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
  refs.busy.append(
    h('div', { class: 'busy-text' }, h('b', {}, `${b.label} ${b.done}/${b.total}`), ` — ${b.current}${b.sub ? ` (${b.sub})` : ''}`, b.fail ? h('span', { class: 'down' }, ` · ${b.fail} failed`) : null),
    h('div', { class: 'bar' }, h('div', { style: { width: `${pct}%` } })),
    h('button', { class: 'btn tiny', onclick: () => (b.stop = true) }, b.stop ? 'Stopping…' : 'Stop')
  );
}

// ---------- editor ----------
function renderEditor(it) {
  const env = S.env;
  const e = deepClone(it.edit || {});
  const dirty = new Set(it.dirty || []);
  let timer = null;
  let pending = Promise.resolve();
  const flush = () => {
    clearTimeout(timer);
    pending = patchItem(it.id, (cur) => {
      cur.edit = { ...cur.edit, ...e };
      cur.dirty = [...new Set([...(cur.dirty || []), ...dirty])];
      if (cur.lastError?.op === 'validate' && dirty.size) cur.lastError = null;
    });
    return pending;
  };
  const notes = h('div', { class: 'card notes small' });
  const refreshNotes = () => {
    const vv = validate({ ...it, edit: e }, S.settings);
    notes.textContent = '';
    notes.hidden = !vv.errors.length && !vv.warnings.length;
    notes.append(...vv.errors.map((x) => h('div', { class: 'down' }, '✕ ' + x)), ...vv.warnings.map((x) => h('div', { class: 'warn-t' }, '! ' + x)));
  };
  const set = (k, v) => {
    e[k] = v;
    dirty.add(k);
    refreshNotes();
    clearTimeout(timer);
    timer = setTimeout(flush, 350);
  };
  const back = async () => {
    await flush();
    S.editId = null;
    render();
  };
  const rerender = async () => {
    await flush();
    render();
  };

  const s = it.scraped || {};
  const input = (label, key, { type = 'text', dir, step, placeholder, cls } = {}) =>
    h(
      'label',
      { class: `field ${cls || ''}` },
      h('span', {}, label),
      h('input', {
        type,
        dir,
        step,
        placeholder,
        value: e[key] ?? '',
        oninput: (ev) => set(key, type === 'number' ? (ev.target.value === '' ? null : Number(ev.target.value)) : ev.target.value),
      })
    );
  const check = (label, key) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!e[key], onchange: (ev) => set(key, ev.target.checked) }), label);

  const descField = (label, key, dir) => {
    const preview = h('div', { class: 'desc-preview', dir, html: e[key] || '<span class="muted">empty</span>' });
    const ta = h('textarea', {
      rows: 7,
      dir: 'ltr',
      class: 'mono',
      value: e[key] || '',
      oninput: (ev) => {
        set(key, ev.target.value);
        preview.innerHTML = ev.target.value;
      },
    });
    return h('div', { class: 'field' }, h('span', {}, label), preview, h('details', {}, h('summary', { class: 'small' }, 'Edit HTML'), ta));
  };

  refreshNotes();
  const be = it.backend?.[env];

  const header = h(
    'div',
    { class: 'editor-head' },
    h('button', { class: 'btn small', onclick: back }, '← Back'),
    h('div', { class: 'grow ellipsis' }, h('b', {}, e.nameEn || e.nameAr || 'Product')),
    h(
      'button',
      {
        class: 'btn small',
        onclick: async () => {
          await flush();
          const fresh = S.items.get(it.id);
          const base = be?.productId != null ? be.product || S.settings.template : S.settings.template;
          modal(`Payload (${be?.productId != null ? `PUT #${be.productId}` : 'POST new'})`, jsonBlock(buildPayload(base, fresh, S.settings, env, { productId: be?.productId ?? null })));
        },
      },
      '{ } JSON'
    ),
    h(
      'button',
      {
        class: 'btn small',
        onclick: async () => {
          const perm = requestImageHosts([it.id]);
          await flush();
          await runBulk('Upload images', [it.id], (id) => uploadImagesFor(id), perm);
        },
      },
      '⬆ Images'
    ),
    h(
      'button',
      {
        class: 'btn small primary',
        onclick: async () => {
          const perm = requestImageHosts([it.id]);
          await flush();
          await runBulk('Save', [it.id], (id) => saveOne(id), perm);
        },
      },
      be?.savedAt ? `💾 Update #${be.productId ?? ''}` : '💾 Save'
    )
  );

  // source panel
  const ph = it.priceHistory || [];
  const sourceCard = h(
    'details',
    { class: 'card', open: true },
    h('summary', {}, h('b', {}, 'Source'), h('span', { class: 'muted small' }, ` — ${s.site || ''} · scraped ${timeAgo(s.scrapedAt)}`)),
    h(
      'div',
      { class: 'kv small' },
      h('span', {}, 'Page'),
      s.url ? h('a', { href: s.url, target: '_blank' }, s.url) : '—',
      h('span', {}, 'Price'),
      h('span', {}, fmtMoney(s.price, s.currency), s.oldPrice ? h('s', { class: 'muted' }, ` ${fmtMoney(s.oldPrice, '')}`) : null, s.inStock === false ? h('span', { class: 'down' }, ' · out of stock') : s.inStock ? ' · in stock' : ''),
      h('span', {}, 'SKU'),
      h('span', {}, s.sku || '—'),
      h('span', {}, 'Brand on page'),
      h('span', {}, s.brand || '—'),
      h('span', {}, 'Breadcrumb'),
      h('span', {}, (s.breadcrumbsEn?.length ? s.breadcrumbsEn : s.breadcrumbsAr || []).join(' › ') || '—'),
      h('span', {}, 'Languages'),
      h('span', {}, (s.langs || []).join(', ').toUpperCase() || '—')
    ),
    (s.specsEn?.length || s.specsAr?.length) &&
      h(
        'details',
        {},
        h('summary', { class: 'small' }, `Specifications (${(s.specsEn || s.specsAr).length})`),
        h('div', { class: 'specs small' }, ...(s.specsEn?.length ? s.specsEn : []).map((x) => h('div', {}, h('b', {}, x.label + ': '), x.value)), ...(s.specsAr || []).map((x) => h('div', { dir: 'rtl' }, h('b', {}, x.label + ': '), x.value)))
      ),
    ph.length > 0 &&
      h(
        'details',
        {},
        h('summary', { class: 'small' }, `Price history (${ph.length})`),
        h('table', { class: 'small hist' }, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Price'), h('th', {}, 'Old')), ...[...ph].reverse().map((p) => h('tr', {}, h('td', {}, new Date(p.at).toLocaleString()), h('td', {}, fmtMoney(p.price, '')), h('td', {}, p.oldPrice != null ? fmtMoney(p.oldPrice, '') : ''))))
      ),
    h(
      'button',
      {
        class: 'btn tiny',
        title: 'Overwrite names, descriptions and prices with the scraped values',
        onclick: async () => {
          await patchItem(it.id, (cur) => {
            const fresh = editFromScraped(cur.scraped, S.settings, { brandId: cur.edit.brandId, categories: cur.edit.categories });
            cur.edit = { ...cur.edit, ...fresh, brandId: cur.edit.brandId, categories: cur.edit.categories };
            cur.dirty = [];
          });
          render();
        },
      },
      'Reset fields from source'
    )
  );

  // images
  const imgs = it.images || [];
  const moveImg = async (i, to) => {
    await flush();
    await patchItem(it.id, (cur) => {
      const [x] = cur.images.splice(i, 1);
      cur.images.splice(to, 0, x);
    });
    render();
  };
  const imgGrid = h(
    'div',
    { class: 'imgs' },
    imgs.map((img, i) => {
      const m = img.uploads?.[env];
      return h(
        'div',
        { class: 'img' + (i === 0 ? ' cover' : '') + (img.error ? ' bad' : '') },
        h('a', { href: img.url, target: '_blank', title: img.url }, h('img', { src: m?.preview || img.url, loading: 'lazy', alt: '' })),
        h('div', { class: 'img-tag small' }, i === 0 ? 'Cover' : `#${i + 1}`, ' · ', m ? h('span', { class: 'ok-t' }, m.id != null ? `uploaded #${m.id}` : 'uploaded ✓') : img.error ? h('span', { class: 'down', title: img.error }, 'failed') : h('span', { class: 'muted' }, 'not uploaded')),
        h(
          'div',
          { class: 'img-actions' },
          img.uploadResponses?.[env] != null ? h('button', { class: 'btn tiny', title: 'Server response for this image', onclick: () => modal('Upload response', jsonBlock(img.uploadResponses[env])) }, '{ }') : null,
          i > 0 ? h('button', { class: 'btn tiny', title: 'Make cover', onclick: () => moveImg(i, 0) }, '★ Make cover') : null,
          i > 0 ? h('button', { class: 'btn tiny', title: 'Move left', onclick: () => moveImg(i, i - 1) }, '←') : null,
          i < imgs.length - 1 ? h('button', { class: 'btn tiny', title: 'Move right', onclick: () => moveImg(i, i + 1) }, '→') : null,
          h(
            'button',
            {
              class: 'btn tiny',
              title: 'Upload again',
              onclick: async () => {
                const perm = requestImageHosts([it.id]);
                await flush();
                await patchItem(it.id, (cur) => {
                  const t = cur.images[i];
                  if (t?.uploads) delete t.uploads[env];
                });
                await runBulk('Upload images', [it.id], (id) => uploadImagesFor(id), perm);
              },
            },
            '⟳'
          ),
          h(
            'button',
            {
              class: 'btn tiny danger',
              title: 'Remove image',
              onclick: async () => {
                await flush();
                await patchItem(it.id, (cur) => cur.images.splice(i, 1));
                render();
              },
            },
            '✕'
          )
        )
      );
    })
  );
  const addUrl = h('input', { type: 'url', placeholder: 'Add image by URL…' });
  const imagesCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title' }, h('b', {}, `Images (${imgs.filter((i) => i.uploads?.[env]).length}/${imgs.length} uploaded to ${envCfg().label})`)),
    imgs.length ? imgGrid : h('div', { class: 'muted small' }, 'No images found on the page.'),
    h(
      'div',
      { class: 'row' },
      addUrl,
      h(
        'button',
        {
          class: 'btn small',
          onclick: async () => {
            const u = addUrl.value.trim();
            if (!/^https?:\/\//.test(u)) return toast('Enter a full image URL', 'warn');
            await flush();
            await patchItem(it.id, (cur) => cur.images.push({ url: u, uploads: {} }));
            render();
          },
        },
        'Add'
      )
    )
  );

  const brandHint = s.brand && !brands().some((b) => String(b.id) === String(e.brandId)) ? `Brand on the source page: ${s.brand}` : null;

  const body = h(
    'div',
    { class: 'view editor' },
    notes,
    it.lastError && it.lastError.op !== 'validate'
      ? h(
          'div',
          { class: 'card error-box' },
          h('b', {}, `Last ${it.lastError.op} error: ${it.lastError.message}`),
          it.lastError.status ? h('div', { class: 'small muted' }, `HTTP ${it.lastError.status} ${it.lastError.url || ''}`) : null,
          ...errorLines(it.lastError.body).map((l) => h('div', { class: 'small' }, '• ' + l)),
          it.lastError.body ? h('details', {}, h('summary', { class: 'small' }, 'Response JSON'), jsonBlock(it.lastError.body)) : null
        )
      : null,
    be?.savedAt
      ? h(
          'div',
          { class: 'card ok-box small' },
          `Saved on ${envCfg().label} as product #${be.productId ?? '?'} · ${timeAgo(be.savedAt)}. Saving again updates that product.`,
          be.response != null ? h('button', { class: 'btn tiny', onclick: () => modal('Save response', jsonBlock(be.response)) }, 'Show server response') : null
        )
      : null,
    sourceCard,
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'grid2' }, input('Name (English)', 'nameEn'), input('Name (Arabic)', 'nameAr', { dir: 'rtl', cls: 'ar' })),
      input('Slug', 'slug', { placeholder: slugify(e.nameEn || e.nameAr) }),
      h('label', { class: 'field' }, h('span', {}, 'Brand'), BrandPicker({ brands: brands(), value: e.brandId, onChange: (id) => set('brandId', id), hint: brandHint })),
      h('div', { class: 'field' }, h('span', {}, 'Categories'), CategoryTree({ roots: categories(), selected: e.categories, selectParents: S.settings.payload.selectParentCategories, onChange: (ids) => set('categories', ids) }))
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'grid3' },
        input(`Price (${S.settings.defaults.currency})`, 'price', { type: 'number', step: '0.001' }),
        input('Price before offer', 'priceBeforeOffer', { type: 'number', step: '0.001', placeholder: 'none' }),
        input('Cost', 'cost', { type: 'number', step: '0.001' }),
        input('Quantity', 'quantity', { type: 'number', step: '1' }),
        input('Max per user', 'maxPerUser', { type: 'number', step: '1' }),
        h('div', {})
      ),
      h('div', { class: 'grid2' }, input('SKU', 'sku'), input('Model number', 'modelNumber')),
      h('div', { class: 'row' }, check('Published', 'isPublished'), check('Listed', 'isListed'))
    ),
    h('div', { class: 'card' }, descField('Description (English, HTML)', 'descEn', 'ltr'), descField('Description (Arabic, HTML)', 'descAr', 'rtl')),
    imagesCard
  );
  return h('div', {}, header, body);
}

// ---------- settings ----------
function renderSettings(beforeLogin = false) {
  const d = deepClone(S.settings);
  const wrap = h('div', { class: 'view settings' });
  const text = (obj, key, label, opts = {}) =>
    h('label', { class: 'field' }, h('span', {}, label), h('input', { type: opts.type || 'text', value: obj[key] ?? '', placeholder: opts.placeholder, oninput: (e) => (obj[key] = opts.type === 'number' ? Number(e.target.value) : e.target.value) }), opts.hint ? h('div', { class: 'hint' }, opts.hint) : null);
  const bool = (obj, key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => (obj[key] = e.target.checked) }), label);
  const section = (title, ...kids) => h('details', { class: 'card', open: beforeLogin && title.startsWith('API') }, h('summary', {}, h('b', {}, title)), ...kids);

  // environments
  const envBox = h('div', {});
  const drawEnvs = () => {
    envBox.textContent = '';
    for (const [k, v] of Object.entries(d.envs)) {
      envBox.append(
        h(
          'div',
          { class: 'env-row' },
          h('input', { class: 'env-label', value: v.label || k, oninput: (e) => (v.label = e.target.value) }),
          h('input', { class: 'grow', value: v.baseUrl, oninput: (e) => (v.baseUrl = e.target.value.trim()) }),
          !['production', 'staging'].includes(k) ? h('button', { class: 'btn tiny danger', onclick: () => (delete d.envs[k], drawEnvs()) }, '✕') : null
        )
      );
    }
  };
  drawEnvs();

  const tpl = h('textarea', { rows: 14, class: 'mono', value: JSON.stringify(d.template, null, 2) });
  const ovr = h('textarea', { rows: 4, class: 'mono', value: JSON.stringify(d.overrides || {}, null, 2) });
  const strip = h('textarea', { rows: 3, value: (d.stripTerms || []).join('\n') });
  const shipping = h('input', { value: (d.defaults.shippingCarriers || []).join(', ') });

  const save = h(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        // ask for permission for custom API hosts (must happen inside the click)
        const extra = Object.values(d.envs)
          .map((v) => {
            try {
              const u = new URL(v.baseUrl);
              return /(^|\.)action\.jo$/.test(u.hostname) ? null : `${u.protocol}//${u.hostname}/*`;
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const permP = extra.length ? chrome.permissions.request({ origins: extra }).catch(() => false) : Promise.resolve(true);
        try {
          d.template = JSON.parse(tpl.value);
        } catch (e) {
          return toast(`Product template is not valid JSON: ${e.message}`, 'error');
        }
        try {
          d.overrides = ovr.value.trim() ? JSON.parse(ovr.value) : {};
        } catch (e) {
          return toast(`Extra JSON is not valid: ${e.message}`, 'error');
        }
        d.stripTerms = strip.value.split('\n').map((x) => x.trim()).filter(Boolean);
        d.defaults.shippingCarriers = shipping.value.split(/[,\s]+/).filter(Boolean).map(Number).filter((x) => !isNaN(x));
        if (!(await permP)) toast('No permission for the custom API host — requests to it will fail', 'warn');
        await saveSettings(d);
        toast('Settings saved');
        render();
      },
    },
    'Save settings'
  );

  const newEnvKey = h('input', { placeholder: 'key e.g. local' });
  wrap.append(
    section(
      'API environments',
      h('div', { class: 'muted small' }, 'Base URL of the API for each environment (switch in the header). Production and Staging are kept separately, with separate logins.'),
      envBox,
      h(
        'div',
        { class: 'row' },
        newEnvKey,
        h(
          'button',
          {
            class: 'btn small',
            onclick: () => {
              const k = newEnvKey.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
              if (!k || d.envs[k]) return;
              d.envs[k] = { label: k, baseUrl: 'https://' };
              newEnvKey.value = '';
              drawEnvs();
            },
          },
          '+ Add environment'
        )
      )
    ),
    section(
      'API endpoints',
      h('div', { class: 'muted small' }, 'Paths are added to the base URL. {id} is replaced with the product id.'),
      text(d.endpoints, 'login', 'Login (POST)'),
      h('div', { class: 'grid2' }, text(d.endpoints, 'brands', 'Brands lookup (GET)'), text(d.endpoints, 'brandsPath', 'Brands JSON path', { placeholder: 'auto (e.g. data)' })),
      h('div', { class: 'grid2' }, text(d.endpoints, 'categories', 'Categories lookup (GET)'), text(d.endpoints, 'categoriesPath', 'Categories JSON path', { placeholder: 'auto (e.g. data)' })),
      h('div', { class: 'grid2' }, text(d.endpoints, 'upload', 'Upload image (POST multipart)'), text(d.endpoints, 'uploadField', 'File field name')),
      text(d.endpoints, 'create', 'Create product (POST)'),
      text(d.endpoints, 'get', 'Get product (GET)'),
      h(
        'div',
        { class: 'grid2' },
        text(d.endpoints, 'update', 'Update product'),
        h('label', { class: 'field' }, h('span', {}, 'Update method'), h('select', { value: d.endpoints.updateMethod, onchange: (e) => (d.endpoints.updateMethod = e.target.value) }, ['PUT', 'PATCH', 'POST'].map((m) => h('option', { value: m }, m))))
      ),
      !beforeLogin &&
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn small', onclick: () => loadLookups(true) }, '↻ Reload lookups'),
          h('button', { class: 'btn small', onclick: () => modal('Last brands response', jsonBlock(S.lookupRaw.brands ?? 'Not loaded in this session — click Reload lookups', 20000)) }, 'Brands raw'),
          h('button', { class: 'btn small', onclick: () => modal('Last categories response', jsonBlock(S.lookupRaw.categories ?? 'Not loaded in this session — click Reload lookups', 20000)) }, 'Categories raw')
        ),
      ...Object.entries(S.lookupErrors).map(([k, e]) => h('div', { class: 'err small' }, `${k}: ${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`))
    ),
    section(
      'Login phone',
      h('div', { class: 'grid2' }, text(d.phone, 'iso', 'Country ISO'), text(d.phone, 'code', 'Country code'))
    ),
    section(
      'New product defaults',
      h(
        'div',
        { class: 'grid3' },
        text(d.defaults, 'quantity', 'Quantity', { type: 'number' }),
        text(d.defaults, 'maxPerUser', 'Max per user', { type: 'number' }),
        text(d.defaults, 'cost', 'Cost', { type: 'number' }),
        text(d.defaults, 'supplierId', 'Supplier ID', { type: 'number' }),
        text(d.defaults, 'currencyId', 'Currency ID', { type: 'number' }),
        text(d.defaults, 'currency', 'Currency code')
      ),
      h('label', { class: 'field' }, h('span', {}, 'Shipping carrier IDs'), shipping),
      h('div', { class: 'row' }, bool(d.defaults, 'isPublished', 'Published'), bool(d.defaults, 'isListed', 'Listed'))
    ),
    section(
      'Pricing rule',
      h('div', { class: 'muted small' }, 'Our price = source price × (1 + markup%) rounded to the nearest “round to” (0 = no rounding).'),
      h('div', { class: 'grid2' }, text(d.pricing, 'markupPercent', 'Markup %', { type: 'number' }), text(d.pricing, 'roundTo', 'Round to', { type: 'number', hint: 'e.g. 0.5 or 1' })),
      bool(d.pricing, 'useOldPriceAsOffer', 'If the source shows a crossed-out price, use it as “price before offer”')
    ),
    section(
      'Text & SEO',
      h('label', { class: 'field' }, h('span', {}, 'Remove sentences that mention (one per line)'), strip, h('div', { class: 'hint' }, 'Applies to descriptions scraped after saving.')),
      text(d.meta, 'titleEn', 'Meta title EN ({name})'),
      text(d.meta, 'titleAr', 'Meta title AR ({name})'),
      text(d.meta, 'descEn', 'Meta description EN'),
      text(d.meta, 'descAr', 'Meta description AR')
    ),
    section(
      'Save payload',
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Where uploaded images go in the payload'),
        h(
          'select',
          { value: d.payload.mediaMode, onchange: (e) => (d.payload.mediaMode = e.target.value) },
          h('option', { value: 'mediaCollective' }, 'mediaCollective.cover / gallery'),
          h('option', { value: 'media' }, 'media.cover / gallery'),
          h('option', { value: 'both' }, 'both')
        )
      ),
      bool(d.payload, 'coverInGallery', 'Also put the cover image in the gallery'),
      bool(d.payload, 'autoUploadOnSave', 'Upload missing images automatically when saving'),
      bool(d.payload, 'requireBrand', 'Brand is required'),
      bool(d.payload, 'requireCategories', 'At least one category is required'),
      bool(d.payload, 'selectParentCategories', 'Selecting a sub-category also selects its parents'),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Product template (JSON) — the base for new products'),
        tpl,
        h('div', { class: 'row' }, h('button', { class: 'btn tiny', onclick: () => (tpl.value = JSON.stringify(DEFAULT_TEMPLATE, null, 2)) }, 'Reset template'), h('span', { class: 'hint' }, 'Tip: paste the request payload your admin panel sends when you create a product.'))
      ),
      h('label', { class: 'field' }, h('span', {}, 'Extra JSON merged into every payload'), ovr)
    ),
    beforeLogin ? null : renderSourcesSection(section),
    beforeLogin ? null : renderDataSection(section),
    h('div', { class: 'row sticky-save' }, save, h('button', { class: 'btn', onclick: () => modal('Reset settings?', h('p', {}, 'Restore all settings to the defaults? Products are kept.'), [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Reset', primary: true, onClick: async (c) => (await chrome.storage.local.remove('settings'), (S.settings = await loadSettings()), c(), render()) }]) }, 'Reset all'))
  );
  return wrap;
}

function renderSourcesSection(section) {
  const inp = h('input', { placeholder: 'example.com' });
  return section(
    'Source sites',
    h('div', { class: 'muted small' }, 'Shops where the Import buttons are added. abdeencenter.com is built in; add more Magento (or other) stores here.'),
    ...S.settings.sources.map((s) =>
      h('div', { class: 'row src' }, h('span', { class: 'grow' }, s.host, s.builtIn ? h('span', { class: 'muted small' }, ' (built in)') : null), !s.builtIn ? h('button', { class: 'btn tiny danger', onclick: () => removeSource(s.host) }, 'Remove') : null)
    ),
    h('div', { class: 'row' }, inp, h('button', { class: 'btn small', onclick: () => addSource(inp.value) }, '+ Add site'), h('button', { class: 'btn small', onclick: async () => addSource(hostOf((await activeTab())?.url || '')) }, '+ Current tab'))
  );
}

function renderDataSection(section) {
  return section(
    'Backup',
    h('div', { class: 'muted small' }, 'Save everything (products, settings) to a JSON file, or restore it on another computer. Login tokens are not included.'),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn small',
          onclick: async () => {
            const { settings, importDefaults, siteMeta } = await chrome.storage.local.get(['settings', 'importDefaults', 'siteMeta']);
            const blob = new Blob([JSON.stringify({ app: 'action-importer', version: 1, exportedAt: now(), settings, importDefaults, siteMeta, items: [...S.items.values()] }, null, 1)], { type: 'application/json' });
            download(blob, `action-importer-backup-${new Date().toISOString().slice(0, 10)}.json`);
          },
        },
        'Export backup (.json)'
      ),
      h(
        'button',
        {
          class: 'btn small',
          onclick: async () => {
            const f = await pickFile('.json,application/json');
            if (!f) return;
            try {
              const j = JSON.parse(await f.text());
              if (j.app !== 'action-importer') throw new Error('Not an Action Importer backup');
              const writes = {};
              for (const it of j.items || []) if (it?.id) writes[ITEM_PREFIX + it.id] = it;
              if (j.settings) writes.settings = j.settings;
              if (j.importDefaults) writes.importDefaults = j.importDefaults;
              if (j.siteMeta) writes.siteMeta = j.siteMeta;
              await chrome.storage.local.set(writes);
              await boot(true);
              toast(`Restored ${(j.items || []).length} products`);
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        },
        'Restore backup…'
      )
    )
  );
}

// ---------- excel ----------
async function doExport(ids) {
  try {
    const items = ids.map((id) => S.items.get(id)).filter(Boolean);
    const blob = await exportExcel(items, { env: S.env, brands: brands(), categories: categories() });
    download(blob, `action-products-${S.env}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.xlsx`);
    toast(`Exported ${items.length} products`);
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'error');
  }
}

async function doImportExcel() {
  const f = await pickFile('.xlsx,.csv');
  if (!f) return;
  try {
    const rows = await readProductRows(f);
    const r = applyRows(rows, [...S.items.values()], { settings: S.settings, env: S.env });
    const writes = {};
    for (const it of r.items) writes[ITEM_PREFIX + it.id] = it;
    await chrome.storage.local.set(writes);
    r.items.forEach((it) => S.items.set(it.id, it));
    toast(`Excel: ${r.updated} updated, ${r.created} new${r.skipped ? `, ${r.skipped} skipped` : ''}`);
    updateList();
  } catch (e) {
    toast(`Import failed: ${e.message}`, 'error');
  }
}

// ------------------------------------------------------------------ boot
async function boot(silent = false) {
  S.settings = await loadSettings();
  const st = await chrome.storage.local.get(['env', 'sessions', 'lookups', 'importDefaults', 'lastPhone', 'apiLog']);
  S.apiLog = st.apiLog || [];
  S.env = st.env && S.settings.envs[st.env] ? st.env : 'production';
  S.sessions = st.sessions || {};
  S.lookups = st.lookups || {};
  S.importDefaults = { brandId: null, categories: [], ...(st.importDefaults || {}) };
  S.lastPhone = st.lastPhone || '';
  await loadItems();
  render();
  if (session() && !silent) loadLookups(false);
}

document.addEventListener('click', (e) => {
  document.querySelectorAll('.menu.open').forEach((m) => {
    if (!m.contains(e.target)) m.classList.remove('open');
  });
});

boot();
