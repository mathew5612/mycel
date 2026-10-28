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

// The interface in headless Chrome over the DevTools protocol, without packages. The hub runs on temporary data and port 0,
// Chrome with its own temporary profile and port 0. Without Chrome the tests are skipped (the path can be set in MYCEL_CHROME).
const chrome = [process.env.MYCEL_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && existsSync(p));
const skip = !chrome && 'Chrome not found';
const temp = prefix => mkdtemp(join(tmpdir(), prefix));
const clean = (...dirs) => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await check()) return; assert.fail('Timed out waiting'); };
const add = (id, extra = {}) => ({ type: 'add-node', node: { id, title: id, x: 0, y: 0, ...extra } });

async function hub(t) {
  const data = await temp('mycel-ui-data-'), folders = await temp('mycel-ui-folders-');
  const app = await startServer({ data, port: 0 });
  t.after(async () => { await app.close(); await clean(data, folders); });
  const token = (await readFile(join(data, 'token'), 'utf8')).trim();
  const post = async (path, body) => { const res = await fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const get = async path => (await fetch(app.url + path)).json();
  const project = async name => { const dir = join(folders, name); await mkdir(dir); return (await post('/api/projects', { path: dir, name })).body.project; };
  // An agent write on top of the current revision, like mycel build in steps.
  const agent = async (id, operations) => {
    const { revision } = await get(`/api/p/${id}/graph`), res = await post(`/api/p/${id}/changes`, { expectedRevision: revision, actor: 'agent', message: 'Agent step', operations });
    assert.equal(res.status, 200, res.body.error); return res.body;
  };
  const node = async (pid, id) => (await get(`/api/p/${pid}/graph`)).nodes.find(n => n.id === id);
  // Collapsed state of sub-maps by id, and the number of history entries.
  const folds = async (pid, ids) => Object.fromEntries((await get(`/api/p/${pid}/graph`)).nodes.filter(n => ids.includes(n.id)).map(n => [n.id, n.collapsed]));
  const entries = async pid => (await get(`/api/p/${pid}/history`)).history.length;
  // The collapsed state became as in want.
  const foldsAre = (pid, want) => until(async () => isDeepStrictEqual(await folds(pid, Object.keys(want)), want));
  // The agent shows a block (mycel show) and says what it is doing now (mycel doing).
  const show = async (pid, id) => { const res = await post(`/api/p/${pid}/show`, { id, actor: 'claude' }); assert.equal(res.status, 200, res.body.error); };
  const doing = async (pid, text, progress = null) => { const res = await post(`/api/p/${pid}/activity`, { actor: 'claude', text, progress }); assert.equal(res.status, 200, res.body.error); };
  return { url: app.url, get, post, project, agent, node, folds, foldsAre, entries, show, doing };
}

async function browser(t, language = 'en-US') {
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
  // Chrome picks the DevTools port itself and writes it to the profile: the first line is the port, the second the browser path.
  let active = '';
  await until(async () => (active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).includes('\n'), 20000);
  const [port, path] = active.split('\n').map(s => s.trim());
  ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('No connection to Chrome')); });
  ws.onmessage = e => { const m = JSON.parse(e.data), w = m.id && waiting.get(m.id); if (!w) return; waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); };
  let target = null;
  await until(async () => (target = (await send('Target.getTargets')).targetInfos.find(x => x.type === 'page')), 10000);
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call('Page.enable');
  // The interface language follows the browser's: Chrome may report the system's, so the tests set it (English by default).
  const { userAgent } = await send('Browser.getVersion');
  await call('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: language });
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  // modifiers are the held keys, as in DevTools: Alt = 1, Ctrl = 2, Meta = 4, Shift = 8.
  const mouse = (type, { x, y }, { button = 'left', clickCount = 1, modifiers = 0 } = {}) => call('Input.dispatchMouseEvent', { type, x, y, modifiers, button: type === 'mouseMoved' ? 'none' : button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount });
  const center = async q => {
    const r = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(q)})?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    assert.ok(r, `No element ${q}`); return r;
  };
  const at = q => typeof q === 'string' ? center(q) : q;
  // A press on an element or a screen point; the release happens at the same point when it is called.
  const press = async q => { const p = await at(q); await mouse('mouseMoved', p); await mouse('mousePressed', p); return () => mouse('mouseReleased', p); };
  return {
    evaluate, press,
    goto: url => call('Page.navigate', { url }),
    reload: () => call('Page.reload'),
    // Typing text into the field with the cursor, as from a keyboard.
    type: text => call('Input.insertText', { text }),
    click: async q => (await press(q))(),
    // A double click on an element or a screen point: the second press with clickCount = 2, as with a real mouse.
    dblclick: async q => { const p = await at(q); await mouse('mouseMoved', p); for (const clickCount of [1, 2]) { await mouse('mousePressed', p, { clickCount }); await mouse('mouseReleased', p, { clickCount }); } },
    rightClick: async q => { const p = await at(q); await mouse('mouseMoved', p); await mouse('mousePressed', p, { button: 'right' }); await mouse('mouseReleased', p, { button: 'right' }); },
    // Dragging with the button held through one point or several in order; during is called while the button is still pressed.
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
    // Window size and media features, for example prefers-reduced-motion.
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
  // An agent write changes only its project's row: the other rows stay the same elements.
  await b.evaluate(`${row(alpha.id)}.closest('li').kept = true`);
  await h.agent(beta.id, [add('b1')]);
  await b.until(`${row(beta.id)}.querySelector('.p-meta').textContent.startsWith('1 block ')`);
  assert.equal(await b.evaluate(`${row(alpha.id)}.closest('li').kept`), true);
  // The trash button is pressed, the agent writes, the release still deletes the project; the held-back update is drawn.
  let release = await b.press(`[data-trash="${gamma.id}"]`);
  await h.agent(beta.id, [add('b2')]);
  await sleep(500);
  await release();
  await until(async () => !(await h.get('/api/projects')).projects.some(p => p.id === gamma.id));
  await b.until(`!${row(gamma.id)} && ${row(beta.id)}.querySelector('.p-meta').textContent.startsWith('2 blocks ')`);
  // A pressed project row opens it.
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
  assert.doesNotMatch(await b.evaluate(`document.querySelector('#viewport').innerText`), /right-click/i);
  await h.agent(p.id, [add('box', { w: 400, h: 300, collapsed: true }), add('inner', { parentId: 'box', x: 10, y: 10 }), add('x1', { x: 0, y: 400 })]);
  await b.until(`Boolean(document.querySelector('.block[data-id="box"] > .fold')) && !document.querySelector('#world.glide')`);
  // The chevron is pressed, the agent adds a block; the release expands the sub-map, the agent's block appears after the write.
  let release = await b.press('.block[data-id="box"] > .fold');
  await h.agent(p.id, [add('y1', { x: 600, y: 0 })]);
  await sleep(400);
  await release();
  await until(async () => (await h.node(p.id, 'box')).collapsed === false);
  await b.until(`Boolean(document.querySelector('.block[data-id="y1"]'))`);
  // The colour of the selected block from the panel above it, the same way.
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
  // The answer to the person's write is delayed by 600 ms; the agent writes while it is running.
  await b.evaluate(`(() => { const f = window.fetch; window.fetch = async (u, o) => { const res = await f(u, o); if (o?.method === 'POST' && String(u).endsWith('/changes')) await new Promise(r => setTimeout(r, 600)); return res; }; })()`);
  await b.click('.swatch.c-red');
  await sleep(150);
  const { revision } = await h.agent(p.id, [add('b', { x: 400, y: 0 })]);
  await b.until(`Boolean(document.querySelector('.block[data-id="b"]')) && window.mycel.state.graph.revision === ${revision}`, 3000);
  assert.equal((await h.node(p.id, 'a')).color, 'red');
});

