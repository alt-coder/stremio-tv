import { api, apiBase, setApiBase, setApiAdapter, store, prefs } from './store.js';
import { handleApi } from './addons.js';
import { openPlayer, playerActive, handlePlayerKey } from './player.js';

/**
 * TV shell: hash-free routing, D-pad focus, and the screens.
 * Data comes from Stremio addons directly; no addon server or VM.
 */

const view = document.querySelector('#view');
const nav = document.querySelector('#nav');
const clock = document.querySelector('#clock');
const statusEl = document.querySelector('#status');
const toastEl = document.querySelector('#toast');

const state = {
  route: { name: 'home' },
  cache: new Map(),
  focus: null,
  query: '',
  browse: { kind: 'genre', id: 'noir', page: 0, items: [] },
  libraryTab: 'continue',
  addonUrl: '',
  addonShift: false,
  editServer: null,
};

const $ = (sel, root = document) => root.querySelector(sel);

/* ---------------- utilities ---------------- */

function status(text) {
  if (!text) {
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.innerHTML = `<div><div class="spin"></div>${text}</div>`;
  statusEl.classList.remove('hidden');
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function card(item, { progress = 0 } = {}) {
  const year = item.year ? ` · ${item.year}` : '';
  const pct = progress && item.duration ? Math.min(100, (progress / item.duration) * 100) : 0;
  return `<div class="card" data-focus data-item="${esc(item.id)}" data-type="${esc(item.type || 'movie')}" tabindex="0">
    <div class="card-poster" style="background-image:url('${esc(item.poster)}')">
      ${item.rights ? `<span class="card-badge">${esc(item.rights)}</span>` : ''}
      ${pct ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
    </div>
    <div class="card-body">
      <div class="card-title">${esc(item.title)}</div>
      <div class="card-sub">${esc((item.genres || [])[0] || '')}${year}</div>
    </div>
  </div>`;
}

async function cached(key, fn, ttl = 120000) {
  const hit = state.cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  state.cache.set(key, { at: Date.now(), value });
  return value;
}

/* ---------------- focus ---------------- */

function focusables() {
  return [...view.querySelectorAll('[data-focus]')].filter((el) => el.offsetParent !== null);
}

function setFocus(el, { scroll = true } = {}) {
  if (!el) return;
  if (state.focus && state.focus !== el) state.focus.classList.remove('focused');
  state.focus = el;
  el.classList.add('focused');
  if (scroll) {
    el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
}

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
}

function moveFocus(dir) {
  const list = focusables();
  if (!list.length) return;
  if (!state.focus || !list.includes(state.focus)) return setFocus(dir === 'left' ? list[list.length - 1] : list[0]);

  const cur = centerOf(state.focus);
  let best = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === state.focus) continue;
    const c = centerOf(el);
    const dx = c.x - cur.x;
    const dy = c.y - cur.y;
    let primary;
    let secondary;
    if (dir === 'left') { if (dx > -4) continue; primary = -dx; secondary = Math.abs(dy); }
    else if (dir === 'right') { if (dx < 4) continue; primary = dx; secondary = Math.abs(dy); }
    else if (dir === 'up') { if (dy > -4) continue; primary = -dy; secondary = Math.abs(dx); }
    else { if (dy < 4) continue; primary = dy; secondary = Math.abs(dx); }
    const overlapping = secondary < Math.min(cur.r.height, c.r.height) * 0.6 ? 0.4 : 1;
    const score = primary + secondary * 1.9 * overlapping;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) setFocus(best);
}

/* ---------------- routing ---------------- */

function go(route) {
  state.route = route;
  paintNav();
  if (playerActive()) return;
  render();
}

function paintNav() {
  const name = state.route.name;
  const map = { home: 'home', browse: 'browse', search: 'search', library: 'library', addons: 'addons', settings: 'settings', detail: 'home', player: 'home' };
  nav.querySelectorAll('[data-nav]').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === map[name]);
  });
}

