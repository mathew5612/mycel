import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, rename, cp } from 'node:fs/promises';
import { realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { startServer } from '../server.mjs';
import { measure } from '../src/layout.mjs';

const appRoot = join(import.meta.dirname, '..'), script = join(appRoot, 'mycel.mjs');
const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
const launcher = join(appRoot, process.platform === 'win32' ? 'Mycel.cmd' : 'Mycel.command');
const temp = async prefix => realpathSync.native(await mkdtemp(join(tmpdir(), prefix)));
const clean = (...dirs) => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
const freePort = () => new Promise((resolve, reject) => { const probe = net.createServer().on('error', reject).listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const until = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await check()) return; assert.fail('Timed out waiting'); };
const idOf = out => /#\/p\/([a-z0-9-]+)/.exec(out)?.[1];

// An agent command as a separate process. The real .mycel and port 4317 are not touched: the data folder is always
// temporary, the address always explicit, Mycel does not start by itself (except in one autostart test); the developer's variables do not matter.
// cut is like head or Select-Object -First: the process ends as soon as it has printed the first lines.
function mycel(args, { cwd = tmpdir(), data, url, start = false, env = {}, cut = false, input = null }) {
  // CLAUDE_PID and MYCEL_CLAUDE are not passed: plugin --install in tests must not find the real claude.
  const drop = new Set(['MYCEL_URL', 'MYCEL_DATA', 'MYCEL_ACTOR', 'MYCEL_TOKEN', 'MYCEL_PROJECT', 'MYCEL_CLAUDE', 'KONTUR_URL', 'KONTUR_DATA', 'KONTUR_ACTOR', 'CLAUDECODE', 'CLAUDE_PID', ...Object.keys(env).map(k => k.toUpperCase())]);
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.has(k.toUpperCase())));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args, ...(url ? ['--url', url] : []), ...(start ? [] : ['--no-start'])], { cwd, env: { ...own, MYCEL_DATA: data, MYCEL_ACTOR: 'tester', ...env }, windowsHide: true });
    if (input !== null) child.stdin.end(input);
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', c => { out += c; if (cut) child.kill(); });
    child.stderr.setEncoding('utf8').on('data', c => { err += c; });
    child.on('error', reject).on('close', code => resolve({ code, out, err }));
  });
}
// A hub in the test process on a temporary data folder and a free port; folder is a temporary project folder.
async function hubFixture(t) {
  const dir = await temp('mycel-cli-data-'), app = await startServer({ data: dir, port: 0 });
  t.after(async () => { await app.close(); await clean(dir); });
  const token = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  const api = async (path, body) => {
    const res = await fetch(app.url + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) } : {});
    return { status: res.status, body: await res.json() };
  };
  const folder = async (prefix = 'mycel-cli-folder-') => { const d = await temp(prefix); t.after(() => clean(d)); return d; };
  return { url: app.url, data: app.data, api, folder, run: (args, cwd, env) => mycel(args, { cwd, env, data: app.data, url: app.url }), cut: (args, cwd) => mycel(args, { cwd, data: app.data, url: app.url, cut: true }),
    // The hook as Claude Code calls it: the event JSON on standard input.
    hook: (event, env) => mycel(['hook'], { cwd: event.cwd, env, data: app.data, url: app.url, input: JSON.stringify(event) }) };
}
// A connected project with the map read.
async function connected(h, name) {
  const dir = await h.folder(), init = await h.run(['init', '--name', name], dir);
  assert.equal(init.code, 0, init.err);
  const read = await h.run(['context'], dir);
  assert.equal(read.code, 0, read.err);
  return { dir, id: idOf(init.out) };
}
const geometry = graph => Object.fromEntries(graph.nodes.map(n => [n.id, [n.parentId, n.attachedTo, n.collapsed, n.x, n.y, n.w, n.h]]));
const links = graph => graph.edges.map(e => `${e.source}>${e.target}:${e.label}`).sort();
// On no level do blocks (together with their attached notes) and free notes overlap.
function overlaps(graph) {
  const { shown } = measure(graph), found = [];
  for (const level of new Set(graph.nodes.map(n => n.parentId))) {
    const all = graph.nodes.filter(n => n.parentId === level);
    const units = all.filter(n => n.type !== 'note' || !n.attachedTo).map(n => {
      const rs = [n, ...all.filter(k => k.attachedTo === n.id)].map(k => ({ x: k.x, y: k.y, ...shown(k) }));
      const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
      return { id: n.id, x, y, r: Math.max(...rs.map(r => r.x + r.w)), b: Math.max(...rs.map(r => r.y + r.h)) };
    });
    for (const a of units) for (const b of units) if (a.id < b.id && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b) found.push(`${a.id} × ${b.id}`);
  }
  return found;
}

const concepts = {
  message: 'Concepts',
  blocks: [
    { title: 'Interface', text: 'The map in the browser', notes: ['No build step'] },
    { title: 'Hub', text: 'One process for all projects', notes: ['Port 4317'],
      blocks: [{ title: 'Registry', text: 'Projects and their folders' }, { title: 'Map', blocks: [{ title: 'Write' }, { title: 'Read' }] }] },
    { title: 'Agents', text: 'Commands for agents', blocks: [{ title: 'Cursor' }, { title: 'Waiting', text: 'A long request' }] },
    { title: 'Checks' }
  ],
  notes: ['Everything is local'],
  links: [['Interface', 'Hub', 'HTTP'], ['Agents', 'Hub', 'HTTP'], ['Registry', 'Map', 'project id'], ['Cursor', 'Waiting']]
};
// The mechanics of a concept; "Draw" is already technical (a sub-map of mechanics): functions and files in backticks are allowed there.
const mechanics = parent => ({
  parent, message: `Mechanics ${parent}`,
  blocks: [
    { title: 'Canvas', text: 'Draws blocks and links', blocks: [{ title: 'Draw', text: '`render()` in `public/app.js`' }, { title: 'Move' }] },
    { title: 'Chat', text: 'Messages of the person and agents', notes: ['The last 500 messages'] },
    { title: 'Home' }
  ],
  links: [['Home', 'Canvas', 'id'], ['Canvas', 'Chat']]
});

test('init connects a folder once; its subfolder belongs to it, a repository inside it is a project of its own', async t => {
  const h = await hubFixture(t), dir = await h.folder(), sub = join(dir, 'src', 'deep'), name = basename(dir);
  await mkdir(sub, { recursive: true });
  let r = await h.run(['init'], dir);
  assert.equal(r.code, 0, r.err);
  const id = idOf(r.out);
  assert.equal(r.out.trim(), `Project "${name}" connected: ${h.url}/#/p/${id}`);
  r = await h.run(['init'], dir);
  assert.equal(r.out.trim(), `Project "${name}" is already connected: ${h.url}/#/p/${id}`);
  r = await h.run(['init'], sub);
  assert.equal(r.out.trim(), `The folder belongs to project "${name}" (${dir}): ${h.url}/#/p/${id}`);
  r = await h.run(['context'], sub);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# Map\nRevision: 0\n/);
  // The search from a repository does not go above its root, so init makes the repository a separate project.
  const repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true }); await mkdir(join(repo, 'lib'));
  r = await h.run(['init', 'lib', '--name', 'Library'], repo);
  assert.equal(r.out.trim(), `Project "Library" connected: ${h.url}/#/p/library`, r.err);
  r = await h.run(['context'], join(repo, 'lib'));
  assert.equal(r.code, 0, r.err);
  r = await h.run(['projects']);
  assert.deepEqual(r.out.trim().split('\n').sort(), [`${id} · ${name} · ${dir}`, `library · Library · ${repo}`].sort());
});

// A name for an already connected folder is a rename: the id and map stay the same, and a subfolder does not change the parent project.
test('init --name renames the project of a connected folder, not the project a subfolder belongs to', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Kontur');
  await mkdir(join(dir, 'lib'));
  let r = await h.run(['init', '--name', 'Mycel'], dir);
  assert.equal(r.out.trim(), `Project renamed to "Mycel": ${h.url}/#/p/${id}`, r.err);
  r = await h.run(['init', '--name', 'Mycel'], dir);
  assert.equal(r.out.trim(), `Project "Mycel" is already connected: ${h.url}/#/p/${id}`, r.err);
  r = await h.run(['init', '--name', 'Other'], join(dir, 'lib'));
  assert.equal(r.out.trim(), `The folder belongs to project "Mycel" (${dir}): ${h.url}/#/p/${id}`, r.err);
  r = await h.run(['init', '--project', id, '--name', 'Mycel 2'], dir);
  assert.equal(r.out.trim(), `Project renamed to "Mycel 2": ${h.url}/#/p/${id}`, r.err);
  const { projects } = (await h.api('/api/projects')).body;
  assert.deepEqual(projects.map(p => [p.id, p.name, p.path]), [[id, 'Mycel 2', dir]]);
  r = await h.run(['context'], dir);
  assert.equal(r.code, 0, r.err);
});

test('a repository inside a folder the human deleted is connected on its own; a deleted repository is not', async t => {
  const h = await hubFixture(t), dir = await h.folder(), repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  let r = await h.run(['init', '--name', 'Folder'], dir);
  assert.equal((await h.api(`/api/projects/${idOf(r.out)}/delete`, {})).status, 200);
  r = await h.run(['init'], repo);
  assert.equal(r.out.trim(), `Project "repo" connected: ${h.url}/#/p/repo`, r.err);
  r = await h.run(['context'], repo);
  assert.equal(r.code, 0, r.err);
  assert.equal((await h.api('/api/projects/repo/delete', {})).status, 200);
  r = await h.run(['init'], repo);
  assert.deepEqual([r.code, r.err.trim()], [1, 'Project "repo" was deleted by the person. Connect it again only at their request: mycel init --new.']);
});

