// Уровни абстракции по глубине вложенности и проверка пакета агента перед записью. «Концепцию» и «Механику» (глубина
// 0 и 1) читают люди без программирования: там коротко и без кода, файлов и имён из кода. Проверяются только поля,
// которые пакет добавляет или меняет; старое содержимое и правки человека из интерфейса не проверяются.

export const levelNames = ['концепция', 'механика', 'техника', 'код'];
export const levelOf = depth => levelNames[Math.min(depth, levelNames.length - 1)];
export const plainDepth = 1, maxTitle = 40, maxText = 200;

// Расширения файлов кода и настроек. Однобуквенные (c, h) — только у имени от двух символов: иначе «a.c» из сокращений.
const ext = 'mjs|cjs|jsx|js|tsx|ts|pyw|py|ipynb|rb|go|rs|java|kts|kt|scala|cs|cpp|cc|cxx|c|hpp|h|swift|php|lua|dart|exs|ex|erl|sh|bash|zsh|ps1|psm1|bat|cmd|sql|sqlite|db|jsonc|json|yaml|yml|toml|ini|cfg|conf|config|env|properties|xml|plist|gradle|lock|html|htm|css|scss|sass|less|vue|svelte|mdx|md|txt|log|tf|proto|graphql|gql|gitignore|dockerignore|npmrc|nvmrc|editorconfig|eslintrc|prettierrc|babelrc|bashrc|zshrc';
// Имя файла может стоять и после пути, который isPath не узнал (Controllers/HomeController.cs, Папка/main.py).
const fileRe = new RegExp(String.raw`(?<![\p{L}\p{N}_.-])[\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*\.(?:${ext})(?![\p{L}\p{N}_-])`, 'giu');
const fileName = new RegExp(String.raw`^[\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*\.(?:${ext})$`, 'iu');
const bareFiles = /\b(?:Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Jenkinsfile|Vagrantfile)\b/g;
// Node.js, Vue.js, D3.js — названия продуктов, а не файлы.
const product = s => /^[A-Z][A-Za-z0-9]*\.js$/.test(s);
const isFile = s => !product(s) && (!/\.[ch]$/i.test(s) || /^[\p{L}\p{N}_-]{2,}\.[ch]$/iu.test(s));
// Путь: адрес, абсолютный или относительный путь, диск Windows или ASCII-слова через / или \, среди которых есть
// файл кода (UI/Button.tsx, /main.py) или строчное слово от трёх букв (src/pay). «TCP/IP», «24/7», «км/ч»,
// «Android/iOS», «Node.js/Express», «/start» — не пути.
function isPath(w) {
  if (!/[\\/]/.test(w)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w) || /^[A-Za-z]:[\\/]/.test(w)) return true;
  if (!/^[\w.~<>{}*@:-]*(?:[\\/][\w.~<>{}*@:-]*)+$/.test(w)) return false;
  const parts = w.split(/[\\/]/).filter(Boolean);
  if (parts.some(p => fileName.test(p) && isFile(p))) return true;
  if (/^(?:\.{1,2}|~)?[\\/]/.test(w)) return parts.length >= 2 && parts.some(p => /[A-Za-z]/.test(p));
  return parts.length >= 2 && parts.some(p => /^[a-z0-9_.~-]{3,}$/.test(p) && /[a-z]/.test(p));
}
// Вызов: имя (и через точку) и сразу скобки, пустые или с аргументами: send(), send(message), create(...). В русском
// тексте перед скобкой пробел — «ИИ (GPT-4o)», «Бот (Telegram)» не вызовы; «ответ(ы)» кириллицей — тоже.
const callRe = /(?<![\p{L}\p{N}_$.-])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^()]*\)/gu;
// Имя через точку: message.text, os.getenv, settings.DEBUG, JSON.parse, ChatCompletion.create. Не код: адреса сайтов
// (openai.com, t.me, Booking.com), документы (photo.jpg), Node.js, ASP.NET, Yandex.Music, «e.g.», «a.m.».
const dottedRe = /(?<![\p{L}\p{N}_$.-])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?![\p{L}\p{N}_$-])/gu;
const site = /^(?:com|net|org|info|biz|edu|gov|ru|su|by|kz|ua|uz|me|io|ai|app|dev|co|uk|us|de|eu|tv|fm|ly|so|to|be|gg|cc|xyz|online|site|shop|tech|cloud|jpe?g|png|gif|webp|heic|svg|pdf|docx?|xlsx?|pptx?|odt|rtf|csv|mp3|mp4|m4a|mov|avi|mkv|webm|wav|ogg|oga|zip|rar|7z)$/i;
const dotted = m => {
  const parts = m.split('.'), first = parts[0], last = parts.at(-1);
  if (product(m) || site.test(last) || first.length < 2 || last.length < 2) return false;
  return /^[a-z_$]/.test(first) || /^[a-z_$]/.test(last);
};
// Имя пользователя и команда бота в Telegram (@study_buddy_bot, /set_language) — то, что пишет пользователь, а не код.
const handle = String.raw`(?<!(?:^|[\s«"'(\[“„])[@/])`;
const snakeRe = new RegExp(String.raw`(?<![\w$])${handle}\w*_\w*(?![\w$])`, 'g');
// camelCase: строчное слово от двух букв, затем заглавная и снова строчная (getResponse). iPhone, macOS, eBay — нет.
const camelRe = new RegExp(String.raw`(?<![\w$])${handle}[a-z][a-z0-9]+[A-Z]+[a-z][A-Za-z0-9]*(?![\w$])`, 'g');
// Класс: слово с заглавной и ролью из кода на конце (CartService, BotHandler, OpenAIClient, TypeError) или Async…
// (AsyncOpenAI). YouTube, OpenAI, WhatsApp, одно «Service» — нет.
const classRe = /(?<![\w$])(?:[A-Z][A-Za-z0-9]*(?:Service|Handler|Client|Controller|Manager|Repository|Provider|Factory|Router|Middleware|Adapter|Dispatcher|Listener|Processor|Validator|Serializer|Helper|Utils|Exception|Error)|Async[A-Z][A-Za-z0-9]*)(?![\w$])/g;

