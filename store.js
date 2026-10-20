/** Client-side state: prefs, watch history, watchlist, subtitle offsets, addons. */

const NS = 'kc.tv.v1.';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    // storage full / private mode — keep running
  }
}

export const prefs = {
  get all() {
    return read('prefs', { subSize: 'normal', subBg: true, subRaise: false, autoSubs: true });
  },
  set(patch) {
    write('prefs', { ...this.all, ...patch });
  },
  get(key) {
    return this.all[key];
  },
};

export const store = {
  history() {
    return read('history', []);
  },
  historyAdd(item) {
    const list = this.history().filter((h) => h.id !== item.id);
    list.unshift({
      id: item.id,
      title: item.title,
      poster: item.poster,
      year: item.year || 0,
      genres: item.genres || [],
      at: Date.now(),
      position: 0,
      duration: 0,
    });
    write('history', list.slice(0, 60));
  },
  historyProgress(id, position, duration) {
    const list = this.history();
    const row = list.find((h) => h.id === id);
    if (!row) return;
    row.position = Math.round(position);
    row.duration = Math.round(duration || row.duration || 0);
    row.at = Date.now();
    write('history', list);
  },
  historyGet(id) {
    return this.history().find((h) => h.id === id) || null;
  },
  historyRemove(id) {
    write('history', this.history().filter((h) => h.id !== id));
  },
  continueWatching() {
    return this.history().filter((h) => h.position > 20 && (!h.duration || h.position < h.duration - 60)).slice(0, 20);
  },
  watchlist() {
    return read('list', []);
  },
  inList(id) {
    return this.watchlist().some((w) => w.id === id);
  },
  toggleList(item) {
    const list = this.watchlist();
    const idx = list.findIndex((w) => w.id === item.id);
    if (idx >= 0) {
      list.splice(idx, 1);
      write('list', list);
      return false;
    }
    list.unshift({ id: item.id, title: item.title, poster: item.poster, year: item.year || 0, genres: item.genres || [], at: Date.now() });
    write('list', list.slice(0, 200));
    return true;
  },
  offsetFor(id, file) {
    const map = read('offsets', {});
    return Number(map[`${id}|${file}`] || 0);
  },
  setOffset(id, file, value) {
    const map = read('offsets', {});
    map[`${id}|${file}`] = Number(value.toFixed(3));
    write('offsets', map);
  },
  lastSub(id) {
    const map = read('lastSub', {});
    return map[id] || null;
  },
  setLastSub(id, file) {
    const map = read('lastSub', {});
    map[id] = file;
    write('lastSub', map);
  },
  addons() {
    return read('addons', []);
  },
  setAddons(list) {
    write('addons', list);
  },
  addAddon(url, manifest) {
    const list = this.addons().filter((a) => a.url !== url);
    list.push({ url, name: manifest?.name || url, id: manifest?.id || '', types: manifest?.types || [], resources: manifest?.resources || [], at: Date.now() });
    write('addons', list);
    return list;
  },
  removeAddon(url) {
    write('addons', this.addons().filter((a) => a.url !== url));
  },
};

let apiAdapter = null;

export function setApiAdapter(adapter) {
  apiAdapter = adapter;
}

export function apiBase() {
  try {
    const saved = localStorage.getItem(NS + 'apiBase');
    if (saved) return String(saved).replace(/\/+$/, '');
  } catch {}
  // Served by the addon server itself: same origin, relative paths.
  if (/^https?:$/.test(location.protocol) && location.pathname.startsWith('/tv')) return '';
  // Packaged TV app (file:// or tizen://): the server lives on the LAN.
  return 'http://127.0.0.1:7011';
}

export function setApiBase(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  try {
    if (clean) localStorage.setItem(NS + 'apiBase', clean);
    else localStorage.removeItem(NS + 'apiBase');
  } catch {}
}

export async function api(path, opts = {}) {
  if (typeof apiAdapter === 'function') {
    const handled = await apiAdapter(path, opts);
    if (handled !== undefined) return handled;
  }
  const headers = { ...(opts.headers || {}) };
  // Only set content-type when there is a body: a bare GET with it would turn
  // every read into a CORS preflight (and the packaged TV app is cross-origin).
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(`${apiBase()}${path}`, { ...opts, headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtOffset(value) {
  const n = Number(value) || 0;
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}s`;
}
