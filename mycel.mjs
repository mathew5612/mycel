// Mycel для агентов: подключение папки проекта, чтение карты, изменения после последнего чтения, ожидание чужих
// правок и сообщений в чате, ответы и статусы заданий, пакеты и построение структуры. Хаб (server.mjs) один на все
// проекты; если он не работает, команда запускает его в фоне. Прочитанное агентом (ревизию карты и изменение чата)
// хранит хаб, а запись идёт только поверх прочитанного: если карту успели изменить, команда печатает изменения.
import { readFile, mkdir, stat, readdir, writeFile, unlink } from 'node:fs/promises';
import { readFileSync, openSync, closeSync, statSync, readlinkSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

// До модулей Mycel: на старом Node они упали бы с непонятной ошибкой. Чтобы проверка успела сработать, сам этот файл
// написан без синтаксиса новее ES2020 (без ??= и подобного): иначе Node 14 не разобрал бы его целиком.
if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Нужен Node.js 22+: https://nodejs.org'); process.exit(1); }
const appRoot = dirname(fileURLToPath(import.meta.url));
const [{ applyOperations, Problem }, { slug }, { projectRoot, pathKey, defaultData }, { renderGuide, editingLine }, { levelProblems, levelReport }] = await Promise.all(['./src/model.mjs', './src/slug.mjs', './src/paths.mjs', './src/guide.mjs', './src/levels.mjs'].map(m => import(m)));
const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));

const usage = `Mycel для агентов: node mycel.mjs <команда> [параметры]

  init [папка]         Подключить проект (по умолчанию текущую папку). Корень — ближайшая папка с .git, у git worktree —
                       основной репозиторий. Та же папка — тот же проект с его картой, подпапка подключённого — его
                       проект, иначе новый.
                       --name Н — название (у уже подключённой папки — переименовать проект), --project ID —
                       подключить проект ID к этой папке (его папку перенесли),
                       --move — даже если прежняя папка есть, --new — новый проект в любом случае.
  projects             Все проекты: id · название · папка.
  open                 Запустить Mycel, если он не работает, и открыть его в браузере. Mycel прежней версии с теми
                       же данными перезапускается.
  start                Запустить Mycel, если он не работает, и показать адрес.
  stop                 Остановить Mycel.
  guide                Инструкция для агента.

  context [--focus ID] Вся карта в Markdown: что человек выделил и в каком блоке работает, новые его действия в
                       Mycel. Запоминает прочитанное. С --focus — только этот блок со всем вложенным и его связи с
                       остальной картой, с --brief — без координат и размеров.
  graph                Вся карта в JSON. Запоминает прочитанную ревизию.
  changes              Что изменили другие после последнего чтения: карта и действия человека.
  wait [--timeout S]   Ждёт действие человека в Mycel (закончил правки, решил по предложению) или правку
                       содержимого карты от других, печатает и завершается (без S — без срока). Перемещения и размеры
                       не будят, а приходят вместе со следующей правкой; --all будит на любую правку.
  selection            Что человек сейчас выделил на карте и в каком блоке работает — с полным текстом.
  apply <файл|->       Пакет операций: { "message", "operations" } или массив операций.
  build <файл|->       Структура целиком: блоки с подкартами, заметки, связи; без x и y всё расставляется само.
                       Пишется по шагам, чтобы было видно, как карта растёт; --at-once — одной записью.
                       Уже записанные блоки, заметки и связи пропускаются: прерванный build можно повторить.
                       apply, build и propose проверяют уровни «Концепция» и «Механика» до записи: коротко, без кода,
                       файлов и имён из кода; --no-check — без проверки, только если человек сам попросил такой текст.
  propose <файл|->     Предложение человеку: структура как у build и (или) "operations" как у apply, "title" —
                       название. Новое ложится на карту пунктиром с подсветкой, изменённое подсвечивается, удаление
                       только помечается; принимает или отклоняет человек. Следующий propose дополняет открытое.
  mark <id[,id…]> <plan|testing|passed|failed|none>
                       Отметка блоков: plan — логика без готового кода (пунктир), testing — проверка идёт сейчас
                       (рамка пульсирует), passed — код написан и тесты прошли (зелёная рамка), failed — проверка
                       не прошла (красная), none — снять. Человек видит смену сразу: отмечай каждый итог, как придёт.
  doing <текст>        Что делаешь сейчас («читаю server.mjs»): строка под картой. --progress N — сколько сделано,
                       0–100; --on id,… — над какими блоками работаешь (их видят человек и другие агенты);
                       doing --done — снять, когда закончил.
  show <id>            Показать человеку блок: карта переходит к нему и выделяет его.

  check [id[,id…]]     Запустить команды проверки (поле test) у блоков и вложенного в них (без id — у всей карты):
                       рамки зеленеют и краснеют по ходу. --timeout S на команду, по умолчанию 600.
  touch <файл…>        Файлы, которые меняешь: их блоки — «правится сейчас» и «возможно устарел».
  fresh <id[,id…]>     Описание блоков верно — снять «возможно устарел» (--all — у всех).
  review               Что изменилось в устройстве проекта, по концепциям: --hours N (по умолчанию 24) или
                       --since ревизия.
  health               Здоровье карты: красные, устаревшие, без проверки, план, TODO и похожее на ключи в файлах
                       блоков (только файл и строка; .env не читается). --no-scan — без чтения файлов.
  overview             Короткий обзор карты (его же хук даёт агенту в начале сессии).
  hook                 Хук Claude Code: JSON события на стандартном вводе (ставится плагином).
  plugin [--install]    Собрать плагин Claude Code для этого компьютера (MCP, хуки, навык); --install — и подключить его
                       (claude из PATH или из сессии Claude Code; --claude путь), без него — напечатать команды.
                       --agent <имя> — запись MCP-сервера для другого агента: codex, cursor, antigravity,
                       gemini, vscode, windsurf, cline, claude-desktop, lmstudio, continue, goose, opencode,
                       jan, openwebui.

  remote [on|off]      Доступ для виртуальных машин: Mycel принимает их запросы на адресе их сети (VMware,
                       VirtualBox, Hyper-V, WSL; --address — свой) и только с ключом. Без параметров — что открыто,
                       машины с доступом и команда установки для агента там; revoke <id> — отозвать ключ машины;
                       --key — напечатать ключ основной машины.
  join <адрес> [ключ]  В виртуальной машине: подключить эту копию Mycel к Mycel на основной. Без ключа — запрос
                       доступа с кодом: человек нажимает «Разрешить» в Mycel, машина получает свой ключ (ждёт до
                       10 минут, --timeout). --project id — проект для команд. join --off — отключить.

  --url URL            Адрес Mycel, по умолчанию MYCEL_URL, адрес из join или http://127.0.0.1:4317.
  --token КЛЮЧ         Ключ для Mycel на другой машине, по умолчанию MYCEL_TOKEN или ключ из join.
  --data каталог       Каталог данных, по умолчанию MYCEL_DATA или .mycel рядом с mycel.mjs.
  --project ID         Проект для команд карты, по умолчанию MYCEL_PROJECT, проект из join или проект текущей папки.
  --actor ИМЯ          Кто вносит изменения, по умолчанию MYCEL_ACTOR; в Claude Code — claude, иначе agent.
  --no-start           Не запускать Mycel, если он не работает.
  -m, --message ТЕКСТ  Причина изменения для apply, build и mark, название для propose.`;

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
// Переменные окружения — MYCEL_*, прежние KONTUR_* тоже читаются.
const env = name => process.env[`MYCEL_${name}`] || process.env[`KONTUR_${name}`];
// Каталог данных, заданный явно, должен совпасть с данными работающего хаба: иначе агент читал бы чужие проекты.
const explicitData = options.data || env('DATA') || null;
let data = resolve(explicitData ?? defaultData(appRoot));
// Копия Mycel в виртуальной машине, подключённая к Mycel на основной (mycel join): адрес, ключ и проект — в
// <данные>/remote.json. Явный адрес (--url, MYCEL_URL) её не использует.
const joined = (() => {
  if (options.url || env('URL')) return null;
  try { const v = JSON.parse(readFileSync(join(data, 'remote.json'), 'utf8')); return typeof v.url === 'string' && typeof v.token === 'string' ? v : null; } catch (e) { return null; }
})();
const base = (() => { try { return new URL(options.url || env('URL') || (joined ? joined.url : 'http://127.0.0.1:4317')); } catch (e) { return null; } })();
const origin = base?.origin, port = Number(base?.port || 80);
// Mycel на этом компьютере или на другом в локальной сети (основная машина для виртуальной). На другой — только с
// ключом: токен по сети не раздаётся, его дают join, --token или MYCEL_TOKEN.
const privateHost = host => /^(10\.\d+|127\.\d+|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)\.\d+\.\d+$/.test(host) || /\.local$/i.test(host);
const loopback = Boolean(base) && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), remote = Boolean(base) && !loopback;
// Claude Code подписывается сам: его команды запускаются с переменной CLAUDECODE.
let actor = options.actor || env('ACTOR') || (process.env.CLAUDECODE ? 'claude' : 'agent');
const launcher = join(appRoot, process.platform === 'win32' ? 'Mycel.cmd' : 'Mycel.command');
let project = null, token = options.token || env('TOKEN') || (joined ? joined.token : null) || null;

