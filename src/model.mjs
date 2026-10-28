import { randomUUID } from 'node:crypto';
import { autoLayout, fitSize, makeSpace, reflow, screenRects, tighten } from './layout.mjs';

export const colors = ['', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
export const types = ['block', 'note'];
// Отметка блока: plan — логика без готового кода (пунктир), testing — проверка идёт прямо сейчас (рамка пульсирует),
// passed — код написан и проверен (зелёная рамка), failed — проверка не прошла (красная). Без отметки — блок как
// раньше, например карта уже написанного кода.
export const statuses = ['plan', 'testing', 'passed', 'failed'];
// Предложение агента: что оно добавляет, меняет и предлагает удалить, пока человек его не принял или не отклонил.
export const proposals = ['add', 'change', 'remove'];
// maxW и maxH — с запасом под большую развёрнутую подкарту: авторасстановка не должна обрезать её размер (MAX в layout.mjs).
export const limits = { nodes: 2000, edges: 8000, operations: 1000, minW: 120, minH: 60, maxW: 20000, maxH: 20000, coord: 1e6, depth: 8 };
export class Problem extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const demand = (ok, message) => { if (!ok) throw new Problem(message); };
const isText = (v, max = 20000) => typeof v === 'string' && v.length <= max;
const isId = v => isText(v, 100) && /^[a-zA-Z0-9_-]+$/.test(v);
const isCoord = v => Number.isFinite(v) && Math.abs(v) <= limits.coord;
const isSize = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
// Файлы блока — пути от корня проекта через «/», папка — с «/» в конце («bot/»). Без абсолютных путей и «..».
const isPath = v => isText(v, 300) && v.trim() === v && v.length > 0 && !/^([a-zA-Z]:|\/)/.test(v) && !v.split('/').includes('..');
export const cleanFiles = list => [...new Set(list.map(f => typeof f === 'string' ? f.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '') : f))];
const folds = process.platform === 'win32' || process.platform === 'darwin', pathKey = f => folds ? f.toLowerCase() : f;
// Блоки, к которым относится файл проекта: он указан у блока сам или лежит в его папке.
export function blocksOfFile(graph, file) {
  const key = pathKey(file);
  return graph.nodes.filter(n => n.files?.some(f => { const k = pathKey(f); return k === key || (k.endsWith('/') && key.startsWith(k)); }));
}

