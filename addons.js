/**
 * Stremio addon protocol client for the TV app.
 *
 * The TV talks to addon HTTP services directly (catalog/meta/stream/subtitles).
 * There is no addon server in the middle and no VM dependency. Manifests are
 * stored locally; the first run seeds Cinemeta + OpenSubtitles, and the Addons
 * screen can add any other manifest URL (Comet, AIOStreams, ...).
 */

import { store } from './store.js';

const DEFAULT_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json',
  'https://opensubtitles-v3.strem.io/manifest.json',
];

const GENRES = [
  ['action', 'Action'], ['adventure', 'Adventure'], ['animation', 'Animation'],
  ['comedy', 'Comedy'], ['crime', 'Crime'], ['documentary', 'Documentary'],
  ['drama', 'Drama'], ['family', 'Family'], ['fantasy', 'Fantasy'],
  ['history', 'History'], ['horror', 'Horror'], ['music', 'Music'],
  ['mystery', 'Mystery'], ['romance', 'Romance'], ['science fiction', 'Sci-Fi'],
  ['thriller', 'Thriller'], ['war', 'War'], ['western', 'Western'],
];

const manifestCache = new Map();
const dataCache = new Map();

const TTL = 5 * 60 * 1000;

function cacheGet(key) {
  const hit = dataCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  return null;
}

function cacheSet(key, value) {
  dataCache.set(key, { at: Date.now(), value });
  return value;
}

function addonBase(url) {
  return String(url || '').replace(/\/manifest\.json(?:\?.*)?$/i, '').replace(/\/+$/, '');
}

