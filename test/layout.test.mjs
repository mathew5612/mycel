import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations } from '../src/model.mjs';
import { measure, reflow } from '../src/layout.mjs';

const GAP = { x: 80, y: 40 };
const empty = () => ({ schemaVersion: 3, revision: 0, updatedAt: '2026-01-01T00:00:00.000Z', nodes: [], edges: [], history: [] });
const block = (id, parentId, text = '', extra = {}) => ({ type: 'add-node', node: { id, title: id, text, parentId, ...extra } });
const note = (id, attachedTo, parentId, text, extra = {}) => ({ type: 'add-node', node: { id, type: 'note', attachedTo, parentId, text, ...extra } });
const link = (source, target) => ({ type: 'add-edge', edge: { id: `${source}-${target}`, source, target } });
const apply = (graph, operations) => applyOperations(graph, operations).graph;

// Six linked top-level concepts: ui and cli in one column, api has a note on the right, a free note below.
const names = ['ui', 'cli', 'api', 'auth', 'store', 'disk'];
const concepts = () => [
  block('ui', null, 'Map interface in a browser'), block('cli', null, 'Agent commands'), block('api', null, 'Hub HTTP API: projects, maps, chat'),
  block('auth', null), block('store', null, 'Stores the map and its history on disk, atomic write through a temp file'), block('disk', null, 'Project folder'),
  note('api-note', 'api', null, 'Each mutation passes expectedRevision'), note('todo', null, null, 'Check restoring projects from trash'),
  link('ui', 'api'), link('cli', 'api'), link('api', 'auth'), link('api', 'store'), link('auth', 'store'), link('store', 'disk')
];
const phrases = ['Reads the map and returns it all', 'Checks the revision and rejects any stale edits', '',
  'Writes the file via a temporary copy and then a rename, so the map is not lost on a power cut or a process crash', 'Briefly',
  'Waits for changes from others and wakes the waiting agents when an edit arrives from the person or another agent. The timeout is limited, reconnecting is safe and loses no events, and the read cursor is kept on the server separately for each agent and only grows.',
  'Links between nodes'];
// A concept's mechanics as the agent builds them: parent is the concept, no coordinates. The first has code steps, the third
// collapsed steps, the second and fourth have notes.
function mechanics(c, k = 0) {
  const m = i => `${c}${i}`, text = i => phrases[(k + i) % phrases.length];
  return [
    block(m(1), c, text(1)), block(`${m(1)}a`, m(1), 'Parses `graph.json`'), block(`${m(1)}b`, m(1)), block(`${m(1)}c`, m(1), text(2)),
    block(m(2), c, text(3)), note(`${m(2)}-note`, m(2), c, `The reason: ${text(4)}`),
    block(m(3), c, text(5), { collapsed: true }), block(`${m(3)}a`, m(3), 'Validates `expectedRevision`'), block(`${m(3)}b`, m(3)),
    block(m(4), c), note(`${m(4)}-note`, m(4), c, text(6) || 'Note'),
    link(m(1), m(2)), link(m(2), m(4)), link(m(1), m(3)), link(`${m(1)}a`, `${m(1)}b`), link(`${m(1)}b`, `${m(1)}c`)
  ];
}

// Units of a level as the layout sees them: a block together with its attached notes, or a free note.
function units(graph, level) {
  const { shown } = measure(graph), all = graph.nodes.filter(n => n.parentId === level);
  return all.filter(n => n.type !== 'note' || !n.attachedTo).map(n => {
    const rs = [n, ...all.filter(k => k.attachedTo === n.id)].map(k => ({ x: k.x, y: k.y, ...shown(k) }));
    const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
    return { id: n.id, x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y };
  });
}
const unit = (graph, id) => units(graph, graph.nodes.find(n => n.id === id).parentId).find(u => u.id === id);
const apart = (a, b, gx = 0, gy = 0) => a.x + a.w + gx <= b.x || b.x + b.w + gx <= a.x || a.y + a.h + gy <= b.y || b.y + b.h + gy <= a.y;
// On no level do units overlap, and blocks stand no closer than the usual gap (free notes are packed tighter).
function assertNoOverlaps(graph, when) {
  const block = new Set(graph.nodes.filter(n => n.type !== 'note').map(n => n.id));
  for (const level of new Set(graph.nodes.map(n => n.parentId))) {
    const list = units(graph, level);
    for (const a of list) for (const b of list) if (a !== b) {
      assert.ok(apart(a, b), `${when}: ${a.id} and ${b.id} overlap`);
      if (block.has(a.id) && block.has(b.id)) assert.ok(apart(a, b, GAP.x, GAP.y), `${when}: ${a.id} is too close to ${b.id}`);
    }
  }
}
// A pushed neighbour stands exactly at the usual gap from the grown concept: GAP.x on the right, GAP.y below.
function assertPushedExactly(prev, next, id) {
  const was = new Map(units(prev, null).map(u => [u.id, u])), g = unit(next, id), others = units(next, null).filter(u => u.id !== id);
  const right = others.some(u => u.x > was.get(u.id).x), down = others.some(u => u.y > was.get(u.id).y);
  if (right) assert.equal(Math.min(...others.filter(u => u.x >= g.x + g.w && u.y < g.y + g.h + GAP.y && g.y < u.y + u.h + GAP.y).map(u => u.x - g.x - g.w)), GAP.x, `${id}: neighbour on the right`);
  if (down) assert.equal(Math.min(...others.filter(u => u.y >= g.y + g.h && u.x < g.x + g.w + GAP.x && g.x < u.x + u.w + GAP.x).map(u => u.y - g.y - g.h)), GAP.y, `${id}: neighbour below`);
  return { right, down };
}
const geometry = graph => graph.nodes.map(n => [n.id, n.x, n.y, n.w, n.h, n.collapsed]);
const grown = () => names.reduce((graph, c, k) => apply(graph, mechanics(c, k)), apply(empty(), concepts()));
const at = (graph, id) => graph.nodes.find(n => n.id === id);
const fold = (id, collapsed = true) => [{ type: 'update-node', id, patch: { collapsed } }];
// Overlaps between the individual rectangles of a level: blocks and notes, including a note and its own block.
function overlapsOf(graph) {
  const { shown } = measure(graph), out = [];
  for (const level of new Set(graph.nodes.map(n => n.parentId))) {
    const rs = graph.nodes.filter(n => n.parentId === level).map(n => ({ id: n.id, x: n.x, y: n.y, ...shown(n) }));
    for (const a of rs) for (const b of rs) if (a.id < b.id && !apart(a, b)) out.push(`${a.id}/${b.id}`);
  }
  return out;
}
const assertApart = (graph, when) => assert.deepEqual(overlapsOf(graph), [], when);

test('concepts grown by their mechanics one build at a time push neighbours aside without overlaps', () => {
  let graph = apply(empty(), concepts());
  assertNoOverlaps(graph, 'concepts');
  const pushed = { right: 0, down: 0 };
  names.forEach((c, k) => {
    const next = apply(graph, mechanics(c, k));
    assertNoOverlaps(next, c);
    const p = assertPushedExactly(graph, next, c);
    pushed.right += p.right; pushed.down += p.down;
    const concept = next.nodes.find(n => n.id === c), inner = unit(next, `${c}1`);
    assert.ok(concept.w >= inner.x + inner.w + 26, `${c} fits its mechanics`);
    graph = next;
  });
  assert.ok(pushed.right >= 3 && pushed.down >= 1, 'neighbours were actually pushed');
  // Steps into an existing mechanic: it pushes the concept's mechanics apart, the concept pushes the map.
  let next = apply(graph, [block('api1d', 'api1', 'Another step'), block('api1e', 'api1'), link('api1c', 'api1d')]);
  assertNoOverlaps(next, 'steps in api1'); assertPushedExactly(graph, next, 'api');
  graph = next;
  // A fifth mechanic in a full concept goes under the existing ones, the concept grows downwards.
  next = apply(graph, [block('store5', 'store', 'Mechanics #5'), note('store5-note', 'store5', 'store', 'Note')]);
  assertNoOverlaps(next, 'store5'); assertPushedExactly(graph, next, 'store');
  assert.ok(next.nodes.find(n => n.id === 'store').h > graph.nodes.find(n => n.id === 'store').h);
});

