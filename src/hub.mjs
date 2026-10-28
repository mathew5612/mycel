// Хаб: реестр проектов, корзина и рабочее состояние каждого открытого проекта (карта, чат, ожидающие агенты, SSE).
// Всё в каталоге данных приложения: projects.json, projects/<id>/, trash/<id>/; в папки проектов ничего не пишется.
// Изменения реестра идут одной очередью, поэтому создание, удаление и перенос не пересекаются.
import { readFile, writeFile, readdir, mkdir, rename, copyFile, open, unlink, rm, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from './store.mjs';
import { openChat } from './chat.mjs';
import { seed } from './seed.mjs';
import { slug } from './slug.mjs';
import { realDir, pathKey, isInside, refusedPath } from './paths.mjs';
import { collectChanges, touchesContent, blocksOfFile, nodeName, Problem } from './model.mjs';

export const ID = /^[a-z0-9-]{1,60}$/;
const WEEK = 7 * 24 * 3600e3;
const log = message => console.error(message);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isDir = p => { try { return typeof p === 'string' && statSync(p).isDirectory(); } catch { return false; } };
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
// Windows не даёт переименовать папку или файл, пока его держит другой процесс (антивирус, индексатор): 20 раз по 100 мс.
async function retry(work) {
  for (let i = 0; ; i++) {
    try { return await work(); }
    catch (e) { if (i >= 19 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; await sleep(100); }
  }
}
// JSON записывается целиком или никак: временный файл, sync, rename.
async function writeJson(file, value) {
  const temp = `${file}-${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await retry(() => rename(temp, file));
  } finally { await unlink(temp).catch(() => {}); }
}

// Один хаб на каталог данных. Lock устарел, если его процесса нет или если ему больше 10 секунд, а по его порту не
// отвечает Mycel с этими же данными: номер умершего процесса Windows мог отдать другой программе.
// Устаревший lock снимает только тот, кто создал server.lock.takeover: иначе два хаба, запущенные разом после сбоя,
// оба сняли бы его и работали бы с одними данными. Остальные ждут исхода и читают lock заново. Файл перехвата,
// брошенный упавшим процессом (старше 10 секунд), удаляется.
export async function lockHub(data, port) {
  const file = join(data, 'server.lock'), guardFile = `${file}.takeover`, mine = { pid: process.pid, port, data, startedAt: new Date().toISOString() };
  const take = () => writeFile(file, JSON.stringify(mine) + '\n', { flag: 'wx' }).then(() => true, e => { if (e.code === 'EEXIST') return false; throw e; });
  const busy = async () => new Error(`Mycel уже запущен: http://127.0.0.1:${(await readLock(file))?.port || 4317}`);
  for (let i = 0; !(await take()); i++) {
    const guard = await open(guardFile, 'wx').catch(e => { if (e.code === 'EEXIST') return null; throw e; });
    if (!guard) {
      if (i >= 150) throw await busy();
      if (Date.now() - (await stat(guardFile).then(s => s.mtimeMs, () => Date.now())) > 10000) await unlink(guardFile).catch(() => {});
      else await sleep(100);
      continue;
    }
    try {
      const held = await readLock(file);
      if (!(await staleLock(held, data))) throw await busy();
      // Пока шла проверка, lock мог смениться: снимается только тот, что признан устаревшим.
      const now = await readLock(file);
      if (now && (now.pid !== held?.pid || now.startedAt !== held?.startedAt)) continue;
      if (now) { log(`Снят lock завершившегося Mycel (pid ${now.pid ?? '?'}).`); await unlink(file).catch(() => {}); }
      if (await take()) break;
      throw await busy();
    } finally { await guard.close(); await unlink(guardFile).catch(() => {}); }
  }
  return {
    update: async actual => { mine.port = actual; await writeFile(file, JSON.stringify(mine) + '\n'); },
    // Чужой lock (его мог перехватить другой хаб) не удаляется.
    async release() { const held = await readLock(file); if (held?.pid === mine.pid && held.startedAt === mine.startedAt) await unlink(file).catch(() => {}); }
  };
}
async function readLock(file) {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    let v; try { v = /^\s*\d+\s*$/.test(text) ? { pid: Number(text) } : Object(JSON.parse(text)); } catch { v = {}; } // 0.9 писала только номер процесса
    return { pid: v.pid ?? null, port: v.port ?? null, startedAt: v.startedAt ?? null, at: Date.parse(v.startedAt) || info.mtimeMs };
  } catch (e) { return e.code === 'ENOENT' ? null : { pid: null, port: null, startedAt: null, at: Date.now() }; }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function staleLock(held, data) {
  if (!held) return true;
  if (Number.isSafeInteger(held.pid) && held.pid > 0 && !alive(held.pid)) return true;
  if (Date.now() - held.at < 10000) return false;
  if (!Number.isInteger(held.port) || held.port < 1 || held.port > 65535) return true;
  try {
    const health = await (await fetch(`http://127.0.0.1:${held.port}/api/health`, { signal: AbortSignal.timeout(2000) })).json();
    return !(['mycel', 'kontur'].includes(health?.app) && typeof health.data === 'string' && pathKey(health.data) === pathKey(data));
  } catch { return true; }
}

// machine — проект виртуальной машины: id её ключа (src/access.mjs) и имя; path тогда — путь в ней.
const entryOf = v => v && typeof v === 'object' && ID.test(v.id) && typeof v.name === 'string' && v.name.trim() && (v.path == null || typeof v.path === 'string') && typeof v.createdAt === 'string'
  ? { id: v.id, name: v.name, path: v.path ?? null, createdAt: v.createdAt, ...(typeof v.machine === 'string' && v.machine ? { machine: v.machine.slice(0, 100), machineName: typeof v.machineName === 'string' ? v.machineName.slice(0, 60) : '' } : {}) } : null;
const entry = p => ({ id: p.id, name: p.name, path: p.path, createdAt: p.createdAt, ...(p.machine ? { machine: p.machine, machineName: p.machineName } : {}) });
// Папки виртуальной машины основная не видит: они сравниваются как строки, без завершающего разделителя, Windows-пути —
// без учёта регистра. Папки основной машины — по настоящему пути (src/paths.mjs).
const machineKey = path => { const p = path.replace(/[\\/]+$/, '') || path; return /^[a-zA-Z]:/.test(p) ? p.replace(/\\/g, '/').toLowerCase() : p; };
const keyOf = (path, machine) => machine ? machineKey(path) : pathKey(path);
const within = (child, parent, machine) => {
  if (!machine) return isInside(child, parent);
  const c = machineKey(child), p = machineKey(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
};
const absolute = (path, machine) => machine ? /^(\/|[a-zA-Z]:[\\/])/.test(path) : isAbsolute(path);
// project.json папки проекта или корзины; id должен совпадать с именем папки.
async function own(dir) {
  try { const v = await readJson(join(dir, 'project.json')), e = entryOf(v); return e && e.id === basename(dir) ? { ...e, deletedAt: typeof v.deletedAt === 'string' ? v.deletedAt : null } : null; }
  catch { return null; }
}
const gone = (t, status) => Object.assign(new Problem(`Проект «${t.name}» удалён человеком.`, status), { extra: { deleted: { id: t.id, name: t.name, deletedAt: t.deletedAt } } });
// Проект удаляют прямо сейчас, и удаление ещё может не состояться (папка занята): запрос стоит повторить.
const deleting = () => Object.assign(new Problem('Проект удаляется, повторите запрос.', 503), { extra: { retry: true } });

// Открытый проект: карта, события для агентов, фокус и выделение человека, его правки, присутствие агентов и что они
// делают сейчас, долгие запросы и SSE его страниц. Разговор человека с агентом идёт в окне агента, не здесь: события
// (chat.json) — только то, что человек сделал кнопками Mycel: закончил правки, принял или отклонил предложение.
function project(e, dir, emit) {
  const p = { ...e, dir, store: null, chat: null, error: null, gone: null, deleting: false, focus: null, selection: null, edit: null, activity: new Map(), sessions: new Set(), waiters: new Map(), agents: new Map(), cursors: Promise.resolve(),
    code: { stale: {}, risks: {} }, editing: new Map() };
  const editFile = join(dir, 'edit.json'), codeFile = join(dir, 'code.json');
  p.open = async () => {
    try {
      p.store = await openStore(dir, null, { lock: false }); p.chat = await openChat(dir); p.error = null;
      // Правки человека, начатые до перезапуска, остаются начатыми: агент не должен проснуться на половине.
      const edit = await readJson(editFile).catch(() => null);
      p.edit = Number.isSafeInteger(edit?.since) && edit.since <= p.store.peek().revision && typeof edit.at === 'string' ? { since: edit.since, at: edit.at } : null;
      const code = await readJson(codeFile).catch(() => null), table = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      p.code = { stale: table(code?.stale), risks: table(code?.risks) };
    }
    catch (error) { await p.store?.close().catch(() => {}); p.store = p.chat = null; p.error = error.message; log(`Проект ${p.id} не открылся: ${error.message}`); }
  };
  // Что агент делает сейчас («читаю server.mjs», можно с процентом): строка под картой. Агент снимает её сам; забытая
  // гаснет через 15 минут.
  const STALE = 15 * 60e3;
  p.activityList = () => [...p.activity.values()].filter(a => Date.now() - Date.parse(a.at) < STALE);
  // blocks — над какими блоками агент работает (doing --on): их видят человек и другие агенты.
  p.setActivity = (actor, text, progress, blocks = []) => {
    if (text) p.activity.set(actor, { actor, text, progress: progress ?? null, blocks, at: new Date().toISOString() }); else p.activity.delete(actor);
    p.broadcast();
  };
  // Код глазами Mycel. Какие файлы агенты правят сейчас (хук Claude Code после правки файла; в памяти): блок этих
  // файлов подсвечен именем агента 2 минуты после последней правки. Устаревшие блоки — их файлы изменили после того,
  // как блок описали; пометку снимает правка блока агентом или mycel fresh. Риски — что нашёл mycel health. Устаревшее
  // и риски — в code.json проекта, переживают перезапуск.
  const NOW = 2 * 60e3, BUSY = 10 * 60e3;
  let codeSaved = Promise.resolve();
  const saveCode = () => (codeSaved = codeSaved.then(() => writeJson(codeFile, p.code)).catch(e => log(`Код проекта ${p.id} не записан: ${e.message}`)));
  const liveIds = () => new Set(p.store.peek().nodes.map(n => n.id));
  // Кто над какими блоками работает: правит их файлы (within мс) или назвал их в doing --on.
  const workOf = within => {
    const graph = p.store.peek(), by = new Map(), put = (actor, ids, at) => {
      const w = by.get(actor) ?? { actor, blocks: new Set(), files: new Set(), at };
      for (const id of ids) w.blocks.add(id);
      if (at > w.at) w.at = at;
      by.set(actor, w); return w;
    };
    for (const [actor, files] of p.editing) for (const [file, at] of files) if (Date.now() - Date.parse(at) < within) put(actor, blocksOfFile(graph, file).map(n => n.id), at).files.add(file);
    for (const a of p.activityList()) if (a.blocks?.length) put(a.actor, a.blocks, a.at);
    return [...by.values()].map(w => ({ actor: w.actor, blocks: [...w.blocks], files: [...w.files], at: w.at }));
  };
  p.work = () => workOf(NOW);
  // Блоки, над которыми сейчас работают другие агенты: о них предупреждают того, кто взялся за те же.
  p.others = (actor, ids) => {
    const want = new Set(ids), names = new Map(p.store.peek().nodes.map(n => [n.id, n]));
    return workOf(BUSY).filter(w => w.actor !== actor).flatMap(w => w.blocks.filter(id => want.has(id) && names.has(id)).map(id => ({ id, name: nodeName(names.get(id)), by: w.actor })));
  };
  // session — сессия агента (Claude Code): напоминание в конце ответа — только о том, что он менял в этой сессии.
  p.touchFiles = (actor, files, session = null) => {
    const graph = p.store.peek(), at = new Date().toISOString(), touched = new Map();
    const mine = p.editing.get(actor) ?? new Map();
    for (const file of files) {
      mine.set(file, at);
      for (const n of blocksOfFile(graph, file)) {
        touched.set(n.id, n);
        const old = p.code.stale[n.id]?.files ?? [];
        p.code.stale[n.id] = { files: [...new Set([...old, file])].slice(-20), by: actor, at, ...(session ? { session } : {}) };
      }
    }
    // Старые правки забываются: в памяти — только последние 200 файлов агента.
    p.editing.set(actor, new Map([...mine].slice(-200)));
    if (touched.size) saveCode();
    p.broadcast();
    return { blocks: [...touched.values()].map(n => ({ id: n.id, name: nodeName(n) })), others: p.others(actor, [...touched.keys()]) };
  };
  // Блок описан заново или подтверждён: пометка «устарел» снимается. Без ids — у всех блоков.
  p.freshen = ids => {
    const all = ids === null, gone = Object.keys(p.code.stale).filter(id => all || ids.includes(id));
    for (const id of gone) delete p.code.stale[id];
    if (gone.length) { saveCode(); p.broadcast(); }
    return gone;
  };
  p.setRisks = risks => { p.code.risks = risks; saveCode(); p.broadcast(); };
  // Устаревшее и риски удалённых блоков не показываются.
  p.codeInfo = () => {
    const ids = liveIds(), keep = table => Object.fromEntries(Object.entries(table).filter(([id]) => ids.has(id)));
    return { stale: keep(p.code.stale), risks: keep(p.code.risks) };
  };
  // Правки человека: с какой ревизии он начал менять содержимое карты, когда и сколько записей сделал с тех пор.
  // Пока он не нажал «Закончить правки», его записи после since не будят агентов.
  const humanEdits = (graph, since) => graph.history.filter(h => h.revision > since && h.actor === 'human' && (!h.delta || touchesContent(h.delta)));
  p.editInfo = () => p.edit && p.store ? { ...p.edit, count: humanEdits(p.store.peek(), p.edit.since).length } : null;
  // Событие для открытых страниц проекта: текущая ревизия карты, правки человека, агенты на связи, что они делают, и
  // прочее (show — блок, который агент просит показать).
  p.state = () => ({ revision: p.store.peek().revision, edit: p.editInfo(), agents: p.presence(), activity: p.activityList(), work: p.work(), code: p.codeInfo() });
  p.broadcast = (extra = {}) => {
    if (!p.store) return;
    const data = JSON.stringify({ ...p.state(), ...extra });
    for (const stream of p.sessions) stream.write(`data: ${data}\n\n`);
  };
  // Запись человека, которая меняет содержимое, начинает правки; кнопка «Закончить правки» их завершает. Файл
  // пишется по очереди и всегда текущим состоянием: запоздавшая запись начала не вернёт уже законченные правки.
  let editSaved = Promise.resolve();
  const saveEdit = () => (editSaved = editSaved.then(() => p.edit ? writeJson(editFile, p.edit) : unlink(editFile).catch(e => { if (e.code !== 'ENOENT') throw e; }))
    .catch(e => log(`Правки проекта ${p.id} не записаны: ${e.message}`)));
  p.startEdit = async (entry, before) => {
    if (p.edit || entry?.actor !== 'human' || (entry.delta && !touchesContent(entry.delta))) return;
    p.edit = { since: before, at: entry.at };
    await saveEdit();
  };
  p.endEdit = async () => {
    const edit = p.editInfo(); if (!edit) return null;
    p.edit = null;
    await saveEdit();
    return { ...edit, until: p.store.peek().revision };
  };
  p.wake = () => { for (const check of [...p.waiters.keys()]) check(); };
  p.committed = () => { p.broadcast(); p.wake(); emit({ project: p.id, revision: p.store.peek().revision }); };
  p.chatted = () => { p.broadcast(); p.wake(); emit({ project: p.id, chat: p.chat.seq }); };
  // Агенты, которые обращались к проекту: ждёт ли агент сейчас изменений (с запасом в 5 секунд между запросами
  // ожидания) и когда был в последний раз. Интерфейс показывает это точкой в строке управления и на главной.
  p.presence = () => [...p.agents.values()].map(a => ({ actor: a.actor, waiting: a.waiting > 0 || Date.now() - a.waitEnded < 5000, lastSeen: a.lastSeen }));
  const present = () => { if (p.gone || !p.store) return; p.broadcast({ presence: true }); emit({ project: p.id, presence: true }); };
  p.touch = (actor, waiting = 0) => {
    if (typeof actor !== 'string' || !actor || actor === 'human' || actor.length > 100) return;
    const a = p.agents.get(actor) ?? { actor, waiting: 0, waitEnded: 0, lastSeen: null };
    const fresh = !p.agents.has(actor), wasWaiting = a.waiting > 0;
    a.waiting += waiting; a.lastSeen = new Date().toISOString();
    if (waiting < 0) a.waitEnded = Date.now();
    p.agents.set(actor, a);
    if (fresh || (!wasWaiting && a.waiting > 0)) present();
    if (waiting < 0 && a.waiting === 0) setTimeout(present, 5500).unref();
  };
  // Изменения после ревизии since, кроме сделанных автором exclude (агент не ждёт собственных правок).
  // complete = false, если история не покрывает этот промежуток: тогда агенту нужно перечитать карту целиком.
  // chatSince — номер изменения событий, после которого они нужны (кроме своих и шагов агентов).
  // Пока человек правит карту, его записи с начала правок приходят, но не считаются новыми (held): ожидание агента
  // на них не просыпается, его разбудит сообщение «Правки карты готовы».
  p.changesSince = (since, exclude, chatSince = null) => {
    const graph = p.store.get(), entries = graph.history.filter(h => h.revision > since);
    const complete = since <= graph.revision && (since === graph.revision || graph.history[0]?.revision <= since + 1) && entries.every(h => h.delta);
    const relevant = entries.filter(h => h.actor !== exclude);
    const fresh = relevant.filter(h => !(p.edit && h.actor === 'human' && h.revision > p.edit.since));
    return {
      revision: graph.revision, since, complete, focus: p.focus, edit: p.editInfo(), held: relevant.length - fresh.length,
      contentChanged: fresh.some(h => !h.delta || touchesContent(h.delta)),
      entries: relevant.map(({ delta, ...h }) => h), ...(complete ? collectChanges(graph, relevant) : { nodes: null, edges: null }),
      ...(chatSince === null ? {} : { chat: { seq: p.chat.seq, messages: p.chat.since(chatSince).filter(m => m.updatedBy !== exclude && m.kind !== 'log') } })
    };
  };
  // Прочитанное агентом: ревизия карты и изменение чата. Пишет только хаб, по очереди; значения только растут,
  // поэтому запоздавшая запись старого чтения не откатывает курсор.
  const cursorFile = actor => join(dir, 'agents', `${actor.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  p.cursor = async actor => {
    try { const c = await readJson(cursorFile(actor)); return { revision: Number.isSafeInteger(c.revision) ? c.revision : null, chat: Number.isSafeInteger(c.chat) ? c.chat : 0 }; }
    catch { return { revision: null, chat: 0 }; }
  };
  p.saveCursor = (actor, { revision, chat }) => {
    const work = p.cursors.then(async () => {
      const old = await p.cursor(actor);
      const next = { revision: revision == null ? old.revision : Math.max(old.revision ?? revision, revision), chat: chat == null ? old.chat : Math.max(old.chat, chat) };
      await mkdir(join(dir, 'agents'), { recursive: true });
      await writeJson(cursorFile(actor), { actor, ...next, at: new Date().toISOString() });
      return next;
    });
    p.cursors = work.catch(() => {});
    return work;
  };
  // Страницы проекта и долгие запросы закрываются: при удалении — с сообщением об этом, при остановке — как обычно.
  p.end = deleted => {
    for (const stream of p.sessions) { if (deleted) stream.write('data: {"deleted":true}\n\n'); stream.end(); }
    p.sessions.clear();
    for (const finish of [...p.waiters.values()]) deleted ? finish(404, { error: 'Проект удалён.', deleted: true }) : finish();
  };
  p.drain = async () => { await p.store?.close(); await p.chat?.close(); await p.cursors; await codeSaved; };
  p.info = () => {
    const g = p.store?.peek(), count = type => g ? g.nodes.filter(n => n.type === type).length : 0;
    return { id: p.id, name: p.name, path: p.path, exists: p.machine ? null : isDir(p.path), ...(p.machine ? { machine: { id: p.machine, name: p.machineName } } : {}), createdAt: p.createdAt, updatedAt: g?.updatedAt ?? p.createdAt, revision: g?.revision ?? null,
      blocks: count('block'), notes: count('note'), edges: g?.edges.length ?? 0, agents: p.presence(), ...(p.error ? { error: p.error } : {}) };
  };
  return p;
}

export async function openHub(data) {
  const dirs = { projects: join(data, 'projects'), trash: join(data, 'trash') };
  await mkdir(dirs.projects, { recursive: true }); await mkdir(dirs.trash, { recursive: true });
  const registryFile = join(data, 'projects.json'), backupFile = join(data, 'projects.backup.json');
  const live = new Map(), trash = new Map(), streams = new Set();
  let seq = 0, queue = Promise.resolve(), closing = false;
  const emit = event => { const line = `data: ${JSON.stringify(event)}\n\n`; for (const stream of streams) stream.write(line); };
  const serial = work => {
    if (closing) return Promise.reject(new Problem('Mycel останавливается.', 503));
    const run = queue.then(work); queue = run.catch(() => {}); return run;
  };
  const changed = () => { seq += 1; emit({ projects: seq }); };
  const saveRegistry = async () => {
    await copyFile(registryFile, backupFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await writeJson(registryFile, { version: 1, projects: [...live.values()].map(entry) });
  };
  const visible = () => [...live.values()].filter(p => !p.gone);
  const removed = () => [...trash.values(), ...[...live.values()].filter(p => p.gone).map(p => ({ ...entry(p), deletedAt: p.gone }))];
  // Папки сравниваются только среди проектов той же машины (null — основная).
  const on = (p, machine) => (p.machine ?? null) === machine;
  const owner = (path, machine = null) => { const key = keyOf(path, machine); return visible().find(p => p.path && on(p, machine) && keyOf(p.path, machine) === key) ?? null; };
  // Ближайший проект, в папке которого лежит path; с root — только внутри root, чтобы подключённая папка выше
  // не захватила отдельный репозиторий. Из удалённых с одной папкой — последний.
  const nearest = (items, path, root = null, machine = null) => items.filter(p => p.path && on(p, machine) && within(path, p.path, machine) && (!root || within(p.path, root, machine)))
    .sort((a, b) => keyOf(b.path, machine).length - keyOf(a.path, machine).length || String(b.deletedAt).localeCompare(String(a.deletedAt)))[0] ?? null;

  // Реестр: projects.json, при порче — его прошлая копия. Испорченный файл откладывается в projects.broken.json, чтобы
  // следующая запись не затёрла им хорошую копию. Корзина — по trash/*/project.json.
  let list = null, broken = false;
  for (const file of [registryFile, backupFile]) {
    try { const r = await readJson(file); if (r?.version !== 1 || !Array.isArray(r.projects)) throw new Error('неизвестный формат'); list = r.projects; break; }
    catch (e) { if (e.code === 'ENOENT') continue; log(`Не читается ${file}: ${e.message}`); if (file === registryFile) broken = true; }
  }
  if (broken) await rename(registryFile, join(data, 'projects.broken.json')).catch(e => log(`Не отложен испорченный реестр: ${e.message}`));
  for (const name of await readdir(dirs.trash)) { const t = await own(join(dirs.trash, name)); if (t) trash.set(t.id, t); }
  // Проекты, которых нет в реестре (запись оборвалась), восстанавливаются по projects/<id>/project.json: пустой реестр
  // при живых папках проектов не принимается. Недописанные .new-* не трогаются.
  const names = new Set(), found = [];
  for (const item of await readdir(dirs.projects, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    if (item.name.startsWith('.new-')) { log(`Пропущена недописанная папка проекта: ${join(dirs.projects, item.name)}`); continue; }
    names.add(item.name);
    const v = await own(join(dirs.projects, item.name)); if (v) found.push(v);
  }
  let dirty = broken || list === null;
  for (const raw of list ?? []) {
    const e = entryOf(raw);
    if (!e || live.has(e.id)) { log(`Пропущена запись реестра: ${JSON.stringify(raw)}`); dirty = true; continue; }
    // Удаление успело перенести папку в корзину, но не записать реестр.
    if (!names.has(e.id) && trash.has(e.id)) { dirty = true; continue; }
    live.set(e.id, project(e, join(dirs.projects, e.id), emit));
  }
  for (const v of found) if (!live.has(v.id)) { log(`Проект ${v.id} возвращён в реестр по project.json.`); live.set(v.id, project(entryOf(v), join(dirs.projects, v.id), emit)); dirty = true; }
  if (dirty) await saveRegistry();
  // Проект, который не открылся, виден с ошибкой, его файлы не пишутся; хаб всё равно работает.
  for (const p of live.values()) await p.open();

  // Удалённое человеком хранится неделю; записи без даты удаления не трогаются.
  const purge = () => serial(async () => {
    for (const t of [...trash.values()]) {
      if (!(Date.now() - Date.parse(t.deletedAt) > WEEK)) continue;
      try { await rm(join(dirs.trash, t.id), { recursive: true, force: true, maxRetries: 5 }); trash.delete(t.id); log(`Из корзины удалён проект ${t.id} («${t.name}»).`); }
      catch (e) { log(`Не удалось удалить из корзины ${t.id}: ${e.message}`); }
    }
  });
  await purge();
  const purger = setInterval(() => purge().catch(() => {}), 3600e3); purger.unref();
  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(': keepalive\n\n');
    for (const p of live.values()) for (const stream of p.sessions) stream.write(': keepalive\n\n');
  }, 20000);
  heartbeat.unref();

  const create = async (path, name, machine = null) => {
    const taken = new Set([...live.keys(), ...trash.keys(), ...await readdir(dirs.projects), ...await readdir(dirs.trash)]);
    const root = slug(name) || 'project';
    let id = root;
    for (let i = 2; taken.has(id); i++) id = `${root}-${i}`;
    const createdAt = new Date().toISOString(), e = { id, name, path, createdAt, ...(machine ? { machine: machine.id, machineName: machine.name } : {}) }, temp = join(dirs.projects, `.new-${randomUUID()}`), dir = join(dirs.projects, id);
    // Проект собирается в .new-* и появляется одним rename: оборванное создание не оставляет полупроекта.
    try {
      await mkdir(temp);
      await writeJson(join(temp, 'project.json'), e);
      await writeJson(join(temp, 'graph.json'), seed.empty(createdAt));
      await writeJson(join(temp, 'chat.json'), { seq: 0, messages: [] });
      await retry(() => rename(temp, dir));
    } catch (error) { await rm(temp, { recursive: true, force: true }).catch(() => {}); throw error; }
    const p = project(e, dir, emit);
    await p.open(); live.set(id, p);
    await saveRegistry(); changed();
    return p;
  };

  return {
    get seq() { return seq; },
    streams,
    // Событие для всех открытых страниц: главной и каждого проекта (например, запрос доступа виртуальной машины).
    notify(event) {
      emit(event);
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const p of live.values()) for (const stream of p.sessions) stream.write(line);
    },
    list: () => visible().map(p => p.info()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    // Проект для маршрутов /api/p/<id>: id — только точный ключ реестра или корзины.
    route(id) {
      const p = ID.test(id) ? live.get(id) : undefined;
      if (p?.deleting) throw deleting();
      if (p && !p.gone) { if (p.error) throw new Problem(p.error, 503); return p; }
      const t = p ? { ...entry(p), deletedAt: p.gone } : ID.test(id) ? trash.get(id) : undefined;
      if (t) throw gone(t, 404);
      throw new Problem('Проект не найден.', 404);
    },
    // machine — id машины, из которой спрашивают (её папки — свои), null — основная машина.
    lookup(path, root, machine = null) {
      if (!absolute(path, machine) || (root !== null && !absolute(root, machine))) throw new Problem('Укажите полный путь папки.');
      const p = nearest(visible(), path, root, machine);
      if (p) return { project: p.info() };
      const t = nearest(removed(), path, root, machine);
      if (t) throw gone(t, 404);
      throw new Problem('Папка не подключена к Mycel.', 404);
    },
    // Найти или создать проект папки; с id — подключить существующий проект к новой папке (её перенесли). root — как
    // у lookup: подключённая или удалённая папка выше корня репозитория его не захватывает, репозиторий — свой проект.
    // machine — { id, name } машины с доступом: проект её папки; саму папку основная машина не проверяет.
    connect: (body, machine = null) => serial(async () => {
      const { path, id, move } = body, root = body.root ?? null, m = machine?.id ?? null;
      if (typeof path !== 'string' || !path) throw new Problem('Нет такой папки.');
      if (root !== null && (typeof root !== 'string' || !absolute(root, m))) throw new Problem('Укажите полный путь папки.');
      if (m ? !absolute(path, m) || /^(\/+|[a-zA-Z]:[\\/]*)$/.test(path) || path.length > 1000 : refusedPath(path)) throw new Problem('Это не папка проекта.');
      const real = m ? path.replace(/[\\/]+$/, '') : realDir(path);
      if (!m && !isDir(real)) throw new Problem('Нет такой папки.');
      const name = body.name == null ? null : typeof body.name === 'string' && body.name.trim() && body.name.trim().length <= 100 ? body.name.trim() : false;
      if (name === false) throw new Problem('Название проекта — от 1 до 100 символов.');
      const same = owner(real, m);
      // Название у уже подключённой папки — переименование: id, карта и папка проекта остаются прежними.
      const keep = async p => {
        if (!name || name === p.name) return { project: p.info(), created: false };
        p.name = name;
        await saveRegistry();
        if (!p.error) await writeJson(join(p.dir, 'project.json'), entry(p)).catch(e => log(`Не записан project.json проекта ${p.id}: ${e.message}`));
        changed();
        return { project: p.info(), created: false, renamed: true };
      };
      if (id != null) {
        const p = typeof id === 'string' && ID.test(id) ? live.get(id) : undefined;
        if (!p || p.gone) throw new Problem('Проект не найден.', 404);
        if (same === p) return keep(p);
        if (same) throw new Problem(`Папка уже подключена к проекту «${same.name}».`, 409);
        // Проект переезжает только в пределах своей машины; есть ли прежняя папка в виртуальной машине, основная не знает.
        if (!on(p, m)) throw new Problem(p.machine ? `Проект «${p.name}» — на машине «${p.machineName}»: переносить его можно только оттуда.` : `Проект «${p.name}» — на основной машине.`, 409);
        if ((m || isDir(p.path)) && move !== true) throw new Problem(`Проект подключён к ${p.path}.`, 409);
        p.path = real; if (name) p.name = name;
        await saveRegistry();
        if (!p.error) await writeJson(join(p.dir, 'project.json'), entry(p)).catch(e => log(`Не записан project.json проекта ${p.id}: ${e.message}`));
        changed();
        return { project: p.info(), created: false, moved: true };
      }
      if (same) return keep(same);
      if (body.new !== true) {
        const parent = nearest(visible(), real, root, m);
        if (parent) return { project: parent.info(), created: false, ancestor: true };
        const t = nearest(removed(), real, root, m);
        if (t) throw gone(t, 409);
      }
      return { project: (await create(real, name ?? real.split(/[\\/]/).filter(Boolean).pop().slice(0, 100), machine)).info(), created: true };
    }),
    // Удаление: записи дописываются, папка уезжает в корзину, и только тогда страницы и ожидающие агенты узнают, что
    // проекта нет. Пока это не решено, запросы к проекту получают 503 «повторите», ожидающие — тот же ответ, страницы
    // остаются открыты: если папка занята, проект работает дальше, и никто не услышал, что он удалён.
    remove: id => serial(async () => {
      const p = live.get(id);
      if (!p || p.gone) throw new Problem('Проект не найден.', 404);
      const deletedAt = new Date().toISOString(), wait = deleting();
      p.deleting = true;
      for (const finish of [...p.waiters.values()]) finish(503, { error: wait.message, ...wait.extra });
      await p.drain();
      const to = join(dirs.trash, id), exists = isDir(p.dir);
      try { if (exists) { await writeJson(join(p.dir, 'project.json'), { ...entry(p), deletedAt }); await retry(() => rename(p.dir, to)); } }
      catch (error) {
        log(`Проект ${id} не перенесён в корзину: ${error.message}`);
        await writeJson(join(p.dir, 'project.json'), entry(p)).catch(() => {});
        await p.open(); p.deleting = false;
        throw new Problem('Папка проекта занята, попробуйте ещё раз.', 409);
      }
      p.gone = deletedAt; p.deleting = false;
      live.delete(id);
      if (exists) trash.set(id, { ...entry(p), deletedAt });
      p.end(true);
      await saveRegistry(); changed();
      return { deleted: id };
    }),
    restore: id => serial(async () => {
      const t = trash.get(id);
      if (!t) throw new Problem('Проекта нет среди удалённых.', 404);
      const same = t.path && owner(t.path, t.machine ?? null);
      if (same) throw new Problem(`Папка уже подключена к проекту «${same.name}».`, 409);
      const dir = join(dirs.projects, id), e = entryOf(t);
      try { await retry(() => rename(join(dirs.trash, id), dir)); }
      catch (error) { log(`Проект ${id} не возвращён из корзины: ${error.message}`); throw new Problem('Папка проекта занята, попробуйте ещё раз.', 409); }
      trash.delete(id);
      await writeJson(join(dir, 'project.json'), e);
      const p = project(e, dir, emit);
      await p.open(); live.set(id, p);
      await saveRegistry(); changed();
      return { project: p.info() };
    }),
    async close() {
      if (!closing) { const pending = queue; closing = true; await pending; }
      clearInterval(purger); clearInterval(heartbeat);
      for (const stream of streams) stream.end();
      streams.clear();
      for (const p of live.values()) p.end(false);
      for (const p of live.values()) await p.drain().catch(e => log(`Проект ${p.id} закрыт с ошибкой: ${e.message}`));
    }
  };
}