// Diving by double-click and levels. The map has settled: level moves and writes are finished, the view is not
// moving. The focus is set at the start of a move, before the write and redraw, so waiting for it alone is not enough.
const settled = `(window.mycel.state.walking === 0 && window.mycel.state.busy === 0 && !document.querySelector('#world.glide'))`;
const focused = id => `window.mycel.state.focus === ${JSON.stringify(id)}`;
const folded = id => `Boolean(document.querySelector('.block[data-id="${id}"]')?.classList.contains('collapsed'))`;
const path = `[...document.querySelectorAll('#focus-bar .focus-path > *')].map(e => e.textContent).join(' ')`;
// The level the slider shows ('' means none fits the map), its name and the slider tick.
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
  // The view moves smoothly: #world gets the glide class.
  await b.evaluate(`(() => { const w = document.querySelector('#world'); window.glided = false; new MutationObserver(() => { if (w.classList.contains('glide')) window.glided = true; }).observe(w, { attributes: true }); })()`);
  const rev0 = (await h.get(`/api/p/${p.id}/graph`)).revision, before = await h.entries(p.id);

  // A double click on a container: focus on it, it is expanded, the sub-maps of its blocks collapsed; one entry, not a content edit.
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  assert.deepEqual(await h.folds(p.id, ids), { A: false, M1: true, T1: false });
  assert.equal(await h.entries(p.id), before + 1);
  const quiet = await h.get(`/api/p/${p.id}/changes?since=${rev0}&content=1`);
  assert.equal(quiet.complete, true); assert.equal(quiet.contentChanged, false);
  await until(async () => await humanFocus(h, p.id) === 'A');
  assert.equal(await b.evaluate('window.mycel.state.editing'), null);
  assert.equal(await b.evaluate('window.glided'), true);
  assert.equal(await b.evaluate(path), 'Map › A');
  assert.equal(await b.evaluate(`document.querySelector('.block[data-id="B"]').classList.contains('out-focus')`), true);
  assert.equal(await b.evaluate(`(() => { const v = document.querySelector('#viewport').getBoundingClientRect(), r = document.querySelector('.block[data-id="A"]').getBoundingClientRect();
    return r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom; })()`), true);

  // The agent adds a block inside the open block: it appears.
  await h.agent(p.id, [add('M3', { parentId: 'A', x: 10, y: 360 })]);
  await b.until(`(() => { const el = document.querySelector('.block[data-id="M3"]'); return Boolean(el) && !el.classList.contains('out-focus'); })() && ${focused('A')} && ${settled}`);

  // Deeper: the path grows.
  await b.dblclick('.block[data-id="M1"] > .head');
  await b.until(`${focused('M1')} && !${folded('M1')} && ${folded('T1')} && ${settled}`);
  assert.deepEqual(await h.folds(p.id, ids), { A: false, M1: false, T1: true });
  assert.equal(await b.evaluate(path), 'Map › A › M1');
  assert.equal(await h.entries(p.id), before + 3);

  // Esc goes one level up; from a top block to the whole map, and the collapsing returns to what it was before the dive.
  await b.key('Escape');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  assert.equal(await b.evaluate(path), 'Map › A');
  await b.key('Escape');
  await b.until(`${focused(null)} && document.querySelector('#focus-bar').hidden && !${folded('M1')} && ${settled}`);
  assert.deepEqual(await h.folds(p.id, ids), { A: false, M1: false, T1: false });
  // Dives and returns in a row merge into one history entry.
  assert.equal(await h.entries(p.id), before + 3);
  assert.equal(await b.evaluate(`document.querySelectorAll('.block.out-focus').length`), 0);
  await until(async () => await humanFocus(h, p.id) === null);

  // Leaving the project clears the focus and restores the collapsing, as leaving the dive does.
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
  // The interface's first write waits until the agent has written its own: it goes out with the old revision and gets 409.
  const holdNext = () => b.evaluate(`(() => { const f = window.fetch; window.held = false; window.fetch = async (u, o) => {
    if (o?.method === 'POST' && String(u).endsWith('/changes')) { window.fetch = f; window.held = true; await new Promise(r => window.release = r); }
    return f(u, o); }; })()`);
  // A dive into A while the agent adds an expanded sub-map M3 to A: after 409 it collapses too.
  await holdNext();
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until('window.held === true');
  await h.agent(p.id, [add('M3', { parentId: 'A', x: 10, y: 300, w: 300, h: 200 }), add('K3', { parentId: 'M3', x: 10, y: 10 })]);
  await b.evaluate('window.release()');
  await h.foldsAre(p.id, { A: false, M1: true, M3: true });
  await b.until(`${focused('A')} && ${settled}`);
  // Leaving while the agent deletes M1: the collapsing of the rest is restored, there is no error.
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
    add('T1', { parentId: 'M1', x: 10, y: 10 }), { type: 'add-node', node: { id: 'N', type: 'note', parentId: 'A', attachedTo: 'M2', text: 'note', x: 400, y: 200 } }]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="A"]')) && ${settled}`);
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  assert.equal(await b.evaluate('window.mycel.state.editing'), null);

  // A block without a sub-map and a note are edited; Esc in the field only finishes the edit.
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

  // A double click on empty space goes one level up, from a top block to the whole map.
  await b.dblclick('.block[data-id="M1"] > .head');
  await b.until(`${focused('M1')} && ${settled}`);
  await b.dblclick(await b.evaluate(corner));
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  await b.dblclick(await b.evaluate(corner));
  await b.until(`${focused(null)} && document.querySelector('#focus-bar').hidden && ${settled}`);

  // Path segments go straight to their level.
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${settled}`);
  await b.dblclick('.block[data-id="M1"] > .head');
  await b.until(`${focused('M1')} && ${settled}`);
  await b.click('#focus-bar [data-focus-on="A"]');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);
  await b.click('#focus-bar .focus-path [data-action="unfocus"]');
  await b.until(`${focused(null)} && document.querySelector('#focus-bar').hidden && ${settled}`);

  // A container's title and text are edited with Enter.
  await b.click('.block[data-id="A"] > .head');
  await b.until(`window.mycel.state.selected?.id === 'A'`);
  await b.key('Enter');
  await b.until(`window.mycel.state.editing === 'A' && ${focused(null)}`);
});

test('"Open" in the context menu dives into a leaf block, where "Block inside" starts the next level; "Edit" edits a container', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('L'), add('Z', { x: 500, y: 0 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="L"]')) && ${settled}`);
  await b.rightClick('.block[data-id="L"]');
  await b.until(`document.querySelector('#menu [data-menu="open"]')?.textContent === 'Open' && !document.querySelector('#menu').hidden`);
  await b.click('#menu [data-menu="open"]');
  await b.until(`${focused('L')} && ${settled}`);
  assert.equal(await b.evaluate(`document.querySelector('.block[data-id="Z"]').classList.contains('out-focus')`), true);
  await until(async () => await humanFocus(h, p.id) === 'L');
  await b.click('#focus-bar [data-focus-act="block"]');
  await b.until(`Boolean(document.querySelector('.block[data-id="L"] > .sub .b-title-input'))`);
  await b.evaluate(`(() => { const input = document.querySelector('.block[data-id="L"] > .sub .b-title-input'); input.value = 'Step'; input.blur(); })()`);
  await until(async () => (await h.get(`/api/p/${p.id}/graph`)).nodes.some(n => n.parentId === 'L' && n.title === 'Step'));
  await b.until(`document.querySelector('.block[data-id="L"] > .sub > .sub-level')?.textContent === 'Mechanics'`);
  // A container is edited from the menu. Esc first clears the selection of the new block: its panel lies over the header.
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
  // Instead of buttons, a slider with four ticks; next to it one word, the name of the chosen level.
  assert.deepEqual(await b.evaluate(`(() => { const s = document.querySelector('#level'); return [s.type, s.min, s.max, document.querySelectorAll('#levels .level-track i').length,document.querySelectorAll('#levels button').length]; })()`), ['range', '1', '4', 4, 0]);
  await b.until(`${active} === '4' && ${levelName} === 'Code' && document.querySelector('#level').value === '4'`);
  assert.deepEqual(await b.evaluate(`['A', 'M', 'T'].map(id => document.querySelector('.block[data-id="' + id + '"] > .sub > .sub-level').textContent)`), ['Mechanics', 'Technical', 'Code']);
  // A click on a tick, as with a real mouse; level switches in a row are one history entry.
  const count = await h.entries(p.id), names = ['Concept', 'Mechanics', 'Technical', 'Code'];
  for (const [level, want] of [[3, { A: false, M: false, T: true }], [1, { A: true, M: true, T: true }], [4, { A: false, M: false, T: false }], [2, { A: false, M: true, T: true }]]) {
    await b.click(tick(level));
    await until(async () => JSON.stringify(await h.folds(p.id, ids)) === JSON.stringify(want));
    await b.until(`${active} === '${level}' && ${levelName} === '${names[level - 1]}' && ${settled}`);
    assert.equal(await h.entries(p.id), count + 1);
  }
  // Arrows on the slider step through the levels.
  await b.evaluate(`document.querySelector('#level').focus()`);
  await b.key('ArrowRight');
  await h.foldsAre(p.id, { A: false, M: false, T: true });
  await b.until(`${active} === '3' && ${settled}`);
  await b.key('ArrowLeft');
  await h.foldsAre(p.id, { A: false, M: true, T: true });
  await b.until(`${active} === '2' && ${settled}`);
  await b.evaluate(`document.querySelector('#level').blur()`);
  // In a dive the active level is the one visible inside the open block.
  await b.dblclick('.block[data-id="M"] > .head');
  await b.until(`${focused('M')} && ${folded('T')} && ${settled}`);
  await b.until(`${active} === '3'`);
  // Esc with a selected block only clears the selection.
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
  // Without sub-maps there is nothing to apply levels to: the slider is disabled.
  await b.until(`document.querySelector('#level')?.disabled === true`);
  await h.agent(p.id, [add('A', { w: 500, h: 300 }), add('M', { parentId: 'A', x: 10, y: 10 }), add('B', { x: 900, y: 0, w: 500, h: 300 }), add('N', { parentId: 'B', x: 10, y: 10 })]);
  await b.until(`Boolean(document.querySelector('.block[data-id="N"]')) && document.querySelector('#level').disabled === false && ${active} === '2' && ${settled}`);
  // Dragging from "Mechanics" to "Concept": while the button is held, only the name changes, not the map or the history.
  const count = await h.entries(p.id);
  await b.drag(tick(2), tick(1), async () => {
    await b.until(`${levelName} === 'Concept' && document.querySelector('#level').value === '1'`);
    await sleep(300);
    assert.deepEqual(await h.folds(p.id, ['A', 'B']), { A: false, B: false });
    assert.equal(await h.entries(p.id), count);
    // The agent adds an expanded sub-map while the slider is held: the thumb does not jump, and the release collapses it too.
    await h.agent(p.id, [add('C', { x: 1800, y: 0, w: 500, h: 300 }), add('K', { parentId: 'C', x: 10, y: 10 })]);
    await sleep(300);
    assert.equal(await b.evaluate(`document.querySelector('#level').value`), '1');
  });
  await h.foldsAre(p.id, { A: true, B: true, C: true });
  await b.until(`${active} === '1' && ${settled}`);
  // The chevron expands only A: no level fits the map, so the thumb is dim, without a name, and stands at the level
  // the map is visible down to. A screen reader does not hear a level name either.
  const mixed = `(${active} === '' && document.querySelector('#levels').classList.contains('mixed') && ${levelName} === '' && document.querySelector('#level').value === '2')`;
  const aligned = `(${active} === '2' && !document.querySelector('#levels').classList.contains('mixed') && ${levelName} === 'Mechanics')`;
  await b.click('.block[data-id="A"] .fold');
  await h.foldsAre(p.id, { A: false, B: true, C: true });
  await b.until(`${mixed} && ${settled}`);
  assert.equal(await b.evaluate(`document.querySelector('#level').getAttribute('aria-valuetext')`), 'Sub-maps collapsed unevenly');
  // A right click on the slider and a press that started elsewhere do not apply a level.
  await b.rightClick(tick(2));
  await b.drag('.dock-bar > .grow', tick(2));
  await sleep(300);
  assert.deepEqual(await h.folds(p.id, ['A', 'B', 'C']), { A: false, B: true, C: true });
  assert.equal(await b.evaluate(`${mixed} && ${settled}`), true);
  // This drag selected the bar's text together with the slider: the next press would drag the selection.
  await b.evaluate(`getSelection().removeAllRanges()`);
  // The thumb was moved away and back to the same tick: the level it showed is applied.
  await b.drag(tick(2), [tick(3), tick(2)]);
  await h.foldsAre(p.id, { A: false, B: false, C: false });
  await b.until(`${aligned} && ${settled}`);
  // A click on the same tick (the value does not change) also aligns the map with the level.
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
  // Each write takes 150 ms longer: the next steps arrive while the previous one is still saving.
  await b.evaluate(`(() => { const f = window.fetch; window.fetch = async (u, o) => { const res = await f(u, o); if (o?.method === 'POST' && String(u).endsWith('/changes')) await new Promise(r => setTimeout(r, 150)); return res; }; })()`);
  const at = (level, want) => `(${active} === '${level}' && document.querySelector('#level').value === '${level}' && ${levelName} === '${want}' && ${settled})`;
  // Three arrows in a row, from "Code" to "Concept".
  await b.evaluate(`document.querySelector('#level').focus()`);
  for (let i = 0; i < 3; i++) { await b.key('ArrowLeft'); await sleep(40); }
  await h.foldsAre(p.id, { A: true, M: true, T: true });
  await b.until(at(1, 'Concept'));
  // Two clicks in a row: the second one is applied.
  await b.click(tick(4)); await sleep(30); await b.click(tick(2));
  await h.foldsAre(p.id, { A: false, M: true, T: true });
  await b.until(at(2, 'Mechanics'));
  await sleep(300);
  assert.deepEqual(await h.folds(p.id, ['A', 'M', 'T']), { A: false, M: true, T: true });

  // After a click on the slider the focus is on it, and Enter and Delete act on the selected block as before the click.
  await b.click('.block[data-id="P"]');
  await b.until(`window.mycel.state.selected?.id === 'P'`);
  await b.click(tick(3));
  await h.foldsAre(p.id, { A: false, M: false, T: true });
  await b.until(`${at(3, 'Technical')} && document.activeElement?.id === 'level' && window.mycel.state.selected?.id === 'P'`);
  await b.key('Enter');
  await b.until(`window.mycel.state.editing === 'P'`);
  await b.key('Escape');
  await b.until(`window.mycel.state.editing === null && ${settled}`);
  await b.click('.block[data-id="P"]');
  await b.click(tick(2));
  await b.until(`${at(2, 'Mechanics')} && document.activeElement?.id === 'level' && window.mycel.state.selected?.id === 'P'`);
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
  // The thumb is dragged over all ticks: the name changes, but the width of the slider with its name does not, otherwise
  // in a narrow bar it would jump between lines right under the pointer.
  const widths = await b.evaluate(`[1, 2, 3, 4].map(v => { const s = document.querySelector('#level'); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true }));
    return [document.querySelector('#level-name').textContent, document.querySelector('#levels').getBoundingClientRect().width]; })`);
  assert.deepEqual(widths.map(([name]) => name), ['Concept', 'Mechanics', 'Technical', 'Code']);
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
  // A title edit; a click on the block's own area takes the cursor out of the input, and the edit stays open.
  const edit = async (id, text) => {
    await b.dblclick(`.block[data-id="${id}"] > .b-title`);
    await b.until(`window.mycel.state.editing === '${id}' && document.activeElement?.matches('.block[data-id="${id}"] .b-title-input')`);
    await b.type(text);
    await b.click(await b.evaluate(`(() => { const r = document.querySelector('.block[data-id="${id}"]').getBoundingClientRect(); return { x: r.left + 4, y: r.top + 4 }; })()`));
    await b.until(`window.mycel.state.editing === '${id}' && document.activeElement === document.querySelector('.block[data-id="${id}"]')`);
  };
  await edit('T1', 'New name');
  // Esc first finishes the edit, then clears the selection; up only when there is neither.
  await b.key('Escape');
  await b.until(`window.mycel.state.editing === null && ${settled}`);
  await until(async () => (await h.node(p.id, 'T1')).title === 'New name');
  assert.equal(await b.evaluate(`${focused('M1')} && window.mycel.state.selected?.id === 'T1'`), true);
  await b.key('Escape');
  await b.until(`window.mycel.state.selected === null`);
  await sleep(300);
  assert.equal(await b.evaluate(focused('M1')), true);
  await b.key('Escape');
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled}`);

  // A double click on empty space with an edit open: the edit is saved, then one level up.
  await intoM1();
  await edit('T2', 'Second');
  await b.dblclick(await b.evaluate(corner));
  await b.until(`${focused('A')} && ${folded('M1')} && ${settled} && window.mycel.state.editing === null`);
  await until(async () => (await h.node(p.id, 'T2')).title === 'Second');
  // The live update has not frozen: the agent's block appears.
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

  // Back to the projects and back again: the map is as before the dive, and its level is lit.
  await diveA();
  await b.evaluate(`location.hash = '#/'`);
  await b.until(`document.querySelectorAll('.p-row').length === 1`);
  assert.deepEqual(await h.folds(p.id, Object.keys(open)), open);
  await until(async () => await humanFocus(h, p.id) === null);
  await b.evaluate(`location.hash = '#/p/${p.id}'`);
  await opened();
  assert.equal(await b.evaluate(active), '3');

  // A reload in a dive: leaving goes out as requests when the page closes.
  await diveA();
  assert.notEqual(await b.evaluate(`sessionStorage.getItem(${key})`), null);
  await b.evaluate(`sessionStorage.removeItem(${key})`);
  await b.reload();
  await opened();
  await h.foldsAre(p.id, open);
  await until(async () => await humanFocus(h, p.id) === null);
  assert.equal(await b.evaluate(`${focused(null)} && document.querySelector('#focus-bar').hidden && !document.querySelector('.block.out-focus')`), true);

  // The requests on close did not get through: the reloaded page restores the collapsing.
  await diveA();
  await b.evaluate(`(() => { const f = window.fetch; window.fetch = (u, o) => o?.keepalive ? Promise.resolve(new Response('{}')) : f(u, o); })()`);
  await b.reload();
  await opened();
  await h.foldsAre(p.id, open);
  await until(async () => await humanFocus(h, p.id) === null);
  assert.equal(await b.evaluate(`sessionStorage.getItem(${key})`), null);
});

test('a level chosen inside a dive keeps the opened block open, shows the chosen level and is undone on exit; a deep dive shows "Code"', { skip }, async t => {
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

  // "Concept" in a dive into A collapses only what is inside A, A itself stays open; leaving through "Map" restores everything.
  await into('A', 'M');
  await b.until(`${active} === '2'`);
  await b.click(tick(1));
  await h.foldsAre(p.id, { A: false, M: true, T: true, K: true });
  await b.until(`${active} === '1' && !${folded('A')} && ${settled}`);
  await b.click('#focus-bar .focus-path [data-action="unfocus"]');
  await b.until(`${focused(null)} && ${settled}`);
  await h.foldsAre(p.id, open);
  await b.until(`${active} === '4'`);

  // "Mechanics" in a dive into M: M itself stays open, the slider shows the chosen level.
  await into('A', 'M');
  await into('M', 'T');
  await b.until(`${active} === '3'`);
  await b.click(tick(2));
  await h.foldsAre(p.id, { A: false, M: false, T: true, K: true });
  await b.until(`${active} === '2' && !${folded('M')} && ${settled}`);

  // Deeper, into T: inside it is the step K with its own sub-map, collapsed by the dive, so "Code" is lit.
  await into('T', 'K');
  await b.until(`${active} === '4'`);

  // Up to the whole map: the collapsing from the dive is restored.
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
  // The block is visible and stands in the centre of the map.
  const centred = id => `(() => { const el = document.querySelector('.block[data-id="${id}"]'), v = document.querySelector('#viewport').getBoundingClientRect(), r = el.getBoundingClientRect();
    return getComputedStyle(el).visibility === 'visible' && Math.abs(r.left + r.width / 2 - v.left - v.width / 2) < 2 && Math.abs(r.top + r.height / 2 - v.top - v.height / 2) < 2; })()`;
  assert.deepEqual(await b.evaluate(`[Boolean(document.querySelector('#chat, #chat-input')), document.querySelector('#viewport').getBoundingClientRect().left]`), [false, 0]);

  // What the agent is doing now is a line above the control bar, its dot is in the bar; a cleared line disappears.
  await h.doing(p.id, 'reading `cart.ts`', 40);
  await b.until(`!document.querySelector('#progress-row').hidden && document.querySelector('.progress-label').textContent === 'claude reading \`cart.ts\`' && Boolean(document.querySelector('#agents .dot'))`);
  assert.equal(await b.evaluate(`document.querySelector('.progress-value').textContent`), '40%');
  await h.doing(p.id, null);
  await b.until(`document.querySelector('#progress-row').hidden`);

  // A main-map block: the dive closes.
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${settled}`);
  await h.show(p.id, 'B');
  await b.until(`${focused(null)} && window.mycel.state.selected?.id === 'B' && ${settled}`);
  assert.equal(await b.evaluate(centred('B')), true);
  // The hub knows what the person selected: "this" makes sense to the agent.
  await until(async () => (await h.get(`/api/p/${p.id}/selection`)).selection === 'B');

  // A block inside another module: the block it lies in opens.
  await b.click('.zoom-bar [data-action="fit"]');
  await b.until(settled);
  await b.dblclick('.block[data-id="A"] > .head');
  await b.until(`${focused('A')} && ${settled}`);
  await h.show(p.id, 'C2');
  await b.until(`${focused('C1')} && window.mycel.state.selected?.id === 'C2' && ${settled}`);
  assert.equal(await b.evaluate(path), 'Map › C › C1');
  assert.equal(await b.evaluate(centred('C2')), true);
  await until(async () => (await h.get(`/api/p/${p.id}/selection`)).selection === 'C2');
});

