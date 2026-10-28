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

// Хаб всегда на временном каталоге данных и свободном порту: настоящий .mycel и порт 4317 не трогаются.
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
// Хаб с одним проектом на временной папке; call() направляет /api/… в /api/p/<id>/….
async function fixture(t) {
  const h = await hubFixture(t), folder = await temp('mycel-folder-');
  t.after(() => clean(folder));
  const { project } = (await h.hub('/api/projects', { path: folder })).body;
  const call = (path, body, extra) => h.hub(path.replace(/^\/api\//, `/api/p/${project.id}/`), body, extra);
  const change = (revision, operations) => call('/api/changes', { expectedRevision: revision, actor: 'test-agent', message: 'Проверка поведения', operations });
  return { ...h, folder, project, dir: join(h.data, 'projects', project.id), url: `${h.app.url}/api/p/${project.id}`, call, change };
}
// Реестр и папки проектов, записанные вручную, как их оставила бы прежняя версия или сбой.
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
// События SSE по одному; комментарии keepalive пропускаются, null — поток закрыт.
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
const until = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await check()) return; assert.fail('Не дождались'); };
const alive = url => fetch(url + '/api/health').then(() => true, () => false);
const hostStatus = url => new Promise((resolve, reject) => { http.get(url, { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
const add = (id, extra = {}) => ({ type: 'add-node', node: { id, title: id, x: 0, y: 0, ...extra } });
const note = (id, attachedTo, extra = {}) => ({ type: 'add-node', node: { id, type: 'note', attachedTo, text: id, x: 0, y: 0, ...extra } });
const link = (id, source, target, label = '') => ({ type: 'add-edge', edge: { id, source, target, label } });

test('a rejected batch is atomic; geometry, colors and duplicate links are validated', () => {
  const graph = seed('test');
  assert.throws(() => applyOperations(graph, [add('a'), add('b'), link('l1', 'a', 'b'), link('l2', 'a', 'b')]), /уже есть/);
  assert.throws(() => applyOperations(graph, [add('start')]), /Узел с id «start» уже есть/);
  assert.equal(graph.nodes.length, 1);
  assert.throws(() => applyOperations(graph, [add('a', { w: 5 })]), /Размер/);
  assert.throws(() => applyOperations(graph, [add('a', { x: 'left' })]), /Координаты/);
  assert.throws(() => applyOperations(graph, [add('a', { color: 'pink' })]), /цвет/);
  assert.throws(() => applyOperations(graph, [add('a'), link('l1', 'a', 'missing')]), /существующих/);
  assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'start', patch: { status: 'done' } }]), /Отметка блока/);
  assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'start', patch: { proposed: 'add' } }]), /нельзя менять/);
  assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'start', patch: { attachedTo: 'start' } }]), /только заметку/);
  assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'start', patch: { parentId: 'start' } }]), /внутри самого себя/);
  const ok = applyOperations(graph, [add('a', { color: 'blue', w: 300, h: 80 }), add('b'), link('l1', 'a', 'b', 'ведёт к')]);
  assert.equal(ok.graph.nodes.length, 3); assert.equal(ok.graph.edges[0].label, 'ведёт к');
  assert.deepEqual(ok.changes, ['Добавлен блок «a»', 'Добавлен блок «b»', 'Добавлена связь «a» → «b»']);
  assert.throws(() => applyOperations(graph, [add('wide', { w: 50000 })]), /Размер узла «wide»/);
});
test('the level check finds code, files and names from code, and lets plain texts through', () => {
  const plain = ['Telegram', 'OpenAI', 'PDF', 'Node.js, Vue.js, Next.js и D3.js', 'ASP.NET Core', 'Ученик пишет вопрос', '«Бот думает» → «Приходит ответ» 🤔',
    'Ответ длиннее 4096 символов Telegram не примет', 'Знаки < и & в ответе, например «x < 5»', '"Кавычки", «ёлочки» и \'апострофы\'', 'Цена 1 000 ₽, скидка 3.5 %, версия 1.2.3, 27/10/2026',
    'TCP/IP, I/O, CI/CD, A/B, HTTP/2, 24/7, км/ч, и/или', 'iPhone, iOS, macOS, eBay, ChatGPT, GPT-4o, YouTube, WhatsApp', 'Android/iOS и Windows/macOS', 'Команды /start и /help, кроме команд с «/»',
    'т. е., e.g., 10 a.m.', 'Сайт openai.com', 'e-mail и SMS', 'Ученик пишет боту @study_buddy_bot в Telegram', 'Команда /set_language меняет язык',
    'Ссылки t.me, youtu.be, socket.io, Booking.com, Mail.ru, character.ai', 'Фото photo.jpg и отчёт report.pdf', 'Yandex.Music, Socket.IO, U.S., Ph.D', 'Почта user@example.com',
    'ИИ (GPT-4o), Бот (Telegram), ответ(ы), e-mail(ы), GPT-4o(mini)', 'PlayStation, PowerPoint, GitHub, LinkedIn, PayPal, ServiceNow, Service и Handler', 'Node.js/Express', 'Ответ… и дальше'];
  for (const text of plain) assert.deepEqual(codeFragments(text), [], text);
  const code = [['`render()`', 'код в обратных кавычках'], ['handle_message', 'имя из кода'], ['BOT_TOKEN', 'имя из кода'], ['getResponse', 'имя из кода'], ['onClick', 'имя из кода'],
    ['get_response()', 'вызов функции'], ['send()', 'вызов функции'], ['ai_service.get_response()', 'вызов функции'], ['bot/handlers.py', 'файл или путь'], ['src/pay', 'файл или путь'],
    ['C:\\Users\\bot', 'файл или путь'], ['/api/p/mycel', 'файл или путь'], ['https://api.telegram.org/bot', 'файл или путь'], ['handlers.py', 'файл'], ['.env', 'файл'], ['.gitignore', 'файл'],
    ['package.json', 'файл'], ['README.md', 'файл'], ['Отчёт.txt', 'файл'], ['main.c', 'файл'], ['Dockerfile', 'файл'],
    // Файл кода после пути с заглавными папками (C#, Unity, Swift, React) и путь от корня.
    ['Controllers/HomeController.cs', 'файл или путь'], ['UI/Button.tsx', 'файл или путь'], ['Assets/Scripts/PlayerController.cs', 'файл или путь'],
    ['Sources/App/ContentView.swift', 'файл или путь'], ['Models/User.cs', 'файл или путь'], ['/main.py', 'файл или путь'],
    // Вызовы с аргументами.
    ['send(message)', 'вызов функции'], ['ask(question)', 'вызов функции'], ['openai.chat.completions.create(model)', 'вызов функции'],
    ['message.text.startswith("/")', 'вызов функции'], ['create(...)', 'вызов функции'],
    // Имена через точку и классы.
    ['message.text', 'имя из кода'], ['bot.handlers', 'имя из кода'], ['os.getenv', 'имя из кода'], ['settings.DEBUG', 'имя из кода'], ['JSON.parse', 'имя из кода'],
    ['ChatCompletion.create', 'имя из кода'], ['message.from_user.id', 'имя из кода'], ['MessageHandler', 'имя из кода'], ['AIService', 'имя из кода'], ['CartService', 'имя из кода'],
    ['OpenAIClient', 'имя из кода'], ['UserRepository', 'имя из кода'], ['AsyncOpenAI', 'имя из кода'], ['TypeError', 'имя из кода']];
  for (const [fragment, what] of code) assert.deepEqual(codeFragments(`Здесь ${fragment}, и всё.`), [[what, fragment]], fragment);
  // Путь в кавычках или перед многоточием, декоратор.
  for (const text of ['Разбор в bot/handlers.py… и дальше', '«bot/handlers.py»…', '“bot/handlers.py”', '„bot/handlers.py“']) assert.deepEqual(codeFragments(text), [['файл или путь', 'bot/handlers.py']], text);
  assert.deepEqual(codeFragments('Папка/main.py'), [['файл', 'main.py']]);
  assert.deepEqual(codeFragments('Ловит @router.message'), [['имя из кода', 'router.message']]);
  // Карта: концепция c, механика m, техника t; старый текст с кодом на концепции не проверяется.
  const graph = applyOperations(seed('t'), [add('c', { title: 'Бот', text: 'Отвечает ученикам' }), add('old', { text: 'Ключ BOT_TOKEN' }), add('m', { parentId: 'c', title: 'Приём вопроса' }),
    add('t', { parentId: 'm', title: 'Обработчик' }), link('l1', 'c', 'old', 'вопрос')]).graph;
  const problems = levelProblems(graph, [
    add('m2', { parentId: 'c', title: 'Клиент `OpenAI`', text: 'x'.repeat(201) }), add('t2', { parentId: 'm', title: 'Ответ', text: '`get_response()` в `ai_service.py`' }),
    note('n1', 'c', { text: 'Читает BOT_TOKEN из .env' }), { type: 'add-node', node: { parentId: 'c', title: 'Без id: getResponse' } }, { type: 'add-node', node: { parentId: 't', title: 'Без id: getResponse' } },
    { type: 'update-node', id: 'c', patch: { title: 'Бот на `aiogram`', color: 'blue' } }, { type: 'update-node', id: 'old', patch: { color: 'red' } }, { type: 'update-node', id: 't', patch: { text: '`bot/handlers.py`' } },
    { type: 'update-node', id: 't2', patch: { parentId: 'c', text: 'Читает handle_message' } }, link('l2', 'c', 'm', 'OPENAI_API_KEY'), link('l3', 'm', 't', 'BOT_TOKEN'),
    { type: 'update-edge', id: 'l1', patch: { label: 'send()' } }]);
  // t2 добавлен на технику и тем же пакетом перенесён на механику: проверяется его итоговый текст, не первый.
  assert.deepEqual(problems.map(p => [p.what, p.name, p.level, p.field, p.problems.map(([what]) => what)]), [
    ['block', 'Клиент `OpenAI`', 'механика', 'название', ['код в обратных кавычках']], ['block', 'Клиент `OpenAI`', 'механика', 'текст', ['длиннее 200 символов']],
    ['block', 'Ответ', 'механика', 'текст', ['имя из кода']], ['note', 'Читает BOT_TOKEN из .env', 'концепция', 'текст', ['файл', 'имя из кода']],
    ['block', 'Без id: getResponse', 'механика', 'название', ['имя из кода']], ['block', 'Бот', 'концепция', 'название', ['код в обратных кавычках']],
    ['edge', 'Бот» → «Приём вопроса', 'механика', 'подпись', ['имя из кода']], ['edge', 'Бот» → «old', 'концепция', 'подпись', ['вызов функции']]]);
  const report = levelReport(problems).split('\n');
  assert.equal(report[0], 'Запись отклонена, ничего не записано:');
  assert.equal(report[2], '- блок «Клиент `OpenAI`» (механика), текст: длиннее 200 символов (201)');
  assert.equal(report[7], '- связь «Бот» → «Приём вопроса» (механика), подпись: имя из кода «OPENAI_API_KEY»');
  assert.equal(report.at(-1), 'Уровни «Концепция» и «Механика» читают люди без программирования: код, файлы и имена переменных — в подкарту, на уровень «Техника»; исправь файл и повтори.');
  assert.deepEqual(levelProblems(graph, [add('ok', { parentId: 'c', title: 'Ученик пишет вопрос', text: 'Бот отвечает в Telegram 🤔' }), link('l4', 'c', 'ok', 'вопрос')]), []);
  // Заметки, прикреплённые к перенесённому блоку, уходят с ним на новый уровень, как в applyOperations.
  const notes = applyOperations(graph, [add('m3', { parentId: 'c', title: 'Ответ' }), note('mn', 'm3', { parentId: 'c', text: 'Если прислать фото, бот молчит' }),
    add('t3', { parentId: 'm', title: 'Чтение ключей' }), note('tn', 't3', { parentId: 'm', text: 'Ключи в файле' })]).graph;
  const down = [{ type: 'update-node', id: 'm3', patch: { parentId: 'm' } }, { type: 'update-node', id: 'mn', patch: { text: 'Падает на `message.text`' } }];
  const up = [note('tn2', 't3', { parentId: 'm', text: 'Ключ `OPENAI_API_KEY`' }), { type: 'update-node', id: 'tn', patch: { text: 'Читает BOT_TOKEN из `.env`' } },
    { type: 'update-node', id: 't3', patch: { parentId: 'c' } }];
  const parentAfter = (ops, id) => applyOperations(notes, ops).graph.nodes.find(n => n.id === id).parentId;
  assert.deepEqual([parentAfter(down, 'mn'), parentAfter(up, 'tn'), parentAfter(up, 'tn2')], ['m', 'c', 'c']);
  assert.deepEqual(levelProblems(notes, down), []);
  assert.deepEqual(levelProblems(notes, up).map(p => [p.what, p.name, p.level, p.field]), [['note', 'Ключ `OPENAI_API_KEY`', 'механика', 'текст'], ['note', 'Ключи в файле', 'механика', 'текст']]);
});
test('deleting a block removes its links; moving and resizing are recorded distinctly', () => {
  const { graph } = applyOperations(seed('test'), [add('a'), add('b'), add('c'), link('l1', 'a', 'b'), link('l2', 'c', 'a')]);
  const removed = applyOperations(graph, [{ type: 'delete-node', id: 'a' }]);
  assert.deepEqual(removed.graph.nodes.map(n => n.id), ['start', 'b', 'c']); assert.equal(removed.graph.edges.length, 0);
  const moved = applyOperations(graph, [{ type: 'update-node', id: 'a', patch: { x: 10, y: 20 } }, { type: 'update-node', id: 'b', patch: { w: 200, h: 100 } }, { type: 'update-node', id: 'c', patch: { text: 'заметка' } }]);
  assert.deepEqual(moved.changes, ['Перемещён блок «a»', 'Изменён размер: блок «b»', 'Изменён блок «c»']);
});
// Файлы и команда проверки — только у блоков; пути от корня проекта через «/». Тот же список файлов — не правка.
test('files and a test command belong to blocks; a file finds its blocks, also through a folder', () => {
  const { graph } = applyOperations(seed('test'), [add('a', { files: ['src\\Server.mjs', './lib/', 'src\\Server.mjs'], test: 'npm test' }), add('b')]);
  assert.deepEqual([graph.nodes[1].files, graph.nodes[1].test], [['src/Server.mjs', 'lib/'], 'npm test']);
  for (const [patch, error] of [[{ files: ['/etc/passwd'] }, /Файлы блока «b»/], [{ files: ['C:/x.js'] }, /Файлы блока «b»/], [{ files: ['../x.js'] }, /Файлы блока «b»/], [{ files: 'a.js' }, /Файлы блока «b»/], [{ test: 5 }, /Проверка блока «b»/]]) {
    assert.throws(() => applyOperations(graph, [{ type: 'update-node', id: 'b', patch }]), error);
  }
  assert.throws(() => applyOperations(graph, [{ type: 'add-node', node: { id: 'n', type: 'note', files: ['a.js'] } }]), /и только у блока/);
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  assert.deepEqual(blocksOfFile(graph, 'lib/deep/x.js').map(n => n.id), ['a']);
  assert.deepEqual(blocksOfFile(graph, 'src/server.mjs').map(n => n.id), fold ? ['a'] : []);
  assert.deepEqual(blocksOfFile(graph, 'library.js'), []);
  // Перемещение блока не меняет его файлов в истории, пустой список и пустая команда снимают поля.
  const moved = applyOperations(graph, [{ type: 'update-node', id: 'a', patch: { x: 50 } }]).graph;
  assert.deepEqual(diffGraphs(graph, moved).nodes.updated, { a: ['x'] });
  const cleared = applyOperations(graph, [{ type: 'update-node', id: 'a', patch: { files: [], test: '' } }]);
  assert.deepEqual([cleared.graph.nodes[1].files, cleared.graph.nodes[1].test, cleared.changes], [undefined, undefined, ['Обновлены файлы и проверка блока «a»']]);
});
test('notes attach only to blocks, move with them and vanish with them', () => {
  const base = applyOperations(seed('test'), [add('a', { x: 100, y: 100 }), add('b'), note('n1', 'a', { x: 280, y: 60 })]).graph;
  assert.throws(() => applyOperations(base, [note('n2', 'n1')]), /существующему блоку/);
  assert.throws(() => applyOperations(base, [note('n2', 'missing')]), /существующему блоку/);
  assert.throws(() => applyOperations(base, [add('inner', { parentId: 'a' }), note('n2', 'inner')]), /своего уровня/);
  assert.throws(() => applyOperations(base, [{ type: 'add-edge', edge: { source: 'a', target: 'n1' } }]), /только блоки/);
  const moved = applyOperations(base, [{ type: 'update-node', id: 'a', patch: { x: 150, y: 80 } }]);
  assert.deepEqual([moved.graph.nodes.find(n => n.id === 'n1').x, moved.graph.nodes.find(n => n.id === 'n1').y], [330, 40]);
  const detached = applyOperations(base, [{ type: 'update-node', id: 'n1', patch: { attachedTo: null } }]);
  assert.deepEqual(detached.changes, ['Откреплена заметка «n1»']);
  assert.deepEqual(applyOperations(base, [{ type: 'update-node', id: 'n1', patch: { x: 5, y: 5, attachedTo: 'b' } }]).changes, ['Прикреплена заметка «n1»']);
  assert.throws(() => applyOperations(base, [{ type: 'update-node', id: 'a', patch: { attachedTo: 'b' } }]), /только заметку/);
  const removed = applyOperations(base, [{ type: 'delete-node', id: 'a' }]);
  assert.deepEqual(removed.graph.nodes.map(n => n.id), ['start', 'b']);
  assert.deepEqual(removed.changes, ['Удалён блок «a» (заметок: 1)']);
  const long = applyOperations(base, [{ type: 'add-node', node: { type: 'note', text: 'Проверить лимит на оплату картой для новых покупателей' } }]);
  assert.deepEqual(long.changes, ['Добавлена заметка «Проверить лимит на оплату картой для…»']);
  const fresh = applyOperations(seed('test'), [{ type: 'add-node', node: { id: 'n', type: 'note', text: 'hi', x: 0, y: 0 } }]).graph.nodes[1];
  assert.deepEqual(fresh, { id: 'n', type: 'note', parentId: null, attachedTo: null, collapsed: false, title: '', text: 'hi', x: 0, y: 0, w: 160, h: 120, color: 'yellow' });
});
test('sub-maps: nested levels, no cycles, limited depth, subtree deletion, collapsing', () => {
  const base = applyOperations(seed('test'), [add('a'), add('b', { parentId: 'a', x: 10, y: 10 }), add('c', { parentId: 'b' }), add('d'), note('n1', 'b', { parentId: 'a' }), link('l1', 'c', 'd', 'наружу')]).graph;
  assert.equal(base.nodes.find(n => n.id === 'n1').parentId, 'a');
  assert.throws(() => applyOperations(base, [{ type: 'update-node', id: 'a', patch: { parentId: 'c' } }]), /внутри самого себя/);
  // И когда тот же пакет сворачивает подкарту или двигает блок: раскладка не начинается по карте с циклом.
  const cyclic = [{ type: 'update-node', id: 'a', patch: { parentId: 'c' } }];
  for (const more of [{ type: 'update-node', id: 'b', patch: { collapsed: true } }, { type: 'update-node', id: 'c', patch: { x: 900, y: 900 } }, { type: 'update-node', id: 'b', patch: { collapsed: true, color: 'red' } }])
    assert.throws(() => applyOperations(base, [...cyclic, more, { type: 'update-node', id: 'd', patch: { collapsed: false } }]), e => e instanceof Problem && e.status === 400 && /внутри самого себя/.test(e.message));
  assert.throws(() => applyOperations(base, [add('x', { parentId: 'missing' })]), /существующим блоком/);
  assert.throws(() => applyOperations(base, [add('x', { parentId: 'n1' })]), /существующим блоком/);
  assert.throws(() => applyOperations(base, [add('y', { parentId: 'x' }), add('x', { parentId: 'missing' })]), /существующим блоком/);
  const at = (graph, id) => graph.nodes.find(n => n.id === id);
  const same = applyOperations(base, [{ type: 'update-node', id: 'b', patch: { parentId: 'a', x: 30, y: 20 } }]).graph;
  assert.deepEqual([at(same, 'n1').x, at(same, 'n1').y], [20, 10]);
  const carried = applyOperations(base, [{ type: 'update-node', id: 'b', patch: { parentId: null, x: 400, y: 0 } }]);
  assert.deepEqual(carried.changes, ['Перенесён блок «b»']);
  assert.deepEqual([at(carried.graph, 'n1').parentId, at(carried.graph, 'n1').x, at(carried.graph, 'n1').y], [null, 390, -10]);
  const folded = applyOperations(base, [{ type: 'update-node', id: 'a', patch: { collapsed: true } }]);
  assert.deepEqual(folded.changes, ['Свёрнута подкарта «a»']); assert.equal(folded.graph.nodes.find(n => n.id === 'a').collapsed, true);
  const moved = applyOperations(base, [{ type: 'update-node', id: 'c', patch: { parentId: null, x: 500, y: 0 } }]);
  assert.deepEqual(moved.changes, ['Перенесён блок «c»']); assert.equal(moved.graph.nodes.find(n => n.id === 'c').parentId, null);
  const removed = applyOperations(base, [{ type: 'delete-node', id: 'a' }]);
  assert.deepEqual(removed.graph.nodes.map(n => n.id), ['start', 'd']); assert.equal(removed.graph.edges.length, 0);
  assert.deepEqual(removed.changes, ['Удалён блок «a» (вложенных узлов: 3)']);
  const chain = Array.from({ length: 10 }, (_, i) => add(`l${i}`, { parentId: i ? `l${i - 1}` : null }));
  assert.equal(applyOperations(seed('test'), chain.slice(0, 8)).graph.nodes.length, 9);
  assert.throws(() => applyOperations(seed('test'), chain), /Вложенность/);
});
test('a batch that makes a parent cycle and deletes a block inside it is refused instead of hanging', async () => {
  // Удаление считало вложенное обходом предков, и по циклу обход не кончался: хаб переставал отвечать на всё.
  // Пакет идёт в отдельном потоке, чтобы зависание не остановило прогон.
  const graph = applyOperations(seed('test'), [add('a'), add('b'), add('x', { parentId: 'a', x: 24, y: 24 })]).graph;
  const operations = [{ type: 'update-node', id: 'a', patch: { parentId: 'b' } }, { type: 'update-node', id: 'b', patch: { parentId: 'a' } }, { type: 'delete-node', id: 'x' }];
  const code = `const { parentPort, workerData } = require('node:worker_threads');
import(workerData.url).then(({ applyOperations }) => { try { applyOperations(workerData.graph, workerData.operations); parentPort.postMessage('принят'); } catch (e) { parentPort.postMessage(e.status + ' ' + e.message); } });`;
  const worker = new Worker(code, { eval: true, workerData: { url: new URL('../src/model.mjs', import.meta.url).href, graph, operations } });
  let timer;
  try {
    const answer = await Promise.race([once(worker, 'message').then(([m]) => m), new Promise(resolve => { timer = setTimeout(resolve, 5000, 'нет ответа за 5 с'); })]);
    assert.equal(answer, '400 Блок не может лежать внутри самого себя.');
  } finally { clearTimeout(timer); await worker.terminate(); }
});
test('nodes without coordinates are laid out: columns follow links, sub-maps fit their content', () => {
  const at = (graph, id) => graph.nodes.find(n => n.id === id);
  const auto = (id, extra = {}) => ({ type: 'add-node', node: { id, title: id, ...extra } });
  const { graph } = applyOperations(seed('test'), [auto('ui'), auto('api', { text: 'Чтение и изменения карты' }), auto('store'), auto('srv'), auto('m1', { parentId: 'srv' }), auto('m2', { parentId: 'srv' }),
    { type: 'add-node', node: { id: 'n1', type: 'note', attachedTo: 'api', text: 'Заметка' } }, link('e1', 'ui', 'api'), link('e2', 'api', 'store'), link('e3', 'm1', 'm2')]);
  const [start, ui, api, store, srv, m1, m2, n1] = ['start', 'ui', 'api', 'store', 'srv', 'm1', 'm2', 'n1'].map(id => at(graph, id));
  assert.deepEqual([start.x, start.y], [0, 0]);
  assert.ok(ui.x > start.x + start.w && api.x > ui.x + ui.w && store.x > n1.x + n1.w, 'источник связи левее цели, новое — правее старого');
  assert.deepEqual([n1.x, n1.y], [api.x + api.w + 16, api.y]);
  assert.deepEqual([m1.x, m1.y], [24, 24]); assert.ok(m2.x > m1.x + m1.w);
  assert.ok(srv.w >= m2.x + m2.w + 26 && srv.h >= 36 + m1.y + m1.h + 14, 'контейнер вмещает подкарту');
  assert.ok(api.h > ui.h && api.w === 240, 'высота подобрана под текст');
  const nodes = graph.nodes.filter(n => n.parentId === null);
  for (const a of nodes) for (const b of nodes) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} и ${b.id} не перекрываются`);
});
test('layout tidies a level: links into sub-maps count for their container, sources come first', () => {
  // Всё свалено в кучу; ui ведёт во вложенный api, а из вложенного core идёт связь в db.
  const base = applyOperations(seed('test'), [add('db', { x: 0, y: 0 }), add('srv', { x: 0, y: 0 }), add('ui', { x: 0, y: 0 }), add('api', { parentId: 'srv', x: 500, y: 500 }), add('core', { parentId: 'srv', x: 0, y: 0 }),
    link('l1', 'ui', 'api'), link('l2', 'core', 'db'), link('l3', 'api', 'core'), link('l4', 'start', 'ui'),
    add('s1', { parentId: 'api', x: 0, y: 0 }), add('s2', { parentId: 'api', x: 0, y: 0 }), link('l5', 's1', 's2'),
    add('k1', { parentId: 's1', x: 0, y: 0 }), add('k2', { parentId: 's1', x: 0, y: 0 }), link('l6', 'k1', 'k2')]).graph;
  const { graph, changes } = applyOperations(base, [{ type: 'layout', deep: true }]);
  const at = id => graph.nodes.find(n => n.id === id), right = id => at(id).x + at(id).w;
  assert.deepEqual(changes, ['Упорядочена карта вместе с подкартами']);
  assert.ok(right('start') < at('ui').x && right('ui') < at('srv').x && right('srv') < at('db').x, 'start → ui → srv → db слева направо');
  assert.deepEqual([at('api').x, at('api').y], [24, 24]); assert.ok(at('core').x > right('api'));
  // Внешняя подкарта растёт после раскладки своего уровня, а не под прежнюю кучу вложенного: ровно содержимое и запас 24 px.
  const fitted = measure(graph).content(at('srv'), 24);
  assert.deepEqual([at('srv').w, at('srv').h], [fitted.w, fitted.h], 'подкарта сжата под новое содержимое');
  assert.ok(at('s2').x > right('s1'), 'техника — слева направо');
  assert.ok(at('k2').y > at('k1').y + at('k1').h && at('k2').x === at('k1').x, 'на уровне кода шаги идут сверху вниз');
  assert.throws(() => applyOperations(base, [{ type: 'layout', parentId: 'missing' }]), /Упорядочить/);
  // Встречные связи (цикл) не ломают раскладку.
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
  await f.change(0, [add('a', { text: 'старый' }), add('b'), link('l1', 'a', 'b')]);
  const human = (revision, operations) => f.call('/api/changes', { expectedRevision: revision, actor: 'human', message: 'Правка человека', operations });
  await human(1, [{ type: 'update-node', id: 'a', patch: { text: 'новый' } }, add('c'), { type: 'delete-edge', id: 'l1' }]);
  const seen = (await f.call('/api/changes?since=1&exclude=test-agent')).body;
  assert.equal(seen.revision, 2); assert.equal(seen.complete, true); assert.deepEqual(seen.entries.map(e => e.actor), ['human']);
  assert.deepEqual(seen.nodes.updated.map(n => [n.id, n.text, n.fields]), [['a', 'новый', ['text']]]);
  assert.deepEqual(seen.nodes.added.map(n => n.id), ['c']); assert.deepEqual(seen.edges.removed, [{ id: 'l1', source: 'a', target: 'b', label: '' }]);
  assert.deepEqual((await f.call('/api/changes?since=0&exclude=human')).body.nodes.added.map(n => n.id), ['a', 'b']);
  assert.equal((await f.call('/api/changes?since=99')).body.complete, false);
  assert.equal((await f.call('/api/changes')).status, 400);
  // Собственная правка агента не будит его ожидание, законченная правка человека — будит.
  await f.call('/api/edits', {});
  const started = Date.now();
  const waiting = f.call('/api/changes?since=2&exclude=test-agent&wait=10');
  await f.change(2, [add('own')]);
  await human(3, [{ type: 'update-node', id: 'b', patch: { title: 'Переименован' } }]);
  await f.call('/api/edits', {});
  const woke = (await waiting).body;
  assert.ok(Date.now() - started < 5000); assert.deepEqual(woke.entries.map(e => e.revision), [4]);
  assert.deepEqual(woke.nodes.updated.map(n => [n.id, n.title]), [['b', 'Переименован']]);
  const idle = await f.call('/api/changes?since=4&wait=0.2');
  assert.deepEqual([idle.status, idle.body.entries.length], [200, 0]);
  // content=1: перемещение и сворачивание не будят, правка текста будит и приносит накопленное вместе с собой.
  const contentOnly = f.call('/api/changes?since=4&exclude=test-agent&wait=10&content=1');
  await human(4, [{ type: 'update-node', id: 'a', patch: { x: 300, y: 40 } }]);
  await human(5, [{ type: 'update-node', id: 'b', patch: { w: 260 } }]);
  assert.equal((await f.call('/api/changes?since=4')).body.contentChanged, false);
  await human(6, [{ type: 'update-node', id: 'c', patch: { text: 'содержимое' } }]);
  await f.call('/api/edits', {});
  const content = (await contentOnly).body;
  // Перемещение и размер подряд от человека — одна запись истории (ревизия 6), правка текста — своя.
  assert.equal(content.contentChanged, true); assert.deepEqual(content.entries.map(e => e.revision), [6, 7]);
  assert.deepEqual(content.entries[0].changes, ['Перемещён блок «a»', 'Изменён размер: блок «Переименован»']);
  assert.deepEqual(content.nodes.updated.map(n => [n.id, n.fields]), [['a', ['x', 'y']], ['b', ['w']], ['c', ['text']]]);
  assert.deepEqual((await f.call('/api/changes?since=5')).body.nodes.updated.map(n => n.id), ['a', 'b', 'c']);
});
test('no chat: an agent says what it is doing, shows a block and reads what the human selected; the human cannot be written to', async t => {
  const f = await fixture(t);
  await f.change(0, [add('a', { title: 'Корзина' }), note('n', 'a', { text: 'Скидка пропадает' })]);
  const controller = new AbortController(); t.after(() => controller.abort());
  const next = events(await fetch(f.url + '/events', { signal: controller.signal }));
  assert.deepEqual(await next(), { revision: 1, edit: null, agents: [], activity: [], work: [], code: { stale: {}, risks: {} } });
  // Ожидание агента видно точкой: он на связи.
  const waiting = f.call('/api/changes?since=1&exclude=claude&wait=10&content=1&chat=0', null, { 'X-Mycel-Actor': 'claude' });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual((await f.hub(`/api/p/${f.project.id}`)).body.project.agents.map(a => [a.actor, a.waiting]), [['claude', true]]);
  let event; do event = await next(); while (!event.agents.some(a => a.waiting));
  assert.deepEqual(event.agents.map(a => [a.actor, a.waiting]), [['claude', true]]);
  // Что агент делает сейчас — строка под картой; null снимает её.
  assert.equal((await f.call('/api/activity', { actor: 'claude', text: 'читаю `server.mjs`', progress: 40 })).status, 200);
  event = await next();
  assert.deepEqual(event.activity.map(a => [a.actor, a.text, a.progress]), [['claude', 'читаю `server.mjs`', 40]]);
  for (const bad of [{ actor: 'claude', text: '' }, { actor: 'human', text: 'x' }, { actor: 'claude', text: 'x', progress: 150 }]) assert.equal((await f.call('/api/activity', bad)).status, 400);
  await f.call('/api/activity', { actor: 'claude', text: null });
  assert.deepEqual((await next()).activity, []);
  // Агент показывает блок: открытые страницы получают его id.
  assert.equal((await f.call('/api/show', { id: 'missing', actor: 'claude' })).status, 400);
  await f.call('/api/show', { id: 'a', actor: 'claude' });
  assert.deepEqual([(event = await next()).show, event.by], ['a', 'claude']);
  // Что человек выделил — агент видит в selection и в context.
  assert.deepEqual((await f.call('/api/selection')).body, { focus: null, selection: null });
  assert.equal((await f.call('/api/selection', { id: 'missing' })).status, 400);
  await f.call('/api/selection', { id: 'n' });
  assert.deepEqual((await f.call('/api/selection')).body, { focus: null, selection: 'n' });
  assert.match(await fetch(`${f.url}/context?brief=1`).then(r => r.text()), /Человек выделил на карте заметку «Скидка пропадает» \(n\)/);
  // Чата нет: писать в события снаружи нельзя, их пишет только Mycel по кнопкам человека.
  for (const path of ['/api/chat', '/api/chat/status']) assert.equal((await f.call(path, { author: 'human', text: 'Привет' })).status, 404);
  assert.equal((await f.call('/api/chat?since=-1')).status, 400);
  controller.abort();
  await f.call('/api/changes', { expectedRevision: 1, actor: 'test-agent', message: 'Будит', operations: [add('b')] });
  await waiting;
});test('an agent proposal lies on the map marked until the human accepts or rejects it; his edits and the decision wake the agent', async t => {
  const f = await fixture(t);
  await f.change(0, [add('k', { title: 'Корзина', w: 500, h: 300 }), add('s', { parentId: 'k', title: 'Сумма', x: 10, y: 10 }), add('o', { title: 'Оплата', x: 700 }), link('e1', 'k', 'o', 'сумма')]);
  await f.change(1, [{ type: 'update-node', id: 'k', patch: { collapsed: true } }]);
  // Отметки: только у блоков и только известные; пометку предложения правкой не поставить.
  assert.equal((await f.change(2, [{ type: 'update-node', id: 'o', patch: { status: 'done' } }])).status, 400);
  assert.equal((await f.change(2, [add('n', { type: 'note', status: 'plan' })])).status, 400);
  assert.equal((await f.change(2, [{ type: 'update-node', id: 'o', patch: { proposed: 'add' } }])).status, 400);
  const offer = (revision, operations, title) => f.call('/api/proposal', { expectedRevision: revision, actor: 'claude', ...(title ? { title } : {}), operations });
  assert.equal((await offer(2, [add('x')])).status, 400);
  let res = await offer(2, [add('promo', { parentId: 'k', title: 'Промокод', x: 10, y: 150 }), { type: 'update-node', id: 's', patch: { text: 'со скидкой' } },
    { type: 'delete-node', id: 'o' }, link('e2', 'promo', 's', 'скидка')], 'Промокоды');
  assert.equal(res.status, 200, res.body.error);
  const marks = g => Object.fromEntries([...g.nodes, ...g.edges].map(x => [x.id, [x.proposed ?? '-', x.status ?? '-']]));
  assert.deepEqual(marks(res.body), { k: ['-', '-'], s: ['change', '-'], o: ['remove', '-'], promo: ['add', 'plan'], e1: ['-', '-'], e2: ['add', '-'] });
  // Свёрнутая подкарта с предложенным раскрывается, удаление только помечено, прежнее содержимое запомнено.
  assert.equal(res.body.nodes.find(n => n.id === 'k').collapsed, false);
  assert.deepEqual([res.body.proposal.title, res.body.proposal.by, res.body.proposal.nodes.s.text], ['Промокоды', 'claude', '']);
  const context = await fetch(`${f.url}/context?brief=1`).then(r => r.text());
  assert.match(context, /Открыто предложение «Промокоды» \(claude\): добавить — 1, изменить — 1, удалить — 1/);
  assert.match(context, /ID: promo \| уровень: механика \| внутри: k \| план, кода нет \| предложено: добавить/);
  // Следующее предложение дополняет открытое.
  res = await offer(3, [add('p2', { parentId: 'k', title: 'Купон', x: 300, y: 150 })]);
  assert.deepEqual([res.status, res.body.proposal.title, marks(res.body).p2], [200, 'Промокоды', ['add', 'plan']]);
  // Человек правит предложенное: правки копятся, агент не просыпается; решение будит его вместе с правками.
  const waiting = f.call('/api/changes?since=4&exclude=claude&wait=10&content=1&chat=0');
  await f.call('/api/changes', { expectedRevision: 4, actor: 'human', message: 'Правка', operations: [{ type: 'update-node', id: 'promo', patch: { title: 'Промокод заказа' } }] });
  assert.equal(await Promise.race([waiting.then(() => 'woke'), new Promise(r => setTimeout(() => r('asleep'), 500))]), 'asleep');
  const accepted = (await f.call('/api/proposal/accept', {})).body;
  // Помеченное к удалению удалено вместе со своими связями, новое осталось планом.
  assert.deepEqual(marks(accepted.graph), { k: ['-', '-'], s: ['-', '-'], promo: ['-', 'plan'], p2: ['-', 'plan'], e2: ['-', '-'] });
  assert.equal(accepted.graph.proposal, undefined);
  assert.deepEqual([accepted.message.kind, accepted.message.proposal.result, accepted.message.proposal.edits.count], ['proposal', 'accepted', 1]);
  const woke = (await waiting).body;
  assert.deepEqual([woke.chat.messages.map(m => m.kind), woke.edit, woke.contentChanged], [['proposal'], null, true]);
  assert.equal((await f.call('/api/proposal/accept', {})).status, 409);
  assert.equal((await offer(woke.revision, [add('y')])).status, 400);
  // Отклонение: добавленное уходит, изменённое и перенесённое в предложенное возвращается, пометки снимаются.
  res = await offer(woke.revision, [add('box', { title: 'Скидки', x: 0, y: 600, w: 400, h: 300 }), { type: 'update-node', id: 's', patch: { parentId: 'box', x: 10, y: 10, text: 'в скидках' } },
    { type: 'update-edge', id: 'e2', patch: { label: 'код' } }], 'Скидки отдельно');
  assert.equal(res.status, 200, res.body.error);
  const rejected = (await f.call('/api/proposal/reject', {})).body;
  const s = rejected.graph.nodes.find(n => n.id === 's');
  assert.deepEqual([s.parentId, s.text, s.x, s.y, s.proposed, rejected.graph.nodes.some(n => n.id === 'box'), rejected.graph.edges.find(e => e.id === 'e2').label],
    ['k', 'со скидкой', 10, 10, undefined, false, 'скидка']);
  assert.deepEqual([rejected.message.proposal.result, rejected.message.text], ['rejected', 'Отклонено предложение «Скидки отдельно»']);
  assert.deepEqual((await f.call('/api/history')).body.history.slice(0, 2).map(h => h.message), ['Отклонено предложение «Скидки отдельно»', 'Предложение «Скидки отдельно»']);
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
  const write = (actor, revision, operations) => call('/changes', { expectedRevision: revision, actor, message: 'Правка', operations });
  await write('claude', 0, [add('a', { text: 'старый' }), add('b')]);
  // Сворачивание и перемещения правок не начинают, первая правка содержимого — начинает.
  await write('human', 1, [{ type: 'update-node', id: 'b', patch: { x: 300 } }]);
  assert.equal((await call('/changes?since=1')).body.edit, null);
  await write('human', 2, [{ type: 'update-node', id: 'a', patch: { text: 'новый' } }]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'edit.json'), 'utf8')).since, 2);
  // Начатые правки переживают перезапуск.
  await app.close(); app = null;
  app = await startServer({ data, port: 0 }); hub = client(app.url, token);
  assert.equal((await call('/changes?since=2')).body.edit.since, 2);
  const waiting = call('/changes?since=2&exclude=claude&wait=10&content=1&chat=0');
  await write('human', 3, [{ type: 'update-node', id: 'b', patch: { title: 'Корзина' } }]);
  await write('human', 4, [{ type: 'update-node', id: 'a', patch: { x: 500 } }]);
  assert.equal(await Promise.race([waiting.then(() => 'woke'), new Promise(r => setTimeout(() => r('asleep'), 600))]), 'asleep');
  const now = (await call('/changes?since=2&exclude=claude')).body;
  assert.deepEqual([now.edit.since, now.edit.count, now.held, now.entries.length, now.contentChanged], [2, 2, 3, 3, false]);
  assert.match(await fetch(`${app.url}/api/p/${project.id}/context`).then(r => r.text()), /Человек сейчас правит карту \(с ревизии 2, записей: 2\)/);
  // «Закончить правки»: одно событие будит агента, изменения приходят с ним.
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
  assert.equal((await f.change(1, [{ type: 'update-edge', id: 'l1', patch: { label: 'передаёт' } }])).status, 200);
  const reversed = await f.change(2, [{ type: 'update-edge', id: 'l1', patch: { source: 'b', target: 'a' } }]);
  assert.equal(reversed.status, 200); assert.deepEqual(reversed.body.edges[0], { id: 'l1', source: 'b', target: 'a', label: 'передаёт' });
  assert.deepEqual((await f.call('/api/history')).body.history.slice(0, 2).map(h => h.changes[0]), ['Изменено направление связи: «b» → «a»', 'Изменена подпись связи «a» → «b»: «передаёт»']);
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
  await assert.rejects(startServer({ data, port: 0 }), new RegExp(`^Error: Mycel уже запущен: ${app.url.replace(/\./g, '\\.')}$`));
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
    nodes: [node('product', null, 'Магазин', { kind: 'product', status: 'building', summary: 'Интернет-магазин.' }), node('checkout', 'product', 'Оформление заказа', { logic: 'Корзина → оплата', questions: 'Без регистрации?' }), node('payment', 'checkout', 'Оплата', { status: 'done', criteria: 'Платёж проходит' }), node('catalog', 'product', 'Каталог')],
    edges: [{ id: 'relation', source: 'catalog', target: 'checkout', kind: 'flow', label: 'передаёт товар' }, { id: 'dep', source: 'payment', target: 'catalog', kind: 'depends', label: '' }],
    history: [{ revision: 8, actor: 'human', message: 'Previous decision', changes: ['Keep this'], at: '2026-10-01T00:00:00.000Z' }]
  };
}
test('nested maps become free-form maps: tree links, merged text, positions', () => {
  const next = migrateToV3(legacyMap());
  assert.equal(next.schemaVersion, 3); assert.equal(next.nodes.length, 4);
  const checkout = next.nodes.find(n => n.id === 'checkout');
  assert.equal(checkout.text, 'Логика: Корзина → оплата\n\nОткрытые вопросы: Без регистрации?');
  assert.equal(next.nodes.find(n => n.id === 'payment').text, 'Критерии готовности: Платёж проходит\n\nСтатус: Готово');
  assert.equal(next.nodes.find(n => n.id === 'product').color, 'blue');
  assert.ok(next.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y) && n.w === 220 && n.h === 110));
  assert.ok(checkout.x > next.nodes.find(n => n.id === 'product').x && next.nodes.find(n => n.id === 'payment').x > checkout.x);
  assert.deepEqual(next.edges.map(e => `${e.source}>${e.target}:${e.label}`), ['product>checkout:', 'checkout>payment:', 'product>catalog:', 'catalog>checkout:передаёт товар', 'payment>catalog:зависимость']);
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
  // Процесса больше нет — и в формате 0.10, и в прежнем (только номер процесса).
  await lock(gone.pid, 1, new Date().toISOString());
  await restart();
  const own = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual([own.pid, own.port, own.data], [process.pid, Number(new URL(app.url).port), app.data]);
  await app.close(); app = null;
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await writeFile(file, String(gone.pid));
  await restart(); await app.close(); app = null;
  // Номер процесса жив, но lock старше 10 секунд и по его порту Mycel не отвечает: номер достался другой программе.
  const port = await freePort();
  await lock(process.pid, port, new Date(Date.now() - 60000).toISOString());
  await restart(); await app.close(); app = null;
  // Свежий lock живого процесса не снимается, и старый тоже, если по его порту отвечает Mycel с этими данными.
  await lock(process.pid, port, new Date().toISOString());
  await assert.rejects(startServer({ data, port: 0 }), new RegExp(`Mycel уже запущен: http://127\\.0\\.0\\.1:${port}`));
  await rm(file);
  app = await startServer({ data, port: 0 });
  const running = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...running, startedAt: new Date(Date.now() - 60000).toISOString() }));
  await assert.rejects(startServer({ data, port: 0 }), /Mycel уже запущен/);
});
// До 0.15 программа называлась Контур, данные — в .kontur рядом с ней. Каталог переносится, пока его не держит хаб.
test('data of the former Контур move from .kontur to .mycel unless its hub is running', async t => {
  const root = await temp('mycel-rename-'), legacy = join(root, '.kontur'), data = join(root, '.mycel');
  t.after(() => clean(root));
  assert.equal(defaultData(root), data);
  await mkdir(legacy); await writeFile(join(legacy, 'projects.json'), '{"projects":[]}');
  await writeFile(join(legacy, 'server.lock'), JSON.stringify({ pid: process.pid, port: 4317 }));
  assert.equal(defaultData(root), legacy, 'хаб прежней версии работает');
  const gone = spawn(process.execPath, ['-e', '']); await once(gone, 'exit');
  await writeFile(join(legacy, 'server.lock'), JSON.stringify({ pid: gone.pid, port: 4317 }));
  assert.equal(defaultData(root), data);
  assert.equal(await readFile(join(data, 'projects.json'), 'utf8'), '{"projects":[]}');
  await assert.rejects(readdir(legacy), { code: 'ENOENT' });
  // Если есть оба каталога, данные — в .mycel, а .kontur не трогается.
  await mkdir(legacy);
  assert.equal(defaultData(root), data);
  assert.deepEqual(await readdir(legacy), []);
});
test('a stale hub lock is taken over by one hub only; the others name the port of that hub', async t => {
  const data = await temp('mycel-race-'), file = join(data, 'server.lock'), guard = `${file}.takeover`;
  t.after(() => clean(data));
  const gone = spawn(process.execPath, ['-e', '']); await once(gone, 'exit');
  const stale = () => writeFile(file, JSON.stringify({ pid: gone.pid, port: 1, data, startedAt: new Date().toISOString() }));
  // Хабы, запущенные разом после сбоя: устаревший lock снимает один, остальные видят его lock, а не прежний.
  for (let round = 0; round < 10; round++) {
    await stale();
    const results = await Promise.allSettled([47101, 47102, 47103].map(port => lockHub(data, port)));
    const won = results.filter(r => r.status === 'fulfilled'), { port } = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(won.length, 1, `круг ${round}`);
    assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason.message), Array(2).fill(`Mycel уже запущен: http://127.0.0.1:${port}`));
    await won[0].value.release();
    await assert.rejects(readFile(file), { code: 'ENOENT' }); await assert.rejects(readFile(guard), { code: 'ENOENT' });
  }
  // Файл перехвата, брошенный упавшим процессом, не мешает запуску.
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
  assert.match(listed.broken.error, /Размер/); assert.equal(listed.empty.error, 'Нет файла карты graph.json.');
  assert.deepEqual([listed.broken.revision, listed.broken.blocks, listed.broken.exists, listed.broken.updatedAt], [null, 0, false, listed.broken.createdAt]);
  for (const route of ['', '/graph', '/context', '/events']) assert.equal((await fetch(`${app.url}/api/p/broken${route}`)).status, 503);
  const refused = await hub('/api/p/broken/changes', { expectedRevision: 0, actor: 'agent', message: 'x', operations: [] });
  assert.deepEqual(refused, { status: 503, body: { error: listed.broken.error } });
  assert.equal(await readFile(join(data, 'projects', 'broken', 'graph.json'), 'utf8'), text);
  await assert.rejects(readFile(join(data, 'projects', 'empty', 'graph.json')), { code: 'ENOENT' });
  // Остальные проекты работают.
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
  // Остановка: только с токеном и только у хаба, запущенного из командной строки.
  assert.equal((await f.hub('/api/stop', {}, { Authorization: '' })).status, 401);
  assert.equal((await f.hub('/api/stop', {})).status, 404);
  assert.equal(await hostStatus(f.url + '/graph'), 403);
  assert.equal(await hostStatus(f.app.url + '/agent'), 403);
  // Инструкция агенту: текст для любого origin, с командой этого компьютера и адресом хаба, без токена.
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
  assert.equal(version, '0.21.0');
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
  // Поиск: ближайший проект, в папке которого лежит путь; с root — только проект внутри root.
  const find = (path, root) => f.hub(`/api/projects?${new URLSearchParams({ path, ...(root ? { root } : {}) })}`);
  assert.equal((await find(deep)).body.project.id, 'podproekt');
  assert.equal((await find(join(repo, 'src'))).body.project.id, id);
  assert.deepEqual(await find(join(repo, 'src'), repo), { status: 404, body: { error: 'Папка не подключена к Mycel.' } });
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
  // Подключённая папка выше: без root репозиторий входит в неё, с root — свой проект.
  assert.equal((await connect({ path: repo })).body.ancestor, true);
  const own = (await connect({ path: repo, root: repo })).body;
  assert.deepEqual([own.created, own.ancestor, own.project.path], [true, undefined, realpathSync.native(repo)]);
  // Удалённая папка выше: без root — 409 «удалён», с root — новый проект.
  assert.equal((await f.hub(`/api/projects/${parent.id}/delete`, {})).status, 200);
  assert.deepEqual([(await connect({ path: other })).status, (await connect({ path: other, root: other })).body.created], [409, true]);
  // Удалён сам репозиторий: по-прежнему 409.
  assert.equal((await f.hub(`/api/projects/${own.project.id}/delete`, {})).status, 200);
  const refused = await connect({ path: repo, root: repo });
  assert.deepEqual([refused.status, refused.body.deleted?.id], [409, own.project.id]);
  assert.deepEqual(await connect({ path: repo, root: 'relative' }), { status: 400, body: { error: 'Укажите полный путь папки.' } });
});
test('refused and missing folders are not connected; names are checked', async t => {
  const f = await hubFixture(t), folder = await temp('mycel-folder-');
  t.after(() => clean(folder));
  await writeFile(join(folder, 'file.txt'), 'x');
  const connect = body => f.hub('/api/projects', body);
  for (const path of [homedir(), parse(tmpdir()).root, 'relative', 42]) assert.deepEqual(await connect({ path }), { status: 400, body: { error: typeof path === 'string' ? 'Это не папка проекта.' : 'Нет такой папки.' } });
  for (const path of [join(folder, 'missing'), join(folder, 'file.txt'), undefined]) assert.deepEqual(await connect({ path }), { status: 400, body: { error: 'Нет такой папки.' } });
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
  await f.call('/api/changes', { expectedRevision: 1, actor: 'human', message: 'Правка', operations: [{ type: 'update-node', id: 'kept', patch: { text: 'текст' } }] });
  await f.call('/api/edits', {});
  await f.call('/api/cursor', { actor: 'tester', revision: 2, chat: 1 });
  const controller = new AbortController(); t.after(() => controller.abort());
  const next = events(await fetch(f.url + '/events', { signal: controller.signal }));
  assert.deepEqual(await next(), { revision: 2, edit: null, agents: [], activity: [], work: [], code: { stale: {}, risks: {} } });
  const waiting = f.call('/api/changes?since=2&exclude=tester&wait=10', null, { 'X-Mycel-Actor': 'tester' });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(await f.hub(`/api/projects/${f.project.id}/delete`, {}), { status: 200, body: { deleted: f.project.id } });
  // Ожидающий агент узнаёт об удалении, только повторив запрос: пока шло удаление, оно могло не состояться.
  assert.deepEqual(await waiting, { status: 503, body: { error: 'Проект удаляется, повторите запрос.', retry: true } });
  const last = [];
  for (let event; (event = await next()) !== null; ) if (!event.presence) last.push(event);
  assert.deepEqual(last, [{ deleted: true }]);
  const graph = await f.call('/api/graph');
  assert.deepEqual([graph.status, graph.body.deleted.id, graph.body.deleted.name], [404, f.project.id, f.project.name]);
  assert.equal(graph.body.error, `Проект «${f.project.name}» удалён человеком.`);
  assert.deepEqual((await f.hub('/api/projects')).body.projects, []);
  const trashed = join(f.data, 'trash', f.project.id);
  assert.equal(JSON.parse(await readFile(join(trashed, 'project.json'), 'utf8')).deletedAt, graph.body.deleted.deletedAt);
  await assert.rejects(readFile(join(f.dir, 'graph.json')), { code: 'ENOENT' });
  // Папка удалённого проекта: поиск и подключение сообщают об удалении, --new создаёт новый проект с другим id.
  const found = await f.hub(`/api/projects?${new URLSearchParams({ path: join(f.folder, 'src') })}`);
  assert.deepEqual([found.status, found.body.deleted], [404, graph.body.deleted]);
  const refused = await f.hub('/api/projects', { path: f.folder });
  assert.deepEqual([refused.status, refused.body.deleted, refused.body.error], [409, graph.body.deleted, graph.body.error]);
  const fresh = (await f.hub('/api/projects', { path: f.folder, new: true })).body;
  assert.deepEqual([fresh.created, fresh.project.id], [true, `${f.project.id}-2`]);
  assert.deepEqual(await f.hub(`/api/projects/${f.project.id}/restore`, {}), { status: 409, body: { error: `Папка уже подключена к проекту «${fresh.project.name}».` } });
  assert.equal((await f.hub(`/api/projects/${fresh.project.id}/delete`, {})).status, 200);
  // id уникален и среди удалённых: оба удалённых id заняты.
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
  // Windows не переименовывает папку с открытым файлом: так ведёт себя антивирус или редактор, держащий файл.
  const handle = await open(join(f.dir, 'chat.json'), 'r');
  let closed = false;
  t.after(() => closed || handle.close());
  // Пока удаление не решено, ожидающий агент и новые запросы слышат «повторите», а не «удалён».
  const removing = f.hub(`/api/projects/${f.project.id}/delete`, {}), retry = { status: 503, body: { error: 'Проект удаляется, повторите запрос.', retry: true } };
  assert.deepEqual(await waiting, retry);
  assert.deepEqual(await f.call('/api/graph'), retry);
  assert.deepEqual(await removing, { status: 409, body: { error: 'Папка проекта занята, попробуйте ещё раз.' } });
  await handle.close(); closed = true;
  assert.equal((await f.change(0, [add('after')])).status, 200);
  // Открытая страница проекта не получила {deleted: true} и видит правки дальше.
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
  await assert.rejects(startServer({ data, port }), new RegExp(`^Error: Порт ${port} занят другой программой\\.$`));
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
  assert.deepEqual(await rebind({ path: other }), { status: 409, body: { error: `Проект подключён к ${f.project.path}.` } });
  await rename(f.folder, moved);
  assert.equal((await f.hub('/api/projects')).body.projects[0].exists, false);
  const back = (await rebind({ path: moved })).body;
  assert.deepEqual([back.created, back.moved, back.project.path, back.project.exists, back.project.revision], [false, true, realpathSync.native(moved), true, 1]);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'project.json'), 'utf8')).path, back.project.path);
  assert.equal((await rebind({ path: moved })).body.moved, undefined);
  assert.deepEqual([(await rebind({ path: other, move: true })).body.moved, (await f.hub(`/api/p/${f.project.id}`)).body.project.path], [true, realpathSync.native(other)]);
  const second = (await f.hub('/api/projects', { path: moved })).body.project;
  assert.deepEqual(await rebind({ path: moved, move: true }), { status: 409, body: { error: `Папка уже подключена к проекту «${second.name}».` } });
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
  // Испорченный реестр: прошлая копия плюс проекты по их папкам.
  await writeFile(join(data, 'projects.json'), '{ broken');
  await start();
  assert.deepEqual(await listed(), expected);
  assert.equal(await readFile(join(data, 'projects.broken.json'), 'utf8'), '{ broken');
  await app.close(); app = null;
  // Испорчены оба: реестр собирается заново по projects/*/project.json.
  await writeFile(join(data, 'projects.json'), 'null'); await writeFile(join(data, 'projects.backup.json'), '');
  await start();
  assert.deepEqual(await listed(), expected);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'projects.json'), 'utf8')).projects.map(p => [p.id, p.path]).sort(), [...expected].sort());
  assert.ok((await readdir(join(data, 'projects'))).includes('.new-leftover'));
  await app.close(); app = null;
  // Удаление успело перенести папку в корзину, но не записать реестр: проект считается удалённым.
  const [[gone]] = expected;
  await rename(join(data, 'projects', gone), join(data, 'trash', gone));
  await start();
  assert.deepEqual(await listed(), expected.slice(1));
  assert.equal((await hub(`/api/p/${gone}/graph`)).status, 404);
});
test('context lists blocks with text and links; unknown routes return 404', async t => {
  const f = await fixture(t);
  await f.change(0, [add('a', { title: 'Корзина', text: 'Состав заказа' }), add('b', { title: 'Оплата' }), link('l1', 'a', 'b', 'сумма'), link('l2', 'b', 'a'), note('n1', 'a', { text: 'Проверить лимит' }), note('n2', null, { text: 'Свободная заметка' }), add('inner', { parentId: 'a', title: 'Внутри' }), note('n3', null, { parentId: 'a', text: 'Заметка в подкарте' }),
    add('tech', { parentId: 'inner', title: 'Хранение' }), add('step', { parentId: 'tech', title: 'Записать' }), add('deeper', { parentId: 'step', title: 'Глубже' })]);
  const res = await fetch(f.url + '/context'); const text = await res.text();
  assert.equal(res.status, 200); assert.match(text, /^# Карта\nРевизия: 1\n/); assert.match(text, /### Корзина\nID: a \| уровень: концепция \| x: 0, y: 0, w: 220, h: 110\n\nСостав заказа\n\nЗаметка \(n1\): Проверить лимит\n\n#### Внутри\nID: inner \| уровень: механика \| x: 0, y: 0, w: 220, h: 110 \| внутри: a/); assert.match(text, /## Заметки\n- \(n2\) Свободная заметка/);
  // Четыре уровня: глубже кода — тоже код. У связей — id для update-edge и delete-edge.
  assert.deepEqual(['tech', 'step', 'deeper'].map(id => new RegExp(`ID: ${id} \\| уровень: ([а-я]+)`).exec(text)[1]), ['техника', 'код', 'код']);
  assert.match(text, /Концепция \(блоки основной карты\) и механика \(их подкарты\) — для людей без программирования/);
  assert.match(text, /^- Корзина \(a\) → Оплата \(b\): сумма · id: l1$/m); assert.match(text, /^- Оплата \(b\) → Корзина \(a\) · id: l2$/m);
  assert.match(text, /Заметки внутри «Корзина» \(a\)\n- \(n3\) Заметка в подкарте/);
  // Фокус: только блок со вложенным и связи с остальной картой; фокус человека виден агенту.
  const focused = await (await fetch(f.url + '/context?focus=a')).text();
  assert.match(focused, /### Корзина/); assert.match(focused, /#### Внутри/); assert.doesNotMatch(focused, /### Оплата/);
  assert.match(focused, /## Связи с остальной картой\n- Корзина \(a\) → Оплата \(b\): сумма/);
  assert.equal((await f.call('/api/focus', { id: 'a' })).status, 200);
  assert.match(await (await fetch(f.url + '/context')).text(), /Человек сейчас в фокусе на блоке «Корзина» \(a\)/);
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
  await f.call('/api/changes', { expectedRevision: 1, actor: 'human', message: 'Правка человека', operations: [{ type: 'update-node', id: 'live', patch: { text: 'текст' } }] });
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
  await f.call('/api/changes', { expectedRevision: 1, actor: 'human', message: 'Правка', operations: [{ type: 'update-node', id: 'live', patch: { text: 'текст' } }] });
  assert.deepEqual(await next(), { project: f.project.id, revision: 2 });
  await f.call('/api/edits', {});
  assert.deepEqual(await next(), { project: f.project.id, chat: 1 });
  await f.call('/api/graph', null, { 'X-Mycel-Actor': 'codex' });
  assert.deepEqual(await next(), { project: f.project.id, presence: true });
  await f.hub(`/api/projects/${f.project.id}/delete`, {});
  assert.deepEqual(await next(), { projects: 3 });
});

// Виртуальная машина ходит на адрес своей сети: только с ключом (Bearer или cookie по ссылке /?key=…), токен по сети
// не раздаётся; подключить папку и открыть доступ оттуда нельзя. 127.0.0.2 — второй адрес вместо сети VMware.
test('a virtual machine reaches Mycel on its network address only with the key; the key link sets a cookie; host-only actions are refused', async t => {
  const data = await temp('mycel-remote-'), app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data); });
  const { version } = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  const req = (path, init = {}) => fetch(far + path, { redirect: 'manual', ...init });
  if (!(await req('/api/health').then(res => res.ok, () => false))) return t.skip('второго адреса loopback нет');
  assert.deepEqual(await (await req('/api/health')).json(), { ok: true, app: 'mycel', version });
  for (const path of ['/api/projects', '/api/session', '/', '/app.js']) assert.equal((await req(path)).status, 401, path);
  const bearer = { headers: { Authorization: `Bearer ${token}` } };
  assert.equal((await req('/api/projects', bearer)).status, 200);
  assert.deepEqual(Object.keys(await (await req('/api/health', bearer)).json()), ['ok', 'app', 'version', 'data']);
  assert.match(await (await req('/agent', bearer)).text(), /Ты в виртуальной машине, а Mycel работает на основной \(http:\/\/127\.0\.0\.2:\d+\)/);
  // Ключ в ссылке ставит cookie и уходит из адреса; с cookie открываются страница и сессия.
  assert.equal((await req('/?key=wrong')).status, 401);
  const link = await req(`/?key=${token}`);
  assert.deepEqual([link.status, link.headers.get('location')], [303, '/']);
  assert.match(link.headers.get('set-cookie'), /^mycel_key=[0-9a-f]+; HttpOnly; SameSite=Strict; Path=\//);
  const cookie = { headers: { cookie: link.headers.get('set-cookie').split(';')[0] } };
  assert.equal((await req('/', cookie)).status, 200);
  assert.equal((await (await req('/api/session', cookie)).json()).token, token);
  // Копия Mycel для виртуальной машины (программа, ключ не нужен): архив, который распаковывает обычный tar, и
  // распакованный mycel.mjs запускается.
  const archive = await req('/download/mycel.tar.gz');
  assert.equal(archive.headers.get('content-type'), 'application/gzip');
  const copy = await temp('mycel-copy-');
  t.after(() => clean(copy));
  await writeFile(join(copy, 'mycel.tar.gz'), Buffer.from(await archive.arrayBuffer()));
  const untar = spawnSync('tar', ['xzf', 'mycel.tar.gz'], { cwd: copy, encoding: 'utf8' });
  if (untar.error) t.diagnostic('tar не найден: распаковка не проверена');
  else {
    assert.equal(untar.status, 0, untar.stderr);
    const help = spawnSync(process.execPath, [join(copy, 'mycel.mjs'), 'help'], { encoding: 'utf8' });
    assert.match(help.stdout, /^Mycel для агентов: node mycel\.mjs <команда>/);
    assert.ok((await readdir(join(copy, 'src'))).includes('agent-guide.md'));
  }
  // Подключить папку, остановить Mycel и открыть доступ из виртуальной машины нельзя.
  const post = (base, path, body) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(far, '/api/projects', { path: data })).status, 403);
  assert.equal((await post(far, '/api/remote', { addresses: [] })).status, 403);
  assert.equal((await req('/api/remote', bearer)).status, 403);
  // На основной машине: только адреса своих адаптеров; закрытый доступ больше не отвечает.
  assert.equal((await post(app.url, '/api/remote', { addresses: ['8.8.8.8'] })).status, 400);
  assert.deepEqual((await (await fetch(`${app.url}/api/remote`)).json()).listening, [{ address: '127.0.0.2', listening: true }]);
  assert.equal((await post(app.url, '/api/remote', { addresses: [] })).status, 200);
  assert.equal(await req('/api/health').then(() => true, () => false), false);
  assert.deepEqual(JSON.parse(await readFile(join(app.data, 'listen.json'), 'utf8')), { addresses: [] });
});