async function render() {
  const { name } = state.route;
  try {
    if (name === 'home') await renderHome();
    else if (name === 'browse') await renderBrowse();
    else if (name === 'search') await renderSearch();
    else if (name === 'library') await renderLibrary();
    else if (name === 'detail') await renderDetail(state.route.id, state.route.type);
    else if (name === 'addons') await renderAddons();
    else if (name === 'settings') await renderSettings();
    else await renderHome();
  } catch (err) {
    view.innerHTML = `<div class="page"><div class="empty">${esc(err.message)}</div></div>`;
  } finally {
    status(null);
  }
  const first = focusables()[0];
  if (first) setFocus(first, { scroll: false });
}

/* ---------------- home ---------------- */

async function renderHome() {
  view.innerHTML = `<div class="page"><div class="empty">Loading…</div></div>`;
  const home = await cached('home', () => api('/api/home'));
  const cont = store.continueWatching();
  const recGenres = tasteGenres();
  const [rec, suggest] = await Promise.all([
    recGenres.length ? cached(`rec:${recGenres.join(',')}`, () => api(`/api/recommend?genres=${recGenres.join(',')}&exclude=${store.history().slice(0, 6).map((h) => h.id).join(',')}`)).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    cached('suggest:home', () => api('/api/suggest', { method: 'POST', body: JSON.stringify({ mood: '', genres: recGenres }) })).catch(() => ({ items: [] })),
  ]);

  const rows = [];
  if (cont.length) rows.push({ title: 'Continue watching', items: cont, progress: true });
  if (rec.items?.length) rows.push({ title: recGenres.length ? `Because you watch ${genreName(recGenres[0])}` : 'Picked for tonight', items: rec.items });
  if (suggest.items?.length) rows.push({ title: suggest.source === 'ai' ? `AI pick — ${suggest.reason}` : 'Suggested tonight', items: suggest.items.slice(0, 18) });
  for (const row of home.rows) rows.push(row);

  const hero = home.hero;
  view.innerHTML = `<div class="page" style="padding:0;display:flex;flex-direction:column">
    ${hero ? `<div class="hero" data-focus data-item="${esc(hero.id)}" tabindex="0" style="background-image:url('${esc(hero.poster)}')">
      <div class="hero-inner">
        <div class="hero-kicker">TRENDING THIS WEEK</div>
        <div class="hero-title">${esc(hero.title)}</div>
        <div class="hero-meta">${hero.year || ''} ${hero.genres?.length ? '· ' + esc(hero.genres.slice(0, 3).join(' · ')) : ''} ${hero.rights ? '· ' + esc(hero.rights) : ''}</div>
        <div class="hero-desc">${esc(hero.description || '')}</div>
      </div>
    </div>` : ''}
    <div class="rows">
      ${rows.map((row, i) => `<div class="row" data-row="${i}">
        <div class="row-head"><div class="row-title">${esc(row.title)}</div>${row.genre ? `<div class="row-more">all ${esc(genreName(row.genre))} →</div>` : ''}</div>
        <div class="row-track">${row.items.map((item) => card(item, { progress: row.progress ? item.position : 0 })).join('')}</div>
      </div>`).join('')}
      <div class="row"><div class="row-head"><div class="row-title">Browse</div></div>
        <div class="chips">${home.genres.map((g) => `<button class="chip" data-focus data-genre="${esc(g.id)}">${esc(g.name)}</button>`).join('')}</div>
      </div>
    </div>
  </div>`;
  decorateHeroActions();
}

function decorateHeroActions() {
  // hero is clickable as a whole; explicit buttons are added on the detail screen
}

function genreName(id) {
  const names = { noir: 'noir', horror: 'horror', scifi: 'sci-fi', comedy: 'comedy', drama: 'drama', crime: 'crime', mystery: 'mystery', thriller: 'thrillers', western: 'westerns', romance: 'romance', adventure: 'adventure', animation: 'animation', war: 'war', 'scifi-horror': 'cult films' };
  return names[id] || id;
}