test('an agent proposal is highlighted and dashed with "Reject" and "Accept" at the bottom; marks colour blocks; a new human block is a plan', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('k', { title: 'Cart', w: 520, h: 320 }), add('s', { parentId: 'k', title: 'Total', x: 10, y: 10 }), add('d', { parentId: 'k', title: 'Delivery', x: 260, y: 10 }), add('o', { title: 'Payment', x: 700, y: 0 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="s"]')) && ${settled}`);
  const cls = id => `[...document.querySelector('.block[data-id="${id}"]').classList].filter(c => /^(st-|pr-|failed)/.test(c)).join(' ')`;
  const offer = async (title, operations) => { const { revision } = await h.get(`/api/p/${p.id}/graph`); const res = await h.post(`/api/p/${p.id}/proposal`, { expectedRevision: revision, actor: 'claude', title, operations }); assert.equal(res.status, 200, res.body.error); };
  await offer('Promo codes', [add('promo', { parentId: 'k', title: 'Promo code', x: 10, y: 160 }), { type: 'update-node', id: 's', patch: { text: 'with a discount' } }, { type: 'delete-node', id: 'd' }]);
  await b.until(`Boolean(document.querySelector('.block[data-id="promo"]')) && document.querySelector('#edits .edits-title')?.textContent === 'Proposal "Promo codes"'`);
  assert.deepEqual(await b.evaluate(`[${['promo', 's', 'd', 'o'].map(cls).join(', ')}]`), ['st-plan pr-add', 'pr-change', 'pr-remove', '']);
  assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.block[data-id="promo"]')).borderTopStyle`), 'dashed');
  assert.equal(await b.evaluate(`document.querySelector('#edits .edits-count').textContent`), '3');
  // "Reject": the proposed things go away, changed things come back; a short message confirms the decision.
  await b.click('#edits [data-action="proposal-reject"]');
  await b.until(`!document.querySelector('.block[data-id="promo"]') && document.querySelector('#edits').hidden && document.querySelector('#toast')?.textContent.includes('Proposal rejected')`);
  assert.deepEqual(await b.evaluate(`[${['s', 'd'].map(cls).join(', ')}]`), ['', '']);
  assert.equal((await h.node(p.id, 's')).text, '');
  // "Accept": new things stay as a plan, things marked for deletion are deleted.
  await offer('Promo codes', [add('promo', { parentId: 'k', title: 'Promo code', x: 10, y: 160 }), { type: 'delete-node', id: 'd' }]);
  await b.until(`Boolean(document.querySelector('.block[data-id="promo"]')) && !document.querySelector('#edits').hidden`);
  await b.click('#edits [data-action="proposal-accept"]');
  await b.until(`document.querySelector('#edits').hidden && !document.querySelector('.block[data-id="d"]')`);
  assert.equal(await b.evaluate(cls('promo')), 'st-plan');
  // A check failed inside a sub-map: the sub-map is red; passed: the block is green.
  await h.agent(p.id, [{ type: 'update-node', id: 's', patch: { status: 'failed' } }, { type: 'update-node', id: 'o', patch: { status: 'passed' } }]);
  await b.until(`${cls('s')} === 'st-failed' && ${cls('k')} === 'failed-inside' && ${cls('o')} === 'st-passed'`);
  // A mark is only the border, without a fill. A change over SSE flashes; a running check shows on the sub-map around it too.
  assert.deepEqual(await b.evaluate(`(() => { const s = getComputedStyle(document.querySelector('.block[data-id="o"]')); return [s.boxShadow.includes('inset'), s.backgroundImage]; })()`), [false, 'none']);
  await h.agent(p.id, [{ type: 'update-node', id: 's', patch: { status: 'testing' } }]);
  await b.until(`${cls('s')} === 'st-testing' && document.querySelector('.block[data-id="s"]').classList.contains('remark') && document.querySelector('.block[data-id="k"]').classList.contains('testing-inside')`);
  assert.notEqual(await b.evaluate(`getComputedStyle(document.querySelector('.block[data-id="s"]')).animationName`), 'none');
  // A block created by the person is a plan.
  await b.rightClick({ x: 1100, y: 700 });
  await b.until(`Boolean(document.querySelector('#menu [data-menu="new-block"]')) && !document.querySelector('#menu').hidden`);
  await b.click('#menu [data-menu="new-block"]');
  await b.until(`document.activeElement?.classList.contains('b-title-input')`);
  await b.type('Returns');
  await b.key('Escape');
  await until(async () => (await h.get(`/api/p/${p.id}/graph`)).nodes.some(n => n.title === 'Returns' && n.status === 'plan'));
});

