import { randomUUID } from 'node:crypto';
import { autoLayout, fitSize, makeSpace, reflow, screenRects, tighten } from './layout.mjs';

export const colors = ['', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
export const types = ['block', 'note'];
// Block mark: plan is logic without finished code (dashed), testing means a check is running right now (the border
// pulses), passed means the code is written and checked (green border), failed means the check did not pass (red). Without
// a mark the block looks as before, for example in a map of code that is already written.
export const statuses = ['plan', 'testing', 'passed', 'failed'];
// Agent proposal: what it adds, changes and proposes to delete until the person accepts or rejects it.
export const proposals = ['add', 'change', 'remove'];
// maxW and maxH leave room for a large expanded sub-map: auto layout must not cut its size (MAX in layout.mjs).
export const limits = { nodes: 2000, edges: 8000, operations: 1000, minW: 120, minH: 60, maxW: 20000, maxH: 20000, coord: 1e6, depth: 8 };
export class Problem extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const demand = (ok, message) => { if (!ok) throw new Problem(message); };
const isText = (v, max = 20000) => typeof v === 'string' && v.length <= max;
const isId = v => isText(v, 100) && /^[a-zA-Z0-9_-]+$/.test(v);
const isCoord = v => Number.isFinite(v) && Math.abs(v) <= limits.coord;
const isSize = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
// Block files are paths from the project root with "/"; a folder ends with "/" ("bot/"). No absolute paths and no "..".
const isPath = v => isText(v, 300) && v.trim() === v && v.length > 0 && !/^([a-zA-Z]:|\/)/.test(v) && !v.split('/').includes('..');
export const cleanFiles = list => [...new Set(list.map(f => typeof f === 'string' ? f.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '') : f))];
const folds = process.platform === 'win32' || process.platform === 'darwin', pathKey = f => folds ? f.toLowerCase() : f;
// Blocks a project file belongs to: the block lists the file itself or the file lies in one of its folders.
export function blocksOfFile(graph, file) {
  const key = pathKey(file);
  return graph.nodes.filter(n => n.files?.some(f => { const k = pathKey(f); return k === key || (k.endsWith('/') && key.startsWith(k)); }));
}

