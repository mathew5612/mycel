// Auto-placement of nodes added without coordinates, and sizing nodes to fit their text.
// Sub-map geometry mirrors public/app.js: the field lies inside the block's frame (1 px) with a 12 px padding,
// under a header 36 px high, or 75 px if the block has text; a collapsed sub-map is a card up to 280 px wide.
// MAX is the node size limit (limits.maxW and maxH in model.mjs). It is far larger than any sub-map: with a limit
// of 2000 px, a container that needed more stored 2000, and the w and h in the map were smaller than what the screen showed.

const PAD = 12, EDGE = 1, HEAD = { base: 36, text: 39 }, FOLDED = { w: 280, h: 30 }, MAX = 20000;
const GAP = { x: 80, y: 40, note: 16, stack: 12, field: 24 };
export const headerH = n => HEAD.base + (n.text.trim() ? HEAD.text : 0);

// A line is 18 px, roughly 7.6 px per character of text (8.4 px if the text has `code`: the monospace font is wider)
// and 8.6 px per character of the bold title, 10 px margins.
export function fitSize(n) {
  const note = n.type === 'note', w = note ? (n.text.length > 200 ? 240 : 160) : n.text.length > 280 ? 320 : 240, inner = w - 24;
  const lines = (s, px) => s.trim() ? s.trim().split('\n').reduce((sum, p) => sum + Math.max(1, Math.ceil(p.length * px / inner)), 0) : 0;
  const title = note ? 0 : lines(n.title, 8.6), text = lines(n.text, n.text.includes('`') ? 8.4 : 7.6);
  const h = 22 + 18 * (title + text) + (title && text ? 3 : 0);
  return { w, h: Math.min(600, Math.max(note ? 80 : 60, Math.round(h))) };
}

// Node sizes on screen: an expanded sub-map is no smaller than its content, a collapsed one is a compact card.
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

// Sub-maps were collapsed or expanded, the whole batch at once (folds: id → collapsed). The map is first expanded fully,
// then collapsed to the wanted view. Each step is exactly reversible, and the expanded map is the same whichever view
// it is reached from, so the view depends only on what is collapsed: however often you switch levels, dive in and
// come back out, everything lands in the same places. The expanded map is the most detailed one: a note under a wide
// sub-map is under it there, not diagonal from the collapsed card. The safety net looks only at the result: new overlaps
// compared with the view before the batch. Returns the number of its shifts.
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
// Depth of a level; a repeat in the chain (the batch is not validated yet) stops the walk.
const depthOf = (byId, level) => { let d = 0; for (const seen = new Set(); level !== null && level !== undefined && !seen.has(level); level = byId.get(level)?.parentId) { seen.add(level); d++; } return d; };

// One step: levels go from the deepest to the main map; on a level, the blocks whose visible size changed (the sub-maps
// themselves and their outer containers) change it together, and each unit (a block with its notes, or a free note)
// shifts so that the gap to its nearest neighbour on the left in its band and above it in its column stays the same.
// Everything is computed from the previous view of the level, so the order of operations does not matter. Returns the affected levels.
function refold(graph, folds) {
  const byId = new Map(graph.nodes.map(n => [n.id, n])), { kids, shown } = measure(graph);
  // Chain of ancestors; a repeat in it (the batch is not validated yet) stops the walk.
  const chain = n => { const out = []; for (const seen = new Set(); n && !seen.has(n.id); n = byId.get(n.parentId)) { seen.add(n.id); out.push(n); } return out; };
  const levels = new Set();
  for (const [id, collapsed] of folds) { const n = byId.get(id); if (n && n.collapsed !== collapsed && kids(id).length) for (const p of chain(n)) levels.add(p.parentId); }
  const before = new Map();
  for (const level of levels) for (const n of kids(level)) before.set(n.id, { x: n.x, y: n.y, ...shown(n) });
  for (const [id, collapsed] of folds) if (byId.has(id)) byId.get(id).collapsed = collapsed;
  for (const level of [...levels].sort((a, b) => depthOf(byId, b) - depthOf(byId, a))) {
    const all = kids(level), size = new Map(all.map(n => [n.id, { w: before.get(n.id).w, h: before.get(n.id).h }]));
    const goal = new Map(all.map(n => [n.id, shown(n)]));
    // Widths and heights change in separate passes: shrinking goes width first, then height; growing goes the other way.
    // The reverse action goes through the same steps in reverse order and, as long as the band (column) of every pair
    // of neighbours stays the same, puts every node back exactly in place: hand placement is not lost.
    for (const [axis, sign] of [['w', -1], ['h', -1], ['h', 1], ['w', 1]]) {
      const moving = new Map();
      for (const n of all) { const d = goal.get(n.id)[axis] - size.get(n.id)[axis]; if (n.type !== 'note' && Math.sign(d) === sign) moving.set(n.id, d); }
      if (moving.size) spread(all, axis, moving, size);
    }
  }
  return levels;
}

