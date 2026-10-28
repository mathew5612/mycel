// Mycel is a free-form map: blocks with text, sticky notes, sub-maps inside blocks, links between blocks.

const $ = (q, root = document) => root.querySelector(q);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Block text: `this` is shown as code, for function and file names on the code level.
const fmt = value => esc(value).replace(/`([^`\n]+)`/g, '<code>$1</code>');
const COLORS = ['', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const COLOR_NAMES = { '': 'No colour', gray: 'Grey', red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' };
const SIZE = { block: { w: 220, h: 110 }, note: { w: 160, h: 120 } };
// The lower limit lets "Show all" fit even a large map that an agent built from a project.
const ZOOM = { min: 0.1, max: 2.5 };
// Sub-map geometry; src/layout.mjs repeats it for automatic placement on the server.
const PAD = 12;                       // inner padding of a sub-map
const EDGE = 1;                       // block border: the sub-map field is measured inside it
const HEAD = { base: 36, text: 39 };  // container header height: the title line, plus two lines of text
const FOLDED = { w: 280, h: 30 };     // collapsed sub-map: width at most this, height for the "N blocks inside" label
const ROOM = { w: 520, h: 300 };      // the field a block gets at once when a sub-map appears in it
const SPOT = 24;                      // gap of a new node from the field edge and from its neighbours
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
const clip = (a, b) => { const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y); return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y }; };

const icons = {
  download: '<path d="M12 4v11m-5-5 5 5 5-5M5 19h14"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  swap: '<path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>'
};
// Abstraction levels come from nesting: concept is the main map, mechanics the sub-maps of its blocks, technical the
// sub-maps of mechanics, code deeper.
const LEVELS = ['Concept', 'Mechanics', 'Technical', 'Code'];
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

// Browser storage: settings are shared by tabs (localStorage), a dive belongs to its tab and survives a reload
// (sessionStorage).
const storage = kind => ({
  get(key) { try { return window[kind].getItem(key); } catch { return null; } },
  set(key, value) { try { window[kind].setItem(key, value); } catch { /* private mode */ } },
  del(key) { try { window[kind].removeItem(key); } catch { /* private mode */ } }
});
const prefs = storage('localStorage'), tabPrefs = storage('sessionStorage');

// Interface language. English text is the source: t() looks it up in the Russian dictionary (RU, at the end of the
// file) when Russian is chosen, and a missing entry stays English. {name} in the text is replaced with values.name.
// A key may start with a context, "[project] Undo", when one English text needs two Russian ones; it is not shown.
const LANGS = ['en', 'ru'], LANG_NAMES = { en: 'English', ru: 'Russian' }, LANG_KEY = 'mycel.lang';
// A choice made with the switch wins; without it, Russian for a browser set to Russian, otherwise English.
function pickLang() {
  const saved = prefs.get(LANG_KEY);
  if (LANGS.includes(saved)) return saved;
  return /^ru(-|$)/i.test(navigator.languages?.[0] || navigator.language || '') ? 'ru' : 'en';
}
let lang = pickLang();
document.documentElement.lang = lang;
function t(text, values) {
  const s = lang === 'ru' && typeof RU[text] === 'string' ? RU[text] : text.replace(/^\[\w+\] /, '');
  return values ? s.replace(/\{(\w+)\}/g, (m, k) => k in values ? String(values[k]) : m) : s;
}
// A number with a word: English one/other; the Russian entry of the other form lists one, few and many.
function plural(n, one, other) {
  const forms = lang === 'ru' ? RU[other] : null, a = Math.abs(n) % 100, b = a % 10;
  return (Array.isArray(forms) ? forms[a > 10 && a < 20 ? 2 : b > 1 && b < 5 ? 1 : b === 1 ? 0 : 2] : n === 1 ? one : other).replace('{n}', n);
}
// Dates in the locale of the interface language: the browser's own variant of it (en-GB, ru-RU), if it has one.
const locale = () => [...(navigator.languages ?? []), navigator.language].find(l => l?.toLowerCase().split('-')[0] === lang) ?? lang;

const state = {
  graph: null, session: null, tab: 'map', view: null,
  selected: null,      // { type: 'node' | 'edge', id }
  editing: null,       // id of the node being edited
  fresh: new Map(),    // nodes created locally and not saved yet: id → { edgeId }
  connectFrom: null,   // "link" mode: id of the source block
  rebind: null,        // "move a link end" mode: { edgeId, end: 'source' | 'target' }
  hoverEdge: null,     // the link under the cursor: its handles and cross are shown
  pointer: { x: -1, y: -1 }, // last pointer position on screen
  gesture: null,       // the current drag
  menu: null,          // the open context menu
  agents: [],          // agents that have used the project: whether waiting, when last seen
  activity: [],        // what agents are doing now: { actor, text, progress, at }
  work: [],            // who works on which blocks: { actor, blocks, files, at }
  code: { stale: {}, risks: {} }, // outdated blocks (their files changed after the description) and risks from mycel health
  health: false,       // "Health" mode: the map shows what is wrong with blocks
  reviewHours: 24,     // how many hours the "What changed" summary in History covers
  access: { pending: [], devices: [], projects: [] }, // access requests of virtual machines and machines with access
  edit: null,          // the person's edits not finished yet: { since, at, count }
  focus: null, focusView: null, focusSince: null, // the module in focus, the map view before focus and when it began
  focusFolds: new Map(), // collapsing changed by dives: id → what it was before focus
  walking: 0,          // how many level moves are still running or queued
  level: 0,            // the level last chosen with the slider; a level move forgets it
  appeared: new Map(), // nodes and links that came over SSE: id → time of appearance, for the animation
  remarked: new Map(), // blocks whose mark changed over SSE: id → time, for the flash
  follow: false,       // following: the map fits itself to changes until the person moves the view
  followIds: null,     // nodes whose top blocks the map last fitted to, when the whole map would be under 40%
  online: true, busy: 0, pending: false, // busy is how many writes of the person are still running
  loading: false, wanted: 0 // a map request for SSE is already running; the revision to read up to
};
// The open screen: home or a project. gen grows on every move; answers that arrive after leaving are dropped.
const page = { gen: 0, kind: null, id: null, prefix: '', name: '', events: null, gone: false };
// Home: the list of projects, the request in flight and the rows that are appearing now.
// held means the list was not redrawn while the pointer was pressed.
const home = { projects: null, timer: 0, loading: false, again: false, held: false, appeared: new Map() };
// The answer arrived on another screen: the result is dropped silently.
class Stale extends Error {}
const node = id => state.graph.nodes.find(n => n.id === id);
const edgeOf = id => state.graph.edges.find(e => e.id === id);
const childrenOf = id => state.graph.nodes.filter(n => n.parentId === id);
const notesOf = id => state.graph.nodes.filter(n => n.type === 'note' && n.attachedTo === id);
const isNote = n => n?.type === 'note';
const isContainer = n => n && !isNote(n) && childrenOf(n.id).length > 0;
const blockEl = id => document.querySelector(`.block[data-id="${CSS.escape(id)}"]`);
// Title and text of a node; a container keeps them in its header.
const part = (el, cls) => el?.querySelector(`:scope > .${cls}, :scope > .head > .${cls}`);
// A short name: the title or the first line of the text, cut at a word with an ellipsis (as in src/model.mjs).
function shorten(line, max = 40) {
  if (line.length <= max) return line;
  const cut = line.slice(0, max), space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
const nodeName = n => n.title.trim() || shorten(n.text.trim().split('\n')[0]) || (isNote(n) ? t('empty note') : t('untitled'));
const date = value => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

function toast(message, options = {}) {
  const el = $('#toast'), gen = page.gen;
  el.innerHTML = `<span>${esc(message)}</span>${options.action ? `<button type="button" id="toast-action">${esc(options.action)}</button>` : ''}`;
  // The action belongs to the screen where the notification appeared: after a move the button does nothing.
  if (options.action) $('#toast-action').onclick = () => { el.className = ''; if (gen === page.gen) options.run(); };
  el.className = `visible${options.error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.className = '', options.action ? 7000 : options.error ? 5000 : 2500);
}
function hideToast() { clearTimeout(toast.timer); $('#toast').className = ''; }
const fail = err => { if (!(err instanceof Stale)) toast(err.message || String(err), { error: true }); };
// A change was not saved: show the error and re-read the map so the local state does not drift from the server.
async function recover(err) {
  if (err instanceof Stale) return;
  fail(err);
  if (page.kind !== 'project' || !state.graph) return;
  try { await refresh(); renderMap(); } catch { /* the server is unreachable: the map updates over SSE */ }
}