// A node lives on the level parentId (null is the main map, otherwise a container block); coordinates are relative to the level.
// A note can be attached to a block on its own level (attachedTo). A block with nested nodes is a sub-map and can be collapsed.
export function validate(graph) {
  demand(Array.isArray(graph.nodes) && graph.nodes.length <= limits.nodes, `A map can hold up to ${limits.nodes} nodes (blocks and notes).`);
  demand(Array.isArray(graph.edges) && graph.edges.length <= limits.edges, 'Too many links.');
  const ids = new Set();
  for (const n of graph.nodes) {
    demand(n && typeof n === 'object', 'Invalid node.');
    demand(isId(n.id), 'Invalid node id: Latin letters, digits, "_" and "-", up to 100 characters.');
    demand(!ids.has(n.id), `A node with id "${n.id}" already exists.`);
    ids.add(n.id);
    // The error names the node so the agent finds it in its batch right away.
    const which = `"${n.id}"`;
    demand(types.includes(n.type), `Type of node ${which}: block or note.`);
    demand(isText(n.title, 200), `Title of node ${which}: up to 200 characters.`);
    demand(isText(n.text), `Text of node ${which}: up to 20000 characters.`);
    demand(isCoord(n.x) && isCoord(n.y), `Coordinates of node ${which} must be numbers.`);
    demand(isSize(n.w, limits.minW, limits.maxW) && isSize(n.h, limits.minH, limits.maxH), `Size of node ${which}: width ${limits.minW}–${limits.maxW}, height ${limits.minH}–${limits.maxH}.`);
    demand(colors.includes(n.color), `Unknown color of node ${which}.`);
    demand(n.parentId === null || isId(n.parentId), 'Invalid parentId.');
    demand(n.attachedTo === null || (n.type === 'note' && isId(n.attachedTo)), 'Only a note can be attached to a block.');
    demand(typeof n.collapsed === 'boolean', 'The collapsed field must be true or false.');
    demand(n.status === undefined || (n.type === 'block' && statuses.includes(n.status)), `Mark of node ${which}: plan, testing, passed or failed, blocks only.`);
    demand(n.proposed === undefined || proposals.includes(n.proposed), `Invalid proposal flag on node ${which}.`);
    demand(n.files === undefined || (n.type === 'block' && Array.isArray(n.files) && n.files.length > 0 && n.files.length <= 50 && n.files.every(isPath)), `Files of block ${which}: 1 to 50 paths from the project root with "/", without "..", blocks only.`);
    demand(n.test === undefined || (n.type === 'block' && isText(n.test, 1000) && n.test.trim() !== ''), `Test command of block ${which}: up to 1000 characters, blocks only.`);
  }
  demand(graph.proposal === undefined || (graph.proposal && typeof graph.proposal === 'object' && isText(graph.proposal.title, 200)), 'Invalid proposal.');
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  // All level references first: the walk up the ancestor chain below relies on every ancestor existing.
  for (const n of graph.nodes) if (n.parentId !== null) demand(byId.get(n.parentId)?.type === 'block', 'A node\'s parentId must be an existing block.');
  for (const n of graph.nodes) {
    const seen = new Set([n.id]);
    for (let p = n.parentId, depth = 0; p !== null; p = byId.get(p).parentId, depth++) {
      demand(!seen.has(p), 'A block cannot lie inside itself.');
      demand(depth < limits.depth, `Nesting is limited to ${limits.depth} levels.`);
      seen.add(p);
    }
    if (n.attachedTo !== null) {
      const target = byId.get(n.attachedTo);
      demand(target?.type === 'block' && target.parentId === n.parentId, 'A note is attached to an existing block on its own level.');
    }
  }
  const edgeIds = new Set();
  const pairs = new Set();
  for (const e of graph.edges) {
    demand(e && typeof e === 'object', 'Invalid link.');
    demand(isId(e.id), 'Invalid link id.');
    demand(!edgeIds.has(e.id), `A link with id "${e.id}" already exists.`);
    demand(ids.has(e.source) && ids.has(e.target) && e.source !== e.target, 'A link must connect two different existing blocks.');
    demand(byId.get(e.source).type === 'block' && byId.get(e.target).type === 'block', 'Links connect blocks only.');
    demand(isText(e.label, 200), 'A link label is up to 200 characters.');
    demand(e.proposed === undefined || proposals.includes(e.proposed), 'Invalid proposal flag on a link.');
    const pair = `${e.source}:${e.target}`;
    demand(!pairs.has(pair), 'This link already exists.');
    edgeIds.add(e.id); pairs.add(pair);
  }
  return graph;
}

export function makeNode(input = {}) {
  demand(input && typeof input === 'object' && !Array.isArray(input), 'Invalid node.');
  const type = input.type ?? 'block';
  demand(input.status == null || (type === 'block' && statuses.includes(input.status)), 'Block mark: plan, testing, passed or failed.');
  return {
    id: input.id ?? randomUUID(), type, parentId: input.parentId ?? null, attachedTo: type === 'note' ? input.attachedTo ?? null : null,
    collapsed: Boolean(input.collapsed), title: input.title ?? '', text: input.text ?? '',
    x: input.x ?? 0, y: input.y ?? 0, w: input.w ?? (type === 'note' ? 160 : 220), h: input.h ?? (type === 'note' ? 120 : 110),
    color: input.color ?? (type === 'note' ? 'yellow' : ''), ...(input.status ? { status: input.status } : {}),
    ...(Array.isArray(input.files) && input.files.length ? { files: cleanFiles(input.files) } : input.files != null && !Array.isArray(input.files) ? { files: input.files } : {}),
    ...(input.test != null && input.test !== '' ? { test: input.test } : {})
  };
}

// Fills in node fields that appeared later: level, note attachment, collapsing.
export function normalizeNode(n, nodes) {
  n.type ??= 'block';
  n.parentId ??= null;
  n.collapsed = Boolean(n.collapsed);
  if (n.type === 'note') {
    if (n.attachedTo === undefined) { n.attachedTo = n.parentId; n.parentId = n.attachedTo ? nodes.find(x => x.id === n.attachedTo)?.parentId ?? null : null; }
  } else n.attachedTo = null;
  return n;
}