function tasteGenres() {
  const counts = new Map();
  const bump = (g) => counts.set(g, (counts.get(g) || 0) + 1);
  for (const h of store.history().slice(0, 12)) {
    for (const g of h.genres || []) {
      const id = genreIdOf(g);
      if (id) bump(id);
    }
  }
  for (const w of store.watchlist().slice(0, 12)) for (const g of w.genres || []) {
    const id = genreIdOf(g);
    if (id) bump(id);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
}

function genreIdOf(subject) {
  const s = String(subject || '').toLowerCase();
  if (/noir/.test(s)) return 'noir';
  if (/horror/.test(s)) return 'horror';
  if (/science fiction|sci-fi/.test(s)) return 'scifi';
  if (/comedy/.test(s)) return 'comedy';
  if (/drama/.test(s)) return 'drama';
  if (/crime/.test(s)) return 'crime';
  if (/mystery/.test(s)) return 'mystery';
  if (/thriller|suspense/.test(s)) return 'thriller';
  if (/western/.test(s)) return 'western';
  if (/romance/.test(s)) return 'romance';
  if (/adventure/.test(s)) return 'adventure';
  if (/animation|animated/.test(s)) return 'animation';
  if (/war/.test(s)) return 'war';
  return null;
}

/* ---------------- browse ---------------- */

async function renderBrowse() {
  const { genres, decades } = await cached('genres', () => api('/api/genres'));
  const b = state.browse;
  const param = b.kind === 'decade' ? `decade=${b.id}` : `genre=${b.id}`;
  status('Loading catalogue…');
  const data = await cached(`browse:${param}:${b.page}`, () => api(`/api/browse?${param}&page=${b.page}`));
  status(null);
  state.browse.items = data.items || [];

  view.innerHTML = `<div class="page">
    <div class="page-head"><h1 class="page-title">Browse</h1><div class="page-sub">${esc(data.title || '')}</div></div>
    <div class="chips">
      ${genres.map((g) => `<button class="chip ${b.kind === 'genre' && b.id === g.id ? 'active' : ''}" data-focus data-genre="${esc(g.id)}">${esc(g.name)}</button>`).join('')}
      ${decades.map((d) => `<button class="chip ${b.kind === 'decade' && b.id === d.id ? 'active' : ''}" data-focus data-decade="${esc(d.id)}">${esc(d.name)}</button>`).join('')}
    </div>
    <div class="grid">
      ${(data.items || []).map((item) => card(item)).join('')}
      ${data.hasMore ? `<button class="chip" data-focus data-more="1">Load more</button>` : ''}
    </div>
  </div>`;
}

/* ---------------- search ---------------- */

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ' '];

async function renderSearch() {
  const q = state.query;
  let results = [];
  if (q.trim().length >= 2) {
    status('Searching…');
    results = (await cached(`search:${q}`, () => api(`/api/search?q=${encodeURIComponent(q)}`, {}), 60000)).items || [];
    status(null);
  }
  view.innerHTML = `<div class="page">
    <div class="page-head"><h1 class="page-title">Search</h1></div>
    <div class="search-box" data-focus tabindex="0" id="searchBox"><span>${esc(q) || '<span style="color:#7c7c92">type a title</span>'}</span><span class="caret"></span></div>
    <div class="keyboard">
      ${KEYS.map((k) => `<button class="key ${k === ' ' ? 'wide' : ''}" data-focus data-key="${esc(k)}">${k === ' ' ? 'space' : esc(k)}</button>`).join('')}
      <button class="key wide" data-focus data-key="__del">⌫</button>
      <button class="key wide" data-focus data-key="__clear">clear</button>
    </div>
    ${results.length ? `<div class="grid">${results.map((item) => card(item)).join('')}</div>` : q.length >= 2 ? '<div class="empty">No films matched.</div>' : ''}
  </div>`;
}