test('a git worktree inside or outside the repository uses the project of the repository; a submodule is its own', async t => {
  const h = await hubFixture(t), repo = await h.folder(), outside = await h.folder();
  await mkdir(join(repo, '.git'));
  let r = await h.run(['init', '--name', 'Repository'], repo);
  const id = idOf(r.out);
  // A git worktree: .git is a file pointing to <repository>/.git/worktrees/<name>, which holds commondir.
  const worktree = async (dir, name) => {
    const gitdir = join(repo, '.git', 'worktrees', name);
    await mkdir(gitdir, { recursive: true }); await writeFile(join(gitdir, 'commondir'), '../..\n');
    await mkdir(join(dir, 'src'), { recursive: true }); await writeFile(join(dir, '.git'), `gitdir: ${gitdir.replace(/\\/g, '/')}\n`);
  };
  // Claude Code puts a worktree inside the repository, Codex into a folder of its own.
  for (const [dir, name] of [[join(repo, '.claude', 'worktrees', 'wt'), 'wt'], [join(outside, 'repo'), 'codex']]) {
    await worktree(dir, name);
    r = await h.run(['context', '--brief'], join(dir, 'src'));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^# Map\nRevision: 0\n/);
    r = await h.run(['init'], dir);
    assert.equal(r.out.trim(), `Project "Repository" is already connected: ${h.url}/#/p/${id}`, r.err);
  }
  // A submodule: gitdir in .git/modules, without commondir.
  const sub = join(repo, 'lib');
  await mkdir(join(repo, '.git', 'modules', 'lib'), { recursive: true }); await mkdir(sub);
  await writeFile(join(sub, '.git'), 'gitdir: ../.git/modules/lib\n');
  r = await h.run(['init'], sub);
  assert.equal(r.out.trim(), `Project "lib" connected: ${h.url}/#/p/lib`, r.err);
  assert.equal((await h.api('/api/projects')).body.projects.length, 2);
});

test('a command outside connected folders says how to connect; a moved project is re-bound with --project', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Moved'), moved = `${dir}-moved`;
  t.after(() => clean(moved));
  await rename(dir, moved);
  let r = await h.run(['projects']);
  assert.equal(r.out.trim(), `${id} · Moved · ${dir} (folder missing)`);
  r = await h.run(['context'], moved);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), `The folder is not connected to Mycel: ${moved}. Run mycel init in the project root.`);
  r = await h.run(['init', '--project', id], moved);
  assert.equal(r.out.trim(), `Project "Moved" is now in the folder ${moved}`, r.err);
  r = await h.run(['context'], moved);
  assert.equal(r.code, 0, r.err);
  r = await h.run(['graph', '--project', id]);
  assert.equal(JSON.parse(r.out).revision, 0);
});

test('a project deleted by the human ends wait and every command; only init --new connects the folder again', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Doomed');
  const waiting = h.run(['wait', '--timeout', '30'], dir);
  await until(async () => (await h.api('/api/projects')).body.projects.find(p => p.id === id)?.agents.some(a => a.actor === 'tester' && a.waiting));
  assert.equal((await h.api(`/api/projects/${id}/delete`, {})).status, 200);
  const text = 'Project "Doomed" was deleted by the person. Connect it again only at their request: mycel init --new.';
  let r = await waiting;
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), text);
  for (const args of [['context'], ['init'], ['doing', 'reading'], ['wait', '--timeout', '5']]) {
    r = await h.run(args, dir);
    assert.deepEqual([r.code, r.err.trim()], [1, text], args.join(' '));
  }
  r = await h.run(['init', '--new'], dir);
  assert.equal(r.code, 0, r.err);
  assert.notEqual(idOf(r.out), id);
});

test('build writes step by step and ends with the same map as --at-once', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-');
  const live = await connected(h, 'Step by step'), once = await connected(h, 'One batch');
  const file = async (name, spec) => { const path = join(work, name); await writeFile(path, JSON.stringify(spec)); return path; };
  const graph = async p => (await h.api(`/api/p/${p.id}/graph`)).body;
  const same = async when => {
    const [a, b] = [await graph(live), await graph(once)];
    assert.deepEqual(geometry(a), geometry(b), when);
    assert.deepEqual(links(a), links(b), when);
    assert.deepEqual(overlaps(a), [], when);
    return a;
  };
  let r = await h.run(['build', await file('concepts.json', concepts)], live.dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Written, revisions 1–3\.\n/);
  assert.ok(r.out.includes('Blocks (id — title):\n- interface — Interface\n- hub — Hub\n  - registry — Registry\n  - map — Map\n    - write — Write'), r.out);
  r = await h.run(['build', join(work, 'concepts.json'), '--at-once'], once.dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Written, revision 1\.\n/);
  const first = await same('concepts');
  assert.deepEqual((await h.api(`/api/p/${live.id}/history`)).body.history.map(e => e.message).reverse(), ['Concepts (step 1 of 3)', 'Concepts (step 2 of 3)', 'Concepts (step 3 of 3)']);
  assert.ok(['interface-note-1', 'hub-note-1', 'note-1'].every(id => first.nodes.some(n => n.id === id)), 'stable note ids');
  // The mechanics of two concepts: the concepts grow and push their neighbours apart, and the result is the same as with one batch.
  for (const parent of ['interface', 'agents']) {
    const path = await file(`${parent}.json`, mechanics(parent));
    for (const [p, extra] of [[live, []], [once, ['--at-once']]]) {
      r = await h.run(['build', path, ...extra], p.dir);
      assert.equal(r.code, 0, r.err);
    }
    await same(parent);
  }
  assert.equal((await graph(live)).revision, 5);
  assert.ok((await graph(live)).nodes.some(n => n.id === 'canvas-2' && n.parentId === 'agents' && n.collapsed));
});

test('the same build after an interrupted one adds only what is missing', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-');
  const resumed = await connected(h, 'Repeat'), once = await connected(h, 'At once');
  const full = join(work, 'full.json'), part = join(work, 'part.json');
  await writeFile(full, JSON.stringify(concepts));
  // As if build was interrupted after the first step: the concepts with notes and their links are written, but not the sub-maps.
  await writeFile(part, JSON.stringify({ ...concepts, blocks: concepts.blocks.map(({ blocks, ...b }) => b), links: concepts.links.slice(0, 2) }));
  for (const [p, path, extra] of [[resumed, part, []], [resumed, full, []], [once, full, ['--at-once']]]) {
    const r = await h.run(['build', path, ...extra], p.dir);
    assert.equal(r.code, 0, r.err);
  }
  const [a, b] = await Promise.all([resumed, once].map(async p => (await h.api(`/api/p/${p.id}/graph`)).body));
  assert.deepEqual(a.nodes.map(n => n.id).sort(), b.nodes.map(n => n.id).sort());
  assert.deepEqual(links(a), links(b));
  assert.deepEqual(overlaps(a), []);
  let r = await h.run(['build', full], resumed.dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Everything in the structure is already on the map\.\n/);
  assert.equal((await h.api(`/api/p/${resumed.id}/graph`)).body.revision, a.revision);
  // An explicit id taken by another block is an error, as before.
  await writeFile(part, JSON.stringify({ blocks: [{ id: 'hub', title: 'Another hub' }] }));
  r = await h.run(['build', part], resumed.dir);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'id "hub" is already taken on the map or in the structure.');
  // An error in the structure shows before writing, without a stack trace.
  await writeFile(part, JSON.stringify({ blocks: [{ title: 'Color', color: 'pink' }] }));
  r = await h.run(['build', part], resumed.dir);
  assert.deepEqual([r.code, r.err.trim()], [1, 'Unknown color of node "color".']);
});

test('a foreign edit between steps is built over; a removed container stops the build, the same build then finishes it', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), path = join(work, 'concepts.json');
  await writeFile(path, JSON.stringify(concepts));
  const ids = ['agents', 'checks', 'cursor', 'hub', 'hub-note-1', 'interface', 'interface-note-1', 'map', 'note-1', 'read', 'registry', 'waiting', 'write'];
  const graph = async p => (await h.api(`/api/p/${p.id}/graph`)).body;
  // The person's edit right after the first step: the next build step writes after 200 ms.
  const between = async (p, operations) => {
    for (const end = Date.now() + 5000; (await graph(p)).revision < 1; await new Promise(r => setTimeout(r, 10))) if (Date.now() > end) assert.fail('The first step was not written');
    assert.equal((await h.api(`/api/p/${p.id}/changes`, { expectedRevision: 1, actor: 'human', message: 'Human edit', operations })).status, 200);
  };
  const over = await connected(h, 'Over');
  let [r] = await Promise.all([h.run(['build', path], over.dir), between(over, [{ type: 'add-node', node: { id: 'foreign', title: 'Foreign', x: -2000, y: -2000 } }])]);
  assert.equal(r.code, 0, r.err);
  // Someone else's edit is the first line of the output, before writing over it; "Written" lists only its own revisions.
  assert.match(r.out, /^The map was changed while writing:\nMap changes after revision 1, now revision 2:\n- r2 human, [^\n]*: Human edit — Added block "Foreign"\n/);
  assert.ok(r.out.includes('\nWritten, revisions 1, 3–4.\n'), r.out);
  assert.equal(r.out.indexOf('r2 human'), r.out.lastIndexOf('r2 human'), r.out);
  assert.deepEqual((await graph(over)).nodes.map(n => n.id).sort(), [...ids, 'foreign'].sort());
  const stopped = await connected(h, 'Stopped');
  [r] = await Promise.all([h.run(['build', path], stopped.dir), between(stopped, [{ type: 'delete-node', id: 'hub' }])]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^Wrote step 1 of 3\.\n/);
  assert.ok(r.out.includes('Deleted: block "Hub" (hub)') && r.out.trim().endsWith('Repeat the same build: blocks already written will be skipped.'), r.out);
  r = await h.run(['build', path], stopped.dir);
  assert.equal(r.code, 0, r.err);
  const done = await graph(stopped);
  assert.deepEqual(done.nodes.map(n => n.id).sort(), ids);
  assert.equal(done.edges.length, concepts.links.length);
  assert.deepEqual(overlaps(done), []);
});

