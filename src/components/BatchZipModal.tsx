import { useEffect, useRef, useState } from 'react';
import {
  Download,
  HardDriveDownload,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import type { NinjaEntry } from '../types/sprite';
import {
  downloadBlob,
  extractRegionToCanvas,
  extractRegionToPngBlob,
  loadImageElement,
  parseAtlas,
} from '../utils/atlasParser';
import {
  type BatchContentMode,
  type BatchJobRecord,
  type StoredNinjaFileRecord,
  clearAllBatchJobs,
  countEntriesInRange,
  createBatchJob,
  formatBytesCompact,
  getLatestBatchJob,
  iterateJobZipEntries,
  prepareFileRecord,
  saveBatchJobRecord,
  saveNinjaFilesToStore,
} from '../utils/batchDownloadStore';
import {
  buildCharacterInstructionsJson,
  collectCharacterCompleteFiles,
  collectCharacterEffectPlan,
  fetchParsedEffectAsset,
  sanitizePathSegment,
  type EffectIncludeScope,
  type ParsedEffectAsset,
} from '../utils/completeCharacterExporter';
import { fetchNinjaBundle } from '../utils/remoteClient';
import { assembleStreamingZipBlob, streamZipToWritable } from '../utils/streamingZip';

interface BatchZipModalProps {
  isOpen: boolean;
  ninjas: NinjaEntry[];
  title?: string;
  onClose: () => void;
}

type PauseReason = 'user' | 'network' | null;

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write(data: BufferSource | Blob): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
}

function isLikelyNetworkError(err: unknown): boolean {
  if (!navigator.onLine) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === 'TypeError' ||
    err.name === 'TimeoutError' ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('load failed') ||
    msg.includes('err_internet') ||
    msg.includes('falha ao carregar imagem') ||
    msg.includes('http 5') ||
    msg.includes('http 429')
  );
}