// A short name for history: the title or the first line of the text, cut at a word with an ellipsis.
export function shorten(line, max = 40) {
  if (line.length <= max) return line;
  const cut = line.slice(0, max), space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
export const nodeName = n => n.title.trim() || shorten(n.text.trim().split('\n')[0]) || (n.type === 'note' ? 'empty note' : 'untitled');
const kindName = n => n.type === 'note' ? 'note' : 'block';
export const statusNames = { plan: 'planned, no code yet', testing: 'checking now', passed: 'passed', failed: 'failed', none: 'no mark' };
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A node, everything nested in it and the notes attached to the blocks being deleted.
export function subtree(graph, id) {
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph.nodes) if (!removed.has(n.id) && (removed.has(n.parentId) || removed.has(n.attachedTo))) { removed.add(n.id); changed = true; }
  }
  return removed;
}

// A block does not lie inside itself: a walk up the ancestors in the middle of a batch, before the full check.
function acyclic(graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const n of graph.nodes) for (let p = byId.get(n.parentId), seen = new Set([n.id]); p; p = byId.get(p.parentId)) { demand(!seen.has(p.id), 'A block cannot lie inside itself.'); seen.add(p.id); }
}

// Applies the whole batch to a copy; an error in any operation leaves the original map untouched.
export function applyOperations(original, operations) {
  demand(Array.isArray(operations) && operations.length > 0 && operations.length <= limits.operations, `Pass 1 to ${limits.operations} operations.`);
  const graph = structuredClone(original);
  const changes = [], placed = new Set(), refit = new Set(), created = new Set(), tight = new Set();
  // Consecutive folds (update-node with collapsed only) are collected and move neighbours apart in one calculation,
  // before any other operation and at the end of the batch: the result does not depend on their order. Other edits
  // also go in groups: by the view before the group, sub-maps that grew push neighbours apart, notes dropped on a block
  // go to its side. The ancestor chain is checked in advance: layout over a batch with a cycle would never finish.
  const folds = new Map(), flush = () => { if (folds.size) { acyclic(graph); reflow(graph, folds); } folds.clear(); };
  let before = null, attached = new Set();
  const settleEdits = () => { if (before) { acyclic(graph); makeSpace(graph, before, attached, placed); } before = null; attached = new Set(); };
  for (const op of operations) {
    demand(op && typeof op === 'object', 'Invalid operation.');
    const foldOnly = op.type === 'update-node' && op.patch && typeof op.patch === 'object' && Object.keys(op.patch).length === 1 && typeof op.patch.collapsed === 'boolean';
    if (foldOnly) settleEdits();
    else { flush(); before ??= screenRects(graph, placed); }
    const node = graph.nodes.find(n => n.id === op.id);
    const edge = graph.edges.find(e => e.id === op.id);
    const patchOf = allowed => {
      demand(op.patch && typeof op.patch === 'object' && !Array.isArray(op.patch), 'Pass patch.');
      for (const key of Object.keys(op.patch)) demand(allowed.includes(key), `Field ${key} cannot be changed.`);
      return structuredClone(op.patch);
    };
    switch (op.type) {
      case 'add-node': {
        demand(op.node && typeof op.node === 'object', 'Pass node.');
        const added = makeNode(op.node);
        // The server places a node without x and y itself after the whole batch, and fits a size without w and h to the text.
        if (op.node.x === undefined && op.node.y === undefined) {
          placed.add(added.id);
          const fit = fitSize(added);
          if (op.node.w === undefined) added.w = fit.w;
          if (op.node.h === undefined) added.h = fit.h;
        }
        graph.nodes.push(added); created.add(added.id); changes.push(`${added.type === 'note' ? 'Added note' : 'Added block'} "${nodeName(added)}"`); break;
      }
      case 'update-node': {
        demand(node, 'Node not found.');
        const patch = patchOf(['title', 'text', 'x', 'y', 'w', 'h', 'color', 'parentId', 'attachedTo', 'collapsed', 'status', 'files', 'test']);
        // An empty file list or an empty command removes them.
        if (Array.isArray(patch.files)) patch.files = patch.files.length ? cleanFiles(patch.files) : null;
        if (patch.test === '') patch.test = null;
        demand(!('status' in patch) || patch.status === null || (node.type === 'block' && statuses.includes(patch.status)), 'Block mark: plan, testing, passed, failed or null.');
        if (foldOnly) { folds.set(node.id, patch.collapsed); changes.push(`${patch.collapsed ? 'Collapsed' : 'Expanded'} sub-map "${nodeName(node)}"`); break; }
        // Attached notes move with the block, including to another level, and keep their offset from it.
        if (node.type === 'block') {
          const dx = (patch.x ?? node.x) - node.x, dy = (patch.y ?? node.y) - node.y, level = 'parentId' in patch ? patch.parentId : node.parentId;
          for (const note of graph.nodes) if (note.attachedTo === node.id) { note.x += dx; note.y += dy; note.parentId = level; }
        }
        // A sub-map was collapsed or expanded together with other fields: neighbours move apart or back, and the
        // other fields are computed from the new view.
        if (typeof patch.collapsed === 'boolean' && patch.collapsed !== node.collapsed) { settleEdits(); acyclic(graph); reflow(graph, new Map([[node.id, patch.collapsed]])); before = screenRects(graph, placed); }
        if (patch.attachedTo) attached.add(node.id);
        Object.assign(node, patch);
        for (const k of ['status', 'files', 'test']) if (node[k] === null) delete node[k];
        const keys = Object.keys(patch), what = kindName(node), only = (...allowed) => keys.length > 0 && keys.every(k => allowed.includes(k));
        if (only('collapsed')) changes.push(`${node.collapsed ? 'Collapsed' : 'Expanded'} sub-map "${nodeName(node)}"`);
        else if (only('status')) changes.push(`Marked block "${nodeName(node)}": ${statusNames[node.status ?? 'none']}`);
        else if (only('files', 'test')) changes.push(`Updated files and test command of block "${nodeName(node)}"`);
        else if (only('x', 'y')) changes.push(`Moved ${what} "${nodeName(node)}"`);
        else if (only('w', 'h')) changes.push(`Changed size of ${what} "${nodeName(node)}"`);
        // The interface attaches a note together with its new position: a drop onto a block.
        else if (keys.includes('attachedTo') && only('attachedTo', 'x', 'y')) changes.push(`${patch.attachedTo ? 'Attached' : 'Detached'} note "${nodeName(node)}"`);
        else if (keys.includes('parentId')) changes.push(`Moved ${what} "${nodeName(node)}" to another level`);
        else changes.push(`Changed ${what} "${nodeName(node)}"`);
        break;
      }
      case 'delete-node': {
        demand(node, 'Node not found.');
        const removed = subtree(graph, op.id), byId = new Map(graph.nodes.map(n => [n.id, n]));
        // Nested means lying inside the block; the rest of what is deleted is notes attached to it from outside. A cycle
        // in the ancestor chain (the batch is not checked yet) stops the walk, and the final check rejects the batch itself.
        const within = n => { for (let p = n.parentId, seen = new Set(); p && !seen.has(p); p = byId.get(p)?.parentId) { if (p === op.id) return true; seen.add(p); } return false; };
        const inner = graph.nodes.filter(n => removed.has(n.id) && within(n)).length, attached = removed.size - 1 - inner;
        const extra = [inner && count(inner, 'nested node'), attached && count(attached, 'note')].filter(Boolean).join(', ');
        graph.nodes = graph.nodes.filter(n => !removed.has(n.id));
        graph.edges = graph.edges.filter(e => !removed.has(e.source) && !removed.has(e.target));
        // What was deleted in the same batch is no longer placed.
        for (const id of removed) { placed.delete(id); refit.delete(id); }
        changes.push(`${node.type === 'note' ? 'Deleted note' : 'Deleted block'} "${nodeName(node)}"${extra ? ` (${extra})` : ''}`); break;
      }
      case 'add-edge': {
        demand(op.edge && typeof op.edge === 'object', 'Pass edge.');
        graph.edges.push({ id: op.edge.id ?? randomUUID(), source: op.edge.source, target: op.edge.target, label: op.edge.label ?? '' });
        const end = id => { const x = graph.nodes.find(k => k.id === id); return x ? `"${nodeName(x)}"` : `"${id}"`; };
        changes.push(`Added link ${end(op.edge.source)} → ${end(op.edge.target)}`); break;
      }
      case 'update-edge': {
        demand(edge, 'Link not found.');
        const patch = patchOf(['label', 'source', 'target']);
        const reversed = patch.source === edge.target && patch.target === edge.source && Object.keys(patch).length === 2;
        Object.assign(edge, patch);
        const end = id => { const x = graph.nodes.find(k => k.id === id); return x ? `"${nodeName(x)}"` : `"${id}"`; }, which = `${end(edge.source)} → ${end(edge.target)}`;
        changes.push(reversed ? `Reversed link: ${which}` : 'label' in patch && Object.keys(patch).length === 1 ? `Changed label of link ${which}: "${edge.label}"` : `Changed link: ${which}`); break;
      }
      case 'layout': {
        // Lays out the level again (parentId: null is the main map, otherwise a block's sub-map), with deep also everything
        // inside its sub-maps; the sub-maps and the block of the arranged sub-map are fitted to the new content. Manual
        // placement of these nodes is lost.
        const level = op.parentId ?? null, container = level === null ? null : graph.nodes.find(n => n.id === level);
        demand(level === null || container?.type === 'block', 'Only the main map or a block\'s sub-map can be arranged.');
        const ids = new Set(graph.nodes.filter(n => n.parentId === level).map(n => n.id));
        if (op.deep) for (let changed = true; changed; ) { changed = false; for (const n of graph.nodes) if (!ids.has(n.id) && ids.has(n.parentId)) { ids.add(n.id); changed = true; } }
        for (const id of ids) {
          placed.add(id);
          if (op.deep && graph.nodes.some(n => n.parentId === id)) refit.add(id);
        }
        if (level !== null) tight.add(level);
        changes.push(level === null ? `Arranged the map${op.deep ? ' with its sub-maps' : ''}` : `Arranged sub-map "${nodeName(container)}"`); break;
      }
      case 'delete-edge': {
        demand(edge, 'Link not found.');
        graph.edges = graph.edges.filter(e => e.id !== op.id); changes.push('Deleted link'); break;
      }
      default: throw new Problem(`Unknown operation: ${op.type}`);
    }
  }
  flush();
  validate(graph);
  settleEdits();
  autoLayout(graph, placed, refit, created);
  for (const id of tight) tighten(graph, id);
  validate(graph);
  return { graph, changes };
}

