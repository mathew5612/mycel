import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startServer } from '../server.mjs';

// Интерфейс в headless Chrome через протокол DevTools, без пакетов. Хаб — на временных данных и порту 0, Chrome —
// со своим временным профилем и портом 0. Без Chrome тесты пропускаются (путь можно задать в MYCEL_CHROME).
const chrome = [process.env.MYCEL_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && existsSync(p));
const skip = !chrome && 'Chrome не найден';
const temp = prefix => mkdtemp(join(tmpdir(), prefix));
const clean = (...dirs) => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await check()) return; assert.fail('Не дождались'); };
const add = (id, extra = {}) => ({ type: 'add-node', node: { id, title: id, x: 0, y: 0, ...extra } });

async function hub(t) {
  const data = await temp('mycel-ui-data-'), folders = await temp('mycel-ui-folders-');
  const app = await startServer({ data, port: 0 });
  t.after(async () => { await app.close(); await clean(data, folders); });
  const token = (await readFile(join(data, 'token'), 'utf8')).trim();
  const post = async (path, body) => { const res = await fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const get = async path => (await fetch(app.url + path)).json();
  const project = async name => { const dir = join(folders, name); await mkdir(dir); return (await post('/api/projects', { path: dir, name })).body.project; };
  // Запись агента поверх текущей ревизии, как mycel build по шагам.
  const agent = async (id, operations) => {
    const { revision } = await get(`/api/p/${id}/graph`), res = await post(`/api/p/${id}/changes`, { expectedRevision: revision, actor: 'agent', message: 'Шаг агента', operations });
    assert.equal(res.status, 200, res.body.error); return res.body;
  };
  const node = async (pid, id) => (await get(`/api/p/${pid}/graph`)).nodes.find(n => n.id === id);
  // Свёрнутость подкарт по id и число записей истории.
  const folds = async (pid, ids) => Object.fromEntries((await get(`/api/p/${pid}/graph`)).nodes.filter(n => ids.includes(n.id)).map(n => [n.id, n.collapsed]));
  const entries = async pid => (await get(`/api/p/${pid}/history`)).history.length;
  // Свёрнутость стала такой, как want.
  const foldsAre = (pid, want) => until(async () => isDeepStrictEqual(await folds(pid, Object.keys(want)), want));
  // Агент показывает блок (mycel show) и пишет, что делает сейчас (mycel doing).
  const show = async (pid, id) => { const res = await post(`/api/p/${pid}/show`, { id, actor: 'claude' }); assert.equal(res.status, 200, res.body.error); };
  const doing = async (pid, text, progress = null) => { const res = await post(`/api/p/${pid}/activity`, { actor: 'claude', text, progress }); assert.equal(res.status, 200, res.body.error); };
  return { url: app.url, get, post, project, agent, node, folds, foldsAre, entries, show, doing };
}

async function browser(t) {
  const profile = await temp('mycel-ui-chrome-');
  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  const exited = once(proc, 'exit');
  let ws = null, seq = 0;
  const waiting = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  t.after(async () => {
    if (ws?.readyState === WebSocket.OPEN) { send('Browser.close').catch(() => {}); await Promise.race([exited, sleep(5000)]); ws.close(); }
    proc.kill(); await Promise.race([exited, sleep(2000)]);
    await clean(profile);
  });
  // Порт DevTools Chrome выбирает сам и пишет в профиль: первая строка — порт, вторая — путь к браузеру.
  let active = '';
  await until(async () => (active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).includes('\n'), 20000);
  const [port, path] = active.split('\n').map(s => s.trim());
  ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Нет связи с Chrome')); });
  ws.onmessage = e => { const m = JSON.parse(e.data), w = m.id && waiting.get(m.id); if (!w) return; waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); };
  let target = null;
  await until(async () => (target = (await send('Target.getTargets')).targetInfos.find(x => x.type === 'page')), 10000);
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  // modifiers — зажатые клавиши, как в DevTools: Alt = 1, Ctrl = 2, Meta = 4, Shift = 8.
  const mouse = (type, { x, y }, { button = 'left', clickCount = 1, modifiers = 0 } = {}) => call('Input.dispatchMouseEvent', { type, x, y, modifiers, button: type === 'mouseMoved' ? 'none' : button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount });
  const center = async q => {
    const r = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(q)})?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    assert.ok(r, `Нет элемента ${q}`); return r;
  };
  const at = q => typeof q === 'string' ? center(q) : q;
  // Нажатие на элемент или точку экрана; отпускание — в той же точке, когда его вызовут.
  const press = async q => { const p = await at(q); await mouse('mouseMoved', p); await mouse('mousePressed', p); return () => mouse('mouseReleased', p); };
  return {
    evaluate, press,
    goto: url => call('Page.navigate', { url }),
    reload: () => call('Page.reload'),
    // Ввод текста в поле, где стоит курсор, как с клавиатуры.
    type: text => call('Input.insertText', { text }),
    click: async q => (await press(q))(),
    // Двойной клик по элементу или точке экрана: второе нажатие с clickCount = 2, как у настоящей мыши.
    dblclick: async q => { const p = await at(q); await mouse('mouseMoved', p); for (const clickCount of [1, 2]) { await mouse('mousePressed', p, { clickCount }); await mouse('mouseReleased', p, { clickCount }); } },
    rightClick: async q => { const p = await at(q); await mouse('mouseMoved', p); await mouse('mousePressed', p, { button: 'right' }); await mouse('mouseReleased', p, { button: 'right' }); },
    // Перетаскивание с зажатой кнопкой через одну точку или несколько по порядку; during вызывается, пока кнопка ещё нажата.
    drag: async (from, to, during, modifiers = 0) => {
      let a = await at(from);
      await mouse('mouseMoved', a, { modifiers }); await mouse('mousePressed', a, { modifiers });
      for (const stop of [to].flat()) {
        const z = await at(stop);
        for (let i = 1; i <= 5; i++) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (z.x - a.x) * i / 5, y: a.y + (z.y - a.y) * i / 5, button: 'left', buttons: 1, modifiers });
        a = z;
      }
      await during?.(); await mouse('mouseReleased', a, { modifiers });
    },
    key: async name => { for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: { Escape: 27, Enter: 13, Delete: 46, ArrowLeft: 37, ArrowRight: 39 }[name] }); },
    // Размер окна и медиа-признаки, например prefers-reduced-motion.
    size: (width, height) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
    media: features => call('Emulation.setEmulatedMedia', { features }),
    until: (expression, ms) => until(() => evaluate(expression).catch(() => false), ms)
  };
}

test('home rows are patched in place; a pressed row link or trash button keeps its click while agents commit', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const alpha = await h.project('alpha'), beta = await h.project('beta'), gamma = await h.project('gamma');
  const row = id => `document.querySelector('[data-open="${id}"]')`;
  await b.goto(`${h.url}/#/`);
  await b.until(`document.querySelectorAll('.p-row').length === 3`);
  // Запись агента меняет только строку его проекта: остальные строки — те же элементы.
  await b.evaluate(`${row(alpha.id)}.closest('li').kept = true`);
  await h.agent(beta.id, [add('b1')]);
  await b.until(`${row(beta.id)}.querySelector('.p-meta').textContent.startsWith('1 блок ')`);
  assert.equal(await b.evaluate(`${row(alpha.id)}.closest('li').kept`), true);
  // Корзина нажата, агент пишет, отпускание всё равно удаляет проект; отложенное обновление дорисовывается.
  let release = await b.press(`[data-trash="${gamma.id}"]`);
  await h.agent(beta.id, [add('b2')]);
  await sleep(500);
  await release();
  await until(async () => !(await h.get('/api/projects')).projects.some(p => p.id === gamma.id));
  await b.until(`!${row(gamma.id)} && ${row(beta.id)}.querySelector('.p-meta').textContent.startsWith('2 блока ')`);
  // Нажатая строка проекта открывает его.
  release = await b.press(`[data-open="${alpha.id}"]`);
  await h.agent(beta.id, [add('b3')]);
  await sleep(500);
  await release();
  await b.until(`location.hash === '#/p/${alpha.id}'`);
});

