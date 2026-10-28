import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, rename, readdir, open, utimes } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, parse, basename, sep } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { startServer } from '../server.mjs';
import { lockHub } from '../src/hub.mjs';
import { applyOperations, blocksOfFile, diffGraphs, Problem } from '../src/model.mjs';
import { measure } from '../src/layout.mjs';
import { migrateToV3 } from '../src/store.mjs';
import { seed } from '../src/seed.mjs';
import { slug } from '../src/slug.mjs';
import { codeFragments, levelProblems, levelReport } from '../src/levels.mjs';
import { defaultData } from '../src/paths.mjs';

// The hub always runs on a temporary data folder and a free port: the real .mycel and port 4317 are left alone.
const temp = prefix => mkdtemp(join(tmpdir(), prefix));
const clean = (...dirs) => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
const client = (url, token) => async (path, body, extra = {}) => {
  const res = await fetch(url + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(body) } : { headers: extra });
  return { status: res.status, body: await res.json() };
};
const tokenOf = async data => (await readFile(join(data, 'token'), 'utf8')).trim();
async function hubFixture(t, options = {}) {
  const data = await temp('mycel-data-');
  const app = await startServer({ data, port: 0, ...options });
  t.after(async () => { await app.close(); await clean(data); });
  const token = await tokenOf(data);
  return { data, app, token, hub: client(app.url, token) };
}
// A hub with one project on a temporary folder; call() routes /api/… to /api/p/<id>/….
async function fixture(t) {
  const h = await hubFixture(t), folder = await temp('mycel-folder-');
  t.after(() => clean(folder));
  const { project } = (await h.hub('/api/projects', { path: folder })).body;
  const call = (path, body, extra) => h.hub(path.replace(/^\/api\//, `/api/p/${project.id}/`), body, extra);
  const change = (revision, operations) => call('/api/changes', { expectedRevision: revision, actor: 'test-agent', message: 'Behaviour check', operations });
  return { ...h, folder, project, dir: join(h.data, 'projects', project.id), url: `${h.app.url}/api/p/${project.id}`, call, change };
}
// A registry and project folders written by hand, as an older version or a crash would leave them.
async function handmade(data, maps) {
  const projects = [];
  for (const [id, text] of Object.entries(maps)) {
    const dir = join(data, 'projects', id), entry = { id, name: id, path: null, createdAt: `2026-10-0${projects.length + 1}T00:00:00.000Z` };
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'project.json'), JSON.stringify(entry));
    if (text !== null) await writeFile(join(dir, 'graph.json'), text);
    projects.push(entry);
  }
  await writeFile(join(data, 'projects.json'), JSON.stringify({ version: 1, projects }));
}
// SSE events one by one; keepalive comments are skipped, null means the stream is closed.
function events(res) {
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (block.startsWith('data: ')) return JSON.parse(block.slice(6)); continue; }
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
}
const freePort = () => new Promise((resolve, reject) => { const probe = net.createServer().on('error', reject).listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const until = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await check()) return; assert.fail('Timed out waiting'); };
const alive = url => fetch(url + '/api/health').then(() => true, () => false);
const hostStatus = url => new Promise((resolve, reject) => { http.get(url, { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
const add = (id, extra = {}) => ({ type: 'add-node', node: { id, title: id, x: 0, y: 0, ...extra } });
const note = (id, attachedTo, extra = {}) => ({ type: 'add-node', node: { id, type: 'note', attachedTo, text: id, x: 0, y: 0, ...extra } });
const link = (id, source, target, label = '') => ({ type: 'add-edge', edge: { id, source, target, label } });

test('a rejected batch is atomic; geometry, colors and duplicate links are validated', () => {
  const graph = seed('test');
  assert.throws(() => applyOperations(graph, [add('a'), add('b'), link('l1', 'a', 'b'), link('l2', 'a', 'b')]), /already exists/);
  assert.throws(() => applyOperations(graph, [add('start')]), /A node with id "start" already exists/);
  assert.equal(graph.nodes.length, 1);
  assert.throws(() => applyOperations(graph, [add('a', { w: 5 })]), /Size/);
  assert.throws(() => applyOperations(graph, [add('a', { x: 'left' })]), /Coordinates/);
  assert.throws(() => applyOperations(graph, [add('a', { color: 'pink' })]), /color/);
  assert.throws(() => applyOperations(graph, [add('a'), link('l1', 'a', 'missing')]), /existing blocks/);
  assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'start', patch: { status: 'done' } }]), /Block mark/);
  assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'start', patch: { proposed: 'add' } }]), /cannot be changed/);
  assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'start', patch: { attachedTo: 'start' } }]), /Only a note/);
  assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'start', patch: { parentId: 'start' } }]), /inside itself/);
  const ok = applyOperations(graph, [add('a', { color: 'blue', w: 300, h: 80 }), add('b'), link('l1', 'a', 'b', 'leads to')]);
  assert.equal(ok.graph.nodes.length, 3); assert.equal(ok.graph.edges[0].label, 'leads to');
  assert.deepEqual(ok.changes, ['Added block "a"', 'Added block "b"', 'Added link "a" → "b"']);
  assert.throws(() => applyOperations(graph, [add('wide', { w: 50000 })]), /Size of node "wide"/);
});
test('the level check finds code, files and names from code, and lets plain texts through', () => {
  const plain = ['Telegram', 'OpenAI', 'PDF', 'Node.js, Vue.js, Next.js и D3.js', 'ASP.NET Core', 'Ученик пишет вопрос', '«Бот думает» → «Приходит ответ» 🤔',
    'Ответ длиннее 4096 символов Telegram не примет', 'Знаки < и & в ответе, например «x < 5»', '"Кавычки", «ёлочки» и \'апострофы\'', 'Цена 1 000 ₽, скидка 3.5 %, версия 1.2.3, 27/10/2026',
    'TCP/IP, I/O, CI/CD, A/B, HTTP/2, 24/7, км/ч, и/или', 'iPhone, iOS, macOS, eBay, ChatGPT, GPT-4o, YouTube, WhatsApp', 'Android/iOS и Windows/macOS', 'Команды /start и /help, кроме команд с «/»',
    'т. е., e.g., 10 a.m.', 'Сайт openai.com', 'e-mail и SMS', 'Ученик пишет боту @study_buddy_bot в Telegram', 'Команда /set_language меняет язык',
    'Ссылки t.me, youtu.be, socket.io, Booking.com, Mail.ru, character.ai', 'Фото photo.jpg и отчёт report.pdf', 'Yandex.Music, Socket.IO, U.S., Ph.D', 'Почта user@example.com',
    'ИИ (GPT-4o), Бот (Telegram), ответ(ы), e-mail(ы), GPT-4o(mini)', 'PlayStation, PowerPoint, GitHub, LinkedIn, PayPal, ServiceNow, Service и Handler', 'Node.js/Express', 'Ответ… и дальше'];
  const english = ['A student asks a question', '"Bot thinks" → "Answer arrives" 🤔', 'Telegram will not accept an answer longer than 4096 characters',
    'Signs < and & in the answer, for example "x < 5"', 'Price $1,000, discount 3.5 %, version 1.2.3, 10/27/2026', 'and/or, read/write, input/output, yes/no, on/off, he/she, client/server',
    'answer(s), file(s), box(es), entr(ies)', 'i.e., e.g., 10 a.m., U.S.', 'The user\'s question goes to the bot', 'Commands /start and /help'];
  for (const text of [...plain, ...english]) assert.deepEqual(codeFragments(text), [], text);
  const code = [['`render()`', 'code in backticks'], ['handle_message', 'name from code'], ['BOT_TOKEN', 'name from code'], ['getResponse', 'name from code'], ['onClick', 'name from code'],
    ['get_response()', 'function call'], ['send()', 'function call'], ['ai_service.get_response()', 'function call'], ['bot/handlers.py', 'file or path'], ['src/pay', 'file or path'],
    ['C:\\Users\\bot', 'file or path'], ['/api/p/mycel', 'file or path'], ['https://api.telegram.org/bot', 'file or path'], ['handlers.py', 'file'], ['.env', 'file'], ['.gitignore', 'file'],
    ['package.json', 'file'], ['README.md', 'file'], ['Отчёт.txt', 'file'], ['main.c', 'file'], ['Dockerfile', 'file'],
    // A code file after a path with capitalised folders (C#, Unity, Swift, React) and a path from the root.
    ['Controllers/HomeController.cs', 'file or path'], ['UI/Button.tsx', 'file or path'], ['Assets/Scripts/PlayerController.cs', 'file or path'],
    ['Sources/App/ContentView.swift', 'file or path'], ['Models/User.cs', 'file or path'], ['/main.py', 'file or path'],
    // Calls with arguments.
    ['send(message)', 'function call'], ['ask(question)', 'function call'], ['openai.chat.completions.create(model)', 'function call'],
    ['message.text.startswith("/")', 'function call'], ['create(...)', 'function call'],
    // Dotted names and classes.
    ['message.text', 'name from code'], ['bot.handlers', 'name from code'], ['os.getenv', 'name from code'], ['settings.DEBUG', 'name from code'], ['JSON.parse', 'name from code'],
    ['ChatCompletion.create', 'name from code'], ['message.from_user.id', 'name from code'], ['MessageHandler', 'name from code'], ['AIService', 'name from code'], ['CartService', 'name from code'],
    ['OpenAIClient', 'name from code'], ['UserRepository', 'name from code'], ['AsyncOpenAI', 'name from code'], ['TypeError', 'name from code']];
  for (const [fragment, what] of code) {
    assert.deepEqual(codeFragments(`Здесь ${fragment}, и всё.`), [[what, fragment]], fragment);
    assert.deepEqual(codeFragments(`Here ${fragment}, and that is all.`), [[what, fragment]], fragment);
  }
  // A path in quotes or before an ellipsis, a decorator.
  for (const text of ['Разбор в bot/handlers.py… и дальше', 'Parsing in bot/handlers.py… and on', '«bot/handlers.py»…', '“bot/handlers.py”', '„bot/handlers.py“']) assert.deepEqual(codeFragments(text), [['file or path', 'bot/handlers.py']], text);
  assert.deepEqual(codeFragments('Папка/main.py'), [['file', 'main.py']]);
  assert.deepEqual(codeFragments('Catches @router.message'), [['name from code', 'router.message']]);
  // The map: concept c, mechanics m, technical t; old text with code on the concept is not checked.
  const graph = applyOperations(seed('t'), [add('c', { title: 'Bot', text: 'Answers students' }), add('old', { text: 'Key BOT_TOKEN' }), add('m', { parentId: 'c', title: 'Receiving a question' }),
    add('t', { parentId: 'm', title: 'Handler' }), link('l1', 'c', 'old', 'question')]).graph;
  const problems = levelProblems(graph, [
    add('m2', { parentId: 'c', title: 'Client `OpenAI`', text: 'x'.repeat(201) }), add('t2', { parentId: 'm', title: 'Answer', text: '`get_response()` in `ai_service.py`' }),
    note('n1', 'c', { text: 'Reads BOT_TOKEN from .env' }), { type: 'add-node', node: { parentId: 'c', title: 'No id: getResponse' } }, { type: 'add-node', node: { parentId: 't', title: 'No id: getResponse' } },
    { type: 'update-node', id: 'c', patch: { title: 'Bot on `aiogram`', color: 'blue' } }, { type: 'update-node', id: 'old', patch: { color: 'red' } }, { type: 'update-node', id: 't', patch: { text: '`bot/handlers.py`' } },
    { type: 'update-node', id: 't2', patch: { parentId: 'c', text: 'Reads handle_message' } }, link('l2', 'c', 'm', 'OPENAI_API_KEY'), link('l3', 'm', 't', 'BOT_TOKEN'),
    { type: 'update-edge', id: 'l1', patch: { label: 'send()' } }]);
  // t2 is added on the technical level and moved to mechanics by the same batch: its final text is checked, not the first one.
  assert.deepEqual(problems.map(p => [p.what, p.name, p.level, p.field, p.problems.map(([what]) => what)]), [
    ['block', 'Client `OpenAI`', 'mechanics', 'title', ['code in backticks']], ['block', 'Client `OpenAI`', 'mechanics', 'text', ['longer than 200 characters']],
    ['block', 'Answer', 'mechanics', 'text', ['name from code']], ['note', 'Reads BOT_TOKEN from .env', 'concept', 'text', ['file', 'name from code']],
    ['block', 'No id: getResponse', 'mechanics', 'title', ['name from code']], ['block', 'Bot', 'concept', 'title', ['code in backticks']],
    ['edge', 'Bot" → "Receiving a question', 'mechanics', 'label', ['name from code']], ['edge', 'Bot" → "old', 'concept', 'label', ['function call']]]);
  const report = levelReport(problems).split('\n');
  assert.equal(report[0], 'Write rejected, nothing was written:');
  assert.equal(report[2], '- block "Client `OpenAI`" (mechanics), text: longer than 200 characters (201)');
  assert.equal(report[7], '- link "Bot" → "Receiving a question" (mechanics), label: name from code "OPENAI_API_KEY"');
  assert.equal(report.at(-1), 'The "Concept" and "Mechanics" levels are read by people who do not program: move code, files and variable names into a sub-map, to the "Technical" level; fix the file and try again.');
  assert.deepEqual(levelProblems(graph, [add('ok', { parentId: 'c', title: 'A student asks a question', text: 'The bot answers in Telegram 🤔' }), link('l4', 'c', 'ok', 'question')]), []);
  // Notes attached to a moved block go with it to the new level, as in applyOperations.
  const notes = applyOperations(graph, [add('m3', { parentId: 'c', title: 'Answer' }), note('mn', 'm3', { parentId: 'c', text: 'If you send a photo, the bot stays silent' }),
    add('t3', { parentId: 'm', title: 'Reading keys' }), note('tn', 't3', { parentId: 'm', text: 'Keys in a file' })]).graph;
  const down = [{ type: 'update-node', id: 'm3', patch: { parentId: 'm' } }, { type: 'update-node', id: 'mn', patch: { text: 'Fails on `message.text`' } }];
  const up = [note('tn2', 't3', { parentId: 'm', text: 'Key `OPENAI_API_KEY`' }), { type: 'update-node', id: 'tn', patch: { text: 'Reads BOT_TOKEN from `.env`' } },
    { type: 'update-node', id: 't3', patch: { parentId: 'c' } }];
  const parentAfter = (ops, id) => applyOperations(notes, ops).graph.nodes.find(n => n.id === id).parentId;
  assert.deepEqual([parentAfter(down, 'mn'), parentAfter(up, 'tn'), parentAfter(up, 'tn2')], ['m', 'c', 'c']);
  assert.deepEqual(levelProblems(notes, down), []);
  assert.deepEqual(levelProblems(notes, up).map(p => [p.what, p.name, p.level, p.field]), [['note', 'Key `OPENAI_API_KEY`', 'mechanics', 'text'], ['note', 'Keys in a file', 'mechanics', 'text']]);
});
test('deleting a block removes its links; moving and resizing are recorded distinctly', () => {
  const { graph } = applyOperations(seed('test'), [add('a'), add('b'), add('c'), link('l1', 'a', 'b'), link('l2', 'c', 'a')]);
  const removed = applyOperations(graph, [{ type: 'delete-node', id: 'a' }]);
  assert.deepEqual(removed.graph.nodes.map(n => n.id), ['start', 'b', 'c']); assert.equal(removed.graph.edges.length, 0);
  const moved = applyOperations(graph, [{ type: 'update-node', id: 'a', patch: { x: 10, y: 20 } }, { type: 'update-node', id: 'b', patch: { w: 200, h: 100 } }, { type: 'update-node', id: 'c', patch: { text: 'note' } }]);
  assert.deepEqual(moved.changes, ['Moved block "a"', 'Changed size of block "b"', 'Changed block "c"']);
});
// Files and a test command belong only to blocks; paths from the project root with "/". The same file list is not an edit.
test('files and a test command belong to blocks; a file finds its blocks, also through a folder', () => {
  const { graph } = applyOperations(seed('test'), [add('a', { files: ['src\\Server.mjs', './lib/', 'src\\Server.mjs'], test: 'npm test' }), add('b')]);
  assert.deepEqual([graph.nodes[1].files, graph.nodes[1].test], [['src/Server.mjs', 'lib/'], 'npm test']);
  for (const [patch, error] of [[{ files: ['/etc/passwd'] }, /Files of block "b"/], [{ files: ['C:/x.js'] }, /Files of block "b"/], [{ files: ['../x.js'] }, /Files of block "b"/], [{ files: 'a.js' }, /Files of block "b"/], [{ test: 5 }, /Test command of block "b"/]]) {
    assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'b', patch }]), error);
  }
  assert.throws(() => applyOperations(graph, [{ type: 'add-node', node: { id: 'n', type: 'note', files: ['a.js'] } }]), /blocks only/);
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  assert.deepEqual(blocksOfFile(graph, 'lib/deep/x.js').map(n => n.id), ['a']);
  assert.deepEqual(blocksOfFile(graph, 'src/server.mjs').map(n => n.id), fold ? ['a'] : []);
  assert.deepEqual(blocksOfFile(graph, 'library.js'), []);
  // Moving a block does not change its files in history; an empty list and an empty command remove the fields.
  const moved = applyOperations(graph, [{ type: 'update-node', id: 'a', patch: { x: 50 } }]).graph;
  assert.deepEqual(diffGraphs(graph, moved).nodes.updated, { a: ['x'] });
  const cleared = applyOperations(graph, [{ type: 'update-node', id: 'a', patch: { files: [], test: '' } }]);
  assert.deepEqual([cleared.graph.nodes[1].files, cleared.graph.nodes[1].test, cleared.changes], [undefined, undefined, ['Updated files and test command of block "a"']]);
});
test('notes attach only to blocks, move with them and vanish with them', () => {
  const base = applyOperations(seed('test'), [add('a', { x: 100, y: 100 }), add('b'), note('n1', 'a', { x: 280, y: 60 })]).graph;
  assert.throws(() => applyOperations(base, [note('n2', 'n1')]), /existing block on its own level/);
  assert.throws(() => applyOperations(base, [note('n2', 'missing')]), /existing block on its own level/);
  assert.throws(() => applyOperations(base, [add('inner', { parentId: 'a' }), note('n2', 'inner')]), /its own level/);
  assert.throws(() => applyOperations(base, [{ type: 'add-edge', edge: { source: 'a', target: 'n1' } }]), /Links connect blocks only/);
  const moved = applyOperations(base, [{ type: 'update-node', id: 'a', patch: { x: 150, y: 80 } }]);
  assert.deepEqual([moved.graph.nodes.find(n => n.id === 'n1').x, moved.graph.nodes.find(n => n.id === 'n1').y], [330, 40]);
  const detached = applyOperations(base, [{ type: 'update-node', id: 'n1', patch: { attachedTo: null } }]);
  assert.deepEqual(detached.changes, ['Detached note "n1"']);
  assert.deepEqual(applyOperations(base, [{ type: 'update-node', id: 'n1', patch: { x: 5, y: 5, attachedTo: 'b' } }]).changes, ['Attached note "n1"']);
  assert.throws(() => applyOperations(base, [{ type: 'update-node', id: 'a', patch: { attachedTo: 'b' } }]), /Only a note/);
  const removed = applyOperations(base, [{ type: 'delete-node', id: 'a' }]);
  assert.deepEqual(removed.graph.nodes.map(n => n.id), ['start', 'b']);
  assert.deepEqual(removed.changes, ['Deleted block "a" (1 note)']);
  const long = applyOperations(base, [{ type: 'add-node', node: { type: 'note', text: 'Check the card payment limit for new customers in every region' } }]);
  assert.deepEqual(long.changes, ['Added note "Check the card payment limit for new…"']);
  const fresh = applyOperations(seed('test'), [{ type: 'add-node', node: { id: 'n', type: 'note', text: 'hi', x: 0, y: 0 } }]).graph.nodes[1];
  assert.deepEqual(fresh, { id: 'n', type: 'note', parentId: null, attachedTo: null, collapsed: false, title: '', text: 'hi', x: 0, y: 0, w: 160, h: 120, color: 'yellow' });
});
test('sub-maps: nested levels, no cycles, limited depth, subtree deletion, collapsing', () => {
  const base = applyOperations(seed('test'), [add('a'), add('b', { parentId: 'a', x: 10, y: 10 }), add('c', { parentId: 'b' }), add('d'), note('n1', 'b', { parentId: 'a' }), link('l1', 'c', 'd', 'outward')]).graph;
  assert.equal(base.nodes.find(n => n.id === 'n1').parentId, 'a');
  assert.throws(() => applyOperations(base, [{ type: 'update-node', id: 'a', patch: { parentId: 'c' } }]), /inside itself/);
  // Also when the same batch collapses a sub-map or moves a block: layout does not start on a map with a cycle.
  const cyclic = [{ type: 'update-node', id: 'a', patch: { parentId: 'c' } }];
  for (const more of [{ type: 'update-node', id: 'b', patch: { collapsed: true } }, { type: 'update-node', id: 'c', patch: { x: 900, y: 900 } }, { type: 'update-node', id: 'b', patch: { collapsed: true, color: 'red' } }])
    assert.throws(() => applyOperations(base, [...cyclic, more, { type: 'update-node', id: 'd', patch: { collapsed: false } }]), e => e instanceof Problem && e.status === 400 && /inside itself/.test(e.message));
  assert.throws(() => applyOperations(base, [add('x', { parentId: 'missing' })]), /parentId must be an existing block/);
  assert.throws(() => applyOperations(base, [add('x', { parentId: 'n1' })]), /parentId must be an existing block/);
  assert.throws(() => applyOperations(base, [add('y', { parentId: 'x' }), add('x', { parentId: 'missing' })]), /parentId must be an existing block/);
  const at = (graph, id) => graph.nodes.find(n => n.id === id);
  const same = applyOperations(base, [{ type: 'update-node', id: 'b', patch: { parentId: 'a', x: 30, y: 20 } }]).graph;
  assert.deepEqual([at(same, 'n1').x, at(same, 'n1').y], [20, 10]);
  const carried = applyOperations(base, [{ type: 'update-node', id: 'b', patch: { parentId: null, x: 400, y: 0 } }]);
  assert.deepEqual(carried.changes, ['Moved block "b" to another level']);
  assert.deepEqual([at(carried.graph, 'n1').parentId, at(carried.graph, 'n1').x, at(carried.graph, 'n1').y], [null, 390, -10]);
  const folded = applyOperations(base, [{ type: 'update-node', id: 'a', patch: { collapsed: true } }]);
  assert.deepEqual(folded.changes, ['Collapsed sub-map "a"']); assert.equal(folded.graph.nodes.find(n => n.id === 'a').collapsed, true);
  const moved = applyOperations(base, [{ type: 'update-node', id: 'c', patch: { parentId: null, x: 500, y: 0 } }]);
  assert.deepEqual(moved.changes, ['Moved block "c" to another level']); assert.equal(moved.graph.nodes.find(n => n.id === 'c').parentId, null);
  const removed = applyOperations(base, [{ type: 'delete-node', id: 'a' }]);
  assert.deepEqual(removed.graph.nodes.map(n => n.id), ['start', 'd']); assert.equal(removed.graph.edges.length, 0);
  assert.deepEqual(removed.changes, ['Deleted block "a" (3 nested nodes)']);
  const chain = Array.from({ length: 10 }, (_, i) => add(`l${i}`, { parentId: i ? `l${i - 1}` : null }));
  assert.equal(applyOperations(seed('test'), chain.slice(0, 8)).graph.nodes.length, 9);
  assert.throws(() => applyOperations(seed('test'), chain), /Nesting/);
});
test('a batch that makes a parent cycle and deletes a block inside it is refused instead of hanging', async () => {
  // Deletion counted nested nodes by walking up the ancestors, and on a cycle the walk never ended: the hub stopped answering anything.
  // The batch runs in a separate thread so that a hang does not stop the run.
  const graph = applyOperations(seed('test'), [add('a'), add('b'), add('x', { parentId: 'a', x: 24, y: 24 })]).graph;
  const operations = [{ type: 'update-node', id: 'a', patch: { parentId: 'b' } }, { type: 'update-node', id: 'b', patch: { parentId: 'a' } }, { type: 'delete-node', id: 'x' }];
  const code = `const { parentPort, workerData } = require('node:worker_threads');
import(workerData.url).then(({ applyOperations }) => { try { applyOperations(workerData.graph, workerData.operations); parentPort.postMessage('accepted'); } catch (e) { parentPort.postMessage(e.status + ' ' + e.message); } });`;
  const worker = new Worker(code, { eval: true, workerData: { url: new URL('../src/model.mjs', import.meta.url).href, graph, operations } });
  let timer;
  try {
    const answer = await Promise.race([once(worker, 'message').then(([m]) => m), new Promise(resolve => { timer = setTimeout(resolve, 5000, 'no answer within 5 s'); })]);
    assert.equal(answer, '400 A block cannot lie inside itself.');
  } finally { clearTimeout(timer); await worker.terminate(); }
});
test('nodes without coordinates are laid out: columns follow links, sub-maps fit their content', () => {
  const at = (graph, id) => graph.nodes.find(n => n.id === id);
  const auto = (id, extra = {}) => ({ type: 'add-node', node: { id, title: id, ...extra } });
  const { graph } = applyOperations(seed('test'), [auto('ui'), auto('api', { text: 'Reads and changes the map' }), auto('store'), auto('srv'), auto('m1', { parentId: 'srv' }), auto('m2', { parentId: 'srv' }),
    { type: 'add-node', node: { id: 'n1', type: 'note', attachedTo: 'api', text: 'Note' } }, link('e1', 'ui', 'api'), link('e2', 'api', 'store'), link('e3', 'm1', 'm2')]);
  const [start, ui, api, store, srv, m1, m2, n1] = ['start', 'ui', 'api', 'store', 'srv', 'm1', 'm2', 'n1'].map(id => at(graph, id));
  assert.deepEqual([start.x, start.y], [0, 0]);
  assert.ok(ui.x > start.x + start.w && api.x > ui.x + ui.w && store.x > n1.x + n1.w, 'a link source is left of its target, new is right of old');
  assert.deepEqual([n1.x, n1.y], [api.x + api.w + 16, api.y]);
  assert.deepEqual([m1.x, m1.y], [24, 24]); assert.ok(m2.x > m1.x + m1.w);
  assert.ok(srv.w >= m2.x + m2.w + 26 && srv.h >= 36 + m1.y + m1.h + 14, 'the container holds the sub-map');
  assert.ok(api.h > ui.h && api.w === 240, 'the height fits the text');
  const nodes = graph.nodes.filter(n => n.parentId === null);
  for (const a of nodes) for (const b of nodes) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} and ${b.id} do not overlap`);
});
test('layout tidies a level: links into sub-maps count for their container, sources come first', () => {
  // Everything is piled up; ui leads into the nested api, and the nested core links to db.
  const base = applyOperations(seed('test'), [add('db', { x: 0, y: 0 }), add('srv', { x: 0, y: 0 }), add('ui', { x: 0, y: 0 }), add('api', { parentId: 'srv', x: 500, y: 500 }), add('core', { parentId: 'srv', x: 0, y: 0 }),
    link('l1', 'ui', 'api'), link('l2', 'core', 'db'), link('l3', 'api', 'core'), link('l4', 'start', 'ui'),
    add('s1', { parentId: 'api', x: 0, y: 0 }), add('s2', { parentId: 'api', x: 0, y: 0 }), link('l5', 's1', 's2'),
    add('k1', { parentId: 's1', x: 0, y: 0 }), add('k2', { parentId: 's1', x: 0, y: 0 }), link('l6', 'k1', 'k2')]).graph;
  const { graph, changes } = applyOperations(base, [{ type: 'layout', deep: true }]);
  const at = id => graph.nodes.find(n => n.id === id), right = id => at(id).x + at(id).w;
  assert.deepEqual(changes, ['Arranged the map with its sub-maps']);
  assert.ok(right('start') < at('ui').x && right('ui') < at('srv').x && right('srv') < at('db').x, 'start → ui → srv → db from left to right');
  assert.deepEqual([at('api').x, at('api').y], [24, 24]); assert.ok(at('core').x > right('api'));
  // The outer sub-map grows after its level is laid out, not to fit the old pile of nested nodes: exactly the content plus 24 px.
  const fitted = measure(graph).content(at('srv'), 24);
  assert.deepEqual([at('srv').w, at('srv').h], [fitted.w, fitted.h], 'the sub-map shrinks to its new content');
  assert.ok(at('s2').x > right('s1'), 'technical goes from left to right');
  assert.ok(at('k2').y > at('k1').y + at('k1').h && at('k2').x === at('k1').x, 'on the code level steps go from top to bottom');
  assert.throws(() => applyOperations(base, [{ type: 'layout', parentId: 'missing' }]), /can be arranged/);
  // Links in both directions (a cycle) do not break the layout.
  const cycle = applyOperations(seed('test'), [add('p', { x: undefined, y: undefined }), add('q', { x: undefined, y: undefined }), link('c1', 'p', 'q'), link('c2', 'q', 'p'), { type: 'layout', deep: true }]).graph;
  assert.ok(cycle.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
});
test('expanding a sub-map moves neighbours aside, folding moves them back', () => {
  const base = applyOperations(seed('test'), [add('c', { x: 0, y: 200, collapsed: true }), add('k', { parentId: 'c', x: 24, y: 24, w: 600, h: 300 }), add('right', { x: 300, y: 200 }), add('below', { x: 0, y: 400 })]).graph;
  const at = (graph, id) => { const n = graph.nodes.find(x => x.id === id); return [n.x, n.y]; };
  const open = applyOperations(base, [{ type: 'update-node', id: 'c', patch: { collapsed: false } }]).graph;
  assert.deepEqual([at(open, 'right'), at(open, 'below'), at(open, 'start')], [[300 + 430, 200], [0, 400 + 308], [0, 0]]);
  const back = applyOperations(open, [{ type: 'update-node', id: 'c', patch: { collapsed: true } }]).graph;
  assert.deepEqual([at(back, 'right'), at(back, 'below')], [[300, 200], [0, 400]]);
});
test('agents read what changed since their revision and can wait for other actors', async t => {
  const f = await fixture(t);
  await f.change(0, [add('a', { text: 'old' }), add('b'), link('l1', 'a', 'b')]);
  const human = (revision, operations) => f.call('/api/changes', { expectedRevision: revision, actor: 'human', message: 'The person\'s edit', operations });
  await human(1, [{ type: 'update-node', id: 'a', patch: { text: 'new' } }, add('c'), { type: 'delete-edge', id: 'l1' }]);
  const seen = (await f.call('/api/changes?since=1&exclude=test-agent')).body;
  assert.equal(seen.revision, 2); assert.equal(seen.complete, true); assert.deepEqual(seen.entries.map(e => e.actor), ['human']);
  assert.deepEqual(seen.nodes.updated.map(n => [n.id, n.text, n.fields]), [['a', 'new', ['text']]]);
  assert.deepEqual(seen.nodes.added.map(n => n.id), ['c']); assert.deepEqual(seen.edges.removed, [{ id: 'l1', source: 'a', target: 'b', label: '' }]);
  assert.deepEqual((await f.call('/api/changes?since=0&exclude=human')).body.nodes.added.map(n => n.id), ['a', 'b']);
  assert.equal((await f.call('/api/changes?since=99')).body.complete, false);
  assert.equal((await f.call('/api/changes')).status, 400);
  // The agent's own edit does not wake its wait, the person's finished edit does.
  await f.call('/api/edits', {});
  const started = Date.now();
  const waiting = f.call('/api/changes?since=2&exclude=test-agent&wait=10');
  await f.change(2, [add('own')]);
  await human(3, [{ type: 'update-node', id: 'b', patch: { title: 'Renamed' } }]);
  await f.call('/api/edits', {});
  const woke = (await waiting).body;
  assert.ok(Date.now() - started < 5000); assert.deepEqual(woke.entries.map(e => e.revision), [4]);
  assert.deepEqual(woke.nodes.updated.map(n => [n.id, n.title]), [['b', 'Renamed']]);
  const idle = await f.call('/api/changes?since=4&wait=0.2');
  assert.deepEqual([idle.status, idle.body.entries.length], [200, 0]);
  // content=1: moving and collapsing do not wake, a text edit wakes and brings what was collected along with it.
  const contentOnly = f.call('/api/changes?since=4&exclude=test-agent&wait=10&content=1');
  await human(4, [{ type: 'update-node', id: 'a', patch: { x: 300, y: 40 } }]);
  await human(5, [{ type: 'update-node', id: 'b', patch: { w: 260 } }]);
  assert.equal((await f.call('/api/changes?since=4')).body.contentChanged, false);
  await human(6, [{ type: 'update-node', id: 'c', patch: { text: 'content' } }]);
  await f.call('/api/edits', {});
  const content = (await contentOnly).body;
  // A move and a resize in a row by the person are one history entry (revision 6), the text edit is its own.
  assert.equal(content.contentChanged, true); assert.deepEqual(content.entries.map(e => e.revision), [6, 7]);
  assert.deepEqual(content.entries[0].changes, ['Moved block "a"', 'Changed size of block "Renamed"']);
  assert.deepEqual(content.nodes.updated.map(n => [n.id, n.fields]), [['a', ['x', 'y']], ['b', ['w']], ['c', ['text']]]);
  assert.deepEqual((await f.call('/api/changes?since=5')).body.nodes.updated.map(n => n.id), ['a', 'b', 'c']);
});
test('no chat: an agent says what it is doing, shows a block and reads what the human selected; the human cannot be written to', async t => {
  const f = await fixture(t);
  await f.change(0, [add('a', { title: 'Cart' }), note('n', 'a', { text: 'The discount disappears' })]);
  const controller = new AbortController(); t.after(() => controller.abort());
  const next = events(await fetch(f.url + '/events', { signal: controller.signal }));
  assert.deepEqual(await next(), { revision: 1, edit: null, agents: [], activity: [], work: [], code: { stale: {}, risks: {} } });
  // A waiting agent shows as a dot: it is connected.
  const waiting = f.call('/api/changes?since=1&exclude=claude&wait=10&content=1&chat=0', null, { 'X-Mycel-Actor': 'claude' });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual((await f.hub(`/api/p/${f.project.id}`)).body.project.agents.map(a => [a.actor, a.waiting]), [['claude', true]]);
  let event; do event = await next(); while (!event.agents.some(a => a.waiting));
  assert.deepEqual(event.agents.map(a => [a.actor, a.waiting]), [['claude', true]]);
  // What the agent is doing now is a line under the map; null clears it.
  assert.equal((await f.call('/api/activity', { actor: 'claude', text: 'reading `server.mjs`', progress: 40 })).status, 200);
  event = await next();
  assert.deepEqual(event.activity.map(a => [a.actor, a.text, a.progress]), [['claude', 'reading `server.mjs`', 40]]);
  for (const bad of [{ actor: 'claude', text: '' }, { actor: 'human', text: 'x' }, { actor: 'claude', text: 'x', progress: 150 }]) assert.equal((await f.call('/api/activity', bad)).status, 400);
  await f.call('/api/activity', { actor: 'claude', text: null });
  assert.deepEqual((await next()).activity, []);
  // The agent shows a block: open pages get its id.
  assert.equal((await f.call('/api/show', { id: 'missing', actor: 'claude' })).status, 400);
  await f.call('/api/show', { id: 'a', actor: 'claude' });
  assert.deepEqual([(event = await next()).show, event.by], ['a', 'claude']);
  // The agent sees what the person selected in selection and in context.
  assert.deepEqual((await f.call('/api/selection')).body, { focus: null, selection: null });
  assert.equal((await f.call('/api/selection', { id: 'missing' })).status, 400);
  await f.call('/api/selection', { id: 'n' });
  assert.deepEqual((await f.call('/api/selection')).body, { focus: null, selection: 'n' });
  assert.match(await fetch(`${f.url}/context?brief=1`).then(r => r.text()), /The person selected the note "The discount disappears" \(n\) on the map/);
  // There is no chat: events cannot be written from outside, only Mycel writes them from the person's buttons.
  for (const path of ['/api/chat', '/api/chat/status']) assert.equal((await f.call(path, { author: 'human', text: 'Hello' })).status, 404);
  assert.equal((await f.call('/api/chat?since=-1')).status, 400);
  controller.abort();
  await f.call('/api/changes', { expectedRevision: 1, actor: 'test-agent', message: 'Wakes', operations: [add('b')] });
  await waiting;
});test('an agent proposal lies on the map marked until the human accepts or rejects it; his edits and the decision wake the agent', async t => {
  const f = await fixture(t);
  await f.change(0, [add('k', { title: 'Cart', w: 500, h: 300 }), add('s', { parentId: 'k', title: 'Total', x: 10, y: 10 }), add('o', { title: 'Payment', x: 700 }), link('e1', 'k', 'o', 'total')]);
  await f.change(1, [{ type: 'update-node', id: 'k', patch: { collapsed: true } }]);
  // Marks: only on blocks and only known ones; a proposal flag cannot be set with an edit.
  assert.equal((await f.change(2, [{ type: 'update-node', id: 'o', patch: { status: 'done' } }])).status, 400);
  assert.equal((await f.change(2, [add('n', { type: 'note', status: 'plan' })])).status, 400);
  assert.equal((await f.change(2, [{ type: 'update-node', id: 'o', patch: { proposed: 'add' } }])).status, 400);
  const offer = (revision, operations, title) => f.call('/api/proposal', { expectedRevision: revision, actor: 'claude', ...(title ? { title } : {}), operations });
  assert.equal((await offer(2, [add('x')])).status, 400);
  let res = await offer(2, [add('promo', { parentId: 'k', title: 'Promo code', x: 10, y: 150 }), { type: 'update-node', id: 's', patch: { text: 'with a discount' } },
    { type: 'delete-node', id: 'o' }, link('e2', 'promo', 's', 'discount')], 'Promo codes');
  assert.equal(res.status, 200, res.body.error);
  const marks = g => Object.fromEntries([...g.nodes, ...g.edges].map(x => [x.id, [x.proposed ?? '-', x.status ?? '-']]));
  assert.deepEqual(marks(res.body), { k: ['-', '-'], s: ['change', '-'], o: ['remove', '-'], promo: ['add', 'plan'], e1: ['-', '-'], e2: ['add', '-'] });
  // A collapsed sub-map with proposed content expands, the deletion is only marked, the previous content is remembered.
  assert.equal(res.body.nodes.find(n => n.id === 'k').collapsed, false);
  assert.deepEqual([res.body.proposal.title, res.body.proposal.by, res.body.proposal.nodes.s.text], ['Promo codes', 'claude', '']);
  const context = await fetch(`${f.url}/context?brief=1`).then(r => r.text());
  assert.match(context, /Open proposal "Promo codes" \(claude\): add: 1, change: 1, remove: 1/);
  assert.match(context, /ID: promo \| level: mechanics \| inside: k \| planned, no code yet \| proposed: add/);
  // The next proposal extends the open one.
  res = await offer(3, [add('p2', { parentId: 'k', title: 'Coupon', x: 300, y: 150 })]);
  assert.deepEqual([res.status, res.body.proposal.title, marks(res.body).p2], [200, 'Promo codes', ['add', 'plan']]);
  // The person edits the proposal: the edits pile up and the agent does not wake; the decision wakes it together with the edits.
  const waiting = f.call('/api/changes?since=4&exclude=claude&wait=10&content=1&chat=0');
  await f.call('/api/changes', { expectedRevision: 4, actor: 'human', message: 'Edit', operations: [{ type: 'update-node', id: 'promo', patch: { title: 'Order promo code' } }] });
  assert.equal(await Promise.race([waiting.then(() => 'woke'), new Promise(r => setTimeout(() => r('asleep'), 500))]), 'asleep');
  const accepted = (await f.call('/api/proposal/accept', {})).body;
  // What was marked for deletion is deleted with its links, the new stays a plan.
  assert.deepEqual(marks(accepted.graph), { k: ['-', '-'], s: ['-', '-'], promo: ['-', 'plan'], p2: ['-', 'plan'], e2: ['-', '-'] });
  assert.equal(accepted.graph.proposal, undefined);
  assert.deepEqual([accepted.message.kind, accepted.message.proposal.result, accepted.message.proposal.edits.count], ['proposal', 'accepted', 1]);
  const woke = (await waiting).body;
  assert.deepEqual([woke.chat.messages.map(m => m.kind), woke.edit, woke.contentChanged], [['proposal'], null, true]);
  assert.equal((await f.call('/api/proposal/accept', {})).status, 409);
  assert.equal((await offer(woke.revision, [add('y')])).status, 400);
  // Rejection: what was added goes away, what was changed or moved into the proposal comes back, marks are removed.
  res = await offer(woke.revision, [add('box', { title: 'Discounts', x: 0, y: 600, w: 400, h: 300 }), { type: 'update-node', id: 's', patch: { parentId: 'box', x: 10, y: 10, text: 'in discounts' } },
    { type: 'update-edge', id: 'e2', patch: { label: 'code' } }], 'Discounts apart');
  assert.equal(res.status, 200, res.body.error);
  const rejected = (await f.call('/api/proposal/reject', {})).body;
  const s = rejected.graph.nodes.find(n => n.id === 's');
  assert.deepEqual([s.parentId, s.text, s.x, s.y, s.proposed, rejected.graph.nodes.some(n => n.id === 'box'), rejected.graph.edges.find(e => e.id === 'e2').label],
    ['k', 'with a discount', 10, 10, undefined, false, 'discount']);
  assert.deepEqual([rejected.message.proposal.result, rejected.message.text], ['rejected', 'Rejected proposal "Discounts apart"']);
  assert.deepEqual((await f.call('/api/history')).body.history.slice(0, 2).map(h => h.message), ['Rejected proposal "Discounts apart"', 'Proposal "Discounts apart"']);
});
test('human edits wake no agent until the human finishes them, survive a restart and arrive as one event', async t => {
  const data = await temp('mycel-edits-'), folder = await temp('mycel-folder-');
  let app;
  t.after(async () => { if (app) await app.close(); await clean(data, folder); });
  app = await startServer({ data, port: 0 });
  const token = await tokenOf(data);
  let hub = client(app.url, token);
  const { project } = (await hub('/api/projects', { path: folder })).body, dir = join(data, 'projects', project.id);
  const call = (path, body) => hub(`/api/p/${project.id}${path}`, body);
  const write = (actor, revision, operations) => call('/changes', { expectedRevision: revision, actor, message: 'Edit', operations });
  await write('claude', 0, [add('a', { text: 'old' }), add('b')]);
  // Collapsing and moves do not start edits, the first content edit does.
  await write('human', 1, [{ type: 'update-node', id: 'b', patch: { x: 300 } }]);
  assert.equal((await call('/changes?since=1')).body.edit, null);
  await write('human', 2, [{ type: 'update-node', id: 'a', patch: { text: 'new' } }]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'edit.json'), 'utf8')).since, 2);
  // Started edits survive a restart.
  await app.close(); app = null;
  app = await startServer({ data, port: 0 }); hub = client(app.url, token);
  assert.equal((await call('/changes?since=2')).body.edit.since, 2);
  const waiting = call('/changes?since=2&exclude=claude&wait=10&content=1&chat=0');
  await write('human', 3, [{ type: 'update-node', id: 'b', patch: { title: 'Cart' } }]);
  await write('human', 4, [{ type: 'update-node', id: 'a', patch: { x: 500 } }]);
  assert.equal(await Promise.race([waiting.then(() => 'woke'), new Promise(r => setTimeout(() => r('asleep'), 600))]), 'asleep');
  const now = (await call('/changes?since=2&exclude=claude')).body;
  assert.deepEqual([now.edit.since, now.edit.count, now.held, now.entries.length, now.contentChanged], [2, 2, 3, 3, false]);
  assert.match(await fetch(`${app.url}/api/p/${project.id}/context`).then(r => r.text()), /The person is editing the map right now \(since revision 2, records: 2\)/);
  // "Finish edits": one event wakes the agent, the changes come with it.
  const done = (await call('/edits', {})).body.message;
  assert.deepEqual([done.kind, done.author, done.edits], ['edits', 'human', { since: 2, at: done.edits.at, count: 2, until: 5 }]);
  const woke = (await waiting).body;
  assert.deepEqual([woke.chat.messages.map(m => m.kind), woke.entries.map(e => e.revision), woke.edit, woke.held, woke.contentChanged], [['edits'], [3, 4, 5], null, 0, true]);
  await assert.rejects(readFile(join(dir, 'edit.json')), { code: 'ENOENT' });
  assert.equal((await call('/edits', {})).body.message, null);
  assert.equal((await call('/changes?since=5')).body.edit, null);
});
test('links can be relabelled, reversed and deleted', async t => {
  const f = await fixture(t);
  assert.equal((await f.change(0, [add('a'), add('b'), link('l1', 'a', 'b')])).status, 200);
  assert.equal((await f.change(1, [{ type: 'update-edge', id: 'l1', patch: { label: 'passes' } }])).status, 200);
  const reversed = await f.change(2, [{ type: 'update-edge', id: 'l1', patch: { source: 'b', target: 'a' } }]);
  assert.equal(reversed.status, 200); assert.deepEqual(reversed.body.edges[0], { id: 'l1', source: 'b', target: 'a', label: 'passes' });
  assert.deepEqual((await f.call('/api/history')).body.history.slice(0, 2).map(h => h.changes[0]), ['Reversed link: "b" → "a"', 'Changed label of link "a" → "b": "passes"']);
  assert.equal((await f.change(3, [{ type: 'update-edge', id: 'l1', patch: { kind: 'flow' } }])).status, 400);
  assert.equal((await f.change(3, [{ type: 'delete-edge', id: 'l1' }])).body.edges.length, 0);
});
test('concurrent writers cannot overwrite each other; history and disk agree', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.all([f.change(0, [add('alpha')]), f.change(0, [add('beta')])]);
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
  const disk = JSON.parse(await readFile(join(f.dir, 'graph.json'), 'utf8'));
  assert.equal(disk.revision, 1); assert.equal(disk.nodes.length, 1); assert.equal(disk.history.length, 1);
  assert.equal((await f.call('/api/graph')).body.revision, 1);
  assert.equal((await f.call('/api/history')).body.history[0].actor, 'test-agent');
  assert.equal((await f.change(1, [add('valid'), link('bad', 'valid', 'missing')])).status, 400);
  assert.equal((await f.call('/api/graph')).body.nodes.length, 1);
});
test('saved data and the token survive a restart; a second hub on the same data is refused', async t => {
  const data = await temp('mycel-restart-'), folder = await temp('mycel-folder-');
  let app;
  t.after(async () => { if (app) await app.close(); await clean(data, folder); });
  app = await startServer({ data, port: 0 });
  await assert.rejects(startServer({ data, port: 0 }), new RegExp(`^Error: Mycel is already running: ${app.url.replace(/\./g, '\\.')}$`));
  assert.equal(JSON.parse(await readFile(join(data, 'server.lock'), 'utf8')).port, Number(new URL(app.url).port));
  const token = await tokenOf(data);
  let hub = client(app.url, token);
  const { project } = (await hub('/api/projects', { path: folder })).body;
  assert.equal((await hub(`/api/p/${project.id}/changes`, { expectedRevision: 0, actor: 'agent', message: 'Persistent', operations: [add('persisted', { x: 300, y: -40 })] })).status, 200);
  await app.close(); app = null;
  app = await startServer({ data, port: 0 });
  hub = client(app.url, token);
  assert.equal((await hub('/api/session')).body.token, token);
  const graph = (await hub(`/api/p/${project.id}/graph`)).body;
  assert.equal(graph.revision, 1); assert.deepEqual(graph.nodes[0], { id: 'persisted', type: 'block', parentId: null, attachedTo: null, collapsed: false, title: 'persisted', text: '', x: 300, y: -40, w: 220, h: 110, color: '' });
  assert.deepEqual((await hub('/api/projects')).body.projects.map(p => [p.id, p.revision, p.blocks]), [[project.id, 1, 1]]);
});
function legacyMap() {
  const node = (id, parentId, title, extra = {}) => ({ id, parentId, title, kind: 'component', status: 'idea', summary: '', logic: '', questions: '', criteria: '', ...extra });
  return {
    schemaVersion: 2, revision: 8, updatedAt: '2026-10-01T00:00:00.000Z',
    nodes: [node('product', null, 'Shop', { kind: 'product', status: 'building', summary: 'An online shop.' }), node('checkout', 'product', 'Checkout', { logic: 'Cart → payment', questions: 'Without sign-up?' }), node('payment', 'checkout', 'Payment', { status: 'done', criteria: 'The payment goes through' }), node('catalog', 'product', 'Catalog')],
    edges: [{ id: 'relation', source: 'catalog', target: 'checkout', kind: 'flow', label: 'passes the item' }, { id: 'dep', source: 'payment', target: 'catalog', kind: 'depends', label: '' }],
    history: [{ revision: 8, actor: 'human', message: 'Previous decision', changes: ['Keep this'], at: '2026-10-01T00:00:00.000Z' }]
  };
}
test('nested maps become free-form maps: tree links, merged text, positions', () => {
  const next = migrateToV3(legacyMap());
  assert.equal(next.schemaVersion, 3); assert.equal(next.nodes.length, 4);
  const checkout = next.nodes.find(n => n.id === 'checkout');
  assert.equal(checkout.text, 'Logic: Cart → payment\n\nOpen questions: Without sign-up?');
  assert.equal(next.nodes.find(n => n.id === 'payment').text, 'Done criteria: The payment goes through\n\nStatus: Done');
  assert.equal(next.nodes.find(n => n.id === 'product').color, 'blue');
  assert.ok(next.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y) && n.w === 220 && n.h === 110));
  assert.ok(checkout.x > next.nodes.find(n => n.id === 'product').x && next.nodes.find(n => n.id === 'payment').x > checkout.x);
  assert.deepEqual(next.edges.map(e => `${e.source}>${e.target}:${e.label}`), ['product>checkout:', 'checkout>payment:', 'product>catalog:', 'catalog>checkout:passes the item', 'payment>catalog:dependency']);
  assert.deepEqual(next.history, legacyMap().history);
});
test('migration keeps an original backup and runs once; version 1 maps migrate too', async t => {
  const data = await temp('mycel-migration-'), dir = join(data, 'projects', 'shop');
  const oldText = JSON.stringify(legacyMap(), null, 2);
  await handmade(data, { shop: oldText });
  let app;
  t.after(async () => { if (app) await app.close(); await clean(data); });
  const exported = async () => (await fetch(app.url + '/api/p/shop/export')).json();
  app = await startServer({ data, port: 0 });
  const migrated = await exported();
  assert.equal(migrated.schemaVersion, 3); assert.equal(migrated.revision, 9);
  assert.equal(migrated.history[0].message, 'Previous decision'); assert.equal(migrated.history[1].actor, 'system');
  assert.equal(await readFile(join(dir, 'graph.v2.backup.json'), 'utf8'), oldText);
  await app.close(); app = null;
  app = await startServer({ data, port: 0 });
  assert.deepEqual(await exported(), migrated);
  await app.close(); app = null;
  const v1 = legacyMap(); v1.schemaVersion = 1; v1.nodes.forEach(n => n.codeRefs = [{ path: 'old.js' }]);
  await rm(dir, { recursive: true, force: true }); await handmade(data, { shop: JSON.stringify(v1) });
  app = await startServer({ data, port: 0 });
  const fromV1 = await exported();
  assert.equal(fromV1.schemaVersion, 3); assert.ok(fromV1.nodes.every(n => !('codeRefs' in n) && n.type === 'block' && n.parentId === null));
  assert.equal(await readFile(join(dir, 'graph.v1.backup.json'), 'utf8'), JSON.stringify(v1));
});
test('a hub lock left by a crashed hub is taken over, a live one is not', async t => {
  const data = await temp('mycel-stale-'), file = join(data, 'server.lock');
  let app;
  t.after(async () => { if (app) await app.close(); await clean(data); });
  const gone = spawn(process.execPath, ['-e', '']); await once(gone, 'exit');
  const lock = (pid, port, startedAt) => writeFile(file, JSON.stringify({ pid, port, data, startedAt }));
  const restart = async () => { if (app) await app.close(); app = null; app = await startServer({ data, port: 0 }); assert.ok(await alive(app.url)); };
  // The process is gone, both in the 0.10 format and in the older one (only the process number).
  await lock(gone.pid, 1, new Date().toISOString());
  await restart();
  const own = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual([own.pid, own.port, own.data], [process.pid, Number(new URL(app.url).port), app.data]);
  await app.close(); app = null;
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await writeFile(file, String(gone.pid));
  await restart(); await app.close(); app = null;
  // The process number is alive, but the lock is older than 10 seconds and no Mycel answers on its port: another program got the number.
  const port = await freePort();
  await lock(process.pid, port, new Date(Date.now() - 60000).toISOString());
  await restart(); await app.close(); app = null;
  // A fresh lock of a live process is not removed, nor is an old one if Mycel with this data answers on its port.
  await lock(process.pid, port, new Date().toISOString());
  await assert.rejects(startServer({ data, port: 0 }), new RegExp(`Mycel is already running: http://127\\.0\\.0\\.1:${port}`));
  await rm(file);
  app = await startServer({ data, port: 0 });
  const running = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...running, startedAt: new Date(Date.now() - 60000).toISOString() }));
  await assert.rejects(startServer({ data, port: 0 }), /Mycel is already running/);
});
// Before 0.15 the program was called Kontur (Контур) and kept its data in .kontur next to it. The folder is moved unless a hub holds it.
test('data of the former Kontur move from .kontur to .mycel unless its hub is running', async t => {
  const root = await temp('mycel-rename-'), legacy = join(root, '.kontur'), data = join(root, '.mycel');
  t.after(() => clean(root));
  assert.equal(defaultData(root), data);
  await mkdir(legacy); await writeFile(join(legacy, 'projects.json'), '{"projects":[]}');
  await writeFile(join(legacy, 'server.lock'), JSON.stringify({ pid: process.pid, port: 4317 }));
  assert.equal(defaultData(root), legacy, 'a hub of the old version is running');
  const gone = spawn(process.execPath, ['-e', '']); await once(gone, 'exit');
  await writeFile(join(legacy, 'server.lock'), JSON.stringify({ pid: gone.pid, port: 4317 }));
  assert.equal(defaultData(root), data);
  assert.equal(await readFile(join(data, 'projects.json'), 'utf8'), '{"projects":[]}');
  await assert.rejects(readdir(legacy), { code: 'ENOENT' });
  // If both folders exist, the data is in .mycel and .kontur is left alone.
  await mkdir(legacy);
  assert.equal(defaultData(root), data);
  assert.deepEqual(await readdir(legacy), []);
});
test('a stale hub lock is taken over by one hub only; the others name the port of that hub', async t => {
  const data = await temp('mycel-race-'), file = join(data, 'server.lock'), guard = `${file}.takeover`;
  t.after(() => clean(data));
  const gone = spawn(process.execPath, ['-e', '']); await once(gone, 'exit');
  const stale = () => writeFile(file, JSON.stringify({ pid: gone.pid, port: 1, data, startedAt: new Date().toISOString() }));
  // Hubs started at once after a crash: one removes the stale lock, the others see its lock, not the old one.
  for (let round = 0; round < 10; round++) {
    await stale();
    const results = await Promise.allSettled([47101, 47102, 47103].map(port => lockHub(data, port)));
    const won = results.filter(r => r.status === 'fulfilled'), { port } = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(won.length, 1, `round ${round}`);
    assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason.message), Array(2).fill(`Mycel is already running: http://127.0.0.1:${port}`));
    await won[0].value.release();
    await assert.rejects(readFile(file), { code: 'ENOENT' }); await assert.rejects(readFile(guard), { code: 'ENOENT' });
  }
  // A takeover file left by a crashed process does not stop the start.
  await stale(); await writeFile(guard, '');
  const old = new Date(Date.now() - 60000); await utimes(guard, old, old);
  const lock = await lockHub(data, 47104);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).port, 47104);
  await lock.release();
});
test('a project with a broken map is listed with its error, answers 503 and is never written', async t => {
  const data = await temp('mycel-invalid-'), folder = await temp('mycel-folder-');
  const broken = seed('invalid'); broken.nodes[0].w = 5;
  const text = JSON.stringify(broken);
  await handmade(data, { broken: text, empty: null });
  const app = await startServer({ data, port: 0 });
  t.after(async () => { await app.close(); await clean(data, folder); });
  const hub = client(app.url, await tokenOf(data));
  const listed = Object.fromEntries((await hub('/api/projects')).body.projects.map(p => [p.id, p]));
  assert.match(listed.broken.error, /Size/); assert.equal(listed.empty.error, 'The map file graph.json is missing.');
  assert.deepEqual([listed.broken.revision, listed.broken.blocks, listed.broken.exists, listed.broken.updatedAt], [null, 0, false, listed.broken.createdAt]);
  for (const route of ['', '/graph', '/context', '/events']) assert.equal((await fetch(`${app.url}/api/p/broken${route}`)).status, 503);
  const refused = await hub('/api/p/broken/changes', { expectedRevision: 0, actor: 'agent', message: 'x', operations: [] });
  assert.deepEqual(refused, { status: 503, body: { error: listed.broken.error } });
  assert.equal(await readFile(join(data, 'projects', 'broken', 'graph.json'), 'utf8'), text);
  await assert.rejects(readFile(join(data, 'projects', 'empty', 'graph.json')), { code: 'ENOENT' });
  // Other projects work.
  assert.equal((await hub('/api/projects', { path: folder })).body.created, true);
});
test('foreign browser origins and missing write credentials are refused; the agent guide is open to all', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/graph', null, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.hub('/api/session', null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.hub('/api/projects', null, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.call('/api/changes', { expectedRevision: 0 }, { Authorization: '' })).status, 401);
  assert.equal((await f.hub('/api/projects', { path: f.folder }, { Authorization: '' })).status, 401);
  assert.equal((await f.hub(`/api/projects/${f.project.id}/delete`, {}, { Authorization: '' })).status, 401);
  // Stopping: only with the token and only for a hub started from the command line.
  assert.equal((await f.hub('/api/stop', {}, { Authorization: '' })).status, 401);
  assert.equal((await f.hub('/api/stop', {})).status, 404);
  assert.equal(await hostStatus(f.url + '/graph'), 403);
  assert.equal(await hostStatus(f.app.url + '/agent'), 403);
  // The agent guide: text for any origin, with this computer's command and the hub address, without the token.
  const res = await fetch(f.app.url + '/agent', { headers: { Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site' } });
  const guide = await res.text(), slash = p => p.replace(/\\/g, '/');
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.ok(guide.includes(`"${slash(process.execPath)}" "${slash(join(import.meta.dirname, '..', 'mycel.mjs'))}" --url ${f.app.url}`));
  assert.ok(guide.includes(`curl.exe -s ${f.app.url}/agent`)); assert.ok(!guide.includes(f.token)); assert.doesNotMatch(guide, /\{\{/);
});
test('the hub reports itself; /api/stop calls onStop', async t => {
  let stopped = false;
  const f = await hubFixture(t, { onStop: () => { stopped = true; } });
  const { version } = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.equal(version, '0.22.0');
  assert.deepEqual((await f.hub('/api/health')).body, { ok: true, app: 'mycel', version, data: f.app.data });
  assert.equal(f.app.data, realpathSync.native(f.data));
  assert.deepEqual((await f.hub('/api/session')).body, { token: f.token, data: f.app.data, port: Number(new URL(f.app.url).port), platform: process.platform });
  assert.equal((await f.hub('/api/stop', {}, { Authorization: '' })).status, 401);
  assert.deepEqual(await f.hub('/api/stop', {}), { status: 200, body: { stopping: true } });
  await until(() => stopped);
});
test('projects are found or created by folder: same folder, subfolder, new, lookup with root', async t => {
  const f = await hubFixture(t), folder = await temp('mycel-folder-');
  t.after(() => clean(folder));
  const sub = join(folder, 'sub'), deep = join(sub, 'deep'), repo = join(folder, 'repo');
  await mkdir(deep, { recursive: true }); await mkdir(join(repo, 'src'), { recursive: true });
  const connect = body => f.hub('/api/projects', body);
  const first = (await connect({ path: folder })).body, id = slug(basename(folder));
  assert.equal(first.created, true);
  const { createdAt, updatedAt, ...rest } = first.project;
  assert.deepEqual(rest, { id, name: basename(realpathSync.native(folder)), path: realpathSync.native(folder), exists: true, revision: 0, blocks: 0, notes: 0, edges: 0, agents: [] });
  assert.equal(updatedAt, createdAt);
  const again = (await connect({ path: folder + sep })).body;
  assert.deepEqual([again.created, again.project.id], [false, id]);
  const inside = (await connect({ path: sub })).body;
  assert.deepEqual([inside.created, inside.ancestor, inside.project.id], [false, true, id]);
  const own = (await connect({ path: sub, new: true, name: ' Подпроект ' })).body;
  assert.deepEqual([own.created, own.project.id, own.project.name], [true, 'podproekt', 'Подпроект']);
  assert.deepEqual([(await connect({ path: sub, new: true })).body.project.id, (await connect({ path: sub })).body.created], ['podproekt', false]);
  assert.deepEqual((await f.hub('/api/projects')).body.projects.map(p => p.id), ['podproekt', id]);
  assert.deepEqual((await f.hub('/api/p/podproekt')).body.project.path, realpathSync.native(sub));
  // Lookup: the nearest project whose folder contains the path; with root, only a project inside root.
  const find = (path, root) => f.hub(`/api/projects?${new URLSearchParams({ path, ...(root ? { root } : {}) })}`);
  assert.equal((await find(deep)).body.project.id, 'podproekt');
  assert.equal((await find(join(repo, 'src'))).body.project.id, id);
  assert.deepEqual(await find(join(repo, 'src'), repo), { status: 404, body: { error: 'The folder is not connected to Mycel.' } });
  assert.equal((await find(deep, folder)).body.project.id, 'podproekt');
  assert.equal((await find(join(folder + '-other', 'x'))).status, 404);
  assert.equal((await find('relative')).status, 400);
});
test('connecting with root: a connected or deleted folder above a repository does not capture it, its own deletion does', async t => {
  const f = await hubFixture(t), work = await temp('mycel-work-');
  t.after(() => clean(work));
  const repo = join(work, 'repo'), other = join(work, 'other'), connect = body => f.hub('/api/projects', body);
  await mkdir(repo); await mkdir(other);
  const parent = (await connect({ path: work })).body.project;
  // A connected folder above: without root the repository falls into it, with root it is its own project.
  assert.equal((await connect({ path: repo })).body.ancestor, true);
  const own = (await connect({ path: repo, root: repo })).body;
  assert.deepEqual([own.created, own.ancestor, own.project.path], [true, undefined, realpathSync.native(repo)]);
  // A deleted folder above: without root, 409 "deleted"; with root, a new project.
  assert.equal((await f.hub(`/api/projects/${parent.id}/delete`, {})).status, 200);
  assert.deepEqual([(await connect({ path: other })).status, (await connect({ path: other, root: other })).body.created], [409, true]);
  // The repository itself was deleted: still 409.
  assert.equal((await f.hub(`/api/projects/${own.project.id}/delete`, {})).status, 200);
  const refused = await connect({ path: repo, root: repo });
  assert.deepEqual([refused.status, refused.body.deleted?.id], [409, own.project.id]);
  assert.deepEqual(await connect({ path: repo, root: 'relative' }), { status: 400, body: { error: 'Give the full path of the folder.' } });
});
test('refused and missing folders are not connected; names are checked', async t => {
  const f = await hubFixture(t), folder = await temp('mycel-folder-');
  t.after(() => clean(folder));
  await writeFile(join(folder, 'file.txt'), 'x');
  const connect = body => f.hub('/api/projects', body);
  for (const path of [homedir(), parse(tmpdir()).root, 'relative', 42]) assert.deepEqual(await connect({ path }), { status: 400, body: { error: typeof path === 'string' ? 'This is not a project folder.' : 'No such folder.' } });
  for (const path of [join(folder, 'missing'), join(folder, 'file.txt'), undefined]) assert.deepEqual(await connect({ path }), { status: 400, body: { error: 'No such folder.' } });
  for (const name of [' ', 'я'.repeat(101), 5]) assert.equal((await connect({ path: folder, name })).status, 400);
  assert.deepEqual((await f.hub('/api/projects')).body.projects, []);
  assert.equal((await f.hub('/api/projects', { path: folder, id: 'missing' })).status, 404);
});
test('folder paths match without case on Windows and macOS', { skip: !['win32', 'darwin'].includes(process.platform) }, async t => {
  const f = await hubFixture(t), folder = await temp('mycel-Case-');
  t.after(() => clean(folder));
  const created = (await f.hub('/api/projects', { path: folder.toLowerCase() })).body.project;
  assert.equal(created.path, realpathSync.native(folder));
  assert.deepEqual([(await f.hub('/api/projects', { path: folder.toUpperCase() })).body.created, created.name], [false, basename(realpathSync.native(folder))]);
  assert.equal((await f.hub(`/api/projects?${new URLSearchParams({ path: join(folder.toUpperCase(), 'SUB') })}`)).body.project.id, created.id);
});
test('a deleted project leaves routes, waiters and pages; its folder reports the deletion; restore brings the data back', async t => {
  const f = await fixture(t), other = await temp('mycel-other-');
  t.after(() => clean(other));
  await f.change(0, [add('kept')]);
  await f.call('/api/changes', { expectedRevision: 1, actor: 'human', message: 'Edit', operations: [{ type: 'update-node', id: 'kept', patch: { text: 'text' } }] });
  await f.call('/api/edits', {});
  await f.call('/api/cursor', { actor: 'tester', revision: 2, chat: 1 });
  const controller = new AbortController(); t.after(() => controller.abort());
  const next = events(await fetch(f.url + '/events', { signal: controller.signal }));
  assert.deepEqual(await next(), { revision: 2, edit: null, agents: [], activity: [], work: [], code: { stale: {}, risks: {} } });
  const waiting = f.call('/api/changes?since=2&exclude=tester&wait=10', null, { 'X-Mycel-Actor': 'tester' });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(await f.hub(`/api/projects/${f.project.id}/delete`, {}), { status: 200, body: { deleted: f.project.id } });
  // A waiting agent learns about the deletion only by repeating the request: while it was in progress, it could still fail.
  assert.deepEqual(await waiting, { status: 503, body: { error: 'The project is being deleted, repeat the request.', retry: true } });
  const last = [];
  for (let event; (event = await next()) !== null; ) if (!event.presence) last.push(event);
  assert.deepEqual(last, [{ deleted: true }]);
  const graph = await f.call('/api/graph');
  assert.deepEqual([graph.status, graph.body.deleted.id, graph.body.deleted.name], [404, f.project.id, f.project.name]);
  assert.equal(graph.body.error, `Project "${f.project.name}" was deleted by the person.`);
  assert.deepEqual((await f.hub('/api/projects')).body.projects, []);
  const trashed = join(f.data, 'trash', f.project.id);
  assert.equal(JSON.parse(await readFile(join(trashed, 'project.json'), 'utf8')).deletedAt, graph.body.deleted.deletedAt);
  await assert.rejects(readFile(join(f.dir, 'graph.json')), { code: 'ENOENT' });
  // The folder of a deleted project: lookup and connect report the deletion, --new creates a new project with another id.
  const found = await f.hub(`/api/projects?${new URLSearchParams({ path: join(f.folder, 'src') })}`);
  assert.deepEqual([found.status, found.body.deleted], [404, graph.body.deleted]);
  const refused = await f.hub('/api/projects', { path: f.folder });
  assert.deepEqual([refused.status, refused.body.deleted, refused.body.error], [409, graph.body.deleted, graph.body.error]);
  const fresh = (await f.hub('/api/projects', { path: f.folder, new: true })).body;
  assert.deepEqual([fresh.created, fresh.project.id], [true, `${f.project.id}-2`]);
  assert.deepEqual(await f.hub(`/api/projects/${f.project.id}/restore`, {}), { status: 409, body: { error: `The folder is already connected to project "${fresh.project.name}".` } });
  assert.equal((await f.hub(`/api/projects/${fresh.project.id}/delete`, {})).status, 200);
  // An id is unique among deleted projects too: both deleted ids are taken.
  assert.equal((await f.hub('/api/projects', { path: other, name: f.project.name })).body.project.id, `${f.project.id}-3`);
  const back = await f.hub(`/api/projects/${f.project.id}/restore`, {});
  assert.deepEqual([back.status, back.body.project.id, back.body.project.revision, back.body.project.blocks], [200, f.project.id, 2, 1]);
  assert.deepEqual((await f.call('/api/graph')).body.nodes.map(n => n.id), ['kept']);
  assert.deepEqual((await f.call('/api/chat')).body.messages.map(m => m.kind), ['edits']);
  assert.deepEqual((await f.call('/api/cursor?actor=tester')).body, { revision: 2, chat: 1 });
  assert.equal('deletedAt' in JSON.parse(await readFile(join(f.dir, 'project.json'), 'utf8')), false);
  assert.equal((await f.hub('/api/projects', { path: f.folder })).body.project.id, f.project.id);
  assert.equal((await f.hub(`/api/projects/${f.project.id}/restore`, {})).status, 404);
  assert.equal((await f.hub('/api/projects/missing/delete', {})).status, 404);
});
test('a project whose folder is busy is not deleted, keeps working, and nobody is told it was deleted', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), controller = new AbortController();
  t.after(() => controller.abort());
  const next = events(await fetch(f.url + '/events', { signal: controller.signal }));
  assert.deepEqual(await next(), { revision: 0, edit: null, agents: [], activity: [], work: [], code: { stale: {}, risks: {} } });
  const waiting = f.call('/api/changes?since=0&exclude=tester&wait=10', null, { 'X-Mycel-Actor': 'tester' });
  await new Promise(r => setTimeout(r, 100));
  // Windows does not rename a folder with an open file: this is how an antivirus or an editor holding the file behaves.
  const handle = await open(join(f.dir, 'chat.json'), 'r');
  let closed = false;
  t.after(() => closed || handle.close());
  // Until the deletion is settled, the waiting agent and new requests hear "repeat", not "deleted".
  const removing = f.hub(`/api/projects/${f.project.id}/delete`, {}), retry = { status: 503, body: { error: 'The project is being deleted, repeat the request.', retry: true } };
  assert.deepEqual(await waiting, retry);
  assert.deepEqual(await f.call('/api/graph'), retry);
  assert.deepEqual(await removing, { status: 409, body: { error: 'The project folder is busy, try again.' } });
  await handle.close(); closed = true;
  assert.equal((await f.change(0, [add('after')])).status, 200);
  // The project's open page did not get {deleted: true} and keeps seeing edits.
  let event; do event = await next(); while (event?.presence);
  assert.deepEqual([event.revision, event.edit, event.deleted], [1, null, undefined]);
  assert.deepEqual((await f.hub('/api/projects')).body.projects.map(p => [p.id, p.revision]), [[f.project.id, 1]]);
  assert.equal('deletedAt' in JSON.parse(await readFile(join(f.dir, 'project.json'), 'utf8')), false);
  assert.equal((await f.hub(`/api/projects/${f.project.id}/delete`, {})).status, 200);
});
test('a busy port is reported and leaves no lock; old trash is purged after a week', async t => {
  const data = await temp('mycel-purge-'), blocker = net.createServer();
  let app;
  t.after(async () => { blocker.close(); if (app) await app.close(); await clean(data); });
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  await assert.rejects(startServer({ data, port }), new RegExp(`^Error: Port ${port} is used by another program\\.$`));
  await assert.rejects(readFile(join(data, 'server.lock')), { code: 'ENOENT' });
  const trashed = async (id, deletedAt) => {
    const dir = join(data, 'trash', id); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'project.json'), JSON.stringify({ id, name: id, path: null, createdAt: '2026-01-01T00:00:00.000Z', ...(deletedAt ? { deletedAt } : {}) }));
  };
  await trashed('old', new Date(Date.now() - 8 * 24 * 3600e3).toISOString());
  await trashed('recent', new Date(Date.now() - 24 * 3600e3).toISOString());
  await trashed('undated', null);
  app = await startServer({ data, port: 0 });
  assert.deepEqual((await readdir(join(data, 'trash'))).sort(), ['recent', 'undated']);
  assert.equal((await fetch(app.url + '/api/p/old/graph')).status, 404);
  assert.equal((await (await fetch(app.url + '/api/p/recent/graph')).json()).deleted.id, 'recent');
});
test('a moved project folder is re-bound by id; a folder that still exists needs move', async t => {
  const f = await fixture(t), moved = `${f.folder}-moved`, other = await temp('mycel-other-');
  t.after(() => clean(moved, other));
  await f.change(0, [add('kept')]);
  const rebind = body => f.hub('/api/projects', { id: f.project.id, ...body });
  assert.deepEqual(await rebind({ path: other }), { status: 409, body: { error: `The project is connected to ${f.project.path}.` } });
  await rename(f.folder, moved);
  assert.equal((await f.hub('/api/projects')).body.projects[0].exists, false);
  const back = (await rebind({ path: moved })).body;
  assert.deepEqual([back.created, back.moved, back.project.path, back.project.exists, back.project.revision], [false, true, realpathSync.native(moved), true, 1]);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'project.json'), 'utf8')).path, back.project.path);
  assert.equal((await rebind({ path: moved })).body.moved, undefined);
  assert.deepEqual([(await rebind({ path: other, move: true })).body.moved, (await f.hub(`/api/p/${f.project.id}`)).body.project.path], [true, realpathSync.native(other)]);
  const second = (await f.hub('/api/projects', { path: moved })).body.project;
  assert.deepEqual(await rebind({ path: moved, move: true }), { status: 409, body: { error: `The folder is already connected to project "${second.name}".` } });
  const registry = JSON.parse(await readFile(join(f.data, 'projects.json'), 'utf8')).projects;
  assert.deepEqual(registry.map(p => [p.id, p.path]), [[f.project.id, realpathSync.native(other)], [second.id, realpathSync.native(moved)]]);
});
test('agent cursors only grow and are kept by the hub in the project data', async t => {
  const f = await fixture(t);
  const save = body => f.call('/api/cursor', { actor: 'codex agent', ...body }), read = () => f.call('/api/cursor?actor=codex%20agent');
  assert.deepEqual((await read()).body, { revision: null, chat: 0 });
  assert.deepEqual((await save({ revision: 5, chat: 2 })).body, { revision: 5, chat: 2 });
  assert.deepEqual((await save({ revision: 3 })).body, { revision: 5, chat: 2 });
  assert.deepEqual((await save({ revision: null, chat: 7 })).body, { revision: 5, chat: 7 });
  await Promise.all([save({ revision: 9 }), save({ revision: 12, chat: 1 }), save({ revision: 10 })]);
  assert.deepEqual((await read()).body, { revision: 12, chat: 7 });
  const file = JSON.parse(await readFile(join(f.dir, 'agents', 'codex_agent.json'), 'utf8'));
  assert.deepEqual([file.actor, file.revision, file.chat], ['codex agent', 12, 7]);
  assert.equal((await f.call('/api/cursor')).status, 400);
  assert.equal((await save({ revision: -1 })).status, 400);
  assert.equal((await f.call('/api/cursor', { revision: 1 })).status, 400);
});
test('the registry recovers from its backup and from project folders', async t => {
  const data = await temp('mycel-registry-'), a = await temp('mycel-a-'), b = await temp('mycel-b-');
  let app, hub;
  t.after(async () => { if (app) await app.close(); await clean(data, a, b); });
  const start = async () => { app = await startServer({ data, port: 0 }); hub = client(app.url, await tokenOf(data)); };
  const listed = async () => (await hub('/api/projects')).body.projects.map(p => [p.id, p.path]);
  await start();
  for (const path of [a, b]) await hub('/api/projects', { path });
  const expected = await listed();
  await mkdir(join(data, 'projects', '.new-leftover'));
  await app.close(); app = null;
  // A damaged registry: the previous copy plus projects from their folders.
  await writeFile(join(data, 'projects.json'), '{ broken');
  await start();
  assert.deepEqual(await listed(), expected);
  assert.equal(await readFile(join(data, 'projects.broken.json'), 'utf8'), '{ broken');
  await app.close(); app = null;
  // Both are damaged: the registry is rebuilt from projects/*/project.json.
  await writeFile(join(data, 'projects.json'), 'null'); await writeFile(join(data, 'projects.backup.json'), '');
  await start();
  assert.deepEqual(await listed(), expected);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'projects.json'), 'utf8')).projects.map(p => [p.id, p.path]).sort(), [...expected].sort());
  assert.ok((await readdir(join(data, 'projects'))).includes('.new-leftover'));
  await app.close(); app = null;
  // The deletion managed to move the folder to the trash but not to write the registry: the project counts as deleted.
  const [[gone]] = expected;
  await rename(join(data, 'projects', gone), join(data, 'trash', gone));
  await start();
  assert.deepEqual(await listed(), expected.slice(1));
  assert.equal((await hub(`/api/p/${gone}/graph`)).status, 404);
});
test('context lists blocks with text and links; unknown routes return 404', async t => {
  const f = await fixture(t);
  await f.change(0, [add('a', { title: 'Cart', text: 'Order contents' }), add('b', { title: 'Payment' }), link('l1', 'a', 'b', 'total'), link('l2', 'b', 'a'), note('n1', 'a', { text: 'Check the limit' }), note('n2', null, { text: 'A free note' }), add('inner', { parentId: 'a', title: 'Inside' }), note('n3', null, { parentId: 'a', text: 'A note in the sub-map' }),
    add('tech', { parentId: 'inner', title: 'Storage' }), add('step', { parentId: 'tech', title: 'Write' }), add('deeper', { parentId: 'step', title: 'Deeper' })]);
  const res = await fetch(f.url + '/context'); const text = await res.text();
  assert.equal(res.status, 200); assert.match(text, /^# Map\nRevision: 1\n/); assert.match(text, /### Cart\nID: a \| level: concept \| x: 0, y: 0, w: 220, h: 110\n\nOrder contents\n\nNote \(n1\): Check the limit\n\n#### Inside\nID: inner \| level: mechanics \| x: 0, y: 0, w: 220, h: 110 \| inside: a/); assert.match(text, /## Notes\n- \(n2\) A free note/);
  // Four levels: deeper than code is code too. Links have an id for update-edge and delete-edge.
  assert.deepEqual(['tech', 'step', 'deeper'].map(id => new RegExp(`ID: ${id} \\| level: ([a-z]+)`).exec(text)[1]), ['technical', 'code', 'code']);
  assert.match(text, /Concept \(blocks of the main map\) and Mechanics \(their sub-maps\) are for people who do not program/);
  assert.match(text, /^- Cart \(a\) → Payment \(b\): total · id: l1$/m); assert.match(text, /^- Payment \(b\) → Cart \(a\) · id: l2$/m);
  assert.match(text, /Notes inside "Cart" \(a\)\n- \(n3\) A note in the sub-map/);
  // Focus: only the block with what is nested and its links to the rest of the map; the person's focus is visible to the agent.
  const focused = await (await fetch(f.url + '/context?focus=a')).text();
  assert.match(focused, /### Cart/); assert.match(focused, /#### Inside/); assert.doesNotMatch(focused, /### Payment/);
  assert.match(focused, /## Links to the rest of the map\n- Cart \(a\) → Payment \(b\): total/);
  assert.equal((await f.call('/api/focus', { id: 'a' })).status, 200);
  assert.match(await (await fetch(f.url + '/context')).text(), /The person is focused on block "Cart" \(a\)/);
  assert.equal((await f.call('/api/focus', { id: 'missing' })).status, 400);
  assert.equal((await f.call('/api/context?focus=n2')).status, 400);
  for (const path of ['/unknown', '/api/unknown', `/api/p/${f.project.id}/unknown`, '/api/p/missing/graph', '/api/p/Bad_Id/graph', '/api/p/../graph']) assert.equal((await f.hub(path)).status, 404, path);
});
test('SSE publishes committed revisions and human edits for a second client', async t => {
  const f = await fixture(t); const controller = new AbortController();
  t.after(() => controller.abort());
  const next = events(await fetch(f.url + '/events', { signal: controller.signal }));
  assert.deepEqual(await next(), { revision: 0, edit: null, agents: [], activity: [], work: [], code: { stale: {}, risks: {} } });
  await f.change(0, [add('live')]);
  assert.deepEqual(await next(), { revision: 1, edit: null, agents: [], activity: [], work: [], code: { stale: {}, risks: {} } });
  await f.call('/api/changes', { expectedRevision: 1, actor: 'human', message: 'The person\'s edit', operations: [{ type: 'update-node', id: 'live', patch: { text: 'text' } }] });
  const started = await next();
  assert.deepEqual(started, { revision: 2, edit: { since: 1, at: started.edit.at, count: 1 }, agents: [], activity: [], work: [], code: { stale: {}, risks: {} } });
  await f.call('/api/edits', {});
  assert.deepEqual(await next(), { revision: 2, edit: null, agents: [], activity: [], work: [], code: { stale: {}, risks: {} } });
  controller.abort();
});
test('the hub event stream reports projects, their revisions and human events', async t => {
  const f = await fixture(t), other = await temp('mycel-other-'), controller = new AbortController();
  t.after(async () => { controller.abort(); await clean(other); });
  const next = events(await fetch(f.app.url + '/api/events', { signal: controller.signal }));
  assert.deepEqual(await next(), { projects: 1 });
  await f.hub('/api/projects', { path: other });
  assert.deepEqual(await next(), { projects: 2 });
  await f.change(0, [add('live')]);
  assert.deepEqual(await next(), { project: f.project.id, revision: 1 });
  await f.call('/api/changes', { expectedRevision: 1, actor: 'human', message: 'Edit', operations: [{ type: 'update-node', id: 'live', patch: { text: 'text' } }] });
  assert.deepEqual(await next(), { project: f.project.id, revision: 2 });
  await f.call('/api/edits', {});
  assert.deepEqual(await next(), { project: f.project.id, chat: 1 });
  await f.call('/api/graph', null, { 'X-Mycel-Actor': 'codex' });
  assert.deepEqual(await next(), { project: f.project.id, presence: true });
  await f.hub(`/api/projects/${f.project.id}/delete`, {});
  assert.deepEqual(await next(), { projects: 3 });
});

// A virtual machine goes to the address on its network: only with a key (Bearer or the cookie from the /?key=… link), the
// token is not handed out over the network; connecting a folder and opening access cannot be done from there. 127.0.0.2 is a second address instead of the VMware network.
test('a virtual machine reaches Mycel on its network address only with the key; the key link sets a cookie; host-only actions are refused', async t => {
  const data = await temp('mycel-remote-'), app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data); });
  const { version } = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  const req = (path, init = {}) => fetch(far + path, { redirect: 'manual', ...init });
  if (!(await req('/api/health').then(res => res.ok, () => false))) return t.skip('no second loopback address');
  assert.deepEqual(await (await req('/api/health')).json(), { ok: true, app: 'mycel', version });
  for (const path of ['/api/projects', '/api/session', '/', '/app.js']) assert.equal((await req(path)).status, 401, path);
  const bearer = { headers: { Authorization: `Bearer ${token}` } };
  assert.equal((await req('/api/projects', bearer)).status, 200);
  assert.deepEqual(Object.keys(await (await req('/api/health', bearer)).json()), ['ok', 'app', 'version', 'data']);
  assert.match(await (await req('/agent', bearer)).text(), /You are in a virtual machine, and Mycel runs on the main computer \(http:\/\/127\.0\.0\.2:\d+\)/);
  // The key in the link sets a cookie and leaves the address; with the cookie the page and the session open.
  assert.equal((await req('/?key=wrong')).status, 401);
  const link = await req(`/?key=${token}`);
  assert.deepEqual([link.status, link.headers.get('location')], [303, '/']);
  assert.match(link.headers.get('set-cookie'), /^mycel_key=[0-9a-f]+; HttpOnly; SameSite=Strict; Path=\//);
  const cookie = { headers: { cookie: link.headers.get('set-cookie').split(';')[0] } };
  assert.equal((await req('/', cookie)).status, 200);
  assert.equal((await (await req('/api/session', cookie)).json()).token, token);
  // A copy of Mycel for a virtual machine (the program, no key needed): an archive that plain tar unpacks, and the
  // unpacked mycel.mjs runs.
  const archive = await req('/download/mycel.tar.gz');
  assert.equal(archive.headers.get('content-type'), 'application/gzip');
  const copy = await temp('mycel-copy-');
  t.after(() => clean(copy));
  await writeFile(join(copy, 'mycel.tar.gz'), Buffer.from(await archive.arrayBuffer()));
  const untar = spawnSync('tar', ['xzf', 'mycel.tar.gz'], { cwd: copy, encoding: 'utf8' });
  if (untar.error) t.diagnostic('tar not found: unpacking not checked');
  else {
    assert.equal(untar.status, 0, untar.stderr);
    const help = spawnSync(process.execPath, [join(copy, 'mycel.mjs'), 'help'], { encoding: 'utf8' });
    assert.match(help.stdout, /^Mycel for agents: node mycel\.mjs <command>/);
    assert.ok((await readdir(join(copy, 'src'))).includes('agent-guide.md'));
  }
  // Connecting a folder, stopping Mycel and opening access cannot be done from a virtual machine.
  const post = (base, path, body) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(far, '/api/projects', { path: data })).status, 403);
  assert.equal((await post(far, '/api/remote', { addresses: [] })).status, 403);
  assert.equal((await req('/api/remote', bearer)).status, 403);
  // On the main computer: only addresses of its own adapters; closed access no longer answers.
  assert.equal((await post(app.url, '/api/remote', { addresses: ['8.8.8.8'] })).status, 400);
  assert.deepEqual((await (await fetch(`${app.url}/api/remote`)).json()).listening, [{ address: '127.0.0.2', listening: true }]);
  assert.equal((await post(app.url, '/api/remote', { addresses: [] })).status, 200);
  assert.equal(await req('/api/health').then(() => true, () => false), false);
  assert.deepEqual(JSON.parse(await readFile(join(app.data, 'listen.json'), 'utf8')), { addresses: [] });
});

