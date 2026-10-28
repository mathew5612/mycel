// Инструменты Mycel для агентов — один список для MCP-сервера (mcp.mjs), выгрузки описаний для любой модели с вызовом
// функций (mycel tools), вызова по имени (mycel call) и встроенного агента для локальных моделей (mycel chat). Каждый
// инструмент запускает ту же команду mycel.mjs, что агент из терминала, и отдаёт её вывод: логика, проверки и тексты
// для агента остаются в одном месте. Проект — тот, что подключён к папке, где запущен агент, или явно: project, folder.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'mycel.mjs');
const text = description => ({ type: 'string', description });
const where = { project: text('id проекта из mycel_projects; по умолчанию — проект папки, где запущен агент'), folder: text('папка проекта, если агент запущен не в ней') };
const noCheck = { no_check: { type: 'boolean', description: 'без проверки уровней «Концепция» и «Механика» — только если человек сам попросил такой текст' } };
const object = description => ({ type: 'object', description, additionalProperties: true });
const ids = description => ({ type: 'array', items: { type: 'string' }, description: `id: ${description}` });
// name, описание, параметры, аргументы команды и (у пакетов) JSON для её стандартного ввода.
export const tools = [
  ['mycel_guide', 'Инструкция Mycel для агента: уровни карты, как строить, предлагать, отмечать тесты. Прочитай один раз в начале работы.', { short: { type: 'boolean', description: 'короткая — для небольших моделей' } }, a => ['guide', ...(a.short ? ['--short'] : [])], null, false],
  ['mycel_projects', 'Все проекты Mycel: id · название · папка.', {}, () => ['projects'], null, false],
  ['mycel_init', 'Подключить папку проекта к Mycel (та же папка — тот же проект с его картой).', { folder: text('папка проекта; по умолчанию — где запущен агент'), name: text('название проекта') },
    a => ['init', ...(a.folder ? [a.folder] : []), ...(a.name ? ['--name', a.name] : [])], null, false],
  ['mycel_context', 'Вся карта в Markdown: блоки с текстом и уровнем, вложенность, заметки, связи с id; что человек выделил и в каком блоке работает; его новые действия в Mycel. Запоминает прочитанное — запись идёт только поверх него.',
    { focus: text('id блока: только он со всем вложенным'), brief: { type: 'boolean', description: 'без координат и размеров' } },
    a => ['context', ...(a.focus ? ['--focus', a.focus] : []), ...(a.brief ? ['--brief'] : [])]],
  ['mycel_changes', 'Что изменили другие после последнего чтения: правки карты и действия человека (закончил правки, принял или отклонил предложение).', {}, () => ['changes']],
  ['mycel_wait', 'Ждать действие человека в Mycel или чужую правку содержимого карты, затем вернуть их. Долгий вызов: Claude Code сам уводит его в фон и сообщит, когда он закончится. Вызывай снова после каждого ответа, пока работаешь с человеком.',
    { timeout_seconds: { type: 'number', description: 'сколько ждать, по умолчанию 1500 (25 минут), не больше 1700' } },
    a => ['wait', '--timeout', String(Math.max(1, Math.min(1700, Math.round(a.timeout_seconds ?? 1500))))]],
  ['mycel_selection', 'Что человек сейчас выделил на карте и в каком блоке работает — с полным текстом. Когда человек пишет «сделай это», «вот этот блок», смотри сюда.', {}, () => ['selection']],
  ['mycel_apply', 'Пакет операций над картой (add-node, update-node, delete-node, add-edge, update-edge, delete-edge, layout) — формат в mycel_guide.',
    { message: text('причина изменения'), operations: { type: 'array', items: { type: 'object' }, description: 'операции' }, ...noCheck },
    a => ['apply', '-', ...(a.message ? ['-m', a.message] : []), ...(a.no_check ? ['--no-check'] : [])], a => ({ operations: a.operations })],
  ['mycel_build', 'Структура целиком: блоки с подкартами, заметки, связи; без x и y всё расставляется само, пишется по шагам — человек видит, как карта растёт.',
    { structure: object('{ "message", "parent", "blocks": [{ "id", "title", "text", "status", "files", "test", "blocks", "notes" }], "notes", "links": [["откуда", "куда", "подпись"]] }'), at_once: { type: 'boolean', description: 'одной записью, без шагов' }, ...noCheck },
    a => ['build', '-', ...(a.at_once ? ['--at-once'] : []), ...(a.no_check ? ['--no-check'] : [])], a => a.structure],
  ['mycel_propose', 'Предложить человеку изменение логики: структура как у mycel_build и (или) "operations" как у mycel_apply, "title" — название. Новое ложится пунктиром с подсветкой, удаление только помечается; человек принимает или отклоняет кнопками, решение придёт в mycel_wait.',
    { proposal: object('{ "title", "parent", "blocks", "notes", "links", "operations" }'), ...noCheck },
    a => ['propose', '-', ...(a.no_check ? ['--no-check'] : [])], a => a.proposal],
  ['mycel_mark', 'Отметка блоков: plan — логика без готового кода (пунктир), testing — проверка идёт сейчас, passed — тесты прошли (зелёная рамка), failed — не прошли (красная), none — снять. Отмечай каждый итог сразу: человек смотрит, как карта окрашивается.',
    { ids: ids('блоки'), status: { type: 'string', enum: ['plan', 'testing', 'passed', 'failed', 'none'] } },
    a => ['mark', (a.ids ?? []).join(','), a.status ?? '']],
  ['mycel_doing', 'Что ты делаешь сейчас («читаю server.mjs») — строка под картой у человека; on — id блоков, над которыми работаешь (их видят человек и другие агенты). done: true — снять, когда закончил.',
    { text: text('что делаешь, коротко'), progress: { type: 'number', description: 'сколько сделано, 0–100' }, on: ids('блоки, над которыми работаешь'), done: { type: 'boolean' } },
    a => a.done || !a.text ? ['doing', '--done'] : ['doing', a.text, ...(a.progress === undefined ? [] : ['--progress', String(a.progress)]), ...(a.on?.length ? ['--on', a.on.join(',')] : [])]],
  ['mycel_show', 'Показать человеку блок: карта переходит к нему и выделяет его. Вместо ссылки в тексте.', { id: text('id блока') }, a => ['show', a.id ?? '']],
  ['mycel_check', 'Запустить команды проверки (поле test) у блоков и вложенного в них, без ids — у всей карты: рамки зеленеют и краснеют по ходу, человек это видит. Вернёт итог и хвост вывода упавших команд.',
    { ids: ids('блоки для проверки'), timeout_seconds: { type: 'number', description: 'предел на команду, по умолчанию 600' } },
    a => ['check', ...(a.ids?.length ? [a.ids.join(',')] : []), ...(a.timeout_seconds ? ['--timeout', String(a.timeout_seconds)] : [])]],
  ['mycel_touch', 'Файлы, которые ты только что изменил (пути от корня проекта или полные): их блоки на карте подписываются твоим именем и помечаются «возможно устарел». Вызывай после правки файлов, если у тебя нет хуков Mycel и не запущен mycel watch.',
    { files: { type: 'array', items: { type: 'string' }, description: 'изменённые файлы' } }, a => ['touch', ...(a.files ?? [])]],
  ['mycel_fresh', 'Описание блоков верно после правки их файлов — снять пометку «возможно устарел». all: true — у всех.',
    { ids: ids('блоки'), all: { type: 'boolean' } }, a => a.all ? ['fresh', '--all'] : ['fresh', (a.ids ?? []).join(',')]],
  ['mycel_review', 'Ревью картой: что изменилось в устройстве проекта по концепциям, простыми словами — за hours часов (по умолчанию 24) или после ревизии since.',
    { hours: { type: 'number' }, since: { type: 'number', description: 'ревизия' } },
    a => ['review', ...(a.since !== undefined ? ['--since', String(a.since)] : a.hours ? ['--hours', String(a.hours)] : [])]],
  ['mycel_health', 'Здоровье карты: красные и устаревшие блоки, блоки без проверки, план, TODO и похожее на ключи в файлах блоков (только файл и строка).',
    { no_scan: { type: 'boolean', description: 'без чтения файлов' } }, a => ['health', ...(a.no_scan ? ['--no-scan'] : [])]],
  ['mycel_overview', 'Короткий обзор карты: концепции и механика по строке, отметки, устаревшее. Дешевле полного mycel_context.', {}, () => ['overview']]
].map(([name, description, properties, args, input = null, scoped = true]) => ({ name, description, properties: scoped ? { ...properties, ...where } : properties, args, input, scoped }));

