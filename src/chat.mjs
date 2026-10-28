// The person's chat with agents: messages and tasks. Stored apart from the map (chat.json) and does not change its revision.
// seq grows with every new message and every task status change; a message's seq is the number of its latest change,
// so "what is new after seq" means the messages with a larger seq.
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
  } catch (e) { if (e.code !== 'ENOENT') throw new Error(`Invalid chat.json: ${file}`); }
  let queue = Promise.resolve();
  // Writes go one at a time and through a temporary file, as for the map: an interrupted write does not damage the chat.
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
    // kind: 'log' is a short line about an agent's step ("reading server.mjs"): the person sees it, other agents do not get it.
    // kind: 'edits' means the person finished editing the map (edits: from which revision, to which, and how many entries);
    // kind: 'proposal' means the person accepted or rejected an agent proposal (proposal: title, whose, outcome and the
    // person's edits); kind: 'check' means the person asks to check blocks (check: ids and names).
    // Only the hub writes such messages, from interface buttons.
    async add({ author, text, task = false, nodes = [], replyTo = null, kind = 'message', edits = null, proposal = null, check = null }) {
      demand(isName(author), 'Give author (up to 100 characters).');
      demand(kind === 'message' || kind === 'log' || (kind === 'edits' && edits) || (kind === 'proposal' && proposal) || (kind === 'check' && check), 'kind: message or log.');
      demand(typeof text === 'string' && text.trim() && text.length <= (kind === 'log' ? 300 : 10000), kind === 'log' ? 'A step is up to 300 characters.' : 'Message text is 1 to 10000 characters.');
      demand(kind !== 'log' || !task, 'A step cannot be a task.');
      demand(Array.isArray(nodes) && nodes.length <= 20 && nodes.every(id => typeof id === 'string' && id.length <= 100), 'nodes: up to 20 block ids.');
      demand(replyTo === null || state.messages.some(m => m.id === replyTo), 'Message to reply to not found.');
      state.seq += 1;
      const message = { id: `m${state.seq}`, seq: state.seq, at: new Date().toISOString(), kind, author, text, task: Boolean(task), status: task ? 'new' : null, progress: null, step: null, nodes, replyTo, updatedBy: author, ...(kind === 'edits' ? { edits } : {}), ...(kind === 'proposal' ? { proposal } : {}), ...(kind === 'check' ? { check } : {}) };
      state.messages = [...state.messages, message].slice(-KEEP);
      await persist();
      return message;
    },
    // progress is how much is done, 0–100; step is what the agent is doing now; the interface draws a bar from them.
    // A finished task is 100 %, a new one has no progress.
    async setStatus(id, status, by, { progress, step } = {}) {
      demand(isName(by), 'Give author (up to 100 characters).');
      demand(statuses.includes(status), `Task status: ${statuses.join(', ')}.`);
      demand(progress === undefined || progress === null || (Number.isFinite(progress) && progress >= 0 && progress <= 100), 'progress: a number from 0 to 100.');
      demand(step === undefined || step === null || (typeof step === 'string' && step.length <= 200), 'step: up to 200 characters.');
      const message = state.messages.find(m => m.id === id);
      demand(message?.task, 'Task not found.');
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
