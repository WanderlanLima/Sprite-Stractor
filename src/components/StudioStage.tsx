import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  Download,
  Film,
  Grid,
  Layers,
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  AtlasPage,
  AtlasRegion,
  CompositeSpineLayer,
  NinjaEntry,
  SlicedFrame,
  SpineCommandEffectRef,
  SpineSkeleton,
} from '../types/sprite';
import {
  computeCompositeAnimationWorldBounds,
  downloadBlob,
  downloadDataUrl,
  exportAnimationGif,
  exportAnimationStripPng,
  exportFramesAsZip,
  extractRegionToCanvas,
  extractSpineEffectRefs,
  getAnimationDuration,
  getCompositeAnimationDuration,
  hasVisibleAnimationContent,
  loadImageElement,
  parseAtlas,
  renderSpineFrameToCanvas,
  sliceAtlasRegions,
} from '../utils/atlasParser';
import {
  buildCharacterInstructionsJson,
  collectCharacterEffectPlan,
  exportCompleteCharacterZip,
  type EffectIncludeScope,
} from '../utils/completeCharacterExporter';
import { fetchNinjaBundle, resolveAssetFetchUrl } from '../utils/remoteClient';

interface LoadedEffectBundle {
  skeleton: SpineSkeleton;
  regionCanvasMap: Map<string, HTMLCanvasElement>;
}

const effectBundleCache = new Map<string, Promise<LoadedEffectBundle | null>>();

async function loadEffectImageWithRetry(src: string): Promise<HTMLImageElement> {
  try {
    return await loadImageElement(src);
  } catch {
    await new Promise((r) => setTimeout(r, 350));
    return await loadImageElement(src);
  }
}

function loadEffectBundle(baseAtlasUrl: string, spineId: string): Promise<LoadedEffectBundle | null> {
  let atlasUrl: string;
  let skeletonUrl: string;
  try {
    atlasUrl = new URL(`${spineId}.atlas`, baseAtlasUrl).toString();
    skeletonUrl = new URL(`${spineId}.json`, baseAtlasUrl).toString();
  } catch {
    return Promise.resolve(null);
  }

  const cacheKey = atlasUrl;
  const cached = effectBundleCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const data = await fetchNinjaBundle(atlasUrl, skeletonUrl);
      if (!data.skeleton) return null;
      const parsedPages = parseAtlas(data.atlasText);
      const loadedImgs: Record<string, HTMLImageElement> = {};
      await Promise.allSettled(
        Object.entries(data.pageUrls).map(async ([pageName, proxyUrl]) => {
          loadedImgs[pageName] = await loadEffectImageWithRetry(proxyUrl);
        })
      );
      const canvasMap = new Map<string, HTMLCanvasElement>();
      for (const page of parsedPages) {
        const img = loadedImgs[page.name];
        if (!img) continue;
        for (const reg of page.regions) {
          canvasMap.set(reg.name, extractRegionToCanvas(reg, img));
        }
      }
      if (canvasMap.size === 0) {
        effectBundleCache.delete(cacheKey);
        return null;
      }
      return {
        skeleton: data.skeleton,
        regionCanvasMap: canvasMap,
      };
    } catch {
      effectBundleCache.delete(cacheKey);
      return null;
    }
  })();

  effectBundleCache.set(cacheKey, promise);
  return promise;
}

