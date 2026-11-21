import type {
  AtlasPage,
  CompositeSpineLayer,
  NinjaEntry,
  SpineCommandEffectRef,
  SpineSkeleton,
} from '../types/sprite';
import {
  canvasToPngBlob,
  computeCompositeAnimationWorldBounds,
  downloadBlob,
  exportAnimationGif,
  exportAnimationStripPngBlob,
  extractRegionToCanvas,
  extractRegionToPngBlob,
  extractSpineEffectRefs,
  getAnimationDuration,
  getCompositeAnimationDuration,
  loadImageElement,
  parseAtlas,
  renderSpineFrameToCanvas,
} from './atlasParser';
import { fetchNinjaBundle } from './remoteClient';
import { assembleStreamingZipBlob, computeCrc32, type StreamingZipEntry } from './streamingZip';

export type EffectIncludeScope = 'powers' | 'all' | 'base';

export interface CompleteExportOptions {
  effectScope: EffectIncludeScope;
  includeOriginalAndFrames: boolean;
  includeLinkedEffects: boolean;
  includeAnimPngsAndSheets: boolean;
  includeAnimGifs: boolean;
  gifBg: 'transparent' | 'dark' | 'light' | 'chroma';
  fps?: number;
  folderPrefix?: string;
  signal?: AbortSignal;
  effectCache?: Map<string, Promise<ParsedEffectAsset | null>>;
  onProgress?: (info: {
    phase: 'base' | 'effects' | 'rendering' | 'zipping';
    message: string;
    percent: number;
  }) => void;
}

export interface BaseCharacterData {
  ninja: NinjaEntry;
  atlasText: string;
  skeleton: SpineSkeleton | null;
  pageUrls: Record<string, string>;
  pageImages: Record<string, HTMLImageElement>;
  regionCanvasMap: Map<string, HTMLCanvasElement>;
}

export interface CollectedCharacterFile {
  path: string;
  data: Blob | ArrayBuffer | Uint8Array | string;
}

export interface ParsedEffectAsset {
  spineId: string;
  atlasText: string;
  skeleton: SpineSkeleton;
  pages: AtlasPage[];
  pageUrls: Record<string, string>;
  pageImages: Record<string, HTMLImageElement>;
  regionCanvasMap: Map<string, HTMLCanvasElement>;
}

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

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Exportação cancelada.', 'AbortError');
  }
}

export function sanitizePathSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'anim';
}

export function getSortedAnimationNames(skeleton: SpineSkeleton | null | undefined): string[] {
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
}

export function filterEffectRefsByScope(
  refs: SpineCommandEffectRef[],
  scope: EffectIncludeScope
): SpineCommandEffectRef[] {
  if (scope === 'base') return [];
  if (scope === 'powers') return refs.filter((r) => r.isSelfOrScreen);
  return refs;
}

export function collectCharacterEffectPlan(
  skeleton: SpineSkeleton | null | undefined,
  scope: EffectIncludeScope
): {
  animNames: string[];
  refsByAnim: Map<string, SpineCommandEffectRef[]>;
  uniqueSpineIds: string[];
} {
  const animNames = getSortedAnimationNames(skeleton);
  const refsByAnim = new Map<string, SpineCommandEffectRef[]>();
  const uniqueIds = new Set<string>();

  if (!skeleton) {
    return { animNames, refsByAnim, uniqueSpineIds: [] };
  }

  for (const animName of animNames) {
    const allRefs = extractSpineEffectRefs(skeleton, animName);
    const filtered = filterEffectRefsByScope(allRefs, scope);
    refsByAnim.set(animName, filtered);
    for (const ref of filtered) {
      uniqueIds.add(ref.spineId);
    }
  }

  return {
    animNames,
    refsByAnim,
    uniqueSpineIds: Array.from(uniqueIds),
  };
}