test('home list keeps updating while several agents commit more often than every 150 ms', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const busy = [await h.project('p0'), await h.project('p1'), await h.project('p2')];
  await b.goto(`${h.url}/#/`);
  await b.until(`document.querySelectorAll('.p-row').length === 3`);
  let run = true, k = 0;
  const agents = (async () => { while (run) { await h.agent(busy[k % 3].id, [add(`m${k}`)]); k++; await sleep(40); } })();
  try {
    await sleep(400);
    const fresh = await h.project('gamma');
    await b.until(`Boolean(document.querySelector('[data-open="${fresh.id}"]'))`, 1500);
  } finally { run = false; await agents; }
});

test('map chevron and colour swatch keep their click while an agent commits; empty map has no hint', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('#viewport'))`);
  assert.doesNotMatch(await b.evaluate(`document.querySelector('#viewport').innerText`), /Правый клик/);
  await h.agent(p.id, [add('box', { w: 400, h: 300, collapsed: true }), add('inner', { parentId: 'box', x: 10, y: 10 }), add('x1', { x: 0, y: 400 })]);
  await b.until(`Boolean(document.querySelector('.block[data-id="box"] > .fold')) && !document.querySelector('#world.glide')`);
  // Шеврон нажат, агент добавляет блок; отпускание разворачивает подкарту, блок агента появляется после записи.
  let release = await b.press('.block[data-id="box"] > .fold');
  await h.agent(p.id, [add('y1', { x: 600, y: 0 })]);
  await sleep(400);
  await release();
  await until(async () => (await h.node(p.id, 'box')).collapsed === false);
  await b.until(`Boolean(document.querySelector('.block[data-id="y1"]'))`);
  // Цвет выделенного блока из панели над ним — так же.
  await b.until(`!document.querySelector('#world.glide')`);
  await b.click('.block[data-id="x1"]');
  await b.until(`Boolean(document.querySelector('.swatch.c-green'))`);
  release = await b.press('.swatch.c-green');
  await h.agent(p.id, [add('y2', { x: 900, y: 0 })]);
  await sleep(400);
  await release();
  await until(async () => (await h.node(p.id, 'x1')).color === 'green');
  await b.until(`Boolean(document.querySelector('.block[data-id="y2"]'))`);
});

test('an agent change that lands during a human write is shown once the write finishes', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('a')]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="a"]')) && !document.querySelector('#world.glide')`);
  await b.click('.block[data-id="a"]');
  await b.until(`Boolean(document.querySelector('.swatch.c-red'))`);
  // Ответ на запись человека задерживается на 600 мс; агент пишет, пока она идёт.
  await b.evaluate(`(() => { const f = window.fetch; window.fetch = async (u, o) => { const res = await f(u, o); if (o?.method === 'POST' && String(u).endsWith('/changes')) await new Promise(r => setTimeout(r, 600)); return res; }; })()`);
  await b.click('.swatch.c-red');
  await sleep(150);
  const { revision } = await h.agent(p.id, [add('b', { x: 400, y: 0 })]);
  await b.until(`Boolean(document.querySelector('.block[data-id="b"]')) && window.mycel.state.graph.revision === ${revision}`, 3000);
  assert.equal((await h.node(p.id, 'a')).color, 'red');
});

// Погружение по двойному клику и уровни. Карта успокоилась: переходы по уровням и записи закончились, вид не
// переезжает. Фокус ставится в начале перехода, до записи и перерисовки, поэтому ждать только его мало.
const settled = `(window.mycel.state.walking === 0 && window.mycel.state.busy === 0 && !document.querySelector('#world.glide'))`;
const focused = id => `window.mycel.state.focus === ${JSON.stringify(id)}`;
const folded = id => `Boolean(document.querySelector('.block[data-id="${id}"]')?.classList.contains('collapsed'))`;
const path = `[...document.querySelectorAll('#focus-bar .focus-path > *')].map(e => e.textContent).join(' ')`;
// Уровень, который показывает ползунок ('' — карте не подходит ни один), его название и деление ползунка.
const active = `document.querySelector('#levels').dataset.level`, levelName = `document.querySelector('#level-name').textContent`;
const tick = level => `#levels .level-track i:nth-child(${level})`;
const corner = `(() => { const r = document.querySelector('#viewport').getBoundingClientRect(); return { x: r.right - 12, y: r.top + 12 }; })()`;
const humanFocus = async (h, pid) => (await h.get(`/api/p/${pid}/changes?since=0`)).focus;

