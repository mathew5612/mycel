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
const until = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await check()) return; assert.fail('Не дождались'); };
const idOf = out => /#\/p\/([a-z0-9-]+)/.exec(out)?.[1];

// Команда агента отдельным процессом. Настоящий .mycel и порт 4317 не трогаются: каталог данных всегда временный,
// адрес всегда явный, Mycel сам не запускается (кроме одного теста автозапуска); переменные разработчика не влияют.
// cut — как head или Select-Object -First: процесс завершается, как только напечатал первые строки.
function mycel(args, { cwd = tmpdir(), data, url, start = false, env = {}, cut = false, input = null }) {
  // CLAUDE_PID и MYCEL_CLAUDE не передаются: plugin --install в тестах не должен найти настоящий claude.
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
// Хаб в процессе теста на временном каталоге данных и свободном порту; folder — временная папка проекта.
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
    // Хук так, как его вызывает Claude Code: событие JSON на стандартном вводе.
    hook: (event, env) => mycel(['hook'], { cwd: event.cwd, env, data: app.data, url: app.url, input: JSON.stringify(event) }) };
}
// Подключённый проект с прочитанной картой.
async function connected(h, name) {
  const dir = await h.folder(), init = await h.run(['init', '--name', name], dir);
  assert.equal(init.code, 0, init.err);
  const read = await h.run(['context'], dir);
  assert.equal(read.code, 0, read.err);
  return { dir, id: idOf(init.out) };
}
const geometry = graph => Object.fromEntries(graph.nodes.map(n => [n.id, [n.parentId, n.attachedTo, n.collapsed, n.x, n.y, n.w, n.h]]));
const links = graph => graph.edges.map(e => `${e.source}>${e.target}:${e.label}`).sort();
// Ни на одном уровне блоки (вместе с прикреплёнными заметками) и свободные заметки не перекрываются.
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
  message: 'Концепции',
  blocks: [
    { title: 'Интерфейс', text: 'Карта в браузере', notes: ['Без сборки'] },
    { title: 'Хаб', text: 'Один процесс на все проекты', notes: ['Порт 4317'],
      blocks: [{ title: 'Реестр', text: 'Список проектов и их папок' }, { title: 'Карта', blocks: [{ title: 'Записать' }, { title: 'Прочитать' }] }] },
    { title: 'Агенты', text: 'Команды для агентов', blocks: [{ title: 'Курсор' }, { title: 'Ожидание', text: 'Долгий запрос' }] },
    { title: 'Проверка' }
  ],
  notes: ['Всё локально'],
  links: [['Интерфейс', 'Хаб', 'HTTP'], ['Агенты', 'Хаб', 'HTTP'], ['Реестр', 'Карта', 'id проекта'], ['Курсор', 'Ожидание']]
};
// Механика концепции; «Нарисовать» — уже техника (подкарта механики): там функции и файлы в обратных кавычках.
const mechanics = parent => ({
  parent, message: `Механика ${parent}`,
  blocks: [
    { title: 'Холст', text: 'Рисует блоки и связи', blocks: [{ title: 'Нарисовать', text: '`render()` в `public/app.js`' }, { title: 'Сдвинуть' }] },
    { title: 'Чат', text: 'Сообщения человека и агентов', notes: ['Последние 500 сообщений'] },
    { title: 'Главная' }
  ],
  links: [['Главная', 'Холст', 'id'], ['Холст', 'Чат']]
});

test('init connects a folder once; its subfolder belongs to it, a repository inside it is a project of its own', async t => {
  const h = await hubFixture(t), dir = await h.folder(), sub = join(dir, 'src', 'deep'), name = basename(dir);
  await mkdir(sub, { recursive: true });
  let r = await h.run(['init'], dir);
  assert.equal(r.code, 0, r.err);
  const id = idOf(r.out);
  assert.equal(r.out.trim(), `Проект «${name}» подключён: ${h.url}/#/p/${id}`);
  r = await h.run(['init'], dir);
  assert.equal(r.out.trim(), `Проект «${name}» уже подключён: ${h.url}/#/p/${id}`);
  r = await h.run(['init'], sub);
  assert.equal(r.out.trim(), `Папка входит в проект «${name}» (${dir}): ${h.url}/#/p/${id}`);
  r = await h.run(['context'], sub);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# Карта\nРевизия: 0\n/);
  // Поиск из репозитория не выходит за его корень, поэтому init делает репозиторий отдельным проектом.
  const repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true }); await mkdir(join(repo, 'lib'));
  r = await h.run(['init', 'lib', '--name', 'Библиотека'], repo);
  assert.equal(r.out.trim(), `Проект «Библиотека» подключён: ${h.url}/#/p/biblioteka`, r.err);
  r = await h.run(['context'], join(repo, 'lib'));
  assert.equal(r.code, 0, r.err);
  r = await h.run(['projects']);
  assert.deepEqual(r.out.trim().split('\n').sort(), [`${id} · ${name} · ${dir}`, `biblioteka · Библиотека · ${repo}`].sort());
});

// Название у уже подключённой папки — переименование: id и карта прежние, из подпапки родительский проект не меняется.
test('init --name renames the project of a connected folder, not the project a subfolder belongs to', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Контур');
  await mkdir(join(dir, 'lib'));
  let r = await h.run(['init', '--name', 'Mycel'], dir);
  assert.equal(r.out.trim(), `Проект переименован в «Mycel»: ${h.url}/#/p/${id}`, r.err);
  r = await h.run(['init', '--name', 'Mycel'], dir);
  assert.equal(r.out.trim(), `Проект «Mycel» уже подключён: ${h.url}/#/p/${id}`, r.err);
  r = await h.run(['init', '--name', 'Другое'], join(dir, 'lib'));
  assert.equal(r.out.trim(), `Папка входит в проект «Mycel» (${dir}): ${h.url}/#/p/${id}`, r.err);
  r = await h.run(['init', '--project', id, '--name', 'Mycel 2'], dir);
  assert.equal(r.out.trim(), `Проект переименован в «Mycel 2»: ${h.url}/#/p/${id}`, r.err);
  const { projects } = (await h.api('/api/projects')).body;
  assert.deepEqual(projects.map(p => [p.id, p.name, p.path]), [[id, 'Mycel 2', dir]]);
  r = await h.run(['context'], dir);
  assert.equal(r.code, 0, r.err);
});

test('a repository inside a folder the human deleted is connected on its own; a deleted repository is not', async t => {
  const h = await hubFixture(t), dir = await h.folder(), repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  let r = await h.run(['init', '--name', 'Папка'], dir);
  assert.equal((await h.api(`/api/projects/${idOf(r.out)}/delete`, {})).status, 200);
  r = await h.run(['init'], repo);
  assert.equal(r.out.trim(), `Проект «repo» подключён: ${h.url}/#/p/repo`, r.err);
  r = await h.run(['context'], repo);
  assert.equal(r.code, 0, r.err);
  assert.equal((await h.api('/api/projects/repo/delete', {})).status, 200);
  r = await h.run(['init'], repo);
  assert.deepEqual([r.code, r.err.trim()], [1, 'Проект «repo» удалён человеком. Подключайте заново только по его просьбе: mycel init --new.']);
});

test('a git worktree inside or outside the repository uses the project of the repository; a submodule is its own', async t => {
  const h = await hubFixture(t), repo = await h.folder(), outside = await h.folder();
  await mkdir(join(repo, '.git'));
  let r = await h.run(['init', '--name', 'Репозиторий'], repo);
  const id = idOf(r.out);
  // Рабочее дерево git worktree: .git — файл со ссылкой на <репозиторий>/.git/worktrees/<имя>, где лежит commondir.
  const worktree = async (dir, name) => {
    const gitdir = join(repo, '.git', 'worktrees', name);
    await mkdir(gitdir, { recursive: true }); await writeFile(join(gitdir, 'commondir'), '../..\n');
    await mkdir(join(dir, 'src'), { recursive: true }); await writeFile(join(dir, '.git'), `gitdir: ${gitdir.replace(/\\/g, '/')}\n`);
  };
  // Claude Code кладёт worktree внутрь репозитория, Codex — в свою папку.
  for (const [dir, name] of [[join(repo, '.claude', 'worktrees', 'wt'), 'wt'], [join(outside, 'repo'), 'codex']]) {
    await worktree(dir, name);
    r = await h.run(['context', '--brief'], join(dir, 'src'));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^# Карта\nРевизия: 0\n/);
    r = await h.run(['init'], dir);
    assert.equal(r.out.trim(), `Проект «Репозиторий» уже подключён: ${h.url}/#/p/${id}`, r.err);
  }
  // Подмодуль: gitdir в .git/modules, без commondir.
  const sub = join(repo, 'lib');
  await mkdir(join(repo, '.git', 'modules', 'lib'), { recursive: true }); await mkdir(sub);
  await writeFile(join(sub, '.git'), 'gitdir: ../.git/modules/lib\n');
  r = await h.run(['init'], sub);
  assert.equal(r.out.trim(), `Проект «lib» подключён: ${h.url}/#/p/lib`, r.err);
  assert.equal((await h.api('/api/projects')).body.projects.length, 2);
});

