// Thin fetch wrapper for the Action.jo API.

export class ApiError extends Error {
  constructor(message, status = 0, body = null, url = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function joinUrl(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return String(base || '').replace(/\/+$/, '') + '/' + String(path || '').replace(/^\/+/, '');
}

// Short, safe copy of a request body for the API log (passwords hidden).
function describeBody(json, form) {
  if (json !== undefined) {
    try {
      return JSON.parse(JSON.stringify(json), (k, v) => (/password/i.test(k) ? '••••' : v));
    } catch {
      return null;
    }
  }
  if (form) {
    const out = {};
    for (const [k, v] of form.entries()) out[k] = typeof v === 'string' ? v : `(file ${v.name || ''}, ${v.type || '?'}, ${v.size} bytes)`;
    return out;
  }
  return null;
}

// Some APIs answer HTTP 200 with an error inside the body.
function bodyError(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.success === false || data.status === false || data.status === 'error' || data.error === true) return data.message || data.error || 'Request failed';
  if (typeof data.code === 'number' && data.code >= 400) return data.message || `Error ${data.code}`;
  return null;
}

export async function apiFetch(baseUrl, path, { method = 'GET', json, form, token, signal, onLog } = {}) {
  const url = joinUrl(baseUrl, path);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // browser sets multipart boundary
  }
  const started = Date.now();
  const log = (status, response, ok) => {
    try {
      onLog?.({ at: new Date().toISOString(), ms: Date.now() - started, method, url, status, ok, request: describeBody(json, form), response });
    } catch {
      /* ignore */
    }
  };
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal, credentials: 'omit' });
  } catch (e) {
    log(0, String(e.message), false);
    throw new ApiError(`Network error — could not reach ${url} (${e.message})`, 0, null, url);
  }
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const inBodyError = res.ok ? bodyError(data) : null;
  log(res.status, data, res.ok && !inBodyError);
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.message || data.error || data.title)) || `HTTP ${res.status} ${res.statusText}`;
    throw new ApiError(String(msg), res.status, data, url);
  }
  if (inBodyError) throw new ApiError(String(inBodyError), res.status, data, url);
  return data;
}

export const fillId = (path, id) => String(path).replace('{id}', encodeURIComponent(id));

// The product may be returned bare or wrapped in {data: ...}.
export function unwrapProduct(resp) {
  if (!resp || typeof resp !== 'object') return null;
  for (const c of [resp, resp.data, resp.product, resp.data?.product, resp.data?.data]) {
    if (c && typeof c === 'object' && !Array.isArray(c) && (c.productId != null || (c.name && c.stocks))) return c;
  }
  if (resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)) return resp.data;
  return resp;
}

export function productIdOf(p) {
  return p?.productId ?? p?.id ?? p?.product_id ?? null;
}

// Find the uploaded media object in an /upload-media response, whatever its shape:
// {id,...} · {data:{id}} · {data:{media:[{id}]}} · {success:true, path/url} · "path/string" ...
const ID_KEYS = ['id', 'mediaId', 'media_id', 'uuid', 'fileId', 'file_id'];
const SRC_KEYS = ['src', 'path', 'file', 'filePath', 'file_path', 'fileName', 'file_name', 'name', 'key'];
const URL_KEYS = ['preview', 'url', 'original_url', 'originalUrl', 'full_url', 'fullUrl', 'link', 'location'];

function* walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return;
  if (!Array.isArray(node)) yield node;
  for (const v of Object.values(node)) if (v && typeof v === 'object') yield* walk(v, depth + 1);
}

export function extractMedia(resp) {
  if (typeof resp === 'string' && resp.trim()) {
    const t = resp.trim();
    return { id: null, src: t, preview: /^https?:/.test(t) ? t : null, _raw: resp };
  }
  const pick = (o, keys) => keys.map((k) => o[k]).find((v) => v != null && v !== '' && typeof v !== 'object');
  // 1) an object that has an id
  for (const o of walk(resp)) {
    const id = pick(o, ID_KEYS);
    if (id != null && (pick(o, SRC_KEYS) || pick(o, URL_KEYS) || o.mimeType || o.mime_type || o.size || o.fileSize || Object.keys(o).length <= 3 || o === resp)) {
      return { ...o, id, src: o.src ?? pick(o, SRC_KEYS) ?? null, preview: o.preview ?? pick(o, URL_KEYS) ?? null };
    }
  }
  // 2) no id: an object with a path / url (temporary upload)
  for (const o of walk(resp)) {
    const src = pick(o, SRC_KEYS);
    const url = pick(o, URL_KEYS);
    if ((src && !/^(success|ok|uploaded)/i.test(String(src))) || url) return { ...o, id: null, src: o.src ?? src ?? url, preview: o.preview ?? url ?? null };
  }
  return null;
}

export function errorInfo(e, op) {
  return {
    op,
    message: e?.message || String(e),
    status: e?.status ?? null,
    body: e?.body ?? null,
    url: e?.url || '',
    at: new Date().toISOString(),
  };
}

// Pull readable validation messages out of {message, details:[...]} / Laravel {errors:{field:[...]}}.
export function errorLines(body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;
  const d = body.details ?? body.errors;
  if (Array.isArray(d)) d.forEach((x) => out.push(typeof x === 'string' ? x : x?.message || JSON.stringify(x)));
  else if (d && typeof d === 'object') Object.entries(d).forEach(([k, v]) => out.push(`${k}: ${[].concat(v).join(', ')}`));
  return out;
}