/* ---------------- library ---------------- */

async function renderLibrary() {
  const tab = state.libraryTab;
  const history = store.history();
  const list = store.watchlist();
  let items = [];
  if (tab === 'continue') items = store.continueWatching();
  else if (tab === 'list') items = list;
  else {
    const genres = tasteGenres();
    const data = genres.length
      ? await cached(`rec:lib:${genres.join(',')}`, () => api(`/api/recommend?genres=${genres.join(',')}`)).catch(() => ({ items: [] }))
      : { items: (await cached('home', () => api('/api/home'))).rows[0]?.items || [] };
    items = data.items || [];
  }

  view.innerHTML = `<div class="page">
    <div class="page-head"><h1 class="page-title">Library</h1><div class="page-sub">${history.length} watched · ${list.length} saved</div></div>
    <div class="lib-tabs">
      ${[['continue', 'Continue watching'], ['list', 'Watchlist'], ['for-you', 'For you']].map(([id, label]) => `<button class="chip ${tab === id ? 'active' : ''}" data-focus data-tab="${id}">${label}</button>`).join('')}
    </div>
    ${items.length ? `<div class="grid">${items.map((item) => card(item, { progress: item.position || 0 })).join('')}</div>` : `<div class="empty">${tab === 'continue' ? 'Nothing in progress. Play something.' : tab === 'list' ? 'Watchlist is empty — press + on a film.' : 'Watch a few films and suggestions will appear here.'}</div>`}
  </div>`;
}

/* ---------------- detail ---------------- */

async function renderDetail(id, type = 'movie') {
  status('Loading film…');
  const item = await cached(`item:${type}:${id}`, () => api(`/api/item/${encodeURIComponent(id)}?type=${encodeURIComponent(type)}`), 300000);
  status(null);
  const saved = store.historyGet(id);
  const inList = store.inList(id);
  const resume = saved && saved.position > 20 ? saved.position : 0;

  view.innerHTML = `<div class="detail">
    <div><div class="detail-poster" style="background-image:url('${esc(item.poster)}')"></div></div>
    <div>
      <h1>${esc(item.title)}${item.year ? ` <span style="color:#9a9aae;font-size:1.2rem">(${item.year})</span>` : ''}</h1>
      <div class="detail-meta">${esc(item.runtime || '')} ${item.rights ? '· ' + esc(item.rights) : ''} ${item.stream?.quality ? '· ' + esc(item.stream.quality) : ''}</div>
      <div class="detail-tags">${(item.genres || []).slice(0, 6).map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div>
      <div class="detail-desc">${esc(item.description || '')}</div>
      <div class="detail-actions">
        <button class="btn primary" data-focus data-play="${esc(item.id)}">${resume ? `Resume ${Math.floor(resume / 60)}m` : 'Play'}</button>
        <button class="btn" data-focus data-list="${esc(item.id)}">${inList ? '✓ In watchlist' : '+ Watchlist'}</button>
        <button class="btn" data-focus data-startsync="${esc(item.id)}">Sync subtitles</button>
      </div>
      ${item.streams?.length ? `<div style="color:#9a9aae;font-size:.9rem;margin-top:.6rem">Streams from installed addons</div>
        <div class="sub-list">${item.streams.map((s, i) => `<div class="sub-row" data-focus data-stream="${i}" tabindex="0"><span>${esc(s.addon || '')} ${esc(s.name || '')} ${esc(s.title || '')}</span><span class="ok">▶</span></div>`).join('')}</div>`
      : '<div class="empty" style="padding:1rem 0">No streams. Add a stream addon (Comet/AIOStreams) in Addons.</div>'}
      ${item.subtitles?.length ? `<div style="color:#9a9aae;font-size:.9rem;margin-top:.6rem">Subtitle tracks — press to set the default</div>
        <div class="sub-list">${item.subtitles.slice(0, 30).map((s, i) => `<div class="sub-row" data-focus data-sub="${esc(s.file)}" tabindex="0"><span>${esc(s.label)}</span><span class="ok">${i === 0 ? 'default' : ''}</span></div>`).join('')}</div>`
      : '<div class="empty" style="padding:1rem 0">No subtitle track on this item.</div>'}
    </div>
  </div>`;
  view.dataset.item = id;
  view.dataset.itemJson = JSON.stringify(item);
}