test('the pencil in the corner of a block shows on hover and opens the edit at once, also for a container, without moving or diving', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('a', { title: 'Catalogue' }), add('c', { title: 'Cart', x: 400, y: 0, w: 400, h: 300 }), add('c1', { parentId: 'c', x: 10, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="c1"]')) && ${settled}`);
  const shown = id => `getComputedStyle(document.querySelector('.block[data-id="${id}"] > .pen')).opacity === '1'`;
  assert.equal(await b.evaluate(shown('a')), false);
  await b.click('.zoom-bar [data-action="fit"]');
  await b.until(settled);
  // Hover shows the pencil only on the block under the pointer; a press opens the title edit, the block does not move.
  const release = await b.press('.block[data-id="a"] .b-text');
  await release();
  await b.until(`${shown('a')} && !(${shown('c')})`);
  const before = await h.node(p.id, 'a');
  await b.click('.block[data-id="a"] > .pen');
  await b.until(`document.activeElement?.classList.contains('b-title-input') && document.activeElement.closest('.block').dataset.id === 'a'`);
  await b.type('Product catalogue');
  await b.key('Escape');
  await until(async () => (await h.node(p.id, 'a')).title === 'Product catalogue');
  const after = await h.node(p.id, 'a');
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
  // On a block with a sub-map the pencil is left of the chevron and edits the header instead of diving.
  const pen = await b.evaluate(`(() => { const p = document.querySelector('.block[data-id="c"] > .pen').getBoundingClientRect(), f = document.querySelector('.block[data-id="c"] > .fold').getBoundingClientRect(); return p.right <= f.left; })()`);
  assert.equal(pen, true);
  await b.click('.block[data-id="c"] > .pen');
  await b.until(`document.activeElement?.classList.contains('b-title-input') && document.activeElement.closest('.block').dataset.id === 'c'`);
  assert.equal(await b.evaluate(focused(null)), true);
  await b.type('Shopping cart');
  await b.key('Escape');
  await until(async () => (await h.node(p.id, 'c')).title === 'Shopping cart');
});