test('double-click on a container dives one level down in one quiet commit; deeper dives grow the path; Esc goes back up to the whole map', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha'), ids = ['A', 'M1', 'T1'];
  await h.agent(p.id, [add('A', { w: 700, h: 500 }), add('B', { x: 1100, y: 0 }), add('M1', { parentId: 'A', x: 10, y: 10, w: 400, h: 300 }), add('M2', { parentId: 'A', x: 450, y: 10 }),
    add('T1', { parentId: 'M1', x: 10, y: 10, w: 300, h: 200 }), add('K1', { parentId: 'T1', x: 10, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${settled}`);
  // Вид переезжает плавно: у #world появляется класс glide.
  await b.evaluate(`(() => { const w = document.querySelector('#world'); window.glided = false; new MutationObserver(() => { if (w.classList.contains('glide')) window.glided = true; }).observe(w, { attributes: true }); })()`);
  const rev0 = (await h.get(`/api/p/${p.id}/graph`)).revision, before = await h.entries(p.id);

  // Двойной клик по контейнеру: фокус на нём, сам он развёрнут, подкарты его блоков свёрнуты; одна запись, не правка содержимого.
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  assert.deepEqual(await h.folds(p.id, ids), { A: false, M1: true, T1: false });
  assert.equal(await h.entries(p.id), before + 1);
  const quiet = await h.get(`/api/p/${p.id}/changes?since=${rev0}&content=1`);
  assert.equal(quiet.complete, true); assert.equal(quiet.contentChanged, false);
  await until(async () => await humanFocus(h, p.id) === 'A');
  assert.equal(await b.evaluate('window.mycel.state.editing'), null);
  assert.equal(await b.evaluate('window.glided'), true);
  assert.equal(await b.evaluate(path), 'Карта › A');
  assert.equal(await b.evaluate(`document.querySelector('.block[data-id="B"]').classList.contains('out-focus')`), true);
  assert.equal(await b.evaluate(`(() => { const v = document.querySelector('#viewport').getBoundingClientRect(), r = document.querySelector('.block[data-id="A"]').getBoundingClientRect();
    return r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom; })()`), true);

  // Агент добавляет блок внутрь открытого блока — он появляется.
  await h.agent(p.id, [add('M3', { parentId: 'A', x: 10, y: 360 })]);
  await b.until(`(() => { const el = document.querySelector('.block[data-id="M3"]'); return Boolean(el) && !el.classList.contains('out-focus'); })() && ${focused('A')} && ${settled}`);

  // Глубже: путь растёт.
  await b.dblclick('.block[data-id="M1"] > .head');
  await b.until(`${focused('M1')} && !${folded('M1')} && ${folded('T1')} && ${settled}`);
  assert.deepEqual(await h.folds(p.id, ids), { A: false, M1: false, T1: true });
  assert.equal(await b.evaluate(path), 'Карта › A › M1');
  assert.equal(await h.entries(p.id), before + 3);

  // Esc — на уровень вверх; с верхнего блока — вся карта, сворачивание возвращается к тому, что было до погружения.
  await b.key('Escape');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  assert.equal(await b.evaluate(path), 'Карта › A');
  await b.key('Escape');
  await b.until(`${focused(null)} && document.querySelector('#focus-bar').hidden && !${folded('M1')} && ${settled}`);
  assert.deepEqual(await h.folds(p.id, ids), { A: false, M1: false, T1: false });
  // Погружения и возвраты подряд сливаются в одну запись истории.
  assert.equal(await h.entries(p.id), before + 3);
  assert.equal(await b.evaluate(`document.querySelectorAll('.block.out-focus').length`), 0);
  await until(async () => await humanFocus(h, p.id) === null);

  // Уход с проекта снимает фокус и возвращает сворачивание, как выход.
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  await until(async () => await humanFocus(h, p.id) === 'A');
  await b.evaluate(`location.hash = '#/'`);
  await b.until(`document.querySelectorAll('.p-row').length === 1`);
  await until(async () => await humanFocus(h, p.id) === null);
  assert.deepEqual(await h.folds(p.id, ids), { A: false, M1: false, T1: false });
  await b.evaluate(`location.hash = '#/p/${p.id}'`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]'))`);
  assert.equal(await b.evaluate(`${focused(null)} && document.querySelector('#focus-bar').hidden && !document.querySelector('.block.out-focus')`), true);
});

test('a dive or an exit that meets an agent write at the same moment is rebuilt from the re-read map', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('A', { w: 900, h: 700 }), add('M1', { parentId: 'A', x: 10, y: 10, w: 300, h: 200 }), add('T1', { parentId: 'M1', x: 10, y: 10 }), add('B', { x: 1300, y: 0 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${settled}`);
  // Первая запись интерфейса ждёт, пока агент не запишет своё: она уйдёт со старой ревизией и получит 409.
  const holdNext = () => b.evaluate(`(() => { const f = window.fetch; window.held = false; window.fetch = async (u, o) => {
    if (o?.method === 'POST' && String(u).endsWith('/changes')) { window.fetch = f; window.held = true; await new Promise(r => window.release = r); }
    return f(u, o); }; })()`);
  // Погружение в A, пока агент добавляет в A развёрнутую подкарту M3: после 409 она тоже сворачивается.
  await holdNext();
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until('window.held === true');
  await h.agent(p.id, [add('M3', { parentId: 'A', x: 10, y: 300, w: 300, h: 200 }), add('K3', { parentId: 'M3', x: 10, y: 10 })]);
  await b.evaluate('window.release()');
  await h.foldsAre(p.id, { A: false, M1: true, M3: true });
  await b.until(`${focused('A')} && ${settled}`);
  // Выход, пока агент удаляет M1: сворачивание остальных возвращается, ошибки нет.
  await holdNext();
  await b.key('Escape');
  await b.until('window.held === true');
  await h.agent(p.id, [{ type: 'delete-node', id: 'M1' }]);
  await b.evaluate('window.release()');
  await b.until(`${focused(null)} && ${settled}`);
  await h.foldsAre(p.id, { A: false, M3: false });
  assert.equal(await b.evaluate(`document.querySelector('#toast')?.classList.contains('error') ?? false`), false);
});

test('double-click on empty canvas goes up; crumbs jump; a leaf block or a note is edited on double-click, a container by Enter', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('A', { w: 700, h: 500 }), add('C', { x: 1100, y: 0 }), add('M1', { parentId: 'A', x: 10, y: 10, w: 300, h: 200 }), add('M2', { parentId: 'A', x: 400, y: 10 }),
    add('T1', { parentId: 'M1', x: 10, y: 10 }), { type: 'add-node', node: { id: 'N', type: 'note', parentId: 'A', attachedTo: 'M2', text: 'заметка', x: 400, y: 200 } }]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${settled}`);
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  assert.equal(await b.evaluate('window.mycel.state.editing'), null);

  // Блок без подкарты и заметка правятся; Esc в поле только заканчивает правку.
  await b.dblclick('.block[data-id="M2"]');
  await b.until(`window.mycel.state.editing === 'M2' && Boolean(document.querySelector('.block[data-id="M2"] .b-title-input'))`);
  await b.key('Escape');
  await b.until(`window.mycel.state.editing === null`);
  await b.dblclick('.block[data-id="N"]');
  await b.until(`window.mycel.state.editing === 'N' && document.activeElement?.matches('.block[data-id="N"] .b-text-input')`);
  await b.key('Escape');
  await b.until(`window.mycel.state.editing === null`);
  await sleep(200);
  assert.equal(await b.evaluate(focused('A')), true);

  // Двойной клик по пустому месту — уровень вверх, с верхнего блока — вся карта.
  await b.dblclick('.block[data-id="M1"] > .head');
  await b.until(`${focused('M1')} && ${settled}`);
  await b.dblclick(await b.evaluate(corner));
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  await b.dblclick(await b.evaluate(corner));
  await b.until(`${focused(null)} && document.querySelector('#focus-bar').hidden && ${settled}`);

  // Звенья пути переходят сразу на свой уровень.
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${settled}`);
  await b.dblclick('.block[data-id="M1"] > .head');
  await b.until(`${focused('M1')} && ${settled}`);
  await b.click('#focus-bar [data-focus-on="A"]');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  await b.click('#focus-bar .focus-path [data-action="unfocus"]');
  await b.until(`${focused(null)} && document.querySelector('#focus-bar').hidden && ${settled}`);

  // Название и текст контейнера правятся по Enter.
  await b.click('.block[data-id="A"] > .head');
  await b.until(`window.mycel.state.selected?.id === 'A'`);
  await b.key('Enter');
  await b.until(`window.mycel.state.editing === 'A' && ${focused(null)}`);
});

test('«Открыть» in the context menu dives into a leaf block, where «Блок внутри» starts the next level; «Изменить» edits a container', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('L'), add('Z', { x: 500, y: 0 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="L"]')) && ${settled}`);
  await b.rightClick('.block[data-id="L"]');
  await b.until(`document.querySelector('#menu [data-menu="open"]')?.textContent === 'Открыть' && !document.querySelector('#menu').hidden`);
  await b.click('#menu [data-menu="open"]');
  await b.until(`${focused('L')} && ${settled}`);
  assert.equal(await b.evaluate(`document.querySelector('.block[data-id="Z"]').classList.contains('out-focus')`), true);
  await until(async () => await humanFocus(h, p.id) === 'L');
  await b.click('#focus-bar [data-focus-act="block"]');
  await b.until(`Boolean(document.querySelector('.block[data-id="L"] > .sub .b-title-input'))`);
  await b.evaluate(`(() => { const input = document.querySelector('.block[data-id="L"] > .sub .b-title-input'); input.value = 'Шаг'; input.blur(); })()`);
  await until(async () => (await h.get(`/api/p/${p.id}/graph`)).nodes.some(n => n.parentId === 'L' && n.title === 'Шаг'));
  await b.until(`document.querySelector('.block[data-id="L"] > .sub > .sub-level')?.textContent === 'Механика'`);
  // Контейнер правится из меню. Esc сначала снимает выделение нового блока: его панель лежит над шапкой.
  await b.key('Escape');
  await b.until(`window.mycel.state.selected === null`);
  await b.rightClick('.block[data-id="L"] > .head');
  await b.until(`Boolean(document.querySelector('#menu [data-menu="edit"]')) && !document.querySelector('#menu').hidden`);
  await b.click('#menu [data-menu="edit"]');
  await b.until(`window.mycel.state.editing === 'L' && document.activeElement?.matches('.block[data-id="L"] > .head > .b-title-input')`);
});

test('the level slider folds the map by depth; it shows the level of a dive', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha'), ids = ['A', 'M', 'T'];
  await h.agent(p.id, [add('A', { w: 900, h: 700 }), add('B', { x: 1300, y: 0 }), add('M', { parentId: 'A', x: 10, y: 10, w: 700, h: 500 }),
    add('T', { parentId: 'M', x: 10, y: 10, w: 400, h: 300 }), add('K', { parentId: 'T', x: 10, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${settled}`);
  // Вместо кнопок — ползунок с четырьмя делениями; рядом одно слово — название выбранного уровня.
  assert.deepEqual(await b.evaluate(`(() => { const s = document.querySelector('#level'); return [s.type, s.min, s.max, document.querySelectorAll('#levels .level-track i').length,document.querySelectorAll('#levels button').length]; })()`), ['range', '1', '4', 4, 0]);
  await b.until(`${active} === '4' && ${levelName} === 'Код' && document.querySelector('#level').value === '4'`);
  assert.deepEqual(await b.evaluate(`['A', 'M', 'T'].map(id => document.querySelector('.block[data-id="' + id + '"] > .sub > .sub-level').textContent)`), ['Механика', 'Техника', 'Код']);
  // Щелчок по делению, как настоящей мышью; переключения уровня подряд — одна запись истории.
  const count = await h.entries(p.id), names = ['Концепция', 'Механика', 'Техника', 'Код'];
  for (const [level, want] of [[3, { A: false, M: false, T: true }], [1, { A: true, M: true, T: true }], [4, { A: false, M: false, T: false }], [2, { A: false, M: true, T: true }]]) {
    await b.click(tick(level));
    await until(async () => JSON.stringify(await h.folds(p.id, ids)) === JSON.stringify(want));
    await b.until(`${active} === '${level}' && ${levelName} === '${names[level - 1]}' && ${settled}`);
    assert.equal(await h.entries(p.id), count + 1);
  }
  // Стрелки на ползунке шагают по уровню.
  await b.evaluate(`document.querySelector('#level').focus()`);
  await b.key('ArrowRight');
  await h.foldsAre(p.id, { A: false, M: false, T: true });
  await b.until(`${active} === '3' && ${settled}`);
  await b.key('ArrowLeft');
  await h.foldsAre(p.id, { A: false, M: true, T: true });
  await b.until(`${active} === '2' && ${settled}`);
  await b.evaluate(`document.querySelector('#level').blur()`);
  // В погружении активен уровень, который виден внутри открытого блока.
  await b.dblclick('.block[data-id="M"] > .head');
  await b.until(`${focused('M')} && ${folded('T')} && ${settled}`);
  await b.until(`${active} === '3'`);
  // Esc при выделенном блоке только снимает выделение.
  await b.click('.block[data-id="T"] > .head');
  await b.until(`window.mycel.state.selected?.id === 'T'`);
  await b.key('Escape');
  await b.until(`window.mycel.state.selected === null`);
  await sleep(300);
  assert.equal(await b.evaluate(focused('M')), true);
  await b.key('Escape');
  await b.until(`${focused('A')} && ${settled}`);
  await b.until(`${active} === '2'`);
  await b.key('Escape');
  await b.until(`${focused(null)} && ${settled}`);
  assert.deepEqual(await h.folds(p.id, ids), { A: false, M: true, T: true });
  await b.until(`${active} === '2'`);
});

test('while the level slider is dragged only its name changes; on release the map folds; a map no level fits dims it', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await b.goto(`${h.url}/#/p/${p.id}`);
  // Без подкарт уровни не к чему применить: ползунок неактивен.
  await b.until(`document.querySelector('#level')?.disabled === true`);
  await h.agent(p.id, [add('A', { w: 500, h: 300 }), add('M', { parentId: 'A', x: 10, y: 10 }), add('B', { x: 900, y: 0, w: 500, h: 300 }), add('N', { parentId: 'B', x: 10, y: 10 })]);
  await b.until(`Boolean(document.querySelector('.block[data-id="N"]')) && document.querySelector('#level').disabled === false && ${active} === '2' && ${settled}`);
  // Тянем от «Механики» к «Концепции»: пока кнопка зажата, меняется только название, карта и история — нет.
  const count = await h.entries(p.id);
  await b.drag(tick(2), tick(1), async () => {
    await b.until(`${levelName} === 'Концепция' && document.querySelector('#level').value === '1'`);
    await sleep(300);
    assert.deepEqual(await h.folds(p.id, ['A', 'B']), { A: false, B: false });
    assert.equal(await h.entries(p.id), count);
    // Агент добавляет развёрнутую подкарту, пока ползунок держат: бегунок не прыгает, а отпускание сворачивает и её.
    await h.agent(p.id, [add('C', { x: 1800, y: 0, w: 500, h: 300 }), add('K', { parentId: 'C', x: 10, y: 10 })]);
    await sleep(300);
    assert.equal(await b.evaluate(`document.querySelector('#level').value`), '1');
  });
  await h.foldsAre(p.id, { A: true, B: true, C: true });
  await b.until(`${active} === '1' && ${settled}`);
  // Шеврон разворачивает только A: карте не подходит ни один уровень — бегунок тусклый, без названия, стоит там,
  // до куда видна карта. Читалка экрана тоже не слышит названия уровня.
  const mixed = `(${active} === '' && document.querySelector('#levels').classList.contains('mixed') && ${levelName} === '' && document.querySelector('#level').value === '2')`;
  const aligned = `(${active} === '2' && !document.querySelector('#levels').classList.contains('mixed') && ${levelName} === 'Механика')`;
  await b.click('.block[data-id="A"] .fold');
  await h.foldsAre(p.id, { A: false, B: true, C: true });
  await b.until(`${mixed} && ${settled}`);
  assert.equal(await b.evaluate(`document.querySelector('#level').getAttribute('aria-valuetext')`), 'Подкарты свёрнуты вразнобой');
  // Правый клик по ползунку и нажатие, начатое не на нём, уровень не применяют.
  await b.rightClick(tick(2));
  await b.drag('.dock-bar > .grow', tick(2));
  await sleep(300);
  assert.deepEqual(await h.folds(p.id, ['A', 'B', 'C']), { A: false, B: true, C: true });
  assert.equal(await b.evaluate(`${mixed} && ${settled}`), true);
  // Это протягивание выделило текст строки вместе с ползунком: следующее нажатие потащило бы выделение.
  await b.evaluate(`getSelection().removeAllRanges()`);
  // Бегунок увели и вернули на то же деление: уровень, который он показывал, применяется.
  await b.drag(tick(2), [tick(3), tick(2)]);
  await h.foldsAre(p.id, { A: false, B: false, C: false });
  await b.until(`${aligned} && ${settled}`);
  // Щелчок по тому же делению (значение не меняется) тоже выравнивает карту по уровню.
  await b.click('.block[data-id="A"] .fold');
  await h.foldsAre(p.id, { A: true, B: false, C: false });
  await b.until(`${mixed} && ${settled}`);
  await b.click(tick(2));
  await h.foldsAre(p.id, { A: false, B: false, C: false });
  await b.until(`${aligned} && ${settled}`);
});

test('quick level steps are not lost while an earlier one is saving; after a click on the slider Enter and Delete still act on the selected block', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('A', { w: 900, h: 700 }), add('M', { parentId: 'A', x: 10, y: 10, w: 700, h: 500 }), add('T', { parentId: 'M', x: 10, y: 10, w: 400, h: 300 }),
    add('K', { parentId: 'T', x: 10, y: 10 }), add('P', { x: 1300, y: 0 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${active} === '4' && ${settled}`);
  // Запись идёт на 150 мс дольше: следующие шаги приходят, пока предыдущий ещё сохраняется.
  await b.evaluate(`(() => { const f = window.fetch; window.fetch = async (u, o) => { const res = await f(u, o); if (o?.method === 'POST' && String(u).endsWith('/changes')) await new Promise(r => setTimeout(r, 150)); return res; }; })()`);
  const at = (level, want) => `(${active} === '${level}' && document.querySelector('#level').value === '${level}' && ${levelName} === '${want}' && ${settled})`;
  // Три стрелки подряд — с «Кода» до «Концепции».
  await b.evaluate(`document.querySelector('#level').focus()`);
  for (let i = 0; i < 3; i++) { await b.key('ArrowLeft'); await sleep(40); }
  await h.foldsAre(p.id, { A: true, M: true, T: true });
  await b.until(at(1, 'Концепция'));
  // Два щелчка подряд — применяется второй.
  await b.click(tick(4)); await sleep(30); await b.click(tick(2));
  await h.foldsAre(p.id, { A: false, M: true, T: true });
  await b.until(at(2, 'Механика'));
  await sleep(300);
  assert.deepEqual(await h.folds(p.id, ['A', 'M', 'T']), { A: false, M: true, T: true });

  // После щелчка по ползунку фокус на нём, а Enter и Delete работают с выделенным блоком, как до щелчка.
  await b.click('.block[data-id="P"]');
  await b.until(`window.mycel.state.selected?.id === 'P'`);
  await b.click(tick(3));
  await h.foldsAre(p.id, { A: false, M: false, T: true });
  await b.until(`${at(3, 'Техника')} && document.activeElement?.id === 'level' && window.mycel.state.selected?.id === 'P'`);
  await b.key('Enter');
  await b.until(`window.mycel.state.editing === 'P'`);
  await b.key('Escape');
  await b.until(`window.mycel.state.editing === null && ${settled}`);
  await b.click('.block[data-id="P"]');
  await b.click(tick(2));
  await b.until(`${at(2, 'Механика')} && document.activeElement?.id === 'level' && window.mycel.state.selected?.id === 'P'`);
  await b.key('Delete');
  await until(async () => !(await h.node(p.id, 'P')));
});

test('in a narrow bar the slider with its name keeps one width at every level; with reduced motion the fill does not animate', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('ab');
  await h.agent(p.id, [add('A', { w: 500, h: 300 }), add('M', { parentId: 'A', x: 10, y: 10 })]);
  await b.size(600, 800);
  await b.media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${active} === '2' && ${settled}`);
  // Бегунок тянут по всем делениям: название меняется, а ширина ползунка с названием — нет, иначе в узкой строке он
  // перескакивал бы между линиями прямо под указателем.
  const widths = await b.evaluate(`[1, 2, 3, 4].map(v => { const s = document.querySelector('#level'); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true }));
    return [document.querySelector('#level-name').textContent, document.querySelector('#levels').getBoundingClientRect().width]; })`);
  assert.deepEqual(widths.map(([name]) => name), ['Концепция', 'Механика', 'Техника', 'Код']);
  assert.equal(new Set(widths.map(([, w]) => w)).size, 1, JSON.stringify(widths));
  assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.level-track'), '::after').transitionDuration`), '0s');
});

test('Esc or a double-click on empty canvas while a block is still being edited saves the edit before going up; live updates keep coming', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('A', { w: 700, h: 500 }), add('M1', { parentId: 'A', x: 10, y: 10, w: 560, h: 300 }), add('T1', { parentId: 'M1', x: 10, y: 10 }), add('T2', { parentId: 'M1', x: 280, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${settled}`);
  const intoM1 = async () => {
    await b.dblclick('.block[data-id="M1"] > .head');
    await b.until(`${focused('M1')} && !${folded('M1')} && ${settled}`);
  };
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  await intoM1();
  // Правка названия; щелчок по полю самого блока уводит курсор из поля ввода, а правка остаётся открытой.
  const edit = async (id, text) => {
    await b.dblclick(`.block[data-id="${id}"] > .b-title`);
    await b.until(`window.mycel.state.editing === '${id}' && document.activeElement?.matches('.block[data-id="${id}"] .b-title-input')`);
    await b.type(text);
    await b.click(await b.evaluate(`(() => { const r = document.querySelector('.block[data-id="${id}"]').getBoundingClientRect(); return { x: r.left + 4, y: r.top + 4 }; })()`));
    await b.until(`window.mycel.state.editing === '${id}' && document.activeElement === document.querySelector('.block[data-id="${id}"]')`);
  };
  await edit('T1', 'Новое имя');
  // Esc сначала заканчивает правку, потом снимает выделение; вверх — только когда нет ни того, ни другого.
  await b.key('Escape');
  await b.until(`window.mycel.state.editing === null && ${settled}`);
  await until(async () => (await h.node(p.id, 'T1')).title === 'Новое имя');
  assert.equal(await b.evaluate(`${focused('M1')} && window.mycel.state.selected?.id === 'T1'`), true);
  await b.key('Escape');
  await b.until(`window.mycel.state.selected === null`);
  await sleep(300);
  assert.equal(await b.evaluate(focused('M1')), true);
  await b.key('Escape');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);

  // Двойной клик по пустому месту при открытой правке: правка сохраняется, потом уровень вверх.
  await intoM1();
  await edit('T2', 'Второе');
  await b.dblclick(await b.evaluate(corner));
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled} && window.mycel.state.editing === null`);
  await until(async () => (await h.node(p.id, 'T2')).title === 'Второе');
  // Живое обновление не замерло: блок агента появляется.
  await h.agent(p.id, [add('X', { parentId: 'A', x: 10, y: 360 })]);
  await b.until(`Boolean(document.querySelector('.block[data-id="X"]')) && !window.mycel.state.pending`);
});

test('leaving the project or reloading the page in a dive returns the folds and clears the focus', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha'), key = JSON.stringify(`mycel.dive.${p.id}`);
  await h.agent(p.id, [add('A', { w: 700, h: 500 }), add('M1', { parentId: 'A', x: 10, y: 10, w: 400, h: 300 }), add('T1', { parentId: 'M1', x: 10, y: 10 }),
    add('C', { x: 1100, y: 0, w: 700, h: 500 }), add('C1', { parentId: 'C', x: 10, y: 10, w: 400, h: 300 }), add('C2', { parentId: 'C1', x: 10, y: 10 })]);
  const open = { A: false, M1: false, C: false, C1: false };
  const opened = async () => { await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${settled}`); };
  const diveA = async () => {
    await b.dblclick('.block[data-id="A"] > .head');
    await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
    await until(async () => await humanFocus(h, p.id) === 'A');
    assert.deepEqual(await h.folds(p.id, Object.keys(open)), { ...open, M1: true });
  };
  await b.goto(`${h.url}/#/p/${p.id}`);
  await opened();

  // Назад к проектам и обратно: карта такая же, как до погружения, горит её уровень.
  await diveA();
  await b.evaluate(`location.hash = '#/'`);
  await b.until(`document.querySelectorAll('.p-row').length === 1`);
  assert.deepEqual(await h.folds(p.id, Object.keys(open)), open);
  await until(async () => await humanFocus(h, p.id) === null);
  await b.evaluate(`location.hash = '#/p/${p.id}'`);
  await opened();
  assert.equal(await b.evaluate(active), '3');

  // Перезагрузка в погружении: выход уходит запросами при закрытии страницы.
  await diveA();
  assert.notEqual(await b.evaluate(`sessionStorage.getItem(${key})`), null);
  await b.evaluate(`sessionStorage.removeItem(${key})`);
  await b.reload();
  await opened();
  await h.foldsAre(p.id, open);
  await until(async () => await humanFocus(h, p.id) === null);
  assert.equal(await b.evaluate(`${focused(null)} && document.querySelector('#focus-bar').hidden && !document.querySelector('.block.out-focus')`), true);

  // Запросы при закрытии не дошли: сворачивание возвращает перезагруженная страница.
  await diveA();
  await b.evaluate(`(() => { const f = window.fetch; window.fetch = (u, o) => o?.keepalive ? Promise.resolve(new Response('{}')) : f(u, o); })()`);
  await b.reload();
  await opened();
  await h.foldsAre(p.id, open);
  await until(async () => await humanFocus(h, p.id) === null);
  assert.equal(await b.evaluate(`sessionStorage.getItem(${key})`), null);
});

test('a level chosen inside a dive keeps the opened block open, shows the chosen level and is undone on exit; a deep dive shows «Код»', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('A', { w: 1100, h: 800 }), add('M', { parentId: 'A', x: 10, y: 10, w: 900, h: 600 }), add('T', { parentId: 'M', x: 10, y: 10, w: 700, h: 400 }),
    add('K', { parentId: 'T', x: 10, y: 10, w: 400, h: 200 }), add('Z', { parentId: 'K', x: 10, y: 10 })]);
  const open = { A: false, M: false, T: false, K: false };
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${settled}`);
  await b.until(`${active} === '4'`);
  const into = async (id, inner) => {
    await b.dblclick(`.block[data-id="${id}"] > .head`);
    await b.until(`${focused(id)} && !${folded(id)} && ${folded(inner)} && ${settled}`);
  };

  // «Концепция» в погружении в A сворачивает только то, что внутри A, сам A открыт; выход через «Карта» возвращает всё.
  await into('A', 'M');
  await b.until(`${active} === '2'`);
  await b.click(tick(1));
  await h.foldsAre(p.id, { A: false, M: true, T: true, K: true });
  await b.until(`${active} === '1' && !${folded('A')} && ${settled}`);
  await b.click('#focus-bar .focus-path [data-action="unfocus"]');
  await b.until(`${focused(null)} && ${settled}`);
  await h.foldsAre(p.id, open);
  await b.until(`${active} === '4'`);

  // «Механика» в погружении в M: сам M остаётся открытым, ползунок показывает выбранный уровень.
  await into('A', 'M');
  await into('M', 'T');
  await b.until(`${active} === '3'`);
  await b.click(tick(2));
  await h.foldsAre(p.id, { A: false, M: false, T: true, K: true });
  await b.until(`${active} === '2' && !${folded('M')} && ${settled}`);

  // Глубже, в T: внутри него шаг K со своей подкартой, свёрнутой погружением, — горит «Код».
  await into('T', 'K');
  await b.until(`${active} === '4'`);

  // Вверх до всей карты: сворачивание из погружения возвращается.
  for (const id of ['M', 'A', null]) {
    await b.key('Escape');
    await b.until(`${focused(id)} && ${settled}`);
  }
  await h.foldsAre(p.id, open);
  await b.until(`${active} === '4'`);
});

test('there is no chat: the agent dot and what the agent is doing sit under the map, a block the agent shows opens its level and is centred, a selection reaches the hub', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('A', { w: 700, h: 500 }), add('M1', { parentId: 'A', x: 10, y: 10 }), add('B', { x: 1100, y: 0 }),
    add('C', { x: 0, y: 700, w: 700, h: 500 }), add('C1', { parentId: 'C', x: 10, y: 10, w: 400, h: 300 }), add('C2', { parentId: 'C1', x: 10, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${settled}`);
  // Блок виден и стоит в центре карты.
  const centred = id => `(() => { const el = document.querySelector('.block[data-id="${id}"]'), v = document.querySelector('#viewport').getBoundingClientRect(), r = el.getBoundingClientRect();
    return getComputedStyle(el).visibility === 'visible' && Math.abs(r.left + r.width / 2 - v.left - v.width / 2) < 2 && Math.abs(r.top + r.height / 2 - v.top - v.height / 2) < 2; })()`;
  assert.deepEqual(await b.evaluate(`[Boolean(document.querySelector('#chat, #chat-input')), document.querySelector('#viewport').getBoundingClientRect().left]`), [false, 0]);

  // Что агент делает сейчас — строка над строкой управления, его точка — в ней; снятая строка исчезает.
  await h.doing(p.id, 'читаю `cart.ts`', 40);
  await b.until(`!document.querySelector('#progress-row').hidden && document.querySelector('.progress-label').textContent === 'claude читаю \`cart.ts\`' && Boolean(document.querySelector('#agents .dot'))`);
  assert.equal(await b.evaluate(`document.querySelector('.progress-value').textContent`), '40%');
  await h.doing(p.id, null);
  await b.until(`document.querySelector('#progress-row').hidden`);

  // Блок основной карты: погружение закрывается.
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${settled}`);
  await h.show(p.id, 'B');
  await b.until(`${focused(null)} && window.mycel.state.selected?.id === 'B' && ${settled}`);
  assert.equal(await b.evaluate(centred('B')), true);
  // Выделенное человеком хаб знает: агенту «это» понятно.
  await until(async () => (await h.get(`/api/p/${p.id}/selection`)).selection === 'B');

  // Блок внутри другого модуля: открывается блок, в котором он лежит.
  await b.click('.zoom-bar [data-action="fit"]');
  await b.until(settled);
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${settled}`);
  await h.show(p.id, 'C2');
  await b.until(`${focused('C1')} && window.mycel.state.selected?.id === 'C2' && ${settled}`);
  assert.equal(await b.evaluate(path), 'Карта › C › C1');
  assert.equal(await b.evaluate(centred('C2')), true);
  await until(async () => (await h.get(`/api/p/${p.id}/selection`)).selection === 'C2');
});

