import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Download,
  Film,
  Grid,
  Layers,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  AtlasPage,
  AtlasRegion,
  NinjaEntry,
  SlicedFrame,
  SpineSkeleton,
} from '../types/sprite';
import {
  downloadDataUrl,
  exportAnimationStripPng,
  exportFramesAsZip,
  extractRegionToCanvas,
  getAnimationDuration,
  loadImageElement,
  parseAtlas,
  renderSpineFrameToCanvas,
  sliceAtlasRegions,
} from '../utils/atlasParser';
import { fetchNinjaBundle } from '../utils/remoteClient';

interface StudioStageProps {
  ninja: NinjaEntry | null;
  onBackToCatalog: () => void;
  onLoadedFramesChange: (payload: {
    ninjaId: string;
    frames: SlicedFrame[];
    atlasText: string;
    skeleton: SpineSkeleton | null;
  } | null) => void;
}

type StageMode = 'player' | 'frames' | 'sheet';
type BgStyle = 'checker' | 'dark' | 'light' | 'chroma';

const PRIORITY_ANIM_ORDER = [
  'idle',
  'run',
  'attack',
  'skill',
  'UniqueSkill',
  'uniqueSkill',
  'superUniqueSkill',
  'win',
  'hurt1',
  'die',
];

export function StudioStage({
  ninja,
  onBackToCatalog,
  onLoadedFramesChange,
}: StudioStageProps) {
  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [bgStyle, setBgStyle] = useState<BgStyle>('checker');
  const [zoom, setZoom] = useState(1.25);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [atlasText, setAtlasText] = useState('');
  const [pages, setPages] = useState<AtlasPage[]>([]);
  const [pageUrls, setPageUrls] = useState<Record<string, string>>({});
  const [pageImages, setPageImages] = useState<Record<string, HTMLImageElement>>({});
  const [skeleton, setSkeleton] = useState<SpineSkeleton | null>(null);
  const [frames, setFrames] = useState<SlicedFrame[]>([]);
  const [regionCanvasMap, setRegionCanvasMap] = useState<Map<string, HTMLCanvasElement>>(
    () => new Map()
  );

  // Player state
  const [selectedAnim, setSelectedAnim] = useState('idle');
  const [animFilter, setAnimFilter] = useState('');
  const [frameFilter, setFrameFilter] = useState('');
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [showAtlasBoxes, setShowAtlasBoxes] = useState(true);
  const [selectedRegion, setSelectedRegion] = useState<AtlasRegion | null>(null);
  const [exportingAnim, setExportingAnim] = useState(false);

  const playerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animTimeRef = useRef(0);

  useEffect(() => {
    if (!ninja) {
      onLoadedFramesChange(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedRegion(null);
    setCurrentTime(0);
    animTimeRef.current = 0;

    async function loadBundle() {
      if (!ninja) return;
      try {
        const data = await fetchNinjaBundle(ninja.atlasUrl, ninja.skeletonUrl);
        if (cancelled) return;

        const parsedPages = parseAtlas(data.atlasText);
        const loadedImgs: Record<string, HTMLImageElement> = {};
        await Promise.all(
          Object.entries(data.pageUrls).map(async ([pageName, proxyUrl]) => {
            loadedImgs[pageName] = await loadImageElement(proxyUrl);
          })
        );
        if (cancelled) return;

        const sliced = sliceAtlasRegions(parsedPages, loadedImgs);
        const canvasMap = new Map<string, HTMLCanvasElement>();
        for (const page of parsedPages) {
          const img = loadedImgs[page.name];
          if (!img) continue;
          for (const reg of page.regions) {
            canvasMap.set(reg.name, extractRegionToCanvas(reg, img));
          }
        }

        const availableAnims = Object.keys(data.skeleton?.animations || {});
        const defaultAnim =
          PRIORITY_ANIM_ORDER.find((a) => availableAnims.includes(a)) ||
          availableAnims[0] ||
          '';

        setAtlasText(data.atlasText);
        setPages(parsedPages);
        setPageUrls(data.pageUrls);
        setPageImages(loadedImgs);
        setSkeleton(data.skeleton);
        setFrames(sliced);
        setRegionCanvasMap(canvasMap);
        if (defaultAnim) setSelectedAnim(defaultAnim);
        else setStageMode('frames');

        onLoadedFramesChange({
          ninjaId: ninja.id,
          frames: sliced,
          atlasText: data.atlasText,
          skeleton: data.skeleton,
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erro ao carregar ninja.');
          onLoadedFramesChange(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadBundle();
    return () => {
      cancelled = true;
    };
  }, [ninja, onLoadedFramesChange]);

  const animNames = useMemo(() => {
    const raw = Object.keys(skeleton?.animations || {});
    return raw.sort((a, b) => {
      const ia = PRIORITY_ANIM_ORDER.indexOf(a);
      const ib = PRIORITY_ANIM_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [skeleton]);

  const filteredAnimNames = useMemo(() => {
    const q = animFilter.trim().toLowerCase();
    return q ? animNames.filter((a) => a.toLowerCase().includes(q)) : animNames;
  }, [animNames, animFilter]);

  const filteredFrames = useMemo(() => {
    const q = frameFilter.trim().toLowerCase();
    return q ? frames.filter((f) => f.name.toLowerCase().includes(q)) : frames;
  }, [frames, frameFilter]);

  const duration = useMemo(() => {
    if (!skeleton || !selectedAnim) return 0;
    return getAnimationDuration(skeleton, selectedAnim);
  }, [skeleton, selectedAnim]);

  // Animation loop
  useEffect(() => {
    if (stageMode !== 'player' || !skeleton || !selectedAnim || regionCanvasMap.size === 0) {
      return;
    }

    let rafId = 0;
    let lastTs = performance.now();

    const drawCurrent = (t: number) => {
      const canvas = playerCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      renderSpineFrameToCanvas(
        ctx,
        canvas.width,
        canvas.height,
        skeleton,
        selectedAnim,
        t,
        regionCanvasMap,
        zoom
      );
    };

    drawCurrent(animTimeRef.current);

    if (!isPlaying || duration <= 0) {
      return;
    }

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      let next = animTimeRef.current + dt * speed;
      if (next >= duration) next = next % duration;
      animTimeRef.current = next;
      setCurrentTime(next);
      drawCurrent(next);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [stageMode, skeleton, selectedAnim, regionCanvasMap, isPlaying, speed, duration, zoom, loading]);

  // Redraw when manually scrubbing while paused
  useEffect(() => {
    if (isPlaying || stageMode !== 'player' || !skeleton || !selectedAnim) return;
    animTimeRef.current = currentTime;
    const canvas = playerCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      renderSpineFrameToCanvas(
        ctx,
        canvas.width,
        canvas.height,
        skeleton,
        selectedAnim,
        currentTime,
        regionCanvasMap,
        zoom
      );
    }
  }, [currentTime, isPlaying, stageMode, skeleton, selectedAnim, regionCanvasMap, zoom]);

  const bgClass =
    bgStyle === 'checker'
      ? 'sprite-checkerboard'
      : bgStyle === 'light'
      ? 'sprite-checkerboard-light'
      : bgStyle === 'chroma'
      ? 'bg-[#00B140]'
      : 'bg-[#090D14]';

  const handleDownloadCurrentCanvasFrame = () => {
    const canvas = playerCanvasRef.current;
    if (!canvas || !ninja) return;
    downloadDataUrl(
      canvas.toDataURL('image/png'),
      `${ninja.id}_${selectedAnim || 'frame'}.png`
    );
  };

  const handleExportAnimStrip = () => {
    if (!skeleton || !selectedAnim || !ninja) return;
    const res = exportAnimationStripPng(skeleton, selectedAnim, regionCanvasMap, 16);
    downloadDataUrl(res.dataUrl, `${ninja.id}_${selectedAnim}_strip_${res.frameCount}f.png`);
  };

  const handleExportAnimZip = async () => {
    if (!skeleton || !selectedAnim || !ninja || duration <= 0) return;
    setExportingAnim(true);
    try {
      const fps = 18;
      const count = Math.max(1, Math.min(72, Math.round(duration * fps)));
      const cellW = Math.max(160, Math.ceil((skeleton.skeleton?.width || 140) * 1.8));
      const cellH = Math.max(160, Math.ceil((skeleton.skeleton?.height || 140) * 1.8));
      const offCanvas = document.createElement('canvas');
      offCanvas.width = cellW;
      offCanvas.height = cellH;
      const ctx = offCanvas.getContext('2d');
      const animFrames: SlicedFrame[] = [];

      if (ctx) {
        for (let i = 0; i < count; i++) {
          const t = count === 1 ? 0 : (i / count) * duration;
          renderSpineFrameToCanvas(ctx, cellW, cellH, skeleton, selectedAnim, t, regionCanvasMap, 1);
          animFrames.push({
            id: `${selectedAnim}_${i}`,
            name: `${selectedAnim}_${String(i).padStart(3, '0')}`,
            width: cellW,
            height: cellH,
            sourceX: 0,
            sourceY: 0,
            sourceWidth: cellW,
            sourceHeight: cellH,
            rotate: 0,
            dataUrl: offCanvas.toDataURL('image/png'),
          });
        }
      }

      await exportFramesAsZip(`${ninja.id}_${selectedAnim}.zip`, animFrames);
    } finally {
      setExportingAnim(false);
    }
  };

  if (!ninja) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-slate-800 bg-[#131A26] p-10 text-center">
        <h2 className="font-display text-lg font-semibold text-slate-100">
          Nenhum ninja selecionado no Estúdio
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Escolha qualquer personagem no catálogo de Ninjas para reproduzir animações, inspecionar a folha de sprites e exportar frames individuais em PNG ou ZIP.
        </p>
        <button
          type="button"
          onClick={onBackToCatalog}
          className="mt-6 inline-flex items-center rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 transition-colors cursor-pointer"
        >
          Abrir Catálogo de Ninjas
        </button>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {/* Studio Sub-header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBackToCatalog}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#131A26] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-white cursor-pointer"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Catálogo</span>
          </button>
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-50 font-mono">
              {ninja.id}
            </h2>
            <p className="text-xs text-slate-400 font-mono tabular-nums">
              {ninja.width} × {ninja.height} px · {frames.length} frames · {animNames.length} animações
            </p>
          </div>
        </div>

        {/* Mode Switcher */}
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#131A26] p-1">
          <button
            type="button"
            onClick={() => setStageMode('player')}
            disabled={animNames.length === 0}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40 ${
              stageMode === 'player'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <Film className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Animações</span>
          </button>
          <button
            type="button"
            onClick={() => setStageMode('frames')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              stageMode === 'frames'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <Grid className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Frames Fatiados ({frames.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setStageMode('sheet')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              stageMode === 'sheet'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Folha Original</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex h-80 items-center justify-center rounded-lg border border-slate-800 bg-[#131A26]">
          <div className="text-center">
            <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-orange-500" />
            <p className="mt-3 text-sm text-slate-300">
              Baixando atlas, skeleton e folha WebP de {ninja.id}...
            </p>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200">
          {error}
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
          {/* Main Stage */}
          <div className="min-w-0 space-y-4">
            {stageMode === 'player' && (
              <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#131A26]">
                {/* Canvas Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    {(
                      [
                        { id: 'checker', label: 'Xadrez' },
                        { id: 'dark', label: 'Escuro' },
                        { id: 'light', label: 'Claro' },
                        { id: 'chroma', label: 'Chroma' },
                      ] as const
                    ).map((bg) => (
                      <button
                        key={bg.id}
                        type="button"
                        onClick={() => setBgStyle(bg.id)}
                        className={`rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                          bgStyle === bg.id
                            ? 'bg-slate-700 text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {bg.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
                      aria-label="Diminuir zoom"
                      className="rounded border border-slate-800 bg-[#0B0F17] p-1.5 text-slate-300 hover:border-slate-600 cursor-pointer"
                    >
                      <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <span className="w-12 text-center font-mono text-xs text-slate-300 tabular-nums">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
                      aria-label="Aumentar zoom"
                      className="rounded border border-slate-800 bg-[#0B0F17] p-1.5 text-slate-300 hover:border-slate-600 cursor-pointer"
                    >
                      <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {/* Stage Canvas */}
                <div className={`${bgClass} flex items-center justify-center p-4`}>
                  <canvas
                    ref={playerCanvasRef}
                    width={640}
                    height={420}
                    className="max-h-[420px] w-full max-w-[640px] object-contain"
                  />
                </div>

                {/* Playback & Export Controls */}
                <div className="space-y-3 border-t border-slate-800/80 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setIsPlaying(false);
                        setCurrentTime((t) => Math.max(0, t - 1 / 30));
                      }}
                      aria-label="Frame anterior"
                      className="rounded-lg border border-slate-800 bg-[#0B0F17] p-2 text-slate-300 hover:border-slate-600 cursor-pointer"
                    >
                      <SkipBack className="h-4 w-4" aria-hidden="true" />
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsPlaying((p) => !p)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
                    >
                      {isPlaying ? (
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

                    <button
                      type="button"
                      onClick={() => {
                        setIsPlaying(false);
                        setCurrentTime((t) => (duration > 0 ? (t + 1 / 30) % duration : 0));
                      }}
                      aria-label="Próximo frame"
                      className="rounded-lg border border-slate-800 bg-[#0B0F17] p-2 text-slate-300 hover:border-slate-600 cursor-pointer"
                    >
                      <SkipForward className="h-4 w-4" aria-hidden="true" />
                    </button>

                    <input
                      type="range"
                      min={0}
                      max={Math.max(0.01, duration)}
                      step={0.01}
                      value={Math.min(currentTime, duration)}
                      onChange={(e) => {
                        setIsPlaying(false);
                        setCurrentTime(Number(e.target.value));
                      }}
                      aria-label="Linha do tempo da animação"
                      className="min-w-[140px] flex-1 accent-orange-500 cursor-pointer"
                    />

                    <span className="font-mono text-xs text-slate-300 tabular-nums">
                      {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
                    </span>

                    <select
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                      aria-label="Velocidade da animação"
                      className="rounded-lg border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-xs text-slate-200 cursor-pointer"
                    >
                      <option value={0.25}>0.25x</option>
                      <option value={0.5}>0.5x</option>
                      <option value={1}>1.0x</option>
                      <option value={1.5}>1.5x</option>
                      <option value={2}>2.0x</option>
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleDownloadCurrentCanvasFrame}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Baixar Frame Atual PNG</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportAnimStrip}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Exportar Spritesheet ({selectedAnim})</span>
                    </button>
                    <button
                      type="button"
                      disabled={exportingAnim}
                      onClick={handleExportAnimZip}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-950/30 px-3 py-1.5 text-xs font-medium text-orange-200 hover:bg-orange-900/40 disabled:opacity-50 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        {exportingAnim
                          ? 'Renderizando...'
                          : `Baixar Frames "${selectedAnim}" (ZIP)`}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {stageMode === 'frames' && (
              <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <input
                    type="search"
                    value={frameFilter}
                    onChange={(e) => setFrameFilter(e.target.value)}
                    placeholder="Filtrar frame (ex: a33, a0)..."
                    className="w-60 rounded-lg border border-slate-800 bg-[#0B0F17] px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      void exportFramesAsZip(`${ninja.id}_todos_frames.zip`, frames, {
                        atlasText,
                        atlasName: `${ninja.id}.atlas`,
                        skeletonJson: skeleton,
                        skeletonName: `${ninja.id}.json`,
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Baixar Todos os {frames.length} Frames (ZIP)</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                  {filteredFrames.map((frame) => (
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
                          <div className="truncate font-mono text-xs font-medium text-slate-100">
                            {frame.name}
                          </div>
                          <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                            {frame.width}×{frame.height}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            downloadDataUrl(frame.dataUrl, `${ninja.id}_${frame.name}.png`)
                          }
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

            {stageMode === 'sheet' && (
              <div className="space-y-4">
                {pages.map((page) => {
                  const img = pageImages[page.name];
                  const proxyUrl = pageUrls[page.name];
                  return (
                    <div
                      key={page.name}
                      className="overflow-hidden rounded-lg border border-slate-800 bg-[#131A26]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-3">
                        <div className="font-mono text-xs text-slate-300 tabular-nums">
                          {page.name} · {img?.width || page.width} × {img?.height || page.height} px ·{' '}
                          {page.regions.length} regiões
                        </div>
                        <div className="flex items-center gap-3">
                          <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={showAtlasBoxes}
                              onChange={(e) => setShowAtlasBoxes(e.target.checked)}
                              className="accent-orange-500"
                            />
                            <span>Mostrar caixas do Atlas</span>
                          </label>
                          {proxyUrl && (
                            <a
                              href={proxyUrl}
                              download={page.name}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500"
                            >
                              <Download className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Baixar Folha</span>
                            </a>
                          )}
                        </div>
                      </div>

                      {selectedRegion && selectedRegion.pageName === page.name && (
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 bg-[#0B0F17] px-4 py-2 text-xs font-mono text-slate-300 tabular-nums">
                          <span>
                            Região: <strong className="text-orange-400">{selectedRegion.name}</strong> · xy ({selectedRegion.x}, {selectedRegion.y}) · size {selectedRegion.width}×{selectedRegion.height} · rot {selectedRegion.rotate}°
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const frame = frames.find((f) => f.name === selectedRegion.name);
                              if (frame) downloadDataUrl(frame.dataUrl, `${ninja.id}_${frame.name}.png`);
                            }}
                            className="text-orange-400 hover:underline cursor-pointer"
                          >
                            Baixar região PNG
                          </button>
                        </div>
                      )}

                      <div className="sprite-checkerboard max-h-[600px] overflow-auto p-4">
                        {img && (
                          <div
                            className="relative inline-block"
                            style={{ width: img.width, height: img.height }}
                          >
                            <img
                              src={proxyUrl}
                              alt={page.name}
                              referrerPolicy="no-referrer"
                              className="block"
                            />
                            {showAtlasBoxes &&
                              page.regions.map((reg, idx) => {
                                const w = reg.rotate === 90 ? reg.height : reg.width;
                                const h = reg.rotate === 90 ? reg.width : reg.height;
                                const isSel = selectedRegion === reg;
                                return (
                                  <button
                                    key={`${reg.name}-${idx}`}
                                    type="button"
                                    title={`${reg.name} (${reg.width}×${reg.height})`}
                                    onClick={() => setSelectedRegion(reg)}
                                    style={{
                                      left: reg.x,
                                      top: reg.y,
                                      width: w,
                                      height: h,
                                    }}
                                    className={`absolute border transition-colors cursor-pointer ${
                                      isSel
                                        ? 'border-orange-400 bg-orange-500/25'
                                        : 'border-cyan-400/45 hover:border-orange-400 hover:bg-orange-500/15'
                                    }`}
                                  />
                                );
                              })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Inspector Sidebar */}
          <aside className="space-y-4">
            <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-3">
              <h3 className="font-display text-sm font-semibold text-slate-100">
                Especificações do Ativo
              </h3>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
                  <dt className="text-slate-400">Identificador</dt>
                  <dd className="font-mono text-slate-100">{ninja.id}</dd>
                </div>
                <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
                  <dt className="text-slate-400">Dimensão Base</dt>
                  <dd className="font-mono text-slate-100 tabular-nums">
                    {ninja.width} × {ninja.height} px
                  </dd>
                </div>
                <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
                  <dt className="text-slate-400">Frames Fatiados</dt>
                  <dd className="font-mono text-slate-100 tabular-nums">{frames.length}</dd>
                </div>
                <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
                  <dt className="text-slate-400">Versão Spine</dt>
                  <dd className="font-mono text-slate-100 tabular-nums">
                    {skeleton?.skeleton?.spine || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">Folhas (Pages)</dt>
                  <dd className="font-mono text-slate-100 tabular-nums">{pages.length}</dd>
                </div>
              </dl>
            </div>

            {animNames.length > 0 && (
              <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-sm font-semibold text-slate-100">
                    Animações ({animNames.length})
                  </h3>
                </div>
                <input
                  type="search"
                  value={animFilter}
                  onChange={(e) => setAnimFilter(e.target.value)}
                  placeholder="Buscar animação..."
                  aria-label="Filtrar animações"
                  className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                />
                <div className="max-h-[340px] space-y-1 overflow-y-auto pr-1">
                  {filteredAnimNames.map((anim) => {
                    const active = anim === selectedAnim && stageMode === 'player';
                    const dur = skeleton ? getAnimationDuration(skeleton, anim) : 0;
                    return (
                      <button
                        key={anim}
                        type="button"
                        onClick={() => {
                          setSelectedAnim(anim);
                          setCurrentTime(0);
                          animTimeRef.current = 0;
                          setStageMode('player');
                          setIsPlaying(true);
                        }}
                        className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer ${
                          active
                            ? 'bg-orange-600 text-white font-medium'
                            : 'text-slate-300 hover:bg-slate-800/70'
                        }`}
                      >
                        <span className="truncate font-mono">{anim}</span>
                        <span
                          className={`ml-2 shrink-0 font-mono text-[11px] tabular-nums ${
                            active ? 'text-orange-100' : 'text-slate-500'
                          }`}
                        >
                          {dur.toFixed(2)}s
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