test('a human edit shows "Finish edits" at the bottom middle of the map; it hands the edits to the agent as one event', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('a'), add('c', { x: 400, y: 0, w: 400, h: 300 }), add('c1', { parentId: 'c', x: 10, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="a"]')) && ${settled}`);
  // A level change does not start edits, a title edit does.
  await b.evaluate(`(() => { const s = document.querySelector('#level'); s.value = 1; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(async () => (await h.node(p.id, 'c')).collapsed === true);
  await b.until(settled);
  assert.equal(await b.evaluate(`document.querySelector('#edits').hidden`), true);
  await b.dblclick('.block[data-id="a"] .b-title');
  await b.until(`Boolean(document.querySelector('.block[data-id="a"] .b-title-input'))`);
  await b.type(' and more');
  await b.key('Escape');
  await b.until(`!document.querySelector('#edits').hidden && document.querySelector('.edits-count').textContent === '1'`);
  const place = await b.evaluate(`(() => { const e = document.querySelector('#edits').getBoundingClientRect(), v = document.querySelector('#viewport').getBoundingClientRect();
    return [Math.abs(e.left + e.width / 2 - v.left - v.width / 2) < 2, v.bottom - e.bottom > 0 && v.bottom - e.bottom < 40]; })()`);
  assert.deepEqual(place, [true, true]);
  // The button hands the edits over as one event and briefly confirms it.
  await b.click('#edits .btn');
  await b.until(`document.querySelector('#edits').hidden && document.querySelector('#toast')?.textContent.includes('Edits sent to the agent')`);
  const { messages } = await h.get(`/api/p/${p.id}/chat`);
  assert.deepEqual(messages.map(m => [m.kind, m.edits?.count]), [['edits', 1]]);
});

// Code through Mycel's eyes: the agent's name over a block whose files it edits, "outdated?", "Health" mode walking to
// blocks, "Check" in the menu of a block with a check command, and the "What changed" summary in History.
test('an agent editing files shows over its block, a stale block says so, "Health" walks to issues, "Check" asks the agent, history tells what changed', { skip }, async t => {
  const h = await hub(t), b = await browser(t);
  const p = await h.project('alpha');
  await h.agent(p.id, [add('K', { title: 'Core', w: 520, h: 320 }), add('S', { parentId: 'K', title: 'Server', x: 10, y: 10, files: ['lib/'], test: 'npm test' }),
    add('U', { title: 'Interface', x: 700, y: 0, files: ['ui.js'] }), add('F', { title: 'Payment', x: 700, y: 300, status: 'failed' })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="S"]')) && ${settled}`);
  assert.equal(await b.evaluate(`document.querySelector('.block[data-id="S"] .b-title').title`), 'Files: lib/\nCheck: npm test');
  assert.equal((await h.post(`/api/p/${p.id}/touch`, { actor: 'claude', files: ['lib/a.js'], session: 's1' })).status, 200);
  await b.until(`document.querySelector('.block[data-id="S"] > .code-row > .who')?.textContent === 'claude' && Boolean(document.querySelector('.block[data-id="S"] > .code-row > .stale-tag'))`);
  assert.equal(await b.evaluate(`document.querySelectorAll('.who').length`), 1);
  // "Health": what is wrong and how many; healthy blocks fade, a press leads to the block.
  await b.click('#health-toggle');
  await b.until(`document.querySelector('#viewport').classList.contains('health') && document.querySelector('#health')?.textContent === 'Failed 1Outdated 1Unchecked 1'`);
  assert.deepEqual(await b.evaluate(`['S', 'U', 'F', 'K'].map(id => document.querySelector('.block[data-id="' + id + '"] > .health-tag')?.textContent ?? null)`), ['outdated?', 'unchecked', 'failed', null]);
  await b.click('#health [data-health="failed"]');
  await b.until(`window.mycel.state.selected?.id === 'F' && ${settled}`);
  await b.click('#health-toggle');
  await b.until(`!document.querySelector('#health') && !document.querySelector('#viewport').classList.contains('health')`);
  // "Check" is only on a block with a check command (or one inside it); the request goes to the agent as an event.
  await b.rightClick('.block[data-id="U"] .b-title');
  await b.until(`!document.querySelector('#menu').hidden`);
  assert.equal(await b.evaluate(`Boolean(document.querySelector('#menu [data-menu="check"]'))`), false);
  await b.key('Escape');
  await b.rightClick('.block[data-id="K"] > .head');
  await b.until(`Boolean(document.querySelector('#menu [data-menu="check"]')) && !document.querySelector('#menu').hidden`);
  await b.click('#menu [data-menu="check"]');
  await until(async () => (await h.get(`/api/p/${p.id}/chat`)).messages.at(-1)?.check?.ids?.[0] === 'K');
  // History: what changed, by concept.
  await b.click('.tabs [data-tab="history"]');
  await b.until(`document.querySelector('.review') && [...document.querySelectorAll('.review h3')].map(e => e.textContent).join() === '"Core","Interface","Payment"'`);
  assert.match(await b.evaluate(`document.querySelector('.review').textContent`), /added block "Server".*Failed: "Payment"\./s);
  await b.click('.review [data-review-hours="1"]');
  await b.until(`document.querySelector('.review [data-review-hours="1"]')?.classList.contains('active')`);
});