test('two concepts in one column growing in one batch do not overlap', () => {
  const graph = apply(empty(), concepts()), at = id => graph.nodes.find(n => n.id === id);
  assert.ok(at('ui').x === at('cli').x && at('ui').y < at('cli').y, 'ui above cli in one column');
  const next = apply(graph, [...mechanics('ui'), ...mechanics('cli', 3)]);
  assertNoOverlaps(next, 'ui and cli');
  const ui = unit(next, 'ui'), cli = unit(next, 'cli');
  assert.equal(cli.y, ui.y + ui.h + GAP.y, 'cli exactly under the grown ui');
  assert.ok(unit(next, 'api').x >= Math.max(ui.x + ui.w, cli.x + cli.w) + GAP.x, 'api right of both');
});

test('folding and unfolding a sub-map returns every node to its place', () => {
  const graph = grown();
  for (const id of [...names, 'api1', 'store1']) {
    const folded = apply(graph, [{ type: 'update-node', id, patch: { collapsed: true } }]);
    assert.deepEqual(geometry(apply(folded, [{ type: 'update-node', id, patch: { collapsed: false } }])), geometry(graph), id);
  }
  // A collapsed mechanic: expand it and collapse it back.
  const open = apply(graph, [{ type: 'update-node', id: 'disk3', patch: { collapsed: false } }]);
  assert.deepEqual(geometry(apply(open, [{ type: 'update-node', id: 'disk3', patch: { collapsed: true } }])), geometry(graph));
});

// A concept placed by the person: one nested block sets its visible size w × h.
const concept = (id, x, y, w, h) => [block(id, null, '', { x, y, w: 220, h: 60 }), block(`${id}-in`, id, '', { x: 24, y: 24, w: w - 50, h: h - 74 })];
const folds = (ids, collapsed) => ids.map(id => ({ type: 'update-node', id, patch: { collapsed } }));
test('switching the level of hand-placed concepts never puts one on another, whatever the op order', () => {
  // c1 above c3 in one column, c2 and c4 in the column to the right. The batch used to be computed op by op: c2 slid left
  // over c3, and c3 moved up after both c1 and c2, onto c1; the result depended on the op order and did not come back.
  const graph = apply(empty(), [...concept('c1', 400, 300, 634, 260), ...concept('c2', 1100, 100, 394, 613), ...concept('c3', 200, 1000, 794, 386), ...concept('c4', 1100, 1100, 394, 487)]);
  const ids = ['c1', 'c2', 'c3', 'c4'], size = (g, id) => measure(g).shown(at(g, id));
  assert.deepEqual(size(graph, 'c3'), { w: 794, h: 386 });
  const one = apply(graph, folds(ids, true));
  assertApart(one, 'concept level');
  assert.equal(at(one, 'c3').y - at(one, 'c1').y - size(one, 'c1').h, at(graph, 'c3').y - at(graph, 'c1').y - size(graph, 'c1').h, 'c3 under c1 at the same gap');
  for (const order of [[3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]]) assert.deepEqual(geometry(apply(graph, order.map(i => folds(ids, true)[i]))), geometry(one), `order ${order}`);
  assert.deepEqual(geometry(apply(one, folds(ids, false))), geometry(graph), 'back');
  // A row right of a column of two expanded concepts of different widths: the row's right block moved by the sum of both
  // narrowings and landed on the left one.
  const row = apply(empty(), [...concept('a', 0, 0, 314, 317), ...concept('b', 0, 357, 388, 454), block('c', null, '', { x: 394, y: 101, w: 240, h: 61 }), block('d', null, '', { x: 714, y: 101, w: 240, h: 61 })]);
  const flat = apply(row, folds(['a', 'b'], true));
  assertApart(flat, 'row');
  assert.equal(at(flat, 'd').x - at(flat, 'c').x, 320, 'the row did not spread apart');
  assert.deepEqual(geometry(apply(row, folds(['b', 'a'], true))), geometry(flat));
  assert.deepEqual(geometry(apply(flat, folds(['a', 'b'], false))), geometry(row));
});

test('folds in a mixed batch are laid out in groups between the other operations', () => {
  const graph = apply(empty(), [...concept('a', 0, 0, 600, 300), ...concept('b', 680, 0, 400, 500), block('c', null, '', { x: 0, y: 340, w: 240, h: 61 })]);
  const move = { type: 'update-node', id: 'c', patch: { x: 0, y: 400 } };
  const mixed = applyOperations(graph, [...folds(['a'], true), move, ...folds(['b'], true)]);
  assert.deepEqual(geometry(mixed.graph), geometry(apply(apply(apply(graph, folds(['a'], true)), [move]), folds(['b'], true))));
  assert.deepEqual(mixed.changes, ['Collapsed sub-map "a"', 'Moved block "c"', 'Collapsed sub-map "b"']);
  // Collapsing together with other fields happens at once, in its own group.
  assert.deepEqual(geometry(apply(graph, [{ type: 'update-node', id: 'a', patch: { collapsed: true, color: 'blue' } }])), geometry(apply(graph, folds(['a'], true))));
});

// Layout of the same content in one batch, as before neighbours were pushed apart (captured with the old algorithm). Captured
// again in 0.11: blocks inside a mechanic are now the Technical level, which goes left to right (only Code goes top to bottom), so
// steps ui1a–ui1c stand in a row and the unlinked ui3a and ui3b in a column, and the concepts got wider and shorter.
const today = {
  ui: [0, 0, 2020, 397], cli: [0, 437, 2100, 484], api: [2180, 208, 2020, 505], auth: [4456, 232, 2020, 458], store: [6556, 281, 2020, 360], disk: [8656, 280, 2020, 362],
  'api-note': [4216, 208, 160, 80], todo: [0, 961, 160, 80], ui1: [24, 55, 954, 198], ui1a: [24, 24, 240, 61], ui1b: [344, 25, 240, 60], ui1c: [664, 25, 240, 60], ui2: [1058, 24, 240, 115],
  'ui2-note': [1314, 24, 160, 80], ui3: [1058, 179, 314, 316], ui3a: [24, 24, 240, 79], ui3b: [24, 143, 240, 60], ui4: [1554, 114, 240, 60], 'ui4-note': [1810, 114, 160, 80], cli1: [24, 91, 954, 213],
  cli1a: [24, 51, 240, 61], cli1b: [344, 52, 240, 60], cli1c: [664, 24, 240, 115], cli2: [1058, 24, 240, 61], 'cli2-note': [1314, 24, 240, 202], cli3: [1058, 266, 314, 316], cli3a: [24, 24, 240, 79],
  cli3b: [24, 143, 240, 60], cli4: [1634, 158, 240, 60], 'cli4-note': [1890, 158, 160, 80], api1: [24, 109, 954, 198], api1a: [24, 24, 240, 61], api1b: [344, 25, 240, 60], api1c: [664, 24, 240, 61],
  api2: [1058, 24, 240, 223], 'api2-note': [1314, 24, 160, 80], api3: [1058, 287, 314, 316], api3a: [24, 24, 240, 79], api3b: [24, 143, 240, 60], api4: [1554, 168, 240, 60],
  'api4-note': [1810, 168, 160, 80], auth1: [24, 24, 954, 360], auth1a: [24, 105, 240, 61], auth1b: [344, 106, 240, 60], auth1c: [664, 24, 240, 223], auth2: [1058, 92, 240, 61],
  'auth2-note': [1314, 92, 160, 80], auth3: [1058, 212, 314, 316], auth3a: [24, 24, 240, 79], auth3b: [24, 143, 240, 60], auth4: [1554, 164, 240, 60], 'auth4-note': [1810, 164, 160, 80],
  store1: [24, 24, 954, 223], store1a: [24, 24, 240, 61], store1b: [344, 25, 240, 60], store1c: [664, 24, 240, 61], store2: [1058, 36, 240, 79], 'store2-note': [1314, 36, 160, 94],
  store3: [1058, 170, 314, 277], store3a: [24, 24, 240, 79], store3b: [24, 143, 240, 60], store4: [1554, 62, 240, 60], 'store4-note': [1810, 62, 160, 148], disk1: [24, 29, 954, 216],
  disk1a: [24, 33, 240, 61], disk1b: [344, 34, 240, 60], disk1c: [664, 24, 240, 79], disk2: [1058, 24, 240, 79], 'disk2-note': [1314, 24, 160, 80], disk3: [1058, 144, 314, 316],
  disk3a: [24, 24, 240, 79], disk3b: [24, 143, 240, 60], disk4: [1554, 97, 240, 60], 'disk4-note': [1810, 97, 160, 80]
};

