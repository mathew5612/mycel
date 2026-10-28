// Abstraction levels by nesting depth and the check of an agent's batch before writing. "Concept" and "Mechanics" (depth
// 0 and 1) are read by people who do not program: short there, without code, files and names from code. Only the fields
// the batch adds or changes are checked; old content and the person's edits from the interface are not checked.

export const levelNames = ['concept', 'mechanics', 'technical', 'code'];
export const levelOf = depth => levelNames[Math.min(depth, levelNames.length - 1)];
export const plainDepth = 1, maxTitle = 40, maxText = 200;

// Extensions of code and settings files. One-letter ones (c, h) only after a name of two characters or more: otherwise "a.c" from abbreviations.
const ext = 'mjs|cjs|jsx|js|tsx|ts|pyw|py|ipynb|rb|go|rs|java|kts|kt|scala|cs|cpp|cc|cxx|c|hpp|h|swift|php|lua|dart|exs|ex|erl|sh|bash|zsh|ps1|psm1|bat|cmd|sql|sqlite|db|jsonc|json|yaml|yml|toml|ini|cfg|conf|config|env|properties|xml|plist|gradle|lock|html|htm|css|scss|sass|less|vue|svelte|mdx|md|txt|log|tf|proto|graphql|gql|gitignore|dockerignore|npmrc|nvmrc|editorconfig|eslintrc|prettierrc|babelrc|bashrc|zshrc';
// A file name can also follow a path that isPath did not recognise (Controllers/HomeController.cs, Папка/main.py).
const fileRe = new RegExp(String.raw`(?<![\p{L}\p{N}_.-])[\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*\.(?:${ext})(?![\p{L}\p{N}_-])`, 'giu');
const fileName = new RegExp(String.raw`^[\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*\.(?:${ext})$`, 'iu');
const bareFiles = /\b(?:Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Jenkinsfile|Vagrantfile)\b/g;
// Node.js, Vue.js, D3.js are product names, not files.
const product = s => /^[A-Z][A-Za-z0-9]*\.js$/.test(s);
const isFile = s => !product(s) && (!/\.[ch]$/i.test(s) || /^[\p{L}\p{N}_-]{2,}\.[ch]$/iu.test(s));
// A path: an address, an absolute or relative path, a Windows drive, or ASCII words joined by / or \ among which there is
// a code file (UI/Button.tsx, /main.py) or a lowercase word of three letters or more (src/pay). "TCP/IP", "24/7", "км/ч",
// "Android/iOS", "Node.js/Express", "/start" are not paths, nor are two everyday English words ("and/or", "read/write").
const prose = new Set(('and or nor not but yes no on off in out up down true false he she him her his hers they them their we us you ' +
  'read write input output open close start stop begin end login logout upload download send receive buy sell add remove create delete ' +
  'edit view show hide save load import export before after day night week month year hour per either client server front back ' +
  'frontend backend left right top bottom plus minus win lose pass fail good bad new old male female man woman men women boy girl ' +
  'mom dad parent child student teacher user admin buyer seller question answer text voice photo video image audio light dark ' +
  'online offline mobile desktop web').split(' '));
function isPath(w) {
  if (!/[\\/]/.test(w)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w) || /^[A-Za-z]:[\\/]/.test(w)) return true;
  if (!/^[\w.~<>{}*@:-]*(?:[\\/][\w.~<>{}*@:-]*)+$/.test(w)) return false;
  const parts = w.split(/[\\/]/).filter(Boolean);
  if (parts.some(p => fileName.test(p) && isFile(p))) return true;
  if (/^(?:\.{1,2}|~)?[\\/]/.test(w)) return parts.length >= 2 && parts.some(p => /[A-Za-z]/.test(p));
  if (parts.length === 2 && parts.every(p => prose.has(p.toLowerCase()))) return false;
  return parts.length >= 2 && parts.some(p => /^[a-z0-9_.~-]{3,}$/.test(p) && /[a-z]/.test(p));
}
// A call: a name (dotted too) right before brackets, empty or with arguments: send(), send(message), create(...). In
// Russian text there is a space before the bracket: "ИИ (GPT-4o)", "Бот (Telegram)" are not calls; "ответ(ы)" in Cyrillic
// is not one either, and neither is an English plural ending: "answer(s)", "box(es)", "entr(ies)".
const callRe = /(?<![\p{L}\p{N}_$.-])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^()]*\)/gu;
const plural = m => /^[A-Za-z]+\((?:s|es|ies)\)$/.test(m);
// A dotted name: message.text, os.getenv, settings.DEBUG, JSON.parse, ChatCompletion.create. Not code: site addresses
// (openai.com, t.me, Booking.com), documents (photo.jpg), Node.js, ASP.NET, Yandex.Music, "e.g.", "a.m.".
const dottedRe = /(?<![\p{L}\p{N}_$.-])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?![\p{L}\p{N}_$-])/gu;
const site = /^(?:com|net|org|info|biz|edu|gov|ru|su|by|kz|ua|uz|me|io|ai|app|dev|co|uk|us|de|eu|tv|fm|ly|so|to|be|gg|cc|xyz|online|site|shop|tech|cloud|jpe?g|png|gif|webp|heic|svg|pdf|docx?|xlsx?|pptx?|odt|rtf|csv|mp3|mp4|m4a|mov|avi|mkv|webm|wav|ogg|oga|zip|rar|7z)$/i;
const dotted = m => {
  const parts = m.split('.'), first = parts[0], last = parts.at(-1);
  if (product(m) || site.test(last) || first.length < 2 || last.length < 2) return false;
  return /^[a-z_$]/.test(first) || /^[a-z_$]/.test(last);
};
// A Telegram user name and bot command (@study_buddy_bot, /set_language) are what the user types, not code.
const handle = String.raw`(?<!(?:^|[\s«"'(\[“„])[@/])`;
const snakeRe = new RegExp(String.raw`(?<![\w$])${handle}\w*_\w*(?![\w$])`, 'g');
// camelCase: a lowercase word of two letters or more, then a capital and a lowercase letter again (getResponse). Not iPhone, macOS, eBay.
const camelRe = new RegExp(String.raw`(?<![\w$])${handle}[a-z][a-z0-9]+[A-Z]+[a-z][A-Za-z0-9]*(?![\w$])`, 'g');
// A class: a capitalised word ending in a role from code (CartService, BotHandler, OpenAIClient, TypeError) or Async…
// (AsyncOpenAI). Not YouTube, OpenAI, WhatsApp, or "Service" on its own.
const classRe = /(?<![\w$])(?:[A-Z][A-Za-z0-9]*(?:Service|Handler|Client|Controller|Manager|Repository|Provider|Factory|Router|Middleware|Adapter|Dispatcher|Listener|Processor|Validator|Serializer|Helper|Utils|Exception|Error)|Async[A-Z][A-Za-z0-9]*)(?![\w$])/g;

