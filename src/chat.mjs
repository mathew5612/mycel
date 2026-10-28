// Чат человека с агентами: сообщения и задания. Хранится отдельно от карты (chat.json) и не меняет её ревизию.
// seq растёт с каждым новым сообщением и сменой статуса задания; у сообщения seq — номер его последнего изменения,
// поэтому «что нового после seq» — это сообщения с большим seq.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Problem } from './model.mjs';

export const statuses = ['new', 'working', 'done'];
const KEEP = 500;
const demand = (ok, message) => { if (!ok) throw new Problem(message); };
const isName = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 100;

export async function openChat(directory) {
  const file = join(directory, 'chat.json');
  let state = { seq: 0, messages: [] };
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (!Number.isSafeInteger(state.seq) || !Array.isArray(state.messages)) throw new Error();
  } catch (e) { if (e.code !== 'ENOENT') throw new Error(`Некорректный chat.json: ${file}`); }
  let queue = Promise.resolve();
  // Запись по очереди и через временный файл, как у карты: оборванная запись не портит чат.
  const persist = () => {
    const snapshot = JSON.stringify(state, null, 2) + '\n';
    const work = queue.then(async () => {
      const temp = join(directory, `chat-${randomUUID()}.tmp`);
      try { await writeFile(temp, snapshot); await rename(temp, file); } finally { await unlink(temp).catch(() => {}); }
    });
    queue = work.catch(() => {});
    return work;
  };
  return {
    get seq() { return state.seq; },
    since: seq => state.messages.filter(m => m.seq > seq),
    recent: count => state.messages.slice(-count),
    // kind: 'log' — короткая строка о шаге агента («читаю server.mjs»): видна человеку, другим агентам не приходит.
    // kind: 'edits' — человек закончил правки карты (edits: с какой ревизии, до какой и сколько записей); kind:
    // 'proposal' — человек принял или отклонил предложение агента (proposal: название, чьё, итог и правки человека);
    // kind: 'check' — человек просит проверить блоки (check: id и названия).
    // Такие сообщения пишет только хаб, по кнопкам интерфейса.
    async add({ author, text, task = false, nodes = [], replyTo = null, kind = 'message', edits = null, proposal = null, check = null }) {
      demand(isName(author), 'Укажите author (до 100 символов).');
      demand(kind === 'message' || kind === 'log' || (kind === 'edits' && edits) || (kind === 'proposal' && proposal) || (kind === 'check' && check), 'kind: message или log.');
      demand(typeof text === 'string' && text.trim() && text.length <= (kind === 'log' ? 300 : 10000), kind === 'log' ? 'Шаг — до 300 символов.' : 'Текст сообщения — от 1 до 10000 символов.');
      demand(kind !== 'log' || !task, 'Шаг не может быть заданием.');
      demand(Array.isArray(nodes) && nodes.length <= 20 && nodes.every(id => typeof id === 'string' && id.length <= 100), 'nodes — до 20 id блоков.');
      demand(replyTo === null || state.messages.some(m => m.id === replyTo), 'Сообщение для ответа не найдено.');
      state.seq += 1;
      const message = { id: `m${state.seq}`, seq: state.seq, at: new Date().toISOString(), kind, author, text, task: Boolean(task), status: task ? 'new' : null, progress: null, step: null, nodes, replyTo, updatedBy: author, ...(kind === 'edits' ? { edits } : {}), ...(kind === 'proposal' ? { proposal } : {}), ...(kind === 'check' ? { check } : {}) };
      state.messages = [...state.messages, message].slice(-KEEP);
      await persist();
      return message;
    },
    // progress — сколько сделано, 0–100, step — что агент делает сейчас; интерфейс рисует по ним шкалу.
    // Готовое задание — 100 %, новое — без прогресса.
    async setStatus(id, status, by, { progress, step } = {}) {
      demand(isName(by), 'Укажите author (до 100 символов).');
      demand(statuses.includes(status), `Статус задания: ${statuses.join(', ')}.`);
      demand(progress === undefined || progress === null || (Number.isFinite(progress) && progress >= 0 && progress <= 100), 'progress — число от 0 до 100.');
      demand(step === undefined || step === null || (typeof step === 'string' && step.length <= 200), 'step — до 200 символов.');
      const message = state.messages.find(m => m.id === id);
      demand(message?.task, 'Задание не найдено.');
      state.seq += 1;
      const done = status === 'done', fresh = status === 'new';
      Object.assign(message, {
        status, seq: state.seq, updatedBy: by, updatedAt: new Date().toISOString(),
        progress: done ? 100 : fresh ? null : progress ?? message.progress ?? null,
        step: fresh ? null : step ?? (done ? null : message.step ?? null)
      });
      await persist();
      return message;
    },
    close: () => queue
  };
}