test('a one-shot build of the same structure keeps the previous layout', () => {
  const graph = apply(empty(), [...concepts(), ...names.flatMap((c, k) => mechanics(c, k))]);
  assertNoOverlaps(graph, 'one batch');
  assert.deepEqual(Object.fromEntries(graph.nodes.map(n => [n.id, [n.x, n.y, n.w, n.h]])), today);
  // A batch with only new containers does not touch what exists.
  const more = apply(graph, [block('hub', null, 'Projects hub'), ...mechanics('hub', 2), link('hub', 'ui')]);
  assert.deepEqual(geometry(more).slice(0, graph.nodes.length), geometry(graph));
  assertNoOverlaps(more, 'new concept');
});

test('a note on an existing concept stands at its grown edge and pushes the next columns', () => {
  const graph = apply(empty(), [block('api', null, 'HTTP API'), block('store', null, 'Database'), block('disk', null, 'Project folder'), link('api', 'store'), link('store', 'disk')]);
  const extra = note('api-note', 'api', null, 'Each mutation passes expectedRevision'), edge = g => at(g, 'api').x + measure(g).shown(at(g, 'api')).w + 16;
  // Together with the concept's mechanics, as the agent fills it in.
  const next = apply(graph, [...mechanics('api'), extra]), n = at(next, 'api-note');
  assertApart(next, 'mechanics and note');
  assert.deepEqual([n.x, n.y], [edge(next), at(next, 'api').y], 'note at the final edge');
  assert.equal(at(next, 'store').x, n.x + n.w + GAP.x, 'store exactly one gap to the right');
  assert.equal(at(next, 'disk').x - at(next, 'store').x, at(graph, 'disk').x - at(graph, 'store').x, 'everything to the right moved as one piece');
  assert.deepEqual(geometry(apply(apply(graph, mechanics('api')), [extra])), geometry(next), 'note after the mechanics gives the same map');
  // A single note without mechanics also pushes the next column.
  const alone = apply(graph, [extra]), a = at(alone, 'api-note');
  assertApart(alone, 'single note');
  assert.equal(at(alone, 'store').x, a.x + a.w + GAP.x);
  // New notes stack under the existing one at the final edge, the existing one follows the edge.
  const more = apply(alone, [...mechanics('api'), note('n1', 'api', null, 'Note 1'), note('n2', 'api', null, 'Note 2')]), [old, n1, n2] = ['api-note', 'n1', 'n2'].map(id => at(more, id));
  assertApart(more, 'stack');
  assert.deepEqual([old.x, n1.x, n2.x, old.y, n1.y, n2.y], [edge(more), edge(more), edge(more), at(more, 'api').y, old.y + old.h + 12, n1.y + n1.h + 12]);
});

test('a block under or beside a note of a growing concept is pushed as well', () => {
  // ui above cli in one column, the tall note of ui is beside cli.
  let graph = apply(empty(), [block('ui', null, 'Interface'), block('cli', null, 'Agent commands')]);
  graph = apply(graph, [note('ui-note', 'ui', null, 'The map is redrawn in full on every SSE event, so the selection and editing state are kept separately from the graph')]);
  assertApart(graph, 'note');
  let next = apply(graph, mechanics('ui'));
  assertApart(next, 'mechanics of ui');
  assert.equal(at(next, 'cli').y, unit(next, 'ui').y + unit(next, 'ui').h + GAP.y, 'cli exactly under ui with its note');
  // A pocket on the right: the person put a block under the short note of a tall block.
  graph = apply(empty(), [block('a', null, 'x'.repeat(300)), note('a-note', 'a', null, 'Briefly')]);
  const an = at(graph, 'a-note');
  graph = apply(graph, [block('b', null, '', { x: an.x, y: an.y + an.h + 12, w: 160, h: 60 })]);
  assertApart(graph, 'pocket');
  next = apply(graph, mechanics('a'));
  assertApart(next, 'mechanics of a');
  assert.equal(at(next, 'b').x, unit(next, 'a').x + unit(next, 'a').w + GAP.x);
  // A collapsed concept with a tall note beside the concept under it: that one grows and does not land on the note.
  const steps = c => [block(`${c}1`, c, 'Reads the map'), block(`${c}2`, c, 'Writes the file'), block(`${c}3`, c, 'Checks the revision'), link(`${c}1`, `${c}2`), link(`${c}2`, `${c}3`)];
  graph = apply(empty(), [block('ui', null, 'Interface'), note('ui-note', 'ui', null, 'The reason: '.repeat(20)), block('cli', null, 'Agent commands'), block('api', null, 'HTTP API'), link('ui', 'api'), link('cli', 'api')]);
  graph = apply(apply(graph, steps('ui')), fold('ui'));
  assertApart(graph, 'ui collapsed');
  assertApart(apply(graph, steps('cli')), 'mechanics of cli');
});

test('an unrelated build does not refit a concept whose sub-map the human opened, so folding it back restores the map', () => {
  let graph = apply(empty(), [block('ui', null, 'Interface'), block('api', null, 'HTTP API'), block('store', null, 'Database'), link('ui', 'api'), link('api', 'store')]);
  graph = apply(graph, [block('m1', 'api', 'Reads the map'), block('m2', 'api', 'Writes'), block('m3', 'api', 'Checks the revision', { collapsed: true }),
    ...[1, 2, 3, 4, 5].map(i => block(`s${i}`, 'm3', `step ${i}`)), link('m1', 'm2'), link('m2', 'm3')]);
  const open = apply(graph, fold('m3', false)), size = (g, id) => [at(g, id).w, at(g, id).h];
  for (const ops of [[note('todo', null, null, 'Check it later')], [block('u1', 'ui', 'Reads'), block('u2', 'ui', 'Draws'), link('u1', 'u2')], [note('ui-note', 'ui', null, 'Note')]]) {
    const other = apply(open, ops);
    assertApart(other, ops[0].node.id);
    assert.deepEqual(size(other, 'api'), size(open, 'api'), `${ops[0].node.id}: api is not refit`);
    assert.deepEqual(geometry(apply(other, fold('m3'))), geometry(apply(apply(open, fold('m3')), ops)), `${ops[0].node.id}: collapse back`);
  }
  // Laying out the map without deep arranges the concepts by their visible size, nested content is not refit.
  graph = apply(empty(), [block('p', null, 'Concept'), block('q', null, 'Neighbour'), block('r', null, 'More'), link('p', 'q')]);
  graph = apply(graph, [block('m', 'p', 'Mechanics'), block('m2', 'p', 'Mechanics 2'), link('m', 'm2')]);
  graph = apply(graph, [block('c', 'm', 'Code', { collapsed: true }), block('c2', 'm', 'More code'), link('c', 'c2')]);
  graph = apply(apply(graph, Array.from({ length: 6 }, (_, i) => block(`s${i}`, 'c', 'Code step with a `call` and notes'))), fold('c', false));
  assertApart(graph, 'c expanded');
  for (const [parentId, deep] of [[null, false], ['p', false], [null, true]]) assertApart(apply(graph, [{ type: 'layout', parentId, deep }]), `layout ${parentId} ${deep}`);
  assert.deepEqual(size(apply(graph, [{ type: 'layout', parentId: null }]), 'm'), size(graph, 'm'));
});