// Выход с кодом — исключением до конца файла: вывод в канал успевает дописаться, в отличие от process.exit.
class Exit { constructor(code) { this.code = code; } }
const quit = code => { throw new Exit(code); };
function fail(message, code = 1) { console.error(message); quit(code); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Каждый запрос подписан именем агента: так человек видит, что агент на связи. Пока человек удаляет проект, хаб
// отвечает 503 с retry: удаление может не состояться (папка занята), поэтому запрос повторяется до исхода (до 10 с).
async function call(path, body) {
  if (body && token === null) token = (await call('/api/session')).value.token;
  // Mycel на другой машине требует ключ и для чтения.
  const headers = { 'X-Mycel-Actor': actor, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token !== null && (body || remote) ? { Authorization: `Bearer ${token}` } : {}) };
  for (let i = 0; ; i++) {
    const res = await fetch(new URL(path, base), body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    const type = res.headers.get('content-type') ?? '', value = type.includes('json') ? await res.json() : await res.text();
    if (res.status !== 503 || value?.retry !== true || i >= 50) return { status: res.status, value };
    await sleep(200);
  }
}
const deletedText = name => `Проект «${name}» удалён человеком. Подключайте заново только по его просьбе: mycel init --new.`;
// Ответ на запрос к проекту. Удалённый человеком проект — отдельное сообщение и выход, без повторов.
function ok({ status, value }) {
  if (status === 404 && value?.deleted) fail(deletedText(value.deleted.name ?? project?.name));
  if (status !== 200) fail(`Ошибка ${status}: ${value?.error ?? value}`);
  return value;
}

// Кто отвечает по адресу: null — никто, { foreign: true } — не Mycel, иначе ответ /api/health.
async function health(ms = 3000) {
  try {
    const res = await fetch(new URL('/api/health', base), { signal: AbortSignal.timeout(ms) });
    const value = (res.headers.get('content-type') ?? '').includes('json') ? await res.json().catch(() => null) : await res.text().then(() => null);
    return res.ok && value?.ok === true ? value : { foreign: true };
  } catch { return null; }
}
// Остановить можно и Mycel другой версии: так его и обновляют. Команда — полная: node может не быть в PATH.
// До 0.15 программа называлась Контур (app: 'kontur'): такой хаб — прежняя версия.
const ours = app => app === 'mycel' || app === 'kontur';
function check(h, stopping = false) {
  if (h.foreign || (h.app && !ours(h.app))) fail(`На ${origin} отвечает не Mycel.`);
  if (!h.app) fail(`На ${origin} работает старая версия Mycel: остановите её.`);
  if (explicitData && !remote && (typeof h.data !== 'string' || pathKey(h.data) !== pathKey(data))) fail(`На ${origin} работает Mycel с другими данными: ${h.data}`);
  if (!stopping && h.version !== version) fail(remote ? `Версия Mycel на ${origin} (${h.version}) и здесь (${version}) разная: обновите копию здесь — curl -fsS ${origin}/install.sh | sh (подключение сохранится).` : `Mycel обновлён: перезапустите его ("${process.execPath}" "${join(appRoot, 'mycel.mjs')}" stop, затем ${launcher}).`);
}
// Остановка с ожиданием, пока процесс не отпустит порт и lock: следующий запуск не должен застать уходящий хаб.
async function stopHub(h) {
  const pid = typeof h.data === 'string' ? await lockPid(h.data) : null, res = await call('/api/stop', {});
  if (res.status === 200) for (const end = Date.now() + 5000; Date.now() < end && (await health(500) || (pid && alive(pid))); ) await sleep(100);
  return res;
}
async function ensure() {
  let h = await health();
  // Mycel на другой машине отсюда не запустить.
  if (!h && remote) fail(`Mycel на ${origin} не отвечает. Он должен работать на основной машине с открытым доступом (node mycel.mjs remote on), а брандмауэр — пропускать node.`);
  if (!h && !options['no-start']) { h = await launch(); if (!h) fail(await notRunning(true)); }
  if (!h) fail(await notRunning(false));
  check(h);
  return h;
}
// Хаб работает в фоне и после выхода агента, его вывод — в <данные>/server.log. Переменные агента ему не передаются:
// порт и каталог данных заданы явно. Хаб прежней версии мог только что остановиться: его .kontur теперь можно перенести.
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
  // Все 5 секунд, даже если процесс уже завершился: его мог опередить хаб, запущенный другим агентом.
  for (const end = Date.now() + 5000; Date.now() < end; ) {
    await sleep(100);
    const h = await health(1000);
    if (h) { if (h.app === 'mycel') console.error(`Запущен Mycel: ${origin}`); return h; }
  }
  return null;
}
async function lockPid(dir = data) {
  try {
    const text = await readFile(join(dir, 'server.lock'), 'utf8'), v = /^\s*\d+\s*$/.test(text) ? { pid: Number(text) } : JSON.parse(text);
    return Number.isSafeInteger(v?.pid) && v.pid > 0 ? v.pid : null;
  } catch { return null; }
}
// В песочнице без сети хаб может работать, но быть недоступен этой команде.
async function notRunning(started) {
  const pid = await lockPid(), sandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1' && 'В песочнице без сети запускайте команды Mycel с разрешением на сеть.';
  if (pid && alive(pid)) return [`Mycel запущен (pid ${pid}), но не отвечает на ${origin}`, sandbox].filter(Boolean).join('\n');
  const tail = started ? (await readFile(join(data, 'server.log'), 'utf8').catch(() => '')).trim().split(/\r?\n/).slice(-3).join('\n') : '';
  return [`Mycel не запущен. Попросите человека открыть ${launcher}.`, tail, sandbox].filter(Boolean).join('\n');
}

// Проект команды: --project или проект папки, в которой она запущена (из любой подпапки). В репозитории поиск не
// выходит за его корень: подключённая папка выше не захватывает отдельный репозиторий. Из git worktree ищется та же
// папка основного рабочего дерева. Копия в виртуальной машине ищет проекты своих папок (init там создаёт их с пометкой
// машины), а если папка не подключена — берёт проект, выбранный при join.
const projectId = () => options.project || env('PROJECT') || null;
async function resolveProject() {
  const { root, git, path } = projectRoot(process.cwd()), id = projectId();
  let res = await call(id ? `/api/p/${encodeURIComponent(id)}` : `/api/projects?${new URLSearchParams({ path, ...(git ? { root } : {}) })}`);
  if (!id && res.status === 404 && !res.value?.deleted && joined && joined.project) res = await call(`/api/p/${encodeURIComponent(joined.project)}`);
  if (res.status === 404 && res.value?.deleted) fail(deletedText(res.value.deleted.name));
  if (res.status === 404) fail(id ? `Проекта ${id} нет: список — mycel projects.` : remote ? `Папка не подключена к Mycel на ${origin}: ${root}. Выполни mycel init в корне проекта (проект появится там с пометкой этой машины) или укажи --project <id> (список — mycel projects).` : `Папка не подключена к Mycel: ${root}. Выполните mycel init в корне проекта.`);
  const p = ok(res).project;
  if (p.error) fail(`Проект «${p.name}» не открывается: ${p.error}`);
  return p;
}
const at = path => `/api/p/${project.id}${path}`;
// Папка проекта на этой машине: в виртуальной папка проекта с основной не видна — тогда корень текущей папки.
const here = () => {
  // Файлы проекта виртуальной машины — там: проверки и поиск рисков запускаются на ней.
  if (project.machine && !remote) fail(`Файлы проекта «${project.name}» — на машине «${project.machine.name}»: запускай это там.`);
  return isDir(project.path) ? project.path : projectRoot(process.cwd()).root;
};
// Прочитанное агентом хранит хаб, отдельно для каждого actor; значения только растут.
const readCursor = async () => ok(await call(at(`/cursor?actor=${encodeURIComponent(actor)}`)));
const saveCursor = async patch => ok(await call(at('/cursor'), { actor, ...patch }));
async function needCursor() {
  const cursor = await readCursor();
  if (cursor.revision === null) fail('Сначала прочитайте карту: mycel context');
  return cursor;
}
async function readText(source) {
  if (source !== '-') return readFile(source, 'utf8').catch(e => fail(`Не читается файл ${source}: ${e.code ?? e.message}`));
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
async function readInput(source = input) {
  if (!source) fail('Укажите JSON-файл или - для стандартного ввода.');
  const text = await readText(source);
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) { fail(`Некорректный JSON: ${e.message}`); }
}

