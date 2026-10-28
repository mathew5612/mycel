// The Mycel MCP server for agents (Claude Code through the plugin, Codex, Cursor and others): stdio, JSON-RPC with one line
// per message, no dependencies. The tools are the shared list in src/tools.mjs; the project is the one connected to the
// folder the agent runs in (CLAUDE_PROJECT_DIR or the current folder), or given explicitly: project, folder.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools, schema, runTool, toolResult } from './src/tools.mjs';

const appRoot = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// Who makes the changes: MYCEL_ACTOR (or the old KONTUR_ACTOR), otherwise by the client name from initialize (claude-code → claude).
const named = process.env.MYCEL_ACTOR || process.env.KONTUR_ACTOR;
let actor = named || 'agent';

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
async function handle({ id, method, params }) {
  if (id === undefined || id === null) return; // notifications, including notifications/initialized
  if (method === 'initialize') {
    const client = String(params?.clientInfo?.name ?? '');
    if (!named) actor = /claude/i.test(client) ? 'claude' : /codex/i.test(client) ? 'codex' : (client.replace(/[^ -~]/g, '').trim().slice(0, 100) || 'agent');
    return send({ id, result: {
      protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0],
      capabilities: { tools: {} }, serverInfo: { name: 'mycel', version },
      instructions: 'Mycel is a shared project map: the person watches it in the browser and sees your edits at once. Start with mycel_guide and mycel_context. Mycel has no chat: answer the person here, and learn about their actions in Mycel through mycel_wait and mycel_changes.'
    } });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: schema(t) })) } });
  if (method === 'tools/call') {
    const tool = tools.find(t => t.name === params?.name);
    if (!tool) return send({ id, error: { code: -32602, message: `No tool ${params?.name}` } });
    const a = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const r = toolResult(tool, await runTool(tool, a, { cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), actor }));
    return send({ id, result: { content: [{ type: 'text', text: r.text }], isError: r.error } });
  }
  send({ id, error: { code: -32601, message: `Method not supported: ${method}` } });
}

// Calls still in progress: when the client closes the input, the server answers them first.
const pending = new Set();
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let message;
  // A BOM at the start of the stream (PowerShell writes it) is not part of the message.
  try { message = JSON.parse(line.replace(/^﻿/, '')); } catch { return send({ id: null, error: { code: -32700, message: 'Invalid JSON.' } }); }
  const work = handle(message).catch(e => { process.stderr.write(`${e.stack ?? e}\n`); if (message.id != null) send({ id: message.id, error: { code: -32603, message: e.message } }); });
  pending.add(work); work.finally(() => pending.delete(work));
}).on('close', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