// The token may change while the page is open: the session is re-read once for all requests that got a 401.
let sessionLoad = null;
const loadSession = () => sessionLoad ??= api('/api/session').then(s => { state.session = s; }).finally(() => { sessionLoad = null; });
async function api(path, body, retry = true) {
  let res;
  try { res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session?.token}` }, body: JSON.stringify(body) } : {}); }
  catch { throw new Error(t('No connection to the server.')); }
  if (res.status === 401 && retry) { await loadSession(); return api(path, body, false); }
  const value = await res.json().catch(() => ({}));
  if (!res.ok) { const error = new Error(value.error || t('Server error: {status}', { status: res.status })); error.status = res.status; error.deleted = value.deleted; throw error; }
  return value;
}
// A request to the open project: the prefix is taken at call time, the answer is then checked against the screen generation.
const papi = (path, body) => api(page.prefix + path, body);

// Level geometry. Node coordinates are relative to its level: for a nested node, to the parent's sub-map field.
// An expanded container grows to fit its content: the header on top, the sub-map field with PAD padding.

let sizes = new Map();
// Sub-maps that contain a block with a failed or running check, and sub-map readiness: how many blocks inside have
// each mark. Computed on every map render.
let failedIn = new Set(), testingIn = new Set(), tally = new Map();
// While a container is being edited, its header holds the text field, even if the text is empty.
const headerH = n => HEAD.base + (n.text.trim() || state.editing === n.id ? HEAD.text : 0);
// In focus only the focus block, everything inside it and its notes are visible; the rest of the map is hidden but stays in place.
let focusIds = null;
function visible(n) {
  if (focusIds && !focusIds.has(n.id)) return false;
  for (let p = n.parentId; p; ) { const parent = node(p); if (!parent || parent.collapsed) return false; p = parent.parentId; }
  return true;
}
const edgeShown = e => { const a = e && node(e.source), b = e && node(e.target); return Boolean(a && b && visible(a) && visible(b)); };
// The space an expanded sub-map takes: nested nodes, field padding, header and border.
function contentSize(n) {
  let right = 0, bottom = 0;
  for (const k of childrenOf(n.id)) { const ks = layoutSize(k); right = Math.max(right, k.x + ks.w); bottom = Math.max(bottom, k.y + ks.h); }
  return { w: right + 2 * PAD + 2 * EDGE, h: headerH(n) + bottom + PAD + 2 * EDGE };
}
// An expanded sub-map keeps its size (w, h) and is never smaller than its content; a collapsed one is a compact card.
function layoutSize(n) {
  if (sizes.has(n.id)) return sizes.get(n.id);
  let size = { w: n.w, h: n.h };
  if (isContainer(n)) {
    if (n.collapsed) size = { w: Math.min(n.w, FOLDED.w), h: headerH(n) + FOLDED.h };
    else { const c = contentSize(n); size = { w: Math.max(n.w, c.w), h: Math.max(n.h, c.h) }; }
  }
  sizes.set(n.id, size);
  return size;
}
// Containers up the chain from id that are too tight grow to fit their content; returns operations so the size is saved.
function growOps(id) {
  const ops = [];
  sizes = new Map();
  for (let p = id; p; p = node(p)?.parentId) {
    const n = node(p); if (!n || n.collapsed) break;
    const c = contentSize(n);
    if (c.w <= n.w && c.h <= n.h) continue;
    n.w = clamp(Math.max(n.w, c.w), 120, 20000); n.h = clamp(Math.max(n.h, c.h), 60, 20000);
    ops.push({ type: 'update-node', id: n.id, patch: { w: n.w, h: n.h } });
    sizes = new Map();
  }
  return ops;
}
// Free space in a sub-map field: the first position on a 20 px grid where the node does not touch its neighbours, otherwise below them.
function freeSpot(container, size) {
  sizes = new Map();
  const box = layoutSize(container), w = box.w - 2 * PAD - 2 * EDGE, h = box.h - headerH(container) - PAD - 2 * EDGE;
  const others = childrenOf(container.id).map(k => ({ x: k.x, y: k.y, ...layoutSize(k) }));
  for (let y = SPOT; y + size.h <= h - SPOT; y += 20)
    for (let x = SPOT; x + size.w <= w - SPOT; x += 20)
      if (!others.some(o => overlaps({ x, y, ...size }, o, SPOT - 1))) return { x, y };
  return { x: SPOT, y: others.reduce((bottom, o) => Math.max(bottom, o.y + o.h + SPOT), SPOT) };
}
function worldRect(n) {
  const size = layoutSize(n);
  if (!n.parentId) return { x: n.x, y: n.y, w: size.w, h: size.h };
  const o = subOrigin(node(n.parentId));
  return { x: o.x + n.x, y: o.y + n.y, w: size.w, h: size.h };
}
// The origin of a container's sub-map field in world coordinates, and the field itself.
function subOrigin(container) { const r = worldRect(container); return { x: r.x + EDGE + PAD, y: r.y + EDGE + headerH(container) }; }
function fieldRect(container) { const r = worldRect(container), o = subOrigin(container); return { x: o.x, y: o.y, w: r.x + r.w - EDGE - PAD - o.x, h: r.y + r.h - EDGE - PAD - o.y }; }
const depthOf = n => { let d = 0; for (let p = n.parentId; p; p = node(p)?.parentId) d++; return d; };

// Data

function adopt(next) {
  const prev = state.graph;
  state.graph = next;
  // Nodes created locally and not saved yet, and their links, stay on the map.
  if (prev) for (const [id, fresh] of state.fresh) {
    const n = prev.nodes.find(x => x.id === id);
    if (n && !node(id)) state.graph.nodes.push(n);
    const e = fresh.edgeId && prev.edges.find(x => x.id === fresh.edgeId);
    if (e && !edgeOf(e.id) && node(e.source) && node(e.target)) state.graph.edges.push(e);
  }
}
async function refresh() { const gen = page.gen, next = await papi('/graph'); if (gen !== page.gen) throw new Stale(); adopt(next); }
// Pointers pressed anywhere on the page. While any is pressed, the live update waits: a redraw would replace the
// pressed home row, chevron or panel button, and the click on it would be lost. The release draws what was held back.
const pressed = new Set();
// While a gesture, input, write or pressed pointer is in progress, the map from the server is not swapped in: otherwise
// the dragged node or the editor would lose its state, and the element under the press its click.
const interacting = () => Boolean(state.gesture || state.editing || state.busy || pressed.size || document.activeElement?.id === 'edge-label');
// Writes still running: leaving the project waits for them so an edit is not lost on a retry after 409.
const saving = new Set();
// again builds the operations anew from the map re-read after 409 (the slider level): repeating the old ones would not
// touch sub-maps the agent added while the slider was held.
function commit(operations, message, again) {
  const job = write(operations, message, again);
  saving.add(job); job.catch(() => {}).finally(() => saving.delete(job));
  return job;
}
async function write(operations, message, again) {
  const gen = page.gen;
  state.busy++;
  try {
    const send = ops => papi('/changes', { expectedRevision: state.graph.revision, actor: 'human', message, operations: ops });
    let next, prev = null;
    try { next = await send(operations); }
    catch (err) {
      if (err.status !== 409) throw err;
      prev = state.graph; await refresh();
      const ops = again ? again() : operations;
      next = ops.length ? await send(ops) : state.graph;
    }
    if (gen !== page.gen) throw new Stale();
    // The agent edit that caused the retry appears and is fitted in follow mode, as if it came over SSE.
    const ids = prev ? touched(prev, state.graph) : [], added = prev ? markAppeared(prev, state.graph) : 0;
    state.graph = next;
    renderMap();
    if (added && state.follow && state.tab === 'map') autoFit(ids);
    if (state.tab === 'history') await showHistory();
  } catch (err) { throw gen === page.gen ? err : new Stale(); }
  // An agent edit that arrived during the write is only noted: after the last write the map reads it.
  finally { if (gen === page.gen && !--state.busy) flushPending(); }
}

// Frame and tabs

// The map at full width with the control bar under it, as in n8n. There is no chat: people talk to the agent in its window.
function shell() {
  $('#app').innerHTML = `<div class="work"><div class="focus-bar" id="focus-bar" hidden></div><main id="main"></main>
      <div class="progress-row" id="progress-row" hidden><div class="progress" id="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div></div>
      <div class="dock-bar" id="dock">${barHtml()}</div></div>`;
}
function setStatus(online) {
  state.online = online;
  const el = $('#status'); if (el) el.textContent = online ? '' : t('No connection to the server');
}
async function showTab(tab) {
  const gen = page.gen;
  if (state.editing) await finishEdit();
  if (gen !== page.gen) return;
  state.tab = tab;
  document.querySelectorAll('.tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#levels').hidden = tab !== 'map';
  renderFocus();
  if (tab === 'map') showMap(); else await showHistory();
}
function showMap() {
  $('#main').innerHTML = `<div class="viewport" id="viewport">
      <div class="world" id="world">
        <svg class="edges" id="edges"><defs>
          <marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 8 4.5 1 8Z"/></marker>
          <marker id="arrow-selected" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 8 4.5 1 8Z"/></marker>
          <marker id="arrow-temp" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 8 4.5 1 8Z"/></marker>
        </defs><g id="edge-layer"></g><path id="edge-temp" class="edge temp" marker-end="url(#arrow-temp)" hidden/></svg>
        <div id="blocks"></div>
        <svg class="edges handles" id="handle-layer"></svg>
      </div>
      <div id="float"></div>
      <div class="menu" id="menu" hidden></div>
      <div class="zoom-bar">
        <button data-action="zoom-out" aria-label="${t('Zoom out')}">−</button><span id="zoom-value">100%</span><button data-action="zoom-in" aria-label="${t('Zoom in')}">+</button>
        <button data-action="fit" title="${t('Show all')}" aria-label="${t('Show all')}">${icon('fit', 16)}</button>
      </div>
      <div class="edits" id="edits" hidden></div>
    </div>`;
  // The browser can still scroll a viewport with overflow: hidden when an element at its edge gets focus;
  // then the picture drifts away from the coordinates. Any such scroll is reset.
  $('#viewport').addEventListener('scroll', e => { e.target.scrollTop = 0; e.target.scrollLeft = 0; });
  renderMap(); renderEdits();
  if (state.view && !state.follow) applyView(); else autoFit(state.followIds, false);
}
// At the top is the review by map: what changed in how the project is built, by concept, over an hour, a day or a week, in plain words.
const REVIEW = [[1, 'Last hour'], [24, 'Last day'], [168, 'Last week']];
async function showHistory() {
  const gen = page.gen, [{ history }, review] = await Promise.all([papi('/history'), papi(`/review?hours=${state.reviewHours}`)]);
  if (gen !== page.gen || state.tab !== 'history') return;
  const actor = a => a === 'human' ? t('You') : a === 'system' ? t('System') : a;
  const marks = [review.passed.length && t('Passed: {list}.', { list: review.passed.join(', ') }), review.failed.length && t('Failed: {list}.', { list: review.failed.join(', ') })].filter(Boolean).join(' ');
  const counts = [t('Entries: {n}', { n: review.entries }), review.human && t('yours: {n}', { n: review.human }), review.agents.length && t('agents: {list}', { list: review.agents.join(', ') })].filter(Boolean).join(', ');
  const summary = `<section class="review"><div class="review-head"><h2>${t('What changed')}</h2><nav class="tabs">${REVIEW.map(([h, label]) => `<button type="button" data-review-hours="${h}"${h === state.reviewHours ? ' class="active"' : ''}>${t(label)}</button>`).join('')}</nav></div>
    ${review.groups.length ? `${review.groups.map(g => `<h3>${esc(t('"{title}"', { title: g.title }))}</h3><ul>${g.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`).join('')}${marks ? `<p class="review-marks">${esc(marks)}</p>` : ''}
      <p class="muted">${esc(counts)}.</p>` : `<p class="muted">${t('No changes in how the project is built over this period.')}</p>`}</section>`;
  $('#main').innerHTML = `<div class="page"><h1>${t('History')}</h1>${summary}${history.length ? `<ol class="history">${history.map(h => `<li>
      <div class="h-meta"><b>${esc(actor(h.actor))}</b><span>${date(h.at)}</span><span>${t('revision {n}', { n: h.revision })}</span></div>
      <div class="h-msg">${esc(h.message)}</div>
      ${h.changes.length > 1 || (h.changes[0] && h.changes[0] !== h.message) ? `<ul>${h.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </li>`).join('')}</ol>` : `<p class="muted">${t('No changes yet.')}</p>`}</div>`;
}

// Map

function renderMap() {
  const blocks = $('#blocks'); if (!blocks) return;
  sizes = new Map();
  if (state.focus && !node(state.focus)) state.focus = null;
  focusIds = state.focus ? focusSet(state.focus) : null;
  // The selection is also cleared from a node or link hidden in a collapsed sub-map: otherwise the panel and keys would act on something invisible.
  const s = state.selected;
  if (s && !(s.type === 'node' ? node(s.id) && visible(node(s.id)) : edgeShown(edgeOf(s.id)))) state.selected = null;
  if (state.editing && !node(state.editing)) state.editing = null;
  const editor = state.editing ? captureEditor(state.editing) : null;
  failedIn = new Set(); testingIn = new Set(); tally = new Map();
  for (const n of state.graph.nodes) {
    const inside = n.status === 'failed' ? failedIn : n.status === 'testing' ? testingIn : null;
    if (inside) for (let p = node(n.parentId); p && !inside.has(p.id); p = node(p.parentId)) inside.add(p.id);
    if (!isNote(n)) for (let p = node(n.parentId); p; p = node(p.parentId)) {
      const c = tally.get(p.id) ?? { plan: 0, testing: 0, passed: 0, failed: 0, none: 0 };
      c[n.status ?? 'none']++; tally.set(p.id, c);
    }
  }
  blocks.innerHTML = levelHtml(null);
  // The block being edited went into a collapsed sub-map: the edit is saved instead of hanging without a field and holding the update.
  if (state.editing && !blockEl(state.editing)) finishEdit(editor);
  else if (state.editing) mountEditor(state.editing, editor?.focus ?? 'title', editor);
  for (const el of blocks.querySelectorAll('.block')) { const text = part(el, 'b-text'); if (text && text.scrollHeight > text.clientHeight + 1) el.classList.add('clipped'); }
  renderLevels(); renderFocus(); renderEdits(); reportSelection();
  drawEdges(); renderFloat(); syncHover(); paintCode();
}
// Nodes of one level: containers first, then blocks, then notes. What comes later in the markup is higher on screen:
// a block laid on a sub-map does not go under its header and content, and notes lie on top of everything.
function levelHtml(parentId) {
  const level = state.graph.nodes.filter(n => n.parentId === parentId), blocks = level.filter(n => !isNote(n));
  return [...blocks.filter(n => isContainer(n)), ...blocks.filter(n => !isContainer(n)), ...level.filter(isNote)].map(blockHtml).join('');
}
// Sub-map readiness is a strip along the top edge: how many blocks inside passed, are being tested, failed, are planned
// and have no mark. No mark inside at all means no strip.
const METER = ['passed', 'testing', 'failed', 'plan', 'none'];
function meterHtml(n) {
  const c = tally.get(n.id); if (!c || !(c.plan + c.testing + c.passed + c.failed)) return '';
  const total = METER.reduce((sum, k) => sum + c[k], 0);
  return `<div class="meter" title="${esc(t('Passed {passed} of {total}', { passed: c.passed, total }))}">${METER.filter(k => c[k]).map(k => `<i class="m-${k}" style="flex:${c[k]}"></i>`).join('')}</div>`;
}
function blockHtml(n) {
  const size = layoutSize(n), selected = state.selected?.type === 'node' && state.selected.id === n.id;
  const container = isContainer(n), kids = container ? childrenOf(n.id) : [], blocksIn = kids.filter(c => !isNote(c)).length;
  // The label of a collapsed sub-map: "3 blocks inside", "1 note inside", "2 blocks, 1 note inside".
  const inside = [blocksIn && plural(blocksIn, '{n} block', '{n} blocks'), kids.length > blocksIn && plural(kids.length - blocksIn, '{n} note', '{n} notes')].filter(Boolean).join(', ');
  const age = appearing(n.id);
  // The mark (plan is dashed, testing pulses, passed is green, failed is red; a sub-map with something being tested or
  // failed inside the same), the flash of a mark that just changed, and the agent proposal tag.
  const flash = remarking(n.id);
  const classes = ['block', `lv-${Math.min(depthOf(n), 3)}`, isNote(n) && 'note', n.color && `c-${n.color}`, selected && 'selected', container && 'container', container && n.collapsed && 'collapsed', focusIds && !focusIds.has(n.id) && 'out-focus', age !== null && 'appear',
    n.status && `st-${n.status}`, n.status !== 'failed' && failedIn.has(n.id) && 'failed-inside', n.status !== 'testing' && testingIn.has(n.id) && 'testing-inside', flash !== null && 'remark', n.proposed && `pr-${n.proposed}`].filter(Boolean).join(' ');
  // The block's files and its check command are a tooltip on the title: on the map their place goes to the meaning.
  const code = [n.files && t('Files: {files}', { files: n.files.join(', ') }), n.test && t('Check: {test}', { test: n.test })].filter(Boolean).join('\n');
  const head = `${isNote(n) ? '' : `<div class="b-title"${code ? ` title="${esc(code)}"` : ''}>${esc(n.title)}</div>`}<div class="b-text">${fmt(n.text)}</div>`;
  return `<div class="${classes}" data-id="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px;width:${size.w}px;height:${size.h}px${age !== null ? `;animation-delay:-${age}ms` : ''}${flash !== null ? `;--remark-delay:-${flash}ms` : ''}" tabindex="0" aria-label="${esc(nodeName(n))}">
      ${container ? `<div class="head" style="height:${headerH(n)}px">${head}</div>` : head}
      ${container ? `<button type="button" class="fold" data-fold title="${n.collapsed ? t('Expand sub-map') : t('Collapse sub-map')}" aria-label="${n.collapsed ? t('Expand') : t('Collapse')}">${icon(n.collapsed ? 'right' : 'down', 15)}</button>` : ''}
      ${container && n.collapsed ? `<button type="button" class="fold-badge" data-fold>${esc(t('{list} inside', { list: inside }))}</button>` : ''}
      ${isNote(n) ? '' : `<button type="button" class="pen" data-pen tabindex="-1" title="${t('Edit')}" aria-label="${t('Edit block')}">${icon('pen', 14)}</button>`}
      ${meterHtml(n)}
      ${container && !n.collapsed ? `<div class="sub" style="top:${headerH(n)}px"><span class="sub-level">${t(LEVELS[Math.min(depthOf(n) + 1, LEVELS.length - 1)])}</span>${levelHtml(n.id)}</div>` : ''}
      ${isNote(n) ? '' : `<span class="port" data-port title="${t('Drag to another block to link')}"></span><span class="ez ez-t" data-port></span><span class="ez ez-r" data-port></span><span class="ez ez-b" data-port></span><span class="ez ez-l" data-port></span>`}${container && n.collapsed ? '' : '<span class="resize" data-resize></span>'}
    </div>`;
}
function edgeGeometry(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  const outer = contains(a, b) ? a : contains(b, a) ? b : null;
  let g;
  if (outer) {
    // A link between a container and its nested block starts from the side of the border nearest the block, not through the block. The header is on top; it is not crossed.
    const inner = outer === a ? b : a, ic = outer === a ? bc : ac;
    const [, o, i] = [
      [inner.x - outer.x, { x: outer.x, y: ic.y }, { x: inner.x, y: ic.y }],
      [outer.x + outer.w - inner.x - inner.w, { x: outer.x + outer.w, y: ic.y }, { x: inner.x + inner.w, y: ic.y }],
      [outer.y + outer.h - inner.y - inner.h, { x: ic.x, y: outer.y + outer.h }, { x: ic.x, y: inner.y + inner.h }]
    ].reduce((best, side) => side[0] < best[0] ? side : best);
    const [p, q] = outer === a ? [o, i] : [i, o], mid = [(p.x + q.x) / 2, (p.y + q.y) / 2];
    g = { x1: p.x, y1: p.y, x2: q.x, y2: q.y, c1: mid, c2: mid };
  } else if (Math.abs(dx) >= Math.abs(dy)) {
    const x1 = dx > 0 ? a.x + a.w : a.x, x2 = dx > 0 ? b.x : b.x + b.w;
    g = { x1, y1: ac.y, x2, y2: bc.y, c1: [(x1 + x2) / 2, ac.y], c2: [(x1 + x2) / 2, bc.y] };
  } else {
    const y1 = dy > 0 ? a.y + a.h : a.y, y2 = dy > 0 ? b.y : b.y + b.h;
    g = { x1: ac.x, y1, x2: bc.x, y2, c1: [ac.x, (y1 + y2) / 2], c2: [bc.x, (y1 + y2) / 2] };
  }
  g.d = `M${g.x1},${g.y1} C${g.c1[0]},${g.c1[1]} ${g.c2[0]},${g.c2[1]} ${g.x2},${g.y2}`;
  g.mx = (g.x1 + g.x2) / 2; g.my = (g.y1 + g.y2) / 2;
  return g;
}
const overlaps = (a, b, gap = 12) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
// How many milliseconds a node or link that came over SSE has been appearing; null means it has appeared. A redraw sets
// a negative animation delay, so the animation continues from the same point instead of starting over.
const APPEAR = 250;
function appearing(id) {
  const t0 = state.appeared.get(id); if (t0 === undefined) return null;
  const age = Math.round(performance.now() - t0);
  if (age < APPEAR) return age;
  state.appeared.delete(id); return null;
}
// A block's mark changed over SSE (the agent runs tests): the block flashes a ring of its colour. The flash age survives
// redraws, as with appearing.
const REMARK = 1200;
function remarking(id) {
  const t0 = state.remarked.get(id); if (t0 === undefined) return null;
  const age = Math.round(performance.now() - t0);
  if (age < REMARK) return age;
  state.remarked.delete(id); return null;
}
function drawEdges() {
  const layer = $('#edge-layer'); if (!layer) return;
  const edges = state.graph.edges.map(e => {
    const a = node(e.source), b = node(e.target); if (!a || !b || !visible(a) || !visible(b)) return '';
    const g = edgeGeometry(worldRect(a), worldRect(b)), selected = state.selected?.type === 'edge' && state.selected.id === e.id, age = appearing(e.id);
    const title = `${nodeName(a)} → ${nodeName(b)}${e.label ? `: ${e.label}` : ''}`;
    return `<g class="edge-group${selected ? ' selected' : ''}${state.hoverEdge === e.id ? ' hover' : ''}${age !== null ? ' appear' : ''}${e.proposed ? ` pr-${e.proposed}` : ''}" data-edge="${esc(e.id)}"${age !== null ? ` style="animation-delay:-${age}ms"` : ''}>
      <path class="edge-hit" d="${g.d}"><title>${esc(title)}</title></path><path class="edge" d="${g.d}" marker-end="url(#${selected ? 'arrow-selected' : 'arrow'})"/>
      ${e.label ? `<foreignObject x="${g.mx - 110}" y="${g.my - 11}" width="220" height="22"><div xmlns="http://www.w3.org/1999/xhtml" class="edge-label-box"><span class="edge-label">${esc(e.label)}</span></div></foreignObject>` : ''}
    </g>`;
  });
  // A thread from a note to its block, if the note was moved away from it.
  const leaders = state.graph.nodes.filter(n => isNote(n) && n.attachedTo && visible(n)).map(n => {
    const parent = node(n.attachedTo); if (!parent) return '';
    const a = worldRect(n), b = worldRect(parent);
    return overlaps(a, b) ? '' : `<path class="leader" d="${edgeGeometry(a, b).d}"/>`;
  });
  layer.innerHTML = leaders.join('') + edges.join('');
  renderOverlay();
}
// Handles at the ends and a cross in the middle of the link under the cursor or the selected one. They lie in a separate
// layer above the blocks, otherwise a block covers the handle on its border. Their size on screen does not depend on zoom.
function renderOverlay() {
  const layer = $('#handle-layer'); if (!layer) return;
  const ids = new Set([state.hoverEdge, state.selected?.type === 'edge' ? state.selected.id : null, state.gesture?.type === 'rebind' ? state.gesture.edgeId : null].filter(Boolean));
  const k = 1 / (state.view?.z ?? 1);
  layer.innerHTML = [...ids].map(id => {
    const e = edgeOf(id), a = e && node(e.source), b = e && node(e.target); if (!a || !b || !visible(a) || !visible(b)) return '';
    const g = edgeGeometry(worldRect(a), worldRect(b)), cy = e.label ? g.my - 24 * k : g.my;
    // The handles sit slightly inward from the line ends so they do not lie on the block's port circle.
    const path = document.querySelector(`.edge-group[data-edge="${CSS.escape(id)}"] .edge`);
    const length = path?.getTotalLength() ?? 0, inset = Math.min(20 * k, length / 3);
    const p1 = path && length ? path.getPointAtLength(inset) : { x: g.x1, y: g.y1 }, p2 = path && length ? path.getPointAtLength(length - inset) : { x: g.x2, y: g.y2 };
    const handles = [['source', p1], ['target', p2]].map(([end, pt]) => `<circle class="edge-handle" data-handle="${end}" data-edge="${esc(id)}" cx="${pt.x}" cy="${pt.y}" r="${7 * k}"><title>${t('Drag onto another block')}</title></circle>`).join('');
    return `${handles}<g class="edge-x" data-edge="${esc(id)}" transform="translate(${g.mx},${cy}) scale(${k})"><title>${t('Delete link')}</title><circle r="10"/><path d="M-3.5 -3.5 3.5 3.5M3.5 -3.5-3.5 3.5"/></g>`;
  }).join('');
}
function hoverEdge(id) {
  clearTimeout(hoverEdge.timer);
  if (state.hoverEdge === id) return;
  state.hoverEdge = id;
  document.querySelectorAll('.edge-group.hover').forEach(el => el.classList.remove('hover'));
  if (id) document.querySelector(`.edge-group[data-edge="${CSS.escape(id)}"]`)?.classList.add('hover');
  renderOverlay();
}
// After a redraw the hover state is checked against the real pointer position:
// the browser itself sends pointerover for the old position, and without this the handles can get stuck.
function syncHover() {
  if (state.gesture) return;
  const el = document.elementFromPoint(state.pointer.x, state.pointer.y);
  hoverEdge(el?.closest?.('[data-edge]')?.dataset.edge ?? null);
}
function select(selected) {
  state.selected = selected;
  document.querySelectorAll('.block.selected').forEach(el => el.classList.remove('selected'));
  if (selected?.type === 'node') blockEl(selected.id)?.classList.add('selected');
  drawEdges(); renderFloat(); reportSelection();
}
function renderFloat() {
  const float = $('#float'); if (!float) return;
  if (!state.selected || state.editing) { float.innerHTML = ''; return; }
  if (state.selected.type === 'node') {
    const n = node(state.selected.id);
    const swatches = COLORS.map(c => `<button type="button" class="swatch${c ? ` c-${c}` : ' none'}${n.color === c ? ' active' : ''}" data-color="${c}" title="${t(COLOR_NAMES[c])}" aria-label="${t(COLOR_NAMES[c])}"></button>`).join('');
    const connect = isNote(n) ? '' : `<button type="button" class="tool" data-action="connect" title="${t('Link to another block')}" aria-label="${t('Link')}">${icon('link', 15)}</button>`;
    float.innerHTML = `<div class="tools" id="tools">${swatches}<i class="sep"></i>${connect}<button type="button" class="tool" data-action="delete" title="${t('Delete')}" aria-label="${t('Delete')}">${icon('trash', 15)}</button></div>`;
  } else {
    const e = edgeOf(state.selected.id);
    float.innerHTML = `<div class="tools" id="tools"><input id="edge-label" value="${esc(e.label)}" placeholder="${t('Label')}" maxlength="200" aria-label="${t('Link label')}"><button type="button" class="tool" data-action="swap" title="${t('Reverse direction')}" aria-label="${t('Reverse direction')}">${icon('swap', 15)}</button><button type="button" class="tool" data-action="delete" title="${t('Delete link')}" aria-label="${t('Delete link')}">${icon('trash', 15)}</button></div>`;
  }
  positionFloat();
}
function positionFloat() {
  const tools = $('#tools'), vp = $('#viewport'); if (!tools || !vp || !state.selected) return;
  let x, top, bottom;
  if (state.selected.type === 'node') {
    const r = worldRect(node(state.selected.id)), a = toScreen(r.x + r.w / 2, r.y), b = toScreen(0, r.y + r.h);
    x = a.x; top = a.y - 8; bottom = b.y + 8;
  } else {
    const e = edgeOf(state.selected.id), g = edgeGeometry(worldRect(node(e.source)), worldRect(node(e.target))), s = toScreen(g.mx, g.my);
    x = s.x; top = s.y - 14; bottom = s.y + 14;
  }
  // The panel does not go past the window edges: it is pushed in horizontally, and if there is no room above it goes under the node.
  const w = tools.offsetWidth, h = tools.offsetHeight, below = top - h < 4;
  tools.classList.toggle('below', below);
  tools.style.left = `${clamp(x, w / 2 + 6, Math.max(w / 2 + 6, vp.clientWidth - w / 2 - 6))}px`;
  tools.style.top = `${below ? bottom : top}px`;
}

// Context menu

function openMenu(clientX, clientY, target) {
  const menu = $('#menu'), vp = $('#viewport'); if (!menu) return;
  const items = [];
  if (target.type === 'node') {
    const n = node(target.id);
    if (isNote(n)) { if (n.attachedTo) items.push({ action: 'detach', label: 'Detach from block' }); }
    else {
      items.push(state.focus === n.id ? { action: 'unfocus', label: 'Leave focus' } : { action: 'open', label: 'Open' }, '-');
      items.push({ action: 'new-inner-block', label: 'Block inside' }, { action: 'new-inner-note', label: 'Note inside' });
      if (isContainer(n)) items.push({ action: 'fold', label: n.collapsed ? 'Expand sub-map' : 'Collapse sub-map' });
      items.push('-', { action: 'note-for', label: 'Note on block' }, { action: 'connect', label: 'Link to…' });
      // A block can be checked if it or something inside it has a check command: the agent runs it.
      if ([...subtreeOf(n.id)].some(id => node(id)?.test)) items.push({ action: 'check', label: 'Check' });
    }
    items.push({ action: 'edit', label: isNote(n) ? 'Edit note' : 'Edit' }, '-', { action: 'delete', label: 'Delete', danger: true });
  } else if (target.type === 'edge') {
    items.push({ action: 'label', label: 'Label' }, { action: 'swap', label: 'Reverse direction' }, { action: 'rebind-source', label: 'Move start to…' }, { action: 'rebind-target', label: 'Move end to…' }, '-', { action: 'delete', label: 'Delete link', danger: true });
  } else {
    items.push({ action: 'new-block', label: target.container ? 'Block inside' : 'Block' }, { action: 'new-note', label: target.container ? 'Note inside' : 'Note' });
  }
  menu.innerHTML = items.map(i => i === '-' ? '<i class="sep"></i>' : `<button type="button" data-menu="${i.action}"${i.danger ? ' class="danger"' : ''}>${esc(t(i.label))}</button>`).join('');
  menu.hidden = false;
  const r = vp.getBoundingClientRect(), x = clamp(clientX - r.left, 4, vp.clientWidth - menu.offsetWidth - 4), y = clamp(clientY - r.top, 4, vp.clientHeight - menu.offsetHeight - 4);
  menu.style.left = `${x}px`; menu.style.top = `${y}px`;
  state.menu = { world: toWorld(clientX, clientY), target };
  menu.querySelector('button')?.focus({ preventScroll: true });
}
function closeMenu() { const menu = $('#menu'); if (menu) menu.hidden = true; state.menu = null; }
// A world point → coordinates inside a container's sub-map field (not below zero).
function localIn(container, p) { const o = subOrigin(container); return { x: Math.max(0, p.x - o.x), y: Math.max(0, p.y - o.y) }; }
async function runMenu(action) {
  const m = state.menu; closeMenu(); if (!m) return;
  const n = m.target.type === 'node' ? node(m.target.id) : m.target.container ? node(m.target.container) : null;
  const inside = (type, container) => {
    const size = SIZE[type], p = localIn(container, { x: m.world.x - size.w / 2, y: m.world.y - size.h / 2 });
    createNode({ type, parentId: container.id, x: p.x, y: p.y });
  };
  switch (action) {
    case 'new-block': if (n && isContainer(n)) inside('block', n); else if (n) await createInside(n, 'block'); else createNode({ type: 'block', x: m.world.x - SIZE.block.w / 2, y: m.world.y - SIZE.block.h / 2 }); break;
    case 'new-note': if (n && isContainer(n)) inside('note', n); else if (n) await createInside(n, 'note'); else createNode({ type: 'note', x: m.world.x - SIZE.note.w / 2, y: m.world.y - SIZE.note.h / 2 }); break;
    case 'new-inner-block': case 'new-inner-note': if (n) await createInside(n, action === 'new-inner-block' ? 'block' : 'note'); break;
    case 'open': if (n) await walk(() => dive(n.id)); break;
    case 'unfocus': await walk(exitFocus); break;
    case 'fold': if (n) await toggleFold(n); break;
    case 'note-for': if (n) {
      // The sticker goes on the block's top right corner. A container has its chevron there, and inside a sub-map there may be no field above the block; then it goes to the right of the block.
      const w = layoutSize(n).w, y = n.y - SIZE.note.h + 30, beside = isContainer(n) || (n.parentId && y < 0);
      createNode({ type: 'note', parentId: n.parentId, attachedTo: n.id, x: beside ? n.x + w + 16 : n.x + w - 40, y: beside ? Math.max(0, n.y) : y });
    } break;
    case 'connect': if (n) startConnect(n.id); break;
    case 'check': if (n) {
      await papi('/check', { ids: [n.id] });
      toast(t(state.agents.some(a => a.waiting) ? 'The agent will check "{name}"' : 'No agent is connected right now: it will see the request to check "{name}" when it comes back', { name: nodeName(n) }));
    } break;
    case 'edit': if (n) startEdit(n.id, isNote(n) ? 'text' : 'title'); break;
    case 'detach': if (n && n.attachedTo) { n.attachedTo = null; await commit([{ type: 'update-node', id: n.id, patch: { attachedTo: null } }], t('Detached note "{name}"', { name: nodeName(n) })); } break;
    case 'delete': select(m.target); await deleteSelected(); break;
    case 'label': select(m.target); $('#edge-label')?.focus(); break;
    case 'swap': select(m.target); await swapEdge(); break;
    case 'rebind-source': case 'rebind-target': select(m.target); startRebind(m.target.id, action === 'rebind-source' ? 'source' : 'target'); break;
  }
}
// A new node inside a block: a collapsed sub-map expands, a block without a sub-map gets a roomy field at once
// (if the node is not saved, the size goes back), the node takes a free spot.
async function createInside(n, type) {
  if (n.collapsed) await commit(foldOps([[n, false]]), t('Expanded sub-map "{name}"', { name: nodeName(n) }));
  let grown = null;
  if (!isContainer(n)) {
    grown = { id: n.id, w: n.w, h: n.h };
    n.w = Math.max(n.w, ROOM.w + 2 * PAD + 2 * EDGE); n.h = Math.max(n.h, headerH(n) + ROOM.h + PAD + 2 * EDGE);
  }
  const spot = freeSpot(n, SIZE[type]);
  createNode({ type, parentId: n.id, x: spot.x, y: spot.y, grown });
}
function startConnect(id) { state.connectFrom = id; $('#viewport').classList.add('connecting'); toast(t('Click the block to link to')); }
function startRebind(edgeId, end) { state.rebind = { edgeId, end }; $('#viewport').classList.add('connecting'); toast(end === 'source' ? t('Click the block the link should start from') : t('Click the block the link should go to')); }
function stopConnect() { state.connectFrom = null; state.rebind = null; $('#viewport')?.classList.remove('connecting'); }
// Moves the start or end of a link to another block. A link cannot loop back to its own block or repeat an existing one.
async function rebindEdge(edgeId, end, target) {
  const e = edgeOf(edgeId); if (!e || !target || !node(target) || isNote(node(target))) return;
  const next = { source: e.source, target: e.target, [end]: target };
  if (next.source === next.target) return toast(t('A link cannot loop back to its own block'));
  if (e[end] === target) return;
  if (state.graph.edges.some(x => x.id !== e.id && x.source === next.source && x.target === next.target)) return toast(t('This link already exists'));
  await commit([{ type: 'update-edge', id: e.id, patch: { [end]: target } }], t('Moved link'));
  select({ type: 'edge', id: e.id });
}

// View: offset and zoom

function applyView() {
  const world = $('#world'); if (!world) return;
  world.style.transform = `translate(${state.view.x}px,${state.view.y}px) scale(${state.view.z})`;
  $('#zoom-value').textContent = `${Math.round(state.view.z * 100)}%`;
  // Zoom for styling: from afar (far) cards show only large titles, up close everything.
  const vp = $('#viewport');
  vp.classList.toggle('far', state.view.z < 0.55);
  vp.style.setProperty('--zoom', state.view.z);
  if (state.selected?.type === 'edge' || state.hoverEdge) renderOverlay();
  positionFloat();
  saveView();
}
// The view is remembered per project together with the follow mode.
const viewKey = id => `mycel.view.${id}`;
function saveView() { if (page.id && state.view) prefs.set(viewKey(page.id), JSON.stringify({ x: state.view.x, y: state.view.y, z: state.view.z, follow: state.follow })); }
function loadView(id) {
  let saved = null;
  try { saved = JSON.parse(prefs.get(viewKey(id))); } catch { saved = null; }
  const ok = Boolean(saved) && [saved.x, saved.y, saved.z].every(Number.isFinite) && saved.z >= ZOOM.min && saved.z <= ZOOM.max;
  // A map opened for the first time follows changes; a saved view remembers whether following was on.
  state.follow = !ok || saved.follow === true;
  state.view = ok ? { x: saved.x, y: saved.y, z: saved.z } : null;
}
function setFollow(on) { if (state.follow !== on) { state.follow = on; saveView(); } }
// Automatic fitting moves smoothly. Any action of the person on the view first stops the move,
// so the map on screen matches the state.view that the action reads or changes.
function glide() {
  const world = $('#world'); if (!world) return;
  world.classList.add('glide'); clearTimeout(glide.timer);
  glide.timer = setTimeout(() => world.classList.remove('glide'), 400);
}
function stopGlide() { clearTimeout(glide.timer); $('#world')?.classList.remove('glide'); }
function toWorld(sx, sy) { const r = $('#viewport').getBoundingClientRect(); return { x: (sx - r.left - state.view.x) / state.view.z, y: (sy - r.top - state.view.y) / state.view.z }; }
function toScreen(wx, wy) { return { x: state.view.x + wx * state.view.z, y: state.view.y + wy * state.view.z }; }
function zoomAt(factor, cx, cy) {
  stopGlide(); setFollow(false);
  const r = $('#viewport').getBoundingClientRect(), px = cx - r.left, py = cy - r.top;
  const z = clamp(state.view.z * factor, ZOOM.min, ZOOM.max);
  state.view = { x: px - (px - state.view.x) * z / state.view.z, y: py - (py - state.view.y) * z / state.view.z, z };
  applyView();
}
function zoomCenter(factor) { const r = $('#viewport').getBoundingClientRect(); zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2); }
// What "Show all" fits: in focus, the module with the notes attached to it, otherwise the whole main map.
const fitRoots = () => (state.focus ? state.graph.nodes.filter(n => n.id === state.focus || n.attachedTo === state.focus) : state.graph.nodes.filter(n => !n.parentId)).map(worldRect);
const boxOf = rects => {
  if (!rects.length) return null;
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
};
const sameBox = (a, b) => a === b || Boolean(a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 0.5));
// The view in which a world rectangle is fully visible with margins; the map is not zoomed beyond 100%.
function fitTo(box) {
  const vp = $('#viewport');
  if (!box) return { x: vp.clientWidth / 2, y: vp.clientHeight / 2, z: 1 };
  const width = vp.clientWidth, padX = clamp(width * 0.06, 20, 60), padY = 60;
  const z = clamp(Math.min((width - padX * 2) / box.w, (vp.clientHeight - padY * 2) / box.h), ZOOM.min, 1);
  return { x: (width - box.w * z) / 2 - box.x * z, y: (vp.clientHeight - box.h * z) / 2 - box.y * z, z };
}
function fitView() {
  if (!$('#viewport')) return;
  state.view = fitTo(boxOf(fitRoots()));
  applyView();
}
const topOf = id => { let n = node(id); while (n?.parentId) n = node(n.parentId); return n?.id; };
// Following: the map is fitted whole, and if that makes it smaller than 40%, to the top blocks inside which the nodes
// ids were added or changed (they are remembered to fit the map the same way when the chat width changes).
function autoFit(ids = state.followIds, smooth = true) {
  if (!$('#viewport') || !state.graph) return;
  let view = fitTo(boxOf(fitRoots()));
  state.followIds = ids?.length ? ids : null;
  if (view.z < 0.4 && !state.focus && state.followIds) {
    const tops = new Set(ids.map(topOf).filter(Boolean)), box = boxOf(state.graph.nodes.filter(n => tops.has(n.id)).map(worldRect));
    if (box) view = fitTo(box);
  }
  if (smooth) glide();
  state.view = view; applyView();
}