const short = line => { if (line.length <= 40) return line; const cut = line.slice(0, 40), space = cut.lastIndexOf(' '); return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`; };
const namer = graph => id => { const n = graph.nodes.find(x => x.id === id); return n ? `«${n.title || short(n.text.trim().split('\n')[0]) || 'без названия'}» (${id})` : `(${id})`; };

// Действия человека в Mycel (и прежняя переписка проектов, у которых был чат): кто, когда, о каких блоках, текст.
const statusNames = { new: 'новое', working: 'в работе', done: 'готово' };
const who = author => author === 'human' ? 'Человек' : author;
function formatChat(messages, graph) {
  const name = namer(graph);
  return messages.flatMap(m => {
    const time = new Date(m.updatedAt && m.updatedBy !== m.author ? m.updatedAt : m.at).toLocaleString('ru');
    if (m.task && m.updatedBy !== m.author) return [`- ${m.id} · ${who(m.updatedBy)} · ${time}: статус задания — ${statusNames[m.status]}${m.status === 'working' && m.progress !== null ? `, ${m.progress} %` : ''}${m.step ? `: ${m.step}` : ''}`, `  ${short(m.text.split('\n')[0])}`];
    // Человек нажал «Закончить правки»: его записи карты с начала правок — одним пакетом.
    if (m.kind === 'edits') return [`- ${m.id} · ${who(m.author)} · ${time}: правки карты готовы — его записи после ревизии ${m.edits.since} (до ${m.edits.until}), всего ${m.edits.count}. Что изменилось — ниже. Учти это; если в правках просьба, сделай и коротко скажи человеку, что сделал.`];
    // Решение человека по предложению агента; его правки в предложении — ниже, в изменениях карты.
    if (m.kind === 'proposal') return [`- ${m.id} · ${who(m.author)} · ${time}: ${m.proposal.result === 'accepted'
      ? `принял предложение «${m.proposal.title}»${m.proposal.edits ? ' со своими правками' : ''}. Принятые блоки — план (пунктир), пока код не написан и не проверен: реализуй их, если человек просил само изменение, и отметь итог тестов (mycel mark).`
      : `отклонил предложение «${m.proposal.title}»: карта вернулась к прежнему. Спроси человека, что поменять, если это неясно.`}`];
    // Человек нажал «Проверить» у блока: проверяет агент.
    if (m.kind === 'check') return [`- ${m.id} · ${who(m.author)} · ${time}: просит проверить ${m.check.ids.map(name).join(', ')}. Выполни mycel check ${m.check.ids.join(',')} (в MCP — mycel_check) и коротко скажи человеку итог; если у блока нет команды проверки, добавь её (поле test).`];
    const meta = [m.id, who(m.author), time, m.task && `задание (${statusNames[m.status]})`, m.replyTo && `ответ на ${m.replyTo}`, m.nodes.length && `о блоках ${m.nodes.map(name).join(', ')}`].filter(Boolean).join(' · ');
    return [`- ${meta}`, ...m.text.split('\n').map(line => `  ${line}`)];
  }).join('\n');
}

// Изменения — в виде, удобном для чтения агентом: записи истории, затем полное содержимое добавленного и изменённого.
const fieldNames = { title: 'название', text: 'текст', color: 'цвет', parentId: 'уровень', attachedTo: 'прикрепление', collapsed: 'сворачивание', x: 'положение', y: 'положение', w: 'размер', h: 'размер', type: 'тип', source: 'начало', target: 'конец', label: 'подпись', status: 'отметка', proposed: 'предложение' };
const markNames = { plan: 'план, кода нет', testing: 'идёт проверка', passed: 'проверен', failed: 'проверка не прошла' }, proposedNames = { add: 'добавить', change: 'изменить', remove: 'удалить' };
function formatChanges(res, graph) {
  const name = namer(graph);
  const lines = [`Изменения карты после ревизии ${res.since}, сейчас ревизия ${res.revision}:`];
  for (const e of res.entries) lines.push(`- r${e.revision} ${e.actor}, ${new Date(e.at).toLocaleString('ru')}: ${e.message}${e.changes.length > 1 || e.changes[0] !== e.message ? ` — ${e.changes.join('; ')}` : ''}`);
  if (!res.complete) { lines.push('', 'История не покрывает весь промежуток: перечитайте карту целиком (mycel context).'); return lines.join('\n'); }
  const where = n => [n.type === 'note' ? 'заметка' : 'блок', n.parentId ? `внутри ${name(n.parentId)}` : 'на основной карте', n.attachedTo && `прикреплена к ${name(n.attachedTo)}`, n.collapsed && 'подкарта свёрнута',
    n.status && markNames[n.status], n.proposed && `предложено: ${proposedNames[n.proposed]}`].filter(Boolean).join(', ');
  const full = n => [`### ${n.title || (n.type === 'note' ? 'Заметка' : 'Без названия')} (id: ${n.id}) — ${where(n)}${n.fields ? `; изменено: ${[...new Set(n.fields.map(f => fieldNames[f] ?? f))].join(', ')}` : ''}`, n.text].filter(Boolean).join('\n');
  const layoutOnly = n => n.fields.every(f => ['x', 'y', 'w', 'h', 'collapsed'].includes(f));
  const { nodes, edges } = res;
  if (nodes.added.length) lines.push('', 'Добавлено:', ...nodes.added.map(full));
  const content = nodes.updated.filter(n => !layoutOnly(n)), moved = nodes.updated.filter(layoutOnly);
  if (content.length) lines.push('', 'Изменено (текущее содержимое):', ...content.map(full));
  if (moved.length) lines.push('', `Только положение, размер или сворачивание: ${moved.map(n => name(n.id)).join(', ')}`);
  if (nodes.removed.length) lines.push('', `Удалено: ${nodes.removed.map(n => `${n.type === 'note' ? 'заметка' : 'блок'} «${n.name}» (${n.id})`).join(', ')}`);
  const edge = (e, mark) => `${mark} ${name(e.source)} → ${name(e.target)}${e.label ? `: ${e.label}` : ''}${e.fields ? ` [изменено: ${e.fields.map(f => fieldNames[f]).join(', ')}]` : ''}`;
  const edgeLines = [...edges.added.map(e => edge(e, '+')), ...edges.updated.map(e => edge(e, '~')), ...edges.removed.map(e => edge(e, '−'))];
  if (edgeLines.length) lines.push('', 'Связи:', ...edgeLines);
  return lines.join('\n');
}
// Чата в Mycel нет: человек говорит с агентом в окне агента, а Mycel сообщает только о том, что человек сделал на карте.
const chatHeader = 'Человек в Mycel:';
// Печатает новое в чате и на карте и сдвигает прочитанное. Сдвиг — до печати: если вывод обрежут (head,
// Select-Object -First) и процесс прервут, то же сообщение не придёт второй раз; инструкция просит читать вывод целиком.
async function report(res) {
  const graph = ok(await call(at('/graph'))), parts = [];
  // «Правки карты готовы» приносит все правки человека с их начала, даже если часть агент уже видел в changes.
  const from = Math.min(res.since, ...(res.chat?.messages ?? []).map(m => m.kind === 'edits' ? m.edits.since : m.proposal?.edits?.since).filter(Number.isInteger));
  const map = from < res.since ? ok(await call(at(`/changes?since=${from}&exclude=${encodeURIComponent(actor)}`))) : res;
  if (res.focus && (res.chat?.messages.length || res.entries.length)) parts.push(`Человек в фокусе на ${namer(graph)(res.focus)}: работай в его рамках (mycel context --focus ${res.focus}).`);
  if (res.chat?.messages.length) parts.push(`${chatHeader}\n${formatChat(res.chat.messages, graph)}`);
  if (res.edit) parts.push(editingLine(res.edit));
  if (map.entries.length || !map.complete) parts.push(formatChanges(map, graph));
  await saveCursor({ revision: res.revision, ...(res.chat ? { chat: res.chat.seq } : {}) });
  console.log(parts.join('\n\n') || `Других изменений нет, ревизия ${res.revision}.`);
}
const changesUrl = (cursor, extra = '') => at(`/changes?since=${cursor.revision}&exclude=${encodeURIComponent(actor)}&chat=${cursor.chat}${extra}`);
// Карту изменили после чтения агента: вместо записи — изменения, прочитанное сдвигается на них.
async function conflict(since) {
  console.log('Карта изменилась после вашего последнего чтения. Изменения ниже; учтите их и повторите запись.\n');
  await report(ok(await call(at(`/changes?since=${since}&exclude=${encodeURIComponent(actor)}`))));
  quit(1);
}
// Итог записи: свои ревизии (чужие между ними не входят: «1, 3–4») и строки истории своих записей (до 50). Сдвиги
// и размеры от раскладки — одной строкой: соседи раздвигаются при каждой постройке, и по имени они агенту не нужны.
async function written(revisions, after = []) {
  const mine = new Set(revisions), all = ok(await call(at('/history'))).history.filter(h => mine.has(h.revision)).reverse().flatMap(h => h.changes);
  const layout = line => /^(Перемещён|Перемещена|Изменён размер:)/.test(line), moved = new Set(all.filter(layout)).size;
  const changes = [...all.filter(line => !layout(line)), ...(moved ? [`Раскладка: сдвинуто или подогнано по размеру узлов — ${moved}`] : [])];
  const runs = revisions.reduce((list, r) => { const last = list[list.length - 1]; if (last && r === last[1] + 1) last[1] = r; else list.push([r, r]); return list; }, []);
  console.log([`Записано, ${revisions.length === 1 ? 'ревизия' : 'ревизии'} ${runs.map(([a, b]) => a === b ? a : `${a}–${b}`).join(', ')}.`, ...changes.slice(0, 50).map(c => `- ${c}`), ...(changes.length > 50 ? [`- … ещё ${changes.length - 50}`] : []), ...after].join('\n'));
}
// Уровни «Концепция» и «Механика» читают люди без программирования: пакет с кодом, файлами, именами из кода или
// длинными текстами на них не пишется вовсе (src/levels.mjs). Проверяется только то, что пакет добавляет или меняет.
function checkLevels(graph, operations) {
  if (options['no-check']) return;
  const problems = levelProblems(graph, operations);
  if (problems.length) fail(levelReport(problems));
}
async function write(message, operations) {
  const { revision } = await needCursor();
  // Глубины — по карте, которую агент прочитал. Если её уже изменили, запись всё равно не прошла бы: сразу изменения.
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

// Дерево из build превращается в пакет: id из названия (латиницей), вложенность через parentId, заметки через
// attachedTo. Повторный build того же файла (например, после обрыва) ничего не дублирует: блок с тем же id, уровнем
// и названием, заметка с тем же id, местом и текстом и уже проведённая связь считаются записанными. Id заметок
// постоянные: <id блока>-note-<номер> и note-<номер> у свободных.
function buildOps(spec, graph) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('build принимает JSON-объект { "blocks", "notes", "links" }.');
  const byId = new Map(graph.nodes.map(n => [n.id, n])), claimed = new Set(), byTitle = new Map(), ops = [], outline = [], level = spec.parent ?? null;
  if (level !== null && byId.get(level)?.type !== 'block') fail(`Блока «${level}» из parent нет на карте.`);
  const take = (wanted, root, same) => {
    if (wanted) {
      if (claimed.has(wanted) || (byId.has(wanted) && !same(byId.get(wanted)))) fail(`id «${wanted}» уже занят на карте или в структуре.`);
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
      if (!b || typeof b !== 'object') fail('Каждый блок в build — объект с title.');
      const title = b.title ?? '';
      const { id, fresh } = take(b.id, slug(title) || 'block', n => n.type === 'block' && n.parentId === parentId && n.title === title);
      byTitle.set(title, byTitle.has(title) ? null : id);
      // Подкарты глубже концепций (у механики — техника, у техники — код) по умолчанию свёрнуты: карта открывается
      // на уровне «Механика», а при раскрытии глубже соседи раздвигаются. Так размеры подкарт не рассчитываются под
      // полностью раскрытый вид.
      const folded = b.collapsed ?? (depth + (spec.parent ? 1 : 0) >= 1 && Boolean(b.blocks?.length));
      if (fresh) ops.push({ type: 'add-node', node: { id, parentId, title, text: b.text ?? '', color: b.color ?? '', collapsed: Boolean(folded), ...(b.status ? { status: b.status } : {}), ...(b.files ? { files: b.files } : {}), ...(b.test ? { test: b.test } : {}), ...geometry(b) } });
      outline.push(`${'  '.repeat(depth)}- ${id} — ${title}`);
      notes(b.notes, parentId, id);
      visit(b.blocks, id, depth + 1);
    }
  };
  // Первая карта проекта прежней версии заменяет стартовый блок с названием папки, если его не заполняли и не связывали.
  const [only] = graph.nodes;
  if (!spec.parent && graph.nodes.length === 1 && only.id === 'start' && !only.text && !graph.edges.length && spec.blocks?.length) { ops.push({ type: 'delete-node', id: 'start' }); byId.delete('start'); }
  visit(spec.blocks, level, 0);
  notes(spec.notes, level, null);
  const ref = r => { if (byId.has(r) || claimed.has(r)) return r; const id = byTitle.get(r); if (id) return id; fail(`Связь ссылается на неизвестный или неоднозначный блок «${r}». Укажите id.`); };
  const pairs = new Set(graph.edges.map(e => `${e.source}:${e.target}`));
  for (const l of spec.links ?? []) {
    const [from, to, label] = Array.isArray(l) ? l : [l?.from, l?.to, l?.label], source = ref(from), target = ref(to);
    if (!pairs.has(`${source}:${target}`)) ops.push({ type: 'add-edge', edge: { source, target, label: label ?? '' } });
  }
  return { ops, outline };
}