// One pass along an axis (axis: w is horizontal, h is vertical): the blocks in moving change size by their difference.
// A pair of nodes from different units that follow each other along the axis and overlap across it keeps its order: a unit
// shifts just enough for its narrowest gap to the nodes before it to stay the same. The pass moves nothing across the
// axis, so pairs that did not overlap cannot start to. Nodes that already lie on top of each other
// move together: an existing overlap does not grow and does not drag the others along.
// A block's notes form one unit with it. A note that sticks out past its far edge in its band (a stack at the side,
// a sticker on the corner) moves with the edge, and so does the continuation of the stack below the band: notes past the edge on the same line (for a stack
// on the right, the same x) that join it in a chain. A note under the block follows the bottom edge in the pass along the other axis.
// The check is the same in both directions (width at the old height, height at the smaller width): a note that
// moves keeps its distance from the edge, the others from the block, and the stack line does not change, so the reverse step puts
// the notes back exactly. With a collapsed card, a note off the line (under the block, next to the stack) is not mistaken for part of the stack.
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
    // A sticker that starts above the block follows only the right edge, even if it reaches below the collapsed card.
    const edge = k.a + k.l, notes = own.get(k.n.id), seed = new Set(notes.filter(r => r.a + r.l > edge && r.a >= k.a && across(r, k))), lines = new Map();
    for (const r of notes) if (seed.has(r) || (r.a >= edge && r.b >= k.b + k.m)) { if (!lines.has(r.a)) lines.set(r.a, []); lines.get(r.a).push(r); }
    // The line in order across the axis: the chain breaks at a gap larger than GAP.y, and a piece with a note from the band moves as a whole.
    for (const line of lines.values()) if (line.some(r => seed.has(r))) {
      line.sort((p, q) => p.b - q.b);
      for (let i = 0, j; i < line.length; i = j) {
        let reach = -Infinity, go = false;
        for (j = i; j < line.length && (j === i || line[j].b - reach <= GAP.y); j++) { reach = Math.max(reach, line[j].b + line[j].m); go ||= seed.has(line[j]); }
        if (go) for (let x = i; x < j; x++) line[x].f = k.d;
      }
    }
  }
  // "Before / after" pairs: one after the other along the axis and in the same band across it. A pair is not needed if
  // between the nodes stands a third one that overlaps both across the axis and keeps order with each: it is from another unit (its own pair holds it)
  // or from the same one but shifts by the same amount. The gap through it is narrower, and the order through it is the same on the reverse
  // step too. A note that moves with the edge keeps no order with a still note of the same block. Neighbours
  // are tried nearest first; once every point of the band is covered by two units, or by one but with each of its shifts,
  // the farther ones are no longer needed, so the work does not grow as a cube.
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
  // Interleaved units (block A before note B, block B before note A) also move together, as strongly connected
  // components (Tarjan): otherwise each would have to stand both before the other and after it. The pairs are then collected again:
  // inside a merged unit the nodes no longer hold each other.
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
  // A unit goes after everything that stands before it (there are no cycles left).
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

// A laid-out sub-map (the layout operation): its block fits the content exactly with the usual margin, so it also shrinks
// after being stretched by hand. Neighbours stay in place when it shrinks.
export function tighten(graph, id) {
  const n = graph.nodes.find(x => x.id === id), { kids, content } = measure(graph);
  if (!n || !kids(id).length) return;
  const c = content(n, GAP.field);
  n.w = Math.min(MAX, Math.max(120, c.w)); n.h = Math.min(MAX, Math.max(60, c.h));
}

