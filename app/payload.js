// Build the JSON body for POST/PUT /admin/products from an imported item.
import { deepClone, deepMerge, DEFAULT_STOCK, isPlainObject, slugify, round3 } from '../shared/model.js';

const READ_ONLY = [
  'productId', 'createdAt', 'updatedAt', 'deletedAt', 'avgRate', 'score', 'viewCount', 'numberOfOrder', 'ratings', 'brand',
  'hasStock', 'minPrice', 'maxPrice', 'hasOffer', 'minPriceBeforeOffer', 'maxPriceBeforeOffer',
];
const STOCK_READ_ONLY = ['stockId', 'createdAt', 'updatedAt', 'sold', 'supplier'];

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function wrapHtml(html) {
  const s = String(html || '').trim();
  if (!s) return '';
  if (/<[a-z][\s\S]*>/i.test(s)) return s;
  return s
    .split(/\n{2,}/)
    .map((p) => `<p dir="auto">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function validate(item, settings) {
  const e = item.edit || {};
  const errors = [];
  const warnings = [];
  if (!String(e.nameEn || '').trim() && !String(e.nameAr || '').trim()) errors.push('Name is missing');
  if (!(Number(e.price) > 0)) errors.push('Price must be greater than 0');
  if (settings.payload.requireBrand && (e.brandId == null || e.brandId === '')) errors.push('Choose a brand');
  if (settings.payload.requireCategories && !(e.categories || []).length) errors.push('Choose at least one category');
  if (!String(e.nameAr || '').trim()) warnings.push('No Arabic name (English will be used)');
  if (!String(e.nameEn || '').trim()) warnings.push('No English name (Arabic will be used)');
  if (!(item.images || []).length) warnings.push('No images');
  if (e.priceBeforeOffer != null && e.priceBeforeOffer !== '' && Number(e.priceBeforeOffer) <= Number(e.price)) warnings.push('Price before offer is not higher than price — offer ignored');
  return { errors, warnings };
}

function money(value, existing, d, keepExisting) {
  const ex = isPlainObject(existing) ? existing : {};
  const cur = d.currency || 'JOD';
  return {
    ...ex,
    currencyId: keepExisting && ex.currencyId != null ? ex.currencyId : Number(d.currencyId) || 1,
    value: round3(Number(value) || 0),
    currency: keepExisting && ex.currency ? ex.currency : cur,
    symbol: keepExisting && ex.symbol ? ex.symbol : cur,
  };
}

/**
 * @param base      template (create) or the product fetched from the API (update)
 * @param item      imported item
 * @param settings  extension settings
 * @param env       environment key (media ids are per environment)
 * @param productId set when updating
 */
export function buildPayload(base, item, settings, env, { productId = null } = {}) {
  const isUpdate = productId != null;
  const p = deepClone(base || settings.template);
  const e = item.edit || {};
  const d = settings.defaults || {};
  const m = settings.meta || {};

  if (!isUpdate) READ_ONLY.forEach((k) => delete p[k]);
  else p.productId = productId;

  const nameEn = String(e.nameEn || e.nameAr || '').trim();
  const nameAr = String(e.nameAr || e.nameEn || '').trim();
  const fill = (tpl, name) => String(tpl || '').replaceAll('{name}', name);

  p.name = { ...(isPlainObject(p.name) ? p.name : {}), ar: nameAr, en: nameEn };
  p.slug = String(e.slug || '').trim() || (isUpdate && p.slug) || slugify(nameEn || nameAr);
  p.brandId = e.brandId != null && e.brandId !== '' ? Number(e.brandId) : p.brandId ?? null;
  p.description = { ...(isPlainObject(p.description) ? p.description : {}), ar: wrapHtml(e.descAr || e.descEn), en: wrapHtml(e.descEn || e.descAr) };
  p.type = p.type || 'simple';
  p.isPublished = !!e.isPublished;
  p.isListed = e.isListed !== false;
  p.metaTitle = { ar: fill(m.titleAr, nameAr), en: fill(m.titleEn, nameEn) };
  p.metaDescription = { ar: fill(m.descAr, nameAr), en: fill(m.descEn, nameEn) };
  p.categories = (e.categories || []).map((x) => (isNaN(x) ? x : Number(x)));
  if (!Array.isArray(p.shippingCarriers) || !p.shippingCarriers.length) p.shippingCarriers = [...(d.shippingCarriers || [1])];
  p.SKU = String(e.sku ?? p.SKU ?? '');
  p.modelNumber = String(e.modelNumber ?? p.modelNumber ?? '');

  const offer = e.priceBeforeOffer != null && e.priceBeforeOffer !== '' && Number(e.priceBeforeOffer) > Number(e.price);
  const makeStock = (baseStock) => {
    const s = deepClone(isPlainObject(baseStock) ? baseStock : DEFAULT_STOCK);
    if (!isUpdate) STOCK_READ_ONLY.forEach((k) => delete s[k]);
    s.quantity = Math.max(0, parseInt(e.quantity, 10) || 0);
    s.maxPerUser = Math.max(1, parseInt(e.maxPerUser, 10) || Number(d.maxPerUser) || 1);
    s.supplierId = isUpdate && s.supplierId != null ? s.supplierId : Number(d.supplierId) || s.supplierId || 1;
    s.isPublished = s.isPublished ?? true;
    s.price = money(e.price, s.price, d, isUpdate);
    s.cost = money(e.cost ?? d.cost ?? 0, s.cost, d, isUpdate);
    s.priceBeforeOffer = offer ? money(e.priceBeforeOffer, s.priceBeforeOffer || s.price, d, isUpdate) : null;
    s.isOffer = offer;
    return s;
  };
  const stocks = Array.isArray(p.stocks) ? p.stocks : [];
  p.stocks = [makeStock(stocks[0]), ...(isUpdate ? stocks.slice(1) : [])];

  const variances = Array.isArray(p.variances) && p.variances.length ? p.variances : [deepClone(settings.template?.variances?.[0] || {})];
  const v = variances[0];
  Object.assign(v, {
    name: { ...p.name },
    slug: p.slug,
    brandId: p.brandId,
    SKU: p.SKU,
    metaTitle: { ...p.metaTitle },
    metaDescription: { ...p.metaDescription },
    isPublished: p.isPublished,
  });
  v.stocks = [makeStock(Array.isArray(v.stocks) ? v.stocks[0] : stocks[0]), ...(isUpdate && Array.isArray(v.stocks) ? v.stocks.slice(1) : [])];
  p.variances = [v, ...(isUpdate ? variances.slice(1) : [])];

  if (!isUpdate) {
    p.minPrice = p.maxPrice = round3(Number(e.price) || 0);
  }

  // The first selected image is the cover, even if its upload failed.
  // Never promote a gallery image silently or reuse a stale template cover.
  const uploaded = (item.images || []).map((img) => {
    const media = img.uploads?.[env];
    if (!media) return null;
    const { _raw, ...fields } = media;
    const src = media.src || media.file || media.preview || null;
    return {
      mediaId: null, alt: null, type: 'image', youtubeUrl: null,
      publishedAt: null, unPublishedAt: null, isPublished: true,
      ...fields, src, preview: media.preview || src,
    };
  });
  {
    const mode = settings.payload.mediaMode || 'media';
    const cover = uploaded[0] ? [{ ...uploaded[0], sort: 0 }] : [];
    const galleryList = (settings.payload.coverInGallery ? uploaded : uploaded.slice(1)).filter(Boolean);
    const gallery = galleryList.map((x, i) => ({ ...x, sort: i }));
    const put = (key) => {
      const cur = isPlainObject(p[key]) ? p[key] : {};
      p[key] = { ...cur, cover, gallery, youtube: cur.youtube || [], downloadable: cur.downloadable || [] };
    };
    if (mode === 'mediaCollective' || mode === 'both') put('mediaCollective');
    // Always send the field required by the admin API, including old settings.
    put('media');
  }

  return isPlainObject(settings.overrides) && Object.keys(settings.overrides).length ? deepMerge(p, settings.overrides) : p;
}