// Узел живёт на уровне parentId (null — основная карта, иначе блок-контейнер); координаты относительны уровню.
// Заметка может быть прикреплена к блоку своего уровня (attachedTo). Блок с вложенными узлами — подкарта, её можно свернуть.
export function validate(graph) {
  demand(Array.isArray(graph.nodes) && graph.nodes.length <= limits.nodes, `Карта может содержать до ${limits.nodes} узлов (блоков и заметок).`);
  demand(Array.isArray(graph.edges) && graph.edges.length <= limits.edges, 'Слишком много связей.');
  const ids = new Set();
  for (const n of graph.nodes) {
    demand(n && typeof n === 'object', 'Некорректный узел.');
    demand(isId(n.id), 'Некорректный id узла: латиница, цифры, «_» и «-», до 100 символов.');
    demand(!ids.has(n.id), `Узел с id «${n.id}» уже есть.`);
    ids.add(n.id);
    // Ошибка называет узел, чтобы агент сразу нашёл его в своём пакете.
    const which = `«${n.id}»`;
    demand(types.includes(n.type), `Тип узла ${which}: block или note.`);
    demand(isText(n.title, 200), `Название узла ${which} — до 200 символов.`);
    demand(isText(n.text), `Текст узла ${which} — до 20000 символов.`);
    demand(isCoord(n.x) && isCoord(n.y), `Координаты узла ${which} должны быть числами.`);
    demand(isSize(n.w, limits.minW, limits.maxW) && isSize(n.h, limits.minH, limits.maxH), `Размер узла ${which}: ширина ${limits.minW}–${limits.maxW}, высота ${limits.minH}–${limits.maxH}.`);
    demand(colors.includes(n.color), `Неизвестный цвет узла ${which}.`);
    demand(n.parentId === null || isId(n.parentId), 'Некорректный parentId.');
    demand(n.attachedTo === null || (n.type === 'note' && isId(n.attachedTo)), 'Прикрепить к блоку можно только заметку.');
    demand(typeof n.collapsed === 'boolean', 'Поле collapsed должно быть true или false.');
    demand(n.status === undefined || (n.type === 'block' && statuses.includes(n.status)), `Отметка узла ${which}: plan, testing, passed или failed, и только у блока.`);
    demand(n.proposed === undefined || proposals.includes(n.proposed), `Некорректная пометка предложения у узла ${which}.`);
    demand(n.files === undefined || (n.type === 'block' && Array.isArray(n.files) && n.files.length > 0 && n.files.length <= 50 && n.files.every(isPath)), `Файлы блока ${which}: от 1 до 50 путей от корня проекта через «/», без «..», и только у блока.`);
    demand(n.test === undefined || (n.type === 'block' && isText(n.test, 1000) && n.test.trim() !== ''), `Проверка блока ${which} — команда до 1000 символов, и только у блока.`);
  }
  demand(graph.proposal === undefined || (graph.proposal && typeof graph.proposal === 'object' && isText(graph.proposal.title, 200)), 'Некорректное предложение.');
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  // Сначала все ссылки на уровень: обход цепочки предков ниже рассчитывает, что каждый предок существует.
  for (const n of graph.nodes) if (n.parentId !== null) demand(byId.get(n.parentId)?.type === 'block', 'Уровень узла должен быть существующим блоком.');
  for (const n of graph.nodes) {
    const seen = new Set([n.id]);
    for (let p = n.parentId, depth = 0; p !== null; p = byId.get(p).parentId, depth++) {
      demand(!seen.has(p), 'Блок не может лежать внутри самого себя.');
      demand(depth < limits.depth, `Вложенность не глубже ${limits.depth} уровней.`);
      seen.add(p);
    }
    if (n.attachedTo !== null) {
      const target = byId.get(n.attachedTo);
      demand(target?.type === 'block' && target.parentId === n.parentId, 'Заметка прикрепляется к существующему блоку своего уровня.');
    }
  }
  const edgeIds = new Set();
  const pairs = new Set();
  for (const e of graph.edges) {
    demand(e && typeof e === 'object', 'Некорректная связь.');
    demand(isId(e.id), 'Некорректный id связи.');
    demand(!edgeIds.has(e.id), `Связь с id «${e.id}» уже есть.`);
    demand(ids.has(e.source) && ids.has(e.target) && e.source !== e.target, 'Связь должна соединять два разных существующих блока.');
    demand(byId.get(e.source).type === 'block' && byId.get(e.target).type === 'block', 'Связи соединяют только блоки.');
    demand(isText(e.label, 200), 'Подпись связи — до 200 символов.');
    demand(e.proposed === undefined || proposals.includes(e.proposed), 'Некорректная пометка предложения у связи.');
    const pair = `${e.source}:${e.target}`;
    demand(!pairs.has(pair), 'Такая связь уже есть.');
    edgeIds.add(e.id); pairs.add(pair);
  }
  return graph;
}

export function makeNode(input = {}) {
  demand(input && typeof input === 'object' && !Array.isArray(input), 'Некорректный узел.');
  const type = input.type ?? 'block';
  demand(input.status == null || (type === 'block' && statuses.includes(input.status)), 'Отметка блока: plan, testing, passed или failed.');
  return {
    id: input.id ?? randomUUID(), type, parentId: input.parentId ?? null, attachedTo: type === 'note' ? input.attachedTo ?? null : null,
    collapsed: Boolean(input.collapsed), title: input.title ?? '', text: input.text ?? '',
    x: input.x ?? 0, y: input.y ?? 0, w: input.w ?? (type === 'note' ? 160 : 220), h: input.h ?? (type === 'note' ? 120 : 110),
    color: input.color ?? (type === 'note' ? 'yellow' : ''), ...(input.status ? { status: input.status } : {}),
    ...(Array.isArray(input.files) && input.files.length ? { files: cleanFiles(input.files) } : input.files != null && !Array.isArray(input.files) ? { files: input.files } : {}),
    ...(input.test != null && input.test !== '' ? { test: input.test } : {})
  };
}