const rectOf = shown => n => ({ x: n.x, y: n.y, ...shown(n) });
const box = rs => { const x = Math.min(...rs.map(q => q.x)), y = Math.min(...rs.map(q => q.y)); return { x, y, w: Math.max(...rs.map(q => q.x + q.w)) - x, h: Math.max(...rs.map(q => q.y + q.h)) - y }; };
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// The existing block X among the level's nodes all has already grown or got notes; o is its previous rectangle (without
// notes). Neighbours move apart so the gap is the usual one again: whatever starts below X's old bottom moves down
// together with everything under it, then everything that starts right of the old right edge moves right in one piece by exactly
// the missing space. Whose neighbour a node is depends on its block, not on the hull with notes, and the bounds are X itself, not X with notes:
// otherwise a neighbour in a pocket under a tall note of X, or beside that note, would stay in place. A note of a neighbour whose block is
// above or left of X, while the note itself ended up under the grown X, moves with the shift on its own. Both shifts are rigid.
function makeRoom(shown, all, X, o) {
  const notes = new Map(), rect = rectOf(shown);
  for (const n of all) if (n.type === 'note' && n.attachedTo) { if (!notes.has(n.attachedTo)) notes.set(n.attachedTo, []); notes.get(n.attachedTo).push(n); }
  const rX = box([X, ...(notes.get(X.id) ?? [])].map(rect)), xR = o.x + o.w, yD = o.y + o.h;
  const near = (a, b) => a.x < b.x + b.w + GAP.x && b.x < a.x + a.w + GAP.x;
  // A unit is a block together with its notes, or a free note.
  const unit = members => ({ members, ...box(members.map(rect)) }), units = [], below = new Set(), right = new Set();
  for (const n of all) {
    if (n === X || (n.type === 'note' && n.attachedTo)) continue;
    const own = notes.get(n.id) ?? [], u = unit([n, ...own]);
    if (n.x >= xR) { units.push(u); right.add(u); continue; }
    if (n.y >= yD && near(u, rX)) { units.push(u); below.add(u); continue; }
    // A block above or left of X: its note right of the old edge in X's band moves right, one below the old bottom moves down.
    const loose = own.filter(k => k.x >= xR ? k.y < rX.y + rX.h && rX.y < k.y + k.h : k.y >= yD && k.x < rX.x + rX.w && rX.x < k.x + k.w);
    units.push(loose.length ? unit([n, ...own.filter(k => !loose.includes(k))]) : u);
    for (const k of loose) { const v = unit([k]); units.push(v); (k.x >= xR ? right : below).add(v); }
  }
  const move = (u, dx, dy) => { for (const m of u.members) { m.x += dx; m.y += dy; } u.x += dx; u.y += dy; };
  // Under a unit is everything that starts below its top and is horizontally closer than the usual gap: a neighbour that a grown
  // container not yet processed already overlaps moves down with it too, and nothing is left pressed against the side of what moved.
  for (const queue = [...below]; queue.length; ) { const u = queue.pop(); for (const v of units) if (!below.has(v) && v.y >= u.y && near(v, u)) { below.add(v); queue.push(v); } }
  const dy = Math.max(0, ...[...below].filter(u => near(u, rX)).map(u => rX.y + rX.h + GAP.y - u.y));
  if (dy) for (const u of below) move(u, 0, dy);
  const dx = Math.max(0, ...[...right].filter(u => u.y < rX.y + rX.h + GAP.y && rX.y < u.y + u.h + GAP.y).map(u => rX.x + rX.w + GAP.x - u.x));
  if (dx) for (const u of right) move(u, dx, 0);
}

// A block's existing notes keep to their side when it grows by dw × dh (o is its previous rectangle): on the right, the whole
// stack follows the right edge, including its part below the block; underneath, notes follow the bottom; a corner note follows the corner.
function keepSides(own, o, dw, dh) {
  const xR = o.x + o.w, yD = o.y + o.h, right = new Set(own.filter(k => k.x + k.w > xR && k.y < yD && (k.x >= xR || k.y + k.h > o.y)));
  // A Set also visits items added during the loop: the chain grows without rescanning the list at every step (a 2000-note stack is not a cube).
  const below = own.filter(k => !right.has(k) && k.x >= xR && k.y >= yD);
  for (const r of right) for (const k of below) if (!right.has(k) && k.x < r.x + r.w && r.x < k.x + k.w && Math.max(k.y, r.y) - Math.min(k.y + k.h, r.y + r.h) <= GAP.y) right.add(k);
  for (const k of own) {
    const side = right.has(k), corner = !side && k.x >= xR && k.y >= yD;
    if (side || corner) k.x += dw;
    if (!side && k.y + k.h > yD && (k.y >= yD || (k.x + k.w > o.x && k.x < xR))) k.y += dh;
  }
}

// On-screen rectangles of the nodes, except skip: the previous view of the levels for makeSpace.
export function screenRects(graph, skip = new Set()) {
  const nodes = graph.nodes.filter(n => !skip.has(n.id)), { shown } = measure({ nodes });
  return new Map(nodes.map(n => [n.id, { x: n.x, y: n.y, ...shown(n) }]));
}

