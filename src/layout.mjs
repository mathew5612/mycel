// Авторасстановка узлов, добавленных без координат, и подбор размера под текст.
// Геометрия подкарты повторяет public/app.js: поле лежит внутри рамки блока (1 px) с отступом 12 px,
// под шапкой высотой 36 px или 75 px, если у блока есть текст; свёрнутая подкарта — карточка до 280 px шириной.
// MAX — предел размера узла (limits.maxW и maxH в model.mjs). Он с большим запасом больше любой подкарты: при пределе
// 2000 px контейнер, которому нужно больше, хранил 2000, и w и h в карте были меньше того, что видно на экране.

const PAD = 12, EDGE = 1, HEAD = { base: 36, text: 39 }, FOLDED = { w: 280, h: 30 }, MAX = 20000;
const GAP = { x: 80, y: 40, note: 16, stack: 12, field: 24 };
export const headerH = n => HEAD.base + (n.text.trim() ? HEAD.text : 0);

// Строка 18 px, примерно 7.6 px на символ текста (8.4 px, если в тексте есть `код` — моноширинный шрифт шире)
// и 8.6 px на символ жирного названия, поля 10 px.
export function fitSize(n) {
  const note = n.type === 'note', w = note ? (n.text.length > 200 ? 240 : 160) : n.text.length > 280 ? 320 : 240, inner = w - 24;
  const lines = (s, px) => s.trim() ? s.trim().split('\n').reduce((sum, p) => sum + Math.max(1, Math.ceil(p.length * px / inner)), 0) : 0;
  const title = note ? 0 : lines(n.title, 8.6), text = lines(n.text, n.text.includes('`') ? 8.4 : 7.6);
  const h = 22 + 18 * (title + text) + (title && text ? 3 : 0);
  return { w, h: Math.min(600, Math.max(note ? 80 : 60, Math.round(h))) };
}

// Размеры узлов на экране: развёрнутая подкарта не меньше содержимого, свёрнутая — компактная карточка.
export function measure(graph) {
  const children = new Map();
  for (const n of graph.nodes) { if (!children.has(n.parentId)) children.set(n.parentId, []); children.get(n.parentId).push(n); }
  const kids = id => children.get(id) ?? [];
  const content = (n, margin) => {
    let right = 0, bottom = 0;
    for (const k of kids(n.id)) { const s = shown(k); right = Math.max(right, k.x + s.w); bottom = Math.max(bottom, k.y + s.h); }
    return { w: right + margin + 2 * PAD + 2 * EDGE, h: headerH(n) + bottom + margin + PAD + 2 * EDGE };
  };
  const shown = n => {
    if (n.type === 'note' || !kids(n.id).length) return { w: n.w, h: n.h };
    if (n.collapsed) return { w: Math.min(n.w, FOLDED.w), h: headerH(n) + FOLDED.h };
    const c = content(n, 0);
    return { w: Math.max(n.w, c.w), h: Math.max(n.h, c.h) };
  };
  return { kids, content, shown };
}

// Подкарты свернули или развернули — весь пакет сразу (folds: id → collapsed). Карта сначала разворачивается целиком,
// потом сворачивается до нужного вида. Каждый шаг точно обратим, а развёрнутая карта — одна и та же, с какого вида
// к ней ни прийти, поэтому вид зависит только от того, что свёрнуто: сколько ни переключай уровни, погружайся и
// выходи, всё встаёт на те же места. Развёрнутая карта — самая подробная: заметка под широкой подкартой там под
// ней, а не по диагонали от свёрнутой карточки. Страховка смотрит только на итог: новые наложения по сравнению с
// видом до пакета. Возвращает число её сдвигов.
export function reflow(graph, folds) {
  const { kids, shown } = measure(graph), byId = new Map(graph.nodes.map(n => [n.id, n])), want = new Map();
  for (const [id, collapsed] of folds) { const n = byId.get(id); if (n && (n.type === 'note' || !kids(id).length)) n.collapsed = collapsed; }
  let same = true;
  for (const n of graph.nodes) if (n.type !== 'note' && kids(n.id).length) { const c = folds.has(n.id) ? folds.get(n.id) : n.collapsed; want.set(n.id, c); same &&= c === n.collapsed; }
  if (same) return 0;
  const snap = new Map(graph.nodes.map(n => [n.id, { x: n.x, y: n.y, ...shown(n) }]));
  const levels = new Set([...refold(graph, new Map([...want.keys()].map(id => [id, false]))), ...refold(graph, new Map([...want].filter(([, c]) => c)))]);
  const after = measure(graph);
  let pushes = 0;
  for (const level of [...levels].sort((a, b) => depthOf(byId, b) - depthOf(byId, a))) pushes += settle(after.shown, after.kids(level), snap);
  return pushes;
}
// Глубина уровня; повтор в цепочке (пакет ещё не проверен) обрывает обход.
const depthOf = (byId, level) => { let d = 0; for (const seen = new Set(); level !== null && level !== undefined && !seen.has(level); level = byId.get(level)?.parentId) { seen.add(level); d++; } return d; };