test('an agent proposal is highlighted and dashed with «Отклонить» and «Принять» at the bottom; marks colour blocks; a new human block is a plan', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('k', { title: 'Корзина', w: 520, h: 320 }), add('s', { parentId: 'k', title: 'Сумма', x: 10, y: 10 }), add('d', { parentId: 'k', title: 'Доставка', x: 260, y: 10 }), add('o', { title: 'Оплата', x: 700, y: 0 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="s"]')) && ${settled}`);
  const cls = id => `[...document.querySelector('.block[data-id="${id}"]').classList].filter(c => /^(st-|pr-|failed)/.test(c)).join(' ')`;
  const offer = async (title, operations) => { const { revision } = await h.get(`/api/p/${p.id}/graph`); const res = await h.post(`/api/p/${p.id}/proposal`, { expectedRevision: revision, actor: 'claude', title, operations }); assert.equal(res.status, 200, res.body.error); };
  await offer('Промокоды', [add('promo', { parentId: 'k', title: 'Промокод', x: 10, y: 160 }), { type: 'update-node', id: 's', patch: { text: 'со скидкой' } }, { type: 'delete-node', id: 'd' }]);
  await b.until(`Boolean(document.querySelector('.block[data-id="promo"]')) && document.querySelector('#edits .edits-title')?.textContent === 'Предложение «Промокоды»'`);
  assert.deepEqual(await b.evaluate(`[${['promo', 's', 'd', 'o'].map(cls).join(', ')}]`), ['st-plan pr-add', 'pr-change', 'pr-remove', '']);
  assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.block[data-id="promo"]')).borderTopStyle`), 'dashed');
  assert.equal(await b.evaluate(`document.querySelector('#edits .edits-count').textContent`), '3');
  // «Отклонить»: предложенное уходит, изменённое возвращается; решение подтверждает короткое сообщение.
  await b.click('#edits [data-action="proposal-reject"]');
  await b.until(`!document.querySelector('.block[data-id="promo"]') && document.querySelector('#edits').hidden && document.querySelector('#toast')?.textContent.includes('Предложение отклонено')`);
  assert.deepEqual(await b.evaluate(`[${['s', 'd'].map(cls).join(', ')}]`), ['', '']);
  assert.equal((await h.node(p.id, 's')).text, '');
  // «Принять»: новое остаётся планом, помеченное к удалению удаляется.
  await offer('Промокоды', [add('promo', { parentId: 'k', title: 'Промокод', x: 10, y: 160 }), { type: 'delete-node', id: 'd' }]);
  await b.until(`Boolean(document.querySelector('.block[data-id="promo"]')) && !document.querySelector('#edits').hidden`);
  await b.click('#edits [data-action="proposal-accept"]');
  await b.until(`document.querySelector('#edits').hidden && !document.querySelector('.block[data-id="d"]')`);
  assert.equal(await b.evaluate(cls('promo')), 'st-plan');
  // Проверка не прошла внутри подкарты — подкарта красная; прошла — блок зелёный.
  await h.agent(p.id, [{ type: 'update-node', id: 's', patch: { status: 'failed' } }, { type: 'update-node', id: 'o', patch: { status: 'passed' } }]);
  await b.until(`${cls('s')} === 'st-failed' && ${cls('k')} === 'failed-inside' && ${cls('o')} === 'st-passed'`);
  // Отметка — только рамкой, без заливки. Смена по SSE вспыхивает; идущая проверка видна и на подкарте вокруг.
  assert.deepEqual(await b.evaluate(`(() => { const s = getComputedStyle(document.querySelector('.block[data-id="o"]')); return [s.boxShadow.includes('inset'), s.backgroundImage]; })()`), [false, 'none']);
  await h.agent(p.id, [{ type: 'update-node', id: 's', patch: { status: 'testing' } }]);
  await b.until(`${cls('s')} === 'st-testing' && document.querySelector('.block[data-id="s"]').classList.contains('remark') && document.querySelector('.block[data-id="k"]').classList.contains('testing-inside')`);
  assert.notEqual(await b.evaluate(`getComputedStyle(document.querySelector('.block[data-id="s"]')).animationName`), 'none');
  // Блок, созданный человеком, — план.
  await b.rightClick({ x: 1100, y: 700 });
  await b.until(`Boolean(document.querySelector('#menu [data-menu="new-block"]')) && !document.querySelector('#menu').hidden`);
  await b.click('#menu [data-menu="new-block"]');
  await b.until(`document.activeElement?.classList.contains('b-title-input')`);
  await b.type('Возвраты');
  await b.key('Escape');
  await until(async () => (await h.get(`/api/p/${p.id}/graph`)).nodes.some(n => n.title === 'Возвраты' && n.status === 'plan'));
});

