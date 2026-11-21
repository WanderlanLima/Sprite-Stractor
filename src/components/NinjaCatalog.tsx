import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Eye, Image as ImageIcon, Search } from 'lucide-react';
import type { NinjaEntry } from '../types/sprite';
import { extractRegionToCanvas, loadImageElement, parseAtlas } from '../utils/atlasParser';
import {
  fetchNinjaBundle,
  getNinjaThumbUrl,
  resolveAssetFetchUrl,
  resolveStaticNinjaThumbUrl,
} from '../utils/remoteClient';

interface NinjaCatalogProps {
  ninjas: NinjaEntry[];
  selectedNinjaId: string | null;
  search: string;
  onSearchChange: (val: string) => void;
  kindFilter: 'character' | 'summon_skin' | 'effect' | 'all';
  onKindFilterChange: (kind: 'character' | 'summon_skin' | 'effect' | 'all') => void;
  sortBy: 'id' | 'name' | 'largest' | 'smallest';
  onSortByChange: (sort: 'id' | 'name' | 'largest' | 'smallest') => void;
  autoThumbnails: boolean;
  onAutoThumbnailsChange: (val: boolean) => void;
  page: number;
  onPageChange: (page: number) => void;
  onSelectNinja: (ninja: NinjaEntry) => void;
  onGoToExtractor: () => void;
  onOpenBatchZip: (list: NinjaEntry[]) => void;
}

const PAGE_SIZE = 36;

// Module-level thumbnail cache so switching tabs doesn't re-fetch thumbnails
const thumbnailCache = new Map<string, string>();
const inFlightRequests = new Map<string, Promise<string | null>>();

let activeThumbnailWorkers = 0;
const pendingQueue: Array<() => void> = [];

function runWithConcurrency<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      activeThumbnailWorkers++;
      try {
        const res = await task();
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        activeThumbnailWorkers--;
        const next = pendingQueue.shift();
        if (next) next();
      }
    };

    if (activeThumbnailWorkers < 2) {
      void execute();
    } else {
      pendingQueue.push(() => {
        void execute();
      });
    }
  });
}

function getSpineKind(ninja: NinjaEntry): 'character' | 'summon_skin' | 'effect' {
  if (ninja.kind) return ninja.kind;
  const lower = ninja.id.toLowerCase();
  if (lower.startsWith('vdfno_')) return 'character';
  if (
    lower.endsWith('_effect') ||
    lower.endsWith('_highteffect') ||
    lower.endsWith('_ground') ||
    lower.includes('huomiao')
  ) {
    return 'effect';
  }
  return 'summon_skin';
}

const KIND_LABELS: Record<'character' | 'summon_skin' | 'effect', string> = {
  character: 'Ninja',
  summon_skin: 'Invocação/Skin',
  effect: 'Efeito',
};