// Дополняет узлы полями, появившимися позже: уровень, прикрепление заметки, сворачивание.
export function normalizeNode(n, nodes) {
  n.type ??= 'block';
  n.parentId ??= null;
  n.collapsed = Boolean(n.collapsed);
  if (n.type === 'note') {
    if (n.attachedTo === undefined) { n.attachedTo = n.parentId; n.parentId = n.attachedTo ? nodes.find(x => x.id === n.attachedTo)?.parentId ?? null : null; }
  } else n.attachedTo = null;
  return n;
}

// Короткое имя для истории: название или первая строка текста, обрезанная по слову с многоточием.
export function shorten(line, max = 40) {
  if (line.length <= max) return line;
  const cut = line.slice(0, max), space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
export const nodeName = n => n.title.trim() || shorten(n.text.trim().split('\n')[0]) || (n.type === 'note' ? 'пустая заметка' : 'без названия');
const kindName = n => n.type === 'note' ? 'заметка' : 'блок';
export const statusNames = { plan: 'план, кода нет', testing: 'идёт проверка', passed: 'проверен', failed: 'проверка не прошла', none: 'без отметки' };

// Узел, всё вложенное в него и заметки, прикреплённые к удаляемым блокам.
export function subtree(graph, id) {
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph.nodes) if (!removed.has(n.id) && (removed.has(n.parentId) || removed.has(n.attachedTo))) { removed.add(n.id); changed = true; }
  }
  return removed;
}

// Блок не лежит внутри самого себя: обход предков посреди пакета, до полной проверки.
function acyclic(graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const n of graph.nodes) for (let p = byId.get(n.parentId), seen = new Set([n.id]); p; p = byId.get(p.parentId)) { demand(!seen.has(p.id), 'Блок не может лежать внутри самого себя.'); seen.add(p.id); }
}

