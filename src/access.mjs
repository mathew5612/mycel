// Доступ виртуальных машин без пересылки ключа. Агент в виртуальной машине просит доступ (запрос с кодом из четырёх
// цифр), человек сверяет код и нажимает «Разрешить» в Mycel на основной машине — машина получает свой ключ. Ключи
// машин хранятся в devices.json только хэшами; отозванный ключ перестаёт работать сразу. Запрос живёт 10 минут, от
// одного адреса — один, всего — не больше пяти.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Problem } from './model.mjs';

const TTL = 10 * 60e3, PENDING = 5;
const hash = key => createHash('sha256').update(String(key)).digest();
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const clean = text => String(text ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60);

export async function openAccess(data, onChange = () => {}) {
  const file = join(data, 'devices.json');
  let devices = [];
  try {
    const list = JSON.parse(await readFile(file, 'utf8'));
    devices = (Array.isArray(list) ? list : []).filter(d => d && typeof d.id === 'string' && typeof d.hash === 'string' && /^[0-9a-f]{64}$/.test(d.hash));
  } catch { devices = []; }
  const requests = new Map();
  let saved = Promise.resolve();
  const save = () => (saved = saved.then(async () => {
    const temp = `${file}-${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(devices, null, 2) + '\n', { mode: 0o600 }); await rename(temp, file); }
    finally { await unlink(temp).catch(() => {}); }
  }));
  const pub = d => ({ id: d.id, name: d.name, address: d.address, project: d.project ?? null, createdAt: d.createdAt, lastSeen: d.lastSeen ?? null });
  const expire = () => { for (const [id, r] of requests) if (Date.now() - r.at > TTL + 60e3) requests.delete(id); else if (r.status === 'pending' && Date.now() - r.at > TTL) r.status = 'expired'; };
  const timer = setInterval(() => { const before = pending().length; expire(); if (pending().length !== before) onChange(); }, 30e3);
  timer.unref();
  const pending = () => [...requests.values()].filter(r => r.status === 'pending').map(r => ({ id: r.id, code: r.code, name: r.name, address: r.address, at: new Date(r.at).toISOString() }));
  return {
    devices: () => devices.map(pub),
    pending,
    // Запрос из виртуальной машины: без ключа. secret — чтобы забрать ответ мог только тот, кто спросил.
    request(name, address) {
      expire();
      for (const [id, r] of requests) if (r.address === address && r.status === 'pending') requests.delete(id);
      if (pending().length >= PENDING) throw new Problem('Слишком много запросов доступа: подождите, пока человек ответит на прежние.', 429);
      const r = { id: randomUUID(), code: String(randomInt(1000, 10000)), name: clean(name) || 'виртуальная машина', address, at: Date.now(), secret: randomBytes(24).toString('hex'), status: 'pending' };
      requests.set(r.id, r);
      onChange();
      return { id: r.id, code: r.code, secret: r.secret, expiresIn: TTL / 1000 };
    },
    // Ответ отдаётся один раз: ключ после этого есть только у машины.
    poll(id, secret) {
      expire();
      const r = requests.get(id);
      if (!r || typeof secret !== 'string' || !same(hash(secret), hash(r.secret))) throw new Problem('Запрос не найден.', 404);
      if (r.status !== 'approved') return { status: r.status };
      requests.delete(id);
      return { status: 'approved', key: r.key, project: r.project ?? null };
    },
    async approve(id, project) {
      expire();
      const r = requests.get(id);
      if (!r || r.status !== 'pending') throw new Problem('Запрос уже не ждёт ответа.', 409);
      const key = randomBytes(32).toString('hex');
      devices.push({ id: randomUUID(), name: r.name, address: r.address, project: project ?? null, hash: hash(key).toString('hex'), createdAt: new Date().toISOString() });
      await save();
      Object.assign(r, { status: 'approved', key, project: project ?? null });
      onChange();
      return pub(devices.at(-1));
    },
    deny(id) {
      const r = requests.get(id);
      if (!r || r.status !== 'pending') throw new Problem('Запрос уже не ждёт ответа.', 409);
      r.status = 'denied'; onChange();
    },
    async revoke(id) {
      const before = devices.length;
      devices = devices.filter(d => d.id !== id);
      if (devices.length === before) throw new Problem('Такой машины нет.', 404);
      await save(); onChange();
    },
    // Машина по ключу; заодно — когда она была в последний раз.
    check(key) {
      if (typeof key !== 'string' || !key) return null;
      const h = hash(key), d = devices.find(x => same(Buffer.from(x.hash, 'hex'), h));
      if (d) d.lastSeen = new Date().toISOString();
      return d ? pub(d) : null;
    },
    close: async () => { clearInterval(timer); await saved; }
  };
}