/* ---------------- addons ---------------- */

async function renderAddons() {
  const addons = store.addons();
  view.innerHTML = `<div class="page">
    <div class="page-head"><h1 class="page-title">Addons</h1><div class="page-sub">Stremio addons are HTTP services — the player can read their catalogs, meta and streams.</div></div>
    <div class="search-box" data-focus tabindex="0" id="addonUrl"><span>${esc(state.addonUrl) || '<span style="color:#7c7c92">manifest.json URL</span>'}</span><span class="caret"></span></div>
    <div class="keyboard">
      ${'abcdefghijklmnopqrstuvwxyz0123456789'.split('').map((k) => `<button class="key" data-focus data-akey="${k}">${state.addonShift ? k.toUpperCase() : k}</button>`).join('')}
      ${[':', '/', '.', '-', '_', '?', '=', '&', '%', '+', '@', '#'].map((k) => `<button class="key wide" data-focus data-akey="${esc(k)}">${esc(k)}</button>`).join('')}
      <button class="key wide" data-focus data-akey="__shift">${state.addonShift ? 'ABC' : 'abc'}</button>
      <button class="key" data-focus data-akey="__del">⌫</button>
      <button class="key wide" data-focus data-akey="__add">Add</button>
    </div>
    ${addons.length ? addons.map((a) => `<div class="addon-row" data-focus data-addon="${esc(a.url)}" tabindex="0">
      <div style="flex:1"><div class="addon-name">${esc(a.name)}</div><div class="addon-url">${esc(a.url)}</div></div>
      <div style="color:#9a9aae;font-size:.8rem">${esc((a.types || []).join(', '))}</div>
    </div>`).join('') : '<div class="empty">No addons yet. Paste a manifest URL above and press Add.</div>'}
  </div>`;
}

/* ---------------- settings ---------------- */

const SERVER_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').concat([':', '/', '.', '-', '_']);

async function renderSettings() {
  const addons = store.addons();
  const p = prefs.all;
  view.innerHTML = `<div class="page">
    <div class="page-head"><h1 class="page-title">Settings</h1><div class="page-sub">${addons.length} addon${addons.length === 1 ? '' : 's'} · on-device player</div></div>
    <div class="chips">
      <button class="chip" data-focus data-nav="addons">Manage addons</button>
      <button class="chip" data-focus data-setting="subSize">Subtitles: ${esc(p.subSize)}</button>
      <button class="chip" data-focus data-setting="subBg">Subtitle box: ${p.subBg ? 'on' : 'off'}</button>
      <button class="chip" data-focus data-setting="subRaise">Position: ${p.subRaise ? 'high' : 'normal'}</button>
      <button class="chip" data-focus data-setting="test">Test addons</button>
      <button class="chip" data-focus data-setting="reset">Clear local data</button>
    </div>
  </div>`;
}