export function buildCharacterInstructionsJson(
  ninjaId: string,
  skeleton: SpineSkeleton,
  scope: EffectIncludeScope,
  effectBundles?: Map<string, ParsedEffectAsset | null>,
  missingEffects?: string[]
): string {
  const animNames = getSortedAnimationNames(skeleton);
  const animations = animNames.map((animName) => {
    const baseDurationSec = Number(getAnimationDuration(skeleton, animName).toFixed(4));
    const allRefs = extractSpineEffectRefs(skeleton, animName);
    const filteredRefs = filterEffectRefsByScope(allRefs, scope);

    let compositeDurationSec = baseDurationSec;
    if (effectBundles) {
      const layers: CompositeSpineLayer[] = [];
      for (const ref of filteredRefs) {
        const eff = effectBundles.get(ref.spineId);
        if (!eff) continue;
        const effAnimName = eff.skeleton.animations?.[ref.animName]
          ? ref.animName
          : Object.keys(eff.skeleton.animations || {})[0];
        if (!effAnimName) continue;
        layers.push({
          spineId: ref.spineId,
          skeleton: eff.skeleton,
          animName: effAnimName,
          regionCanvasMap: eff.regionCanvasMap,
          startTime: ref.startTime,
          duration: getAnimationDuration(eff.skeleton, effAnimName),
          layer: ref.layer,
          loop: ref.loop,
        });
      }
      compositeDurationSec = Number(
        getCompositeAnimationDuration(baseDurationSec, layers).toFixed(4)
      );
    }

    return {
      name: animName,
      baseDurationSec,
      compositeDurationSec,
      effects: allRefs.map((ref) => ({
        spineId: ref.spineId,
        effectAnim: ref.animName,
        startTimeSec: Number(ref.startTime.toFixed(4)),
        layer: ref.layer,
        isSelfOrScreen: ref.isSelfOrScreen,
        includedInScope:
          scope === 'all' || (scope === 'powers' && ref.isSelfOrScreen),
        loop: ref.loop,
        rawCommand: ref.rawCommand,
      })),
    };
  });

  return JSON.stringify(
    {
      characterId: ninjaId,
      atlasFile: `${ninjaId}.atlas`,
      skeletonFile: `${ninjaId}.json`,
      effectScope: scope,
      notes:
        'As definicoes completas de ossos, slots, keyframes e eventos @CMD ficam no arquivo .json (skeleton). Este resumo lista todas as animacoes e os gatilhos de particulas em particulas/<spineId>/.',
      missingEffects: missingEffects && missingEffects.length > 0 ? missingEffects : undefined,
      animations,
    },
    null,
    2
  );
}

async function fetchRawPageOrFallbackBlob(
  proxyUrl: string,
  fallbackImg: HTMLImageElement | undefined,
  signal?: AbortSignal
): Promise<ArrayBuffer | Blob | null> {
  try {
    const resp = await fetch(proxyUrl, { signal: signal ?? AbortSignal.timeout(20_000) });
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > 0) return buf;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
  }

  if (fallbackImg && fallbackImg.naturalWidth > 0 && fallbackImg.naturalHeight > 0) {
    const canvas = document.createElement('canvas');
    canvas.width = fallbackImg.naturalWidth;
    canvas.height = fallbackImg.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(fallbackImg, 0, 0);
      return await canvasToPngBlob(canvas);
    }
  }
  return null;
}

export async function fetchParsedEffectAsset(
  baseAtlasUrl: string,
  spineId: string,
  signal?: AbortSignal,
  cache?: Map<string, Promise<ParsedEffectAsset | null>>
): Promise<ParsedEffectAsset | null> {
  throwIfAborted(signal);
  let atlasUrl: string;
  let skeletonUrl: string;
  try {
    atlasUrl = new URL(`${spineId}.atlas`, baseAtlasUrl).toString();
    skeletonUrl = new URL(`${spineId}.json`, baseAtlasUrl).toString();
  } catch {
    return null;
  }

  const existing = cache?.get(atlasUrl);
  if (existing) return existing;

  const task = (async (): Promise<ParsedEffectAsset | null> => {
    try {
      const data = await fetchNinjaBundle(atlasUrl, skeletonUrl);
      if (!data.skeleton) return null;
      throwIfAborted(signal);

      const pages = parseAtlas(data.atlasText);
      const pageImages: Record<string, HTMLImageElement> = {};
      await Promise.all(
        Object.entries(data.pageUrls).map(async ([pageName, proxyUrl]) => {
          pageImages[pageName] = await loadImageElement(proxyUrl);
        })
      );
      throwIfAborted(signal);

      const regionCanvasMap = new Map<string, HTMLCanvasElement>();
      for (const page of pages) {
        const img = pageImages[page.name];
        if (!img) continue;
        for (const reg of page.regions) {
          regionCanvasMap.set(reg.name, extractRegionToCanvas(reg, img));
        }
      }

      return {
        spineId,
        atlasText: data.atlasText,
        skeleton: data.skeleton,
        pages,
        pageUrls: data.pageUrls,
        pageImages,
        regionCanvasMap,
      };
    } catch (err) {
      cache?.delete(atlasUrl);
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return null;
    }
  })();

  if (cache) {
    if (cache.size >= 36) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }
    cache.set(atlasUrl, task);
  }

  return task;
}