// Agent proposal. The operations are applied to the map at once so the person sees and edits the proposal in place, but
// what is added is marked proposed: 'add' (a new block without a mark becomes a plan right away, dashed), what changes in
// content is marked 'change' with the previous content in graph.proposal, and a deletion is only marked ('remove').
// Deleting something that is proposed to be added deletes it at once. Later proposals extend the open one.
const contentFields = ['parentId', 'attachedTo', 'title', 'text', 'color', 'status'];
const edgeContent = ['source', 'target', 'label'];
export function propose(original, operations, { title, by, at }) {
  demand(Array.isArray(operations) && operations.length > 0 && operations.length <= limits.operations, `Pass 1 to ${limits.operations} operations.`);
  demand(original.proposal || (typeof title === 'string' && title.trim() && title.length <= 200), 'Name the proposal (title, up to 200 characters).');
  const marks = [], real = [];
  for (const op of operations) {
    const list = op?.type === 'delete-node' ? original.nodes : op?.type === 'delete-edge' ? original.edges : null, item = list?.find(x => x.id === op.id);
    (item && item.proposed !== 'add' ? marks : real).push(op);
  }
  let { graph, changes } = real.length ? applyOperations(original, real) : { graph: structuredClone(original), changes: [] };
  // What is proposed must be visible: collapsed sub-maps it lies in (and new sub-maps with it inside) are expanded
  // by the same batch.
  const old = new Map(original.nodes.map(n => [n.id, n])), byId = new Map(graph.nodes.map(n => [n.id, n]));
  const touched = graph.nodes.filter(n => !old.has(n.id) || contentFields.some(k => old.get(n.id)[k] !== n[k]) || marks.some(op => op.type === 'delete-node' && op.id === n.id));
  const unfold = new Set();
  for (const n of touched) for (let p = byId.get(n.parentId); p; p = byId.get(p.parentId)) if (p.collapsed) unfold.add(p.id);
  if (unfold.size) graph = applyOperations(graph, [...unfold].map(id => ({ type: 'update-node', id, patch: { collapsed: false } }))).graph;
  const proposal = graph.proposal ?? { title: title.trim(), by, at, nodes: {}, edges: {} };
  if (title?.trim()) proposal.title = title.trim();
  // A changed node's position is remembered too: if the proposal moved it to another sub-map, rejecting puts it back.
  const mark = (prev, next, fields, snaps) => {
    const old = new Map(prev.map(x => [x.id, x]));
    for (const x of next) {
      const o = old.get(x.id);
      if (!o) { x.proposed = 'add'; if (x.type === 'block' && !x.status) x.status = 'plan'; }
      else if (!x.proposed && fields.some(k => o[k] !== x[k])) { x.proposed = 'change'; snaps[x.id] = Object.fromEntries([...fields, ...('x' in o ? ['x', 'y'] : [])].filter(k => k in o).map(k => [k, o[k]])); }
    }
  };
  mark(original.nodes, graph.nodes, contentFields, proposal.nodes);
  mark(original.edges, graph.edges, edgeContent, proposal.edges);
  const end = id => { const x = graph.nodes.find(k => k.id === id); return x ? `"${nodeName(x)}"` : `"${id}"`; };
  for (const op of marks) {
    const item = (op.type === 'delete-node' ? graph.nodes : graph.edges).find(x => x.id === op.id);
    demand(item, op.type === 'delete-node' ? 'Node not found.' : 'Link not found.');
    item.proposed = 'remove';
    changes.push(op.type === 'delete-node' ? `Proposed to delete ${kindName(item)} "${nodeName(item)}"` : `Proposed to delete link ${end(item.source)} → ${end(item.target)}`);
  }
  graph.proposal = proposal;
  validate(graph);
  return { graph, changes };
}
// Nodes and links without proposal marks; removed is what to take away together with everything nested and attached.
function settleProposal(graph, removedNodes, removedEdges) {
  const gone = new Set(), byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const id of removedNodes) if (byId.has(id)) for (const k of subtree(graph, id)) gone.add(k);
  graph.nodes = graph.nodes.filter(n => !gone.has(n.id));
  graph.edges = graph.edges.filter(e => !gone.has(e.source) && !gone.has(e.target) && !removedEdges.has(e.id));
  for (const x of [...graph.nodes, ...graph.edges]) delete x.proposed;
  delete graph.proposal;
  return gone;
}
// The person accepted the proposal: what is marked for deletion is deleted, the rest stays as is, new blocks as plans.
export function acceptProposal(original) {
  demand(original.proposal, 'There is no open proposal.');
  const graph = structuredClone(original), title = graph.proposal.title;
  const gone = settleProposal(graph, graph.nodes.filter(n => n.proposed === 'remove').map(n => n.id), new Set(graph.edges.filter(e => e.proposed === 'remove').map(e => e.id)));
  validate(graph);
  return { graph, changes: [gone.size ? `Deleted as proposed: ${count(gone.size, 'node')}` : `Accepted proposal "${title}"`] };
}
// The person rejected the proposal: what was added is deleted, deletion marks are removed, what changed gets its previous
// content back through ordinary edits (attached notes follow the block, a block moved back returns to its previous
// place). If the previous level or the note's block has been deleted, only the texts, color and mark come back.
export function rejectProposal(original) {
  demand(original.proposal, 'There is no open proposal.');
  let graph = structuredClone(original);
  const { title, nodes: snaps, edges: edgeSnaps } = graph.proposal, byId = new Map(graph.nodes.map(n => [n.id, n])), added = n => n?.proposed === 'add';
  // First everything goes back in place while the proposed blocks still exist: what changed, by the snapshot of its
  // previous content (including what was later marked for deletion), and a block without a snapshot that lies inside the
  // proposed ones (the person put it there) goes where the root of the proposed ones stands, so it is not lost with them.
  const rescue = graph.nodes.filter(n => !added(n) && !snaps[n.id] && added(byId.get(n.parentId)) && !(n.type === 'note' && n.attachedTo)).map(n => {
    let root = byId.get(n.parentId);
    while (added(byId.get(root.parentId))) root = byId.get(root.parentId);
    return { type: 'update-node', id: n.id, patch: { parentId: root.parentId, x: root.x, y: root.y } };
  });
  const restore = keys => [
    ...graph.nodes.filter(n => !added(n) && snaps[n.id]).map(n => {
      const snap = snaps[n.id], moved = keys.includes('parentId') && snap.parentId !== n.parentId;
      const patch = Object.fromEntries(keys.filter(k => snap[k] !== n[k]).map(k => [k, snap[k] ?? null]));
      if (moved) Object.assign(patch, { x: snap.x, y: snap.y });
      return { type: 'update-node', id: n.id, patch };
    }),
    ...(keys.includes('parentId') ? graph.edges.filter(e => !added(e) && edgeSnaps[e.id]).map(e => ({ type: 'update-edge', id: e.id, patch: Object.fromEntries(edgeContent.filter(k => edgeSnaps[e.id][k] !== e[k]).map(k => [k, edgeSnaps[e.id][k]])) })) : [])
  ].filter(op => Object.keys(op.patch).length);
  // The previous level or the note's block may have been deleted: then only the texts, color and mark come back.
  for (const keys of [['parentId', 'attachedTo', 'title', 'text', 'color', 'status'], ['title', 'text', 'color', 'status']]) {
    const ops = [...rescue, ...restore(keys)];
    if (!ops.length) break;
    try { graph = applyOperations(graph, ops).graph; break; }
    catch (e) { if (!(e instanceof Problem) || keys.length === 4) throw e; }
  }
  settleProposal(graph, graph.nodes.filter(added).map(n => n.id), new Set(graph.edges.filter(added).map(e => e.id)));
  validate(graph);
  return { graph, changes: [`Rejected proposal "${title}"`] };
}

