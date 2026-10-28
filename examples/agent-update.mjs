// Пример: агент добавляет блок в карту проекта через HTTP API, без mycel.mjs. Токен — из <каталог данных>/token,
// он отправляется только на localhost. Запись идёт поверх прочитанной ревизии: если карту успели изменить, хаб ответит 409.
import { readFile } from 'node:fs/promises';
const [base, tokenPath, id, title, text, message] = process.argv.slice(2);
if (!base || !tokenPath || !id || !title || !message) {
  console.error('Запуск: node examples/agent-update.mjs <адрес> <файл токена> <id проекта> "<название>" "<текст>" "<причина>"'); process.exit(1);
}
const origin = new URL(base);
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('Пример отправляет токен только на localhost.');
const token = (await readFile(tokenPath, 'utf8')).trim();
const project = new URL(`/api/p/${encodeURIComponent(id)}/`, origin);
const response = await fetch(new URL('graph', project));
if (!response.ok) throw new Error(`Карта не прочитана: ${response.status}`);
const graph = await response.json();
// Без x и y хаб сам ставит блок правее карты и подбирает размер под текст.
const result = await fetch(new URL('changes', project), {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ expectedRevision: graph.revision, actor: 'coding-agent', message, operations: [{ type: 'add-node', node: { title, text: text ?? '' } }] })
});
const value = await result.json();
if (!result.ok) { console.error(`${result.status}: ${value.error}`); process.exitCode = 1; }
else console.log(`Блок добавлен, ревизия ${value.revision}.`);