test('the pencil in the corner of a block shows on hover and opens the edit at once, also for a container, without moving or diving', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('a', { title: 'Каталог' }), add('c', { title: 'Корзина', x: 400, y: 0, w: 400, h: 300 }), add('c1', { parentId: 'c', x: 10, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="c1"]')) && ${settled}`);
  const shown = id => `getComputedStyle(document.querySelector('.block[data-id="${id}"] > .pen')).opacity === '1'`;
  assert.equal(await b.evaluate(shown('a')), false);
  await b.click('.zoom-bar [data-action="fit"]');
  await b.until(settled);
  // Наведение показывает карандаш только у блока под указателем; нажатие открывает правку названия, блок не сдвигается.
  const release = await b.press('.block[data-id="a"] .b-text');
  await release();
  await b.until(`${shown('a')} && !(${shown('c')})`);
  const before = await h.node(p.id, 'a');
  await b.click('.block[data-id="a"] > .pen');
  await b.until(`document.activeElement?.classList.contains('b-title-input') && document.activeElement.closest('.block').dataset.id === 'a'`);
  await b.type('Каталог товаров');
  await b.key('Escape');
  await until(async () => (await h.node(p.id, 'a')).title === 'Каталог товаров');
  const after = await h.node(p.id, 'a');
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
  // У блока с подкартой карандаш стоит левее шеврона и правит шапку, а не погружает.
  const pen = await b.evaluate(`(() => { const p = document.querySelector('.block[data-id="c"] > .pen').getBoundingClientRect(), f = document.querySelector('.block[data-id="c"] > .fold').getBoundingClientRect(); return p.right <= f.left; })()`);
  assert.equal(pen, true);
  await b.click('.block[data-id="c"] > .pen');
  await b.until(`document.activeElement?.classList.contains('b-title-input') && document.activeElement.closest('.block').dataset.id === 'c'`);
  assert.equal(await b.evaluate(focused(null)), true);
  await b.type('Корзина покупателя');
  await b.key('Escape');
  await until(async () => (await h.node(p.id, 'c')).title === 'Корзина покупателя');
});