test('a growing block keeps its own notes in place: below stays below, a corner sticker stays at the corner', () => {
  const base = apply(empty(), [block('api', null, 'API')]), api = at(base, 'api'), shownOf = g => measure(g).shown(at(g, 'api'));
  const inner = [block('m1', 'api', 'Mechanics'), block('m2', 'api', 'Mechanics 2'), block('m3', 'api', 'Mechanics 3'), link('m1', 'm2'), link('m2', 'm3')];
  let next = apply(apply(base, [note('under', 'api', null, 'under the block', { x: api.x, y: api.y + api.h + 16, w: 160, h: 80 })]), inner);
  assertApart(next, 'note below');
  assert.deepEqual([at(next, 'under').x, at(next, 'under').y], [api.x, api.y + shownOf(next).h + 16]);
  // A sticker on the top right corner, as the UI places it.
  next = apply(apply(base, [note('sticker', 'api', null, 'sticker', { x: api.x + api.w - 40, y: api.y - 90, w: 160, h: 120 })]), inner);
  assert.deepEqual([at(next, 'sticker').x, at(next, 'sticker').y], [api.x + shownOf(next).w - 40, api.y - 90]);
});

// Offsets of a block's notes from its top right corner.
const offsets = (graph, id, ids) => { const b = at(graph, id), s = measure(graph).shown(b); return ids.map(n => [at(graph, n).x - b.x - s.w, at(graph, n).y - b.y]); };
const fresh = (prev, next) => { const was = new Set(overlapsOf(prev)); return overlapsOf(next).filter(p => !was.has(p)); };

test('a sub-map folds and unfolds with its whole note stack, also the part below it', () => {
  // The agent: four notes on a block, then its sub-map in one row; the stack is taller than the block, the lower notes are diagonal from it.
  const ids = ['k-n1', 'k-n2', 'k-n3', 'k-n4'];
  let graph = apply(empty(), [block('k', null, 'Parsing'), block('next', null, 'Database'), link('k', 'next'), ...ids.map((id, i) => note(id, 'k', null, `Note ${i + 1}`))]);
  graph = apply(graph, [block('k1', 'k', 'Reads'), block('k2', 'k', 'Splits'), block('k3', 'k', 'Writes'), link('k1', 'k2'), link('k2', 'k3')]);
  const stack = offsets(graph, 'k', ids), k = at(graph, 'k');
  assert.ok(stack.every(([dx]) => dx === 16) && at(graph, 'k-n4').y >= k.y + measure(graph).shown(k).h, 'stack on the right and taller than the block');
  for (const ops of [fold('k'), levelOps(graph, 1)]) {
    const folded = apply(graph, ops);
    assert.deepEqual(offsets(folded, 'k', ids), stack, 'the whole stack at the collapsed card');
    assert.equal(at(folded, 'next').x - at(graph, 'next').x, at(folded, 'k-n1').x - at(graph, 'k-n1').x, 'the neighbour on the right moves with the stack');
    assertApart(folded, 'collapsed');
    assert.deepEqual(geometry(apply(folded, undo(graph, ops))), geometry(graph), 'back');
  }
});

test('notes and blocks under a wide sub-map stay under it when a sub-map inside it unfolds', () => {
  const graph = apply(empty(), [block('k', null, '', { x: 0, y: 0, w: 846, h: 184 }), block('x', 'k', '', { x: 24, y: 24, collapsed: true }), block('xs', 'x', '', { x: 24, y: 24, w: 220, h: 400 }),
    block('y', 'k', '', { x: 600, y: 24 }), note('n', 'k', null, 'Why', { x: 500, y: 200, w: 160, h: 120 }), block('d', null, '', { x: 40, y: 260 }), block('z', null, '', { x: 700, y: 220 }), block('r', null, '', { x: 1000, y: 0 })]);
  const open = apply(graph, fold('x', false)), dh = measure(open).shown(at(open, 'k')).h - 184;
  assert.ok(dh > 300);
  for (const id of ['n', 'd', 'z']) assert.deepEqual([at(open, id).x, at(open, id).y], [at(graph, id).x, at(graph, id).y + dh], `${id} lower by the growth`);
  assertApart(open, 'x expanded');
  assert.deepEqual(geometry(apply(open, fold('x'))), geometry(graph), 'x collapsed back');
  assert.deepEqual(geometry(apply(apply(graph, fold('k')), fold('k', false))), geometry(graph), 'k collapsed and expanded');
});

test('folding an unrelated sub-map moves no note, even one lying on its block', () => {
  // The expanded k has its notes lying on it (that happened when a sub-map grew without pushing apart), the leaf b has a sticker on its corner.
  const graph = apply(empty(), [block('k', null, '', { x: 0, y: 0, w: 690, h: 350 }), block('ki', 'k', '', { x: 420, y: 24 }),
    ...[0, 132, 264].map((y, i) => note(`n${i}`, 'k', null, 'note', { x: 562, y, w: 160, h: 120 })), block('b', null, '', { x: 1000, y: 0 }),
    note('s', 'b', null, 'sticker', { x: 1180, y: -90, w: 160, h: 120 }), block('u', null, '', { x: 0, y: 900 }), block('ui', 'u', '', { x: 24, y: 24 })]);
  assert.ok(overlapsOf(graph).includes('k/n0'));
  const folded = apply(graph, fold('u'));
  assert.deepEqual(geometry(folded).filter(([id]) => id !== 'u'), geometry(graph).filter(([id]) => id !== 'u'));
  assert.deepEqual(geometry(apply(folded, fold('u', false))), geometry(graph));
  // k itself: the notes lying on it do not land on anything new.
  const k = apply(graph, fold('k'));
  assert.deepEqual(fresh(graph, k), []);
  assert.deepEqual(fresh(k, apply(k, fold('k', false))), []);
});

test('a sticker rides the corner of a block that gets a sub-map, and a note dropped on a sub-map stands beside it', () => {
  // "Block inside" on the leaf b with a sticker on its corner: the block gets a 546 × 350 field at once (createInside in public/app.js).
  let graph = apply(empty(), [block('b', null, '', { x: 0, y: 0 }), block('u', null, '', { x: 0, y: 600 }), block('ui', 'u', '', { x: 24, y: 24 }), note('s', 'b', null, 'sticker', { x: 180, y: -90, w: 160, h: 120 })]);
  graph = apply(graph, [block('bi', 'b', '', { x: 24, y: 24 }), { type: 'update-node', id: 'b', patch: { w: 546, h: 350 } }]);
  assert.deepEqual([at(graph, 's').x, at(graph, 's').y], [506, -90], 'sticker on the corner of the grown block');
  for (const id of ['u', 'b']) assert.deepEqual(geometry(apply(apply(graph, fold(id)), fold(id, false))), geometry(graph), id);
  // A note dropped on the header of an expanded sub-map: it gets attached and stands beside it, not on the block's text.
  graph = apply(graph, [note('f', null, null, 'later', { x: 900, y: 0, w: 160, h: 80 })]);
  const dropped = apply(graph, [{ type: 'update-node', id: 'f', patch: { x: 300, y: 10, attachedTo: 'b' } }]);
  assert.deepEqual(fresh(graph, dropped), []);
  assert.equal(at(dropped, 'f').attachedTo, 'b');
  assert.deepEqual(geometry(apply(apply(dropped, fold('b')), fold('b', false))), geometry(dropped), 'collapse and expand');
});