// Шаги build. Геометрия каждого шага взята из final — ровно та, что дала бы запись одним пакетом. Шаг 1: существующие
// узлы встают туда, куда их раздвинула раскладка, появляются новые блоки уровня build (свёрнутые — сразу со всей
// подкартой). Дальше по шагу на каждую развёрнутую подкарту с новым содержимым: от внешних к вложенным, сверху вниз.
// Связи — в том шаге, после которого есть оба их конца. В каждом шаге правки идут раньше добавлений, связи — последними.
const nodeFields = ['id', 'type', 'parentId', 'attachedTo', 'collapsed', 'title', 'text', 'color', 'status', 'files', 'test', 'x', 'y', 'w', 'h'];
function stages(current, final, ops, level) {
  const deleted = new Set(ops.filter(o => o.type === 'delete-node').map(o => o.id));
  const old = new Map(current.nodes.filter(n => !deleted.has(n.id)).map(n => [n.id, n])), byId = new Map(final.nodes.map(n => [n.id, n]));
  const fresh = final.nodes.filter(n => !old.has(n.id)), known = new Set(current.edges.map(e => e.id)), links = final.edges.filter(e => !known.has(e.id));
  const sent = new Set(old.keys()), linked = new Set();
  // Прикреплённая заметка едет вместе со своим блоком сама; отдельная правка — только если раскладка сдвинула её иначе.
  // Положение и размер — разными правками: так история называет их точно.
  const updates = [], shift = id => { const n = old.get(id), f = byId.get(id); return n && f ? { x: f.x - n.x, y: f.y - n.y } : { x: 0, y: 0 }; };
  const patch = (n, f, keys) => { const p = Object.fromEntries(keys.filter(k => n[k] !== f[k]).map(k => [k, f[k]])); if (Object.keys(p).length) updates.push({ type: 'update-node', id: f.id, patch: p }); };
  for (const type of ['block', 'note']) for (const n of old.values()) {
    const f = byId.get(n.id);
    if (n.type !== type || !f) continue;
    const d = type === 'note' && n.attachedTo ? shift(n.attachedTo) : { x: 0, y: 0 }, was = { ...n, x: n.x + d.x, y: n.y + d.y };
    patch(was, f, ['x', 'y']); patch(was, f, ['w', 'h']);
  }
  const inside = (n, id) => { for (let p = n.parentId; p; p = byId.get(p)?.parentId) if (p === id) return true; return false; };
  // Новые узлы уровней parents (у свёрнутых новых блоков — со всей подкартой) и связи, у которых теперь есть оба конца.
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
  // Новое внутри свёрнутых существующих блоков не видно — оно идёт в первом шаге.
  const folded = fresh.map(n => n.parentId).filter(p => p !== null && old.has(p) && byId.get(p).collapsed);
  const plan = [[...updates, ...ops.filter(o => o.type === 'delete-node'), ...take([...new Set([level, null, ...folded])])]];
  const depth = id => { let d = 0; for (let p = id; p; p = byId.get(p)?.parentId) d++; return d; };
  const containers = [...new Set(fresh.filter(n => !sent.has(n.id)).map(n => n.parentId))].sort((a, b) => depth(a) - depth(b) || byId.get(a).y - byId.get(b).y || byId.get(a).x - byId.get(b).x);
  for (const c of containers) plan.push(take([c]));
  plan.push(take([]));
  return plan.filter(step => step.length);
}
// Можно ли повторить шаги поверх чужих правок: никто не удалил то, во что они кладут узлы и между чем проводят связи,
// и не занял их id.
function rebasable(changes, steps) {
  if (!changes.complete) return false;
  const removed = new Set(changes.nodes.removed.map(n => n.id)), added = new Set(changes.nodes.added.map(n => n.id));
  return steps.flat().every(op => op.type === 'add-edge' ? !removed.has(op.edge.source) && !removed.has(op.edge.target)
    : !removed.has(op.node.parentId) && !removed.has(op.node.attachedTo) && !added.has(op.node.id));
}
const writtenSteps = (k, n) => k === 1 ? `Записан шаг 1 из ${n}.` : `Записаны шаги 1–${k} из ${n}.`;
// Шаги по очереди, с паузой: человек видит, как карта растёт. Если между шагами карту изменили, чужие изменения
// печатаются сразу, а шаг повторяется поверх новой ревизии (до трёх раз); иначе — что записано, чужие изменения и выход.
// Прочитанное сдвигается за чужие правки только после их печати: обрезанный вывод или прерванный build их не теряет.
async function commitSteps(plan, message, start, after) {
  const mine = [];
  let revision = start;
  for (let i = 0; i < plan.length; i++) {
    if (i) await sleep(200);
    for (let retry = 0; ; retry++) {
      const res = await call(at('/changes'), { expectedRevision: revision, actor, message: plan.length > 1 ? `${message} (шаг ${i + 1} из ${plan.length})` : message, operations: plan[i] });
      if (res.status === 200) { revision = res.value.revision; mine.push(revision); await saveCursor({ revision }); break; }
      if (res.status !== 409) { if (i) console.log(writtenSteps(i, plan.length)); ok(res); }
      if (!i) await conflict(revision);
      const changes = ok(await call(at(`/changes?since=${revision}&exclude=${encodeURIComponent(actor)}`)));
      if (retry >= 3 || !rebasable(changes, plan.slice(i))) {
        console.log(`${writtenSteps(i, plan.length)}\n`);
        await report(changes);
        console.log('\nПовторите тот же build: уже записанные блоки будут пропущены.');
        quit(1);
      }
      console.log(`Пока шла запись, карту изменили:\n${formatChanges(changes, ok(await call(at('/graph'))))}\n`);
      revision = changes.revision;
    }
  }
  await written(mine, after);
}

const idList = value => (value || '').split(',').map(x => x.trim()).filter(Boolean);
const plural = (n, forms) => { const a = Math.abs(n) % 100, b = a % 10; return `${n} ${forms[a > 10 && a < 20 ? 2 : b > 1 && b < 5 ? 1 : b === 1 ? 0 : 2]}`; };
// Блоки и всё вложенное в них.
function within(graph, ids) {
  const set = new Set(ids);
  for (let grew = true; grew; ) { grew = false; for (const n of graph.nodes) if (!set.has(n.id) && set.has(n.parentId)) { set.add(n.id); grew = true; } }
  return set;
}
// Отметки от check пишутся поверх текущей ревизии, а не прочитанной: проверка долгая, карту тем временем правят.
// Прочитанное сдвигается на свою запись, только если до неё агент уже всё прочитал.
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
// Команда проверки — из корня проекта, через оболочку, как её записали; «node …» запускается тем же node, что и Mycel
// (его может не быть в PATH). Остаются последние 40 строк вывода.
function runTest(command, timeout) {
  const line = /^node\s/.test(command) ? `"${process.execPath}" ${command.slice(5)}` : command;
  return new Promise(done => {
    const child = spawn(line, { cwd: here(), shell: true, windowsHide: true });
    let out = '';
    const keep = c => { out = (out + c).slice(-20000); };
    child.stdout.setEncoding('utf8').on('data', keep); child.stderr.setEncoding('utf8').on('data', keep);
    const timer = setTimeout(() => {
      out += `\nОстановлено: дольше ${timeout} с.`;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).on('error', () => {}); else child.kill();
    }, timeout * 1000);
    child.on('error', e => { clearTimeout(timer); done({ code: 1, out: e.message }); });
    child.on('close', code => { clearTimeout(timer); done({ code: code === null ? 1 : code, out: out.trim().split(/\r?\n/).slice(-40).join('\n') }); });
  });
}
// Проверка блоков: команды test у блоков и у вложенного в них, каждая по разу. Перед запуском блоки — «идёт проверка»,
// после каждой команды её блоки — «проверен» или «проверка не прошла»: человек видит, как карта окрашивается.
async function runChecks(ids) {
  here();
  const graph = ok(await call(at('/graph'))), name = namer(graph);
  for (const id of ids) if (!graph.nodes.some(n => n.id === id && n.type === 'block')) fail(`Блока «${id}» нет на карте.`);
  const scope = ids.length ? within(graph, ids) : null, targets = graph.nodes.filter(n => n.type === 'block' && n.test && (!scope || scope.has(n.id)));
  if (!targets.length) fail(`${ids.length ? 'У этих блоков и вложенных в них' : 'На карте'} нет команды проверки. Добавь её блоку: mycel apply с update-node { "test": "команда тестов" }.`);
  const groups = new Map();
  for (const n of targets) groups.set(n.test, (groups.get(n.test) || []).concat(n.id));
  const timeout = Number(options.timeout || 600);
  if (!(timeout > 0)) fail('--timeout — секунды, больше 0.');
  await markNow(targets.map(n => n.id), 'testing', 'Проверка идёт');
  const lines = [];
  let failed = 0;
  for (const [command, list] of groups) {
    const r = await runTest(command, timeout), status = r.code === 0 ? 'passed' : 'failed';
    if (status === 'failed') failed++;
    await markNow(list, status, `Проверка: ${markNames[status]}`);
    lines.push(`${status === 'passed' ? 'Проверен' : 'Проверка не прошла'}: ${list.map(name).join(', ')} — \`${command}\`${status === 'failed' ? ` (код ${r.code})\n${r.out}` : ''}`);
  }
  console.log(lines.join('\n\n'));
  if (failed) quit(1);
}

// Риски в файлах блоков: пометки TODO, FIXME, HACK, XXX и строки, похожие на ключи и пароли. Печатаются только файл и
// номер строки, без содержимого. .env, ключи и сертификаты не открываются; зависимости, сборка и данные пропускаются.
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
        if (f.secrets.length) spots.push(`${rel}:${f.secrets.join(',')} (похоже на ключ или пароль)`);
      }
      risks[n.id] = r; where[n.id] = spots;
    }
    ok(await call(at('/risks'), { actor, blocks: risks }));
  }
  const list = (title, items) => items.length ? [`${title}:`, ...items.map(x => `- ${x}`), ''] : [];
  const stale = new Set(code.stale.map(s => s.id));
  console.log([`Здоровье карты «${project.name}»:`, '',
    ...list('Проверка не прошла', blocks.filter(n => n.status === 'failed').map(n => name(n.id))),
    ...list('Возможно устарели (файлы изменили после описания)', code.stale.map(s => `${name(s.id)} — ${s.files.join(', ')}`)),
    ...list('Без проверки (есть файлы, нет команды test и отметки «проверен»)', blocks.filter(n => n.files && !n.test && n.status !== 'passed').map(n => name(n.id))),
    ...list('План (кода нет)', blocks.filter(n => n.status === 'plan').map(n => name(n.id))),
    ...list('Риски в файлах', Object.entries(risks).filter(([, r]) => r.todo || r.secrets).map(([id, r]) => `${name(id)}: ${[r.todo && `TODO ${r.todo}`, r.secrets && `похоже на секрет ${r.secrets}`].filter(Boolean).join(', ')} — ${where[id].join('; ')}`)),
    ...(blocks.some(n => n.files) ? [] : ['У блоков нет файлов: добавь их блокам техники и кода ("files": ["путь"]), тогда видны устаревшие блоки и риски.', '']),
    stale.size || blocks.some(n => n.status === 'failed') ? 'Начни с красных и устаревших блоков.' : 'Красных и устаревших блоков нет.'].join('\n').trim());
}

// Обзор карты для начала сессии: концепции и механика по строке, отметки, устаревшее, предложение. Агент читает
// нужную часть карты (context --focus), а не весь код. Не длиннее 6000 символов.
function overview(graph, code) {
  const kids = id => graph.nodes.filter(n => n.parentId === id && n.type === 'block');
  const first = text => { const line = text.trim().split('\n')[0]; return line.length > 140 ? `${line.slice(0, 139)}…` : line; };
  const line = n => `«${n.title || 'без названия'}» (${n.id})${n.text ? ` — ${first(n.text)}` : ''}`;
  const count = s => graph.nodes.filter(n => n.status === s);
  const lines = [`Mycel: у проекта «${project.name}» есть карта устройства — ${plural(graph.nodes.filter(n => n.type === 'block').length, ['блок', 'блока', 'блоков'])}, человек видит её: ${origin}/#/p/${project.id}.`,
    'Читай нужную часть карты, а не весь код: mycel context --focus <id> (в MCP — mycel_context с focus). Инструкция — mycel guide (mycel_guide).', '', 'Концепции и механика:'];
  for (const c of kids(null)) { lines.push(`- ${line(c)}`); for (const m of kids(c.id)) lines.push(`  - ${line(m)}`); }
  const marks = [count('passed').length && `проверено ${count('passed').length}`, count('failed').length && `не прошло ${count('failed').length} (${count('failed').slice(0, 5).map(n => `«${n.title}»`).join(', ')})`, count('plan').length && `план ${count('plan').length}`].filter(Boolean);
  if (marks.length) lines.push('', `Отметки: ${marks.join(', ')}.`);
  if (code.stale.length) lines.push(`Возможно устарели (файлы изменили после описания): ${code.stale.slice(0, 10).map(s => `«${s.name}» (${s.id})`).join(', ')}.`);
  if (code.work.length) lines.push(`Сейчас работают: ${code.work.map(w => w.actor).join(', ')}.`);
  if (graph.proposal) lines.push(`Открыто предложение «${graph.proposal.title}» — принимает или отклоняет человек.`);
  let text = lines.join('\n');
  if (text.length > 6000) text = `${text.slice(0, text.lastIndexOf('\n', 5900))}\n… карта больше — mycel context --brief.`;
  return text;
}