const advice = 'The "Concept" and "Mechanics" levels are read by people who do not program: move code, files and variable names into a sub-map, to the "Technical" level; fix the file and try again.';
test('build refuses code and long texts at Concept and Mechanics before the first step; a repeated build checks only what it adds', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), { dir, id } = await connected(h, 'Levels');
  const file = async (name, spec) => { const path = join(work, name); await writeFile(path, JSON.stringify(spec)); return path; };
  const revision = async () => (await h.api(`/api/p/${id}/graph`)).body.revision;
  // How an agent built by the old guide: technical titles and texts on the concept and mechanics levels. Technical is allowed.
  const title = 'Bot, dispatcher and message handlers on aiogram';
  const technical = {
    blocks: [{ title, text: '`handle_message()` in `bot/handlers.py` catches messages',
      blocks: [{ title: 'Keys', text: 'Reads BOT_TOKEN from .env', blocks: [{ title: 'Request', text: '`get_response()` in `ai_service.py`' }] }] },
    { title: 'Answer', text: 'The student gets an answer' }],
    links: [[title, 'Answer', 'OPENAI_API_KEY']]
  };
  const path = await file('technical.json', technical);
  let r = await h.run(['build', path], dir);
  assert.deepEqual([r.code, r.out], [1, '']);
  assert.equal(r.err.trim(), ['Write rejected, nothing was written:',
    `- block "${title}" (concept), title: longer than 40 characters (${title.length})`,
    `- block "${title}" (concept), text: code in backticks "\`handle_message()\`"; code in backticks "\`bot/handlers.py\`"`,
    '- block "Keys" (mechanics), text: file ".env"; name from code "BOT_TOKEN"',
    `- link "${title}" → "Answer" (concept), label: name from code "OPENAI_API_KEY"`, advice].join('\n'));
  assert.equal(await revision(), 0, 'nothing written');
  // At the person's request, without the check. A repeat with a new plain block checks only that block: what is written is skipped.
  r = await h.run(['build', path, '--no-check'], dir);
  assert.equal(r.code, 0, r.err);
  const written = await revision();
  r = await h.run(['build', await file('more.json', { ...technical, blocks: [...technical.blocks, { title: 'Photo', text: 'If you send a photo, the bot stays silent' }] })], dir);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith(`Written, revision ${written + 1}.\n- Added block "Photo"\n`), r.out);
  r = await h.run(['build', await file('worse.json', { blocks: [{ title: 'More', text: 'Calls getResponse' }] })], dir);
  assert.deepEqual([r.code, r.err.trim().split('\n')[1]], [1, '- block "More" (concept), text: name from code "getResponse"']);
  assert.equal(await revision(), written + 1);
});

test('apply checks what it adds or changes at Concept and Mechanics by the map the agent read; context gives edge ids', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), { dir, id } = await connected(h, 'Edits');
  const file = async (name, value) => { const path = join(work, name); await writeFile(path, JSON.stringify(value)); return path; };
  const revision = async () => (await h.api(`/api/p/${id}/graph`)).body.revision;
  let r = await h.run(['build', await file('map.json', { blocks: [
    { id: 'bot', title: 'Bot', text: 'Answers students in Telegram', blocks: [{ id: 'intake', title: 'Taking a question', text: 'The student writes a question',
      blocks: [{ id: 'handler', title: 'Handler', text: '`handle_message()` in `bot/handlers.py`' }] }] },
    { id: 'ai', title: 'AI answer', text: 'OpenAI prepares the answer' }], links: [['bot', 'ai', 'question']] })], dir);
  assert.equal(r.code, 0, r.err);
  r = await h.run(['context'], dir);
  const edge = /^- Bot \(bot\) → AI answer \(ai\): question · id: (\S+)$/m.exec(r.out)?.[1];
  assert.ok(edge, r.out);
  const ops = [
    { type: 'update-node', id: 'bot', patch: { title: 'Bot on `aiogram`', color: 'blue' } },
    { type: 'update-node', id: 'handler', patch: { text: '`handle_message()` and `send_answer()` in `bot/handlers.py`' } },
    { type: 'add-node', node: { type: 'note', parentId: 'bot', attachedTo: 'intake', text: 'Key OPENAI_API_KEY is in `config.py`' } },
    { type: 'add-node', node: { parentId: 'handler', title: 'Check the text', text: '`message.text` can be empty' } },
    { type: 'update-edge', id: edge, patch: { label: 'BOT_TOKEN' } }
  ];
  const built = await revision();
  r = await h.run(['apply', await file('ops.json', { message: 'Technical details', operations: ops })], dir);
  assert.deepEqual([r.code, r.out], [1, '']);
  assert.equal(r.err.trim(), ['Write rejected, nothing was written:',
    '- block "Bot" (concept), title: code in backticks "`aiogram`"',
    '- note "Key OPENAI_API_KEY is in `config.py`" (mechanics), text: code in backticks "`config.py`"; name from code "OPENAI_API_KEY"',
    '- link "Bot" → "AI answer" (concept), label: name from code "BOT_TOKEN"', advice].join('\n'));
  assert.equal(await revision(), built);
  // Technical and code levels with code, mechanics in plain words: these are written; the link changes by its id from context.
  r = await h.run(['apply', await file('plain.json', [ops[1], ops[3], { type: 'add-node', node: { type: 'note', parentId: 'bot', attachedTo: 'intake', text: 'If you send a photo, the bot stays silent' } },
    { type: 'update-edge', id: edge, patch: { label: 'student question' } }]), '-m', 'Plain words'], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal((await h.api(`/api/p/${id}/graph`)).body.edges.find(e => e.id === edge).label, 'student question');
  r = await h.run(['apply', join(work, 'ops.json'), '--no-check'], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(await revision(), built + 2);
  // The map was changed after the agent's read: instead of the check and the write, the changes.
  assert.equal((await h.api(`/api/p/${id}/changes`, { expectedRevision: built + 2, actor: 'human', message: 'Human edit', operations: [{ type: 'update-node', id: 'ai', patch: { text: 'OpenAI prepares the reply' } }] })).status, 200);
  r = await h.run(['apply', join(work, 'ops.json')], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /^The map changed after your last read\./);
  assert.equal(await revision(), built + 3);
});

test('doing shows what the agent is doing, show moves the human to a block, selection tells what the human means', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), { dir, id } = await connected(h, 'No chat'), p = path => `/api/p/${id}${path}`;
  await writeFile(join(work, 'b.json'), JSON.stringify({ blocks: [{ id: 'cart', title: 'Cart', text: 'The shopper collects products', blocks: [{ id: 'total', title: 'Total', text: 'The cart adds up the total' }] }] }));
  assert.equal((await h.run(['build', join(work, 'b.json'), '--at-once'], dir)).code, 0);
  let r = await h.run(['doing', 'reading `cart.ts`', '--progress', '40'], dir);
  assert.equal(r.out.trim(), 'Under the map: "reading `cart.ts`", 40 %.');
  assert.deepEqual((await h.api(`/api/p/${id}/chat`)).body.agents.map(a => a.actor), ['tester']);
  assert.equal((await h.run(['doing', '--done'], dir)).out.trim(), 'The line under the map is cleared.');
  assert.equal((await h.run(['doing'], dir)).code, 1);
  assert.equal((await h.run(['show', 'total'], dir)).out.trim(), 'Shown to the person: "Total" (total).');
  assert.equal((await h.run(['show', 'missing'], dir)).code, 1);
  // The person selected a block and works inside a concept: selection prints both with text, context a line about the selection.
  assert.equal((await h.run(['selection'], dir)).out.trim(), 'The person has not selected anything and is not working in any block.');
  await h.api(p('/selection'), { id: 'total' }); await h.api(p('/focus'), { id: 'cart' });
  assert.equal((await h.run(['selection'], dir)).out.trim(), 'Selected: "Total" (total) — block inside "Cart" (cart)\nThe cart adds up the total\n\nWorking in block: "Cart" (cart) — block on the main map\nThe shopper collects products');
  assert.match((await h.run(['context', '--brief'], dir)).out, /The person selected the block "Total" \(total\) on the map/);
  // There is no chat, and no old conversation commands either.
  for (const gone of ['say', 'log', 'chat', 'status', 'progress']) assert.equal((await h.run([gone, 'x'], dir)).code, 1, gone);
});

