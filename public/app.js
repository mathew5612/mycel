// Mycel — свободная карта: блоки с текстом, заметки-стикеры, подкарты внутри блоков, связи между блоками.

const $ = (q, root = document) => root.querySelector(q);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Текст блока: `так` выделяется как код — имена функций и файлов на уровне кода.
const fmt = value => esc(value).replace(/`([^`\n]+)`/g, '<code>$1</code>');
const COLORS = ['', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const COLOR_NAMES = { '': 'Без цвета', gray: 'Серый', red: 'Красный', orange: 'Оранжевый', yellow: 'Жёлтый', green: 'Зелёный', blue: 'Синий', purple: 'Фиолетовый' };
const SIZE = { block: { w: 220, h: 110 }, note: { w: 160, h: 120 } };
// Нижний предел — чтобы «Показать всё» вмещала и большую карту, построенную агентом по проекту.
const ZOOM = { min: 0.1, max: 2.5 };
// Геометрия подкарты; src/layout.mjs повторяет её для авторасстановки на сервере.
const PAD = 12;                       // внутренний отступ подкарты
const EDGE = 1;                       // рамка блока: поле подкарты отсчитывается внутри неё
const HEAD = { base: 36, text: 39 };  // высота шапки контейнера: строка названия, плюс две строки текста
const FOLDED = { w: 280, h: 30 };     // свёрнутая подкарта: ширина не больше, высота под надпись «N блоков внутри»
const ROOM = { w: 520, h: 300 };      // поле, которое блок сразу получает, когда в нём появляется подкарта
const SPOT = 24;                      // отступ нового узла от края поля и от соседей
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
// Уровни абстракции задаются вложенностью: концепция — основная карта, механика — подкарты её блоков, техника —
// подкарты механики, код — глубже.
const LEVELS = ['Концепция', 'Механика', 'Техника', 'Код'];
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

// Хранилище браузера: настройки общие для вкладок (localStorage), погружение — своё у вкладки и переживает
// перезагрузку (sessionStorage).
const storage = kind => ({
  get(key) { try { return window[kind].getItem(key); } catch { return null; } },
  set(key, value) { try { window[kind].setItem(key, value); } catch { /* приватный режим */ } },
  del(key) { try { window[kind].removeItem(key); } catch { /* приватный режим */ } }
});
const prefs = storage('localStorage'), tabPrefs = storage('sessionStorage');

const state = {
  graph: null, session: null, tab: 'map', view: null,
  selected: null,      // { type: 'node' | 'edge', id }
  editing: null,       // id узла, который редактируется
  fresh: new Map(),    // узлы, созданные локально и ещё не сохранённые: id → { edgeId }
  connectFrom: null,   // режим «связать»: id исходного блока
  rebind: null,        // режим «перенести конец связи»: { edgeId, end: 'source' | 'target' }
  hoverEdge: null,     // связь под курсором: у неё видны ручки и крестик
  pointer: { x: -1, y: -1 }, // последнее положение указателя на экране
  gesture: null,       // текущее перетаскивание
  menu: null,          // открытое контекстное меню
  agents: [],          // агенты, которые обращались к проекту: ждёт ли, когда был
  activity: [],        // что агенты делают сейчас: { actor, text, progress, at }
  work: [],            // кто над какими блоками работает: { actor, blocks, files, at }
  code: { stale: {}, risks: {} }, // устаревшие блоки (их файлы изменили после описания) и риски из mycel health
  health: false,       // режим «Здоровье»: на карте видно, что с блоками не так
  reviewHours: 24,     // за сколько часов сводка «Что изменилось» в истории
  access: { pending: [], devices: [], projects: [] }, // запросы доступа виртуальных машин и машины с доступом
  edit: null,          // правки человека, которые он ещё не закончил: { since, at, count }
  focus: null, focusView: null, focusSince: null, // модуль в фокусе, вид карты до фокуса и время входа в него
  focusFolds: new Map(), // сворачивание, которое поменяли погружения: id → каким было до фокуса
  walking: 0,          // сколько переходов по уровням ещё идёт или ждёт очереди
  level: 0,            // уровень, выбранный ползунком последним; переход по уровням его забывает
  appeared: new Map(), // узлы и связи, пришедшие по SSE: id → время появления, для анимации
  remarked: new Map(), // блоки, чья отметка сменилась по SSE: id → время, для вспышки
  follow: false,       // слежение: карта сама вписывается под изменения, пока человек не двигал вид
  followIds: null,     // узлы, к верхним блокам которых карта вписалась в последний раз, когда целиком была бы мельче 40%
  online: true, busy: 0, pending: false, // busy — сколько записей человека ещё идёт
  loading: false, wanted: 0 // запрос карты по SSE уже идёт; ревизия, до которой нужно дочитать
};
// Открытый экран: главная или проект. gen растёт при каждом переходе — ответы, пришедшие после ухода, отбрасываются.
const page = { gen: 0, kind: null, id: null, prefix: '', name: '', events: null, gone: false };
// Главная: список проектов, запрос в полёте и строки, которые сейчас проявляются.
// held — список не перерисован, пока был нажат указатель.
const home = { projects: null, timer: 0, loading: false, again: false, held: false, appeared: new Map() };
// Ответ пришёл уже на другом экране: результат отбрасывается молча.
class Stale extends Error {}
const node = id => state.graph.nodes.find(n => n.id === id);
const edgeOf = id => state.graph.edges.find(e => e.id === id);
const childrenOf = id => state.graph.nodes.filter(n => n.parentId === id);
const notesOf = id => state.graph.nodes.filter(n => n.type === 'note' && n.attachedTo === id);
const isNote = n => n?.type === 'note';
const isContainer = n => n && !isNote(n) && childrenOf(n.id).length > 0;
const blockEl = id => document.querySelector(`.block[data-id="${CSS.escape(id)}"]`);
// Название и текст узла; у контейнера они лежат в шапке.
const part = (el, cls) => el?.querySelector(`:scope > .${cls}, :scope > .head > .${cls}`);
// Короткое имя: название или первая строка текста, обрезанная по слову с многоточием (как в src/model.mjs).
function shorten(line, max = 40) {
  if (line.length <= max) return line;
  const cut = line.slice(0, max), space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
const nodeName = n => n.title.trim() || shorten(n.text.trim().split('\n')[0]) || (isNote(n) ? 'пустая заметка' : 'без названия');
const date = value => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const plural = (n, forms) => { const a = Math.abs(n) % 100, b = a % 10; return `${n} ${forms[a > 10 && a < 20 ? 2 : b > 1 && b < 5 ? 1 : b === 1 ? 0 : 2]}`; };

function toast(message, options = {}) {
  const el = $('#toast'), gen = page.gen;
  el.innerHTML = `<span>${esc(message)}</span>${options.action ? `<button type="button" id="toast-action">${esc(options.action)}</button>` : ''}`;
  // Действие относится к экрану, где появилось уведомление: после перехода кнопка ничего не делает.
  if (options.action) $('#toast-action').onclick = () => { el.className = ''; if (gen === page.gen) options.run(); };
  el.className = `visible${options.error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.className = '', options.action ? 7000 : options.error ? 5000 : 2500);
}
function hideToast() { clearTimeout(toast.timer); $('#toast').className = ''; }
const fail = err => { if (!(err instanceof Stale)) toast(err.message || String(err), { error: true }); };
// Изменение не сохранилось: показываем ошибку и перечитываем карту, чтобы локальное состояние не расходилось с сервером.
async function recover(err) {
  if (err instanceof Stale) return;
  fail(err);
  if (page.kind !== 'project' || !state.graph) return;
  try { await refresh(); renderMap(); } catch { /* сервер недоступен: карта обновится по SSE */ }
}

