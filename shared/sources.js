// Manage extra "source" sites (other stores) the importer button is injected into.
import { loadSettings } from './model.js';

export const CONTENT_FILES = { js: ['content/scraper.js', 'content/inject.js'], css: ['content/inject.css'] };

export function originsFor(host) {
  const h = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
  if (!h) return [];
  return [`https://${h}/*`, `https://*.${h}/*`, `http://${h}/*`, `http://*.${h}/*`];
}

export function cleanHost(input) {
  return String(input || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
}

const scriptId = (host) => `src-${host.replace(/[^a-z0-9.-]/g, '')}`;

export async function registerSource(host) {
  const origins = originsFor(host);
  const id = scriptId(host);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  await chrome.scripting.registerContentScripts([
    { id, matches: origins, js: CONTENT_FILES.js, css: CONTENT_FILES.css, runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}

export async function unregisterSource(host) {
  const id = scriptId(host);
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
}

// Re-register scripts for every custom source we still have permission for.
export async function syncSources() {
  const settings = await loadSettings();
  const wanted = settings.sources.filter((s) => !s.builtIn);
  const registered = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const wantedIds = new Set(wanted.map((s) => scriptId(s.host)));
  const stale = registered.filter((r) => r.id.startsWith('src-') && !wantedIds.has(r.id)).map((r) => r.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
  for (const s of wanted) {
    const ok = await chrome.permissions.contains({ origins: originsFor(s.host).slice(0, 2) }).catch(() => false);
    if (ok && !registered.some((r) => r.id === scriptId(s.host))) await registerSource(s.host).catch(() => {});
  }
}
