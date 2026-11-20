import JSZip from 'jszip';

export interface WorkerAddEntry {
  path: string;
  data: ArrayBuffer;
}

export type ZipWorkerInMessage =
  | { type: 'init' }
  | { type: 'add'; entries: WorkerAddEntry[] }
  | { type: 'generate'; compression?: 'STORE' | 'DEFLATE' };

export type ZipWorkerOutMessage =
  | { type: 'progress'; percent: number }
  | { type: 'done'; buffer: ArrayBuffer }
  | { type: 'error'; message: string };

let zip = new JSZip();

self.onmessage = async (event: MessageEvent<ZipWorkerInMessage>) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      zip = new JSZip();
      return;
    }

    if (msg.type === 'add') {
      for (const entry of msg.entries) {
        zip.file(entry.path, entry.data);
      }
      return;
    }

    if (msg.type === 'generate') {
      const compression = msg.compression ?? 'STORE';
      let lastReported = -1;
      const uint8 = await zip.generateAsync(
        {
          type: 'uint8array',
          compression,
          ...(compression === 'DEFLATE' ? { compressionOptions: { level: 3 } } : {}),
        },
        (meta) => {
          const pct = Math.round(meta.percent);
          if (pct !== lastReported) {
            lastReported = pct;
            (self as unknown as Worker).postMessage({
              type: 'progress',
              percent: pct,
            } satisfies ZipWorkerOutMessage);
          }
        }
      );

      // Copy into a cleanly owned ArrayBuffer for zero-copy transfer
      const outCopy = new Uint8Array(uint8.byteLength);
      outCopy.set(uint8);
      const outBuffer: ArrayBuffer = outCopy.buffer;
      (self as unknown as Worker).postMessage(
        { type: 'done', buffer: outBuffer } satisfies ZipWorkerOutMessage,
        [outBuffer]
      );
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : 'Erro no Web Worker ao gerar ZIP.',
    } satisfies ZipWorkerOutMessage);
  }
};