async function fetchNinjaThumbnail(ninja: NinjaEntry): Promise<string | null> {
  const cached = thumbnailCache.get(ninja.id);
  if (cached) return cached;

  const existing = inFlightRequests.get(ninja.id);
  if (existing) return existing;

  const promise = runWithConcurrency(async () => {
    try {
      const bundle = await fetchNinjaBundle(ninja.atlasUrl, ninja.skeletonUrl);
      const pages = parseAtlas(bundle.atlasText);
      const allRegions = pages.flatMap((p) => p.regions);
      if (allRegions.length === 0) return null;

      const largestRegion = allRegions.reduce(
        (best, r) => (r.width * r.height > best.width * best.height ? r : best),
        allRegions[0]
      );

      let targetRegionName = largestRegion.name;
      const anims = bundle.skeleton?.animations;
      if (anims) {
        const animOrder = ['idle', 'stand', 'animation', 'skill', 'attack', ...Object.keys(anims)];
        for (const animKey of animOrder) {
          const slots = anims[animKey]?.slots;
          if (!slots) continue;
          const slotOrder = [slots.L0, ...Object.values(slots)].filter(Boolean);
          let matched = false;
          for (const slotAnim of slotOrder) {
            const firstAttach = slotAnim?.attachment?.find((a) => typeof a.name === 'string');
            if (firstAttach?.name && allRegions.some((r) => r.name === firstAttach.name)) {
              targetRegionName = firstAttach.name;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
      }

      const targetRegion =
        allRegions.find((r) => r.name === targetRegionName) || largestRegion;
      const pageProxyUrl = bundle.pageUrls[targetRegion.pageName] || Object.values(bundle.pageUrls)[0];
      if (!pageProxyUrl) return null;

      const img = await loadImageElement(pageProxyUrl);
      const cropped = extractRegionToCanvas(targetRegion, img);

      const thumbCanvas = document.createElement('canvas');
      const maxDim = 144;
      const scale = Math.min(1, maxDim / Math.max(cropped.width, cropped.height));
      thumbCanvas.width = Math.max(1, Math.round(cropped.width * scale));
      thumbCanvas.height = Math.max(1, Math.round(cropped.height * scale));
      const ctx = thumbCanvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(cropped, 0, 0, thumbCanvas.width, thumbCanvas.height);
      const url = thumbCanvas.toDataURL('image/png');
      thumbnailCache.set(ninja.id, url);
      return url;
    } catch {
      return null;
    } finally {
      inFlightRequests.delete(ninja.id);
    }
  });

  inFlightRequests.set(ninja.id, promise);
  return promise;
}

function NinjaThumbCanvas({
  src,
  alt,
  onError,
}: {
  src: string;
  alt: string;
  onError: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = 160;
      const cssH = 128;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      const scale = Math.min(cssW / Math.max(1, img.width), cssH / Math.max(1, img.height));
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      const dx = (cssW - drawW) / 2;
      const dy = (cssH - drawH) / 2;
      ctx.drawImage(img, dx, dy, drawW, drawH);
    };
    img.onerror = () => {
      if (!cancelled) onErrorRef.current();
    };
    img.src = src;

    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <canvas
      ref={canvasRef}
      aria-label={alt}
      role="img"
      className="h-32 w-40 max-h-full max-w-full object-contain transition-transform duration-200 group-hover:scale-105"
    />
  );
}

function NinjaCard({
  ninja,
  isSelected,
  autoThumbnails,
  onSelect,
}: {
  ninja: NinjaEntry;
  isSelected: boolean;
  autoThumbnails: boolean;
  onSelect: () => void;
}) {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const directThumbUrl = autoThumbnails
    ? getNinjaThumbUrl(ninja.atlasUrl, ninja.skeletonUrl)
    : null;
  const [thumbUrl, setThumbUrl] = useState<string | null>(
    () => thumbnailCache.get(ninja.id) || directThumbUrl
  );
  const [loadingThumb, setLoadingThumb] = useState(false);
  const [nameArtFailed, setNameArtFailed] = useState(false);

  useEffect(() => {
    setNameArtFailed(false);
  }, [ninja.nameArtUrl]);

  useEffect(() => {
    const cached = thumbnailCache.get(ninja.id);
    if (cached) {
      setThumbUrl(cached);
      return;
    }
    if (!autoThumbnails) {
      setThumbUrl(null);
      return;
    }
    if (directThumbUrl) {
      setThumbUrl(directThumbUrl);
      return;
    }

    const el = cardRef.current;
    if (!el) return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          setLoadingThumb(true);
          void resolveStaticNinjaThumbUrl(ninja).then((staticUrl) => {
            if (cancelled) return;
            if (staticUrl) {
              thumbnailCache.set(ninja.id, staticUrl);
              setThumbUrl(staticUrl);
              setLoadingThumb(false);
              return;
            }
            void fetchNinjaThumbnail(ninja).then((url) => {
              if (!cancelled) {
                setThumbUrl(url);
                setLoadingThumb(false);
              }
            });
          });
        }
      },
      { rootMargin: '140px' }
    );

    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [ninja, autoThumbnails, directThumbUrl]);

  const kind = getSpineKind(ninja);
  const resolvedNameArt =
    ninja.nameArtUrl && !nameArtFailed ? resolveAssetFetchUrl(ninja.nameArtUrl) : null;
  const displayName = ninja.name || ninja.id;

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={onSelect}
      className={`group flex flex-col overflow-hidden rounded-lg border text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
        isSelected
          ? 'border-orange-500 bg-[#182232]'
          : 'border-slate-800/80 bg-[#131A26] hover:border-slate-600'
      }`}
    >
      <div
        className={`sprite-checkerboard relative flex h-40 sm:h-44 w-full items-center justify-center overflow-hidden border-b border-slate-800/80 px-2.5 pt-2.5 ${
          resolvedNameArt ? 'pb-11' : 'pb-2.5'
        }`}
      >
        {thumbUrl ? (
          <NinjaThumbCanvas
            src={thumbUrl}
            alt={`Sprite ${displayName}`}
            onError={() => {
              // If fast remote crop fails, fall back once to full-atlas canvas extraction
              if (!thumbUrl.startsWith('data:')) {
                void fetchNinjaThumbnail(ninja).then((fallbackUrl) => {
                  setThumbUrl(fallbackUrl);
                });
              } else {
                setThumbUrl(null);
              }
            }}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-slate-500">
            <ImageIcon className="h-6 w-6 opacity-60" aria-hidden="true" />
            <span className="font-mono text-[11px] tabular-nums">
              {loadingThumb ? 'Carregando...' : ninja.code}
            </span>
          </div>
        )}

        {resolvedNameArt && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center bg-gradient-to-t from-[#0B0F17]/80 via-[#0B0F17]/25 to-transparent px-1.5 pt-2 pb-1">
            <img
              src={resolvedNameArt}
              alt={displayName}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setNameArtFailed(true)}
              className="max-h-10 w-full object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.85)]"
            />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1 p-2.5 sm:p-3">
        <div className="flex items-start justify-between gap-1.5">
          <span
            className="line-clamp-1 font-display text-xs sm:text-sm font-semibold text-slate-100"
            title={displayName}
          >
            {displayName}
          </span>
          <Eye
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500 transition-colors group-hover:text-orange-400"
            aria-hidden="true"
          />
        </div>
        {ninja.name && (
          <div className="truncate font-mono text-[11px] text-orange-300/90" title={ninja.id}>
            {ninja.id}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[11px] sm:text-xs text-slate-400 font-mono tabular-nums truncate">
          <span>
            {ninja.width} × {ninja.height} px
          </span>
          <span aria-hidden="true">·</span>
          <span>{KIND_LABELS[kind]}</span>
        </div>
      </div>
    </button>
  );
}

export function NinjaCatalog({
  ninjas,
  selectedNinjaId,
  search,
  onSearchChange,
  kindFilter,
  onKindFilterChange,
  sortBy,
  onSortByChange,
  autoThumbnails,
  onAutoThumbnailsChange,
  page,
  onPageChange,
  onSelectNinja,
  onGoToExtractor,
  onOpenBatchZip,
}: NinjaCatalogProps) {
  const counts = useMemo(() => {
    let character = 0;
    let summon_skin = 0;
    let effect = 0;
    for (const n of ninjas) {
      const k = getSpineKind(n);
      if (k === 'character') character++;
      else if (k === 'summon_skin') summon_skin++;
      else effect++;
    }
    return { all: ninjas.length, character, summon_skin, effect };
  }, [ninjas]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = ninjas.filter((n) => {
      if (kindFilter !== 'all' && getSpineKind(n) !== kindFilter) return false;
      if (
        q &&
        !n.id.toLowerCase().includes(q) &&
        !n.code.toLowerCase().includes(q) &&
        !(n.name || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });

    if (sortBy === 'largest') {
      list.sort((a, b) => b.width * b.height - a.width * a.height);
    } else if (sortBy === 'smallest') {
      list.sort((a, b) => a.width * a.height - b.width * b.height);
    } else if (sortBy === 'name') {
      list.sort((a, b) =>
        (a.name || a.id).localeCompare(b.name || b.id, 'pt-BR', { numeric: true })
      );
    } else {
      list.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    }
    return list;
  }, [ninjas, kindFilter, search, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);

  if (ninjas.length === 0) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-slate-800 bg-[#131A26] p-6 sm:p-10 text-center">
        <h2 className="font-display text-lg font-semibold text-slate-100">
          Nenhum pacote Spine carregado
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Extraia uma URL de jogo (como https://naruto.jotagame.com/) para indexar personagens, invocações, skins e efeitos Spine.
        </p>
        <button
          type="button"
          onClick={onGoToExtractor}
          className="mt-6 inline-flex items-center rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 transition-colors cursor-pointer"
        >
          Ir para o Extrator URL
        </button>
      </div>
    );
  }

  return (
    <section className="space-y-4 sm:space-y-5">
      <div className="flex flex-col gap-3 sm:gap-4 border-b border-slate-800/80 pb-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-display text-lg sm:text-xl font-semibold text-slate-50">
              Catálogo Spine (Ninjas, Invocações e Efeitos)
            </h2>
            <p className="mt-0.5 text-xs text-slate-400 tabular-nums">
              {filtered.length} de {ninjas.length} pacotes Spine disponíveis · Clique para abrir no Estúdio, exportar GIF ou fatiar
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
            <div className="relative w-full min-w-0 sm:w-64">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Buscar nome ou ID (ex: Tsunade, Naruto, 100301)..."
                aria-label="Filtrar pacotes Spine por nome ou ID"
                className="w-full rounded-lg border border-slate-800 bg-[#131A26] py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
              />
            </div>

            <select
              value={sortBy}
              onChange={(e) =>
                onSortByChange(e.target.value as 'id' | 'name' | 'largest' | 'smallest')
              }
              aria-label="Ordenar pacotes"
              className="w-full sm:w-auto rounded-lg border border-slate-800 bg-[#131A26] px-3 py-2 text-xs sm:text-sm text-slate-200 focus:border-orange-500 focus:outline-none cursor-pointer"
            >
              <option value="id">Ordenar: ID</option>
              <option value="name">Ordenar: Nome (A–Z)</option>
              <option value="largest">Ordenar: Maior dimensão</option>
              <option value="smallest">Ordenar: Menor dimensão</option>
            </select>

            <label className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-[#131A26] px-3 py-2 text-xs font-medium text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoThumbnails}
                onChange={(e) => onAutoThumbnailsChange(e.target.checked)}
                className="h-3.5 w-3.5 accent-orange-500"
              />
              <span className="whitespace-nowrap">Miniaturas automáticas</span>
            </label>

            <button
              type="button"
              disabled={filtered.length === 0}
              onClick={() => onOpenBatchZip(filtered)}
              className="inline-flex flex-1 sm:flex-initial items-center justify-center gap-2 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Baixar Todos ({filtered.length}) ZIP</span>
            </button>
          </div>
        </div>

        <div className="flex w-full sm:w-fit items-center gap-1 overflow-x-auto rounded-lg border border-slate-800 bg-[#131A26] p-1">
          {(
            [
              { id: 'character', label: 'Ninjas', count: counts.character },
              { id: 'summon_skin', label: 'Invocações e Skins', count: counts.summon_skin },
              { id: 'effect', label: 'Efeitos e Auras', count: counts.effect },
              { id: 'all', label: 'Todos', count: counts.all },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onKindFilterChange(tab.id)}
              aria-pressed={kindFilter === tab.id}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                kindFilter === tab.id
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>
      </div>

      {pageItems.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-[#131A26] p-8 text-center text-sm text-slate-400">
          Nenhum pacote encontrado para "{search}".
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {pageItems.map((ninja) => (
            <NinjaCard
              key={ninja.id}
              ninja={ninja}
              isSelected={ninja.id === selectedNinjaId}
              autoThumbnails={autoThumbnails}
              onSelect={() => onSelectNinja(ninja)}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-4">
          <span className="text-xs text-slate-400 font-mono tabular-nums">
            Página {safePage} de {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => onPageChange(Math.max(1, safePage - 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#131A26] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-600 disabled:opacity-40 cursor-pointer"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Anterior</span>
            </button>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#131A26] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-600 disabled:opacity-40 cursor-pointer"
            >
              <span>Próxima</span>
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
