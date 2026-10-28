// Mycel for agents: connecting a project folder, reading the map, changes since the last read, waiting for others'
// edits and chat messages, replies and task statuses, batches and building a structure. One hub (server.mjs) serves all
// projects; if it is not running, the command starts it in the background. The hub keeps what the agent has read (the map
// revision and the chat change), and writes go only on top of what was read: if the map changed, the command prints the changes.
import { readFile, mkdir, stat, readdir, writeFile, unlink } from 'node:fs/promises';
import { readFileSync, openSync, closeSync, statSync, readlinkSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

// Before Mycel's modules: on an old Node they would fail with an unclear error. So that the check gets to run, this file
// itself is written without syntax newer than ES2020 (no ??= and the like): otherwise Node 14 would not parse it at all.
if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Node.js 22+ is needed: https://nodejs.org'); process.exit(1); }
const appRoot = dirname(fileURLToPath(import.meta.url));
const [{ applyOperations, Problem }, { slug }, { projectRoot, pathKey, defaultData }, { renderGuide, editingLine }, { levelProblems, levelReport }] = await Promise.all(['./src/model.mjs', './src/slug.mjs', './src/paths.mjs', './src/guide.mjs', './src/levels.mjs'].map(m => import(m)));
const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));

const usage = `Mycel for agents: node mycel.mjs <command> [options]

  init [folder]        Connect a project (the current folder by default). The root is the nearest folder with .git; for
                       a git worktree, the main repository. The same folder is the same project with its map, a
                       subfolder of a connected folder is its project, otherwise a new one.
                       --name N: the name (for an already connected folder, renames the project); --project ID:
                       connect project ID to this folder (its folder was moved);
                       --move: even if the old folder exists; --new: a new project in any case.
  projects             All projects: id · name · folder.
  open                 Start Mycel if it is not running, and open it in the browser. A Mycel of an older version with
                       the same data is restarted.
  start                Start Mycel if it is not running, and print its address.
  stop                 Stop Mycel.
  guide                The agent guide.

  context [--focus ID] The whole map in Markdown: what the person selected and which block they work in, their new
                       actions in Mycel. Remembers what was read. With --focus, only that block with everything nested
                       and its links to the rest of the map; with --brief, without coordinates and sizes.
  graph                The whole map in JSON. Remembers the revision read.
  changes              What others changed since the last read: the map and the person's actions.
  wait [--timeout S]   Waits for a person's action in Mycel (finished edits, decided on a proposal) or a content edit
                       of the map by others, prints it and exits (without S, no time limit). Moves and sizes do not
                       wake it but arrive with the next edit; --all wakes on any edit.
  selection            What the person has selected on the map now and which block they work in, with full text.
  apply <file|->       A batch of operations: { "message", "operations" } or an array of operations.
  build <file|->       A whole structure: blocks with sub-maps, notes, links; without x and y everything is placed
                       automatically. Written in steps so the map is seen growing; --at-once writes one record.
                       Blocks, notes and links already written are skipped: an interrupted build can be repeated.
                       apply, build and propose check the Concept and Mechanics levels before writing: short, no code,
                       files or names from code; --no-check skips it, only if the person asked for such text.
  propose <file|->     A proposal to the person: a structure as for build and/or "operations" as for apply; "title" is
                       its name. New items appear dashed and highlighted, changed ones are highlighted, deletion is
                       only flagged; the person accepts or rejects. The next propose extends the open one.
  mark <id[,id…]> <plan|testing|passed|failed|none>
                       Mark blocks: plan, logic without finished code (dashed); testing, a check is running now
                       (the border pulses); passed, code written and tests passed (green border); failed, the check
                       failed (red); none clears it. The person sees each change at once: mark each result as it comes.
  doing <text>         What you are doing now ("reading server.mjs"): the line under the map. --progress N: how much is
                       done, 0–100; --on id,…: which blocks you are working on (the person and other agents see them);
                       doing --done clears it when you finish.
  show <id>            Show the person a block: the map moves to it and selects it.

  check [id[,id…]]     Run the check commands (the test field) of the blocks and everything nested (without id, of the
                       whole map): borders turn green and red as it goes. --timeout S per command, 600 by default.
  touch <file…>        Files you are changing: their blocks become "being edited" and "possibly outdated".
  fresh <id[,id…]>     The blocks' description is right: clear "possibly outdated" (--all for all).
  review               What changed in how the project works, by concept: --hours N (24 by default) or
                       --since revision.
  health               Map health: failed, outdated, unchecked, plan, TODOs and things that look like keys in the
                       blocks' files (only file and line; .env is not read). --no-scan: without reading files.
  overview             A short overview of the map (the hook gives the same to the agent at session start).
  hook                 Claude Code hook: event JSON on standard input (installed by the plugin).
  plugin [--install]   Build the Claude Code plugin for this computer (MCP, hooks, skill); --install also connects it
                       (claude from PATH or from the Claude Code session; --claude path), without it prints the commands.
                       --agent <name>: the MCP server entry for another agent: codex, cursor, antigravity,
                       gemini, vscode, windsurf, cline, claude-desktop, lmstudio, continue, goose, opencode,
                       jan, openwebui.

  remote [on|off]      Access for virtual machines: Mycel accepts their requests on the address of their network
                       (VMware, VirtualBox, Hyper-V, WSL; --address for your own) and only with a key. Without options:
                       what is open, machines with access and the install command for the agent there; revoke <id>
                       revokes a machine key; --key prints the main computer's key.
  join <address> [key] In a virtual machine: connect this Mycel copy to Mycel on the main computer. Without a key, an
                       access request with a code: the person presses "Allow" in Mycel and the machine gets its own key
                       (waits up to 10 minutes, --timeout). --project id: the project for commands. join --off disconnects.

  --url URL            Mycel address; by default MYCEL_URL, the address from join or http://127.0.0.1:4317.
  --token KEY          Key for Mycel on another machine; by default MYCEL_TOKEN or the key from join.
  --data folder        Data folder; by default MYCEL_DATA or .mycel next to mycel.mjs.
  --project ID         Project for map commands; by default MYCEL_PROJECT, the project from join or of the current folder.
  --actor NAME         Who makes the changes; by default MYCEL_ACTOR; in Claude Code claude, otherwise agent.
  --no-start           Do not start Mycel if it is not running.
  -m, --message TEXT   Reason for the change for apply, build and mark; the name for propose.`;

const flags = ['--all', '--brief', '--no-start', '--at-once', '--move', '--new', '--no-check', '--done', '--no-scan', '--off', '--key', '--install', '--short'];
const args = process.argv.slice(2), options = {}, rest = [];
let missing = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (flags.includes(a)) options[a.slice(2)] = true;
  else if (a === '-m' || (a.startsWith('--') && a.length > 2)) { const v = args[++i]; if (v === undefined && missing === null) missing = a; options[a === '-m' ? 'message' : a.slice(2)] = v; }
  else rest.push(a);
}
const [command, input] = rest;
// Environment variables are MYCEL_*; the old KONTUR_* are read too.
const env = name => process.env[`MYCEL_${name}`] || process.env[`KONTUR_${name}`];
// An explicitly given data folder must match the running hub's data: otherwise the agent would read other projects.
const explicitData = options.data || env('DATA') || null;
let data = resolve(explicitData ?? defaultData(appRoot));
// A Mycel copy in a virtual machine connected to Mycel on the main computer (mycel join): the address, key and project
// are in <data>/remote.json. An explicit address (--url, MYCEL_URL) does not use it.
const joined = (() => {
  if (options.url || env('URL')) return null;
  try { const v = JSON.parse(readFileSync(join(data, 'remote.json'), 'utf8')); return typeof v.url === 'string' && typeof v.token === 'string' ? v : null; } catch (e) { return null; }
})();
const base = (() => { try { return new URL(options.url || env('URL') || (joined ? joined.url : 'http://127.0.0.1:4317')); } catch (e) { return null; } })();
const origin = base?.origin, port = Number(base?.port || 80);
// Mycel on this computer or on another one in the local network (the main computer for a virtual one). On another one,
// only with a key: the token is not handed out over the network; join, --token or MYCEL_TOKEN give it.
const privateHost = host => /^(10\.\d+|127\.\d+|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)\.\d+\.\d+$/.test(host) || /\.local$/i.test(host);
const loopback = Boolean(base) && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), remote = Boolean(base) && !loopback;
// Claude Code signs itself: its commands run with the CLAUDECODE variable.
let actor = options.actor || env('ACTOR') || (process.env.CLAUDECODE ? 'claude' : 'agent');
const launcher = join(appRoot, process.platform === 'win32' ? 'Mycel.cmd' : 'Mycel.command');
let project = null, token = options.token || env('TOKEN') || (joined ? joined.token : null) || null;

// Exiting with a code is an exception up to the end of the file: output to a pipe gets written in full, unlike with process.exit.
class Exit { constructor(code) { this.code = code; } }
const quit = code => { throw new Exit(code); };
function fail(message, code = 1) { console.error(message); quit(code); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Every request is signed with the agent's name: this is how the person sees that the agent is connected. While the person
// deletes a project, the hub answers 503 with retry: the deletion may fail (the folder is busy), so the request is repeated
// until the outcome (up to 10 s).
async function call(path, body) {
  if (body && token === null) token = (await call('/api/session')).value.token;
  // Mycel on another machine requires the key for reading too.
  const headers = { 'X-Mycel-Actor': actor, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token !== null && (body || remote) ? { Authorization: `Bearer ${token}` } : {}) };
  for (let i = 0; ; i++) {
    const res = await fetch(new URL(path, base), body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    const type = res.headers.get('content-type') ?? '', value = type.includes('json') ? await res.json() : await res.text();
    if (res.status !== 503 || value?.retry !== true || i >= 50) return { status: res.status, value };
    await sleep(200);
  }
}
const deletedText = name => `Project "${name}" was deleted by the person. Connect it again only at their request: mycel init --new.`;
// The response to a project request. A project deleted by the person gives a separate message and an exit, with no retries.
function ok({ status, value }) {
  if (status === 404 && value?.deleted) fail(deletedText(value.deleted.name ?? project?.name));
  if (status !== 200) fail(`Error ${status}: ${value?.error ?? value}`);
  return value;
}

// Who answers at the address: null means nobody, { foreign: true } means not Mycel, otherwise the /api/health response.
async function health(ms = 3000) {
  try {
    const res = await fetch(new URL('/api/health', base), { signal: AbortSignal.timeout(ms) });
    const value = (res.headers.get('content-type') ?? '').includes('json') ? await res.json().catch(() => null) : await res.text().then(() => null);
    return res.ok && value?.ok === true ? value : { foreign: true };
  } catch { return null; }
}
// A Mycel of another version can be stopped too: this is how it is updated. The command is given in full: node may not be on PATH.
// Before 0.15 the program was called Kontur (app: 'kontur'): such a hub is an older version.
const ours = app => app === 'mycel' || app === 'kontur';
function check(h, stopping = false) {
  if (h.foreign || (h.app && !ours(h.app))) fail(`Something other than Mycel answers at ${origin}.`);
  if (!h.app) fail(`An old version of Mycel is running at ${origin}: stop it.`);
  if (explicitData && !remote && (typeof h.data !== 'string' || pathKey(h.data) !== pathKey(data))) fail(`Mycel with other data is running at ${origin}: ${h.data}`);
  if (!stopping && h.version !== version) fail(remote ? `The Mycel version at ${origin} (${h.version}) differs from the one here (${version}): update the copy here with curl -fsS ${origin}/install.sh | sh (the connection is kept).` : `Mycel was updated: restart it ("${process.execPath}" "${join(appRoot, 'mycel.mjs')}" stop, then ${launcher}).`);
}
// Stop and wait until the process releases the port and the lock: the next start must not find a hub on its way out.
async function stopHub(h) {
  const pid = typeof h.data === 'string' ? await lockPid(h.data) : null, res = await call('/api/stop', {});
  if (res.status === 200) for (const end = Date.now() + 5000; Date.now() < end && (await health(500) || (pid && alive(pid))); ) await sleep(100);
  return res;
}
async function ensure() {
  let h = await health();
  // Mycel on another machine cannot be started from here.
  if (!h && remote) fail(`Mycel at ${origin} does not answer. It must be running on the main computer with access open (node mycel.mjs remote on), and the firewall must let node through.`);
  if (!h && !options['no-start']) { h = await launch(); if (!h) fail(await notRunning(true)); }
  if (!h) fail(await notRunning(false));
  check(h);
  return h;
}
// The hub keeps running in the background after the agent exits; its output goes to <data>/server.log. The agent's
// variables are not passed to it: the port and data folder are given explicitly. A hub of an older version may have just
// stopped: its .kontur can now be moved.
async function launch() {
  try {
    if (!explicitData) data = resolve(defaultData(appRoot));
    await mkdir(data, { recursive: true });
    const log = openSync(join(data, 'server.log'), 'a');
    try {
      const drop = ['URL', 'ACTOR', 'DATA'].flatMap(k => [`MYCEL_${k}`, `KONTUR_${k}`]).concat('CLAUDECODE');
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.includes(k.toUpperCase())));
      const child = spawn(process.execPath, [join(appRoot, 'server.mjs'), '--port', String(port), '--data', data], { cwd: appRoot, detached: true, windowsHide: true, stdio: ['ignore', log, log], env });
      child.on('error', () => {}); child.unref();
    } finally { closeSync(log); }
  } catch { return null; }
  // The full 5 seconds, even if the process has already exited: a hub started by another agent may have got ahead of it.
  for (const end = Date.now() + 5000; Date.now() < end; ) {
    await sleep(100);
    const h = await health(1000);
    if (h) { if (h.app === 'mycel') console.error(`Started Mycel: ${origin}`); return h; }
  }
  return null;
}
async function lockPid(dir = data) {
  try {
    const text = await readFile(join(dir, 'server.lock'), 'utf8'), v = /^\s*\d+\s*$/.test(text) ? { pid: Number(text) } : JSON.parse(text);
    return Number.isSafeInteger(v?.pid) && v.pid > 0 ? v.pid : null;
  } catch { return null; }
}
// In a sandbox without network the hub may be running but unreachable for this command.
async function notRunning(started) {
  const pid = await lockPid(), sandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1' && 'In a sandbox without network, run Mycel commands with network permission.';
  if (pid && alive(pid)) return [`Mycel is running (pid ${pid}) but does not answer at ${origin}`, sandbox].filter(Boolean).join('\n');
  const tail = started ? (await readFile(join(data, 'server.log'), 'utf8').catch(() => '')).trim().split(/\r?\n/).slice(-3).join('\n') : '';
  return [`Mycel is not running. Ask the person to open ${launcher}.`, tail, sandbox].filter(Boolean).join('\n');
}