// Токен мог смениться, пока страница открыта: сессия перечитывается один раз на все запросы, получившие 401.
let sessionLoad = null;
const loadSession = () => sessionLoad ??= api('/api/session').then(s => { state.session = s; }).finally(() => { sessionLoad = null; });
async function api(path, body, retry = true) {
  let res;
  try { res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session?.token}` }, body: JSON.stringify(body) } : {}); }
  catch { throw new Error('Нет связи с сервером.'); }
  if (res.status === 401 && retry) { await loadSession(); return api(path, body, false); }
  const value = await res.json().catch(() => ({}));
  if (!res.ok) { const error = new Error(value.error || `Ошибка сервера: ${res.status}`); error.status = res.status; error.deleted = value.deleted; throw error; }
  return value;
}
// Запрос к открытому проекту: префикс берётся в момент вызова, ответ потом сверяется с поколением экрана.
const papi = (path, body) => api(page.prefix + path, body);

// Геометрия уровней. Координаты узла относительны его уровню: у вложенного — полю подкарты родителя.
// Развёрнутый контейнер растёт под содержимое: шапка сверху, поле подкарты с отступом PAD.

let sizes = new Map();
// Подкарты, внутри которых есть блок с непрошедшей или идущей проверкой, и готовность подкарт — сколько блоков внутри
// с каждой отметкой. Считается при каждой отрисовке карты.
let failedIn = new Set(), testingIn = new Set(), tally = new Map();
// Пока контейнер редактируется, шапка вмещает поле текста, даже если текст пуст.
const headerH = n => HEAD.base + (n.text.trim() || state.editing === n.id ? HEAD.text : 0);
// В фокусе видны только блок фокуса, всё внутри него и его заметки; остальная карта скрыта, но остаётся на месте.
let focusIds = null;
function visible(n) {
  if (focusIds && !focusIds.has(n.id)) return false;
  for (let p = n.parentId; p; ) { const parent = node(p); if (!parent || parent.collapsed) return false; p = parent.parentId; }
  return true;
}
const edgeShown = e => { const a = e && node(e.source), b = e && node(e.target); return Boolean(a && b && visible(a) && visible(b)); };
// Место, которое занимает развёрнутая подкарта: вложенные узлы, отступы поля, шапка и рамка.
function contentSize(n) {
  let right = 0, bottom = 0;
  for (const k of childrenOf(n.id)) { const ks = layoutSize(k); right = Math.max(right, k.x + ks.w); bottom = Math.max(bottom, k.y + ks.h); }
  return { w: right + 2 * PAD + 2 * EDGE, h: headerH(n) + bottom + PAD + 2 * EDGE };
}
// Развёрнутая подкарта хранит свой размер (w, h) и не бывает меньше содержимого; свёрнутая — компактная карточка.
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
// Контейнеры по цепочке вверх от id, которым тесно, растут под содержимое; возвращает операции, чтобы размер сохранился.
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
// Свободное место в поле подкарты: первая позиция сеткой по 20 px, где узел не задевает соседей, иначе — под ними.
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
// Начало поля подкарты контейнера в мировых координатах и само поле.
function subOrigin(container) { const r = worldRect(container); return { x: r.x + EDGE + PAD, y: r.y + EDGE + headerH(container) }; }
function fieldRect(container) { const r = worldRect(container), o = subOrigin(container); return { x: o.x, y: o.y, w: r.x + r.w - EDGE - PAD - o.x, h: r.y + r.h - EDGE - PAD - o.y }; }
const depthOf = n => { let d = 0; for (let p = n.parentId; p; p = node(p)?.parentId) d++; return d; };

// Данные

function adopt(next) {
  const prev = state.graph;
  state.graph = next;
  // Локально созданные, ещё не сохранённые узлы и их связи остаются на карте.
  if (prev) for (const [id, fresh] of state.fresh) {
    const n = prev.nodes.find(x => x.id === id);
    if (n && !node(id)) state.graph.nodes.push(n);
    const e = fresh.edgeId && prev.edges.find(x => x.id === fresh.edgeId);
    if (e && !edgeOf(e.id) && node(e.source) && node(e.target)) state.graph.edges.push(e);
  }
}
async function refresh() { const gen = page.gen, next = await papi('/graph'); if (gen !== page.gen) throw new Stale(); adopt(next); }
// Нажатые указатели на всей странице. Пока хоть один нажат, живое обновление ждёт: перерисовка заменила бы нажатую
// строку главной, шеврон или кнопку панели, и клик по ним потерялся бы. Отпускание дорисовывает отложенное.
const pressed = new Set();
// Пока идёт жест, ввод, запись или нажат указатель, карту с сервера не подменяем: иначе перетаскиваемый узел или
// редактор потеряют состояние, а элемент под нажатием — клик.
const interacting = () => Boolean(state.gesture || state.editing || state.busy || pressed.size || document.activeElement?.id === 'edge-label');
// Записи, которые ещё идут: уход с проекта ждёт их, чтобы правка не потерялась на повторе после 409.
const saving = new Set();
// again собирает операции заново по перечитанной после 409 карте (уровень ползунка): повтор прежних не тронул бы
// подкарты, которые агент добавил, пока ползунок держали.
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
    // Правка агента, из-за которой запись повторилась, проявляется и вписывается в слежении, как пришедшая по SSE.
    const ids = prev ? touched(prev, state.graph) : [], added = prev ? markAppeared(prev, state.graph) : 0;
    state.graph = next;
    renderMap();
    if (added && state.follow && state.tab === 'map') autoFit(ids);
    if (state.tab === 'history') await showHistory();
  } catch (err) { throw gen === page.gen ? err : new Stale(); }
  // Правка агента, пришедшая во время записи, только отмечена: после последней записи карта её дочитывает.
  finally { if (gen === page.gen && !--state.busy) flushPending(); }
}

// Каркас и вкладки

// Карта на всю ширину, под ней строка управления, как в n8n. Чата нет: с агентом говорят в его окне.
function shell() {
  $('#app').innerHTML = `<div class="work"><div class="focus-bar" id="focus-bar" hidden></div><main id="main"></main>
      <div class="progress-row" id="progress-row" hidden><div class="progress" id="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div></div>
      <div class="dock-bar" id="dock">${barHtml()}</div></div>`;
}
function setStatus(online) {
  state.online = online;
  const el = $('#status'); if (el) el.textContent = online ? '' : 'Нет связи с сервером';
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
        <button data-action="zoom-out" aria-label="Уменьшить">−</button><span id="zoom-value">100%</span><button data-action="zoom-in" aria-label="Увеличить">+</button>
        <button data-action="fit" title="Показать всё" aria-label="Показать всё">${icon('fit', 16)}</button>
      </div>
      <div class="edits" id="edits" hidden></div>
    </div>`;
  // Вьюпорт с overflow: hidden браузер всё равно может прокрутить при фокусе на элементе у края;
  // тогда картинка разъезжается с координатами. Любую такую прокрутку сбрасываем.
  $('#viewport').addEventListener('scroll', e => { e.target.scrollTop = 0; e.target.scrollLeft = 0; });
  renderMap(); renderEdits();
  if (state.view && !state.follow) applyView(); else autoFit(state.followIds, false);
}
// Сверху — ревью картой: что изменилось в устройстве проекта по концепциям за час, день или неделю, простыми словами.
const REVIEW = [[1, 'За час'], [24, 'За день'], [168, 'За неделю']];
async function showHistory() {
  const gen = page.gen, [{ history }, review] = await Promise.all([papi('/history'), papi(`/review?hours=${state.reviewHours}`)]);
  if (gen !== page.gen || state.tab !== 'history') return;
  const actor = a => a === 'human' ? 'Человек' : a === 'system' ? 'Система' : a;
  const marks = [review.passed.length && `Проверено: ${review.passed.join(', ')}.`, review.failed.length && `Проверка не прошла: ${review.failed.join(', ')}.`].filter(Boolean).join(' ');
  const summary = `<section class="review"><div class="review-head"><h2>Что изменилось</h2><nav class="tabs">${REVIEW.map(([h, label]) => `<button type="button" data-review-hours="${h}"${h === state.reviewHours ? ' class="active"' : ''}>${label}</button>`).join('')}</nav></div>
    ${review.groups.length ? `${review.groups.map(g => `<h3>«${esc(g.title)}»</h3><ul>${g.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`).join('')}${marks ? `<p class="review-marks">${esc(marks)}</p>` : ''}
      <p class="muted">Записей: ${review.entries}${review.human ? `, ваших: ${review.human}` : ''}${review.agents.length ? `, агенты: ${esc(review.agents.join(', '))}` : ''}.</p>` : '<p class="muted">Устройство проекта за это время не менялось.</p>'}</section>`;
  $('#main').innerHTML = `<div class="page"><h1>История</h1>${summary}${history.length ? `<ol class="history">${history.map(h => `<li>
      <div class="h-meta"><b>${esc(actor(h.actor))}</b><span>${date(h.at)}</span><span>ревизия ${h.revision}</span></div>
      <div class="h-msg">${esc(h.message)}</div>
      ${h.changes.length > 1 || (h.changes[0] && h.changes[0] !== h.message) ? `<ul>${h.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </li>`).join('')}</ol>` : '<p class="muted">Изменений пока нет.</p>'}</div>`;
}

// Карта

function renderMap() {
  const blocks = $('#blocks'); if (!blocks) return;
  sizes = new Map();
  if (state.focus && !node(state.focus)) state.focus = null;
  focusIds = state.focus ? focusSet(state.focus) : null;
  // Выделение снимается и с узла или связи, скрытых в свёрнутой подкарте: иначе панель и клавиши работали бы с невидимым.
  const s = state.selected;
  if (s && !(s.type === 'node' ? node(s.id) && visible(node(s.id)) : edgeShown(edgeOf(s.id)))) state.selected = null;
  if (state.editing && !node(state.editing)) state.editing = null;
  const editor = state.editing ? captureEditor(state.editing) : null;
  failedIn = new Set(); testingIn = new Set(); tally = new Map();
  for (const n of state.graph.nodes) {
    const inside = n.status === 'failed' ? failedIn : n.status === 'testing' ? testingIn : null;
    if (inside) for (let p = node(n.parentId); p && !inside.has(p.id); p = node(p.parentId)) inside.add(p.id);
    if (!isNote(n)) for (let p = node(n.parentId); p; p = node(p.parentId)) {
      const t = tally.get(p.id) ?? { plan: 0, testing: 0, passed: 0, failed: 0, none: 0 };
      t[n.status ?? 'none']++; tally.set(p.id, t);
    }
  }
  blocks.innerHTML = levelHtml(null);
  // Блок, который правят, ушёл в свёрнутую подкарту: правка сохраняется, а не висит без поля и не держит обновление.
  if (state.editing && !blockEl(state.editing)) finishEdit(editor);
  else if (state.editing) mountEditor(state.editing, editor?.focus ?? 'title', editor);
  for (const el of blocks.querySelectorAll('.block')) { const t = part(el, 'b-text'); if (t && t.scrollHeight > t.clientHeight + 1) el.classList.add('clipped'); }
  renderLevels(); renderFocus(); renderEdits(); reportSelection();
  drawEdges(); renderFloat(); syncHover(); paintCode();
}
// Узлы одного уровня: сначала контейнеры, затем блоки, затем заметки. Что позже в разметке, то выше на экране:
// блок, положенный на подкарту, не уходит под её шапку и содержимое, а заметки лежат поверх всего.
function levelHtml(parentId) {
  const level = state.graph.nodes.filter(n => n.parentId === parentId), blocks = level.filter(n => !isNote(n));
  return [...blocks.filter(n => isContainer(n)), ...blocks.filter(n => !isContainer(n)), ...level.filter(isNote)].map(blockHtml).join('');
}
// Готовность подкарты — полоска вдоль верхнего края: сколько блоков внутри проверено, проверяется, упало, в плане и без
// отметки. Нет ни одной отметки внутри — нет и полоски.
const METER = ['passed', 'testing', 'failed', 'plan', 'none'];
function meterHtml(n) {
  const t = tally.get(n.id); if (!t || !(t.plan + t.testing + t.passed + t.failed)) return '';
  const total = METER.reduce((sum, k) => sum + t[k], 0);
  return `<div class="meter" title="Проверено ${t.passed} из ${total}">${METER.filter(k => t[k]).map(k => `<i class="m-${k}" style="flex:${t[k]}"></i>`).join('')}</div>`;
}
function blockHtml(n) {
  const size = layoutSize(n), selected = state.selected?.type === 'node' && state.selected.id === n.id;
  const container = isContainer(n), kids = container ? childrenOf(n.id) : [], blocksIn = kids.filter(c => !isNote(c)).length;
  // Надпись свёрнутой подкарты: «3 блока внутри», «1 заметка внутри», «2 блока, 1 заметка внутри».
  const inside = [blocksIn && plural(blocksIn, ['блок', 'блока', 'блоков']), kids.length > blocksIn && plural(kids.length - blocksIn, ['заметка', 'заметки', 'заметок'])].filter(Boolean).join(', ');
  const age = appearing(n.id);
  // Отметка (план — пунктир, идёт проверка — пульсирует, проверен — зелёный, проверка не прошла — красный; подкарта, внутри
  // которой что-то проверяется или не прошло, — так же), вспышка только что сменившейся отметки и пометка предложения агента.
  const flash = remarking(n.id);
  const classes = ['block', `lv-${Math.min(depthOf(n), 3)}`, isNote(n) && 'note', n.color && `c-${n.color}`, selected && 'selected', container && 'container', container && n.collapsed && 'collapsed', focusIds && !focusIds.has(n.id) && 'out-focus', age !== null && 'appear',
    n.status && `st-${n.status}`, n.status !== 'failed' && failedIn.has(n.id) && 'failed-inside', n.status !== 'testing' && testingIn.has(n.id) && 'testing-inside', flash !== null && 'remark', n.proposed && `pr-${n.proposed}`].filter(Boolean).join(' ');
  // Файлы блока и команда его проверки — подсказкой у названия: на карте их место занимает смысл.
  const code = [n.files && `Файлы: ${n.files.join(', ')}`, n.test && `Проверка: ${n.test}`].filter(Boolean).join('\n');
  const head = `${isNote(n) ? '' : `<div class="b-title"${code ? ` title="${esc(code)}"` : ''}>${esc(n.title)}</div>`}<div class="b-text">${fmt(n.text)}</div>`;
  return `<div class="${classes}" data-id="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px;width:${size.w}px;height:${size.h}px${age !== null ? `;animation-delay:-${age}ms` : ''}${flash !== null ? `;--remark-delay:-${flash}ms` : ''}" tabindex="0" aria-label="${esc(nodeName(n))}">
      ${container ? `<div class="head" style="height:${headerH(n)}px">${head}</div>` : head}
      ${container ? `<button type="button" class="fold" data-fold title="${n.collapsed ? 'Развернуть подкарту' : 'Свернуть подкарту'}" aria-label="${n.collapsed ? 'Развернуть' : 'Свернуть'}">${icon(n.collapsed ? 'right' : 'down', 15)}</button>` : ''}
      ${container && n.collapsed ? `<button type="button" class="fold-badge" data-fold>${inside} внутри</button>` : ''}
      ${isNote(n) ? '' : `<button type="button" class="pen" data-pen tabindex="-1" title="Изменить" aria-label="Изменить блок">${icon('pen', 14)}</button>`}
      ${meterHtml(n)}
      ${container && !n.collapsed ? `<div class="sub" style="top:${headerH(n)}px"><span class="sub-level">${LEVELS[Math.min(depthOf(n) + 1, LEVELS.length - 1)]}</span>${levelHtml(n.id)}</div>` : ''}
      ${isNote(n) ? '' : '<span class="port" data-port title="Потяните к другому блоку, чтобы связать"></span><span class="ez ez-t" data-port></span><span class="ez ez-r" data-port></span><span class="ez ez-b" data-port></span><span class="ez ez-l" data-port></span>'}${container && n.collapsed ? '' : '<span class="resize" data-resize></span>'}
    </div>`;
}
function edgeGeometry(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  const outer = contains(a, b) ? a : contains(b, a) ? b : null;
  let g;
  if (outer) {
    // Связь контейнера с его вложенным блоком идёт от ближней к блоку стороны рамки, а не сквозь блок. Сверху шапка, её не пересекаем.
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
// Сколько миллисекунд проявляется узел или связь, пришедшие по SSE; null — уже проявились. Перерисовка ставит
// отрицательную задержку анимации, и она продолжается с того же места, а не начинается заново.
const APPEAR = 250;
function appearing(id) {
  const t0 = state.appeared.get(id); if (t0 === undefined) return null;
  const age = Math.round(performance.now() - t0);
  if (age < APPEAR) return age;
  state.appeared.delete(id); return null;
}
// Отметка блока сменилась по SSE (агент прогоняет тесты): блок вспыхивает кольцом её цвета. Возраст вспышки переживает
// перерисовки, как у проявления.
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
  // Ниточка от заметки к блоку, если заметку отодвинули от него.
  const leaders = state.graph.nodes.filter(n => isNote(n) && n.attachedTo && visible(n)).map(n => {
    const parent = node(n.attachedTo); if (!parent) return '';
    const a = worldRect(n), b = worldRect(parent);
    return overlaps(a, b) ? '' : `<path class="leader" d="${edgeGeometry(a, b).d}"/>`;
  });
  layer.innerHTML = leaders.join('') + edges.join('');
  renderOverlay();
}
// Ручки на концах и крестик в середине у связи под курсором или выделенной. Лежат в отдельном слое поверх блоков,
// иначе блок перекрывает ручку на своей границе. Размер на экране не зависит от масштаба.
function renderOverlay() {
  const layer = $('#handle-layer'); if (!layer) return;
  const ids = new Set([state.hoverEdge, state.selected?.type === 'edge' ? state.selected.id : null, state.gesture?.type === 'rebind' ? state.gesture.edgeId : null].filter(Boolean));
  const k = 1 / (state.view?.z ?? 1);
  layer.innerHTML = [...ids].map(id => {
    const e = edgeOf(id), a = e && node(e.source), b = e && node(e.target); if (!a || !b || !visible(a) || !visible(b)) return '';
    const g = edgeGeometry(worldRect(a), worldRect(b)), cy = e.label ? g.my - 24 * k : g.my;
    // Ручки стоят чуть внутрь от концов линии, чтобы не лежать на кружке-порте блока.
    const path = document.querySelector(`.edge-group[data-edge="${CSS.escape(id)}"] .edge`);
    const length = path?.getTotalLength() ?? 0, inset = Math.min(20 * k, length / 3);
    const p1 = path && length ? path.getPointAtLength(inset) : { x: g.x1, y: g.y1 }, p2 = path && length ? path.getPointAtLength(length - inset) : { x: g.x2, y: g.y2 };
    const handles = [['source', p1], ['target', p2]].map(([end, pt]) => `<circle class="edge-handle" data-handle="${end}" data-edge="${esc(id)}" cx="${pt.x}" cy="${pt.y}" r="${7 * k}"><title>Перетащите на другой блок</title></circle>`).join('');
    return `${handles}<g class="edge-x" data-edge="${esc(id)}" transform="translate(${g.mx},${cy}) scale(${k})"><title>Удалить связь</title><circle r="10"/><path d="M-3.5 -3.5 3.5 3.5M3.5 -3.5-3.5 3.5"/></g>`;
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
// После перерисовки состояние наведения сверяется с реальным положением указателя:
// браузер сам шлёт pointerover по старой позиции, и без этого ручки могут залипнуть.
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
    const swatches = COLORS.map(c => `<button type="button" class="swatch${c ? ` c-${c}` : ' none'}${n.color === c ? ' active' : ''}" data-color="${c}" title="${COLOR_NAMES[c]}" aria-label="${COLOR_NAMES[c]}"></button>`).join('');
    const connect = isNote(n) ? '' : `<button type="button" class="tool" data-action="connect" title="Связать с другим блоком" aria-label="Связать">${icon('link', 15)}</button>`;
    float.innerHTML = `<div class="tools" id="tools">${swatches}<i class="sep"></i>${connect}<button type="button" class="tool" data-action="delete" title="Удалить" aria-label="Удалить">${icon('trash', 15)}</button></div>`;
  } else {
    const e = edgeOf(state.selected.id);
    float.innerHTML = `<div class="tools" id="tools"><input id="edge-label" value="${esc(e.label)}" placeholder="Подпись" maxlength="200" aria-label="Подпись связи"><button type="button" class="tool" data-action="swap" title="Сменить направление" aria-label="Сменить направление">${icon('swap', 15)}</button><button type="button" class="tool" data-action="delete" title="Удалить связь" aria-label="Удалить связь">${icon('trash', 15)}</button></div>`;
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
  // Панель не выходит за края окна: прижимается по горизонтали, а если сверху нет места — встаёт под узлом.
  const w = tools.offsetWidth, h = tools.offsetHeight, below = top - h < 4;
  tools.classList.toggle('below', below);
  tools.style.left = `${clamp(x, w / 2 + 6, Math.max(w / 2 + 6, vp.clientWidth - w / 2 - 6))}px`;
  tools.style.top = `${below ? bottom : top}px`;
}

// Контекстное меню

function openMenu(clientX, clientY, target) {
  const menu = $('#menu'), vp = $('#viewport'); if (!menu) return;
  const items = [];
  if (target.type === 'node') {
    const n = node(target.id);
    if (isNote(n)) { if (n.attachedTo) items.push({ action: 'detach', label: 'Открепить от блока' }); }
    else {
      items.push(state.focus === n.id ? { action: 'unfocus', label: 'Выйти из фокуса' } : { action: 'open', label: 'Открыть' }, '-');
      items.push({ action: 'new-inner-block', label: 'Блок внутри' }, { action: 'new-inner-note', label: 'Заметка внутри' });
      if (isContainer(n)) items.push({ action: 'fold', label: n.collapsed ? 'Развернуть подкарту' : 'Свернуть подкарту' });
      items.push('-', { action: 'note-for', label: 'Заметка к блоку' }, { action: 'connect', label: 'Связать с…' });
      // Проверить можно блок, у которого или внутри которого есть команда проверки: запускает её агент.
      if ([...subtreeOf(n.id)].some(id => node(id)?.test)) items.push({ action: 'check', label: 'Проверить' });
    }
    items.push({ action: 'edit', label: isNote(n) ? 'Изменить заметку' : 'Изменить' }, '-', { action: 'delete', label: 'Удалить', danger: true });
  } else if (target.type === 'edge') {
    items.push({ action: 'label', label: 'Подпись' }, { action: 'swap', label: 'Сменить направление' }, { action: 'rebind-source', label: 'Перенести начало на…' }, { action: 'rebind-target', label: 'Перенести конец на…' }, '-', { action: 'delete', label: 'Удалить связь', danger: true });
  } else {
    items.push({ action: 'new-block', label: target.container ? 'Блок внутри' : 'Блок' }, { action: 'new-note', label: target.container ? 'Заметка внутри' : 'Заметка' });
  }
  menu.innerHTML = items.map(i => i === '-' ? '<i class="sep"></i>' : `<button type="button" data-menu="${i.action}"${i.danger ? ' class="danger"' : ''}>${esc(i.label)}</button>`).join('');
  menu.hidden = false;
  const r = vp.getBoundingClientRect(), x = clamp(clientX - r.left, 4, vp.clientWidth - menu.offsetWidth - 4), y = clamp(clientY - r.top, 4, vp.clientHeight - menu.offsetHeight - 4);
  menu.style.left = `${x}px`; menu.style.top = `${y}px`;
  state.menu = { world: toWorld(clientX, clientY), target };
  menu.querySelector('button')?.focus({ preventScroll: true });
}
function closeMenu() { const menu = $('#menu'); if (menu) menu.hidden = true; state.menu = null; }
// Точка мира → координаты внутри поля подкарты контейнера (не меньше нуля).
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
      // Стикер ложится на правый верхний угол блока. У контейнера там шеврон, а внутри подкарты над блоком может не быть поля, тогда — справа от блока.
      const w = layoutSize(n).w, y = n.y - SIZE.note.h + 30, beside = isContainer(n) || (n.parentId && y < 0);
      createNode({ type: 'note', parentId: n.parentId, attachedTo: n.id, x: beside ? n.x + w + 16 : n.x + w - 40, y: beside ? Math.max(0, n.y) : y });
    } break;
    case 'connect': if (n) startConnect(n.id); break;
    case 'check': if (n) {
      await papi('/check', { ids: [n.id] });
      toast(state.agents.some(a => a.waiting) ? `Агент проверит «${nodeName(n)}»` : `Агента сейчас нет на связи: он увидит просьбу проверить «${nodeName(n)}», когда вернётся`);
    } break;
    case 'edit': if (n) startEdit(n.id, isNote(n) ? 'text' : 'title'); break;
    case 'detach': if (n && n.attachedTo) { n.attachedTo = null; await commit([{ type: 'update-node', id: n.id, patch: { attachedTo: null } }], `Откреплена заметка «${nodeName(n)}»`); } break;
    case 'delete': select(m.target); await deleteSelected(); break;
    case 'label': select(m.target); $('#edge-label')?.focus(); break;
    case 'swap': select(m.target); await swapEdge(); break;
    case 'rebind-source': case 'rebind-target': select(m.target); startRebind(m.target.id, action === 'rebind-source' ? 'source' : 'target'); break;
  }
}
// Новый узел внутри блока: свёрнутая подкарта разворачивается, блок без подкарты сразу получает просторное поле
// (если узел не сохранят, размер вернётся), узел встаёт на свободное место.
async function createInside(n, type) {
  if (n.collapsed) await commit(foldOps([[n, false]]), `Развёрнута подкарта «${nodeName(n)}»`);
  let grown = null;
  if (!isContainer(n)) {
    grown = { id: n.id, w: n.w, h: n.h };
    n.w = Math.max(n.w, ROOM.w + 2 * PAD + 2 * EDGE); n.h = Math.max(n.h, headerH(n) + ROOM.h + PAD + 2 * EDGE);
  }
  const spot = freeSpot(n, SIZE[type]);
  createNode({ type, parentId: n.id, x: spot.x, y: spot.y, grown });
}
function startConnect(id) { state.connectFrom = id; $('#viewport').classList.add('connecting'); toast('Нажмите на блок, с которым связать'); }
function startRebind(edgeId, end) { state.rebind = { edgeId, end }; $('#viewport').classList.add('connecting'); toast(end === 'source' ? 'Нажмите на блок, откуда пойдёт связь' : 'Нажмите на блок, куда пойдёт связь'); }
function stopConnect() { state.connectFrom = null; state.rebind = null; $('#viewport')?.classList.remove('connecting'); }
// Переносит начало или конец связи на другой блок. Связь не может замкнуться на себя и не может повторять существующую.
async function rebindEdge(edgeId, end, target) {
  const e = edgeOf(edgeId); if (!e || !target || !node(target) || isNote(node(target))) return;
  const next = { source: e.source, target: e.target, [end]: target };
  if (next.source === next.target) return toast('Связь не может замыкаться на себя');
  if (e[end] === target) return;
  if (state.graph.edges.some(x => x.id !== e.id && x.source === next.source && x.target === next.target)) return toast('Такая связь уже есть');
  await commit([{ type: 'update-edge', id: e.id, patch: { [end]: target } }], 'Перенесена связь');
  select({ type: 'edge', id: e.id });
}

// Вид: смещение и масштаб

function applyView() {
  const world = $('#world'); if (!world) return;
  world.style.transform = `translate(${state.view.x}px,${state.view.y}px) scale(${state.view.z})`;
  $('#zoom-value').textContent = `${Math.round(state.view.z * 100)}%`;
  // Масштаб для оформления: издалека (far) на карточках только крупные названия, вблизи — всё.
  const vp = $('#viewport');
  vp.classList.toggle('far', state.view.z < 0.55);
  vp.style.setProperty('--zoom', state.view.z);
  if (state.selected?.type === 'edge' || state.hoverEdge) renderOverlay();
  positionFloat();
  saveView();
}
// Вид помнится для каждого проекта вместе с режимом слежения.
const viewKey = id => `mycel.view.${id}`;
function saveView() { if (page.id && state.view) prefs.set(viewKey(page.id), JSON.stringify({ x: state.view.x, y: state.view.y, z: state.view.z, follow: state.follow })); }
function loadView(id) {
  let saved = null;
  try { saved = JSON.parse(prefs.get(viewKey(id))); } catch { saved = null; }
  const ok = Boolean(saved) && [saved.x, saved.y, saved.z].every(Number.isFinite) && saved.z >= ZOOM.min && saved.z <= ZOOM.max;
  // Карта, которую открывают впервые, следит за изменениями; сохранённый вид помнит, было ли слежение включено.
  state.follow = !ok || saved.follow === true;
  state.view = ok ? { x: saved.x, y: saved.y, z: saved.z } : null;
}
function setFollow(on) { if (state.follow !== on) { state.follow = on; saveView(); } }
// Автоматическое вписывание переезжает плавно. Любое действие человека с видом сначала снимает переезд,
// чтобы карта на экране совпадала с state.view, который он читает или меняет.
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
// Что вписывает «Показать всё»: в фокусе — модуль вместе с прикреплёнными к нему заметками, иначе вся основная карта.
const fitRoots = () => (state.focus ? state.graph.nodes.filter(n => n.id === state.focus || n.attachedTo === state.focus) : state.graph.nodes.filter(n => !n.parentId)).map(worldRect);
const boxOf = rects => {
  if (!rects.length) return null;
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
};
const sameBox = (a, b) => a === b || Boolean(a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 0.5));
// Вид, при котором прямоугольник мира целиком виден с полями; крупнее 100% карта не увеличивается.
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
// Слежение: карта вписывается целиком, а если так она мельче 40% — по верхним блокам, внутри которых
// добавились или изменились узлы ids (их помним, чтобы так же вписать карту при смене ширины чата).
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

// Создание, редактирование, удаление

// grown — прежний размер блока, который ради нового узла стал подкартой и вырос: вернётся, если узел не сохранят.
function createNode({ type, x, y, parentId = null, attachedTo = null, from = null, grown = null }) {
  if (state.editing) finishEdit();
  const size = SIZE[type];
  // Новый блок — логика без готового кода: план, пунктиром, пока его не реализуют и не проверят.
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
  // У контейнера на время правки шапка вмещает поле текста и поле подкарты сдвигается вниз: нужна полная перерисовка.
  if (isContainer(node(id))) { state.selected = { type: 'node', id }; renderMap(); }
  else select({ type: 'node', id });
  mountEditor(id, focus);
}
// Снимок открытого редактора: значения полей и положение курсора, чтобы пережить перерисовку.
function captureEditor(id) {
  const el = blockEl(id), title = part(el, 'b-title-input'), text = part(el, 'b-text-input');
  if (!text) return null;
  const active = document.activeElement === title ? title : text;
  return { title: title?.value ?? '', text: text.value, focus: active === text ? 'text' : 'title', start: active.selectionStart, end: active.selectionEnd };
}
// Повторный вызов на уже открытом редакторе только переводит фокус.
function mountEditor(id, focus = 'title', saved = null) {
  const n = node(id), el = blockEl(id); if (!n || !el) return;
  el.classList.add('editing');
  const title = part(el, 'b-title'), text = part(el, 'b-text');
  if (title) title.outerHTML = `<input class="b-title-input" placeholder="Название" maxlength="200" value="${esc(saved ? saved.title : n.title)}" aria-label="Название блока">`;
  if (text) text.outerHTML = `<textarea class="b-text-input" placeholder="${isNote(n) ? 'Заметка' : 'Текст'}" maxlength="20000" aria-label="Текст">${esc(saved ? saved.text : n.text)}</textarea>`;
  const target = part(el, focus === 'text' || isNote(n) ? 'b-text-input' : 'b-title-input'); if (!target) return;
  target.focus({ preventScroll: true });
  if (saved) target.setSelectionRange(saved.start, saved.end);
  else if (target.classList.contains('b-title-input')) target.select();
  else target.selectionStart = target.selectionEnd = target.value.length;
  renderFloat();
}
// saved — снимок редактора, если его поле уже убрано с карты.
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
        await commit([...ops, ...growOps(n.parentId)], `${isNote(n) ? 'Добавлена заметка' : 'Добавлен блок'} «${nodeName(n)}»`);
      }
    } else {
      const patch = {};
      if (title !== n.title) patch.title = title;
      if (text !== n.text) patch.text = text;
      Object.assign(n, patch);
      if (Object.keys(patch).length) await commit([{ type: 'update-node', id, patch }], `${isNote(n) ? 'Изменена заметка' : 'Изменён блок'} «${nodeName(n)}»`);
      else renderMap();
    }
  } catch (err) { await recover(err); }
  await flushPending();
}
// Несохранённый узел убирается вместе со своей связью, а выросший ради него блок возвращает прежний размер.
function dropFresh(id, fresh) {
  state.fresh.delete(id);
  state.graph.nodes = state.graph.nodes.filter(x => x.id !== id);
  state.graph.edges = state.graph.edges.filter(e => e.id !== fresh.edgeId);
  const grown = fresh.grown && node(fresh.grown.id);
  if (grown) { grown.w = fresh.grown.w; grown.h = fresh.grown.h; }
}
// Узел, всё вложенное в него и заметки, прикреплённые к удаляемым блокам.
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
      await commit([{ type: 'delete-edge', id: s.id }], 'Удалена связь');
      toast('Связь удалена', { action: 'Отменить', run: () => commit([{ type: 'add-edge', edge: e }], 'Восстановлена связь').catch(fail) });
      return;
    }
    const n = node(s.id), removed = subtreeOf(n.id);
    const nodes = state.graph.nodes.filter(x => removed.has(x.id)), edges = state.graph.edges.filter(e => removed.has(e.source) || removed.has(e.target));
    select(null);
    if (state.fresh.has(n.id)) { dropFresh(n.id, state.fresh.get(n.id)); renderMap(); return; }
    await commit([{ type: 'delete-node', id: n.id }], `${isNote(n) ? 'Удалена заметка' : 'Удалён блок'} «${nodeName(n)}»`);
    const restore = [...nodes.map(x => ({ type: 'add-node', node: x })), ...edges.map(e => ({ type: 'add-edge', edge: e }))];
    toast(isNote(n) ? 'Заметка удалена' : nodes.length > 1 ? 'Блок и его содержимое удалены' : 'Блок удалён', { action: 'Отменить', run: () => commit(restore, `${isNote(n) ? 'Восстановлена заметка' : 'Восстановлен блок'} «${nodeName(n)}»`).catch(fail) });
  } catch (err) { fail(err); }
}
async function connect(source, target) {
  if (source === target || isNote(node(source)) || isNote(node(target))) return;
  if (state.graph.edges.some(e => e.source === source && e.target === target)) return toast('Такая связь уже есть');
  const e = { id: crypto.randomUUID(), source, target, label: '' };
  await commit([{ type: 'add-edge', edge: e }], 'Добавлена связь');
  select({ type: 'edge', id: e.id });
}
async function swapEdge() {
  const e = edgeOf(state.selected?.id); if (!e) return;
  if (state.graph.edges.some(x => x.source === e.target && x.target === e.source)) return toast('Встречная связь уже есть');
  await commit([{ type: 'update-edge', id: e.id, patch: { source: e.target, target: e.source } }], 'Изменено направление связи');
}
// Видимый блок под точкой мира с запасом в несколько экранных пикселей от края; заметки не считаются.
// Из вложенных друг в друга подходит самый глубокий. level ограничивает поиск одним уровнем.
function blockNear(p, exclude = null, marginPx = 12, level) {
  const m = marginPx / (state.view?.z ?? 1);
  let found = null, best = -1;
  for (const n of state.graph.nodes) {
    if (isNote(n) || n.id === exclude || !visible(n) || (level !== undefined && n.parentId !== level)) continue;
    // Запас у края вложенного блока не выходит за поле подкарты: бросок на шапку контейнера достаётся контейнеру при любом масштабе.
    const zone = n.parentId ? clip(grow(worldRect(n), m), fieldRect(node(n.parentId))) : grow(worldRect(n), m), d = depthOf(n);
    if (inRect(p, zone) && d >= best) { found = n.id; best = d; }
  }
  return found;
}
// Блок, к которому ляжет связь: тот, внутри которого указатель (из вложенных — самый глубокий, из лежащих друг на друге
// — верхний: карточка над подкартой, позже нарисованная — над прежней); только если такого нет — ближайший с запасом
// у края. Так бросок у края нужного блока не достаётся соседу, задетому запасом, а к подкарте, лежащей под блоком,
// связь ведётся бросом на её видимую часть. Бросок на прикреплённую заметку — связь с её блоком.
function linkTarget(p, from) {
  const order = new Map(state.graph.nodes.map((n, i) => [n.id, i]));
  const under = n => n.id !== from && visible(n) && inRect(p, n.parentId ? clip(worldRect(n), fieldRect(node(n.parentId))) : worldRect(n));
  const hits = state.graph.nodes.filter(n => !isNote(n) && under(n));
  hits.sort((a, b) => depthOf(b) - depthOf(a) || isContainer(a) - isContainer(b) || order.get(b.id) - order.get(a.id));
  const note = state.graph.nodes.find(n => isNote(n) && n.attachedTo && n.attachedTo !== from && under(n));
  return hits[0]?.id ?? note?.attachedTo ?? blockNear(p, from);
}
// Развёрнутый контейнер, в поле подкарты которого лежит точка; из вложенных — самый глубокий. skip — перетаскиваемый
// узел со всем вложенным: в самого себя его не положить.
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
// Превью связи во время протягивания: линия со стрелкой тянется за курсором, а над блоком встаёт так, как ляжет готовая связь.
function showPreview(a, b) { const temp = $('#edge-temp'); if (!temp) return; temp.removeAttribute('hidden'); temp.setAttribute('d', edgeGeometry(a, b).d); }
function hidePreview() { $('#edge-temp')?.setAttribute('hidden', ''); }
function markDrop(id) { document.querySelectorAll('.block.drop').forEach(el => el.classList.remove('drop')); if (id) blockEl(id)?.classList.add('drop'); }
// Подсветка поля подкарты, куда ляжет перетаскиваемый узел.
function markLevel(id) { document.querySelectorAll('.sub.drop-target').forEach(el => el.classList.remove('drop-target')); if (id) blockEl(id)?.querySelector(':scope > .sub')?.classList.add('drop-target'); }
// Узел и всё, что лежит в его подкарте.
function nestedIn(id) {
  const inside = new Set([id]);
  for (let changed = true; changed; ) { changed = false; for (const n of state.graph.nodes) if (!inside.has(n.id) && inside.has(n.parentId)) { inside.add(n.id); changed = true; } }
  return inside;
}
// Перенос узла на другой уровень: в поле подкарты под указателем или на основную карту. Координаты пересчитываются
// в систему нового уровня, внутри подкарты — не левее и не выше поля. Прикреплённые заметки сервер переносит вместе
// с блоком; заметка цепляется к блоку нового уровня, на который её бросили, иначе открепляется.
async function moveToLevel(n, target, p) {
  const r = worldRect(n), o = target ? subOrigin(node(target)) : { x: 0, y: 0 };
  const x = target ? Math.max(0, Math.round(r.x - o.x)) : Math.round(r.x), y = target ? Math.max(0, Math.round(r.y - o.y)) : Math.round(r.y);
  const patch = { parentId: target, x, y };
  if (isNote(n)) patch.attachedTo = blockNear(p, n.id, 0, target);
  // Локально — как сделает сервер, чтобы контейнер вырос под новое содержимое и сохранил размер в той же записи.
  for (const note of notesOf(n.id)) { note.x += x - n.x; note.y += y - n.y; note.parentId = target; }
  Object.assign(n, patch);
  const where = target ? `в «${nodeName(node(target))}»` : 'на основную карту';
  await commit([{ type: 'update-node', id: n.id, patch }, ...growOps(target)], `${isNote(n) ? 'Перенесена заметка' : 'Перенесён блок'} «${nodeName(n)}» ${where}`);
}
async function flushPending() { if (state.pending && !interacting()) { state.pending = false; await liveRefresh(state.wanted); } }

// Указатель: перетаскивание узлов, изменение размера, связи, панорамирование, щипок

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
  // Захват указателя на самом узле: тогда pointerup, click и dblclick приходят на него, а не на холст.
  const capture = el => { try { el.setPointerCapture(e.pointerId); } catch { /* указатель уже отпущен */ } };
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
  // Связь начинается с края блока (полоса по всему контуру), с кружка-порта или с любого места блока с Alt. Кружок важнее
  // ручки связи, если они оказались в одной точке; угол изменения размера — важнее края.
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
    // Жест начинается от показанного размера: развёрнутая подкарта бывает больше сохранённого.
    const n = node(blockElement.dataset.id), shown = layoutSize(n);
    state.gesture = { type: 'resize', id: n.id, w: shown.w, h: shown.h, x: e.clientX, y: e.clientY };
    capture(blockElement); return;
  }
  if (blockElement) {
    if (state.editing) finishEdit();
    const n = node(blockElement.dataset.id);
    // Прикреплённые заметки едут вместе с блоком одной группой.
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
// Размеры контейнеров зависят от содержимого: после сдвига или растяжения узла пересчитываем их по всей цепочке.
function relayout() {
  sizes = new Map();
  for (const el of document.querySelectorAll('.block.container')) { const n = node(el.dataset.id); if (!n) continue; const s = layoutSize(n); el.style.width = `${s.w}px`; el.style.height = `${s.h}px`; }
}
function onPointerMove(e) {
  // Отпускание, которого страница не увидела (например, на полосе прокрутки), не держит обновление дольше движения мыши.
  if (!e.buttons && pressed.delete(e.pointerId) && !pressed.size) released();
  state.pointer = { x: e.clientX, y: e.clientY };
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = state.gesture; if (!g) return;
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  switch (g.type) {
    // Человек сам двигает вид или карту — слежение выключается.
    case 'pan': {
      if (!g.moved && Math.hypot(dx, dy) > 3) { g.moved = true; setFollow(false); }
      state.view.x = g.vx + dx; state.view.y = g.vy + dy; applyView(); break;
    }
    case 'drag': {
      if (!g.moved && Math.hypot(dx, dy) <= 3) break;
      if (!g.moved) { g.moved = true; setFollow(false); blockEl(g.id)?.classList.add('dragging'); }
      const n = node(g.id), p = toWorld(e.clientX, e.clientY);
      let level = containerAt(p, g.skip);
      if (focusIds && !focusIds.has(level)) level = n.parentId; // в фокусе узел не уходит за пределы модуля
      let wx = Math.round(dx / state.view.z), wy = Math.round(dy / state.view.z);
      // Пока указатель над полем своей подкарты, группа не уходит левее и выше поля; сдвиг общий, иначе заметки отстают.
      // Вне поля узел тянется свободно: отпустите его на основной карте или в другой подкарте, чтобы перенести туда.
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
      // Развёрнутая подкарта не становится меньше содержимого и хранит ровно тот размер, что видно.
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
// Отпущен последний нажатый указатель: главная дорисовывает список уже после клика, карта дочитывает отложенную правку.
function released() { if (page.kind === 'home') { if (home.held) setTimeout(renderHome); } else flushPending(); }
async function onPointerUp(e) {
  pointers.delete(e.pointerId); pressed.delete(e.pointerId);
  const g = state.gesture;
  // Нажатие без жеста — шеврон, панель, меню, строка главной.
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
        let message = `${isNote(n) ? 'Перемещена заметка' : 'Перемещён блок'} «${nodeName(n)}»`;
        if (isNote(n)) {
          // Заметка, отпущенная на блоке своего уровня, прикрепляется к нему. Открепить её можно через меню.
          const target = blockNear(p, g.id, 0, n.parentId);
          if (target && target !== n.attachedTo) { patch.attachedTo = target; n.attachedTo = target; message = `Прикреплена заметка «${nodeName(n)}»`; }
        }
        await commit([{ type: 'update-node', id: g.id, patch }, ...growOps(n.parentId)], message); break;
      }
      case 'resize': {
        const n = node(g.id); if (!n || state.fresh.has(g.id)) break;
        await commit([{ type: 'update-node', id: g.id, patch: { w: n.w, h: n.h } }, ...growOps(n.parentId)], `Изменён размер: ${isNote(n) ? 'заметка' : 'блок'} «${nodeName(n)}»`); break;
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
        // Связь появляется только при отпускании на блоке; бросок в пустоту ничего не создаёт.
        hidePreview();
        const target = linkTarget(toWorld(e.clientX, e.clientY), g.from);
        if (target) await connect(g.from, target);
        break;
      }
    }
  } catch (err) { await recover(err); }
  await flushPending();
}
// Наведение на связь (линию, подпись, ручку или крестик) показывает её ручки и крестик.
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
// Наведение на блок подсвечивает его связи.
document.addEventListener('pointerover', e => {
  const blockElement = e.target.closest?.('.block'); if (!blockElement || state.gesture || !state.graph) return;
  const id = blockElement.dataset.id;
  for (const edge of state.graph.edges) if (edge.source === id || edge.target === id) document.querySelector(`.edge-group[data-edge="${CSS.escape(edge.id)}"]`)?.classList.add('related');
});
document.addEventListener('pointerout', e => {
  if (e.target.closest?.('.block') && !e.target.closest('.block').contains(e.relatedTarget)) document.querySelectorAll('.edge-group.related').forEach(el => el.classList.remove('related'));
});
// Нажатие отмечается раньше всех обработчиков; новое основное нажатие снимает отметки, отпускание которых потерялось.
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
  // Блок с подкартой открывается — погружение на уровень ниже; блок без подкарты и заметка правятся.
  if (blockElement) {
    const n = node(blockElement.dataset.id); if (!n || state.editing === n.id) return;
    if (isContainer(n)) { walk(() => dive(n.id)); return; }
    const under = document.elementFromPoint(e.clientX, e.clientY); startEdit(n.id, under?.closest('.b-text') || isNote(n) ? 'text' : 'title'); return;
  }
  if (e.target.closest('[data-edge]')) { $('#edge-label')?.focus(); return; }
  // Пустое место в поле подкарты — часть её блока: погружение в него. Пустое место вне блоков и поле блока, который
  // уже открыт, — уровень вверх.
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
  // В фокусе пустое место — это поле модуля: новый узел ляжет внутрь блока фокуса.
  else target = { type: 'canvas', container: containerAt(toWorld(e.clientX, e.clientY)) ?? state.focus };
  if (target.type !== 'canvas') select(target);
  openMenu(e.clientX, e.clientY, target);
});

// Клики по кнопкам

document.addEventListener('click', async e => {
  const control = e.target.closest('button'); if (!control) return;
  // Главная: строка для агента и корзина у проекта.
  if (control.hasAttribute('data-copy-agent')) return copyAgent().catch(fail);
  if (control.dataset.trash) { control.disabled = true; return deleteProject(control.dataset.trash).catch(err => { control.disabled = false; fail(err); }); }
  // Запрос доступа виртуальной машины и отключение машины.
  if (control.dataset.pairApprove || control.dataset.pairDeny) return answerPair(control, Boolean(control.dataset.pairApprove));
  if (control.dataset.revoke) { control.disabled = true; return api(`/api/devices/${encodeURIComponent(control.dataset.revoke)}/revoke`, {}).then(info => { setAccess(info); toast('Машина отключена'); }, err => { control.disabled = false; fail(err); }); }
  // await обязателен: без него ошибка сохранения проходит мимо catch.
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
    // Карандаш в углу блока — правка названия и текста сразу, и у блока с подкартой тоже.
    if (control.hasAttribute('data-pen')) return startEdit(control.closest('.block').dataset.id, 'title');
    if (control.dataset.color !== undefined && state.selected?.type === 'node') {
      const n = node(state.selected.id); n.color = control.dataset.color;
      return await commit([{ type: 'update-node', id: n.id, patch: { color: n.color } }], `${isNote(n) ? 'Изменена заметка' : 'Изменён блок'} «${nodeName(n)}»`);
    }
    switch (control.dataset.action) {
      case 'zoom-in': zoomCenter(1.2); break;
      case 'zoom-out': zoomCenter(1 / 1.2); break;
      // «Показать всё» всегда вписывает всю карту и включает слежение.
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
    if (edge && label !== edge.label) { edge.label = label; await commit([{ type: 'update-edge', id: edge.id, patch: { label } }], 'Изменена подпись связи').catch(recover); }
  }
});
document.addEventListener('focusout', e => {
  if (!e.target.isConnected) return; // поле убрано перерисовкой, а не пользователем
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
  // Поле ввода забирает клавиши себе. Ползунок уровня — только стрелки: после щелчка по нему Delete, Enter и Tab
  // по-прежнему работают с выделенным блоком.
  if (e.target.matches('input:not([type="range"]), textarea')) {
    if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); if (state.connectFrom || state.rebind) stopConnect(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && state.editing) { e.preventDefault(); finishEdit(); return; }
    if (e.key === 'Enter' && e.target.classList.contains('b-title-input')) { e.preventDefault(); part(e.target.closest('.block'), 'b-text-input')?.focus(); return; }
    if (e.key === 'Enter' && e.target.id === 'edge-label') { e.preventDefault(); e.target.blur(); }
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) { e.preventDefault(); deleteSelected(); return; }
  // Esc заканчивает правку (курсор мог уйти из поля, а правка — остаться), потом снимает выделение, а когда нет ни
  // правки, ни выделения, — поднимает на уровень вверх.
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

// Уровни: ползунок сворачивает подкарты глубже выбранного уровня и разворачивает остальные.
// Концепция — свёрнуты все подкарты, механика — видны подкарты основной карты, техника — и подкарты механики,
// код — развёрнуто всё.

const foldedAt = (level, n) => level < LEVELS.length && depthOf(n) >= level - 1;
// Подкарте уровень подходит, если она свёрнута так, как он сворачивает. Подкарты внутри кода — тоже код: «Коду»
// подходят и свёрнутые, иначе в погружении в технику с подкартами у шагов не горел бы ни один уровень.
const fits = (level, n) => n.collapsed === foldedAt(level, n) || (level === LEVELS.length && depthOf(n) >= LEVELS.length - 1);
// В погружении ползунок действует только внутри открытого блока: сам он и путь к нему остаются развёрнутыми.
// Блок считается по текущей карте, а не по последней отрисовке: после 409 её перечитывают до перерисовки.
const levelContainers = () => {
  const inside = state.focus ? focusSet(state.focus) : null;
  return state.graph.nodes.filter(n => isContainer(n) && (!inside || (inside.has(n.id) && n.id !== state.focus)));
};
// Текущий уровень — по видимым подкартам: что лежит внутри свёрнутых, на экране не видно. Если видимому подходят
// несколько уровней, горит нажатый последним, иначе тот, до которого видна карта (в погружении — уровень блоков
// внутри открытого блока).
const shownLevel = () => Math.min(Math.max(0, ...state.graph.nodes.filter(visible).map(depthOf)) + 1, LEVELS.length);
function currentLevel() {
  if (!state.graph.nodes.some(isContainer)) return 0;
  const containers = levelContainers().filter(visible), ok = level => containers.every(n => fits(level, n));
  if (state.level && ok(state.level)) return state.level;
  const shown = shownLevel();
  return ok(shown) ? shown : 0;
}
// Ползунок: деления по уровням, заполнено до выбранного, рядом название. Карте не подходит ни один уровень (подкарты
// свёрнуты вразнобой шевронами) — бегунок стоит на уровне, до которого видна карта, но тусклый и без названия. Пока
// бегунок держат мышью или выбранный уровень ещё применяется, он не прыгает от обновлений карты.
function paintLevel(level) {
  const box = $('#levels'), input = $('#level'); if (!box || !input) return;
  const mixed = box.classList.contains('mixed');
  input.value = level; input.setAttribute('aria-valuetext', mixed ? 'Подкарты свёрнуты вразнобой' : LEVELS[level - 1]);
  box.style.setProperty('--level', (level - 1) / (LEVELS.length - 1));
  box.querySelectorAll('.level-track i').forEach((tick, i) => tick.classList.toggle('on', i < level));
  $('#level-name').textContent = mixed ? '' : LEVELS[level - 1];
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
// Выбор на ползунке встаёт в очередь переходов, как погружения, и шаг применяет уровень, выбранный последним. Пока
// шаги не прошли, ползунок показывает выбор: перерисовка после записи вернула бы бегунок назад, и следующий шаг,
// стрелка или щелчок считались бы от старого уровня.
let picked = 0, picks = 0;
function pickLevel(level) {
  picked = level; picks++;
  walk(() => showLevel(picked)).finally(() => { if (!--picks) renderLevels(); });
}
async function showLevel(level) {
  state.level = level;
  const ops = () => foldOps(levelContainers().map(n => [n, foldedAt(level, n)])), first = ops();
  if (first.length) await commit(first, `Показан уровень «${LEVELS[level - 1]}»`, ops); else renderLevels();
  fitView();
}

// Фокус: работа над одним модулем. На карте только он со всем вложенным, сверху путь к нему и действия. Чат показывает
// разговор о модуле, новые сообщения прикладывают его, агент видит, над чем работает человек.

const focusSet = id => { const ids = nestedIn(id); for (const n of state.graph.nodes) if (n.attachedTo === id) ids.add(n.id); return ids; };
const ancestorsOf = n => { const chain = []; for (let p = n.parentId; p; p = node(p)?.parentId) chain.unshift(node(p)); return chain.filter(Boolean); };
// Переходы по уровням идут по очереди: следующий считается от фокуса, в котором закончился предыдущий.
let travel = Promise.resolve();
function walk(step) {
  const gen = page.gen;
  state.walking++;
  travel = travel.then(() => gen === page.gen && state.graph ? step() : null).catch(recover).finally(() => { if (gen === page.gen) state.walking--; });
  return travel;
}
// Сворачивание одной записью, как у ползунка уровня: агентов оно не будит. Сначала глубокие подкарты, потом
// внешние — соседи раздвигаются уже под итоговый размер. В фокусе первое изменение каждой подкарты запоминается —
// и погружением, и ползунком, и шевроном: выход возвращает карту такой, какой она была до фокуса.
function foldOps(list) {
  const ops = list.filter(([x, folded]) => x.collapsed !== folded).sort(([a], [b]) => depthOf(b) - depthOf(a)).map(([x, folded]) => {
    if (state.focus && !state.focusFolds.has(x.id)) state.focusFolds.set(x.id, x.collapsed);
    x.collapsed = folded; return { type: 'update-node', id: x.id, patch: { collapsed: folded } };
  });
  if (state.focus && ops.length) saveDive();
  return ops;
}
// Шеврон и пункт меню. Сообщение собирается уже после переключения. После 409 операция собирается по перечитанной
// карте: подкарту, которую агент успел свернуть или развернуть, не переключит обратно повтор прежней.
function toggleFold(n) {
  const id = n.id, want = !n.collapsed, ops = foldOps([[n, want]]);
  return commit(ops, `${want ? 'Свёрнута' : 'Развёрнута'} подкарта «${nodeName(n)}»`, () => { const m = node(id); return m && isContainer(m) ? foldOps([[m, want]]) : []; });
}
// Что вернёт выход из погружения, помнится и во вкладке: её могут перезагрузить, а запрос при закрытии страницы —
// не дойти. Тогда сворачивание вернёт следующее открытие проекта в этой вкладке. now — что поставил фокус.
const diveKey = id => `mycel.dive.${id}`;
function saveDive() { tabPrefs.set(diveKey(page.id), JSON.stringify([...state.focusFolds].map(([id, was]) => [id, was, node(id)?.collapsed ?? was]))); }
function undive(id) {
  let saved = null;
  try { saved = JSON.parse(tabPrefs.get(diveKey(id))); } catch { saved = null; }
  tabPrefs.del(diveKey(id));
  if (!Array.isArray(saved)) return [];
  // Только подкарты, которые с тех пор никто не менял: запрос при закрытии мог и дойти.
  const back = saved.filter(e => Array.isArray(e) && typeof e[1] === 'boolean' && e[1] !== e[2]).map(([x, was, now]) => [node(x), was, now]);
  return foldOps(back.filter(([x, , now]) => x && isContainer(x) && x.collapsed === now));
}
// Снимает фокус; возвращает сборщик операций для одной записи, которые вернут сворачивание, поменянное погружениями.
// После 409 сборщик вызывается снова по перечитанной карте.
function restoreOps() {
  const back = [...state.focusFolds];
  state.focus = null; state.level = 0; state.focusFolds = new Map();
  return () => foldOps(back.map(([id, was]) => [node(id), was]).filter(([x]) => x && isContainer(x)));
}
// Погружение в блок: фокус на нём, его подкарта и всё на пути к нему развёрнуто, подкарты его блоков свёрнуты —
// виден ровно один уровень вниз. Вид плавно переезжает к блоку. Первое погружение запоминает вид карты.
// Открытая правка сначала сохраняется: свёрнутая подкарта убрала бы её поле.
async function dive(id) {
  const gen = page.gen;
  if (state.editing) await finishEdit();
  if (state.tab !== 'map') await showTab('map');
  const n = node(id); if (gen !== page.gen || !n || isNote(n)) return;
  if (!state.focus) Object.assign(state, { focusView: { ...state.view }, focusSince: new Date().toISOString(), focusFolds: new Map() });
  state.focus = id; state.level = 0;
  select(null);
  // После 409 — заново по перечитанной карте: подкарты, которые агент добавил в блок, тоже свернутся.
  const plan = () => { const m = node(id); return m ? foldOps([...childrenOf(id).filter(isContainer).map(k => [k, true]), ...[m, ...ancestorsOf(m)].filter(isContainer).map(x => [x, false])]) : []; };
  const ops = plan();
  if (ops.length) await commit(ops, `Открыт блок «${nodeName(n)}»`, plan); else renderMap();
  glide(); fitView();
  papi('/focus', { id }).catch(() => {});
}
// Уровень вверх: открывается блок выше, а с верхнего блока — вся карта.
async function goUp() {
  const n = state.focus && node(state.focus); if (!n) return;
  if (n.parentId && node(n.parentId)) await dive(n.parentId); else await exitFocus();
}
// Выход на основную карту: сворачивание, которое поменяли погружения, возвращается одной записью; вид — прежний,
// а в режиме слежения карта снова вписывается целиком.
async function exitFocus() {
  if (!state.focus) return;
  if (state.editing) await finishEdit();
  const plan = restoreOps(), ops = plan();
  papi('/focus', { id: null }).catch(() => {});
  if (ops.length) await commit(ops, 'Показана вся карта', plan); else renderMap();
  tabPrefs.del(diveKey(page.id));
  if (state.follow) autoFit(null);
  else if (state.focusView) { glide(); state.view = state.focusView; applyView(); }
}
// Правки человека: первая его запись, которая меняет содержимое карты, начинает их на сервере, и внизу посередине
// карты появляется «Закончить правки». Пока её не нажали, агент на эти правки не отвечает; кнопка отдаёт их одним
// сообщением в чате.
// Пока открыто предложение агента, на месте кнопки — его название и «Отклонить» / «Принять»: решение заканчивает и правки.
function renderEdits() {
  const el = $('#edits'); if (!el) return;
  const proposal = state.graph?.proposal, html = proposal
    ? `<span class="edits-title" title="${esc(proposal.title)}">Предложение «${esc(proposal.title)}»</span><span class="edits-count" title="Карточек в предложении">${state.graph.nodes.filter(n => n.proposed).length}</span><button type="button" class="btn ghost" data-action="proposal-reject">Отклонить</button><button type="button" class="btn" data-action="proposal-accept">Принять</button>`
    : state.edit ? `<button type="button" class="btn" data-action="edits-done">Закончить правки</button><span class="edits-count" title="Записей с начала правок">${state.edit.count}</span>` : '';
  el.hidden = !html;
  if (el.innerHTML !== html) el.innerHTML = html;
}
// Решение по предложению агента: принятое остаётся (новое — планом, пунктиром), отклонённое убирается с карты.
async function decideProposal(accept) {
  if (state.editing) await finishEdit();
  await Promise.allSettled([...saving]);
  const gen = page.gen, { graph, message } = await papi(`/proposal/${accept ? 'accept' : 'reject'}`, {});
  if (gen !== page.gen) return;
  if (graph.revision > state.graph.revision) { adopt(graph); renderMap(); }
  state.edit = null; renderEdits();
  toast(message.proposal.result === 'accepted' ? 'Предложение принято' : 'Предложение отклонено');
}
async function finishEdits() {
  // Открытая правка текста и записи, которые ещё идут, — тоже часть правок.
  if (state.editing) await finishEdit();
  await Promise.allSettled([...saving]);
  const gen = page.gen, { message } = await papi('/edits', {});
  if (gen !== page.gen) return;
  state.edit = null; renderEdits();
  if (message) toast('Правки переданы агенту');
}
function renderFocus() {
  const bar = $('#focus-bar'); if (!bar) return;
  const n = state.focus && node(state.focus);
  bar.hidden = !n || state.tab !== 'map';
  $('#app').classList.toggle('focused', Boolean(n));
  if (!n) return;
  const ref = x => `<button type="button" class="ref" data-focus-on="${esc(x.id)}">${esc(nodeName(x))}</button>`;
  bar.innerHTML = `<nav class="focus-path"><button type="button" class="ref" data-action="unfocus">Карта</button>${ancestorsOf(n).map(a => `<i>›</i>${ref(a)}`).join('')}<i>›</i><b>${esc(nodeName(n))}</b></nav>
    <span class="grow"></span>
    <button type="button" class="btn ghost" data-focus-act="block">Блок внутри</button><button type="button" class="btn ghost" data-focus-act="note">Заметка</button>
    <button type="button" class="icon-btn" data-action="unfocus" title="Выйти из фокуса" aria-label="Выйти из фокуса">${icon('close', 16)}</button>`;
}

// Агенты. Разговор с агентом идёт в его окне — в Mycel чата нет. Здесь только точка в строке управления (кто на
// связи: зелёная — ждёт действий человека, жёлтая — работает) и строка над ней — что агент делает сейчас.

// Агент на связи, пока ждёт изменений; занят, если обращался за последние 10 минут.
function agentState(a) { return a.waiting ? 'on' : Date.now() - new Date(a.lastSeen).getTime() < 600000 ? 'busy' : 'off'; }
const barHtml = () => `
    <a class="back" href="#/">‹ ${esc(page.name)}</a>
    <nav class="tabs"><button type="button" data-tab="map" class="active">Карта</button><button type="button" data-tab="history">История</button></nav>
    <div class="levels" id="levels"><div class="level-track">${LEVELS.map((_, i) => `<i style="left: calc(7px + (100% - 14px) * ${i / (LEVELS.length - 1)})"></i>`).join('')}<input type="range" id="level" min="1" max="${LEVELS.length}" step="1" value="${LEVELS.length}" aria-label="Уровень"></div><span class="level-name"><span id="level-name"></span>${LEVELS.map(name => `<span>${name}</span>`).join('')}</span></div>
    <nav class="tabs"><button type="button" data-action="health" id="health-toggle" aria-pressed="false" title="Что с блоками не так: не прошли проверку, устарели, без проверки, риски">Здоровье</button></nav>
    <span class="grow"></span>
    <span id="status" role="status"></span>
    <span class="agents" id="agents"></span>
    <a class="icon-btn" href="${page.prefix}/export" download title="Скачать карту" aria-label="Скачать карту">${icon('download', 16)}</a>`;
function renderAgents() {
  const el = $('#agents'); if (!el) return;
  el.innerHTML = state.agents.filter(a => agentState(a) !== 'off').map(a => `<i class="dot ${agentState(a)}" title="${esc(a.actor)}"></i>`).join('');
  renderActivity();
}
// Что агент делает сейчас: полоса над строкой управления — кто и что, и шкала из сегментов; без процента по шкале
// бежит отсвет. Агент снимает строку сам, когда закончил.
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
// Что человек выделил, хаб узнаёт сразу: агенту «сделай вот это» понятно без чата.
function reportSelection() {
  const id = state.selected?.type === 'node' && node(state.selected.id) && !state.fresh.has(state.selected.id) ? state.selected.id : null;
  if (id === reportSelection.last || !page.prefix) return;
  reportSelection.last = id;
  papi('/selection', { id }).catch(() => { reportSelection.last = undefined; });
}// Переход к блоку, который показывает агент (mycel show): свёрнутые подкарты на пути к нему разворачиваются, блок
// выделяется и встаёт в центр. Блок вне погружения скрыт: тогда открывается блок, в котором он лежит, а блок основной
// карты — на всей карте.
// Код глазами Mycel. Над блоком, файлы которого агент правит сейчас, — имя агента (над свёрнутой подкартой, если блок
// в ней); у блока, чьи файлы изменили после того, как его описали, — «устарел?». Правка гаснет через 2 минуты после
// последней, блоки из «doing --on» держатся, пока агент их не снял.
const EDITING = 2 * 60e3;
function shownFor(id) { for (let n = node(id); n; n = node(n.parentId)) { const el = blockEl(n.id); if (el) return el; } return null; }
// Что с блоком не так — для режима «Здоровье»; тот же разбор, что у mycel health.
function issuesOf(n) {
  const r = state.code.risks[n.id];
  return [n.status === 'failed' && ['failed', 'не прошла'], state.code.stale[n.id] && ['stale', 'устарел?'], n.files && !n.test && n.status !== 'passed' && ['untested', 'без проверки'],
    n.status === 'plan' && ['plan', 'план'], r && (r.todo || r.secrets) && ['risk', [r.todo && `TODO ${r.todo}`, r.secrets && 'ключ?'].filter(Boolean).join(' · ')]].filter(Boolean);
}
const HEALTH = [['failed', 'Не прошло'], ['stale', 'Устарело'], ['untested', 'Без проверки'], ['plan', 'План'], ['risk', 'Риски']];
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
  // Устаревшее и что не так — у видимого блока; у свёрнутой подкарты — за всё, что в ней, числом.
  const health = state.health && state.tab === 'map', stale = new Map(), tags = new Map();
  $('#viewport')?.classList.toggle('health', health);
  for (const n of state.graph.nodes) {
    if (isNote(n)) continue;
    const s = state.code.stale[n.id], issues = health ? issuesOf(n) : [];
    if (!s && !issues.length) continue;
    const el = shownFor(n.id); if (!el) continue;
    if (s && !health) stale.set(el, [...(stale.get(el) ?? []), `«${nodeName(n)}»: ${s.files.join(', ')} (${s.by})`]);
    const own = tags.get(el) ?? new Map();
    for (const [k, label] of issues) { const t = own.get(k) ?? { label, n: 0 }; t.n++; own.set(k, t); }
    if (issues.length) tags.set(el, own);
  }
  // Имя агента и «устарел?» — одной строкой над блоком: при отдалении карты они не налезают друг на друга.
  for (const el of new Set([...who.keys(), ...stale.keys()])) {
    const actors = who.get(el), lines = stale.get(el);
    if (actors) el.classList.add('working');
    el.insertAdjacentHTML('beforeend', `<span class="code-row">${actors ? `<span class="who">${esc([...actors].join(', '))}</span>` : ''}${lines ? `<span class="stale-tag" title="${esc(`Файлы изменили после того, как блок описали:\n${lines.join('\n')}`)}">${lines.length > 1 ? `устарели: ${lines.length}` : 'устарел?'}</span>` : ''}</span>`);
  }
  const many = { failed: 'не прошли', stale: 'устарели', untested: 'без проверки', plan: 'план', risk: 'риски' };
  for (const [el, own] of tags) {
    el.classList.add('h-issue');
    el.insertAdjacentHTML('beforeend', `<span class="health-tag">${HEALTH.filter(([k]) => own.has(k)).map(([k]) => { const t = own.get(k); return `<i class="k-${k}">${esc(t.n > 1 ? `${many[k]}: ${t.n}` : t.label)}</i>`; }).join('')}</span>`);
  }
  renderHealth();
}
// Режим «Здоровье»: сверху слева — сколько блоков не прошло, устарело, без проверки, в плане и с рисками; нажатие
// показывает следующий такой блок. Здоровые блоки бледнеют.
function renderHealth() {
  const vp = $('#viewport'); if (!vp) return;
  let panel = $('#health');
  if (!state.health) { panel?.remove(); return; }
  if (!panel) { vp.insertAdjacentHTML('beforeend', '<div class="health-panel" id="health"></div>'); panel = $('#health'); }
  const count = new Map(HEALTH.map(([k]) => [k, 0]));
  for (const n of state.graph.nodes) if (!isNote(n)) for (const [k] of issuesOf(n)) count.set(k, count.get(k) + 1);
  const html = [...count.values()].some(Boolean)
    ? HEALTH.filter(([k]) => count.get(k)).map(([k, label]) => `<button type="button" class="k-${k}" data-health="${k}">${label} <b>${count.get(k)}</b></button>`).join('')
    : '<span class="health-ok">Красных, устаревших и непроверенных блоков нет</span>';
  if (panel.innerHTML !== html) panel.innerHTML = html;
}
// Следующий блок выбранного вида: по кругу, от того, что показан сейчас.
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
  if (folded.length) { const name = nodeName(folded[0][0]); await commit(foldOps(folded), `Развёрнута подкарта «${name}»`); }
  // Показанный блок встаёт в центр — это вид человека, слежение выключается.
  stopGlide(); setFollow(false);
  const r = worldRect(node(id) ?? n), vp = $('#viewport');
  state.view.x = vp.clientWidth / 2 - (r.x + r.w / 2) * state.view.z; state.view.y = vp.clientHeight / 2 - (r.y + r.h / 2) * state.view.z;
  applyView(); select({ type: 'node', id });
}
document.addEventListener('input', e => {
  // Пока ползунок тянут, меняется только он сам; карта сворачивается, когда его отпустили или шагнули клавишей.
  if (e.target.id === 'level') { $('#levels').classList.remove('mixed'); paintLevel(Number(e.target.value)); }
});
document.addEventListener('change', e => { if (e.target.id === 'level') pickLevel(Number(e.target.value)); });
// Нажатие на ползунок левой кнопкой: значение и «ни один уровень не подходит» на момент нажатия.
let grab = null;
document.addEventListener('pointerdown', e => {
  grab = e.target.id === 'level' && e.button === 0 && !e.target.disabled ? { pointer: e.pointerId, value: Number(e.target.value), mixed: $('#levels').classList.contains('mixed') } : null;
});
// Отпустили на значении, с которого начали (change не будет): если карте не подходил ни один уровень, это значение
// всё равно применяется — и когда бегунок водили туда и обратно, — иначе ползунок снова показывает карту как есть.
document.addEventListener('pointerup', e => {
  const g = grab; if (!g || g.pointer !== e.pointerId) return;
  grab = null;
  const value = Number($('#level')?.value);
  if (value !== g.value) return; // уровень применит change
  if (g.mixed) pickLevel(value); else setTimeout(renderLevels);
});
document.addEventListener('pointercancel', e => { if (grab?.pointer === e.pointerId) { grab = null; setTimeout(renderLevels); } });
// Точка агента гаснет, если он давно не обращался: перерисовка раз в минуту.
setInterval(renderAgents, 60000);

// Живое обновление по SSE

// Узлы, которые в next новые или изменились, и концы новых связей: к ним вписывается мелкая карта в режиме слежения.
const TOUCH = ['type', 'parentId', 'attachedTo', 'collapsed', 'title', 'text', 'color', 'x', 'y', 'w', 'h'];
function touched(prev, next) {
  const old = new Map(prev.nodes.map(n => [n.id, n])), edges = new Set(prev.edges.map(e => e.id));
  const ids = next.nodes.filter(n => { const o = old.get(n.id); return !o || TOUCH.some(k => o[k] !== n[k]); }).map(n => n.id);
  for (const e of next.edges) if (!edges.has(e.id)) ids.push(e.source, e.target);
  return ids;
}
// Узлы и связи, которых не было в prev, проявляются; возвращает, сколько их.
function markAppeared(prev, next) {
  const had = new Set([...prev.nodes, ...prev.edges].map(x => x.id)), now = performance.now();
  let added = 0;
  for (const x of [...next.nodes, ...next.edges]) if (!had.has(x.id)) { state.appeared.set(x.id, now); added++; }
  // Сменившаяся отметка у уже бывшего блока вспыхивает; если блок спрятан в свёрнутой подкарте — вспыхивает её карточка.
  const marks = new Map(prev.nodes.map(n => [n.id, n.status])), byId = new Map(next.nodes.map(n => [n.id, n]));
  for (const n of next.nodes) if (marks.has(n.id) && marks.get(n.id) !== n.status && n.status) {
    let shown = n;
    for (let p = byId.get(n.parentId); p; p = byId.get(p.parentId)) if (p.collapsed) shown = p;
    state.remarked.set(shown.id, now);
  }
  return added;
}
// Запрос карты один: события во время него только поднимают wanted, после ответа карта дочитывается, если сервер
// ушёл дальше. Принимается только ревизия новее текущей. Новые узлы и связи проявляются, слежение вписывает карту.
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
  // Без новых событий за время запроса желаемая ревизия — та, что ответил сервер: иначе ревизию, которой на сервере
  // нет (данные восстановили из копии), карта перечитывала бы без конца.
  if (state.wanted === asked) state.wanted = next.revision;
  if (interacting()) { state.pending = true; return; }
  if (next.revision > state.graph.revision) {
    const prev = state.graph;
    sizes = new Map();
    const before = state.tab === 'map' ? boxOf(fitRoots()) : null, ids = touched(prev, next), added = markAppeared(prev, next);
    // Агент выложил предложение или дополнил его: вид переезжает к новому в нём.
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

// Маршруты: #/ — главная со списком проектов, #/p/<id> — карта проекта. Переход без перезагрузки страницы.

let routing = Promise.resolve(), notice = null; // notice — уведомление, которое показать уже на новом экране
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
// Уход с экрана: открытая правка и идущие записи сохраняются в старый проект, фокус снимается, поток событий
// закрывается, уведомление прячется, всё состояние проекта сбрасывается.
async function leave() {
  if (page.kind === 'project' && !page.gone) {
    if (state.editing) await finishEdit();
    // Погружение закрывается, как выходом: сворачивание возвращается, агент узнаёт, что фокуса нет.
    await walk(exitFocus);
    await Promise.allSettled([...saving]);
    // Ушедший человек ничего не выделяет.
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
// Вкладку закрывают или перезагружают в погружении: выход из него уходит запросами, которые браузер дошлёт после
// закрытия, вид карты — прежний. Если запись не дойдёт, сворачивание вернёт перезагруженная страница (undive).
window.addEventListener('pagehide', () => {
  if (page.kind !== 'project' || page.gone || !state.graph || !state.focus) return;
  const send = (path, body) => fetch(page.prefix + path, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session?.token}` }, body: JSON.stringify(body) }).catch(() => {});
  const ops = restoreOps()();
  if (ops.length) send('/changes', { expectedRevision: state.graph.revision, actor: 'human', message: 'Показана вся карта', operations: ops });
  send('/focus', { id: null });
  if (state.focusView) { state.view = state.focusView; saveView(); }
});

