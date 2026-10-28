// The built-in Mycel agent for local models: any server with an OpenAI-compatible /v1/chat/completions and function
// calling (Ollama, LM Studio, llama.cpp, vLLM). The model gets a short guide, an overview of the map, all Mycel tools and
// reading of the project files: no separate agent client is needed. The model does not change the project code: it only reads it and keeps the map.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { tools as mycelTools, schema, runTool, toolResult } from './tools.mjs';

// tool_choice is not sent: Ollama does not support it, and "auto" is the default anyway.
const ROUNDS = 24;
const secret = name => /^\.env|\.(pem|key|p12|pfx|crt)$|^id_(rsa|ed25519|ecdsa)/i.test(name);
const skip = new Set(['node_modules', '.git', '.mycel', '.kontur', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', '__pycache__']);
const text = description => ({ type: 'string', description });

// Reading the project folder: only inside it; .env, keys and certificates are not opened, and neither are binary and large files.
export function fileTools(root) {
  const inside = path => {
    const full = resolve(root, path || '.'), rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('The path is outside the project folder.');
    return full;
  };
  const textOf = async full => {
    if (secret(basename(full))) throw new Error('Files with secrets (.env, keys, certificates) are not read.');
    if ((await stat(full)).size > 512 * 1024) throw new Error('The file is larger than 512 KB.');
    const body = await readFile(full, 'utf8');
    if (body.slice(0, 8000).includes('\u0000')) throw new Error('Binary file.');
    return body;
  };
  return [
    { name: 'list_files', description: 'List the files and folders of the project (a folder ends with /). Without dependencies, build output and .git.',
      properties: { path: text('a folder from the project root, the root by default') },
      async run(a) {
        const items = await readdir(inside(a.path), { withFileTypes: true });
        return items.filter(i => !skip.has(i.name)).map(i => i.isDirectory() ? `${i.name}/` : i.name).sort().join('\n') || '(empty)';
      } },
    { name: 'read_file', description: 'Read a project file with line numbers (400 lines at a time; for more, use from).',
      properties: { path: text('a file from the project root'), from: { type: 'number', description: 'the line to start from, 1 by default' }, lines: { type: 'number', description: 'how many lines, up to 2000' } },
      async run(a) {
        const all = (await textOf(inside(a.path))).split(/\r?\n/), from = Math.max(1, Math.floor(a.from || 1)), count = Math.min(Math.max(1, Math.floor(a.lines || 400)), 2000);
        const end = from - 1 + count;
        return all.slice(from - 1, end).map((line, i) => `${from + i}: ${line}`).join('\n') + (end < all.length ? `\n… ${all.length - end} more lines (from: ${end + 1})` : '');
      } },
    { name: 'search_files', description: 'Find lines matching a regular expression in the project files (up to 100 matches).',
      properties: { pattern: text('a regular expression'), path: text('a folder from the project root, the root by default') },
      async run(a) {
        let re;
        try { re = new RegExp(a.pattern, 'i'); } catch (e) { throw new Error(`Not a regular expression: ${e.message}`); }
        const found = [], walk = async (dir, depth) => {
          for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (found.length >= 100 || skip.has(item.name)) continue;
            const full = join(dir, item.name);
            if (item.isDirectory()) { if (depth < 8) await walk(full, depth + 1); continue; }
            const body = await textOf(full).catch(() => null);
            if (body !== null) body.split(/\r?\n/).forEach((line, i) => { if (found.length < 100 && re.test(line)) found.push(`${relative(root, full).replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 200)}`); });
          }
        };
        await walk(inside(a.path), 0);
        return found.join('\n') || 'Nothing found.';
      } }
  ];
}

// Descriptions for the model: all Mycel tools except the long wait (a conversation does not need it), and file reading.
export function chatTools(root) {
  const mine = mycelTools.filter(t => t.name !== 'mycel_wait'), files = fileTools(root);
  return {
    defs: [...mine, ...files].map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.run ? { type: 'object', properties: t.properties } : schema(t) } })),
    find: name => mine.find(t => t.name === name) ?? files.find(t => t.name === name) ?? null
  };
}

// A conversation: the person's line → the model's answers and tool calls until the model answers with text (up to 24 steps).
// After the answer, a reminder to describe the blocks whose files are marked changed (like the plugin's Stop hook), once.
export async function runChat({ base, model, key, actor, cwd, system, prompt, env, afterTurn, log = line => process.stderr.write(`${line}\n`), say = line => process.stdout.write(`${line}\n`) }) {
  const { defs, find } = chatTools(cwd), url = `${base.replace(/\/+$/, '')}/chat/completions`;
  const messages = [{ role: 'system', content: system }];
  const complete = async () => {
    const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: `Bearer ${key}` } : {}),
      body: JSON.stringify({ model, messages, tools: defs, temperature: 0.2 }), signal: AbortSignal.timeout(600e3) });
    if (!res.ok) throw new Error(`The model answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const message = (await res.json()).choices?.[0]?.message;
    if (!message) throw new Error('The model returned nothing.');
    return message;
  };
  const call = async c => {
    const tool = find(c.function?.name);
    if (!tool) return `No tool ${c.function?.name}.`;
    let args = {};
    try { args = c.function.arguments ? (typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments) : c.function.arguments) : {}; }
    catch { return 'The arguments are not JSON: repeat the call with valid JSON.'; }
    log(`→ ${tool.name}${args.path ? ` ${args.path}` : args.ids ? ` ${args.ids.join(',')}` : ''}`);
    if (tool.run) { try { return await tool.run(args); } catch (e) { return `Error: ${e.message}`; } }
    return toolResult(tool, await runTool(tool, args, { cwd, actor, env })).text;
  };
  const turn = async line => {
    messages.push({ role: 'user', content: line });
    let reminded = false;
    for (let round = 0; round < ROUNDS; round++) {
      const message = await complete();
      messages.push(Object.assign({ role: 'assistant', content: message.content ?? '' }, message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}));
      if (message.tool_calls?.length) {
        for (const c of message.tool_calls) messages.push({ role: 'tool', tool_call_id: c.id, content: await call(c) });
        continue;
      }
      if (message.content) say(message.content.trim());
      const reminder = reminded ? null : await afterTurn?.();
      if (!reminder) return;
      reminded = true;
      messages.push({ role: 'user', content: reminder });
    }
    log(`Stopped: more than ${ROUNDS} steps in a row.`);
  };
  if (prompt) return turn(prompt);
  const rl = createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY) });
  say('Type a task; an empty line or "exit" ends the conversation.');
  for await (const line of rl) {
    if (!line.trim() || /^(выход|exit|quit)$/i.test(line.trim())) break;
    try { await turn(line); } catch (e) { log(e.message); }
  }
  rl.close();
}