// The command's project: --project or the project of the folder it runs in (from any subfolder). In a repository the
// search does not go above its root: a connected folder above does not capture a separate repository. From a git
// worktree, the same folder of the main working tree is looked up. A copy in a virtual machine looks up the projects of
// its own folders (init there creates them marked with the machine), and if the folder is not connected, takes the
// project chosen at join.
const projectId = () => options.project || env('PROJECT') || null;
async function resolveProject() {
  const { root, git, path } = projectRoot(process.cwd()), id = projectId();
  let res = await call(id ? `/api/p/${encodeURIComponent(id)}` : `/api/projects?${new URLSearchParams({ path, ...(git ? { root } : {}) })}`);
  if (!id && res.status === 404 && !res.value?.deleted && joined && joined.project) res = await call(`/api/p/${encodeURIComponent(joined.project)}`);
  if (res.status === 404 && res.value?.deleted) fail(deletedText(res.value.deleted.name));
  if (res.status === 404) fail(id ? `There is no project ${id}: see mycel projects for the list.` : remote ? `The folder is not connected to Mycel at ${origin}: ${root}. Run mycel init in the project root (the project appears there marked with this machine) or pass --project <id> (list: mycel projects).` : `The folder is not connected to Mycel: ${root}. Run mycel init in the project root.`);
  const p = ok(res).project;
  if (p.error) fail(`Project "${p.name}" cannot be opened: ${p.error}`);
  return p;
}
const at = path => `/api/p/${project.id}${path}`;
// The project folder on this machine: in a virtual machine the project folder of the main computer is not visible, so the
// root of the current folder is used.
const here = () => {
  // The files of a virtual machine's project are there: checks and risk scans run on it.
  if (project.machine && !remote) fail(`The files of project "${project.name}" are on machine "${project.machine.name}": run this there.`);
  return isDir(project.path) ? project.path : projectRoot(process.cwd()).root;
};
// The hub keeps what the agent has read, separately for each actor; the values only grow.
const readCursor = async () => ok(await call(at(`/cursor?actor=${encodeURIComponent(actor)}`)));
const saveCursor = async patch => ok(await call(at('/cursor'), { actor, ...patch }));
async function needCursor() {
  const cursor = await readCursor();
  if (cursor.revision === null) fail('Read the map first: mycel context');
  return cursor;
}
async function readText(source) {
  if (source !== '-') return readFile(source, 'utf8').catch(e => fail(`Cannot read file ${source}: ${e.code ?? e.message}`));
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
async function readInput(source = input) {
  if (!source) fail('Give a JSON file or - for standard input.');
  const text = await readText(source);
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) { fail(`Invalid JSON: ${e.message}`); }
}

const short = line => { if (line.length <= 40) return line; const cut = line.slice(0, 40), space = cut.lastIndexOf(' '); return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`; };
const namer = graph => id => { const n = graph.nodes.find(x => x.id === id); return n ? `"${n.title || short(n.text.trim().split('\n')[0]) || 'untitled'}" (${id})` : `(${id})`; };

// The person's actions in Mycel (and the old conversation of projects that had a chat): who, when, about which blocks, the text.
const statusNames = { new: 'new', working: 'in progress', done: 'done' };
const who = author => author === 'human' ? 'Person' : author;
function formatChat(messages, graph) {
  const name = namer(graph);
  return messages.flatMap(m => {
    const time = new Date(m.updatedAt && m.updatedBy !== m.author ? m.updatedAt : m.at).toLocaleString('en-GB');
    if (m.task && m.updatedBy !== m.author) return [`- ${m.id} · ${who(m.updatedBy)} · ${time}: task status: ${statusNames[m.status]}${m.status === 'working' && m.progress !== null ? `, ${m.progress} %` : ''}${m.step ? `: ${m.step}` : ''}`, `  ${short(m.text.split('\n')[0])}`];
    // The person pressed "Finish edits": their map records since the edits started, as one batch.
    if (m.kind === 'edits') return [`- ${m.id} · ${who(m.author)} · ${time}: map edits finished: their records after revision ${m.edits.since} (up to ${m.edits.until}), ${m.edits.count} in total. What changed is below. Take it into account; if the edits contain a request, do it and briefly tell the person what you did.`];
    // The person's decision on an agent proposal; their edits in the proposal are below, in the map changes.
    if (m.kind === 'proposal') return [`- ${m.id} · ${who(m.author)} · ${time}: ${m.proposal.result === 'accepted'
      ? `accepted the proposal "${m.proposal.title}"${m.proposal.edits ? ' with their own edits' : ''}. Accepted blocks are a plan (dashed) until the code is written and checked: implement them if the person asked for the change itself, and mark the test results (mycel mark).`
      : `rejected the proposal "${m.proposal.title}": the map is back to what it was. Ask the person what to change if it is unclear.`}`];
    // The person pressed "Check" on a block: the agent does the check.
    if (m.kind === 'check') return [`- ${m.id} · ${who(m.author)} · ${time}: asks to check ${m.check.ids.map(name).join(', ')}. Run mycel check ${m.check.ids.join(',')} (in MCP, mycel_check) and briefly tell the person the result; if a block has no check command, add one (the test field).`];
    const meta = [m.id, who(m.author), time, m.task && `task (${statusNames[m.status]})`, m.replyTo && `reply to ${m.replyTo}`, m.nodes.length && `about blocks ${m.nodes.map(name).join(', ')}`].filter(Boolean).join(' · ');
    return [`- ${meta}`, ...m.text.split('\n').map(line => `  ${line}`)];
  }).join('\n');
}

// Changes in a form convenient for an agent to read: History records, then the full content of what was added and changed.
const fieldNames = { title: 'title', text: 'text', color: 'color', parentId: 'level', attachedTo: 'attachment', collapsed: 'collapsing', x: 'position', y: 'position', w: 'size', h: 'size', type: 'type', source: 'start', target: 'end', label: 'label', status: 'mark', proposed: 'proposal' };
const markNames = { plan: 'planned, no code yet', testing: 'checking now', passed: 'passed', failed: 'failed' }, proposedNames = { add: 'add', change: 'change', remove: 'remove' };
function formatChanges(res, graph) {
  const name = namer(graph);
  const lines = [`Map changes after revision ${res.since}, now revision ${res.revision}:`];
  for (const e of res.entries) lines.push(`- r${e.revision} ${e.actor}, ${new Date(e.at).toLocaleString('en-GB')}: ${e.message}${e.changes.length > 1 || e.changes[0] !== e.message ? ` — ${e.changes.join('; ')}` : ''}`);
  if (!res.complete) { lines.push('', 'History does not cover the whole range: read the whole map again (mycel context).'); return lines.join('\n'); }
  const where = n => [n.type === 'note' ? 'note' : 'block', n.parentId ? `inside ${name(n.parentId)}` : 'on the main map', n.attachedTo && `attached to ${name(n.attachedTo)}`, n.collapsed && 'sub-map collapsed',
    n.status && markNames[n.status], n.proposed && `proposed: ${proposedNames[n.proposed]}`].filter(Boolean).join(', ');
  const full = n => [`### ${n.title || (n.type === 'note' ? 'Note' : 'Untitled')} (id: ${n.id}) — ${where(n)}${n.fields ? `; changed: ${[...new Set(n.fields.map(f => fieldNames[f] ?? f))].join(', ')}` : ''}`, n.text].filter(Boolean).join('\n');
  const layoutOnly = n => n.fields.every(f => ['x', 'y', 'w', 'h', 'collapsed'].includes(f));
  const { nodes, edges } = res;
  if (nodes.added.length) lines.push('', 'Added:', ...nodes.added.map(full));
  const content = nodes.updated.filter(n => !layoutOnly(n)), moved = nodes.updated.filter(layoutOnly);
  if (content.length) lines.push('', 'Changed (current content):', ...content.map(full));
  if (moved.length) lines.push('', `Only position, size or collapsing: ${moved.map(n => name(n.id)).join(', ')}`);
  if (nodes.removed.length) lines.push('', `Deleted: ${nodes.removed.map(n => `${n.type === 'note' ? 'note' : 'block'} "${n.name}" (${n.id})`).join(', ')}`);
  const edge = (e, mark) => `${mark} ${name(e.source)} → ${name(e.target)}${e.label ? `: ${e.label}` : ''}${e.fields ? ` [changed: ${e.fields.map(f => fieldNames[f]).join(', ')}]` : ''}`;
  const edgeLines = [...edges.added.map(e => edge(e, '+')), ...edges.updated.map(e => edge(e, '~')), ...edges.removed.map(e => edge(e, '−'))];
  if (edgeLines.length) lines.push('', 'Links:', ...edgeLines);
  return lines.join('\n');
}
// Mycel has no chat: the person talks to the agent in the agent's window, and Mycel reports only what the person did on the map.
const chatHeader = 'The person in Mycel:';
// Prints what is new in the chat and on the map and moves the read mark. The move comes before printing: if the output is
// cut (head, Select-Object -First) and the process is interrupted, the same message does not come a second time; the guide
// asks to read the output in full.
async function report(res) {
  const graph = ok(await call(at('/graph'))), parts = [];
  // "Map edits finished" brings all the person's edits since they started, even if the agent already saw some in changes.
  const from = Math.min(res.since, ...(res.chat?.messages ?? []).map(m => m.kind === 'edits' ? m.edits.since : m.proposal?.edits?.since).filter(Number.isInteger));
  const map = from < res.since ? ok(await call(at(`/changes?since=${from}&exclude=${encodeURIComponent(actor)}`))) : res;
  if (res.focus && (res.chat?.messages.length || res.entries.length)) parts.push(`The person is focused on ${namer(graph)(res.focus)}: work within it (mycel context --focus ${res.focus}).`);
  if (res.chat?.messages.length) parts.push(`${chatHeader}\n${formatChat(res.chat.messages, graph)}`);
  if (res.edit) parts.push(editingLine(res.edit));
  if (map.entries.length || !map.complete) parts.push(formatChanges(map, graph));
  await saveCursor({ revision: res.revision, ...(res.chat ? { chat: res.chat.seq } : {}) });
  console.log(parts.join('\n\n') || `No other changes, revision ${res.revision}.`);
}
const changesUrl = (cursor, extra = '') => at(`/changes?since=${cursor.revision}&exclude=${encodeURIComponent(actor)}&chat=${cursor.chat}${extra}`);
// The map was changed after the agent's read: instead of writing, the changes; the read mark moves past them.
async function conflict(since) {
  console.log('The map changed after your last read. The changes are below; take them into account and repeat the write.\n');
  await report(ok(await call(at(`/changes?since=${since}&exclude=${encodeURIComponent(actor)}`))));
  quit(1);
}
// The result of a write: own revisions (others' between them are not included: "1, 3–4") and History lines of own writes
// (up to 50). Moves and sizes from layout are one line: neighbours move apart on every build, and the agent does not need
// them by name.
async function written(revisions, after = []) {
  const mine = new Set(revisions), all = ok(await call(at('/history'))).history.filter(h => mine.has(h.revision)).reverse().flatMap(h => h.changes);
  const layout = line => /^(Moved|Changed size of) (block|note) ".*"$/.test(line), moved = new Set(all.filter(layout)).size;
  const changes = [...all.filter(line => !layout(line)), ...(moved ? [`Layout: nodes moved or resized: ${moved}`] : [])];
  const runs = revisions.reduce((list, r) => { const last = list[list.length - 1]; if (last && r === last[1] + 1) last[1] = r; else list.push([r, r]); return list; }, []);
  console.log([`Written, ${revisions.length === 1 ? 'revision' : 'revisions'} ${runs.map(([a, b]) => a === b ? a : `${a}–${b}`).join(', ')}.`, ...changes.slice(0, 50).map(c => `- ${c}`), ...(changes.length > 50 ? [`- … ${changes.length - 50} more`] : []), ...after].join('\n'));
}
// The Concept and Mechanics levels are read by people who do not program: a batch with code, files, names from code or
// long texts on them is not written at all (src/levels.mjs). Only what the batch adds or changes is checked.
function checkLevels(graph, operations) {
  if (options['no-check']) return;
  const problems = levelProblems(graph, operations);
  if (problems.length) fail(levelReport(problems));
}
async function write(message, operations) {
  const { revision } = await needCursor();
  // Depths come from the map the agent read. If it has already changed, the write would fail anyway: the changes right away.
  if (!options['no-check']) {
    const current = ok(await call(at('/graph')));
    if (current.revision !== revision) await conflict(revision);
    checkLevels(current, operations);
  }
  const res = await call(at('/changes'), { expectedRevision: revision, actor, message, operations });
  if (res.status === 409) await conflict(revision);
  const next = ok(res).revision;
  await saveCursor({ revision: next });
  await written([next]);
}