test('a sub-map that grows from an edit pushes its neighbours and keeps its notes beside it', () => {
  // Dragging inside a sub-map: the UI sends the new place and the container's growth (growOps).
  let graph = apply(empty(), [block('k', null, '', { x: 0, y: 0, w: 546, h: 350 }), block('ki', 'k', '', { x: 24, y: 24 }), block('r', null, '', { x: 788, y: 0 }), block('u', null, '', { x: 0, y: 390 }),
    ...[0, 132, 264].map((y, i) => note(`n${i}`, 'k', null, 'note', { x: 562, y, w: 160, h: 120 }))]);
  let next = apply(graph, [{ type: 'update-node', id: 'ki', patch: { x: 420, y: 300 } }, { type: 'update-node', id: 'k', patch: { w: 666, h: 460 } }]);
  assert.deepEqual(fresh(graph, next), []);
  assert.deepEqual(offsets(next, 'k', ['n0', 'n1', 'n2']), offsets(graph, 'k', ['n0', 'n1', 'n2']), 'notes at the edge');
  assert.equal(at(next, 'r').x, at(next, 'n0').x + 160 + GAP.x, 'neighbour on the right past the notes');
  assert.equal(at(next, 'u').y, 460 + GAP.y, 'neighbour below under the sub-map');
  // "Block inside" on an agent's block with notes on the right: the block gets a field at once.
  graph = apply(empty(), [block('a', null, 'Intake'), block('b', null, 'Parsing'), block('c', null, 'Database'), link('a', 'b'), link('b', 'c'), note('b-n1', 'b', null, 'The reason'), note('b-n2', 'b', null, 'Open question')]);
  next = apply(graph, [block('bi', 'b', '', { x: 24, y: 24 }), { type: 'update-node', id: 'b', patch: { w: 546, h: 350 } }]);
  assert.deepEqual(fresh(graph, next), []);
  assert.deepEqual(offsets(next, 'b', ['b-n1', 'b-n2']), offsets(graph, 'b', ['b-n1', 'b-n2']));
  assert.deepEqual(geometry(apply(apply(next, levelOps(next, 1)), levelOps(apply(next, levelOps(next, 1)), 4))), geometry(next), 'levels there and back');
  // A block inside a concept with another one under it: the lower one moves down.
  graph = apply(empty(), [block('p', null, '', { x: 0, y: 0, w: 600, h: 200 }), block('p1', 'p', '', { x: 24, y: 24 }), block('q', null, '', { x: 3, y: 240 })]);
  next = apply(graph, [block('p2', 'p', '', { x: 24, y: 154 }), { type: 'update-node', id: 'p', patch: { h: 314 } }]);
  assert.deepEqual(fresh(graph, next), []);
  assert.deepEqual([at(next, 'q').x, at(next, 'q').y], [3, 314 + GAP.y]);
});

test('one fold next to 1500 overlapping notes or left of a 1990-block row takes well under a second', () => {
  const node = (id, x, y, extra = {}) => ({ id, type: 'block', parentId: null, attachedTo: null, collapsed: false, title: id, text: '', x, y, w: 220, h: 110, color: '', ...extra });
  const base = more => ({ ...empty(), nodes: [node('k', 0, 0), node('k1', 24, 24, { parentId: 'k', h: 400 }), ...more] });
  const pile = Array.from({ length: 1500 }, (_, i) => ({ ...node(`p${i}`, 600 + i % 3, 0), type: 'note', w: 160, h: 120, color: 'yellow' }));
  const row = Array.from({ length: 1990 }, (_, i) => node(`r${i}`, 400 + i * 300, 0));
  for (const [what, graph] of [['pile of notes', base(pile)], ['row of blocks', base(row)]]) {
    const start = performance.now();
    applyOperations(graph, fold('k'));
    assert.ok(performance.now() - start < 1000, `${what}: ${Math.round(performance.now() - start)} ms`);
  }
});

test('a sub-map with a 1990-note stack folds and grows fast, and so does a chevron elsewhere while it is folded', () => {
  // The stack is almost entirely below the block: its continuation used to be collected by a "note × note × list" scan (a cube),
  // both on collapse and when the block grew. The chevron of another sub-map expands and collapses the whole map again, that is,
  // it goes through the stack twice.
  const graph = { ...empty(), nodes: [blockAt('k', { w: 900, h: 600 }), blockAt('ki', { parentId: 'k', x: 24, y: 24, w: 840, h: 500 }), blockAt('j', { x: -2000, w: 400, h: 300 }),
    blockAt('ji', { parentId: 'j', x: 24, y: 24 }), ...Array.from({ length: 1990 }, (_, i) => noteOf(`n${i}`, 'k', { x: 916, y: i * 92, h: 80 }))] };
  const time = run => { const start = performance.now(), result = run(); return [result, Math.round(performance.now() - start)]; };
  const [folded, one] = time(() => apply(graph, fold('k'))), [, other] = time(() => apply(folded, fold('j'))), [, grow] = time(() => apply(graph, [block('step', 'k', 'Step')]));
  assert.ok(one < 500 && other < 500 && grow < 500, `collapse k: ${one} ms, chevron j: ${other} ms, step in k: ${grow} ms`);
  assert.deepEqual([at(folded, 'n0').x, at(folded, 'n1989').x, at(folded, 'n1989').y], [296, 296, 1989 * 92], 'the whole stack at the card');
});

// Random agent builds: nested blocks, notes on new and existing blocks (tall ones too), free notes,
// layout with and without deep, and between builds the person collapses and expands sub-maps. A build adds no
// overlaps, and containers outside the ancestor chains of the new nodes keep their size.
test('random agent builds never add overlaps and leave unrelated containers alone', () => {
  const texts = ['', 'Briefly', 'Reads the map and returns it all', 'x'.repeat(300), 'Step `code`', 'Lengthy comment '.repeat(25)];
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, pick = list => list[Math.floor(rnd() * list.length)];
  for (let run = 1; run <= 40; run++) {
    let graph = empty(), uid = 0;
    seed = run * 7919;
    for (let step = 0; step < 12; step++) {
      const blocks = graph.nodes.filter(n => n.type === 'block'), ops = [], made = [];
      const depth = id => { let d = 0; for (let p = id; p; p = at(graph, p).parentId) d++; return d; };
      if (blocks.length && rnd() < 0.1) ops.push({ type: 'layout', parentId: rnd() < 0.5 ? null : pick(blocks).id, deep: rnd() < 0.5 });
      else {
        const parent = blocks.length && rnd() < 0.7 ? pick(blocks).id : null, level = blocks.filter(b => b.parentId === parent);
        if (depth(parent) >= 6) continue;
        for (let i = 0, count = Math.floor(rnd() * 5); i < count; i++) {
          const id = `b${++uid}`, kids = rnd() < 0.4 ? 1 + Math.floor(rnd() * 3) : 0;
          ops.push(block(id, parent, pick(texts), { collapsed: kids > 0 && rnd() < 0.4 })); made.push(id);
          if (rnd() < 0.3) ops.push(note(`n${++uid}`, id, parent, pick(texts) || 'Note'));
          for (let k = 0; k < kids; k++) ops.push(block(`b${++uid}`, id, pick(texts).slice(0, 100)));
        }
        if (level.length && rnd() < 0.4) ops.push(note(`n${++uid}`, pick(level).id, parent, pick(texts) || 'Note'));
        if (parent && rnd() < 0.3) ops.push(note(`n${++uid}`, parent, at(graph, parent).parentId, pick(texts) || 'Note'));
        if (rnd() < 0.2) ops.push(note(`n${++uid}`, null, parent, 'Free note'));
        const ends = [...level.map(b => b.id), ...made];
        for (let i = 0; i < 3 && ends.length > 1; i++) { const s = pick(ends), t = pick(ends); if (s !== t && ![...graph.edges, ...ops.map(o => o.edge).filter(Boolean)].some(e => e.source === s && e.target === t)) ops.push(link(s, t)); }
        const subs = blocks.filter(b => graph.nodes.some(n => n.parentId === b.id));
        if (subs.length && rnd() < 0.25) { const c = pick(subs); graph = apply(graph, fold(c.id, !c.collapsed)); }
      }
      if (!ops.length) continue;
      const was = new Set(overlapsOf(graph)), next = apply(graph, ops), chain = new Set();
      assert.deepEqual(overlapsOf(next).filter(p => !was.has(p)), [], `run ${run}, step ${step}`);
      for (const o of ops) if (o.node) for (let p = o.node.parentId; p; p = at(next, p).parentId) chain.add(p);
      if (!ops.some(o => o.type === 'layout')) for (const n of graph.nodes) if (!chain.has(n.id) && graph.nodes.some(k => k.parentId === n.id)) assert.deepEqual([at(next, n.id).w, at(next, n.id).h], [n.w, n.h], `run ${run}, step ${step}: ${n.id}`);
      graph = next;
    }
  }
});