// The agent in a virtual machine sets everything up itself: without a key it can reach the guide, the installer and the
// access request; the person allows the request with a button, the machine gets its key once (devices.json holds only a hash), a revoked key stops working.
test('a virtual machine asks for access without a key; the human approves it and the machine gets its own revocable key', async t => {
  const data = await temp('mycel-pair-'), app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('no second loopback address');
  const call = async (base, path, body, key = null) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text() };
  };
  // Without a key: the guide, the installer, a copy of Mycel and the access request; everything else is closed.
  assert.match((await call(far, '/agent')).body, new RegExp(`curl -fsS ${far.replace(/\./g, '\\.')}/install\\.sh \\| sh`));
  assert.match((await call(far, '/install.sh')).body, new RegExp(`^#!/bin/sh[\\s\\S]*HOST="${far.replace(/\./g, '\\.')}"[\\s\\S]*exec "\\$NODE" "\\$DIR/mycel\\.mjs" join "\\$HOST" "\\$@"`));
  assert.equal((await fetch(`${far}/download/mycel.tar.gz`)).status, 200);
  assert.equal((await call(far, '/api/projects')).status, 401);
  const project = (await call(app.url, '/api/projects', { path: data, name: 'Map' }, token)).body.project;
  const asked = (await call(far, '/api/pair', { name: 'ubuntu <vm>' })).body;
  assert.match(asked.code, /^\d{4}$/);
  assert.equal((await call(far, `/api/pair/${asked.id}?secret=wrong`)).status, 404);
  assert.deepEqual((await call(far, `/api/pair/${asked.id}?secret=${asked.secret}`)).body, { status: 'pending' });
  const access = (await call(app.url, '/api/access')).body;
  assert.deepEqual(access.pending.map(r => [r.id, r.code, r.name]), [[asked.id, asked.code, 'ubuntu vm']]);
  assert.deepEqual(access.projects, [{ id: project.id, name: 'Map' }]);
  // A request can only be answered from the main computer.
  assert.equal((await call(far, `/api/pair/${asked.id}/approve`, {}, token)).status, 403);
  assert.equal((await call(app.url, `/api/pair/${asked.id}/approve`, { project: 'nope' }, token)).status, 400);
  const approved = (await call(app.url, `/api/pair/${asked.id}/approve`, { project: project.id }, token)).body;
  assert.deepEqual([approved.pending, approved.devices.map(d => [d.name, d.project])], [[], [['ubuntu vm', project.id]]]);
  const answer = (await call(far, `/api/pair/${asked.id}?secret=${asked.secret}`)).body;
  assert.deepEqual([answer.status, answer.project, /^[0-9a-f]{64}$/.test(answer.key)], ['approved', project.id, true]);
  assert.equal((await call(far, `/api/pair/${asked.id}?secret=${asked.secret}`)).status, 404, 'the key is given out once');
  // The machine key works as a key, the session returns it rather than the main computer's token; the file holds only a hash.
  assert.equal((await call(far, '/api/projects', null, answer.key)).status, 200);
  assert.equal((await call(far, '/api/session', null, answer.key)).body.token, answer.key);
  assert.equal((await call(far, '/api/access', null, answer.key)).status, 403);
  const stored = await readFile(join(app.data, 'devices.json'), 'utf8');
  assert.ok(!stored.includes(answer.key) && !stored.includes(token));
  // A denied request and a revoked key.
  const second = (await call(far, '/api/pair', { name: 'other' })).body;
  assert.equal((await call(app.url, `/api/pair/${second.id}/deny`, {}, token)).status, 200);
  assert.deepEqual((await call(far, `/api/pair/${second.id}?secret=${second.secret}`)).body, { status: 'denied' });
  assert.equal((await call(app.url, `/api/devices/${approved.devices[0].id}/revoke`, {}, token)).status, 200);
  assert.equal((await call(far, '/api/projects', null, answer.key)).status, 401);
  assert.deepEqual((await call(app.url, '/api/access')).body.devices, []);
});