test('a command outside connected folders says how to connect; a moved project is re-bound with --project', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Перенос'), moved = `${dir}-moved`;
  t.after(() => clean(moved));
  await rename(dir, moved);
  let r = await h.run(['projects']);
  assert.equal(r.out.trim(), `${id} · Перенос · ${dir} (папки нет)`);
  r = await h.run(['context'], moved);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), `Папка не подключена к Mycel: ${moved}. Выполните mycel init в корне проекта.`);
  r = await h.run(['init', '--project', id], moved);
  assert.equal(r.out.trim(), `Проект «Перенос» теперь в папке ${moved}`, r.err);
  r = await h.run(['context'], moved);
  assert.equal(r.code, 0, r.err);
  r = await h.run(['graph', '--project', id]);
  assert.equal(JSON.parse(r.out).revision, 0);
});

test('a project deleted by the human ends wait and every command; only init --new connects the folder again', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Удаляемый');
  const waiting = h.run(['wait', '--timeout', '30'], dir);
  await until(async () => (await h.api('/api/projects')).body.projects.find(p => p.id === id)?.agents.some(a => a.actor === 'tester' && a.waiting));
  assert.equal((await h.api(`/api/projects/${id}/delete`, {})).status, 200);
  const text = 'Проект «Удаляемый» удалён человеком. Подключайте заново только по его просьбе: mycel init --new.';
  let r = await waiting;
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), text);
  for (const args of [['context'], ['init'], ['doing', 'читаю'], ['wait', '--timeout', '5']]) {
    r = await h.run(args, dir);
    assert.deepEqual([r.code, r.err.trim()], [1, text], args.join(' '));
  }
  r = await h.run(['init', '--new'], dir);
  assert.equal(r.code, 0, r.err);
  assert.notEqual(idOf(r.out), id);
});

test('build writes step by step and ends with the same map as --at-once', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-');
  const live = await connected(h, 'По шагам'), once = await connected(h, 'Одним пакетом');
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
  assert.match(r.out, /^Записано, ревизии 1–3\.\n/);
  assert.ok(r.out.includes('Блоки (id — название):\n- interfeys — Интерфейс\n- hab — Хаб\n  - reestr — Реестр\n  - karta — Карта\n    - zapisat — Записать'), r.out);
  r = await h.run(['build', join(work, 'concepts.json'), '--at-once'], once.dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Записано, ревизия 1\.\n/);
  const first = await same('концепции');
  assert.deepEqual((await h.api(`/api/p/${live.id}/history`)).body.history.map(e => e.message).reverse(), ['Концепции (шаг 1 из 3)', 'Концепции (шаг 2 из 3)', 'Концепции (шаг 3 из 3)']);
  assert.ok(['interfeys-note-1', 'hab-note-1', 'note-1'].every(id => first.nodes.some(n => n.id === id)), 'постоянные id заметок');
  // Механика двух концепций: концепции растут и раздвигают соседей, итог тот же, что одним пакетом.
  for (const parent of ['interfeys', 'agenty']) {
    const path = await file(`${parent}.json`, mechanics(parent));
    for (const [p, extra] of [[live, []], [once, ['--at-once']]]) {
      r = await h.run(['build', path, ...extra], p.dir);
      assert.equal(r.code, 0, r.err);
    }
    await same(parent);
  }
  assert.equal((await graph(live)).revision, 5);
  assert.ok((await graph(live)).nodes.some(n => n.id === 'holst-2' && n.parentId === 'agenty' && n.collapsed));
});

test('the same build after an interrupted one adds only what is missing', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-');
  const resumed = await connected(h, 'Повтор'), once = await connected(h, 'Сразу');
  const full = join(work, 'full.json'), part = join(work, 'part.json');
  await writeFile(full, JSON.stringify(concepts));
  // Как если бы build оборвался после первого шага: записаны концепции с заметками и их связи, но не подкарты.
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
  assert.match(r.out, /^Всё из структуры уже есть на карте\.\n/);
  assert.equal((await h.api(`/api/p/${resumed.id}/graph`)).body.revision, a.revision);
  // Явный id, занятый другим блоком, — ошибка, как и раньше.
  await writeFile(part, JSON.stringify({ blocks: [{ id: 'hab', title: 'Другой хаб' }] }));
  r = await h.run(['build', part], resumed.dir);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'id «hab» уже занят на карте или в структуре.');
  // Ошибка в структуре видна до записи, без трассировки.
  await writeFile(part, JSON.stringify({ blocks: [{ title: 'Цвет', color: 'pink' }] }));
  r = await h.run(['build', part], resumed.dir);
  assert.deepEqual([r.code, r.err.trim()], [1, 'Неизвестный цвет узла «tsvet».']);
});

test('a foreign edit between steps is built over; a removed container stops the build, the same build then finishes it', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), path = join(work, 'concepts.json');
  await writeFile(path, JSON.stringify(concepts));
  const ids = ['agenty', 'hab', 'hab-note-1', 'interfeys', 'interfeys-note-1', 'karta', 'kursor', 'note-1', 'ozhidanie', 'prochitat', 'proverka', 'reestr', 'zapisat'];
  const graph = async p => (await h.api(`/api/p/${p.id}/graph`)).body;
  // Правка человека сразу после первого шага: следующий build пишет через 200 мс.
  const between = async (p, operations) => {
    for (const end = Date.now() + 5000; (await graph(p)).revision < 1; await new Promise(r => setTimeout(r, 10))) if (Date.now() > end) assert.fail('Первый шаг не записан');
    assert.equal((await h.api(`/api/p/${p.id}/changes`, { expectedRevision: 1, actor: 'human', message: 'Правка человека', operations })).status, 200);
  };
  const over = await connected(h, 'Поверх');
  let [r] = await Promise.all([h.run(['build', path], over.dir), between(over, [{ type: 'add-node', node: { id: 'chuzhoy', title: 'Чужой', x: -2000, y: -2000 } }])]);
  assert.equal(r.code, 0, r.err);
  // Чужая правка — первой строкой вывода, до записи поверх неё; в «Записано» только свои ревизии.
  assert.match(r.out, /^Пока шла запись, карту изменили:\nИзменения карты после ревизии 1, сейчас ревизия 2:\n- r2 human, [^\n]*: Правка человека — Добавлен блок «Чужой»\n/);
  assert.ok(r.out.includes('\nЗаписано, ревизии 1, 3–4.\n'), r.out);
  assert.equal(r.out.indexOf('r2 human'), r.out.lastIndexOf('r2 human'), r.out);
  assert.deepEqual((await graph(over)).nodes.map(n => n.id).sort(), [...ids, 'chuzhoy'].sort());
  const stopped = await connected(h, 'Остановлен');
  [r] = await Promise.all([h.run(['build', path], stopped.dir), between(stopped, [{ type: 'delete-node', id: 'hab' }])]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^Записан шаг 1 из 3\.\n/);
  assert.ok(r.out.includes('Удалено: блок «Хаб» (hab)') && r.out.trim().endsWith('Повторите тот же build: уже записанные блоки будут пропущены.'), r.out);
  r = await h.run(['build', path], stopped.dir);
  assert.equal(r.code, 0, r.err);
  const done = await graph(stopped);
  assert.deepEqual(done.nodes.map(n => n.id).sort(), ids);
  assert.equal(done.edges.length, concepts.links.length);
  assert.deepEqual(overlaps(done), []);
});