async function applySetting(which) {
  if (which === 'server') {
    state.editServer = apiBase() || 'http://';
    return renderSettings();
  }
  if (which === 'subSize') {
    const order = ['small', 'normal', 'large'];
    const next = order[(order.indexOf(prefs.get('subSize')) + 1) % order.length];
    prefs.set({ subSize: next });
    toast(`Subtitles ${next}`);
    return renderSettings();
  }
  if (which === 'subBg') {
    prefs.set({ subBg: !prefs.get('subBg') });
    return renderSettings();
  }
  if (which === 'subRaise') {
    prefs.set({ subRaise: !prefs.get('subRaise') });
    return renderSettings();
  }
  if (which === 'test') {
    status('Testing addons…');
    try {
      const home = await api('/api/home');
      toast(`OK — ${home.rows?.length || 0} rows from addons`);
    } catch (err) {
      toast(`Failed: ${err.message}`);
    } finally {
      status(null);
      renderSettings();
    }
    return;
  }
  if (which === 'reset') {
    try {
      localStorage.removeItem('kc.tv.v1.history');
      localStorage.removeItem('kc.tv.v1.list');
      localStorage.removeItem('kc.tv.v1.offsets');
      localStorage.removeItem('kc.tv.v1.lastSub');
    } catch {}
    toast('Library data cleared');
    return renderSettings();
  }
}

async function applyServerKey(k) {
  if (k === '__del') state.editServer = (state.editServer || '').slice(0, -1);
  else if (k === '__cancel') state.editServer = null;
  else if (k === '__save') {
    const value = String(state.editServer || '').trim();
    setApiBase(value);
    state.editServer = null;
    state.cache.clear();
    toast('Server saved');
    return renderSettings();
  } else state.editServer = ((state.editServer || '') + k).slice(0, 200);
  return renderSettings();
}

/* ---------------- activation ---------------- */

function activate(el) {
  if (!el) return;

  if (el.dataset.nav) return go({ name: el.dataset.nav });
  if (el.dataset.genre) { state.browse = { kind: 'genre', id: el.dataset.genre, page: 0, items: [] }; return go({ name: 'browse' }); }
  if (el.dataset.decade) { state.browse = { kind: 'decade', id: el.dataset.decade, page: 0, items: [] }; return go({ name: 'browse' }); }
  if (el.dataset.more) { state.browse.page += 1; state.cache.delete(`browse:${state.browse.kind === 'decade' ? 'decade' : 'genre'}=${state.browse.id}:${state.browse.page}`); return render(); }
  if (el.dataset.item) return go({ name: 'detail', id: el.dataset.item, type: el.dataset.type || 'movie' });
  if (el.dataset.tab) { state.libraryTab = el.dataset.tab; return render(); }
  if (el.dataset.setting) return applySetting(el.dataset.setting);
  if (el.dataset.skey) return applyServerKey(el.dataset.skey);

  if (el.dataset.stream !== undefined) {
    const item = JSON.parse(view.dataset.itemJson || '{}');
    const stream = item.streams?.[Number(el.dataset.stream)];
    if (!stream) return toast('Stream unavailable');
    if (!stream.url) return toast(stream.externalUrl ? 'External link only' : 'This stream needs a torrent server');
    item.stream = stream;
    return playItem(item);
  }
  if (el.dataset.play) {
    const item = JSON.parse(view.dataset.itemJson || '{}');
    if (!item.stream?.url) return toast('No direct stream. Add a stream addon or pick a stream below.');
    return playItem(item);
  }
  if (el.dataset.list) {
    const item = JSON.parse(view.dataset.itemJson || '{}');
    const added = store.toggleList(item);
    toast(added ? 'Added to watchlist' : 'Removed from watchlist');
    return render();
  }
  if (el.dataset.startsync) {
    const item = JSON.parse(view.dataset.itemJson || '{}');
    state.cache.delete('startSync');
    return playItem(item, { openSync: true });
  }
  if (el.dataset.sub) {
    const item = JSON.parse(view.dataset.itemJson || '{}');
    store.setLastSub(item.id, el.dataset.sub);
    toast('Default subtitle set');
    return;
  }

  if (el.dataset.key) {
    const k = el.dataset.key;
    if (k === '__del') state.query = state.query.slice(0, -1);
    else if (k === '__clear') state.query = '';
    else state.query = (state.query + k).slice(0, 40);
    return renderSearch().then(() => focusSearchEnd());
  }

  if (el.dataset.akey) {
    const k = el.dataset.akey;
    if (k === '__del') state.addonUrl = state.addonUrl.slice(0, -1);
    else if (k === '__shift') state.addonShift = !state.addonShift;
    else if (k === '__add') return addAddon();
    else {
      const value = /^[a-z]$/.test(k) && state.addonShift ? k.toUpperCase() : k;
      state.addonUrl = (state.addonUrl + value).slice(0, 400);
    }
    return renderAddons();
  }

  if (el.dataset.addon) {
    // reserved: open the addon's catalog list
    toast('Addon installed. Catalog rows coming next.');
    return;
  }
}