test('a human edit shows «Закончить правки» at the bottom middle of the map; it hands the edits to the agent as one event', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('a'), add('c', { x: 400, y: 0, w: 400, h: 300 }), add('c1', { parentId: 'c', x: 10, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="a"]')) && ${settled}`);
  // Смена уровня правок не начинает, правка названия — начинает.
  await b.evaluate(`(() => { const s = document.querySelector('#level'); s.value = 1; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(async () => (await h.node(p.id, 'c')).collapsed === true);
  await b.until(settled);
  assert.equal(await b.evaluate(`document.querySelector('#edits').hidden`), true);
  await b.dblclick('.block[data-id="a"] .b-title');
  await b.until(`Boolean(document.querySelector('.block[data-id="a"] .b-title-input'))`);
  await b.type(' и ещё');
  await b.key('Escape');
  await b.until(`!document.querySelector('#edits').hidden && document.querySelector('.edits-count').textContent === '1'`);
  const place = await b.evaluate(`(() => { const e = document.querySelector('#edits').getBoundingClientRect(), v = document.querySelector('#viewport').getBoundingClientRect();
    return [Math.abs(e.left + e.width / 2 - v.left - v.width / 2) < 2, v.bottom - e.bottom > 0 && v.bottom - e.bottom < 40]; })()`);
  assert.deepEqual(place, [true, true]);
  // Кнопка отдаёт правки одним событием и коротко подтверждает это.
  await b.click('#edits .btn');
  await b.until(`document.querySelector('#edits').hidden && document.querySelector('#toast')?.textContent.includes('Правки переданы агенту')`);
  const { messages } = await h.get(`/api/p/${p.id}/chat`);
  assert.deepEqual(messages.map(m => [m.kind, m.edits?.count]), [['edits', 1]]);
});

// Код глазами Mycel: имя агента над блоком, файлы которого он правит, «устарел?», режим «Здоровье» с переходом к
// блокам, «Проверить» в меню блока с командой проверки и сводка «Что изменилось» в истории.
test('an agent editing files shows over its block, a stale block says so, «Здоровье» walks to issues, «Проверить» asks the agent, history tells what changed', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('K', { title: 'Ядро', w: 520, h: 320 }), add('S', { parentId: 'K', title: 'Сервер', x: 10, y: 10, files: ['lib/'], test: 'npm test' }),
    add('U', { title: 'Интерфейс', x: 700, y: 0, files: ['ui.js'] }), add('F', { title: 'Оплата', x: 700, y: 300, status: 'failed' })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="S"]')) && ${settled}`);
  assert.equal(await b.evaluate(`document.querySelector('.block[data-id="S"] .b-title').title`), 'Файлы: lib/\nПроверка: npm test');
  assert.equal((await h.post(`/api/p/${p.id}/touch`, { actor: 'claude', files: ['lib/a.js'], session: 's1' })).status, 200);
  await b.until(`document.querySelector('.block[data-id="S"] > .code-row > .who')?.textContent === 'claude' && Boolean(document.querySelector('.block[data-id="S"] > .code-row > .stale-tag'))`);
  assert.equal(await b.evaluate(`document.querySelectorAll('.who').length`), 1);
  // «Здоровье»: что не так и сколько; здоровые блоки бледнеют, нажатие ведёт к блоку.
  await b.click('#health-toggle');
  await b.until(`document.querySelector('#viewport').classList.contains('health') && document.querySelector('#health')?.textContent === 'Не прошло 1Устарело 1Без проверки 1'`);
  assert.deepEqual(await b.evaluate(`['S', 'U', 'F', 'K'].map(id => document.querySelector('.block[data-id="' + id + '"] > .health-tag')?.textContent ?? null)`), ['устарел?', 'без проверки', 'не прошла', null]);
  await b.click('#health [data-health="failed"]');
  await b.until(`window.mycel.state.selected?.id === 'F' && ${settled}`);
  await b.click('#health-toggle');
  await b.until(`!document.querySelector('#health') && !document.querySelector('#viewport').classList.contains('health')`);
  // «Проверить» — только у блока с командой проверки (или с ней внутри); просьба уходит агенту событием.
  await b.rightClick('.block[data-id="U"] .b-title');
  await b.until(`!document.querySelector('#menu').hidden`);
  assert.equal(await b.evaluate(`Boolean(document.querySelector('#menu [data-menu="check"]'))`), false);
  await b.key('Escape');
  await b.rightClick('.block[data-id="K"] > .head');
  await b.until(`Boolean(document.querySelector('#menu [data-menu="check"]')) && !document.querySelector('#menu').hidden`);
  await b.click('#menu [data-menu="check"]');
  await until(async () => (await h.get(`/api/p/${p.id}/chat`)).messages.at(-1)?.check?.ids?.[0] === 'K');
  // История: что изменилось по концепциям.
  await b.click('.tabs [data-tab="history"]');
  await b.until(`document.querySelector('.review') && [...document.querySelectorAll('.review h3')].map(e => e.textContent).join() === '«Интерфейс»,«Оплата»,«Ядро»'`);
  assert.match(await b.evaluate(`document.querySelector('.review').textContent`), /добавлен блок «Сервер».*Проверка не прошла: «Оплата»\./s);
  await b.click('.review [data-review-hours="1"]');
  await b.until(`document.querySelector('.review [data-review-hours="1"]')?.classList.contains('active')`);
});

