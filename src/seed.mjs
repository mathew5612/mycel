import { makeNode } from './model.mjs';
export function seed(projectName, demo = false) {
  const node = (id, title, text, x, y, color = '', w = 220, h = 110) => makeNode({ id, title, text, x, y, w, h, color });
  const note = (id, attachedTo, text, x, y, parentId = null) => makeNode({ id, type: 'note', attachedTo, parentId, text, x, y });
  const inner = (id, parentId, title, text, x, y, w = 200, h = 90) => makeNode({ id, parentId, title, text, x, y, w, h });
  const nodes = demo ? [
    node('mycel', 'Mycel', 'Свободная карта продукта: блоки, заметки и связи между ними.', 0, 40, 'blue', 240, 100),
    node('blocks', 'Блоки', 'Правый клик по пустому месту создаёт блок или заметку. Двигайте блок и растягивайте за правый нижний угол.', 380, -150, '', 220, 140),
    node('links', 'Связи', 'Потяните кружок на краю блока к другому блоку. У связи может быть подпись.', 380, 30, '', 220, 120),
    node('history', 'История', 'Каждое изменение записано: кто, когда и что.', 380, 190, '', 220, 120),
    note('note-1', 'blocks', 'Правый клик по блоку — заметка к нему. Она переезжает вместе с блоком.', 560, -235),
    node('checkout', 'Подкарта', 'Правый клик по блоку — «Блок внутри». Блоки перетаскиваются в подкарту и обратно, шеврон сворачивает её.', 0, 360, 'green', 580, 280),
    inner('cart', 'checkout', 'Корзина', 'Вложенный блок', 24, 24),
    inner('payment', 'checkout', 'Оплата', 'Вложенный блок', 304, 24)
  ] : [node('start', projectName, '', 0, 0, 'blue')];
  const edges = demo ? [['mycel', 'blocks', ''], ['mycel', 'links', ''], ['mycel', 'history', ''], ['cart', 'payment', 'сумма']].map(([source, target, label], i) => ({ id: `edge-${i}`, source, target, label })) : [];
  return { schemaVersion: 3, revision: 0, updatedAt: new Date().toISOString(), nodes, edges, history: [] };
}
// Карта нового проекта в хабе — пустая: агент строит её с нуля, человек видит, как она растёт.
seed.empty = at => ({ schemaVersion: 3, revision: 0, updatedAt: at, nodes: [], edges: [], history: [] });
