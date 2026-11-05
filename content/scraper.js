// Product scraper: Magento 2 first (abdeencenter.com), then JSON-LD / OpenGraph for any other shop.
(() => {
  'use strict';
  const NS = (globalThis.__ACTION_IMPORTER__ = globalThis.__ACTION_IMPORTER__ || {});
  if (NS.scraperLoaded) return;
  NS.scraperLoaded = true;

  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const text = (el) => (el ? clean(el.textContent) : '');
  const hasArabic = (s) => /[؀-ۿ]/.test(s || '');

  function q(root, sels) {
    for (const s of [].concat(sels)) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
      } catch {
        /* bad selector */
      }
    }
    return null;
  }

  function metaContent(doc, ...names) {
    for (const n of names) {
      const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
      const v = el?.getAttribute('content');
      if (v) return v.trim();
    }
    return '';
  }

  function toNumber(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v)
      .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
      .replace(/٫/g, '.')
      .replace(/٬/g, ',');
    const m = s.match(/-?\d[\d.,]*/);
    if (!m) return null;
    s = m[0].replace(/[.,]+$/, '');
    if (s.includes('.') && s.includes(',')) {
      s = s.lastIndexOf('.') > s.lastIndexOf(',') ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
    } else if (s.includes(',')) {
      s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    }
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function abs(u, base) {
    if (!u) return null;
    try {
      return new URL(u, base).href;
    } catch {
      return null;
    }
  }

  function magentoInit(doc) {
    const out = [];
    doc.querySelectorAll('script[type="text/x-magento-init"]').forEach((s) => {
      try {
        out.push(JSON.parse(s.textContent));
      } catch {
        /* ignore */
      }
    });
    return out;
  }

  function findKeyDeep(obj, key, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 10) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const v of Object.values(obj)) {
      const r = findKeyDeep(v, key, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  function jsonLdProduct(doc) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent);
        const arr = Array.isArray(j) ? j : j['@graph'] || [j];
        for (const it of arr) {
          const t = it?.['@type'];
          if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) return it;
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function isMagento(doc) {
    return !!(
      doc.querySelector('script[type="text/x-magento-init"], [data-mage-init], #product_addtocart_form, .switcher-language [data-post]') ||
      doc.body?.classList.contains('catalog-product-view') ||
      doc.querySelector('img[src*="/media/catalog/product/"]')
    );
  }

  function isProductPage(doc) {
    if (doc.querySelector('#product_addtocart_form, form[data-product-sku]')) return true;
    if (doc.body?.classList.contains('catalog-product-view')) return true;
    if (jsonLdProduct(doc)) return true;
    return /product/i.test(metaContent(doc, 'og:type'));
  }

  // ---- description cleaning ----
  const ALLOWED = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'U', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BLOCKQUOTE']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'NOSCRIPT', 'SVG', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'LINK', 'META', 'OBJECT', 'EMBED']);
  const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, tr, blockquote, div, span, strong, b';

  function sanitizeHtml(html, stripTerms = []) {
    if (!html) return '';
    const d = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html');
    const root = d.getElementById('__root');
    if (!root) return '';
    const terms = (stripTerms || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    if (terms.length) {
      const hit = (s) => terms.some((x) => String(s).toLowerCase().includes(x));
      // remove short blocks that mention a stripped term (e.g. "متوفرة حصرياً لدى مخازن عابدين")
      const els = [...root.querySelectorAll(BLOCKS)].reverse();
      for (const el of els) {
        if (!el.isConnected) continue;
        const t = el.textContent;
        if (hit(t) && t.trim().length <= 160) el.remove();
      }
      // longer text: drop only the sentences that mention the term
      const walker = d.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) if (hit(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
      for (const n of nodes) {
        n.nodeValue = n.nodeValue
          .split(/(?<=[.!?؟\n])\s+/)
          .filter((s) => !hit(s))
          .join(' ');
      }
    }
    const walk = (node) => {
      for (const ch of [...node.childNodes]) {
        if (ch.nodeType === 8) {
          ch.remove();
          continue;
        }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName.toUpperCase();
        if (DROP.has(tag)) {
          ch.remove();
          continue;
        }
        walk(ch);
        if (!ALLOWED.has(tag)) {
          // unwrap: keep the text, lose the tag (DIV/SPAN/A/FONT...)
          if (tag === 'DIV' && ch.nextSibling && ch.textContent.trim()) ch.after(d.createElement('br'));
          ch.replaceWith(...ch.childNodes);
          continue;
        }
        for (const a of [...ch.attributes]) if (!['colspan', 'rowspan'].includes(a.name)) ch.removeAttribute(a.name);
        if (tag === 'P') ch.setAttribute('dir', 'auto');
      }
    };
    walk(root);
    // drop empty paragraphs/list items
    root.querySelectorAll('p, li, strong, b, em, h2, h3, h4').forEach((el) => {
      if (!el.textContent.trim() && !el.querySelector('br, table')) el.remove();
    });
    let out = root.innerHTML.replace(/(\s*<br>\s*){3,}/g, '<br><br>').replace(/\s+/g, ' ').trim();
    out = out.replace(/^(<br>\s*)+|(<br>\s*)+$/g, '');
    if (out && !/<(p|ul|ol|table|h\d|blockquote)\b/i.test(out)) out = `<p dir="auto">${out}</p>`;
    return out;
  }

  // ---- images ----
  function scrapeImages(doc, base, ld) {
    const images = [];
    const videos = [];
    const add = (u) => {
      const a = abs(u, base);
      if (a && /^https?:/.test(a) && !/placeholder|\/logo|loader|spacer/i.test(a) && !images.includes(a)) images.push(a);
    };
    for (const j of magentoInit(doc)) {
      const g = findKeyDeep(j, 'mage/gallery/gallery');
      if (g?.data?.length) {
        [...g.data]
          .sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || Number(a.position || 0) - Number(b.position || 0))
          .forEach((it) => {
            if (it.videoUrl) {
              videos.push(it.videoUrl);
              return;
            }
            add(it.full || it.img || it.thumb);
          });
      }
    }
    if (!images.length) {
      doc.querySelectorAll('.fotorama__stage__frame[href], [data-gallery-role="gallery"] .fotorama__stage__frame[href]').forEach((el) => add(el.getAttribute('href')));
    }
    if (!images.length) {
      doc
        .querySelectorAll(
          '[data-gallery-role="gallery-placeholder"] img, img.gallery-placeholder__image, .product.media img, .product-image-gallery img, .woocommerce-product-gallery img, .product-gallery img'
        )
        .forEach((img) => add(img.getAttribute('data-zoom-image') || img.getAttribute('data-large_image') || img.getAttribute('data-src') || img.getAttribute('src')));
    }
    if (!images.length && ld?.image) [].concat(ld.image).forEach((im) => add(typeof im === 'string' ? im : im?.url || im?.contentUrl));
    if (!images.length) add(metaContent(doc, 'og:image', 'og:image:url', 'twitter:image'));
    return { images, videos: [...new Set(videos)] };
  }

  function magentoStores(doc) {
    const codes = new Set();
    let current = null;
    doc.querySelectorAll('[data-post]').forEach((el) => {
      try {
        const j = JSON.parse(el.getAttribute('data-post'));
        const d = j?.data || {};
        if (d.___store) {
          codes.add(d.___store);
          if (d.___from_store) current = d.___from_store;
        }
      } catch {
        /* ignore */
      }
    });
    doc.querySelectorAll('a[href*="___store="]').forEach((a) => {
      const m = a.getAttribute('href').match(/___store=([\w-]+)/);
      if (m) codes.add(m[1]);
    });
    const trig = q(doc, ['.switcher-language .switcher-trigger strong[class*="view-"]', '#switcher-language-trigger strong[class*="view-"]', '.switcher-language strong[class*="view-"]']);
    if (!current && trig) {
      const m = trig.className.match(/view-([\w-]+)/);
      if (m) current = m[1];
    }
    if (current) codes.add(current);
    return { current, codes: [...codes] };
  }

  function detectLang(doc, name) {
    const l = (doc.documentElement?.getAttribute('lang') || '').toLowerCase();
    const arName = hasArabic(name);
    if (l.startsWith('ar')) return 'ar';
    if (l.startsWith('en') && !arName) return 'en';
    return arName ? 'ar' : 'en';
  }

  function specsFromDescription(el) {
    const out = [];
    if (!el) return out;
    el.querySelectorAll('li, p, tr').forEach((n) => {
      if (n.querySelector('li, p, tr')) return;
      const t = text(n);
      const m = t.match(/^([^:：]{2,40})\s*[:：]\s*(.{1,200})$/);
      if (m) out.push({ label: clean(m[1]), value: clean(m[2]) });
    });
    return out;
  }

  // ---- main scrape of one document ----
  function scrapeDocument(doc, url, opts = {}) {
    const base = url || doc.baseURI || location.href;
    const ld = jsonLdProduct(doc);
    const magento = isMagento(doc);
    const offers = ld ? [].concat(ld.offers || [])[0] || {} : {};

    const name =
      text(q(doc, ['.product-info-main .page-title [itemprop="name"]', '.product-info-main h1.page-title', 'h1.page-title .base', 'h1.page-title', 'h1.product_title', 'h1[itemprop="name"]', '.product-name h1'])) ||
      clean(ld?.name) ||
      clean(metaContent(doc, 'og:title')).replace(/\s*[|\-–].*$/, '') ||
      text(doc.querySelector('h1'));

    const sku =
      text(q(doc, ['.product-info-main .product.attribute.sku .value', '.product.attribute.sku .value', '[itemprop="sku"]', '.sku_wrapper .sku'])) ||
      doc.querySelector('[itemprop="sku"]')?.getAttribute('content') ||
      clean(ld?.sku) ||
      doc.querySelector('form[data-product-sku]')?.getAttribute('data-product-sku') ||
      '';

    const sourceId =
      q(doc, ['#product_addtocart_form input[name="product"]', 'form[data-product-sku] input[name="product"]'])?.value ||
      q(doc, ['.product-info-main .price-box[data-product-id]', '.price-box[data-product-id]'])?.getAttribute('data-product-id') ||
      clean(ld?.productID) ||
      null;

    // price
    const priceRoot = q(doc, ['.product-info-main .product-info-price', '.product-info-main', '.product-info-price', '.summary .price']) || doc;
    const fin = q(priceRoot, ['[data-price-type="finalPrice"][data-price-amount]', '[data-price-type="finalPrice"]', '[data-price-type="minPrice"][data-price-amount]']);
    let price = toNumber(fin?.getAttribute('data-price-amount')) ?? (fin ? toNumber(text(fin)) : null);
    const old = q(priceRoot, ['[data-price-type="oldPrice"][data-price-amount]', '.old-price [data-price-amount]', '.old-price .price', 'del .amount']);
    let oldPrice = old ? toNumber(old.getAttribute('data-price-amount')) ?? toNumber(text(old)) : null;
    if (price == null) price = toNumber(metaContent(doc, 'product:price:amount', 'og:price:amount'));
    if (price == null) price = toNumber(offers.price ?? offers.lowPrice);
    if (price == null) price = toNumber(doc.querySelector('[itemprop="price"]')?.getAttribute('content') || text(doc.querySelector('[itemprop="price"]')));
    if (price == null) price = toNumber(text(q(priceRoot, ['.price-box .price', 'ins .amount', '.price'])));
    if (oldPrice != null && price != null && oldPrice <= price) oldPrice = null;
    const currency = metaContent(doc, 'product:price:currency', 'og:price:currency') || offers.priceCurrency || doc.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content') || 'JOD';

    // description
    const descEl = q(doc, [
      '.product.attribute.description .value',
      '#description .value',
      '#description .product.attribute.description',
      '.product.info.detailed .description .value',
      '#tab-description',
      '.woocommerce-product-details__short-description',
      'div[itemprop="description"]',
      '.product-description',
    ]);
    const shortEl = q(doc, ['.product.attribute.overview .value', '.product-info-main .overview']);
    let descriptionHtml = descEl ? sanitizeHtml(descEl.innerHTML, opts.stripTerms) : '';
    if (!descriptionHtml) {
      const fallback = clean(ld?.description) || metaContent(doc, 'og:description', 'description');
      if (fallback) descriptionHtml = sanitizeHtml(`<p>${fallback.replace(/</g, '&lt;')}</p>`, opts.stripTerms);
    }
    const shortDescriptionHtml = shortEl ? sanitizeHtml(shortEl.innerHTML, opts.stripTerms) : '';

    // specs
    const specs = [];
    doc.querySelectorAll('#product-attribute-specs-table tr, table.additional-attributes tr, .woocommerce-product-attributes tr').forEach((tr) => {
      const l = text(tr.querySelector('th'));
      const v = text(tr.querySelector('td'));
      if (l && v) specs.push({ label: l, value: v });
    });
    for (const s of specsFromDescription(descEl)) if (!specs.some((x) => x.label === s.label)) specs.push(s);

    // brand
    let brand = specs.find((s) => /brand|manufacturer|ماركة|الماركة|العلامة/i.test(s.label))?.value || '';
    if (!brand) brand = text(q(doc, ['[itemprop="brand"] [itemprop="name"]', '.product-brand a', '.product-brand', '.brand-name', '.amshopby-brand-title-link'])) || doc.querySelector('[itemprop="brand"]')?.getAttribute('content') || '';
    if (!brand) brand = metaContent(doc, 'product:brand', 'og:brand');
    if (!brand && ld?.brand) brand = typeof ld.brand === 'string' ? ld.brand : ld.brand.name || '';

    // stock
    let inStock = null;
    const st = q(doc, ['.product-info-main .stock', '.product-info-stock-sku .stock', 'p.stock']);
    if (st) inStock = st.classList.contains('available') || st.classList.contains('in-stock') ? true : st.classList.contains('unavailable') || st.classList.contains('out-of-stock') ? false : null;
    if (inStock == null) {
      const av = metaContent(doc, 'product:availability', 'og:availability') || offers.availability || doc.querySelector('[itemprop="availability"]')?.getAttribute('href') || '';
      if (av) inStock = /instock|in stock|available/i.test(av) && !/out/i.test(av);
    }
    if (inStock == null && doc.querySelector('#product-addtocart-button:not([disabled])')) inStock = true;

    // breadcrumbs
    let breadcrumbs = [...doc.querySelectorAll('.breadcrumbs li, .breadcrumb li, nav.woocommerce-breadcrumb a, nav[aria-label*="readcrumb"] li')].map(text).filter(Boolean);
    if (breadcrumbs.length && /^(home|الرئيسية|الصفحة الرئيسية|الرئيسيه)$/i.test(breadcrumbs[0])) breadcrumbs.shift();
    if (breadcrumbs.length && breadcrumbs[breadcrumbs.length - 1] === name) breadcrumbs.pop();

    // configurable options (for reference)
    const options = [];
    for (const j of magentoInit(doc)) {
      const cfg = findKeyDeep(j, 'jsonConfig');
      if (cfg?.attributes) {
        Object.values(cfg.attributes).forEach((a) => options.push({ label: a.label, values: (a.options || []).map((o) => o.label) }));
        break;
      }
    }

    const { images, videos } = scrapeImages(doc, base, ld);
    const lang = detectLang(doc, name);

    return {
      url: base.split('#')[0],
      site: (() => {
        try {
          return new URL(base).hostname.replace(/^www\./, '');
        } catch {
          return location.hostname.replace(/^www\./, '');
        }
      })(),
      platform: magento ? 'magento' : 'generic',
      lang,
      sourceId: sourceId ? String(sourceId) : null,
      sku,
      name,
      descriptionHtml,
      shortDescriptionHtml,
      price,
      oldPrice,
      currency,
      inStock,
      brand: clean(brand),
      breadcrumbs,
      specs,
      images,
      videos,
      options,
    };
  }

  function fillMissing(target, from) {
    if (!target || !from) return target;
    for (const [k, v] of Object.entries(from)) {
      const cur = target[k];
      const empty = cur == null || cur === '' || (Array.isArray(cur) && !cur.length);
      if (empty && v != null && v !== '' && !(Array.isArray(v) && !v.length)) target[k] = v;
    }
    return target;
  }

  async function fetchDoc(url, init = {}) {
    try {
      const r = await fetch(url, { credentials: 'same-origin', redirect: 'follow', ...init, headers: { Accept: 'text/html,application/xhtml+xml' } });
      if (!r.ok) return null;
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { doc, url: r.url || url };
    } catch {
      return null;
    }
  }

  function withParam(url, k, v) {
    const u = new URL(url);
    u.searchParams.set(k, v);
    return u.href;
  }

  const noAlt = new Set();

  // Scrape a product in both Arabic and English (Magento store views).
  async function scrapeBilingual(doc, url, opts = {}) {
    const primary = scrapeDocument(doc, url, opts);
    const out = { primary, ar: null, en: null, storeCodes: null };
    out[primary.lang] = primary;
    const other = primary.lang === 'ar' ? 'en' : 'ar';
    const host = primary.site;
    if (primary.platform !== 'magento' && !opts.storeCodes?.[other]) return out;
    if (noAlt.has(host) && !opts.storeCodes?.[other]) return out;

    const st = magentoStores(doc);
    const cands = [];
    if (opts.storeCodes?.[other]) cands.push(opts.storeCodes[other]);
    for (const c of st.codes) if (c !== st.current && !cands.includes(c)) cands.push(c);
    if (!cands.length) cands.push(...(other === 'en' ? ['default', 'en'] : ['ar', 'arabic']));

    for (const code of cands.slice(0, 4)) {
      const res = await fetchDoc(withParam(primary.url, '___store', code), { credentials: 'omit' });
      if (!res) continue;
      const s2 = scrapeDocument(res.doc, primary.url, opts);
      if (s2.lang === other && s2.name) {
        out[other] = s2;
        out.storeCodes = { [other]: code };
        if (st.current) out.storeCodes[primary.lang] = st.current;
        break;
      }
    }
    if (!out[other]) noAlt.add(host);
    return out;
  }

  function listingCards(doc = document) {
    const cards = [];
    doc.querySelectorAll('.product-item, li.item.product, li.product.type-product, .products-grid .item').forEach((card) => {
      const a = q(card, ['a.product-item-link', 'a.product-item-photo', 'a.product.photo', '.product-name a', 'a.woocommerce-LoopProduct-link', 'a[href]']);
      if (!a) return;
      const href = abs(a.getAttribute('href'), location.href);
      if (!href || href.startsWith('javascript')) return;
      if (card.parentElement?.closest('.product-item, li.item.product') ) return; // nested
      cards.push({ card, url: href.split('#')[0] });
    });
    return cards;
  }

  Object.assign(NS, {
    scrapeDocument,
    scrapeBilingual,
    sanitizeHtml,
    isProductPage,
    isMagento,
    magentoStores,
    fetchDoc,
    fillMissing,
    listingCards,
    toNumber,
  });
})();