// Запрос доступа виртуальной машины: карточка с её кодом на любой странице основной машины, проект выбирает человек;
// «Разрешить» выдаёт ключ, «Отключить» на главной его отзывает, «Отклонить» на странице проекта — отказ.
test('a virtual machine access request shows a card with its code on any page; «Разрешить» grants it, «Отключить» revokes it', { skip }, async t => {
  const data = await temp('mycel-ui-pair-'), folders = await temp('mycel-ui-pair-folders-'), app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data, folders); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('второго адреса loopback нет');
  const make = async name => { const dir = join(folders, name); await mkdir(dir); return (await (await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, name }) })).json()).project; };
  const alpha = await make('Альфа'), beta = await make('Бета');
  const ask = async () => (await fetch(`${far}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ubuntu' }) })).json();
  const answer = async r => (await fetch(`${far}/api/pair/${r.id}?secret=${r.secret}`)).json();
  const b = await browser(t);
  await b.goto(`${app.url}/#/`);
  await b.until(`document.querySelectorAll('.p-row').length === 2`);
  let asked = await ask();
  await b.until(`document.querySelector('#access .access-text b')?.textContent === '${asked.code}'`);
  assert.match(await b.evaluate(`document.querySelector('#access .access-text').textContent`), /Виртуальная машина «ubuntu» \(127\.0\.0\.1\) просит доступ к Mycel\. Код \d{4}/);
  await b.evaluate(`document.querySelector('[data-pair-project]').value = ${JSON.stringify(beta.id)}`);
  await b.click('[data-pair-approve]');
  await b.until(`!document.querySelector('#access') && document.querySelector('#devices li')?.textContent.startsWith('ubuntu · 127.0.0.1 · Бета')`);
  const granted = await answer(asked);
  assert.deepEqual([granted.status, granted.project], ['approved', beta.id]);
  await b.click('#devices [data-revoke]');
  await b.until(`document.querySelector('#devices').hidden`);
  assert.equal((await fetch(`${far}/api/projects`, { headers: { Authorization: `Bearer ${granted.key}` } })).status, 401);
  // На странице проекта — та же карточка, по умолчанию с этим проектом.
  await b.goto(`${app.url}/#/p/${alpha.id}`);
  await b.until(`Boolean(document.querySelector('#viewport'))`);
  asked = await ask();
  await b.until(`document.querySelector('#access .access-text b')?.textContent === '${asked.code}'`);
  assert.equal(await b.evaluate(`document.querySelector('[data-pair-project]').value`), alpha.id);
  await b.click('[data-pair-deny]');
  await b.until(`!document.querySelector('#access')`);
  assert.deepEqual(await answer(asked), { status: 'denied' });
});

