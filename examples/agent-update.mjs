// Example: an agent adds a block to a project's map through the HTTP API, without mycel.mjs. The token comes from
// <data folder>/token and is sent only to localhost. The write goes on top of the revision read: if the map changed meanwhile, the hub answers 409.
import { readFile } from 'node:fs/promises';
const [base, tokenPath, id, title, text, message] = process.argv.slice(2);
if (!base || !tokenPath || !id || !title || !message) {
  console.error('Usage: node examples/agent-update.mjs <address> <token file> <project id> "<title>" "<text>" "<reason>"'); process.exit(1);
}
const origin = new URL(base);
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('The example sends the token only to localhost.');
const token = (await readFile(tokenPath, 'utf8')).trim();
const project = new URL(`/api/p/${encodeURIComponent(id)}/`, origin);
const response = await fetch(new URL('graph', project));
if (!response.ok) throw new Error(`The map was not read: ${response.status}`);
const graph = await response.json();
// Without x and y the hub places the block to the right of the map itself and fits its size to the text.
const result = await fetch(new URL('changes', project), {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ expectedRevision: graph.revision, actor: 'coding-agent', message, operations: [{ type: 'add-node', node: { title, text: text ?? '' } }] })
});
const value = await result.json();
if (!result.ok) { console.error(`${result.status}: ${value.error}`); process.exitCode = 1; }
else console.log(`Block added, revision ${value.revision}.`);
