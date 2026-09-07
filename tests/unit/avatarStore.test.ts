import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { avatarStore, createAvatarStore, describeAvatar, type SavedAvatar } from '../../apps/web/src/avatarStore';

const MiB = 1024 * 1024;

function glb(marker = 0, bytes = 24): ArrayBuffer {
  const data = new ArrayBuffer(bytes);
  const view = new DataView(data);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes, true);
  if (bytes >= 24) {
    view.setUint32(12, bytes - 20, true);
    view.setUint32(16, 0x4e4f534a, true);
    new Uint8Array(data).set([123, 125, 32, 32], 20);
    view.setUint8(23, marker);
  }
  return data;
}

async function avatar(marker = 0, bytes = 24): Promise<SavedAvatar> {
  const data = glb(marker, bytes);
  return { ...(await describeAvatar(data, `Avatar ${marker}`, '-Z')), data };
}

type Request<T = unknown> = { result?: T; error?: Error; onsuccess?: () => void; onerror?: () => void };
type FakeTransaction = {
  oncomplete?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  error?: Error;
  abort: () => void;
  objectStore: (name: string) => FakeObjectStore;
};
type FakeObjectStore = {
  get: (key: IDBValidKey) => Request;
  getKey: (key: IDBValidKey) => Request;
  getAll: (query?: unknown, count?: number) => Request;
  getAllKeys: (query?: unknown, count?: number) => Request;
  put: (value: unknown, key?: IDBValidKey) => Request;
  delete: (key: IDBValidKey) => Request;
};