// Один шаг: уровни идут от глубоких к основной карте; на уровне блоки, чей видимый размер изменился (сами подкарты
// и их внешние контейнеры), меняют его вместе, а каждая единица (блок со своими заметками или свободная заметка)
// сдвигается так, чтобы зазор до ближайшего соседа слева в её полосе и сверху в её колонке остался прежним. Всё
// считается по прежнему виду уровня, поэтому порядок операций не важен. Возвращает затронутые уровни.
function refold(graph, folds) {
  const byId = new Map(graph.nodes.map(n => [n.id, n])), { kids, shown } = measure(graph);
  // Цепочка предков; повтор в ней (пакет ещё не проверен) обрывает обход.
  const chain = n => { const out = []; for (const seen = new Set(); n && !seen.has(n.id); n = byId.get(n.parentId)) { seen.add(n.id); out.push(n); } return out; };
  const levels = new Set();
  for (const [id, collapsed] of folds) { const n = byId.get(id); if (n && n.collapsed !== collapsed && kids(id).length) for (const p of chain(n)) levels.add(p.parentId); }
  const before = new Map();
  for (const level of levels) for (const n of kids(level)) before.set(n.id, { x: n.x, y: n.y, ...shown(n) });
  for (const [id, collapsed] of folds) if (byId.has(id)) byId.get(id).collapsed = collapsed;
  for (const level of [...levels].sort((a, b) => depthOf(byId, b) - depthOf(byId, a))) {
    const all = kids(level), size = new Map(all.map(n => [n.id, { w: before.get(n.id).w, h: before.get(n.id).h }]));
    const goal = new Map(all.map(n => [n.id, shown(n)]));
    // Ширины и высоты меняются отдельными проходами: сжатие — сначала ширина, потом высота, рост — наоборот.
    // Обратное действие проходит те же шаги в обратном порядке, и при неизменной полосе (колонке) каждой пары
    // соседей возвращает каждый узел точно на место: ручная расстановка не теряется.
    for (const [axis, sign] of [['w', -1], ['h', -1], ['h', 1], ['w', 1]]) {
      const moving = new Map();
      for (const n of all) { const d = goal.get(n.id)[axis] - size.get(n.id)[axis]; if (n.type !== 'note' && Math.sign(d) === sign) moving.set(n.id, d); }
      if (moving.size) spread(all, axis, moving, size);
    }
  }
  return levels;
}

