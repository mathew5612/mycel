// Инструкция для агента: шаблон src/agent-guide.md с адресом Mycel и командой этого компьютера. Её отдаёт
// GET /agent, а `mycel.mjs guide` печатает ту же без сервера. Команда — всегда полный путь к node: у агента node
// может не быть в PATH. Прямые слэши работают и в PowerShell, и в bash, и в cmd.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Человек правит карту: агент не отвечает на эти правки, пока не придёт «Правки карты готовы». Строка для context,
// changes и wait.
export const editingLine = edit => `Человек сейчас правит карту (с ревизии ${edit.since}, записей: ${edit.count}) и ещё не нажал «Закончить правки»: не отвечай на эти правки и не меняй то, что он правит, — в чат придёт «Правки карты готовы».`;
const slash = p => p.replace(/\\/g, '/');
// remote: 'served' — инструкцию читают из виртуальной машины по сети (команды этого компьютера там не годятся);
// 'joined' — её печатает копия Mycel в виртуальной машине, подключённая к основной (mycel join).
// short — короткая инструкция для небольших моделей (src/agent-guide-short.md): только главное, без примеров.
export async function renderGuide({ url, remote = null, short = false }) {
  if (short) return (await readFile(join(appRoot, 'src', 'agent-guide-short.md'), 'utf8')).replaceAll('{{url}}', new URL(url).origin);
  const { origin, port } = new URL(url);
  const local = !remote && port !== '4317';
  const command = remote === 'served' ? '"<путь к node>" "<папка Mycel в этой машине>/mycel.mjs"' : `"${slash(process.execPath)}" "${slash(join(appRoot, 'mycel.mjs'))}"${local ? ` --url ${origin}` : ''}`;
  const note = remote === 'served'
    ? `\nТы в виртуальной машине, а Mycel работает на основной (${origin}). Поставь всё одной командой: \`curl -fsS ${origin}/install.sh | sh\` — Node.js 22+ (если его нет — в ~/.mycel-node), копия Mycel в ~/mycel и запрос доступа. Команда печатает код: скажи его человеку — он сверит код и нажмёт «Разрешить» в Mycel на основной машине. Ответа она ждёт до 10 минут: если умеешь, запусти её в фоне. Проект своей папки создай сам (\`init\` в её корне) — он появится у человека с пометкой этой машины; проект основной машины выбирает человек при разрешении, другой — \`--project <id>\`. Дальше команда Mycel — node и ~/mycel/mycel.mjs, полные пути печатает установка; первым делом подключи плагин: \`node ~/mycel/mycel.mjs plugin --install\`.\n`
    : remote === 'joined' ? `\nЭта копия Mycel подключена к Mycel на другой машине (${origin}, \`mycel join\`): карта — там, файлы проекта и проверки — здесь. Папку этой машины подключай как обычно (\`init\` в её корне): проект появится у человека с пометкой этой машины. Запустить и остановить Mycel можно только там.\n` : '';
  const template = await readFile(join(appRoot, 'src', 'agent-guide.md'), 'utf8');
  return template.replaceAll('{{remote}}', note).replaceAll('{{url}}', origin).replaceAll('{{command}}', command).replaceAll('{{readme}}', slash(join(appRoot, 'docs', 'reference.md')));
}