export const schema = tool => ({ type: 'object', properties: tool.properties });

// Команда mycel.mjs от имени агента; JSON пакета — через стандартный ввод. cwd — папка, где работает агент.
export function runTool(tool, a, { cwd, actor, env = process.env }) {
  const args = [cli, ...tool.args(a), ...(tool.scoped && a.project ? ['--project', a.project] : [])];
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: (tool.scoped && a.folder) || cwd, env: { ...env, MYCEL_ACTOR: actor }, windowsHide: true });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', c => { out += c; });
    child.stderr.setEncoding('utf8').on('data', c => { err += c; });
    child.on('error', e => resolve({ code: 1, out: '', err: e.message }));
    child.on('close', code => resolve({ code, out: out.trimEnd(), err: err.trimEnd() }));
    child.stdin.on('error', () => {});
    child.stdin.end(tool.input ? JSON.stringify(tool.input(a)) : undefined);
  });
}
// Ответ инструмента для модели: wait без событий за срок — не ошибка, агент просто ждёт снова.
export function toolResult(tool, { code, out, err }) {
  const quiet = tool.name === 'mycel_wait' && code === 2;
  return { text: quiet ? 'Человек ничего не делал в Mycel, и карту не меняли. Вызови mycel_wait снова, если ждёшь его.' : [out, err].filter(Boolean).join('\n') || 'Готово.', error: code !== 0 && !quiet };
}