// Creating, editing, deleting

// grown is the former size of a block that became a sub-map for the new node and grew: it goes back if the node is not saved.
function createNode({ type, x, y, parentId = null, attachedTo = null, from = null, grown = null }) {
  if (state.editing) finishEdit();
  const size = SIZE[type];
  // A new block is logic without finished code: a plan, dashed, until it is implemented and checked.
  const n = { id: crypto.randomUUID(), type, parentId, attachedTo: type === 'note' ? attachedTo : null, collapsed: false, title: '', text: '', x: Math.round(x), y: Math.round(y), w: size.w, h: size.h, color: type === 'note' ? 'yellow' : '', ...(type === 'block' ? { status: 'plan' } : {}) };
  state.graph.nodes.push(n);
  const fresh = { edgeId: null, grown };
  if (from && node(from)) { const e = { id: crypto.randomUUID(), source: from, target: n.id, label: '' }; state.graph.edges.push(e); fresh.edgeId = e.id; }
  state.fresh.set(n.id, fresh);
  renderMap();
  select({ type: 'node', id: n.id });
  startEdit(n.id, type === 'note' ? 'text' : 'title');
}
function startEdit(id, focus = 'title') {
  if (state.editing === id) return;
  if (state.editing) finishEdit();
  if (!blockEl(id)) return;
  state.editing = id;
  // While a container is edited, its header holds the text field and the sub-map field moves down: a full redraw is needed.
  if (isContainer(node(id))) { state.selected = { type: 'node', id }; renderMap(); }
  else select({ type: 'node', id });
  mountEditor(id, focus);
}
// A snapshot of the open editor: field values and cursor position, to survive a redraw.
function captureEditor(id) {
  const el = blockEl(id), title = part(el, 'b-title-input'), text = part(el, 'b-text-input');
  if (!text) return null;
  const active = document.activeElement === title ? title : text;
  return { title: title?.value ?? '', text: text.value, focus: active === text ? 'text' : 'title', start: active.selectionStart, end: active.selectionEnd };
}
// A repeated call on an editor already open only moves the focus.
function mountEditor(id, focus = 'title', saved = null) {
  const n = node(id), el = blockEl(id); if (!n || !el) return;
  el.classList.add('editing');
  const title = part(el, 'b-title'), text = part(el, 'b-text');
  if (title) title.outerHTML = `<input class="b-title-input" placeholder="${t('Title')}" maxlength="200" value="${esc(saved ? saved.title : n.title)}" aria-label="${t('Block title')}">`;
  if (text) text.outerHTML = `<textarea class="b-text-input" placeholder="${isNote(n) ? t('Note') : t('Text')}" maxlength="20000" aria-label="${t('Text')}">${esc(saved ? saved.text : n.text)}</textarea>`;
  const target = part(el, focus === 'text' || isNote(n) ? 'b-text-input' : 'b-title-input'); if (!target) return;
  target.focus({ preventScroll: true });
  if (saved) target.setSelectionRange(saved.start, saved.end);
  else if (target.classList.contains('b-title-input')) target.select();
  else target.selectionStart = target.selectionEnd = target.value.length;
  renderFloat();
}
// saved is the editor snapshot, if its field is already gone from the map.
async function finishEdit(saved = null) {
  const id = state.editing; if (!id) return;
  state.editing = null;
  const el = blockEl(id), n = node(id);
  if (!n || !(el || saved)) return flushPending();
  const title = saved ? saved.title : part(el, 'b-title-input')?.value ?? n.title;
  const text = saved ? saved.text : part(el, 'b-text-input')?.value ?? n.text;
  const fresh = state.fresh.get(id); state.fresh.delete(id);
  try {
    if (fresh) {
      if (!title.trim() && !text.trim()) {
        dropFresh(id, fresh);
        if (state.selected?.id === id) state.selected = null;
        renderMap();
      } else {
        n.title = title; n.text = text;
        const ops = [{ type: 'add-node', node: n }];
        const e = fresh.edgeId && edgeOf(fresh.edgeId);
        if (e) ops.push({ type: 'add-edge', edge: e });
        const grown = fresh.grown && node(fresh.grown.id);
        if (grown) ops.push({ type: 'update-node', id: grown.id, patch: { w: grown.w, h: grown.h } });
        await commit([...ops, ...growOps(n.parentId)], t(isNote(n) ? 'Added note "{name}"' : 'Added block "{name}"', { name: nodeName(n) }));
      }
    } else {
      const patch = {};
      if (title !== n.title) patch.title = title;
      if (text !== n.text) patch.text = text;
      Object.assign(n, patch);
      if (Object.keys(patch).length) await commit([{ type: 'update-node', id, patch }], t(isNote(n) ? 'Changed note "{name}"' : 'Changed block "{name}"', { name: nodeName(n) }));
      else renderMap();
    }
  } catch (err) { await recover(err); }
  await flushPending();
}
// An unsaved node is removed together with its link, and the block that grew for it gets its former size back.
function dropFresh(id, fresh) {
  state.fresh.delete(id);
  state.graph.nodes = state.graph.nodes.filter(x => x.id !== id);
  state.graph.edges = state.graph.edges.filter(e => e.id !== fresh.edgeId);
  const grown = fresh.grown && node(fresh.grown.id);
  if (grown) { grown.w = fresh.grown.w; grown.h = fresh.grown.h; }
}
// A node, everything nested in it and the notes attached to the blocks being deleted.
function subtreeOf(id) {
  const removed = new Set([id]);
  let changed = true;
  while (changed) { changed = false; for (const n of state.graph.nodes) if (!removed.has(n.id) && (removed.has(n.parentId) || removed.has(n.attachedTo))) { removed.add(n.id); changed = true; } }
  return removed;
}
async function deleteSelected() {
  const s = state.selected; if (!s) return;
  try {
    if (s.type === 'edge') {
      const e = edgeOf(s.id); select(null); hoverEdge(null);
      await commit([{ type: 'delete-edge', id: s.id }], t('Deleted link'));
      toast(t('Link deleted'), { action: t('Undo'), run: () => commit([{ type: 'add-edge', edge: e }], t('Restored link')).catch(fail) });
      return;
    }
    const n = node(s.id), removed = subtreeOf(n.id);
    const nodes = state.graph.nodes.filter(x => removed.has(x.id)), edges = state.graph.edges.filter(e => removed.has(e.source) || removed.has(e.target));
    select(null);
    if (state.fresh.has(n.id)) { dropFresh(n.id, state.fresh.get(n.id)); renderMap(); return; }
    await commit([{ type: 'delete-node', id: n.id }], t(isNote(n) ? 'Deleted note "{name}"' : 'Deleted block "{name}"', { name: nodeName(n) }));
    const restore = [...nodes.map(x => ({ type: 'add-node', node: x })), ...edges.map(e => ({ type: 'add-edge', edge: e }))];
    toast(t(isNote(n) ? 'Note deleted' : nodes.length > 1 ? 'Block and its content deleted' : 'Block deleted'), { action: t('Undo'), run: () => commit(restore, t(isNote(n) ? 'Restored note "{name}"' : 'Restored block "{name}"', { name: nodeName(n) })).catch(fail) });
  } catch (err) { fail(err); }
}
async function connect(source, target) {
  if (source === target || isNote(node(source)) || isNote(node(target))) return;
  if (state.graph.edges.some(e => e.source === source && e.target === target)) return toast(t('This link already exists'));
  const e = { id: crypto.randomUUID(), source, target, label: '' };
  await commit([{ type: 'add-edge', edge: e }], t('Added link'));
  select({ type: 'edge', id: e.id });
}
async function swapEdge() {
  const e = edgeOf(state.selected?.id); if (!e) return;
  if (state.graph.edges.some(x => x.source === e.target && x.target === e.source)) return toast(t('A link in the opposite direction already exists'));
  await commit([{ type: 'update-edge', id: e.id, patch: { source: e.target, target: e.source } }], t('Reversed link'));
}
// The visible block under a world point, with a margin of a few screen pixels from its edge; notes do not count.
// Of blocks nested in each other the deepest fits. level limits the search to one level.
function blockNear(p, exclude = null, marginPx = 12, level) {
  const m = marginPx / (state.view?.z ?? 1);
  let found = null, best = -1;
  for (const n of state.graph.nodes) {
    if (isNote(n) || n.id === exclude || !visible(n) || (level !== undefined && n.parentId !== level)) continue;
    // The margin at a nested block's edge does not go past the sub-map field: a drop on a container's header goes to the container at any zoom.
    const zone = n.parentId ? clip(grow(worldRect(n), m), fieldRect(node(n.parentId))) : grow(worldRect(n), m), d = depthOf(n);
    if (inRect(p, zone) && d >= best) { found = n.id; best = d; }
  }
  return found;
}
// The block a link will go to: the one the pointer is inside (of nested ones the deepest, of stacked ones the top one: a
// card above a sub-map, one drawn later above an earlier one); only if there is none, the nearest with a margin at its
// edge. So a drop at the edge of the right block does not go to a neighbour caught by the margin, and a link to a sub-map
// lying under a block is made by a drop on its visible part. A drop on an attached note links to its block.
function linkTarget(p, from) {
  const order = new Map(state.graph.nodes.map((n, i) => [n.id, i]));
  const under = n => n.id !== from && visible(n) && inRect(p, n.parentId ? clip(worldRect(n), fieldRect(node(n.parentId))) : worldRect(n));
  const hits = state.graph.nodes.filter(n => !isNote(n) && under(n));
  hits.sort((a, b) => depthOf(b) - depthOf(a) || isContainer(a) - isContainer(b) || order.get(b.id) - order.get(a.id));
  const note = state.graph.nodes.find(n => isNote(n) && n.attachedTo && n.attachedTo !== from && under(n));
  return hits[0]?.id ?? note?.attachedTo ?? blockNear(p, from);
}
// The expanded container whose sub-map field holds the point; of nested ones the deepest. skip is the dragged node with
// everything nested: it cannot be put into itself.
function containerAt(p, skip = new Set()) {
  let found = null, best = -1;
  for (const n of state.graph.nodes) {
    if (skip.has(n.id) || !isContainer(n) || n.collapsed || !visible(n)) continue;
    const d = depthOf(n);
    if (inRect(p, fieldRect(n)) && d >= best) { found = n.id; best = d; }
  }
  return found;
}
const cursorRect = p => ({ x: p.x, y: p.y, w: 0, h: 0 });
// Link preview while dragging: a line with an arrow follows the cursor, and over a block it lies the way the finished link will.
function showPreview(a, b) { const temp = $('#edge-temp'); if (!temp) return; temp.removeAttribute('hidden'); temp.setAttribute('d', edgeGeometry(a, b).d); }
function hidePreview() { $('#edge-temp')?.setAttribute('hidden', ''); }
function markDrop(id) { document.querySelectorAll('.block.drop').forEach(el => el.classList.remove('drop')); if (id) blockEl(id)?.classList.add('drop'); }
// Highlight of the sub-map field where the dragged node will land.
function markLevel(id) { document.querySelectorAll('.sub.drop-target').forEach(el => el.classList.remove('drop-target')); if (id) blockEl(id)?.querySelector(':scope > .sub')?.classList.add('drop-target'); }
// A node and everything in its sub-map.
function nestedIn(id) {
  const inside = new Set([id]);
  for (let changed = true; changed; ) { changed = false; for (const n of state.graph.nodes) if (!inside.has(n.id) && inside.has(n.parentId)) { inside.add(n.id); changed = true; } }
  return inside;
}
// Moving a node to another level: into the sub-map field under the pointer or to the main map. Coordinates are recomputed
// in the new level's system, inside a sub-map not left of or above the field. The server moves attached notes together
// with the block; a note attaches to the block of the new level it was dropped on, otherwise it is detached.
async function moveToLevel(n, target, p) {
  const r = worldRect(n), o = target ? subOrigin(node(target)) : { x: 0, y: 0 };
  const x = target ? Math.max(0, Math.round(r.x - o.x)) : Math.round(r.x), y = target ? Math.max(0, Math.round(r.y - o.y)) : Math.round(r.y);
  const patch = { parentId: target, x, y };
  if (isNote(n)) patch.attachedTo = blockNear(p, n.id, 0, target);
  // Locally, as the server will do it, so the container grows to fit the new content and saves its size in the same write.
  for (const note of notesOf(n.id)) { note.x += x - n.x; note.y += y - n.y; note.parentId = target; }
  Object.assign(n, patch);
  const where = target ? t('into "{name}"', { name: nodeName(node(target)) }) : t('to the main map');
  await commit([{ type: 'update-node', id: n.id, patch }, ...growOps(target)], t(isNote(n) ? 'Moved note "{name}" {where}' : 'Moved block "{name}" {where}', { name: nodeName(n), where }));
}
async function flushPending() { if (state.pending && !interacting()) { state.pending = false; await liveRefresh(state.wanted); } }

