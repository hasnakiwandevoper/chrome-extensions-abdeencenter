// Excel export/import of the imported products list.
import { writeXlsx, readXlsx, parseCsv } from './xlsx.js';
import { flattenTree, normalizeUrl, itemIdFor, hostOf, slugify } from '../shared/model.js';

const htmlToText = (html) => {
  if (!html) return '';
  const d = new DOMParser().parseFromString(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d|tr)>/gi, '\n'), 'text/html');
  return d.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
};

const COLS = [
  ['Local ID', 30],
  ['Status', 12],
  ['Backend product ID', 12],
  ['Saved at', 18],
  ['Source site', 16],
  ['Source URL', 40],
  ['Source product ID', 10],
  ['Source SKU', 18],
  ['Name EN', 40],
  ['Name AR', 40],
  ['Source price', 11],
  ['Source old price', 11],
  ['Currency', 8],
  ['In stock', 8],
  ['Previous source price', 11],
  ['Price changed at', 18],
  ['Our price', 11],
  ['Price before offer', 11],
  ['Cost', 9],
  ['Quantity', 9],
  ['Max per user', 9],
  ['SKU', 18],
  ['Model number', 18],
  ['Brand ID', 9],
  ['Brand', 18],
  ['Source brand', 18],
  ['Category IDs', 14],
  ['Categories', 30],
  ['Published', 9],
  ['Listed', 8],
  ['Slug', 30],
  ['Image URLs', 50],
  ['Images uploaded', 10],
  ['Description EN (text)', 50],
  ['Description AR (text)', 50],
  ['Description EN (HTML)', 50],
  ['Description AR (HTML)', 50],
  ['Breadcrumbs EN', 30],
  ['Breadcrumbs AR', 30],
  ['Specs EN', 40],
  ['Specs AR', 40],
  ['Options', 30],
  ['Scraped at', 18],
  ['Last error', 40],
];

export async function exportExcel(items, { env, brands = [], categories = [] }) {
  const brandMap = new Map(brands.map((b) => [String(b.id), b]));
  const flat = flattenTree(categories);
  const catMap = new Map(flat.map((c) => [String(c.id), c]));
  const rows = items.map((it) => {
    const s = it.scraped || {};
    const e = it.edit || {};
    const be = it.backend?.[env] || {};
    const ph = it.priceHistory || [];
    const prev = ph.length > 1 ? ph[ph.length - 2].price : null;
    const up = (it.images || []).filter((i) => i.uploads?.[env]).length;
    const status = be.savedAt ? 'Saved' : it.lastError ? 'Error' : 'Not saved';
    return [
      it.id,
      status,
      be.productId ?? '',
      be.savedAt || '',
      s.site || it.source?.site || '',
      s.url || it.source?.url || '',
      s.sourceId || '',
      s.sku || '',
      e.nameEn || '',
      e.nameAr || '',
      s.price ?? '',
      s.oldPrice ?? '',
      s.currency || '',
      s.inStock == null ? '' : s.inStock ? 'yes' : 'no',
      prev ?? '',
      it.priceChangedAt || '',
      e.price ?? '',
      e.priceBeforeOffer ?? '',
      e.cost ?? '',
      e.quantity ?? '',
      e.maxPerUser ?? '',
      e.sku || '',
      e.modelNumber || '',
      e.brandId ?? '',
      brandMap.get(String(e.brandId))?.label || '',
      s.brand || '',
      (e.categories || []).join(', '),
      (e.categories || []).map((id) => catMap.get(String(id))?.path?.join(' › ') || `#${id}`).join(' | '),
      e.isPublished ? 'yes' : 'no',
      e.isListed === false ? 'no' : 'yes',
      e.slug || '',
      (it.images || []).map((i) => i.url).join('\n'),
      `${up}/${(it.images || []).length}`,
      htmlToText(e.descEn),
      htmlToText(e.descAr),
      e.descEn || '',
      e.descAr || '',
      (s.breadcrumbsEn || []).join(' › '),
      (s.breadcrumbsAr || []).join(' › '),
      (s.specsEn || []).map((x) => `${x.label}: ${x.value}`).join('\n'),
      (s.specsAr || []).map((x) => `${x.label}: ${x.value}`).join('\n'),
      (s.options || []).map((o) => `${o.label}: ${o.values.join(', ')}`).join('\n'),
      s.scrapedAt || '',
      it.lastError ? `${it.lastError.op}: ${it.lastError.message}` : '',
    ];
  });

  const history = [];
  for (const it of items) for (const p of it.priceHistory || []) history.push([it.id, it.edit?.nameEn || it.edit?.nameAr || '', it.source?.url || '', p.at, p.price ?? '', p.oldPrice ?? '']);

  return writeXlsx([
    { name: 'Products', columns: COLS.map(([header, width]) => ({ header, width })), rows },
    { name: 'Price history', columns: [['Local ID', 30], ['Name', 40], ['Source URL', 40], ['Date', 22], ['Price', 10], ['Old price', 10]].map(([header, width]) => ({ header, width })), rows: history },
    { name: 'Brands', columns: [['Brand ID', 10], ['Name EN', 30], ['Name AR', 30]].map(([header, width]) => ({ header, width })), rows: brands.map((b) => [b.id, b.nameEn || b.label, b.nameAr || '']) },
    {
      name: 'Categories',
      columns: [['Category ID', 12], ['Path', 60], ['Name AR', 30]].map(([header, width]) => ({ header, width })),
      rows: flat.map((c) => [c.id, c.path.join(' › '), c.nameAr || '']),
    },
  ]);
}

