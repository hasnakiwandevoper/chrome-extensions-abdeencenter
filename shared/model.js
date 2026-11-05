// Shared data model (used by the service worker and the side panel). No DOM APIs here.

export const ITEM_PREFIX = 'it:';

export const DEFAULT_STOCK = {
  quantity: 100,
  maxPerUser: 50,
  publishedAt: null,
  unPublishedAt: null,
  sort: 0,
  isPublished: true,
  supplierId: 1,
  campaignId: null,
  price: { currencyId: 1, value: 0, currency: 'JOD', symbol: 'JOD' },
  cost: { currencyId: 1, value: 0, currency: 'JOD', symbol: 'JOD' },
  priceBeforeOffer: null,
  isOffer: false,
  isPreOrder: false,
  note: { en: null },
};

// Built from the sample product the admin panel sends (read-only/server fields removed).
export const DEFAULT_TEMPLATE = {
  name: { ar: '', en: '' },
  slug: '',
  brandId: null,
  productGroupId: null,
  description: { ar: '', en: '' },
  type: 'simple',
  oldSlug: null,
  isPublished: true,
  isListed: true,
  variationAttributes: [],
  publishedAt: null,
  releaseAt: null,
  unPublishedAt: null,
  shippingId: null,
  priority: 0,
  metaTitle: { ar: '', en: '' },
  metaDescription: { ar: '', en: '' },
  colors: null,
  mediaCollective: { cover: [], gallery: [], youtube: [], downloadable: [] },
  bundles: [],
  stocks: [DEFAULT_STOCK],
  attributes: [],
  variances: [
    {
      alternativeId: null,
      varianceId: null,
      auctionId: null,
      name: { ar: '', en: '' },
      slug: '',
      brandId: null,
      SKU: '',
      type: 'physical',
      metaTitle: { ar: '', en: '' },
      metaDescription: { ar: '', en: '' },
      isDefault: false,
      isPublished: true,
      publishedAt: null,
      attributes: [],
      stocks: [DEFAULT_STOCK],
      media: { cover: [], gallery: [], youtube: [] },
      unPublishedAt: null,
    },
  ],
  suggested: [],
  media: { gallery: [], cover: [], youtube: [], downloadable: [] },
  disabledPaymentMethods: [],
  categories: [],
  shippingCarriers: [1],
  productLabels: [],
  faqs: [],
  SKU: '',
  modelNumber: '',
  labels: [],
};

export const DEFAULT_SETTINGS = {
  envs: {
    production: { label: 'Production', baseUrl: 'https://action.jo/api/v1' },
    staging: { label: 'Staging', baseUrl: 'https://admin.staging.action.jo/api/v1' },
  },
  endpoints: {
    login: '/auth/login',
    brands: '/lookups/brands',
    brandsPath: '',
    categories: '/lookups/categories',
    categoriesPath: '',
    upload: '/upload-media',
    uploadField: 'file',
    create: '/admin/products?trans=off',
    get: '/admin/products/{id}?trans=off',
    update: '/admin/products/{id}?trans=off',
    updateMethod: 'PUT',
  },
  phone: { iso: 'JO', code: '962' },
  defaults: {
    quantity: 100,
    maxPerUser: 50,
    supplierId: 1,
    currencyId: 1,
    currency: 'JOD',
    cost: 0,
    shippingCarriers: [1],
    isPublished: false,
    isListed: true,
  },
  pricing: { markupPercent: 0, roundTo: 0, useOldPriceAsOffer: false },
  stripTerms: ['عابدين', 'Abdeen'],
  meta: {
    titleAr: '{name} - أفضل سعر',
    titleEn: '{name} - Best Prices',
    descAr: '{name} ✔️ تسوق اونلاين في الأردن مع أكشن موبايل ✔️ أسعار مناسبة ✔️ تصفح الموقع الآن',
    descEn: '{name} ✔️ Shop Online in Jordan with Action Mobile ✔️ Affordable Prices ✔️ Browse the Website Now',
  },
  payload: {
    mediaMode: 'media', // media is required; legacy modes also mirror into mediaCollective
    coverInGallery: false,
    autoUploadOnSave: true,
    requireBrand: true,
    requireCategories: true,
    selectParentCategories: true,
  },
  template: DEFAULT_TEMPLATE,
  overrides: {},
  sources: [{ host: 'abdeencenter.com', builtIn: true }],
};

// Keys whose value is replaced as a whole instead of deep-merged with the defaults.
const REPLACE_KEYS = new Set(['template', 'overrides', 'sources', 'stripTerms', 'shippingCarriers']);

export function deepClone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

export function deepMerge(base, over) {
  if (over === undefined) return deepClone(base);
  if (!isPlainObject(base) || !isPlainObject(over)) return deepClone(over);
  const out = deepClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (REPLACE_KEYS.has(k) || !isPlainObject(v) || !isPlainObject(out[k])) out[k] = deepClone(v);
    else out[k] = deepMerge(out[k], v);
  }
  return out;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return deepMerge(DEFAULT_SETTINGS, settings || {});
}

