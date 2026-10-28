// The hub: the project registry, the trash and the working state of every open project (map, chat, waiting agents, SSE).
// Everything is in the app's data folder: projects.json, projects/<id>/, trash/<id>/; nothing is written to project folders.
// Registry changes go through one queue, so creating, deleting and moving never overlap.
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
// Windows does not let you rename a folder or file while another process holds it (antivirus, indexer): 20 tries, 100 ms apart.
async function retry(work) {
  for (let i = 0; ; i++) {
    try { return await work(); }
    catch (e) { if (i >= 19 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; await sleep(100); }
  }
}
// JSON is written in full or not at all: temporary file, sync, rename.
async function writeJson(file, value) {
  const temp = `${file}-${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await retry(() => rename(temp, file));
  } finally { await unlink(temp).catch(() => {}); }
}

// One hub per data folder. A lock is stale if its process is gone, or if it is older than 10 seconds and no Mycel with
// the same data answers on its port: Windows may have given the dead process's number to another program.
// Only whoever created server.lock.takeover removes a stale lock: otherwise two hubs started at once after a crash
// would both remove it and work on the same data. The others wait for the outcome and read the lock again. A takeover
// file left by a crashed process (older than 10 seconds) is deleted.
export async function lockHub(data, port) {
  const file = join(data, 'server.lock'), guardFile = `${file}.takeover`, mine = { pid: process.pid, port, data, startedAt: new Date().toISOString() };
  const take = () => writeFile(file, JSON.stringify(mine) + '\n', { flag: 'wx' }).then(() => true, e => { if (e.code === 'EEXIST') return false; throw e; });
  const busy = async () => new Error(`Mycel is already running: http://127.0.0.1:${(await readLock(file))?.port || 4317}`);
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
      // The lock may have changed during the check: only the one found stale is removed.
      const now = await readLock(file);
      if (now && (now.pid !== held?.pid || now.startedAt !== held?.startedAt)) continue;
      if (now) { log(`Removed the lock of a Mycel that has exited (pid ${now.pid ?? '?'}).`); await unlink(file).catch(() => {}); }
      if (await take()) break;
      throw await busy();
    } finally { await guard.close(); await unlink(guardFile).catch(() => {}); }
  }
  return {
    update: async actual => { mine.port = actual; await writeFile(file, JSON.stringify(mine) + '\n'); },
    // Someone else's lock (another hub may have taken it over) is not deleted.
    async release() { const held = await readLock(file); if (held?.pid === mine.pid && held.startedAt === mine.startedAt) await unlink(file).catch(() => {}); }
  };
}
async function readLock(file) {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    let v; try { v = /^\s*\d+\s*$/.test(text) ? { pid: Number(text) } : Object(JSON.parse(text)); } catch { v = {}; } // 0.9 wrote only the process number
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

// machine marks a virtual machine's project: the id of its key (src/access.mjs) and its name; path is then a path inside it.
const entryOf = v => v && typeof v === 'object' && ID.test(v.id) && typeof v.name === 'string' && v.name.trim() && (v.path == null || typeof v.path === 'string') && typeof v.createdAt === 'string'
  ? { id: v.id, name: v.name, path: v.path ?? null, createdAt: v.createdAt, ...(typeof v.machine === 'string' && v.machine ? { machine: v.machine.slice(0, 100), machineName: typeof v.machineName === 'string' ? v.machineName.slice(0, 60) : '' } : {}) } : null;
const entry = p => ({ id: p.id, name: p.name, path: p.path, createdAt: p.createdAt, ...(p.machine ? { machine: p.machine, machineName: p.machineName } : {}) });
// The main computer cannot see a virtual machine's folders: they are compared as strings without a trailing separator,
// Windows paths case-insensitively. Folders of the main computer are compared by the real path (src/paths.mjs).
const machineKey = path => { const p = path.replace(/[\\/]+$/, '') || path; return /^[a-zA-Z]:/.test(p) ? p.replace(/\\/g, '/').toLowerCase() : p; };
const keyOf = (path, machine) => machine ? machineKey(path) : pathKey(path);
const within = (child, parent, machine) => {
  if (!machine) return isInside(child, parent);
  const c = machineKey(child), p = machineKey(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
};
const absolute = (path, machine) => machine ? /^(\/|[a-zA-Z]:[\\/])/.test(path) : isAbsolute(path);
// project.json of a project or trash folder; the id must match the folder name.
async function own(dir) {
  try { const v = await readJson(join(dir, 'project.json')), e = entryOf(v); return e && e.id === basename(dir) ? { ...e, deletedAt: typeof v.deletedAt === 'string' ? v.deletedAt : null } : null; }
  catch { return null; }
}
const gone = (t, status) => Object.assign(new Problem(`Project "${t.name}" was deleted by the person.`, status), { extra: { deleted: { id: t.id, name: t.name, deletedAt: t.deletedAt } } });
// The project is being deleted right now, and the deletion may still fail (the folder is busy): the request is worth repeating.
const deleting = () => Object.assign(new Problem('The project is being deleted, repeat the request.', 503), { extra: { retry: true } });

// An open project: the map, events for agents, the person's focus and selection, the person's edits, agent presence and
// what agents are doing now, long requests and the SSE of its pages. The person talks to the agent in the agent's window,
// not here: events (chat.json) are only what the person did with Mycel buttons: finished edits, accepted or rejected a proposal.
function project(e, dir, emit) {
  const p = { ...e, dir, store: null, chat: null, error: null, gone: null, deleting: false, focus: null, selection: null, edit: null, activity: new Map(), sessions: new Set(), waiters: new Map(), agents: new Map(), cursors: Promise.resolve(),
    code: { stale: {}, risks: {} }, editing: new Map() };
  const editFile = join(dir, 'edit.json'), codeFile = join(dir, 'code.json');
  p.open = async () => {
    try {
      p.store = await openStore(dir, null, { lock: false }); p.chat = await openChat(dir); p.error = null;
      // The person's edits started before a restart stay started: the agent must not wake up halfway through.
      const edit = await readJson(editFile).catch(() => null);
      p.edit = Number.isSafeInteger(edit?.since) && edit.since <= p.store.peek().revision && typeof edit.at === 'string' ? { since: edit.since, at: edit.at } : null;
      const code = await readJson(codeFile).catch(() => null), table = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      p.code = { stale: table(code?.stale), risks: table(code?.risks) };
    }
    catch (error) { await p.store?.close().catch(() => {}); p.store = p.chat = null; p.error = error.message; log(`Project ${p.id} did not open: ${error.message}`); }
  };
  // What the agent is doing now ("reading server.mjs", optionally with a percentage): a line under the map. The agent
  // clears it itself; a forgotten one fades after 15 minutes.
  const STALE = 15 * 60e3;
  p.activityList = () => [...p.activity.values()].filter(a => Date.now() - Date.parse(a.at) < STALE);
  // blocks are the blocks the agent is working on (doing --on): the person and other agents see them. auto — the line
  // comes from the agent's hooks (its task list, the file it edits): it does not replace a line the agent set itself less
  // than 2 minutes ago, which says more, and keeps its blocks.
  p.setActivity = (actor, text, progress, blocks = [], auto = false) => {
    const was = p.activity.get(actor);
    if (auto && text && was && !was.auto && Date.now() - Date.parse(was.at) < 2 * 60e3) return;
    if (text) p.activity.set(actor, Object.assign({ actor, text, progress: progress ?? null, blocks: auto && was ? was.blocks : blocks, at: new Date().toISOString() }, auto ? { auto: true } : {}));
    else p.activity.delete(actor);
    p.broadcast();
  };
  // Code as Mycel sees it. Which files agents are editing now (the Claude Code hook after a file edit; in memory): the
  // block of those files is highlighted with the agent's name for 2 minutes after the last edit. Outdated blocks are those
  // whose files changed after the block was described; an agent's edit of the block or mycel fresh clears the flag. Risks
  // are what mycel health found. Outdated blocks and risks live in the project's code.json and survive a restart.
  const NOW = 2 * 60e3, BUSY = 10 * 60e3;
  let codeSaved = Promise.resolve();
  const saveCode = () => (codeSaved = codeSaved.then(() => writeJson(codeFile, p.code)).catch(e => log(`Code info of project ${p.id} not saved: ${e.message}`)));
  const liveIds = () => new Set(p.store.peek().nodes.map(n => n.id));
  // Who is working on which blocks: editing their files (within ms) or named them in doing --on.
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
  // Blocks other agents are working on now: whoever takes up the same ones is warned about them.
  p.others = (actor, ids) => {
    const want = new Set(ids), names = new Map(p.store.peek().nodes.map(n => [n.id, n]));
    return workOf(BUSY).filter(w => w.actor !== actor).flatMap(w => w.blocks.filter(id => want.has(id) && names.has(id)).map(id => ({ id, name: nodeName(names.get(id)), by: w.actor })));
  };
  // session is the agent's session (Claude Code): the reminder at the end of a reply covers only what it changed in this session.
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
    // Old edits are forgotten: only the agent's last 200 files are kept in memory.
    p.editing.set(actor, new Map([...mine].slice(-200)));
    if (touched.size) saveCode();
    p.broadcast();
    return { blocks: [...touched.values()].map(n => ({ id: n.id, name: nodeName(n) })), others: p.others(actor, [...touched.keys()]) };
  };
  // A block was described again or confirmed: the "outdated?" flag is cleared. Without ids, for all blocks.
  p.freshen = ids => {
    const all = ids === null, gone = Object.keys(p.code.stale).filter(id => all || ids.includes(id));
    for (const id of gone) delete p.code.stale[id];
    if (gone.length) { saveCode(); p.broadcast(); }
    return gone;
  };
  p.setRisks = risks => { p.code.risks = risks; saveCode(); p.broadcast(); };
  // Outdated flags and risks of deleted blocks are not shown.
  p.codeInfo = () => {
    const ids = liveIds(), keep = table => Object.fromEntries(Object.entries(table).filter(([id]) => ids.has(id)));
    return { stale: keep(p.code.stale), risks: keep(p.code.risks) };
  };
  // The person's edits: from which revision they started changing the map content, when, and how many entries they made since.
  // Until they click "Finish edits", their entries after since do not wake agents.
  const humanEdits = (graph, since) => graph.history.filter(h => h.revision > since && h.actor === 'human' && (!h.delta || touchesContent(h.delta)));
  p.editInfo = () => p.edit && p.store ? { ...p.edit, count: humanEdits(p.store.peek(), p.edit.since).length } : null;
  // An event for the project's open pages: the current map revision, the person's edits, connected agents, what they are
  // doing, and more (show is a block the agent asks to show).
  p.state = () => ({ revision: p.store.peek().revision, edit: p.editInfo(), agents: p.presence(), activity: p.activityList(), work: p.work(), code: p.codeInfo() });
  p.broadcast = (extra = {}) => {
    if (!p.store) return;
    const data = JSON.stringify({ ...p.state(), ...extra });
    for (const stream of p.sessions) stream.write(`data: ${data}\n\n`);
  };
  // A write by the person that changes content starts edits; the "Finish edits" button ends them. The file is written
  // one at a time and always with the current state: a late write of the start will not bring back edits already finished.
  let editSaved = Promise.resolve();
  const saveEdit = () => (editSaved = editSaved.then(() => p.edit ? writeJson(editFile, p.edit) : unlink(editFile).catch(e => { if (e.code !== 'ENOENT') throw e; }))
    .catch(e => log(`Edits of project ${p.id} not saved: ${e.message}`)));
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
  // Agents that contacted the project: whether the agent is waiting for changes now (with 5 seconds of slack between wait
  // requests) and when it was last seen. The interface shows this as a dot in the control bar and on the home page.
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
  // Changes after revision since, except those made by the author exclude (an agent does not wait for its own edits).
  // complete = false if the history does not cover this range: then the agent needs to read the whole map again.
  // chatSince is the event change number after which events are needed (except one's own and agent steps).
  // While the person edits the map, their entries since the start of the edits arrive but do not count as new (held):
  // an agent's wait does not wake on them; the "Map edits finished" message wakes it.
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
  // What the agent has read: the map revision and the chat change. Only the hub writes it, one at a time; values only
  // grow, so a late write of an old read does not roll the cursor back.
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
  // The project's pages and long requests are closed: on deletion with a message about it, on stop as usual.
  p.end = deleted => {
    for (const stream of p.sessions) { if (deleted) stream.write('data: {"deleted":true}\n\n'); stream.end(); }
    p.sessions.clear();
    for (const finish of [...p.waiters.values()]) deleted ? finish(404, { error: 'Project deleted.', deleted: true }) : finish();
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
    if (closing) return Promise.reject(new Problem('Mycel is stopping.', 503));
    const run = queue.then(work); queue = run.catch(() => {}); return run;
  };
  const changed = () => { seq += 1; emit({ projects: seq }); };
  const saveRegistry = async () => {
    await copyFile(registryFile, backupFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await writeJson(registryFile, { version: 1, projects: [...live.values()].map(entry) });
  };
  const visible = () => [...live.values()].filter(p => !p.gone);
  const removed = () => [...trash.values(), ...[...live.values()].filter(p => p.gone).map(p => ({ ...entry(p), deletedAt: p.gone }))];
  // Folders are compared only among projects of the same machine (null is the main computer).
  const on = (p, machine) => (p.machine ?? null) === machine;
  const owner = (path, machine = null) => { const key = keyOf(path, machine); return visible().find(p => p.path && on(p, machine) && keyOf(p.path, machine) === key) ?? null; };
  // The nearest project whose folder contains path; with root, only inside root, so that a connected folder higher up
  // does not capture a separate repository. Among deleted ones with the same folder, the latest.
  const nearest = (items, path, root = null, machine = null) => items.filter(p => p.path && on(p, machine) && within(path, p.path, machine) && (!root || within(p.path, root, machine)))
    .sort((a, b) => keyOf(b.path, machine).length - keyOf(a.path, machine).length || String(b.deletedAt).localeCompare(String(a.deletedAt)))[0] ?? null;

  // The registry: projects.json, and if it is damaged, its previous copy. A damaged file is set aside to
  // projects.broken.json so the next write does not overwrite the good copy with it. The trash comes from trash/*/project.json.
  let list = null, broken = false;
  for (const file of [registryFile, backupFile]) {
    try { const r = await readJson(file); if (r?.version !== 1 || !Array.isArray(r.projects)) throw new Error('unknown format'); list = r.projects; break; }
    catch (e) { if (e.code === 'ENOENT') continue; log(`Cannot read ${file}: ${e.message}`); if (file === registryFile) broken = true; }
  }
  if (broken) await rename(registryFile, join(data, 'projects.broken.json')).catch(e => log(`Could not set aside the damaged registry: ${e.message}`));
  for (const name of await readdir(dirs.trash)) { const t = await own(join(dirs.trash, name)); if (t) trash.set(t.id, t); }
  // Projects missing from the registry (a write was cut off) are restored from projects/<id>/project.json: an empty
  // registry is not accepted while project folders exist. Unfinished .new-* folders are left alone.
  const names = new Set(), found = [];
  for (const item of await readdir(dirs.projects, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    if (item.name.startsWith('.new-')) { log(`Skipped an unfinished project folder: ${join(dirs.projects, item.name)}`); continue; }
    names.add(item.name);
    const v = await own(join(dirs.projects, item.name)); if (v) found.push(v);
  }
  let dirty = broken || list === null;
  for (const raw of list ?? []) {
    const e = entryOf(raw);
    if (!e || live.has(e.id)) { log(`Skipped a registry entry: ${JSON.stringify(raw)}`); dirty = true; continue; }
    // The deletion managed to move the folder to the trash but not to write the registry.
    if (!names.has(e.id) && trash.has(e.id)) { dirty = true; continue; }
    live.set(e.id, project(e, join(dirs.projects, e.id), emit));
  }
  for (const v of found) if (!live.has(v.id)) { log(`Project ${v.id} returned to the registry from project.json.`); live.set(v.id, project(entryOf(v), join(dirs.projects, v.id), emit)); dirty = true; }
  if (dirty) await saveRegistry();
  // A project that did not open is listed with its error and its files are not written; the hub works anyway.
  for (const p of live.values()) await p.open();

  // What the person deleted is kept for a week; entries without a deletion date are left alone.
  const purge = () => serial(async () => {
    for (const t of [...trash.values()]) {
      if (!(Date.now() - Date.parse(t.deletedAt) > WEEK)) continue;
      try { await rm(join(dirs.trash, t.id), { recursive: true, force: true, maxRetries: 5 }); trash.delete(t.id); log(`Removed project ${t.id} ("${t.name}") from the trash.`); }
      catch (e) { log(`Could not remove ${t.id} from the trash: ${e.message}`); }
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
    // The project is assembled in .new-* and appears with one rename: an interrupted creation leaves no half-made project.
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
    // An event for all open pages: the home page and every project (for example, a virtual machine's access request).
    notify(event) {
      emit(event);
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const p of live.values()) for (const stream of p.sessions) stream.write(line);
    },
    list: () => visible().map(p => p.info()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    // The project for /api/p/<id> routes: id is only an exact key of the registry or the trash.
    route(id) {
      const p = ID.test(id) ? live.get(id) : undefined;
      if (p?.deleting) throw deleting();
      if (p && !p.gone) { if (p.error) throw new Problem(p.error, 503); return p; }
      const t = p ? { ...entry(p), deletedAt: p.gone } : ID.test(id) ? trash.get(id) : undefined;
      if (t) throw gone(t, 404);
      throw new Problem('Project not found.', 404);
    },
    // machine is the id of the machine asking (its folders are its own), null is the main computer.
    lookup(path, root, machine = null) {
      if (!absolute(path, machine) || (root !== null && !absolute(root, machine))) throw new Problem('Give the full path of the folder.');
      const p = nearest(visible(), path, root, machine);
      if (p) return { project: p.info() };
      const t = nearest(removed(), path, root, machine);
      if (t) throw gone(t, 404);
      throw new Problem('The folder is not connected to Mycel.', 404);
    },
    // Find or create the folder's project; with id, connect an existing project to a new folder (it was moved). root works
    // as in lookup: a connected or deleted folder above the repository root does not capture it, the repository is its own project.
    // machine is { id, name } of a machine with access: the project of its folder; the main computer does not check the folder itself.
    connect: (body, machine = null) => serial(async () => {
      const { path, id, move } = body, root = body.root ?? null, m = machine?.id ?? null;
      if (typeof path !== 'string' || !path) throw new Problem('No such folder.');
      if (root !== null && (typeof root !== 'string' || !absolute(root, m))) throw new Problem('Give the full path of the folder.');
      if (m ? !absolute(path, m) || /^(\/+|[a-zA-Z]:[\\/]*)$/.test(path) || path.length > 1000 : refusedPath(path)) throw new Problem('This is not a project folder.');
      const real = m ? path.replace(/[\\/]+$/, '') : realDir(path);
      if (!m && !isDir(real)) throw new Problem('No such folder.');
      const name = body.name == null ? null : typeof body.name === 'string' && body.name.trim() && body.name.trim().length <= 100 ? body.name.trim() : false;
      if (name === false) throw new Problem('Project name: 1 to 100 characters.');
      const same = owner(real, m);
      // A name for a folder that is already connected means renaming: the project's id, map and folder stay the same.
      const keep = async p => {
        if (!name || name === p.name) return { project: p.info(), created: false };
        p.name = name;
        await saveRegistry();
        if (!p.error) await writeJson(join(p.dir, 'project.json'), entry(p)).catch(e => log(`project.json of project ${p.id} not saved: ${e.message}`));
        changed();
        return { project: p.info(), created: false, renamed: true };
      };
      if (id != null) {
        const p = typeof id === 'string' && ID.test(id) ? live.get(id) : undefined;
        if (!p || p.gone) throw new Problem('Project not found.', 404);
        if (same === p) return keep(p);
        if (same) throw new Problem(`The folder is already connected to project "${same.name}".`, 409);
        // A project moves only within its own machine; the main computer does not know whether the old folder still exists in a virtual machine.
        if (!on(p, m)) throw new Problem(p.machine ? `Project "${p.name}" is on machine "${p.machineName}": it can only be moved from there.` : `Project "${p.name}" is on the main computer.`, 409);
        if ((m || isDir(p.path)) && move !== true) throw new Problem(`The project is connected to ${p.path}.`, 409);
        p.path = real; if (name) p.name = name;
        await saveRegistry();
        if (!p.error) await writeJson(join(p.dir, 'project.json'), entry(p)).catch(e => log(`project.json of project ${p.id} not saved: ${e.message}`));
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
    // Deletion: writes finish, the folder moves to the trash, and only then do pages and waiting agents learn that the
    // project is gone. Until this is settled, requests to the project get 503 "repeat", waiting ones get the same answer,
    // pages stay open: if the folder is busy, the project keeps working and nobody heard that it was deleted.
    remove: id => serial(async () => {
      const p = live.get(id);
      if (!p || p.gone) throw new Problem('Project not found.', 404);
      const deletedAt = new Date().toISOString(), wait = deleting();
      p.deleting = true;
      for (const finish of [...p.waiters.values()]) finish(503, { error: wait.message, ...wait.extra });
      await p.drain();
      const to = join(dirs.trash, id), exists = isDir(p.dir);
      try { if (exists) { await writeJson(join(p.dir, 'project.json'), { ...entry(p), deletedAt }); await retry(() => rename(p.dir, to)); } }
      catch (error) {
        log(`Project ${id} not moved to the trash: ${error.message}`);
        await writeJson(join(p.dir, 'project.json'), entry(p)).catch(() => {});
        await p.open(); p.deleting = false;
        throw new Problem('The project folder is busy, try again.', 409);
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
      if (!t) throw new Problem('The project is not in the trash.', 404);
      const same = t.path && owner(t.path, t.machine ?? null);
      if (same) throw new Problem(`The folder is already connected to project "${same.name}".`, 409);
      const dir = join(dirs.projects, id), e = entryOf(t);
      try { await retry(() => rename(join(dirs.trash, id), dir)); }
      catch (error) { log(`Project ${id} not restored from the trash: ${error.message}`); throw new Problem('The project folder is busy, try again.', 409); }
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
      for (const p of live.values()) await p.drain().catch(e => log(`Project ${p.id} closed with an error: ${e.message}`));
    }
  };
}