// Pointer: dragging nodes, resizing, links, panning, pinch

const pointers = new Map();
function onPointerDown(e) {
  stopGlide();
  if (state.menu && !e.target.closest('#menu')) closeMenu();
  const vp = $('#viewport'); if (!vp || !vp.contains(e.target)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    state.gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), view: { ...state.view } };
    return;
  }
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
  if (e.target.closest('#tools, #menu, .zoom-bar, #edits, #health, input, textarea, [data-fold], [data-pen]')) return;
  // Pointer capture on the node itself: then pointerup, click and dblclick come to it, not to the canvas.
  const capture = el => { try { el.setPointerCapture(e.pointerId); } catch { /* the pointer is already released */ } };
  const blockElement = e.target.closest('.block');
  if (state.connectFrom) {
    const from = state.connectFrom; stopConnect();
    if (blockElement && blockElement.dataset.id !== from) connect(from, blockElement.dataset.id).catch(fail);
    return;
  }
  if (state.rebind) {
    const { edgeId, end } = state.rebind; stopConnect();
    if (blockElement) rebindEdge(edgeId, end, blockElement.dataset.id).catch(fail);
    return;
  }
  const cross = e.target.closest('.edge-x');
  if (cross) { select({ type: 'edge', id: cross.dataset.edge }); deleteSelected(); return; }
  // A link starts from a block's edge (a strip along the whole outline), from the port circle, or from anywhere on the block
  // with Alt. The circle wins over a link handle at the same point; the resize corner wins over the edge.
  const resizing = e.target.closest('[data-resize]');
  const portBlock = resizing ? null : e.altKey && blockElement && !isNote(node(blockElement.dataset.id)) ? blockElement
    : (e.target.closest('[data-port]') ?? document.elementsFromPoint(e.clientX, e.clientY).find(el => el.matches?.('.port')))?.closest('.block');
  if (portBlock && state.editing !== portBlock.dataset.id) {
    if (state.editing) finishEdit();
    state.gesture = { type: 'connect', from: portBlock.dataset.id, x: e.clientX, y: e.clientY };
    capture(portBlock); return;
  }
  const handle = e.target.closest('.edge-handle');
  if (handle) {
    if (state.editing) finishEdit();
    if (state.selected?.id !== handle.dataset.edge) select({ type: 'edge', id: handle.dataset.edge });
    state.gesture = { type: 'rebind', edgeId: handle.dataset.edge, end: handle.dataset.handle, x: e.clientX, y: e.clientY };
    document.querySelector(`.edge-group[data-edge="${CSS.escape(handle.dataset.edge)}"]`)?.classList.add('rebinding');
    capture(handle); return;
  }
  if (blockElement && state.editing === blockElement.dataset.id) return;
  if (blockElement && e.target.closest('[data-resize]')) {
    if (state.editing) finishEdit();
    // The gesture starts from the shown size: an expanded sub-map can be larger than the saved one.
    const n = node(blockElement.dataset.id), shown = layoutSize(n);
    state.gesture = { type: 'resize', id: n.id, w: shown.w, h: shown.h, x: e.clientX, y: e.clientY };
    capture(blockElement); return;
  }
  if (blockElement) {
    if (state.editing) finishEdit();
    const n = node(blockElement.dataset.id);
    // Attached notes travel with the block as one group.
    const group = [n, ...(isNote(n) ? [] : notesOf(n.id))].map(x => ({ id: x.id, ox: x.x, oy: x.y }));
    state.gesture = { type: 'drag', id: n.id, x: e.clientX, y: e.clientY, moved: false, group, skip: nestedIn(n.id) };
    capture(blockElement); return;
  }
  const edgeElement = e.target.closest('[data-edge]');
  if (edgeElement) { if (state.editing) finishEdit(); select({ type: 'edge', id: edgeElement.dataset.edge }); return; }
  state.gesture = { type: 'pan', x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false };
  capture(vp); vp.classList.add('panning');
}
function moveNode(id, x, y) {
  const n = node(id), el = blockEl(id); if (!n || !el) return;
  n.x = x; n.y = y; el.style.left = `${x}px`; el.style.top = `${y}px`;
}
// Container sizes depend on their content: after a node is moved or resized they are recomputed along the whole chain.
function relayout() {
  sizes = new Map();
  for (const el of document.querySelectorAll('.block.container')) { const n = node(el.dataset.id); if (!n) continue; const s = layoutSize(n); el.style.width = `${s.w}px`; el.style.height = `${s.h}px`; }
}
function onPointerMove(e) {
  // A release the page did not see (for example, on a scroll bar) does not hold the update past the next mouse move.
  if (!e.buttons && pressed.delete(e.pointerId) && !pressed.size) released();
  state.pointer = { x: e.clientX, y: e.clientY };
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = state.gesture; if (!g) return;
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  switch (g.type) {
    // The person moves the view or the map: following turns off.
    case 'pan': {
      if (!g.moved && Math.hypot(dx, dy) > 3) { g.moved = true; setFollow(false); }
      state.view.x = g.vx + dx; state.view.y = g.vy + dy; applyView(); break;
    }
    case 'drag': {
      if (!g.moved && Math.hypot(dx, dy) <= 3) break;
      if (!g.moved) { g.moved = true; setFollow(false); blockEl(g.id)?.classList.add('dragging'); }
      const n = node(g.id), p = toWorld(e.clientX, e.clientY);
      let level = containerAt(p, g.skip);
      if (focusIds && !focusIds.has(level)) level = n.parentId; // in focus the node does not leave the module
      let wx = Math.round(dx / state.view.z), wy = Math.round(dy / state.view.z);
      // While the pointer is over its own sub-map field, the group does not go left of or above the field; the shift is shared, otherwise notes lag behind.
      // Outside the field the node moves freely: release it on the main map or in another sub-map to move it there.
      if (n.parentId && level === n.parentId) for (const m of g.group) { if (m.ox >= 0) wx = Math.max(wx, -m.ox); if (m.oy >= 0) wy = Math.max(wy, -m.oy); }
      for (const m of g.group) moveNode(m.id, m.ox + wx, m.oy + wy);
      markLevel(level !== n.parentId ? level : null);
      if (isNote(n)) markDrop(blockNear(p, g.id, 0, level));
      drawEdges(); positionFloat(); break;
    }
    case 'resize': {
      const n = node(g.id), el = blockEl(g.id); if (!n || !el) break;
      if (!g.moved && (dx || dy)) { g.moved = true; setFollow(false); }
      n.w = clamp(Math.round(g.w + dx / state.view.z), 120, 20000); n.h = clamp(Math.round(g.h + dy / state.view.z), 60, 20000);
      // An expanded sub-map does not get smaller than its content and keeps exactly the size that is shown.
      if (isContainer(n)) { sizes = new Map(); const c = contentSize(n); n.w = clamp(Math.max(n.w, c.w), 120, 20000); n.h = clamp(Math.max(n.h, c.h), 60, 20000); }
      sizes = new Map(); const s = layoutSize(n);
      el.style.width = `${s.w}px`; el.style.height = `${s.h}px`;
      relayout(); drawEdges(); positionFloat(); break;
    }
    case 'rebind': {
      const edge = edgeOf(g.edgeId); if (!edge) break;
      const fixed = node(g.end === 'source' ? edge.target : edge.source), p = toWorld(e.clientX, e.clientY);
      const target = blockNear(p, fixed.id), other = target ? worldRect(node(target)) : cursorRect(p);
      showPreview(g.end === 'source' ? other : worldRect(fixed), g.end === 'source' ? worldRect(fixed) : other);
      markDrop(target); break;
    }
    case 'connect': {
      const from = node(g.from); if (!from) break;
      const p = toWorld(e.clientX, e.clientY), target = linkTarget(p, g.from);
      showPreview(worldRect(from), target ? worldRect(node(target)) : cursorRect(p));
      markDrop(target); break;
    }
    case 'pinch': {
      const [a, b] = [...pointers.values()]; if (!b) break;
      const r = $('#viewport').getBoundingClientRect(), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const z = clamp(g.view.z * Math.hypot(a.x - b.x, a.y - b.y) / g.dist, ZOOM.min, ZOOM.max);
      setFollow(false);
      state.view = { x: mx - (mx - g.view.x) * z / g.view.z, y: my - (my - g.view.y) * z / g.view.z, z };
      applyView(); break;
    }
  }
}
// The last pressed pointer is released: home draws the list after the click, the map reads the held-back edit.
function released() { if (page.kind === 'home') { if (home.held) setTimeout(renderHome); } else flushPending(); }
async function onPointerUp(e) {
  pointers.delete(e.pointerId); pressed.delete(e.pointerId);
  const g = state.gesture;
  // A press without a gesture: chevron, panel, menu, home row.
  if (!g) { if (!pressed.size) released(); return; }
  if (g.type === 'pinch') { if (pointers.size < 2) state.gesture = null; return; }
  state.gesture = null;
  $('#viewport')?.classList.remove('panning');
  markDrop(null);
  try {
    switch (g.type) {
      case 'pan': if (!g.moved) select(null); break;
      case 'drag': {
        blockEl(g.id)?.classList.remove('dragging'); markLevel(null);
        const n = node(g.id); if (!n) break;
        if (!g.moved) { select({ type: 'node', id: g.id }); break; }
        if (state.fresh.has(g.id)) break;
        const p = toWorld(e.clientX, e.clientY);
        let level = containerAt(p, g.skip);
        if (focusIds && !focusIds.has(level)) level = n.parentId;
        if (level !== n.parentId) { await moveToLevel(n, level, p); break; }
        const patch = { x: n.x, y: n.y };
        let message = t(isNote(n) ? 'Moved note "{name}"' : 'Moved block "{name}"', { name: nodeName(n) });
        if (isNote(n)) {
          // A note released on a block of its own level attaches to it. It can be detached from the menu.
          const target = blockNear(p, g.id, 0, n.parentId);
          if (target && target !== n.attachedTo) { patch.attachedTo = target; n.attachedTo = target; message = t('Attached note "{name}"', { name: nodeName(n) }); }
        }
        await commit([{ type: 'update-node', id: g.id, patch }, ...growOps(n.parentId)], message); break;
      }
      case 'resize': {
        const n = node(g.id); if (!n || state.fresh.has(g.id)) break;
        await commit([{ type: 'update-node', id: g.id, patch: { w: n.w, h: n.h } }, ...growOps(n.parentId)], t(isNote(n) ? 'Changed size of note "{name}"' : 'Changed size of block "{name}"', { name: nodeName(n) })); break;
      }
      case 'rebind': {
        hidePreview();
        document.querySelector('.edge-group.rebinding')?.classList.remove('rebinding');
        const edge = edgeOf(g.edgeId); if (!edge) break;
        const target = blockNear(toWorld(e.clientX, e.clientY), g.end === 'source' ? edge.target : edge.source);
        if (target) await rebindEdge(g.edgeId, g.end, target); else drawEdges();
        hoverEdge(null);
        break;
      }
      case 'connect': {
        // A link appears only on release over a block; a drop on empty space creates nothing.
        hidePreview();
        const target = linkTarget(toWorld(e.clientX, e.clientY), g.from);
        if (target) await connect(g.from, target);
        break;
      }
    }
  } catch (err) { await recover(err); }
  await flushPending();
}
// Hovering a link (its line, label, handle or cross) shows its handles and cross.
document.addEventListener('pointerover', e => {
  const edgeElement = e.target.closest?.('[data-edge]');
  if (edgeElement && !state.gesture) hoverEdge(edgeElement.dataset.edge);
});
document.addEventListener('pointerout', e => {
  if (!e.target.closest?.('[data-edge]') || state.gesture) return;
  const next = e.relatedTarget?.closest?.('[data-edge]');
  if (next && next.dataset.edge === state.hoverEdge) return;
  clearTimeout(hoverEdge.timer);
  hoverEdge.timer = setTimeout(() => { if (!state.gesture) hoverEdge(null); }, 150);
});
// Hovering a block highlights its links.
document.addEventListener('pointerover', e => {
  const blockElement = e.target.closest?.('.block'); if (!blockElement || state.gesture || !state.graph) return;
  const id = blockElement.dataset.id;
  for (const edge of state.graph.edges) if (edge.source === id || edge.target === id) document.querySelector(`.edge-group[data-edge="${CSS.escape(edge.id)}"]`)?.classList.add('related');
});
document.addEventListener('pointerout', e => {
  if (e.target.closest?.('.block') && !e.target.closest('.block').contains(e.relatedTarget)) document.querySelectorAll('.edge-group.related').forEach(el => el.classList.remove('related'));
});
// A press is noted before all other handlers; a new primary press clears the presses whose release was lost.
document.addEventListener('pointerdown', e => { if (e.isPrimary) pressed.clear(); pressed.add(e.pointerId); }, true);
window.addEventListener('blur', () => { if (pressed.size) { pressed.clear(); released(); } });
document.addEventListener('pointerdown', onPointerDown);
document.addEventListener('pointermove', onPointerMove);
document.addEventListener('pointerup', onPointerUp);
document.addEventListener('pointercancel', onPointerUp);
document.addEventListener('wheel', e => {
  const vp = $('#viewport'); if (!vp || !vp.contains(e.target) || e.target.closest('textarea')) return;
  e.preventDefault(); stopGlide(); setFollow(false);
  if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
  else { state.view.x -= e.deltaX; state.view.y -= e.deltaY; applyView(); }
}, { passive: false });
document.addEventListener('dblclick', e => {
  const vp = $('#viewport'); if (!vp || !vp.contains(e.target)) return;
  if (e.target.closest('#tools, #menu, .zoom-bar, #edits, #health, input, textarea, [data-fold], [data-pen]')) return;
  const blockElement = e.target.closest('.block');
  // A block with a sub-map opens, diving one level down; a block without a sub-map and a note are edited.
  if (blockElement) {
    const n = node(blockElement.dataset.id); if (!n || state.editing === n.id) return;
    if (isContainer(n)) { walk(() => dive(n.id)); return; }
    const under = document.elementFromPoint(e.clientX, e.clientY); startEdit(n.id, under?.closest('.b-text') || isNote(n) ? 'text' : 'title'); return;
  }
  if (e.target.closest('[data-edge]')) { $('#edge-label')?.focus(); return; }
  // Empty space in a sub-map field is part of its block: dive into it. Empty space outside blocks and the field of the
  // block already open go one level up.
  const inside = containerAt(toWorld(e.clientX, e.clientY));
  if (inside && inside !== state.focus) walk(() => dive(inside)); else if (state.focus) walk(goUp);
});
document.addEventListener('contextmenu', e => {
  const vp = $('#viewport'); if (!vp || !vp.contains(e.target) || e.target.closest('input, textarea')) return;
  e.preventDefault();
  if (state.editing) finishEdit();
  if (state.connectFrom || state.rebind) stopConnect();
  const blockElement = e.target.closest('.block'), edgeElement = e.target.closest('[data-edge]');
  let target;
  if (blockElement) target = { type: 'node', id: blockElement.dataset.id };
  else if (edgeElement) target = { type: 'edge', id: edgeElement.dataset.edge };
  // In focus, empty space is the module's field: a new node goes inside the focus block.
  else target = { type: 'canvas', container: containerAt(toWorld(e.clientX, e.clientY)) ?? state.focus };
  if (target.type !== 'canvas') select(target);
  openMenu(e.clientX, e.clientY, target);
});

