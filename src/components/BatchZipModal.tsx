import { useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import type { NinjaEntry } from '../types/sprite';
import {
  downloadBlob,
  extractRegionToPngBlob,
  loadImageElement,
  parseAtlas,
} from '../utils/atlasParser';
import { fetchNinjaBundle } from '../utils/remoteClient';
import { createZipWorkerSession, type ZipWorkerSession } from '../utils/zipWorkerClient';

interface BatchZipModalProps {
  isOpen: boolean;
  ninjas: NinjaEntry[];
  title?: string;
  onClose: () => void;
}

type BatchContentMode = 'idle-only' | 'all-sliced' | 'raw-bundle';

export function BatchZipModal({
  isOpen,
  ninjas,
  title = 'Baixar Sprites em Lote (ZIP)',
  onClose,
}: BatchZipModalProps) {
  const [contentMode, setContentMode] = useState<BatchContentMode>('idle-only');
  const [startIdx, setStartIdx] = useState(1);
  const [endIdx, setEndIdx] = useState(() => ninjas.length);
  const [chunkSize, setChunkSize] = useState<number>(100);
  const [concurrency, setConcurrency] = useState<number>(8);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({
    done: 0,
    total: 0,
    currentId: '',
    errors: 0,
    ratePerSec: 0,
    zipPercent: null as number | null,
  });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (!isOpen) return null;

  const safeStart = Math.max(1, Math.min(startIdx, ninjas.length));
  const safeEnd = Math.max(safeStart, Math.min(endIdx || ninjas.length, ninjas.length));
  const targetList = ninjas.slice(safeStart - 1, safeEnd);

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleStartDownload = async () => {
    if (targetList.length === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setStatusMessage(null);

    const effectiveChunk =
      chunkSize <= 0 ? targetList.length : Math.max(10, chunkSize);
    const totalParts = Math.ceil(targetList.length / effectiveChunk);
    const workers = Math.max(1, Math.min(16, concurrency));

    const startedAt = performance.now();
    let done = 0;
    let errors = 0;
    setProgress({
      done: 0,
      total: targetList.length,
      currentId: targetList[0].id,
      errors: 0,
      ratePerSec: 0,
      zipPercent: null,
    });

    const processOneNinja = async (ninja: NinjaEntry, session: ZipWorkerSession) => {
      if (controller.signal.aborted) return;
      try {
        const bundle = await fetchNinjaBundle(ninja.atlasUrl, ninja.skeletonUrl, {
          skipSkeleton: contentMode === 'idle-only',
        });
        if (controller.signal.aborted) return;

        const pages = parseAtlas(bundle.atlasText);
        const batch: Array<{ path: string; data: Blob | ArrayBuffer | string }> = [];

        if (contentMode === 'raw-bundle') {
          batch.push({ path: `${ninja.id}/${ninja.id}.atlas`, data: bundle.atlasText });
          if (bundle.skeleton) {
            batch.push({
              path: `${ninja.id}/${ninja.id}.json`,
              data: JSON.stringify(bundle.skeleton),
            });
          }
          await Promise.all(
            Object.entries(bundle.pageUrls).map(async ([pageName, proxyUrl]) => {
              const resp = await fetch(proxyUrl, { signal: controller.signal });
              if (resp.ok) {
                const buf = await resp.arrayBuffer();
                batch.push({ path: `${ninja.id}/${pageName}`, data: buf });
              }
            })
          );
        } else {
          const pageImages: Record<string, HTMLImageElement> = {};
          await Promise.all(
            Object.entries(bundle.pageUrls).map(async ([pageName, proxyUrl]) => {
              pageImages[pageName] = await loadImageElement(proxyUrl);
            })
          );
          if (controller.signal.aborted) return;

          if (contentMode === 'idle-only') {
            const allRegions = pages.flatMap((p) => p.regions);
            if (allRegions.length > 0) {
              let targetRegionName = bundle.idleFrameName || allRegions[0].name;
              if (!bundle.idleFrameName) {
                const idleSlots = bundle.skeleton?.animations?.idle?.slots;
                if (idleSlots) {
                  const preferredSlot = idleSlots.L0 || Object.values(idleSlots)[0];
                  const firstAtt = preferredSlot?.attachment?.find(
                    (a) => typeof a.name === 'string'
                  );
                  if (firstAtt?.name) targetRegionName = firstAtt.name;
                }
              }
              const region =
                allRegions.find((r) => r.name === targetRegionName) || allRegions[0];
              const img = pageImages[region.pageName];
              if (img) {
                const blob = await extractRegionToPngBlob(region, img);
                if (blob) {
                  batch.push({ path: `${ninja.id}.png`, data: blob });
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
                  return blob ? { path: `${ninja.id}/${frameName}.png`, data: blob } : null;
                })
              );
              for (const item of blobs) {
                if (item) batch.push(item);
              }
            }
            batch.push({ path: `${ninja.id}/${ninja.id}.atlas`, data: bundle.atlasText });
            if (bundle.skeleton) {
              batch.push({
                path: `${ninja.id}/${ninja.id}.json`,
                data: JSON.stringify(bundle.skeleton),
              });
            }
          }
        }

        if (batch.length > 0 && !controller.signal.aborted) {
          await session.addFilesBatch(batch);
        }
      } catch {
        errors++;
      } finally {
        done++;
        const elapsedSec = Math.max(0.2, (performance.now() - startedAt) / 1000);
        setProgress({
          done,
          total: targetList.length,
          currentId: ninja.id,
          errors,
          ratePerSec: Number((done / elapsedSec).toFixed(1)),
          zipPercent: null,
        });
      }
    };

    try {
      for (let partIndex = 0; partIndex < totalParts; partIndex++) {
        if (controller.signal.aborted) break;

        const slice = targetList.slice(
          partIndex * effectiveChunk,
          (partIndex + 1) * effectiveChunk
        );
        const session = createZipWorkerSession();

        try {
          let cursor = 0;
          const runWorker = async () => {
            while (!controller.signal.aborted) {
              const idx = cursor++;
              if (idx >= slice.length) break;
              await processOneNinja(slice[idx], session);
            }
          };

          await Promise.all(
            Array.from({ length: Math.min(workers, slice.length) }, () => runWorker())
          );

          if (controller.signal.aborted) break;

          setStatusMessage(
            totalParts > 1
              ? `Compactando em segundo plano (parte ${partIndex + 1} de ${totalParts})...`
              : 'Compactando ZIP em segundo plano...'
          );

          const blob = await session.generateBlob((zipPct) => {
            setProgress((prev) => ({ ...prev, zipPercent: zipPct }));
          }, 'STORE');
          const suffix = totalParts > 1 ? `_parte_${partIndex + 1}_de_${totalParts}` : '';
          downloadBlob(blob, `shinobi_sprites_${contentMode}${suffix}.zip`);
        } finally {
          session.dispose();
        }
      }

      if (controller.signal.aborted) {
        setStatusMessage('Download em lote cancelado.');
      } else {
        setStatusMessage(
          `Concluído! ${done - errors} de ${targetList.length} ninjas exportados.`
        );
      }
    } finally {
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-zip-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-[#131A26] p-6 space-y-5 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="batch-zip-title" className="font-display text-lg font-semibold text-slate-50">
              {title}
            </h3>
            <p className="mt-1 text-xs text-slate-400 tabular-nums">
              {ninjas.length} ninjas disponíveis · Compactação em segundo plano (Web Worker)
            </p>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={onClose}
            aria-label="Fechar janela"
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40 cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Content Format Choice */}
        <div className="space-y-2">
          <span className="block text-xs font-medium text-slate-300">Conteúdo do ZIP</span>
          <div className="space-y-2">
            {(
              [
                {
                  id: 'idle-only',
                  label: '1 Sprite Principal por Ninja (PNG)',
                  desc: 'Rápido e leve — extrai a pose principal de cada ninja em PNG transparente.',
                },
                {
                  id: 'all-sliced',
                  label: 'Todos os Frames Fatiados (Pastas + PNGs)',
                  desc: 'Fatia todos os frames de cada ninja em pastas individuais (+ .atlas e .json).',
                },
                {
                  id: 'raw-bundle',
                  label: 'Pacotes Originais (.webp + .atlas + .json)',
                  desc: 'Baixa as folhas de textura originais sem recortar os frames no navegador.',
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
                  disabled={running}
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

        {/* Range, Chunk Split & Speed */}
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <label className="space-y-1">
            <span className="text-slate-400">Do ninja</span>
            <input
              type="number"
              min={1}
              max={ninjas.length}
              disabled={running}
              value={startIdx}
              onChange={(e) => setStartIdx(Number(e.target.value))}
              className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
            />
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Até o ninja</span>
            <input
              type="number"
              min={1}
              max={ninjas.length}
              disabled={running}
              value={endIdx}
              onChange={(e) => setEndIdx(Number(e.target.value))}
              className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
            />
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Dividir ZIP</span>
            <select
              disabled={running}
              value={chunkSize}
              onChange={(e) => setChunkSize(Number(e.target.value))}
              className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2 py-1.5 font-mono text-slate-100"
            >
              <option value={50}>50 ninjas</option>
              <option value={100}>100 ninjas</option>
              <option value={250}>250 ninjas</option>
              <option value={0}>Arquivo único</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Velocidade</span>
            <select
              disabled={running}
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

        {(running || statusMessage) && (
          <div className="space-y-2 rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums">
              <span className="text-slate-200 truncate">
                {progress.zipPercent !== null
                  ? statusMessage || 'Empacotando ZIP...'
                  : running
                  ? `Baixando (${progress.ratePerSec}/s): ${progress.currentId}...`
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

        <div className="flex items-center justify-end gap-3 pt-1">
          {running ? (
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-900/40 cursor-pointer"
            >
              Cancelar
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-300 hover:border-slate-500 cursor-pointer"
              >
                Fechar
              </button>
              <button
                type="button"
                disabled={targetList.length === 0}
                onClick={() => void handleStartDownload()}
                className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Baixar {targetList.length} Ninjas (ZIP)</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
