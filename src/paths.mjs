// Project folders. Compared by the real path (a junction, subst and a redirected Desktop give the same folder)
// and case-insensitively on Windows and macOS. The project root is the nearest folder with .git (for a git worktree,
// the main working tree). Shared by the hub and mycel.mjs.
import { realpathSync, existsSync, statSync, readFileSync, renameSync } from 'node:fs';
import { resolve, parse, sep, dirname, join, isAbsolute, relative, basename } from 'node:path';
import { homedir } from 'node:os';

const folds = process.platform === 'win32' || process.platform === 'darwin';
const isRoot = p => parse(p).root === p;
// The path stored in the registry: the real one, without a trailing separator (except a drive root). If the end of the
// path does not exist yet, the real path of the nearest existing folder plus the rest as is: this way Windows short
// names (C:\Users\RUNNER~1) and links are resolved even for a subfolder that does not exist.
export function realDir(p) {
  let r = resolve(p);
  for (let d = r, rest = []; ; ) {
    try { r = join(realpathSync.native(d), ...rest); break; } catch { /* no such folder: go one level up */ }
    const up = dirname(d);
    if (up === d) break;
    rest.unshift(basename(d)); d = up;
  }
  return isRoot(r) ? r : r.replace(/[\\/]+$/, '');
}
export const pathKey = p => folds ? realDir(p).toLowerCase() : realDir(p);
// child is the same folder as parent or lies inside it. The boundary is a separator: C:\proj is not a parent of C:\project2.
export function isInside(child, parent) {
  const c = pathKey(child), p = pathKey(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
// path is the same folder, but in the main working tree: for a git worktree, the folder with the same relative path in the repository.
export function projectRoot(dir) {
  const start = realDir(dir);
  for (let d = start; ; d = dirname(d)) {
    const git = join(d, '.git');
    if (existsSync(git)) { const main = mainTree(git); return main ? { root: main, git: true, path: join(main, relative(d, start)) } : { root: d, git: true, path: start }; }
    if (dirname(d) === d) return { root: start, git: false, path: start };
  }
}
// A git worktree is the same project as the main tree: its .git is a file "gitdir: <X>/.git/worktrees/<name>",
// and that folder holds commondir. A submodule (gitdir in .git/modules, no commondir) and a bare repository are roots of their own.
function mainTree(git) {
  try {
    if (!statSync(git).isFile()) return null;
    const line = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, 'utf8')), gitdir = line && resolve(dirname(git), line[1]);
    if (!gitdir || basename(dirname(gitdir)) !== 'worktrees' || !existsSync(join(gitdir, 'commondir'))) return null;
    const common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
    return basename(common).toLowerCase() === '.git' ? realDir(dirname(common)) : null;
  } catch { return null; }
}
// The default data folder is .mycel next to the program. Before 0.15 the program was called Kontur and kept its data in
// .kontur: it is renamed if .mycel does not exist yet and no running hub of the old version holds it. If that fails (the
// hub is running, another process holds the folder), the data stays in .kontur until the next start.
export function defaultData(appRoot) {
  const data = join(appRoot, '.mycel'), legacy = join(appRoot, '.kontur');
  if (existsSync(data) || !existsSync(legacy)) return data;
  if (lockHeld(legacy)) return legacy;
  try { renameSync(legacy, data); return data; } catch { return legacy; }
}
function lockHeld(dir) {
  try {
    const text = readFileSync(join(dir, 'server.lock'), 'utf8'), pid = /^\s*\d+\s*$/.test(text) ? Number(text) : JSON.parse(text)?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  } catch { return false; }
}
// A drive root and the home folder are not projects: such a project would capture every folder inside.
export function refusedPath(p) {
  if (typeof p !== 'string' || !isAbsolute(p)) return true;
  if (process.platform === 'win32' && !/^[a-zA-Z]:[\\/]|^\\\\[^\\]+\\[^\\]+/.test(p)) return true;
  const r = realDir(p);
  return isRoot(r) || pathKey(r) === pathKey(homedir());
}
