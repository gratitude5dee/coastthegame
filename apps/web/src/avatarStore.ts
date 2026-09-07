export interface AvatarDescriptor {
  id: string;
  name: string;
  forward: '-Z' | '+Z';
  heightM: number;
  bytes: number;
}

export interface SavedAvatar extends AvatarDescriptor {
  data: ArrayBuffer;
}

export interface AvatarStore {
  list(): Promise<AvatarDescriptor[]>;
  load(id: string): Promise<SavedAvatar | null>;
  save(record: SavedAvatar): Promise<AvatarDescriptor>;
  remove(id: string): Promise<void>;
  selected(): Promise<string | null>;
  select(id: string | null): Promise<void>;
}

const MAX_ASSETS = 8;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const STORES = ['metadata', 'assets', 'settings'];
const DESCRIPTOR_KEYS = ['id', 'name', 'forward', 'heightM', 'bytes'];

function validateOptions(name: string, forward: string, heightM: number): void {
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('Avatar name must contain 1–120 characters');
  if (forward !== '-Z' && forward !== '+Z') throw new Error('Avatar forward must be -Z or +Z');
  if (!Number.isFinite(heightM) || heightM <= 0) throw new Error('Avatar heightM must be finite and positive');
}

function validateData(data: ArrayBuffer): void {
  if (!(data instanceof ArrayBuffer)) throw new Error('Avatar data must be an ArrayBuffer');
  if (data.byteLength > MAX_ASSET_BYTES) throw new Error('Avatar exceeds the 20 MiB asset limit');
  if (data.byteLength < 12) throw new Error('Avatar requires a GLB v2 header');
  const header = new DataView(data);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== data.byteLength) {
    throw new Error('Avatar has an invalid GLB v2 header or byte length');
  }
}

function descriptor(value: unknown): AvatarDescriptor {
  if (!value || typeof value !== 'object') throw new Error('Corrupt avatar metadata');
  const r = value as AvatarDescriptor;
  if (Object.keys(r).length !== DESCRIPTOR_KEYS.length || !DESCRIPTOR_KEYS.every((key) => Object.hasOwn(r, key))) {
    throw new Error('Corrupt avatar metadata fields');
  }
  if (typeof r.id !== 'string' || !/^avatar-[0-9a-f]{64}$/.test(r.id)) throw new Error('Corrupt avatar identity');
  validateOptions(r.name, r.forward, r.heightM);
  if (!Number.isSafeInteger(r.bytes) || r.bytes < 12 || r.bytes > MAX_ASSET_BYTES) throw new Error('Corrupt avatar byte size');
  return { id: r.id, name: r.name, forward: r.forward, heightM: r.heightM, bytes: r.bytes };
}

function metadata(value: SavedAvatar): AvatarDescriptor {
  return descriptor({ id: value.id, name: value.name, forward: value.forward, heightM: value.heightM, bytes: value.bytes });
}

function assetData(value: unknown, meta: AvatarDescriptor): ArrayBuffer {
  if (!value || typeof value !== 'object') throw new Error('Corrupt avatar: missing asset data');
  const asset = value as { id: string; data: ArrayBuffer };
  if (Object.keys(asset).length !== 2 || !Object.hasOwn(asset, 'id') || !Object.hasOwn(asset, 'data') || asset.id !== meta.id) {
    throw new Error('Corrupt avatar asset metadata');
  }
  validateData(asset.data);
  if (asset.data.byteLength !== meta.bytes) throw new Error('Corrupt avatar: byte size does not match metadata');
  return asset.data.slice(0);
}

function inventory(values: unknown[], keys?: IDBValidKey[]): AvatarDescriptor[] {
  const records = values.map(descriptor);
  if (records.length > MAX_ASSETS || records.reduce((total, r) => total + r.bytes, 0) > MAX_TOTAL_BYTES) {
    throw new Error('Corrupt avatar inventory: storage limits exceeded');
  }
  if (keys && (keys.length !== records.length || records.some((r) => !keys.includes(r.id)))) {
    throw new Error('Corrupt avatar inventory: metadata and assets differ');
  }
  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function describeAvatar(data: ArrayBuffer, name: string, forward: '-Z' | '+Z', heightM = 1.8): Promise<AvatarDescriptor> {
  validateOptions(name, forward, heightM);
  validateData(data);
  const options = new TextEncoder().encode(JSON.stringify({ version: 1, forward, heightM }) + '\n');
  const input = new Uint8Array(options.length + data.byteLength);
  input.set(options);
  input.set(new Uint8Array(data), options.length);
  if (!globalThis.crypto?.subtle) throw new Error('Avatar SHA-256 unavailable: a secure context is required');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', input);
  const id = 'avatar-' + [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, '0')).join('');
  return { id, name, forward, heightM, bytes: input.length - options.length };
}