// A project for a virtual machine's folder: the machine creates it with its own key, the main computer does not check the
// folder; the project is marked with the machine, and its folders are compared only with its own projects.
test('a machine with its own key creates projects for its folders; they are marked with the machine and kept apart', async t => {
  const data = await temp('mycel-machine-'), app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('no second loopback address');
  const call = async (base, path, body, key = null) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const machine = async name => {
    const asked = (await call(far, '/api/pair', { name })).body;
    await call(app.url, `/api/pair/${asked.id}/approve`, {}, token);
    return (await call(far, `/api/pair/${asked.id}?secret=${asked.secret}`)).body.key;
  };
  const ubuntu = await machine('ubuntu');
  assert.equal((await call(far, '/api/projects', { path: '/home/user/hedwig', name: 'Hedwig' }, token)).status, 403, 'not with the main computer\'s token: it is unclear whose folder it is');
  for (const path of ['/', 'home/user', 'C:\\']) assert.equal((await call(far, '/api/projects', { path }, ubuntu)).status, 400, path);
  const made = (await call(far, '/api/projects', { path: '/home/user/hedwig/', name: 'Hedwig' }, ubuntu)).body;
  assert.equal(made.created, true);
  assert.deepEqual([made.project.path, made.project.exists, made.project.machine.name], ['/home/user/hedwig', null, 'ubuntu']);
  assert.deepEqual((await call(far, '/api/projects', { path: '/home/user/hedwig' }, ubuntu)).body.created, false);
  assert.equal((await call(far, `/api/projects?path=${encodeURIComponent('/home/user/hedwig/src')}`, null, ubuntu)).body.project.id, made.project.id);
  // The same folder on another machine and on the main computer is not this project.
  const debian = await machine('debian');
  assert.equal((await call(far, `/api/projects?path=${encodeURIComponent('/home/user/hedwig')}`, null, debian)).status, 404);
  assert.equal((await call(app.url, `/api/projects?path=${encodeURIComponent('/home/user/hedwig')}`)).status, 404);
  const other = (await call(far, '/api/projects', { path: '/home/user/hedwig', name: 'Hedwig' }, debian)).body.project;
  assert.notEqual(other.id, made.project.id);
  assert.equal((await call(far, '/api/projects', { path: '/srv/x', id: made.project.id, move: true }, debian)).status, 409, 'another machine\'s project is not moved');
  // Listed with the machine; the mark stays after a restart.
  assert.deepEqual((await call(app.url, '/api/projects')).body.projects.filter(p => p.machine).map(p => p.machine.name).sort(), ['debian', 'ubuntu']);
  await app.close();
  const again = await startServer({ data, port: 0 });
  t.after(() => again.close());
  assert.equal((await call(again.url, '/api/projects')).body.projects.find(p => p.id === made.project.id).machine.name, 'ubuntu');
});