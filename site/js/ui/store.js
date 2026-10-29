// 瀏覽器端的儲存。策略與設定存在 localStorage,使用者上傳的價格資料存在 IndexedDB。
// 這些資料只存在使用者自己的瀏覽器裡,不會傳到任何伺服器。每個讀寫都包 try/catch:
// 無痕模式或封鎖儲存時,網站照常運作,只是不會記住東西。

import { normalizeStrategy } from '../engine/strategy.js';

const KEYS = { strategies: 'sl.strategies', session: 'sl.session', theme: 'sl.theme' };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export const loadTheme = () => { try { return localStorage.getItem(KEYS.theme); } catch { return null; } };
export const saveTheme = (t) => { try { localStorage.setItem(KEYS.theme, t); } catch { /* 忽略 */ } };

export const loadSession = () => read(KEYS.session, null);
export const saveSession = (session) => write(KEYS.session, session);

export function listStrategies() {
  const raw = read(KEYS.strategies, []);
  return Array.isArray(raw) ? raw.map(normalizeStrategy) : [];
}

/** 以名稱為鍵儲存(同名覆蓋),回傳是否成功 */
export function saveStrategy(strategy) {
  const s = normalizeStrategy(strategy);
  const all = listStrategies().filter((x) => x.name !== s.name);
  all.push(s);
  return write(KEYS.strategies, all);
}

export function deleteStrategy(name) {
  return write(KEYS.strategies, listStrategies().filter((x) => x.name !== name));
}

// ---- 使用者上傳的價格資料(IndexedDB) -----------------------------------------

const DB = 'strategy-lab', STORE = 'series';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = async (mode, fn) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
};

const pack = (bars) => ({ d: bars.d, o: Array.from(bars.o), h: Array.from(bars.h), l: Array.from(bars.l), c: Array.from(bars.c), v: Array.from(bars.v) });

export async function saveUserSeries(id, name, bars, meta = {}) {
  try { await tx('readwrite', (s) => s.put({ id, name, meta, ...pack(bars) })); return true; } catch { return false; }
}

export async function listUserSeries() {
  try { return (await tx('readonly', (s) => s.getAll())) || []; } catch { return []; }
}

export async function deleteUserSeries(id) {
  try { await tx('readwrite', (s) => s.delete(id)); return true; } catch { return false; }
}