// Один проход по оси (axis: w — по горизонтали, h — по вертикали): блоки из moving меняют размер на свою разницу.
// Пара узлов разных единиц, которые идут друг за другом вдоль оси и пересекаются поперёк, держит порядок: единица
// сдвигается на столько, чтобы её самый узкий зазор до узлов перед ней остался прежним. Поперёк проход ничего не
// двигает, поэтому пары, которые не перекрывались, перекрыться не могут. Узлы, которые уже лежат друг на друге,
// едут вместе: прежнее наложение не растёт и не тянет за собой остальных.
// Заметки блока — одна единица с ним. Заметка, которая выходит за его дальний край в его полосе (стопка сбоку,
// стикер на углу), едет с краем, а с ней — продолжение стопки ниже полосы: заметки за краем на той же линии (у стопки
// справа — тот же x), примыкающие к ней цепочкой. Заметка под блоком едет за нижним краем в проходе по другой оси.
// Проверка одна и та же в обе стороны (ширина — при прежней высоте, высота — при меньшей ширине): заметка, которая
// едет, держит место от края, остальные — от блока, линия стопки при этом не меняется, поэтому обратный шаг ставит
// заметки точно на место. Заметку не на линии (под блоком, рядом со стопкой) свёрнутая карточка не путает со стопкой.
function spread(all, axis, moving, size) {
  const [a, b, cross] = axis === 'w' ? ['x', 'y', 'h'] : ['y', 'x', 'w'], at = new Map(all.map(n => [n.id, n]));
  const head = n => n.type === 'note' && at.get(n.attachedTo)?.type === 'block' ? n.attachedTo : n.id;
  const rs = all.map(n => ({ n, h: head(n), a: n[a], l: size.get(n.id)[axis], b: n[b], m: size.get(n.id)[cross], f: 0, d: moving.get(n.id) ?? 0 }));
  const root = new Map(rs.map(r => [r.h, r.h])), across = (p, q) => p.b < q.b + q.m && q.b < p.b + p.m;
  const find = id => { let r = id; while (root.get(r) !== r) r = root.get(r); for (let x = id; x !== r; ) { const up = root.get(x); root.set(x, r); x = up; } return r; };
  const join = (x, y) => { x = find(x); y = find(y); if (x !== y) root.set(x, y); };
  const byStart = [...rs].sort((p, q) => p.a - q.a);
  for (let i = 0; i < byStart.length; i++) for (let j = i + 1, p = byStart[i]; j < byStart.length && byStart[j].a < p.a + p.l; j++) if (across(p, byStart[j])) join(p.h, byStart[j].h);
  const own = new Map();
  for (const r of rs) if (r.h !== r.n.id) { if (!own.has(r.h)) own.set(r.h, []); own.get(r.h).push(r); }
  for (const k of rs) if (k.d && own.has(k.n.id)) {
    // Стикер, который начинается над блоком, едет только за правым краем, даже если ниже свёрнутой карточки.
    const edge = k.a + k.l, notes = own.get(k.n.id), seed = new Set(notes.filter(r => r.a + r.l > edge && r.a >= k.a && across(r, k))), lines = new Map();
    for (const r of notes) if (seed.has(r) || (r.a >= edge && r.b >= k.b + k.m)) { if (!lines.has(r.a)) lines.set(r.a, []); lines.get(r.a).push(r); }
    // Линия по порядку поперёк: цепочка рвётся на зазоре больше GAP.y, и кусок с заметкой из полосы едет весь.
    for (const line of lines.values()) if (line.some(r => seed.has(r))) {
      line.sort((p, q) => p.b - q.b);
      for (let i = 0, j; i < line.length; i = j) {
        let reach = -Infinity, go = false;
        for (j = i; j < line.length && (j === i || line[j].b - reach <= GAP.y); j++) { reach = Math.max(reach, line[j].b + line[j].m); go ||= seed.has(line[j]); }
        if (go) for (let x = i; x < j; x++) line[x].f = k.d;
      }
    }
  }
  // Пары «перед — за»: друг за другом вдоль оси и в одной полосе поперёк. Пара не нужна, если между узлами стоит
  // третий, который пересекается поперёк с обоими и держит порядок с каждым: он другой единицы (его держит своя пара)
  // или той же, но сдвигается с ним одинаково. Зазор через него уже́, а порядок через него тот же и при обратном
  // шаге. Заметка, которая едет с краем, порядка с неподвижной заметкой того же блока не держит. Соседи
  // перебираются от ближних; когда каждую точку полосы заслоняют две единицы или одна, но с каждым своим сдвигом,
  // дальние уже не нужны, — так работа не растёт как куб.
  const shut = (list, lo, hi, shifts) => {
    for (const x of new Set([lo, ...list.flatMap(c => [c.from, c.to])])) {
      if (x < lo || x >= hi) continue;
      const here = list.filter(c => c.from <= x && x < c.to), units = new Set(here.map(c => c.u));
      if (!units.size) return false;
      if (units.size === 1) { const [u] = units, starts = new Set(here.map(c => c.f)); for (const s of shifts.get(u)) if (!starts.has(s)) return false; }
    }
    return true;
  };
  const pairsOf = () => {
    const shifts = new Map(), byEnd = [...rs].sort((p, q) => p.a + p.l - (q.a + q.l)), pairs = [];
    for (const r of rs) { if (!shifts.has(r.u)) shifts.set(r.u, new Set()); shifts.get(r.u).add(r.f + r.d); }
    for (const q of rs) {
      let lo = 0, hi = byEnd.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (byEnd[mid].a + byEnd[mid].l <= q.a) lo = mid + 1; else hi = mid; }
      const seen = [];
      for (let i = lo - 1, check = 1; i >= 0; i--) {
        const p = byEnd[i], end = p.a + p.l;
        if (p.u === q.u || !across(p, q)) continue;
        const from = Math.max(p.b, q.b), to = Math.min(p.b + p.m, q.b + q.m);
        if (!seen.some(c => c.a >= end && c.from < to && from < c.to && (c.u !== p.u || c.f === p.f + p.d))) pairs.push([p, q]);
        seen.push({ a: p.a, from, to, u: p.u, f: p.f });
        if (seen.length === check) { check *= 2; if (shut(seen.filter(c => c.a >= end), q.b, q.b + q.m, shifts)) break; }
      }
    }
    return pairs;
  };
  for (const r of rs) r.u = find(r.h);
  let pairs = pairsOf();
  // Единицы вперемешку (блок A перед заметкой B, блок B перед заметкой A) тоже едут вместе — компоненты сильной
  // связности (Тарьян): иначе каждой пришлось бы стоять и перед другой, и за ней. Пары тогда собираются заново:
  // внутри слитой единицы узлы друг друга уже не держат.
  const out = new Map(), num = new Map(), low = new Map(), stack = [], on = new Set(), cycles = [];
  for (const [p, q] of pairs) if (p.u !== q.u) { if (!out.has(p.u)) out.set(p.u, new Set()); out.get(p.u).add(q.u); }
  const visit = v => {
    num.set(v, num.size); low.set(v, num.get(v)); stack.push(v); on.add(v);
    for (const w of out.get(v) ?? []) if (!num.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), num.get(w)));
    if (low.get(v) === num.get(v)) { const c = stack.splice(stack.indexOf(v)); for (const w of c) on.delete(w); if (c.length > 1) cycles.push(c); }
  };
  for (const r of rs) if (!num.has(r.u)) visit(r.u);
  if (cycles.length) {
    for (const c of cycles) for (const v of c) join(v, c[0]);
    for (const r of rs) r.u = find(r.h);
    pairs = pairsOf();
  }
  const units = new Set(rs.map(r => r.u)), into = new Map([...units].map(u => [u, []])), next = new Map([...units].map(u => [u, new Set()])), wait = new Map([...units].map(u => [u, 0]));
  for (const [p, q] of pairs) if (p.u !== q.u) {
    into.get(q.u).push([p, q]);
    if (!next.get(p.u).has(q.u)) { next.get(p.u).add(q.u); wait.set(q.u, wait.get(q.u) + 1); }
  }
  // Единица — после всех, кто стоит перед ней (циклов уже нет).
  const t = new Map(), ready = [...units].filter(u => !wait.get(u));
  while (ready.length) {
    const u = ready.pop();
    let was = Infinity, now = Infinity;
    for (const [p, q] of into.get(u)) { const gap = q.a - p.a - p.l; was = Math.min(was, gap); now = Math.min(now, gap + q.f - (t.get(p.u) ?? 0) - p.f - p.d); }
    t.set(u, into.get(u).length ? was - now : 0);
    for (const s of next.get(u)) { wait.set(s, wait.get(s) - 1); if (!wait.get(s)) ready.push(s); }
  }
  for (const r of rs) r.n[a] += (t.get(r.u) ?? 0) + r.f;
  for (const [id, d] of moving) size.get(id)[axis] += d;
}