// Хуки агентов: Claude Code (плагин Mycel), Codex (--from codex, ~/.codex/hooks.json), Cursor (--from cursor,
// ~/.cursor/hooks.json). События у них разные, смысл один: после правки файла его блоки «правится сейчас» и «возможно
// устарел»; перед концом ответа — напоминание описать блоки, файлы которых агент менял в этой сессии; в начале сессии —
// обзор карты. Хук не мешает работе: Mycel не запущен или другой версии, папка не подключена, ошибка — тихий выход с
// кодом 0.
// Файлы из патча apply_patch (Codex): строки «*** Add File: путь», «*** Update File:», «*** Delete File:», «*** Move to:».
const patchFiles = command => [...(Array.isArray(command) ? command.join('\n') : String(command)).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)].map(m => m[1]);
// Событие агента в общем виде: kind — edit (files), stop (repeat — уже напоминали), start; session; папка cwd.
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
    const input = ev.tool_input || {};
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
  if (e.kind === 'edit') {
    const base = isDir(project.path) ? project.path : root;
    const files = e.files.map(f => relative(base, resolve(e.cwd, f)).replace(/\\/g, '/')).filter(f => f && !f.startsWith('..') && !isAbsolute(f)).slice(0, 50);
    if (!files.length) return;
    const res = await call(at('/touch'), { actor, files, session });
    // Предупредить о чужих блоках можно только в Claude Code: у других агентов после правки файла ответа хука нет.
    if (from === 'claude' && res.status === 200 && res.value.others.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Mycel: ${res.value.others.map(o => `блок «${o.name}» (${o.id}) сейчас делает ${o.by}`).join('; ')}. Согласуй с человеком, прежде чем править те же файлы.` } }));
  } else if (e.kind === 'stop') {
    if (e.repeat) return;
    const mine = ok(await call(at('/code'))).stale.filter(s => s.by === actor && s.session && s.session === session);
    if (!mine.length) return;
    const reason = `Mycel: в этой сессии ты менял файлы блоков ${mine.map(s => `«${s.name}» (${s.id})`).join(', ')}, а их описание на карте не обновлено. Если устройство поменялось — обнови текст блоков (mycel apply или mycel_apply); если описание верно — подтверди: mycel fresh ${mine.map(s => s.id).join(',')} (mycel_fresh). Потом закончи ответ.`;
    console.log(JSON.stringify(from === 'cursor' ? { followup_message: reason } : { decision: 'block', reason }));
  } else {
    const text = overview(ok(await call(at('/graph'))), ok(await call(at('/code'))));
    // Codex берёт в контекст обычный вывод хука начала сессии, Cursor — additional_context.
    if (from === 'codex') console.log(text);
    else console.log(JSON.stringify(from === 'cursor' ? { additional_context: text } : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
  }
}
// Команда claude: --claude или MYCEL_CLAUDE, claude в PATH, иначе процесс Claude Code, из которого запущена команда
// (CLAUDE_PID): приложение держит claude не в PATH.
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
// Плагин Claude Code для этого компьютера — локальный маркетплейс в <данные>/plugin: MCP-сервер Mycel, хуки (после
// правки файла, конец ответа, начало сессии) и навык с короткой инструкцией. Пути полные: node может не быть в PATH.
// Хук — без оболочки (command и args): событие приходит прямо на стандартный ввод node. Ставит плагин человек: это
// его настройки.
async function plugin() {
  const out = resolve(options.out || join(data, 'plugin')), root = join(out, 'mycel'), slash = p => p.replace(/\\/g, '/');
  const node = slash(process.execPath), cli = slash(join(appRoot, 'mycel.mjs')), server = slash(join(appRoot, 'mcp.mjs'));
  // В виртуальной машине плагин работает через подключение join: адрес и ключ CLI берёт из него сам.
  if (remote && !joined) fail(`Сначала подключи эту копию к Mycel: node mycel.mjs join ${origin} <ключ> --project <id>`);
  const custom = origin !== 'http://127.0.0.1:4317' && !joined;
  // --agent <имя>: запись MCP-сервера для агента без плагинов Claude Code; файлы плагина при этом не нужны.
  // Команда хука для агентов со своими хуками: полные пути и адрес, если Mycel не на 4317.
  const hookFor = from => `\"${node}\" \"${cli}\" hook --from ${from}${custom ? ` --url ${origin}` : ''}`;
  if (options.agent !== undefined) return agentConfig(options.agent, node, server, custom ? { MYCEL_URL: origin } : null, hookFor);
  const handler ={ type: 'command', command: node, args: [cli, 'hook', ...(custom ? ['--url', origin] : [])], timeout: 30 };
  const description = 'Mycel: карта устройства проекта рядом с агентом — MCP-сервер, подсветка правок и устаревших блоков, обзор карты в начале сессии.';
  const json = value => `${JSON.stringify(value, null, 2)}\n`;
  const files = [
    [join(out, '.claude-plugin', 'marketplace.json'), json({ name: 'mycel-local', description: 'Mycel на этом компьютере', owner: { name: 'Mycel' }, plugins: [{ name: 'mycel', source: './mycel', description }] })],
    [join(root, '.claude-plugin', 'plugin.json'), json({ name: 'mycel', version, description, author: { name: 'Mycel' } })],
    [join(root, '.mcp.json'), json({ mcpServers: { mycel: Object.assign({ command: node, args: [server] }, custom ? { env: { MYCEL_URL: origin } } : {}) } })],
    [join(root, 'hooks', 'hooks.json'), json({ hooks: { PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [handler] }], Stop: [{ hooks: [handler] }], SessionStart: [{ hooks: [handler] }] } })],
    [join(root, 'skills', 'mycel', 'SKILL.md'), ['---', 'name: mycel',
      'description: Карта устройства проекта в Mycel. Используй, когда проект подключён к Mycel или человек говорит о карте, блоках, предложении, отметках тестов.', '---',
      'Mycel — общая карта проекта: человек смотрит её в браузере и видит правки агента сразу.', '',
      '- В начале работы прочитай инструкцию: инструмент `mycel_guide`, затем нужную часть карты: `mycel_context` с `focus`.',
      '- Меняешь код — держи карту правдой: у блоков техники и кода поле `files` (файлы блока) и `test` (команда проверки). Блок, чьи файлы ты поменял, помечается «возможно устарел»: обнови его текст (`mycel_apply`) или подтверди (`mycel_fresh`).',
      '- Тесты — `mycel_check` с id блоков: рамки зеленеют и краснеют на глазах у человека.',
      '- Неутверждённые изменения логики — `mycel_propose`, решает человек. Что изменилось за сессию — `mycel_review`, где дыры — `mycel_health`.', ''].join('\n')]
  ];
  for (const [file, text] of files) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); }
  // --install: подключить плагин самому (повторно — безопасно) и убрать отдельно подключённый MCP-сервер mycel, чтобы
  // инструменты не повторялись. Инструменты и хуки появятся в новой сессии Claude Code.
  if (options.install) {
    const claude = findClaude();
    if (claude) {
      const run = list => /\.m?js$/.test(claude) ? spawnSync(process.execPath, [claude, ...list], { encoding: 'utf8', windowsHide: true })
        : claude === 'claude' ? spawnSync(['claude', ...list.map(a => `\"${a}\"`)].join(' '), { encoding: 'utf8', windowsHide: true, shell: true })
        : spawnSync(claude, list, { encoding: 'utf8', windowsHide: true });
      for (const list of [['plugin', 'marketplace', 'add', out, '--scope', 'user'], ['plugin', 'install', 'mycel@mycel-local', '--scope', 'user']]) {
        const r = run(list);
        if (r.status !== 0) fail(`Не удалось: claude ${list.join(' ')}\n${(r.stderr || r.stdout || (r.error && r.error.message) || '').trim()}`);
      }
      run(['mcp', 'remove', 'mycel', '-s', 'user']);
      console.log('Плагин Mycel подключён. Инструменты mycel_* и хуки появятся в новой сессии Claude Code: попроси человека начать её.');
      return;
    }
    console.error('Не нашёл claude: выполни команды подключения ниже сам.');
    process.exitCode = 1;
  }
  console.log([`Плагин Mycel для Claude Code: ${out}`, '',
    'Подключить: node mycel.mjs plugin --install, или вручную:',
    `  claude plugin marketplace add "${out}" --scope user`, '  claude plugin install mycel@mycel-local --scope user',
    'Если MCP-сервер mycel уже подключён отдельно, уберите его, чтобы инструменты не повторялись: claude mcp remove mycel -s user', '',
    'Другие агенты — тот же MCP-сервер Mycel; что и куда вставить, печатает node mycel.mjs plugin --agent <имя>:',
    ...agentConfigs(node, server, custom ? { MYCEL_URL: origin } : null).map(a => `  ${a.id.padEnd(15)}${a.name} — ${a.where}`), '',
    'Своя локальная модель без клиента (Ollama, LM Studio, llama.cpp): node mycel.mjs chat --model <имя> [--base <адрес /v1>].'].join('\n'));
}
// MCP-сервер Mycel для агентов без плагинов Claude Code: файл настроек и запись mycel для него. Сервер тот же, что в
// плагине; пути полные, адрес Mycel — переменной окружения, если он не на 4317 (у копии, подключённой join, не нужен).
// hook(from) — команда хука Mycel для агентов, у которых есть свои хуки (Codex, Cursor).
function agentConfigs(node, server, env, hook = () => '') {
  const json = value => JSON.stringify(value, null, 2), stdio = Object.assign({ command: node, args: [server] }, env ? { env } : {});
  const toml = ['[mcp_servers.mycel]', `command = ${JSON.stringify(node)}`, `args = [${JSON.stringify(server)}]`,
    ...(env ? ['', '[mcp_servers.mycel.env]', ...Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)] : [])].join('\n');
  const envFlags = flag => env ? Object.entries(env).map(([k, v]) => `${flag} ${k}=${v} `).join('') : '', typed = Object.assign({ type: 'stdio' }, stdio);
  // YAML для Continue и Goose: строки — в кавычках JSON (их понимает YAML), пути Windows с двоеточием не ломаются.
  const q = JSON.stringify, envYaml = pad => env ? [`${pad}env:`, ...Object.entries(env).map(([k, v]) => `${pad}  ${k}: ${q(v)}`)] : [];
  const yaml = ['mcpServers:', '  - name: mycel', '    type: stdio', `    command: ${q(node)}`, '    args:', `      - ${q(server)}`, ...envYaml('    ')].join('\n');
  const goose = ['extensions:', '  mycel:', '    name: mycel', '    type: stdio', '    enabled: true', `    cmd: ${q(node)}`, `    args: [${q(server)}]`, ...(env ? [`    envs: ${q(env)}`] : []), '    timeout: 300'].join('\n');
  // Пути и формы — по документации агентов на 28.10.2026. Команды добавления — там, где они документированы (без
  // переменных окружения — только если их нет).
  return [
    { id: 'codex', name: 'Codex CLI', where: '~/.codex/config.toml (для проекта — .codex/config.toml, если проект доверенный)', text: toml,
      command: `codex mcp add mycel ${envFlags('--env')}-- "${node}" "${server}"`,
      hooks: { where: '~/.codex/hooks.json (Codex спросит доверие к хукам: /hooks)', text: json({ hooks: { PostToolUse: [{ matcher: 'apply_patch|Edit|Write', hooks: [{ type: 'command', command: hook('codex'), timeout: 30 }] }], Stop: [{ hooks: [{ type: 'command', command: hook('codex'), timeout: 30 }] }], SessionStart: [{ hooks: [{ type: 'command', command: hook('codex'), timeout: 30 }] }] } }) } },
    { id: 'cursor', name: 'Cursor', where: '~/.cursor/mcp.json (для одного проекта — .cursor/mcp.json в нём)', text: json({ mcpServers: { mycel: typed } }),
      hooks: { where: '~/.cursor/hooks.json', text: json({ version: 1, hooks: { afterFileEdit: [{ command: hook('cursor') }], stop: [{ command: hook('cursor') }], sessionStart: [{ command: hook('cursor') }] } }) } },
    { id: 'antigravity', name: 'Antigravity CLI (сменил Gemini CLI)', where: '~/.gemini/config/mcp_config.json (для проекта — .agents/mcp_config.json в нём)', text: json({ mcpServers: { mycel: stdio } }) },
    { id: 'gemini', name: 'Gemini CLI', where: '~/.gemini/settings.json (для проекта — .gemini/settings.json в нём)', text: json({ mcpServers: { mycel: stdio } }),
      command: `gemini mcp add -s user ${envFlags('-e')}mycel "${node}" "${server}"` },
    { id: 'vscode', name: 'VS Code (Copilot)', where: '.vscode/mcp.json в проекте или общий — «MCP: Open User Configuration»', text: json({ servers: { mycel: typed } }),
      command: env ? null : `code --add-mcp '${JSON.stringify({ name: 'mycel', type: 'stdio', command: node, args: [server] })}'` },
    { id: 'windsurf', name: 'Windsurf / Devin Desktop', where: '~/.config/devin/mcp_config.json (в Windows — %APPDATA%\\devin\\mcp_config.json; прежний Windsurf — ~/.codeium/windsurf/mcp_config.json)', text: json({ mcpServers: { mycel: stdio } }) },
    { id: 'cline', name: 'Cline', where: 'Cline → MCP Servers → Configure MCP Servers (у Cline CLI — ~/.cline/data/settings/cline_mcp_settings.json)', text: json({ mcpServers: { mycel: Object.assign({}, stdio, { disabled: false }) } }),
      command: env ? null : `cline mcp add mycel --yes -- "${node}" "${server}"` },
    // Клиенты локальных моделей.
    { id: 'lmstudio', name: 'LM Studio', where: '~/.lmstudio/mcp.json (Windows — %USERPROFILE%\\.lmstudio\\mcp.json; в приложении — Program → Install → Edit mcp.json)', text: json({ mcpServers: { mycel: stdio } }) },
    { id: 'continue', name: 'Continue', where: '~/.continue/config.yaml (для проекта — .continue/mcpServers/mycel.yaml с name, version, schema: v1); MCP работает в режиме агента', text: yaml },
    { id: 'goose', name: 'Goose', where: '~/.config/goose/config.yaml (Windows — %APPDATA%\\Block\\goose\\config\\config.yaml), раздел extensions; или goose configure → Add Extension → Command-line Extension', text: goose },
    { id: 'opencode', name: 'opencode', where: '~/.config/opencode/opencode.json (для проекта — opencode.json в корне), раздел mcp', text: json(Object.assign({ $schema: 'https://opencode.ai/config.json' }, { mcp: { mycel: Object.assign({ type: 'local', command: [node, server], enabled: true }, env ? { environment: env } : {}) } })) },
    { id: 'jan', name: 'Jan', where: 'mcp_config.json в папке данных Jan (Windows — %APPDATA%\\Jan\\data, macOS — ~/Library/Application Support/Jan/data, Linux — ~/.local/share/Jan/data); дополни mcpServers, не трогая mcpSettings', text: json({ mcpServers: { mycel: Object.assign({}, stdio, { active: true }) } }),
      command: `jan cli mcp add mycel --command "${node}" --arg "${server}" ${envFlags('--env')}--active` },
    { id: 'openwebui', name: 'Open WebUI (через mcpo)', where: 'файл настроек mcpo (mycel.json); затем в Open WebUI — Settings → Integrations → Tools или Admin → Integrations: адрес http://localhost:8000/mycel', text: json({ mcpServers: { mycel: stdio } }),
      command: 'uvx mcpo --port 8000 --config mycel.json' },    { id: 'claude-desktop', name: 'Claude Desktop', where: 'claude_desktop_config.json: Settings → Developer → Edit Config (macOS — ~/Library/Application Support/Claude/, Windows — %APPDATA%\\Claude\\), затем перезапустить приложение', text: json({ mcpServers: { mycel: stdio } }) }
  ];
}// Запись для одного агента: что вставить и куда, и чего у него нет без хуков Claude Code.
function agentConfig(id, node, server, env, hook) {
  const all = agentConfigs(node, server, env, hook), a = all.find(x => x.id === id);
  if (!a) fail(`Агенты: ${all.map(x => x.id).join(', ')}. Claude Code — node mycel.mjs plugin --install.`);
  console.log([`${a.name} — ${a.where}. Добавь запись mycel к остальным серверам, не затирая их:`, '', a.text, '',
    ...(a.command ? [`Или командой: ${a.command}`, ''] : []),
    ...(a.hooks ? [`Хуки Mycel — ${a.hooks.where}: после правки файла его блоки отмечаются сами, в конце ответа приходит напоминание обновить их, в начале сессии — обзор карты. Добавь к остальным хукам:`, '', a.hooks.text, '',
      'Перезапусти агента: инструменты mycel_* и хуки появятся в новой сессии.']
      : ['Перезапусти агента: инструменты mycel_* появятся в новой сессии. Хуков у этой записи нет: запусти node mycel.mjs watch в папке проекта (изменённые файлы отмечаются сами) или после правки файлов вызывай mycel_touch, перед концом работы — обнови описание блоков или mycel_fresh.'])].join('\n'));
}