// Агент в виртуальной машине настраивает всё сам: без ключа ему открыты инструкция, установка и запрос доступа; человек
// разрешает запрос кнопкой, машина один раз получает свой ключ (в devices.json — только хэш), отозванный ключ не работает.
test('a virtual machine asks for access without a key; the human approves it and the machine gets its own revocable key', async t => {
  const data = await temp('mycel-pair-'), app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('второго адреса loopback нет');
  const call = async (base, path, body, key = null) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text() };
  };
  // Без ключа: инструкция, установка, копия Mycel и запрос доступа; остальное закрыто.
  assert.match((await call(far, '/agent')).body, new RegExp(`curl -fsS ${far.replace(/\./g, '\\.')}/install\\.sh \\| sh`));
  assert.match((await call(far, '/install.sh')).body, new RegExp(`^#!/bin/sh[\\s\\S]*HOST="${far.replace(/\./g, '\\.')}"[\\s\\S]*exec "\\$NODE" "\\$DIR/mycel\\.mjs" join "\\$HOST" "\\$@"`));
  assert.equal((await fetch(`${far}/download/mycel.tar.gz`)).status, 200);
  assert.equal((await call(far, '/api/projects')).status, 401);
  const project = (await call(app.url, '/api/projects', { path: data, name: 'Карта' }, token)).body.project;
  const asked = (await call(far, '/api/pair', { name: 'ubuntu <vm>' })).body;
  assert.match(asked.code, /^\d{4}$/);
  assert.equal((await call(far, `/api/pair/${asked.id}?secret=wrong`)).status, 404);
  assert.deepEqual((await call(far, `/api/pair/${asked.id}?secret=${asked.secret}`)).body, { status: 'pending' });
  const access = (await call(app.url, '/api/access')).body;
  assert.deepEqual(access.pending.map(r => [r.id, r.code, r.name]), [[asked.id, asked.code, 'ubuntu vm']]);
  assert.deepEqual(access.projects, [{ id: project.id, name: 'Карта' }]);
  // Ответить на запрос можно только с основной машины.
  assert.equal((await call(far, `/api/pair/${asked.id}/approve`, {}, token)).status, 403);
  assert.equal((await call(app.url, `/api/pair/${asked.id}/approve`, { project: 'nope' }, token)).status, 400);
  const approved = (await call(app.url, `/api/pair/${asked.id}/approve`, { project: project.id }, token)).body;
  assert.deepEqual([approved.pending, approved.devices.map(d => [d.name, d.project])], [[], [['ubuntu vm', project.id]]]);
  const answer = (await call(far, `/api/pair/${asked.id}?secret=${asked.secret}`)).body;
  assert.deepEqual([answer.status, answer.project, /^[0-9a-f]{64}$/.test(answer.key)], ['approved', project.id, true]);
  assert.equal((await call(far, `/api/pair/${asked.id}?secret=${asked.secret}`)).status, 404, 'ключ отдаётся один раз');
  // Ключ машины работает как ключ, сессия отдаёт его же, а не токен основной машины; в файле — только хэш.
  assert.equal((await call(far, '/api/projects', null, answer.key)).status, 200);
  assert.equal((await call(far, '/api/session', null, answer.key)).body.token, answer.key);
  assert.equal((await call(far, '/api/access', null, answer.key)).status, 403);
  const stored = await readFile(join(app.data, 'devices.json'), 'utf8');
  assert.ok(!stored.includes(answer.key) && !stored.includes(token));
  // Отклонённый запрос и отозванный ключ.
  const second = (await call(far, '/api/pair', { name: 'other' })).body;
  assert.equal((await call(app.url, `/api/pair/${second.id}/deny`, {}, token)).status, 200);
  assert.deepEqual((await call(far, `/api/pair/${second.id}?secret=${second.secret}`)).body, { status: 'denied' });
  assert.equal((await call(app.url, `/api/devices/${approved.devices[0].id}/revoke`, {}, token)).status, 200);
  assert.equal((await call(far, '/api/projects', null, answer.key)).status, 401);
  assert.deepEqual((await call(app.url, '/api/access')).body.devices, []);
});

