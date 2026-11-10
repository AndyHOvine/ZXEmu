const DB_NAME = 'zxemu';
const STATES = 'states';
const SLOTS = 'slots';

export const SLOT_COUNT = 4;

function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class SaveStates {
  constructor() {
    this.dbPromise = null;
  }

  db() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('Save states need browser storage, which is not available here')); return; }
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore(STATES);
          r.result.createObjectStore(SLOTS);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error || new Error('Browser storage is blocked'));
      });
      this.dbPromise.catch(() => { this.dbPromise = null; });
    }
    return this.dbPromise;
  }

  async tx(mode, fn) {
    const db = await this.db();
    const t = db.transaction([STATES, SLOTS], mode);
    const result = fn(t.objectStore(STATES), t.objectStore(SLOTS));
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage full'));
    });
    return result;
  }

  async list(game) {
    const db = await this.db();
    const store = db.transaction(SLOTS).objectStore(SLOTS);
    const out = [];
    for (let i = 1; i <= SLOT_COUNT; i++) out.push((await request(store.get(`${game}/${i}`))) || null);
    return out;
  }

  async load(game, slot) {
    const db = await this.db();
    return request(db.transaction(STATES).objectStore(STATES).get(`${game}/${slot}`));
  }

  save(game, slot, summary, state) {
    return this.tx('readwrite', (states, slots) => {
      states.put(state, `${game}/${slot}`);
      slots.put(summary, `${game}/${slot}`);
    });
  }

  remove(game, slot) {
    return this.tx('readwrite', (states, slots) => {
      states.delete(`${game}/${slot}`);
      slots.delete(`${game}/${slot}`);
    });
  }
}