// Button clicks

document.addEventListener('click', async e => {
  const control = e.target.closest('button'); if (!control) return;
  // The language switch, on home and in the map's control bar.
  if (control.dataset.lang) return setLang(control.dataset.lang).catch(fail);
  // Home: the line for the agent and the project's trash button.
  if (control.hasAttribute('data-copy-agent')) return copyAgent().catch(fail);
  if (control.dataset.trash) { control.disabled = true; return deleteProject(control.dataset.trash).catch(err => { control.disabled = false; fail(err); }); }
  // A virtual machine's access request and disconnecting a machine.
  if (control.dataset.pairApprove || control.dataset.pairDeny) return answerPair(control, Boolean(control.dataset.pairApprove));
  if (control.dataset.revoke) { control.disabled = true; return api(`/api/devices/${encodeURIComponent(control.dataset.revoke)}/revoke`, {}).then(info => { setAccess(info); toast(t('Machine disconnected')); }, err => { control.disabled = false; fail(err); }); }
  // await is required: without it a save error slips past the catch.
  try {
    if (control.dataset.menu) return await runMenu(control.dataset.menu);
    if (control.dataset.tab) return await showTab(control.dataset.tab);
    if (control.dataset.health) return await nextIssue(control.dataset.health);
    if (control.dataset.reviewHours) { state.reviewHours = Number(control.dataset.reviewHours); return await showHistory(); }
    if (control.dataset.focusOn) return await walk(() => dive(control.dataset.focusOn));
    if (control.dataset.focusAct) {
      const n = node(state.focus); if (!n) return;
      return await createInside(n, control.dataset.focusAct);
    }
    if (control.hasAttribute('data-fold')) {
      const n = node(control.closest('.block').dataset.id); if (!n) return;
      return await toggleFold(n);
    }
    // The pencil in a block's corner edits the title and text at once, for a block with a sub-map too.
    if (control.hasAttribute('data-pen')) return startEdit(control.closest('.block').dataset.id, 'title');
    if (control.dataset.color !== undefined && state.selected?.type === 'node') {
      const n = node(state.selected.id); n.color = control.dataset.color;
      return await commit([{ type: 'update-node', id: n.id, patch: { color: n.color } }], t(isNote(n) ? 'Changed note "{name}"' : 'Changed block "{name}"', { name: nodeName(n) }));
    }
    switch (control.dataset.action) {
      case 'zoom-in': zoomCenter(1.2); break;
      case 'zoom-out': zoomCenter(1 / 1.2); break;
      // "Show all" always fits the whole map and turns following on.
      case 'fit': setFollow(true); state.followIds = null; fitView(); break;
      case 'health':
        state.health = !state.health;
        control.classList.toggle('active', state.health); control.setAttribute('aria-pressed', String(state.health));
        if (state.tab !== 'map') await showTab('map'); else paintCode();
        break;
      case 'unfocus': await walk(exitFocus); break;
      case 'edits-done': control.disabled = true; await finishEdits(); break;
      case 'proposal-accept': case 'proposal-reject': control.disabled = true; await decideProposal(control.dataset.action === 'proposal-accept'); break;
      case 'delete': await deleteSelected(); break;
      case 'connect': if (state.selected?.type === 'node') startConnect(state.selected.id); break;
      case 'swap': await swapEdge(); break;
    }
  } catch (err) { await recover(err); }
});
document.addEventListener('change', async e => {
  if (e.target.id === 'edge-label' && state.selected?.type === 'edge') {
    const edge = edgeOf(state.selected.id), label = e.target.value.trim();
    if (edge && label !== edge.label) { edge.label = label; await commit([{ type: 'update-edge', id: edge.id, patch: { label } }], t('Changed link label')).catch(recover); }
  }
});
document.addEventListener('focusout', e => {
  if (!e.target.isConnected) return; // the field was removed by a redraw, not by the user
  if (state.editing && e.target.matches('.b-title-input, .b-text-input')) {
    const block = e.target.closest('.block');
    if (!block.contains(e.relatedTarget)) finishEdit();
  }
});
document.addEventListener('keydown', e => {
  if (!$('#viewport')) return;
  if (state.menu) {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    const buttons = [...$('#menu').querySelectorAll('button')], i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
    return;
  }
  // An input field takes the keys for itself. The level slider takes only the arrows: after a click on it Delete, Enter
  // and Tab still act on the selected block.
  if (e.target.matches('input:not([type="range"]), textarea')) {
    if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); if (state.connectFrom || state.rebind) stopConnect(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && state.editing) { e.preventDefault(); finishEdit(); return; }
    if (e.key === 'Enter' && e.target.classList.contains('b-title-input')) { e.preventDefault(); part(e.target.closest('.block'), 'b-text-input')?.focus(); return; }
    if (e.key === 'Enter' && e.target.id === 'edge-label') { e.preventDefault(); e.target.blur(); }
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) { e.preventDefault(); deleteSelected(); return; }
  // Esc finishes an edit (the cursor may have left the field while the edit stayed open), then clears the selection, and
  // when there is neither an edit nor a selection, goes one level up.
  if (e.key === 'Escape') {
    if (state.connectFrom || state.rebind) stopConnect();
    else if (state.editing) { finishEdit(); return; }
    else if (!state.selected && state.focus) walk(goUp);
    select(null); return;
  }
  if (e.key === 'Enter' && state.selected?.type === 'node') { e.preventDefault(); startEdit(state.selected.id, 'text'); return; }
  if (e.key === 'Enter' && state.selected?.type === 'edge') { e.preventDefault(); $('#edge-label')?.focus(); return; }
  if (e.key === 'Tab' && state.selected?.type === 'node' && !e.shiftKey && !isNote(node(state.selected.id))) { e.preventDefault(); const n = node(state.selected.id); createNode({ type: 'block', parentId: n.parentId, x: n.x + layoutSize(n).w + 90, y: n.y, from: n.id }); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomCenter(1.2); }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomCenter(1 / 1.2); }
  if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); stopGlide(); setFollow(true); state.followIds = null; fitView(); }
});

// Levels: the slider collapses sub-maps deeper than the chosen level and expands the rest.
// Concept: all sub-maps collapsed; mechanics: the sub-maps of the main map visible; technical: the sub-maps of
// mechanics too; code: everything expanded.

const foldedAt = (level, n) => level < LEVELS.length && depthOf(n) >= level - 1;
// A level fits a sub-map if the sub-map is collapsed the way the level collapses it. Sub-maps inside code are code too:
// "Code" fits collapsed ones as well, otherwise in a dive into technical with sub-maps under steps no level would light up.
const fits = (level, n) => n.collapsed === foldedAt(level, n) || (level === LEVELS.length && depthOf(n) >= LEVELS.length - 1);
// In a dive the slider acts only inside the open block: the block itself and the path to it stay expanded.
// The block is taken from the current map, not from the last render: after 409 the map is re-read before the redraw.
const levelContainers = () => {
  const inside = state.focus ? focusSet(state.focus) : null;
  return state.graph.nodes.filter(n => isContainer(n) && (!inside || (inside.has(n.id) && n.id !== state.focus)));
};
// The current level comes from the visible sub-maps: what lies inside collapsed ones is not on screen. If several levels
// fit what is visible, the one pressed last lights up, otherwise the one the map is visible down to (in a dive, the level
// of the blocks inside the open block).
const shownLevel = () => Math.min(Math.max(0, ...state.graph.nodes.filter(visible).map(depthOf)) + 1, LEVELS.length);
function currentLevel() {
  if (!state.graph.nodes.some(isContainer)) return 0;
  const containers = levelContainers().filter(visible), ok = level => containers.every(n => fits(level, n));
  if (state.level && ok(state.level)) return state.level;
  const shown = shownLevel();
  return ok(shown) ? shown : 0;
}
// The slider: ticks for the levels, filled up to the chosen one, its name next to it. If no level fits the map (sub-maps
// collapsed unevenly with chevrons), the thumb stands at the level the map is visible down to, but dim and without a
// name. While the thumb is held with the mouse or the chosen level is still being applied, it does not jump on map updates.
function paintLevel(level) {
  const box = $('#levels'), input = $('#level'); if (!box || !input) return;
  const mixed = box.classList.contains('mixed');
  input.value = level; input.setAttribute('aria-valuetext', mixed ? t('Sub-maps collapsed unevenly') : t(LEVELS[level - 1]));
  box.style.setProperty('--level', (level - 1) / (LEVELS.length - 1));
  box.querySelectorAll('.level-track i').forEach((tick, i) => tick.classList.toggle('on', i < level));
  $('#level-name').textContent = mixed ? '' : t(LEVELS[level - 1]);
}
function renderLevels() {
  const box = $('#levels'), input = $('#level'); if (!box || !input || !state.graph) return;
  const level = currentLevel();
  input.disabled = !state.graph.nodes.some(n => isContainer(n));
  box.dataset.level = level || '';
  if (input.matches(':active') || picks) return;
  box.classList.toggle('mixed', !level && !input.disabled);
  paintLevel(level || shownLevel());
}
// A choice on the slider joins the queue of moves, like dives, and the step applies the level chosen last. Until the
// steps are done, the slider shows the choice: a redraw after a write would move the thumb back, and the next step,
// arrow or click would count from the old level.
let picked = 0, picks = 0;
function pickLevel(level) {
  picked = level; picks++;
  walk(() => showLevel(picked)).finally(() => { if (!--picks) renderLevels(); });
}
async function showLevel(level) {
  state.level = level;
  const ops = () => foldOps(levelContainers().map(n => [n, foldedAt(level, n)])), first = ops();
  if (first.length) await commit(first, t('Showed level "{level}"', { level: t(LEVELS[level - 1]) }), ops); else renderLevels();
  fitView();
}

