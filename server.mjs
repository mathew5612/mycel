import http from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { gzipSync } from 'node:zlib';
import { applyOperations, propose, acceptProposal, rejectProposal, review, reviewText, statusNames, nodeName, Problem } from './src/model.mjs';
import { openHub, lockHub } from './src/hub.mjs';
import { realDir, defaultData } from './src/paths.mjs';
import { renderGuide, editingLine } from './src/guide.mjs';
import { openAccess } from './src/access.mjs';
import { levelNames, levelOf } from './src/levels.mjs';

const appRoot = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
const publicGraph = graph => { const { history, ...rest } = graph; return rest; };
// Уровень абстракции по глубине вложенности: концепция, механика, техника, код (всё глубже).
export { levelNames };
const proposedNames = { add: 'добавить', change: 'изменить', remove: 'удалить' };
// Узел и всё, что лежит в его подкартах.
const subtreeIds = (graph, id) => {
  const inside = new Set([id]);
  for (let changed = true; changed; ) { changed = false; for (const n of graph.nodes) if (!inside.has(n.id) && inside.has(n.parentId)) { inside.add(n.id); changed = true; } }
  return inside;
};
// Карта в Markdown для агента. focusId — только этот блок со всем вложенным и его связи с остальной картой:
// агенту, который работает над одним модулем, не нужно читать всё. humanFocus — над чем сейчас работает человек.
// brief — без координат и размеров: агенту, который только читает смысл карты, они не нужны. edit — человек сейчас
// правит карту и ещё не нажал «Закончить правки». selection — что человек выделил на карте. code — устаревшие блоки
// (их файлы изменили после описания) и кто над чем работает.
function context(graph, focusId = null, humanFocus = null, brief = false, edit = null, selection = null, code = null) {
  const stale = code?.stale ?? {}, work = code?.work ?? [];
  const title = id => graph.nodes.find(n => n.id === id)?.title || id;
  const at = parentId => graph.nodes.filter(n => n.parentId === parentId);
  const blocks = graph.nodes.filter(n => n.type !== 'note'), mark = x => x.proposed ? ` | предложено: ${proposedNames[x.proposed]}` : '';
  const selected = selection && graph.nodes.find(n => n.id === selection);
  const focus = focusId && graph.nodes.find(n => n.id === focusId && n.type === 'block');
  if (focusId && !focus) throw new Problem('Блок для фокуса не найден.');
  const inside = focus ? subtreeIds(graph, focus.id) : null;
  const lines = ['# Карта', `Ревизия: ${graph.revision}`, '', `Блоков: ${blocks.length}, заметок: ${graph.nodes.length - blocks.length}, связей: ${graph.edges.length}.`, '',
    ...(humanFocus ? [`Человек сейчас в фокусе на блоке «${title(humanFocus)}» (${humanFocus}): отвечай и работай в его рамках.`, ''] : []),
    ...(selected ? [`Человек выделил на карте ${selected.type === 'note' ? 'заметку' : 'блок'} «${nodeName(selected)}» (${selected.id}): «это», «вот этот блок» в его словах — скорее всего он.`, ''] : []),
    ...(edit ? [editingLine(edit), ''] : []),
    ...(graph.proposal ? [`Открыто предложение «${graph.proposal.title}» (${graph.proposal.by}): ${['add', 'change', 'remove'].map(k => `${proposedNames[k]} — ${graph.nodes.filter(n => n.proposed === k).length}`).join(', ')}. Принимает или отклоняет его человек; дополнить — mycel propose, поправить предложенные карточки — mycel apply.`, ''] : []),
    ...(graph.nodes.some(n => n.status) ? ['Отметки блоков (рамкой): «план, кода нет» — пунктир, логика без готового кода; «идёт проверка» — пульсирует; «проверен» — зелёная, код написан и тесты прошли; «проверка не прошла» — красная.', ''] : []),
    ...(Object.keys(stale).length ? [`Возможно устарели (их файлы изменили после того, как блок описали): ${Object.entries(stale).map(([id, s]) => `«${title(id)}» (${id}) — ${s.files.join(', ')}`).join('; ')}. Обнови текст этих блоков или подтверди, что он верен: mycel fresh <id>.`, ''] : []),
    ...(work.length ? [`Сейчас работают: ${work.map(w => `${w.actor} — ${w.blocks.map(id => `«${title(id)}» (${id})`).join(', ') || w.files.join(', ')}`).join('; ')}. Не берись за чужие блоки без просьбы человека.`, ''] : []),
    ...(focus ? [`Показан только фокус: «${title(focus.id)}» со всем вложенным и его связи с остальной картой.`, ''] : []),
    brief ? 'Блок может содержать подкарту: вложенные блоки и заметки (parentId — id блока). Заметка может быть прикреплена к блоку своего уровня (attachedTo).'
      : 'Блок может содержать подкарту: вложенные блоки и заметки (parentId — id блока). Их x и y отсчитываются от левого верхнего угла поля подкарты: оно лежит внутри рамки блока под его шапкой. w и h блока — его собственный размер; развёрнутая подкарта на экране растёт под содержимое. Заметка может быть прикреплена к блоку своего уровня (attachedTo).', '',
    'Уровни абстракции задаются вложенностью. Концепция (блоки основной карты) и механика (их подкарты) — для людей без программирования: что это и как работает, название в 1–4 простых слова, текст — одно короткое предложение, связи подписаны простыми словами; без кода, файлов и имён из кода. Техника (подкарты механики) — для разработчиков: компоненты, файлы и библиотеки в `обратных кавычках`, настройки, данные, технические риски заметками. Код (подкарты техники и глубже) — шаги в порядке выполнения: название — действие, в тексте функция и файл в `обратных кавычках`.', ''];
  const block = (n, depth) => {
    const level = at(n.parentId);
    lines.push(`${'#'.repeat(Math.min(depth + 3, 6))} ${n.title || 'без названия'}`, `ID: ${n.id} | уровень: ${levelOf(depth)}${brief ? '' : ` | x: ${n.x}, y: ${n.y}, w: ${n.w}, h: ${n.h}`}${n.color ? ` | цвет: ${n.color}` : ''}${n.parentId ? ` | внутри: ${n.parentId}` : ''}${n.collapsed ? ' | подкарта свёрнута' : ''}${n.status ? ` | ${statusNames[n.status]}` : ''}${stale[n.id] ? ' | возможно устарел' : ''}${mark(n)}`);
    if (n.text) lines.push('', n.text);
    if (n.files) lines.push('', `Файлы: ${n.files.join(', ')}`);
    if (n.test) lines.push('', `Проверка: \`${n.test}\``);
    for (const note of level.filter(x => x.type === 'note' && x.attachedTo === n.id)) lines.push('', `Заметка (${note.id})${mark(note)}: ${note.text}`);
    lines.push('');
    visit(n.id, depth + 1);
  };
  const visit = (parentId, depth) => {
    const level = at(parentId);
    for (const n of level.filter(x => x.type !== 'note')) block(n, depth);
    const free = level.filter(x => x.type === 'note' && x.attachedTo === null);
    if (free.length) { lines.push(`${parentId ? `Заметки внутри «${title(parentId)}» (${parentId})` : '## Заметки'}`); for (const n of free) lines.push(`- (${n.id})${mark(n)} ${n.text}`); lines.push(''); }
  };
  if (focus) { let depth = 0; for (let p = focus.parentId; p; p = graph.nodes.find(n => n.id === p)?.parentId) depth++; block(focus, depth); }
  else visit(null, 0);
  // id связи — для update-edge и delete-edge.
  const edge = e => `- ${title(e.source)} (${e.source}) → ${title(e.target)} (${e.target})${e.label ? `: ${e.label}` : ''} · id: ${e.id}${mark(e)}`;
  if (focus) {
    lines.push('## Связи внутри', ...graph.edges.filter(e => inside.has(e.source) && inside.has(e.target)).map(edge), '');
    lines.push('## Связи с остальной картой', ...graph.edges.filter(e => inside.has(e.source) !== inside.has(e.target)).map(edge));
  } else lines.push('## Связи', ...graph.edges.map(edge));
  return lines.join('\n');
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new Problem('Используйте Content-Type: application/json.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Problem('Тело запроса больше 1 МБ.', 413); chunks.push(chunk); }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new Problem('Некорректный JSON-объект.'); }
}
// Токен API переживает перезапуск: открытые вкладки и агенты не теряют доступ. Новый — только если файла нет.
async function apiToken(data) {
  const file = join(data, 'token'), old = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (/^[A-Za-z0-9_-]{16,256}$/.test(old)) return old;
  const token = randomBytes(32).toString('hex');
  await writeFile(file, token + '\n', { mode: 0o600 });
  return token;
}
const isCount = v => v == null || (Number.isSafeInteger(v) && v >= 0);

// Сетевые адаптеры компьютера (IPv4, кроме loopback); vm — адаптер виртуальных машин (VMware, VirtualBox, Hyper-V, WSL).
const interfaces = () => Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter(i => i.family === 'IPv4' && !i.internal)
  .map(i => ({ name, address: i.address, vm: /vmware|vmnet|virtualbox|vboxnet|hyper-v|vethernet|wsl|virbr|utun|bridge100/i.test(name) })));