async function fetchJson(url, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, mode: 'cors', cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    }
    return await res.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Addon timed out');
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(error.message)) {
      throw new Error(`Cannot reach ${new URL(url).host} (CORS or offline)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function hasResource(addon, resource) {
  const resources = addon?.manifest?.resources;
  if (!Array.isArray(resources)) return false;
  return resources.some((entry) => (typeof entry === 'string' ? entry === resource : entry?.name === resource));
}

function supports(addon, resource, type) {
  if (!hasResource(addon, resource)) return false;
  const types = addon.manifest.types || [];
  return !types.length || types.includes(type);
}

async function manifestFor(url) {
  if (manifestCache.has(url)) {
    return manifestCache.get(url);
  }
  const manifest = await fetchJson(url);
  if (!manifest || !manifest.id || !manifest.name) {
    throw new Error('Not a Stremio addon manifest');
  }
  manifestCache.set(url, manifest);
  return manifest;
}

async function loadAddons() {
  let saved = store.addons();
  if (!saved.length) {
    for (const url of DEFAULT_ADDONS) {
      try {
        const manifest = await manifestFor(url);
        store.addAddon(url, manifest);
      } catch (error) {
        // Offline first run: keep the URL so a later attempt can retry.
        store.addAddon(url, { name: new URL(url).host, id: url, types: [], resources: [] });
      }
    }
    saved = store.addons();
  }
  const addons = [];
  for (const entry of saved) {
    try {
      const manifest = await manifestFor(entry.url);
      addons.push({ ...entry, manifest, base: addonBase(entry.url) });
    } catch (error) {
      addons.push({ ...entry, manifest: null, base: addonBase(entry.url), error: error.message });
    }
  }
  return addons;
}

function extraPath(extra) {
  const parts = Object.entries(extra || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return parts.length ? `/${parts.join('&')}` : '';
}

async function catalog(addon, type, id, extra = {}) {
  const key = `catalog|${addon.base}|${type}|${id}|${JSON.stringify(extra)}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const data = await fetchJson(`${addon.base}/catalog/${type}/${encodeURIComponent(id)}${extraPath(extra)}.json`);
  return cacheSet(key, data);
}

async function fetchMeta(addon, type, id) {
  const data = await fetchJson(`${addon.base}/meta/${type}/${encodeURIComponent(id)}.json`);
  return data.meta || null;
}

async function streams(addon, type, id) {
  const data = await fetchJson(`${addon.base}/stream/${type}/${encodeURIComponent(id)}.json`);
  return Array.isArray(data.streams) ? data.streams : [];
}

async function subtitles(addon, type, id, extra = {}) {
  const data = await fetchJson(`${addon.base}/subtitles/${type}/${encodeURIComponent(id)}${extraPath(extra)}.json`);
  return Array.isArray(data.subtitles) ? data.subtitles : [];
}

function toCard(meta, type) {
  return {
    id: meta.id,
    type: type || meta.type || 'movie',
    title: meta.name || meta.title || meta.id,
    poster: meta.poster || meta.background || '',
    background: meta.background || meta.poster || '',
    year: meta.year || meta.releaseInfo || '',
    genres: meta.genres || meta.genre || [],
    description: meta.description || '',
    runtime: meta.runtime || '',
    imdbRating: meta.imdbRating || '',
  };
}

async function home() {
  const addons = await loadAddons();
  const rows = [];
  let hero = null;

  for (const addon of addons) {
    if (!addon.manifest || !hasResource(addon, 'catalog')) continue;
    const catalogs = (addon.manifest.catalogs || []).filter((c) => ['movie', 'series'].includes(c.type));
    for (const cat of catalogs.slice(0, 3)) {
      try {
        const data = await catalog(addon, cat.type, cat.id, {});
        const items = (data.metas || []).map((m) => toCard(m, cat.type)).filter((m) => m.poster);
        if (!items.length) continue;
        if (!hero) hero = items[0];
        rows.push({
          title: cat.name || cat.id,
          items,
          genre: cat.genre || undefined,
        });
      } catch (error) {
        // Skip a broken catalog, keep the rest of the home screen usable.
      }
      if (rows.length >= 8) break;
    }
    if (rows.length >= 8) break;
  }

  return {
    hero,
    rows,
    genres: GENRES.map(([id, name]) => ({ id, name })),
  };
}

async function search(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return { items: [] };
  const addons = await loadAddons();
  const results = new Map();
  for (const addon of addons) {
    if (!addon.manifest || !hasResource(addon, 'catalog')) continue;
    const catalogDef = (addon.manifest.catalogs || []).find((c) => ['movie', 'series'].includes(c.type));
    if (!catalogDef) continue;
    for (const type of ['movie', 'series']) {
      try {
        const data = await catalog(addon, type, catalogDef.id, { search: q });
        for (const meta of data.metas || []) {
          const card = toCard(meta, type);
          if (card.poster && !results.has(card.id)) results.set(card.id, card);
        }
      } catch (error) {
        // Search is best-effort across addons.
      }
    }
  }
  return { items: [...results.values()] };
}

async function browse({ genre = '', page = 0 } = {}) {
  const addons = await loadAddons();
  const addon = addons.find((a) => a.manifest && hasResource(a, 'catalog'));
  if (!addon) return { items: [], title: 'Browse', hasMore: false };
  const catalogDef = (addon.manifest.catalogs || []).find((c) => ['movie', 'series'].includes(c.type));
  if (!catalogDef) return { items: [], title: 'Browse', hasMore: false };
  const extra = {};
  if (genre) extra.genre = GENRES.find(([id]) => id === genre)?.[1] || genre;
  if (page) extra.skip = page * 30;
  const data = await catalog(addon, catalogDef.type, catalogDef.id, extra);
  return {
    items: (data.metas || []).map((m) => toCard(m, catalogDef.type)),
    title: genre ? GENRES.find(([id]) => id === genre)?.[1] || genre : 'Popular',
    hasMore: Array.isArray(data.metas) && data.metas.length >= 30,
  };
}

async function item(id, type = 'movie') {
  const addons = await loadAddons();
  const metaAddon = addons.find((a) => a.manifest && supports(a, 'meta', type));
  if (!metaAddon) {
    throw new Error('No installed addon provides metadata for this item');
  }
  const meta = await fetchMeta(metaAddon, type, id);
  if (!meta) throw new Error('Metadata not found');

  const allStreams = [];
  for (const addon of addons) {
    if (!addon.manifest || !supports(addon, 'stream', type)) continue;
    try {
      const list = await streams(addon, type, id);
      for (const stream of list) {
        allStreams.push({ ...stream, addon: addon.manifest.name });
      }
    } catch (error) {
      // One broken stream addon should not hide the others.
    }
  }

  const allSubs = [];
  for (const addon of addons) {
    if (!addon.manifest || !supports(addon, 'subtitles', type)) continue;
    try {
      const list = await subtitles(addon, type, id);
      for (const sub of list) {
        allSubs.push({
          ...sub,
          file: sub.url,
          label: sub.subtitleFileName || sub.lang || sub.id || 'subtitle',
          lang: sub.lang || '',
        });
      }
    } catch (error) {
      // Optional.
    }
  }

  const card = toCard(meta, type);
  return {
    ...card,
    id,
    type,
    description: meta.description || '',
    runtime: meta.runtime || '',
    pageUrl: meta.url || '',
    streams: allStreams,
    subtitles: allSubs,
    stream: allStreams[0] || null,
  };
}

/** Minimal SRT/WebVTT parser for the player subtitle proxy adapter. */
function parseCues(text) {
  const blocks = String(text || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.length);
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0) continue;
    const [startRaw, endRaw] = lines[index].split('-->');
    const parse = (value) => {
      const match = String(value || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
      if (!match) return null;
      return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || '0').padEnd(3, '0').slice(0, 3)) / 1000;
    };
    const start = parse(startRaw);
    const end = parse(endRaw);
    const body = lines.slice(index + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (start !== null && end !== null && end > start && body) {
      cues.push({ start, end, text: body });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

async function subtitleCues(url) {
  const res = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!res.ok) throw new Error(`subtitle HTTP ${res.status}`);
  return parseCues(await res.text());
}

/**
 * Adapter for the existing FreeTV app's api(path) calls. Returns undefined when
 * the path is not a Stremio data request so the server fallback can handle it.
 */
async function handleApi(path, opts = {}) {
  try {
    if (path === '/api/home') return await home();
    if (path === '/api/genres') {
      return { genres: GENRES.map(([id, name]) => ({ id, name })), decades: [] };
    }
    if (path.startsWith('/api/browse')) {
      const url = new URL(path, location.origin);
      return await browse({ genre: url.searchParams.get('genre') || '', page: Number(url.searchParams.get('page') || 0) });
    }
    if (path.startsWith('/api/search')) {
      const url = new URL(path, location.origin);
      return await search(url.searchParams.get('q') || '');
    }
    if (path.startsWith('/api/item/')) {
      const id = decodeURIComponent(path.slice('/api/item/'.length).split('?')[0]);
      return await item(id, new URL(path, location.origin).searchParams.get('type') || 'movie');
    }
    if (path.startsWith('/api/addon')) {
      const url = new URL(path, location.origin).searchParams.get('url');
      const manifest = await manifestFor(url);
      return { url, manifest };
    }
    if (path.startsWith('/api/subtitles')) {
      const url = new URL(path, location.origin).searchParams.get('url');
      return { cues: await subtitleCues(url) };
    }
    if (path.startsWith('/api/recommend') || path.startsWith('/api/suggest')) {
      return { items: [] };
    }
    if (path.startsWith('/api/waveform')) {
      return { error: 'Waveform server not configured (on-device mode)' };
    }
  } catch (error) {
    throw new Error(error.message || 'Addon request failed');
  }
  return undefined;
}

export {
  addonBase,
  browse,
  catalog,
  handleApi,
  home,
  item,
  loadAddons,
  manifestFor,
  search,
  subtitleCues,
};
