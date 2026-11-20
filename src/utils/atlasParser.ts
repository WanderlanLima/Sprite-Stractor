import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import type {
  AtlasPage,
  AtlasRegion,
  SlicedFrame,
  SpineAnimationData,
  SpineAttachmentInfo,
  SpineBoneDef,
  SpineSkeleton,
} from '../types/sprite';
import { createZipWorkerSession } from './zipWorkerClient';

export function parseAtlas(atlasText: string): AtlasPage[] {
  const lines = atlasText.split(/\r?\n/);
  const pages: AtlasPage[] = [];
  let currentPage: AtlasPage | null = null;
  let currentRegion: AtlasRegion | null = null;

  const parsePair = (val: string): [number, number] => {
    const parts = val.split(',').map((s) => Number(s.trim()));
    return [parts[0] || 0, parts[1] || 0];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (currentRegion && currentPage) {
        currentPage.regions.push(currentRegion);
        currentRegion = null;
      }
      currentPage = null;
      continue;
    }

    const isIndented = /^\s+/.test(rawLine);
    const colonIdx = trimmed.indexOf(':');

    if (!currentPage) {
      currentPage = {
        name: trimmed,
        width: 0,
        height: 0,
        regions: [],
      };
      pages.push(currentPage);
      continue;
    }

    if (!isIndented && colonIdx !== -1 && !currentRegion) {
      // Page header property
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (key === 'size') {
        const [w, h] = parsePair(val);
        currentPage.width = w;
        currentPage.height = h;
      } else if (key === 'format') {
        currentPage.format = val;
      } else if (key === 'filter') {
        currentPage.filter = val;
      } else if (key === 'repeat') {
        currentPage.repeat = val;
      }
      continue;
    }

    if (!isIndented && colonIdx === -1) {
      // Could be a new region name OR a new page name without blank line
      if (/\.(png|webp|jpe?g|gif|ktx2?)$/i.test(trimmed)) {
        if (currentRegion) {
          currentPage.regions.push(currentRegion);
          currentRegion = null;
        }
        currentPage = {
          name: trimmed,
          width: 0,
          height: 0,
          regions: [],
        };
        pages.push(currentPage);
      } else {
        if (currentRegion) {
          currentPage.regions.push(currentRegion);
        }
        currentRegion = {
          name: trimmed,
          pageName: currentPage.name,
          rotate: 0,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          origWidth: 0,
          origHeight: 0,
          offsetX: 0,
          offsetY: 0,
          index: -1,
        };
      }
      continue;
    }

    if (currentRegion && colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (key === 'rotate') {
        if (val === 'true') currentRegion.rotate = 90;
        else if (val === 'false') currentRegion.rotate = 0;
        else currentRegion.rotate = Number(val) || 0;
      } else if (key === 'xy') {
        const [x, y] = parsePair(val);
        currentRegion.x = x;
        currentRegion.y = y;
      } else if (key === 'size') {
        const [w, h] = parsePair(val);
        currentRegion.width = w;
        currentRegion.height = h;
      } else if (key === 'orig') {
        const [ow, oh] = parsePair(val);
        currentRegion.origWidth = ow;
        currentRegion.origHeight = oh;
      } else if (key === 'offset') {
        const [ox, oy] = parsePair(val);
        currentRegion.offsetX = ox;
        currentRegion.offsetY = oy;
      } else if (key === 'index') {
        currentRegion.index = Number(val);
      }
    }
  }

  if (currentRegion && currentPage) {
    currentPage.regions.push(currentRegion);
  }

  return pages;
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Falha ao carregar imagem: ${src}`));
    img.src = src;
  });
}

export function extractRegionToCanvas(
  region: AtlasRegion,
  pageImage: HTMLImageElement
): HTMLCanvasElement {
  const outW = Math.max(1, region.origWidth || region.width);
  const outH = Math.max(1, region.origHeight || region.height);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const isRotated90 = region.rotate === 90;
  const srcW = isRotated90 ? region.height : region.width;
  const srcH = isRotated90 ? region.width : region.height;

  const destX = region.offsetX || 0;
  const destY = Math.max(0, outH - (region.offsetY || 0) - region.height);

  ctx.save();
  if (isRotated90) {
    ctx.translate(destX, destY + region.height);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(
      pageImage,
      region.x,
      region.y,
      srcW,
      srcH,
      0,
      0,
      srcW,
      srcH
    );
  } else {
    ctx.drawImage(
      pageImage,
      region.x,
      region.y,
      srcW,
      srcH,
      destX,
      destY,
      region.width,
      region.height
    );
  }
  ctx.restore();
  return canvas;
}

export function sliceAtlasRegions(
  pages: AtlasPage[],
  pageImages: Record<string, HTMLImageElement>
): SlicedFrame[] {
  const frames: SlicedFrame[] = [];
  for (const page of pages) {
    const img = pageImages[page.name];
    if (!img) continue;
    for (let i = 0; i < page.regions.length; i++) {
      const region = page.regions[i];
      const canvas = extractRegionToCanvas(region, img);
      frames.push({
        id: `${page.name}::${region.name}::${region.index}::${i}`,
        name: region.index >= 0 ? `${region.name}_${region.index}` : region.name,
        width: canvas.width,
        height: canvas.height,
        sourceX: region.x,
        sourceY: region.y,
        sourceWidth: region.width,
        sourceHeight: region.height,
        rotate: region.rotate,
        dataUrl: canvas.toDataURL('image/png'),
      });
    }
  }
  // Sort natural order (a0, a1, a2, ..., a10)
  return frames.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function getDefaultSkinAttachments(
  skeleton: SpineSkeleton
): Record<string, Record<string, SpineAttachmentInfo>> {
  if (!skeleton.skins) return {};
  if (Array.isArray(skeleton.skins)) {
    const def = skeleton.skins.find((s) => s.name === 'default') || skeleton.skins[0];
    return def?.attachments || {};
  }
  return skeleton.skins.default || Object.values(skeleton.skins)[0] || {};
}

export function getAnimationDuration(skeleton: SpineSkeleton, animName: string): number {
  const anim = skeleton.animations?.[animName];
  if (!anim) return 0;
  let maxTime = 0;

  if (anim.slots) {
    for (const slotAnim of Object.values(anim.slots)) {
      for (const kf of slotAnim.attachment || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
      for (const kf of slotAnim.color || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
    }
  }

  if (anim.bones) {
    for (const boneAnim of Object.values(anim.bones)) {
      for (const kf of boneAnim.rotate || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
      for (const kf of boneAnim.translate || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
      for (const kf of boneAnim.scale || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
    }
  }

  for (const ev of anim.events || []) {
    if ((ev.time || 0) > maxTime) maxTime = ev.time || 0;
  }

  // Add 1 frame hold so last keyframe is visible
  return maxTime > 0 ? maxTime + 1 / 24 : 0.5;
}

function sampleLinear(
  frames: Array<{ time?: number; [key: string]: unknown }> | undefined,
  t: number,
  field: string,
  defaultVal: number
): number {
  if (!frames || frames.length === 0) return defaultVal;
  const firstTime = frames[0].time || 0;
  if (t <= firstTime) {
    const v = frames[0][field];
    return typeof v === 'number' ? v : defaultVal;
  }
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    const ta = a.time || 0;
    const tb = b.time || 0;
    if (t >= ta && t <= tb) {
      const va = typeof a[field] === 'number' ? (a[field] as number) : defaultVal;
      const vb = typeof b[field] === 'number' ? (b[field] as number) : defaultVal;
      if (a.curve === 'stepped' || tb === ta) return va;
      const alpha = (t - ta) / (tb - ta);
      return va + (vb - va) * alpha;
    }
  }
  const last = frames[frames.length - 1];
  const v = last[field];
  return typeof v === 'number' ? v : defaultVal;
}

function sampleAngle(
  frames: Array<{ time?: number; angle?: number; curve?: unknown }> | undefined,
  t: number
): number {
  if (!frames || frames.length === 0) return 0;
  const firstTime = frames[0].time || 0;
  if (t <= firstTime) return frames[0].angle || 0;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    const ta = a.time || 0;
    const tb = b.time || 0;
    if (t >= ta && t <= tb) {
      const va = a.angle || 0;
      const vb = b.angle || 0;
      if (a.curve === 'stepped' || tb === ta) return va;
      let diff = vb - va;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      const alpha = (t - ta) / (tb - ta);
      return va + diff * alpha;
    }
  }
  return frames[frames.length - 1].angle || 0;
}

interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

function mulMat(p: Mat2D, c: Mat2D): Mat2D {
  return {
    a: p.a * c.a + p.c * c.b,
    b: p.b * c.a + p.d * c.b,
    c: p.a * c.c + p.c * c.d,
    d: p.b * c.c + p.d * c.d,
    tx: p.a * c.tx + p.c * c.ty + p.tx,
    ty: p.b * c.tx + p.d * c.ty + p.ty,
  };
}

function makeLocalMat(
  x: number,
  y: number,
  rotDeg: number,
  sx: number,
  sy: number
): Mat2D {
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    a: cos * sx,
    b: sin * sx,
    c: -sin * sy,
    d: cos * sy,
    tx: x,
    ty: y,
  };
}

export interface AnimationWorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

function buildBoneMap(skeleton: SpineSkeleton): Map<string, SpineBoneDef> {
  const boneMap = new Map<string, SpineBoneDef>();
  for (const b of skeleton.bones || []) boneMap.set(b.name, b);
  return boneMap;
}

function resolveSlotAttachmentAtTime(
  slotName: string,
  defaultAttachment: string | undefined,
  anim: SpineAnimationData | undefined,
  time: number
): string | null | undefined {
  let attachmentName: string | null | undefined = defaultAttachment;
  const slotTimeline = anim?.slots?.[slotName]?.attachment;
  if (slotTimeline && slotTimeline.length > 0) {
    for (let i = 0; i < slotTimeline.length; i++) {
      if ((slotTimeline[i].time || 0) <= time + 1e-5) {
        attachmentName = slotTimeline[i].name ?? null;
      } else {
        break;
      }
    }
  }
  return attachmentName;
}

function createWorldMatrixResolver(
  boneMap: Map<string, SpineBoneDef>,
  anim: SpineAnimationData | undefined,
  time: number
) {
  const worldMatrices = new Map<string, Mat2D>();
  const getWorldMatrix = (boneName: string): Mat2D => {
    const cached = worldMatrices.get(boneName);
    if (cached) return cached;
    const def = boneMap.get(boneName);
    if (!def) {
      const idMat: Mat2D = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      worldMatrices.set(boneName, idMat);
      return idMat;
    }

    const boneAnim = anim?.bones?.[boneName];
    const lx = (def.x || 0) + sampleLinear(boneAnim?.translate, time, 'x', 0);
    const ly = (def.y || 0) + sampleLinear(boneAnim?.translate, time, 'y', 0);
    const lrot = (def.rotation || 0) + sampleAngle(boneAnim?.rotate, time);
    const lsx = (def.scaleX ?? 1) * sampleLinear(boneAnim?.scale, time, 'x', 1);
    const lsy = (def.scaleY ?? 1) * sampleLinear(boneAnim?.scale, time, 'y', 1);

    const local = makeLocalMat(lx, ly, lrot, lsx, lsy);
    const world = def.parent ? mulMat(getWorldMatrix(def.parent), local) : local;
    worldMatrices.set(boneName, world);
    return world;
  };
  return getWorldMatrix;
}

function collectSampleTimes(
  anim: SpineAnimationData | undefined,
  duration: number,
  samples: number
): number[] {
  const times = new Set<number>();
  const stepCount = Math.max(2, samples);
  for (let s = 0; s < stepCount; s++) {
    times.add(stepCount === 1 ? 0 : (s / (stepCount - 1)) * duration);
  }
  if (anim?.slots) {
    for (const slotAnim of Object.values(anim.slots)) {
      for (const kf of slotAnim.attachment || []) {
        if (typeof kf.time === 'number') times.add(kf.time);
      }
    }
  }
  if (anim?.bones) {
    for (const boneAnim of Object.values(anim.bones)) {
      for (const kf of boneAnim.translate || []) {
        if (typeof kf.time === 'number') times.add(kf.time);
      }
      for (const kf of boneAnim.rotate || []) {
        if (typeof kf.time === 'number') times.add(kf.time);
      }
      for (const kf of boneAnim.scale || []) {
        if (typeof kf.time === 'number') times.add(kf.time);
      }
    }
  }
  return Array.from(times).sort((a, b) => a - b);
}

export function computeAnimationWorldBounds(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  samples = 24
): AnimationWorldBounds {
  const anim = skeleton.animations?.[animName];
  const slotsDef = skeleton.slots || [];
  const skinAttachments = getDefaultSkinAttachments(skeleton);
  const boneMap = buildBoneMap(skeleton);
  const duration = getAnimationDuration(skeleton, animName);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const sampleTimes = collectSampleTimes(anim, duration, samples);
  for (const t of sampleTimes) {
    const getWorldMatrix = createWorldMatrixResolver(boneMap, anim, t);

    for (const slot of slotsDef) {
      const attachmentName = resolveSlotAttachmentAtTime(slot.name, slot.attachment, anim, t);
      if (!attachmentName) continue;

      const attInfo = skinAttachments[slot.name]?.[attachmentName];
      const regionKey = attInfo?.path || attInfo?.name || attachmentName;
      const spriteCanvas = regionCanvasMap.get(regionKey);
      if (!spriteCanvas) continue;

      const wm = getWorldMatrix(slot.bone);
      const localMat = makeLocalMat(
        attInfo?.x || 0,
        attInfo?.y || 0,
        attInfo?.rotation || 0,
        attInfo?.scaleX ?? 1,
        attInfo?.scaleY ?? 1
      );
      const finalMat = mulMat(wm, localMat);

      const hw = (attInfo?.width || spriteCanvas.width) / 2;
      const hh = (attInfo?.height || spriteCanvas.height) / 2;

      const corners: Array<[number, number]> = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ];
      for (const [cx, cy] of corners) {
        const wx = finalMat.a * cx + finalMat.c * cy + finalMat.tx;
        const wy = finalMat.b * cx + finalMat.d * cy + finalMat.ty;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    const skelW = Math.max(80, skeleton.skeleton?.width || 160);
    const skelH = Math.max(80, skeleton.skeleton?.height || 160);
    return {
      minX: -skelW / 2,
      maxX: skelW / 2,
      minY: 0,
      maxY: skelH,
      width: skelW,
      height: skelH,
      centerX: 0,
      centerY: skelH / 2,
    };
  }

  const width = Math.max(16, maxX - minX);
  const height = Math.max(16, maxY - minY);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

export function renderSpineFrameToCanvas(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  skeleton: SpineSkeleton,
  animName: string,
  time: number,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  zoom = 1,
  panX = 0,
  panY = 0,
  autoFitBounds?: AnimationWorldBounds | null
): number {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const anim = skeleton.animations?.[animName];
  const slotsDef = skeleton.slots || [];
  const skinAttachments = getDefaultSkinAttachments(skeleton);
  const boneMap = buildBoneMap(skeleton);
  const getWorldMatrix = createWorldMatrixResolver(boneMap, anim, time);

  let effectiveScale: number;
  let anchorX: number;
  let anchorY: number;

  if (autoFitBounds) {
    const fitScale = Math.min(
      (canvasWidth * 0.86) / autoFitBounds.width,
      (canvasHeight * 0.86) / autoFitBounds.height
    );
    const baseScale = Math.min(4.0, Math.max(0.08, fitScale));
    effectiveScale = baseScale * zoom;
    anchorX = canvasWidth / 2 - autoFitBounds.centerX * effectiveScale + panX;
    anchorY = canvasHeight / 2 + autoFitBounds.centerY * effectiveScale + panY;
  } else {
    const skelBounds = skeleton.skeleton || {};
    const skelW = Math.max(80, skelBounds.width || 160);
    const skelH = Math.max(80, skelBounds.height || 160);
    const baseScale = Math.min((canvasWidth * 0.72) / skelW, (canvasHeight * 0.72) / skelH);
    effectiveScale = Math.min(3.5, Math.max(0.15, baseScale)) * zoom;
    anchorX = canvasWidth / 2 + panX;
    anchorY = canvasHeight * 0.76 + panY;
  }

  let drawnSlots = 0;

  ctx.save();
  // Spine Y-up coordinate space anchored near bottom-center
  ctx.translate(anchorX, anchorY);
  ctx.scale(effectiveScale, -effectiveScale);

  for (const slot of slotsDef) {
    let attachmentName: string | null | undefined = slot.attachment;
    const slotTimeline = anim?.slots?.[slot.name]?.attachment;
    if (slotTimeline && slotTimeline.length > 0) {
      for (let i = 0; i < slotTimeline.length; i++) {
        if ((slotTimeline[i].time || 0) <= time + 1e-5) {
          attachmentName = slotTimeline[i].name ?? null;
        } else {
          break;
        }
      }
    }

    if (!attachmentName) continue;

    const attInfo = skinAttachments[slot.name]?.[attachmentName];
    const regionKey = attInfo?.path || attInfo?.name || attachmentName;
    const spriteCanvas = regionCanvasMap.get(regionKey);
    if (!spriteCanvas) continue;

    const wm = getWorldMatrix(slot.bone);
    ctx.save();
    ctx.transform(wm.a, wm.b, wm.c, wm.d, wm.tx, wm.ty);

    if (slot.blend === 'additive') {
      ctx.globalCompositeOperation = 'lighter';
    }

    const ax = attInfo?.x || 0;
    const ay = attInfo?.y || 0;
    const arot = ((attInfo?.rotation || 0) * Math.PI) / 180;
    const asx = attInfo?.scaleX ?? 1;
    const asy = attInfo?.scaleY ?? 1;
    const aw = attInfo?.width || spriteCanvas.width;
    const ah = attInfo?.height || spriteCanvas.height;

    ctx.translate(ax, ay);
    if (arot !== 0) ctx.rotate(arot);
    // Negate Y scale to draw upright canvas image inside Spine Y-up space
    ctx.scale(asx, -asy);
    ctx.drawImage(spriteCanvas, -aw / 2, -ah / 2, aw, ah);

    ctx.restore();
    drawnSlots++;
  }

  ctx.restore();
  return drawnSlots;
}

export function sliceImageByGrid(
  img: HTMLImageElement,
  cols: number,
  rows: number,
  margin = 0,
  spacing = 0
): SlicedFrame[] {
  const safeCols = Math.max(1, Math.floor(cols));
  const safeRows = Math.max(1, Math.floor(rows));
  const usableW = img.width - margin * 2 - spacing * (safeCols - 1);
  const usableH = img.height - margin * 2 - spacing * (safeRows - 1);
  const cellW = Math.floor(usableW / safeCols);
  const cellH = Math.floor(usableH / safeRows);
  if (cellW <= 0 || cellH <= 0) return [];

  const frames: SlicedFrame[] = [];
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = cellW;
  tempCanvas.height = cellH;
  const ctx = tempCanvas.getContext('2d');
  if (!ctx) return [];

  let index = 0;
  for (let r = 0; r < safeRows; r++) {
    for (let c = 0; c < safeCols; c++) {
      const sx = margin + c * (cellW + spacing);
      const sy = margin + r * (cellH + spacing);
      ctx.clearRect(0, 0, cellW, cellH);
      ctx.drawImage(img, sx, sy, cellW, cellH, 0, 0, cellW, cellH);

      // Skip completely empty transparent cells
      const data = ctx.getImageData(0, 0, cellW, cellH).data;
      let hasPixels = false;
      for (let p = 3; p < data.length; p += 4) {
        if (data[p] > 4) {
          hasPixels = true;
          break;
        }
      }
      if (!hasPixels) continue;

      frames.push({
        id: `grid_${r}_${c}`,
        name: `sprite_${String(index).padStart(3, '0')}`,
        width: cellW,
        height: cellH,
        sourceX: sx,
        sourceY: sy,
        sourceWidth: cellW,
        sourceHeight: cellH,
        rotate: 0,
        dataUrl: tempCanvas.toDataURL('image/png'),
      });
      index++;
    }
  }

  return frames;
}

export function sliceImageByAutoBBox(
  img: HTMLImageElement,
  alphaThreshold = 12,
  minSize = 8,
  mergeGap = 2
): SlicedFrame[] {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = img.width;
  srcCanvas.height = img.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) return [];
  srcCtx.drawImage(img, 0, 0);

  const w = img.width;
  const h = img.height;
  const imgData = srcCtx.getImageData(0, 0, w, h).data;
  const visited = new Uint8Array(w * h);

  interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  const boxes: Box[] = [];
  const queue = new Int32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (visited[idx]) continue;
      if (imgData[idx * 4 + 3] <= alphaThreshold) continue;

      let head = 0;
      let tail = 0;
      queue[tail++] = idx;
      visited[idx] = 1;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const rMin = Math.max(0, cy - mergeGap - 1);
        const rMax = Math.min(h - 1, cy + mergeGap + 1);
        const cMin = Math.max(0, cx - mergeGap - 1);
        const cMax = Math.min(w - 1, cx + mergeGap + 1);

        for (let ny = rMin; ny <= rMax; ny++) {
          for (let nx = cMin; nx <= cMax; nx++) {
            const nIdx = ny * w + nx;
            if (!visited[nIdx] && imgData[nIdx * 4 + 3] > alphaThreshold) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          }
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw >= minSize && bh >= minSize) {
        boxes.push({ minX, minY, maxX, maxY });
      }
    }
  }

  // Sort reading order (rows, then left-to-right)
  boxes.sort((a, b) => {
    if (Math.abs(a.minY - b.minY) > 16) return a.minY - b.minY;
    return a.minX - b.minX;
  });

  const frames: SlicedFrame[] = [];
  const outCanvas = document.createElement('canvas');
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) return [];

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    outCanvas.width = bw;
    outCanvas.height = bh;
    outCtx.clearRect(0, 0, bw, bh);
    outCtx.drawImage(img, b.minX, b.minY, bw, bh, 0, 0, bw, bh);
    frames.push({
      id: `bbox_${i}`,
      name: `sprite_${String(i).padStart(3, '0')}`,
      width: bw,
      height: bh,
      sourceX: b.minX,
      sourceY: b.minY,
      sourceWidth: bw,
      sourceHeight: bh,
      rotate: 0,
      dataUrl: outCanvas.toDataURL('image/png'),
    });
  }

  return frames;
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array | null {
  const base64 = dataUrl.split(',')[1];
  if (!base64) return null;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export async function exportFramesAsZip(
  zipFilename: string,
  frames: SlicedFrame[],
  extras?: {
    atlasText?: string;
    atlasName?: string;
    skeletonJson?: unknown;
    skeletonName?: string;
  }
) {
  const session = createZipWorkerSession();
  try {
    const batch: Array<{ path: string; data: Uint8Array | string }> = [];
    for (const f of frames) {
      const bytes = dataUrlToUint8Array(f.dataUrl);
      if (bytes) {
        batch.push({ path: `frames/${f.name}.png`, data: bytes });
      }
    }
    if (extras?.atlasText && extras.atlasName) {
      batch.push({ path: extras.atlasName, data: extras.atlasText });
    }
    if (extras?.skeletonJson && extras.skeletonName) {
      batch.push({
        path: extras.skeletonName,
        data: JSON.stringify(extras.skeletonJson, null, 2),
      });
    }
    await session.addFilesBatch(batch);
    const blob = await session.generateBlob(undefined, 'STORE');
    downloadBlob(blob, zipFilename);
  } finally {
    session.dispose();
  }
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

export async function extractRegionToPngBlob(
  region: AtlasRegion,
  pageImage: HTMLImageElement
): Promise<Blob | null> {
  const outW = Math.max(1, region.origWidth || region.width);
  const outH = Math.max(1, region.origHeight || region.height);
  const isRotated90 = region.rotate === 90;
  const srcW = isRotated90 ? region.height : region.width;
  const srcH = isRotated90 ? region.width : region.height;
  const destX = region.offsetX || 0;
  const destY = Math.max(0, outH - (region.offsetY || 0) - region.height);

  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(outW, outH);
    const ctx = off.getContext('2d');
    if (ctx) {
      ctx.save();
      if (isRotated90) {
        ctx.translate(destX, destY + region.height);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(pageImage, region.x, region.y, srcW, srcH, 0, 0, srcW, srcH);
      } else {
        ctx.drawImage(
          pageImage,
          region.x,
          region.y,
          srcW,
          srcH,
          destX,
          destY,
          region.width,
          region.height
        );
      }
      ctx.restore();
      return await off.convertToBlob({ type: 'image/png' });
    }
  }

  const canvas = extractRegionToCanvas(region, pageImage);
  return await canvasToPngBlob(canvas);
}

export function exportAnimationStripPng(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  fps = 16
): { dataUrl: string; frameCount: number; cellWidth: number; cellHeight: number } {
  const duration = getAnimationDuration(skeleton, animName);
  const frameCount = Math.max(1, Math.min(60, Math.round(duration * fps)));
  const bounds = computeAnimationWorldBounds(skeleton, animName, regionCanvasMap, 24);
  const cellW = Math.max(128, Math.min(512, Math.ceil(bounds.width * 1.16)));
  const cellH = Math.max(128, Math.min(512, Math.ceil(bounds.height * 1.16)));

  const cols = Math.min(frameCount, 8);
  const rows = Math.ceil(frameCount / cols);

  const sheetCanvas = document.createElement('canvas');
  sheetCanvas.width = cols * cellW;
  sheetCanvas.height = rows * cellH;
  const sheetCtx = sheetCanvas.getContext('2d');

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = cellW;
  frameCanvas.height = cellH;
  const frameCtx = frameCanvas.getContext('2d');

  if (sheetCtx && frameCtx) {
    for (let i = 0; i < frameCount; i++) {
      const t = frameCount === 1 ? 0 : (i / frameCount) * duration;
      renderSpineFrameToCanvas(
        frameCtx,
        cellW,
        cellH,
        skeleton,
        animName,
        t,
        regionCanvasMap,
        1,
        0,
        0,
        bounds
      );
      const col = i % cols;
      const row = Math.floor(i / cols);
      sheetCtx.drawImage(frameCanvas, col * cellW, row * cellH);
    }
  }

  return {
    dataUrl: sheetCanvas.toDataURL('image/png'),
    frameCount,
    cellWidth: cellW,
    cellHeight: cellH,
  };
}

export async function exportAnimationGif(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  options?: {
    fps?: number;
    bounds?: AnimationWorldBounds | null;
    backgroundColor?: string | null;
    onProgress?: (percent: number) => void;
  }
): Promise<{ blob: Blob; frameCount: number; width: number; height: number }> {
  const fps = options?.fps ?? 18;
  const duration = getAnimationDuration(skeleton, animName);
  const frameCount =
    duration <= 0 ? 1 : Math.max(1, Math.min(72, Math.round(duration * fps)));
  const delayMs = duration <= 0 ? 100 : Math.max(20, Math.round((duration / frameCount) * 1000));

  const bounds =
    options?.bounds || computeAnimationWorldBounds(skeleton, animName, regionCanvasMap, 24);
  const cellW = Math.max(160, Math.min(512, Math.ceil(bounds.width * 1.16)));
  const cellH = Math.max(160, Math.min(512, Math.ceil(bounds.height * 1.16)));

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = cellW;
  frameCanvas.height = cellH;
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
  const bgColor = options?.backgroundColor || null;

  const gif = GIFEncoder();

  if (ctx) {
    for (let i = 0; i < frameCount; i++) {
      const t = frameCount === 1 ? 0 : (i / frameCount) * duration;
      renderSpineFrameToCanvas(
        ctx,
        cellW,
        cellH,
        skeleton,
        animName,
        t,
        regionCanvasMap,
        1,
        0,
        0,
        bounds
      );

      if (bgColor) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, cellW, cellH);
        ctx.restore();
      }

      const imageData = ctx.getImageData(0, 0, cellW, cellH);
      const rgba = imageData.data;

      if (bgColor) {
        const palette = quantize(rgba, 256, { format: 'rgb565' });
        while (palette.length < 4) palette.push([0, 0, 0]);
        const indexed = applyPalette(rgba, palette, 'rgb565');
        const depth = Math.max(2, Math.ceil(Math.log2(palette.length)));
        gif.writeFrame(indexed, cellW, cellH, {
          palette,
          delay: delayMs,
          repeat: 0,
          dispose: 0,
          colorDepth: depth,
          transparent: false,
        });
      } else {
        // Extract only opaque pixels so transparent index 0 never collides with black outlines
        const totalPixels = cellW * cellH;
        const opaqueMask = new Uint8Array(totalPixels);
        let opaqueCount = 0;
        for (let px = 0, p = 0; px < totalPixels; px++, p += 4) {
          if (rgba[p + 3] >= 64) {
            opaqueMask[px] = 1;
            opaqueCount++;
          }
        }

        const opaqueRgba = new Uint8Array(Math.max(4, opaqueCount * 4));
        if (opaqueCount === 0) {
          opaqueRgba[0] = 0;
          opaqueRgba[1] = 0;
          opaqueRgba[2] = 0;
          opaqueRgba[3] = 255;
        } else {
          let wIdx = 0;
          for (let px = 0, p = 0; px < totalPixels; px++, p += 4) {
            if (opaqueMask[px]) {
              opaqueRgba[wIdx++] = rgba[p];
              opaqueRgba[wIdx++] = rgba[p + 1];
              opaqueRgba[wIdx++] = rgba[p + 2];
              opaqueRgba[wIdx++] = 255;
            }
          }
        }

        const opaquePalette = quantize(opaqueRgba, 255, { format: 'rgb565' });
        const finalPalette: Array<[number, number, number]> = [
          [0, 0, 0], // Index 0 is strictly reserved as the transparent background index
          ...opaquePalette.map(
            (c) => [c[0], c[1], c[2]] as [number, number, number]
          ),
        ];
        while (finalPalette.length < 4) finalPalette.push([0, 0, 0]);

        const finalIndexed = new Uint8Array(totalPixels);
        if (opaqueCount > 0) {
          const opaqueIndexed = applyPalette(rgba, opaquePalette, 'rgb565');
          for (let px = 0; px < totalPixels; px++) {
            finalIndexed[px] = opaqueMask[px] ? opaqueIndexed[px] + 1 : 0;
          }
        }

        const depth = Math.max(2, Math.ceil(Math.log2(finalPalette.length)));
        gif.writeFrame(finalIndexed, cellW, cellH, {
          palette: finalPalette,
          delay: delayMs,
          repeat: 0,
          dispose: 2,
          colorDepth: depth,
          transparent: true,
          transparentIndex: 0,
        });
      }

      options?.onProgress?.(Math.round(((i + 1) / frameCount) * 100));
      if (i % 3 === 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  gif.finish();
  const bytes = gif.bytes();
  return {
    blob: new Blob([bytes], { type: 'image/gif' }),
    frameCount,
    width: cellW,
    height: cellH,
  };
}