// Focus: working on one module. The map shows only it with everything nested, with the path to it and actions on top. The
// chat shows the conversation about the module, new messages carry it, the agent sees what the person is working on.

const focusSet = id => { const ids = nestedIn(id); for (const n of state.graph.nodes) if (n.attachedTo === id) ids.add(n.id); return ids; };
const ancestorsOf = n => { const chain = []; for (let p = n.parentId; p; p = node(p)?.parentId) chain.unshift(node(p)); return chain.filter(Boolean); };
// Level moves run in turn: the next one counts from the focus the previous one ended in.
let travel = Promise.resolve();
function walk(step) {
  const gen = page.gen;
  state.walking++;
  travel = travel.then(() => gen === page.gen && state.graph ? step() : null).catch(recover).finally(() => { if (gen === page.gen) state.walking--; });
  return travel;
}
// Collapsing in one write, as with the level slider: it does not wake agents. Deep sub-maps first, then outer ones, so
// neighbours move apart for the final size. In focus the first change of each sub-map is remembered, whether by a dive,
// the slider or a chevron: leaving returns the map to how it was before focus.
function foldOps(list) {
  const ops = list.filter(([x, folded]) => x.collapsed !== folded).sort(([a], [b]) => depthOf(b) - depthOf(a)).map(([x, folded]) => {
    if (state.focus && !state.focusFolds.has(x.id)) state.focusFolds.set(x.id, x.collapsed);
    x.collapsed = folded; return { type: 'update-node', id: x.id, patch: { collapsed: folded } };
  });
  if (state.focus && ops.length) saveDive();
  return ops;
}
// The chevron and the menu item. The message is built after the toggle. After 409 the operation is built from the re-read
// map: a sub-map the agent has collapsed or expanded meanwhile is not toggled back by repeating the old one.
function toggleFold(n) {
  const id = n.id, want = !n.collapsed, ops = foldOps([[n, want]]);
  return commit(ops, t(want ? 'Collapsed sub-map "{name}"' : 'Expanded sub-map "{name}"', { name: nodeName(n) }), () => { const m = node(id); return m && isContainer(m) ? foldOps([[m, want]]) : []; });
}
// What leaving a dive will restore is also remembered in the tab: it may be reloaded, and the request on page close may
// not get through. Then the next opening of the project in this tab restores the collapsing. now is what focus set.
const diveKey = id => `mycel.dive.${id}`;
function saveDive() { tabPrefs.set(diveKey(page.id), JSON.stringify([...state.focusFolds].map(([id, was]) => [id, was, node(id)?.collapsed ?? was]))); }
function undive(id) {
  let saved = null;
  try { saved = JSON.parse(tabPrefs.get(diveKey(id))); } catch { saved = null; }
  tabPrefs.del(diveKey(id));
  if (!Array.isArray(saved)) return [];
  // Only sub-maps nobody has changed since: the request on close may have got through after all.
  const back = saved.filter(e => Array.isArray(e) && typeof e[1] === 'boolean' && e[1] !== e[2]).map(([x, was, now]) => [node(x), was, now]);
  return foldOps(back.filter(([x, , now]) => x && isContainer(x) && x.collapsed === now));
}
// Clears the focus; returns a builder of operations for one write that restore the collapsing changed by dives.
// After 409 the builder is called again on the re-read map.
function restoreOps() {
  const back = [...state.focusFolds];
  state.focus = null; state.level = 0; state.focusFolds = new Map();
  return () => foldOps(back.map(([id, was]) => [node(id), was]).filter(([x]) => x && isContainer(x)));
}
// Diving into a block: focus on it, its sub-map and everything on the path to it expanded, the sub-maps of its blocks
// collapsed, so exactly one level down is visible. The view moves smoothly to the block. The first dive remembers the map view.
// An open edit is saved first: a collapsed sub-map would remove its field.
async function dive(id) {
  const gen = page.gen;
  if (state.editing) await finishEdit();
  if (state.tab !== 'map') await showTab('map');
  const n = node(id); if (gen !== page.gen || !n || isNote(n)) return;
  if (!state.focus) Object.assign(state, { focusView: { ...state.view }, focusSince: new Date().toISOString(), focusFolds: new Map() });
  state.focus = id; state.level = 0;
  select(null);
  // After 409, anew from the re-read map: sub-maps the agent added to the block collapse too.
  const plan = () => { const m = node(id); return m ? foldOps([...childrenOf(id).filter(isContainer).map(k => [k, true]), ...[m, ...ancestorsOf(m)].filter(isContainer).map(x => [x, false])]) : []; };
  const ops = plan();
  if (ops.length) await commit(ops, t('Opened block "{name}"', { name: nodeName(n) }), plan); else renderMap();
  glide(); fitView();
  papi('/focus', { id }).catch(() => {});
}
// One level up: the block above opens, and from a top block the whole map.
async function goUp() {
  const n = state.focus && node(state.focus); if (!n) return;
  if (n.parentId && node(n.parentId)) await dive(n.parentId); else await exitFocus();
}
// Back to the main map: the collapsing changed by dives is restored in one write; the view is the former one,
// and in follow mode the map is fitted whole again.
async function exitFocus() {
  if (!state.focus) return;
  if (state.editing) await finishEdit();
  const plan = restoreOps(), ops = plan();
  papi('/focus', { id: null }).catch(() => {});
  if (ops.length) await commit(ops, t('Showed the whole map'), plan); else renderMap();
  tabPrefs.del(diveKey(page.id));
  if (state.follow) autoFit(null);
  else if (state.focusView) { glide(); state.view = state.focusView; applyView(); }
}
// The person's edits: their first write that changes the map's content starts them on the server, and "Finish edits"
// appears at the bottom middle of the map. Until it is pressed, the agent does not answer these edits; the button hands
// them over as one message in the chat.
// While an agent proposal is open, the button's place holds its title and "Reject" / "Accept": the decision finishes the edits too.
function renderEdits() {
  const el = $('#edits'); if (!el) return;
  const proposal = state.graph?.proposal, html = proposal
    ? `<span class="edits-title" title="${esc(proposal.title)}">${esc(t('Proposal "{title}"', { title: proposal.title }))}</span><span class="edits-count" title="${t('Cards in the proposal')}">${state.graph.nodes.filter(n => n.proposed).length}</span><button type="button" class="btn ghost" data-action="proposal-reject">${t('Reject')}</button><button type="button" class="btn" data-action="proposal-accept">${t('Accept')}</button>`
    : state.edit ? `<button type="button" class="btn" data-action="edits-done">${t('Finish edits')}</button><span class="edits-count" title="${t('Entries since the edits started')}">${state.edit.count}</span>` : '';
  el.hidden = !html;
  if (el.innerHTML !== html) el.innerHTML = html;
}
// A decision on an agent proposal: what is accepted stays (new things as a plan, dashed), what is rejected leaves the map.
async function decideProposal(accept) {
  if (state.editing) await finishEdit();
  await Promise.allSettled([...saving]);
  const gen = page.gen, { graph, message } = await papi(`/proposal/${accept ? 'accept' : 'reject'}`, {});
  if (gen !== page.gen) return;
  if (graph.revision > state.graph.revision) { adopt(graph); renderMap(); }
  state.edit = null; renderEdits();
  toast(message.proposal.result === 'accepted' ? t('Proposal accepted') : t('Proposal rejected'));
}
async function finishEdits() {
  // An open text edit and writes still running are part of the edits too.
  if (state.editing) await finishEdit();
  await Promise.allSettled([...saving]);
  const gen = page.gen, { message } = await papi('/edits', {});
  if (gen !== page.gen) return;
  state.edit = null; renderEdits();
  if (message) toast(t('Edits sent to the agent'));
}
function renderFocus() {
  const bar = $('#focus-bar'); if (!bar) return;
  const n = state.focus && node(state.focus);
  bar.hidden = !n || state.tab !== 'map';
  $('#app').classList.toggle('focused', Boolean(n));
  if (!n) return;
  const ref = x => `<button type="button" class="ref" data-focus-on="${esc(x.id)}">${esc(nodeName(x))}</button>`;
  bar.innerHTML = `<nav class="focus-path"><button type="button" class="ref" data-action="unfocus">${t('Map')}</button>${ancestorsOf(n).map(a => `<i>›</i>${ref(a)}`).join('')}<i>›</i><b>${esc(nodeName(n))}</b></nav>
    <span class="grow"></span>
    <button type="button" class="btn ghost" data-focus-act="block">${t('Block inside')}</button><button type="button" class="btn ghost" data-focus-act="note">${t('Note')}</button>
    <button type="button" class="icon-btn" data-action="unfocus" title="${t('Leave focus')}" aria-label="${t('Leave focus')}">${icon('close', 16)}</button>`;
}

// Agents. The conversation with the agent happens in its window; Mycel has no chat. Here there is only the dot in the
// control bar (who is connected: green waits for the person's actions, yellow is working) and the line above it: what the agent is doing now.

// An agent is connected while it waits for changes; busy if it made a request in the last 10 minutes.
function agentState(a) { return a.waiting ? 'on' : Date.now() - new Date(a.lastSeen).getTime() < 600000 ? 'busy' : 'off'; }
const barHtml = () => `
    <a class="back" href="#/">‹ ${esc(page.name)}</a>
    <nav class="tabs"><button type="button" data-tab="map" class="active">${t('Map')}</button><button type="button" data-tab="history">${t('History')}</button></nav>
    <div class="levels" id="levels"><div class="level-track">${LEVELS.map((_, i) => `<i style="left: calc(7px + (100% - 14px) * ${i / (LEVELS.length - 1)})"></i>`).join('')}<input type="range" id="level" min="1" max="${LEVELS.length}" step="1" value="${LEVELS.length}" aria-label="${t('Level')}"></div><span class="level-name"><span id="level-name"></span>${LEVELS.map(name => `<span>${t(name)}</span>`).join('')}</span></div>
    <nav class="tabs"><button type="button" data-action="health" id="health-toggle"${state.health ? ' class="active"' : ''} aria-pressed="${state.health}" title="${t('What is wrong with blocks: failed, outdated, unchecked, risks')}">${t('Health')}</button></nav>
    <span class="grow"></span>
    <span id="status" role="status"></span>
    <span class="agents" id="agents"></span>
    <a class="icon-btn" href="${page.prefix}/export" download title="${t('Download map')}" aria-label="${t('Download map')}">${icon('download', 16)}</a>
    ${langHtml()}`;
// The language switch: plain EN / RU, the chosen one is marked.
const langHtml = () => `<nav class="lang" aria-label="${t('Language')}">${LANGS.map(l => `<button type="button" data-lang="${l}" aria-pressed="${l === lang}" aria-label="${t(LANG_NAMES[l])}">${l.toUpperCase()}</button>`).join('<span aria-hidden="true">/</span>')}</nav>`;
function renderAgents() {
  const el = $('#agents'); if (!el) return;
  el.innerHTML = state.agents.filter(a => agentState(a) !== 'off').map(a => `<i class="dot ${agentState(a)}" title="${esc(a.actor)}"></i>`).join('');
  renderActivity();
}
// What the agent is doing now: a strip above the control bar with who and what, and a bar of segments; without a
// percentage a glow runs along the bar. The agent clears the line itself when it is done.
const SEGMENTS = 20;
function renderActivity() {
  const el = $('#progress'); if (!el) return;
  const a = [...state.activity].sort((x, y) => y.at.localeCompare(x.at))[0];
  $('#progress-row').hidden = !a;
  if (!a) return;
  const known = a.progress !== null && a.progress !== undefined, filled = known ? Math.round(a.progress / 100 * SEGMENTS) : 0;
  el.classList.toggle('unknown', !known); el.classList.remove('complete');
  if (known) el.setAttribute('aria-valuenow', String(a.progress)); else el.removeAttribute('aria-valuenow');
  el.title = `${a.actor}: ${a.text}`;
  el.innerHTML = `<span class="progress-label"><b>${esc(a.actor)}</b> ${esc(a.text)}</span><span class="progress-track">${Array.from({ length: SEGMENTS }, (_, i) =>
    `<i class="${i < filled ? 'on' : i === filled ? 'next' : ''}" style="--i:${i}"></i>`).join('')}</span><span class="progress-value">${known ? `${Math.round(a.progress)}%` : '··'}</span>`;
}
// The hub learns at once what the person selected: "do this" makes sense to the agent without a chat.
function reportSelection() {
  const id = state.selected?.type === 'node' && node(state.selected.id) && !state.fresh.has(state.selected.id) ? state.selected.id : null;
  if (id === reportSelection.last || !page.prefix) return;
  reportSelection.last = id;
  papi('/selection', { id }).catch(() => { reportSelection.last = undefined; });
}// Going to the block the agent shows (mycel show): collapsed sub-maps on the path to it expand, the block is selected
// and centred. A block outside the dive is hidden: then the block it lies in opens, and a main-map block opens on the
// whole map.
// Code through Mycel's eyes. Above a block whose files the agent is editing now is the agent's name (above the collapsed
// sub-map, if the block is in one); a block whose files changed after it was described says "outdated?". An edit fades
// 2 minutes after the last one, blocks from "doing --on" stay until the agent clears them.
const EDITING = 2 * 60e3;
function shownFor(id) { for (let n = node(id); n; n = node(n.parentId)) { const el = blockEl(n.id); if (el) return el; } return null; }
// What is wrong with a block, for "Health" mode; the same analysis as mycel health.
function issuesOf(n) {
  const r = state.code.risks[n.id];
  return [n.status === 'failed' && ['failed', t('failed')], state.code.stale[n.id] && ['stale', t('outdated?')], n.files && !n.test && n.status !== 'passed' && ['untested', t('unchecked')],
    n.status === 'plan' && ['plan', t('plan')], r && (r.todo || r.secrets) && ['risk', [r.todo && `TODO ${r.todo}`, r.secrets && t('key?')].filter(Boolean).join(' · ')]].filter(Boolean);
}
const HEALTH = [['failed', 'Failed'], ['stale', 'Outdated'], ['untested', 'Unchecked'], ['plan', 'Plan'], ['risk', 'Risks']];
function paintCode() {
  const blocks = $('#blocks'); if (!blocks || !state.graph) return;
  blocks.querySelectorAll('.code-row, .health-tag').forEach(el => el.remove());
  blocks.querySelectorAll('.block.working, .block.h-issue').forEach(el => el.classList.remove('working', 'h-issue'));
  const who = new Map();
  for (const w of state.work) {
    if (w.files.length && !w.blocks.length) continue;
    if (w.files.length && Date.now() - Date.parse(w.at) > EDITING && !state.activity.some(a => a.actor === w.actor && a.blocks?.length)) continue;
    for (const id of w.blocks) { const el = shownFor(id); if (el) who.set(el, new Set([...(who.get(el) ?? []), w.actor])); }
  }
  // Outdated and what is wrong: on the visible block; on a collapsed sub-map, as a count for everything in it.
  const health = state.health && state.tab === 'map', stale = new Map(), tags = new Map();
  $('#viewport')?.classList.toggle('health', health);
  for (const n of state.graph.nodes) {
    if (isNote(n)) continue;
    const s = state.code.stale[n.id], issues = health ? issuesOf(n) : [];
    if (!s && !issues.length) continue;
    const el = shownFor(n.id); if (!el) continue;
    if (s && !health) stale.set(el, [...(stale.get(el) ?? []), t('"{name}": {files} ({by})', { name: nodeName(n), files: s.files.join(', '), by: s.by })]);
    const own = tags.get(el) ?? new Map();
    for (const [k, label] of issues) { const c = own.get(k) ?? { label, n: 0 }; c.n++; own.set(k, c); }
    if (issues.length) tags.set(el, own);
  }
  // The agent's name and "outdated?" share one line above the block: when the map is zoomed out they do not overlap.
  for (const el of new Set([...who.keys(), ...stale.keys()])) {
    const actors = who.get(el), lines = stale.get(el);
    if (actors) el.classList.add('working');
    el.insertAdjacentHTML('beforeend', `<span class="code-row">${actors ? `<span class="who">${esc([...actors].join(', '))}</span>` : ''}${lines ? `<span class="stale-tag" title="${esc(t('Files changed after the block was described:\n{lines}', { lines: lines.join('\n') }))}">${esc(lines.length > 1 ? t('outdated: {n}', { n: lines.length }) : t('outdated?'))}</span>` : ''}</span>`);
  }
  const many = { failed: 'failed: {n}', stale: 'outdated: {n}', untested: 'unchecked: {n}', plan: 'plan: {n}', risk: 'risks: {n}' };
  for (const [el, own] of tags) {
    el.classList.add('h-issue');
    el.insertAdjacentHTML('beforeend', `<span class="health-tag">${HEALTH.filter(([k]) => own.has(k)).map(([k]) => { const c = own.get(k); return `<i class="k-${k}">${esc(c.n > 1 ? t(many[k], { n: c.n }) : c.label)}</i>`; }).join('')}</span>`);
  }
  renderHealth();
}
// "Health" mode: at the top left, how many blocks failed, are outdated, unchecked, planned and have risks; a press
// shows the next such block. Healthy blocks fade.
function renderHealth() {
  const vp = $('#viewport'); if (!vp) return;
  let panel = $('#health');
  if (!state.health) { panel?.remove(); return; }
  if (!panel) { vp.insertAdjacentHTML('beforeend', '<div class="health-panel" id="health"></div>'); panel = $('#health'); }
  const count = new Map(HEALTH.map(([k]) => [k, 0]));
  for (const n of state.graph.nodes) if (!isNote(n)) for (const [k] of issuesOf(n)) count.set(k, count.get(k) + 1);
  const html = [...count.values()].some(Boolean)
    ? HEALTH.filter(([k]) => count.get(k)).map(([k, label]) => `<button type="button" class="k-${k}" data-health="${k}">${t(label)} <b>${count.get(k)}</b></button>`).join('')
    : `<span class="health-ok">${t('No failed, outdated or unchecked blocks')}</span>`;
  if (panel.innerHTML !== html) panel.innerHTML = html;
}
// The next block of the chosen kind: round the list, from the one shown now.
function nextIssue(kind) {
  const list = state.graph.nodes.filter(n => !isNote(n) && issuesOf(n).some(([k]) => k === kind));
  if (!list.length) return;
  const at = list.findIndex(n => n.id === nextIssue.last?.[kind]), n = list[(at + 1) % list.length];
  nextIssue.last = { ...nextIssue.last, [kind]: n.id };
  return focusNode(n.id);
}
setInterval(() => { if (state.graph && state.tab === 'map') paintCode(); }, 30000);