// Edits with coordinates are already applied: dragging inside a sub-map, a block inside, a resize, a note dropped on
// a block. before is the previous view of the levels (id → on-screen rectangle), attached are the notes the batch attached,
// skip are the nodes autoLayout will place later. A note dropped on its own block stands beside it, and a
// sub-map that grew pushes its neighbours apart and keeps its notes on their side, as in an agent build
// (makeRoom). Levels go from the deepest to the main map: the outer container grows already accounting for the shifts inside.
export function makeSpace(graph, before, attached = new Set(), skip = new Set()) {
  const nodes = graph.nodes.filter(n => !skip.has(n.id)), { kids, shown } = measure({ nodes }), byId = new Map(graph.nodes.map(n => [n.id, n]));
  const depth = level => { let d = 0; for (let p = byId.get(level); p; p = byId.get(p.parentId)) d++; return d; };
  const levels = [...new Set(nodes.map(n => n.parentId))].sort((x, y) => depth(y) - depth(x));
  for (const level of levels) {
    const all = kids(level), notes = all.filter(n => attached.has(n.id) && byId.get(n.attachedTo)?.parentId === level);
    const grown = all.filter(n => n.type === 'block' && kids(n.id).length && before.has(n.id) && (shown(n).w > before.get(n.id).w || shown(n).h > before.get(n.id).h));
    if (!notes.length && !grown.length) continue;
    // The safety net removes only what the growth and the shifts made here added: overlaps that the person or the agent
    // made with their own edit stay as they are.
    const snap = new Map(all.map(n => [n.id, { x: n.x, y: n.y, ...(grown.includes(n) ? { w: before.get(n.id).w, h: before.get(n.id).h } : shown(n)) }]));
    // If the right side is closer, it stands on the right, below the existing notes there, otherwise under the block, right of the existing ones.
    // A sticker on the top right corner (that is how the UI places it) stays: it follows the corner.
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
      // The growth does not touch a note the batch placed itself (a step-by-step build writes the final places).
      const kept = k => before.has(k.id) && k.x - X.x === before.get(k.id).x - b.x && k.y - X.y === before.get(k.id).y - b.y;
      keepSides(all.filter(k => k.attachedTo === X.id && kept(k)), o, Math.max(0, now.w - b.w), Math.max(0, now.h - b.h));
      makeRoom(shown, all, X, o);
    }
    settle(shown, all, snap);
  }
}

// A safety net for what the pushing apart did not foresee (a pocket between units, a note that drifted from its block):
// each new overlap on the level is removed by a shift right or down, whichever is shorter, to the usual gap. The one that
// moves is a note rather than a block, otherwise the one that did not change, otherwise the lower and further right one; a block moves with its notes.
// Overlaps that existed before the batch (snap holds the previous rectangles) are left alone. At most 4 steps per node.
// Returns the number of shifts.
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

