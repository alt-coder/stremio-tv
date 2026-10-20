import { api, store, prefs, fmtTime, fmtOffset } from './store.js';

/**
 * Player + subtitle overlay + the visual sync editor.
 *
 * The player paints subtitles itself instead of using <track>, because the
 * whole point is shifting cue timing live: offset is subtracted from
 * currentTime at lookup, so nudging it re-syncs instantly with no reload.
 */

const $ = (sel) => document.querySelector(sel);

/** tiny toast — shared element with app.js, so the player can talk to the user too */
function toast(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

let v, subsEl, uiEl, layerEl, titleEl, badgeEl, timeEl, durEl, fillEl, bufEl, actionsEl;
let syncEl, canvas, cueLane, rulerEl, offsetEl, modeEl, cueInfoEl, filmEl, winEl;

// Module scripts run after parsing, so the DOM is ready: wire everything now.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
else init();

const P = {
  item: null,
  streamUrl: null,
  cues: [],
  subFile: null,
  offset: 0,
  subsOn: true,
  cueIndex: -1,
  uiVisible: false,
  uiTimer: 0,
  focusIdx: 2,
  lastSave: 0,
  sync: {
    open: false,
    origOffset: 0,
    idx: 0,
    zoom: 30,
    fine: true,
    winStart: 0,
    winSeconds: 30,
    peaks: null,
    loading: false,
    cache: new Map(),
    previewTimer: 0,
    playing: false,
  },
};

export function playerActive() {
  const l = layerEl || document.getElementById('playerLayer');
  return l ? !l.classList.contains('hidden') : false;
}
export function syncActive() {
  return P.sync.open;
}

function init() {
  v = $('#video');
  subsEl = $('#subs');
  uiEl = $('#playerUI');
  layerEl = $('#playerLayer');
  titleEl = $('#puTitle');
  badgeEl = $('#puBadge');
  timeEl = $('#puTime');
  durEl = $('#puDur');
  fillEl = $('#puFill');
  bufEl = $('#puBuffer');
  actionsEl = $('#puActions');

  v.addEventListener('timeupdate', onTime);
  v.addEventListener('progress', onProgress);
  v.addEventListener('play', () => { setBadge(''); updatePlayButton(); armUi(); });
  v.addEventListener('pause', () => { updatePlayButton(); showUi(); });
  v.addEventListener('ended', () => { showUi(); setBadge('finished'); });

  actionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) action(btn.dataset.act);
  });
  actionsEl.addEventListener('focusin', (e) => {
    const btns = [...actionsEl.querySelectorAll('button')];
    P.focusIdx = Math.max(0, btns.indexOf(document.activeElement));
    paintActionFocus();
  });

  applySubStyle();
  initSync();
}

/* ---------------- player ---------------- */

export async function openPlayer(item, { startAt = 0 } = {}) {
  if (!layerEl) init();
  P.item = item;
  P.streamUrl = item?.stream?.url || item?.url || null;
  P.cueIndex = -1;
  P.subsOn = prefs.get('autoSubs') !== false;
  P.subFile = null;
  P.cues = [];
  renderSubs('');

  layerEl.classList.remove('hidden');
  layerEl.setAttribute('aria-hidden', 'false');
  titleEl.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
  setBadge(item.rights || '');
  subsEl.className = 'subs';

  const saved = store.historyGet(item.id);
  const at = startAt || (saved && saved.position > 20 ? saved.position : 0);
  v.src = item.stream.url;
  v.currentTime = at;
  store.historyAdd(item);

  showUi();
  armUi();
  // Autoplay can be refused (TV browsers, headless): never block the player on it.
  await Promise.race([
    v.play().catch(() => {}),
    new Promise((r) => setTimeout(r, 2500)),
  ]);

  const file = store.lastSub(item.id) || item.subtitles?.[0]?.file || null;
  if (file) loadSubtitle(file).catch((err) => setBadge(`subs: ${err.message}`));
}

