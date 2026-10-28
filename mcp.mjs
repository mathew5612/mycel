// MCP-сервер Mycel для агентов (Claude Code — через плагин, Codex, Cursor и другие): stdio, JSON-RPC по одной строке на
// сообщение, без зависимостей. Инструменты — общий список src/tools.mjs; проект — тот, что подключён к папке, где запущен
// агент (CLAUDE_PROJECT_DIR или текущая папка), или явно: project, folder.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools, schema, runTool, toolResult } from './src/tools.mjs';

const appRoot = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// Кто вносит изменения: MYCEL_ACTOR (или прежняя KONTUR_ACTOR), иначе по имени клиента из initialize (claude-code → claude).
const named = process.env.MYCEL_ACTOR || process.env.KONTUR_ACTOR;
let actor = named || 'agent';

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
async function handle({ id, method, params }) {
  if (id === undefined || id === null) return; // уведомления, в том числе notifications/initialized
  if (method === 'initialize') {
    const client = String(params?.clientInfo?.name ?? '');
    if (!named) actor = /claude/i.test(client) ? 'claude' : /codex/i.test(client) ? 'codex' : (client.replace(/[^ -~]/g, '').trim().slice(0, 100) || 'agent');
    return send({ id, result: {
      protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0],
      capabilities: { tools: {} }, serverInfo: { name: 'mycel', version },
      instructions: 'Mycel — общая карта проекта: человек смотрит её в браузере и видит твои правки сразу. Начни с mycel_guide и mycel_context. Чата в Mycel нет: отвечай человеку здесь, а о его действиях в Mycel узнавай через mycel_wait и mycel_changes.'
    } });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: schema(t) })) } });
  if (method === 'tools/call') {
    const tool = tools.find(t => t.name === params?.name);
    if (!tool) return send({ id, error: { code: -32602, message: `Нет инструмента ${params?.name}` } });
    const a = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const r = toolResult(tool, await runTool(tool, a, { cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), actor }));
    return send({ id, result: { content: [{ type: 'text', text: r.text }], isError: r.error } });
  }
  send({ id, error: { code: -32601, message: `Метод не поддерживается: ${method}` } });
}

// Вызовы, которые ещё идут: когда клиент закрывает ввод, сервер сначала отвечает на них.
const pending = new Set();
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let message;
  // Метка BOM в начале потока (так пишет PowerShell) — не часть сообщения.
  try { message = JSON.parse(line.replace(/^﻿/, '')); } catch { return send({ id: null, error: { code: -32700, message: 'Некорректный JSON.' } }); }
  const work = handle(message).catch(e => { process.stderr.write(`${e.stack ?? e}\n`); if (message.id != null) send({ id: message.id, error: { code: -32603, message: e.message } }); });
  pending.add(work); work.finally(() => pending.delete(work));
}).on('close', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
