import { mkdir, readFile, rename, copyFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { validate, normalizeNode, diffGraphs, touchesContent, Problem } from './model.mjs';

const statusNames = { planned: 'Запланировано', building: 'В работе', done: 'Готово', blocked: 'Заблокировано' };
const kindNames = { depends: 'зависимость', informs: 'влияние' };

// Переводит карту версий 1–2 (вложенные блоки с полями суть, логика, критерии, вопросы) в свободную карту версии 3.
// Вложенность становится связями родитель → ребёнок, блоки расставляются деревом слева направо, тексты собираются в одно поле.
export function migrateToV3(old) {
  const nodes = old.nodes;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const children = id => nodes.filter(n => n.parentId === id);
  const W = 220, H = 110, GX = 120, GY = 40;
  const pos = new Map();
  let cursor = 0;
  const place = (n, depth, seen) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const kids = children(n.id).filter(k => !seen.has(k.id));
    if (!kids.length) { pos.set(n.id, { x: depth * (W + GX), y: cursor }); cursor += H + GY; return; }
    kids.forEach(k => place(k, depth + 1, seen));
    const ys = kids.map(k => pos.get(k.id).y);
    pos.set(n.id, { x: depth * (W + GX), y: (Math.min(...ys) + Math.max(...ys)) / 2 });
  };
  const seen = new Set();
  nodes.filter(n => n.parentId == null || !byId.has(n.parentId)).forEach(r => place(r, 0, seen));
  nodes.forEach(n => place(n, 0, seen));
  const text = n => [n.summary, n.logic && `Логика: ${n.logic}`, n.criteria && `Критерии готовности: ${n.criteria}`, n.questions && `Открытые вопросы: ${n.questions}`, statusNames[n.status] && `Статус: ${statusNames[n.status]}`].filter(Boolean).join('\n\n');
  const next = {
    schemaVersion: 3, revision: old.revision, updatedAt: old.updatedAt,
    nodes: nodes.map(n => ({ id: n.id, type: 'block', parentId: null, attachedTo: null, collapsed: false, title: String(n.title ?? ''), text: text(n), x: pos.get(n.id).x, y: pos.get(n.id).y, w: W, h: H, color: n.parentId == null ? 'blue' : '' })),
    edges: [], history: old.history
  };
  const pairs = new Set();
  const addEdge = (id, source, target, label) => {
    const pair = `${source}:${target}`;
    if (pairs.has(pair) || source === target || !byId.has(source) || !byId.has(target)) return;
    pairs.add(pair); next.edges.push({ id, source, target, label });
  };
  for (const n of nodes) if (n.parentId != null) addEdge(`tree-${n.id}`, n.parentId, n.id, '');
  for (const e of old.edges ?? []) addEdge(e.id, e.source, e.target, e.label || kindNames[e.kind] || '');
  return next;
}

