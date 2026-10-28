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

// The Mycel MCP server as Claude Code runs it: a separate process, JSON-RPC one line at a time through stdin and stdout.
// The hub is on a temporary data folder and a free port: the real .mycel and port 4317 are not touched.
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
  // A button the person presses in the interface is a POST with the session token.
  const press = async path => { const { token } = await api('/api/session'); return fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }); };
  t.after(async () => { child.stdin.end(); await exited; await app.close(); await clean(data, folder); });
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, version: '1' } });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  return { init, request, tool, api, press, folder, lines };
}

test('the MCP server answers the handshake, lists the mycel tools and runs them as the agent named by the client', async t => {
  const m = await mcp(t);
  assert.deepEqual([m.init.result.protocolVersion, m.init.result.serverInfo.name, m.init.result.capabilities], ['2025-06-18', 'mycel', { tools: {} }]);
  assert.match(m.init.result.instructions, /Mycel has no chat/);
  assert.deepEqual((await m.request('ping')).result, {});
  assert.equal((await m.request('server/discover')).error.code, -32601);
  const { tools } = (await m.request('tools/list')).result;
  assert.deepEqual(tools.map(x => x.name), ['mycel_guide', 'mycel_projects', 'mycel_init', 'mycel_context', 'mycel_changes', 'mycel_wait', 'mycel_selection',
    'mycel_apply', 'mycel_build', 'mycel_propose', 'mycel_mark', 'mycel_doing', 'mycel_show', 'mycel_check', 'mycel_touch', 'mycel_fresh', 'mycel_review', 'mycel_health', 'mycel_overview']);
  assert.ok(tools.every(x => x.inputSchema.type === 'object' && x.description));
  assert.equal((await m.tool('mycel_nothing')).rpc.code, -32602);
  assert.match((await m.tool('mycel_guide')).text, /^# Mycel: agent guide/);

  // The project is the folder the agent runs in; batches are objects, without files.
  assert.match((await m.tool('mycel_init', { name: 'Through MCP' })).text, /Project "Through MCP" connected/);
  const id = (await m.api('/api/projects')).projects[0].id;
  assert.match((await m.tool('mycel_context')).text, /^# Map\nRevision: 0/);
  let r = await m.tool('mycel_build', { structure: { blocks: [{ id: 'cart', title: 'Cart', text: 'The shopper collects products', blocks: [{ id: 'total', title: 'Total', text: 'The cart adds up the total' }] }] }, at_once: true });
  assert.deepEqual([r.error, /Written, revision 1/.test(r.text)], [false, true]);
  // A level violation is a tool error with an explanation, not a protocol failure.
  r = await m.tool('mycel_apply', { operations: [{ type: 'update-node', id: 'cart', patch: { text: 'calls `cart.add()`' } }] });
  assert.deepEqual([r.error, /Concept/.test(r.text)], [true, true]);
  r = await m.tool('mycel_mark', { ids: ['total'], status: 'passed' });
  assert.match(r.text, /Marked block "Total": passed/);
  r = await m.tool('mycel_propose', { proposal: { title: 'Promo codes', parent: 'cart', blocks: [{ id: 'promo', title: 'Promo code', text: 'The shopper enters a code and gets a discount' }] } });
  assert.match(r.text, /Proposal "Promo codes" is on the map/);
  const graph = await m.api(`/api/p/${id}/graph`);
  assert.deepEqual([graph.nodes.find(n => n.id === 'total').status, graph.nodes.find(n => n.id === 'promo').proposed, graph.proposal.by], ['passed', 'add', 'claude']);
  assert.deepEqual((await m.api(`/api/p/${id}/history`)).history.map(h => h.actor), ['claude', 'claude', 'claude']);

  // The line under the map, showing a block, the person's selection.
  assert.match((await m.tool('mycel_doing', { text: 'reading `cart.ts`', progress: 30 })).text, /Under the map: "reading `cart.ts`", 30 %/);
  assert.deepEqual((await m.api(`/api/p/${id}/chat`)).agents.map(a => a.actor), ['claude']);
  assert.match((await m.tool('mycel_doing', { done: true })).text, /cleared/);
  assert.match((await m.tool('mycel_show', { id: 'total' })).text, /Shown to the person: "Total"/);
  assert.match((await m.tool('mycel_selection')).text, /has not selected anything/);

  // Waiting without events is not an error: the agent simply waits again.
  r = await m.tool('mycel_wait', { timeout_seconds: 1 });
  assert.deepEqual([r.error, /Call mycel_wait again/.test(r.text)], [false, true]);
  assert.match((await m.tool('mycel_projects')).text, new RegExp(`^${id} · Through MCP`));
  // The person's decision wakes the wait; calls run in parallel.
  const waiting = m.tool('mycel_wait', { timeout_seconds: 30 });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await m.press(`/api/p/${id}/proposal/accept`)).status, 200);
  r = await waiting;
  assert.deepEqual([r.error, /accepted the proposal "Promo codes"/.test(r.text)], [false, true]);
});

test('without a known client name the agent is called by it; MYCEL_ACTOR is not needed', async t => {
  const m = await mcp(t, 'codex-cli');
  await m.tool('mycel_init', { name: 'Codex' });
  await m.tool('mycel_doing', { text: 'looking' });
  const id = (await m.api('/api/projects')).projects[0].id;
  assert.deepEqual((await m.api(`/api/p/${id}/chat`)).agents.map(a => a.actor), ['codex']);
});