// A virtual machine's access request: a card with its code on any page of the main computer, the person picks the project;
// "Allow" gives a key, "Disconnect" on home revokes it, "Deny" on a project page refuses.
test('a virtual machine access request shows a card with its code on any page; "Allow" grants it, "Disconnect" revokes it', { skip }, async t => {
  const data = await temp('mycel-ui-pair-'), folders = await temp('mycel-ui-pair-folders-'), app = await startServer({ data, port: 0, listen: ['127.0.0.2'] });
  t.after(async () => { await app.close(); await clean(data, folders); });
  const far = `http://127.0.0.2:${new URL(app.url).port}`, token = (await readFile(join(data, 'token'), 'utf8')).trim();
  if (!(await fetch(`${far}/api/health`).then(res => res.ok, () => false))) return t.skip('no second loopback address');
  const make = async name => { const dir = join(folders, name); await mkdir(dir); return (await (await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, name }) })).json()).project; };
  const alpha = await make('Alpha'), beta = await make('Beta');
  const ask = async () => (await fetch(`${far}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ubuntu' }) })).json();
  const answer = async r => (await fetch(`${far}/api/pair/${r.id}?secret=${r.secret}`)).json();
  const b = await browser(t);
  await b.goto(`${app.url}/#/`);
  await b.until(`document.querySelectorAll('.p-row').length === 2`);
  let asked = await ask();
  await b.until(`document.querySelector('#access .access-text b')?.textContent === '${asked.code}'`);
  assert.match(await b.evaluate(`document.querySelector('#access .access-text').textContent`), /Virtual machine "ubuntu" \(127\.0\.0\.1\) is asking for access to Mycel\. Code \d{4}: it must match the code on its screen\./);
  await b.evaluate(`document.querySelector('[data-pair-project]').value = ${JSON.stringify(beta.id)}`);
  await b.click('[data-pair-approve]');
  await b.until(`!document.querySelector('#access') && document.querySelector('#devices li')?.textContent.startsWith('ubuntu · 127.0.0.1 · Beta')`);
  const granted = await answer(asked);
  assert.deepEqual([granted.status, granted.project], ['approved', beta.id]);
  await b.click('#devices [data-revoke]');
  await b.until(`document.querySelector('#devices').hidden`);
  assert.equal((await fetch(`${far}/api/projects`, { headers: { Authorization: `Bearer ${granted.key}` } })).status, 401);
  // On a project page the same card, with this project by default.
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
  // "u" lies over "a" and covers its bottom right corner; "k" is a sub-map with the block "k1".
  await h.agent(p.id, [add('a'), add('b', { x: 400, y: 0 }), add('u', { x: 120, y: 60 }), add('k', { x: 0, y: 260, w: 520, h: 300 }), add('k1', { parentId: 'k', x: 10, y: 10 })]);
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`Boolean(document.querySelector('.block[data-id="k1"]')) && ${settled}`);
  assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('#viewport')).backgroundImage`), 'none');
  const box = id => b.evaluate(`(() => { const r = document.querySelector('.block[data-id="${id}"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const edges = async () => (await h.get(`/api/p/${p.id}/graph`)).edges.map(e => `${e.source}>${e.target}`).sort();
  const [a, bb, u, k, k1] = await Promise.all(['a', 'b', 'u', 'k', 'k1'].map(box));
  // From the bottom edge of "b" to a block inside the sub-map.
  await b.drag({ x: bb.x + bb.w / 2, y: bb.y + bb.h }, { x: k1.x + k1.w / 2, y: k1.y + k1.h / 2 });
  await until(async () => (await edges()).includes('b>k1'));
  // From the left edge of "a" to empty space in the sub-map: a link to the sub-map itself.
  await b.drag({ x: a.x, y: a.y + 20 }, { x: k.x + k.w - 60, y: k.y + k.h - 40 });
  await until(async () => (await edges()).includes('a>k'));
  // From the top edge of "u" to the part of "a" that "u" itself covers.
  await b.drag({ x: u.x + u.w - 30, y: u.y }, { x: u.x + 20, y: u.y + 20 });
  await until(async () => (await edges()).includes('u>a'));
  // With Alt, from the middle of the visible part of "a" to "b"; "a" does not move.
  const before = await h.node(p.id, 'a');
  await b.drag({ x: a.x + 50, y: a.y + 30 }, { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }, null, 1);
  await until(async () => (await edges()).includes('a>b'));
  const after = await h.node(p.id, 'a');
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
  // Without Alt the middle of a block still moves it.
  await b.drag({ x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }, { x: bb.x + bb.w / 2 + 40, y: bb.y + bb.h / 2 });
  await until(async () => (await h.node(p.id, 'b')).x > 400);
  assert.deepEqual(await edges(), ['a>b', 'a>k', 'b>k1', 'u>a']);
});

// Interface language: English by default, Russian for a browser set to Russian until the person picks a language with
// the EN / RU switch (on home and in the control bar). The choice is stored in the browser and redraws the page in place.
test('a browser set to Russian gets the Russian interface; the switch changes it in place, writes history in the chosen language and survives a reload', { skip }, async t => {
  const h = await hub(t), b = await browser(t, 'ru-RU');
  const p = await h.project('alpha');
  await h.agent(p.id, [add('a', { title: 'Cart' })]);
  const chosen = l => `(document.querySelector('[data-lang="${l}"]')?.getAttribute('aria-pressed') === 'true' && document.documentElement.lang === '${l}')`;
  const stored = `localStorage.getItem('mycel.lang')`, view = `JSON.stringify(window.mycel.state.view)`;
  const last = async () => (await h.get(`/api/p/${p.id}/history`)).history[0].message;
  const rename = async title => {
    await b.dblclick('.block[data-id="a"] .b-title');
    await b.until(`Boolean(document.querySelector('.block[data-id="a"] .b-title-input'))`);
    await b.type(title);
    await b.key('Escape');
  };
  // Home in Russian, with nothing stored: the line for the agent and the switch in the header.
  await b.goto(`${h.url}/#/`);
  await b.until(`document.querySelector('.home-top .agent-line')?.textContent.startsWith('Агенту: ') && ${chosen('ru')}`);
  assert.equal(await b.evaluate(stored), null);
  // The map in Russian; the person's edit shows «Закончить правки» and goes to history in Russian.
  await b.goto(`${h.url}/#/p/${p.id}`);
  await b.until(`document.querySelector('[data-tab="history"]')?.textContent === 'История' && Boolean(document.querySelector('.block[data-id="a"]')) && ${settled}`);
  await rename('Basket');
  await b.until(`document.querySelector('#edits .btn')?.textContent === 'Закончить правки'`);
  await until(async () => await last() === 'Изменён блок «Basket»');
  // The switch in the control bar: English at once, on the same project and view, with the edits still open.
  const before = await b.evaluate(view);
  await b.click('.dock-bar [data-lang="en"]');
  await b.until(`document.querySelector('[data-tab="history"]').textContent === 'History' && document.querySelector('#edits .btn')?.textContent === 'Finish edits' && ${chosen('en')} && ${settled}`);
  assert.deepEqual([await b.evaluate(stored), await b.evaluate('location.hash'), await b.evaluate(view)], ['en', `#/p/${p.id}`, before]);
  await rename('Cart');
  await until(async () => await last() === 'Changed block "Cart"');
  // The choice survives a reload, although the browser is set to Russian.
  await b.reload();
  await b.until(`document.querySelector('[data-tab="history"]')?.textContent === 'History' && ${chosen('en')} && ${settled}`);
  // Back to Russian with the switch on home; that choice is kept after a reload too.
  await b.evaluate(`location.hash = '#/'`);
  await b.until(`document.querySelector('.home-top .agent-line')?.textContent.startsWith('For your agent: ') && document.querySelector('.p-meta')?.textContent.startsWith('1 block ')`);
  await b.click('.home-top [data-lang="ru"]');
  await b.until(`document.querySelector('.home-top .agent-line')?.textContent.startsWith('Агенту: ') && document.querySelector('.p-meta')?.textContent.startsWith('1 блок ') && ${chosen('ru')}`);
  assert.equal(await b.evaluate(stored), 'ru');
  await b.reload();
  await b.until(`document.querySelector('.p-meta')?.textContent.startsWith('1 блок ') && ${chosen('ru')}`);
});