const nodeFields = ['type', 'parentId', 'attachedTo', 'collapsed', 'title', 'text', 'x', 'y', 'w', 'h', 'color', 'status', 'proposed', 'files', 'test'];
const edgeFields = ['source', 'target', 'label', 'proposed'];
// Lists (block files) are compared by content: after structuredClone this is always a different array.
const same = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]));
// What changed between two states of the map. Stored in history with every revision so an agent can learn what was
// changed after its last read: ids of what was added, what changed with field names, a short description of what was deleted.
export function diffGraphs(before, after) {
  const part = (prev, next, fields, describe) => {
    const old = new Map(prev.map(x => [x.id, x])), now = new Set(next.map(x => x.id));
    const updated = {};
    for (const x of next) {
      const o = old.get(x.id); if (!o) continue;
      const changed = fields.filter(k => !same(o[k], x[k]));
      if (changed.length) updated[x.id] = changed;
    }
    return { added: next.filter(x => !old.has(x.id)).map(x => x.id), updated, removed: prev.filter(x => !now.has(x.id)).map(describe) };
  };
  return {
    nodes: part(before.nodes, after.nodes, nodeFields, n => ({ id: n.id, type: n.type, name: nodeName(n), parentId: n.parentId })),
    edges: part(before.edges, after.edges, edgeFields, e => ({ id: e.id, source: e.source, target: e.target, label: e.label }))
  };
}