// Главная: строка для агента и проекты, новые сверху. Обновляется по общему потоку событий.

function openHome() {
  document.title = 'Mycel';
  Object.assign(home, { projects: null, loading: false, again: false, held: false, appeared: new Map() });
  $('#app').innerHTML = `<div class="home"><div class="home-col">
      <div class="home-top"><button type="button" class="agent-line" data-copy-agent>Агенту: ${esc(location.origin)}/agent</button><span class="grow"></span><span id="status" role="status"></span></div>
      <ul class="projects" id="projects"></ul>
      <section class="devices" id="devices" hidden></section>
    </div></div>`;
  loadHome();
  hubEvents();
  renderDevices();
}
// Не чаще раза в 150 мс от первого события: таймер не переставляется, иначе при нескольких агентах события идут
// чаще 150 мс и список не обновлялся бы вовсе. Запрос один: события во время него дают ещё один после.
const scheduleHome = () => { home.timer ||= setTimeout(() => { home.timer = 0; loadHome(); }, 150); };
async function loadHome() {
  if (page.kind !== 'home') return;
  if (home.loading) { home.again = true; return; }
  const gen = page.gen;
  home.loading = true; home.again = false;
  try {
    const { projects } = await api('/api/projects');
    if (gen !== page.gen) return;
    // События идут на каждую запись агента в любом проекте; тот же список ничего не перерисовывает.
    if (home.projects && JSON.stringify(projects) === JSON.stringify(home.projects)) return;
    // Проявляются только строки, которых не было в прошлом списке; первый показ — без анимации.
    if (home.projects) { const known = new Set(home.projects.map(p => p.id)), now = performance.now(); for (const p of projects) if (!known.has(p.id)) home.appeared.set(p.id, now); }
    home.projects = projects; renderHome();
  } catch (err) { if (gen === page.gen) fail(err); }
  finally { if (gen === page.gen) { home.loading = false; if (home.again) scheduleHome(); } }
}
// Строки привязаны к id проекта: обновление меняет в них только изменившиеся поля, добавляет новые и убирает удалённые.
// Ссылка и корзина остаются теми же элементами, поэтому клик и фокус на них не теряются. Пока указатель нажат, список ждёт.
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
        <button type="button" class="icon-btn p-trash" data-trash="${esc(p.id)}" title="Удалить проект" aria-label="Удалить проект">${icon('trash', 16)}</button>`;
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
  put('.p-meta', `${plural(p.blocks ?? 0, ['блок', 'блока', 'блоков'])}${when}`);
  // Проект виртуальной машины: её папку основная машина не видит — рядом имя машины.
  put('.p-path', p.machine ? `${p.path} · на машине «${p.machine.name}»` : p.exists ? p.path : p.path ? `${p.path} · папки нет` : 'папки нет');
  put('.p-error', p.error ?? '', Boolean(p.error));
}
// Удаление без подтверждения: проект уходит в корзину Mycel, вернуть его можно из уведомления.
async function deleteProject(id) {
  const p = home.projects?.find(x => x.id === id); if (!p) return;
  const gen = page.gen, path = `/api/projects/${encodeURIComponent(id)}`;
  await api(`${path}/delete`, {});
  if (gen !== page.gen) return;
  home.projects = home.projects.filter(x => x.id !== id); renderHome();
  toast(`Проект «${p.name}» удалён`, { action: 'Вернуть', run: () => api(`${path}/restore`, {}).then(scheduleHome, fail) });
}
// Строка для агента копируется целой фразой: её вставляют в чат агента.
async function copyAgent() {
  // Из виртуальной машины Mycel отвечает только с ключом: он идёт во фразе заголовком, а curl — той системы, где браузер.
  const far = !['127.0.0.1', 'localhost'].includes(location.hostname), key = far && state.session?.token;
  const win = far ? /^Win/.test(navigator.platform) : (state.session?.platform ?? (/^Win/.test(navigator.platform) ? 'win32' : '')) === 'win32';
  const text = `Прочитай инструкцию Mycel и выполни её: ${win ? 'curl.exe -s' : 'curl -s'}${key ? ` -H "Authorization: Bearer ${key}"` : ''} ${location.origin}/agent`;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area); area.select();
    const copied = document.execCommand('copy'); area.remove();
    if (!copied) throw new Error('Не удалось скопировать.');
  }
  toast('Скопировано');
}
// Доступ виртуальных машин. Агент там просит доступ и печатает код; на любой странице Mycel этой машины — карточка
// с тем же кодом, выбором проекта и кнопками. «Разрешить» выдаёт машине её ключ; на главной — машины с доступом и
// «Отключить». В самой виртуальной машине этого нет: /api/access ей закрыт.
async function loadAccess() {
  try { setAccess(await api('/api/access')); } catch { /* не основная машина или нет связи */ }
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
  const html = list.map(r => `<div class="access-row" data-pair="${esc(r.id)}">
      <div class="access-text">Виртуальная машина «${esc(r.name)}» (${esc(r.address)}) просит доступ к Mycel. Код <b>${esc(r.code)}</b> — он должен совпасть с кодом на её экране.</div>
      <div class="access-act"><label>Проект <select data-pair-project><option value="">без проекта</option>${state.access.projects.map(p => `<option value="${esc(p.id)}"${p.id === chosen ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <button type="button" class="btn ghost" data-pair-deny="${esc(r.id)}">Отклонить</button><button type="button" class="btn" data-pair-approve="${esc(r.id)}">Разрешить</button></div>
    </div>`).join('');
  // Список не перерисовывается без перемен: выбранный проект не сбрасывается.
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}
function renderDevices() {
  const box = $('#devices'); if (!box) return;
  const list = state.access.devices, name = id => state.access.projects.find(p => p.id === id)?.name ?? id;
  box.hidden = !list.length;
  box.innerHTML = list.length ? `<h2>Виртуальные машины с доступом</h2><ul>${list.map(d => `<li><span>${esc(d.name)} · ${esc(d.address)}${d.project ? ` · ${esc(name(d.project))}` : ''}${d.lastSeen ? ` · была ${date(d.lastSeen)}` : ''}</span><button type="button" class="btn ghost" data-revoke="${esc(d.id)}">Отключить</button></li>`).join('')}</ul>` : '';
}
async function answerPair(control, approve) {
  const row = control.closest('[data-pair]'), id = row.dataset.pair, project = row.querySelector('[data-pair-project]')?.value || null;
  row.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    setAccess(await api(`/api/pair/${encodeURIComponent(id)}/${approve ? 'approve' : 'deny'}`, approve ? { project } : {}));
    toast(approve ? 'Доступ разрешён' : 'Запрос отклонён');
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
  // Запросы доступа, пришедшие, пока поток подключался, — перечитать: дальше их приносят события.
  events.onopen = () => { if (gen !== page.gen) return; setStatus(true); loadAccess(); if (broken) { broken = false; loadSession().catch(() => {}); } };
  events.onerror = () => {
    if (gen !== page.gen) return;
    setStatus(false); broken = true;
    if (events.readyState === EventSource.CLOSED) setTimeout(() => { if (gen === page.gen && page.events === events) hubEvents(); }, 2000);
  };
}