// Fold properties on random maps: agent ones (build without coordinates, up to four levels, notes) and hand-made ones
// (random sizes and places without overlaps, blocks may touch, notes on any side of a block). Batches are built the way
// the UI builds them: the level slider, a chevron, diving in, and coming back out is the reverse batch.
const words = ['', 'Briefly', 'Reads the map and returns it all', 'x'.repeat(300), 'Step `code`', 'Lengthy comment '.repeat(12)];
function agentMap(rnd) {
  const int = n => Math.floor(rnd() * n), pick = list => list[int(list.length)], cs = Array.from({ length: 3 + int(5) }, (_, i) => `c${i}`);
  // A block's notes come in a stack of up to three, which can be taller than the block.
  let uid = 0;
  const notes = (id, parent) => rnd() < 0.35 ? Array.from({ length: 1 + int(3) }, () => note(`n${++uid}`, id, parent, pick(words) || 'Note')) : [];
  let graph = apply(empty(), [...cs.map(c => block(c, null, pick(words).slice(0, 120))), ...cs.slice(1).filter(() => rnd() < 0.7).map(c => link(pick(cs.slice(0, cs.indexOf(c))), c)), ...cs.flatMap(c => notes(c, null))]);
  const fill = (parent, depth) => {
    const ids = Array.from({ length: 1 + int(4) }, () => `b${++uid}`);
    graph = apply(graph, ids.flatMap((id, i) => [block(id, parent, pick(words).slice(0, 120), { collapsed: rnd() < 0.2 }), ...(i && rnd() < 0.6 ? [link(ids[int(i)], id)] : []), ...notes(id, parent)]));
    if (depth < 3) for (const id of ids) if (rnd() < 0.45) fill(id, depth + 1);
  };
  for (const c of cs) if (rnd() < 0.85) fill(c, 1);
  return graph;
}
function handMap(rnd) {
  const int = n => Math.floor(rnd() * n), nodes = [];
  let uid = 0;
  const make = (parentId, depth) => {
    for (let i = 0, k = 2 + int(depth ? 4 : 6); i < k; i++) {
      const id = `h${++uid}`, inner = depth < 3 && rnd() < (depth ? 0.4 : 0.6);
      nodes.push({ id, type: 'block', parentId, attachedTo: null, collapsed: inner && rnd() < 0.35, title: id, text: words[int(words.length)].slice(0, 80), x: 0, y: 0, w: 120 + int(260), h: 60 + int(160), color: '' });
      if (inner) make(id, depth + 1);
      for (let j = int(3); j > 0; j--) nodes.push({ id: `h${++uid}`, type: 'note', parentId, attachedTo: id, collapsed: false, title: '', text: 'Note', x: 0, y: 0, w: 160, h: 80 + int(100), color: 'yellow' });
    }
    if (rnd() < 0.3) nodes.push({ id: `h${++uid}`, type: 'note', parentId, attachedTo: null, collapsed: false, title: '', text: 'Free note', x: 0, y: 0, w: 160, h: 80, color: 'yellow' });
  };
  make(null, 0);
  const graph = { ...empty(), nodes }, depth = id => id ? 1 + depth(at(graph, id).parentId) : 0;
  for (const level of [...new Set(nodes.map(n => n.parentId))].sort((a, b) => depth(b) - depth(a))) {
    const { shown } = measure(graph), placed = [], gap = rnd() < 0.5 ? 0 : 20, items = nodes.filter(n => n.parentId === level && !n.attachedTo);
    let side = Math.sqrt(items.reduce((sum, n) => sum + (shown(n).w + 300) * (shown(n).h + 200), 0));
    for (const n of items) {
      const own = nodes.filter(k => k.attachedTo === n.id);
      for (let tries = 1; ; tries++) {
        if (tries % 100 === 0) side *= 1.2;
        n.x = (level ? 24 : 0) + int(side); n.y = (level ? 24 : 0) + 200 + int(side * 0.7);
        const s = shown(n);
        let stack = n.y;
        // Notes: in a stack on the right, below, above (anywhere along the block), on the left.
        for (const k of own) {
          const r = rnd();
          if (r < 0.4) { k.x = n.x + s.w + 16; k.y = stack; stack += k.h + 12; } else if (r < 0.6) { k.x = n.x + int(s.w); k.y = n.y + s.h + 16; } else if (r < 0.8) { k.x = n.x + int(s.w); k.y = n.y - k.h - 16; } else { k.x = n.x - k.w - 16; k.y = n.y + int(s.h); }
        }
        const mine = [n, ...own].map(k => ({ x: k.x, y: k.y, ...shown(k) }));
        if (mine.every((a, i) => placed.every(b => apart(a, b, gap, gap)) && mine.every((b, j) => i === j || apart(a, b)))) { placed.push(...mine); break; }
      }
    }
  }
  return graph;
}
const depthOf = (graph, n) => n.parentId ? 1 + depthOf(graph, at(graph, n.parentId)) : 0;
const isBox = (graph, n) => n.type !== 'note' && graph.nodes.some(k => k.parentId === n.id);
// Like foldOps in public/app.js: only what changes, the deepest sub-maps first.
const foldOps = (graph, list) => list.filter(([n, collapsed]) => n.collapsed !== collapsed).sort(([a], [b]) => depthOf(graph, b) - depthOf(graph, a)).map(([n, collapsed]) => ({ type: 'update-node', id: n.id, patch: { collapsed } }));
const levelOps = (graph, level) => foldOps(graph, graph.nodes.filter(n => isBox(graph, n)).map(n => [n, level < 4 && depthOf(graph, n) >= level - 1]));
const diveOps = (graph, n) => { const up = []; for (let p = n; p; p = p.parentId && at(graph, p.parentId)) up.push(p); return foldOps(graph, [...graph.nodes.filter(k => k.parentId === n.id && isBox(graph, k)).map(k => [k, true]), ...up.filter(p => isBox(graph, p)).map(p => [p, false])]); };
const undo = (graph, ops) => ops.map(op => ({ ...op, patch: { collapsed: at(graph, op.id).collapsed } }));
// The safety net's shifts: the same calculation on a copy.
const guarded = (graph, ops) => reflow(structuredClone(graph), new Map(ops.map(op => [op.id, op.patch.collapsed])));
// A note to the right of its block (the whole stack, including its part below the block) keeps its offset from the block's top right corner.
function besides(graph) {
  const { shown } = measure(graph), out = new Map();
  const right = graph.nodes.filter(k => k.attachedTo && k.x >= at(graph, k.attachedTo).x + shown(at(graph, k.attachedTo)).w), stack = right.filter(k => { const b = at(graph, k.attachedTo); return k.y < b.y + shown(b).h && b.y < k.y + k.h; });
  for (let i = 0; i < stack.length; i++) for (const k of right) if (!stack.includes(k) && k.attachedTo === stack[i].attachedTo && k.x === stack[i].x && Math.abs(k.y - stack[i].y - stack[i].h) <= 40) stack.push(k);
  for (const k of stack) { const b = at(graph, k.attachedTo), s = shown(b); out.set(k.id, [k.x - b.x - s.w, k.y - b.y]); }
  return out;
}