interface StudioStageProps {
  ninja: NinjaEntry | null;
  openCompleteExportSignal?: number;
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
  openCompleteExportSignal = 0,
  onBackToCatalog,
  onLoadedFramesChange,
}: StudioStageProps) {
  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [bgStyle, setBgStyle] = useState<BgStyle>('checker');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [autoFit, setAutoFit] = useState(true);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

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
  const [gifProgress, setGifProgress] = useState<number | null>(null);
  const [gifBg, setGifBg] = useState<'transparent' | 'dark' | 'light' | 'chroma'>('transparent');

  // Complete character export modal state
  const [showCompleteExportModal, setShowCompleteExportModal] = useState(false);
  const [completeEffectScope, setCompleteEffectScope] = useState<EffectIncludeScope>('powers');
  const [completeIncludeOriginals, setCompleteIncludeOriginals] = useState(true);
  const [completeIncludeEffects, setCompleteIncludeEffects] = useState(true);
  const [completeIncludeAnimPngs, setCompleteIncludeAnimPngs] = useState(true);
  const [completeIncludeAnimGifs, setCompleteIncludeAnimGifs] = useState(true);
  const [completeGifBg, setCompleteGifBg] = useState<'transparent' | 'dark' | 'light' | 'chroma'>(
    'transparent'
  );
  const [completeExportProgress, setCompleteExportProgress] = useState<{
    phase: string;
    message: string;
    percent: number;
  } | null>(null);
  const [completeExportError, setCompleteExportError] = useState<string | null>(null);
  const completeExportAbortRef = useRef<AbortController | null>(null);

  const [effectMode, setEffectMode] = useState<'powers' | 'all' | 'base'>('powers');
  const [compositeLayers, setCompositeLayers] = useState<CompositeSpineLayer[]>([]);
  const [loadingEffects, setLoadingEffects] = useState(false);
  const [effectLoadError, setEffectLoadError] = useState<string | null>(null);

  const [playerDetached, setPlayerDetached] = useState(false);
  const [dockHeight, setDockHeight] = useState(0);
  const [nameArtFailed, setNameArtFailed] = useState(false);

  const playerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerBoxRef = useRef<HTMLDivElement | null>(null);
  const savedScrollYRef = useRef<number | null>(null);
  const animTimeRef = useRef(0);

  const openDetachedPlayer = () => {
    if (!playerDetached) {
      savedScrollYRef.current = window.scrollY;
      if (playerBoxRef.current) {
        const h = playerBoxRef.current.getBoundingClientRect().height;
        if (h > 0) setDockHeight(h);
      }
    }
    setPlayerDetached(true);
  };

  const closeDetachedPlayer = () => {
    setPlayerDetached(false);
  };

  useEffect(() => {
    if (!ninja) {
      onLoadedFramesChange(null);
      return;
    }

    let cancelled = false;
    window.scrollTo({ top: 0, behavior: 'auto' });
    setLoading(true);
    setError(null);
    setSelectedRegion(null);
    setCurrentTime(0);
    setAutoFit(true);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNameArtFailed(false);
    savedScrollYRef.current = null;
    setDockHeight(0);
    setPlayerDetached(false);
    setShowCompleteExportModal(false);
    setCompleteExportProgress(null);
    setCompleteExportError(null);
    setEffectMode('powers');
    setCompositeLayers([]);
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
        const idleAnim = availableAnims.find((a) => a.toLowerCase() === 'idle');
        const visibleIdle =
          idleAnim && hasVisibleAnimationContent(data.skeleton, idleAnim) ? idleAnim : undefined;
        const firstVisiblePriority = PRIORITY_ANIM_ORDER.find(
          (a) => availableAnims.includes(a) && hasVisibleAnimationContent(data.skeleton, a)
        );
        const firstVisibleAny = availableAnims.find((a) =>
          hasVisibleAnimationContent(data.skeleton, a)
        );
        const defaultAnim =
          visibleIdle ||
          firstVisiblePriority ||
          firstVisibleAny ||
          idleAnim ||
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
        if (defaultAnim) {
          setSelectedAnim(defaultAnim);
          setStageMode('player');
          setIsPlaying(true);
          setCurrentTime(0);
          animTimeRef.current = 0;
        } else {
          setStageMode('frames');
        }

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
      const aIdle = a.toLowerCase() === 'idle';
      const bIdle = b.toLowerCase() === 'idle';
      if (aIdle && !bIdle) return -1;
      if (!aIdle && bIdle) return 1;
      const ia = PRIORITY_ANIM_ORDER.indexOf(a);
      const ib = PRIORITY_ANIM_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [skeleton]);

  // Exit detached overlay if user leaves player mode
  useEffect(() => {
    if (stageMode !== 'player') {
      setPlayerDetached(false);
    }
  }, [stageMode]);

  // Lock background scroll, allow Escape key to dismiss, and restore scrollY on close
  useEffect(() => {
    if (!playerDetached) {
      const targetY = savedScrollYRef.current;
      if (targetY !== null) {
        savedScrollYRef.current = null;
        window.scrollTo({ top: targetY, behavior: 'auto' });
        const rafId = requestAnimationFrame(() => {
          window.scrollTo({ top: targetY, behavior: 'auto' });
        });
        return () => cancelAnimationFrame(rafId);
      }
      return;
    }

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDetachedPlayer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [playerDetached]);

  useEffect(() => {
    if (openCompleteExportSignal > 0 && ninja && !loading && !error) {
      setShowCompleteExportModal(true);
    }
  }, [openCompleteExportSignal, ninja, loading, error]);

  const completeEffectPlan = useMemo(
    () => collectCharacterEffectPlan(skeleton, completeEffectScope),
    [skeleton, completeEffectScope]
  );

  const animEffectMap = useMemo(() => {
    const map = new Map<string, SpineCommandEffectRef[]>();
    if (!skeleton) return map;
    for (const animName of animNames) {
      map.set(animName, extractSpineEffectRefs(skeleton, animName));
    }
    return map;
  }, [skeleton, animNames]);

  const rawEffectRefs = useMemo(
    () => animEffectMap.get(selectedAnim) || [],
    [animEffectMap, selectedAnim]
  );

  const hasSelfPowers = useMemo(
    () => rawEffectRefs.some((r) => r.isSelfOrScreen),
    [rawEffectRefs]
  );
  const hasImpactEffects = useMemo(
    () => rawEffectRefs.some((r) => !r.isSelfOrScreen),
    [rawEffectRefs]
  );

  // Load companion Spine power/particle bundles for the selected animation
  useEffect(() => {
    if (!ninja || !skeleton || !selectedAnim || effectMode === 'base' || rawEffectRefs.length === 0) {
      setCompositeLayers([]);
      setLoadingEffects(false);
      setEffectLoadError(null);
      return;
    }

    const activeRefs =
      effectMode === 'all'
        ? rawEffectRefs
        : rawEffectRefs.filter((r) => r.isSelfOrScreen);

    if (activeRefs.length === 0) {
      setCompositeLayers([]);
      setLoadingEffects(false);
      setEffectLoadError(null);
      return;
    }

    let cancelled = false;
    setCompositeLayers([]);
    setLoadingEffects(true);
    setEffectLoadError(null);

    const uniqueSpineIds = Array.from(new Set(activeRefs.map((r) => r.spineId)));
    Promise.all(
      uniqueSpineIds.map(async (id) => [id, await loadEffectBundle(ninja.atlasUrl, id)] as const)
    )
      .then((entries) => {
        if (cancelled) return;
        const bundleMap = new Map<string, LoadedEffectBundle>();
        for (const [id, bundle] of entries) {
          if (bundle) bundleMap.set(id, bundle);
        }

        const builtLayers: CompositeSpineLayer[] = [];
        for (const ref of activeRefs) {
          const bundle = bundleMap.get(ref.spineId);
          if (!bundle) continue;
          const available = Object.keys(bundle.skeleton.animations || {});
          const refLower = ref.animName.trim().toLowerCase();
          const targetAnim =
            available.find((a) => a === ref.animName) ||
            available.find((a) => a.trim().toLowerCase() === refLower) ||
            available[0];
          if (!targetAnim) continue;

          builtLayers.push({
            spineId: ref.spineId,
            skeleton: bundle.skeleton,
            animName: targetAnim,
            regionCanvasMap: bundle.regionCanvasMap,
            startTime: ref.startTime,
            duration: getAnimationDuration(bundle.skeleton, targetAnim),
            layer: ref.layer,
            loop: ref.loop,
          });
        }
        setCompositeLayers(builtLayers);
        if (builtLayers.length === 0) {
          setEffectLoadError('Partículas indisponíveis no momento');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingEffects(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ninja, skeleton, selectedAnim, effectMode, rawEffectRefs]);

  const filteredAnimNames = useMemo(() => {
    const q = animFilter.trim().toLowerCase();
    return q ? animNames.filter((a) => a.toLowerCase().includes(q)) : animNames;
  }, [animNames, animFilter]);

  const filteredFrames = useMemo(() => {
    const q = frameFilter.trim().toLowerCase();
    return q ? frames.filter((f) => f.name.toLowerCase().includes(q)) : frames;
  }, [frames, frameFilter]);

  const baseDuration = useMemo(() => {
    if (!skeleton || !selectedAnim) return 0;
    return getAnimationDuration(skeleton, selectedAnim);
  }, [skeleton, selectedAnim]);

  const duration = useMemo(
    () => getCompositeAnimationDuration(baseDuration, compositeLayers),
    [baseDuration, compositeLayers]
  );

  const animWorldBounds = useMemo(() => {
    if (!skeleton || !selectedAnim || regionCanvasMap.size === 0) return null;
    return computeCompositeAnimationWorldBounds(
      skeleton,
      selectedAnim,
      regionCanvasMap,
      compositeLayers,
      24
    );
  }, [skeleton, selectedAnim, regionCanvasMap, compositeLayers]);

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
        zoom,
        pan.x,
        pan.y,
        autoFit ? animWorldBounds : null,
        compositeLayers,
        {
          fillRatio: 0.66,
          maxAutoFitScale: 1.65,
          followFramePose: zoom > 1.05,
        }
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
  }, [
    stageMode,
    skeleton,
    selectedAnim,
    regionCanvasMap,
    compositeLayers,
    isPlaying,
    speed,
    duration,
    zoom,
    pan,
    autoFit,
    animWorldBounds,
    loading,
  ]);

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
        zoom,
        pan.x,
        pan.y,
        autoFit ? animWorldBounds : null,
        compositeLayers,
        {
          fillRatio: 0.66,
          maxAutoFitScale: 1.65,
          followFramePose: zoom > 1.05,
        }
      );
    }
  }, [
    currentTime,
    isPlaying,
    stageMode,
    skeleton,
    selectedAnim,
    regionCanvasMap,
    compositeLayers,
    zoom,
    pan,
    autoFit,
    animWorldBounds,
  ]);

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
    const res = exportAnimationStripPng(
      skeleton,
      selectedAnim,
      regionCanvasMap,
      16,
      compositeLayers
    );
    const suffix = compositeLayers.length > 0 ? '_com_poderes' : '';
    downloadDataUrl(res.dataUrl, `${ninja.id}_${selectedAnim}${suffix}_strip_${res.frameCount}f.png`);
  };

  const handleExportAnimZip = async () => {
    if (!skeleton || !selectedAnim || !ninja || duration <= 0) return;
    setExportingAnim(true);
    try {
      const fps = 18;
      const count = Math.max(1, Math.min(72, Math.round(duration * fps)));
      const bounds =
        animWorldBounds ||
        computeCompositeAnimationWorldBounds(
          skeleton,
          selectedAnim,
          regionCanvasMap,
          compositeLayers,
          24
        );
      const cellW = Math.max(160, Math.min(640, Math.ceil(bounds.width * 1.16)));
      const cellH = Math.max(160, Math.min(640, Math.ceil(bounds.height * 1.16)));
      const offCanvas = document.createElement('canvas');
      offCanvas.width = cellW;
      offCanvas.height = cellH;
      const ctx = offCanvas.getContext('2d');
      const animFrames: SlicedFrame[] = [];

      if (ctx) {
        for (let i = 0; i < count; i++) {
          const t = count === 1 ? 0 : (i / count) * duration;
          renderSpineFrameToCanvas(
            ctx,
            cellW,
            cellH,
            skeleton,
            selectedAnim,
            t,
            regionCanvasMap,
            1,
            0,
            0,
            bounds,
            compositeLayers
          );
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

      const suffix = compositeLayers.length > 0 ? '_com_poderes' : '';
      const rawRefsForAnim = extractSpineEffectRefs(skeleton, selectedAnim);
      const animInstructions = JSON.stringify(
        {
          characterId: ninja.id,
          animation: selectedAnim,
          durationSec: Number(duration.toFixed(4)),
          fps,
          frameCount: animFrames.length,
          effectMode,
          effects: rawRefsForAnim.map((r) => ({
            spineId: r.spineId,
            effectAnim: r.animName,
            startTimeSec: Number(r.startTime.toFixed(4)),
            layer: r.layer,
            isSelfOrScreen: r.isSelfOrScreen,
            loop: r.loop,
            rawCommand: r.rawCommand,
          })),
        },
        null,
        2
      );
      await exportFramesAsZip(`${ninja.id}_${selectedAnim}${suffix}.zip`, animFrames, {
        extraFiles: [{ path: 'instrucoes_animacao.json', data: animInstructions }],
      });
    } finally {
      setExportingAnim(false);
    }
  };

  const handleRunCompleteCharacterExport = async () => {
    if (!ninja) return;
    const controller = new AbortController();
    completeExportAbortRef.current = controller;
    setCompleteExportError(null);
    setCompleteExportProgress({
      phase: 'base',
      message: 'Iniciando empacotamento completo...',
      percent: 2,
    });

    try {
      await exportCompleteCharacterZip(
        {
          ninja,
          atlasText,
          skeleton,
          pageUrls,
          pageImages,
          regionCanvasMap,
        },
        {
          effectScope: completeEffectScope,
          includeOriginalAndFrames: completeIncludeOriginals,
          includeLinkedEffects: completeIncludeEffects,
          includeAnimPngsAndSheets: completeIncludeAnimPngs,
          includeAnimGifs: completeIncludeAnimGifs,
          gifBg: completeGifBg,
          fps: 18,
          signal: controller.signal,
          onProgress: (info) => setCompleteExportProgress(info),
        }
      );
      setShowCompleteExportModal(false);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setCompleteExportError(
          err instanceof Error ? err.message : 'Erro ao exportar personagem completo.'
        );
      }
    } finally {
      completeExportAbortRef.current = null;
      setCompleteExportProgress(null);
    }
  };

  const handleExportAnimGif = async () => {
    if (!skeleton || !selectedAnim || !ninja) return;
    setGifProgress(0);
    const backgroundColor =
      gifBg === 'dark'
        ? '#090D14'
        : gifBg === 'light'
        ? '#F8FAFC'
        : gifBg === 'chroma'
        ? '#00B140'
        : null;
    try {
      const res = await exportAnimationGif(skeleton, selectedAnim, regionCanvasMap, {
        fps: 18,
        bounds: animWorldBounds,
        backgroundColor,
        compositeLayers,
        onProgress: (pct) => setGifProgress(pct),
      });
      const powerSuffix = compositeLayers.length > 0 ? '_poderes' : '';
      const bgSuffix = gifBg === 'transparent' ? '_sem_fundo' : `_${gifBg}`;
      downloadBlob(res.blob, `${ninja.id}_${selectedAnim}${powerSuffix}${bgSuffix}.gif`);
    } finally {
      setGifProgress(null);
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
      <div className="flex flex-col gap-3 border-b border-slate-800/80 pb-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onBackToCatalog}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-800 bg-[#131A26] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-white cursor-pointer"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Catálogo</span>
          </button>
          {ninja.nameArtUrl && !nameArtFailed && (
            <img
              src={resolveAssetFetchUrl(ninja.nameArtUrl)}
              alt={ninja.name || ninja.id}
              onError={() => setNameArtFailed(true)}
              referrerPolicy="no-referrer"
              className="hidden h-9 w-auto max-w-[140px] shrink-0 object-contain sm:block"
            />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 className="truncate font-display text-base font-semibold text-slate-50 sm:text-lg">
                {ninja.name || ninja.id}
              </h2>
              {ninja.name && (
                <span className="font-mono text-xs text-slate-400">{ninja.id}</span>
              )}
            </div>
            <p className="text-xs text-slate-400 font-mono tabular-nums">
              {ninja.width} × {ninja.height} px · {frames.length} frames · {animNames.length} animações
            </p>
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {/* Mode Switcher */}
          <div className="flex w-full items-center gap-1 overflow-x-auto rounded-lg border border-slate-800 bg-[#131A26] p-1 sm:w-auto">
            <button
              type="button"
              onClick={() => setStageMode('player')}
              disabled={animNames.length === 0}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 ${
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
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
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
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                stageMode === 'sheet'
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Folha Original</span>
            </button>
          </div>

          <button
            type="button"
            disabled={loading || Boolean(error)}
            onClick={() => setShowCompleteExportModal(true)}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer whitespace-nowrap sm:w-auto"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Baixar Completo (ZIP)</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex h-80 items-center justify-center rounded-lg border border-slate-800 bg-[#131A26] px-4">
          <div className="text-center">
            <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-orange-500" />
            <p className="mt-3 text-sm text-slate-300">
              Baixando atlas, skeleton e folha WebP de {ninja.name ? `${ninja.name} (${ninja.id})` : ninja.id}...
            </p>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200">
          {error}
        </div>
      )}

      {!loading && !error && frames.length > 0 && !skeleton && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/25 px-4 py-3 text-xs text-amber-200">
          Modo estático: os frames fatiados e a folha original foram carregados normalmente para visualização e exportação em PNG/ZIP. Para reproduzir animações Spine (.json) no GitHub Pages, configure um Proxy CORS próprio (ex: Cloudflare Worker) nas opções da aba Extrator URL.
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
          {/* Main Stage */}
          <div className="min-w-0 space-y-4">
            {stageMode === 'player' && (
              <div
                style={
                  playerDetached && dockHeight > 0
                    ? { minHeight: `${dockHeight}px` }
                    : undefined
                }
              >
                {playerDetached && (
                  <div className="flex items-center justify-between rounded-lg border border-dashed border-slate-700/80 bg-[#131A26]/50 px-4 py-6 text-xs text-slate-400">
                    <span>Player exibido em tela cheia · Animação: {selectedAnim}</span>
                    <button
                      type="button"
                      onClick={closeDetachedPlayer}
                      className="rounded-md border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-orange-500 cursor-pointer whitespace-nowrap shrink-0"
                    >
                      Recolher aqui
                    </button>
                  </div>
                )}

                <div
                  className={
                    playerDetached
                      ? 'fixed inset-0 z-50 overflow-y-auto bg-[#0B0F17]/95 backdrop-blur-md p-2 sm:p-6 pb-[max(0.75rem,env(safe-area-inset-bottom))]'
                      : ''
                  }
                  onClick={
                    playerDetached
                      ? (e) => {
                          if (e.target === e.currentTarget) {
                            closeDetachedPlayer();
                          }
                        }
                      : undefined
                  }
                  role={playerDetached ? 'dialog' : undefined}
                  aria-modal={playerDetached ? true : undefined}
                  aria-label={playerDetached ? `Player de animação ${ninja.name || ninja.id}` : undefined}
                >
                  <div
                    ref={!playerDetached ? playerBoxRef : undefined}
                    className={`rounded-lg border border-slate-800 bg-[#131A26] ${
                      playerDetached
                        ? 'mx-auto my-1 sm:my-2 w-full max-w-6xl border-slate-700/80 shadow-2xl'
                        : 'overflow-hidden'
                    }`}
                  >
                    {playerDetached && (
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-lg border-b border-slate-800/80 bg-[#0F1520] px-3 py-2 sm:px-4 sm:py-2.5">
                        <div className="flex min-w-0 items-center gap-2 text-xs">
                          <span className="truncate font-display font-semibold text-slate-100">
                            {ninja.name || ninja.id}
                          </span>
                          {ninja.name && (
                            <span className="hidden font-mono text-[11px] text-slate-400 sm:inline">
                              ({ninja.id})
                            </span>
                          )}
                          <span className="text-slate-500" aria-hidden="true">
                            ·
                          </span>
                          <span className="truncate font-mono font-medium text-orange-400">
                            {selectedAnim}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={closeDetachedPlayer}
                          className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#131A26] px-3 py-1.5 text-xs font-semibold text-slate-100 hover:border-orange-500 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer sm:px-4 sm:py-2"
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                          <span>Fechar</span>
                        </button>
                      </div>
                    )}

                    {/* Canvas Toolbar */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-2.5 py-2 sm:gap-3 sm:px-4 sm:py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
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
                              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                bgStyle === bg.id
                                  ? 'bg-slate-700 text-white'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {bg.label}
                            </button>
                          ))}
                        </div>

                        {rawEffectRefs.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1 rounded border border-slate-800 bg-[#0B0F17] p-0.5">
                            {hasSelfPowers && (
                              <button
                                type="button"
                                onClick={() => setEffectMode('powers')}
                                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                  effectMode === 'powers'
                                    ? 'bg-orange-600 text-white'
                                    : 'text-slate-400 hover:text-slate-100'
                                }`}
                              >
                                Com poderes
                              </button>
                            )}
                            {hasImpactEffects && (
                              <button
                                type="button"
                                onClick={() => setEffectMode('all')}
                                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                  effectMode === 'all'
                                    ? 'bg-orange-600 text-white'
                                    : 'text-slate-400 hover:text-slate-100'
                                }`}
                              >
                                {hasSelfPowers ? 'Completa (+ impactos)' : 'Com efeitos'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setEffectMode('base')}
                              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                effectMode === 'base'
                                  ? 'bg-slate-700 text-white'
                                  : 'text-slate-400 hover:text-slate-100'
                              }`}
                            >
                              Somente ninja
                            </button>
                          </div>
                        )}

                        {loadingEffects && (
                          <span className="text-xs text-orange-300 font-mono whitespace-nowrap">
                            Carregando poderes...
                          </span>
                        )}
                        {!loadingEffects && effectLoadError && (
                          <span className="text-xs text-amber-300 font-mono whitespace-nowrap">
                            {effectLoadError}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1 rounded border border-slate-800 bg-[#0B0F17] p-0.5">
                          <button
                            type="button"
                            onClick={() => setPan((p) => ({ ...p, x: p.x - 24 }))}
                            aria-label="Mover para esquerda"
                            title="Mover esquerda"
                            className="rounded p-1 text-slate-300 hover:bg-slate-800 cursor-pointer"
                          >
                            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setPan((p) => ({ ...p, y: p.y - 24 }))}
                            aria-label="Mover para cima"
                            title="Mover cima"
                            className="rounded p-1 text-slate-300 hover:bg-slate-800 cursor-pointer"
                          >
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setPan((p) => ({ ...p, y: p.y + 24 }))}
                            aria-label="Mover para baixo"
                            title="Mover baixo"
                            className="rounded p-1 text-slate-300 hover:bg-slate-800 cursor-pointer"
                          >
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setPan((p) => ({ ...p, x: p.x + 24 }))}
                            aria-label="Mover para direita"
                            title="Mover direita"
                            className="rounded p-1 text-slate-300 hover:bg-slate-800 cursor-pointer"
                          >
                            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setAutoFit(true);
                            setPan({ x: 0, y: 0 });
                          }}
                          title="Centralizar animação mantendo o zoom atual"
                          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                            autoFit && pan.x === 0 && pan.y === 0
                              ? 'border-orange-500/60 bg-orange-950/30 text-orange-200'
                              : 'border-slate-800 bg-[#0B0F17] text-slate-300 hover:border-slate-600'
                          }`}
                        >
                          <Maximize2 className="h-3 w-3" aria-hidden="true" />
                          <span>Enquadrar</span>
                        </button>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setZoom((z) => Math.max(0.2, Number((z - 0.15).toFixed(2))))
                            }
                            aria-label="Diminuir zoom"
                            className="rounded border border-slate-800 bg-[#0B0F17] p-1.5 text-slate-300 hover:border-slate-600 cursor-pointer"
                          >
                            <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setZoom(1);
                              setPan({ x: 0, y: 0 });
                            }}
                            title="Clique para voltar o zoom a 100%"
                            aria-label={`Zoom atual ${Math.round(zoom * 100)}%, clique para resetar para 100%`}
                            className="w-11 rounded py-1 text-center font-mono text-xs text-slate-300 tabular-nums hover:bg-slate-800 hover:text-white cursor-pointer"
                          >
                            {Math.round(zoom * 100)}%
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setZoom((z) => Math.min(6, Number((z + 0.15).toFixed(2))))
                            }
                            aria-label="Aumentar zoom"
                            className="rounded border border-slate-800 bg-[#0B0F17] p-1.5 text-slate-300 hover:border-slate-600 cursor-pointer"
                          >
                            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Stage Canvas (supports touch/mouse drag to pan) */}
                    <div
                      className={`${bgClass} relative flex items-center justify-center p-2 sm:p-4 ${
                        playerDetached ? 'h-[40dvh] min-h-[220px] sm:h-[48vh] max-h-[520px]' : ''
                      }`}
                    >
                      <canvas
                        ref={playerCanvasRef}
                        width={640}
                        height={420}
                        onPointerDown={(e) => {
                          e.currentTarget.setPointerCapture(e.pointerId);
                          dragStartRef.current = {
                            x: e.clientX,
                            y: e.clientY,
                            panX: pan.x,
                            panY: pan.y,
                          };
                        }}
                        onPointerMove={(e) => {
                          const d = dragStartRef.current;
                          if (!d) return;
                          const rect = e.currentTarget.getBoundingClientRect();
                          const scaleX = e.currentTarget.width / Math.max(1, rect.width);
                          const scaleY = e.currentTarget.height / Math.max(1, rect.height);
                          setPan({
                            x: Math.round(d.panX + (e.clientX - d.x) * scaleX),
                            y: Math.round(d.panY + (e.clientY - d.y) * scaleY),
                          });
                        }}
                        onPointerUp={(e) => {
                          dragStartRef.current = null;
                          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                            e.currentTarget.releasePointerCapture(e.pointerId);
                          }
                        }}
                        onPointerCancel={() => {
                          dragStartRef.current = null;
                        }}
                        className={
                          playerDetached
                            ? 'h-full w-full max-w-5xl object-contain touch-none cursor-grab active:cursor-grabbing'
                            : 'max-h-[420px] w-full max-w-[640px] object-contain touch-none cursor-grab active:cursor-grabbing'
                        }
                      />
                      <span className="pointer-events-none absolute bottom-2 right-3 rounded bg-black/55 px-2 py-0.5 text-[10px] font-mono text-slate-300">
                        {zoom > 1.05
                          ? 'Arraste para mover · Rastreamento automático ativo'
                          : 'Arraste para mover · Enquadramento automático ativo'}
                      </span>
                    </div>

                {/* Playback & Export Controls */}
                <div className="space-y-3 border-t border-slate-800/80 p-3 sm:p-4">
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
                    <div className="inline-flex max-w-full flex-wrap items-center overflow-hidden rounded-lg border border-emerald-500/40 bg-emerald-950/30 sm:flex-nowrap">
                      <select
                        value={gifBg}
                        disabled={exportingAnim || gifProgress !== null}
                        onChange={(e) =>
                          setGifBg(
                            e.target.value as 'transparent' | 'dark' | 'light' | 'chroma'
                          )
                        }
                        aria-label="Fundo do GIF"
                        className="border-b border-emerald-500/30 bg-transparent px-2 py-1.5 text-xs text-emerald-100 focus:outline-none cursor-pointer disabled:opacity-50 sm:border-b-0 sm:border-r"
                      >
                        <option value="transparent" className="bg-[#0B0F17] text-slate-100">
                          Sem fundo
                        </option>
                        <option value="dark" className="bg-[#0B0F17] text-slate-100">
                          Fundo escuro
                        </option>
                        <option value="light" className="bg-[#0B0F17] text-slate-100">
                          Fundo claro
                        </option>
                        <option value="chroma" className="bg-[#0B0F17] text-slate-100">
                          Chroma verde
                        </option>
                      </select>
                      <button
                        type="button"
                        disabled={exportingAnim || gifProgress !== null}
                        onClick={() => void handleExportAnimGif()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-50 cursor-pointer"
                      >
                        <Film className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {gifProgress !== null
                            ? `Gerando GIF (${gifProgress}%)...`
                            : `Exportar GIF (${selectedAnim})`}
                        </span>
                      </button>
                    </div>
                    <button
                      type="button"
                      disabled={exportingAnim || gifProgress !== null}
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
                    className="w-full rounded-lg border border-slate-800 bg-[#0B0F17] px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none sm:w-60"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowCompleteExportModal(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Personagem Completo + Animações (ZIP)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void exportFramesAsZip(`${ninja.id}_todos_frames.zip`, frames, {
                          atlasText,
                          atlasName: `${ninja.id}.atlas`,
                          skeletonJson: skeleton,
                          skeletonName: `${ninja.id}.json`,
                          extraFiles: skeleton
                            ? [
                                {
                                  path: 'animacoes_instrucoes.json',
                                  data: buildCharacterInstructionsJson(
                                    ninja.id,
                                    skeleton,
                                    'all'
                                  ),
                                },
                              ]
                            : undefined,
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Baixar Só Frames Base ({frames.length})</span>
                    </button>
                  </div>
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
              {ninja.nameArtUrl && !nameArtFailed && (
                <div className="flex items-center justify-center rounded-md border border-slate-800/80 bg-[#0B0F17] px-3 py-2">
                  <img
                    src={resolveAssetFetchUrl(ninja.nameArtUrl)}
                    alt={ninja.name || ninja.id}
                    onError={() => setNameArtFailed(true)}
                    referrerPolicy="no-referrer"
                    className="max-h-14 w-auto max-w-full object-contain"
                  />
                </div>
              )}
              <dl className="space-y-2 text-xs">
                {ninja.name && (
                  <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
                    <dt className="text-slate-400">Personagem</dt>
                    <dd className="text-right font-medium text-slate-100">{ninja.name}</dd>
                  </div>
                )}
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
                    const effRefs = animEffectMap.get(anim) || [];
                    const hasPowers = effRefs.some((r) => r.isSelfOrScreen);
                    const hasImpacts = !hasPowers && effRefs.length > 0;
                    return (
                      <button
                        key={anim}
                        type="button"
                        onClick={() => {
                          setSelectedAnim(anim);
                          setCurrentTime(0);
                          animTimeRef.current = 0;
                          setAutoFit(true);
                          setZoom(1);
                          setPan({ x: 0, y: 0 });
                          setStageMode('player');
                          setIsPlaying(true);
                          setEffectMode(hasPowers ? 'powers' : hasImpacts ? 'all' : 'base');
                          openDetachedPlayer();
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
                          {hasPowers ? '+poder · ' : hasImpacts ? '+efeito · ' : ''}
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

      {showCompleteExportModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="complete-char-export-title"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-2 sm:p-4"
        >
          <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-[#131A26] p-4 sm:p-5 space-y-4 max-h-[90dvh] overflow-y-auto shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
              <div className="min-w-0">
                <h3
                  id="complete-char-export-title"
                  className="font-display text-base font-semibold text-slate-50"
                >
                  Exportar Personagem Completo (ZIP)
                </h3>
                <p className="mt-0.5 font-mono text-xs text-slate-400">
                  {ninja.name ? `${ninja.name} · ` : ''}
                  {ninja.id} · {frames.length} frames · {animNames.length} animações ·{' '}
                  {completeEffectPlan.uniqueSpineIds.length} pacote(s) de partículas
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(completeExportProgress)}
                onClick={() => setShowCompleteExportModal(false)}
                aria-label="Fechar janela"
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40 cursor-pointer"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {completeEffectPlan.uniqueSpineIds.length > 0 && (
              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3 space-y-1.5">
                <div className="text-[11px] font-medium text-slate-300">
                  Pacotes de partículas vinculados encontrados no <code className="font-mono text-orange-300">.json</code>:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {completeEffectPlan.uniqueSpineIds.map((effId) => (
                    <span
                      key={effId}
                      className="rounded border border-orange-500/30 bg-orange-950/30 px-2 py-0.5 font-mono text-[11px] text-orange-200"
                    >
                      {effId}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2 text-xs">
              <label className="block space-y-1">
                <span className="font-medium text-slate-300">Escopo de partículas e poderes</span>
                <select
                  disabled={Boolean(completeExportProgress)}
                  value={completeEffectScope}
                  onChange={(e) => setCompleteEffectScope(e.target.value as EffectIncludeScope)}
                  className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100"
                >
                  <option value="powers">Com poderes (partículas no ninja e tela — recomendado)</option>
                  <option value="all">Completa (+ efeitos de impacto no alvo)</option>
                  <option value="base">Somente ninja (sem partículas)</option>
                </select>
              </label>

              <div className="space-y-2 pt-1">
                <span className="block font-medium text-slate-300">O que incluir na pasta do personagem</span>

                <label className="flex items-start gap-2.5 rounded-md border border-slate-800 bg-[#0B0F17] p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeOriginals}
                    onChange={(e) => setCompleteIncludeOriginals(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">
                      Originais + Frames Fatiados
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Inclui <code className="font-mono">.atlas</code>, <code className="font-mono">.json</code>, folha original e pasta <code className="font-mono">frames/*.png</code>.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 rounded-md border border-slate-800 bg-[#0B0F17] p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeEffects}
                    onChange={(e) => setCompleteIncludeEffects(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">
                      Pacotes de Partículas + Instruções JSON
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Inclui <code className="font-mono">particulas/&lt;efeito&gt;/</code> e <code className="font-mono">animacoes_instrucoes.json</code> mapeando cada animação e tempo de disparo.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 rounded-md border border-slate-800 bg-[#0B0F17] p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeAnimPngs}
                    onChange={(e) => setCompleteIncludeAnimPngs(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">
                      Todas as Animações: Sequência PNG + Spritesheet
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Renderiza cada animação já composta com as partículas em <code className="font-mono">animacoes/&lt;anim&gt;/</code>.
                    </div>
                  </div>
                </label>

                <div className="rounded-md border border-slate-800 bg-[#0B0F17] p-2.5 space-y-2">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={Boolean(completeExportProgress)}
                      checked={completeIncludeAnimGifs}
                      onChange={(e) => setCompleteIncludeAnimGifs(e.target.checked)}
                      className="mt-0.5 accent-emerald-500"
                    />
                    <div>
                      <div className="font-medium text-slate-100">
                        Todas as Animações em GIF Animado
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Gera <code className="font-mono">&lt;anim&gt;.gif</code> já com os poderes para cada animação.
                      </div>
                    </div>
                  </label>

                  {completeIncludeAnimGifs && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pl-2 sm:pl-6">
                      <span className="text-[11px] text-slate-400">Fundo dos GIFs:</span>
                      <select
                        disabled={Boolean(completeExportProgress)}
                        value={completeGifBg}
                        onChange={(e) =>
                          setCompleteGifBg(
                            e.target.value as 'transparent' | 'dark' | 'light' | 'chroma'
                          )
                        }
                        className="w-full sm:w-auto rounded border border-slate-800 bg-[#131A26] px-2 py-1 text-[11px] text-slate-200"
                      >
                        <option value="transparent">Sem fundo (transparente)</option>
                        <option value="dark">Fundo escuro</option>
                        <option value="light">Fundo claro</option>
                        <option value="chroma">Chroma verde</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {completeExportProgress && (
              <div className="space-y-1.5 rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
                <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="truncate text-slate-200">{completeExportProgress.message}</span>
                  <span className="ml-2 shrink-0 text-emerald-400">
                    {completeExportProgress.percent}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-150"
                    style={{ width: `${completeExportProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            {completeExportError && (
              <div
                role="alert"
                className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200"
              >
                {completeExportError}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              {completeExportProgress ? (
                <button
                  type="button"
                  onClick={() => completeExportAbortRef.current?.abort()}
                  className="rounded-lg border border-red-700/70 bg-red-950/40 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-900/50 cursor-pointer"
                >
                  Cancelar
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setShowCompleteExportModal(false)}
                    className="rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-300 hover:border-slate-500 cursor-pointer"
                  >
                    Fechar
                  </button>
                  <button
                    type="button"
                    disabled={
                      !completeIncludeOriginals &&
                      !completeIncludeEffects &&
                      !completeIncludeAnimPngs &&
                      !completeIncludeAnimGifs
                    }
                    onClick={() => void handleRunCompleteCharacterExport()}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer sm:w-auto"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Baixar {ninja.id}_completo.zip</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