// Проект: имя и карта, затем поток событий только этого проекта.

async function openProject(id) {
  const gen = page.gen, prefix = page.prefix;
  document.title = 'Mycel';
  $('#app').innerHTML = '<div class="loading">Загрузка…</div>';
  try {
    const [{ project }, graph] = await Promise.all([api(prefix), api(`${prefix}/graph`)]);
    if (gen !== page.gen) return;
    page.name = project.name; document.title = `${project.name} — Mycel`;
    adopt(graph); loadView(id);
    const back = undive(id);
    shell(); renderAgents();
    await showTab('map');
    // Выход из погружения при закрытии прошлой страницы не дошёл: сворачивание возвращается, фокус снимается.
    if (back.length) { papi('/focus', { id: null }).catch(() => {}); await commit(back, 'Показана вся карта').catch(recover); }
    if (gen === page.gen) projectEvents();
  } catch (err) {
    if (gen !== page.gen || err instanceof Stale) return;
    if (err.status === 404) { notice = err.deleted ? 'Проект удалён' : err.message; location.hash = '#/'; return; }
    $('#app').innerHTML = `<div class="loading"><h2>Не удалось открыть карту</h2><p>${esc(err.message)}</p><button class="btn" id="retry">Повторить</button> <a class="btn" href="#/">К проектам</a></div>`;
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
    // Агент показывает блок; пока человек правит текст или тянет узел, вид не дёргается.
    if (data.show && !state.editing && !state.gesture) focusNode(data.show).catch(recover);
  };
  // После обрыва связи сессия перечитывается: токен мог смениться.
  // Запросы доступа, пришедшие, пока поток подключался, — перечитать: дальше их приносят события.
  events.onopen = () => { if (gen !== page.gen) return; setStatus(true); loadAccess(); if (broken) { broken = false; loadSession().catch(() => {}); } };
  // Сервер закрыл поток (а не просто пропала связь): проект удалён — на главную, иначе переподключиться через 2 с.
  events.onerror = async () => {
    if (gen !== page.gen) return;
    setStatus(false); broken = true;
    if (events.readyState !== EventSource.CLOSED) return;
    try { await api(page.prefix); }
    catch (err) { if (gen === page.gen && err.status === 404) return gone(); }
    setTimeout(() => { if (gen === page.gen && page.events === events) projectEvents(); }, 2000);
  };
}
// Проект удалили (на главной или в другом окне): возвращаемся к списку, правку уже некуда сохранить.
function gone() {
  if (page.gone) return;
  page.gone = true; page.events?.close();
  notice = 'Проект удалён'; location.hash = '#/';
}

async function boot() {
  // Без сессии экраны всё равно открываются: чтение её не требует, а запись перечитает её на 401.
  await loadSession().catch(() => {});
  route();
  loadAccess();
}
boot();
// Доступ к внутренностям для отладки из консоли браузера.
window.mycel = { state, page, home, node, blockNear, containerAt, toWorld, toScreen, worldRect, layoutSize, fieldRect, edgeGeometry, focusNode, dive, goUp, exitFocus, liveRefresh, autoFit };