// The build tree becomes a batch: ids from titles (in Latin letters), nesting through parentId, notes through
// attachedTo. Repeating build with the same file (for example, after an interruption) duplicates nothing: a block with the
// same id, level and title, a note with the same id, place and text, and an existing link count as written. Note ids are
// stable: <block id>-note-<number>, and note-<number> for free notes.
function buildOps(spec, graph) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('build takes a JSON object { "blocks", "notes", "links" }.');
  const byId = new Map(graph.nodes.map(n => [n.id, n])), claimed = new Set(), byTitle = new Map(), ops = [], outline = [], level = spec.parent ?? null;
  if (level !== null && byId.get(level)?.type !== 'block') fail(`Block "${level}" from parent is not on the map.`);
  const take = (wanted, root, same) => {
    if (wanted) {
      if (claimed.has(wanted) || (byId.has(wanted) && !same(byId.get(wanted)))) fail(`id "${wanted}" is already taken on the map or in the structure.`);
      claimed.add(wanted); return { id: wanted, fresh: !byId.has(wanted) };
    }
    for (let i = 1; ; i++) {
      const id = i === 1 ? root : `${root}-${i}`, old = byId.get(id);
      if (!claimed.has(id) && (!old || same(old))) { claimed.add(id); return { id, fresh: !old }; }
    }
  };
  const geometry = b => Object.fromEntries(['x', 'y', 'w', 'h'].filter(k => b[k] !== undefined).map(k => [k, b[k]]));
  const notes = (list, parentId, attachedTo) => (list ?? []).forEach((note, i) => {
    const text = typeof note === 'string' ? note : note?.text ?? '';
    const { id, fresh } = take(null, `${attachedTo ? `${attachedTo}-` : ''}note-${i + 1}`, n => n.type === 'note' && n.parentId === parentId && n.attachedTo === attachedTo && n.text === text);
    if (fresh) ops.push({ type: 'add-node', node: { id, type: 'note', parentId, attachedTo, text, ...(note?.color ? { color: note.color } : {}) } });
  });
  const visit = (blocks, parentId, depth) => {
    for (const b of blocks ?? []) {
      if (!b || typeof b !== 'object') fail('Every block in build is an object with a title.');
      const title = b.title ?? '';
      const { id, fresh } = take(b.id, slug(title) || 'block', n => n.type === 'block' && n.parentId === parentId && n.title === title);
      byTitle.set(title, byTitle.has(title) ? null : id);
      // Sub-maps deeper than concepts (technical under mechanics, code under technical) are collapsed by default: the map
      // opens at the Mechanics level, and expanding deeper moves neighbours apart. This way sub-map sizes are not computed
      // for the fully expanded view.
      const folded = b.collapsed ?? (depth + (spec.parent ? 1 : 0) >= 1 && Boolean(b.blocks?.length));
      if (fresh) ops.push({ type: 'add-node', node: { id, parentId, title, text: b.text ?? '', color: b.color ?? '', collapsed: Boolean(folded), ...(b.status ? { status: b.status } : {}), ...(b.files ? { files: b.files } : {}), ...(b.test ? { test: b.test } : {}), ...geometry(b) } });
      outline.push(`${'  '.repeat(depth)}- ${id} — ${title}`);
      notes(b.notes, parentId, id);
      visit(b.blocks, id, depth + 1);
    }
  };
  // The first map of a project from an older version replaces the starting block with the folder name if it was not filled in or linked.
  const [only] = graph.nodes;
  if (!spec.parent && graph.nodes.length === 1 && only.id === 'start' && !only.text && !graph.edges.length && spec.blocks?.length) { ops.push({ type: 'delete-node', id: 'start' }); byId.delete('start'); }
  visit(spec.blocks, level, 0);
  notes(spec.notes, level, null);
  const ref = r => { if (byId.has(r) || claimed.has(r)) return r; const id = byTitle.get(r); if (id) return id; fail(`A link refers to an unknown or ambiguous block "${r}". Give its id.`); };
  const pairs = new Set(graph.edges.map(e => `${e.source}:${e.target}`));
  for (const l of spec.links ?? []) {
    const [from, to, label] = Array.isArray(l) ? l : [l?.from, l?.to, l?.label], source = ref(from), target = ref(to);
    if (!pairs.has(`${source}:${target}`)) ops.push({ type: 'add-edge', edge: { source, target, label: label ?? '' } });
  }
  return { ops, outline };
}

// build steps. The geometry of each step is taken from final: exactly what writing one batch would give. Step 1: existing
// nodes move to where layout pushed them, and new blocks of the build level appear (collapsed ones at once with their whole
// sub-map). Then one step for each expanded sub-map with new content: from outer to nested, top to bottom.
// Links go in the step after which both their ends exist. In each step edits come before additions, and links come last.
const nodeFields = ['id', 'type', 'parentId', 'attachedTo', 'collapsed', 'title', 'text', 'color', 'status', 'files', 'test', 'x', 'y', 'w', 'h'];
function stages(current, final, ops, level) {
  const deleted = new Set(ops.filter(o => o.type === 'delete-node').map(o => o.id));
  const old = new Map(current.nodes.filter(n => !deleted.has(n.id)).map(n => [n.id, n])), byId = new Map(final.nodes.map(n => [n.id, n]));
  const fresh = final.nodes.filter(n => !old.has(n.id)), known = new Set(current.edges.map(e => e.id)), links = final.edges.filter(e => !known.has(e.id));
  const sent = new Set(old.keys()), linked = new Set();
  // An attached note moves with its block by itself; a separate edit only if layout moved it differently.
  // Position and size are separate edits: this way History names them exactly.
  const updates = [], shift = id => { const n = old.get(id), f = byId.get(id); return n && f ? { x: f.x - n.x, y: f.y - n.y } : { x: 0, y: 0 }; };
  const patch = (n, f, keys) => { const p = Object.fromEntries(keys.filter(k => n[k] !== f[k]).map(k => [k, f[k]])); if (Object.keys(p).length) updates.push({ type: 'update-node', id: f.id, patch: p }); };
  for (const type of ['block', 'note']) for (const n of old.values()) {
    const f = byId.get(n.id);
    if (n.type !== type || !f) continue;
    const d = type === 'note' && n.attachedTo ? shift(n.attachedTo) : { x: 0, y: 0 }, was = { ...n, x: n.x + d.x, y: n.y + d.y };
    patch(was, f, ['x', 'y']); patch(was, f, ['w', 'h']);
  }
  const inside = (n, id) => { for (let p = n.parentId; p; p = byId.get(p)?.parentId) if (p === id) return true; return false; };
  // New nodes on the parents levels (for new collapsed blocks, with the whole sub-map) and links that now have both ends.
  const take = parents => {
    const ids = new Set();
    for (const n of fresh) if (parents.includes(n.parentId) && !sent.has(n.id)) {
      ids.add(n.id);
      if (n.type === 'block' && n.collapsed) for (const k of fresh) if (inside(k, n.id)) ids.add(k.id);
    }
    for (const id of ids) sent.add(id);
    const ready = links.filter(e => !linked.has(e.id) && sent.has(e.source) && sent.has(e.target));
    for (const e of ready) linked.add(e.id);
    return [...fresh.filter(n => ids.has(n.id)).map(n => ({ type: 'add-node', node: Object.fromEntries(nodeFields.map(k => [k, n[k]])) })),
      ...ready.map(e => ({ type: 'add-edge', edge: { id: e.id, source: e.source, target: e.target, label: e.label } }))];
  };
  // New content inside collapsed existing blocks is not visible: it goes in the first step.
  const folded = fresh.map(n => n.parentId).filter(p => p !== null && old.has(p) && byId.get(p).collapsed);
  const plan = [[...updates, ...ops.filter(o => o.type === 'delete-node'), ...take([...new Set([level, null, ...folded])])]];
  const depth = id => { let d = 0; for (let p = id; p; p = byId.get(p)?.parentId) d++; return d; };
  const containers = [...new Set(fresh.filter(n => !sent.has(n.id)).map(n => n.parentId))].sort((a, b) => depth(a) - depth(b) || byId.get(a).y - byId.get(b).y || byId.get(a).x - byId.get(b).x);
  for (const c of containers) plan.push(take([c]));
  plan.push(take([]));
  return plan.filter(step => step.length);
}
// Whether the steps can be repeated on top of others' edits: nobody deleted what they put nodes into and draw links between,
// and nobody took their ids.
function rebasable(changes, steps) {
  if (!changes.complete) return false;
  const removed = new Set(changes.nodes.removed.map(n => n.id)), added = new Set(changes.nodes.added.map(n => n.id));
  return steps.flat().every(op => op.type === 'add-edge' ? !removed.has(op.edge.source) && !removed.has(op.edge.target)
    : !removed.has(op.node.parentId) && !removed.has(op.node.attachedTo) && !added.has(op.node.id));
}
const writtenSteps = (k, n) => k === 1 ? `Wrote step 1 of ${n}.` : `Wrote steps 1–${k} of ${n}.`;
// Steps one by one, with a pause: the person sees the map grow. If the map was changed between steps, others' changes are
// printed at once and the step is repeated on top of the new revision (up to three times); otherwise, what was written,
// others' changes and an exit. The read mark moves past others' edits only after they are printed: cut output or an
// interrupted build does not lose them.
async function commitSteps(plan, message, start, after) {
  const mine = [];
  let revision = start;
  for (let i = 0; i < plan.length; i++) {
    if (i) await sleep(200);
    for (let retry = 0; ; retry++) {
      const res = await call(at('/changes'), { expectedRevision: revision, actor, message: plan.length > 1 ? `${message} (step ${i + 1} of ${plan.length})` : message, operations: plan[i] });
      if (res.status === 200) { revision = res.value.revision; mine.push(revision); await saveCursor({ revision }); break; }
      if (res.status !== 409) { if (i) console.log(writtenSteps(i, plan.length)); ok(res); }
      if (!i) await conflict(revision);
      const changes = ok(await call(at(`/changes?since=${revision}&exclude=${encodeURIComponent(actor)}`)));
      if (retry >= 3 || !rebasable(changes, plan.slice(i))) {
        console.log(`${writtenSteps(i, plan.length)}\n`);
        await report(changes);
        console.log('\nRepeat the same build: blocks already written will be skipped.');
        quit(1);
      }
      console.log(`The map was changed while writing:\n${formatChanges(changes, ok(await call(at('/graph'))))}\n`);
      revision = changes.revision;
    }
  }
  await written(mine, after);
}

