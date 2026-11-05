import { ITEM_PREFIX, loadSettings, mergeImport, scrapedFromBilingual, itemIdFor } from './shared/model.js';
import { syncSources } from './shared/sources.js';

async function init() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn('sidePanel', e);
  }
  await syncSources().catch((e) => console.warn('syncSources', e));
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// Serialise writes so two quick imports never overwrite each other.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function handleImport(data) {
  if (!data?.primary?.name && !data?.ar?.name && !data?.en?.name) throw new Error('Could not read a product name on this page.');
  const settings = await loadSettings();
  const st = await chrome.storage.local.get(['env', 'lookups', 'importDefaults', 'siteMeta']);
  const env = st.env || 'production';
  const brands = st.lookups?.[env]?.brands || [];
  const scraped = scrapedFromBilingual(data);
  const key = ITEM_PREFIX + itemIdFor(scraped);
  const existing = (await chrome.storage.local.get(key))[key];
  const r = mergeImport(existing, scraped, settings, st.importDefaults || {}, brands);
  const writes = { [key]: r.item };
  if (data.storeCodes && scraped.site) {
    const siteMeta = st.siteMeta || {};
    const cur = siteMeta[scraped.site]?.storeCodes || {};
    const next = { ...cur, ...data.storeCodes };
    if (JSON.stringify(cur) !== JSON.stringify(next)) writes.siteMeta = { ...siteMeta, [scraped.site]: { ...(siteMeta[scraped.site] || {}), storeCodes: next } };
  }
  await chrome.storage.local.set(writes);
  return {
    id: r.item.id,
    created: r.created,
    priceChanged: r.priceChanged,
    previousPrice: r.previousPrice,
    price: scraped.price,
    name: r.item.edit.nameEn || r.item.edit.nameAr,
    langs: scraped.langs,
    images: scraped.images.length,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'IMPORT_PRODUCT') {
    enqueue(() => handleImport(msg.data))
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'OPEN_PANEL') {
    const tabId = sender.tab?.id;
    chrome.sidePanel
      .open({ tabId })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});