const advice = 'Уровни «Концепция» и «Механика» читают люди без программирования: код, файлы и имена переменных — в подкарту, на уровень «Техника»; исправь файл и повтори.';
test('build refuses code and long texts at Концепция and Механика before the first step; a repeated build checks only what it adds', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), { dir, id } = await connected(h, 'Уровни');
  const file = async (name, spec) => { const path = join(work, name); await writeFile(path, JSON.stringify(spec)); return path; };
  const revision = async () => (await h.api(`/api/p/${id}/graph`)).body.revision;
  // Как строил агент по прежней инструкции: технические названия и тексты на концепции и механике. Техника — можно.
  const title = 'Бот, диспетчер и обработчики сообщений на aiogram';
  const technical = {
    blocks: [{ title, text: '`handle_message()` в `bot/handlers.py` ловит сообщения',
      blocks: [{ title: 'Ключи', text: 'Читает BOT_TOKEN из .env', blocks: [{ title: 'Запрос', text: '`get_response()` в `ai_service.py`' }] }] },
    { title: 'Ответ', text: 'Ученик получает ответ' }],
    links: [[title, 'Ответ', 'OPENAI_API_KEY']]
  };
  const path = await file('technical.json', technical);
  let r = await h.run(['build', path], dir);
  assert.deepEqual([r.code, r.out], [1, '']);
  assert.equal(r.err.trim(), ['Запись отклонена, ничего не записано:',
    `- блок «${title}» (концепция), название: длиннее 40 символов (${title.length})`,
    `- блок «${title}» (концепция), текст: код в обратных кавычках «\`handle_message()\`»; код в обратных кавычках «\`bot/handlers.py\`»`,
    '- блок «Ключи» (механика), текст: файл «.env»; имя из кода «BOT_TOKEN»',
    `- связь «${title}» → «Ответ» (концепция), подпись: имя из кода «OPENAI_API_KEY»`, advice].join('\n'));
  assert.equal(await revision(), 0, 'ничего не записано');
  // По просьбе человека — без проверки. Повтор с новым простым блоком проверяет только его: записанное пропускается.
  r = await h.run(['build', path, '--no-check'], dir);
  assert.equal(r.code, 0, r.err);
  const written = await revision();
  r = await h.run(['build', await file('more.json', { ...technical, blocks: [...technical.blocks, { title: 'Фото', text: 'Если прислать фото, бот молчит' }] })], dir);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith(`Записано, ревизия ${written + 1}.\n- Добавлен блок «Фото»\n`), r.out);
  r = await h.run(['build', await file('worse.json', { blocks: [{ title: 'Ещё', text: 'Вызывает getResponse' }] })], dir);
  assert.deepEqual([r.code, r.err.trim().split('\n')[1]], [1, '- блок «Ещё» (концепция), текст: имя из кода «getResponse»']);
  assert.equal(await revision(), written + 1);
});

test('apply checks what it adds or changes at Концепция and Механика by the map the agent read; context gives edge ids', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), { dir, id } = await connected(h, 'Правки');
  const file = async (name, value) => { const path = join(work, name); await writeFile(path, JSON.stringify(value)); return path; };
  const revision = async () => (await h.api(`/api/p/${id}/graph`)).body.revision;
  let r = await h.run(['build', await file('map.json', { blocks: [
    { id: 'bot', title: 'Бот', text: 'Отвечает ученикам в Telegram', blocks: [{ id: 'priem', title: 'Приём вопроса', text: 'Ученик пишет вопрос',
      blocks: [{ id: 'handler', title: 'Обработчик', text: '`handle_message()` в `bot/handlers.py`' }] }] },
    { id: 'ai', title: 'Ответ ИИ', text: 'OpenAI готовит ответ' }], links: [['bot', 'ai', 'вопрос']] })], dir);
  assert.equal(r.code, 0, r.err);
  r = await h.run(['context'], dir);
  const edge = /^- Бот \(bot\) → Ответ ИИ \(ai\): вопрос · id: (\S+)$/m.exec(r.out)?.[1];
  assert.ok(edge, r.out);
  const ops = [
    { type: 'update-node', id: 'bot', patch: { title: 'Бот на `aiogram`', color: 'blue' } },
    { type: 'update-node', id: 'handler', patch: { text: '`handle_message()` и `send_answer()` в `bot/handlers.py`' } },
    { type: 'add-node', node: { type: 'note', parentId: 'bot', attachedTo: 'priem', text: 'Ключ OPENAI_API_KEY лежит в `config.py`' } },
    { type: 'add-node', node: { parentId: 'handler', title: 'Проверить текст', text: '`message.text` бывает пустым' } },
    { type: 'update-edge', id: edge, patch: { label: 'BOT_TOKEN' } }
  ];
  const built = await revision();
  r = await h.run(['apply', await file('ops.json', { message: 'Технические подробности', operations: ops })], dir);
  assert.deepEqual([r.code, r.out], [1, '']);
  assert.equal(r.err.trim(), ['Запись отклонена, ничего не записано:',
    '- блок «Бот» (концепция), название: код в обратных кавычках «`aiogram`»',
    '- заметка «Ключ OPENAI_API_KEY лежит в `config.py`» (механика), текст: код в обратных кавычках «`config.py`»; имя из кода «OPENAI_API_KEY»',
    '- связь «Бот» → «Ответ ИИ» (концепция), подпись: имя из кода «BOT_TOKEN»', advice].join('\n'));
  assert.equal(await revision(), built);
  // Техника и код с кодом, механика простыми словами — записываются; связь меняется по id из context.
  r = await h.run(['apply', await file('plain.json', [ops[1], ops[3], { type: 'add-node', node: { type: 'note', parentId: 'bot', attachedTo: 'priem', text: 'Если прислать фото, бот молчит' } },
    { type: 'update-edge', id: edge, patch: { label: 'вопрос ученика' } }]), '-m', 'Простые слова'], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal((await h.api(`/api/p/${id}/graph`)).body.edges.find(e => e.id === edge).label, 'вопрос ученика');
  r = await h.run(['apply', join(work, 'ops.json'), '--no-check'], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(await revision(), built + 2);
  // Карту изменили после чтения агента: вместо проверки и записи — изменения.
  assert.equal((await h.api(`/api/p/${id}/changes`, { expectedRevision: built + 2, actor: 'human', message: 'Правка человека', operations: [{ type: 'update-node', id: 'ai', patch: { text: 'Ответ готовит OpenAI' } }] })).status, 200);
  r = await h.run(['apply', join(work, 'ops.json')], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /^Карта изменилась после вашего последнего чтения\./);
  assert.equal(await revision(), built + 3);
});

test('doing shows what the agent is doing, show moves the human to a block, selection tells what the human means', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), { dir, id } = await connected(h, 'Без чата'), p = path => `/api/p/${id}${path}`;
  await writeFile(join(work, 'b.json'), JSON.stringify({ blocks: [{ id: 'korzina', title: 'Корзина', text: 'Покупатель собирает товары', blocks: [{ id: 'summa', title: 'Сумма', text: 'Корзина считает итог' }] }] }));
  assert.equal((await h.run(['build', join(work, 'b.json'), '--at-once'], dir)).code, 0);
  let r = await h.run(['doing', 'читаю `cart.ts`', '--progress', '40'], dir);
  assert.equal(r.out.trim(), 'Под картой: «читаю `cart.ts`», 40 %.');
  assert.deepEqual((await h.api(`/api/p/${id}/chat`)).body.agents.map(a => a.actor), ['tester']);
  assert.equal((await h.run(['doing', '--done'], dir)).out.trim(), 'Строка под картой снята.');
  assert.equal((await h.run(['doing'], dir)).code, 1);
  assert.equal((await h.run(['show', 'summa'], dir)).out.trim(), 'Показан человеку: «Сумма» (summa).');
  assert.equal((await h.run(['show', 'missing'], dir)).code, 1);
  // Человек выделил блок и работает внутри концепции: selection печатает оба с текстом, context — строку о выделенном.
  assert.equal((await h.run(['selection'], dir)).out.trim(), 'Человек ничего не выделил и ни в каком блоке не работает.');
  await h.api(p('/selection'), { id: 'summa' }); await h.api(p('/focus'), { id: 'korzina' });
  assert.equal((await h.run(['selection'], dir)).out.trim(), 'Выделено: «Сумма» (summa) — блок внутри «Корзина» (korzina)\nКорзина считает итог\n\nРаботает в блоке: «Корзина» (korzina) — блок на основной карте\nПокупатель собирает товары');
  assert.match((await h.run(['context', '--brief'], dir)).out, /Человек выделил на карте блок «Сумма» \(summa\)/);
  // Чата нет: прежних команд переписки тоже.
  for (const gone of ['say', 'log', 'chat', 'status', 'progress']) assert.equal((await h.run([gone, 'x'], dir)).code, 1, gone);
});