test('what context and wait printed counts as read even when the reader cuts the output short', async t => {
  const h = await hubFixture(t), dir = await h.folder();
  const id = idOf((await h.run(['init', '--name', 'Cut'], dir)).out), cursor = async () => (await h.api(`/api/p/${id}/cursor?actor=tester`)).body;
  let r = await h.cut(['context'], dir);
  assert.match(r.out, /^# Map/);
  assert.deepEqual(await cursor(), { revision: 0, chat: 0 });
  // The person added a block and pressed "Finish edits".
  await h.api(`/api/p/${id}/changes`, { expectedRevision: 0, actor: 'human', message: 'Edit', operations: [{ type: 'add-node', node: { id: 'x', title: 'New', x: 0, y: 0 } }] });
  await h.api(`/api/p/${id}/edits`, {});
  r = await h.cut(['wait', '--timeout', '10'], dir);
  assert.match(r.out, /^The person in Mycel:/);
  assert.deepEqual(await cursor(), { revision: 1, chat: 1 });
  r = await h.run(['changes'], dir);
  assert.equal(r.out.trim(), 'No other changes, revision 1.');
});

test('context prints what the human did in Mycel while the agent was not waiting; human edits are held until "Finish edits"', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Edits'), p = path => `/api/p/${id}${path}`;
  // The person is editing the map: changes says so, and wait does not wake on their edits.
  const human = { expectedRevision: 0, actor: 'human', message: 'Human edit', operations: [{ type: 'add-node', node: { id: 'x', title: 'New', x: 0, y: 0 } }] };
  assert.equal((await h.api(p('/changes'), human)).status, 200);
  assert.match((await h.run(['changes'], dir)).out, /The person is editing the map right now \(since revision 0, records: 1\)/);
  assert.equal((await h.run(['wait', '--timeout', '2'], dir)).code, 2);
  // "Finish edits" wakes it, and the edits come in full, even though changes already showed them.
  assert.equal((await h.api(p('/edits'), {})).status, 200);
  let r = await h.run(['wait', '--timeout', '5'], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^The person in Mycel:\n- m1 · Person · [^\n]*: map edits finished: their records after revision 0 \(up to 1\), 1 in total/);
  assert.match(r.out, /Added:\n### New \(id: x\)/);
  assert.doesNotMatch(r.out, /editing the map right now/);
  // What the person did while the agent was not waiting is printed by context too, once.
  const again = { expectedRevision: 1, actor: 'human', message: 'Human edit', operations: [{ type: 'update-node', id: 'x', patch: { text: 'text' } }] };
  assert.equal((await h.api(p('/changes'), again)).status, 200);
  assert.equal((await h.api(p('/edits'), {})).status, 200);
  r = await h.run(['context'], dir);
  assert.match(r.out, /## The person in Mycel:\n- m2 · Person · [^\n]*: map edits finished/);
  assert.doesNotMatch((await h.run(['context'], dir)).out, /The person in Mycel/);
});
test('propose lays the guide example on the map for the human to decide, mark sets test results; the decision wakes wait', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), { dir, id } = await connected(h, 'Shop');
  const file = async (name, value) => { const p = join(work, name); await writeFile(p, JSON.stringify(value)); return p; };
  assert.equal((await h.run(['build', await file('b.json', { blocks: [{ id: 'cart', title: 'Cart', text: 'The shopper collects products',
    blocks: [{ id: 'add-product', title: 'Add a product', text: 'The product goes into the cart' }, { id: 'total', title: 'Total', text: 'The cart adds up the total' }] }] }), '--at-once'], dir)).code, 0);
  // The example from the agent guide.
  let r = await h.run(['propose', await file('p.json', { title: 'Promo codes in the cart', parent: 'cart',
    blocks: [{ id: 'promo', title: 'Promo code', text: 'The shopper enters a code and gets a discount' }], links: [['promo', 'total', 'discount']],
    operations: [{ type: 'update-node', id: 'total', patch: { text: 'The total includes the discount' } }, { type: 'delete-node', id: 'add-product' }] })], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /- Added block "Promo code"\n- Added link "Promo code" → "Total"\n- Changed block "Total"\n- Proposed to delete block "Add a product"/);
  assert.match(r.out, /Proposal "Promo codes in the cart" is on the map/);
  // The level check works for a proposal too; the first proposal cannot be opened without a title.
  assert.equal((await h.run(['propose', await file('bad.json', { blocks: [{ title: 'handle_message()', text: 'x' }] })], dir)).code, 1);
  assert.match((await h.run(['context', '--brief'], dir)).out, /ID: promo \| level: mechanics \| inside: cart \| planned, no code yet \| proposed: add/);
  assert.match((await h.run(['mark', 'total', 'testing'], dir)).out, /Marked block "Total": checking now/);
  r = await h.run(['mark', 'total,cart', 'passed'], dir);
  assert.match(r.out, /Marked block "Total": passed\n- Marked block "Cart": passed/);
  assert.equal((await h.run(['mark', 'total', 'green'], dir)).code, 1);
  // The person accepts; the agent's wait wakes up with the decision and a hint about what to do next.
  assert.equal((await h.api(`/api/p/${id}/proposal/accept`, {})).status, 200);
  r = await h.run(['wait', '--timeout', '5'], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /accepted the proposal "Promo codes in the cart"\. Accepted blocks are a plan \(dashed\)/);
  assert.match(r.out, /Deleted: block "Add a product" \(add-product\)/);
  const graph = (await h.api(`/api/p/${id}/graph`)).body;
  assert.deepEqual(graph.nodes.map(n => [n.id, n.status ?? null, n.proposed ?? null]), [['cart', 'passed', null], ['total', 'passed', null], ['promo', 'plan', null]]);
});

test('guide renders the command of this computer without a running Mycel', async t => {
  const data = await temp('mycel-cli-data-'), url = `http://127.0.0.1:${await freePort()}`, slash = p => p.replace(/\\/g, '/');
  t.after(() => clean(data));
  const r = await mycel(['guide'], { data, url });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(`- PowerShell: \`& "${slash(process.execPath)}" "${slash(script)}" --url ${url} <command>\``), r.out);
  assert.ok(r.out.includes(`curl.exe -s ${url}/agent`));
  assert.ok(!r.out.includes('{{'));
});