// Places the nodes in placed. Levels are processed from the deepest to the main map: a sub-map is laid out before
// its container, and the container takes its place already at its final size. On a level, new blocks go in columns
// following the links between them (source left of target), attached notes go to the right of their block.
// refit are the containers that shrink to their content after layout (laying out a whole level),
// created are the nodes added by this batch (by default, the ones being placed).
export function autoLayout(graph, placed, refit = new Set(), created = placed) {
  if (!placed.size) return;
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  // The view of the existing nodes without the added ones: it shows how much an existing container has grown.
  const prior = graph.nodes.filter(n => !created.has(n.id)), { shown: was } = measure({ nodes: prior });
  const before = new Map(prior.map(n => [n.id, was(n)]));
  for (const id of refit) { const n = byId.get(id); n.w = 120; n.h = 60; }
  const { kids, content, shown } = measure(graph);
  const depth = id => { let d = 0; for (let p = id; p; p = byId.get(p)?.parentId) d++; return d; };
  // A container that has become too tight grows to its content with some margin.
  const fit = n => {
    const need = content(n, 0);
    if (need.w <= n.w && need.h <= n.h) return;
    const roomy = content(n, GAP.field);
    n.w = Math.min(MAX, Math.max(n.w, roomy.w)); n.h = Math.min(MAX, Math.max(n.h, roomy.h));
  };
  // A new container grows as soon as its level is laid out; outer ones grow later, when their level is laid out: until then
  // their content stands in the old places, and a sub-map laid out with deep would grow to fit the old pile. Existing
  // containers grow on the level of their own container (room).
  const grow = id => { if (placed.has(id)) fit(byId.get(id)); };
  // The levels of new nodes and all levels above them are processed: an existing container on the ancestor chain of a new node
  // grows and pushes its neighbours apart before the level of its own container is laid out.
  const chain = new Set(), seen = new Set([...placed].map(id => byId.get(id).parentId));
  for (const id of placed) for (let p = byId.get(id).parentId; p && !chain.has(p); p = byId.get(p).parentId) { chain.add(p); seen.add(byId.get(p).parentId); }
  const levels = [...seen].sort((a, b) => depth(b) - depth(a)), done = new Set(), free = n => !placed.has(n.id) || done.has(n.id);
  // Existing blocks of the level that grew because of the batch or got new notes, top to bottom and left
  // to right: each pushes its neighbours apart, and its container grows later, already accounting for the shifts.
  const room = level => {
    const all = kids(level), list = all.filter(n => n.type !== 'note' && !placed.has(n.id) && (chain.has(n.id) || all.some(k => k.attachedTo === n.id && placed.has(k.id))));
    if (!list.length) return;
    const snap = new Map(all.filter(free).map(n => [n.id, { x: n.x, y: n.y, ...(before.get(n.id) ?? shown(n)) }]));
    for (const X of list.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const b = before.get(X.id) ?? { w: X.w, h: X.h }, need = content(X, 0);
      // Only what became larger than the previous view grows: a size that lags behind the content after a nested sub-map was
      // expanded by hand is not adjusted, otherwise collapsing it back would leave a trace. A collapsed block does not grow,
      // but an empty collapsed block with its first nested blocks becomes a card, which can be taller than the block, and it pushes neighbours apart.
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
      // New notes go right of the final edge in a stack, below the notes already there.
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
    // Start: on the main map, right of everything that exists; in a sub-map, under the existing content.
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const n of old) { const s = shown(n); x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y); x2 = Math.max(x2, n.x + s.w); y2 = Math.max(y2, n.y + s.h); }
    const origin = level === null ? (old.length ? { x: x2 + 2 * GAP.x, y: y1 } : { x: 0, y: 0 }) : { x: GAP.field, y: old.length ? y2 + GAP.y : GAP.field };

    // Links between blocks of this level. A link to a node inside a sub-map counts as a link to the sub-map itself:
    // otherwise a block that leads into the nested content would not stand left of the container.
    const owner = id => { let n = byId.get(id); while (n && n.parentId !== level) n = n.parentId ? byId.get(n.parentId) : null; return n?.id; };
    const sourcesOf = new Map();
    for (const e of graph.edges) {
      const s = owner(e.source), t = owner(e.target);
      if (s && t && s !== t && freshIds.has(s) && freshIds.has(t)) sourcesOf.set(t, new Set([...(sourcesOf.get(t) ?? []), s]));
    }
    // A block's column is the length of the longest path to it along these links.
    const rank = new Map(), visiting = new Set();
    const rankOf = id => {
      if (rank.has(id)) return rank.get(id);
      if (visiting.has(id)) return 0; // cycle: a back link does not shift the column
      visiting.add(id);
      const r = Math.max(0, ...[...(sourcesOf.get(id) ?? [])].map(s => rankOf(s) + 1));
      visiting.delete(id); rank.set(id, r);
      return r;
    };
    let columns = [];
    for (const n of blocks) (columns[rankOf(n.id)] ??= []).push(n);
    // With cycles a column number can be skipped: drop the empty columns, otherwise the width calculation gives NaN.
    columns = columns.filter(Boolean);
    // Without links a single column would stretch into a tall strip: lay the blocks out in an almost square grid.
    if (columns.length === 1 && blocks.length > 3) {
      const rows = Math.ceil(blocks.length / Math.ceil(Math.sqrt(blocks.length)));
      columns = Array.from({ length: Math.ceil(blocks.length / rows) }, (_, i) => blocks.slice(i * rows, (i + 1) * rows));
    }
    // Order within a column follows the average height of the sources in previous columns, so links cross less.
    // Blocks without sources keep their original order after the rest.
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
    // On the Code level (sub-maps of Technical blocks and deeper) steps go top to bottom, like lines of a program; above it,
    // Mechanics and Technical go left to right, like data flows. This way nested sub-maps do not stretch into one long strip.
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

    // New free notes go side by side under the new blocks (notes on existing blocks are already placed, see room).
    let nx = origin.x;
    const ny = blocks.length ? bottom + GAP.y : origin.y;
    for (const note of fresh.filter(n => n.type === 'note' && !freshIds.has(n.attachedTo))) { note.x = nx; note.y = ny; nx += note.w + GAP.note; }
    for (const n of fresh) done.add(n.id);
    if (level !== null) grow(level);
  }
}