test('what context and wait printed counts as read even when the reader cuts the output short', async t => {
  const h = await hubFixture(t), dir = await h.folder();
  const id = idOf((await h.run(['init', '--name', 'Обрезка'], dir)).out), cursor = async () => (await h.api(`/api/p/${id}/cursor?actor=tester`)).body;
  let r = await h.cut(['context'], dir);
  assert.match(r.out, /^# Карта/);
  assert.deepEqual(await cursor(), { revision: 0, chat: 0 });
  // Человек добавил блок и нажал «Закончить правки».
  await h.api(`/api/p/${id}/changes`, { expectedRevision: 0, actor: 'human', message: 'Правка', operations: [{ type: 'add-node', node: { id: 'x', title: 'Новый', x: 0, y: 0 } }] });
  await h.api(`/api/p/${id}/edits`, {});
  r = await h.cut(['wait', '--timeout', '10'], dir);
  assert.match(r.out, /^Человек в Mycel:/);
  assert.deepEqual(await cursor(), { revision: 1, chat: 1 });
  r = await h.run(['changes'], dir);
  assert.equal(r.out.trim(), 'Других изменений нет, ревизия 1.');
});

test('context prints what the human did in Mycel while the agent was not waiting; human edits are held until «Закончить правки»', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Правки'), p = path => `/api/p/${id}${path}`;
  // Человек правит карту: changes говорит об этом, wait на его правки не просыпается.
  const human = { expectedRevision: 0, actor: 'human', message: 'Правка человека', operations: [{ type: 'add-node', node: { id: 'x', title: 'Новый', x: 0, y: 0 } }] };
  assert.equal((await h.api(p('/changes'), human)).status, 200);
  assert.match((await h.run(['changes'], dir)).out, /Человек сейчас правит карту \(с ревизии 0, записей: 1\)/);
  assert.equal((await h.run(['wait', '--timeout', '2'], dir)).code, 2);
  // «Закончить правки» будит, и правки приходят целиком, хотя changes их уже показывал.
  assert.equal((await h.api(p('/edits'), {})).status, 200);
  let r = await h.run(['wait', '--timeout', '5'], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Человек в Mycel:\n- m1 · Человек · [^\n]*: правки карты готовы — его записи после ревизии 0 \(до 1\), всего 1/);
  assert.match(r.out, /Добавлено:\n### Новый \(id: x\)/);
  assert.doesNotMatch(r.out, /сейчас правит/);
  // То, что человек сделал, пока агент не ждал, печатает и context — один раз.
  const again = { expectedRevision: 1, actor: 'human', message: 'Правка человека', operations: [{ type: 'update-node', id: 'x', patch: { text: 'текст' } }] };
  assert.equal((await h.api(p('/changes'), again)).status, 200);
  assert.equal((await h.api(p('/edits'), {})).status, 200);
  r = await h.run(['context'], dir);
  assert.match(r.out, /## Человек в Mycel:\n- m2 · Человек · [^\n]*: правки карты готовы/);
  assert.doesNotMatch((await h.run(['context'], dir)).out, /Человек в Mycel/);
});
test('propose lays the guide example on the map for the human to decide, mark sets test results; the decision wakes wait', async t => {
  const h = await hubFixture(t), work = await h.folder('mycel-cli-files-'), { dir, id } = await connected(h, 'Магазин');
  const file = async (name, value) => { const p = join(work, name); await writeFile(p, JSON.stringify(value)); return p; };
  assert.equal((await h.run(['build', await file('b.json', { blocks: [{ id: 'korzina', title: 'Корзина', text: 'Покупатель собирает товары',
    blocks: [{ id: 'kladet', title: 'Положить товар', text: 'Товар попадает в корзину' }, { id: 'summa', title: 'Сумма', text: 'Корзина считает итог' }] }] }), '--at-once'], dir)).code, 0);
  // Пример из инструкции агенту.
  let r = await h.run(['propose', await file('p.json', { title: 'Промокоды в корзине', parent: 'korzina',
    blocks: [{ id: 'promo', title: 'Промокод', text: 'Покупатель вводит код и получает скидку' }], links: [['promo', 'summa', 'скидка']],
    operations: [{ type: 'update-node', id: 'summa', patch: { text: 'Сумма считается со скидкой' } }, { type: 'delete-node', id: 'kladet' }] })], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /- Добавлен блок «Промокод»\n- Добавлена связь «Промокод» → «Сумма»\n- Изменён блок «Сумма»\n- Предложено удалить блок «Положить товар»/);
  assert.match(r.out, /Предложение «Промокоды в корзине» на карте/);
  // Проверка уровней работает и для предложения; без названия первое предложение не открыть.
  assert.equal((await h.run(['propose', await file('bad.json', { blocks: [{ title: 'handle_message()', text: 'x' }] })], dir)).code, 1);
  assert.match((await h.run(['context', '--brief'], dir)).out, /ID: promo \| уровень: механика \| внутри: korzina \| план, кода нет \| предложено: добавить/);
  assert.match((await h.run(['mark', 'summa', 'testing'], dir)).out, /Отмечен блок «Сумма»: идёт проверка/);
  r = await h.run(['mark', 'summa,korzina', 'passed'], dir);
  assert.match(r.out, /Отмечен блок «Сумма»: проверен\n- Отмечен блок «Корзина»: проверен/);
  assert.equal((await h.run(['mark', 'summa', 'green'], dir)).code, 1);
  // Человек принимает; ожидание агента просыпается с решением и подсказкой, что делать дальше.
  assert.equal((await h.api(`/api/p/${id}/proposal/accept`, {})).status, 200);
  r = await h.run(['wait', '--timeout', '5'], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /принял предложение «Промокоды в корзине»\. Принятые блоки — план \(пунктир\)/);
  assert.match(r.out, /Удалено: блок «Положить товар» \(kladet\)/);
  const graph = (await h.api(`/api/p/${id}/graph`)).body;
  assert.deepEqual(graph.nodes.map(n => [n.id, n.status ?? null, n.proposed ?? null]), [['korzina', 'passed', null], ['summa', 'passed', null], ['promo', 'plan', null]]);
});

test('guide renders the command of this computer without a running Mycel', async t => {
  const data = await temp('mycel-cli-data-'), url = `http://127.0.0.1:${await freePort()}`, slash = p => p.replace(/\\/g, '/');
  t.after(() => clean(data));
  const r = await mycel(['guide'], { data, url });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(`- PowerShell: \`& "${slash(process.execPath)}" "${slash(script)}" --url ${url} <команда>\``), r.out);
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
    [json({ ok: true, revision: 3 }), url => `На ${url} работает старая версия Mycel: остановите её.`],
    [res => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html></html>'); }, url => `На ${url} отвечает не Mycel.`],
    [json({ ok: true, app: 'mycel', version, data: other }), url => `На ${url} работает Mycel с другими данными: ${other}`],
    [json({ ok: true, app: 'mycel', version: '0.0.1', data }), () => `Mycel обновлён: перезапустите его ("${process.execPath}" "${script}" stop, затем ${launcher}).`],
    // До 0.15 программа называлась Контур: её хаб — прежняя версия, а не чужая программа.
    [json({ ok: true, app: 'kontur', version: '0.14.0', data }), () => `Mycel обновлён: перезапустите его ("${process.execPath}" "${script}" stop, затем ${launcher}).`]
  ];
  for (const [answer, text] of cases) {
    const url = await fake(answer), r = await mycel(['projects'], { data, url });
    assert.deepEqual([r.code, r.err.trim()], [1, text(url)]);
  }
  const url = `http://127.0.0.1:${await freePort()}`;
  let r = await mycel(['projects'], { data, url });
  assert.deepEqual([r.code, r.err.trim()], [1, `Mycel не запущен. Попросите человека открыть ${launcher}.`]);
  r = await mycel(['stop'], { data, url });
  assert.deepEqual([r.code, r.out.trim()], [0, 'Mycel не запущен.']);
  r = await mycel(['projects'], { data, url: 'http://example.com:4317' });
  assert.deepEqual([r.code, r.err.trim()], [1, 'Mycel работает на этом компьютере или в локальной сети (основная машина для виртуальной): ключ не отправляется на другие адреса.']);
});

// Единственный тест, где Mycel запускается сам, отдельным фоновым процессом: после него он останавливается командой,
// а если не вышло — по pid из server.lock.
test('a command starts Mycel in the background when it is not running; open replaces an older version; stop ends it', async t => {
  const data = await temp('mycel-cli-auto-'), url = `http://127.0.0.1:${await freePort()}`, old = await temp('mycel-cli-old-'), empty = await temp('mycel-cli-path-');
  let previous = null;
  t.after(async () => {
    previous?.kill();
    await mycel(['stop'], { data, url });
    const pid = await readFile(join(data, 'server.lock'), 'utf8').then(text => JSON.parse(text).pid, () => null);
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) try { process.kill(pid); } catch { /* уже завершился */ }
    await clean(data, old, empty);
  });
  let r = await mycel(['start'], { data, url, start: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err.trim(), `Запущен Mycel: ${url}`);
  assert.equal(r.out.trim(), `Mycel: ${url}`);
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.deepEqual([health.app, health.version, health.data], ['mycel', version, data]);
  const lock = JSON.parse(await readFile(join(data, 'server.lock'), 'utf8'));
  assert.ok(lock.pid !== process.pid && lock.port === Number(new URL(url).port));
  assert.match(await readFile(join(data, 'server.log'), 'utf8'), /Mycel → /);
  r = await mycel(['start'], { data, url, start: true });
  assert.deepEqual([r.code, r.err], [0, ''], 'второй раз не запускается');
  r = await mycel(['stop'], { data, url });
  assert.equal(r.out.trim(), `Mycel остановлен: ${url}.`, r.err);
  assert.equal(await fetch(`${url}/api/health`).then(() => true, () => false), false);
  await assert.rejects(readFile(join(data, 'server.lock')), { code: 'ENOENT' });
  // Код обновили, а работает Mycel прежней версии с теми же данными: open (двойной клик по Mycel.cmd) сменяет его
  // текущим. Браузер в тесте не открывается: в PATH нет ни cmd.exe, ни open, ни xdg-open.
  await cp(join(appRoot, 'src'), join(old, 'src'), { recursive: true }); await cp(join(appRoot, 'server.mjs'), join(old, 'server.mjs'));
  await writeFile(join(old, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.1' }));
  previous = spawn(process.execPath, [join(old, 'server.mjs'), '--port', new URL(url).port, '--data', data], { stdio: 'ignore', windowsHide: true });
  const exited = once(previous, 'exit');
  await until(async () => (await fetch(`${url}/api/health`).then(res => res.json(), () => null))?.version === '0.0.1');
  r = await mycel(['open'], { data, url, start: true, env: { PATH: empty } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.err.trim(), r.out.trim()], [`Остановлен Mycel 0.0.1.\nЗапущен Mycel: ${url}`, `Mycel: ${url}/`]);
  await exited;
  assert.equal((await (await fetch(`${url}/api/health`)).json()).version, version);
  r = await mycel(['stop'], { data, url });
  assert.equal(r.out.trim(), `Mycel остановлен: ${url}.`, r.err);
});

test('mycel.mjs parses as ES2020, so on an old Node the version check runs instead of a syntax error', t => {
  // Разбор тем же acorn, что внутри Node; на Node без него проверка пропускается.
  const parse = spawnSync(process.execPath, ['--expose-internals', '-e', `
    let acorn; try { acorn = require('internal/deps/acorn/acorn/dist/acorn'); } catch { process.exit(3); }
    acorn.parse(require('fs').readFileSync(process.argv[1], 'utf8'), { ecmaVersion: 2020, sourceType: 'module', allowAwaitOutsideFunction: true });`, script], { encoding: 'utf8' });
  if (parse.status === 3) return t.skip('в этой версии Node нет встроенного acorn');
  assert.equal(parse.status, 0, parse.stderr);
});

// Карта, которая не устаревает: у блоков файлы и команда проверки. Хук Claude Code после правки файла отмечает его блок
// «правится сейчас» и «возможно устарел»; в конце ответа напоминает описать блок, в начале сессии даёт обзор карты.
test('a hook after a file edit marks its block as edited and stale; describing the block again or fresh clears it', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Код');
  const spec = { message: 'Карта кода', blocks: [{ id: 'core', title: 'Ядро', text: 'Сервер и данные.', blocks: [
    { id: 'srv', title: 'Сервер', text: 'Отвечает на запросы.', files: ['server.mjs', 'lib/'], test: 'node -e "process.exit(0)"' },
    { id: 'ui', title: 'Интерфейс', text: 'Рисует карту.', files: ['public\\app.js'], test: 'node -e "process.exit(3)"' }] }] };
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
  // Файл вне проекта и файл без блока ничего не отмечают.
  await h.hook(event('PostToolUse', { tool_input: { file_path: join(tmpdir(), 'x.js') } }));
  await h.hook(event('PostToolUse', { tool_input: { file_path: join(dir, 'README.md') } }));
  assert.equal((await h.api(`/api/p/${id}/code`)).body.stale.length, 1);
  r = await h.run(['context', '--brief'], dir);
  assert.match(r.out, /Возможно устарели \(их файлы изменили после того, как блок описали\): «Сервер» \(srv\) — lib\/a\.js/);
  assert.match(r.out, /ID: srv \| уровень: механика \| внутри: core \| возможно устарел/);
  assert.match(r.out, /Файлы: server\.mjs, lib\/\n\nПроверка: `node -e "process\.exit\(0\)"`/);
  assert.match(r.out, /Сейчас работают: tester — «Сервер» \(srv\)/);
  // Конец ответа: напоминание только той сессии, что меняла файлы, и не повторно подряд.
  r = await h.hook(event('Stop'));
  const stop = JSON.parse(r.out);
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /«Сервер» \(srv\).*mycel fresh srv/);
  assert.equal((await h.hook(event('Stop', { stop_hook_active: true }))).out, '');
  assert.equal((await h.hook(event('Stop', { session_id: 's2' }))).out, '');
  // Начало сессии: обзор карты вместо чтения всего кода.
  r = await h.hook(event('SessionStart', { source: 'startup' }));
  const start = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(start.hookEventName, 'SessionStart');
  assert.match(start.additionalContext, /у проекта «Код» есть карта устройства — 3 блока/);
  assert.match(start.additionalContext, /- «Ядро» \(core\) — Сервер и данные\.\n  - «Сервер» \(srv\) — Отвечает на запросы\./);
  assert.match(start.additionalContext, /Возможно устарели \(файлы изменили после описания\): «Сервер» \(srv\)/);
  // Другой агент берётся за тот же блок — его предупреждают.
  r = await h.run(['touch', 'server.mjs'], dir, { MYCEL_ACTOR: 'codex' });
  assert.match(r.out, /Блок «Сервер» \(srv\) сейчас делает tester\./);
  r = await h.run(['doing', 'правлю интерфейс', '--on', 'ui,srv'], dir, { MYCEL_ACTOR: 'codex' });
  assert.match(r.out, /Блок «Сервер» \(srv\) сейчас делает tester/);
  // Агент описал блок заново — пометка снята; fresh подтверждает описание без правки.
  r = await h.run(['context'], dir);
  await writeFile(join(dir, 'ops.json'), JSON.stringify([{ type: 'update-node', id: 'srv', patch: { text: 'Отвечает на запросы и пишет журнал.' } }]));
  r = await h.run(['apply', 'ops.json'], dir);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual((await h.api(`/api/p/${id}/code`)).body.stale, []);
  await h.run(['touch', 'public/app.js'], dir);
  r = await h.run(['fresh', 'ui'], dir);
  assert.equal(r.out.trim(), 'Описание подтверждено, пометка «устарел» снята: ui.');
  assert.deepEqual((await h.api(`/api/p/${id}/code`)).body.stale, []);
  // Хук молчит, если папка не подключена или Mycel не запущен.
  const other = await h.folder();
  assert.deepEqual(await h.hook({ hook_event_name: 'SessionStart', cwd: other }).then(x => [x.code, x.out]), [0, '']);
  assert.deepEqual(await mycel(['hook'], { cwd: dir, data: h.url, url: `http://127.0.0.1:${await freePort()}`, input: JSON.stringify(event('SessionStart')) }).then(x => [x.code, x.out, x.err]), [0, '', '']);
});

test('check runs the test commands of blocks and marks them live; the human asks for a check with a button', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Проверка');
  await writeFile(join(dir, 'map.json'), JSON.stringify({ blocks: [{ id: 'core', title: 'Ядро', blocks: [
    { id: 'srv', title: 'Сервер', test: 'node -e "process.exit(0)"' }, { id: 'api', title: 'API', test: 'node -e "process.exit(0)"' },
    { id: 'ui', title: 'Интерфейс', test: 'node -e "console.log(\'упало тут\'); process.exit(3)"' }, { id: 'docs', title: 'Документы' }] }] }));
  assert.equal((await h.run(['build', 'map.json', '--at-once'], dir)).code, 0);
  let r = await h.run(['check'], dir);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /Проверен: «Сервер» \(srv\), «API» \(api\) — `node -e "process\.exit\(0\)"`/);
  assert.match(r.out, /Проверка не прошла: «Интерфейс» \(ui\) — `.*` \(код 3\)\nупало тут/);
  const status = async () => Object.fromEntries((await h.api(`/api/p/${id}/graph`)).body.nodes.filter(n => n.status).map(n => [n.id, n.status]));
  assert.deepEqual(await status(), { srv: 'passed', api: 'passed', ui: 'failed' });
  // Прогон виден по ходу: сначала «идёт проверка», потом итог каждой команды.
  const history = (await h.api(`/api/p/${id}/history`)).body.history.map(e => e.message).reverse().slice(-3);
  assert.deepEqual(history, ['Проверка идёт', 'Проверка: проверен', 'Проверка: проверка не прошла']);
  r = await h.run(['check', 'srv'], dir);
  assert.deepEqual([r.code, r.out.trim()], [0, 'Проверен: «Сервер» (srv) — `node -e "process.exit(0)"`']);
  r = await h.run(['check', 'docs'], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /У этих блоков и вложенных в них нет команды проверки/);
  // После check запись агента идёт без конфликта: прочитанное сдвинулось на свои отметки.
  await writeFile(join(dir, 'ops.json'), JSON.stringify([{ type: 'update-node', id: 'docs', patch: { text: 'README' } }]));
  assert.equal((await h.run(['apply', 'ops.json'], dir)).code, 0);
  // Человек нажал «Проверить» — агент узнаёт об этом в wait и changes.
  assert.equal((await h.api(`/api/p/${id}/check`, { ids: ['ui'] })).status, 200);
  r = await h.run(['changes'], dir);
  assert.match(r.out, /Человек · .*: просит проверить «Интерфейс» \(ui\)\. Выполни mycel check ui/);
  assert.equal((await h.api(`/api/p/${id}/check`, { ids: ['nope'] })).status, 400);
});