// What in a text gives away code: [what, fragment]. Whatever is found is cut out so `get_response()` in backticks is not counted three times.
export function codeFragments(value) {
  let s = String(value ?? '');
  const found = [], take = (re, what, keep = () => true) => {
    s = s.replace(re, m => { if (!keep(m)) return m; found.push([what, m]); return ' '; });
  };
  take(/`[^`]*`?/g, 'code in backticks');
  s = s.split(/(\s+)/).map(word => {
    const w = word.replace(/^[«"'(\[“”„‘‚]+|[»"')\].,:;!?…“”’‘]+$/g, '');
    if (w && isPath(w)) { found.push(['file or path', w]); return ' '; }
    return word;
  }).join('');
  take(fileRe, 'file', isFile);
  take(bareFiles, 'file');
  take(callRe, 'function call', m => !plural(m));
  take(dottedRe, 'name from code', dotted);
  take(snakeRe, 'name from code', m => /[A-Za-z]/.test(m));
  take(camelRe, 'name from code');
  take(classRe, 'name from code');
  return found;
}

// Violations of the operations batch on top of the graph map (before writing). A node's depth follows its final nesting after the batch.
// Returns [{ what: 'block' | 'note' | 'edge', name, level, field, problems: [[what, fragment]] }].
// Final values are checked: a text added and corrected in the same batch is checked as corrected. A block is named the
// way the agent knows it: by its title before the batch, a new one by its title from the batch.
export function levelProblems(graph, operations) {
  const ops = Array.isArray(operations) ? operations.filter(isObject) : [];
  const parent = new Map(graph.nodes.map(n => [n.id, n.parentId ?? null])), known = new Map(graph.nodes.map(n => [n.id, n]));
  const edges = new Map(graph.edges.map(e => [e.id, { ...e }]));
  // Which block each note is attached to: a block moved to another level takes them along (as in applyOperations).
  const attached = new Map(graph.nodes.filter(n => n.type === 'note').map(n => [n.id, n.attachedTo ?? null]));
  // Fields the batch adds or changes. A node or link without an id gets a key with "#" (ids cannot contain it): nothing
  // refers to them.
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
    if (max && value.length > max) problems.unshift([`longer than ${max} characters`, String(value.length)]);
    if (problems.length) out.push({ what, name: label, level, field, problems });
  };
  for (const [id, f] of fields) if (plain(id)) {
    const what = known.get(id)?.type === 'note' ? 'note' : 'block', level = levelOf(depth(id));
    check(what, name(id), level, 'title', f.title, maxTitle);
    check(what, name(id), level, 'text', f.text, maxText);
  }
  for (const [id, label] of labels) {
    const e = edges.get(id);
    if (plain(e.source) && plain(e.target)) check('edge', `${name(e.source)}" → "${name(e.target)}`, levelOf(Math.max(depth(e.source), depth(e.target))), 'label', label, 0);
  }
  return out;
}
const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const kinds = { block: 'block', note: 'note', edge: 'link' };
export const levelAdvice = 'The "Concept" and "Mechanics" levels are read by people who do not program: move code, files and variable names into a sub-map, to the "Technical" level; fix the file and try again.';
// The refusal text: every violation with its block, level and fragment, and at the end where to move it.
export function levelReport(problems) {
  return ['Write rejected, nothing was written:',
    ...problems.map(p => `- ${kinds[p.what]} "${p.name}" (${p.level}), ${p.field}: ${p.problems.map(([what, fragment]) => /^longer than/.test(what) ? `${what} (${fragment})` : `${what} "${fragment}"`).join('; ')}`),
    levelAdvice].join('\n');
}
