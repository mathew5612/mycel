import http from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { gzipSync } from 'node:zlib';
import { applyOperations, propose, acceptProposal, rejectProposal, review, reviewText, statusNames, nodeName, Problem } from './src/model.mjs';
import { openHub, lockHub } from './src/hub.mjs';
import { realDir, defaultData } from './src/paths.mjs';
import { renderGuide, editingLine } from './src/guide.mjs';
import { openAccess } from './src/access.mjs';
import { levelNames, levelOf } from './src/levels.mjs';

const appRoot = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
const publicGraph = graph => { const { history, ...rest } = graph; return rest; };
// Abstraction level by nesting depth: concept, mechanics, technical, code (everything deeper).
export { levelNames };
const proposedNames = { add: 'add', change: 'change', remove: 'remove' };
// A node and everything in its sub-maps.
const subtreeIds = (graph, id) => {
  const inside = new Set([id]);
  for (let changed = true; changed; ) { changed = false; for (const n of graph.nodes) if (!inside.has(n.id) && inside.has(n.parentId)) { inside.add(n.id); changed = true; } }
  return inside;
};
// The map in Markdown for an agent. focusId shows only this block with everything nested and its links to the rest of
// the map: an agent working on one module does not need to read everything. humanFocus is what the person is working on
// now. brief leaves out coordinates and sizes: an agent that only reads what the map means does not need them. edit means
// the person is editing the map now and has not clicked "Finish edits" yet. selection is what the person selected on the
// map. code holds outdated blocks (their files changed after they were described) and who is working on what.
function context(graph, focusId = null, humanFocus = null, brief = false, edit = null, selection = null, code = null) {
  const stale = code?.stale ?? {}, work = code?.work ?? [];
  const title = id => graph.nodes.find(n => n.id === id)?.title || id;
  const at = parentId => graph.nodes.filter(n => n.parentId === parentId);
  const blocks = graph.nodes.filter(n => n.type !== 'note'), mark = x => x.proposed ? ` | proposed: ${proposedNames[x.proposed]}` : '';
  const selected = selection && graph.nodes.find(n => n.id === selection);
  const focus = focusId && graph.nodes.find(n => n.id === focusId && n.type === 'block');
  if (focusId && !focus) throw new Problem('Focus block not found.');
  const inside = focus ? subtreeIds(graph, focus.id) : null;
  const lines = ['# Map', `Revision: ${graph.revision}`, '', `Blocks: ${blocks.length}, notes: ${graph.nodes.length - blocks.length}, links: ${graph.edges.length}.`, '',
    ...(humanFocus ? [`The person is focused on block "${title(humanFocus)}" (${humanFocus}): answer and work within it.`, ''] : []),
    ...(selected ? [`The person selected the ${selected.type === 'note' ? 'note' : 'block'} "${nodeName(selected)}" (${selected.id}) on the map: "this", "this block" in their words most likely means it.`, ''] : []),
    ...(edit ? [editingLine(edit), ''] : []),
    ...(graph.proposal ? [`Open proposal "${graph.proposal.title}" (${graph.proposal.by}): ${['add', 'change', 'remove'].map(k => `${proposedNames[k]}: ${graph.nodes.filter(n => n.proposed === k).length}`).join(', ')}. The person accepts or rejects it; to extend it use mycel propose, to adjust the proposed cards use mycel apply.`, ''] : []),
    ...(graph.nodes.some(n => n.status) ? ['Block marks (shown by the border): "planned, no code yet" is dashed, logic without finished code; "checking now" pulses; "passed" is green, the code is written and the tests passed; "failed" is red.', ''] : []),
    ...(Object.keys(stale).length ? [`Possibly outdated (their files changed after the block was described): ${Object.entries(stale).map(([id, s]) => `"${title(id)}" (${id}): ${s.files.join(', ')}`).join('; ')}. Update the text of these blocks or confirm it is still right: mycel fresh <id>.`, ''] : []),
    ...(work.length ? [`Working now: ${work.map(w => `${w.actor} on ${w.blocks.map(id => `"${title(id)}" (${id})`).join(', ') || w.files.join(', ')}`).join('; ')}. Do not take up other agents' blocks unless the person asks.`, ''] : []),
    ...(focus ? [`Showing only the focus: "${title(focus.id)}" with everything nested in it and its links to the rest of the map.`, ''] : []),
    brief ? 'A block can contain a sub-map: nested blocks and notes (parentId is the block id). A note can be attached to a block on its own level (attachedTo).'
      : 'A block can contain a sub-map: nested blocks and notes (parentId is the block id). Their x and y are measured from the top-left corner of the sub-map field, which lies inside the block frame under its header. A block\'s w and h are its own size; an expanded sub-map grows on screen to fit its content. A note can be attached to a block on its own level (attachedTo).', '',
    'Abstraction levels follow nesting. Concept (blocks of the main map) and Mechanics (their sub-maps) are for people who do not program: what it is and how it works, a title of 1–4 simple words, the text is one short sentence, links are labelled in simple words; no code, files or names from code. Technical (sub-maps of Mechanics) is for developers: components, files and libraries in `backticks`, settings, data, technical risks as notes. Code (sub-maps of Technical and deeper) is steps in execution order: the title is an action, the text names the function and file in `backticks`.', ''];
  const block = (n, depth) => {
    const level = at(n.parentId);
    lines.push(`${'#'.repeat(Math.min(depth + 3, 6))} ${n.title || 'untitled'}`, `ID: ${n.id} | level: ${levelOf(depth)}${brief ? '' : ` | x: ${n.x}, y: ${n.y}, w: ${n.w}, h: ${n.h}`}${n.color ? ` | color: ${n.color}` : ''}${n.parentId ? ` | inside: ${n.parentId}` : ''}${n.collapsed ? ' | sub-map collapsed' : ''}${n.status ? ` | ${statusNames[n.status]}` : ''}${stale[n.id] ? ' | possibly outdated' : ''}${mark(n)}`);
    if (n.text) lines.push('', n.text);
    if (n.files) lines.push('', `Files: ${n.files.join(', ')}`);
    if (n.test) lines.push('', `Test command: \`${n.test}\``);
    for (const note of level.filter(x => x.type === 'note' && x.attachedTo === n.id)) lines.push('', `Note (${note.id})${mark(note)}: ${note.text}`);
    lines.push('');
    visit(n.id, depth + 1);
  };
  const visit = (parentId, depth) => {
    const level = at(parentId);
    for (const n of level.filter(x => x.type !== 'note')) block(n, depth);
    const free = level.filter(x => x.type === 'note' && x.attachedTo === null);
    if (free.length) { lines.push(`${parentId ? `Notes inside "${title(parentId)}" (${parentId})` : '## Notes'}`); for (const n of free) lines.push(`- (${n.id})${mark(n)} ${n.text}`); lines.push(''); }
  };
  if (focus) { let depth = 0; for (let p = focus.parentId; p; p = graph.nodes.find(n => n.id === p)?.parentId) depth++; block(focus, depth); }
  else visit(null, 0);
  // The link id is for update-edge and delete-edge.
  const edge = e => `- ${title(e.source)} (${e.source}) → ${title(e.target)} (${e.target})${e.label ? `: ${e.label}` : ''} · id: ${e.id}${mark(e)}`;
  if (focus) {
    lines.push('## Links inside', ...graph.edges.filter(e => inside.has(e.source) && inside.has(e.target)).map(edge), '');
    lines.push('## Links to the rest of the map', ...graph.edges.filter(e => inside.has(e.source) !== inside.has(e.target)).map(edge));
  } else lines.push('## Links', ...graph.edges.map(edge));
  return lines.join('\n');
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new Problem('Use Content-Type: application/json.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Problem('The request body is larger than 1 MB.', 413); chunks.push(chunk); }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new Problem('Invalid JSON object.'); }
}
// The API token survives a restart: open tabs and agents do not lose access. A new one is made only if the file is missing.
async function apiToken(data) {
  const file = join(data, 'token'), old = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (/^[A-Za-z0-9_-]{16,256}$/.test(old)) return old;
  const token = randomBytes(32).toString('hex');
  await writeFile(file, token + '\n', { mode: 0o600 });
  return token;
}
const isCount = v => v == null || (Number.isSafeInteger(v) && v >= 0);

// The computer's network adapters (IPv4, except loopback); vm marks a virtual machine adapter (VMware, VirtualBox, Hyper-V, WSL).
const interfaces = () => Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter(i => i.family === 'IPv4' && !i.internal)
  .map(i => ({ name, address: i.address, vm: /vmware|vmnet|virtualbox|vboxnet|hyper-v|vethernet|wsl|virbr|utun|bridge100/i.test(name) })));