const truthy = (v) => (typeof v === 'boolean' ? v : /^(1|y|yes|true|نعم)$/i.test(String(v ?? '').trim()));
const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
};

/** Reads an .xlsx/.csv file and returns row objects keyed by header. */
export async function readProductRows(file) {
  let rows;
  if (/\.csv$/i.test(file.name)) rows = parseCsv(await file.text());
  else {
    const sheets = await readXlsx(await file.arrayBuffer());
    const sheet = sheets.find((s) => /^products$/i.test(s.name)) || sheets[0];
    if (!sheet) throw new Error('The file has no sheets');
    rows = sheet.rows;
  }
  const header = (rows[0] || []).map((x) => String(x ?? '').trim().toLowerCase());
  return rows
    .slice(1)
    .filter((r) => r && r.some((c) => c != null && c !== ''))
    .map((r) => Object.fromEntries(header.map((k, i) => [k, r[i]])));
}

/**
 * Apply spreadsheet rows to the item map. Returns {updated, created, skipped, items: [changed items]}.
 * Only non-empty cells overwrite values.
 */
export function applyRows(rows, existingItems, { settings, env }) {
  const byId = new Map(existingItems.map((it) => [it.id, it]));
  const byUrl = new Map(existingItems.filter((it) => it.source?.url).map((it) => [normalizeUrl(it.source.url), it]));
  const out = [];
  let updated = 0;
  let created = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  const has = (r, k) => r[k] != null && String(r[k]).trim() !== '';

  for (const r of rows) {
    let it = (has(r, 'local id') && byId.get(String(r['local id']).trim())) || (has(r, 'source url') && byUrl.get(normalizeUrl(String(r['source url']).trim())));
    const isNew = !it;
    if (isNew) {
      if (!has(r, 'name en') && !has(r, 'name ar')) {
        skipped++;
        continue;
      }
      const url = has(r, 'source url') ? String(r['source url']).trim() : '';
      const src = { site: url ? hostOf(url) : 'excel', url, sourceId: null, sku: has(r, 'source sku') ? String(r['source sku']) : '' };
      it = {
        id: itemIdFor(src),
        source: { ...src, platform: 'excel' },
        scraped: { ...src, nameEn: '', nameAr: '', price: num(r['source price']), currency: settings.defaults.currency, images: [], scrapedAt: now },
        edit: {
          nameEn: '',
          nameAr: '',
          descEn: '',
          descAr: '',
          slug: '',
          brandId: null,
          categories: [],
          price: null,
          priceBeforeOffer: null,
          cost: settings.defaults.cost,
          quantity: settings.defaults.quantity,
          maxPerUser: settings.defaults.maxPerUser,
          sku: '',
          modelNumber: '',
          isPublished: settings.defaults.isPublished,
          isListed: settings.defaults.isListed,
        },
        dirty: [],
        images: [],
        priceHistory: [],
        backend: {},
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
    }
    const e = it.edit;
    const dirty = new Set(it.dirty || []);
    const set = (key, val) => {
      if (val == null || val === '') return;
      if (JSON.stringify(e[key]) !== JSON.stringify(val)) {
        e[key] = val;
        dirty.add(key);
      }
    };
    if (has(r, 'name en')) set('nameEn', String(r['name en']).trim());
    if (has(r, 'name ar')) set('nameAr', String(r['name ar']).trim());
    set('price', num(r['our price']));
    set('priceBeforeOffer', num(r['price before offer']));
    set('cost', num(r['cost']));
    set('quantity', num(r['quantity']));
    set('maxPerUser', num(r['max per user']));
    if (has(r, 'sku')) set('sku', String(r['sku']).trim());
    if (has(r, 'model number')) set('modelNumber', String(r['model number']).trim());
    if (has(r, 'brand id')) set('brandId', num(r['brand id']) ?? String(r['brand id']).trim());
    if (has(r, 'category ids'))
      set(
        'categories',
        String(r['category ids'])
          .split(/[,;|\s]+/)
          .filter(Boolean)
          .map((x) => (isNaN(x) ? x : Number(x)))
      );
    if (has(r, 'published')) set('isPublished', truthy(r['published']));
    if (has(r, 'listed')) set('isListed', truthy(r['listed']));
    if (has(r, 'slug')) set('slug', String(r['slug']).trim());
    if (has(r, 'description en (html)')) set('descEn', String(r['description en (html)']));
    else if (isNew && has(r, 'description en (text)')) set('descEn', String(r['description en (text)']));
    if (has(r, 'description ar (html)')) set('descAr', String(r['description ar (html)']));
    else if (isNew && has(r, 'description ar (text)')) set('descAr', String(r['description ar (text)']));
    if (!e.slug) e.slug = slugify(e.nameEn || e.nameAr);
    if (has(r, 'image urls')) {
      const urls = String(r['image urls'])
        .split(/[\n,\s]+/)
        .map((x) => x.trim())
        .filter((x) => /^https?:\/\//i.test(x));
      const old = new Map((it.images || []).map((i) => [i.url, i]));
      const next = urls.map((u) => old.get(u) || { url: u, uploads: {} });
      if (JSON.stringify(next.map((i) => i.url)) !== JSON.stringify((it.images || []).map((i) => i.url))) it.images = next;
    }
    it.dirty = [...dirty];
    it.updatedAt = now;
    out.push(it);
    isNew ? created++ : updated++;
    if (isNew) byId.set(it.id, it);
  }
  return { updated, created, skipped, items: out };
}