// A content edit: something was added or deleted, a link changed, or a node changed something other than its position,
// size or collapsing. Moving to another sub-map and attaching a note change the structure and count too.
const layoutFields = ['x', 'y', 'w', 'h', 'collapsed'];
export const touchesContent = ({ nodes, edges }) => Boolean(nodes.added.length || nodes.removed.length || edges.added.length || edges.removed.length || Object.keys(edges.updated).length
  || Object.values(nodes.updated).some(fields => fields.some(f => !layoutFields.includes(f))));

// Review by map: what changed in how the project is built over the history entries, grouped by concept (blocks of the
// main map), in plain words, for a person who does not read code diffs. Position, size and collapsing do not count, notes are counted.
const reviewFields = { title: 'title', text: 'text', color: 'color', parentId: 'moved', attachedTo: 'attachment', files: 'files', test: 'test command' };
export function review(graph, entries) {
  const done = entries.filter(h => h.delta), { nodes, edges } = collectChanges(graph, done), byId = new Map(graph.nodes.map(n => [n.id, n]));
  const rootOf = id => { let n = byId.get(id); while (n?.parentId && byId.has(n.parentId)) n = byId.get(n.parentId); return n ?? null; };
  const groups = new Map(), q = n => `"${nodeName(n)}"`;
  const add = (root, line) => {
    const key = root?.id ?? '';
    if (!groups.has(key)) groups.set(key, { id: root?.id ?? null, title: root ? nodeName(root) : 'Deleted', items: [], notes: 0 });
    if (line) groups.get(key).items.push(line); else groups.get(key).notes++;
  };
  const passed = [], failed = [];
  const marked = n => { if (n.status === 'passed') passed.push(q(n)); if (n.status === 'failed') failed.push(q(n)); };
  for (const n of nodes.added) {
    if (n.type === 'note') { add(rootOf(n.id), null); continue; }
    add(rootOf(n.id), n.parentId ? `added block ${q(n)}${n.status === 'plan' ? ' (planned, no code yet)' : ''}` : 'new concept');
    marked(n);
  }
  for (const n of nodes.updated) {
    const fields = n.fields.filter(f => !layoutFields.includes(f) && f !== 'proposed' && f !== 'type');
    if (!fields.length) continue;
    const what = [...new Set(fields.map(f => f === 'status' ? statusNames[n.status ?? 'none'] : reviewFields[f] ?? f))].join(', ');
    add(rootOf(n.id), `${n.type === 'note' ? 'changed note' : 'changed block'} ${q(n)}: ${what}`);
    if (fields.includes('status')) marked(n);
  }
  for (const r of nodes.removed) add(byId.has(r.parentId) ? rootOf(r.parentId) : null, `${r.type === 'note' ? 'deleted note' : 'deleted block'} "${r.name}"`);
  const end = id => byId.has(id) ? q(byId.get(id)) : `(${id})`;
  for (const e of edges.added) add(rootOf(e.source), `link ${end(e.source)} → ${end(e.target)}${e.label ? `: ${e.label}` : ''}`);
  for (const e of edges.updated) add(rootOf(e.source), `changed link ${end(e.source)} → ${end(e.target)}`);
  for (const e of edges.removed) add(byId.has(e.source) ? rootOf(e.source) : null, `removed link ${end(e.source)} → ${end(e.target)}`);
  const list = [...groups.values()].map(g => ({ ...g, items: g.notes ? [...g.items, `${count(g.notes, 'note')} added`] : g.items }))
    .sort((a, b) => (a.id === null) - (b.id === null) || a.title.localeCompare(b.title, 'en'));
  const human = done.filter(h => h.actor === 'human').length, agents = [...new Set(done.filter(h => h.actor !== 'human' && h.actor !== 'system').map(h => h.actor))];
  return { since: done[0] ? done[0].revision - 1 : graph.revision, revision: graph.revision, entries: done.length, human, agents, from: done[0]?.at ?? null, groups: list, passed, failed };
}
export function reviewText(r) {
  if (!r.groups.length) return `No changes in how the project is built (revision ${r.revision}).`;
  const who = [r.human && `the person: ${r.human}`, r.agents.length && `agents: ${r.agents.join(', ')}`].filter(Boolean).join('; ');
  return [`What changed from revision ${r.since} to ${r.revision}${r.from ? ` (since ${new Date(r.from).toLocaleString('en-GB')})` : ''}: ${count(r.entries, 'entry', 'entries')}${who ? `, ${who}` : ''}.`,
    ...r.groups.flatMap(g => ['', `"${g.title}"`, ...g.items.map(i => `- ${i}`)]),
    ...(r.passed.length || r.failed.length ? ['', [r.passed.length && `Passed: ${r.passed.join(', ')}.`, r.failed.length && `Failed: ${r.failed.join(', ')}.`].filter(Boolean).join(' ')] : [])].join('\n');
}

// A summary of changes over history entries: added and changed nodes and links in full in their current form, for
// changed ones the fields that changed, deleted ones briefly. What was added and then deleted is left out of the summary.
export function collectChanges(graph, entries) {
  const merge = (kind, current) => {
    const state = new Map();
    for (const h of entries) {
      const d = h.delta[kind];
      for (const id of d.added) state.set(id, { added: true });
      for (const [id, fields] of Object.entries(d.updated)) {
        const s = state.get(id);
        if (s?.added) continue;
        state.set(id, { fields: new Set([...(s?.fields ?? []), ...fields]) });
      }
      for (const r of d.removed) { if (state.get(r.id)?.added) state.delete(r.id); else state.set(r.id, { removed: r }); }
    }
    const result = { added: [], updated: [], removed: [] };
    for (const [id, s] of state) {
      const item = current.find(x => x.id === id);
      if (s.removed) result.removed.push(s.removed);
      else if (!item) continue;
      else if (s.added) result.added.push(item);
      else result.updated.push({ ...item, fields: [...s.fields] });
    }
    return result;
  };
  return { nodes: merge('nodes', graph.nodes), edges: merge('edges', graph.edges) };
}