// Что в тексте выдаёт код: [что, фрагмент]. Найденное вырезается, чтобы `get_response()` в кавычках не считался трижды.
export function codeFragments(value) {
  let s = String(value ?? '');
  const found = [], take = (re, what, keep = () => true) => {
    s = s.replace(re, m => { if (!keep(m)) return m; found.push([what, m]); return ' '; });
  };
  take(/`[^`]*`?/g, 'код в обратных кавычках');
  s = s.split(/(\s+)/).map(word => {
    const w = word.replace(/^[«"'(\[“”„‘‚]+|[»"')\].,:;!?…“”’‘]+$/g, '');
    if (w && isPath(w)) { found.push(['файл или путь', w]); return ' '; }
    return word;
  }).join('');
  take(fileRe, 'файл', isFile);
  take(bareFiles, 'файл');
  take(callRe, 'вызов функции');
  take(dottedRe, 'имя из кода', dotted);
  take(snakeRe, 'имя из кода', m => /[A-Za-z]/.test(m));
  take(camelRe, 'имя из кода');
  take(classRe, 'имя из кода');
  return found;
}

// Нарушения пакета operations поверх карты graph (до записи). Глубина узла — по итоговой вложенности после пакета.
// Возвращает [{ what: 'block' | 'note' | 'edge', name, level, field, problems: [[что, фрагмент]] }].
// Проверяются итоговые значения: текст, добавленный и тут же исправленный в том же пакете, — по исправленному. Блок
// называется так, как его знает агент: по названию до пакета, новый — по названию из пакета.
export function levelProblems(graph, operations) {
  const ops = Array.isArray(operations) ? operations.filter(isObject) : [];
  const parent = new Map(graph.nodes.map(n => [n.id, n.parentId ?? null])), known = new Map(graph.nodes.map(n => [n.id, n]));
  const edges = new Map(graph.edges.map(e => [e.id, { ...e }]));
  // К какому блоку прикреплена каждая заметка: блок, перенесённый на другой уровень, уводит их с собой (как в applyOperations).
  const attached = new Map(graph.nodes.filter(n => n.type === 'note').map(n => [n.id, n.attachedTo ?? null]));
  // Поля, которые пакет добавляет или меняет. Узел и связь без id получают ключ с «#» (в id его нет): на них никто не
  // ссылается.
  const fields = new Map(), labels = new Map(), pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
  ops.forEach((op, i) => {
    if (op.type === 'add-node' && isObject(op.node)) {
      const id = op.node.id ?? `#${i}`;
      parent.set(id, op.node.parentId ?? null); known.set(id, op.node); fields.set(id, { title: op.node.title, text: op.node.text });
      if (op.node.type === 'note') attached.set(id, op.node.attachedTo ?? null);
    } else if (op.type === 'update-node' && isObject(op.patch) && parent.has(op.id)) {
      const note = known.get(op.id)?.type === 'note';
      if (note && 'attachedTo' in op.patch) attached.set(op.id, op.patch.attachedTo ?? null);
      if ('parentId' in op.patch) {
        const level = op.patch.parentId ?? null;
        parent.set(op.id, level);
        if (!note) for (const [id, to] of attached) if (to === op.id) parent.set(id, level);
      }
      fields.set(op.id, { ...fields.get(op.id), ...pick(op.patch, ['title', 'text']) });
    } else if (op.type === 'add-edge' && isObject(op.edge)) {
      const id = op.edge.id ?? `#${i}`;
      edges.set(id, { ...op.edge }); labels.set(id, op.edge.label);
    } else if (op.type === 'update-edge' && isObject(op.patch) && edges.has(op.id)) {
      Object.assign(edges.get(op.id), pick(op.patch, ['source', 'target', 'label']));
      if ('label' in op.patch) labels.set(op.id, op.patch.label);
    }
  });
  const depth = id => { let d = 0; for (let p = parent.get(id), guard = 0; p != null && guard < 100; p = parent.get(p), guard++) d++; return d; };
  const plain = id => id != null && parent.has(id) && depth(id) <= plainDepth;
  const name = id => { const n = known.get(id); return (n?.title || String(n?.text ?? '').trim().split('\n')[0] || id).slice(0, 60); };
  const out = [], check = (what, label, level, field, value, max) => {
    if (typeof value !== 'string' || !value) return;
    const problems = codeFragments(value);
    if (max && value.length > max) problems.unshift([`длиннее ${max} символов`, String(value.length)]);
    if (problems.length) out.push({ what, name: label, level, field, problems });
  };
  for (const [id, f] of fields) if (plain(id)) {
    const what = known.get(id)?.type === 'note' ? 'note' : 'block', level = levelOf(depth(id));
    check(what, name(id), level, 'название', f.title, maxTitle);
    check(what, name(id), level, 'текст', f.text, maxText);
  }
  for (const [id, label] of labels) {
    const e = edges.get(id);
    if (plain(e.source) && plain(e.target)) check('edge', `${name(e.source)}» → «${name(e.target)}`, levelOf(Math.max(depth(e.source), depth(e.target))), 'подпись', label, 0);
  }
  return out;
}
const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const kinds = { block: 'блок', note: 'заметка', edge: 'связь' };
export const levelAdvice = 'Уровни «Концепция» и «Механика» читают люди без программирования: код, файлы и имена переменных — в подкарту, на уровень «Техника»; исправь файл и повтори.';
// Текст отказа: каждое нарушение с блоком, уровнем и фрагментом, в конце — куда это перенести.
export function levelReport(problems) {
  return ['Запись отклонена, ничего не записано:',
    ...problems.map(p => `- ${kinds[p.what]} «${p.name}» (${p.level}), ${p.field}: ${p.problems.map(([what, fragment]) => /^длиннее/.test(what) ? `${what} (${fragment})` : `${what} «${fragment}»`).join('; ')}`),
    levelAdvice].join('\n');
}
