import JSZip from 'jszip';
import type {
  WorkerAddEntry,
  ZipWorkerInMessage,
  ZipWorkerOutMessage,
} from '../workers/zipWorker';

export interface ZipWorkerSession {
  addFile(path: string, data: Blob | ArrayBuffer | Uint8Array | string): Promise<void>;
  addFilesBatch(
    items: Array<{ path: string; data: Blob | ArrayBuffer | Uint8Array | string }>
  ): Promise<void>;
  generateBlob(
    onProgress?: (percent: number) => void,
    compression?: 'STORE' | 'DEFLATE'
  ): Promise<Blob>;
  dispose(): void;
}

const textEncoder = new TextEncoder();

async function toOwnedArrayBuffer(
  data: Blob | ArrayBuffer | Uint8Array | string
): Promise<ArrayBuffer> {
  if (typeof data === 'string') {
    const encoded = textEncoder.encode(data);
    const copy = new Uint8Array(encoded.byteLength);
    copy.set(encoded);
    return copy.buffer;
  }
  if (data instanceof Blob) {
    return await data.arrayBuffer();
  }
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
  }
  return data.slice(0);
}

export function createZipWorkerSession(): ZipWorkerSession {
  if (typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('../workers/zipWorker.ts', import.meta.url), {
        type: 'module',
      });
      worker.postMessage({ type: 'init' } satisfies ZipWorkerInMessage);

      return {
        async addFile(path, data) {
          const buf = await toOwnedArrayBuffer(data);
          const msg: ZipWorkerInMessage = {
            type: 'add',
            entries: [{ path, data: buf }],
          };
          worker.postMessage(msg, [buf]);
        },

        async addFilesBatch(items) {
          if (items.length === 0) return;
          const entries: WorkerAddEntry[] = await Promise.all(
            items.map(async (item) => ({
              path: item.path,
              data: await toOwnedArrayBuffer(item.data),
            }))
          );
          const transferables = entries.map((e) => e.data);
          const msg: ZipWorkerInMessage = { type: 'add', entries };
          worker.postMessage(msg, transferables);
        },

        generateBlob(onProgress, compression = 'STORE') {
          return new Promise<Blob>((resolve, reject) => {
            const onMessage = (event: MessageEvent<ZipWorkerOutMessage>) => {
              const payload = event.data;
              if (payload.type === 'progress') {
                onProgress?.(payload.percent);
              } else if (payload.type === 'done') {
                cleanup();
                resolve(new Blob([payload.buffer], { type: 'application/zip' }));
              } else if (payload.type === 'error') {
                cleanup();
                reject(new Error(payload.message));
              }
            };
            const onError = (err: ErrorEvent) => {
              cleanup();
              reject(new Error(err.message || 'Falha no Web Worker de ZIP.'));
            };
            const cleanup = () => {
              worker.removeEventListener('message', onMessage);
              worker.removeEventListener('error', onError);
            };
            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            worker.postMessage({
              type: 'generate',
              compression,
            } satisfies ZipWorkerInMessage);
          });
        },

        dispose() {
          worker.terminate();
        },
      };
    } catch {
      // Fall back to main-thread JSZip below if Worker construction fails
    }
  }

  const fallbackZip = new JSZip();
  return {
    async addFile(path, data) {
      fallbackZip.file(path, data);
    },
    async addFilesBatch(items) {
      for (const item of items) {
        fallbackZip.file(item.path, item.data);
      }
    },
    async generateBlob(onProgress, compression = 'STORE') {
      return await fallbackZip.generateAsync(
        { type: 'blob', compression },
        (meta) => onProgress?.(Math.round(meta.percent))
      );
    },
    dispose() {
      // no-op
    },
  };
}