async function focusNode(id) {
  if (!node(id)) return;
  const gen = page.gen;
  if (state.tab !== 'map') await showTab('map');
  if (gen !== page.gen) return;
  if (state.focus && !focusSet(state.focus).has(id)) { const up = node(id)?.parentId; await walk(() => up ? dive(up) : exitFocus()); }
  const n = node(id); if (gen !== page.gen || !n) return;
  const folded = []; for (let p = n.parentId; p; p = node(p)?.parentId) if (node(p)?.collapsed) folded.push([node(p), false]);
  if (folded.length) { const name = nodeName(folded[0][0]); await commit(foldOps(folded), t('Expanded sub-map "{name}"', { name })); }
  // The shown block is centred: this is the person's view, following turns off.
  stopGlide(); setFollow(false);
  const r = worldRect(node(id) ?? n), vp = $('#viewport');
  state.view.x = vp.clientWidth / 2 - (r.x + r.w / 2) * state.view.z; state.view.y = vp.clientHeight / 2 - (r.y + r.h / 2) * state.view.z;
  applyView(); select({ type: 'node', id });
}
document.addEventListener('input', e => {
  // While the slider is dragged, only the slider changes; the map collapses when it is released or stepped with a key.
  if (e.target.id === 'level') { $('#levels').classList.remove('mixed'); paintLevel(Number(e.target.value)); }
});
document.addEventListener('change', e => { if (e.target.id === 'level') pickLevel(Number(e.target.value)); });
// A left-button press on the slider: the value and "no level fits" at the moment of the press.
let grab = null;
document.addEventListener('pointerdown', e => {
  grab = e.target.id === 'level' && e.button === 0 && !e.target.disabled ? { pointer: e.pointerId, value: Number(e.target.value), mixed: $('#levels').classList.contains('mixed') } : null;
});
// Released on the value it started from (there will be no change event): if no level fitted the map, this value is
// applied anyway, also when the thumb was moved there and back; otherwise the slider shows the map as it is again.
document.addEventListener('pointerup', e => {
  const g = grab; if (!g || g.pointer !== e.pointerId) return;
  grab = null;
  const value = Number($('#level')?.value);
  if (value !== g.value) return; // the change event applies the level
  if (g.mixed) pickLevel(value); else setTimeout(renderLevels);
});
document.addEventListener('pointercancel', e => { if (grab?.pointer === e.pointerId) { grab = null; setTimeout(renderLevels); } });
// The agent's dot goes out if it has not made a request for a long time: a redraw once a minute.
setInterval(renderAgents, 60000);

// Live update over SSE

// Nodes that are new or changed in next, and the ends of new links: a small map is fitted to them in follow mode.
const TOUCH = ['type', 'parentId', 'attachedTo', 'collapsed', 'title', 'text', 'color', 'x', 'y', 'w', 'h'];
function touched(prev, next) {
  const old = new Map(prev.nodes.map(n => [n.id, n])), edges = new Set(prev.edges.map(e => e.id));
  const ids = next.nodes.filter(n => { const o = old.get(n.id); return !o || TOUCH.some(k => o[k] !== n[k]); }).map(n => n.id);
  for (const e of next.edges) if (!edges.has(e.id)) ids.push(e.source, e.target);
  return ids;
}
// Nodes and links that were not in prev appear; returns how many there are.
function markAppeared(prev, next) {
  const had = new Set([...prev.nodes, ...prev.edges].map(x => x.id)), now = performance.now();
  let added = 0;
  for (const x of [...next.nodes, ...next.edges]) if (!had.has(x.id)) { state.appeared.set(x.id, now); added++; }
  // A changed mark on an existing block flashes; if the block is hidden in a collapsed sub-map, its card flashes.
  const marks = new Map(prev.nodes.map(n => [n.id, n.status])), byId = new Map(next.nodes.map(n => [n.id, n]));
  for (const n of next.nodes) if (marks.has(n.id) && marks.get(n.id) !== n.status && n.status) {
    let shown = n;
    for (let p = byId.get(n.parentId); p; p = byId.get(p.parentId)) if (p.collapsed) shown = p;
    state.remarked.set(shown.id, now);
  }
  return added;
}
// One map request at a time: events during it only raise wanted, and after the answer the map is read further if the
// server has moved on. Only a revision newer than the current one is taken. New nodes and links appear, following fits the map.
async function liveRefresh(revision) {
  if (!state.graph) return;
  if (revision > state.wanted) state.wanted = revision;
  if (state.wanted <= state.graph.revision || state.loading) return;
  if (interacting()) { state.pending = true; return; }
  const gen = page.gen, asked = state.wanted;
  state.loading = true;
  let next;
  try { next = await papi('/graph'); }
  catch (err) { if (gen === page.gen) { state.loading = false; fail(err); } return; }
  if (gen !== page.gen) return;
  state.loading = false;
  // Without new events during the request, the wanted revision is the one the server answered: otherwise the map would
  // re-read a revision the server does not have (the data was restored from a copy) forever.
  if (state.wanted === asked) state.wanted = next.revision;
  if (interacting()) { state.pending = true; return; }
  if (next.revision > state.graph.revision) {
    const prev = state.graph;
    sizes = new Map();
    const before = state.tab === 'map' ? boxOf(fitRoots()) : null, ids = touched(prev, next), added = markAppeared(prev, next);
    // The agent posted a proposal or added to it: the view moves to what is new in it.
    const offered = next.nodes.filter(n => n.proposed && !prev.nodes.some(o => o.id === n.id && o.proposed)).map(n => n.id);
    adopt(next); renderMap();
    const shown = offered.map(node).filter(n => n && visible(n));
    if (shown.length && state.tab === 'map' && !state.focus) { setFollow(false); glide(); state.view = fitTo(boxOf(shown.map(worldRect))); applyView(); }
    else if (state.follow && state.tab === 'map' && (added || !sameBox(before, boxOf(fitRoots())))) autoFit(ids);
    if (state.tab === 'history') await showHistory();
    if (gen !== page.gen) return;
  }
  if (state.wanted > state.graph.revision) liveRefresh(state.wanted);
}

// Routes: #/ is home with the list of projects, #/p/<id> is a project's map. Moving between them does not reload the page.