test('review tells what changed by concept; health finds red, stale, untested blocks and risks without printing them', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Здоровье');
  await mkdir(join(dir, 'lib'));
  await writeFile(join(dir, 'lib', 'a.js'), "// TODO: убрать\nconst key = 'sk-abcdefghijklmnopqrstuvwxyz123456';\n");
  await writeFile(join(dir, 'lib', '.env'), "TOKEN='sk-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'\n");
  await writeFile(join(dir, 'map.json'), JSON.stringify({ blocks: [{ id: 'core', title: 'Ядро', blocks: [
    { id: 'srv', title: 'Сервер', files: ['lib/'] }, { id: 'ui', title: 'Интерфейс', status: 'failed' }, { id: 'pay', title: 'Оплата', status: 'plan' }] }] }));
  assert.equal((await h.run(['build', 'map.json', '--at-once'], dir)).code, 0);
  let r = await h.run(['review', '--hours', '1'], dir);
  assert.match(r.out, /^Что изменилось с ревизии 0 по \d+ \(с .*\): записей \d+, агенты: tester\.\n\n«Ядро»\n- новая концепция\n- добавлен блок «Сервер»\n- добавлен блок «Интерфейс»\n- добавлен блок «Оплата» \(план, кода нет\)/);
  assert.match(r.out, /\n\nПроверка не прошла: «Интерфейс»\.\n$/);
  r = await h.run(['context'], dir);
  r = await h.run(['mark', 'ui', 'passed'], dir);
  const since = (await h.api(`/api/p/${id}`)).body.project.revision - 1;
  r = await h.run(['review', '--since', String(since)], dir);
  assert.match(r.out, /«Ядро»\n- изменён блок «Интерфейс»: проверен\n\nПроверено: «Интерфейс»\./);
  await h.run(['touch', 'lib/a.js'], dir);
  r = await h.run(['health'], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Возможно устарели \(файлы изменили после описания\):\n- «Сервер» \(srv\) — lib\/a\.js/);
  assert.match(r.out, /Без проверки \(есть файлы, нет команды test и отметки «проверен»\):\n- «Сервер» \(srv\)/);
  assert.match(r.out, /План \(кода нет\):\n- «Оплата» \(pay\)/);
  assert.match(r.out, /Риски в файлах:\n- «Сервер» \(srv\): TODO 1, похоже на секрет 1 — lib\/a\.js:1 \(TODO 1\); lib\/a\.js:2 \(похоже на ключ или пароль\)/);
  assert.doesNotMatch(r.out, /sk-|убрать/);
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
  assert.deepEqual(hooks.PostToolUse[0], { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: slash(process.execPath), args: [slash(script), 'hook', '--url', h.url], timeout: 30 }] });
  assert.match(await readFile(join(out, 'mycel', 'skills', 'mycel', 'SKILL.md'), 'utf8'), /^---\nname: mycel\ndescription: /);
  assert.match(r.out, /claude plugin install mycel@mycel-local --scope user/);
});