test('reach tells an old version, a foreign answer, other data and a newer code apart, and does not start with --no-start', async t => {
  const data = await temp('mycel-cli-data-'), other = join(data, 'other');
  t.after(() => clean(data));
  const fake = async answer => {
    const server = http.createServer((req, res) => answer(res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const json = value => res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const cases = [
    [json({ ok: true, revision: 3 }), url => `An old version of Mycel is running at ${url}: stop it.`],
    [res => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html></html>'); }, url => `Something other than Mycel answers at ${url}.`],
    [json({ ok: true, app: 'mycel', version, data: other }), url => `Mycel with other data is running at ${url}: ${other}`],
    [json({ ok: true, app: 'mycel', version: '0.0.1', data }), () => `Mycel was updated: restart it ("${process.execPath}" "${script}" stop, then ${launcher}).`],
    // Before 0.15 the program was called Kontur: its hub is an older version, not a foreign program.
    [json({ ok: true, app: 'kontur', version: '0.14.0', data }), () => `Mycel was updated: restart it ("${process.execPath}" "${script}" stop, then ${launcher}).`]
  ];
  for (const [answer, text] of cases) {
    const url = await fake(answer), r = await mycel(['projects'], { data, url });
    assert.deepEqual([r.code, r.err.trim()], [1, text(url)]);
  }
  const url = `http://127.0.0.1:${await freePort()}`;
  let r = await mycel(['projects'], { data, url });
  assert.deepEqual([r.code, r.err.trim()], [1, `Mycel is not running. Ask the person to open ${launcher}.`]);
  r = await mycel(['stop'], { data, url });
  assert.deepEqual([r.code, r.out.trim()], [0, 'Mycel is not running.']);
  r = await mycel(['projects'], { data, url: 'http://example.com:4317' });
  assert.deepEqual([r.code, r.err.trim()], [1, 'Mycel runs on this computer or in the local network (the main computer for a virtual one): the key is not sent to other addresses.']);
});

// The only test where Mycel starts by itself, as a separate background process: afterwards it is stopped with the
// command, and if that fails, by the pid from server.lock.
test('a command starts Mycel in the background when it is not running; open replaces an older version; stop ends it', async t => {
  const data = await temp('mycel-cli-auto-'), url = `http://127.0.0.1:${await freePort()}`, old = await temp('mycel-cli-old-'), empty = await temp('mycel-cli-path-');
  let previous = null;
  t.after(async () => {
    previous?.kill();
    await mycel(['stop'], { data, url });
    const pid = await readFile(join(data, 'server.lock'), 'utf8').then(text => JSON.parse(text).pid, () => null);
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) try { process.kill(pid); } catch { /* already exited */ }
    await clean(data, old, empty);
  });
  let r = await mycel(['start'], { data, url, start: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err.trim(), `Started Mycel: ${url}`);
  assert.equal(r.out.trim(), `Mycel: ${url}`);
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.deepEqual([health.app, health.version, health.data], ['mycel', version, data]);
  const lock = JSON.parse(await readFile(join(data, 'server.lock'), 'utf8'));
  assert.ok(lock.pid !== process.pid && lock.port === Number(new URL(url).port));
  assert.match(await readFile(join(data, 'server.log'), 'utf8'), /Mycel → /);
  r = await mycel(['start'], { data, url, start: true });
  assert.deepEqual([r.code, r.err], [0, ''], 'not started a second time');
  r = await mycel(['stop'], { data, url });
  assert.equal(r.out.trim(), `Mycel stopped: ${url}.`, r.err);
  assert.equal(await fetch(`${url}/api/health`).then(() => true, () => false), false);
  await assert.rejects(readFile(join(data, 'server.lock')), { code: 'ENOENT' });
  // The code was updated, but a Mycel of an older version with the same data is running: open (a double click on Mycel.cmd)
  // replaces it with the current one. The browser does not open in the test: PATH has no cmd.exe, open or xdg-open.
  await cp(join(appRoot, 'src'), join(old, 'src'), { recursive: true }); await cp(join(appRoot, 'server.mjs'), join(old, 'server.mjs'));
  await writeFile(join(old, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.1' }));
  previous = spawn(process.execPath, [join(old, 'server.mjs'), '--port', new URL(url).port, '--data', data], { stdio: 'ignore', windowsHide: true });
  const exited = once(previous, 'exit');
  await until(async () => (await fetch(`${url}/api/health`).then(res => res.json(), () => null))?.version === '0.0.1');
  r = await mycel(['open'], { data, url, start: true, env: { PATH: empty } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.err.trim(), r.out.trim()], [`Stopped Mycel 0.0.1.\nStarted Mycel: ${url}`, `Mycel: ${url}/`]);
  await exited;
  assert.equal((await (await fetch(`${url}/api/health`)).json()).version, version);
  r = await mycel(['stop'], { data, url });
  assert.equal(r.out.trim(), `Mycel stopped: ${url}.`, r.err);
});

test('mycel.mjs parses as ES2020, so on an old Node the version check runs instead of a syntax error', t => {
  // Parsed with the same acorn that is inside Node; on a Node without it the check is skipped.
  const parse = spawnSync(process.execPath, ['--expose-internals', '-e', `
    let acorn; try { acorn = require('internal/deps/acorn/acorn/dist/acorn'); } catch { process.exit(3); }
    acorn.parse(require('fs').readFileSync(process.argv[1], 'utf8'), { ecmaVersion: 2020, sourceType: 'module', allowAwaitOutsideFunction: true });`, script], { encoding: 'utf8' });
  if (parse.status === 3) return t.skip('this Node version has no built-in acorn');
  assert.equal(parse.status, 0, parse.stderr);
});

// A map that does not go stale: blocks have files and a check command. The Claude Code hook after a file edit marks its
// block "being edited" and "possibly outdated"; at the end of a reply it reminds to describe the block, at the start of a session it gives an overview of the map.
test('a hook after a file edit marks its block as edited and stale; describing the block again or fresh clears it', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Code');
  const spec = { message: 'Code map', blocks: [{ id: 'core', title: 'Core', text: 'Server and data.', blocks: [
    { id: 'srv', title: 'Server', text: 'Answers requests.', files: ['server.mjs', 'lib/'], test: 'node -e "process.exit(0)"' },
    { id: 'ui', title: 'Interface', text: 'Draws the map.', files: ['public\\app.js'], test: 'node -e "process.exit(3)"' }] }] };
  await writeFile(join(dir, 'map.json'), JSON.stringify(spec));
  let r = await h.run(['build', 'map.json', '--at-once'], dir);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual((await h.api(`/api/p/${id}/graph`)).body.nodes.filter(n => n.files).map(n => [n.id, n.files, n.test]),
    [['srv', ['server.mjs', 'lib/'], 'node -e "process.exit(0)"'], ['ui', ['public/app.js'], 'node -e "process.exit(3)"']]);
  const event = (name, extra = {}) => ({ hook_event_name: name, cwd: dir, session_id: 's1', ...extra });
  r = await h.hook(event('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(dir, 'lib', 'a.js') } }));
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  let code = (await h.api(`/api/p/${id}/code`)).body;
  assert.deepEqual(code.stale.map(s => [s.id, s.files, s.by, s.session]), [['srv', ['lib/a.js'], 'tester', 's1']]);
  assert.deepEqual(code.work.map(w => [w.actor, w.blocks, w.files]), [['tester', ['srv'], ['lib/a.js']]]);
  // A file outside the project and a file without a block mark nothing.
  await h.hook(event('PostToolUse', { tool_input: { file_path: join(tmpdir(), 'x.js') } }));
  await h.hook(event('PostToolUse', { tool_input: { file_path: join(dir, 'README.md') } }));
  assert.equal((await h.api(`/api/p/${id}/code`)).body.stale.length, 1);
  r = await h.run(['context', '--brief'], dir);
  assert.match(r.out, /Possibly outdated \(their files changed after the block was described\): "Server" \(srv\): lib\/a\.js/);
  assert.match(r.out, /ID: srv \| level: mechanics \| inside: core \| possibly outdated/);
  assert.match(r.out, /Files: server\.mjs, lib\/\n\nTest command: `node -e "process\.exit\(0\)"`/);
  assert.match(r.out, /Working now: tester on "Server" \(srv\)/);
  // End of a reply: a reminder only to the session that changed the files, and not twice in a row.
  r = await h.hook(event('Stop'));
  const stop = JSON.parse(r.out);
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /"Server" \(srv\).*mycel fresh srv/);
  assert.equal((await h.hook(event('Stop', { stop_hook_active: true }))).out, '');
  assert.equal((await h.hook(event('Stop', { session_id: 's2' }))).out, '');
  // Start of a session: an overview of the map instead of reading all the code.
  r = await h.hook(event('SessionStart', { source: 'startup' }));
  const start = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(start.hookEventName, 'SessionStart');
  assert.match(start.additionalContext, /project "Code" has a map of how it works, 3 blocks/);
  assert.match(start.additionalContext, /- "Core" \(core\) — Server and data\.\n  - "Server" \(srv\) — Answers requests\./);
  assert.match(start.additionalContext, /Possibly outdated \(files changed after the description\): "Server" \(srv\)/);
  // Another agent takes up the same block: it is warned.
  r = await h.run(['touch', 'server.mjs'], dir, { MYCEL_ACTOR: 'codex' });
  assert.match(r.out, /Block "Server" \(srv\) is being worked on by tester\./);
  r = await h.run(['doing', 'editing the interface', '--on', 'ui,srv'], dir, { MYCEL_ACTOR: 'codex' });
  assert.match(r.out, /Block "Server" \(srv\) is being worked on by tester/);
  // The agent described the block again, so the flag is cleared; fresh confirms the description without an edit.
  r = await h.run(['context'], dir);
  await writeFile(join(dir, 'ops.json'), JSON.stringify([{ type: 'update-node', id: 'srv', patch: { text: 'Answers requests and writes a log.' } }]));
  r = await h.run(['apply', 'ops.json'], dir);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual((await h.api(`/api/p/${id}/code`)).body.stale, []);
  await h.run(['touch', 'public/app.js'], dir);
  r = await h.run(['fresh', 'ui'], dir);
  assert.equal(r.out.trim(), 'Description confirmed, the "outdated" flag is cleared: ui.');
  assert.deepEqual((await h.api(`/api/p/${id}/code`)).body.stale, []);
  // The hook stays silent if the folder is not connected or Mycel is not running.
  const other = await h.folder();
  assert.deepEqual(await h.hook({ hook_event_name: 'SessionStart', cwd: other }).then(x => [x.code, x.out]), [0, '']);
  assert.deepEqual(await mycel(['hook'], { cwd: dir, data: h.url, url: `http://127.0.0.1:${await freePort()}`, input: JSON.stringify(event('SessionStart')) }).then(x => [x.code, x.out, x.err]), [0, '', '']);
});

test('check runs the test commands of blocks and marks them live; the human asks for a check with a button', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Checks');
  await writeFile(join(dir, 'map.json'), JSON.stringify({ blocks: [{ id: 'core', title: 'Core', blocks: [
    { id: 'srv', title: 'Server', test: 'node -e "process.exit(0)"' }, { id: 'api', title: 'API', test: 'node -e "process.exit(0)"' },
    { id: 'ui', title: 'Interface', test: 'node -e "console.log(\'failed here\'); process.exit(3)"' }, { id: 'docs', title: 'Docs' }] }] }));
  assert.equal((await h.run(['build', 'map.json', '--at-once'], dir)).code, 0);
  let r = await h.run(['check'], dir);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /Passed: "Server" \(srv\), "API" \(api\) — `node -e "process\.exit\(0\)"`/);
  assert.match(r.out, /Failed: "Interface" \(ui\) — `.*` \(code 3\)\nfailed here/);
  const status = async () => Object.fromEntries((await h.api(`/api/p/${id}/graph`)).body.nodes.filter(n => n.status).map(n => [n.id, n.status]));
  assert.deepEqual(await status(), { srv: 'passed', api: 'passed', ui: 'failed' });
  // The run is visible as it goes: first "checking now", then the result of each command.
  const history = (await h.api(`/api/p/${id}/history`)).body.history.map(e => e.message).reverse().slice(-3);
  assert.deepEqual(history, ['Check running', 'Check: passed', 'Check: failed']);
  r = await h.run(['check', 'srv'], dir);
  assert.deepEqual([r.code, r.out.trim()], [0, 'Passed: "Server" (srv) — `node -e "process.exit(0)"`']);
  r = await h.run(['check', 'docs'], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /These blocks and the blocks nested in them have no check command/);
  // After check the agent's write goes without a conflict: the read mark moved to its own marks.
  await writeFile(join(dir, 'ops.json'), JSON.stringify([{ type: 'update-node', id: 'docs', patch: { text: 'README' } }]));
  assert.equal((await h.run(['apply', 'ops.json'], dir)).code, 0);
  // The person pressed "Check": the agent learns about it in wait and changes.
  assert.equal((await h.api(`/api/p/${id}/check`, { ids: ['ui'] })).status, 200);
  r = await h.run(['changes'], dir);
  assert.match(r.out, /Person · .*: asks to check "Interface" \(ui\)\. Run mycel check ui/);
  assert.equal((await h.api(`/api/p/${id}/check`, { ids: ['nope'] })).status, 400);
});

test('review tells what changed by concept; health finds red, stale, untested blocks and risks without printing them', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Health');
  await mkdir(join(dir, 'lib'));
  await writeFile(join(dir, 'lib', 'a.js'), "// TODO: tidy up\nconst key = 'sk-abcdefghijklmnopqrstuvwxyz123456';\n");
  await writeFile(join(dir, 'lib', '.env'), "TOKEN='sk-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'\n");
  await writeFile(join(dir, 'map.json'), JSON.stringify({ blocks: [{ id: 'core', title: 'Core', blocks: [
    { id: 'srv', title: 'Server', files: ['lib/'] }, { id: 'ui', title: 'Interface', status: 'failed' }, { id: 'pay', title: 'Payment', status: 'plan' }] }] }));
  assert.equal((await h.run(['build', 'map.json', '--at-once'], dir)).code, 0);
  let r = await h.run(['review', '--hours', '1'], dir);
  assert.match(r.out, /^What changed from revision 0 to \d+ \(since .*\): \d+ entr(y|ies), agents: tester\.\n\n"Core"\n- new concept\n- added block "Server"\n- added block "Interface"\n- added block "Payment" \(planned, no code yet\)/);
  assert.match(r.out, /\n\nFailed: "Interface"\.\n$/);
  r = await h.run(['context'], dir);
  r = await h.run(['mark', 'ui', 'passed'], dir);
  const since = (await h.api(`/api/p/${id}`)).body.project.revision - 1;
  r = await h.run(['review', '--since', String(since)], dir);
  assert.match(r.out, /"Core"\n- changed block "Interface": passed\n\nPassed: "Interface"\./);
  await h.run(['touch', 'lib/a.js'], dir);
  r = await h.run(['health'], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Possibly outdated \(files changed after the description\):\n- "Server" \(srv\) — lib\/a\.js/);
  assert.match(r.out, /Unchecked \(has files, but no test command and no "passed" mark\):\n- "Server" \(srv\)/);
  assert.match(r.out, /Plan \(no code yet\):\n- "Payment" \(pay\)/);
  assert.match(r.out, /Risks in files:\n- "Server" \(srv\): TODO 1, looks like a secret 1 — lib\/a\.js:1 \(TODO 1\); lib\/a\.js:2 \(looks like a key or password\)/);
  assert.doesNotMatch(r.out, /sk-|tidy up/);
  assert.deepEqual(Object.fromEntries(Object.entries((await h.api(`/api/p/${id}/code`)).body.risks).map(([k, v]) => [k, [v.todo, v.secrets]])), { srv: [1, 1] });
});

test('plugin writes a local Claude Code marketplace with the MCP server, hooks and a skill for this computer', async t => {
  const h = await hubFixture(t), out = await h.folder('mycel-cli-plugin-');
  const r = await h.run(['plugin', '--out', out], tmpdir());
  assert.equal(r.code, 0, r.err);
  const read = async (...parts) => JSON.parse(await readFile(join(out, ...parts), 'utf8'));
  assert.deepEqual((await read('.claude-plugin', 'marketplace.json')).plugins.map(p => [p.name, p.source]), [['mycel', './mycel']]);
  assert.deepEqual(await read('mycel', '.claude-plugin', 'plugin.json').then(p => [p.name, p.version]), ['mycel', version]);
  const slash = p => p.replace(/\\/g, '/');
  assert.deepEqual((await read('mycel', '.mcp.json')).mcpServers.mycel, { command: slash(process.execPath), args: [slash(join(appRoot, 'mcp.mjs'))], env: { MYCEL_URL: h.url } });
  const { hooks } = await read('mycel', 'hooks', 'hooks.json');
  assert.deepEqual(Object.keys(hooks), ['PostToolUse', 'Stop', 'SessionStart']);
  assert.deepEqual(hooks.PostToolUse[0], { matcher: 'Write|Edit|MultiEdit|NotebookEdit|TodoWrite|TaskCreate|TaskUpdate|.*update_plan', hooks: [{ type: 'command', command: slash(process.execPath), args: [slash(script), 'hook', '--url', h.url], timeout: 30 }] });
  assert.match(await readFile(join(out, 'mycel', 'skills', 'mycel', 'SKILL.md'), 'utf8'), /^---\nname: mycel\ndescription: /);
  assert.match(r.out, /claude plugin install mycel@mycel-local --scope user/);
});

// A Mycel copy in a virtual machine: join with a key saves the address, key and project, and then commands work from any
// folder without --url. 127.0.0.2 is a second address instead of the VMware network; the real port 4317 is not touched.
test('a copy of Mycel in a virtual machine joins the host Mycel with the key and works with its project', async t => {
  const data = await temp('mycel-cli-host-'), vm = await temp('mycel-cli-vm-'), folder = await temp('mycel-cli-folder-'), work = await temp('mycel-cli-work-');
  const app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data, vm, folder, work); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, key = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('no second loopback address');
  const id = idOf((await mycel(['init', '--name', 'Host'], { cwd: folder, data: app.data, url: app.url })).out);
  // The copy in the virtual machine: its own data folder, the address only from join.
  const inVm = (args, cwd = work) => mycel(args, { cwd, data: vm, url: null });
  let r = await inVm(['join', far, 'x'.repeat(20)]);
  assert.deepEqual([r.code, r.err.trim()], [1, 'The key does not fit: ask for access again with node mycel.mjs join <address> without a key.']);
  r = await inVm(['join', 'http://8.8.8.8:4317', key]);
  assert.deepEqual([r.code, r.err.trim()], [1, 'You can connect only to Mycel in the local network: the key is not sent to other addresses.']);
  r = await inVm(['join', far, key, '--project', 'nope']);
  assert.match(r.err, /There is no project nope there\. Projects: .*\(Host\)/);
  // The address works without http:// too, as people write it.
  r = await inVm(['join', far.replace('http://', ''), key, '--project', id]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^Connected to Mycel at ${far.replace(/\./g, '\\.')}, project ${id}\\.`));
  assert.deepEqual(JSON.parse(await readFile(join(vm, 'remote.json'), 'utf8')), { url: far, token: key, project: id });
  r = await inVm(['context', '--brief']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# Map\nRevision: \d+/);
  r = await inVm(['guide']);
  assert.match(r.out, /This Mycel copy is connected to Mycel on another machine/);
  for (const [args, text] of [[['init'], /A project for a folder of this machine is created by the machine with its own key/], [['stop'], /This is done on the main computer/], [['remote', 'on'], /This is done on the main computer/]]) {
    r = await inVm(args);
    assert.equal(r.code, 1); assert.match(r.err, text);
  }
  // The plugin in the virtual machine takes the address and key from join: its files do not contain them.
  const out = join(vm, 'plugin');
  assert.equal((await inVm(['plugin', '--out', out])).code, 0);
  const hooks = JSON.parse(await readFile(join(out, 'mycel', 'hooks', 'hooks.json'), 'utf8')).hooks.Stop[0].hooks[0];
  assert.deepEqual(hooks.args.slice(1), ['hook']);
  assert.equal(JSON.parse(await readFile(join(out, 'mycel', '.mcp.json'), 'utf8')).mcpServers.mycel.env, undefined);
  r = await inVm(['join', '--off']);
  assert.equal(r.out.trim(), 'This Mycel copy is no longer connected to another machine.');
  await assert.rejects(readFile(join(vm, 'remote.json')), { code: 'ENOENT' });
});

// The agent in a virtual machine connects by itself: join without a key asks for access, prints a code and waits; the person
// presses "Allow", and the machine gets its own key and project. remote on the main computer does not print the key.
test('join without a key asks for access, waits for the human to approve and gets its own key and project', async t => {
  const data = await temp('mycel-cli-host-'), vm = await temp('mycel-cli-vm-'), folder = await temp('mycel-cli-folder-'), work = await temp('mycel-cli-work-');
  const app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data, vm, folder, work); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('no second loopback address');
  const id = idOf((await mycel(['init', '--name', 'Host'], { cwd: folder, data: app.data, url: app.url })).out);
  const host = async (path, body) => (await fetch(app.url + path, body ? { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  const joining = mycel(['join', far.replace('http://', '')], { cwd: work, data: vm, url: null });
  let pending = [];
  await until(async () => (pending = (await host('/api/access')).pending).length === 1, 10000);
  await host(`/api/pair/${pending[0].id}/approve`, { project: id });
  const r = await joining;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`Code ${pending[0].code}: the person compares it and presses "Allow"[\\s\\S]*Connected to Mycel at ${far.replace(/\./g, '\\.')}, project ${id}\\.`));
  const saved = JSON.parse(await readFile(join(vm, 'remote.json'), 'utf8'));
  assert.deepEqual([saved.url, saved.project, saved.token === token, /^[0-9a-f]{64}$/.test(saved.token)], [far, id, false, true]);
  assert.match((await mycel(['context', '--brief'], { cwd: work, data: vm, url: null })).out, /^# Map/);
  // The agent connects a folder of this machine itself: a project marked with the machine; commands from that folder find it, from others the join project.
  const hedwig = await temp('mycel-cli-hedwig-');
  t.after(() => clean(hedwig));
  let made = await mycel(['init', '--name', 'Hedwig'], { cwd: hedwig, data: vm, url: null });
  assert.equal(made.code, 0, made.err);
  const hid = idOf(made.out);
  assert.match(made.out, /^Project "Hedwig" connected: /);
  await writeFile(join(hedwig, 'map.json'), JSON.stringify({ blocks: [{ id: 'core', title: 'Core' }] }));
  assert.equal((await mycel(['context'], { cwd: hedwig, data: vm, url: null })).code, 0);
  assert.equal((await mycel(['build', 'map.json', '--at-once'], { cwd: hedwig, data: vm, url: null })).code, 0);
  assert.deepEqual((await host(`/api/p/${hid}/graph`)).nodes.map(n => n.id), ['core']);
  assert.deepEqual((await host(`/api/p/${id}/graph`)).nodes.map(n => n.id), [], 'the join project is untouched');
  const listed = await mycel(['projects'], { cwd: folder, data: app.data, url: app.url });
  assert.match(listed.out, new RegExp(`${hid} · Hedwig · .+ \\(on machine ".+"\\)`));
  const elsewhere = await mycel(['check', '--project', hid], { cwd: folder, data: app.data, url: app.url });
  assert.match(elsewhere.err, /The files of project "Hedwig" are on machine ".+": run this there\./);
  // remote on the main computer: the machine with access and the install command, without the main computer's key.
  const shown = await mycel(['remote'], { cwd: folder, data: app.data, url: app.url });
  assert.match(shown.out, /Machines with access \(remote revoke <id> to revoke\):\n- [0-9a-f-]+ · /);
  assert.match(shown.out, new RegExp(`curl -fsS ${far.replace(/\./g, '\\.')}/install\\.sh \\| sh`));
  assert.ok(!shown.out.includes(token));
  assert.ok((await mycel(['remote', '--key'], { cwd: folder, data: app.data, url: app.url })).out.includes(token));
  // A denied request: join reports it and exits.
  const denied = mycel(['join', far], { cwd: work, data: join(vm, 'second'), url: null });
  await until(async () => (pending = (await host('/api/access')).pending).length === 1, 10000);
  await host(`/api/pair/${pending[0].id}/deny`, {});
  const d = await denied;
  assert.deepEqual([d.code, d.err.trim()], [1, 'The person denied the access request.']);
});

// The plugin is required: plugin --install connects it through claude (repeating is safe) and removes a separate MCP server.
// claude here is a fake script; the real Claude Code is not touched.
test('plugin --install connects the plugin with claude and removes a separate mycel MCP server; without claude it prints the commands', async t => {
  const h = await hubFixture(t), out = await h.folder('mycel-cli-plugin-'), fake = join(out, 'fake-claude.mjs'), calls = join(out, 'calls.txt');
  await writeFile(fake, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n'); process.exit(process.argv[2] === 'mcp' ? 1 : 0);`);
  let r = await h.run(['plugin', '--install', '--out', join(out, 'p'), '--claude', fake], tmpdir());
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'The Mycel plugin is connected. The mycel_* tools and hooks appear in a new Claude Code session: ask the person to start one.');
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), [`plugin marketplace add ${join(out, 'p')} --scope user`, 'plugin install mycel@mycel-local --scope user', 'mcp remove mycel -s user']);
  r = await h.run(['plugin', '--install', '--out', join(out, 'q')], tmpdir(), { PATH: out });
  assert.equal(r.code, 1);
  assert.match(r.err, /Could not find claude: run the connection commands below yourself\./);
  assert.match(r.out, /claude plugin install mycel@mycel-local --scope user/);
});

