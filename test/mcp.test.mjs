import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { startServer } from '../server.mjs';

// MCP-сервер Mycel так, как его запускает Claude Code: отдельный процесс, JSON-RPC по строке через stdin и stdout.
// Хаб — на временном каталоге данных и свободном порту: настоящий .mycel и порт 4317 не трогаются.
const temp = async prefix => realpathSync.native(await mkdtemp(join(tmpdir(), prefix)));
const clean = (...dirs) => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
async function mcp(t, client = 'claude-code') {
  const data = await temp('mycel-mcp-data-'), folder = await temp('mycel-mcp-folder-'), app = await startServer({ data, port: 0 });
  const drop = new Set(['MYCEL_URL', 'MYCEL_DATA', 'MYCEL_ACTOR', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR']);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.has(k.toUpperCase()))), MYCEL_URL: app.url, MYCEL_DATA: app.data };
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'mcp.mjs')], { cwd: folder, env, windowsHide: true });
  const exited = once(child, 'exit'), replies = new Map(), lines = [];
  let seq = 0;
  createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); lines.push(m); replies.get(m.id)?.(m); });
  const request = (method, params) => new Promise(resolve => { const id = ++seq; replies.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args = {}) => { const m = await request('tools/call', { name, arguments: args }); return m.error ? { rpc: m.error } : { text: m.result.content[0].text, error: m.result.isError }; };
  const api = async path => (await fetch(app.url + path)).json();
  // Кнопка человека в интерфейсе — POST с токеном сессии.
  const press = async path => { const { token } = await api('/api/session'); return fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }); };
  t.after(async () => { child.stdin.end(); await exited; await app.close(); await clean(data, folder); });
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, version: '1' } });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  return { init, request, tool, api, press, folder, lines };
}

test('the MCP server answers the handshake, lists the mycel tools and runs them as the agent named by the client', async t => {
  const m = await mcp(t);
  assert.deepEqual([m.init.result.protocolVersion, m.init.result.serverInfo.name, m.init.result.capabilities], ['2025-06-18', 'mycel', { tools: {} }]);
  assert.match(m.init.result.instructions, /Чата в Mycel нет/);
  assert.deepEqual((await m.request('ping')).result, {});
  assert.equal((await m.request('server/discover')).error.code, -32601);
  const { tools } = (await m.request('tools/list')).result;
  assert.deepEqual(tools.map(x => x.name), ['mycel_guide', 'mycel_projects', 'mycel_init', 'mycel_context', 'mycel_changes', 'mycel_wait', 'mycel_selection',
    'mycel_apply', 'mycel_build', 'mycel_propose', 'mycel_mark', 'mycel_doing', 'mycel_show', 'mycel_check', 'mycel_touch', 'mycel_fresh', 'mycel_review', 'mycel_health', 'mycel_overview']);
  assert.ok(tools.every(x => x.inputSchema.type === 'object' && x.description));
  assert.equal((await m.tool('mycel_nothing')).rpc.code, -32602);
  assert.match((await m.tool('mycel_guide')).text, /^# Mycel: инструкция для агента/);

  // Проект — папка, где запущен агент; пакеты — объектами, без файлов.
  assert.match((await m.tool('mycel_init', { name: 'Через MCP' })).text, /Проект «Через MCP» подключён/);
  const id = (await m.api('/api/projects')).projects[0].id;
  assert.match((await m.tool('mycel_context')).text, /^# Карта\nРевизия: 0/);
  let r = await m.tool('mycel_build', { structure: { blocks: [{ id: 'korzina', title: 'Корзина', text: 'Покупатель собирает товары', blocks: [{ id: 'summa', title: 'Сумма', text: 'Корзина считает итог' }] }] }, at_once: true });
  assert.deepEqual([r.error, /Записано, ревизия 1/.test(r.text)], [false, true]);
  // Нарушение уровней — ошибка инструмента с объяснением, а не сбой протокола.
  r = await m.tool('mycel_apply', { operations: [{ type: 'update-node', id: 'korzina', patch: { text: 'вызывает `cart.add()`' } }] });
  assert.deepEqual([r.error, /Концепция/.test(r.text)], [true, true]);
  r = await m.tool('mycel_mark', { ids: ['summa'], status: 'passed' });
  assert.match(r.text, /Отмечен блок «Сумма»: проверен/);
  r = await m.tool('mycel_propose', { proposal: { title: 'Промокоды', parent: 'korzina', blocks: [{ id: 'promo', title: 'Промокод', text: 'Покупатель вводит код и получает скидку' }] } });
  assert.match(r.text, /Предложение «Промокоды» на карте/);
  const graph = await m.api(`/api/p/${id}/graph`);
  assert.deepEqual([graph.nodes.find(n => n.id === 'summa').status, graph.nodes.find(n => n.id === 'promo').proposed, graph.proposal.by], ['passed', 'add', 'claude']);
  assert.deepEqual((await m.api(`/api/p/${id}/history`)).history.map(h => h.actor), ['claude', 'claude', 'claude']);

  // Строка под картой, показ блока, выделение человека.
  assert.match((await m.tool('mycel_doing', { text: 'читаю `cart.ts`', progress: 30 })).text, /Под картой: «читаю `cart.ts`», 30 %/);
  assert.deepEqual((await m.api(`/api/p/${id}/chat`)).agents.map(a => a.actor), ['claude']);
  assert.match((await m.tool('mycel_doing', { done: true })).text, /снята/);
  assert.match((await m.tool('mycel_show', { id: 'summa' })).text, /Показан человеку: «Сумма»/);
  assert.match((await m.tool('mycel_selection')).text, /ничего не выделил/);

  // Ожидание без событий — не ошибка: агент просто ждёт снова.
  r = await m.tool('mycel_wait', { timeout_seconds: 1 });
  assert.deepEqual([r.error, /Вызови mycel_wait снова/.test(r.text)], [false, true]);
  assert.match((await m.tool('mycel_projects')).text, new RegExp(`^${id} · Через MCP`));
  // Решение человека будит ожидание; вызовы идут параллельно.
  const waiting = m.tool('mycel_wait', { timeout_seconds: 30 });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await m.press(`/api/p/${id}/proposal/accept`)).status, 200);
  r = await waiting;
  assert.deepEqual([r.error, /принял предложение «Промокоды»/.test(r.text)], [false, true]);
});

test('without a known client name the agent is called by it; MYCEL_ACTOR is not needed', async t => {
  const m = await mcp(t, 'codex-cli');
  await m.tool('mycel_init', { name: 'Codex' });
  await m.tool('mycel_doing', { text: 'смотрю' });
  const id = (await m.api('/api/projects')).projects[0].id;
  assert.deepEqual((await m.api(`/api/p/${id}/chat`)).agents.map(a => a.actor), ['codex']);
});