// Копия Mycel в виртуальной машине: join с ключом сохраняет адрес, ключ и проект, дальше команды работают из любой
// папки без --url. 127.0.0.2 — второй адрес вместо сети VMware; настоящий порт 4317 не трогается.
test('a copy of Mycel in a virtual machine joins the host Mycel with the key and works with its project', async t => {
  const data = await temp('mycel-cli-host-'), vm = await temp('mycel-cli-vm-'), folder = await temp('mycel-cli-folder-'), work = await temp('mycel-cli-work-');
  const app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data, vm, folder, work); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, key = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('второго адреса loopback нет');
  const id = idOf((await mycel(['init', '--name', 'Хост'], { cwd: folder, data: app.data, url: app.url })).out);
  // Копия в виртуальной машине: свой каталог данных, адрес — только из join.
  const inVm = (args, cwd = work) => mycel(args, { cwd, data: vm, url: null });
  let r = await inVm(['join', far, 'x'.repeat(20)]);
  assert.deepEqual([r.code, r.err.trim()], [1, 'Ключ не подходит: попросите доступ заново — node mycel.mjs join <адрес> без ключа.']);
  r = await inVm(['join', 'http://8.8.8.8:4317', key]);
  assert.deepEqual([r.code, r.err.trim()], [1, 'Подключаться можно только к Mycel в локальной сети: ключ не отправляется на другие адреса.']);
  r = await inVm(['join', far, key, '--project', 'nope']);
  assert.match(r.err, /Проекта nope там нет\. Проекты: .*\(Хост\)/);
  // Адрес — и без http://, как его пишут люди.
  r = await inVm(['join', far.replace('http://', ''), key, '--project', id]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^Подключено к Mycel на ${far.replace(/\./g, '\\.')}, проект ${id}\\.`));
  assert.deepEqual(JSON.parse(await readFile(join(vm, 'remote.json'), 'utf8')), { url: far, token: key, project: id });
  r = await inVm(['context', '--brief']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# Карта\nРевизия: \d+/);
  r = await inVm(['guide']);
  assert.match(r.out, /Эта копия Mycel подключена к Mycel на другой машине/);
  for (const [args, text] of [[['init'], /Проект для папки этой машины создаёт машина со своим ключом/], [['stop'], /Это делается на основной машине/], [['remote', 'on'], /Это делается на основной машине/]]) {
    r = await inVm(args);
    assert.equal(r.code, 1); assert.match(r.err, text);
  }
  // Плагин в виртуальной машине берёт адрес и ключ из join: в его файлах их нет.
  const out = join(vm, 'plugin');
  assert.equal((await inVm(['plugin', '--out', out])).code, 0);
  const hooks = JSON.parse(await readFile(join(out, 'mycel', 'hooks', 'hooks.json'), 'utf8')).hooks.Stop[0].hooks[0];
  assert.deepEqual(hooks.args.slice(1), ['hook']);
  assert.equal(JSON.parse(await readFile(join(out, 'mycel', '.mcp.json'), 'utf8')).mcpServers.mycel.env, undefined);
  r = await inVm(['join', '--off']);
  assert.equal(r.out.trim(), 'Эта копия Mycel больше не подключена к другой машине.');
  await assert.rejects(readFile(join(vm, 'remote.json')), { code: 'ENOENT' });
});

// Агент в виртуальной машине подключается сам: join без ключа просит доступ, печатает код и ждёт; человек нажимает
// «Разрешить» — машина получает свой ключ и проект. remote на основной машине ключа не печатает.
test('join without a key asks for access, waits for the human to approve and gets its own key and project', async t => {
  const data = await temp('mycel-cli-host-'), vm = await temp('mycel-cli-vm-'), folder = await temp('mycel-cli-folder-'), work = await temp('mycel-cli-work-');
  const app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data, vm, folder, work); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(app.data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('второго адреса loopback нет');
  const id = idOf((await mycel(['init', '--name', 'Хост'], { cwd: folder, data: app.data, url: app.url })).out);
  const host = async (path, body) => (await fetch(app.url + path, body ? { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  const joining = mycel(['join', far.replace('http://', '')], { cwd: work, data: vm, url: null });
  let pending = [];
  await until(async () => (pending = (await host('/api/access')).pending).length === 1, 10000);
  await host(`/api/pair/${pending[0].id}/approve`, { project: id });
  const r = await joining;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`Код ${pending[0].code}: человек сверит его и нажмёт «Разрешить»[\\s\\S]*Подключено к Mycel на ${far.replace(/\./g, '\\.')}, проект ${id}\\.`));
  const saved = JSON.parse(await readFile(join(vm, 'remote.json'), 'utf8'));
  assert.deepEqual([saved.url, saved.project, saved.token === token, /^[0-9a-f]{64}$/.test(saved.token)], [far, id, false, true]);
  assert.match((await mycel(['context', '--brief'], { cwd: work, data: vm, url: null })).out, /^# Карта/);
  // Папку этой машины агент подключает сам: проект с пометкой машины, команды из неё находят его, из других — проект join.
  const hedwig = await temp('mycel-cli-hedwig-');
  t.after(() => clean(hedwig));
  let made = await mycel(['init', '--name', 'Hedwig'], { cwd: hedwig, data: vm, url: null });
  assert.equal(made.code, 0, made.err);
  const hid = idOf(made.out);
  assert.match(made.out, /^Проект «Hedwig» подключён: /);
  await writeFile(join(hedwig, 'map.json'), JSON.stringify({ blocks: [{ id: 'core', title: 'Ядро' }] }));
  assert.equal((await mycel(['context'], { cwd: hedwig, data: vm, url: null })).code, 0);
  assert.equal((await mycel(['build', 'map.json', '--at-once'], { cwd: hedwig, data: vm, url: null })).code, 0);
  assert.deepEqual((await host(`/api/p/${hid}/graph`)).nodes.map(n => n.id), ['core']);
  assert.deepEqual((await host(`/api/p/${id}/graph`)).nodes.map(n => n.id), [], 'проект join не тронут');
  const listed = await mycel(['projects'], { cwd: folder, data: app.data, url: app.url });
  assert.match(listed.out, new RegExp(`${hid} · Hedwig · .+ \\(на машине «.+»\\)`));
  const elsewhere = await mycel(['check', '--project', hid], { cwd: folder, data: app.data, url: app.url });
  assert.match(elsewhere.err, /Файлы проекта «Hedwig» — на машине «.+»: запускай это там\./);
  // remote на основной машине: машина с доступом и команда установки, ключа основной машины нет.
  const shown = await mycel(['remote'], { cwd: folder, data: app.data, url: app.url });
  assert.match(shown.out, /Машины с доступом \(remote revoke <id> — отозвать\):\n- [0-9a-f-]+ · /);
  assert.match(shown.out, new RegExp(`curl -fsS ${far.replace(/\./g, '\\.')}/install\\.sh \\| sh`));
  assert.ok(!shown.out.includes(token));
  assert.ok((await mycel(['remote', '--key'], { cwd: folder, data: app.data, url: app.url })).out.includes(token));
  // Отклонённый запрос: join сообщает об этом и выходит.
  const denied = mycel(['join', far], { cwd: work, data: join(vm, 'second'), url: null });
  await until(async () => (pending = (await host('/api/access')).pending).length === 1, 10000);
  await host(`/api/pair/${pending[0].id}/deny`, {});
  const d = await denied;
  assert.deepEqual([d.code, d.err.trim()], [1, 'Человек отклонил запрос доступа.']);
});

// Плагин обязателен: plugin --install подключает его через claude (повторно — безопасно) и убирает отдельный MCP-сервер.
// claude здесь — подставной скрипт, настоящий Claude Code не трогается.
test('plugin --install connects the plugin with claude and removes a separate mycel MCP server; without claude it prints the commands', async t => {
  const h = await hubFixture(t), out = await h.folder('mycel-cli-plugin-'), fake = join(out, 'fake-claude.mjs'), calls = join(out, 'calls.txt');
  await writeFile(fake, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n'); process.exit(process.argv[2] === 'mcp' ? 1 : 0);`);
  let r = await h.run(['plugin', '--install', '--out', join(out, 'p'), '--claude', fake], tmpdir());
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'Плагин Mycel подключён. Инструменты mycel_* и хуки появятся в новой сессии Claude Code: попроси человека начать её.');
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), [`plugin marketplace add ${join(out, 'p')} --scope user`, 'plugin install mycel@mycel-local --scope user', 'mcp remove mycel -s user']);
  r = await h.run(['plugin', '--install', '--out', join(out, 'q')], tmpdir(), { PATH: out });
  assert.equal(r.code, 1);
  assert.match(r.err, /Не нашёл claude: выполни команды подключения ниже сам\./);
  assert.match(r.out, /claude plugin install mycel@mycel-local --scope user/);
});