const idList = value => (value || '').split(',').map(x => x.trim()).filter(Boolean);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Blocks and everything nested in them.
function within(graph, ids) {
  const set = new Set(ids);
  for (let grew = true; grew; ) { grew = false; for (const n of graph.nodes) if (!set.has(n.id) && set.has(n.parentId)) { set.add(n.id); grew = true; } }
  return set;
}
// Marks from check are written on top of the current revision, not the one read: a check takes long, and the map is edited
// meanwhile. The read mark moves to this write only if the agent had read everything before it.
async function markNow(ids, status, message) {
  for (let i = 0; ; i++) {
    const cursor = await readCursor(), revision = ok(await call(at(''))).project.revision;
    const res = await call(at('/changes'), { expectedRevision: revision, actor, message, operations: ids.map(id => ({ type: 'update-node', id, patch: { status } })) });
    if (res.status === 409 && i < 3) continue;
    const next = ok(res).revision;
    if (cursor.revision === revision) await saveCursor({ revision: next });
    return;
  }
}
// A check command runs from the project root, through the shell, as it was written; "node …" runs with the same node as
// Mycel (it may not be on PATH). The last 40 lines of output are kept.
function runTest(command, timeout) {
  const line = /^node\s/.test(command) ? `"${process.execPath}" ${command.slice(5)}` : command;
  return new Promise(done => {
    const child = spawn(line, { cwd: here(), shell: true, windowsHide: true });
    let out = '';
    const keep = c => { out = (out + c).slice(-20000); };
    child.stdout.setEncoding('utf8').on('data', keep); child.stderr.setEncoding('utf8').on('data', keep);
    const timer = setTimeout(() => {
      out += `\nStopped: took longer than ${timeout} s.`;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).on('error', () => {}); else child.kill();
    }, timeout * 1000);
    child.on('error', e => { clearTimeout(timer); done({ code: 1, out: e.message }); });
    child.on('close', code => { clearTimeout(timer); done({ code: code === null ? 1 : code, out: out.trim().split(/\r?\n/).slice(-40).join('\n') }); });
  });
}
// Checking blocks: the test commands of the blocks and of everything nested in them, each once. Before the run the blocks
// are "checking now", after each command its blocks are "passed" or "failed": the person sees the map change colour.
async function runChecks(ids) {
  here();
  const graph = ok(await call(at('/graph'))), name = namer(graph);
  for (const id of ids) if (!graph.nodes.some(n => n.id === id && n.type === 'block')) fail(`Block "${id}" is not on the map.`);
  const scope = ids.length ? within(graph, ids) : null, targets = graph.nodes.filter(n => n.type === 'block' && n.test && (!scope || scope.has(n.id)));
  if (!targets.length) fail(`${ids.length ? 'These blocks and the blocks nested in them have' : 'The map has'} no check command. Add one to a block: mycel apply with update-node { "test": "test command" }.`);
  const groups = new Map();
  for (const n of targets) groups.set(n.test, (groups.get(n.test) || []).concat(n.id));
  const timeout = Number(options.timeout || 600);
  if (!(timeout > 0)) fail('--timeout is in seconds, more than 0.');
  await markNow(targets.map(n => n.id), 'testing', 'Check running');
  const lines = [];
  let failed = 0;
  for (const [command, list] of groups) {
    const r = await runTest(command, timeout), status = r.code === 0 ? 'passed' : 'failed';
    if (status === 'failed') failed++;
    await markNow(list, status, `Check: ${markNames[status]}`);
    lines.push(`${status === 'passed' ? 'Passed' : 'Failed'}: ${list.map(name).join(', ')} — \`${command}\`${status === 'failed' ? ` (code ${r.code})\n${r.out}` : ''}`);
  }
  console.log(lines.join('\n\n'));
  if (failed) quit(1);
}

// Risks in the blocks' files: TODO, FIXME, HACK, XXX marks and lines that look like keys and passwords. Only the file and
// line number are printed, without the content. .env, keys and certificates are not opened; dependencies, build output and data are skipped.
const skipDirs = new Set(['node_modules', '.git', '.mycel', '.kontur', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', '__pycache__']);
const secretFile = name => /^\.env|\.(pem|key|p12|pfx|crt)$|^id_(rsa|ed25519|ecdsa)/i.test(name);
const secretLines = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/, /(api[_-]?key|secret|token|passw(?:or)?d)\s*[:=]\s*['"][^'"\s]{12,}['"]/i];
async function filesOf(entry, seen) {
  const root = here(), full = resolve(root, entry), inside = relative(root, full);
  if (inside.startsWith('..') || isAbsolute(inside)) return [];
  const out = [];
  const walk = async (path, depth) => {
    if (seen.size > 5000 || seen.has(path)) return;
    const info = await stat(path).catch(() => null);
    if (!info) return;
    if (info.isFile()) { if (!secretFile(basename(path)) && info.size <= 1024 * 1024) { seen.add(path); out.push(path); } return; }
    if (!info.isDirectory() || depth > 8 || skipDirs.has(basename(path))) return;
    for (const name of await readdir(path).catch(() => [])) await walk(join(path, name), depth + 1);
  };
  await walk(full, 0);
  return out;
}
async function scanFile(path) {
  const text = await readFile(path, 'utf8').catch(() => null), found = { todo: [], secrets: [] };
  if (text === null || text.slice(0, 8000).includes('\u0000')) return found;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) found.todo.push(i + 1);
    if (secretLines.some(re => re.test(line))) found.secrets.push(i + 1);
  });
  return found;
}
async function healthReport() {
  if (!options['no-scan']) here();
  const graph = ok(await call(at('/graph'))), code = ok(await call(at('/code'))), name = namer(graph), blocks = graph.nodes.filter(n => n.type === 'block');
  const risks = {}, where = {};
  if (!options['no-scan']) {
    const seen = new Set();
    for (const n of blocks.filter(b => b.files)) {
      const r = { todo: 0, secrets: 0 }, spots = [];
      for (const entry of n.files) for (const file of await filesOf(entry, seen)) {
        const f = await scanFile(file), rel = relative(here(), file).replace(/\\/g, '/');
        r.todo += f.todo.length; r.secrets += f.secrets.length;
        if (f.todo.length) spots.push(`${rel}:${f.todo.slice(0, 5).join(',')}${f.todo.length > 5 ? '…' : ''} (TODO ${f.todo.length})`);
        if (f.secrets.length) spots.push(`${rel}:${f.secrets.join(',')} (looks like a key or password)`);
      }
      risks[n.id] = r; where[n.id] = spots;
    }
    ok(await call(at('/risks'), { actor, blocks: risks }));
  }
  const list = (title, items) => items.length ? [`${title}:`, ...items.map(x => `- ${x}`), ''] : [];
  const stale = new Set(code.stale.map(s => s.id));
  console.log([`Health of the map "${project.name}":`, '',
    ...list('Failed', blocks.filter(n => n.status === 'failed').map(n => name(n.id))),
    ...list('Possibly outdated (files changed after the description)', code.stale.map(s => `${name(s.id)} — ${s.files.join(', ')}`)),
    ...list('Unchecked (has files, but no test command and no "passed" mark)', blocks.filter(n => n.files && !n.test && n.status !== 'passed').map(n => name(n.id))),
    ...list('Plan (no code yet)', blocks.filter(n => n.status === 'plan').map(n => name(n.id))),
    ...list('Risks in files', Object.entries(risks).filter(([, r]) => r.todo || r.secrets).map(([id, r]) => `${name(id)}: ${[r.todo && `TODO ${r.todo}`, r.secrets && `looks like a secret ${r.secrets}`].filter(Boolean).join(', ')} — ${where[id].join('; ')}`)),
    ...(blocks.some(n => n.files) ? [] : ['The blocks have no files: add them to the technical and code blocks ("files": ["path"]), then outdated blocks and risks show up.', '']),
    stale.size || blocks.some(n => n.status === 'failed') ? 'Start with the failed and outdated blocks.' : 'No failed or outdated blocks.'].join('\n').trim());
}

// An overview of the map for the start of a session: concepts and mechanics one line each, marks, outdated items, the
// proposal. The agent reads the part of the map it needs (context --focus), not all the code. No longer than 6000 characters.
function overview(graph, code) {
  const kids = id => graph.nodes.filter(n => n.parentId === id && n.type === 'block');
  const first = text => { const line = text.trim().split('\n')[0]; return line.length > 140 ? `${line.slice(0, 139)}…` : line; };
  const line = n => `"${n.title || 'untitled'}" (${n.id})${n.text ? ` — ${first(n.text)}` : ''}`;
  const count = s => graph.nodes.filter(n => n.status === s);
  const lines = [`Mycel: project "${project.name}" has a map of how it works, ${plural(graph.nodes.filter(n => n.type === 'block').length, 'block', 'blocks')}, and the person sees it: ${origin}/#/p/${project.id}.`,
    'Read the part of the map you need, not all the code: mycel context --focus <id> (in MCP, mycel_context with focus). The guide: mycel guide (mycel_guide).',
    'Write the map (titles, texts, notes, link labels, the doing line) in the language the person uses with you.', '', 'Concepts and mechanics:'];
  for (const c of kids(null)) { lines.push(`- ${line(c)}`); for (const m of kids(c.id)) lines.push(`  - ${line(m)}`); }
  const marks = [count('passed').length && `passed ${count('passed').length}`, count('failed').length && `failed ${count('failed').length} (${count('failed').slice(0, 5).map(n => `"${n.title}"`).join(', ')})`, count('plan').length && `plan ${count('plan').length}`].filter(Boolean);
  if (marks.length) lines.push('', `Marks: ${marks.join(', ')}.`);
  if (code.stale.length) lines.push(`Possibly outdated (files changed after the description): ${code.stale.slice(0, 10).map(s => `"${s.name}" (${s.id})`).join(', ')}.`);
  if (code.work.length) lines.push(`Working now: ${code.work.map(w => w.actor).join(', ')}.`);
  if (graph.proposal) lines.push(`Open proposal "${graph.proposal.title}": the person accepts or rejects it.`);
  let text = lines.join('\n');
  if (text.length > 6000) text = `${text.slice(0, text.lastIndexOf('\n', 5900))}\n… the map is larger: mycel context --brief.`;
  return text;
}