const readCookie = (header, name) => (header ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
// Копия Mycel для виртуальной машины: программа без данных и тестов, архивом tar.gz (ustar), чтобы поставить её одной
// командой curl … | tar xz.
async function bundle() {
  const files = ['mycel.mjs', 'mcp.mjs', 'server.mjs', 'package.json', 'README.md', 'docs/reference.md', 'LICENSE', 'Mycel.command'];
  for (const dir of ['src', 'public']) for (const name of (await readdir(join(appRoot, dir))).sort()) files.push(`${dir}/${name}`);
  const blocks = [], mtime = Math.floor(Date.now() / 1000);
  for (const name of files) {
    const body = await readFile(join(appRoot, name)), head = Buffer.alloc(512);
    const put = (text, at, size) => head.write(text, at, size, 'utf8');
    put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
    put(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12); put(`${mtime.toString(8).padStart(11, '0')}\0`, 136, 12);
    put('        ', 148, 8); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
    put(`${head.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(head, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

// Установка в виртуальной машине (Linux, macOS): Node.js 22+ — системный или официальный с nodejs.org с проверкой
// SHA-256 в ~/.mycel-node, копия Mycel с основной машины в ~/mycel (MYCEL_DIR), затем запрос доступа (join): ключ
// машина получит, когда человек нажмёт «Разрешить». У подключённой копии повторный запуск только обновляет её.
const installScript = origin => `#!/bin/sh
# Mycel для этой машины: Node.js 22+, копия Mycel и запрос доступа к Mycel на основной машине (${origin}).
set -e
HOST="${origin}"
DIR="\${MYCEL_DIR:-$HOME/mycel}"
fit() { command -v "$1" >/dev/null 2>&1 && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; }
NODE=node
if ! fit node; then
  NODE="$HOME/.mycel-node/bin/node"
  if ! fit "$NODE"; then
    case "$(uname -s)" in Linux) os=linux;; Darwin) os=darwin;; *) echo "Поставьте Node.js 22+ сами: https://nodejs.org"; exit 1;; esac
    case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "Поставьте Node.js 22+ сами: https://nodejs.org"; exit 1;; esac
    base=https://nodejs.org/dist/latest-v22.x
    line=$(curl -fsSL "$base/SHASUMS256.txt" | grep " node-v22[.0-9]*-$os-$arch.tar.gz$" | head -n 1)
    [ -n "$line" ] || { echo "Не нашёл Node.js 22 для $os-$arch на nodejs.org"; exit 1; }
    file=\${line##* }; sum=\${line%% *}; tmp=$(mktemp -d)
    echo "Скачиваю $file…"
    curl -fsSL "$base/$file" -o "$tmp/$file"
    got=$( (sha256sum "$tmp/$file" 2>/dev/null || shasum -a 256 "$tmp/$file") | cut -d ' ' -f 1)
    [ "$got" = "$sum" ] || { echo "Контрольная сумма Node.js не совпала — не ставлю."; rm -rf "$tmp"; exit 1; }
    mkdir -p "$HOME/.mycel-node"
    tar xzf "$tmp/$file" -C "$HOME/.mycel-node" --strip-components=1
    rm -rf "$tmp"
  fi
fi
mkdir -p "$DIR"
curl -fsS "$HOST/download/mycel.tar.gz" | tar xz -C "$DIR"
echo "Mycel: $DIR, node: $NODE"
# Копия уже подключена: это обновление, доступ прежний.
if [ -f "$DIR/.mycel/remote.json" ] && [ $# -eq 0 ]; then echo "Mycel обновлён, подключение прежнее."; exit 0; fi
exec "$NODE" "$DIR/mycel.mjs" join "$HOST" "$@"
`;

// Один процесс на все проекты. onStop — как остановить процесс по команде mycel.mjs stop; без него хаб
// останавливает только тот, кто его запустил. listen — адреса для виртуальных машин вместо listen.json (для тестов).
export async function startServer({ data, port = 4317, onStop = null, listen = null } = {}) {
  data = resolve(data ?? (process.env.MYCEL_DATA || process.env.KONTUR_DATA || defaultData(appRoot)));
  await mkdir(data, { recursive: true }); data = realDir(data);
  const lock = await lockHub(data, port);
  let hub = null, token, access = null;
  try { token = await apiToken(data); hub = await openHub(data); access = await openAccess(data, () => hub.notify({ access: accessInfo() })); }
  catch (e) { await hub?.close(); await lock.release(); throw e; }
  // Запросы доступа и машины с доступом — для карточки «Разрешить» и списка машин на основной машине.
  const accessInfo = () => ({ pending: access.pending(), devices: access.devices(), projects: hub.list().map(p => ({ id: p.id, name: p.name })) });
  const auth = value => {
    const actual = Buffer.from(value ?? ''); const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  // Виртуальные машины (mycel remote): на каждом адресе из listen.json — свой сервер с тем же обработчиком и портом.
  const listenFile = join(data, 'listen.json'), remotes = new Map();
  const openRemote = address => new Promise(done => {
    const s = http.createServer((req, res) => handle(req, res, address));
    s.requestTimeout = 15000; s.headersTimeout = 10000;
    s.once('error', e => { remotes.set(address, { server: null, error: e.code === 'EADDRNOTAVAIL' ? 'такого адреса сейчас нет на этом компьютере' : e.code === 'EADDRINUSE' ? 'порт на этом адресе занят' : e.message }); done(); });
    s.listen(server.address().port, address, () => { remotes.set(address, { server: s, error: null }); done(); });
  });
  const closeRemote = async address => {
    const r = remotes.get(address); remotes.delete(address);
    if (r?.server) await new Promise(ok => { r.server.close(ok); r.server.closeAllConnections(); });
  };
  const setRemotes = async addresses => {
    for (const a of [...remotes.keys()]) if (!addresses.includes(a)) await closeRemote(a);
    for (const a of addresses) if (!remotes.get(a)?.server) await openRemote(a);
  };
  const remoteInfo = () => [...remotes].map(([address, r]) => ({ address, listening: Boolean(r.server), ...(r.error ? { error: r.error } : {}) }));
  const handle = async (req, res, remote) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    let p = null;
    try {
      const actualPort = server.address().port;
      const hosts = remote ? [`${remote}:${actualPort}`] : [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!hosts.includes(req.headers.host)) throw new Problem('Недопустимый Host.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      // Из виртуальной машины — только с ключом: заголовок Bearer (агент) или cookie, которую ставит ссылка /?key=…
      // (браузер). Без ключа видно только, что здесь Mycel и какой версии; запуск, остановка, подключение папок и
      // настройка доступа — только на основной машине.
      // Ключ — токен основной машины или ключ машины, получившей доступ по запросу (src/access.mjs).
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
      const valid = key => typeof key === 'string' && key !== '' && (auth(`Bearer ${key}`) || Boolean(access.check(key)));
      // device — машина с собственным ключом: её проекты и папки свои (src/hub.mjs, machine).
      let usedKey = null, device = null;
      if (remote) {
        const presented = bearer ?? readCookie(req.headers.cookie, 'mycel_key'), keyed = valid(presented);
        if (keyed) { usedKey = presented; device = access.check(presented); }
        if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('key')) {
          const key = url.searchParams.get('key');
          if (!valid(key)) throw new Problem('Ключ не подходит: попросите доступ заново (node mycel.mjs join <адрес>).', 401);
          res.writeHead(303, { Location: '/', 'Set-Cookie': `mycel_key=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` }); return res.end();
        }
        if (req.method === 'GET' && url.pathname === '/api/health') return send(200, keyed ? { ok: true, app: 'mycel', version, data } : { ok: true, app: 'mycel', version });
        // Без ключа: инструкция агенту, установка копии Mycel и запрос доступа — так агент в виртуальной машине
        // настраивает всё сам, а человек только нажимает «Разрешить».
        const open = (req.method === 'GET' && (['/agent', '/install.sh', '/download/mycel.tar.gz'].includes(url.pathname) || /^\/api\/pair\/[^/]+$/.test(url.pathname))) || (req.method === 'POST' && url.pathname === '/api/pair');
        if (!keyed && !open) {
          const hint = `Агент в этой машине ставит Mycel и просит доступ сам: curl -fsS http://${remote}:${actualPort}/install.sh | sh — затем человек нажимает «Разрешить» в Mycel на основной машине.`;
          if (req.method === 'GET' && url.pathname === '/') return send(401, `Это Mycel на основной машине. ${hint}`, 'text/plain; charset=utf-8');
          throw new Problem(`Нужен ключ Mycel. ${hint}`, 401);
        }
        if (req.method === 'POST' && url.pathname === '/api/projects' && !device) throw new Problem('Проект для папки этой машины создаёт машина со своим ключом: node mycel.mjs join <адрес> без ключа — человек нажмёт «Разрешить».', 403);
        if (['/api/remote', '/api/access'].includes(url.pathname) || /^\/api\/(pair\/[^/]+\/(approve|deny)|devices\/)/.test(url.pathname) || (req.method === 'POST' && url.pathname === '/api/stop')) throw new Problem('Это делается на основной машине: остановить Mycel, открыть доступ и ответить на запрос доступа.', 403);
      }
      // Инструкцию агенту открывают откуда угодно (curl, браузер, другой сайт): токена в ней нет, поэтому только Host.
      if (req.method === 'GET' && url.pathname === '/agent') return send(200, await renderGuide({ url: `http://${remote ?? '127.0.0.1'}:${actualPort}`, remote: remote ? 'served' : null }), 'text/plain; charset=utf-8');
      if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) throw new Problem('Запрос с другого origin запрещён.', 403);
      if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) throw new Problem('Откройте приложение непосредственно на localhost.', 403);
      if (!['GET', 'POST'].includes(req.method)) throw new Problem('Метод не поддерживается.', 405);
      // Запрос доступа из виртуальной машины — единственная запись без ключа.
      if (req.method === 'POST' && !valid(bearer) && !(remote && url.pathname === '/api/pair')) throw new Problem('Нужен Bearer token из каталога данных.', 401);
      const get = path => req.method === 'GET' && url.pathname === path, post = path => req.method === 'POST' && url.pathname === path;

      if (get('/api/health')) return send(200, { ok: true, app: 'mycel', version, data });
      // Из виртуальной машины сессия отдаёт тот ключ, с которым пришли: токен основной машины по сети не уходит.
      if (get('/api/session')) return send(200, { token: usedKey ?? token, data, port: actualPort, platform: process.platform });
      // Установка Mycel в виртуальной машине: Node.js 22+ (если нет — в ~/.mycel-node), копия в ~/mycel, запрос доступа.
      if (get('/install.sh')) return send(200, installScript(`http://${remote ?? '127.0.0.1'}:${actualPort}`), 'text/x-shellscript; charset=utf-8');
      // Запрос доступа: машина получает код (его сверяет человек) и секрет, по которому заберёт ключ после «Разрешить».
      if (post('/api/pair')) {
        if (!remote) throw new Problem('Доступ просят из виртуальной машины.', 404);
        const b = await jsonBody(req);
        return send(200, access.request(b.name, req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? remote));
      }
      const pair = /^\/api\/pair\/([^/]+)(?:\/(approve|deny))?$/.exec(url.pathname);
      if (pair && req.method === 'GET' && !pair[2]) return send(200, access.poll(pair[1], url.searchParams.get('secret')));
      if (pair && req.method === 'POST' && pair[2]) {
        const b = await jsonBody(req);
        if (pair[2] === 'deny') { access.deny(pair[1]); return send(200, accessInfo()); }
        if (b.project != null && !hub.list().some(x => x.id === b.project)) throw new Problem('Такого проекта нет.');
        await access.approve(pair[1], b.project ?? null);
        return send(200, accessInfo());
      }
      if (get('/api/access')) return send(200, accessInfo());
      const revoke = req.method === 'POST' && /^\/api\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
      if (revoke) { await jsonBody(req); await access.revoke(revoke[1]); return send(200, accessInfo()); }
      // Без path — все проекты; с path — проект, в папке которого он лежит (mycel.mjs из любой подпапки).
      if (get('/api/projects')) {
        const path = url.searchParams.get('path');
        return send(200, path === null ? { projects: hub.list() } : hub.lookup(path, url.searchParams.get('root'), device?.id ?? null));
      }
      if (post('/api/projects')) return send(200, await hub.connect(await jsonBody(req), device ? { id: device.id, name: device.name } : null));
      const action = req.method === 'POST' && /^\/api\/projects\/([^/]+)\/(delete|restore)$/.exec(url.pathname);
      if (action) { await jsonBody(req); return send(200, await (action[2] === 'delete' ? hub.remove(action[1]) : hub.restore(action[1]))); }
      // Главная страница: создание, удаление, перенос проектов, правки карт, чат и присутствие агентов.
      if (get('/api/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ projects: hub.seq })}\n\n`); hub.streams.add(res);
        req.on('close', () => hub.streams.delete(res)); return;
      }
      if (post('/api/stop')) {
        if (!onStop) throw new Problem('Этот сервер останавливает тот, кто его запустил.', 404);
        send(200, { stopping: true }); setImmediate(onStop); return;
      }
      // Доступ для виртуальных машин: на каких адресах этого компьютера Mycel принимает их запросы (по ключу).
      // Пустой список закрывает доступ. Только адреса сетевых адаптеров этого компьютера; настройка — в listen.json.
      if (get('/api/remote')) return send(200, { port: actualPort, listening: remoteInfo(), interfaces: interfaces() });
      if (post('/api/remote')) {
        const b = await jsonBody(req), own = new Set(interfaces().map(i => i.address));
        if (!Array.isArray(b.addresses) || b.addresses.length > 8 || !b.addresses.every(a => typeof a === 'string' && own.has(a))) throw new Problem('addresses — адреса сетевых адаптеров этого компьютера (их показывает mycel remote).');
        const addresses = [...new Set(b.addresses)];
        await writeFile(listenFile, JSON.stringify({ addresses }, null, 2) + '\n');
        await setRemotes(addresses);
        return send(200, { port: actualPort, listening: remoteInfo(), interfaces: interfaces() });
      }
      const scoped = /^\/api\/p\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (scoped) {
        p = hub.route(scoped[1]);
        p.touch(req.headers['x-mycel-actor']);
        return await projectRoute(req, res, url, scoped[2] ?? '', p, send);
      }
      // Копия Mycel для виртуальной машины (из неё — только с ключом, как всё остальное).
      if (get('/download/mycel.tar.gz')) {
        res.setHeader('Content-Disposition', 'attachment; filename="mycel.tar.gz"');
        return send(200, await bundle(), 'application/gzip');
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname]; return send(200, await readFile(join(appRoot, 'public', file)), `${type}; charset=utf-8`);
      }
      throw new Problem('Маршрут не найден.', 404);
    } catch (error) {
      if (res.headersSent) return res.end();
      if (!(error instanceof Problem)) console.error(error);
      send(error.status ?? 500, { error: error instanceof Problem ? error.message : 'Внутренняя ошибка сервера. Подробности в терминале.', ...error.extra, ...(p?.store ? { revision: p.store.peek().revision } : {}) });
    }
  };
  const server = http.createServer((req, res) => handle(req, res, null));
  // Маршруты одного проекта: те же, что были у сервера одной карты, под /api/p/<id>.
  async function projectRoute(req, res, url, route, p, send) {
    const get = r => req.method === 'GET' && route === r, post = r => req.method === 'POST' && route === r;
    // Пока читалось тело запроса, проект могли удалить: тогда запись не идёт в закрытую карту.
    const body = async () => { const value = await jsonBody(req); if (hub.route(p.id) !== p) throw new Problem('Проект удалён.', 404); return value; };
    if (get('')) return send(200, { project: p.info() });
    if (get('/graph')) return send(200, publicGraph(p.store.get()));
    if (get('/history')) return send(200, { history: p.store.get().history.slice().reverse() });
    if (get('/export')) {
      res.setHeader('Content-Disposition', `attachment; filename="mycel-${p.id}.json"`); return send(200, p.store.get());
    }
    if (get('/context')) return send(200, context(p.store.get(), url.searchParams.get('focus'), p.focus, url.searchParams.get('brief') === '1', p.editInfo(), p.selection, { ...p.codeInfo(), work: p.work() }), 'text/markdown; charset=utf-8');
    // Ревью картой: что изменилось в устройстве проекта после ревизии since или за последние hours часов.
    if (get('/review')) {
      const graph = p.store.get(), since = url.searchParams.get('since'), hours = url.searchParams.get('hours');
      let entries;
      if (since !== null) {
        if (!Number.isSafeInteger(Number(since)) || Number(since) < 0) throw new Problem('since — ревизия, целое число от 0.');
        entries = graph.history.filter(h => h.revision > Number(since));
      } else {
        const h = Number(hours ?? 24);
        if (!Number.isFinite(h) || h <= 0 || h > 24 * 365) throw new Problem('hours — число часов, больше 0.');
        entries = graph.history.filter(e => Date.now() - Date.parse(e.at) <= h * 3600e3);
      }
      const r = review(graph, entries);
      return send(200, { ...r, text: reviewText(r) });
    }
    // Код: какие файлы правят агенты (хук после правки файла), устаревшие блоки, риски, кто над чем работает.
    if (get('/code')) {
      const nodes = new Map(p.store.peek().nodes.map(n => [n.id, n])), info = p.codeInfo();
      return send(200, { stale: Object.entries(info.stale).map(([id, s]) => ({ id, name: nodeName(nodes.get(id)), ...s })), risks: info.risks, work: p.work() });
    }
    if (post('/touch')) {
      const b = await body();
      if (typeof b.actor !== 'string' || !b.actor || b.actor === 'human' || b.actor.length > 100) throw new Problem('Укажите actor агента (до 100 символов).');
      if (!Array.isArray(b.files) || !b.files.length || b.files.length > 50 || !b.files.every(f => typeof f === 'string' && f && f.length <= 300)) throw new Problem('files — от 1 до 50 путей от корня проекта.');
      if (!(b.session == null || (typeof b.session === 'string' && b.session.length <= 100))) throw new Problem('session — id сессии агента, до 100 символов.');
      p.touch(b.actor);
      return send(200, p.touchFiles(b.actor, b.files.map(f => f.replace(/\\/g, '/')), b.session ?? null));
    }
    // Агент подтверждает, что описание блоков верно (или описал их заново): пометка «устарел» снимается.
    if (post('/fresh')) {
      const b = await body();
      if (!(b.ids === null || (Array.isArray(b.ids) && b.ids.every(id => typeof id === 'string')))) throw new Problem('ids — список id блоков или null (все).');
      p.touch(b.actor);
      return send(200, { fresh: p.freshen(b.ids) });
    }
    // Риски, найденные mycel health в файлах блоков: числа, без содержимого строк.
    if (post('/risks')) {
      const b = await body(), ids = new Set(p.store.peek().nodes.map(n => n.id)), count = v => Number.isSafeInteger(v) && v >= 0 && v <= 1e6;
      if (!b.blocks || typeof b.blocks !== 'object' || Array.isArray(b.blocks) || !Object.entries(b.blocks).every(([id, r]) => ids.has(id) && r && count(r.todo) && count(r.secrets))) throw new Problem('blocks — { id блока: { todo, secrets } } с целыми числами.');
      p.touch(b.actor);
      const at = new Date().toISOString();
      p.setRisks(Object.fromEntries(Object.entries(b.blocks).filter(([, r]) => r.todo || r.secrets).map(([id, r]) => [id, { todo: r.todo, secrets: r.secrets, at }])));
      return send(200, { risks: p.codeInfo().risks });
    }
    // Человек просит проверить блоки (кнопка «Проверить» в меню блока): событие будит агентов, проверяет агент.
    if (post('/check')) {
      const b = await body(), nodes = p.store.peek().nodes;
      if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 100 || !b.ids.every(id => nodes.some(n => n.id === id && n.type === 'block'))) throw new Problem('ids — блоки, которые нужно проверить.');
      const names = b.ids.map(id => nodeName(nodes.find(n => n.id === id)));
      const message = await p.chat.add({ author: 'human', kind: 'check', text: `Проверить: ${names.map(n => `«${n}»`).join(', ')}`, check: { ids: b.ids, names } });
      p.chatted();
      return send(200, { message });
    }
    // Фокус человека: над каким блоком он сейчас работает. Хранится, пока работает хаб; агенты видят его в контексте и изменениях.
    if (post('/focus')) {
      const id = (await body()).id ?? null;
      if (id !== null && !p.store.get().nodes.some(n => n.id === id && n.type === 'block')) throw new Problem('Блок для фокуса не найден.');
      p.focus = id; p.broadcast({ focus: id });
      return send(200, { focus: id });
    }
    if (get('/changes')) {
      const since = Number(url.searchParams.get('since') ?? NaN), exclude = url.searchParams.get('exclude') ?? '', wait = Number(url.searchParams.get('wait') ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) throw new Problem('Укажите since — ревизию, после которой нужны изменения.');
      if (!Number.isFinite(wait) || wait < 0 || wait > 300) throw new Problem('wait — время ожидания в секундах, от 0 до 300.');
      // content=1: ждать правки содержимого, а перемещения, размеры и сворачивание копить до неё.
      // chat=N: заодно ждать сообщений в чате после изменения N; они будят всегда. Правки человека, которые он ещё
      // не закончил (held), не будят.
      const content = url.searchParams.get('content') === '1', chatParam = url.searchParams.get('chat'), chatSince = chatParam === null ? null : Number(chatParam);
      if (chatSince !== null && (!Number.isSafeInteger(chatSince) || chatSince < 0)) throw new Problem('chat — номер изменения чата, целое число от 0.');
      const ready = r => !r.complete || (content ? r.contentChanged : r.entries.length > r.held) || r.chat?.messages.length > 0;
      const now = p.changesSince(since, exclude, chatSince);
      if (!wait || ready(now)) return send(200, now);
      // Долгий запрос: проверка после каждой записи, досрочный ответ при остановке хаба и 404 при удалении проекта.
      let done = false;
      const stop = () => { if (done) return; done = true; clearTimeout(timer); p.waiters.delete(check); p.touch(exclude, -1); };
      const finish = (status = 200, value) => { stop(); if (!res.writableEnded) send(status, value ?? p.changesSince(since, exclude, chatSince)); };
      const check = () => { if (ready(p.changesSince(since, exclude, chatSince))) finish(); };
      const timer = setTimeout(finish, wait * 1000);
      p.waiters.set(check, finish);
      p.touch(exclude, 1);
      res.on('close', stop);
      return;
    }
    if (get('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(p.state())}\n\n`); p.sessions.add(res);
      req.on('close', () => p.sessions.delete(res)); return;
    }
    if (post('/changes')) {
      const b = await body();
      const result = await p.store.commit(b.expectedRevision, b.actor, b.message, graph => applyOperations(graph, b.operations));
      await p.startEdit(result.history.at(-1), result.revision - 1);
      // Агент описал блок заново (название, текст, файлы, проверка) — пометка «устарел» с него снимается.
      const delta = result.history.at(-1)?.delta;
      if (b.actor !== 'human' && delta) p.freshen(Object.entries(delta.nodes.updated).filter(([, f]) => f.some(k => ['title', 'text', 'files', 'test'].includes(k))).map(([id]) => id));
      p.committed();
      return send(200, publicGraph(result));
    }
    // Предложение агента: пакет ложится на карту с пометками (src/model.mjs, propose), следующий дополняет открытое.
    if (post('/proposal')) {
      const b = await body(), title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : p.store.peek().proposal?.title ?? '';
      const result = await p.store.commit(b.expectedRevision, b.actor, `Предложение «${title}»`, graph => propose(graph, b.operations, { title: b.title, by: b.actor, at: new Date().toISOString() }));
      p.committed();
      return send(200, publicGraph(result));
    }
    // Человек принимает или отклоняет предложение. Его правки с начала уходят агентам вместе с решением одним
    // сообщением в чате, оно агентов и будит.
    if (post('/proposal/accept') || post('/proposal/reject')) {
      await body();
      const accept = route.endsWith('accept'), open = p.store.peek().proposal, verb = accept ? 'Принято' : 'Отклонено';
      if (!open) throw new Problem('Открытого предложения нет.', 409);
      // Правки человека — до решения: сама запись решения в них не входит.
      const pending = p.editInfo(), edits = pending && { ...pending, until: p.store.peek().revision };
      let result;
      // Запись идёт поверх текущей ревизии: агент мог дописать предложение, пока человек нажимал кнопку.
      for (let i = 0; ; i++) {
        try { result = await p.store.commit(p.store.peek().revision, 'human', `${verb} предложение «${open.title}»`, accept ? acceptProposal : rejectProposal); break; }
        catch (e) { if (e.status !== 409 || i >= 3) throw e; }
      }
      // Сообщение о решении — до того, как проснутся агенты: они получают его вместе с изменениями карты.
      await p.endEdit();
      const message = await p.chat.add({ author: 'human', kind: 'proposal', text: `${verb} предложение «${open.title}»`, proposal: { title: open.title, by: open.by, result: accept ? 'accepted' : 'rejected', ...(edits ? { edits } : {}) } });
      p.committed(); p.chatted();
      return send(200, { graph: publicGraph(result), message });
    }
    // «Закончить правки»: правки человека с начала уходят агентам одним сообщением в чате, оно их и будит.
    if (post('/edits')) {
      await body();
      const edits = await p.endEdit();
      if (!edits) return send(200, { message: null });
      const message = await p.chat.add({ author: 'human', kind: 'edits', text: 'Правки карты готовы', edits });
      p.chatted();
      return send(200, { message });
    }
    // События для агентов: что человек сделал кнопками Mycel (закончил правки, решил по предложению), и прежняя
    // переписка проектов, у которых был чат. since — номер изменения событий. Писать сюда снаружи нельзя: разговор
    // с агентом идёт в его окне.
    if (get('/chat')) {
      const since = url.searchParams.get('since');
      if (since !== null && (!Number.isSafeInteger(Number(since)) || Number(since) < 0)) throw new Problem('since — номер изменения событий, целое число от 0.');
      return send(200, { seq: p.chat.seq, messages: since === null ? p.chat.recent(200) : p.chat.since(Number(since)), agents: p.presence() });
    }
    // Что агент делает сейчас: строка под картой. text: null — снять; progress — 0–100, если известно.
    if (post('/activity')) {
      const b = await body();
      if (typeof b.actor !== 'string' || !b.actor || b.actor === 'human' || b.actor.length > 100) throw new Problem('Укажите actor агента (до 100 символов).');
      if (b.text !== null && !(typeof b.text === 'string' && b.text.trim() && b.text.length <= 200)) throw new Problem('text — что агент делает сейчас, до 200 символов, или null.');
      if (!(b.progress == null || (Number.isFinite(b.progress) && b.progress >= 0 && b.progress <= 100))) throw new Problem('progress — число от 0 до 100.');
      const nodes = p.store.peek().nodes, blocks = b.blocks ?? [];
      if (!Array.isArray(blocks) || blocks.length > 50 || !blocks.every(id => nodes.some(n => n.id === id && n.type === 'block'))) throw new Problem('blocks — id блоков, над которыми работает агент.');
      p.touch(b.actor); p.setActivity(b.actor, b.text?.trim() ?? null, b.progress, blocks);
      return send(200, { activity: p.activityList(), others: p.others(b.actor, blocks) });
    }
    // Агент показывает человеку блок: открытые страницы проекта переходят к нему (в его подкарту) и выделяют его.
    if (post('/show')) {
      const b = await body();
      if (!p.store.get().nodes.some(n => n.id === b.id)) throw new Problem('Блок для показа не найден.');
      p.touch(b.actor); p.broadcast({ show: b.id, by: typeof b.actor === 'string' ? b.actor : null });
      return send(200, { shown: b.id });
    }
    // Что человек выделил на карте: блок или заметку (интерфейс сообщает сам). Вместе с фокусом — о чём он говорит агенту.
    if (post('/selection')) {
      const id = (await body()).id ?? null;
      if (id !== null && !p.store.get().nodes.some(n => n.id === id)) throw new Problem('Узел не найден.');
      p.selection = id;
      return send(200, { selection: id });
    }
    if (get('/selection')) {
      const nodes = p.store.peek().nodes, alive = id => id && nodes.some(n => n.id === id) ? id : null;
      return send(200, { focus: alive(p.focus), selection: alive(p.selection) });
    }
    // Что агент уже прочитал: ревизия карты и изменение чата. mycel.mjs хранит это только здесь.
    if (get('/cursor')) {
      const actor = url.searchParams.get('actor');
      if (!actor || actor.length > 100) throw new Problem('Укажите actor (до 100 символов).');
      return send(200, await p.cursor(actor));
    }
    if (post('/cursor')) {
      const b = await body();
      if (typeof b.actor !== 'string' || !b.actor || b.actor.length > 100) throw new Problem('Укажите actor (до 100 символов).');
      if (!isCount(b.revision) || !isCount(b.chat)) throw new Problem('revision и chat — целые числа от 0.');
      return send(200, await p.saveCursor(b.actor, b));
    }
    throw new Problem('Маршрут не найден.', 404);
  }
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolveStart, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveStart); });
    await lock.update(server.address().port);
  } catch (e) {
    server.close(); await hub.close(); await lock.release();
    throw e.code === 'EADDRINUSE' ? new Error(`Порт ${port} занят другой программой.`) : e;
  }
  // Доступ для виртуальных машин, открытый раньше: адрес, которого сейчас нет, не мешает запуску.
  const saved = listen ?? await readFile(listenFile, 'utf8').then(text => JSON.parse(text).addresses, () => []);
  await setRemotes(Array.isArray(saved) ? saved.filter(a => typeof a === 'string') : []);
  for (const r of remoteInfo()) console.error(r.listening ? `Для виртуальных машин: http://${r.address}:${server.address().port}` : `Адрес ${r.address} для виртуальных машин не открыт: ${r.error}`);
  let closing = null;
  return {
    url: `http://127.0.0.1:${server.address().port}`, data,
    close: () => closing ??= (async () => {
      await hub.close(); await access.close();
      for (const address of [...remotes.keys()]) await closeRemote(address);
      await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
      await lock.release();
    })()
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const options = {};
  try {
    if (args.includes('--help')) {
      console.log('Mycel: node server.mjs [--port 4317] [--data <каталог данных>]');
    } else {
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i].slice(2);
        if (!['data', 'port'].includes(key) || !args[i].startsWith('--') || !args[i + 1]) throw new Error('Неизвестный или неполный аргумент. Используйте --help.');
        options[key] = key === 'port' ? Number(args[i + 1]) : args[i + 1];
      }
      if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('Некорректный порт.');
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
      const app = await startServer({ ...options, onStop: stop });
      console.log(`\nMycel → ${app.url}\nДанные: ${app.data}\nCtrl+C — остановить.\n`);
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