test('fold batches never add overlaps, do not depend on op order, and the map depends only on what is folded', t => {
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, pick = list => list[Math.floor(rnd() * list.length)];
  const stats = { batches: 0, guarded: 0, back: 0, revisits: 0 };
  for (let run = 1; run <= 40; run++) {
    seed = run * 7919;
    let graph = run % 2 ? agentMap(rnd) : handMap(rnd);
    assert.deepEqual(overlapsOf(graph), [], `run ${run}: initial map`);
    // The map's view for each set of collapsed sub-maps: until the safety net steps in, it is the same whatever path leads there.
    const seen = new Map(), flags = g => g.nodes.filter(n => isBox(g, n)).map(n => +n.collapsed).join('');
    const visit = (g, when) => { const key = flags(g); if (seen.has(key)) { assert.deepEqual(geometry(g), seen.get(key), when); stats.revisits++; } else seen.set(key, geometry(g)); };
    visit(graph, `run ${run}`);
    for (let step = 0; step < 25; step++) {
      const boxes = graph.nodes.filter(n => isBox(graph, n)), r = rnd(), box = pick(boxes), when = `run ${run}, step ${step}`;
      if (!boxes.length) break;
      const ops = r < 0.5 ? levelOps(graph, 1 + Math.floor(rnd() * 4)) : r < 0.75 ? foldOps(graph, [[box, !box.collapsed]]) : diveOps(graph, pick(graph.nodes.filter(n => n.type !== 'note')));
      if (!ops.length) continue;
      const was = new Set(overlapsOf(graph)), next = apply(graph, ops), pushes = guarded(graph, ops), near = besides(graph), after = besides(next);
      stats.batches++;
      if (pushes) { stats.guarded++; seen.clear(); }
      assert.deepEqual(overlapsOf(next).filter(p => !was.has(p)), [], `${when}: new overlaps`);
      assert.deepEqual(geometry(apply(graph, [...ops].sort(() => rnd() - 0.5))), geometry(next), `${when}: op order`);
      if (!pushes) for (const [id, offset] of near) if (after.has(id)) assert.deepEqual(after.get(id), offset, `${when}: note ${id} stays at its block`);
      visit(next, when);
      if (rnd() < 0.5) {
        // The reverse batch (coming out of a dive, the previous level): without the safety net, exactly back to the old places.
        const back = undo(graph, ops), again = apply(next, back), more = guarded(next, back);
        stats.batches++;
        if (more) { stats.guarded++; seen.clear(); } else if (!pushes) { assert.deepEqual(geometry(again), geometry(graph), `${when}: there and back`); stats.back++; }
        assert.deepEqual(overlapsOf(again).filter(p => !new Set(overlapsOf(next)).has(p)), [], `${when}: new overlaps on the way back`);
        visit(again, when);
        graph = again;
      } else graph = next;
    }
  }
  t.diagnostic(`batches ${stats.batches}, safety net shifted in ${stats.guarded}, exact there and back ${stats.back}, repeated views matched ${stats.revisits}`);
  assert.ok(stats.back > 100 && stats.revisits > 200, 'enough checks');
});

// Nodes with set places, as the map stores them.
const blockAt = (id, extra = {}) => ({ id, type: 'block', parentId: null, attachedTo: null, collapsed: false, title: id, text: '', x: 0, y: 0, w: 220, h: 110, color: '', ...extra });
const noteOf = (id, attachedTo, extra = {}) => blockAt(id, { type: 'note', attachedTo, w: 160, h: 120, color: 'yellow', ...extra });

test('a block under a sub-map comes back after every fold, past notes under and left of the sub-map', () => {
  // Block b is under sub-map k; k has a note under its left corner (moves with the bottom edge) and a note on the left (stays). The nearest
  // one above b is sometimes one, sometimes the other. The note on the left used to drop out of the pairs with b only on collapse: b rose
  // by 100 px with every chevron, and with the note lower it ran onto it, and the safety net moved the notes away.
  for (const [ly, lh] of [[189, 73], [400, 80]]) {
    let graph = { ...empty(), nodes: [blockAt('k', { w: 1045, h: 635 }), blockAt('ki', { parentId: 'k', x: 24, y: 24, w: 985, h: 515 }),
      noteOf('u', 'k', { x: -93, y: 651, h: 80 }), noteOf('l', 'k', { x: -203, y: ly, h: lh }), blockAt('b', { x: -70, y: 934 })] };
    const start = geometry(graph);
    for (let cycle = 1; cycle <= 3; cycle++) {
      const folded = apply(graph, fold('k')), when = `note on the left at ${ly}, cycle ${cycle}`;
      assert.deepEqual([guarded(graph, fold('k')), guarded(folded, fold('k', false))], [0, 0], `${when}: no safety net needed`);
      assert.deepEqual(fresh(graph, folded), [], when);
      graph = apply(folded, fold('k', false));
      assert.deepEqual(geometry(graph), start, when);
    }
  }
});

test('a fold does not mix up a note under a sub-map with the note stack beside it', () => {
  // Past the edge of the collapsed card and below it, a stack note and a note from under the sub-map can stand side by side. The stack
  // continues only with a note on its line (the same x; for a row under the block, the same y). After a chevron the stack note
  // used to move under the sub-map, and the note from under the sub-map into the stack.
  const k = more => ({ ...empty(), nodes: [blockAt('k', { w: 900, h: 600 }), blockAt('ki', { parentId: 'k', x: 24, y: 24, w: 840, h: 500 }), ...more] });
  const maps = [
    ['k', k([noteOf('r1', 'k', { x: 916, y: 0, h: 80 }), noteOf('r2', 'k', { x: 916, y: 100 }), noteOf('a', 'k', { x: 100, y: 616 })])],
    ['k', k([...[0, 1, 2, 3, 4].map(i => noteOf(`r${i}`, 'k', { x: 916, y: i * 132 })), noteOf('u', 'k', { x: 300, y: 660 })])]
  ];
  // As in the UI: the agent builds a sub-map and two notes on it, the person drops a free note on the left part of the
  // header; it gets attached and stands under the sub-map.
  let ui = apply(empty(), [block('build', null), block('s1', 'build'), block('s2', 'build'), block('s3', 'build'), link('s1', 's2'), link('s2', 's3'),
    note('r1', 'build', null, 'Built off the main branch'), note('r2', 'build', null, 'Signing keys are with the owner'), block('next', null), link('build', 'next')]);
  ui = apply(ui, [note('free', null, null, 'Verify the signature pre-release', { x: 0, y: 420 })]);
  ui = apply(ui, [{ type: 'update-node', id: 'free', patch: { x: 120, y: 0, attachedTo: 'build' } }]);
  assert.ok(at(ui, 'free').y >= measure(ui).shown(at(ui, 'build')).h && at(ui, 'r2').y < at(ui, 'free').y, 'dropped note under the sub-map, the stack above it');
  maps.push(['build', ui]);
  for (const [id, graph] of maps) {
    const folded = apply(graph, fold(id));
    assert.deepEqual([guarded(graph, fold(id)), guarded(folded, fold(id, false))], [0, 0], `${id}: no safety net needed`);
    assert.deepEqual(fresh(graph, folded), [], id);
    assert.deepEqual(geometry(apply(folded, fold(id, false))), geometry(graph), id);
  }
});