async function playItem(item, { openSync = false } = {}) {
  await openPlayer(item);
  if (openSync) {
    document.dispatchEvent(new CustomEvent('tv:opensync'));
  }
}

async function addAddon() {
  const url = state.addonUrl.trim();
  if (!url) return;
  status('Reading manifest…');
  try {
    const data = await api(`/api/addon?url=${encodeURIComponent(url)}`);
    store.addAddon(data.url, data.manifest);
    state.addonUrl = '';
    toast(`Added ${data.manifest.name}`);
  } catch (err) {
    toast(`Addon: ${err.message}`);
  } finally {
    status(null);
    renderAddons();
  }
}

function focusSearchEnd() {
  const list = focusables();
  if (list.length) setFocus(list[0]);
}

/* ---------------- events ---------------- */

function wireEvents() {
  nav.querySelectorAll('[data-nav]').forEach((b) => {
    b.addEventListener('click', () => go({ name: b.dataset.nav }));
    b.addEventListener('pointerenter', () => setFocus(b));
  });

  view.addEventListener('pointerover', (e) => {
    const el = e.target.closest('[data-focus]');
    if (el) setFocus(el, { scroll: false });
  });

  view.addEventListener('click', (e) => {
    const el = e.target.closest('[data-focus]');
    if (el) activate(el);
  });

  document.addEventListener('keydown', (e) => {
    if (playerActive()) {
      if (handlePlayerKey(e)) {
        e.stopPropagation();
        return;
      }
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveFocus('left'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveFocus('right'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus('up'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus('down'); }
    else if (e.key === 'Enter' || e.keyCode === 13) {
      if (document.activeElement && document.activeElement.matches('[data-focus]')) {
        e.preventDefault();
        activate(document.activeElement);
      } else if (state.focus) {
        e.preventDefault();
        activate(state.focus);
      }
    } else if (e.key === 'Escape' || e.keyCode === 461 || e.keyCode === 10009) {
      if (state.route.name !== 'home') go({ name: 'home' });
    }
  });

  // Samsung hardware Back. Dispatch the same Escape path the player/editor
  // already handles, then exit only when Back is pressed on the home screen.
  document.addEventListener('tizenhwkey', (event) => {
    if (event.keyName !== 'back') return;
    const wasHome = !playerActive() && state.route.name === 'home';
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(ev, 'keyCode', { get: () => 10009 });
    document.dispatchEvent(ev);
    if (wasHome) {
      try {
        window.tizen.application.getCurrentApplication().exit();
      } catch (error) {
        /* browser */
      }
    }
  });

  document.addEventListener('tv:playerclosed', () => { paintNav(); render(); });
  document.addEventListener('tv:opensync', () => { document.querySelector('#puActions [data-act="sync"]')?.click(); });

  setInterval(() => {
    const d = new Date();
    clock.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, 15000);
  clock.textContent = new Date().toTimeString().slice(0, 5);
}

// ?server=http://ip:port lets a packaged TV app be pointed without typing.
const bootParams = new URLSearchParams(location.search);
if (bootParams.get('server')) setApiBase(bootParams.get('server'));

setApiAdapter(handleApi);
wireEvents();
go({ name: 'home' });

export { go, toast };