async function loadImageWithRetry(
  url: string,
  signal: AbortSignal,
  attempts = 3
): Promise<HTMLImageElement> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      return await loadImageElement(url);
    } catch (err) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      lastErr = err;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Falha ao carregar imagem: ${url}`);
}

async function fetchBufferWithRetry(
  url: string,
  signal: AbortSignal,
  attempts = 3
): Promise<ArrayBuffer> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      const resp = await fetch(url, { signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return await resp.arrayBuffer();
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        throw err;
      }
      lastErr = err;
      if (attempt < attempts - 1) {
        const delay = 500 * (attempt + 1) * (attempt + 1);
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, delay);
          const onAbort = () => {
            clearTimeout(t);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Falha ao baixar arquivo.');
}

const MODE_LABELS: Record<BatchContentMode, string> = {
  'idle-only': '1 Sprite Principal (PNG)',
  'all-sliced': 'Todos os Frames Fatiados (Pastas + PNGs)',
  'raw-bundle': 'Pacotes Originais (.webp + .atlas + .json)',
  'complete-animated': 'Personagem Completo (Animações + Partículas + Originais)',
};

function getSpineFolderPrefix(ninja: NinjaEntry): string {
  const kind =
    ninja.kind ??
    (ninja.id.toLowerCase().startsWith('vdfno_')
      ? 'character'
      : /(?:_effect|_highteffect|_ground)$/i.test(ninja.id) ||
        ninja.id.toLowerCase().includes('huomiao')
      ? 'effect'
      : 'summon_skin');

  if (kind === 'effect') return `efeitos/${ninja.id}`;
  if (kind === 'summon_skin') return `invocacoes_skins/${ninja.id}`;
  return `ninjas/${ninja.id}`;
}

export function BatchZipModal({
  isOpen,
  ninjas,
  title = 'Exportar Catálogo Spine em Lote (ZIP)',
  onClose,
}: BatchZipModalProps) {
  const [contentMode, setContentMode] = useState<BatchContentMode>('idle-only');
  const [includeLinkedEffects, setIncludeLinkedEffects] = useState(true);
  const [effectScope, setEffectScope] = useState<EffectIncludeScope>('powers');
  const [includeAnimGifs, setIncludeAnimGifs] = useState(true);
  const [startIdx, setStartIdx] = useState(1);
  const [endIdx, setEndIdx] = useState(() => ninjas.length);
  const [chunkSize, setChunkSize] = useState<number>(100);
  const [concurrency, setConcurrency] = useState<number>(8);

  const [savedJob, setSavedJob] = useState<BatchJobRecord | null>(null);
  const [running, setRunning] = useState(false);
  const [packaging, setPackaging] = useState(false);
  const [pausedByNetwork, setPausedByNetwork] = useState(false);

  const [progress, setProgress] = useState({
    done: 0,
    total: 0,
    currentId: '',
    errors: 0,
    ratePerSec: 0,
    savedBytes: 0,
    zipPercent: null as number | null,
  });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pauseReasonRef = useRef<PauseReason>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStartIdx(1);
    setEndIdx(ninjas.length);
    let active = true;
    void getLatestBatchJob().then((job) => {
      if (!active || !job) return;
      setSavedJob(job);
      if (job.status === 'paused') {
        setContentMode(job.contentMode);
        if (typeof job.includeLinkedEffects === 'boolean') {
          setIncludeLinkedEffects(job.includeLinkedEffects);
        }
        if (job.effectScope) {
          setEffectScope(job.effectScope);
        }
        if (typeof job.includeAnimGifs === 'boolean') {
          setIncludeAnimGifs(job.includeAnimGifs);
        }
        setStartIdx(job.startIdx);
        setEndIdx(job.endIdx);
        setChunkSize(job.chunkSize);
        setProgress({
          done: job.completedIndices.length,
          total: job.totalNinjas,
          currentId: '',
          errors: job.failedIndices.length,
          ratePerSec: 0,
          savedBytes: job.totalBytes,
          zipPercent: null,
        });
      }
    });
    return () => {
      active = false;
    };
  }, [isOpen, ninjas.length]);

  if (!isOpen) return null;

  const safeStart = Math.max(1, Math.min(startIdx, ninjas.length));
  const safeEnd = Math.max(safeStart, Math.min(endIdx || ninjas.length, ninjas.length));
  const targetList = ninjas.slice(safeStart - 1, safeEnd);
  const supportsSavePicker =
    typeof window !== 'undefined' &&
    typeof (window as SaveFilePickerWindow).showSaveFilePicker === 'function';

  const handlePause = () => {
    pauseReasonRef.current = 'user';
    abortRef.current?.abort();
  };

  const handleDiscardSaved = async () => {
    await clearAllBatchJobs();
    setSavedJob(null);
    setPausedByNetwork(false);
    setStatusMessage(null);
    setProgress({
      done: 0,
      total: 0,
      currentId: '',
      errors: 0,
      ratePerSec: 0,
      savedBytes: 0,
      zipPercent: null,
    });
  };

  const packageRangeToZip = async (
    job: BatchJobRecord,
    rangeStart: number,
    rangeEnd: number,
    filename: string,
    partLabel?: string
  ) => {
    setPackaging(true);
    setStatusMessage(
      partLabel
        ? `Gerando ${partLabel} sem uso excessivo de memória...`
        : 'Gerando arquivo ZIP em fluxo contínuo...'
    );
    setProgress((prev) => ({ ...prev, zipPercent: 0 }));

    const entryEstimate = await countEntriesInRange(job.id, rangeStart, rangeEnd);
    const zipBlob = await assembleStreamingZipBlob(
      () => iterateJobZipEntries(job.id, rangeStart, rangeEnd),
      entryEstimate,
      (pct) => setProgress((prev) => ({ ...prev, zipPercent: pct }))
    );

    downloadBlob(zipBlob, filename);
  };

  const handleDirectSaveToDisk = async (job: BatchJobRecord) => {
    const pickerFn = (window as SaveFilePickerWindow).showSaveFilePicker;
    if (!pickerFn) return;

    const filename = `shinobi_sprites_${job.contentMode}_${job.startIdx}_a_${job.endIdx}.zip`;
    try {
      const handle = await pickerFn({
        suggestedName: filename,
        types: [
          {
            description: 'Arquivo ZIP',
            accept: { 'application/zip': ['.zip'] },
          },
        ],
      });
      setPackaging(true);
      setStatusMessage('Gravando ZIP direto no disco...');
      setProgress((prev) => ({ ...prev, zipPercent: 0 }));

      const writable = await handle.createWritable();
      const entryEstimate = await countEntriesInRange(job.id, 0, job.totalNinjas);
      await streamZipToWritable(
        () => iterateJobZipEntries(job.id, 0, job.totalNinjas),
        writable,
        entryEstimate,
        (pct) => setProgress((prev) => ({ ...prev, zipPercent: pct }))
      );

      setStatusMessage(`Arquivo "${filename}" salvo diretamente no disco com sucesso!`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setStatusMessage(
        err instanceof Error ? err.message : 'Não foi possível gravar direto no disco.'
      );
    } finally {
      setPackaging(false);
    }
  };

  const handleReexportSaved = async (job: BatchJobRecord, partialLabel?: string) => {
    try {
      const suffix = partialLabel ? `_${partialLabel}` : '';
      const filename = `shinobi_sprites_${job.contentMode}_${job.startIdx}_a_${job.endIdx}${suffix}.zip`;
      await packageRangeToZip(job, 0, job.totalNinjas, filename);
      setStatusMessage(
        `ZIP gerado (${job.completedIndices.length} ninjas · ${formatBytesCompact(job.totalBytes)}). Se o navegador bloqueou o pop-up, clique em "Baixar ZIP".`
      );
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : 'Erro ao montar arquivo ZIP a partir do cache.'
      );
    } finally {
      setPackaging(false);
    }
  };

  const runJob = async (existingJob?: BatchJobRecord) => {
    const activeMode = existingJob ? existingJob.contentMode : contentMode;
    const activeIncludeEffects = existingJob
      ? existingJob.includeLinkedEffects ?? true
      : activeMode === 'idle-only'
      ? false
      : includeLinkedEffects;
    const activeEffectScope: EffectIncludeScope = existingJob
      ? existingJob.effectScope ?? 'powers'
      : effectScope;
    const activeIncludeGifs = existingJob
      ? existingJob.includeAnimGifs ?? true
      : includeAnimGifs;

    const activeStart = existingJob ? existingJob.startIdx : safeStart;
    const activeEnd = existingJob ? existingJob.endIdx : safeEnd;
    const activeChunk = existingJob ? existingJob.chunkSize : chunkSize;
    const activeList = ninjas.slice(activeStart - 1, activeEnd);

    if (activeList.length === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;
    pauseReasonRef.current = null;
    setPausedByNetwork(false);
    setRunning(true);
    setPackaging(false);
    setStatusMessage(null);

    const onOffline = () => {
      pauseReasonRef.current = 'network';
      controller.abort();
    };
    window.addEventListener('offline', onOffline);

    const job: BatchJobRecord = existingJob
      ? { ...existingJob, status: 'running' }
      : await createBatchJob({
          contentMode: activeMode,
          includeLinkedEffects: activeIncludeEffects,
          effectScope: activeEffectScope,
          includeAnimGifs: activeIncludeGifs,
          startIdx: activeStart,
          endIdx: activeEnd,
          chunkSize: activeChunk,
          totalNinjas: activeList.length,
        });

    if (existingJob) {
      await saveBatchJobRecord(job);
    }
    setSavedJob(job);

    const completedSet = new Set<number>(job.completedIndices);
    const failedSet = new Set<number>(job.failedIndices);
    const exportedPartsSet = new Set<number>(job.exportedParts);

    const effectiveChunk =
      activeChunk <= 0 ? activeList.length : Math.max(10, activeChunk);
    const totalParts = Math.ceil(activeList.length / effectiveChunk);
    const requestedWorkers = Math.max(1, Math.min(16, concurrency));
    const workers =
      activeMode === 'complete-animated' ? Math.min(requestedWorkers, 2) : requestedWorkers;

    const effectCache = new Map<string, Promise<ParsedEffectAsset | null>>();
    const startedAt = performance.now();
    const initialDone = completedSet.size;
    let sessionDone = 0;
    let totalBytes = job.totalBytes;
    let consecutiveNetErrors = 0;

    setProgress({
      done: completedSet.size,
      total: activeList.length,
      currentId: activeList[Math.min(completedSet.size, activeList.length - 1)]?.id || '',
      errors: failedSet.size,
      ratePerSec: 0,
      savedBytes: totalBytes,
      zipPercent: null,
    });

    const persistJobProgress = (() => {
      let queue: Promise<void> = Promise.resolve();
      let inFlight = false;
      return (force = false) => {
        if (inFlight && !force) return queue;
        queue = queue.then(async () => {
          inFlight = true;
          try {
            job.completedIndices = Array.from(completedSet).sort((a, b) => a - b);
            job.failedIndices = Array.from(failedSet).sort((a, b) => a - b);
            job.exportedParts = Array.from(exportedPartsSet).sort((a, b) => a - b);
            job.totalBytes = totalBytes;
            await saveBatchJobRecord(job);
            setSavedJob({ ...job });
          } finally {
            inFlight = false;
          }
        });
        return queue;
      };
    })();

    const processOneNinja = async (ninjaIndex: number, ninja: NinjaEntry) => {
      if (controller.signal.aborted || completedSet.has(ninjaIndex)) return;

      try {
        // Retry bundle fetch up to 3 times on transient network failures
        let bundle: Awaited<ReturnType<typeof fetchNinjaBundle>> | null = null;
        let bundleErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (controller.signal.aborted) return;
          try {
            bundle = await fetchNinjaBundle(ninja.atlasUrl, ninja.skeletonUrl, {
              skipSkeleton: activeMode === 'idle-only',
            });
            break;
          } catch (err) {
            bundleErr = err;
            if (attempt < 2 && isLikelyNetworkError(err)) {
              await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            } else {
              break;
            }
          }
        }
        if (!bundle) throw bundleErr ?? new Error('Falha ao carregar pacote do ninja.');
        if (controller.signal.aborted) return;

        const pages = parseAtlas(bundle.atlasText);
        const rawItems: Array<{ path: string; data: Blob | ArrayBuffer | Uint8Array | string }> = [];
        const folderPrefix = getSpineFolderPrefix(ninja);

        const appendLinkedEffectsIfNeeded = async (sliceFrames: boolean) => {
          if (!activeIncludeEffects || !bundle?.skeleton || activeEffectScope === 'base') return;
          const plan = collectCharacterEffectPlan(bundle.skeleton, activeEffectScope);
          const effectBundles = new Map<string, ParsedEffectAsset | null>();
          const missing: string[] = [];

          for (const spineId of plan.uniqueSpineIds) {
            if (controller.signal.aborted) return;
            const parsed = await fetchParsedEffectAsset(
              ninja.atlasUrl,
              spineId,
              controller.signal,
              effectCache
            );
            effectBundles.set(spineId, parsed);
            if (!parsed) {
              missing.push(spineId);
              continue;
            }
            const effDir = `${folderPrefix}/particulas/${sanitizePathSegment(spineId)}`;
            rawItems.push({ path: `${effDir}/${spineId}.atlas`, data: parsed.atlasText });
            rawItems.push({
              path: `${effDir}/${spineId}.json`,
              data: JSON.stringify(parsed.skeleton, null, 2),
            });
            const effSheets = await Promise.all(
              Object.entries(parsed.pageUrls).map(async ([pageName, proxyUrl]) => {
                const buf = await fetchBufferWithRetry(proxyUrl, controller.signal, 2);
                return { path: `${effDir}/${pageName}`, data: buf };
              })
            );
            rawItems.push(...effSheets);

            if (sliceFrames) {
              for (const effPage of parsed.pages) {
                const effImg = parsed.pageImages[effPage.name];
                if (!effImg) continue;
                const effBlobs = await Promise.all(
                  effPage.regions.map(async (region) => {
                    const frameName =
                      region.index >= 0 ? `${region.name}_${region.index}` : region.name;
                    const blob = await extractRegionToPngBlob(region, effImg);
                    return blob
                      ? { path: `${effDir}/frames/${sanitizePathSegment(frameName)}.png`, data: blob }
                      : null;
                  })
                );
                for (const item of effBlobs) {
                  if (item) rawItems.push(item);
                }
              }
            }
          }

          rawItems.push({
            path: `${folderPrefix}/animacoes_instrucoes.json`,
            data: buildCharacterInstructionsJson(
              ninja.id,
              bundle.skeleton,
              activeEffectScope,
              effectBundles,
              missing
            ),
          });
        };

        if (activeMode === 'complete-animated') {
          const pageImages: Record<string, HTMLImageElement> = {};
          await Promise.all(
            Object.entries(bundle.pageUrls).map(async ([pageName, proxyUrl]) => {
              pageImages[pageName] = await loadImageWithRetry(proxyUrl, controller.signal, 3);
            })
          );
          if (controller.signal.aborted) return;

          const regionCanvasMap = new Map<string, HTMLCanvasElement>();
          for (const page of pages) {
            const img = pageImages[page.name];
            if (!img) continue;
            for (const reg of page.regions) {
              regionCanvasMap.set(reg.name, extractRegionToCanvas(reg, img));
            }
          }

          const completeFiles = await collectCharacterCompleteFiles(
            {
              ninja,
              atlasText: bundle.atlasText,
              skeleton: bundle.skeleton,
              pageUrls: bundle.pageUrls,
              pageImages,
              regionCanvasMap,
            },
            {
              effectScope: activeEffectScope,
              includeOriginalAndFrames: true,
              includeLinkedEffects: activeIncludeEffects,
              includeAnimPngsAndSheets: true,
              includeAnimGifs: activeIncludeGifs,
              gifBg: 'transparent',
              fps: 18,
              folderPrefix,
              signal: controller.signal,
              effectCache,
            }
          );
          rawItems.push(...completeFiles);
        } else if (activeMode === 'raw-bundle') {
          rawItems.push({ path: `${folderPrefix}/${ninja.id}.atlas`, data: bundle.atlasText });
          if (bundle.skeleton) {
            rawItems.push({
              path: `${folderPrefix}/${ninja.id}.json`,
              data: JSON.stringify(bundle.skeleton),
            });
          }
          const sheetEntries = Object.entries(bundle.pageUrls);
          const downloadedSheets = await Promise.all(
            sheetEntries.map(async ([pageName, proxyUrl]) => {
              const buf = await fetchBufferWithRetry(proxyUrl, controller.signal, 3);
              return { path: `${folderPrefix}/${pageName}`, data: buf };
            })
          );
          rawItems.push(...downloadedSheets);
          await appendLinkedEffectsIfNeeded(false);
        } else {
          const pageImages: Record<string, HTMLImageElement> = {};
          await Promise.all(
            Object.entries(bundle.pageUrls).map(async ([pageName, proxyUrl]) => {
              pageImages[pageName] = await loadImageWithRetry(proxyUrl, controller.signal, 3);
            })
          );
          if (controller.signal.aborted) return;

          if (activeMode === 'idle-only') {
            const allRegions = pages.flatMap((p) => p.regions);
            if (allRegions.length > 0) {
              const largestRegion = allRegions.reduce(
                (best, r) => (r.width * r.height > best.width * best.height ? r : best),
                allRegions[0]
              );
              let targetRegionName = bundle.idleFrameName || largestRegion.name;
              if (!bundle.idleFrameName && bundle.skeleton?.animations) {
                const anims = bundle.skeleton.animations;
                const animOrder = ['idle', 'stand', 'animation', 'skill', 'attack', ...Object.keys(anims)];
                for (const animKey of animOrder) {
                  const slots = anims[animKey]?.slots;
                  if (!slots) continue;
                  const slotOrder = [slots.L0, ...Object.values(slots)].filter(Boolean);
                  let matched = false;
                  for (const slotAnim of slotOrder) {
                    const firstAtt = slotAnim?.attachment?.find(
                      (a) => typeof a.name === 'string'
                    );
                    if (firstAtt?.name && allRegions.some((r) => r.name === firstAtt.name)) {
                      targetRegionName = firstAtt.name;
                      matched = true;
                      break;
                    }
                  }
                  if (matched) break;
                }
              }
              const region =
                allRegions.find((r) => r.name === targetRegionName) || largestRegion;
              const img = pageImages[region.pageName];
              if (img) {
                const blob = await extractRegionToPngBlob(region, img);
                if (blob) {
                  rawItems.push({ path: `${folderPrefix}.png`, data: blob });
                }
              }
            }
          } else {
            for (const page of pages) {
              const img = pageImages[page.name];
              if (!img) continue;
              const blobs = await Promise.all(
                page.regions.map(async (region) => {
                  const frameName =
                    region.index >= 0 ? `${region.name}_${region.index}` : region.name;
                  const blob = await extractRegionToPngBlob(region, img);
                  return blob ? { path: `${folderPrefix}/frames/${frameName}.png`, data: blob } : null;
                })
              );
              for (const item of blobs) {
                if (item) rawItems.push(item);
              }
            }
            rawItems.push({ path: `${folderPrefix}/${ninja.id}.atlas`, data: bundle.atlasText });
            if (bundle.skeleton) {
              rawItems.push({
                path: `${folderPrefix}/${ninja.id}.json`,
                data: JSON.stringify(bundle.skeleton),
              });
            }
            await appendLinkedEffectsIfNeeded(true);
          }
        }

        if (controller.signal.aborted) return;

        const preparedRecords: StoredNinjaFileRecord[] = await Promise.all(
          rawItems.map((item) => prepareFileRecord(item.path, item.data))
        );

        const ninjaBytes = await saveNinjaFilesToStore(
          job.id,
          ninjaIndex,
          ninja.id,
          preparedRecords
        );

        consecutiveNetErrors = 0;
        completedSet.add(ninjaIndex);
        failedSet.delete(ninjaIndex);
        totalBytes += ninjaBytes;
        sessionDone++;

        if (sessionDone % 5 === 0) {
          await persistJobProgress();
        }
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        if (isLikelyNetworkError(err)) {
          consecutiveNetErrors++;
          if (consecutiveNetErrors >= 5) {
            pauseReasonRef.current = 'network';
            controller.abort();
            return;
          }
        } else {
          consecutiveNetErrors = 0;
          failedSet.add(ninjaIndex);
        }
      } finally {
        const elapsedSec = Math.max(0.25, (performance.now() - startedAt) / 1000);
        const rate = Number(((completedSet.size - initialDone) / elapsedSec).toFixed(1));
        setProgress((prev) => ({
          ...prev,
          done: completedSet.size,
          currentId: ninja.id,
          errors: failedSet.size,
          ratePerSec: Math.max(0, rate),
          savedBytes: totalBytes,
        }));
      }
    };

    try {
      for (let partIndex = 0; partIndex < totalParts; partIndex++) {
        if (controller.signal.aborted) break;
        if (exportedPartsSet.has(partIndex)) continue;

        const partStart = partIndex * effectiveChunk;
        const partEnd = Math.min(activeList.length, (partIndex + 1) * effectiveChunk);

        const pendingIndices: number[] = [];
        for (let idx = partStart; idx < partEnd; idx++) {
          if (!completedSet.has(idx) && !failedSet.has(idx)) {
            pendingIndices.push(idx);
          }
        }

        if (pendingIndices.length > 0) {
          let cursor = 0;
          const runWorker = async () => {
            while (!controller.signal.aborted) {
              const pos = cursor++;
              if (pos >= pendingIndices.length) break;
              const ninjaIndex = pendingIndices[pos];
              await processOneNinja(ninjaIndex, activeList[ninjaIndex]);
            }
          };

          await Promise.all(
            Array.from({ length: Math.min(workers, pendingIndices.length) }, () => runWorker())
          );
        }

        await persistJobProgress(true);
        if (controller.signal.aborted) break;

        const suffix = totalParts > 1 ? `_parte_${partIndex + 1}_de_${totalParts}` : '';
        const filename = `shinobi_sprites_${activeMode}${suffix}.zip`;
        await packageRangeToZip(
          job,
          partStart,
          partEnd,
          filename,
          totalParts > 1 ? `parte ${partIndex + 1} de ${totalParts}` : undefined
        );
        setPackaging(false);
        exportedPartsSet.add(partIndex);
        await persistJobProgress(true);
      }

      if (controller.signal.aborted) {
        job.status = 'paused';
        await persistJobProgress(true);
        const wasNet = pauseReasonRef.current === 'network' || !navigator.onLine;
        setPausedByNetwork(wasNet);
        setStatusMessage(
          wasNet
            ? `Conexão instável ou offline. Progresso salvo em ${completedSet.size}/${activeList.length} ninjas — clique em "Continuar Download" quando a rede voltar.`
            : `Download pausado em ${completedSet.size}/${activeList.length} ninjas. Você pode continuar de onde parou a qualquer momento.`
        );
      } else {
        job.status = 'completed';
        await persistJobProgress(true);
        setStatusMessage(
          `Concluído! ${completedSet.size} de ${activeList.length} ninjas empacotados (${formatBytesCompact(totalBytes)}).`
        );
      }
    } catch (err) {
      job.status = 'paused';
      await persistJobProgress(true);
      setStatusMessage(
        err instanceof Error
          ? `Interrompido: ${err.message}. Progresso salvo (${completedSet.size}/${activeList.length}).`
          : `Download pausado com progresso salvo (${completedSet.size}/${activeList.length}).`
      );
    } finally {
      window.removeEventListener('offline', onOffline);
      setPackaging(false);
      setRunning(false);
      abortRef.current = null;
    }
  };

  const pct =
    progress.zipPercent !== null
      ? progress.zipPercent
      : progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  const hasResumablePausedJob =
    !running && !packaging && savedJob && savedJob.status === 'paused';
  const hasCompletedCachedJob =
    !running && !packaging && savedJob && savedJob.status === 'completed';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-zip-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-2 sm:p-4"
    >
      <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-[#131A26] p-4 sm:p-6 space-y-4 sm:space-y-5 max-h-[90dvh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="batch-zip-title" className="font-display text-lg font-semibold text-slate-50">
              {title}
            </h3>
            <p className="mt-1 text-xs text-slate-400 tabular-nums">
              {ninjas.length} pacotes disponíveis · Cache local retomável (IndexedDB) + ZIP Streaming
            </p>
          </div>
          <button
            type="button"
            disabled={running || packaging}
            onClick={onClose}
            aria-label="Fechar janela"
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40 cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Saved Paused Job Banner */}
        {hasResumablePausedJob && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-950/25 p-3.5 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                  {pausedByNetwork && <WifiOff className="h-3.5 w-3.5 shrink-0" />}
                  <span>Download em pausa salvo localmente</span>
                </div>
                <p className="text-[11px] text-slate-300">
                  {MODE_LABELS[savedJob.contentMode]} · Pacotes {savedJob.startIdx}–{savedJob.endIdx}
                </p>
                <p className="text-[11px] font-mono text-amber-300 tabular-nums">
                  {savedJob.completedIndices.length}/{savedJob.totalNinjas} pacotes salvos ·{' '}
                  {formatBytesCompact(savedJob.totalBytes)} em cache
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleDiscardSaved()}
                title="Descartar cache salvo"
                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#0B0F17] px-2 py-1 text-[11px] text-slate-300 hover:border-red-500/60 hover:text-red-200 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
                <span>Descartar</span>
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runJob(savedJob)}
                className="inline-flex items-center gap-1.5 rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
              >
                <Play className="h-3.5 w-3.5" />
                <span>
                  Continuar Download (faltam{' '}
                  {Math.max(
                    0,
                    savedJob.totalNinjas -
                      savedJob.completedIndices.length -
                      savedJob.failedIndices.length
                  )}
                  )
                </span>
              </button>

              {savedJob.completedIndices.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleReexportSaved(savedJob, 'parcial')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Gerar ZIP Parcial ({savedJob.completedIndices.length})</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Completed Cached Job Banner (Re-download or Direct Disk Save) */}
        {hasCompletedCachedJob && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/20 p-3.5 space-y-2.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-emerald-200">
                  Pacote pronto no cache local
                </div>
                <p className="text-[11px] text-slate-300 tabular-nums">
                  {MODE_LABELS[savedJob.contentMode]} · {savedJob.completedIndices.length} pacotes ·{' '}
                  {formatBytesCompact(savedJob.totalBytes)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleDiscardSaved()}
                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#0B0F17] px-2 py-1 text-[11px] text-slate-300 hover:border-slate-500 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
                <span>Limpar Cache</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleReexportSaved(savedJob)}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Baixar ZIP Novamente</span>
              </button>
              {supportsSavePicker && (
                <button
                  type="button"
                  onClick={() => void handleDirectSaveToDisk(savedJob)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
                >
                  <HardDriveDownload className="h-3.5 w-3.5" />
                  <span>Salvar Direto no Disco...</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Content Format Choice */}
        <div className="space-y-2">
          <span className="block text-xs font-medium text-slate-300">Conteúdo do ZIP</span>
          <div className="space-y-2">
            {(
              [
                {
                  id: 'idle-only',
                  label: '1 Sprite Principal por Pacote (PNG)',
                  desc: 'Rápido e leve — extrai a pose principal de cada pacote em PNG transparente.',
                },
                {
                  id: 'all-sliced',
                  label: 'Todos os Frames Fatiados (Pastas + PNGs)',
                  desc: 'Fatia todos os frames de cada pacote em pastas (+ .atlas, .json e partículas opcionais).',
                },
                {
                  id: 'raw-bundle',
                  label: 'Pacotes Originais (.webp + .atlas + .json)',
                  desc: 'Baixa as folhas de textura originais organizadas em pastas por categoria.',
                },
                {
                  id: 'complete-animated',
                  label: 'Personagem Completo (Animações + Partículas + Originais)',
                  desc: 'Inclui originais, frames, partículas (noe_*), animacoes_instrucoes.json e todas as animações renderizadas juntas.',
                },
              ] as const
            ).map((opt) => (
              <label
                key={opt.id}
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  contentMode === opt.id
                    ? 'border-orange-500 bg-[#182232]'
                    : 'border-slate-800 bg-[#0B0F17] hover:border-slate-700'
                }`}
              >
                <input
                  type="radio"
                  name="batchMode"
                  disabled={running || packaging}
                  checked={contentMode === opt.id}
                  onChange={() => setContentMode(opt.id)}
                  className="mt-0.5 accent-orange-500"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-100">{opt.label}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {contentMode !== 'idle-only' && (
          <div className="space-y-2.5 rounded-lg border border-slate-800 bg-[#0B0F17] p-3 text-xs">
            <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                disabled={running || packaging}
                checked={includeLinkedEffects}
                onChange={(e) => setIncludeLinkedEffects(e.target.checked)}
                className="accent-orange-500"
              />
              <span>
                Incluir pacotes de partículas vinculados (<code className="font-mono text-orange-300">particulas/noe_*</code>) e{' '}
                <code className="font-mono text-orange-300">animacoes_instrucoes.json</code>
              </span>
            </label>

            {(includeLinkedEffects || contentMode === 'complete-animated') && (
              <div className="flex flex-col items-stretch gap-2 pl-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:pl-5">
                <span className="text-[11px] text-slate-400">Escopo das partículas:</span>
                <select
                  disabled={running || packaging}
                  value={effectScope}
                  onChange={(e) => setEffectScope(e.target.value as EffectIncludeScope)}
                  aria-label="Escopo das partículas no lote"
                  className="w-full rounded border border-slate-800 bg-[#131A26] px-2 py-1.5 text-[11px] text-slate-200 sm:w-auto sm:py-1"
                >
                  <option value="powers">Com poderes (personagem + tela)</option>
                  <option value="all">Completa (+ impactos no alvo)</option>
                  <option value="base">Somente personagem (sem partículas)</option>
                </select>
              </div>
            )}

            {contentMode === 'complete-animated' && (
              <>
                <label className="flex items-start gap-2 pl-2 text-slate-200 cursor-pointer sm:items-center sm:pl-5">
                  <input
                    type="checkbox"
                    disabled={running || packaging}
                    checked={includeAnimGifs}
                    onChange={(e) => setIncludeAnimGifs(e.target.checked)}
                    className="mt-0.5 accent-emerald-500 sm:mt-0"
                  />
                  <span>Gerar GIF animado para cada animação (além de PNGs e Spritesheet)</span>
                </label>
                <p className="pl-2 text-[11px] text-amber-300/90 sm:pl-5">
                  Dica: o modo completo gera muitos arquivos e imagens — recomenda-se dividir o ZIP em 25 ou 50 pacotes.
                </p>
              </>
            )}
          </div>
        )}

        {/* Range, Chunk Split & Speed */}
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <label className="space-y-1">
            <span className="text-slate-400">Do item</span>
            <input
              type="number"
              min={1}
              max={ninjas.length}
              disabled={running || packaging}
              value={startIdx}
              onChange={(e) => setStartIdx(Number(e.target.value))}
              className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
            />
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Até o item</span>
            <input
              type="number"
              min={1}
              max={ninjas.length}
              disabled={running || packaging}
              value={endIdx}
              onChange={(e) => setEndIdx(Number(e.target.value))}
              className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
            />
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Dividir ZIP</span>
            <select
              disabled={running || packaging}
              value={chunkSize}
              onChange={(e) => setChunkSize(Number(e.target.value))}
              className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
            >
              <option value={25}>25 pacotes</option>
              <option value={50}>50 pacotes</option>
              <option value={100}>100 pacotes</option>
              <option value={250}>250 pacotes</option>
              <option value={0}>Arquivo único</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Velocidade</span>
            <select
              disabled={running || packaging}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2 py-1.5 font-mono text-slate-100"
            >
              <option value={4}>Normal (4x)</option>
              <option value={8}>Rápida (8x)</option>
              <option value={12}>Turbo (12x)</option>
            </select>
          </label>
        </div>

        {(running || packaging || statusMessage) && (
          <div className="space-y-2 rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums">
              <span className="text-slate-200 truncate">
                {progress.zipPercent !== null
                  ? statusMessage || 'Empacotando ZIP...'
                  : running
                  ? `Baixando (${progress.ratePerSec}/s · ${formatBytesCompact(progress.savedBytes)}): ${progress.currentId}...`
                  : statusMessage}
              </span>
              <span className="text-orange-400 shrink-0 ml-2">
                {progress.zipPercent !== null
                  ? `${progress.zipPercent}%`
                  : `${progress.done}/${progress.total} (${pct}%)`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-orange-500 transition-all duration-150"
                style={{ width: `${pct}%` }}
              />
            </div>
            {progress.errors > 0 && (
              <p className="text-[11px] text-amber-400 tabular-nums">
                {progress.errors} pacote(s) não encontrados ou ignorados.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 pt-1">
          {running ? (
            <button
              type="button"
              disabled={packaging}
              onClick={handlePause}
              className="inline-flex items-center gap-2 rounded-lg border border-amber-700 bg-amber-950/50 px-4 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-900/50 disabled:opacity-40 cursor-pointer"
            >
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Pausar Download</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={packaging}
                onClick={onClose}
                className="rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-300 hover:border-slate-500 disabled:opacity-40 cursor-pointer"
              >
                Fechar
              </button>
              <button
                type="button"
                disabled={targetList.length === 0 || packaging}
                onClick={() => void runJob()}
                className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {hasResumablePausedJob
                    ? `Novo Download (${targetList.length})`
                    : `Baixar ${targetList.length} Pacotes (ZIP)`}
                </span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