// One sub-map with notes on every side (a stack on the right, which may reach below the block and not be on one line, under the block,
// on the left, above, a sticker on the corner, diagonal) and neighbours outside its hull: a chevron there and back. No overlaps
// are added, and without the safety net everything returns exactly to its place.
test('a sub-map with notes on every side folds and unfolds back exactly', t => {
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, int = n => Math.floor(rnd() * n), pick = list => list[int(list.length)];
  let guards = 0;
  for (let run = 1; run <= 400; run++) {
    seed = run * 7919;
    const w = 400 + int(1000), h = 200 + int(700), nodes = [blockAt('k', { w, h, text: rnd() < 0.3 ? 'Text' : '' }), blockAt('ki', { parentId: 'k', x: 24, y: 24, w: w - 60, h: h - 120 })];
    const s = measure({ nodes }).shown(nodes[0]), taken = [{ x: 0, y: 0, ...s }], free = r => taken.every(q => apart(r, q, 1, 1));
    let stack = rnd() < 0.6 ? 0 : int(s.h);
    for (let i = 0, count = 1 + int(7); i < count; i++) {
      const nw = rnd() < 0.7 ? 160 : 240, nh = 72 + int(200), mode = pick(['stack', 'stack', 'below', 'below', 'left', 'above', 'sticker', 'diagonal']);
      for (let tries = 0; tries < 40; tries++) {
        let r;
        if (mode === 'stack') { r = { x: s.w + 16 + (rnd() < 0.2 ? int(60) : 0), y: stack, w: nw, h: nh }; stack += nh + 12; }
        else if (mode === 'below') r = { x: int(s.w + 100) - 100, y: s.h + 16 + (rnd() < 0.5 ? 0 : int(200)), w: nw, h: nh };
        else if (mode === 'left') r = { x: -nw - 16 - int(60), y: int(s.h + 200) - 100, w: nw, h: nh };
        else if (mode === 'above') r = { x: int(s.w), y: -nh - 16 - int(40), w: nw, h: nh };
        else if (mode === 'sticker') r = { x: s.w - 40 - int(60), y: 30 - nh, w: nw, h: nh };
        else r = { x: s.w + 16 + int(200), y: s.h + 16 + int(200), w: nw, h: nh };
        if (mode === 'sticker' || free(r)) { taken.push(r); nodes.push(noteOf(`n${i}`, 'k', r)); break; }
      }
    }
    const x = Math.min(...taken.map(r => r.x)), y = Math.min(...taken.map(r => r.y)), hull = { x, y, w: Math.max(...taken.map(r => r.x + r.w)) - x, h: Math.max(...taken.map(r => r.y + r.h)) - y };
    for (let i = 0, count = int(4); i < count; i++) for (let tries = 0; tries < 40; tries++) {
      const r = { x: hull.x - 400 + int(hull.w + 800), y: hull.y - 300 + int(hull.h + 600), w: 220, h: 110 };
      if (apart(r, hull, 1, 1) && free(r)) { taken.push(r); nodes.push(blockAt(`b${i}`, r)); break; }
    }
    const graph = { ...empty(), nodes }, folded = apply(graph, fold('k')), back = apply(folded, fold('k', false)), when = `run ${run}`;
    assert.deepEqual(fresh(graph, folded), [], `${when}: collapsed`);
    assert.deepEqual(fresh(folded, back), [], `${when}: expanded`);
    if (guarded(graph, fold('k')) || guarded(folded, fold('k', false))) guards++;
    else assert.deepEqual(geometry(back), geometry(graph), `${when}: there and back`);
  }
  t.diagnostic(`safety net shifted in ${guards} of 400`);
});

test('mechanics and technique go left to right, only code steps go top to bottom', () => {
  const chain = (ids, parent) => [...ids.map(id => block(id, parent, 'Step')), ...ids.slice(1).map((id, i) => link(ids[i], id))];
  const graph = apply(empty(), [block('c', null, 'Concept'), ...chain(['m1', 'm2'], 'c'), ...chain(['t1', 't2'], 'm1'), ...chain(['s1', 's2', 's3'], 't1')]);
  const row = ids => ids.slice(1).every((id, i) => at(graph, id).x > at(graph, ids[i]).x + at(graph, ids[i]).w && at(graph, id).y < at(graph, ids[i]).y + at(graph, ids[i]).h);
  const column = ids => ids.slice(1).every((id, i) => at(graph, id).y > at(graph, ids[i]).y + at(graph, ids[i]).h && at(graph, id).x === at(graph, ids[i]).x);
  assert.ok(row(['m1', 'm2']), 'mechanics left to right');
  assert.ok(row(['t1', 't2']), 'technical left to right');
  assert.ok(column(['s1', 's2', 's3']), 'code top to bottom');
  assertApart(graph, 'four levels');
});

test('a container whose content needs more than 2000 px stores its full size', () => {
  const long = 'A long mechanics text that does not fit on a single line and so takes up several. '.repeat(6);
  const graph = apply(empty(), [block('a', null, 'Concept'), block('b', null, 'Neighbour'), link('a', 'b'), ...Array.from({ length: 60 }, (_, i) => block(`m${i}`, 'a', long))]);
  const a = at(graph, 'a'), { shown, content } = measure(graph), need = content(a, 0);
  assert.ok(need.w > 2000 && need.h > 2000, 'the content needs more than 2000 px');
  assert.ok(a.w >= need.w && a.h >= need.h, `stored ${a.w} × ${a.h}, needed ${need.w} × ${need.h}`);
  assert.deepEqual(shown(a), { w: a.w, h: a.h });
  assert.equal(at(graph, 'b').x, a.x + a.w + GAP.x);
  assertApart(graph, 'large sub-map');
});

test('laying out a sub-map fits its block to the content: a hand-stretched block shrinks, neighbours stay', () => {
  const graph = apply(empty(), [block('a', null, 'Concept'), block('b', null, 'Neighbour'), block('m1', 'a', 'Step'), block('m2', 'a', 'Step'), link('m1', 'm2')]);
  const stretched = apply(graph, [{ type: 'update-node', id: 'a', patch: { w: 1800, h: 1500 } }]);
  const tidy = apply(stretched, [{ type: 'layout', parentId: 'a' }]), a = at(tidy, 'a'), need = measure(tidy).content(a, 24);
  assert.deepEqual([a.w, a.h], [need.w, need.h]);
  assert.ok(a.w < 1800 && a.h < 1500);
  assert.deepEqual([at(tidy, 'b').x, at(tidy, 'b').y], [at(stretched, 'b').x, at(stretched, 'b').y]);
  // A block shrunk below its content grows back to it with the same margin.
  const small = apply(apply(graph, [{ type: 'update-node', id: 'a', patch: { w: 120, h: 60 } }]), [{ type: 'layout', parentId: 'a' }]);
  assert.deepEqual([at(small, 'a').w, at(small, 'a').h], [need.w, need.h]);
  assertApart(small, 'refit container');
});

test('a node added and deleted in one batch is not laid out', () => {
  const graph = apply(empty(), [block('a', null)]);
  assert.deepEqual(apply(graph, [block('b', null), { type: 'delete-node', id: 'b' }]).nodes.map(n => n.id), ['a']);
  assert.deepEqual(apply(graph, [block('k', 'a'), { type: 'delete-node', id: 'a' }]).nodes, []);
  assert.deepEqual(apply(graph, [{ type: 'layout', deep: true }, { type: 'delete-node', id: 'a' }]).nodes, []);
});