export function closePlayer() {
  if (!v) return;
  try { v.pause(); } catch {}
  const t = v.currentTime;
  if (P.item && Number.isFinite(t)) store.historyProgress(P.item.id, t, v.duration || 0);
  v.removeAttribute('src');
  v.load();
  P.item = null;
  P.streamUrl = null;
  P.cues = [];
  layerEl.classList.add('hidden');
  layerEl.setAttribute('aria-hidden', 'true');
}

async function loadSubtitle(file) {
  let data;
  if (/^https?:\/\//i.test(file)) {
    data = await api(`/api/subtitles?url=${encodeURIComponent(file)}`);
  } else if (P.item?.id) {
    data = await api(`/api/subtitles/${encodeURIComponent(P.item.id)}?file=${encodeURIComponent(file)}`);
  } else {
    data = await api(`/api/subtitles?url=${encodeURIComponent(file)}`);
  }
  P.cues = data.cues || [];
  P.subFile = file;
  const keyId = P.item?.id || P.streamUrl || 'stream';
  P.offset = store.offsetFor(keyId, file);
  P.cueIndex = -1;
  if (P.item?.id) store.setLastSub(P.item.id, file);
  onTime();
  setBadge(`${P.cues.length} cues · ${fmtOffset(P.offset)}`);
}

