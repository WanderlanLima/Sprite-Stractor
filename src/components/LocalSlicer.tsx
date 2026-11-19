import { useEffect, useState } from 'react';
import { Download, Pause, Play, Scissors, Upload } from 'lucide-react';
import type { SlicedFrame } from '../types/sprite';
import {
  downloadDataUrl,
  exportFramesAsZip,
  loadImageElement,
  parseAtlas,
  sliceAtlasRegions,
  sliceImageByAutoBBox,
  sliceImageByGrid,
} from '../utils/atlasParser';

interface LocalSlicerProps {
  externalSource: { url: string; filename: string } | null;
  onFramesChange: (frames: SlicedFrame[], name: string) => void;
}

type SliceMethod = 'auto' | 'grid' | 'atlas';

export function LocalSlicer({ externalSource, onFramesChange }: LocalSlicerProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [filename, setFilename] = useState('spritesheet');
  const [loadedImg, setLoadedImg] = useState<HTMLImageElement | null>(null);

  const [method, setMethod] = useState<SliceMethod>('auto');
  const [alphaThreshold, setAlphaThreshold] = useState(12);
  const [minSize, setMinSize] = useState(10);
  const [mergeGap, setMergeGap] = useState(2);

  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(4);
  const [margin, setMargin] = useState(0);
  const [spacing, setSpacing] = useState(0);

  const [atlasText, setAtlasText] = useState('');

  const [frames, setFrames] = useState<SlicedFrame[]>([]);
  const [slicing, setSlicing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Simple flipbook preview
  const [previewIdx, setPreviewIdx] = useState(0);
  const [playingPreview, setPlayingPreview] = useState(true);
  const [previewFps, setPreviewFps] = useState(10);

  useEffect(() => {
    if (!externalSource) return;
    setImageSrc(externalSource.url);
    setFilename(externalSource.filename.replace(/\.[^.]+$/, ''));
  }, [externalSource]);

  useEffect(() => {
    if (!imageSrc) {
      setLoadedImg(null);
      return;
    }
    let cancelled = false;
    setError(null);
    void loadImageElement(imageSrc)
      .then((img) => {
        if (!cancelled) setLoadedImg(img);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erro ao carregar imagem.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [imageSrc]);

  useEffect(() => {
    if (!playingPreview || frames.length <= 1) return;
    const interval = setInterval(() => {
      setPreviewIdx((i) => (i + 1) % frames.length);
    }, Math.max(40, Math.round(1000 / previewFps)));
    return () => clearInterval(interval);
  }, [playingPreview, frames.length, previewFps]);

  const runSlice = () => {
    if (!loadedImg) return;
    setSlicing(true);
    setError(null);
    try {
      let result: SlicedFrame[] = [];
      if (method === 'auto') {
        result = sliceImageByAutoBBox(loadedImg, alphaThreshold, minSize, mergeGap);
      } else if (method === 'grid') {
        result = sliceImageByGrid(loadedImg, cols, rows, margin, spacing);
      } else {
        const pages = parseAtlas(atlasText);
        if (pages.length === 0) {
          throw new Error('Cole ou envie um conteúdo .atlas válido.');
        }
        const map: Record<string, HTMLImageElement> = {};
        for (const p of pages) {
          map[p.name] = loadedImg;
        }
        result = sliceAtlasRegions(pages, map);
      }
      setFrames(result);
      setPreviewIdx(0);
      onFramesChange(result, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao fatiar imagem.');
    } finally {
      setSlicing(false);
    }
  };

  // Auto-slice when an external sheet loads for immediate gratification
  useEffect(() => {
    if (loadedImg) {
      runSlice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedImg]);

  const handleImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setImageSrc(reader.result);
        setFilename(file.name.replace(/\.[^.]+$/, ''));
      }
    };
    reader.readAsDataURL(file);
  };

  const handleAtlasFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAtlasText(reader.result);
        setMethod('atlas');
      }
    };
    reader.readAsText(file);
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-2 border-b border-slate-800/80 pb-4">
        <h2 className="font-display text-xl font-semibold text-slate-50">
          Fatiador Local de Spritesheets
        </h2>
        <p className="text-xs text-slate-400">
          Envie qualquer imagem PNG/WebP ou importe um arquivo .atlas para detectar sprites automaticamente pela transparência (Alpha) ou por grade uniforme.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
        {/* Controls Panel */}
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-2">
                Imagem do Spritesheet (PNG, WebP, JPG)
              </label>
              <label className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-700 bg-[#0B0F17] px-4 py-5 text-center hover:border-orange-500/60 cursor-pointer transition-colors">
                <Upload className="h-5 w-5 text-slate-400" aria-hidden="true" />
                <span className="mt-2 text-xs font-medium text-slate-200">
                  {loadedImg ? `${filename} (${loadedImg.width}×${loadedImg.height})` : 'Selecionar imagem'}
                </span>
                <input
                  type="file"
                  accept="image/png,image/webp,image/jpeg,image/gif"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleImageFile(f);
                  }}
                  className="sr-only"
                />
              </label>
            </div>

            <div className="space-y-2">
              <span className="block text-xs font-medium text-slate-300">Método de Fatiamento</span>
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-[#0B0F17] p-1">
                {(
                  [
                    { id: 'auto', label: 'Auto Alpha' },
                    { id: 'grid', label: 'Grade' },
                    { id: 'atlas', label: '.atlas' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMethod(m.id)}
                    className={`rounded-md py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                      method === m.id
                        ? 'bg-orange-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {method === 'auto' && (
              <div className="space-y-3 text-xs">
                <div>
                  <div className="flex justify-between text-slate-300 mb-1">
                    <span>Limiar Alpha</span>
                    <span className="font-mono tabular-nums">{alphaThreshold}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={128}
                    value={alphaThreshold}
                    onChange={(e) => setAlphaThreshold(Number(e.target.value))}
                    className="w-full accent-orange-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-slate-300 mb-1">
                    <span>Tamanho Mínimo (px)</span>
                    <span className="font-mono tabular-nums">{minSize} px</span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={64}
                    value={minSize}
                    onChange={(e) => setMinSize(Number(e.target.value))}
                    className="w-full accent-orange-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-slate-300 mb-1">
                    <span>Margem de Fusão</span>
                    <span className="font-mono tabular-nums">{mergeGap} px</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={8}
                    value={mergeGap}
                    onChange={(e) => setMergeGap(Number(e.target.value))}
                    className="w-full accent-orange-500"
                  />
                </div>
              </div>
            )}

            {method === 'grid' && (
              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="space-y-1">
                  <span className="text-slate-300">Colunas</span>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={cols}
                    onChange={(e) => setCols(Number(e.target.value))}
                    className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300">Linhas</span>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={rows}
                    onChange={(e) => setRows(Number(e.target.value))}
                    className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300">Margem (px)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={margin}
                    onChange={(e) => setMargin(Number(e.target.value))}
                    className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300">Espaçamento</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={spacing}
                    onChange={(e) => setSpacing(Number(e.target.value))}
                    className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>
              </div>
            )}

            {method === 'atlas' && (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Conteúdo .atlas</span>
                  <label className="text-orange-400 hover:underline cursor-pointer">
                    Carregar arquivo
                    <input
                      type="file"
                      accept=".atlas,.txt"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleAtlasFile(f);
                      }}
                      className="sr-only"
                    />
                  </label>
                </div>
                <textarea
                  rows={6}
                  value={atlasText}
                  onChange={(e) => setAtlasText(e.target.value)}
                  placeholder="Cole aqui o texto do arquivo .atlas..."
                  className="w-full rounded-md border border-slate-800 bg-[#0B0F17] p-2 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
                />
              </div>
            )}

            <button
              type="button"
              disabled={!loadedImg || slicing}
              onClick={runSlice}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:bg-slate-800 disabled:text-slate-500 cursor-pointer"
            >
              <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{slicing ? 'Fatiando...' : 'Fatiar Sprites'}</span>
            </button>

            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>

          {/* Flipbook Animation Preview */}
          {frames.length > 0 && (
            <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  Prévia da Sequência
                </h3>
                <span className="font-mono text-xs text-slate-400 tabular-nums">
                  {previewIdx + 1} / {frames.length}
                </span>
              </div>
              <div className="sprite-checkerboard flex h-40 items-center justify-center rounded-md border border-slate-800 p-3">
                <img
                  src={frames[previewIdx % frames.length]?.dataUrl}
                  alt="Prévia animada"
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setPlayingPreview((p) => !p)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs text-slate-200 cursor-pointer"
                >
                  {playingPreview ? (
                    <>
                      <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Pausar</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Reproduzir</span>
                    </>
                  )}
                </button>
                <label className="flex items-center gap-2 text-xs text-slate-400">
                  <span>FPS</span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={previewFps}
                    onChange={(e) => setPreviewFps(Math.max(1, Number(e.target.value)))}
                    className="w-14 rounded border border-slate-800 bg-[#0B0F17] px-2 py-1 font-mono text-slate-100"
                  />
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Sliced Frames Grid */}
        <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4">
          {frames.length === 0 ? (
            <div className="flex h-80 flex-col items-center justify-center text-center text-sm text-slate-400">
              <Scissors className="h-7 w-7 text-slate-600 mb-2" aria-hidden="true" />
              <p>Envie uma folha de sprites ou clique em Fatiar em qualquer imagem do jogo.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                <span className="font-mono text-xs text-slate-300 tabular-nums">
                  {frames.length} sprites extraídos
                </span>
                <button
                  type="button"
                  onClick={() => void exportFramesAsZip(`${filename}_sprites.zip`, frames)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Baixar Todos (ZIP)</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                {frames.map((frame) => (
                  <div
                    key={frame.id}
                    className="flex flex-col overflow-hidden rounded-lg border border-slate-800 bg-[#0B0F17]"
                  >
                    <div className="sprite-checkerboard flex h-28 items-center justify-center p-2">
                      <img
                        src={frame.dataUrl}
                        alt={frame.name}
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2 border-t border-slate-800/80 px-2.5 py-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-slate-100">
                          {frame.name}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                          {frame.width}×{frame.height}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => downloadDataUrl(frame.dataUrl, `${frame.name}.png`)}
                        aria-label={`Baixar ${frame.name}`}
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white cursor-pointer"
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
