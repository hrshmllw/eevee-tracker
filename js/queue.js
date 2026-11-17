// IndexedDB outbox: pending changes + photo blobs + last-synced data cache.
// Falls back to memory if IndexedDB is unavailable.
const DB_NAME = 'eevee-tracker';
let dbp;
const mem = { ops: new Map(), blobs: new Map(), kv: new Map(), seq: 1 };

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
        db.createObjectStore('blobs');
        db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store)); // synchronous: returns an IDBRequest
    t.oncomplete = () => resolve(req instanceof IDBRequest ? req.result : req);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const wrap = (req) => req;

export const queue = {
  async add(op) {
    op.at = Date.now();
    return tx('ops', 'readwrite', (s) => {
      if (!s) { op.seq = mem.seq++; mem.ops.set(op.seq, op); return op.seq; }
      return wrap(s.add(op));
    });
  },
  async all() {
    return tx('ops', 'readonly', (s) => (s ? wrap(s.getAll()) : [...mem.ops.values()]));
  },
  async remove(seq) {
    return tx('ops', 'readwrite', (s) => (s ? wrap(s.delete(seq)) : mem.ops.delete(seq)));
  },
  async putBlob(key, blob) {
    return tx('blobs', 'readwrite', (s) => (s ? wrap(s.put(blob, key)) : mem.blobs.set(key, blob)));
  },
  async getBlob(key) {
    return tx('blobs', 'readonly', (s) => (s ? wrap(s.get(key)) : mem.blobs.get(key)));
  },
  async deleteBlob(key) {
    return tx('blobs', 'readwrite', (s) => (s ? wrap(s.delete(key)) : mem.blobs.delete(key)));
  },
  async kvGet(key) {
    return tx('kv', 'readonly', (s) => (s ? wrap(s.get(key)) : mem.kv.get(key)));
  },
  async kvSet(key, val) {
    return tx('kv', 'readwrite', (s) => (s ? wrap(s.put(val, key)) : mem.kv.set(key, val)));
  },
};