let routing = Promise.resolve(), notice = null; // notice is a notification to show on the new screen
const route = () => { routing = routing.then(go).catch(err => console.error(err)); };
window.addEventListener('hashchange', route);
async function go() {
  const m = /^#\/p\/([a-z0-9-]{1,60})$/.exec(location.hash), kind = m ? 'project' : 'home', id = m?.[1] ?? null;
  if (page.kind === kind && page.id === id) return;
  await leave();
  Object.assign(page, { kind, id, prefix: id ? `/api/p/${id}` : '', name: '', gone: false });
  if (notice) { toast(notice); notice = null; }
  if (kind === 'home') openHome(); else openProject(id);
}
// Leaving a screen: the open edit and running writes are saved to the old project, the focus is cleared, the event
// stream is closed, the notification is hidden, all project state is reset.
async function leave() {
  if (page.kind === 'project' && !page.gone) {
    if (state.editing) await finishEdit();
    // The dive closes as on leaving it: the collapsing is restored, the agent learns there is no focus.
    await walk(exitFocus);
    await Promise.allSettled([...saving]);
    // A person who has left selects nothing.
    if (reportSelection.last) papi('/selection', { id: null }).catch(() => {});
  }
  reportSelection.last = undefined;
  page.events?.close(); page.events = null;
  clearTimeout(home.timer); home.timer = 0; hideToast();
  page.gen++;
  Object.assign(state, { graph: null, view: null, tab: 'map', selected: null, editing: null, fresh: new Map(), connectFrom: null, rebind: null, hoverEdge: null, gesture: null, menu: null, focus: null, focusView: null, focusSince: null, focusFolds: new Map(), walking: 0, level: 0, pending: false, busy: 0, loading: false, wanted: 0, appeared: new Map(), remarked: new Map(), follow: false, followIds: null, edit: null, agents: [], activity: [], work: [], code: { stale: {}, risks: {} }, health: false, reviewHours: 24 });
  sizes = new Map(); focusIds = null; pointers.clear();
  clearTimeout(hoverEdge.timer); clearTimeout(glide.timer);
  $('#app').classList.remove('focused');
}
// The tab is closed or reloaded in a dive: leaving the dive goes out as requests the browser sends after closing, and
// the map view is the former one. If the write does not get through, the reloaded page restores the collapsing (undive).
window.addEventListener('pagehide', () => {
  if (page.kind !== 'project' || page.gone || !state.graph || !state.focus) return;
  const send = (path, body) => fetch(page.prefix + path, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session?.token}` }, body: JSON.stringify(body) }).catch(() => {});
  const ops = restoreOps()();
  if (ops.length) send('/changes', { expectedRevision: state.graph.revision, actor: 'human', message: t('Showed the whole map'), operations: ops });
  send('/focus', { id: null });
  if (state.focusView) { state.view = state.focusView; saveView(); }
});

// Home: the line for the agent and the projects, newest first. Updated from the shared event stream.

function openHome() {
  document.title = 'Mycel';
  Object.assign(home, { projects: null, loading: false, again: false, held: false, appeared: new Map() });
  homeShell();
  loadHome();
  hubEvents();
  renderDevices();
}
function homeShell() {
  $('#app').innerHTML = `<div class="home"><div class="home-col">
      <div class="home-top"><button type="button" class="agent-line" data-copy-agent>${esc(t('For your agent: {url}', { url: `${location.origin}/agent` }))}</button><span class="grow"></span><span id="status" role="status"></span>${langHtml()}</div>
      <ul class="projects" id="projects"></ul>
      <section class="devices" id="devices" hidden></section>
    </div></div>`;
}
// At most once per 150 ms from the first event: the timer is not reset, otherwise with several agents events come more
// often than every 150 ms and the list would never update. One request at a time: events during it give one more after.
const scheduleHome = () => { home.timer ||= setTimeout(() => { home.timer = 0; loadHome(); }, 150); };
async function loadHome() {
  if (page.kind !== 'home') return;
  if (home.loading) { home.again = true; return; }
  const gen = page.gen;
  home.loading = true; home.again = false;
  try {
    const { projects } = await api('/api/projects');
    if (gen !== page.gen) return;
    // Events come on every agent write in any project; the same list redraws nothing.
    if (home.projects && JSON.stringify(projects) === JSON.stringify(home.projects)) return;
    // Only rows that were not in the previous list appear; the first showing has no animation.
    if (home.projects) { const known = new Set(home.projects.map(p => p.id)), now = performance.now(); for (const p of projects) if (!known.has(p.id)) home.appeared.set(p.id, now); }
    home.projects = projects; renderHome();
  } catch (err) { if (gen === page.gen) fail(err); }
  finally { if (gen === page.gen) { home.loading = false; if (home.again) scheduleHome(); } }
}
// Rows are tied to the project id: an update changes only the fields that changed in them, adds new ones and removes deleted ones.
// The link and the trash button stay the same elements, so a click and focus on them are not lost. While the pointer is pressed, the list waits.
function renderHome() {
  const list = $('#projects'); if (!list || !home.projects) return;
  if (pressed.size) { home.held = true; return; }
  home.held = false;
  const now = performance.now(), rows = [...home.projects].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const els = new Map([...list.children].map(li => [li.dataset.id, li])), ids = new Set(rows.map(p => p.id));
  for (const [id, li] of els) if (!ids.has(id)) li.remove();
  let next = list.firstElementChild;
  for (const p of rows) {
    let li = els.get(p.id);
    if (!li) {
      li = Object.assign(document.createElement('li'), { className: 'p-row' }); li.dataset.id = p.id;
      li.innerHTML = `<a class="p-open" href="#/p/${esc(p.id)}" data-open="${esc(p.id)}"><span class="p-name"><b></b><i class="dot on" hidden></i></span><span class="p-meta"></span><span class="p-path"></span><span class="p-error" hidden></span></a>
        <button type="button" class="icon-btn p-trash" data-trash="${esc(p.id)}" title="${t('Delete project')}" aria-label="${t('Delete project')}">${icon('trash', 16)}</button>`;
      const t0 = home.appeared.get(p.id), age = t0 === undefined ? 300 : Math.round(now - t0);
      if (age < 300) { li.classList.add('appear'); li.style.animationDelay = `-${age}ms`; li.onanimationend = () => { li.classList.remove('appear'); li.style.animationDelay = ''; }; }
    }
    home.appeared.delete(p.id);
    fillRow(li, p);
    if (li === next) next = li.nextElementSibling; else list.insertBefore(li, next);
  }
}
function fillRow(li, p) {
  const put = (q, text, show = true) => { const el = $(q, li); if (el.textContent !== text) el.textContent = text; if (el.hidden === show) el.hidden = !show; return el; };
  const waiting = (p.agents ?? []).filter(a => a.waiting).map(a => a.actor).join(', ');
  const when = Number.isFinite(Date.parse(p.updatedAt)) ? ` · ${date(p.updatedAt)}` : '';
  put('.p-name b', p.name);
  const dot = put('.dot', '', Boolean(waiting)); if (dot.title !== waiting) dot.title = waiting;
  put('.p-meta', `${plural(p.blocks ?? 0, '{n} block', '{n} blocks')}${when}`);
  // A virtual machine's project: the main computer cannot see its folder, so the machine's name is shown next to it.
  put('.p-path', p.machine ? t('{path} · on machine "{machine}"', { path: p.path, machine: p.machine.name }) : p.exists ? p.path : p.path ? t('{path} · folder missing', { path: p.path }) : t('folder missing'));
  put('.p-error', p.error ?? '', Boolean(p.error));
}
// Deleting without confirmation: the project goes to Mycel's trash, and it can be brought back from the notification.
async function deleteProject(id) {
  const p = home.projects?.find(x => x.id === id); if (!p) return;
  const gen = page.gen, path = `/api/projects/${encodeURIComponent(id)}`;
  await api(`${path}/delete`, {});
  if (gen !== page.gen) return;
  home.projects = home.projects.filter(x => x.id !== id); renderHome();
  toast(t('Project "{name}" deleted', { name: p.name }), { action: t('[project] Undo'), run: () => api(`${path}/restore`, {}).then(scheduleHome, fail) });
}
// The line for the agent is copied as a whole phrase: it is pasted into the agent's chat.
async function copyAgent() {
  // From a virtual machine Mycel answers only with a key: it goes in the phrase as a header, and curl is that of the system the browser runs on.
  const far = !['127.0.0.1', 'localhost'].includes(location.hostname), key = far && state.session?.token;
  const win = far ? /^Win/.test(navigator.platform) : (state.session?.platform ?? (/^Win/.test(navigator.platform) ? 'win32' : '')) === 'win32';
  const command = `${win ? 'curl.exe -s' : 'curl -s'}${key ? ` -H "Authorization: Bearer ${key}"` : ''} ${location.origin}/agent`;
  const text = t('Read the Mycel guide and follow it: {command}', { command });
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area); area.select();
    const copied = document.execCommand('copy'); area.remove();
    if (!copied) throw new Error(t('Could not copy.'));
  }
  toast(t('Copied'));
}
// Virtual machine access. The agent there asks for access and prints a code; every Mycel page of this computer shows a
// card with the same code, a project choice and buttons. "Allow" gives the machine its key; home lists the machines with
// access and "Disconnect". The virtual machine itself does not have this: /api/access is closed to it.
async function loadAccess() {
  try { setAccess(await api('/api/access')); } catch { /* not the main computer, or no connection */ }
}
function setAccess(info) {
  if (!info || !Array.isArray(info.pending)) return;
  state.access = info; renderAccess(); renderDevices();
}
function renderAccess() {
  const list = state.access.pending;
  let el = $('#access');
  if (!list.length) { el?.remove(); return; }
  if (!el) { el = Object.assign(document.createElement('div'), { id: 'access', className: 'access' }); document.body.append(el); }
  const chosen = page.kind === 'project' ? page.id : state.access.projects[0]?.id;
  // The code goes into the text already as markup; the other values are escaped before they go in.
  const html = list.map(r => `<div class="access-row" data-pair="${esc(r.id)}">
      <div class="access-text">${t('Virtual machine "{name}" ({address}) is asking for access to Mycel. Code {code}: it must match the code on its screen.', { name: esc(r.name), address: esc(r.address), code: `<b>${esc(r.code)}</b>` })}</div>
      <div class="access-act"><label>${t('Project')} <select data-pair-project><option value="">${t('no project')}</option>${state.access.projects.map(p => `<option value="${esc(p.id)}"${p.id === chosen ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <button type="button" class="btn ghost" data-pair-deny="${esc(r.id)}">${t('Deny')}</button><button type="button" class="btn" data-pair-approve="${esc(r.id)}">${t('Allow')}</button></div>
    </div>`).join('');
  // The list is not redrawn without changes: the chosen project is not reset.
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}
function renderDevices() {
  const box = $('#devices'); if (!box) return;
  const list = state.access.devices, name = id => state.access.projects.find(p => p.id === id)?.name ?? id;
  box.hidden = !list.length;
  box.innerHTML = list.length ? `<h2>${t('Virtual machines with access')}</h2><ul>${list.map(d => `<li><span>${esc(d.name)} · ${esc(d.address)}${d.project ? ` · ${esc(name(d.project))}` : ''}${d.lastSeen ? ` · ${esc(t('last seen {date}', { date: date(d.lastSeen) }))}` : ''}</span><button type="button" class="btn ghost" data-revoke="${esc(d.id)}">${t('Disconnect')}</button></li>`).join('')}</ul>` : '';
}
async function answerPair(control, approve) {
  const row = control.closest('[data-pair]'), id = row.dataset.pair, project = row.querySelector('[data-pair-project]')?.value || null;
  row.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    setAccess(await api(`/api/pair/${encodeURIComponent(id)}/${approve ? 'approve' : 'deny'}`, approve ? { project } : {}));
    toast(approve ? t('Access allowed') : t('Request denied'));
  } catch (err) { row.querySelectorAll('button').forEach(b => { b.disabled = false; }); fail(err); loadAccess(); }
}

function hubEvents() {
  const gen = page.gen, events = new EventSource('/api/events');
  let broken = false;
  page.events = events;
  events.onmessage = e => {
    if (gen !== page.gen) return;
    const data = JSON.parse(e.data);
    if (data.access) setAccess(data.access); else scheduleHome();
  };
  // Access requests that arrived while the stream was connecting are re-read: after that, events bring them.
  events.onopen = () => { if (gen !== page.gen) return; setStatus(true); loadAccess(); if (broken) { broken = false; loadSession().catch(() => {}); } };
  events.onerror = () => {
    if (gen !== page.gen) return;
    setStatus(false); broken = true;
    if (events.readyState === EventSource.CLOSED) setTimeout(() => { if (gen === page.gen && page.events === events) hubEvents(); }, 2000);
  };
}

// Project: name and map, then the event stream of this project only.

async function openProject(id) {
  const gen = page.gen, prefix = page.prefix;
  document.title = 'Mycel';
  $('#app').innerHTML = `<div class="loading">${t('Loading…')}</div>`;
  try {
    const [{ project }, graph] = await Promise.all([api(prefix), api(`${prefix}/graph`)]);
    if (gen !== page.gen) return;
    page.name = project.name; document.title = `${project.name} — Mycel`;
    adopt(graph); loadView(id);
    const back = undive(id);
    shell(); renderAgents();
    await showTab('map');
    // Leaving the dive when the previous page closed did not get through: the collapsing is restored, the focus is cleared.
    if (back.length) { papi('/focus', { id: null }).catch(() => {}); await commit(back, t('Showed the whole map')).catch(recover); }
    if (gen === page.gen) projectEvents();
  } catch (err) {
    if (gen !== page.gen || err instanceof Stale) return;
    if (err.status === 404) { notice = err.deleted ? t('Project deleted') : err.message; location.hash = '#/'; return; }
    $('#app').innerHTML = `<div class="loading"><h2>${t('Could not open the map')}</h2><p>${esc(err.message)}</p><button class="btn" id="retry">${t('Retry')}</button> <a class="btn" href="#/">${t('Back to projects')}</a></div>`;
    $('#retry').onclick = () => { if (gen === page.gen) openProject(id); };
  }
}
function projectEvents() {
  const gen = page.gen, events = new EventSource(`${page.prefix}/events`);
  let broken = false;
  page.events = events;
  events.onmessage = e => {
    if (gen !== page.gen) return;
    const data = JSON.parse(e.data);
    if (data.deleted) return gone();
    if (Number.isFinite(data.revision)) liveRefresh(data.revision);
    if ('edit' in data && JSON.stringify(data.edit) !== JSON.stringify(state.edit)) { state.edit = data.edit; renderEdits(); }
    if (data.agents) { state.agents = data.agents; state.activity = data.activity ?? []; renderAgents(); }
    if (data.work) { state.work = data.work; state.code = data.code ?? state.code; paintCode(); }
    if (data.access) setAccess(data.access);
    // The agent shows a block; while the person is editing text or dragging a node, the view does not jump.
    if (data.show && !state.editing && !state.gesture) focusNode(data.show).catch(recover);
  };
  // After a lost connection the session is re-read: the token may have changed.
  // Access requests that arrived while the stream was connecting are re-read: after that, events bring them.
  events.onopen = () => { if (gen !== page.gen) return; setStatus(true); loadAccess(); if (broken) { broken = false; loadSession().catch(() => {}); } };
  // The server closed the stream (rather than the connection dropping): the project was deleted, go home; otherwise reconnect in 2 s.
  events.onerror = async () => {
    if (gen !== page.gen) return;
    setStatus(false); broken = true;
    if (events.readyState !== EventSource.CLOSED) return;
    try { await api(page.prefix); }
    catch (err) { if (gen === page.gen && err.status === 404) return gone(); }
    setTimeout(() => { if (gen === page.gen && page.events === events) projectEvents(); }, 2000);
  };
}
// The project was deleted (on home or in another window): back to the list, there is nowhere to save the edit anymore.
function gone() {
  if (page.gone) return;
  page.gone = true; page.events?.close();
  notice = t('Project deleted'); location.hash = '#/';
}

// Switching the language keeps the screen: the choice is stored and the open page is drawn again in place, with the
// same project, view, dive and selection.
async function setLang(next) {
  if (next === lang || !LANGS.includes(next)) return;
  prefs.set(LANG_KEY, next);
  lang = next; document.documentElement.lang = lang;
  if (page.kind === 'home') { homeShell(); renderHome(); renderDevices(); }
  else if (page.kind === 'project' && state.graph) {
    const gen = page.gen;
    if (state.editing) await finishEdit();
    if (gen !== page.gen) return;
    closeMenu(); if (state.connectFrom || state.rebind) stopConnect();
    shell(); renderAgents();
    await showTab(state.tab);
  }
  setStatus(state.online); renderAccess();
  $(`[data-lang="${lang}"]`)?.focus({ preventScroll: true });
}

// Russian dictionary: English source text → the Russian wording. A plural entry lists the one, few and many forms.
const RU = {
  // Common
  'Loading…': 'Загрузка…',
  'No connection to the server.': 'Нет связи с сервером.',
  'No connection to the server': 'Нет связи с сервером',
  'Server error: {status}': 'Ошибка сервера: {status}',
  'Language': 'Язык',
  'English': 'Английский',
  'Russian': 'Русский',
  'empty note': 'пустая заметка',
  'untitled': 'без названия',
  'Undo': 'Отменить',
  // Colours and levels
  'No colour': 'Без цвета',
  'Grey': 'Серый',
  'Red': 'Красный',
  'Orange': 'Оранжевый',
  'Yellow': 'Жёлтый',
  'Green': 'Зелёный',
  'Blue': 'Синий',
  'Purple': 'Фиолетовый',
  'Concept': 'Концепция',
  'Mechanics': 'Механика',
  'Technical': 'Техника',
  'Code': 'Код',
  // Control bar, focus bar and zoom
  'Map': 'Карта',
  'History': 'История',
  'Level': 'Уровень',
  'Sub-maps collapsed unevenly': 'Подкарты свёрнуты вразнобой',
  'Health': 'Здоровье',
  'What is wrong with blocks: failed, outdated, unchecked, risks': 'Что с блоками не так: не прошли проверку, устарели, без проверки, риски',
  'Download map': 'Скачать карту',
  'Leave focus': 'Выйти из фокуса',
  'Zoom out': 'Уменьшить',
  'Zoom in': 'Увеличить',
  'Show all': 'Показать всё',
  // Blocks, notes and links on the map
  '{n} blocks': ['{n} блок', '{n} блока', '{n} блоков'],
  '{n} notes': ['{n} заметка', '{n} заметки', '{n} заметок'],
  '{list} inside': '{list} внутри',
  'Passed {passed} of {total}': 'Проверено {passed} из {total}',
  'Files: {files}': 'Файлы: {files}',
  'Check: {test}': 'Проверка: {test}',
  'Expand sub-map': 'Развернуть подкарту',
  'Collapse sub-map': 'Свернуть подкарту',
  'Expand': 'Развернуть',
  'Collapse': 'Свернуть',
  'Edit': 'Изменить',
  'Edit block': 'Изменить блок',
  'Drag to another block to link': 'Потяните к другому блоку, чтобы связать',
  'Drag onto another block': 'Перетащите на другой блок',
  'Title': 'Название',
  'Block title': 'Название блока',
  'Text': 'Текст',
  // Selection panel and context menu
  'Link to another block': 'Связать с другим блоком',
  'Link': 'Связать',
  'Delete': 'Удалить',
  'Label': 'Подпись',
  'Link label': 'Подпись связи',
  'Reverse direction': 'Сменить направление',
  'Delete link': 'Удалить связь',
  'Detach from block': 'Открепить от блока',
  'Open': 'Открыть',
  'Block inside': 'Блок внутри',
  'Note inside': 'Заметка внутри',
  'Note on block': 'Заметка к блоку',
  'Link to…': 'Связать с…',
  'Check': 'Проверить',
  'Edit note': 'Изменить заметку',
  'Move start to…': 'Перенести начало на…',
  'Move end to…': 'Перенести конец на…',
  'Block': 'Блок',
  'Note': 'Заметка',
  // Notifications on the map
  'The agent will check "{name}"': 'Агент проверит «{name}»',
  'No agent is connected right now: it will see the request to check "{name}" when it comes back': 'Агента сейчас нет на связи: он увидит просьбу проверить «{name}», когда вернётся',
  'Click the block to link to': 'Нажмите на блок, с которым связать',
  'Click the block the link should start from': 'Нажмите на блок, откуда пойдёт связь',
  'Click the block the link should go to': 'Нажмите на блок, куда пойдёт связь',
  'A link cannot loop back to its own block': 'Связь не может замыкаться на себя',
  'This link already exists': 'Такая связь уже есть',
  'A link in the opposite direction already exists': 'Встречная связь уже есть',
  'Link deleted': 'Связь удалена',
  'Note deleted': 'Заметка удалена',
  'Block and its content deleted': 'Блок и его содержимое удалены',
  'Block deleted': 'Блок удалён',
  // History entries written by the interface
  'Added note "{name}"': 'Добавлена заметка «{name}»',
  'Added block "{name}"': 'Добавлен блок «{name}»',
  'Changed note "{name}"': 'Изменена заметка «{name}»',
  'Changed block "{name}"': 'Изменён блок «{name}»',
  'Deleted note "{name}"': 'Удалена заметка «{name}»',
  'Deleted block "{name}"': 'Удалён блок «{name}»',
  'Restored note "{name}"': 'Восстановлена заметка «{name}»',
  'Restored block "{name}"': 'Восстановлен блок «{name}»',
  'Moved note "{name}"': 'Перемещена заметка «{name}»',
  'Moved block "{name}"': 'Перемещён блок «{name}»',
  'Moved note "{name}" {where}': 'Перенесена заметка «{name}» {where}',
  'Moved block "{name}" {where}': 'Перенесён блок «{name}» {where}',
  'into "{name}"': 'в «{name}»',
  'to the main map': 'на основную карту',
  'Attached note "{name}"': 'Прикреплена заметка «{name}»',
  'Detached note "{name}"': 'Откреплена заметка «{name}»',
  'Changed size of note "{name}"': 'Изменён размер: заметка «{name}»',
  'Changed size of block "{name}"': 'Изменён размер: блок «{name}»',
  'Expanded sub-map "{name}"': 'Развёрнута подкарта «{name}»',
  'Collapsed sub-map "{name}"': 'Свёрнута подкарта «{name}»',
  'Opened block "{name}"': 'Открыт блок «{name}»',
  'Showed level "{level}"': 'Показан уровень «{level}»',
  'Showed the whole map': 'Показана вся карта',
  'Added link': 'Добавлена связь',
  'Deleted link': 'Удалена связь',
  'Restored link': 'Восстановлена связь',
  'Moved link': 'Перенесена связь',
  'Reversed link': 'Изменено направление связи',
  'Changed link label': 'Изменена подпись связи',
  // The person's edits and agent proposals
  'Finish edits': 'Закончить правки',
  'Entries since the edits started': 'Записей с начала правок',
  'Edits sent to the agent': 'Правки переданы агенту',
  'Proposal "{title}"': 'Предложение «{title}»',
  'Cards in the proposal': 'Карточек в предложении',
  'Reject': 'Отклонить',
  'Accept': 'Принять',
  'Proposal accepted': 'Предложение принято',
  'Proposal rejected': 'Предложение отклонено',
  // Code and Health
  'failed': 'не прошла',
  'outdated?': 'устарел?',
  'unchecked': 'без проверки',
  'plan': 'план',
  'key?': 'ключ?',
  'failed: {n}': 'не прошли: {n}',
  'outdated: {n}': 'устарели: {n}',
  'unchecked: {n}': 'без проверки: {n}',
  'plan: {n}': 'план: {n}',
  'risks: {n}': 'риски: {n}',
  'Failed': 'Не прошло',
  'Outdated': 'Устарело',
  'Unchecked': 'Без проверки',
  'Plan': 'План',
  'Risks': 'Риски',
  '"{name}": {files} ({by})': '«{name}»: {files} ({by})',
  'Files changed after the block was described:\n{lines}': 'Файлы изменили после того, как блок описали:\n{lines}',
  'No failed, outdated or unchecked blocks': 'Красных, устаревших и непроверенных блоков нет',
  // History and What changed
  'What changed': 'Что изменилось',
  'Last hour': 'За час',
  'Last day': 'За день',
  'Last week': 'За неделю',
  '"{title}"': '«{title}»',
  'Passed: {list}.': 'Проверено: {list}.',
  'Failed: {list}.': 'Проверка не прошла: {list}.',
  'Entries: {n}': 'Записей: {n}',
  'yours: {n}': 'ваших: {n}',
  'agents: {list}': 'агенты: {list}',
  'No changes in how the project is built over this period.': 'Устройство проекта за это время не менялось.',
  'You': 'Человек',
  'System': 'Система',
  'revision {n}': 'ревизия {n}',
  'No changes yet.': 'Изменений пока нет.',
  // Home
  'For your agent: {url}': 'Агенту: {url}',
  'Read the Mycel guide and follow it: {command}': 'Прочитай инструкцию Mycel и выполни её: {command}',
  'Copied': 'Скопировано',
  'Could not copy.': 'Не удалось скопировать.',
  'Delete project': 'Удалить проект',
  '{path} · on machine "{machine}"': '{path} · на машине «{machine}»',
  '{path} · folder missing': '{path} · папки нет',
  'folder missing': 'папки нет',
  'Project "{name}" deleted': 'Проект «{name}» удалён',
  '[project] Undo': 'Вернуть',
  'Project deleted': 'Проект удалён',
  'Could not open the map': 'Не удалось открыть карту',
  'Retry': 'Повторить',
  'Back to projects': 'К проектам',
  // Virtual machine access
  'Virtual machine "{name}" ({address}) is asking for access to Mycel. Code {code}: it must match the code on its screen.': 'Виртуальная машина «{name}» ({address}) просит доступ к Mycel. Код {code} — он должен совпасть с кодом на её экране.',
  'Project': 'Проект',
  'no project': 'без проекта',
  'Deny': 'Отклонить',
  'Allow': 'Разрешить',
  'Access allowed': 'Доступ разрешён',
  'Request denied': 'Запрос отклонён',
  'Virtual machines with access': 'Виртуальные машины с доступом',
  'last seen {date}': 'была {date}',
  'Disconnect': 'Отключить',
  'Machine disconnected': 'Машина отключена'
};

async function boot() {
  const first = $('#app > .loading'); if (first) first.textContent = t('Loading…');
  // Without a session the screens still open: reading does not need it, and a write re-reads it on 401.
  await loadSession().catch(() => {});
  route();
  loadAccess();
}
boot();
// Access to the internals for debugging from the browser console.
window.mycel = { state, page, home, node, blockNear, containerAt, toWorld, toScreen, worldRect, layoutSize, fieldRect, edgeGeometry, focusNode, dive, goUp, exitFocus, liveRefresh, autoFit };