test('a link starts from any edge of a block or with Alt anywhere on it and lands on the block under the pointer, also one lying under the source; the map has no dots', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  // «u» лежит поверх «a» и закрывает его правый нижний угол; «k» — подкарта с блоком «k1».
  await h.agent(p.id, [add('a'), add('b', { x: 400, y: 0 }), add('u', { x: 120, y: 60 }), add('k', { x: 0, y: 260, w: 520, h: 300 }), add('k1', { parentId: 'k', x: 10, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="k1"]')) && ${settled}`);
  assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('#viewport')).backgroundImage`), 'none');
  const box = id => b.evaluate(`(() => { const r = document.querySelector('.block[data-id="${id}"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const edges = async () => (await h.get(`/api/p/${p.id}/graph`)).edges.map(e => `${e.source}>${e.target}`).sort();
  const [a, bb, u, k, k1] = await Promise.all(['a', 'b', 'u', 'k', 'k1'].map(box));
  // С нижнего края «b» — в блок внутри подкарты.
  await b.drag({ x: bb.x + bb.w / 2, y: bb.y + bb.h }, { x: k1.x + k1.w / 2, y: k1.y + k1.h / 2 });
  await until(async () => (await edges()).includes('b>k1'));
  // С левого края «a» — в пустое место подкарты: связь с самой подкартой.
  await b.drag({ x: a.x, y: a.y + 20 }, { x: k.x + k.w - 60, y: k.y + k.h - 40 });
  await until(async () => (await edges()).includes('a>k'));
  // С верхнего края «u» — на ту часть «a», которую «u» сам и закрывает.
  await b.drag({ x: u.x + u.w - 30, y: u.y }, { x: u.x + 20, y: u.y + 20 });
  await until(async () => (await edges()).includes('u>a'));
  // С Alt — из середины видимой части «a» к «b»; «a» при этом не двигается.
  const before = await h.node(p.id, 'a');
  await b.drag({ x: a.x + 50, y: a.y + 30 }, { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }, null, 1);
  await until(async () => (await edges()).includes('a>b'));
  const after = await h.node(p.id, 'a');
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
  // Без Alt середина блока по-прежнему двигает его.
  await b.drag({ x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }, { x: bb.x + bb.w / 2 + 40, y: bb.y + bb.h / 2 });
  await until(async () => (await h.node(p.id, 'b')).x > 400);
  assert.deepEqual(await edges(), ['a>b', 'a>k', 'b>k1', 'u>a']);
});