function fakeIndexedDB(mode: 'ok' | 'throw' | 'error' | 'hang' | 'blocked' = 'ok') {
  const databases = new Map<string, Map<string, Map<IDBValidKey, unknown>>>();
  const queues = new Map<string, Array<() => void>>();
  const state = {
    databases,
    opens: [] as Array<[string, number | undefined]>,
    reads: [] as Array<[string, string]>,
    transactions: [] as Array<{ stores: string[]; mode: IDBTransactionMode }>,
    connections: [] as Array<{ close: () => void; onversionchange?: () => void; onclose?: () => void }>,
    closes: 0,
    upgradeAborts: 0,
    commits: 0,
    failWriteStore: '',
    failCommit: false,
    holdCommit: false,
    releaseCommit: undefined as (() => void) | undefined,
    finishOpen: undefined as (() => void) | undefined,
  };
  const factory = {
    open(name: string, version?: number) {
      state.opens.push([name, version]);
      if (mode === 'throw') throw new DOMException('IndexedDB disabled', 'SecurityError');
      const request: Request & { onupgradeneeded?: () => void; onblocked?: () => void; transaction?: { abort: () => void } } = {};
      const finish = () => {
        const isNew = !databases.has(name);
        if (isNew) databases.set(name, new Map());
        const stores = databases.get(name)!;
        let closed = false;
        const db = {
          onversionchange: undefined as (() => void) | undefined,
          onclose: undefined as (() => void) | undefined,
          close() {
            closed = true;
            state.closes++;
          },
          objectStoreNames: { contains: (storeName: string) => stores.has(storeName) },
          createObjectStore(storeName: string) {
            stores.set(storeName, new Map());
          },
          transaction(storeNames: string[], txMode: IDBTransactionMode) {
            if (closed) throw new DOMException('Connection closed', 'InvalidStateError');
            state.transactions.push({ stores: [...storeNames], mode: txMode });
            const pending: Array<() => void> = [];
            const activeRequests = new Set<Request>();
            let snapshot: Map<string, Map<IDBValidKey, unknown>>;
            let finished = false;
            let started = false;
            const queue = queues.get(name) ?? [];
            queues.set(name, queue);
            const next = () => {
              queue.shift();
              queueMicrotask(() => queue[0]?.());
            };
            const tx: FakeTransaction = {
              abort() {
                if (finished) throw new DOMException('Transaction finished', 'InvalidStateError');
                finished = true;
                queueMicrotask(() => {
                  for (const request of activeRequests) {
                    request.error = new DOMException('Request aborted', 'AbortError');
                    request.onerror?.();
                    tx.onerror?.();
                  }
                  tx.onabort?.();
                  next();
                });
              },
              objectStore(storeName) {
                if (!storeNames.includes(storeName) || !stores.has(storeName)) throw new Error('Missing object store');
                const operation = (kind: string, fn: (map: Map<IDBValidKey, unknown>) => unknown) => {
                  const r: Request = {};
                  activeRequests.add(r);
                  pending.push(() => {
                    if (finished) return;
                    activeRequests.delete(r);
                    try {
                      if (kind === 'put' || kind === 'delete') {
                        if (txMode !== 'readwrite') throw new Error('Readonly transaction');
                        if (state.failWriteStore === storeName) {
                          state.failWriteStore = '';
                          throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
                        }
                      } else state.reads.push([storeName, kind]);
                      r.result = fn(snapshot.get(storeName)!);
                      r.onsuccess?.();
                    } catch (error) {
                      r.error = error as Error;
                      tx.error = error as Error;
                      r.onerror?.();
                      tx.onerror?.();
                      tx.abort();
                    }
                  });
                  return r;
                };
                return {
                  get: (key) => operation('get', (m) => structuredClone(m.get(key))),
                  getKey: (key) => operation('getKey', (m) => (m.has(key) ? key : undefined)),
                  getAll: (_query, count) =>
                    operation('getAll', (m) => [...m.values()].slice(0, count).map((value) => structuredClone(value))),
                  getAllKeys: (_query, count) => operation('getAllKeys', (m) => [...m.keys()].slice(0, count)),
                  put(value, key) {
                    const copy = structuredClone(value);
                    const id = key ?? (copy as { id: string }).id;
                    return operation('put', (m) => {
                      m.set(id, copy);
                      return id;
                    });
                  },
                  delete: (key) =>
                    operation('delete', (m) => {
                      m.delete(key);
                    }),
                };
              },
            };
            const commit = () => {
              state.releaseCommit = undefined;
              if (state.failCommit) {
                state.failCommit = false;
                tx.error = new DOMException('Commit aborted', 'AbortError');
                tx.abort();
                return;
              }
              finished = true;
              if (txMode === 'readwrite') for (const storeName of storeNames) stores.set(storeName, snapshot.get(storeName)!);
              state.commits++;
              tx.oncomplete?.();
              next();
            };
            const pump = () => {
              if (finished) return;
              const operation = pending.shift();
              if (operation) {
                operation();
                queueMicrotask(pump);
              } else if (state.holdCommit && txMode === 'readwrite') state.releaseCommit = commit;
              else commit();
            };
            const start = () => {
              if (started) return;
              started = true;
              snapshot = new Map(storeNames.map((storeName) => [storeName, new Map(stores.get(storeName)!)]));
              queueMicrotask(pump);
            };
            queue.push(start);
            if (queue.length === 1) queueMicrotask(start);
            return tx;
          },
        };
        state.connections.push(db);
        request.result = db;
        request.transaction = {
          abort: () => {
            state.upgradeAborts++;
          },
        };
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      };
      state.finishOpen = finish;
      queueMicrotask(() => {
        if (mode === 'hang') return;
        if (mode === 'blocked') {
          request.onblocked?.();
          return;
        }
        if (mode === 'error') {
          request.error = new DOMException('Open failed', 'UnknownError');
          request.onerror?.();
          return;
        }
        finish();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, state, stores: () => databases.get('coast-avatars')! };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('avatar description', () => {
  it('hashes bytes and versioned normalization, never names', async () => {
    const data = glb();
    const a = await describeAvatar(data, 'First', '-Z');
    const b = await describeAvatar(data, 'Different', '-Z', 1.8);
    const expected = createHash('sha256').update('{"version":1,"forward":"-Z","heightM":1.8}\n').update(new Uint8Array(data)).digest('hex');
    expect(a.id).toBe(`avatar-${expected}`);
    expect(b.id).toBe(a.id);
    expect((await describeAvatar(data, 'First', '+Z')).id).not.toBe(a.id);
    expect((await describeAvatar(data, 'First', '-Z', 2)).id).not.toBe(a.id);
    expect((await describeAvatar(glb(1), 'First', '-Z')).id).not.toBe(a.id);
    expect(a).toEqual({ id: a.id, name: 'First', forward: '-Z', heightM: 1.8, bytes: 24 });
  });

  it('validates name, options, size and the minimum GLB v2 header', async () => {
    await expect(describeAvatar(glb(), 'x'.repeat(120), '-Z')).resolves.toMatchObject({ name: 'x'.repeat(120) });
    for (const name of ['', ' ', 'x'.repeat(121)]) await expect(describeAvatar(glb(), name, '-Z')).rejects.toThrow(/name/);
    for (const height of [0, -1, NaN, Infinity]) await expect(describeAvatar(glb(), 'A', '-Z', height)).rejects.toThrow(/height/);
    await expect(describeAvatar(glb(), 'A', 'X' as '-Z')).rejects.toThrow(/forward/);
    await expect(describeAvatar(glb(0, 20 * MiB + 1), 'A', '-Z')).rejects.toThrow(/20 MiB/);
    await expect(describeAvatar(new ArrayBuffer(11), 'A', '-Z')).rejects.toThrow(/GLB v2/);
    for (const offset of [0, 4, 8]) {
      const data = glb();
      new DataView(data).setUint32(offset, 1, true);
      await expect(describeAvatar(data, 'A', '-Z')).rejects.toThrow(/GLB v2/);
    }
    vi.stubGlobal('crypto', undefined);
    await expect(describeAvatar(glb(), 'A', '-Z')).rejects.toThrow(/SHA-256 unavailable/);
  });
});

describe('avatarStore', () => {
  it('persists save/load/list across stores and version changes, with metadata-only listing', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const a = await avatar();
    const b = await avatar(1);
    expect(await store.list()).toEqual([]);
    expect(await store.load(a.id)).toBeNull();
    expect(await store.save(a)).toEqual(await describeAvatar(a.data, a.name, a.forward));
    await store.save(b);
    fake.state.reads.length = 0;
    const listed = await store.list();
    expect(listed.map((r) => r.id)).toEqual([a.id, b.id].sort());
    expect(fake.state.reads).toEqual([['metadata', 'getAll']]);
    expect(fake.state.transactions.at(-1)).toEqual({ stores: ['metadata'], mode: 'readonly' });
    const reopened = createAvatarStore({ indexedDB: fake.factory });
    expect(await reopened.load(a.id)).toEqual(a);
    expect(await reopened.list()).toEqual(listed);
    fake.state.connections[0]!.onversionchange?.();
    expect(fake.state.closes).toBe(1);
    expect(await store.load(b.id)).toEqual(b);
    expect(fake.state.opens).toEqual(Array.from({ length: 3 }, () => ['coast-avatars', 1]));
    expect([...fake.stores().keys()].sort()).toEqual(['assets', 'metadata', 'settings']);
  });

  it('deduplicates without renaming, and clones input/output buffers before async work', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const original = await avatar();
    const expected = structuredClone(original);
    const saving = store.save(original);
    new Uint8Array(original.data)[23] = 99;
    original.name = 'Changed during save';
    await saving;
    const duplicate = await store.save({ ...expected, name: 'New label' });
    expect(duplicate.name).toBe(expected.name);
    duplicate.name = 'Changed result';
    const loaded = (await store.load(expected.id))!;
    expect(loaded).toEqual(expected);
    new Uint8Array(loaded.data)[23] = 77;
    (await store.list())[0]!.name = 'Changed listing';
    expect(await store.load(expected.id)).toEqual(expected);
    expect(await store.list()).toHaveLength(1);
  });

  it('selects only saved assets, persists selection, and removes only the named avatar', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const a = await avatar();
    const b = await avatar(1);
    await store.save(a);
    await store.save(b);
    const takes = new Map([['take-1', { actorId: 'player' }]]);
    fake.state.databases.set('coast', new Map([['takes', takes]]));
    expect(await store.selected()).toBeNull();
    await store.select(a.id);
    await expect(store.select('missing')).rejects.toThrow(/not saved/);
    expect(await createAvatarStore({ indexedDB: fake.factory }).selected()).toBe(a.id);
    await store.remove(b.id);
    expect(await store.selected()).toBe(a.id);
    await store.remove('missing');
    await store.remove(a.id);
    expect(await store.selected()).toBeNull();
    expect(await store.load(a.id)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(fake.state.transactions.at(-3)?.stores).not.toContain('takes');
    expect(takes.get('take-1')).toEqual({ actorId: 'player' });
    await store.save(b);
    await store.select(b.id);
    await store.select(null);
    expect(await store.selected()).toBeNull();
    expect(await store.load(b.id)).toEqual(b);
  });

  it('enforces 8 assets atomically across connections without eviction, including dedup at capacity', async () => {
    const fake = fakeIndexedDB();
    const first = createAvatarStore({ indexedDB: fake.factory });
    const second = createAvatarStore({ indexedDB: fake.factory });
    const records = await Promise.all(Array.from({ length: 9 }, (_, index) => avatar(index)));
    for (const record of records.slice(0, 7)) await first.save(record);
    const results = await Promise.allSettled([first.save(records[7]!), second.save(records[8]!)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason.message).toMatch(/8 assets/);
    expect(await first.list()).toHaveLength(8);
    for (const record of records.slice(0, 7)) expect(await first.load(record.id)).toEqual(record);
    await expect(first.save({ ...records[0]!, name: 'Duplicate' })).resolves.toMatchObject({ name: records[0]!.name });
  });

  it('enforces the exact 20 MiB per-asset and 128 MiB total budgets without eviction', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const record = await avatar(i, 20 * MiB);
      await store.save(record);
      ids.push(record.id);
    }
    const last = await avatar(6, 8 * MiB);
    await store.save(last);
    await store.select(ids[0]!);
    await expect(store.save(await avatar(7))).rejects.toThrow(/128 MiB/);
    expect((await store.list()).reduce((total, r) => total + r.bytes, 0)).toBe(128 * MiB);
    expect((await store.list()).map((r) => r.id).sort()).toEqual([...ids, last.id].sort());
    expect(await store.selected()).toBe(ids[0]);
    await store.remove(last.id);
    const second = createAvatarStore({ indexedDB: fake.factory });
    const contenders = await Promise.all([avatar(7, 8 * MiB), avatar(8, 8 * MiB)]);
    const results = await Promise.allSettled([store.save(contenders[0]!), second.save(contenders[1]!)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason.message).toMatch(/128 MiB/);
    expect((await store.list()).reduce((total, r) => total + r.bytes, 0)).toBe(128 * MiB);
  });

  it('rejects quota errors and rolls back metadata, bytes and selection together', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const a = await avatar();
    const b = await avatar(1);
    await store.save(a);
    await store.select(a.id);
    for (const storeName of ['metadata', 'assets']) {
      fake.state.failWriteStore = storeName;
      await expect(store.save(b)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    }
    expect(await store.list()).toHaveLength(1);
    expect(await store.load(b.id)).toBeNull();
    expect(await store.selected()).toBe(a.id);
    fake.state.failWriteStore = 'settings';
    await expect(store.remove(a.id)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await store.load(a.id)).toEqual(a);
    expect(await store.selected()).toBe(a.id);
    fake.state.failCommit = true;
    await expect(store.save(b)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.load(b.id)).toBeNull();
  });

  it('resolves writes only on transaction commit', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const a = await avatar();
    fake.state.holdCommit = true;
    let resolved = false;
    const saving = store.save(a).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(fake.state.releaseCommit).toBeTypeOf('function'));
    expect(resolved).toBe(false);
    expect(fake.stores().get('metadata')!.size).toBe(0);
    fake.state.releaseCommit!();
    await saving;
    expect(resolved).toBe(true);
    expect(fake.stores().get('metadata')!.size).toBe(1);
  });

  it('surfaces unavailable IndexedDB without memory fallback or permission requests', async () => {
    const persist = vi.fn();
    vi.stubGlobal('navigator', { storage: { persist } });
    vi.stubGlobal('indexedDB', undefined);
    const a = await avatar();
    for (const store of [avatarStore, createAvatarStore({ indexedDB: null })]) {
      await expect(store.save(a)).rejects.toThrow(/IndexedDB unavailable/);
      await expect(store.list()).rejects.toThrow(/IndexedDB unavailable/);
      await expect(store.load(a.id)).rejects.toThrow(/IndexedDB unavailable/);
      await expect(store.select(null)).rejects.toThrow(/IndexedDB unavailable/);
      await expect(store.selected()).rejects.toThrow(/IndexedDB unavailable/);
      await expect(store.remove(a.id)).rejects.toThrow(/IndexedDB unavailable/);
    }
    expect(persist).not.toHaveBeenCalled();
    for (const mode of ['throw', 'error'] as const) {
      const fake = fakeIndexedDB(mode);
      const store = createAvatarStore({ indexedDB: fake.factory });
      await expect(store.save(a)).rejects.toThrow(/disabled|Open failed/);
      expect(fake.state.databases.size).toBe(0);
    }
  });

  it.each(['hang', 'blocked'] as const)('bounds %s opens and closes late connections', async (mode) => {
    vi.useFakeTimers();
    const fake = fakeIndexedDB(mode);
    const store = createAvatarStore({ indexedDB: fake.factory, openTimeoutMs: 25 });
    const pending = expect(store.list()).rejects.toThrow(mode === 'blocked' ? /blocked open timed out/ : /open timed out/);
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    fake.state.finishOpen!();
    expect(fake.state.closes).toBeGreaterThan(0);
    expect(fake.state.upgradeAborts).toBe(1);
  });

  it('supports an isolated database name and rejects unbounded timeout configuration', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory, dbName: 'avatar-test' });
    await store.save(await avatar());
    expect(fake.state.opens).toEqual([['avatar-test', 1]]);
    for (const openTimeoutMs of [0, -1, NaN, Infinity, 2147483648]) expect(() => createAvatarStore({ openTimeoutMs })).toThrow(/timeout/i);
  });

  it('rejects forged input hashes, sizes and options before opening a database', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const a = await avatar();
    await expect(store.save({ ...a, id: `avatar-${'0'.repeat(64)}` })).rejects.toThrow(/identity/);
    await expect(store.save({ ...a, bytes: a.bytes + 1 })).rejects.toThrow(/byte size/);
    await expect(store.save({ ...a, forward: '+Z' })).rejects.toThrow(/identity/);
    await expect(store.save({ ...a, heightM: 2 })).rejects.toThrow(/identity/);
    expect(fake.state.opens).toEqual([]);
  });

  it('detects corrupt binary data, sizes, identity and metadata on read and duplicate save', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const a = await avatar();
    await store.save(a);
    const assets = fake.stores().get('assets')!;
    const metas = fake.stores().get('metadata')!;
    const originalMeta = structuredClone(metas.get(a.id));
    const originalAsset = structuredClone(assets.get(a.id));
    const corrupt = (assets.get(a.id) as { data: ArrayBuffer }).data;
    new Uint8Array(corrupt)[23] = 9;
    await expect(store.load(a.id)).rejects.toThrow(/SHA-256 identity/);
    await expect(store.save(a)).rejects.toThrow(/SHA-256 identity/);
    assets.set(a.id, structuredClone(originalAsset));
    metas.set(a.id, { ...(originalMeta as object), bytes: a.bytes + 1 });
    await expect(store.load(a.id)).rejects.toThrow(/byte size/);
    metas.set(a.id, { ...(originalMeta as object), forward: 'bad' });
    await expect(store.list()).rejects.toThrow(/forward/);
    metas.set(a.id, { ...(originalMeta as object), heightM: 2 });
    await expect(store.load(a.id)).rejects.toThrow(/identity/);
    metas.set(a.id, { ...(originalMeta as object), bytes: 21 * MiB });
    await expect(store.list()).rejects.toThrow(/byte size/);
    metas.set(a.id, originalMeta);
    assets.delete(a.id);
    await expect(store.load(a.id)).rejects.toThrow(/missing asset/);
    await expect(store.save(await avatar(1))).rejects.toThrow(/metadata and assets differ/);
    await expect(store.select(a.id)).rejects.toThrow(/missing asset/);
    assets.set(a.id, originalAsset);
    metas.delete(a.id);
    await expect(store.load(a.id)).rejects.toThrow(/metadata/);
    await store.remove(a.id);
    expect(await store.list()).toEqual([]);
  });

  it('detects corrupt selection rather than returning an unknown asset', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const a = await avatar();
    await store.save(a);
    await store.select(a.id);
    fake.stores().get('assets')!.delete(a.id);
    await expect(store.selected()).rejects.toThrow(/missing asset/);
    fake.stores().get('settings')!.set('selected', { url: 'https://example.test/raw.glb' });
    await expect(store.selected()).rejects.toThrow(/selection/);
    await store.select(null);
    expect(await store.selected()).toBeNull();
  });

  it('persists only allowlisted descriptor/data fields, never source URLs', async () => {
    const fake = fakeIndexedDB();
    const store = createAvatarStore({ indexedDB: fake.factory });
    const a = await avatar();
    const extra = {
      ...a,
      url: 'https://example.test/signed.glb?token=secret',
      sourceUrl: 'blob:temporary',
      thumbnail: 'data:image/png;base64,test',
    };
    const saved = await store.save(extra);
    await store.select(a.id);
    expect(Object.keys(saved).sort()).toEqual(['bytes', 'forward', 'heightM', 'id', 'name']);
    expect(Object.keys(fake.stores().get('assets')!.get(a.id) as object).sort()).toEqual(['data', 'id']);
    expect(Object.keys((await store.load(a.id))!).sort()).toEqual(['bytes', 'data', 'forward', 'heightM', 'id', 'name']);
    const serialized = JSON.stringify([...fake.stores().values()].map((s) => [...s.values()]));
    expect(serialized).not.toMatch(/https:|blob:|data:|sourceUrl|thumbnail|token/);
  });
});