// Lock-файл, оставленный аварийно завершённым сервером: в нём номер процесса, которого уже нет.
// Пока сервер работает, Windows не даёт прочитать файл, а номер процесса жив.
async function staleLock(lockPath) {
  let pid;
  try { pid = Number(await readFile(lockPath, 'utf8')); } catch { return false; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

// lock: false — один пишущий процесс уже гарантирует хаб своим server.lock. initial === null — карта должна быть:
// без graph.json это ошибка, а не новая пустая карта (папка проекта не создаётся и не пишется).
export async function openStore(directory, initial, { lock: locked = true } = {}) {
  if (locked || initial !== null) await mkdir(directory, { recursive: true });
  // Один пишущий процесс на каталог данных. Штатная остановка удаляет этот lock-файл.
  const lockPath = join(directory, 'server.lock');
  let lock = null;
  if (locked) {
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await staleLock(lockPath)) { await unlink(lockPath); lock = await open(lockPath, 'wx'); }
      else throw new Error(`Каталог данных уже занят: ${lockPath}. Если сервер завершился аварийно, убедитесь, что он остановлен, и удалите server.lock.`);
    }
    await lock.writeFile(String(process.pid));
  }
  const file = join(directory, 'graph.json');
  let graph, closed = false;
  const release = async () => { if (!lock) return; await lock.close(); await unlink(lockPath).catch(() => {}); };
  const persist = async next => {
    const temp = join(directory, `graph-${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, 'wx');
      try { await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await copyFile(file, join(directory, 'graph.backup.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await rename(temp, file);
    } finally { await unlink(temp).catch(() => {}); }
  };
  try {
    let text = null;
    try { text = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (text === null && initial === null) throw new Error('Нет файла карты graph.json.');
    if (text === null) { graph = initial; await persist(graph); }
    else try { graph = JSON.parse(text); } catch { throw new Error('graph.json повреждён: это не JSON.'); }
    if (!graph || typeof graph !== 'object' || ![1, 2, 3].includes(graph.schemaVersion) || !Number.isSafeInteger(graph.revision) || graph.revision < 0 || !Array.isArray(graph.history) || !Array.isArray(graph.nodes)) throw new Error('Неподдерживаемый формат graph.json.');
    if (graph.schemaVersion < 3) {
      const old = structuredClone(graph);
      if (old.schemaVersion === 1) for (const node of old.nodes) delete node.codeRefs;
      const migrated = migrateToV3(old);
      validate(migrated);
      await copyFile(file, join(directory, `graph.v${graph.schemaVersion}.backup.json`), constants.COPYFILE_EXCL).catch(e => { if (e.code !== 'EEXIST') throw e; });
      migrated.revision += 1;
      migrated.updatedAt = new Date().toISOString();
      migrated.history = [...migrated.history, { revision: migrated.revision, at: migrated.updatedAt, actor: 'system', message: 'Карта переведена в свободный формат', changes: ['Вложенность стала связями, описания собраны в текст блока, блоки расставлены деревом слева направо'] }].slice(-200);
      await persist(migrated);
      graph = migrated;
    }
    // Карты версии 3, записанные раньше, могут не содержать type, parentId, attachedTo и collapsed.
    for (const node of graph.nodes) normalizeNode(node, graph.nodes);
    validate(graph);
  } catch (e) { await release(); throw e; }
  let queue = Promise.resolve();
  return {
    get: () => structuredClone(graph),
    // Без копии, только для чтения: сводка проекта на главной не копирует всю историю.
    peek: () => graph,
    commit(expectedRevision, actor, message, transform) {
      // Закрытая карта (проект удаляют или хаб останавливается) новых записей не принимает; принятые до close допишутся.
      if (closed) return Promise.reject(new Problem('Карта закрыта.', 503));
      const work = queue.then(async () => {
        if (!Number.isSafeInteger(expectedRevision)) throw new Problem('expectedRevision обязателен.');
        if (expectedRevision !== graph.revision) throw new Problem(`Конфликт ревизий: сейчас ${graph.revision}. Прочитайте карту заново и объедините изменения.`, 409);
        if (typeof actor !== 'string' || !actor.trim() || actor.length > 100) throw new Problem('Укажите actor (до 100 символов).');
        if (typeof message !== 'string' || !message.trim() || message.length > 1000) throw new Problem('Укажите причину изменения в message (до 1000 символов).');
        const { graph: next, changes } = await transform(structuredClone(graph));
        validate(next);
        next.revision = graph.revision + 1; next.updatedAt = new Date().toISOString();
        const entry = { revision: next.revision, at: next.updatedAt, actor, message, changes, delta: diffGraphs(graph, next) };
        // Человек листает карту (погружения, возвраты, уровни, перетаскивания): подряд идущие записи без правки
        // содержимого сливаются в одну, иначе навигация вытеснила бы из последних 200 записей настоящие правки.
        const last = graph.history.at(-1);
        if (actor === 'human' && last?.actor === actor && last.delta && !touchesContent(last.delta) && !touchesContent(entry.delta)) {
          const subject = line => line.replace(/^\S+\s/, ''), later = new Set(changes.map(subject));
          entry.changes = [...last.changes.filter(line => !later.has(subject(line))), ...changes].slice(-50);
          const updated = { ...last.delta.nodes.updated };
          for (const [id, fields] of Object.entries(entry.delta.nodes.updated)) updated[id] = [...new Set([...(updated[id] ?? []), ...fields])];
          entry.delta.nodes.updated = updated;
          next.history = [...graph.history.slice(0, -1), entry];
        } else next.history = [...graph.history, entry].slice(-200);
        await persist(next); graph = next;
        return structuredClone(graph);
      });
      queue = work.catch(() => {});
      return work;
    },
    async close() { closed = true; await queue; await release(); }
  };
}