// Проект папки виртуальной машины: создаёт его машина со своим ключом, папку основная не проверяет; проект помечен
// машиной, и её папки сравниваются только с её же проектами.
test('a machine with its own key creates projects for its folders; they are marked with the machine and kept apart', async t => {
  const data = await temp('mycel-machine-'), app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('второго адреса loopback нет');
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
  assert.equal((await call(far, '/api/projects', { path: '/home/user/hedwig', name: 'Hedwig' }, token)).status, 403, 'токеном основной — нельзя: не ясно, чья папка');
  for (const path of ['/', 'home/user', 'C:\\']) assert.equal((await call(far, '/api/projects', { path }, ubuntu)).status, 400, path);
  const made = (await call(far, '/api/projects', { path: '/home/user/hedwig/', name: 'Hedwig' }, ubuntu)).body;
  assert.equal(made.created, true);
  assert.deepEqual([made.project.path, made.project.exists, made.project.machine.name], ['/home/user/hedwig', null, 'ubuntu']);
  assert.deepEqual((await call(far, '/api/projects', { path: '/home/user/hedwig' }, ubuntu)).body.created, false);
  assert.equal((await call(far, `/api/projects?path=${encodeURIComponent('/home/user/hedwig/src')}`, null, ubuntu)).body.project.id, made.project.id);
  // Та же папка на другой машине и на основной — не этот проект.
  const debian = await machine('debian');
  assert.equal((await call(far, `/api/projects?path=${encodeURIComponent('/home/user/hedwig')}`, null, debian)).status, 404);
  assert.equal((await call(app.url, `/api/projects?path=${encodeURIComponent('/home/user/hedwig')}`)).status, 404);
  const other = (await call(far, '/api/projects', { path: '/home/user/hedwig', name: 'Hedwig' }, debian)).body.project;
  assert.notEqual(other.id, made.project.id);
  assert.equal((await call(far, '/api/projects', { path: '/srv/x', id: made.project.id, move: true }, debian)).status, 409, 'чужой проект не переносится');
  // В списке — с машиной; после перезапуска пометка остаётся.
  assert.deepEqual((await call(app.url, '/api/projects')).body.projects.filter(p => p.machine).map(p => p.machine.name).sort(), ['debian', 'ubuntu']);
  await app.close();
  const again = await startServer({ data, port: 0 });
  t.after(() => again.close());
  assert.equal((await call(again.url, '/api/projects')).body.projects.find(p => p.id === made.project.id).machine.name, 'ubuntu');
});