// Agent hooks: Claude Code (the Mycel plugin), Codex (--from codex, ~/.codex/hooks.json), Cursor (--from cursor,
// ~/.cursor/hooks.json). Their events differ, the meaning is the same: after a file edit its blocks are "being edited" and
// "possibly outdated"; before the end of a reply, a reminder to describe the blocks whose files the agent changed in this
// session; at the start of a session, an overview of the map. The hook does not get in the way: if Mycel is not running or
// is a different version, the folder is not connected or there is an error, it exits quietly with code 0.
// Files from an apply_patch patch (Codex): the lines "*** Add File: path", "*** Update File:", "*** Delete File:", "*** Move to:".
const patchFiles = command => [...(Array.isArray(command) ? command.join('\n') : String(command)).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)].map(m => m[1]);
// A change of the agent's own task list: TodoWrite and update_plan with the whole list (Claude Code, the Claude desktop
// app, Codex), update_plan with advance / done / start (the desktop app), TaskCreate and TaskUpdate (one task).
const STEP = ['pending', 'in_progress', 'completed'];
const step = (title, text, status) => ({ title: String(title || '').slice(0, 200), text: String(text || title || '').slice(0, 200), status: STEP.includes(status) ? status : 'pending' });
const taskId = r => {
  const id = r && typeof r === 'object' ? (r.task?.id ?? r.id) : null;
  if (id !== null && id !== undefined) return String(id);
  const m = /#(\d+)/.exec(typeof r === 'string' ? r : JSON.stringify(r ?? ''));
  return m ? m[1] : null;
};
function planChange(tool, input, response) {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) return { set: input.todos.map(t => step(t.content, t.status === 'in_progress' && t.activeForm, t.status)) };
  if (/update_plan$/.test(tool || '')) {
    if (Array.isArray(input.items)) return { set: input.items.map(s => step(s.content, s.content, s.status)) };
    if (Array.isArray(input.plan)) return { set: input.plan.map(s => step(s.step, s.step, s.status)) };
    if (input.advance || input.done || input.start) return { advance: Boolean(input.advance), done: Array.isArray(input.done) ? input.done : [], start: Number.isInteger(input.start) ? input.start : null };
  }
  if (tool === 'TaskCreate' && input.subject) return { add: { id: taskId(response), ...step(input.subject, null, 'pending') } };
  if (tool === 'TaskUpdate' && input.taskId !== undefined) return { update: { id: String(input.taskId), status: input.status, title: input.subject, text: input.activeForm } };
  return null;
}
function applyPlan(steps, c) {
  if (c.set) return c.set;
  steps = steps.map(s => ({ ...s }));
  if (c.add) { steps.push({ ...c.add, id: c.add.id ?? String(steps.length + 1) }); return steps; }
  if (c.update) {
    const s = steps.find(x => x.id === c.update.id);
    if (!s) return steps;
    if (c.update.status === 'deleted') return steps.filter(x => x !== s);
    if (STEP.includes(c.update.status)) s.status = c.update.status;
    if (c.update.title) s.title = String(c.update.title).slice(0, 200);
    s.text = String(c.update.text || s.title).slice(0, 200);
    return steps;
  }
  // advance completes the current step and starts the next pending one; done and start count steps from 1.
  if (c.advance) {
    const now = steps.find(s => s.status === 'in_progress'); if (now) now.status = 'completed';
    const next = steps.find(s => s.status === 'pending'); if (next) next.status = 'in_progress';
  }
  for (const n of c.done) if (steps[n - 1]) steps[n - 1].status = 'completed';
  if (c.start && steps[c.start - 1]) { for (const s of steps) if (s.status === 'in_progress') s.status = 'pending'; steps[c.start - 1].status = 'in_progress'; }
  return steps;
}
// The line under the map from the task list: the current step and the share of finished steps; open — steps are left.
function planLine(steps) {
  if (!steps.length) return null;
  const done = steps.filter(s => s.status === 'completed').length, now = steps.find(s => s.status === 'in_progress') ?? steps.find(s => s.status === 'pending');
  return { text: (now ?? steps[steps.length - 1]).text, progress: Math.round(done / steps.length * 100), open: Boolean(now) };
}
// The task list as the hook last saw it, per session (TaskUpdate and update_plan change it a step at a time). In the data
// folder; lists of sessions older than a week are removed at the start of a session.
const planFile = session => join(data, 'hooks', `${(session || 'session').replace(/[^\w-]/g, '_').slice(0, 100)}.json`);
const readPlan = async session => { try { return JSON.parse(await readFile(planFile(session), 'utf8')); } catch (e) { return { steps: [] }; } };
const savePlan = async (session, plan) => { await mkdir(dirname(planFile(session)), { recursive: true }); await writeFile(planFile(session), JSON.stringify(plan)); };
async function prunePlans() {
  const dir = join(data, 'hooks');
  for (const name of await readdir(dir).catch(() => [])) {
    const file = join(dir, name);
    if (Date.now() - (await stat(file).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 7 * 864e5) await unlink(file).catch(() => {});
  }
}
// An agent event in a common form: kind is edit (files), plan (a task list change), stop (repeat: already reminded) or
// start; session; the cwd folder; sub — the event of a helper agent (Claude Code subagent).
function hookEvent(from, ev) {
  if (from === 'cursor') {
    const cwd = (ev.workspace_roots && ev.workspace_roots[0]) || process.cwd(), session = ev.conversation_id || ev.session_id || null;
    if (ev.hook_event_name === 'afterFileEdit' && typeof ev.file_path === 'string') return { kind: 'edit', files: [ev.file_path], session, cwd };
    if (ev.hook_event_name === 'stop') return { kind: 'stop', repeat: (ev.loop_count || 0) > 0 || ev.status === 'aborted', session, cwd };
    if (ev.hook_event_name === 'sessionStart') return { kind: 'start', session, cwd };
    return null;
  }
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : process.cwd(), session = typeof ev.session_id === 'string' ? ev.session_id : null, name = ev.hook_event_name;
  if (name === 'PostToolUse') {
    const input = ev.tool_input || {}, change = planChange(ev.tool_name, input, ev.tool_response);
    if (change) return { kind: 'plan', change, session, cwd, sub: Boolean(ev.agent_id) };
    const files = typeof input.file_path === 'string' ? [input.file_path] : typeof input.notebook_path === 'string' ? [input.notebook_path] : input.command ? patchFiles(input.command) : [];
    return files.length ? { kind: 'edit', files, session, cwd } : null;
  }
  if (name === 'Stop') return { kind: 'stop', repeat: Boolean(ev.stop_hook_active), session, cwd };
  if (name === 'SessionStart') return { kind: 'start', session, cwd };
  return null;
}
async function hook() {
  let event;
  try { event = JSON.parse((await readText('-')).replace(/^\uFEFF/, '')); } catch (e) { return; }
  const from = options.from || 'claude', e = hookEvent(from, event);
  if (!e) return;
  const h = await health(1500);
  if (!h || h.foreign || !ours(h.app) || h.version !== version) return;
  const { root, git, path } = projectRoot(e.cwd), id = projectId();
  let found = await call(id ? `/api/p/${encodeURIComponent(id)}` : `/api/projects?${new URLSearchParams(Object.assign({ path }, git ? { root } : {}))}`);
  if (!id && found.status === 404 && joined && joined.project) found = await call(`/api/p/${encodeURIComponent(joined.project)}`);
  if (found.status !== 200 || found.value.project.error) return;
  project = found.value.project;
  const session = e.session ? e.session.slice(0, 100) : null;
  const open = async () => Boolean(planLine((await readPlan(session)).steps)?.open);
  if (e.kind === 'plan') {
    // A helper agent's own list is not the person's task: only the main agent's list moves the line under the map.
    if (e.sub) return;
    const plan = await readPlan(session);
    plan.steps = applyPlan(plan.steps, e.change);
    await savePlan(session, plan);
    const line = planLine(plan.steps);
    await call(at('/activity'), { actor, text: line ? line.text : null, progress: line ? line.progress : null, auto: true });
  } else if (e.kind === 'edit') {
    const base = isDir(project.path) ? project.path : root;
    const files = e.files.map(f => relative(base, resolve(e.cwd, f)).replace(/\\/g, '/')).filter(f => f && !f.startsWith('..') && !isAbsolute(f)).slice(0, 50);
    if (!files.length) return;
    const res = await call(at('/touch'), { actor, files, session });
    // Without a task list the line under the map says which files the agent is editing.
    if (!await open()) await call(at('/activity'), { actor, text: `editing ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`.slice(0, 200), progress: null, auto: true });
    // A warning about others' blocks is possible only in Claude Code: other agents get no hook response after a file edit.
    if (from === 'claude' && res.status === 200 && res.value.others.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Mycel: ${res.value.others.map(o => `block "${o.name}" (${o.id}) is being worked on by ${o.by}`).join('; ')}. Agree with the person before editing the same files.` } }));
  } else if (e.kind === 'stop') {
    const mine = e.repeat ? [] : ok(await call(at('/code'))).stale.filter(s => s.by === actor && s.session && s.session === session);
    if (mine.length) {
      const reason = `Mycel: in this session you changed files of the blocks ${mine.map(s => `"${s.name}" (${s.id})`).join(', ')}, and their description on the map is not updated. If how it works has changed, update the blocks' text (mycel apply or mycel_apply); if the description is right, confirm it: mycel fresh ${mine.map(s => s.id).join(',')} (mycel_fresh). Then finish your reply.`;
      console.log(JSON.stringify(from === 'cursor' ? { followup_message: reason } : { decision: 'block', reason }));
      return;
    }
    // The reply is over: the line under the map goes away, unless the task list still has open steps (the work goes on
    // in the background).
    if (!await open()) await call(at('/activity'), { actor, text: null, auto: true });
  } else {
    await prunePlans();
    const text = overview(ok(await call(at('/graph'))), ok(await call(at('/code'))));
    // Codex takes the plain output of the session start hook into context, Cursor takes additional_context.
    if (from === 'codex') console.log(text);
    else console.log(JSON.stringify(from === 'cursor' ? { additional_context: text } : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
  }
}
// The claude command: --claude or MYCEL_CLAUDE, claude on PATH, otherwise the Claude Code process the command was started
// from (CLAUDE_PID): the app keeps claude off PATH.
function findClaude() {
  const given = options.claude || env('CLAUDE');
  if (given) return given;
  if (spawnSync('claude --version', { shell: true, windowsHide: true, stdio: 'ignore' }).status === 0) return 'claude';
  const pid = Number(process.env.CLAUDE_PID);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const path = process.platform === 'linux' ? readlinkSync(`/proc/${pid}/exe`)
      : process.platform === 'win32' ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Path`], { encoding: 'utf8', windowsHide: true }).stdout.trim()
      : spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    return path && /^claude/i.test(basename(path)) ? path : null;
  } catch (e) { return null; }
}
// The Claude Code plugin for this computer is a local marketplace in <data>/plugin: the Mycel MCP server, hooks (after a
// file edit, end of a reply, start of a session) and a skill with a short guide. Paths are full: node may not be on PATH.
// The hook runs without a shell (command and args): the event goes straight to node's standard input. The person installs
// the plugin: these are their settings.
async function plugin() {
  const out = resolve(options.out || join(data, 'plugin')), root = join(out, 'mycel'), slash = p => p.replace(/\\/g, '/');
  const node = slash(process.execPath), cli = slash(join(appRoot, 'mycel.mjs')), server = slash(join(appRoot, 'mcp.mjs'));
  // In a virtual machine the plugin works through the join connection: the CLI takes the address and key from it itself.
  if (remote && !joined) fail(`Connect this copy to Mycel first: node mycel.mjs join ${origin} <key> --project <id>`);
  const custom = origin !== 'http://127.0.0.1:4317' && !joined;
  // --agent <name>: the MCP server entry for an agent without Claude Code plugins; the plugin files are not needed then.
  // The hook command for agents with their own hooks: full paths, and the address if Mycel is not on 4317.
  const hookFor = from => `\"${node}\" \"${cli}\" hook --from ${from}${custom ? ` --url ${origin}` : ''}`;
  if (options.agent !== undefined) return agentConfig(options.agent, node, server, custom ? { MYCEL_URL: origin } : null, hookFor);
  const handler ={ type: 'command', command: node, args: [cli, 'hook', ...(custom ? ['--url', origin] : [])], timeout: 30 };
  const description = 'Mycel: a map of how the project works, next to the agent: the MCP server, highlighting of edits and outdated blocks, an overview of the map at session start.';
  const json = value => `${JSON.stringify(value, null, 2)}\n`;
  const files = [
    [join(out, '.claude-plugin', 'marketplace.json'), json({ name: 'mycel-local', description: 'Mycel on this computer', owner: { name: 'Mycel' }, plugins: [{ name: 'mycel', source: './mycel', description }] })],
    [join(root, '.claude-plugin', 'plugin.json'), json({ name: 'mycel', version, description, author: { name: 'Mycel' } })],
    [join(root, '.mcp.json'), json({ mcpServers: { mycel: Object.assign({ command: node, args: [server] }, custom ? { env: { MYCEL_URL: origin } } : {}) } })],
    [join(root, 'hooks', 'hooks.json'), json({ hooks: { PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|TodoWrite|TaskCreate|TaskUpdate|.*update_plan', hooks: [handler] }], Stop: [{ hooks: [handler] }], SessionStart: [{ hooks: [handler] }] } })],
    [join(root, 'skills', 'mycel', 'SKILL.md'), ['---', 'name: mycel',
      'description: The map of how the project works, in Mycel. Use it when the project is connected to Mycel or the person talks about the map, blocks, a proposal or test marks.', '---',
      'Mycel is a shared project map: the person watches it in the browser and sees the agent\'s edits at once.', '',
      '- At the start of work, read the guide: the `mycel_guide` tool, then the part of the map you need: `mycel_context` with `focus`.',
      '- Write the map in the language the person uses with you: block titles and texts, notes, link labels, proposal titles, the `doing` line. Names from code and file names stay as they are.',
      '- When you change code, keep the map true: technical and code blocks have the `files` field (the block\'s files) and `test` (the check command). A block whose files you changed is marked "possibly outdated": update its text (`mycel_apply`) or confirm it (`mycel_fresh`).',
      '- Tests: `mycel_check` with block ids: borders turn green and red while the person watches.',
      '- Logic changes the person has not approved yet: `mycel_propose`, the person decides. What changed in the session: `mycel_review`; where the gaps are: `mycel_health`.', ''].join('\n')]
  ];
  for (const [file, text] of files) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); }
  // --install: connect the plugin itself (repeating is safe) and remove a separately connected mycel MCP server so the
  // tools are not duplicated. The tools and hooks appear in a new Claude Code session.
  if (options.install) {
    const claude = findClaude();
    if (claude) {
      const run = list => /\.m?js$/.test(claude) ? spawnSync(process.execPath, [claude, ...list], { encoding: 'utf8', windowsHide: true })
        : claude === 'claude' ? spawnSync(['claude', ...list.map(a => `\"${a}\"`)].join(' '), { encoding: 'utf8', windowsHide: true, shell: true })
        : spawnSync(claude, list, { encoding: 'utf8', windowsHide: true });
      for (const list of [['plugin', 'marketplace', 'add', out, '--scope', 'user'], ['plugin', 'install', 'mycel@mycel-local', '--scope', 'user']]) {
        const r = run(list);
        if (r.status !== 0) fail(`Failed: claude ${list.join(' ')}\n${(r.stderr || r.stdout || (r.error && r.error.message) || '').trim()}`);
      }
      run(['mcp', 'remove', 'mycel', '-s', 'user']);
      console.log('The Mycel plugin is connected. The mycel_* tools and hooks appear in a new Claude Code session: ask the person to start one.');
      return;
    }
    console.error('Could not find claude: run the connection commands below yourself.');
    process.exitCode = 1;
  }
  console.log([`The Mycel plugin for Claude Code: ${out}`, '',
    'To connect: node mycel.mjs plugin --install, or by hand:',
    `  claude plugin marketplace add "${out}" --scope user`, '  claude plugin install mycel@mycel-local --scope user',
    'If the mycel MCP server is already connected separately, remove it so the tools are not duplicated: claude mcp remove mycel -s user', '',
    'Other agents use the same Mycel MCP server; node mycel.mjs plugin --agent <name> prints what to paste and where:',
    ...agentConfigs(node, server, custom ? { MYCEL_URL: origin } : null).map(a => `  ${a.id.padEnd(15)}${a.name} — ${a.where}`), '',
    'Your own local model without a client (Ollama, LM Studio, llama.cpp): node mycel.mjs chat --model <name> [--base <address /v1>].'].join('\n'));
}
// The Mycel MCP server for agents without Claude Code plugins: the settings file and the mycel entry for it. The server is
// the same as in the plugin; paths are full, and the Mycel address is an environment variable if it is not on 4317 (not
// needed for a copy connected with join). hook(from) is the Mycel hook command for agents with their own hooks (Codex, Cursor).
function agentConfigs(node, server, env, hook = () => '') {
  const json = value => JSON.stringify(value, null, 2), stdio = Object.assign({ command: node, args: [server] }, env ? { env } : {});
  const toml = ['[mcp_servers.mycel]', `command = ${JSON.stringify(node)}`, `args = [${JSON.stringify(server)}]`,
    ...(env ? ['', '[mcp_servers.mycel.env]', ...Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)] : [])].join('\n');
  const envFlags = flag => env ? Object.entries(env).map(([k, v]) => `${flag} ${k}=${v} `).join('') : '', typed = Object.assign({ type: 'stdio' }, stdio);
  // YAML for Continue and Goose: strings are in JSON quotes (YAML understands them), so Windows paths with a colon do not break.
  const q = JSON.stringify, envYaml = pad => env ? [`${pad}env:`, ...Object.entries(env).map(([k, v]) => `${pad}  ${k}: ${q(v)}`)] : [];
  const yaml = ['mcpServers:', '  - name: mycel', '    type: stdio', `    command: ${q(node)}`, '    args:', `      - ${q(server)}`, ...envYaml('    ')].join('\n');
  const goose = ['extensions:', '  mycel:', '    name: mycel', '    type: stdio', '    enabled: true', `    cmd: ${q(node)}`, `    args: [${q(server)}]`, ...(env ? [`    envs: ${q(env)}`] : []), '    timeout: 300'].join('\n');
  // Paths and shapes follow the agents' documentation as of 28.10.2026. Add commands are given where they are documented
  // (those without environment variable support only when there are no variables).
  return [
    { id: 'codex', name: 'Codex CLI', where: '~/.codex/config.toml (for a project, .codex/config.toml if the project is trusted)', text: toml,
      command: `codex mcp add mycel ${envFlags('--env')}-- "${node}" "${server}"`,
      hooks: { where: '~/.codex/hooks.json (Codex asks you to trust the hooks: /hooks)', text: json({ hooks: { PostToolUse: [{ matcher: 'apply_patch|Edit|Write|update_plan', hooks: [{ type: 'command', command: hook('codex'), timeout: 30 }] }], Stop: [{ hooks: [{ type: 'command', command: hook('codex'), timeout: 30 }] }], SessionStart: [{ hooks: [{ type: 'command', command: hook('codex'), timeout: 30 }] }] } }) } },
    { id: 'cursor', name: 'Cursor', where: '~/.cursor/mcp.json (for one project, .cursor/mcp.json in it)', text: json({ mcpServers: { mycel: typed } }),
      hooks: { where: '~/.cursor/hooks.json', text: json({ version: 1, hooks: { afterFileEdit: [{ command: hook('cursor') }], stop: [{ command: hook('cursor') }], sessionStart: [{ command: hook('cursor') }] } }) } },
    { id: 'antigravity', name: 'Antigravity CLI (replaced Gemini CLI)', where: '~/.gemini/config/mcp_config.json (for a project, .agents/mcp_config.json in it)', text: json({ mcpServers: { mycel: stdio } }) },
    { id: 'gemini', name: 'Gemini CLI', where: '~/.gemini/settings.json (for a project, .gemini/settings.json in it)', text: json({ mcpServers: { mycel: stdio } }),
      command: `gemini mcp add -s user ${envFlags('-e')}mycel "${node}" "${server}"` },
    { id: 'vscode', name: 'VS Code (Copilot)', where: '.vscode/mcp.json in the project, or the shared one: "MCP: Open User Configuration"', text: json({ servers: { mycel: typed } }),
      command: env ? null : `code --add-mcp '${JSON.stringify({ name: 'mycel', type: 'stdio', command: node, args: [server] })}'` },
    { id: 'windsurf', name: 'Windsurf / Devin Desktop', where: '~/.config/devin/mcp_config.json (on Windows, %APPDATA%\\devin\\mcp_config.json; the old Windsurf, ~/.codeium/windsurf/mcp_config.json)', text: json({ mcpServers: { mycel: stdio } }) },
    { id: 'cline', name: 'Cline', where: 'Cline → MCP Servers → Configure MCP Servers (for Cline CLI, ~/.cline/data/settings/cline_mcp_settings.json)', text: json({ mcpServers: { mycel: Object.assign({}, stdio, { disabled: false }) } }),
      command: env ? null : `cline mcp add mycel --yes -- "${node}" "${server}"` },
    // Local model clients.
    { id: 'lmstudio', name: 'LM Studio', where: '~/.lmstudio/mcp.json (Windows: %USERPROFILE%\\.lmstudio\\mcp.json; in the app: Program → Install → Edit mcp.json)', text: json({ mcpServers: { mycel: stdio } }) },
    { id: 'continue', name: 'Continue', where: '~/.continue/config.yaml (for a project, .continue/mcpServers/mycel.yaml with name, version, schema: v1); MCP works in agent mode', text: yaml },
    { id: 'goose', name: 'Goose', where: '~/.config/goose/config.yaml (Windows: %APPDATA%\\Block\\goose\\config\\config.yaml), the extensions section; or goose configure → Add Extension → Command-line Extension', text: goose },
    { id: 'opencode', name: 'opencode', where: '~/.config/opencode/opencode.json (for a project, opencode.json in its root), the mcp section', text: json(Object.assign({ $schema: 'https://opencode.ai/config.json' }, { mcp: { mycel: Object.assign({ type: 'local', command: [node, server], enabled: true }, env ? { environment: env } : {}) } })) },
    { id: 'jan', name: 'Jan', where: 'mcp_config.json in the Jan data folder (Windows: %APPDATA%\\Jan\\data, macOS: ~/Library/Application Support/Jan/data, Linux: ~/.local/share/Jan/data); add to mcpServers without touching mcpSettings', text: json({ mcpServers: { mycel: Object.assign({}, stdio, { active: true }) } }),
      command: `jan cli mcp add mycel --command "${node}" --arg "${server}" ${envFlags('--env')}--active` },
    { id: 'openwebui', name: 'Open WebUI (through mcpo)', where: 'the mcpo settings file (mycel.json); then in Open WebUI, Settings → Integrations → Tools or Admin → Integrations: address http://localhost:8000/mycel', text: json({ mcpServers: { mycel: stdio } }),
      command: 'uvx mcpo --port 8000 --config mycel.json' },    { id: 'claude-desktop', name: 'Claude Desktop', where: 'claude_desktop_config.json: Settings → Developer → Edit Config (macOS: ~/Library/Application Support/Claude/, Windows: %APPDATA%\\Claude\\), then restart the app', text: json({ mcpServers: { mycel: stdio } }) }
  ];
}// The entry for one agent: what to paste and where, and what it lacks without Claude Code hooks.
function agentConfig(id, node, server, env, hook) {
  const all = agentConfigs(node, server, env, hook), a = all.find(x => x.id === id);
  if (!a) fail(`Agents: ${all.map(x => x.id).join(', ')}. Claude Code: node mycel.mjs plugin --install.`);
  console.log([`${a.name} — ${a.where}. Add the mycel entry to the other servers without overwriting them:`, '', a.text, '',
    ...(a.command ? [`Or with a command: ${a.command}`, ''] : []),
    ...(a.hooks ? [`Mycel hooks — ${a.hooks.where}: after a file edit its blocks are marked by themselves, at the end of a reply a reminder to update them comes, and at the start of a session an overview of the map. Add them to the other hooks:`, '', a.hooks.text, '',
      'Restart the agent: the mycel_* tools and hooks appear in a new session.']
      : ['Restart the agent: the mycel_* tools appear in a new session. This entry has no hooks: run node mycel.mjs watch in the project folder (changed files are marked by themselves) or call mycel_touch after editing files, and before finishing work update the blocks\' description or call mycel_fresh.'])].join('\n'));
}

// Access for virtual machines. Mycel accepts their requests on the address of their network (VMware, VirtualBox, Hyper-V,
// WSL) and only with a key. on opens it on the virtual network addresses (or --address), off closes it, revoke <id> revokes
// a machine key, and without options it shows what is open, which machines have access and how the agent there sets
// everything up. The main computer's key is printed only with --key: agents get their own keys through a request the person
// allows. On the first opening, Windows Firewall asks about node: the person answers.
async function remoteAccess(action) {
  await ensure();
  let state = ok(await call('/api/remote'));
  if (action === 'on' || action === 'off') {
    const wanted = action === 'off' ? [] : options.address ? idList(options.address) : state.interfaces.filter(i => i.vm).map(i => i.address);
    if (!wanted.length && action === 'on') fail(`No virtual machine adapters found. Give the address: node mycel.mjs remote on --address <address>. Adapters: ${state.interfaces.map(i => `${i.name} ${i.address}`).join('; ') || 'none'}.`);
    state = ok(await call('/api/remote', { addresses: wanted }));
  } else if (action === 'revoke') {
    if (!rest[2]) fail('node mycel.mjs remote revoke <machine id> (the id is in node mycel.mjs remote)');
    ok(await call(`/api/devices/${encodeURIComponent(rest[2])}/revoke`, {}));
    console.log(`Machine key ${rest[2]} revoked.`);
  } else if (action) fail('node mycel.mjs remote [on [--address address,…] | off | revoke <id>] [--key]');
  const access = ok(await call('/api/access'));
  if (!state.listening.length) { console.log('Access for virtual machines is closed. To open it: node mycel.mjs remote on'); return; }
  const name = a => (state.interfaces.find(i => i.address === a) || {}).name || 'adapter', open = state.listening.filter(l => l.listening);
  // The hint uses the address of the VMware NAT network (VMnet8): virtual machines are there by default.
  const best = open.find(l => /vmnet8/i.test(name(l.address))) || open[0], first = best ? `http://${best.address}:${state.port}` : null;
  if (options.key && token === null) token = ok(await call('/api/session')).token;
  console.log(['Mycel accepts requests from virtual machines, only with a key:',
    ...state.listening.map(l => l.listening ? `- http://${l.address}:${state.port} (${name(l.address)})` : `- ${l.address}: not open: ${l.error}`),
    ...(access.devices.length ? ['', 'Machines with access (remote revoke <id> to revoke):', ...access.devices.map(d => `- ${d.id} · ${d.name} (${d.address})${d.project ? `, project ${d.project}` : ''}${d.lastSeen ? `, last seen ${new Date(d.lastSeen).toLocaleString('en-GB')}` : ''}`)] : []),
    ...(access.pending.length ? ['', 'Waiting for an answer (answer with the buttons in Mycel):', ...access.pending.map(r => `- ${r.name} (${r.address}), code ${r.code}`)] : []),
    ...(first ? ['', 'The agent in the virtual machine sets everything up itself: Node.js, a Mycel copy and the access request:',
      `  curl -fsS ${first}/install.sh | sh`,
      'The person compares the code in the output with the code in Mycel on the main computer and presses "Allow".',
      ...(options.key ? ['', `The main computer's key (by hand: join <address> <key>; in the browser: ${first}/?key=<key>): ${token}`, 'The key gives full access to Mycel: do not publish it.'] : []),
      '', 'To close access: node mycel.mjs remote off. If the virtual machine cannot reach it: Windows Firewall must let node through, and a VPN must not take over the virtual machine network.'] : [])].join('\n'));
}
// A Mycel copy in a virtual machine connects to Mycel on the main computer: the address, key and project are in
// <data>/remote.json. Without a key, an access request: a code is printed, the person compares it and presses "Allow" in
// Mycel on the main computer, and the machine gets its own key (waits up to 10 minutes, --timeout). --off disconnects.
async function joinHost() {
  const file = join(data, 'remote.json');
  if (options.off !== undefined || input === '--off' || input === 'off') { await unlink(file).catch(() => {}); console.log('This Mycel copy is no longer connected to another machine.'); return; }
  const address = rest[1];
  let key = rest[2] || null, url = null, granted = null;
  // The address can also be given without http://: 192.168.241.1:4317.
  try { url = new URL(/^[a-z]+:\/\//i.test(address || '') ? address : `http://${address}`); } catch (e) { fail('node mycel.mjs join <address> [key] [--project id], the address is for example http://192.168.241.1:4317'); }
  if (url.protocol !== 'http:' || !privateHost(url.hostname)) fail('You can connect only to Mycel in the local network: the key is not sent to other addresses.');
  if (key !== null && !/^[A-Za-z0-9_-]{16,256}$/.test(key)) fail('The key does not look like a Mycel key. Without a key, join asks for access, and the person allows it with a button.');
  const request = async (path, body) => {
    const res = await fetch(new URL(path, url), { method: body ? 'POST' : 'GET', headers: Object.assign({ 'X-Mycel-Actor': actor }, key ? { Authorization: `Bearer ${key}` } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: res.status, value: await res.json().catch(() => null) };
  };
  const unreachable = () => fail(`Mycel at ${url.origin} does not answer. On the main computer: node mycel.mjs remote on; Windows Firewall must let node through, and a VPN must not take over the virtual machine network.`);
  let h = null;
  try { h = await request('/api/health'); } catch (e) { unreachable(); }
  if (!h.value || h.value.app !== 'mycel') fail(`Something other than Mycel answers at ${url.origin}.`);
  if (key === null) {
    const asked = await request('/api/pair', { name: hostname() });
    if (asked.status !== 200) fail(asked.value?.error ?? `Error ${asked.status}.`);
    const limit = Math.min(Number(options.timeout || 600), 3600), until = Date.now() + limit * 1000;
    console.log(`Access request sent to ${url.origin}. Code ${asked.value.code}: the person compares it and presses "Allow" in Mycel on the main computer. Waiting up to ${Math.round(limit / 60)} min…`);
    for (;;) {
      if (Date.now() > until) fail('No answer. Ask for access again: node mycel.mjs join <address>.', 2);
      await sleep(2000);
      let answer = null;
      try { answer = await request(`/api/pair/${asked.value.id}?secret=${asked.value.secret}`); } catch (e) { continue; }
      if (answer.status !== 200) fail(answer.value?.error ?? `Error ${answer.status}.`);
      const s = answer.value.status;
      if (s === 'approved') { key = answer.value.key; granted = answer.value.project; break; }
      if (s === 'denied') fail('The person denied the access request.');
      if (s === 'expired') fail('The request expired: the person did not answer within 10 minutes. Ask for access again: node mycel.mjs join <address>.', 2);
    }
    try { h = await request('/api/health'); } catch (e) { unreachable(); }
  }
  if (!h.value.data) fail('The key does not fit: ask for access again with node mycel.mjs join <address> without a key.');
  const id = options.project || granted || null, list = (await request('/api/projects')).value?.projects || [];
  if (id && !list.some(p => p.id === id)) fail(`There is no project ${id} there. Projects: ${list.map(p => `${p.id} (${p.name})`).join(', ') || 'none'}.`);
  await mkdir(data, { recursive: true });
  await writeFile(file, `${JSON.stringify({ url: url.origin, token: key, project: id }, null, 2)}\n`, { mode: 0o600 });
  const me = `"${process.execPath}" "${join(appRoot, 'mycel.mjs')}"`;
  console.log([`Connected to Mycel at ${url.origin}${id ? `, project ${id}` : ''}.`,
    ...(h.value.version !== version ? [`The version there is ${h.value.version}, here ${version}: update the Mycel copy here, otherwise commands will refuse to work.`] : []),
    ...(id ? [] : ['No project chosen: repeat join with --project <id> or add --project to commands. Projects:', ...list.map(p => `- ${p.id} · ${p.name}`)]),
    `Next: the guide is ${me} guide; map commands run from the project folder on this machine; the browser is ${me} open; the Claude Code plugin is ${me} plugin.`].join('\n'));
}
// Mycel tools for any model with function calling: descriptions (--format openai by default, or mcp) and a call by name
// with JSON arguments, the same as the MCP server does. This is how Mycel plugs into your own agent on Ollama, LM Studio,
// llama.cpp or into a framework without MCP.
async function listTools() {
  const { tools, schema } = await import('./src/tools.mjs'), format = options.format || 'openai';
  if (!['openai', 'mcp'].includes(format)) fail('--format openai or mcp');
  console.log(JSON.stringify(tools.map(t => format === 'mcp' ? { name: t.name, description: t.description, inputSchema: schema(t) } : { type: 'function', function: { name: t.name, description: t.description, parameters: schema(t) } }), null, 2));
}
// Variables for the command a tool runs: the address, data and key given to this command explicitly.
const childEnv = () => Object.assign({}, process.env, options.url ? { MYCEL_URL: origin } : {}, options.data ? { MYCEL_DATA: data } : {}, options.token ? { MYCEL_TOKEN: token } : {});
async function callTool() {
  const { tools, runTool, toolResult } = await import('./src/tools.mjs');
  const tool = tools.find(t => t.name === input || t.name === `mycel_${input}`);
  if (!tool) fail(`No tool ${input || ''}. List: node mycel.mjs tools.`);
  const raw = rest[2] === undefined ? '{}' : rest[2] === '-' ? await readText('-') : rest[2];
  let args = null;
  try { args = JSON.parse(raw.replace(/^\uFEFF/, '') || '{}'); } catch (e) { fail(`The arguments are not JSON: ${e.message}`); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('The arguments must be a JSON object.');
  const r = toolResult(tool, await runTool(tool, args, { cwd: process.cwd(), actor, env: childEnv() }));
  console.log(r.text);
  if (r.error) quit(1);
}
// Watching the project files, for any agent and for the person's edits in an editor: changed files are marked the same
// way as by the Claude Code hook after an edit (touch): their blocks become "outdated?", with a name above them (editor by
// default). Changes are collected for a second; dependencies, build output, .git and data are not watched. Runs until stopped.
async function watchFiles() {
  const { watch } = await import('node:fs'), root = here();
  let queue = new Set(), timer = null;
  const flush = async () => {
    timer = null;
    const files = [...queue].slice(0, 50); queue = new Set([...queue].slice(50));
    if (queue.size) timer = setTimeout(flush, 1000);
    if (!files.length) return;
    const res = await call(at('/touch'), { actor, files }).catch(e => ({ status: 0, value: { error: e.message } }));
    if (res.status !== 200) { console.error(`Not marked (${files.join(', ')}): ${res.value?.error ?? res.status}`); return; }
    const r = res.value;
    if (r.blocks.length) console.log(`${new Date().toLocaleTimeString('en-GB')} ${files.join(', ')} → ${r.blocks.map(b => `"${b.name}"`).join(', ')}`);
    for (const o of r.others) console.log(`Block "${o.name}" (${o.id}) is being worked on by ${o.by}.`);
  };
  watch(root, { recursive: true }, (event, name) => {
    if (!name) return;
    const rel = String(name).replace(/\\/g, '/');
    if (rel.split('/').some(part => skipDirs.has(part)) || secretFile(basename(rel))) return;
    let info = null;
    try { info = statSync(join(root, rel)); } catch (e) { info = null; }
    if (info && !info.isFile()) return;
    queue.add(rel);
    if (!timer) timer = setTimeout(flush, 1000);
  });
  console.log(`Watching ${root}: changed files are marked on the map of project "${project.name}" as ${actor}. Ctrl+C to stop.`);
  await new Promise(() => {});
}
// The built-in agent for a local model (src/agent.mjs): the server with an OpenAI-compatible API is --base or MYCEL_LLM_URL,
// Ollama by default (http://127.0.0.1:11434/v1); the model is --model or MYCEL_LLM_MODEL, otherwise the first one from
// /models; the key is MYCEL_LLM_KEY. A task text after chat is one turn; without it, a conversation. The name on the map is local-<model>.
async function chat() {
  const { runChat } = await import('./src/agent.mjs');
  const llm = (options.base || env('LLM_URL') || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''), key = env('LLM_KEY') || null;
  let model = options.model || env('LLM_MODEL') || null;
  if (!model) {
    const list = await fetch(`${llm}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) }).then(r => r.json(), () => null);
    model = list?.data?.[0]?.id || list?.models?.[0]?.name || null;
    if (!model) fail(`No answer from ${llm}/models. Start Ollama, LM Studio or llama-server and give the model: --model <name> (--base <address /v1>).`);
  }
  if (!options.actor && !env('ACTOR')) actor = `local-${model.replace(/[^A-Za-z0-9._-]+/g, '-')}`.slice(0, 60);
  await ensure();
  const { root, git, path } = projectRoot(process.cwd()), id = projectId();
  let res = await call(id ? `/api/p/${encodeURIComponent(id)}` : `/api/projects?${new URLSearchParams(Object.assign({ path }, git ? { root } : {}))}`);
  if (!id && res.status === 404 && joined && joined.project) res = await call(`/api/p/${encodeURIComponent(joined.project)}`);
  project = res.status === 200 && !res.value.project.error ? res.value.project : null;
  const guide = await renderGuide({ url: origin, short: true });
  const view = project ? overview(ok(await call(at('/graph'))), ok(await call(at('/code')))) : `The folder ${root} is not connected to Mycel: connect it with mycel_init (name it after what the project is).`;
  const system = [guide, '', view, '', `You work in the project folder ${project ? here() : root}. The mycel_* tools change the map the person sees in the browser; list_files, read_file and search_files read the project code. You do not change code.`].join('\n');
  // End of a reply: blocks whose files were marked changed under your name are to be described again or confirmed.
  const afterTurn = async () => {
    if (!project) return null;
    const mine = ok(await call(at('/code'))).stale.filter(s => s.by === actor);
    return mine.length ? `Mycel: the files of the blocks ${mine.map(s => `"${s.name}" (${s.id})`).join(', ')} changed, and the description of these blocks is not updated. Update them (mycel_apply) or confirm the description is right (mycel_fresh), and answer briefly.` : null;
  };
  console.error(`Mycel and model ${model} (${llm}), name on the map: ${actor}${project ? `, project "${project.name}"` : ''}.`);
  try { await runChat({ base: llm, model, key, actor, cwd: project ? here() : root, system, prompt: rest.slice(1).join(' ').trim() || null, env: childEnv(), afterTurn }); }
  catch (e) { fail(e.message); }
}
const projectCommands = ['context', 'graph', 'changes', 'wait', 'selection', 'apply', 'build', 'propose', 'mark', 'doing', 'show', 'touch', 'fresh', 'check', 'review', 'health', 'overview', 'watch'];
async function main() {
  if (!command || command === 'help') return console.log(usage);
  if (![...projectCommands, 'init', 'projects', 'open', 'start', 'stop', 'guide', 'hook', 'plugin', 'remote', 'join', 'tools', 'call', 'chat'].includes(command)) { console.log(usage); quit(1); }
  if (missing) fail(`Give a value for ${missing}.`);
  if (command === 'join') return joinHost();
  if (!base || base.protocol !== 'http:' || !(loopback || privateHost(base.hostname))) fail('Mycel runs on this computer or in the local network (the main computer for a virtual one): the key is not sent to other addresses.');
  if (remote && !token && command !== 'guide' && command !== 'hook') fail(`Mycel on another machine needs a key: node mycel.mjs join ${origin} <key> --project <id> (the key is printed by "node mycel.mjs remote" on the main computer).`);
  if (remote && ['start', 'stop', 'remote'].includes(command)) fail('This is done on the main computer: Mycel is started and stopped and access is opened there.');
  // Hooks are run by the agent whose hook it is (--from: codex, cursor; Claude Code by default); edits noticed by watch are
  // under the name editor. An explicit name (--actor, MYCEL_ACTOR) takes precedence.
  if (!options.actor && !env('ACTOR')) { if (command === 'hook') actor = options.from || 'claude'; if (command === 'watch') actor = 'editor'; }
  if (!/^[ -~]{1,100}$/.test(actor) || !actor.trim()) fail('The agent name (--actor) must be in Latin letters, up to 100 characters.');
  if (command === 'hook') { try { await hook(); } catch (e) { /* the hook stays silent: the Claude Code reply must not break */ } return; }
  if (command === 'plugin') return plugin();
  if (command === 'tools') return listTools();
  if (command === 'call') return callTool();
  if (command === 'chat') return chat();
  if (projectCommands.includes(command)) { await ensure(); project = await resolveProject(); }
  switch (command) {
    case 'guide': console.log(await renderGuide({ url: origin, remote: remote ? 'joined' : null, short: Boolean(options.short) })); break;
    case 'watch': await watchFiles(); break;
    case 'remote': await remoteAccess(input); break;
    case 'start': await ensure(); console.log(`Mycel: ${origin}`); break;
    case 'open': {
      // The person opens Mycel after an update: a hub of an older version with the same data is replaced by the current one.
      // Agent commands do not do this: they only report that Mycel was updated.
      const h = await health();
      if (!remote && !options['no-start'] && ours(h?.app) && h.version !== version && typeof h.data === 'string' && pathKey(h.data) === pathKey(data) && (await stopHub(h)).status === 200) console.error(`Stopped Mycel ${h.version}.`);
      await ensure();
      // In a virtual machine the browser opens a link with the key: Mycel sets a cookie and removes the key from the address.
      const url = `${origin}/`, link = remote ? `${origin}/?key=${token}` : url;
      const [file, list, extra] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `start "" "${link}"`], { windowsVerbatimArguments: true }] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [link], {}];
      try { const child = spawn(file, list, { ...extra, detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', () => {}); child.unref(); } catch { /* the browser did not open: the address is printed */ }
      console.log(`Mycel: ${url}`);
      break;
    }
    case 'stop': {
      const h = await health();
      if (!h) { console.log('Mycel is not running.'); break; }
      check(h, true);
      const res = await stopHub(h);
      if (res.status !== 200) fail(`Error ${res.status}: ${res.value?.error ?? res.value}`);
      console.log(`Mycel stopped: ${origin}.`);
      break;
    }
    case 'init': {
      const folder = resolve(input ?? '.');
      if (!isDir(folder)) fail(`No such folder: ${folder}`);
      await ensure();
      // A repository is its own project, as in the search: a connected or deleted folder above its root does not count
      // (root), otherwise the next command would not find the project the folder "belongs to". A deleted project of the
      // repository itself means stop.
      const { root, git } = projectRoot(folder);
      const res = await call('/api/projects', { path: root, ...(git ? { root } : {}), ...(options.name ? { name: options.name } : {}), ...(options.project ? { id: options.project } : {}), ...(options.move ? { move: true } : {}), ...(options.new ? { new: true } : {}) });
      if (res.value?.deleted) fail(deletedText(res.value.deleted.name));
      if (res.status !== 200) fail(res.status === 400 ? `${res.value?.error} Folder: ${root}` : res.value?.error ?? `Error ${res.status}.`);
      const { project: p, created, moved, renamed, ancestor } = res.value, link = `${origin}/#/p/${p.id}`;
      console.log(created ? `Project "${p.name}" connected: ${link}` : moved ? `Project "${p.name}" is now in the folder ${p.path}` : renamed ? `Project renamed to "${p.name}": ${link}` : ancestor ? `The folder belongs to project "${p.name}" (${p.path}): ${link}` : `Project "${p.name}" is already connected: ${link}`);
      break;
    }
    case 'projects': {
      await ensure();
      const { projects } = ok(await call('/api/projects'));
      console.log(projects.length ? projects.map(p => `${p.id} · ${p.name} · ${[p.path, p.machine && `(on machine "${p.machine.name}")`, p.exists === false && '(folder missing)'].filter(Boolean).join(' ')}${p.error ? ` · cannot be opened: ${p.error}` : ''}`).join('\n') : 'No projects.');
      break;
    }
    case 'context': {
      const query = new URLSearchParams({ ...(options.focus ? { focus: options.focus } : {}), ...(options.brief ? { brief: '1' } : {}) }).toString();
      // The map has already been received in full: the read mark is saved before printing so cut output does not lose it.
      // The person's actions count as read only together with printing: otherwise what came while the agent was not waiting would be lost.
      const cursor = await readCursor(), value = ok(await call(at(`/context${query ? `?${query}` : ''}`)));
      const unread = ok(await call(at(`/chat?since=${cursor.chat}`)));
      const fresh = unread.messages.filter(m => m.updatedBy !== actor && m.kind !== 'log'), shown = fresh.slice(-20);
      const news = shown.length ? `\n## ${chatHeader}\n${fresh.length > shown.length ? `(${fresh.length - shown.length} more before)\n` : ''}${formatChat(shown, ok(await call(at('/graph'))))}` : null;
      await saveCursor({ revision: Number(/^Revision: (\d+)/m.exec(value)[1]), chat: unread.seq });
      console.log(value);
      if (news) console.log(news);
      break;
    }
    case 'graph': {
      const value = ok(await call(at('/graph')));
      await saveCursor({ revision: value.revision });
      console.log(JSON.stringify(value, null, 2));
      break;
    }
    case 'changes': await report(ok(await call(changesUrl(await needCursor())))); break;
    case 'wait': {
      const cursor = await needCursor(), limit = Number(options.timeout ?? 0), until = limit > 0 ? Date.now() + limit * 1000 : Infinity;
      let warned = false;
      while (Date.now() < until) {
        const wait = Math.max(1, Math.min(60, Math.round((until - Date.now()) / 1000)));
        let res;
        // The cursor does not move until there is a content edit or a message: accumulated moves come with them.
        try { res = await call(changesUrl(cursor, `&wait=${wait}${options.all ? '' : '&content=1'}`)); }
        catch {
          // The hub is restarting or unavailable: wait for it without exiting. A deleted project means an exit at once, with no retries.
          if (!warned) console.error('Mycel is unavailable, still waiting…');
          warned = true; await sleep(3000); continue;
        }
        warned = false;
        const value = ok(res);
        if (!value.complete || value.chat.messages.length || (options.all ? value.entries.length > value.held : value.contentChanged)) return report(value);
      }
      fail('No changes.', 2);
      break;
    }
    case 'apply': {
      const body = await readInput(), operations = Array.isArray(body) ? body : body?.operations;
      await write(options.message ?? body?.message ?? 'Agent changes', operations);
      break;
    }
    case 'build': {
      // The structure is built on the fresh map, and only if it was not changed after the agent's read.
      const spec = await readInput(), { revision } = await needCursor(), current = ok(await call(at('/graph')));
      if (current.revision !== revision) await conflict(revision);
      const { ops, outline } = buildOps(spec, current), after = ['', 'Blocks (id — title):', ...outline];
      if (!ops.length) {
        if (!spec.blocks?.length && !spec.notes?.length && !spec.links?.length) fail('The structure has no blocks, notes or links.');
        console.log(['Everything in the structure is already on the map.', ...after].join('\n'));
        break;
      }
      // The result is computed in advance: an error in the structure and level violations show before the first write, and
      // the steps get ready geometry. Only what will be written is checked: on a repeat, what is already written is skipped.
      const final = applyOperations(current, ops).graph;
      checkLevels(current, ops);
      await commitSteps(options['at-once'] ? [ops] : stages(current, final, ops, spec.parent ?? null), options.message ?? spec.message ?? 'Built the map structure', revision, after);
      break;
    }
    case 'propose': {
      // A structure in build format and/or apply operations; new items appear dashed and highlighted, the person decides.
      const spec = await readInput(), { revision } = await needCursor(), current = ok(await call(at('/graph')));
      if (current.revision !== revision) await conflict(revision);
      const list = Array.isArray(spec) ? spec : null, structure = !list && (spec?.blocks || spec?.notes || spec?.links);
      const { ops, outline } = structure ? buildOps(spec, current) : { ops: [], outline: [] };
      const operations = [...ops, ...(list ?? spec?.operations ?? [])], title = options.message ?? spec?.title ?? spec?.message;
      if (!operations.length) fail('The proposal has neither blocks nor operations: everything in the structure is already on the map.');
      if (!current.proposal && !(typeof title === 'string' && title.trim())) fail('Name the proposal: "title" in the file or -m.');
      checkLevels(current, operations);
      const res = await call(at('/proposal'), { expectedRevision: revision, actor, title, operations });
      if (res.status === 409) await conflict(revision);
      const next = ok(res).revision;
      await saveCursor({ revision: next });
      await written([next], [...(outline.length ? ['', 'Blocks (id — title):', ...outline] : []), '', `Proposal "${ok(res).proposal.title}" is on the map: new items are dashed and highlighted. The person accepts or rejects it with the buttons; the decision comes in wait and changes.`]);
      break;
    }
    case 'mark': {
      const ids = (input ?? '').split(',').map(x => x.trim()).filter(Boolean), value = rest[2];
      if (!ids.length || !['plan', 'testing', 'passed', 'failed', 'none'].includes(value)) fail('mycel mark <id[,id…]> plan|testing|passed|failed|none');
      await write(options.message ?? `Mark: ${value === 'none' ? 'no mark' : markNames[value]}`, ids.map(id => ({ type: 'update-node', id, patch: { status: value === 'none' ? null : value } })));
      break;
    }
    case 'selection': {
      // What the person is talking about: the selected node and the block they are working in, with full text.
      const { focus, selection } = ok(await call(at('/selection'))), graph = ok(await call(at('/graph'))), name = namer(graph);
      const full = (label, id) => { const n = graph.nodes.find(x => x.id === id); return [`${label}: ${name(id)} — ${n.type === 'note' ? 'note' : 'block'}${n.parentId ? ` inside ${name(n.parentId)}` : ' on the main map'}${n.status ? `, ${markNames[n.status]}` : ''}`, ...(n.text ? [n.text] : [])].join('\n'); };
      console.log([selection && full('Selected', selection), focus && full('Working in block', focus)].filter(Boolean).join('\n\n') || 'The person has not selected anything and is not working in any block.');
      break;
    }
    case 'doing': {
      const text = options.done ? null : rest.slice(1).join(' ').trim(), progress = options.progress === undefined ? null : Number(options.progress);
      if (!options.done && !text) fail('mycel doing \'what you are doing now\' [--progress 0–100] [--on id,…] or mycel doing --done');
      const blocks = text ? idList(options.on) : [], r = ok(await call(at('/activity'), { actor, text, progress, blocks }));
      console.log([text ? `Under the map: "${text}"${progress !== null ? `, ${progress} %` : ''}${blocks.length ? `; blocks ${blocks.join(', ')} are marked with your name` : ''}.` : 'The line under the map is cleared.',
        ...r.others.map(o => `Block "${o.name}" (${o.id}) is being worked on by ${o.by}: agree with the person before taking it up.`)].join('\n'));
      break;
    }
    case 'show': {
      if (!input) fail('mycel show <block id>');
      ok(await call(at('/show'), { id: input, actor }));
      console.log(`Shown to the person: ${namer(ok(await call(at('/graph'))))(input)}.`);
      break;
    }
    // Files the agent is changing (the same as the Claude Code hook after a file edit): their blocks are "being edited".
    case 'touch': {
      const files = rest.slice(1).map(f => relative(here(), resolve(f)).replace(/\\/g, '/')).filter(f => f && !f.startsWith('..') && !isAbsolute(f));
      if (!files.length) fail('mycel touch <file…>: files inside the project folder.');
      const r = ok(await call(at('/touch'), { actor, files }));
      console.log([r.blocks.length ? `Blocks of these files: ${r.blocks.map(b => `"${b.name}" (${b.id})`).join(', ')}; they are marked "possibly outdated" until you describe them again or confirm them (mycel fresh).` : 'No block has these files.',
        ...r.others.map(o => `Block "${o.name}" (${o.id}) is being worked on by ${o.by}.`)].join('\n'));
      break;
    }
    case 'fresh': {
      const ids = options.all ? null : idList(input);
      if (ids !== null && !ids.length) fail('mycel fresh <id[,id…]> or mycel fresh --all');
      const { fresh } = ok(await call(at('/fresh'), { actor, ids }));
      console.log(fresh.length ? `Description confirmed, the "outdated" flag is cleared: ${fresh.join(', ')}.` : 'None of them are outdated.');
      break;
    }
    case 'check': await runChecks(idList(input)); break;
    case 'review': {
      const query = options.since !== undefined ? `since=${encodeURIComponent(options.since)}` : `hours=${encodeURIComponent(options.hours || 24)}`;
      console.log(ok(await call(at(`/review?${query}`))).text);
      break;
    }
    case 'health': await healthReport(); break;
    case 'overview': console.log(overview(ok(await call(at('/graph'))), ok(await call(at('/code'))))); break;
  }
}

try { await main(); }
catch (e) {
  if (e instanceof Exit) process.exitCode = e.code;
  // A model error (for example, in a build structure) and a missing hub give a message, without a stack trace.
  else if (e instanceof Problem) { console.error(e.message); process.exitCode = 1; }
  else if (e instanceof TypeError && e.message === 'fetch failed') { console.error(`Mycel does not answer: ${origin}.`); process.exitCode = 1; }
  else throw e;
}
