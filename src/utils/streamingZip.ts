const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface StreamingZipEntry {
  path: string;
  size: number;
  crc32: number;
  blob: Blob;
}

interface CentralDirRecord {
  nameBytes: Uint8Array;
  crc32: number;
  size: number;
  offset: number;
  modTime: number;
  modDate: number;
}

const textEncoder = new TextEncoder();
const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;
const SMALL_FILE_THRESHOLD = 64 * 1024; // 64 KB
const STAGING_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB

function getDosDateTime(date = new Date()): { modTime: number; modDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const modTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const modDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { modTime, modDate };
}

function buildLocalFileHeader(
  nameBytes: Uint8Array,
  crc32: number,
  size: number,
  modTime: number,
  modDate: number
): Uint8Array {
  const needsZip64 = size >= MAX_U32;
  const extraLen = needsZip64 ? 20 : 0;
  const header = new Uint8Array(30 + nameBytes.length + extraLen);
  const view = new DataView(header.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, needsZip64 ? 45 : 20, true);
  view.setUint16(6, 0x0800, true); // UTF-8 filename flag
  view.setUint16(8, 0, true); // STORE (no compression)
  view.setUint16(10, modTime, true);
  view.setUint16(12, modDate, true);
  view.setUint32(14, crc32 >>> 0, true);
  view.setUint32(18, needsZip64 ? MAX_U32 : size, true);
  view.setUint32(22, needsZip64 ? MAX_U32 : size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, extraLen, true);
  header.set(nameBytes, 30);

  if (needsZip64) {
    const extPos = 30 + nameBytes.length;
    view.setUint16(extPos, 0x0001, true);
    view.setUint16(extPos + 2, 16, true);
    view.setBigUint64(extPos + 4, BigInt(size), true);
    view.setBigUint64(extPos + 12, BigInt(size), true);
  }

  return header;
}

function buildCentralDirectoryAndEocd(
  records: CentralDirRecord[],
  cdOffset: number
): Uint8Array[] {
  const cdParts: Uint8Array[] = [];
  let cdSize = 0;

  for (const rec of records) {
    const needsSize64 = rec.size >= MAX_U32;
    const needsOffset64 = rec.offset >= MAX_U32;
    const extraPayloadLen = (needsSize64 ? 16 : 0) + (needsOffset64 ? 8 : 0);
    const extraLen = extraPayloadLen > 0 ? 4 + extraPayloadLen : 0;

    const entry = new Uint8Array(46 + rec.nameBytes.length + extraLen);
    const view = new DataView(entry.buffer);

    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, extraLen > 0 ? 45 : 20, true);
    view.setUint16(6, extraLen > 0 ? 45 : 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true); // STORE
    view.setUint16(12, rec.modTime, true);
    view.setUint16(14, rec.modDate, true);
    view.setUint32(16, rec.crc32 >>> 0, true);
    view.setUint32(20, needsSize64 ? MAX_U32 : rec.size, true);
    view.setUint32(24, needsSize64 ? MAX_U32 : rec.size, true);
    view.setUint16(28, rec.nameBytes.length, true);
    view.setUint16(30, extraLen, true);
    view.setUint16(32, 0, true); // comment len
    view.setUint16(34, 0, true); // disk start
    view.setUint16(36, 0, true); // internal attrs
    view.setUint32(38, 0, true); // external attrs
    view.setUint32(42, needsOffset64 ? MAX_U32 : rec.offset, true);
    entry.set(rec.nameBytes, 46);

    if (extraLen > 0) {
      let extPos = 46 + rec.nameBytes.length;
      view.setUint16(extPos, 0x0001, true);
      view.setUint16(extPos + 2, extraPayloadLen, true);
      extPos += 4;
      if (needsSize64) {
        view.setBigUint64(extPos, BigInt(rec.size), true);
        view.setBigUint64(extPos + 8, BigInt(rec.size), true);
        extPos += 16;
      }
      if (needsOffset64) {
        view.setBigUint64(extPos, BigInt(rec.offset), true);
      }
    }

    cdParts.push(entry);
    cdSize += entry.byteLength;
  }

  const count = records.length;
  const needsZip64Eocd =
    count >= MAX_U16 || cdSize >= MAX_U32 || cdOffset >= MAX_U32;

  if (needsZip64Eocd) {
    const zip64EocdOffset = cdOffset + cdSize;
    const z64 = new Uint8Array(56);
    const z64View = new DataView(z64.buffer);
    z64View.setUint32(0, 0x06064b50, true);
    z64View.setBigUint64(4, 44n, true);
    z64View.setUint16(12, 45, true);
    z64View.setUint16(14, 45, true);
    z64View.setUint32(16, 0, true);
    z64View.setUint32(20, 0, true);
    z64View.setBigUint64(24, BigInt(count), true);
    z64View.setBigUint64(32, BigInt(count), true);
    z64View.setBigUint64(40, BigInt(cdSize), true);
    z64View.setBigUint64(48, BigInt(cdOffset), true);
    cdParts.push(z64);

    const loc = new Uint8Array(20);
    const locView = new DataView(loc.buffer);
    locView.setUint32(0, 0x07064b50, true);
    locView.setUint32(4, 0, true);
    locView.setBigUint64(8, BigInt(zip64EocdOffset), true);
    locView.setUint32(16, 1, true);
    cdParts.push(loc);
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, count >= MAX_U16 ? MAX_U16 : count, true);
  eocdView.setUint16(10, count >= MAX_U16 ? MAX_U16 : count, true);
  eocdView.setUint32(12, cdSize >= MAX_U32 ? MAX_U32 : cdSize, true);
  eocdView.setUint32(16, cdOffset >= MAX_U32 ? MAX_U32 : cdOffset, true);
  eocdView.setUint16(20, 0, true);
  cdParts.push(eocd);

  return cdParts;
}

const yieldFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Builds a composite disk-backed Blob without holding the whole archive in JS heap.
 * Small entries (< 64 KB) + headers are coalesced into 2 MB chunks; large Blobs
 * (>= 64 KB, e.g. WebP sheets stored in IndexedDB) are appended directly by reference.
 */
export async function assembleStreamingZipBlob(
  iterateEntries: () => AsyncIterable<StreamingZipEntry[]>,
  totalEntriesEstimate: number,
  onProgress?: (percent: number) => void
): Promise<Blob> {
  const zipParts: BlobPart[] = [];
  const records: CentralDirRecord[] = [];
  const { modTime, modDate } = getDosDateTime();

  let staging = new Uint8Array(STAGING_CHUNK_SIZE);
  let stagingUsed = 0;

  const flushStaging = () => {
    if (stagingUsed > 0) {
      zipParts.push(new Blob([staging.slice(0, stagingUsed)]));
      stagingUsed = 0;
    }
  };

  const appendBytes = (bytes: Uint8Array) => {
    if (bytes.byteLength >= STAGING_CHUNK_SIZE) {
      flushStaging();
      zipParts.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      return;
    }
    if (stagingUsed + bytes.byteLength > staging.byteLength) {
      flushStaging();
    }
    staging.set(bytes, stagingUsed);
    stagingUsed += bytes.byteLength;
  };

  let offset = 0;
  let processed = 0;
  let lastReportedPct = -1;

  for await (const batch of iterateEntries()) {
    for (const entry of batch) {
      const nameBytes = textEncoder.encode(entry.path);
      const localHeader = buildLocalFileHeader(
        nameBytes,
        entry.crc32,
        entry.size,
        modTime,
        modDate
      );

      records.push({
        nameBytes,
        crc32: entry.crc32,
        size: entry.size,
        offset,
        modTime,
        modDate,
      });

      appendBytes(localHeader);
      offset += localHeader.byteLength;

      if (entry.size > 0) {
        if (entry.size < SMALL_FILE_THRESHOLD) {
          const smallBytes = new Uint8Array(await entry.blob.arrayBuffer());
          appendBytes(smallBytes);
          offset += smallBytes.byteLength;
        } else {
          flushStaging();
          zipParts.push(entry.blob);
          offset += entry.size;
        }
      }

      processed++;
      if (totalEntriesEstimate > 0 && onProgress) {
        const pct = Math.min(95, Math.round((processed / totalEntriesEstimate) * 95));
        if (pct !== lastReportedPct) {
          lastReportedPct = pct;
          onProgress(pct);
        }
      }
    }
    await yieldFrame();
  }

  flushStaging();
  staging = new Uint8Array(0);

  const cdAndEocd = buildCentralDirectoryAndEocd(records, offset);
  for (const part of cdAndEocd) {
    zipParts.push(part as BlobPart);
  }

  onProgress?.(100);
  return new Blob(zipParts, { type: 'application/zip' });
}

/**
 * Streams a ZIP archive directly into a FileSystemWritableFileStream (File System Access API)
 * with tiny RAM footprint (~2-4 MB).
 */
export async function streamZipToWritable(
  iterateEntries: () => AsyncIterable<StreamingZipEntry[]>,
  writable: { write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> },
  totalEntriesEstimate: number,
  onProgress?: (percent: number) => void
): Promise<void> {
  const records: CentralDirRecord[] = [];
  const { modTime, modDate } = getDosDateTime();

  let staging = new Uint8Array(STAGING_CHUNK_SIZE);
  let stagingUsed = 0;

  const flushStaging = async () => {
    if (stagingUsed > 0) {
      await writable.write(staging.slice(0, stagingUsed));
      stagingUsed = 0;
    }
  };

  const appendBytes = async (bytes: Uint8Array) => {
    if (bytes.byteLength >= STAGING_CHUNK_SIZE) {
      await flushStaging();
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
      return;
    }
    if (stagingUsed + bytes.byteLength > staging.byteLength) {
      await flushStaging();
    }
    staging.set(bytes, stagingUsed);
    stagingUsed += bytes.byteLength;
  };

  let offset = 0;
  let processed = 0;
  let lastReportedPct = -1;

  for await (const batch of iterateEntries()) {
    for (const entry of batch) {
      const nameBytes = textEncoder.encode(entry.path);
      const localHeader = buildLocalFileHeader(
        nameBytes,
        entry.crc32,
        entry.size,
        modTime,
        modDate
      );

      records.push({
        nameBytes,
        crc32: entry.crc32,
        size: entry.size,
        offset,
        modTime,
        modDate,
      });

      await appendBytes(localHeader);
      offset += localHeader.byteLength;

      if (entry.size > 0) {
        if (entry.size < SMALL_FILE_THRESHOLD) {
          const smallBytes = new Uint8Array(await entry.blob.arrayBuffer());
          await appendBytes(smallBytes);
          offset += smallBytes.byteLength;
        } else {
          await flushStaging();
          await writable.write(entry.blob);
          offset += entry.size;
        }
      }

      processed++;
      if (totalEntriesEstimate > 0 && onProgress) {
        const pct = Math.min(95, Math.round((processed / totalEntriesEstimate) * 95));
        if (pct !== lastReportedPct) {
          lastReportedPct = pct;
          onProgress(pct);
        }
      }
    }
    await yieldFrame();
  }

  await flushStaging();
  staging = new Uint8Array(0);

  const cdAndEocd = buildCentralDirectoryAndEocd(records, offset);
  for (const part of cdAndEocd) {
    await writable.write(part as Uint8Array<ArrayBuffer>);
  }

  await writable.close();
  onProgress?.(100);
}