function getGifBgColor(gifBg: CompleteExportOptions['gifBg']): string | null {
  if (gifBg === 'dark') return '#090D14';
  if (gifBg === 'light') return '#F8FAFC';
  if (gifBg === 'chroma') return '#00B140';
  return null;
}

export async function collectCharacterCompleteFiles(
  baseData: BaseCharacterData,
  options: CompleteExportOptions
): Promise<CollectedCharacterFile[]> {
  throwIfAborted(options.signal);

  const prefix = options.folderPrefix ? `${options.folderPrefix.replace(/\/+$/, '')}/` : '';
  const files: CollectedCharacterFile[] = [];
  const usedPaths = new Set<string>();

  const pushFile = (relPath: string, data: Blob | ArrayBuffer | Uint8Array | string) => {
    const cleanRel = relPath.replace(/^\/+/, '');
    const fullPath = `${prefix}${cleanRel}`;
    if (usedPaths.has(fullPath)) return;
    usedPaths.add(fullPath);
    files.push({ path: fullPath, data });
  };

  const basePages = parseAtlas(baseData.atlasText);

  // 1. Original character package + sliced PNG frames
  if (options.includeOriginalAndFrames) {
    options.onProgress?.({
      phase: 'base',
      message: `Fatiando frames base de ${baseData.ninja.id}...`,
      percent: 5,
    });

    pushFile(`${baseData.ninja.id}.atlas`, baseData.atlasText);
    if (baseData.skeleton) {
      pushFile(`${baseData.ninja.id}.json`, JSON.stringify(baseData.skeleton, null, 2));
    }

    for (const [pageName, proxyUrl] of Object.entries(baseData.pageUrls)) {
      throwIfAborted(options.signal);
      const sheetData = await fetchRawPageOrFallbackBlob(
        proxyUrl,
        baseData.pageImages[pageName],
        options.signal
      );
      if (sheetData) {
        pushFile(pageName, sheetData);
      }
    }

    for (const page of basePages) {
      const img = baseData.pageImages[page.name];
      if (!img) continue;
      const slicedBlobs = await Promise.all(
        page.regions.map(async (region) => {
          const frameName = region.index >= 0 ? `${region.name}_${region.index}` : region.name;
          const blob = await extractRegionToPngBlob(region, img);
          return blob ? { path: `frames/${sanitizePathSegment(frameName)}.png`, blob } : null;
        })
      );
      for (const item of slicedBlobs) {
        if (item) pushFile(item.path, item.blob);
      }
    }
  }

  const plan = collectCharacterEffectPlan(baseData.skeleton, options.effectScope);
  const needsEffects =
    Boolean(baseData.skeleton) &&
    options.effectScope !== 'base' &&
    (options.includeLinkedEffects ||
      options.includeAnimPngsAndSheets ||
      options.includeAnimGifs);

  // 2. Fetch linked particle bundles (noe_*)
  const effectBundles = new Map<string, ParsedEffectAsset | null>();
  const missingEffects: string[] = [];

  if (needsEffects && plan.uniqueSpineIds.length > 0) {
    for (let i = 0; i < plan.uniqueSpineIds.length; i++) {
      throwIfAborted(options.signal);
      const spineId = plan.uniqueSpineIds[i];
      const pct = 10 + Math.round(((i + 1) / plan.uniqueSpineIds.length) * 18);
      options.onProgress?.({
        phase: 'effects',
        message: `Baixando partículas (${i + 1}/${plan.uniqueSpineIds.length}): ${spineId}...`,
        percent: pct,
      });

      const parsed = await fetchParsedEffectAsset(
        baseData.ninja.atlasUrl,
        spineId,
        options.signal,
        options.effectCache
      );
      effectBundles.set(spineId, parsed);
      if (!parsed) {
        missingEffects.push(spineId);
      }
    }
  }

  // 3. Export animation instructions JSON + linked effect bundles into particulas/
  if (
    baseData.skeleton &&
    (options.includeLinkedEffects ||
      options.includeAnimPngsAndSheets ||
      options.includeAnimGifs)
  ) {
    pushFile(
      'animacoes_instrucoes.json',
      buildCharacterInstructionsJson(
        baseData.ninja.id,
        baseData.skeleton,
        options.effectScope,
        effectBundles,
        missingEffects
      )
    );
  }

  if (options.includeLinkedEffects && options.effectScope !== 'base') {
    for (const [spineId, eff] of effectBundles.entries()) {
      if (!eff) continue;
      throwIfAborted(options.signal);
      const effDir = `particulas/${sanitizePathSegment(spineId)}`;
      pushFile(`${effDir}/${spineId}.atlas`, eff.atlasText);
      pushFile(`${effDir}/${spineId}.json`, JSON.stringify(eff.skeleton, null, 2));

      for (const [pageName, proxyUrl] of Object.entries(eff.pageUrls)) {
        throwIfAborted(options.signal);
        const sheetData = await fetchRawPageOrFallbackBlob(
          proxyUrl,
          eff.pageImages[pageName],
          options.signal
        );
        if (sheetData) {
          pushFile(`${effDir}/${pageName}`, sheetData);
        }
      }

      for (const page of eff.pages) {
        const img = eff.pageImages[page.name];
        if (!img) continue;
        const blobs = await Promise.all(
          page.regions.map(async (region) => {
            const frameName = region.index >= 0 ? `${region.name}_${region.index}` : region.name;
            const blob = await extractRegionToPngBlob(region, img);
            return blob
              ? { path: `${effDir}/frames/${sanitizePathSegment(frameName)}.png`, blob }
              : null;
          })
        );
        for (const item of blobs) {
          if (item) pushFile(item.path, item.blob);
        }
      }
    }
  }

  // 4. Render all animations composited with their particles (PNG sequence, Spritesheet, GIF)
  if (
    baseData.skeleton &&
    plan.animNames.length > 0 &&
    (options.includeAnimPngsAndSheets || options.includeAnimGifs)
  ) {
    const fps = options.fps ?? 18;
    const bgColor = getGifBgColor(options.gifBg);
    const frameCanvas = document.createElement('canvas');

    for (let aIdx = 0; aIdx < plan.animNames.length; aIdx++) {
      throwIfAborted(options.signal);
      const animName = plan.animNames[aIdx];
      const safeAnim = sanitizePathSegment(animName);
      const animDir = `animacoes/${safeAnim}`;
      const refs = plan.refsByAnim.get(animName) || [];

      const layers: CompositeSpineLayer[] = [];
      for (const ref of refs) {
        const eff = effectBundles.get(ref.spineId);
        if (!eff) continue;
        const effAnimName = eff.skeleton.animations?.[ref.animName]
          ? ref.animName
          : Object.keys(eff.skeleton.animations || {})[0];
        if (!effAnimName) continue;
        layers.push({
          spineId: ref.spineId,
          skeleton: eff.skeleton,
          animName: effAnimName,
          regionCanvasMap: eff.regionCanvasMap,
          startTime: ref.startTime,
          duration: getAnimationDuration(eff.skeleton, effAnimName),
          layer: ref.layer,
          loop: ref.loop,
        });
      }

      const baseDuration = getAnimationDuration(baseData.skeleton, animName);
      const totalDuration = getCompositeAnimationDuration(baseDuration, layers);
      const bounds = computeCompositeAnimationWorldBounds(
        baseData.skeleton,
        animName,
        baseData.regionCanvasMap,
        layers,
        24
      );

      const basePct = 30 + Math.round((aIdx / plan.animNames.length) * 58);
      options.onProgress?.({
        phase: 'rendering',
        message: `Renderizando animação "${animName}" (${aIdx + 1}/${plan.animNames.length})...`,
        percent: basePct,
      });

      if (options.includeAnimPngsAndSheets) {
        const frameCount =
          totalDuration <= 0 ? 1 : Math.max(1, Math.min(72, Math.round(totalDuration * fps)));
        const cellW = Math.max(160, Math.min(640, Math.ceil(bounds.width * 1.16)));
        const cellH = Math.max(160, Math.min(640, Math.ceil(bounds.height * 1.16)));
        frameCanvas.width = cellW;
        frameCanvas.height = cellH;
        const ctx = frameCanvas.getContext('2d');

        if (ctx) {
          for (let f = 0; f < frameCount; f++) {
            throwIfAborted(options.signal);
            const t = frameCount === 1 ? 0 : (f / frameCount) * totalDuration;
            renderSpineFrameToCanvas(
              ctx,
              cellW,
              cellH,
              baseData.skeleton,
              animName,
              t,
              baseData.regionCanvasMap,
              1,
              0,
              0,
              bounds,
              layers
            );
            const pngBlob = await canvasToPngBlob(frameCanvas);
            if (pngBlob) {
              pushFile(
                `${animDir}/frames/${safeAnim}_${String(f).padStart(3, '0')}.png`,
                pngBlob
              );
            }
            if (f % 6 === 5) {
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }

        const strip = await exportAnimationStripPngBlob(
          baseData.skeleton,
          animName,
          baseData.regionCanvasMap,
          16,
          layers,
          bounds
        );
        if (strip.blob) {
          pushFile(`${animDir}/${safeAnim}_spritesheet.png`, strip.blob);
        }
      }

      if (options.includeAnimGifs) {
        throwIfAborted(options.signal);
        const gifRes = await exportAnimationGif(
          baseData.skeleton,
          animName,
          baseData.regionCanvasMap,
          {
            fps,
            bounds,
            backgroundColor: bgColor,
            compositeLayers: layers,
          }
        );
        pushFile(`${animDir}/${safeAnim}.gif`, gifRes.blob);
      }

      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return files;
}

export async function exportCompleteCharacterZip(
  baseData: BaseCharacterData,
  options: CompleteExportOptions
): Promise<{ fileCount: number; zipFilename: string }> {
  const folderName = sanitizePathSegment(baseData.ninja.id);
  const collected = await collectCharacterCompleteFiles(baseData, {
    ...options,
    folderPrefix: options.folderPrefix ?? folderName,
  });

  throwIfAborted(options.signal);
  options.onProgress?.({
    phase: 'zipping',
    message: `Empacotando ${collected.length} arquivos no ZIP...`,
    percent: 90,
  });

  const textEncoder = new TextEncoder();
  const entries: StreamingZipEntry[] = [];

  for (let i = 0; i < collected.length; i++) {
    throwIfAborted(options.signal);
    const item = collected[i];
    let bytes: Uint8Array;
    let blob: Blob;

    if (typeof item.data === 'string') {
      bytes = textEncoder.encode(item.data);
      blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
        type: 'text/plain;charset=utf-8',
      });
    } else if (item.data instanceof Blob) {
      const ab = await item.data.arrayBuffer();
      bytes = new Uint8Array(ab);
      blob = item.data;
    } else if (item.data instanceof Uint8Array) {
      bytes = item.data;
      blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
    } else {
      bytes = new Uint8Array(item.data);
      blob = new Blob([item.data]);
    }

    entries.push({
      path: item.path,
      size: bytes.byteLength,
      crc32: computeCrc32(bytes),
      blob,
    });
  }

  const zipBlob = await assembleStreamingZipBlob(
    async function* (): AsyncGenerator<StreamingZipEntry[]> {
      for (let i = 0; i < entries.length; i += 24) {
        yield entries.slice(i, i + 24);
      }
    },
    entries.length,
    (pct) => {
      options.onProgress?.({
        phase: 'zipping',
        message: `Montando arquivo ZIP (${pct}%)...`,
        percent: 90 + Math.round(pct * 0.1),
      });
    }
  );

  const zipFilename = `${folderName}_completo.zip`;
  downloadBlob(zipBlob, zipFilename);
  return { fileCount: entries.length, zipFilename };
}