// Применяет весь пакет к копии; ошибка в любой операции оставляет исходную карту нетронутой.
export function applyOperations(original, operations) {
  demand(Array.isArray(operations) && operations.length > 0 && operations.length <= limits.operations, `Передайте от 1 до ${limits.operations} операций.`);
  const graph = structuredClone(original);
  const changes = [], placed = new Set(), refit = new Set(), created = new Set(), tight = new Set();
  // Подряд идущие сворачивания (update-node только с collapsed) копятся и раздвигают соседей одним расчётом —
  // перед любой другой операцией и в конце пакета: итог не зависит от их порядка. Остальные правки тоже идут
  // группами: по виду до группы выросшие подкарты раздвигают соседей, брошенные на блок заметки встают сбоку.
  // Цепочка предков проверяется заранее: раскладка по пакету с циклом не закончилась бы.
  const folds = new Map(), flush = () => { if (folds.size) { acyclic(graph); reflow(graph, folds); } folds.clear(); };
  let before = null, attached = new Set();
  const settleEdits = () => { if (before) { acyclic(graph); makeSpace(graph, before, attached, placed); } before = null; attached = new Set(); };
  for (const op of operations) {
    demand(op && typeof op === 'object', 'Некорректная операция.');
    const foldOnly = op.type === 'update-node' && op.patch && typeof op.patch === 'object' && Object.keys(op.patch).length === 1 && typeof op.patch.collapsed === 'boolean';
    if (foldOnly) settleEdits();
    else { flush(); before ??= screenRects(graph, placed); }
    const node = graph.nodes.find(n => n.id === op.id);
    const edge = graph.edges.find(e => e.id === op.id);
    const patchOf = allowed => {
      demand(op.patch && typeof op.patch === 'object' && !Array.isArray(op.patch), 'Передайте patch.');
      for (const key of Object.keys(op.patch)) demand(allowed.includes(key), `Поле ${key} нельзя менять.`);
      return structuredClone(op.patch);
    };
    switch (op.type) {
      case 'add-node': {
        demand(op.node && typeof op.node === 'object', 'Передайте node.');
        const added = makeNode(op.node);
        // Узел без x и y сервер расставляет сам после всего пакета, а размер без w и h подбирает под текст.
        if (op.node.x === undefined && op.node.y === undefined) {
          placed.add(added.id);
          const fit = fitSize(added);
          if (op.node.w === undefined) added.w = fit.w;
          if (op.node.h === undefined) added.h = fit.h;
        }
        graph.nodes.push(added); created.add(added.id); changes.push(`${added.type === 'note' ? 'Добавлена заметка' : 'Добавлен блок'} «${nodeName(added)}»`); break;
      }
      case 'update-node': {
        demand(node, 'Узел не найден.');
        const patch = patchOf(['title', 'text', 'x', 'y', 'w', 'h', 'color', 'parentId', 'attachedTo', 'collapsed', 'status', 'files', 'test']);
        // Пустой список файлов или пустая команда — снять их.
        if (Array.isArray(patch.files)) patch.files = patch.files.length ? cleanFiles(patch.files) : null;
        if (patch.test === '') patch.test = null;
        demand(!('status' in patch) || patch.status === null || (node.type === 'block' && statuses.includes(patch.status)), 'Отметка блока: plan, testing, passed, failed или null.');
        if (foldOnly) { folds.set(node.id, patch.collapsed); changes.push(`${patch.collapsed ? 'Свёрнута' : 'Развёрнута'} подкарта «${nodeName(node)}»`); break; }
        // Прикреплённые заметки переезжают вместе с блоком, в том числе на другой уровень, и сохраняют смещение от него.
        if (node.type === 'block') {
          const dx = (patch.x ?? node.x) - node.x, dy = (patch.y ?? node.y) - node.y, level = 'parentId' in patch ? patch.parentId : node.parentId;
          for (const note of graph.nodes) if (note.attachedTo === node.id) { note.x += dx; note.y += dy; note.parentId = level; }
        }
        // Свернули или развернули подкарту вместе с другими полями — соседи раздвигаются или сдвигаются обратно, а
        // остальные поля считаются от нового вида.
        if (typeof patch.collapsed === 'boolean' && patch.collapsed !== node.collapsed) { settleEdits(); acyclic(graph); reflow(graph, new Map([[node.id, patch.collapsed]])); before = screenRects(graph, placed); }
        if (patch.attachedTo) attached.add(node.id);
        Object.assign(node, patch);
        for (const k of ['status', 'files', 'test']) if (node[k] === null) delete node[k];
        const keys = Object.keys(patch), what = kindName(node), only = (...allowed) => keys.length > 0 && keys.every(k => allowed.includes(k));
        if (only('collapsed')) changes.push(`${node.collapsed ? 'Свёрнута' : 'Развёрнута'} подкарта «${nodeName(node)}»`);
        else if (only('status')) changes.push(`Отмечен блок «${nodeName(node)}»: ${statusNames[node.status ?? 'none']}`);
        else if (only('files', 'test')) changes.push(`Обновлены файлы и проверка блока «${nodeName(node)}»`);
        else if (only('x', 'y')) changes.push(`${node.type === 'note' ? 'Перемещена' : 'Перемещён'} ${what} «${nodeName(node)}»`);
        else if (only('w', 'h')) changes.push(`Изменён размер: ${what} «${nodeName(node)}»`);
        // Интерфейс прикрепляет заметку вместе с новым положением: бросок на блок.
        else if (keys.includes('attachedTo') && only('attachedTo', 'x', 'y')) changes.push(`${patch.attachedTo ? 'Прикреплена' : 'Откреплена'} заметка «${nodeName(node)}»`);
        else if (keys.includes('parentId')) changes.push(`${node.type === 'note' ? 'Перенесена заметка' : 'Перенесён блок'} «${nodeName(node)}»`);
        else changes.push(`${node.type === 'note' ? 'Изменена' : 'Изменён'} ${what} «${nodeName(node)}»`);
        break;
      }
      case 'delete-node': {
        demand(node, 'Узел не найден.');
        const removed = subtree(graph, op.id), byId = new Map(graph.nodes.map(n => [n.id, n]));
        // Вложенное — то, что лежит внутри блока; остальное удаляемое — заметки, прикреплённые к нему снаружи. Цикл
        // в цепочке предков (пакет ещё не проверен) обрывает обход, а сам пакет отклонит итоговая проверка.
        const within = n => { for (let p = n.parentId, seen = new Set(); p && !seen.has(p); p = byId.get(p)?.parentId) { if (p === op.id) return true; seen.add(p); } return false; };
        const inner = graph.nodes.filter(n => removed.has(n.id) && within(n)).length, attached = removed.size - 1 - inner;
        const extra = [inner && `вложенных узлов: ${inner}`, attached && `заметок: ${attached}`].filter(Boolean).join(', ');
        graph.nodes = graph.nodes.filter(n => !removed.has(n.id));
        graph.edges = graph.edges.filter(e => !removed.has(e.source) && !removed.has(e.target));
        // Удалённое в том же пакете больше не расставляется.
        for (const id of removed) { placed.delete(id); refit.delete(id); }
        changes.push(`${node.type === 'note' ? 'Удалена заметка' : 'Удалён блок'} «${nodeName(node)}»${extra ? ` (${extra})` : ''}`); break;
      }
      case 'add-edge': {
        demand(op.edge && typeof op.edge === 'object', 'Передайте edge.');
        graph.edges.push({ id: op.edge.id ?? randomUUID(), source: op.edge.source, target: op.edge.target, label: op.edge.label ?? '' });
        const end = id => { const x = graph.nodes.find(k => k.id === id); return x ? `«${nodeName(x)}»` : `«${id}»`; };
        changes.push(`Добавлена связь ${end(op.edge.source)} → ${end(op.edge.target)}`); break;
      }
      case 'update-edge': {
        demand(edge, 'Связь не найдена.');
        const patch = patchOf(['label', 'source', 'target']);
        const reversed = patch.source === edge.target && patch.target === edge.source && Object.keys(patch).length === 2;
        Object.assign(edge, patch);
        const end = id => { const x = graph.nodes.find(k => k.id === id); return x ? `«${nodeName(x)}»` : `«${id}»`; }, which = `${end(edge.source)} → ${end(edge.target)}`;
        changes.push(reversed ? `Изменено направление связи: ${which}` : 'label' in patch && Object.keys(patch).length === 1 ? `Изменена подпись связи ${which}: «${edge.label}»` : `Изменена связь: ${which}`); break;
      }
      case 'layout': {
        // Заново расставляет уровень (parentId: null — основная карта, иначе подкарта блока), с deep — и всё внутри
        // его подкарт; подкарты и блок упорядоченной подкарты при этом подгоняются под новое содержимое. Ручная
        // расстановка этих узлов теряется.
        const level = op.parentId ?? null, container = level === null ? null : graph.nodes.find(n => n.id === level);
        demand(level === null || container?.type === 'block', 'Упорядочить можно основную карту или подкарту блока.');
        const ids = new Set(graph.nodes.filter(n => n.parentId === level).map(n => n.id));
        if (op.deep) for (let changed = true; changed; ) { changed = false; for (const n of graph.nodes) if (!ids.has(n.id) && ids.has(n.parentId)) { ids.add(n.id); changed = true; } }
        for (const id of ids) {
          placed.add(id);
          if (op.deep && graph.nodes.some(n => n.parentId === id)) refit.add(id);
        }
        if (level !== null) tight.add(level);
        changes.push(level === null ? `Упорядочена карта${op.deep ? ' вместе с подкартами' : ''}` : `Упорядочена подкарта «${nodeName(container)}»`); break;
      }
      case 'delete-edge': {
        demand(edge, 'Связь не найдена.');
        graph.edges = graph.edges.filter(e => e.id !== op.id); changes.push('Удалена связь'); break;
      }
      default: throw new Problem(`Неизвестная операция: ${op.type}`);
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

// Предложение агента. Операции применяются к карте сразу, чтобы человек видел и правил предложенное на месте, но
// добавленное помечается proposed: 'add' (новый блок без отметки — сразу план, пунктир), изменённое по содержимому —
// 'change' с прежним содержимым в graph.proposal, а удаление только помечается ('remove'). Удаление того, что
// предложено добавить, удаляет сразу. Открытое предложение дополняется следующими.
const contentFields = ['parentId', 'attachedTo', 'title', 'text', 'color', 'status'];
const edgeContent = ['source', 'target', 'label'];
export function propose(original, operations, { title, by, at }) {
  demand(Array.isArray(operations) && operations.length > 0 && operations.length <= limits.operations, `Передайте от 1 до ${limits.operations} операций.`);
  demand(original.proposal || (typeof title === 'string' && title.trim() && title.length <= 200), 'Назовите предложение (title, до 200 символов).');
  const marks = [], real = [];
  for (const op of operations) {
    const list = op?.type === 'delete-node' ? original.nodes : op?.type === 'delete-edge' ? original.edges : null, item = list?.find(x => x.id === op.id);
    (item && item.proposed !== 'add' ? marks : real).push(op);
  }
  let { graph, changes } = real.length ? applyOperations(original, real) : { graph: structuredClone(original), changes: [] };
  // Предложенное должно быть видно: свёрнутые подкарты, в которых оно лежит (и новые подкарты с ним внутри),
  // разворачиваются тем же пакетом.
  const old = new Map(original.nodes.map(n => [n.id, n])), byId = new Map(graph.nodes.map(n => [n.id, n]));
  const touched = graph.nodes.filter(n => !old.has(n.id) || contentFields.some(k => old.get(n.id)[k] !== n[k]) || marks.some(op => op.type === 'delete-node' && op.id === n.id));
  const unfold = new Set();
  for (const n of touched) for (let p = byId.get(n.parentId); p; p = byId.get(p.parentId)) if (p.collapsed) unfold.add(p.id);
  if (unfold.size) graph = applyOperations(graph, [...unfold].map(id => ({ type: 'update-node', id, patch: { collapsed: false } }))).graph;
  const proposal = graph.proposal ?? { title: title.trim(), by, at, nodes: {}, edges: {} };
  if (title?.trim()) proposal.title = title.trim();
  // У изменённого узла запоминается и положение: если предложение перенесло его в другую подкарту, отказ вернёт его на место.
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
  const end = id => { const x = graph.nodes.find(k => k.id === id); return x ? `«${nodeName(x)}»` : `«${id}»`; };
  for (const op of marks) {
    const item = (op.type === 'delete-node' ? graph.nodes : graph.edges).find(x => x.id === op.id);
    demand(item, op.type === 'delete-node' ? 'Узел не найден.' : 'Связь не найдена.');
    item.proposed = 'remove';
    changes.push(op.type === 'delete-node' ? `Предложено удалить ${kindName(item)} «${nodeName(item)}»` : `Предложено удалить связь ${end(item.source)} → ${end(item.target)}`);
  }
  graph.proposal = proposal;
  validate(graph);
  return { graph, changes };
}
// Узлы и связи без пометок предложения; removed — что убрать вместе со всем вложенным и прикреплённым.
function settleProposal(graph, removedNodes, removedEdges) {
  const gone = new Set(), byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const id of removedNodes) if (byId.has(id)) for (const k of subtree(graph, id)) gone.add(k);
  graph.nodes = graph.nodes.filter(n => !gone.has(n.id));
  graph.edges = graph.edges.filter(e => !gone.has(e.source) && !gone.has(e.target) && !removedEdges.has(e.id));
  for (const x of [...graph.nodes, ...graph.edges]) delete x.proposed;
  delete graph.proposal;
  return gone;
}
// Человек принял предложение: помеченное к удалению удаляется, остальное остаётся как есть — новые блоки планом.
export function acceptProposal(original) {
  demand(original.proposal, 'Открытого предложения нет.');
  const graph = structuredClone(original), title = graph.proposal.title;
  const gone = settleProposal(graph, graph.nodes.filter(n => n.proposed === 'remove').map(n => n.id), new Set(graph.edges.filter(e => e.proposed === 'remove').map(e => e.id)));
  validate(graph);
  return { graph, changes: [gone.size ? `Удалено по предложению узлов: ${gone.size}` : `Принято предложение «${title}»`] };
}
// Человек отклонил предложение: добавленное удаляется, пометки к удалению снимаются, изменённое получает прежнее
// содержимое обычными правками (прикреплённые заметки едут за блоком, перенесённый обратно блок встаёт на прежнее
// место). Если прежний уровень или блок для заметки уже удалили, возвращаются только тексты, цвет и отметка.
export function rejectProposal(original) {
  demand(original.proposal, 'Открытого предложения нет.');
  let graph = structuredClone(original);
  const { title, nodes: snaps, edges: edgeSnaps } = graph.proposal, byId = new Map(graph.nodes.map(n => [n.id, n])), added = n => n?.proposed === 'add';
  // Сначала всё возвращается на места, пока предложенные блоки ещё есть: изменённое — по снимку прежнего содержимого
  // (в том числе то, что потом пометили к удалению), а блок без снимка, который лежит в предложенном (его положил туда
  // человек), — туда, где стоит корень предложенного, чтобы не пропасть вместе с ним.
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
  // Прежний уровень или блок для заметки могли удалить: тогда возвращаются только тексты, цвет и отметка.
  for (const keys of [['parentId', 'attachedTo', 'title', 'text', 'color', 'status'], ['title', 'text', 'color', 'status']]) {
    const ops = [...rescue, ...restore(keys)];
    if (!ops.length) break;
    try { graph = applyOperations(graph, ops).graph; break; }
    catch (e) { if (!(e instanceof Problem) || keys.length === 4) throw e; }
  }
  settleProposal(graph, graph.nodes.filter(added).map(n => n.id), new Set(graph.edges.filter(added).map(e => e.id)));
  validate(graph);
  return { graph, changes: [`Отклонено предложение «${title}»`] };
}

const nodeFields = ['type', 'parentId', 'attachedTo', 'collapsed', 'title', 'text', 'x', 'y', 'w', 'h', 'color', 'status', 'proposed', 'files', 'test'];
const edgeFields = ['source', 'target', 'label', 'proposed'];
// Списки (файлы блока) сравниваются по содержимому: после structuredClone это всегда другой массив.
const same = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]));
// Что изменилось между двумя состояниями карты. Хранится в истории у каждой ревизии, чтобы агент мог узнать,
// что поменяли после его последнего чтения: id добавленного, изменённое с именами полей, краткое описание удалённого.
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

