// Adds "Import to Action" buttons on product + listing pages and a small floating dock.
(() => {
  'use strict';
  const NS = globalThis.__ACTION_IMPORTER__;
  if (!NS || NS.injectLoaded || window.top !== window) return;
  NS.injectLoaded = true;

  const ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
  const host = location.hostname.replace(/^www\./, '');
  const norm = (u) => {
    try {
      const x = new URL(u, location.href);
      return (x.origin + x.pathname).replace(/\/+$/, '').toLowerCase();
    } catch {
      return '';
    }
  };
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let index = new Map();
  let stopFlag = false;
  let bulkRunning = false;

  const ctxOk = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  async function opts() {
    const { settings, siteMeta } = await chrome.storage.local.get(['settings', 'siteMeta']);
    return { stripTerms: settings?.stripTerms ?? ['عابدين', 'Abdeen'], storeCodes: siteMeta?.[host]?.storeCodes || null };
  }

  async function send(data) {
    if (!ctxOk()) throw new Error('The extension was updated — please refresh this page.');
    const r = await chrome.runtime.sendMessage({ type: 'IMPORT_PRODUCT', data });
    if (!r?.ok) throw new Error(r?.error || 'Import failed');
    return r;
  }

  async function scrapeCurrent() {
    const o = await opts();
    // Magento removes its gallery JSON from the live DOM, so read a fresh copy of the page too.
    const fetched = await NS.fetchDoc(location.href);
    if (!fetched) return NS.scrapeBilingual(document, location.href, o);
    const data = await NS.scrapeBilingual(fetched.doc, location.href, o);
    const live = NS.scrapeDocument(document, location.href, o);
    if (data[live.lang]) NS.fillMissing(data[live.lang], live);
    return data;
  }

  async function scrapeUrl(url) {
    const o = await opts();
    const fetched = await NS.fetchDoc(url);
    if (!fetched) throw new Error('Could not open ' + url);
    if (!NS.isProductPage(fetched.doc)) throw new Error('Not a product page: ' + url);
    return NS.scrapeBilingual(fetched.doc, fetched.url, o);
  }

  function describe(r) {
    const langs = r.langs?.length === 2 ? ' (AR + EN)' : r.langs?.length ? ` (${r.langs[0].toUpperCase()} only)` : '';
    if (r.created) return `Imported${langs}: ${r.name}`;
    if (r.priceChanged) return `Price changed ${fmt(r.previousPrice)} → ${fmt(r.price)}: ${r.name}`;
    return `Refreshed${langs}: ${r.name}`;
  }

  // ---------- buttons ----------
  function makeBtn(cls, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `aimp-btn ${cls}`;
    b.innerHTML = ICON + '<span></span>';
    b.querySelector('span').textContent = label;
    b.dataset.state = 'idle';
    return b;
  }
  function setBtn(b, state, label) {
    if (!b) return;
    b.dataset.state = state;
    b.querySelector('span').textContent = label;
    b.disabled = state === 'loading';
  }
  const inListLabel = (it) => (it?.backend && Object.values(it.backend).some((x) => x?.productId) ? 'Saved ✓ (re-import)' : 'In list ✓ (re-import)');

  async function importCurrent(btn) {
    setBtn(btn, 'loading', 'Importing…');
    dockStatus('Reading product…');
    try {
      const data = await scrapeCurrent();
      const r = await send(data);
      setBtn(btn, 'done', r.created ? 'Imported ✓' : 'Updated ✓');
      toast(describe(r), r.priceChanged ? 'warn' : 'ok');
      return r;
    } catch (e) {
      setBtn(btn, 'error', 'Failed — retry');
      toast(e.message, 'error');
      throw e;
    } finally {
      dockStatus('');
    }
  }

  async function importUrl(url, btn, quiet = false) {
    setBtn(btn, 'loading', '…');
    try {
      const r = await send(await scrapeUrl(url));
      setBtn(btn, 'done', r.created ? 'Imported ✓' : 'Updated ✓');
      if (!quiet || r.priceChanged) toast(describe(r), r.priceChanged ? 'warn' : 'ok');
      return r;
    } catch (e) {
      setBtn(btn, 'error', 'Failed');
      toast(e.message, 'error');
      throw e;
    }
  }

  function productBtn() {
    return document.querySelector('.aimp-product-btn');
  }

  function decorateProduct() {
    if (!NS.isProductPage(document) || productBtn()) return;
    const atc = document.querySelector('#product-addtocart-button, button[name="add-to-cart"], .single_add_to_cart_button, button.tocart');
    if (!atc?.parentElement) return;
    const b = makeBtn('aimp-product-btn', 'Import to Action');
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      importCurrent(b).catch(() => {});
    });
    atc.insertAdjacentElement('afterend', b);
  }

  function decorateCards() {
    for (const { card, url } of NS.listingCards()) {
      if (card.querySelector('.aimp-card-btn')) continue;
      const b = makeBtn('aimp-card-btn', 'Import');
      b.dataset.url = url;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        importUrl(url, b).catch(() => {});
      });
      const slot = card.querySelector('.product-item-details, .product-item-info, .product-details') || card;
      slot.appendChild(b);
    }
  }

  function updateMarks() {
    document.querySelectorAll('.aimp-card-btn').forEach((b) => {
      if (b.dataset.state === 'loading') return;
      const it = index.get(norm(b.dataset.url));
      if (it) setBtn(b, 'done', inListLabel(it).replace(' (re-import)', ''));
      else if (b.dataset.state !== 'error') setBtn(b, 'idle', 'Import');
    });
    const pb = productBtn();
    const cur = index.get(norm(location.href));
    if (pb && pb.dataset.state !== 'loading' && pb.dataset.state !== 'error') setBtn(pb, cur ? 'done' : 'idle', cur ? inListLabel(cur) : 'Import to Action');
    renderDock();
  }

  async function refreshIndex() {
    if (!ctxOk()) return;
    const all = await chrome.storage.local.get(null);
    const m = new Map();
    for (const [k, v] of Object.entries(all)) if (k.startsWith('it:') && v?.source?.url) m.set(norm(v.source.url), v);
    index = m;
    updateMarks();
  }

  // ---------- floating dock (shadow DOM so the shop's CSS can't break it) ----------
  const rootHost = document.createElement('div');
  rootHost.id = 'action-importer-root';
  const shadow = rootHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    .dock { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; direction: ltr; }
    .fab { width: 44px; height: 44px; border-radius: 50%; border: 0; background: #7b2d7f; color: #fff; font-weight: 700; font-size: 18px; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.25); }
    .panel { display: none; width: 260px; background: #fff; color: #1f1f24; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.22); overflow: hidden; border: 1px solid #ece6ef; }
    .dock.open .panel { display: block; } .dock.open .fab { display: none; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #7b2d7f; color: #fff; font-size: 13px; }
    .head b { flex: 1; } .count { font-size: 11px; opacity: .85; }
    .min { background: transparent; border: 0; color: #fff; font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; }
    .body { padding: 10px 12px 12px; display: grid; gap: 8px; }
    .status { font-size: 12px; color: #5d5866; min-height: 0; }
    .status:empty { display: none; }
    button.act { width: 100%; border: 1px solid #7b2d7f; background: #7b2d7f; color: #fff; padding: 8px 10px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
    button.act.sec { background: #fff; color: #7b2d7f; }
    button.act:disabled { opacity: .6; cursor: default; }
    .dock { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
    .toasts { display: grid; gap: 6px; width: min(340px, calc(100vw - 32px)); direction: ltr; }
    .toasts:empty { display: none; }
    .toast { background: #1f1f24; color: #fff; padding: 9px 12px; border-radius: 8px; font-size: 13px; box-shadow: 0 6px 18px rgba(0,0,0,.25); border-left: 4px solid #3fb27f; }
    .toast.error { border-left-color: #e5484d; } .toast.warn { border-left-color: #f5a524; }
  </style>
  <div class="dock">
    <div class="toasts"></div>
    <button class="fab" title="Action Importer">A</button>
    <div class="panel">
      <div class="head"><b>Action Importer</b><span class="count"></span><button class="min" title="Minimise">–</button></div>
      <div class="body"><div class="status"></div><div class="acts" style="display:grid;gap:6px"></div></div>
    </div>
  </div>`;
  (document.body || document.documentElement).appendChild(rootHost);
  const $ = (s) => shadow.querySelector(s);
  const dock = $('.dock');

  $('.fab').addEventListener('click', () => setOpen(true));
  $('.min').addEventListener('click', () => setOpen(false));
  function setOpen(open) {
    dock.classList.toggle('open', open);
    if (ctxOk()) chrome.storage.local.set({ dockOpen: open });
  }

  function dockStatus(t) {
    $('.status').textContent = t || '';
  }

  function toast(msg, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    const box = $('.toasts');
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5000);
  }

  function actBtn(label, fn, sec = false) {
    const b = document.createElement('button');
    b.className = `act${sec ? ' sec' : ''}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function renderDock() {
    const acts = $('.acts');
    acts.textContent = '';
    $('.count').textContent = `${index.size} in list`;
    if (bulkRunning) {
      acts.append(actBtn('Stop', () => (stopFlag = true), true));
      return;
    }
    if (NS.isProductPage(document)) {
      const cur = index.get(norm(location.href));
      acts.append(
        actBtn(cur ? 'Re-import (refresh price)' : 'Import this product', async (e) => {
          e.target.disabled = true;
          await importCurrent(productBtn()).catch(() => {});
          e.target.disabled = false;
        })
      );
    }
    const cards = NS.listingCards();
    if (cards.length > 1) {
      const fresh = cards.filter((c) => !index.has(norm(c.url))).length;
      acts.append(actBtn(`Import all on page (${cards.length})`, () => importAll(false)));
      if (fresh !== cards.length) acts.append(actBtn(`Only new (${fresh})`, () => importAll(true), true));
    }
    acts.append(
      actBtn(
        'Open side panel',
        () =>
          chrome.runtime
            .sendMessage({ type: 'OPEN_PANEL' })
            .then((r) => !r?.ok && toast('Click the Action Importer icon in the toolbar to open the panel', 'warn'))
            .catch(() => toast('The extension was updated — please refresh this page.', 'error')),
        true
      )
    );
  }

  async function importAll(onlyNew) {
    const cards = NS.listingCards().filter((c) => !onlyNew || !index.has(norm(c.url)));
    if (!cards.length) return toast('Nothing to import on this page', 'warn');
    bulkRunning = true;
    stopFlag = false;
    renderDock();
    let ok = 0;
    let fail = 0;
    let changed = 0;
    for (let i = 0; i < cards.length && !stopFlag; i++) {
      dockStatus(`Importing ${i + 1} / ${cards.length}…`);
      try {
        const r = await importUrl(cards[i].url, cards[i].card.querySelector('.aimp-card-btn'), true);
        ok++;
        if (r.priceChanged) changed++;
      } catch {
        fail++;
      }
      await sleep(250);
    }
    bulkRunning = false;
    dockStatus('');
    toast(`Done: ${ok} imported/updated${changed ? `, ${changed} price changes` : ''}${fail ? `, ${fail} failed` : ''}${stopFlag ? ' (stopped)' : ''}`, fail ? 'warn' : 'ok');
    renderDock();
  }

  // ---------- messages from the side panel ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'PING') {
      sendResponse({ ok: true, host, isProduct: NS.isProductPage(document), cards: NS.listingCards().length });
      return false;
    }
    if (msg?.type === 'IMPORT_ACTIVE') {
      (async () => {
        if (!NS.isProductPage(document)) throw new Error('This tab is not a product page. Use "Import all" on a category page instead.');
        return importCurrent(productBtn());
      })().then(
        (r) => sendResponse({ ok: true, ...r }),
        (e) => sendResponse({ ok: false, error: e.message })
      );
      return true;
    }
    if (msg?.type === 'IMPORT_ALL') {
      importAll(!!msg.onlyNew);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // ---------- boot ----------
  function decorate() {
    decorateProduct();
    decorateCards();
    updateMarks();
  }
  let t = null;
  new MutationObserver((muts) => {
    const ours = (m) =>
      m.target === rootHost ||
      m.target.closest?.('.aimp-btn') ||
      [...m.addedNodes, ...m.removedNodes].every((n) => n === rootHost || n.classList?.contains('aimp-btn') || n.parentElement?.closest?.('.aimp-btn'));
    if (muts.every(ours)) return;
    clearTimeout(t);
    t = setTimeout(decorate, 600);
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && Object.keys(ch).some((k) => k.startsWith('it:'))) refreshIndex();
  });
  chrome.storage.local.get('dockOpen').then(({ dockOpen }) => dock.classList.toggle('open', dockOpen !== false));
  decorate();
  refreshIndex();
})();