function subIndexAt(time) {
  const cues = P.cues;
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time < cues[mid].start) hi = mid - 1;
    else if (time >= cues[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

function onTime() {
  if (!v || !P.item) return;
  timeEl.textContent = fmtTime(v.currentTime);
  durEl.textContent = fmtTime(v.duration || 0);
  const pct = v.duration ? (v.currentTime / v.duration) * 100 : 0;
  fillEl.style.width = `${pct}%`;

  if (!P.subsOn || !P.cues.length) {
    if (P.cueIndex !== -1) { P.cueIndex = -1; renderSubs(''); }
  } else {
    const idx = subIndexAt(v.currentTime - P.offset);
    if (idx !== P.cueIndex) {
      P.cueIndex = idx;
      renderSubs(idx >= 0 ? P.cues[idx].text : '');
    }
  }

  const now = Date.now();
  if (now - P.lastSave > 5000) {
    P.lastSave = now;
    if (v.duration) store.historyProgress(P.item.id, v.currentTime, v.duration);
  }
}

function onProgress() {
  if (!bufEl || !v.buffered.length || !v.duration) return;
  const end = v.buffered.end(v.buffered.length - 1);
  bufEl.style.width = `${Math.min(100, (end / v.duration) * 100)}%`;
}

function renderSubs(text) {
  subsEl.textContent = text || '';
  const p = prefs.all;
  subsEl.className = ['subs', p.subSize === 'large' ? 'large' : '', p.subSize === 'small' ? 'small' : '', p.subRaise ? 'raised' : '', p.subBg ? 'bg' : '']
    .filter(Boolean).join(' ');
}

function applySubStyle() {
  renderSubs(subsEl ? subsEl.textContent : '');
}

function setBadge(text) {
  badgeEl.textContent = text || '';
}

function seek(delta) {
  if (!v.duration) return;
  v.currentTime = Math.min(v.duration - 0.3, Math.max(0, v.currentTime + delta));
  onTime();
  armUi();
}

function togglePlay() {
  if (v.paused) v.play().catch(() => {}); else v.pause();
  updatePlayButton();
}

function updatePlayButton() {
  const btn = actionsEl?.querySelector('[data-act="play"]');
  if (btn) btn.textContent = v.paused ? 'Play' : 'Pause';
}

function showUi() {
  uiEl.classList.add('show');
  P.uiVisible = true;
  paintActionFocus();
}
function hideUi() {
  uiEl.classList.remove('show');
  P.uiVisible = false;
  actionsEl.querySelectorAll('button').forEach((b) => b.classList.remove('focused'));
  if (document.activeElement && actionsEl.contains(document.activeElement)) document.activeElement.blur();
}
function armUi() {
  clearTimeout(P.uiTimer);
  P.uiTimer = setTimeout(() => { if (!v.paused) hideUi(); }, 4200);
}

function paintActionFocus() {
  const btns = [...actionsEl.querySelectorAll('button')];
  btns.forEach((b, i) => b.classList.toggle('focused', i === P.focusIdx));
  if (P.uiVisible && btns[P.focusIdx]) btns[P.focusIdx].focus({ preventScroll: true });
}

function action(name) {
  switch (name) {
    case 'back': closePlayer(); document.dispatchEvent(new CustomEvent('tv:playerclosed')); break;
    case 'rw': seek(-10); break;
    case 'ff': seek(10); break;
    case 'play': togglePlay(); break;
    case 'subs': toggleSubs(); break;
    case 'sync': openSync(); break;
    default: break;
  }
}

function toggleSubs() {
  P.subsOn = !P.subsOn;
  if (!P.subsOn) renderSubs('');
  else onTime();
  setBadge(P.subsOn ? 'subtitles on' : 'subtitles off');
  armUi();
}

/* ---------------- sync editor ---------------- */

function initSync() {
  syncEl = $('#syncLayer');
  canvas = $('#waveCanvas');
  cueLane = $('#cueLane');
  rulerEl = $('#ruler');
  offsetEl = $('#syncOffset');
  modeEl = $('#syncMode');
  cueInfoEl = $('#syncCue');
  filmEl = $('#syncFilm');
  winEl = $('#syncWin');

  cueLane.addEventListener('pointerdown', onCuePointerDown);
  window.addEventListener('resize', () => { if (P.sync.open) drawWave(); });
  const prevBtn = document.getElementById('syncPrevChunk');
  const nextBtn = document.getElementById('syncNextChunk');
  if (prevBtn) prevBtn.addEventListener('click', () => chunkStep(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => chunkStep(1));
}

export async function openSync() {
  if (!P.streamUrl && !P.item) return;
  if (!P.subFile || !P.cues.length) {
    toast('No subtitle track loaded for this film');
    return;
  }
  P.sync.open = true;
  P.sync.origOffset = P.offset;
  P.sync.idx = Math.max(0, subIndexAt(v.currentTime - P.offset));
  P.sync.zoom = 30;
  P.sync.fine = true;
  v.pause();
  hideUi();
  syncEl.classList.remove('hidden');
  syncEl.setAttribute('aria-hidden', 'false');
  filmEl.textContent = `${P.item?.title || P.streamUrl || 'Stream'} — ${P.subFile}`;
  await focusCue(P.sync.idx, { center: true });
  updateOffsetLabel();
}

export function closeSync({ save = false } = {}) {
  if (!P.sync.open) return;
  if (!save) P.offset = P.sync.origOffset;
  const keyId = P.item?.id || P.streamUrl || 'stream';
  if (save) store.setOffset(keyId, P.subFile, P.offset);
  clearTimeout(P.sync.previewTimer);
  P.sync.open = false;
  P.sync.playing = false;
  syncEl.classList.add('hidden');
  syncEl.setAttribute('aria-hidden', 'true');
  P.cueIndex = -1;
  onTime();
  showUi();
  armUi();
  if (save) toast(`Saved ${fmtOffset(P.offset)}`);
}

function updateOffsetLabel() {
  offsetEl.textContent = fmtOffset(P.offset);
  modeEl.textContent = P.sync.fine ? 'fine 0.05s' : 'coarse 0.50s';
}

function chunkStep(dir) {
  if (!P.sync.open) return;
  P.sync.winStart = Math.max(0, P.sync.winStart + dir * P.sync.winSeconds);
  loadWave().then(renderSync);
  toast(dir > 0 ? 'Next chunk' : 'Previous chunk');
}

async function focusCue(idx, { center = false } = {}) {
  if (!P.cues.length) return;
  P.sync.idx = Math.max(0, Math.min(P.cues.length - 1, idx));
  const cue = P.cues[P.sync.idx];
  const cueStart = cue.start + P.offset;

  const margin = 2;
  const left = P.sync.winStart;
  const right = P.sync.winStart + P.sync.winSeconds;
  if (center || cueStart < left + margin || cueStart > right - margin) {
    P.sync.winStart = Math.max(0, cueStart - P.sync.winSeconds * 0.35);
  }
  await loadWave();
  renderSync();
}

async function loadWave() {
  const start = Math.max(0, Math.floor(P.sync.winStart));
  const seconds = Math.ceil(P.sync.winSeconds);
  const key = `${start}:${seconds}`;
  const cached = P.sync.cache.get(key);
  if (cached) {
    P.sync.peaks = cached;
    drawWave();
    return;
  }
  P.sync.loading = true;
  try {
    const idOrUrl = P.item?.id;
    const url = P.streamUrl;
    const path = idOrUrl
      ? `/api/waveform/${encodeURIComponent(idOrUrl)}?start=${start}&seconds=${seconds}&rate=20`
      : `/api/waveform?url=${encodeURIComponent(url)}&start=${start}&seconds=${seconds}&rate=20`;
    const data = await api(path);
    const peaks = base64ToBytes(data.peaks);
    const payload = { start: data.start, seconds: data.seconds, rate: data.rate, peaks };
    P.sync.cache.set(key, payload);
    // Only paint if the window is still the one we asked for.
    if (Math.abs(P.sync.winStart - start) < 2) {
      P.sync.peaks = payload;
      drawWave();
    }
  } catch (err) {
    toast(`Waveform: ${err.message}`);
  } finally {
    P.sync.loading = false;
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function drawWave() {
  if (!canvas || !P.sync.open) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 176;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    ctx.beginPath();
    ctx.moveTo((w * i) / 10, 0);
    ctx.lineTo((w * i) / 10, h);
    ctx.stroke();
  }

  const data = P.sync.peaks;
  if (!data || !data.peaks.length) {
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.font = '16px sans-serif';
    ctx.fillText(P.sync.loading ? 'loading waveform…' : 'no audio', 16, h / 2);
    return;
  }

  const mid = h / 2;
  const barW = Math.max(1, w / data.peaks.length);
  for (let i = 0; i < data.peaks.length; i++) {
    const t = data.start + i / data.rate;
    if (t < P.sync.winStart || t > P.sync.winStart + P.sync.winSeconds) continue;
    const x = ((t - P.sync.winStart) / P.sync.winSeconds) * w;
    const amp = (data.peaks[i] / 255) * (h * 0.46);
    ctx.fillStyle = amp > h * 0.2 ? '#9b7dff' : '#5d5a86';
    ctx.fillRect(x, mid - amp, barW, Math.max(1, amp * 2));
  }

  // playhead
  const px = ((v.currentTime - P.sync.winStart) / P.sync.winSeconds) * w;
  if (px >= 0 && px <= w) {
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(px - 1, 0, 2, h);
  }
}

function renderSync() {
  if (!P.sync.open) return;
  const { winStart, winSeconds } = P.sync;
  const winEnd = winStart + winSeconds;
  cueLane.innerHTML = '';

  P.cues.forEach((cue, i) => {
    const start = cue.start + P.offset;
    const end = cue.end + P.offset;
    if (end < winStart || start > winEnd) return;
    const el = document.createElement('div');
    el.className = `cue${i === P.sync.idx ? ' sel' : ''}`;
    el.style.left = `${Math.max(0, ((start - winStart) / winSeconds) * 100)}%`;
    el.style.width = `${Math.max(0.4, ((Math.min(end, winEnd) - Math.max(start, winStart)) / winSeconds) * 100)}%`;
    el.textContent = cue.text.split('\n')[0];
    el.dataset.idx = String(i);
    cueLane.appendChild(el);
  });

  const ph = document.createElement('div');
  ph.className = 'playhead';
  ph.style.left = `${((v.currentTime - winStart) / winSeconds) * 100}%`;
  cueLane.appendChild(ph);

  // ruler
  rulerEl.innerHTML = '';
  const step = winSeconds <= 15 ? 1 : winSeconds <= 40 ? 5 : 15;
  for (let t = Math.ceil(winStart / step) * step; t <= winEnd; t += step) {
    const pct = ((t - winStart) / winSeconds) * 100;
    const label = document.createElement('i');
    label.style.left = `${pct}%`;
    label.textContent = fmtTime(t);
    rulerEl.appendChild(label);
    const tick = document.createElement('b');
    tick.style.left = `${pct}%`;
    rulerEl.appendChild(tick);
  }

  winEl.textContent = `${fmtTime(winStart)} – ${fmtTime(winEnd)} · ${winSeconds}s window`;
  drawWave();
  updateCueInfo();
}

function updateCueInfo() {
  const cue = P.cues[P.sync.idx];
  if (!cue) { cueInfoEl.textContent = ''; return; }
  cueInfoEl.textContent = `#${P.sync.idx + 1}/${P.cues.length} · ${fmtTime(cue.start + P.offset)} · ${cue.text.replace(/\n/g, ' ').slice(0, 120)}`;
  updateOffsetLabel();
}

function nudge(delta) {
  P.offset = Math.round((P.offset + delta) * 1000) / 1000;
  const cue = P.cues[P.sync.idx];
  const cueStart = cue.start + P.offset;
  const margin = 1.2;
  if (cueStart < P.sync.winStart + margin) P.sync.winStart = Math.max(0, cueStart - P.sync.winSeconds * 0.25);
  if (cueStart > P.sync.winStart + P.sync.winSeconds - margin) P.sync.winStart = Math.max(0, cueStart - P.sync.winSeconds * 0.75);
  if (Math.abs(P.sync.winStart - (P.sync.peaks?.start ?? P.sync.winStart)) > 0.5) {
    loadWave().then(renderSync);
  }
  renderSync();
  P.offset = Math.max(-120, Math.min(120, P.offset));
}

function cycleZoom() {
  const levels = [10, 30, 60, 120];
  P.sync.zoom = levels[(levels.indexOf(P.sync.zoom) + 1) % levels.length];
  P.sync.winSeconds = P.sync.zoom;
  focusCue(P.sync.idx, { center: true });
}

async function previewCue() {
  const cue = P.cues[P.sync.idx];
  if (!cue) return;
  clearTimeout(P.sync.previewTimer);
  const startAt = Math.max(0, cue.start + P.offset - 2.5);
  const stopAt = cue.end + P.offset + 1.8;
  v.currentTime = startAt;
  try { await v.play(); } catch {}
  const tick = () => {
    if (!P.sync.open) return;
    drawWave();
    renderSync();
    if (v.currentTime >= stopAt) {
      v.pause();
      v.currentTime = Math.max(0, cue.start + P.offset - 1);
      P.sync.playing = false;
      drawWave();
      return;
    }
    P.sync.previewTimer = requestAnimationFrame(tick);
  };
  P.sync.playing = true;
  tick();
}

/* pointer drag on the cue lane */
function onCuePointerDown(e) {
  const cueEl = e.target.closest('.cue');
  if (cueEl) P.sync.idx = Number(cueEl.dataset.idx);
  const startX = e.clientX;
  const startOffset = P.offset;
  const width = cueLane.clientWidth || 1;
  const secPerPx = P.sync.winSeconds / width;
  v.pause();

  const move = (ev) => {
    P.offset = Math.round((startOffset + (ev.clientX - startX) * secPerPx) * 1000) / 1000;
    renderSync();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  renderSync();
}

/* ---------------- test surface (used by /tv/selftest.js) ---------------- */

export const __test = {
  state: P,
  openPlayer,
  closePlayer,
  openSync,
  closeSync,
  handlePlayerKey,
  nudge: (d) => nudge(d),
  focusCue,
  renderSync,
  subIndexAt,
  get video() { return v; },
  setCues(cues, file, offset = 0) {
    P.cues = cues;
    P.subFile = file;
    P.offset = offset;
    P.cueIndex = -1;
    onTime();
  },
  currentSubText() { return $('.subs') ? $('.subs').textContent : ''; },
  canvasHasSignal() {
    if (!canvas) return false;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4 * 37) {
      if (data[i] > 90 || data[i + 2] > 90) lit++;
    }
    return lit > 20;
  },
  cueBlocks() { return cueLane ? cueLane.querySelectorAll('.cue').length : 0; },
  offsetLabel() { return offsetEl ? offsetEl.textContent : ''; },
};


export function handlePlayerKey(e) {
  const code = e.keyCode;
  const key = e.key;

  if (P.sync.open) return handleSyncKey(e);

  // Back / Escape
  if (key === 'Escape' || code === 461 || code === 10009) {
    e.preventDefault();
    closePlayer();
    document.dispatchEvent(new CustomEvent('tv:playerclosed'));
    return true;
  }
  // Color keys open sync / toggle subs
  if (code === 403) { e.preventDefault(); openSync(); return true; }
  if (code === 404) { e.preventDefault(); toggleSubs(); return true; }

  if (key === 'Enter' || code === 13) {
    e.preventDefault();
    if (P.uiVisible && document.activeElement && actionsEl.contains(document.activeElement)) {
      action(document.activeElement.dataset.act);
    } else {
      togglePlay();
    }
    armUi();
    return true;
  }
  if (key === 'ArrowLeft') { e.preventDefault(); if (P.uiVisible) moveAction(-1); else seek(-10); return true; }
  if (key === 'ArrowRight') { e.preventDefault(); if (P.uiVisible) moveAction(1); else seek(10); return true; }
  if (key === 'ArrowUp') { e.preventDefault(); v.muted = false; v.volume = Math.min(1, v.volume + 0.1); showUi(); setBadge(`volume ${Math.round(v.volume * 100)}%`); armUi(); return true; }
  if (key === 'ArrowDown') { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); showUi(); setBadge(`volume ${Math.round(v.volume * 100)}%`); armUi(); return true; }

  if (key === 'c' || key === 'C') { e.preventDefault(); toggleSubs(); return true; }
  if (key === 's' || key === 'S') { e.preventDefault(); openSync(); return true; }
  if (key === ' ' || code === 179 || code === 10252 || code === 415) { e.preventDefault(); togglePlay(); armUi(); return true; }
  if (code === 19) { e.preventDefault(); v.pause(); return true; }
  return false;
}

function moveAction(delta) {
  const btns = [...actionsEl.querySelectorAll('button')];
  P.focusIdx = (P.focusIdx + delta + btns.length) % btns.length;
  paintActionFocus();
  armUi();
}

function handleSyncKey(e) {
  const key = e.key;
  const code = e.keyCode;

  if (key === 'Escape' || code === 461 || code === 10009) {
    e.preventDefault();
    closeSync({ save: false });
    return true;
  }
  if (key === 'Enter' || code === 13) {
    e.preventDefault();
    previewCue();
    return true;
  }
  if (key === 'ArrowLeft') { e.preventDefault(); nudge(P.sync.fine ? -0.05 : -0.5); return true; }
  if (key === 'ArrowRight') { e.preventDefault(); nudge(P.sync.fine ? 0.05 : 0.5); return true; }
  if (key === 'ArrowUp') { e.preventDefault(); focusCue(P.sync.idx - 1); return true; }
  if (key === 'ArrowDown') { e.preventDefault(); focusCue(P.sync.idx + 1); return true; }
  if (key === 'n' || key === 'N' || key === 'PageDown') { e.preventDefault(); chunkStep(1); return true; }
  if (key === 'p' || key === 'P' || key === 'PageUp') { e.preventDefault(); chunkStep(-1); return true; }

  // Samsung colour keys: red 403, green 404, yellow 405, blue 406
  if (code === 403) { e.preventDefault(); P.sync.fine = !P.sync.fine; updateOffsetLabel(); return true; }
  if (code === 404) { e.preventDefault(); cycleZoom(); return true; }
  if (code === 405) { e.preventDefault(); P.offset = 0; renderSync(); toast('Offset reset'); return true; }
  if (code === 406) { e.preventDefault(); closeSync({ save: true }); return true; }

  if (key === ' ' || code === 179 || code === 10252) { e.preventDefault(); previewCue(); return true; }
  return false;
}