// Упорядоченная подкарта (операция layout): её блок — ровно по содержимому с обычным запасом, то есть и сжимается
// после ручного растягивания. Соседи при сжатии остаются на местах.
export function tighten(graph, id) {
  const n = graph.nodes.find(x => x.id === id), { kids, content } = measure(graph);
  if (!n || !kids(id).length) return;
  const c = content(n, GAP.field);
  n.w = Math.min(MAX, Math.max(120, c.w)); n.h = Math.min(MAX, Math.max(60, c.h));
}

const rectOf = shown => n => ({ x: n.x, y: n.y, ...shown(n) });
const box = rs => { const x = Math.min(...rs.map(q => q.x)), y = Math.min(...rs.map(q => q.y)); return { x, y, w: Math.max(...rs.map(q => q.x + q.w)) - x, h: Math.max(...rs.map(q => q.y + q.h)) - y }; };
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Существующий блок X среди узлов уровня all уже вырос или получил заметки; o — его прежний прямоугольник (без
// заметок). Соседи расходятся, чтобы зазор снова был обычным: то, что начинается под прежним низом X, уезжает вниз
// вместе со всем, что под ним, затем всё, что начинается правее прежнего правого края, — вправо одним куском ровно
// на нехватку места. Чей сосед — решает его блок, а не охват с заметками, а границы — сам блок X, а не X с заметками:
// иначе сосед в кармане под высокой заметкой X или сбоку от неё остался бы на месте. Заметка соседа, блок которого
// выше или левее X, а сама она попала под выросший X, едет со сдвигом одна. Оба сдвига жёсткие.
function makeRoom(shown, all, X, o) {
  const notes = new Map(), rect = rectOf(shown);
  for (const n of all) if (n.type === 'note' && n.attachedTo) { if (!notes.has(n.attachedTo)) notes.set(n.attachedTo, []); notes.get(n.attachedTo).push(n); }
  const rX = box([X, ...(notes.get(X.id) ?? [])].map(rect)), xR = o.x + o.w, yD = o.y + o.h;
  const near = (a, b) => a.x < b.x + b.w + GAP.x && b.x < a.x + a.w + GAP.x;
  // Единица — блок вместе со своими заметками или свободная заметка.
  const unit = members => ({ members, ...box(members.map(rect)) }), units = [], below = new Set(), right = new Set();
  for (const n of all) {
    if (n === X || (n.type === 'note' && n.attachedTo)) continue;
    const own = notes.get(n.id) ?? [], u = unit([n, ...own]);
    if (n.x >= xR) { units.push(u); right.add(u); continue; }
    if (n.y >= yD && near(u, rX)) { units.push(u); below.add(u); continue; }
    // Блок выше или левее X: его заметка правее прежнего края в полосе X едет вправо, под прежним низом — вниз.
    const loose = own.filter(k => k.x >= xR ? k.y < rX.y + rX.h && rX.y < k.y + k.h : k.y >= yD && k.x < rX.x + rX.w && rX.x < k.x + k.w);
    units.push(loose.length ? unit([n, ...own.filter(k => !loose.includes(k))]) : u);
    for (const k of loose) { const v = unit([k]); units.push(v); (k.x >= xR ? right : below).add(v); }
  }
  const move = (u, dx, dy) => { for (const m of u.members) { m.x += dx; m.y += dy; } u.x += dx; u.y += dy; };
  // Под единицей — всё, что начинается ниже её верха и по горизонтали ближе обычного зазора: с ней уезжает и сосед,
  // на которого уже налёг ещё не обработанный выросший контейнер, и никто не остаётся вплотную сбоку от сдвинутого.
  for (const queue = [...below]; queue.length; ) { const u = queue.pop(); for (const v of units) if (!below.has(v) && v.y >= u.y && near(v, u)) { below.add(v); queue.push(v); } }
  const dy = Math.max(0, ...[...below].filter(u => near(u, rX)).map(u => rX.y + rX.h + GAP.y - u.y));
  if (dy) for (const u of below) move(u, 0, dy);
  const dx = Math.max(0, ...[...right].filter(u => u.y < rX.y + rX.h + GAP.y && rX.y < u.y + u.h + GAP.y).map(u => rX.x + rX.w + GAP.x - u.x));
  if (dx) for (const u of right) move(u, dx, 0);
}

// Прежние заметки блока держатся своей стороны, когда он вырос на dw × dh (o — его прежний прямоугольник): справа —
// за правым краем вся стопка, в том числе её часть ниже блока, снизу — за низом, угловая — за углом.
function keepSides(own, o, dw, dh) {
  const xR = o.x + o.w, yD = o.y + o.h, right = new Set(own.filter(k => k.x + k.w > xR && k.y < yD && (k.x >= xR || k.y + k.h > o.y)));
  // Set обходит и добавленные по ходу: цепочка без перебора списка на каждом шаге (стопка в 2000 заметок — не куб).
  const below = own.filter(k => !right.has(k) && k.x >= xR && k.y >= yD);
  for (const r of right) for (const k of below) if (!right.has(k) && k.x < r.x + r.w && r.x < k.x + k.w && Math.max(k.y, r.y) - Math.min(k.y + k.h, r.y + r.h) <= GAP.y) right.add(k);
  for (const k of own) {
    const side = right.has(k), corner = !side && k.x >= xR && k.y >= yD;
    if (side || corner) k.x += dw;
    if (!side && k.y + k.h > yD && (k.y >= yD || (k.x + k.w > o.x && k.x < xR))) k.y += dh;
  }
}

// Прямоугольники узлов на экране, кроме skip, — прежний вид уровней для makeSpace.
export function screenRects(graph, skip = new Set()) {
  const nodes = graph.nodes.filter(n => !skip.has(n.id)), { shown } = measure({ nodes });
  return new Map(nodes.map(n => [n.id, { x: n.x, y: n.y, ...shown(n) }]));
}

// Правки с координатами уже применены: перетаскивание внутри подкарты, блок внутри, размер, заметка, брошенная на
// блок. before — прежний вид уровней (id → прямоугольник на экране), attached — заметки, которые пакет прикрепил,
// skip — узлы, которые потом расставит autoLayout. Заметка, брошенная на свой блок, встаёт сбоку от него, а
// подкарта, которая выросла, раздвигает соседей и держит свои заметки на их стороне, как при постройке агента
// (makeRoom). Уровни — от глубоких к основной карте: внешний контейнер растёт уже с учётом сдвигов внутри.
export function makeSpace(graph, before, attached = new Set(), skip = new Set()) {
  const nodes = graph.nodes.filter(n => !skip.has(n.id)), { kids, shown } = measure({ nodes }), byId = new Map(graph.nodes.map(n => [n.id, n]));
  const depth = level => { let d = 0; for (let p = byId.get(level); p; p = byId.get(p.parentId)) d++; return d; };
  const levels = [...new Set(nodes.map(n => n.parentId))].sort((x, y) => depth(y) - depth(x));
  for (const level of levels) {
    const all = kids(level), notes = all.filter(n => attached.has(n.id) && byId.get(n.attachedTo)?.parentId === level);
    const grown = all.filter(n => n.type === 'block' && kids(n.id).length && before.has(n.id) && (shown(n).w > before.get(n.id).w || shown(n).h > before.get(n.id).h));
    if (!notes.length && !grown.length) continue;
    // Страховка снимает только то, что добавили рост и сдвиги отсюда: наложения, которые человек или агент сделал
    // своей правкой, остаются как есть.
    const snap = new Map(all.map(n => [n.id, { x: n.x, y: n.y, ...(grown.includes(n) ? { w: before.get(n.id).w, h: before.get(n.id).h } : shown(n)) }]));
    // Ближе вправо — встаёт справа, ниже прежних заметок там, иначе под блоком, правее прежних. Стикер на правом
    // верхнем углу (так его ставит интерфейс) остаётся: он едет за углом.
    for (const k of notes) {
      const b = byId.get(k.attachedTo), s = shown(b), sticker = k.y < b.y && k.x < b.x + s.w && k.x + k.w > b.x + s.w;
      if (sticker || !hit({ x: k.x, y: k.y, w: k.w, h: k.h }, { x: b.x, y: b.y, ...s })) continue;
      const dx = b.x + s.w + GAP.note - k.x, dy = b.y + s.h + GAP.stack - k.y, right = dx <= dy, own = all.filter(m => m !== k && m.attachedTo === b.id);
      if (right) k.x += dx; else k.y += dy;
      for (let again = true; again; ) {
        again = false;
        for (const m of own) if (m.x < k.x + k.w + (right ? 0 : GAP.note) && k.x < m.x + m.w + (right ? 0 : GAP.note) && m.y < k.y + k.h + (right ? GAP.stack : 0) && k.y < m.y + m.h + (right ? GAP.stack : 0)) {
          if (right) k.y = m.y + m.h + GAP.stack; else k.x = m.x + m.w + GAP.note;
          again = true;
        }
      }
    }
    for (const X of grown.sort((p, q) => p.y - q.y || p.x - q.x)) {
      const b = before.get(X.id), now = shown(X), o = { x: X.x, y: X.y, w: b.w, h: b.h };
      // Заметку, которую пакет поставил сам (пошаговый build пишет итоговые места), рост не трогает.
      const kept = k => before.has(k.id) && k.x - X.x === before.get(k.id).x - b.x && k.y - X.y === before.get(k.id).y - b.y;
      keepSides(all.filter(k => k.attachedTo === X.id && kept(k)), o, Math.max(0, now.w - b.w), Math.max(0, now.h - b.h));
      makeRoom(shown, all, X, o);
    }
    settle(shown, all, snap);
  }
}

// Страховка на то, что раздвигание не предусмотрело (карман между единицами, заметка, которая ушла от своего блока):
// каждое новое наложение на уровне снимается сдвигом вправо или вниз, куда ближе, на обычный зазор. Сдвигается
// заметка, а не блок, иначе тот, кто не менялся, иначе тот, что ниже и правее; блок едет со своими заметками.
// Наложения, которые были до пакета (snap — прежние прямоугольники), не трогаются. Шагов не больше 4 на узел.
// Возвращает число сдвигов.
function settle(shown, all, snap) {
  const size = new Map(all.map(n => [n.id, shown(n)])), rect = n => ({ n, x: n.x, y: n.y, ...size.get(n.id) }), same = r => { const s = snap.get(r.n.id); return s && s.x === r.x && s.y === r.y && s.w === r.w && s.h === r.h; };
  const old = (a, b) => snap.has(a.n.id) && snap.has(b.n.id) && hit(snap.get(a.n.id), snap.get(b.n.id)), note = r => r.n.type === 'note';
  for (let step = 0; step < 4 * all.length; step++) {
    const rs = all.map(rect);
    let a, b;
    for (a of rs) if (!same(a) && (b = rs.find(r => r !== a && hit(a, r) && !old(a, r)))) break;
    if (!b) return step;
    const m = note(a) !== note(b) ? (note(a) ? a : b) : same(b) || b.y > a.y || (b.y === a.y && b.x > a.x) ? b : a, f = m === a ? b : a, blocks = !note(a) && !note(b);
    const dx = f.x + f.w + (blocks ? GAP.x : GAP.note) - m.x, dy = f.y + f.h + (blocks ? GAP.y : GAP.stack) - m.y;
    for (const k of note(m) ? [m.n] : [m.n, ...all.filter(k => k.attachedTo === m.n.id)]) if (dy <= dx) k.y += dy; else k.x += dx;
  }
  return 4 * all.length;
}

// Расставляет узлы из placed. Уровни обрабатываются от глубоких к основной карте: подкарта раскладывается раньше
// своего контейнера, и контейнер встаёт на место уже с итоговым размером. На уровне новые блоки идут колонками
// по связям между ними (источник левее цели), прикреплённые заметки — справа от своего блока.
// refit — контейнеры, которые после раскладки сжимаются под своё содержимое (упорядочивание уровня целиком),
// created — узлы, добавленные этим пакетом (по умолчанию — расставляемые).
export function autoLayout(graph, placed, refit = new Set(), created = placed) {
  if (!placed.size) return;
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  // Вид прежних узлов без добавленных: по нему видно, насколько вырос существующий контейнер.
  const prior = graph.nodes.filter(n => !created.has(n.id)), { shown: was } = measure({ nodes: prior });
  const before = new Map(prior.map(n => [n.id, was(n)]));
  for (const id of refit) { const n = byId.get(id); n.w = 120; n.h = 60; }
  const { kids, content, shown } = measure(graph);
  const depth = id => { let d = 0; for (let p = id; p; p = byId.get(p)?.parentId) d++; return d; };
  // Контейнер, которому стало тесно, растёт под содержимое с запасом.
  const fit = n => {
    const need = content(n, 0);
    if (need.w <= n.w && need.h <= n.h) return;
    const roomy = content(n, GAP.field);
    n.w = Math.min(MAX, Math.max(n.w, roomy.w)); n.h = Math.min(MAX, Math.max(n.h, roomy.h));
  };
  // Новый контейнер растёт, как только разложен его уровень; внешние — позже, когда разложен их уровень: до этого их
  // содержимое стоит на прежних местах, и упорядоченная с deep подкарта выросла бы под старую кучу. Существующие
  // контейнеры растут на уровне своего контейнера (room).
  const grow = id => { if (placed.has(id)) fit(byId.get(id)); };
  // Обрабатываются уровни новых узлов и все уровни над ними: существующий контейнер на цепочке предков нового узла
  // растёт и раздвигает соседей раньше, чем раскладывается уровень его собственного контейнера.
  const chain = new Set(), seen = new Set([...placed].map(id => byId.get(id).parentId));
  for (const id of placed) for (let p = byId.get(id).parentId; p && !chain.has(p); p = byId.get(p).parentId) { chain.add(p); seen.add(byId.get(p).parentId); }
  const levels = [...seen].sort((a, b) => depth(b) - depth(a)), done = new Set(), free = n => !placed.has(n.id) || done.has(n.id);
  // Существующие блоки уровня, которые выросли из-за пакета или получили новые заметки, — сверху вниз и слева
  // направо: каждый раздвигает соседей, его контейнер растёт позже уже с учётом сдвигов.
  const room = level => {
    const all = kids(level), list = all.filter(n => n.type !== 'note' && !placed.has(n.id) && (chain.has(n.id) || all.some(k => k.attachedTo === n.id && placed.has(k.id))));
    if (!list.length) return;
    const snap = new Map(all.filter(free).map(n => [n.id, { x: n.x, y: n.y, ...(before.get(n.id) ?? shown(n)) }]));
    for (const X of list.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const b = before.get(X.id) ?? { w: X.w, h: X.h }, need = content(X, 0);
      // Растёт только то, что стало больше прежнего вида: размер, отставший от содержимого после ручного разворота
      // вложенной подкарты, не подгоняется — иначе свернуть её обратно было бы нельзя без следа. Свёрнутый не растёт,
      // но пустой свёрнутый блок с первыми вложенными становится карточкой, которая бывает выше блока, — она раздвигает.
      if (chain.has(X.id) && !X.collapsed && (need.w > b.w || need.h > b.h)) {
        const roomy = content(X, GAP.field);
        if (need.w > b.w || X.w >= b.w) X.w = Math.min(MAX, Math.max(X.w, roomy.w));
        if (need.h > b.h || X.h >= b.h) X.h = Math.min(MAX, Math.max(X.h, roomy.h));
      }
      const now = shown(X), dw = Math.max(0, now.w - b.w), dh = Math.max(0, now.h - b.h);
      const own = all.filter(k => k.attachedTo === X.id), fresh = own.filter(k => placed.has(k.id));
      if (!dw && !dh && !fresh.length) continue;
      const o = { x: X.x, y: X.y, w: b.w, h: b.h };
      keepSides(own.filter(k => !placed.has(k.id)), o, dw, dh);
      // Новые — справа от итогового края стопкой, ниже заметок, которые там уже есть.
      for (const k of fresh) {
        k.x = X.x + now.w + GAP.note; k.y = X.y;
        for (let again = true; again; ) { again = false; for (const m of own) if (m !== k && free(m) && m.x < k.x + k.w && k.x < m.x + m.w && m.y < k.y + k.h + GAP.stack && k.y < m.y + m.h + GAP.stack) { k.y = m.y + m.h + GAP.stack; again = true; } }
        done.add(k.id);
      }
      makeRoom(shown, all.filter(free), X, o);
    }
    settle(shown, all.filter(free), snap);
  };
  for (const level of levels) {
    room(level);
    const all = kids(level), fresh = all.filter(n => !free(n)), old = all.filter(free);
    const blocks = fresh.filter(n => n.type !== 'note'), freshIds = new Set(blocks.map(n => n.id));
    const notesOf = id => fresh.filter(n => n.type === 'note' && n.attachedTo === id);
    // Начало: на основной карте — правее всего существующего, в подкарте — под существующим содержимым.
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const n of old) { const s = shown(n); x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y); x2 = Math.max(x2, n.x + s.w); y2 = Math.max(y2, n.y + s.h); }
    const origin = level === null ? (old.length ? { x: x2 + 2 * GAP.x, y: y1 } : { x: 0, y: 0 }) : { x: GAP.field, y: old.length ? y2 + GAP.y : GAP.field };

    // Связи между блоками этого уровня. Связь с узлом внутри подкарты считается связью с самой подкартой:
    // иначе блок, который ведёт во вложенное, не встал бы левее контейнера.
    const owner = id => { let n = byId.get(id); while (n && n.parentId !== level) n = n.parentId ? byId.get(n.parentId) : null; return n?.id; };
    const sourcesOf = new Map();
    for (const e of graph.edges) {
      const s = owner(e.source), t = owner(e.target);
      if (s && t && s !== t && freshIds.has(s) && freshIds.has(t)) sourcesOf.set(t, new Set([...(sourcesOf.get(t) ?? []), s]));
    }
    // Колонка блока — длина самого длинного пути к нему по этим связям.
    const rank = new Map(), visiting = new Set();
    const rankOf = id => {
      if (rank.has(id)) return rank.get(id);
      if (visiting.has(id)) return 0; // цикл: обратная связь не сдвигает колонку
      visiting.add(id);
      const r = Math.max(0, ...[...(sourcesOf.get(id) ?? [])].map(s => rankOf(s) + 1));
      visiting.delete(id); rank.set(id, r);
      return r;
    };
    let columns = [];
    for (const n of blocks) (columns[rankOf(n.id)] ??= []).push(n);
    // При циклах колонка может пропустить номер: пустые колонки убираем, иначе расчёт ширины даёт NaN.
    columns = columns.filter(Boolean);
    // Без связей одна колонка вытянулась бы в столбик: раскладываем почти квадратной сеткой.
    if (columns.length === 1 && blocks.length > 3) {
      const rows = Math.ceil(blocks.length / Math.ceil(Math.sqrt(blocks.length)));
      columns = Array.from({ length: Math.ceil(blocks.length / rows) }, (_, i) => blocks.slice(i * rows, (i + 1) * rows));
    }
    // Порядок в колонке — по средней высоте источников в предыдущих колонках, чтобы связи меньше пересекались.
    // Блоки без источников остаются в исходном порядке после остальных.
    const height = new Map();
    columns.forEach((col, r) => {
      if (!col) return;
      const middle = n => { const s = [...(sourcesOf.get(n.id) ?? [])].filter(id => height.has(id)); return s.length ? s.reduce((sum, id) => sum + height.get(id), 0) / s.length : 2; };
      if (r > 0) col.sort((a, b) => middle(a) - middle(b));
      col.forEach((n, i) => height.set(n.id, (i + 0.5) / col.length));
    });
    const unit = n => {
      const s = shown(n), notes = notesOf(n.id);
      if (!notes.length) return s;
      return { w: s.w + GAP.note + Math.max(...notes.map(x => x.w)), h: Math.max(s.h, notes.reduce((sum, x) => sum + x.h + GAP.stack, -GAP.stack)) };
    };
    // На уровне кода (подкарты техники и глубже) шаги идут сверху вниз, как строки программы; выше — механика и
    // техника — слева направо, как потоки данных. Так вложенные подкарты не вытягиваются в одну длинную ленту.
    const down = depth(level) >= 3;
    const along = u => down ? u.h : u.w, across = u => down ? u.w : u.h, gapAlong = down ? GAP.y : GAP.x, gapAcross = down ? GAP.x : GAP.y;
    const spans = columns.map(col => col ? col.reduce((sum, n) => sum + across(unit(n)) + gapAcross, -gapAcross) : 0), widest = Math.max(0, ...spans);
    let step = 0, bottom = origin.y;
    columns.forEach((col, r) => {
      if (!col) return;
      let side = Math.round((widest - spans[r]) / 2);
      for (const n of col) {
        n.x = origin.x + (down ? side : step); n.y = origin.y + (down ? step : side);
        let ny = n.y;
        for (const note of notesOf(n.id)) { note.x = n.x + shown(n).w + GAP.note; note.y = ny; ny += note.h + GAP.stack; }
        side += across(unit(n)) + gapAcross; bottom = Math.max(bottom, n.y + unit(n).h);
      }
      step += Math.max(...col.map(n => along(unit(n)))) + gapAlong;
    });

    // Свободные новые заметки — рядом под новыми блоками (заметки к существующим блокам уже стоят, см. room).
    let nx = origin.x;
    const ny = blocks.length ? bottom + GAP.y : origin.y;
    for (const note of fresh.filter(n => n.type === 'note' && !freshIds.has(n.attachedTo))) { note.x = nx; note.y = ny; nx += note.w + GAP.note; }
    for (const n of fresh) done.add(n.id);
    if (level !== null) grow(level);
  }
}