// Правка содержимого: что-то добавлено или удалено, изменена связь или у узла поменялось что-то кроме положения,
// размера и сворачивания. Перенос в другую подкарту и прикрепление заметки меняют структуру и тоже считаются.
const layoutFields = ['x', 'y', 'w', 'h', 'collapsed'];
export const touchesContent = ({ nodes, edges }) => Boolean(nodes.added.length || nodes.removed.length || edges.added.length || edges.removed.length || Object.keys(edges.updated).length
  || Object.values(nodes.updated).some(fields => fields.some(f => !layoutFields.includes(f))));

// Ревью картой: что изменилось в устройстве проекта за записи истории — по концепциям (блокам основной карты), простыми
// словами, для человека, который не читает дифф кода. Положение, размер и сворачивание не в счёт, заметки — числом.
const reviewFields = { title: 'название', text: 'текст', color: 'цвет', parentId: 'перенесён', attachedTo: 'прикрепление', files: 'файлы', test: 'проверка' };
export function review(graph, entries) {
  const done = entries.filter(h => h.delta), { nodes, edges } = collectChanges(graph, done), byId = new Map(graph.nodes.map(n => [n.id, n]));
  const rootOf = id => { let n = byId.get(id); while (n?.parentId && byId.has(n.parentId)) n = byId.get(n.parentId); return n ?? null; };
  const groups = new Map(), q = n => `«${nodeName(n)}»`;
  const add = (root, line) => {
    const key = root?.id ?? '';
    if (!groups.has(key)) groups.set(key, { id: root?.id ?? null, title: root ? nodeName(root) : 'Удалённое', items: [], notes: 0 });
    if (line) groups.get(key).items.push(line); else groups.get(key).notes++;
  };
  const passed = [], failed = [];
  const marked = n => { if (n.status === 'passed') passed.push(q(n)); if (n.status === 'failed') failed.push(q(n)); };
  for (const n of nodes.added) {
    if (n.type === 'note') { add(rootOf(n.id), null); continue; }
    add(rootOf(n.id), n.parentId ? `добавлен блок ${q(n)}${n.status === 'plan' ? ' (план, кода нет)' : ''}` : 'новая концепция');
    marked(n);
  }
  for (const n of nodes.updated) {
    const fields = n.fields.filter(f => !layoutFields.includes(f) && f !== 'proposed' && f !== 'type');
    if (!fields.length) continue;
    const what = [...new Set(fields.map(f => f === 'status' ? statusNames[n.status ?? 'none'] : reviewFields[f] ?? f))].join(', ');
    add(rootOf(n.id), `${n.type === 'note' ? 'изменена заметка' : 'изменён блок'} ${q(n)}: ${what}`);
    if (fields.includes('status')) marked(n);
  }
  for (const r of nodes.removed) add(byId.has(r.parentId) ? rootOf(r.parentId) : null, `${r.type === 'note' ? 'удалена заметка' : 'удалён блок'} «${r.name}»`);
  const end = id => byId.has(id) ? q(byId.get(id)) : `(${id})`;
  for (const e of edges.added) add(rootOf(e.source), `связь ${end(e.source)} → ${end(e.target)}${e.label ? `: ${e.label}` : ''}`);
  for (const e of edges.updated) add(rootOf(e.source), `изменена связь ${end(e.source)} → ${end(e.target)}`);
  for (const e of edges.removed) add(byId.has(e.source) ? rootOf(e.source) : null, `убрана связь ${end(e.source)} → ${end(e.target)}`);
  const list = [...groups.values()].map(g => ({ ...g, items: g.notes ? [...g.items, `заметок добавлено: ${g.notes}`] : g.items }))
    .sort((a, b) => (a.id === null) - (b.id === null) || a.title.localeCompare(b.title, 'ru'));
  const human = done.filter(h => h.actor === 'human').length, agents = [...new Set(done.filter(h => h.actor !== 'human' && h.actor !== 'system').map(h => h.actor))];
  return { since: done[0] ? done[0].revision - 1 : graph.revision, revision: graph.revision, entries: done.length, human, agents, from: done[0]?.at ?? null, groups: list, passed, failed };
}
export function reviewText(r) {
  if (!r.groups.length) return `Изменений в устройстве проекта нет (ревизия ${r.revision}).`;
  const who = [r.human && `человек — ${r.human}`, r.agents.length && `агенты: ${r.agents.join(', ')}`].filter(Boolean).join('; ');
  return [`Что изменилось с ревизии ${r.since} по ${r.revision}${r.from ? ` (с ${new Date(r.from).toLocaleString('ru')})` : ''}: записей ${r.entries}${who ? `, ${who}` : ''}.`,
    ...r.groups.flatMap(g => ['', `«${g.title}»`, ...g.items.map(i => `- ${i}`)]),
    ...(r.passed.length || r.failed.length ? ['', [r.passed.length && `Проверено: ${r.passed.join(', ')}.`, r.failed.length && `Проверка не прошла: ${r.failed.join(', ')}.`].filter(Boolean).join(' ')] : [])].join('\n');
}

// Сводка изменений по записям истории: добавленные и изменённые узлы и связи — в текущем виде целиком,
// у изменённых — какие поля менялись, удалённые — кратко. Добавленное и затем удалённое в сводку не попадает.
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