export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(u || '').toLowerCase();
  }
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function itemIdFor(src) {
  const site = src.site || hostOf(src.url) || 'manual';
  if (src.sourceId) return `${site}|pid:${src.sourceId}`;
  if (src.url) return `${site}|url:${normalizeUrl(src.url)}`;
  if (src.sku) return `${site}|sku:${src.sku}`;
  return `${site}|rnd:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150);
}

export function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

export function applyPriceRule(price, pricing = {}) {
  if (price == null || price === '' || !isFinite(price)) return null;
  let p = Number(price) * (1 + (Number(pricing.markupPercent) || 0) / 100);
  const r = Number(pricing.roundTo) || 0;
  if (r > 0) p = Math.round(p / r) * r;
  return round3(p);
}

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// Turn the content script's {primary, ar, en} result into one flat "scraped" record.
export function scrapedFromBilingual(b) {
  const p = b.primary || b.ar || b.en || {};
  const ar = b.ar || {};
  const en = b.en || {};
  return {
    url: p.url,
    site: p.site || hostOf(p.url),
    platform: p.platform || 'generic',
    sourceId: p.sourceId || ar.sourceId || en.sourceId || null,
    sku: p.sku || en.sku || ar.sku || '',
    nameAr: ar.name || '',
    nameEn: en.name || '',
    descAr: ar.descriptionHtml || '',
    descEn: en.descriptionHtml || '',
    shortDescAr: ar.shortDescriptionHtml || '',
    shortDescEn: en.shortDescriptionHtml || '',
    price: p.price ?? null,
    oldPrice: p.oldPrice ?? null,
    currency: p.currency || 'JOD',
    inStock: p.inStock ?? null,
    brand: en.brand || ar.brand || p.brand || '',
    breadcrumbsAr: ar.breadcrumbs || [],
    breadcrumbsEn: en.breadcrumbs || [],
    specsAr: ar.specs || [],
    specsEn: en.specs || [],
    images: uniq([...(p.images || []), ...(ar.images || []), ...(en.images || [])]),
    videos: uniq([...(p.videos || []), ...(ar.videos || []), ...(en.videos || [])]),
    options: p.options || en.options || ar.options || [],
    langs: [b.ar ? 'ar' : null, b.en ? 'en' : null].filter(Boolean),
    scrapedAt: new Date().toISOString(),
  };
}

export function editFromScraped(s, settings, defaults = {}) {
  const pr = settings.pricing || {};
  const d = settings.defaults || {};
  const offer = pr.useOldPriceAsOffer && s.oldPrice != null && s.price != null && s.oldPrice > s.price;
  return {
    nameEn: s.nameEn || s.nameAr || '',
    nameAr: s.nameAr || s.nameEn || '',
    descEn: s.descEn || s.descAr || '',
    descAr: s.descAr || s.descEn || '',
    slug: slugify(s.nameEn || s.nameAr || s.sku),
    brandId: defaults.brandId ?? null,
    categories: [...(defaults.categories || [])],
    price: applyPriceRule(s.price, pr),
    priceBeforeOffer: offer ? applyPriceRule(s.oldPrice, pr) : null,
    cost: Number(d.cost) || 0,
    quantity: s.inStock === false ? 0 : Number(d.quantity) || 0,
    maxPerUser: Number(d.maxPerUser) || 1,
    sku: s.sku || '',
    modelNumber: s.sku || '',
    isPublished: !!d.isPublished,
    isListed: d.isListed !== false,
  };
}

// ---------- lookups normalisation ----------

export function getPath(obj, path) {
  if (!path) return obj;
  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function extractList(resp, depth = 0) {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== 'object' || depth > 4) return [];
  for (const k of ['data', 'items', 'results', 'brands', 'categories', 'list', 'rows', 'records']) {
    const v = resp[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const inner = extractList(v, depth + 1);
      if (inner.length) return inner;
    }
  }
  for (const v of Object.values(resp)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  return [];
}

function nameParts(x) {
  const n = x.name ?? x.title ?? x.label ?? x.text;
  if (n && typeof n === 'object') return { en: n.en || '', ar: n.ar || '' };
  return { en: n != null ? String(n) : '', ar: x.nameAr || x.name_ar || '' };
}

export function idOf(x, kind) {
  return x[`${kind}Id`] ?? x[`${kind}_id`] ?? x.id ?? x.value ?? x.key ?? null;
}

const CHILD_KEYS = ['children', 'subCategories', 'sub_categories', 'subcategories', 'childs', 'childrens', 'subs'];
function childrenOf(x) {
  if (Array.isArray(x.meta?.children)) return x.meta.children;
  for (const k of CHILD_KEYS) if (Array.isArray(x[k])) return x[k];
  return [];
}
function parentOf(x) {
  const p = x.parentId ?? x.parent_id ?? x.parentCategoryId ?? x.parent;
  if (p && typeof p === 'object') return p.categoryId ?? p.id ?? null;
  return p ?? null;
}

function label(np, fallback) {
  if (np.en && np.ar && np.en !== np.ar) return `${np.en}`;
  return np.en || np.ar || String(fallback ?? '');
}

export function normalizeBrands(resp, path) {
  const list = extractList(getPath(resp, path));
  return list
    .map((x) => {
      const np = nameParts(x);
      const id = idOf(x, 'brand');
      return { id, label: label(np, id), nameEn: np.en, nameAr: np.ar, slug: x.slug || '' };
    })
    .filter((b) => b.id != null)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function normalizeCategories(resp, path) {
  const list = extractList(getPath(resp, path));
  const mapNode = (x, parentId) => {
    const np = nameParts(x);
    const id = idOf(x, 'category');
    return {
      id,
      label: label(np, id),
      nameEn: np.en,
      nameAr: np.ar,
      parentId: parentId ?? parentOf(x) ?? null,
      children: childrenOf(x).map((c) => mapNode(c, id)).filter((c) => c.id != null),
    };
  };
  if (list.some((x) => childrenOf(x).length)) {
    return list.map((x) => mapNode(x, null)).filter((n) => n.id != null);
  }
  // Flat list with parent ids -> build tree
  const nodes = list.map((x) => mapNode(x, null)).filter((n) => n.id != null);
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const roots = [];
  for (const n of nodes) {
    const p = n.parentId != null && n.parentId !== 0 ? byId.get(String(n.parentId)) : null;
    if (p && p !== n) p.children.push(n);
    else roots.push(n);
  }
  return roots;
}

export function flattenTree(roots, out = [], depth = 0, path = []) {
  for (const n of roots || []) {
    out.push({ ...n, depth, path: [...path, n.label] });
    flattenTree(n.children, out, depth + 1, [...path, n.label]);
  }
  return out;
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function matchBrand(name, brands) {
  const n = normName(name);
  if (!n || !brands?.length) return null;
  return (
    brands.find((b) => [b.nameEn, b.nameAr, b.slug, b.label].some((x) => normName(x) === n)) ||
    brands.find((b) => normName(b.nameEn).length > 2 && (n.startsWith(normName(b.nameEn)) || normName(b.nameEn).startsWith(n))) ||
    null
  );
}

// ---------- merge an import into an existing item ----------

export function mergeImport(existing, scraped, settings, defaults = {}, brands = []) {
  const now = new Date().toISOString();
  if (!existing) {
    const edit = editFromScraped(scraped, settings, defaults);
    if (edit.brandId == null && scraped.brand) edit.brandId = matchBrand(scraped.brand, brands)?.id ?? null;
    const item = {
      id: itemIdFor(scraped),
      source: { site: scraped.site, url: scraped.url, sourceId: scraped.sourceId, sku: scraped.sku, platform: scraped.platform },
      scraped,
      edit,
      dirty: [],
      images: scraped.images.map((url) => ({ url, uploads: {} })),
      priceHistory: [{ price: scraped.price, oldPrice: scraped.oldPrice, at: now }],
      backend: {},
      lastError: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    return { item, created: true, priceChanged: false };
  }
  const item = existing;
  const prev = item.scraped || {};
  const priceChanged = prev.price !== scraped.price || (prev.oldPrice ?? null) !== (scraped.oldPrice ?? null);
  if (priceChanged) {
    item.priceHistory = [...(item.priceHistory || []), { price: scraped.price, oldPrice: scraped.oldPrice, at: now }];
    item.priceChangedAt = now;
  }
  // keep values the user already had if the new scrape is missing a language
  const merged = { ...scraped };
  for (const k of ['nameAr', 'nameEn', 'descAr', 'descEn', 'brand', 'sku']) if (!merged[k] && prev[k]) merged[k] = prev[k];
  item.scraped = merged;
  const fresh = editFromScraped(merged, settings, { brandId: item.edit.brandId, categories: item.edit.categories });
  const dirty = new Set(item.dirty || []);
  for (const [k, v] of Object.entries(fresh)) {
    if (k === 'brandId' || k === 'categories' || k === 'isPublished' || k === 'isListed') continue;
    if (!dirty.has(k)) item.edit[k] = v;
  }
  if (item.edit.brandId == null && merged.brand) item.edit.brandId = matchBrand(merged.brand, brands)?.id ?? null;
  const known = new Set(item.images.map((i) => i.url));
  for (const u of merged.images) if (!known.has(u)) item.images.push({ url: u, uploads: {} });
  item.source = { ...item.source, url: merged.url || item.source.url };
  item.updatedAt = now;
  item.lastSeenAt = now;
  return { item, created: false, priceChanged, previousPrice: prev.price };
}
