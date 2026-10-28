import { makeNode } from './model.mjs';
export function seed(projectName, demo = false) {
  const node = (id, title, text, x, y, color = '', w = 220, h = 110) => makeNode({ id, title, text, x, y, w, h, color });
  const note = (id, attachedTo, text, x, y, parentId = null) => makeNode({ id, type: 'note', attachedTo, parentId, text, x, y });
  const inner = (id, parentId, title, text, x, y, w = 200, h = 90) => makeNode({ id, parentId, title, text, x, y, w, h });
  const nodes = demo ? [
    node('mycel', 'Mycel', 'A free-form product map: blocks, notes and the links between them.', 0, 40, 'blue', 240, 100),
    node('blocks', 'Blocks', 'Right-click an empty spot to create a block or a note. Drag a block to move it and its bottom-right corner to resize it.', 380, -150, '', 220, 140),
    node('links', 'Links', 'Drag the circle on a block edge to another block. A link can have a label.', 380, 30, '', 220, 120),
    node('history', 'History', 'Every change is recorded: who, when and what.', 380, 190, '', 220, 120),
    note('note-1', 'blocks', 'Right-click a block to add a note to it. The note moves with the block.', 560, -235),
    node('checkout', 'Sub-map', 'Right-click a block and choose "Block inside". Blocks can be dragged into the sub-map and back; the chevron collapses it.', 0, 360, 'green', 580, 280),
    inner('cart', 'checkout', 'Cart', 'Nested block', 24, 24),
    inner('payment', 'checkout', 'Payment', 'Nested block', 304, 24)
  ] : [node('start', projectName, '', 0, 0, 'blue')];
  const edges = demo ? [['mycel', 'blocks', ''], ['mycel', 'links', ''], ['mycel', 'history', ''], ['cart', 'payment', 'total']].map(([source, target, label], i) => ({ id: `edge-${i}`, source, target, label })) : [];
  return { schemaVersion: 3, revision: 0, updatedAt: new Date().toISOString(), nodes, edges, history: [] };
}
// A new project's map in the hub is empty: the agent builds it from scratch and the person watches it grow.
seed.empty = at => ({ schemaVersion: 3, revision: 0, updatedAt: at, nodes: [], edges: [], history: [] });
