// Встроенный агент Mycel для локальных моделей: любой сервер с OpenAI-совместимым /v1/chat/completions и вызовом
// функций (Ollama, LM Studio, llama.cpp, vLLM). Модель получает короткую инструкцию, обзор карты, все инструменты Mycel
// и чтение файлов проекта — отдельный агент-клиент не нужен. Код проекта модель не меняет: только читает и ведёт карту.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { tools as mycelTools, schema, runTool, toolResult } from './tools.mjs';

// tool_choice не передаётся: Ollama его не поддерживает, а «auto» и так по умолчанию.
const ROUNDS = 24;
const secret = name => /^\.env|\.(pem|key|p12|pfx|crt)$|^id_(rsa|ed25519|ecdsa)/i.test(name);
const skip = new Set(['node_modules', '.git', '.mycel', '.kontur', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', '__pycache__']);
const text = description => ({ type: 'string', description });

// Чтение папки проекта: только внутри неё; .env, ключи и сертификаты не открываются, двоичные и большие файлы — тоже.
export function fileTools(root) {
  const inside = path => {
    const full = resolve(root, path || '.'), rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Путь вне папки проекта.');
    return full;
  };
  const textOf = async full => {
    if (secret(basename(full))) throw new Error('Файлы с секретами (.env, ключи, сертификаты) не читаются.');
    if ((await stat(full)).size > 512 * 1024) throw new Error('Файл больше 512 КБ.');
    const body = await readFile(full, 'utf8');
    if (body.slice(0, 8000).includes('\u0000')) throw new Error('Двоичный файл.');
    return body;
  };
  return [
    { name: 'list_files', description: 'Список файлов и папок проекта (папка — с / на конце). Без зависимостей, сборки и .git.',
      properties: { path: text('папка от корня проекта, по умолчанию корень') },
      async run(a) {
        const items = await readdir(inside(a.path), { withFileTypes: true });
        return items.filter(i => !skip.has(i.name)).map(i => i.isDirectory() ? `${i.name}/` : i.name).sort().join('\n') || '(пусто)';
      } },
    { name: 'read_file', description: 'Прочитать файл проекта с номерами строк (по 400 строк; дальше — from).',
      properties: { path: text('файл от корня проекта'), from: { type: 'number', description: 'с какой строки, по умолчанию 1' }, lines: { type: 'number', description: 'сколько строк, до 2000' } },
      async run(a) {
        const all = (await textOf(inside(a.path))).split(/\r?\n/), from = Math.max(1, Math.floor(a.from || 1)), count = Math.min(Math.max(1, Math.floor(a.lines || 400)), 2000);
        const end = from - 1 + count;
        return all.slice(from - 1, end).map((line, i) => `${from + i}: ${line}`).join('\n') + (end < all.length ? `\n… ещё ${all.length - end} строк (from: ${end + 1})` : '');
      } },
    { name: 'search_files', description: 'Найти строки по регулярному выражению в файлах проекта (до 100 совпадений).',
      properties: { pattern: text('регулярное выражение'), path: text('папка от корня проекта, по умолчанию корень') },
      async run(a) {
        let re;
        try { re = new RegExp(a.pattern, 'i'); } catch (e) { throw new Error(`Не регулярное выражение: ${e.message}`); }
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
        return found.join('\n') || 'Ничего не нашлось.';
      } }
  ];
}

// Описания для модели: все инструменты Mycel, кроме долгого ожидания (в разговоре оно не нужно), и чтение файлов.
export function chatTools(root) {
  const mine = mycelTools.filter(t => t.name !== 'mycel_wait'), files = fileTools(root);
  return {
    defs: [...mine, ...files].map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.run ? { type: 'object', properties: t.properties } : schema(t) } })),
    find: name => mine.find(t => t.name === name) ?? files.find(t => t.name === name) ?? null
  };
}

// Разговор: строка человека → ответы модели и вызовы инструментов, пока модель не ответит текстом (до 24 шагов). После
// ответа — напоминание описать блоки, файлы которых отмечены изменёнными (как хук Stop плагина), один раз.
export async function runChat({ base, model, key, actor, cwd, system, prompt, env, afterTurn, log = line => process.stderr.write(`${line}\n`), say = line => process.stdout.write(`${line}\n`) }) {
  const { defs, find } = chatTools(cwd), url = `${base.replace(/\/+$/, '')}/chat/completions`;
  const messages = [{ role: 'system', content: system }];
  const complete = async () => {
    const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: `Bearer ${key}` } : {}),
      body: JSON.stringify({ model, messages, tools: defs, temperature: 0.2 }), signal: AbortSignal.timeout(600e3) });
    if (!res.ok) throw new Error(`Модель ответила ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const message = (await res.json()).choices?.[0]?.message;
    if (!message) throw new Error('Модель ничего не вернула.');
    return message;
  };
  const call = async c => {
    const tool = find(c.function?.name);
    if (!tool) return `Нет инструмента ${c.function?.name}.`;
    let args = {};
    try { args = c.function.arguments ? (typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments) : c.function.arguments) : {}; }
    catch { return 'Аргументы — не JSON: повтори вызов с корректным JSON.'; }
    log(`→ ${tool.name}${args.path ? ` ${args.path}` : args.ids ? ` ${args.ids.join(',')}` : ''}`);
    if (tool.run) { try { return await tool.run(args); } catch (e) { return `Ошибка: ${e.message}`; } }
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
    log(`Остановился: больше ${ROUNDS} шагов подряд.`);
  };
  if (prompt) return turn(prompt);
  const rl = createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY) });
  say('Пиши задачу; пустая строка или «выход» — закончить.');
  for await (const line of rl) {
    if (!line.trim() || /^(выход|exit|quit)$/i.test(line.trim())) break;
    try { await turn(line); } catch (e) { log(e.message); }
  }
  rl.close();
}
