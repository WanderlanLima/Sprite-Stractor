import { computeCrc32, type StreamingZipEntry } from './streamingZip';

export type BatchContentMode = 'idle-only' | 'all-sliced' | 'raw-bundle';
export type BatchJobStatus = 'running' | 'paused' | 'completed';

export interface StoredNinjaFileRecord {
  path: string;
  blob: Blob;
  size: number;
  crc32: number;
}

export interface StoredNinjaEntry {
  key: string; // `${jobId}:${ninjaIndex}`
  jobId: string;
  ninjaIndex: number; // 0-based index within target range
  ninjaId: string;
  files: StoredNinjaFileRecord[];
  totalBytes: number;
}

export interface BatchJobRecord {
  id: string;
  contentMode: BatchContentMode;
  startIdx: number;
  endIdx: number;
  chunkSize: number;
  totalNinjas: number;
  completedIndices: number[];
  failedIndices: number[];
  exportedParts: number[];
  totalBytes: number;
  totalFilesCount: number;
  status: BatchJobStatus;
  updatedAt: number;
}

const DB_NAME = 'shinobi_batch_zip_db';
const DB_VERSION = 1;
const STORE_JOBS = 'jobs';
const STORE_FILES = 'ninja_files';

// In-memory fallback when IndexedDB is unavailable (e.g., strict private browsing)
const memoryJobs = new Map<string, BatchJobRecord>();
const memoryFiles = new Map<string, StoredNinjaEntry>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openBatchDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_JOBS)) {
            db.createObjectStore(STORE_JOBS, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_FILES)) {
            const store = db.createObjectStore(STORE_FILES, { keyPath: 'key' });
            store.createIndex('jobId', 'jobId', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {
    // ignore
  }
}

export async function prepareFileRecord(
  path: string,
  data: Blob | ArrayBuffer | Uint8Array | string
): Promise<StoredNinjaFileRecord> {
  let bytes: Uint8Array;
  let blob: Blob;

  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
    blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'text/plain;charset=utf-8' });
  } else if (data instanceof Blob) {
    const ab = await data.arrayBuffer();
    bytes = new Uint8Array(ab);
    blob = data;
  } else if (data instanceof Uint8Array) {
    bytes = data;
    blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
  } else {
    bytes = new Uint8Array(data);
    blob = new Blob([data]);
  }

  return {
    path,
    blob,
    size: bytes.byteLength,
    crc32: computeCrc32(bytes),
  };
}

export async function getLatestBatchJob(): Promise<BatchJobRecord | null> {
  const db = await openBatchDb();
  if (!db) {
    const all = Array.from(memoryJobs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    const latest = all[0] || null;
    if (latest && latest.status === 'running') {
      latest.status = 'paused';
    }
    return latest;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_JOBS, 'readonly');
      const req = tx.objectStore(STORE_JOBS).getAll();
      req.onsuccess = () => {
        const list = (req.result as BatchJobRecord[]) || [];
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        const latest = list[0] || null;
        if (latest && latest.status === 'running') {
          // App was closed or crashed mid-run; normalize to paused so user can resume
          latest.status = 'paused';
        }
        resolve(latest);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function clearAllBatchJobs(): Promise<void> {
  memoryJobs.clear();
  memoryFiles.clear();

  const db = await openBatchDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE_JOBS, STORE_FILES], 'readwrite');
      tx.objectStore(STORE_JOBS).clear();
      tx.objectStore(STORE_FILES).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function createBatchJob(params: {
  contentMode: BatchContentMode;
  startIdx: number;
  endIdx: number;
  chunkSize: number;
  totalNinjas: number;
}): Promise<BatchJobRecord> {
  await clearAllBatchJobs();
  void requestPersistentStorage();

  const job: BatchJobRecord = {
    id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    contentMode: params.contentMode,
    startIdx: params.startIdx,
    endIdx: params.endIdx,
    chunkSize: params.chunkSize,
    totalNinjas: params.totalNinjas,
    completedIndices: [],
    failedIndices: [],
    exportedParts: [],
    totalBytes: 0,
    totalFilesCount: 0,
    status: 'running',
    updatedAt: Date.now(),
  };

  memoryJobs.set(job.id, job);

  const db = await openBatchDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_JOBS, 'readwrite');
        tx.objectStore(STORE_JOBS).put(job);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  return job;
}

export async function saveBatchJobRecord(job: BatchJobRecord): Promise<void> {
  const updated: BatchJobRecord = {
    ...job,
    updatedAt: Date.now(),
  };
  memoryJobs.set(updated.id, updated);

  const db = await openBatchDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_JOBS, 'readwrite');
      tx.objectStore(STORE_JOBS).put(updated);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function saveNinjaFilesToStore(
  jobId: string,
  ninjaIndex: number,
  ninjaId: string,
  files: StoredNinjaFileRecord[]
): Promise<number> {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const entry: StoredNinjaEntry = {
    key: `${jobId}:${ninjaIndex}`,
    jobId,
    ninjaIndex,
    ninjaId,
    files,
    totalBytes,
  };

  const db = await openBatchDb();
  if (!db) {
    memoryFiles.set(entry.key, entry);
    return totalBytes;
  }

  const ok = await new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readwrite');
      tx.objectStore(STORE_FILES).put(entry);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });

  if (!ok) {
    memoryFiles.set(entry.key, entry);
  }
  return totalBytes;
}

async function getStoredNinjaEntry(
  db: IDBDatabase | null,
  jobId: string,
  ninjaIndex: number
): Promise<StoredNinjaEntry | null> {
  const key = `${jobId}:${ninjaIndex}`;
  const mem = memoryFiles.get(key);
  if (mem) return mem;
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readonly');
      const req = tx.objectStore(STORE_FILES).get(key);
      req.onsuccess = () => resolve((req.result as StoredNinjaEntry) || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function* iterateJobZipEntries(
  jobId: string,
  startNinjaIndex: number,
  endNinjaIndexExclusive: number
): AsyncIterable<StreamingZipEntry[]> {
  const db = await openBatchDb();
  const BATCH_READ = 8;

  for (let i = startNinjaIndex; i < endNinjaIndexExclusive; i += BATCH_READ) {
    const end = Math.min(endNinjaIndexExclusive, i + BATCH_READ);
    const promises: Promise<StoredNinjaEntry | null>[] = [];
    for (let idx = i; idx < end; idx++) {
      promises.push(getStoredNinjaEntry(db, jobId, idx));
    }
    const records = await Promise.all(promises);
    const out: StreamingZipEntry[] = [];
    for (const rec of records) {
      if (!rec) continue;
      for (const f of rec.files) {
        out.push({
          path: f.path,
          size: f.size,
          crc32: f.crc32,
          blob: f.blob,
        });
      }
    }
    if (out.length > 0) {
      yield out;
    }
  }
}

export async function countEntriesInRange(
  jobId: string,
  startNinjaIndex: number,
  endNinjaIndexExclusive: number
): Promise<number> {
  const db = await openBatchDb();
  let count = 0;
  for (let idx = startNinjaIndex; idx < endNinjaIndexExclusive; idx += 20) {
    const end = Math.min(endNinjaIndexExclusive, idx + 20);
    const promises: Promise<StoredNinjaEntry | null>[] = [];
    for (let k = idx; k < end; k++) {
      promises.push(getStoredNinjaEntry(db, jobId, k));
    }
    const records = await Promise.all(promises);
    for (const r of records) {
      if (r) count += r.files.length;
    }
  }
  return count;
}

export function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