function openDatabase(factory: IDBFactory, name: string, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    let settled = false;
    let blocked = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error(`Avatar IndexedDB ${blocked ? 'blocked ' : ''}open timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    request.onblocked = () => {
      blocked = true;
    };
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        request.result.close();
        return;
      }
      try {
        const db = request.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, name === 'settings' ? undefined : { keyPath: 'id' });
        }
      } catch (error) {
        request.transaction?.abort();
        request.result.close();
        fail(error);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => fail(request.error ?? new Error('Avatar IndexedDB open failed'));
  });
}

type Watch = <T>(request: IDBRequest<T>, success: (value: T) => void) => void;

function transaction<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  operation: (tx: IDBTransaction, watch: Watch, result: (value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    let failure: unknown;
    const abort = (error: unknown) => {
      failure = error;
      try {
        tx.abort();
      } catch {
        reject(error);
      }
    };
    const watch: Watch = (request, success) => {
      request.onerror = () => {
        failure ??= request.error ?? new Error('Avatar IndexedDB request failed');
      };
      request.onsuccess = () => {
        try {
          success(request.result);
        } catch (error) {
          abort(error);
        }
      };
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Avatar IndexedDB transaction aborted'));
    tx.onerror = () => {
      failure ??= tx.error ?? new Error('Avatar IndexedDB transaction failed');
    };
    try {
      operation(tx, watch, (result) => {
        value = result;
      });
    } catch (error) {
      abort(error);
    }
  });
}

export function createAvatarStore(opts: { indexedDB?: IDBFactory | null; dbName?: string; openTimeoutMs?: number } = {}): AvatarStore {
  const dbName = opts.dbName ?? 'coast-avatars';
  const openTimeoutMs = opts.openTimeoutMs ?? 5000;
  if (!Number.isFinite(openTimeoutMs) || openTimeoutMs <= 0 || openTimeoutMs > 2147483647)
    throw new Error('Avatar openTimeoutMs must be a positive bounded timeout');
  let dbPromise: Promise<IDBDatabase> | undefined;
  async function database(): Promise<IDBDatabase> {
    if (!dbPromise) {
      const factory = opts.indexedDB === undefined ? globalThis.indexedDB : opts.indexedDB;
      if (!factory) throw new Error('Avatar IndexedDB unavailable; avatar was not persisted');
      dbPromise = openDatabase(factory, dbName, openTimeoutMs).then(
        (db) => {
          const close = () => {
            db.close();
            dbPromise = undefined;
          };
          db.onversionchange = close;
          db.onclose = close;
          return db;
        },
        (error: unknown) => {
          dbPromise = undefined;
          throw error;
        },
      );
    }
    return dbPromise;
  }

  function selection(tx: IDBTransaction, watch: Watch, done: (id: string | null) => void): void {
    watch(tx.objectStore('settings').get('selected'), (value: unknown) => {
      if (value === undefined || value === null) return done(null);
      if (typeof value !== 'string' || !/^avatar-[0-9a-f]{64}$/.test(value)) throw new Error('Corrupt avatar selection');
      watch(tx.objectStore('metadata').get(value), (raw: unknown) => {
        if (descriptor(raw).id !== value) throw new Error('Corrupt avatar selection metadata');
        watch(tx.objectStore('assets').getKey(value), (key) => {
          if (key !== value) throw new Error('Corrupt avatar selection: missing asset');
          done(value);
        });
      });
    });
  }

  return {
    async list() {
      return transaction(await database(), ['metadata'], 'readonly', (tx, watch, done) => {
        watch(tx.objectStore('metadata').getAll(undefined, MAX_ASSETS + 1), (values: unknown[]) => done(inventory(values)));
      });
    },
    async load(id) {
      const record = await transaction<SavedAvatar | null>(await database(), ['metadata', 'assets'], 'readonly', (tx, watch, done) => {
        watch(tx.objectStore('metadata').get(id), (raw: unknown) => {
          watch(tx.objectStore('assets').get(id), (asset: unknown) => {
            if (raw === undefined && asset === undefined) return done(null);
            const meta = descriptor(raw);
            if (meta.id !== id) throw new Error('Corrupt avatar identity');
            done({ ...meta, data: assetData(asset, meta) });
          });
        });
      });
      if (record) {
        const verified = await describeAvatar(record.data, record.name, record.forward, record.heightM);
        if (verified.id !== record.id) throw new Error('Corrupt avatar: SHA-256 identity mismatch');
      }
      return record;
    },
    async save(record) {
      const meta = metadata(record);
      validateData(record.data);
      const data = record.data.slice(0);
      if (data.byteLength !== meta.bytes) throw new Error('Avatar byte size does not match metadata');
      const verified = await describeAvatar(data, meta.name, meta.forward, meta.heightM);
      if (verified.id !== meta.id) throw new Error('Avatar SHA-256 identity mismatch');
      return transaction(await database(), ['metadata', 'assets'], 'readwrite', (tx, watch, done) => {
        const metas = tx.objectStore('metadata');
        const assets = tx.objectStore('assets');
        watch(metas.getAll(undefined, MAX_ASSETS + 1), (values: unknown[]) => {
          watch(assets.getAllKeys(undefined, MAX_ASSETS + 1), (keys) => {
            const records = inventory(values, keys);
            const existing = records.find((r) => r.id === meta.id);
            if (existing) {
              if (existing.bytes !== meta.bytes || existing.forward !== meta.forward || existing.heightM !== meta.heightM)
                throw new Error('Corrupt avatar: identity options differ');
              watch(assets.get(meta.id), (raw: unknown) => {
                const previous = new Uint8Array(assetData(raw, existing));
                const incoming = new Uint8Array(data);
                if (!previous.every((byte, i) => byte === incoming[i])) throw new Error('Corrupt avatar: SHA-256 identity mismatch');
                done(existing);
              });
              return;
            }
            if (records.length >= MAX_ASSETS) throw new Error('Avatar library limit is 8 assets; remove an avatar before saving');
            if (records.reduce((total, r) => total + r.bytes, meta.bytes) > MAX_TOTAL_BYTES)
              throw new Error('Avatar library exceeds the 128 MiB total limit; remove an avatar before saving');
            watch(metas.put(meta), () => {});
            watch(assets.put({ id: meta.id, data }), () => {});
            done(meta);
          });
        });
      });
    },
    async remove(id) {
      return transaction(await database(), STORES, 'readwrite', (tx, watch, done) => {
        watch(tx.objectStore('metadata').delete(id), () => {});
        watch(tx.objectStore('assets').delete(id), () => {});
        watch(tx.objectStore('settings').get('selected'), (value: unknown) => {
          if (value === id) watch(tx.objectStore('settings').delete('selected'), () => {});
          done(undefined);
        });
      });
    },
    async selected() {
      return transaction(await database(), STORES, 'readonly', (tx, watch, done) => selection(tx, watch, done));
    },
    async select(id) {
      return transaction(await database(), STORES, 'readwrite', (tx, watch, done) => {
        const settings = tx.objectStore('settings');
        if (id === null) {
          watch(settings.delete('selected'), () => done(undefined));
          return;
        }
        watch(tx.objectStore('metadata').get(id), (raw: unknown) => {
          if (raw === undefined) throw new Error('Cannot select an avatar that is not saved');
          if (descriptor(raw).id !== id) throw new Error('Corrupt avatar identity');
          watch(tx.objectStore('assets').getKey(id), (key) => {
            if (key !== id) throw new Error('Corrupt avatar: missing asset data');
            watch(settings.put(id, 'selected'), () => done(undefined));
          });
        });
      });
    },
  };
}

export const avatarStore = createAvatarStore();