const readCookie = (header, name) => (header ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
// A copy of Mycel for a virtual machine: the program without data and tests, as a tar.gz archive (ustar), so it installs
// with one command: curl … | tar xz.
async function bundle() {
  const files = ['mycel.mjs', 'mcp.mjs', 'server.mjs', 'package.json', 'README.md', 'docs/reference.md', 'LICENSE', 'Mycel.command'];
  for (const dir of ['src', 'public']) for (const name of (await readdir(join(appRoot, dir))).sort()) files.push(`${dir}/${name}`);
  const blocks = [], mtime = Math.floor(Date.now() / 1000);
  for (const name of files) {
    const body = await readFile(join(appRoot, name)), head = Buffer.alloc(512);
    const put = (text, at, size) => head.write(text, at, size, 'utf8');
    put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
    put(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12); put(`${mtime.toString(8).padStart(11, '0')}\0`, 136, 12);
    put('        ', 148, 8); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
    put(`${head.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(head, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

// Installation in a virtual machine (Linux, macOS): Node.js 22+, the system one or the official one from nodejs.org with a
// SHA-256 check in ~/.mycel-node, a copy of Mycel from the main computer in ~/mycel (MYCEL_DIR), then an access request
// (join): the machine gets its key when the person clicks "Allow". For a copy that is already connected, running it again only updates it.
const installScript = origin => `#!/bin/sh
# Mycel for this machine: Node.js 22+, a copy of Mycel and an access request to Mycel on the main computer (${origin}).
set -e
HOST="${origin}"
DIR="\${MYCEL_DIR:-$HOME/mycel}"
fit() { command -v "$1" >/dev/null 2>&1 && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; }
NODE=node
if ! fit node; then
  NODE="$HOME/.mycel-node/bin/node"
  if ! fit "$NODE"; then
    case "$(uname -s)" in Linux) os=linux;; Darwin) os=darwin;; *) echo "Install Node.js 22+ yourself: https://nodejs.org"; exit 1;; esac
    case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "Install Node.js 22+ yourself: https://nodejs.org"; exit 1;; esac
    base=https://nodejs.org/dist/latest-v22.x
    line=$(curl -fsSL "$base/SHASUMS256.txt" | grep " node-v22[.0-9]*-$os-$arch.tar.gz$" | head -n 1)
    [ -n "$line" ] || { echo "Could not find Node.js 22 for $os-$arch on nodejs.org"; exit 1; }
    file=\${line##* }; sum=\${line%% *}; tmp=$(mktemp -d)
    echo "Downloading $file…"
    curl -fsSL "$base/$file" -o "$tmp/$file"
    got=$( (sha256sum "$tmp/$file" 2>/dev/null || shasum -a 256 "$tmp/$file") | cut -d ' ' -f 1)
    [ "$got" = "$sum" ] || { echo "The Node.js checksum does not match, not installing."; rm -rf "$tmp"; exit 1; }
    mkdir -p "$HOME/.mycel-node"
    tar xzf "$tmp/$file" -C "$HOME/.mycel-node" --strip-components=1
    rm -rf "$tmp"
  fi
fi
mkdir -p "$DIR"
curl -fsS "$HOST/download/mycel.tar.gz" | tar xz -C "$DIR"
echo "Mycel: $DIR, node: $NODE"
# The copy is already connected: this is an update, access stays the same.
if [ -f "$DIR/.mycel/remote.json" ] && [ $# -eq 0 ]; then echo "Mycel updated, the connection stays the same."; exit 0; fi
exec "$NODE" "$DIR/mycel.mjs" join "$HOST" "$@"
`;

// One process for all projects. onStop is how to stop the process on the mycel.mjs stop command; without it the hub is
// stopped only by whoever started it. listen holds addresses for virtual machines instead of listen.json (for tests).
export async function startServer({ data, port = 4317, onStop = null, listen = null } = {}) {
  data = resolve(data ?? (process.env.MYCEL_DATA || process.env.KONTUR_DATA || defaultData(appRoot)));
  await mkdir(data, { recursive: true }); data = realDir(data);
  const lock = await lockHub(data, port);
  let hub = null, token, access = null;
  try { token = await apiToken(data); hub = await openHub(data); access = await openAccess(data, () => hub.notify({ access: accessInfo() })); }
  catch (e) { await hub?.close(); await lock.release(); throw e; }
  // Access requests and machines with access, for the "Allow" card and the machine list on the main computer.
  const accessInfo = () => ({ pending: access.pending(), devices: access.devices(), projects: hub.list().map(p => ({ id: p.id, name: p.name })) });
  const auth = value => {
    const actual = Buffer.from(value ?? ''); const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  // Virtual machines (mycel remote): each address from listen.json gets its own server with the same handler and port.
  const listenFile = join(data, 'listen.json'), remotes = new Map();
  const openRemote = address => new Promise(done => {
    const s = http.createServer((req, res) => handle(req, res, address));
    s.requestTimeout = 15000; s.headersTimeout = 10000;
    s.once('error', e => { remotes.set(address, { server: null, error: e.code === 'EADDRNOTAVAIL' ? 'this computer has no such address right now' : e.code === 'EADDRINUSE' ? 'the port is in use on this address' : e.message }); done(); });
    s.listen(server.address().port, address, () => { remotes.set(address, { server: s, error: null }); done(); });
  });
  const closeRemote = async address => {
    const r = remotes.get(address); remotes.delete(address);
    if (r?.server) await new Promise(ok => { r.server.close(ok); r.server.closeAllConnections(); });
  };
  const setRemotes = async addresses => {
    for (const a of [...remotes.keys()]) if (!addresses.includes(a)) await closeRemote(a);
    for (const a of addresses) if (!remotes.get(a)?.server) await openRemote(a);
  };
  const remoteInfo = () => [...remotes].map(([address, r]) => ({ address, listening: Boolean(r.server), ...(r.error ? { error: r.error } : {}) }));
  const handle = async (req, res, remote) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    let p = null;
    try {
      const actualPort = server.address().port;
      const hosts = remote ? [`${remote}:${actualPort}`] : [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!hosts.includes(req.headers.host)) throw new Problem('Host not allowed.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      // From a virtual machine, only with a key: a Bearer header (agent) or the cookie set by the /?key=… link
      // (browser). Without a key one only sees that this is Mycel and which version; starting, stopping, connecting
      // folders and setting up access happen only on the main computer.
      // The key is the main computer's token or the key of a machine that got access through a request (src/access.mjs).
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
      const valid = key => typeof key === 'string' && key !== '' && (auth(`Bearer ${key}`) || Boolean(access.check(key)));
      // device is a machine with its own key: its projects and folders are its own (src/hub.mjs, machine).
      let usedKey = null, device = null;
      if (remote) {
        const presented = bearer ?? readCookie(req.headers.cookie, 'mycel_key'), keyed = valid(presented);
        if (keyed) { usedKey = presented; device = access.check(presented); }
        if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('key')) {
          const key = url.searchParams.get('key');
          if (!valid(key)) throw new Problem('The key does not fit: ask for access again (node mycel.mjs join <address>).', 401);
          res.writeHead(303, { Location: '/', 'Set-Cookie': `mycel_key=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` }); return res.end();
        }
        if (req.method === 'GET' && url.pathname === '/api/health') return send(200, keyed ? { ok: true, app: 'mycel', version, data } : { ok: true, app: 'mycel', version });
        // Without a key: the agent guide, installing a copy of Mycel and the access request; this way the agent in a
        // virtual machine sets everything up itself, and the person only clicks "Allow".
        const open = (req.method === 'GET' && (['/agent', '/install.sh', '/download/mycel.tar.gz'].includes(url.pathname) || /^\/api\/pair\/[^/]+$/.test(url.pathname))) || (req.method === 'POST' && url.pathname === '/api/pair');
        if (!keyed && !open) {
          const hint = `The agent in this machine installs Mycel and asks for access itself: curl -fsS http://${remote}:${actualPort}/install.sh | sh, then the person clicks "Allow" in Mycel on the main computer.`;
          if (req.method === 'GET' && url.pathname === '/') return send(401, `This is Mycel on the main computer. ${hint}`, 'text/plain; charset=utf-8');
          throw new Problem(`A Mycel key is required. ${hint}`, 401);
        }
        if (req.method === 'POST' && url.pathname === '/api/projects' && !device) throw new Problem('A project for a folder of this machine is created by the machine with its own key: node mycel.mjs join <address> without a key, and the person clicks "Allow".', 403);
        if (['/api/remote', '/api/access'].includes(url.pathname) || /^\/api\/(pair\/[^/]+\/(approve|deny)|devices\/)/.test(url.pathname) || (req.method === 'POST' && url.pathname === '/api/stop')) throw new Problem('This is done on the main computer: stopping Mycel, opening access and answering access requests.', 403);
      }
      // The agent guide can be opened from anywhere (curl, a browser, another site): it holds no token, so only Host is checked.
      if (req.method === 'GET' && url.pathname === '/agent') return send(200, await renderGuide({ url: `http://${remote ?? '127.0.0.1'}:${actualPort}`, remote: remote ? 'served' : null }), 'text/plain; charset=utf-8');
      if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) throw new Problem('Requests from another origin are not allowed.', 403);
      if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) throw new Problem('Open the app directly on localhost.', 403);
      if (!['GET', 'POST'].includes(req.method)) throw new Problem('Method not supported.', 405);
      // An access request from a virtual machine is the only write without a key.
      if (req.method === 'POST' && !valid(bearer) && !(remote && url.pathname === '/api/pair')) throw new Problem('A Bearer token from the data folder is required.', 401);
      const get = path => req.method === 'GET' && url.pathname === path, post = path => req.method === 'POST' && url.pathname === path;

      if (get('/api/health')) return send(200, { ok: true, app: 'mycel', version, data });
      // From a virtual machine the session returns the key the request came with: the main computer's token does not go over the network.
      if (get('/api/session')) return send(200, { token: usedKey ?? token, data, port: actualPort, platform: process.platform });
      // Installing Mycel in a virtual machine: Node.js 22+ (if missing, into ~/.mycel-node), a copy in ~/mycel, an access request.
      if (get('/install.sh')) return send(200, installScript(`http://${remote ?? '127.0.0.1'}:${actualPort}`), 'text/x-shellscript; charset=utf-8');
      // Access request: the machine gets a code (the person checks it) and a secret for picking up the key after "Allow".
      if (post('/api/pair')) {
        if (!remote) throw new Problem('Access is requested from a virtual machine.', 404);
        const b = await jsonBody(req);
        return send(200, access.request(b.name, req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? remote));
      }
      const pair = /^\/api\/pair\/([^/]+)(?:\/(approve|deny))?$/.exec(url.pathname);
      if (pair && req.method === 'GET' && !pair[2]) return send(200, access.poll(pair[1], url.searchParams.get('secret')));
      if (pair && req.method === 'POST' && pair[2]) {
        const b = await jsonBody(req);
        if (pair[2] === 'deny') { access.deny(pair[1]); return send(200, accessInfo()); }
        if (b.project != null && !hub.list().some(x => x.id === b.project)) throw new Problem('No such project.');
        await access.approve(pair[1], b.project ?? null);
        return send(200, accessInfo());
      }
      if (get('/api/access')) return send(200, accessInfo());
      const revoke = req.method === 'POST' && /^\/api\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
      if (revoke) { await jsonBody(req); await access.revoke(revoke[1]); return send(200, accessInfo()); }
      // Without path, all projects; with path, the project whose folder contains it (mycel.mjs from any subfolder).
      if (get('/api/projects')) {
        const path = url.searchParams.get('path');
        return send(200, path === null ? { projects: hub.list() } : hub.lookup(path, url.searchParams.get('root'), device?.id ?? null));
      }
      if (post('/api/projects')) return send(200, await hub.connect(await jsonBody(req), device ? { id: device.id, name: device.name } : null));
      const action = req.method === 'POST' && /^\/api\/projects\/([^/]+)\/(delete|restore)$/.exec(url.pathname);
      if (action) { await jsonBody(req); return send(200, await (action[2] === 'delete' ? hub.remove(action[1]) : hub.restore(action[1]))); }
      // The home page: creating, deleting and moving projects, map edits, chat and agent presence.
      if (get('/api/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ projects: hub.seq })}\n\n`); hub.streams.add(res);
        req.on('close', () => hub.streams.delete(res)); return;
      }
      if (post('/api/stop')) {
        if (!onStop) throw new Problem('This server is stopped by whoever started it.', 404);
        send(200, { stopping: true }); setImmediate(onStop); return;
      }
      // Access for virtual machines: on which addresses of this computer Mycel takes their requests (with a key).
      // An empty list closes access. Only addresses of this computer's network adapters; the setting is in listen.json.
      if (get('/api/remote')) return send(200, { port: actualPort, listening: remoteInfo(), interfaces: interfaces() });
      if (post('/api/remote')) {
        const b = await jsonBody(req), own = new Set(interfaces().map(i => i.address));
        if (!Array.isArray(b.addresses) || b.addresses.length > 8 || !b.addresses.every(a => typeof a === 'string' && own.has(a))) throw new Problem('addresses: addresses of this computer\'s network adapters (mycel remote shows them).');
        const addresses = [...new Set(b.addresses)];
        await writeFile(listenFile, JSON.stringify({ addresses }, null, 2) + '\n');
        await setRemotes(addresses);
        return send(200, { port: actualPort, listening: remoteInfo(), interfaces: interfaces() });
      }
      const scoped = /^\/api\/p\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (scoped) {
        p = hub.route(scoped[1]);
        p.touch(req.headers['x-mycel-actor']);
        return await projectRoute(req, res, url, scoped[2] ?? '', p, send);
      }
      // A copy of Mycel for a virtual machine (from inside it, only with a key, like everything else).
      if (get('/download/mycel.tar.gz')) {
        res.setHeader('Content-Disposition', 'attachment; filename="mycel.tar.gz"');
        return send(200, await bundle(), 'application/gzip');
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname]; return send(200, await readFile(join(appRoot, 'public', file)), `${type}; charset=utf-8`);
      }
      throw new Problem('Route not found.', 404);
    } catch (error) {
      if (res.headersSent) return res.end();
      if (!(error instanceof Problem)) console.error(error);
      send(error.status ?? 500, { error: error instanceof Problem ? error.message : 'Internal server error. Details are in the terminal.', ...error.extra, ...(p?.store ? { revision: p.store.peek().revision } : {}) });
    }
  };
  const server = http.createServer((req, res) => handle(req, res, null));
  // Routes of one project: the same as the single-map server had, under /api/p/<id>.
  async function projectRoute(req, res, url, route, p, send) {
    const get = r => req.method === 'GET' && route === r, post = r => req.method === 'POST' && route === r;
    // The project may have been deleted while the request body was read: then the write does not go into a closed map.
    const body = async () => { const value = await jsonBody(req); if (hub.route(p.id) !== p) throw new Problem('Project deleted.', 404); return value; };
    if (get('')) return send(200, { project: p.info() });
    if (get('/graph')) return send(200, publicGraph(p.store.get()));
    if (get('/history')) return send(200, { history: p.store.get().history.slice().reverse() });
    if (get('/export')) {
      res.setHeader('Content-Disposition', `attachment; filename="mycel-${p.id}.json"`); return send(200, p.store.get());
    }
    if (get('/context')) return send(200, context(p.store.get(), url.searchParams.get('focus'), p.focus, url.searchParams.get('brief') === '1', p.editInfo(), p.selection, { ...p.codeInfo(), work: p.work() }), 'text/markdown; charset=utf-8');
    // Review by map: what changed in how the project is built after revision since or over the last hours hours.
    if (get('/review')) {
      const graph = p.store.get(), since = url.searchParams.get('since'), hours = url.searchParams.get('hours');
      let entries;
      if (since !== null) {
        if (!Number.isSafeInteger(Number(since)) || Number(since) < 0) throw new Problem('since: a revision, an integer from 0.');
        entries = graph.history.filter(h => h.revision > Number(since));
      } else {
        const h = Number(hours ?? 24);
        if (!Number.isFinite(h) || h <= 0 || h > 24 * 365) throw new Problem('hours: a number of hours, greater than 0.');
        entries = graph.history.filter(e => Date.now() - Date.parse(e.at) <= h * 3600e3);
      }
      const r = review(graph, entries);
      return send(200, { ...r, text: reviewText(r) });
    }
    // Code: which files agents are editing (the hook after a file edit), outdated blocks, risks, who is working on what.
    if (get('/code')) {
      const nodes = new Map(p.store.peek().nodes.map(n => [n.id, n])), info = p.codeInfo();
      return send(200, { stale: Object.entries(info.stale).map(([id, s]) => ({ id, name: nodeName(nodes.get(id)), ...s })), risks: info.risks, work: p.work() });
    }
    if (post('/touch')) {
      const b = await body();
      if (typeof b.actor !== 'string' || !b.actor || b.actor === 'human' || b.actor.length > 100) throw new Problem('Give the agent\'s actor (up to 100 characters).');
      if (!Array.isArray(b.files) || !b.files.length || b.files.length > 50 || !b.files.every(f => typeof f === 'string' && f && f.length <= 300)) throw new Problem('files: 1 to 50 paths from the project root.');
      if (!(b.session == null || (typeof b.session === 'string' && b.session.length <= 100))) throw new Problem('session: the agent\'s session id, up to 100 characters.');
      p.touch(b.actor);
      return send(200, p.touchFiles(b.actor, b.files.map(f => f.replace(/\\/g, '/')), b.session ?? null));
    }
    // The agent confirms that the block descriptions are right (or described them again): the "outdated?" flag is cleared.
    if (post('/fresh')) {
      const b = await body();
      if (!(b.ids === null || (Array.isArray(b.ids) && b.ids.every(id => typeof id === 'string')))) throw new Problem('ids: a list of block ids, or null (all).');
      p.touch(b.actor);
      return send(200, { fresh: p.freshen(b.ids) });
    }
    // Risks that mycel health found in block files: numbers, without the contents of lines.
    if (post('/risks')) {
      const b = await body(), ids = new Set(p.store.peek().nodes.map(n => n.id)), count = v => Number.isSafeInteger(v) && v >= 0 && v <= 1e6;
      if (!b.blocks || typeof b.blocks !== 'object' || Array.isArray(b.blocks) || !Object.entries(b.blocks).every(([id, r]) => ids.has(id) && r && count(r.todo) && count(r.secrets))) throw new Problem('blocks: { block id: { todo, secrets } } with integers.');
      p.touch(b.actor);
      const at = new Date().toISOString();
      p.setRisks(Object.fromEntries(Object.entries(b.blocks).filter(([, r]) => r.todo || r.secrets).map(([id, r]) => [id, { todo: r.todo, secrets: r.secrets, at }])));
      return send(200, { risks: p.codeInfo().risks });
    }
    // The person asks to check blocks (the "Check" button in the block menu): the event wakes agents, an agent does the check.
    if (post('/check')) {
      const b = await body(), nodes = p.store.peek().nodes;
      if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 100 || !b.ids.every(id => nodes.some(n => n.id === id && n.type === 'block'))) throw new Problem('ids: the blocks to check.');
      const names = b.ids.map(id => nodeName(nodes.find(n => n.id === id)));
      const message = await p.chat.add({ author: 'human', kind: 'check', text: `Check: ${names.map(n => `"${n}"`).join(', ')}`, check: { ids: b.ids, names } });
      p.chatted();
      return send(200, { message });
    }
    // The person's focus: which block they are working on now. Kept while the hub runs; agents see it in context and changes.
    if (post('/focus')) {
      const id = (await body()).id ?? null;
      if (id !== null && !p.store.get().nodes.some(n => n.id === id && n.type === 'block')) throw new Problem('Focus block not found.');
      p.focus = id; p.broadcast({ focus: id });
      return send(200, { focus: id });
    }
    if (get('/changes')) {
      const since = Number(url.searchParams.get('since') ?? NaN), exclude = url.searchParams.get('exclude') ?? '', wait = Number(url.searchParams.get('wait') ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) throw new Problem('Give since: the revision after which changes are needed.');
      if (!Number.isFinite(wait) || wait < 0 || wait > 300) throw new Problem('wait: waiting time in seconds, from 0 to 300.');
      // content=1: wait for a content edit, collecting moves, sizes and collapsing until then.
      // chat=N: also wait for chat messages after change N; they always wake. The person's edits that they have not
      // finished yet (held) do not wake.
      const content = url.searchParams.get('content') === '1', chatParam = url.searchParams.get('chat'), chatSince = chatParam === null ? null : Number(chatParam);
      if (chatSince !== null && (!Number.isSafeInteger(chatSince) || chatSince < 0)) throw new Problem('chat: a chat change number, an integer from 0.');
      const ready = r => !r.complete || (content ? r.contentChanged : r.entries.length > r.held) || r.chat?.messages.length > 0;
      const now = p.changesSince(since, exclude, chatSince);
      if (!wait || ready(now)) return send(200, now);
      // A long request: a check after every write, an early answer when the hub stops and 404 when the project is deleted.
      let done = false;
      const stop = () => { if (done) return; done = true; clearTimeout(timer); p.waiters.delete(check); p.touch(exclude, -1); };
      const finish = (status = 200, value) => { stop(); if (!res.writableEnded) send(status, value ?? p.changesSince(since, exclude, chatSince)); };
      const check = () => { if (ready(p.changesSince(since, exclude, chatSince))) finish(); };
      const timer = setTimeout(finish, wait * 1000);
      p.waiters.set(check, finish);
      p.touch(exclude, 1);
      res.on('close', stop);
      return;
    }
    if (get('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(p.state())}\n\n`); p.sessions.add(res);
      req.on('close', () => p.sessions.delete(res)); return;
    }
    if (post('/changes')) {
      const b = await body();
      const result = await p.store.commit(b.expectedRevision, b.actor, b.message, graph => applyOperations(graph, b.operations));
      await p.startEdit(result.history.at(-1), result.revision - 1);
      // The agent described a block again (title, text, files, test command): the "outdated?" flag is cleared from it.
      const delta = result.history.at(-1)?.delta;
      if (b.actor !== 'human' && delta) p.freshen(Object.entries(delta.nodes.updated).filter(([, f]) => f.some(k => ['title', 'text', 'files', 'test'].includes(k))).map(([id]) => id));
      p.committed();
      return send(200, publicGraph(result));
    }
    // An agent proposal: the batch lands on the map with marks (src/model.mjs, propose), the next one extends the open one.
    if (post('/proposal')) {
      const b = await body(), title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : p.store.peek().proposal?.title ?? '';
      const result = await p.store.commit(b.expectedRevision, b.actor, `Proposal "${title}"`, graph => propose(graph, b.operations, { title: b.title, by: b.actor, at: new Date().toISOString() }));
      p.committed();
      return send(200, publicGraph(result));
    }
    // The person accepts or rejects a proposal. Their edits since the start go to agents together with the decision in
    // one chat message, which is also what wakes the agents.
    if (post('/proposal/accept') || post('/proposal/reject')) {
      await body();
      const accept = route.endsWith('accept'), open = p.store.peek().proposal, verb = accept ? 'Accepted' : 'Rejected';
      if (!open) throw new Problem('There is no open proposal.', 409);
      // The person's edits are those before the decision: the decision entry itself is not part of them.
      const pending = p.editInfo(), edits = pending && { ...pending, until: p.store.peek().revision };
      let result;
      // The write goes on top of the current revision: the agent may have extended the proposal while the person clicked the button.
      for (let i = 0; ; i++) {
        try { result = await p.store.commit(p.store.peek().revision, 'human', `${verb} proposal "${open.title}"`, accept ? acceptProposal : rejectProposal); break; }
        catch (e) { if (e.status !== 409 || i >= 3) throw e; }
      }
      // The decision message comes before the agents wake up: they get it together with the map changes.
      await p.endEdit();
      const message = await p.chat.add({ author: 'human', kind: 'proposal', text: `${verb} proposal "${open.title}"`, proposal: { title: open.title, by: open.by, result: accept ? 'accepted' : 'rejected', ...(edits ? { edits } : {}) } });
      p.committed(); p.chatted();
      return send(200, { graph: publicGraph(result), message });
    }
    // "Finish edits": the person's edits since the start go to agents in one chat message, which is also what wakes them.
    if (post('/edits')) {
      await body();
      const edits = await p.endEdit();
      if (!edits) return send(200, { message: null });
      const message = await p.chat.add({ author: 'human', kind: 'edits', text: 'Map edits finished', edits });
      p.chatted();
      return send(200, { message });
    }
    // Events for agents: what the person did with Mycel buttons (finished edits, decided on a proposal), and the earlier
    // conversation of projects that had a chat. since is the event change number. Nothing can be written here from
    // outside: the conversation with the agent happens in its window.
    if (get('/chat')) {
      const since = url.searchParams.get('since');
      if (since !== null && (!Number.isSafeInteger(Number(since)) || Number(since) < 0)) throw new Problem('since: an event change number, an integer from 0.');
      return send(200, { seq: p.chat.seq, messages: since === null ? p.chat.recent(200) : p.chat.since(Number(since)), agents: p.presence() });
    }
    // What the agent is doing now: a line under the map. text: null clears it; progress is 0–100 if known; auto: true —
    // the line comes from the agent's hooks.
    if (post('/activity')) {
      const b = await body();
      if (typeof b.actor !== 'string' || !b.actor || b.actor === 'human' || b.actor.length > 100) throw new Problem('Give the agent\'s actor (up to 100 characters).');
      if (b.text !== null && !(typeof b.text === 'string' && b.text.trim() && b.text.length <= 200)) throw new Problem('text: what the agent is doing now, up to 200 characters, or null.');
      if (!(b.progress == null || (Number.isFinite(b.progress) && b.progress >= 0 && b.progress <= 100))) throw new Problem('progress: a number from 0 to 100.');
      const nodes = p.store.peek().nodes, blocks = b.blocks ?? [];
      if (!Array.isArray(blocks) || blocks.length > 50 || !blocks.every(id => nodes.some(n => n.id === id && n.type === 'block'))) throw new Problem('blocks: ids of the blocks the agent is working on.');
      p.touch(b.actor); p.setActivity(b.actor, b.text?.trim() ?? null, b.progress, blocks, b.auto === true);
      return send(200, { activity: p.activityList(), others: p.others(b.actor, blocks) });
    }
    // The agent shows the person a block: the project's open pages go to it (into its sub-map) and select it.
    if (post('/show')) {
      const b = await body();
      if (!p.store.get().nodes.some(n => n.id === b.id)) throw new Problem('Block to show not found.');
      p.touch(b.actor); p.broadcast({ show: b.id, by: typeof b.actor === 'string' ? b.actor : null });
      return send(200, { shown: b.id });
    }
    // What the person selected on the map: a block or a note (the interface reports it). Together with the focus, it tells what they are talking to the agent about.
    if (post('/selection')) {
      const id = (await body()).id ?? null;
      if (id !== null && !p.store.get().nodes.some(n => n.id === id)) throw new Problem('Node not found.');
      p.selection = id;
      return send(200, { selection: id });
    }
    if (get('/selection')) {
      const nodes = p.store.peek().nodes, alive = id => id && nodes.some(n => n.id === id) ? id : null;
      return send(200, { focus: alive(p.focus), selection: alive(p.selection) });
    }
    // What the agent has already read: the map revision and the chat change. mycel.mjs keeps this only here.
    if (get('/cursor')) {
      const actor = url.searchParams.get('actor');
      if (!actor || actor.length > 100) throw new Problem('Give actor (up to 100 characters).');
      return send(200, await p.cursor(actor));
    }
    if (post('/cursor')) {
      const b = await body();
      if (typeof b.actor !== 'string' || !b.actor || b.actor.length > 100) throw new Problem('Give actor (up to 100 characters).');
      if (!isCount(b.revision) || !isCount(b.chat)) throw new Problem('revision and chat: integers from 0.');
      return send(200, await p.saveCursor(b.actor, b));
    }
    throw new Problem('Route not found.', 404);
  }
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolveStart, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveStart); });
    await lock.update(server.address().port);
  } catch (e) {
    server.close(); await hub.close(); await lock.release();
    throw e.code === 'EADDRINUSE' ? new Error(`Port ${port} is used by another program.`) : e;
  }
  // Access for virtual machines opened earlier: an address that does not exist now does not stop the start.
  const saved = listen ?? await readFile(listenFile, 'utf8').then(text => JSON.parse(text).addresses, () => []);
  await setRemotes(Array.isArray(saved) ? saved.filter(a => typeof a === 'string') : []);
  for (const r of remoteInfo()) console.error(r.listening ? `For virtual machines: http://${r.address}:${server.address().port}` : `Address ${r.address} for virtual machines is not open: ${r.error}`);
  let closing = null;
  return {
    url: `http://127.0.0.1:${server.address().port}`, data,
    close: () => closing ??= (async () => {
      await hub.close(); await access.close();
      for (const address of [...remotes.keys()]) await closeRemote(address);
      await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
      await lock.release();
    })()
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const options = {};
  try {
    if (args.includes('--help')) {
      console.log('Mycel: node server.mjs [--port 4317] [--data <data folder>]');
    } else {
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i].slice(2);
        if (!['data', 'port'].includes(key) || !args[i].startsWith('--') || !args[i + 1]) throw new Error('Unknown or incomplete argument. Use --help.');
        options[key] = key === 'port' ? Number(args[i + 1]) : args[i + 1];
      }
      if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('Invalid port.');
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
      const app = await startServer({ ...options, onStop: stop });
      console.log(`\nMycel → ${app.url}\nData: ${app.data}\nCtrl+C to stop.\n`);
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