// Другие агенты: тот же MCP-сервер, запись для их файла настроек; адрес — переменной, если Mycel не на 4317.
test('plugin --agent prints the MCP server entry for another agent; plugin lists them all', async t => {
  const h = await hubFixture(t), slash = p => p.replace(/\\/g, '/'), node = slash(process.execPath), server = slash(join(appRoot, 'mcp.mjs'));
  // Вывод: строка о файле, пустая строка, запись, пустая строка, дальше — команда и хуки, если есть.
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
  assert.match(r.out, /Или командой: codex mcp add mycel --env MYCEL_URL=/);
  r = await h.run(['plugin', '--agent', 'nope'], tmpdir());
  assert.deepEqual([r.code, r.err.trim()], [1, 'Агенты: codex, cursor, antigravity, gemini, vscode, windsurf, cline, lmstudio, continue, goose, opencode, jan, openwebui, claude-desktop. Claude Code — node mycel.mjs plugin --install.']);
  const out = await h.folder('mycel-cli-plugin-');
  r = await h.run(['plugin', '--out', out], tmpdir());
  assert.match(r.out, /  cursor         Cursor — ~\/\.cursor\/mcp\.json/);
});

// Универсально: описания инструментов для любой модели с вызовом функций и вызов по имени — то же, что MCP.
test('tools exports the Mycel tools for function calling; call runs one by name with JSON arguments', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Инструменты');
  let r = await h.run(['tools'], dir);
  const list = JSON.parse(r.out);
  assert.ok(list.every(x => x.type === 'function' && x.function.parameters.type === 'object'));
  assert.ok(['mycel_context', 'mycel_build', 'mycel_touch', 'mycel_check'].every(name => list.some(x => x.function.name === name)));
  assert.ok(JSON.parse((await h.run(['tools', '--format', 'mcp'], dir)).out).some(x => x.name === 'mycel_check' && x.inputSchema.type === 'object'));
  assert.match((await h.run(['call', 'overview'], dir)).out, /у проекта «Инструменты» есть карта устройства/);
  r = await h.run(['call', 'mycel_build', JSON.stringify({ structure: { blocks: [{ id: 'core', title: 'Ядро' }] }, at_once: true })], dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual((await h.api(`/api/p/${id}/graph`)).body.nodes.map(n => n.id), ['core']);
  assert.match((await h.run(['guide', '--short'], dir)).out, /^# Mycel: коротко для агента/);
  r = await h.run(['call', 'nope'], dir);
  assert.deepEqual([r.code, r.err.trim()], [1, 'Нет инструмента nope. Список: node mycel.mjs tools.']);
});

// Слежение за файлами — для любого агента и правок в редакторе: изменённый файл блока отмечается сам.
test('watch marks changed files of blocks as edited and stale, whoever changed them', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Слежение');
  await mkdir(join(dir, 'lib')); await mkdir(join(dir, 'node_modules'));
  await writeFile(join(dir, 'map.json'), JSON.stringify({ blocks: [{ id: 'srv', title: 'Сервер', files: ['lib/'] }] }));
  assert.equal((await h.run(['build', 'map.json', '--at-once'], dir)).code, 0);
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MYCEL_|KONTUR_)|^(CLAUDECODE|CLAUDE_PID)$/i.test(k)));
  const child = spawn(process.execPath, [script, 'watch', '--url', h.url, '--no-start'], { cwd: dir, env: { ...own, MYCEL_DATA: h.data }, windowsHide: true });
  // Слежение не завершается само и держит папку: остановить его до того, как папки удаляются, иначе прогон не закончится.
  const stop = () => { child.stdout.destroy(); child.stderr.destroy(); child.kill(); child.unref(); };
  let out = '';
  child.stdout.setEncoding('utf8').on('data', c => { out += c; });
  child.stderr.setEncoding('utf8').on('data', c => { out += c; });
  try {
    await until(async () => out.includes('Слежу за'), 10000);
    await writeFile(join(dir, 'node_modules', 'x.js'), '1');
    await writeFile(join(dir, 'lib', '.env'), 'KEY=1');
    // Windows начинает слать события не сразу после запуска слежения: файл пишется заново, пока его не заметят.
    let stale = [];
    for (let i = 0; i < 40 && !stale.length; i++) {
      if (i % 4 === 0) await writeFile(join(dir, 'lib', 'a.js'), `console.log(${i})`);
      await new Promise(r => setTimeout(r, 250));
      stale = (await h.api(`/api/p/${id}/code`)).body.stale;
    }
    assert.deepEqual(stale.map(s => [s.id, s.by, s.files]), [['srv', 'editor', ['lib/a.js']]], out);
    await until(async () => /lib\/a\.js → «Сервер»/.test(out), 5000);
  } finally { stop(); }
});