// Other agents: the same MCP server, an entry for their settings file; the address is a variable if Mycel is not on 4317.
test('plugin --agent prints the MCP server entry for another agent; plugin lists them all', async t => {
  const h = await hubFixture(t), slash = p => p.replace(/\\/g, '/'), node = slash(process.execPath), server = slash(join(appRoot, 'mcp.mjs'));
  // Output: a line about the file, an empty line, the entry, an empty line, then the command and hooks if there are any.
  const part = (r, i = 1) => r.out.split('\n\n')[i];
  let r = await h.run(['plugin', '--agent', 'cursor'], tmpdir());
  assert.equal(r.code, 0, r.err);
  const json = JSON.parse(part(r));
  assert.deepEqual(Object.keys(JSON.parse(part(r, 3)).hooks), ['afterFileEdit', 'stop', 'sessionStart']);
  assert.match(part(r, 3), /hook --from cursor --url http:\/\/127\.0\.0\.1:\d+/);
  assert.deepEqual(json, { mcpServers: { mycel: { type: 'stdio', command: node, args: [server], env: { MYCEL_URL: h.url } } } });
  r = await h.run(['plugin', '--agent', 'vscode'], tmpdir());
  assert.equal(JSON.parse(part(r)).servers.mycel.type, 'stdio');
  r = await h.run(['plugin', '--agent', 'continue'], tmpdir());
  assert.match(part(r), /^mcpServers:\n  - name: mycel\n    type: stdio\n    command: "/);
  r = await h.run(['plugin', '--agent', 'codex'], tmpdir());
  assert.match(r.out, new RegExp(`\\[mcp_servers\\.mycel\\]\\ncommand = "${node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(r.out, /\[mcp_servers\.mycel\.env\]\nMYCEL_URL = "http:\/\/127\.0\.0\.1:\d+"/);
  assert.match(r.out, /Or with a command: codex mcp add mycel --env MYCEL_URL=/);
  r = await h.run(['plugin', '--agent', 'nope'], tmpdir());
  assert.deepEqual([r.code, r.err.trim()], [1, 'Agents: codex, cursor, antigravity, gemini, vscode, windsurf, cline, lmstudio, continue, goose, opencode, jan, openwebui, claude-desktop. Claude Code: node mycel.mjs plugin --install.']);
  const out = await h.folder('mycel-cli-plugin-');
  r = await h.run(['plugin', '--out', out], tmpdir());
  assert.match(r.out, /  cursor         Cursor — ~\/\.cursor\/mcp\.json/);
});

// Universal: tool descriptions for any model with function calling and a call by name, the same as MCP.
test('tools exports the Mycel tools for function calling; call runs one by name with JSON arguments', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Tools');
  let r = await h.run(['tools'], dir);
  const list = JSON.parse(r.out);
  assert.ok(list.every(x => x.type === 'function' && x.function.parameters.type === 'object'));
  assert.ok(['mycel_context', 'mycel_build', 'mycel_touch', 'mycel_check'].every(name => list.some(x => x.function.name === name)));
  assert.ok(JSON.parse((await h.run(['tools', '--format', 'mcp'], dir)).out).some(x => x.name === 'mycel_check' && x.inputSchema.type === 'object'));
  assert.match((await h.run(['call', 'overview'], dir)).out, /project "Tools" has a map of how it works/);
  r = await h.run(['call', 'mycel_build', JSON.stringify({ structure: { blocks: [{ id: 'core', title: 'Core' }] }, at_once: true })], dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual((await h.api(`/api/p/${id}/graph`)).body.nodes.map(n => n.id), ['core']);
  assert.match((await h.run(['guide', '--short'], dir)).out, /^# Mycel: short agent guide/);
  r = await h.run(['call', 'nope'], dir);
  assert.deepEqual([r.code, r.err.trim()], [1, 'No tool nope. List: node mycel.mjs tools.']);
});

// Watching files, for any agent and for edits in an editor: a changed file of a block is marked by itself.
test('watch marks changed files of blocks as edited and stale, whoever changed them', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Watch');
  await mkdir(join(dir, 'lib')); await mkdir(join(dir, 'node_modules'));
  await writeFile(join(dir, 'map.json'), JSON.stringify({ blocks: [{ id: 'srv', title: 'Server', files: ['lib/'] }] }));
  assert.equal((await h.run(['build', 'map.json', '--at-once'], dir)).code, 0);
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MYCEL_|KONTUR_)|^(CLAUDECODE|CLAUDE_PID)$/i.test(k)));
  const child = spawn(process.execPath, [script, 'watch', '--url', h.url, '--no-start'], { cwd: dir, env: { ...own, MYCEL_DATA: h.data }, windowsHide: true });
  // Watching does not end by itself and holds the folder: stop it before the folders are deleted, otherwise the run never ends.
  const stop = () => { child.stdout.destroy(); child.stderr.destroy(); child.kill(); child.unref(); };
  let out = '';
  child.stdout.setEncoding('utf8').on('data', c => { out += c; });
  child.stderr.setEncoding('utf8').on('data', c => { out += c; });
  try {
    await until(async () => out.includes('Watching'), 10000);
    await writeFile(join(dir, 'node_modules', 'x.js'), '1');
    await writeFile(join(dir, 'lib', '.env'), 'KEY=1');
    // Windows does not start sending events right after watching starts: the file is written again until it is noticed.
    let stale = [];
    for (let i = 0; i < 40 && !stale.length; i++) {
      if (i % 4 === 0) await writeFile(join(dir, 'lib', 'a.js'), `console.log(${i})`);
      await new Promise(r => setTimeout(r, 250));
      stale = (await h.api(`/api/p/${id}/code`)).body.stale;
    }
    assert.deepEqual(stale.map(s => [s.id, s.by, s.files]), [['srv', 'editor', ['lib/a.js']]], out);
    await until(async () => /lib\/a\.js → "Server"/.test(out), 5000);
  } finally { stop(); }
});

// The built-in agent for a local model: an OpenAI-compatible server (a fake one here), the Mycel tools and reading of the
// project files; .env is not read; the name on the map is local-<model>.
test('chat runs a local model through an OpenAI-compatible API with the Mycel tools and reading of project files', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Local');
  await writeFile(join(dir, 'app.js'), 'console.log(1)\n'); await writeFile(join(dir, '.env'), 'KEY=secret\n');
  const seen = [], call = (cid, name, args) => ({ id: cid, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const replies = [
    { tool_calls: [call('c1', 'list_files', {}), call('c2', 'read_file', { path: '.env' }), call('c3', 'read_file', { path: 'app.js' })] },
    { tool_calls: [call('c4', 'mycel_context', { brief: true })] },
    { tool_calls: [call('c5', 'mycel_build', { structure: { blocks: [{ id: 'app', title: 'App', text: 'Prints a number.' }] }, at_once: true })] },
    { content: 'The map is built.' }
  ];
  const llm = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ url: req.url, body: JSON.parse(body || '{}') });
    const reply = replies.shift() ?? { content: 'more' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.content ?? null, ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) } }] }));
  });
  await new Promise(r => llm.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { llm.closeAllConnections(); llm.close(r); }));
  const r = await h.run(['chat', '--base', `http://127.0.0.1:${llm.address().port}/v1`, '--model', 'qwen2.5:7b', 'build the map'], dir, { MYCEL_ACTOR: '' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'The map is built.');
  assert.deepEqual([seen[0].url, seen[0].body.model], ['/v1/chat/completions', 'qwen2.5:7b']);
  const names = seen[0].body.tools.map(x => x.function.name);
  assert.ok(['mycel_context', 'mycel_build', 'mycel_check', 'list_files', 'read_file', 'search_files'].every(n => names.includes(n)) && !names.includes('mycel_wait'));
  assert.match(seen[0].body.messages[0].content, /^# Mycel: short agent guide[\s\S]*project "Local" has a map of how it works/);
  const results = seen[1].body.messages.filter(m => m.role === 'tool').map(m => m.content);
  assert.match(results[0], /app\.js/);
  assert.match(results[1], /are not read/);
  assert.match(results[2], /^1: console\.log\(1\)/);
  assert.deepEqual((await h.api(`/api/p/${id}/graph`)).body.nodes.map(n => n.id), ['app']);
  assert.equal((await h.api(`/api/p/${id}/history`)).body.history[0].actor, 'local-qwen2.5-7b');
});

// Codex and Cursor hooks: an edit through apply_patch and afterFileEdit marks the files, the end of a reply reminds, the
// start of a session gives an overview of the map (as plain output in Codex, as additional_context in Cursor).
test('the hook understands Codex and Cursor events', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Hooks');
  await writeFile(join(dir, 'map.json'), JSON.stringify({ blocks: [{ id: 'srv', title: 'Server', files: ['lib/'] }, { id: 'ui', title: 'Window', files: ['ui/'] }] }));
  assert.equal((await h.run(['build', 'map.json', '--at-once'], dir)).code, 0);
  const hook = (from, event) => mycel(['hook', '--from', from], { cwd: dir, data: h.data, url: h.url, input: JSON.stringify(event), env: { MYCEL_ACTOR: '' } });
  const patch = '*** Begin Patch\n*** Update File: lib/a.js\n@@\n-a\n+b\n*** Add File: lib/b.js\n+x\n*** End Patch';
  let r = await hook('codex', { hook_event_name: 'PostToolUse', cwd: dir, session_id: 's1', tool_name: 'apply_patch', tool_input: { command: ['apply_patch', patch] } });
  assert.deepEqual([r.code, r.out], [0, '']);
  let stale = (await h.api(`/api/p/${id}/code`)).body.stale;
  assert.deepEqual(stale.map(s => [s.id, s.by, s.files]), [['srv', 'codex', ['lib/a.js', 'lib/b.js']]]);
  assert.equal(JSON.parse((await hook('codex', { hook_event_name: 'Stop', cwd: dir, session_id: 's1' })).out).decision, 'block');
  assert.match((await hook('codex', { hook_event_name: 'SessionStart', cwd: dir, source: 'startup' })).out, /^Mycel: project "Hooks" has a map of how it works/);
  r = await hook('cursor', { hook_event_name: 'afterFileEdit', conversation_id: 'c1', workspace_roots: [dir], file_path: join(dir, 'ui', 'view.js'), edits: [] });
  assert.equal(r.code, 0);
  stale = (await h.api(`/api/p/${id}/code`)).body.stale;
  assert.deepEqual(stale.find(s => s.id === 'ui').by, 'cursor');
  assert.match(JSON.parse((await hook('cursor', { hook_event_name: 'stop', conversation_id: 'c1', workspace_roots: [dir], status: 'completed', loop_count: 0 })).out).followup_message, /"Window" \(ui\)/);
  assert.equal((await hook('cursor', { hook_event_name: 'stop', conversation_id: 'c1', workspace_roots: [dir], status: 'completed', loop_count: 1 })).out, '');
  assert.match(JSON.parse((await hook('cursor', { hook_event_name: 'sessionStart', workspace_roots: [dir] })).out).additional_context, /project "Hooks"/);
});

test('hooks show the agent\'s task list under the map: the current step and the share done; without a list, the files it edits; the line goes at the end of a reply', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Progress');
  await writeFile(join(dir, 'map.json'), JSON.stringify({ blocks: [{ id: 'srv', title: 'Server', files: ['lib/'] }] }));
  assert.equal((await h.run(['build', 'map.json', '--at-once'], dir)).code, 0);
  const event = (name, extra = {}) => ({ hook_event_name: name, cwd: dir, session_id: 's1', ...extra });
  const tool = async (tool_name, tool_input, extra = {}) => assert.equal((await h.hook(event('PostToolUse', { tool_name, tool_input, ...extra }))).code, 0);
  // The line under the map for an actor; another actor's empty line reads the list without changing it.
  const line = async (actor = 'tester') => {
    const a = (await h.api(`/api/p/${id}/activity`, { actor: 'probe', text: null })).body.activity.find(x => x.actor === actor);
    return a ? [a.text, a.progress] : null;
  };
  // Claude Code TodoWrite: the whole list each time; the current step is shown by its activeForm.
  await tool('TodoWrite', { todos: [{ content: 'Read', status: 'completed', activeForm: 'Reading' }, { content: 'Write', status: 'in_progress', activeForm: 'Writing the server' },
    { content: 'Test', status: 'pending', activeForm: 'Testing' }, { content: 'Ship', status: 'pending', activeForm: 'Shipping' }] });
  assert.deepEqual(await line(), ['Writing the server', 25]);
  // A file edit while the list has open steps leaves the line alone; a helper agent's list is not the agent's task.
  await tool('Edit', { file_path: join(dir, 'README.md') });
  await tool('TodoWrite', { todos: [{ content: 'Other', status: 'in_progress' }] }, { agent_id: 'helper' });
  assert.deepEqual(await line(), ['Writing the server', 25]);
  // update_plan of the Claude desktop app: the whole list, then advance, done and start (from 1).
  await tool('mcp__ccd_turn__update_plan', { items: [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }, { content: 'Three', status: 'pending' }] });
  assert.deepEqual(await line(), ['One', 0]);
  await tool('mcp__ccd_turn__update_plan', { advance: true });
  assert.deepEqual(await line(), ['Two', 33]);
  await tool('mcp__ccd_turn__update_plan', { done: [2], start: 3 });
  assert.deepEqual(await line(), ['Three', 67]);
  // The end of a reply keeps the line while steps are left (the work goes on), and removes it when all are done.
  assert.equal((await h.hook(event('Stop'))).out, '');
  assert.deepEqual(await line(), ['Three', 67]);
  await tool('mcp__ccd_turn__update_plan', { advance: true });
  assert.deepEqual(await line(), ['Three', 100]);
  await h.hook(event('Stop'));
  assert.equal(await line(), null);
  // TaskCreate and TaskUpdate change one task; the id comes from the tool's answer.
  const s3 = { session_id: 's3' };
  await tool('TaskCreate', { subject: 'Build', description: 'b' }, { ...s3, tool_response: { task: { id: '1', subject: 'Build' } } });
  await tool('TaskCreate', { subject: 'Check', description: 'c' }, { ...s3, tool_response: 'Task #2 created successfully: Check' });
  assert.deepEqual(await line(), ['Build', 0]);
  await tool('TaskUpdate', { taskId: '1', status: 'in_progress', activeForm: 'Building' }, s3);
  assert.deepEqual(await line(), ['Building', 0]);
  await tool('TaskUpdate', { taskId: '1', status: 'completed' }, s3);
  assert.deepEqual(await line(), ['Check', 50]);
  await tool('TaskUpdate', { taskId: '2', status: 'deleted' }, s3);
  assert.deepEqual(await line(), ['Build', 100]);
  // Codex update_plan: plan with step and status.
  const codex = await mycel(['hook', '--from', 'codex'], { cwd: dir, data: h.data, url: h.url, env: { MYCEL_ACTOR: '' },
    input: JSON.stringify(event('PostToolUse', { session_id: 'c1', tool_name: 'update_plan', tool_input: { plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'in_progress' }] } })) });
  assert.equal(codex.code, 0);
  assert.deepEqual(await line('codex'), ['Fix', 50]);
  // Without a task list: the files being edited, without a percentage; the end of a reply removes the line.
  const s2 = { session_id: 's2' };
  await tool('Edit', { file_path: join(dir, 'lib', 'a.js') }, s2);
  assert.deepEqual(await line(), ['editing lib/a.js', null]);
  assert.equal(JSON.parse((await h.hook(event('Stop', s2))).out).decision, 'block');
  assert.deepEqual(await line(), ['editing lib/a.js', null]);
  await h.hook(event('Stop', { ...s2, stop_hook_active: true }));
  assert.equal(await line(), null);
  // A line the agent set itself (doing) is not replaced by the hooks for 2 minutes.
  assert.equal((await h.run(['doing', 'reading the code', '--progress', '10'], dir)).code, 0);
  await tool('Edit', { file_path: join(dir, 'lib', 'b.js') }, s2);
  await tool('TodoWrite', { todos: [{ content: 'X', status: 'in_progress' }] }, { session_id: 's5' });
  assert.deepEqual(await line(), ['reading the code', 10]);
});