// Доступ для виртуальных машин. Mycel принимает их запросы на адресе их сети (VMware, VirtualBox, Hyper-V, WSL) и
// только с ключом. on — открыть на адресах виртуальных сетей (или --address), off — закрыть, revoke <id> — отозвать
// ключ машины, без параметров — что открыто, какие машины с доступом и как агенту там всё поставить. Ключ основной
// машины печатается только с --key: агенты получают свои ключи по запросу, который разрешает человек. При первом
// открытии брандмауэр Windows спрашивает про node: отвечает человек.
async function remoteAccess(action) {
  await ensure();
  let state = ok(await call('/api/remote'));
  if (action === 'on' || action === 'off') {
    const wanted = action === 'off' ? [] : options.address ? idList(options.address) : state.interfaces.filter(i => i.vm).map(i => i.address);
    if (!wanted.length && action === 'on') fail(`Адаптеров виртуальных машин не нашёл. Укажите адрес: node mycel.mjs remote on --address <адрес>. Адаптеры: ${state.interfaces.map(i => `${i.name} ${i.address}`).join('; ') || 'нет'}.`);
    state = ok(await call('/api/remote', { addresses: wanted }));
  } else if (action === 'revoke') {
    if (!rest[2]) fail('node mycel.mjs remote revoke <id машины> (id — в node mycel.mjs remote)');
    ok(await call(`/api/devices/${encodeURIComponent(rest[2])}/revoke`, {}));
    console.log(`Ключ машины ${rest[2]} отозван.`);
  } else if (action) fail('node mycel.mjs remote [on [--address адрес,…] | off | revoke <id>] [--key]');
  const access = ok(await call('/api/access'));
  if (!state.listening.length) { console.log('Доступ для виртуальных машин закрыт. Открыть: node mycel.mjs remote on'); return; }
  const name = a => (state.interfaces.find(i => i.address === a) || {}).name || 'адаптер', open = state.listening.filter(l => l.listening);
  // В подсказке — адрес NAT-сети VMware (VMnet8): там виртуальные машины по умолчанию.
  const best = open.find(l => /vmnet8/i.test(name(l.address))) || open[0], first = best ? `http://${best.address}:${state.port}` : null;
  if (options.key && token === null) token = ok(await call('/api/session')).token;
  console.log(['Mycel принимает запросы виртуальных машин — только с ключом:',
    ...state.listening.map(l => l.listening ? `- http://${l.address}:${state.port} (${name(l.address)})` : `- ${l.address}: не открыт — ${l.error}`),
    ...(access.devices.length ? ['', 'Машины с доступом (remote revoke <id> — отозвать):', ...access.devices.map(d => `- ${d.id} · ${d.name} (${d.address})${d.project ? `, проект ${d.project}` : ''}${d.lastSeen ? `, была ${new Date(d.lastSeen).toLocaleString('ru')}` : ''}`)] : []),
    ...(access.pending.length ? ['', 'Ждут ответа (ответ — кнопками в Mycel):', ...access.pending.map(r => `- ${r.name} (${r.address}), код ${r.code}`)] : []),
    ...(first ? ['', 'Агент в виртуальной машине ставит всё сам — Node.js, копию Mycel и запрос доступа:',
      `  curl -fsS ${first}/install.sh | sh`,
      'Человек сверяет код из вывода с кодом в Mycel на основной машине и нажимает «Разрешить».',
      ...(options.key ? ['', `Ключ основной машины (вручную: join <адрес> <ключ>, браузер — ${first}/?key=<ключ>): ${token}`, 'Ключ даёт полный доступ к Mycel: не публикуйте его.'] : []),
      '', 'Закрыть доступ — node mycel.mjs remote off. Если виртуальная машина не достучится: брандмауэр Windows должен пропускать node, а VPN — не забирать сеть виртуальных машин.'] : [])].join('\n'));
}
// Копия Mycel в виртуальной машине подключается к Mycel на основной: адрес, ключ и проект — в <данные>/remote.json.
// Без ключа — запрос доступа: печатается код, человек сверяет его и нажимает «Разрешить» в Mycel на основной машине,
// машина получает свой ключ (ждёт до 10 минут, --timeout). --off — отключить.
async function joinHost() {
  const file = join(data, 'remote.json');
  if (options.off !== undefined || input === '--off' || input === 'off') { await unlink(file).catch(() => {}); console.log('Эта копия Mycel больше не подключена к другой машине.'); return; }
  const address = rest[1];
  let key = rest[2] || null, url = null, granted = null;
  // Адрес можно дать и без http://: 192.168.241.1:4317.
  try { url = new URL(/^[a-z]+:\/\//i.test(address || '') ? address : `http://${address}`); } catch (e) { fail('node mycel.mjs join <адрес> [ключ] [--project id], адрес — например http://192.168.241.1:4317'); }
  if (url.protocol !== 'http:' || !privateHost(url.hostname)) fail('Подключаться можно только к Mycel в локальной сети: ключ не отправляется на другие адреса.');
  if (key !== null && !/^[A-Za-z0-9_-]{16,256}$/.test(key)) fail('Ключ не похож на ключ Mycel. Без ключа join попросит доступ, и человек разрешит его кнопкой.');
  const request = async (path, body) => {
    const res = await fetch(new URL(path, url), { method: body ? 'POST' : 'GET', headers: Object.assign({ 'X-Mycel-Actor': actor }, key ? { Authorization: `Bearer ${key}` } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: res.status, value: await res.json().catch(() => null) };
  };
  const unreachable = () => fail(`Mycel на ${url.origin} не отвечает. На основной машине: node mycel.mjs remote on; брандмауэр Windows должен пропускать node, а VPN — не забирать сеть виртуальных машин.`);
  let h = null;
  try { h = await request('/api/health'); } catch (e) { unreachable(); }
  if (!h.value || h.value.app !== 'mycel') fail(`На ${url.origin} отвечает не Mycel.`);
  if (key === null) {
    const asked = await request('/api/pair', { name: hostname() });
    if (asked.status !== 200) fail(asked.value?.error ?? `Ошибка ${asked.status}.`);
    const limit = Math.min(Number(options.timeout || 600), 3600), until = Date.now() + limit * 1000;
    console.log(`Запрос доступа отправлен на ${url.origin}. Код ${asked.value.code}: человек сверит его и нажмёт «Разрешить» в Mycel на основной машине. Жду до ${Math.round(limit / 60)} мин…`);
    for (;;) {
      if (Date.now() > until) fail('Ответа нет. Попросите доступ снова: node mycel.mjs join <адрес>.', 2);
      await sleep(2000);
      let answer = null;
      try { answer = await request(`/api/pair/${asked.value.id}?secret=${asked.value.secret}`); } catch (e) { continue; }
      if (answer.status !== 200) fail(answer.value?.error ?? `Ошибка ${answer.status}.`);
      const s = answer.value.status;
      if (s === 'approved') { key = answer.value.key; granted = answer.value.project; break; }
      if (s === 'denied') fail('Человек отклонил запрос доступа.');
      if (s === 'expired') fail('Запрос истёк: человек не ответил за 10 минут. Попросите доступ снова: node mycel.mjs join <адрес>.', 2);
    }
    try { h = await request('/api/health'); } catch (e) { unreachable(); }
  }
  if (!h.value.data) fail('Ключ не подходит: попросите доступ заново — node mycel.mjs join <адрес> без ключа.');
  const id = options.project || granted || null, list = (await request('/api/projects')).value?.projects || [];
  if (id && !list.some(p => p.id === id)) fail(`Проекта ${id} там нет. Проекты: ${list.map(p => `${p.id} (${p.name})`).join(', ') || 'нет'}.`);
  await mkdir(data, { recursive: true });
  await writeFile(file, `${JSON.stringify({ url: url.origin, token: key, project: id }, null, 2)}\n`, { mode: 0o600 });
  const me = `"${process.execPath}" "${join(appRoot, 'mycel.mjs')}"`;
  console.log([`Подключено к Mycel на ${url.origin}${id ? `, проект ${id}` : ''}.`,
    ...(h.value.version !== version ? [`Версия там ${h.value.version}, здесь ${version}: обновите копию Mycel здесь, иначе команды откажутся работать.`] : []),
    ...(id ? [] : ['Проект не выбран: повторите join с --project <id> или добавляйте --project к командам. Проекты:', ...list.map(p => `- ${p.id} · ${p.name}`)]),
    `Дальше: инструкция — ${me} guide; команды карты — из папки проекта на этой машине; браузер — ${me} open; плагин Claude Code — ${me} plugin.`].join('\n'));
}
// Инструменты Mycel для любой модели с вызовом функций: описания (--format openai — по умолчанию, или mcp) и вызов по
// имени с аргументами JSON — то же, что делает MCP-сервер. Так Mycel подключается к своему агенту на Ollama, LM Studio,
// llama.cpp или к фреймворку без MCP.
async function listTools() {
  const { tools, schema } = await import('./src/tools.mjs'), format = options.format || 'openai';
  if (!['openai', 'mcp'].includes(format)) fail('--format openai или mcp');
  console.log(JSON.stringify(tools.map(t => format === 'mcp' ? { name: t.name, description: t.description, inputSchema: schema(t) } : { type: 'function', function: { name: t.name, description: t.description, parameters: schema(t) } }), null, 2));
}
// Переменные для команды, которую запускает инструмент: адрес, данные и ключ, заданные этой команде явно.
const childEnv = () => Object.assign({}, process.env, options.url ? { MYCEL_URL: origin } : {}, options.data ? { MYCEL_DATA: data } : {}, options.token ? { MYCEL_TOKEN: token } : {});
async function callTool() {
  const { tools, runTool, toolResult } = await import('./src/tools.mjs');
  const tool = tools.find(t => t.name === input || t.name === `mycel_${input}`);
  if (!tool) fail(`Нет инструмента ${input || ''}. Список: node mycel.mjs tools.`);
  const raw = rest[2] === undefined ? '{}' : rest[2] === '-' ? await readText('-') : rest[2];
  let args = null;
  try { args = JSON.parse(raw.replace(/^\uFEFF/, '') || '{}'); } catch (e) { fail(`Аргументы — не JSON: ${e.message}`); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('Аргументы — JSON-объект.');
  const r = toolResult(tool, await runTool(tool, args, { cwd: process.cwd(), actor, env: childEnv() }));
  console.log(r.text);
  if (r.error) quit(1);
}
// Слежение за файлами проекта — для любого агента и для правок человека в редакторе: изменённые файлы отмечаются так
// же, как хук Claude Code после правки (touch): их блоки — «устарел?», над ними имя (по умолчанию editor). Изменения
// собираются за секунду; зависимости, сборка, .git и данные не смотрятся. Работает, пока его не остановят.
async function watchFiles() {
  const { watch } = await import('node:fs'), root = here();
  let queue = new Set(), timer = null;
  const flush = async () => {
    timer = null;
    const files = [...queue].slice(0, 50); queue = new Set([...queue].slice(50));
    if (queue.size) timer = setTimeout(flush, 1000);
    if (!files.length) return;
    const res = await call(at('/touch'), { actor, files }).catch(e => ({ status: 0, value: { error: e.message } }));
    if (res.status !== 200) { console.error(`Не отмечено (${files.join(', ')}): ${res.value?.error ?? res.status}`); return; }
    const r = res.value;
    if (r.blocks.length) console.log(`${new Date().toLocaleTimeString('ru')} ${files.join(', ')} → ${r.blocks.map(b => `«${b.name}»`).join(', ')}`);
    for (const o of r.others) console.log(`Блок «${o.name}» (${o.id}) сейчас делает ${o.by}.`);
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
  console.log(`Слежу за ${root}: изменённые файлы отмечаются на карте проекта «${project.name}» от имени ${actor}. Ctrl+C — остановить.`);
  await new Promise(() => {});
}
// Встроенный агент для локальной модели (src/agent.mjs): сервер с OpenAI-совместимым API — --base или MYCEL_LLM_URL,
// по умолчанию Ollama (http://127.0.0.1:11434/v1); модель — --model или MYCEL_LLM_MODEL, иначе первая из /models; ключ —
// MYCEL_LLM_KEY. Текст задачи после chat — один ход, без него — разговор. Имя на карте — local-<модель>.
async function chat() {
  const { runChat } = await import('./src/agent.mjs');
  const llm = (options.base || env('LLM_URL') || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''), key = env('LLM_KEY') || null;
  let model = options.model || env('LLM_MODEL') || null;
  if (!model) {
    const list = await fetch(`${llm}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) }).then(r => r.json(), () => null);
    model = list?.data?.[0]?.id || list?.models?.[0]?.name || null;
    if (!model) fail(`Нет ответа от ${llm}/models. Запусти Ollama, LM Studio или llama-server и укажи модель: --model <имя> (--base <адрес /v1>).`);
  }
  if (!options.actor && !env('ACTOR')) actor = `local-${model.replace(/[^A-Za-z0-9._-]+/g, '-')}`.slice(0, 60);
  await ensure();
  const { root, git, path } = projectRoot(process.cwd()), id = projectId();
  let res = await call(id ? `/api/p/${encodeURIComponent(id)}` : `/api/projects?${new URLSearchParams(Object.assign({ path }, git ? { root } : {}))}`);
  if (!id && res.status === 404 && joined && joined.project) res = await call(`/api/p/${encodeURIComponent(joined.project)}`);
  project = res.status === 200 && !res.value.project.error ? res.value.project : null;
  const guide = await renderGuide({ url: origin, short: true });
  const view = project ? overview(ok(await call(at('/graph'))), ok(await call(at('/code')))) : `Папка ${root} не подключена к Mycel: подключи её — mycel_init (название — по смыслу проекта).`;
  const system = [guide, '', view, '', `Ты работаешь в папке проекта ${project ? here() : root}. Инструменты mycel_* меняют карту, которую человек видит в браузере; list_files, read_file и search_files читают код проекта. Код ты не меняешь.`].join('\n');
  // Конец ответа: блоки, чьи файлы отметили изменёнными от твоего имени, — описать заново или подтвердить.
  const afterTurn = async () => {
    if (!project) return null;
    const mine = ok(await call(at('/code'))).stale.filter(s => s.by === actor);
    return mine.length ? `Mycel: файлы блоков ${mine.map(s => `«${s.name}» (${s.id})`).join(', ')} изменены, а описание этих блоков не обновлено. Обнови их (mycel_apply) или подтверди, что описание верно (mycel_fresh), и коротко ответь.` : null;
  };
  console.error(`Mycel и модель ${model} (${llm}), имя на карте — ${actor}${project ? `, проект «${project.name}»` : ''}.`);
  try { await runChat({ base: llm, model, key, actor, cwd: project ? here() : root, system, prompt: rest.slice(1).join(' ').trim() || null, env: childEnv(), afterTurn }); }
  catch (e) { fail(e.message); }
}
const projectCommands = ['context', 'graph', 'changes', 'wait', 'selection', 'apply', 'build', 'propose', 'mark', 'doing', 'show', 'touch', 'fresh', 'check', 'review', 'health', 'overview', 'watch'];
async function main() {
  if (!command || command === 'help') return console.log(usage);
  if (![...projectCommands, 'init', 'projects', 'open', 'start', 'stop', 'guide', 'hook', 'plugin', 'remote', 'join', 'tools', 'call', 'chat'].includes(command)) { console.log(usage); quit(1); }
  if (missing) fail(`Укажите значение для ${missing}.`);
  if (command === 'join') return joinHost();
  if (!base || base.protocol !== 'http:' || !(loopback || privateHost(base.hostname))) fail('Mycel работает на этом компьютере или в локальной сети (основная машина для виртуальной): ключ не отправляется на другие адреса.');
  if (remote && !token && command !== 'guide' && command !== 'hook') fail(`Для Mycel на другой машине нужен ключ: node mycel.mjs join ${origin} <ключ> --project <id> (ключ печатает «node mycel.mjs remote» на основной машине).`);
  if (remote && ['start', 'stop', 'remote'].includes(command)) fail('Это делается на основной машине: там запускают и останавливают Mycel и открывают доступ.');
  // Хуки запускает агент, чей это хук (--from: codex, cursor; по умолчанию Claude Code); правки, замеченные watch, —
  // от имени editor. Явное имя (--actor, MYCEL_ACTOR) важнее.
  if (!options.actor && !env('ACTOR')) { if (command === 'hook') actor = options.from || 'claude'; if (command === 'watch') actor = 'editor'; }
  if (!/^[ -~]{1,100}$/.test(actor) || !actor.trim()) fail('Имя агента (--actor) — латиницей, до 100 символов.');
  if (command === 'hook') { try { await hook(); } catch (e) { /* хук молчит: ответ Claude Code не должен ломаться */ } return; }
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
      // Человек открывает Mycel после обновления: хаб прежней версии с теми же данными сменяется текущим. Агентские
      // команды так не делают — они только сообщают, что Mycel обновлён.
      const h = await health();
      if (!remote && !options['no-start'] && ours(h?.app) && h.version !== version && typeof h.data === 'string' && pathKey(h.data) === pathKey(data) && (await stopHub(h)).status === 200) console.error(`Остановлен Mycel ${h.version}.`);
      await ensure();
      // В виртуальной машине браузер открывается по ссылке с ключом: Mycel ставит cookie и убирает ключ из адреса.
      const url = `${origin}/`, link = remote ? `${origin}/?key=${token}` : url;
      const [file, list, extra] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `start "" "${link}"`], { windowsVerbatimArguments: true }] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [link], {}];
      try { const child = spawn(file, list, { ...extra, detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', () => {}); child.unref(); } catch { /* браузер не открылся: адрес напечатан */ }
      console.log(`Mycel: ${url}`);
      break;
    }
    case 'stop': {
      const h = await health();
      if (!h) { console.log('Mycel не запущен.'); break; }
      check(h, true);
      const res = await stopHub(h);
      if (res.status !== 200) fail(`Ошибка ${res.status}: ${res.value?.error ?? res.value}`);
      console.log(`Mycel остановлен: ${origin}.`);
      break;
    }
    case 'init': {
      const folder = resolve(input ?? '.');
      if (!isDir(folder)) fail(`Нет такой папки: ${folder}`);
      await ensure();
      // Репозиторий — свой проект, как и при поиске: подключённая или удалённая папка выше его корня не в счёт (root),
      // иначе следующая команда не нашла бы проект, в который «входит» папка. Удалённый проект самого репозитория — стоп.
      const { root, git } = projectRoot(folder);
      const res = await call('/api/projects', { path: root, ...(git ? { root } : {}), ...(options.name ? { name: options.name } : {}), ...(options.project ? { id: options.project } : {}), ...(options.move ? { move: true } : {}), ...(options.new ? { new: true } : {}) });
      if (res.value?.deleted) fail(deletedText(res.value.deleted.name));
      if (res.status !== 200) fail(res.status === 400 ? `${res.value?.error} Папка: ${root}` : res.value?.error ?? `Ошибка ${res.status}.`);
      const { project: p, created, moved, renamed, ancestor } = res.value, link = `${origin}/#/p/${p.id}`;
      console.log(created ? `Проект «${p.name}» подключён: ${link}` : moved ? `Проект «${p.name}» теперь в папке ${p.path}` : renamed ? `Проект переименован в «${p.name}»: ${link}` : ancestor ? `Папка входит в проект «${p.name}» (${p.path}): ${link}` : `Проект «${p.name}» уже подключён: ${link}`);
      break;
    }
    case 'projects': {
      await ensure();
      const { projects } = ok(await call('/api/projects'));
      console.log(projects.length ? projects.map(p => `${p.id} · ${p.name} · ${[p.path, p.machine && `(на машине «${p.machine.name}»)`, p.exists === false && '(папки нет)'].filter(Boolean).join(' ')}${p.error ? ` · не открывается: ${p.error}` : ''}`).join('\n') : 'Проектов нет.');
      break;
    }
    case 'context': {
      const query = new URLSearchParams({ ...(options.focus ? { focus: options.focus } : {}), ...(options.brief ? { brief: '1' } : {}) }).toString();
      // Карта уже получена целиком: прочитанное записывается до печати, чтобы его не потерял обрезанный вывод. Действия
      // человека считаются прочитанными только вместе с печатью: иначе то, что пришло, пока агент не ждал, пропало бы.
      const cursor = await readCursor(), value = ok(await call(at(`/context${query ? `?${query}` : ''}`)));
      const unread = ok(await call(at(`/chat?since=${cursor.chat}`)));
      const fresh = unread.messages.filter(m => m.updatedBy !== actor && m.kind !== 'log'), shown = fresh.slice(-20);
      const news = shown.length ? `\n## ${chatHeader}\n${fresh.length > shown.length ? `(раньше ещё ${fresh.length - shown.length})\n` : ''}${formatChat(shown, ok(await call(at('/graph'))))}` : null;
      await saveCursor({ revision: Number(/^Ревизия: (\d+)/m.exec(value)[1]), chat: unread.seq });
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
        // Курсор не сдвигается, пока не было правки содержимого или сообщения: накопленные перемещения придут вместе с ними.
        try { res = await call(changesUrl(cursor, `&wait=${wait}${options.all ? '' : '&content=1'}`)); }
        catch {
          // Хаб перезапускается или недоступен: ждём его, не завершаясь. Удалённый проект — сразу выход, без повторов.
          if (!warned) console.error('Mycel недоступен, продолжаю ждать…');
          warned = true; await sleep(3000); continue;
        }
        warned = false;
        const value = ok(res);
        if (!value.complete || value.chat.messages.length || (options.all ? value.entries.length > value.held : value.contentChanged)) return report(value);
      }
      fail('Изменений не было.', 2);
      break;
    }
    case 'apply': {
      const body = await readInput(), operations = Array.isArray(body) ? body : body?.operations;
      await write(options.message ?? body?.message ?? 'Изменения агента', operations);
      break;
    }
    case 'build': {
      // Структура строится по свежей карте и только если её не меняли после чтения агента.
      const spec = await readInput(), { revision } = await needCursor(), current = ok(await call(at('/graph')));
      if (current.revision !== revision) await conflict(revision);
      const { ops, outline } = buildOps(spec, current), after = ['', 'Блоки (id — название):', ...outline];
      if (!ops.length) {
        if (!spec.blocks?.length && !spec.notes?.length && !spec.links?.length) fail('В структуре нет блоков, заметок и связей.');
        console.log(['Всё из структуры уже есть на карте.', ...after].join('\n'));
        break;
      }
      // Итог считается заранее: ошибка в структуре и нарушение уровней видны до первой записи, а шаги получают
      // готовую геометрию. Проверяется только то, что будет записано: при повторе уже записанное пропущено.
      const final = applyOperations(current, ops).graph;
      checkLevels(current, ops);
      await commitSteps(options['at-once'] ? [ops] : stages(current, final, ops, spec.parent ?? null), options.message ?? spec.message ?? 'Построена структура карты', revision, after);
      break;
    }
    case 'propose': {
      // Структура в формате build и (или) операции apply; новое ложится пунктиром с подсветкой, решает человек.
      const spec = await readInput(), { revision } = await needCursor(), current = ok(await call(at('/graph')));
      if (current.revision !== revision) await conflict(revision);
      const list = Array.isArray(spec) ? spec : null, structure = !list && (spec?.blocks || spec?.notes || spec?.links);
      const { ops, outline } = structure ? buildOps(spec, current) : { ops: [], outline: [] };
      const operations = [...ops, ...(list ?? spec?.operations ?? [])], title = options.message ?? spec?.title ?? spec?.message;
      if (!operations.length) fail('В предложении нет ни блоков, ни операций: всё из структуры уже есть на карте.');
      if (!current.proposal && !(typeof title === 'string' && title.trim())) fail('Назовите предложение: "title" в файле или -m.');
      checkLevels(current, operations);
      const res = await call(at('/proposal'), { expectedRevision: revision, actor, title, operations });
      if (res.status === 409) await conflict(revision);
      const next = ok(res).revision;
      await saveCursor({ revision: next });
      await written([next], [...(outline.length ? ['', 'Блоки (id — название):', ...outline] : []), '', `Предложение «${ok(res).proposal.title}» на карте: новое — пунктиром с подсветкой. Принимает или отклоняет его человек кнопками; решение придёт в wait и changes.`]);
      break;
    }
    case 'mark': {
      const ids = (input ?? '').split(',').map(x => x.trim()).filter(Boolean), value = rest[2];
      if (!ids.length || !['plan', 'testing', 'passed', 'failed', 'none'].includes(value)) fail('mycel mark <id[,id…]> plan|testing|passed|failed|none');
      await write(options.message ?? `Отметка: ${value === 'none' ? 'без отметки' : markNames[value]}`, ids.map(id => ({ type: 'update-node', id, patch: { status: value === 'none' ? null : value } })));
      break;
    }
    case 'selection': {
      // О чём человек говорит: выделенный узел и блок, в котором он работает, — с полным текстом.
      const { focus, selection } = ok(await call(at('/selection'))), graph = ok(await call(at('/graph'))), name = namer(graph);
      const full = (label, id) => { const n = graph.nodes.find(x => x.id === id); return [`${label}: ${name(id)} — ${n.type === 'note' ? 'заметка' : 'блок'}${n.parentId ? ` внутри ${name(n.parentId)}` : ' на основной карте'}${n.status ? `, ${markNames[n.status]}` : ''}`, ...(n.text ? [n.text] : [])].join('\n'); };
      console.log([selection && full('Выделено', selection), focus && full('Работает в блоке', focus)].filter(Boolean).join('\n\n') || 'Человек ничего не выделил и ни в каком блоке не работает.');
      break;
    }
    case 'doing': {
      const text = options.done ? null : rest.slice(1).join(' ').trim(), progress = options.progress === undefined ? null : Number(options.progress);
      if (!options.done && !text) fail('mycel doing \'что делаешь сейчас\' [--progress 0–100] [--on id,…] или mycel doing --done');
      const blocks = text ? idList(options.on) : [], r = ok(await call(at('/activity'), { actor, text, progress, blocks }));
      console.log([text ? `Под картой: «${text}»${progress !== null ? `, ${progress} %` : ''}${blocks.length ? `; блоки ${blocks.join(', ')} помечены твоим именем` : ''}.` : 'Строка под картой снята.',
        ...r.others.map(o => `Блок «${o.name}» (${o.id}) сейчас делает ${o.by}: согласуй с человеком, прежде чем браться за него.`)].join('\n'));
      break;
    }
    case 'show': {
      if (!input) fail('mycel show <id блока>');
      ok(await call(at('/show'), { id: input, actor }));
      console.log(`Показан человеку: ${namer(ok(await call(at('/graph'))))(input)}.`);
      break;
    }
    // Файлы, которые агент меняет (то же, что хук Claude Code после правки файла): их блоки — «правится сейчас».
    case 'touch': {
      const files = rest.slice(1).map(f => relative(here(), resolve(f)).replace(/\\/g, '/')).filter(f => f && !f.startsWith('..') && !isAbsolute(f));
      if (!files.length) fail('mycel touch <файл…> — файлы внутри папки проекта.');
      const r = ok(await call(at('/touch'), { actor, files }));
      console.log([r.blocks.length ? `Блоки этих файлов: ${r.blocks.map(b => `«${b.name}» (${b.id})`).join(', ')} — отмечены «возможно устарел», пока их не опишешь заново или не подтвердишь (mycel fresh).` : 'Ни у одного блока нет этих файлов.',
        ...r.others.map(o => `Блок «${o.name}» (${o.id}) сейчас делает ${o.by}.`)].join('\n'));
      break;
    }
    case 'fresh': {
      const ids = options.all ? null : idList(input);
      if (ids !== null && !ids.length) fail('mycel fresh <id[,id…]> или mycel fresh --all');
      const { fresh } = ok(await call(at('/fresh'), { actor, ids }));
      console.log(fresh.length ? `Описание подтверждено, пометка «устарел» снята: ${fresh.join(', ')}.` : 'Устаревших блоков среди них нет.');
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
  // Ошибка модели (например, в структуре build) и пропавший хаб — сообщением, без трассировки.
  else if (e instanceof Problem) { console.error(e.message); process.exitCode = 1; }
  else if (e instanceof TypeError && e.message === 'fetch failed') { console.error(`Mycel не отвечает: ${origin}.`); process.exitCode = 1; }
  else throw e;
}