// Встроенный агент для локальной модели: OpenAI-совместимый сервер (здесь — подставной), инструменты Mycel и чтение
// файлов проекта; .env не читается; имя на карте — local-<модель>.
test('chat runs a local model through an OpenAI-compatible API with the Mycel tools and reading of project files', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Локальная');
  await writeFile(join(dir, 'app.js'), 'console.log(1)\n'); await writeFile(join(dir, '.env'), 'KEY=secret\n');
  const seen = [], call = (cid, name, args) => ({ id: cid, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const replies = [
    { tool_calls: [call('c1', 'list_files', {}), call('c2', 'read_file', { path: '.env' }), call('c3', 'read_file', { path: 'app.js' })] },
    { tool_calls: [call('c4', 'mycel_context', { brief: true })] },
    { tool_calls: [call('c5', 'mycel_build', { structure: { blocks: [{ id: 'app', title: 'Приложение', text: 'Печатает число.' }] }, at_once: true })] },
    { content: 'Карта построена.' }
  ];
  const llm = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ url: req.url, body: JSON.parse(body || '{}') });
    const reply = replies.shift() ?? { content: 'ещё' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.content ?? null, ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) } }] }));
  });
  await new Promise(r => llm.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { llm.closeAllConnections(); llm.close(r); }));
  const r = await h.run(['chat', '--base', `http://127.0.0.1:${llm.address().port}/v1`, '--model', 'qwen2.5:7b', 'построй карту'], dir, { MYCEL_ACTOR: '' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'Карта построена.');
  assert.deepEqual([seen[0].url, seen[0].body.model], ['/v1/chat/completions', 'qwen2.5:7b']);
  const names = seen[0].body.tools.map(x => x.function.name);
  assert.ok(['mycel_context', 'mycel_build', 'mycel_check', 'list_files', 'read_file', 'search_files'].every(n => names.includes(n)) && !names.includes('mycel_wait'));
  assert.match(seen[0].body.messages[0].content, /^# Mycel: коротко для агента[\s\S]*у проекта «Локальная» есть карта устройства/);
  const results = seen[1].body.messages.filter(m => m.role === 'tool').map(m => m.content);
  assert.match(results[0], /app\.js/);
  assert.match(results[1], /не читаются/);
  assert.match(results[2], /^1: console\.log\(1\)/);
  assert.deepEqual((await h.api(`/api/p/${id}/graph`)).body.nodes.map(n => n.id), ['app']);
  assert.equal((await h.api(`/api/p/${id}/history`)).body.history[0].actor, 'local-qwen2.5-7b');
});

// Хуки Codex и Cursor: правка через apply_patch и afterFileEdit отмечает файлы, конец ответа напоминает, начало сессии —
// обзор карты (у Codex — обычным выводом, у Cursor — additional_context).
test('the hook understands Codex and Cursor events', async t => {
  const h = await hubFixture(t), { dir, id } = await connected(h, 'Хуки');
  await writeFile(join(dir, 'map.json'), JSON.stringify({ blocks: [{ id: 'srv', title: 'Сервер', files: ['lib/'] }, { id: 'ui', title: 'Окно', files: ['ui/'] }] }));
  assert.equal((await h.run(['build', 'map.json', '--at-once'], dir)).code, 0);
  const hook = (from, event) => mycel(['hook', '--from', from], { cwd: dir, data: h.data, url: h.url, input: JSON.stringify(event), env: { MYCEL_ACTOR: '' } });
  const patch = '*** Begin Patch\n*** Update File: lib/a.js\n@@\n-a\n+b\n*** Add File: lib/b.js\n+x\n*** End Patch';
  let r = await hook('codex', { hook_event_name: 'PostToolUse', cwd: dir, session_id: 's1', tool_name: 'apply_patch', tool_input: { command: ['apply_patch', patch] } });
  assert.deepEqual([r.code, r.out], [0, '']);
  let stale = (await h.api(`/api/p/${id}/code`)).body.stale;
  assert.deepEqual(stale.map(s => [s.id, s.by, s.files]), [['srv', 'codex', ['lib/a.js', 'lib/b.js']]]);
  assert.equal(JSON.parse((await hook('codex', { hook_event_name: 'Stop', cwd: dir, session_id: 's1' })).out).decision, 'block');
  assert.match((await hook('codex', { hook_event_name: 'SessionStart', cwd: dir, source: 'startup' })).out, /^Mycel: у проекта «Хуки» есть карта устройства/);
  r = await hook('cursor', { hook_event_name: 'afterFileEdit', conversation_id: 'c1', workspace_roots: [dir], file_path: join(dir, 'ui', 'view.js'), edits: [] });
  assert.equal(r.code, 0);
  stale = (await h.api(`/api/p/${id}/code`)).body.stale;
  assert.deepEqual(stale.find(s => s.id === 'ui').by, 'cursor');
  assert.match(JSON.parse((await hook('cursor', { hook_event_name: 'stop', conversation_id: 'c1', workspace_roots: [dir], status: 'completed', loop_count: 0 })).out).followup_message, /«Окно» \(ui\)/);
  assert.equal((await hook('cursor', { hook_event_name: 'stop', conversation_id: 'c1', workspace_roots: [dir], status: 'completed', loop_count: 1 })).out, '');
  assert.match(JSON.parse((await hook('cursor', { hook_event_name: 'sessionStart', workspace_roots: [dir] })).out).additional_context, /у проекта «Хуки»/);
});