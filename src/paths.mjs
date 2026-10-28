// Папки проектов. Сравнение — по настоящему пути (junction, subst и перенаправленный Рабочий стол дают одну папку)
// и без учёта регистра на Windows и macOS. Корень проекта — ближайшая папка с .git (у git worktree — основное рабочее
// дерево). Общий для хаба и mycel.mjs.
import { realpathSync, existsSync, statSync, readFileSync, renameSync } from 'node:fs';
import { resolve, parse, sep, dirname, join, isAbsolute, relative, basename } from 'node:path';
import { homedir } from 'node:os';

const folds = process.platform === 'win32' || process.platform === 'darwin';
const isRoot = p => parse(p).root === p;
// Путь, который хранится в реестре: настоящий, без завершающего разделителя (кроме корня диска).
export function realDir(p) {
  let r = resolve(p);
  try { r = realpathSync.native(r); } catch { /* папки нет: берём путь как есть */ }
  return isRoot(r) ? r : r.replace(/[\\/]+$/, '');
}
export const pathKey = p => folds ? realDir(p).toLowerCase() : realDir(p);
// child — та же папка или лежит внутри parent. Граница по разделителю: C:\proj не родитель C:\project2.
export function isInside(child, parent) {
  const c = pathKey(child), p = pathKey(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
// path — та же папка, но в основном рабочем дереве: у git worktree это папка с тем же относительным путём в репозитории.
export function projectRoot(dir) {
  const start = realDir(dir);
  for (let d = start; ; d = dirname(d)) {
    const git = join(d, '.git');
    if (existsSync(git)) { const main = mainTree(git); return main ? { root: main, git: true, path: join(main, relative(d, start)) } : { root: d, git: true, path: start }; }
    if (dirname(d) === d) return { root: start, git: false, path: start };
  }
}
// Рабочее дерево git worktree — тот же проект, что и основное: его .git — файл «gitdir: <X>/.git/worktrees/<имя>»,
// а в той папке лежит commondir. Подмодуль (gitdir в .git/modules, без commondir) и голый репозиторий — свои корни.
function mainTree(git) {
  try {
    if (!statSync(git).isFile()) return null;
    const line = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, 'utf8')), gitdir = line && resolve(dirname(git), line[1]);
    if (!gitdir || basename(dirname(gitdir)) !== 'worktrees' || !existsSync(join(gitdir, 'commondir'))) return null;
    const common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
    return basename(common).toLowerCase() === '.git' ? realDir(dirname(common)) : null;
  } catch { return null; }
}
// Каталог данных по умолчанию — .mycel рядом с программой. До 0.15 программа называлась Контур и хранила данные в
// .kontur: он переименовывается, если .mycel ещё нет и его не держит работающий хаб прежней версии. Не вышло (хаб
// работает, папку держит другой процесс) — данные остаются в .kontur до следующего запуска.
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
// Корень диска и домашняя папка — не проекты: такой проект захватил бы все папки внутри.
export function refusedPath(p) {
  if (typeof p !== 'string' || !isAbsolute(p)) return true;
  if (process.platform === 'win32' && !/^[a-zA-Z]:[\\/]|^\\\\[^\\]+\\[^\\]+/.test(p)) return true;
  const r = realDir(p);
  return isRoot(r) || pathKey(r) === pathKey(homedir());
}
