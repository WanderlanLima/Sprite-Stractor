export type SpinePackageKind = 'character' | 'summon_skin' | 'effect';

export interface NinjaEntry {
  id: string;
  code: string;
  name?: string;
  nameArtUrl?: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  atlasUrl: string;
  skeletonUrl: string;
  kind?: SpinePackageKind;
  sourceIndex?: 'spine-hd' | 'spine-astc' | 'code';
}

export interface SheetEntry {
  name: string;
  url: string;
  width?: number;
  height?: number;
  bytes?: number;
  sheetKind?: 'astc_sheet' | 'spine_sheet';
}

export type GameAssetCategory = 'emoji' | 'hero' | 'item' | 'ui' | 'bg' | 'sprite' | 'other';

export interface GameAssetEntry {
  name: string;
  url: string;
  category: GameAssetCategory;
  ext: string;
}

export interface ScanStats {
  scannedScripts: number;
  discoveredAssets: number;
  totalNinjas: number;
  totalSheets: number;
  elapsedMs: number;
}

export interface ExtractResponse {
  sourceUrl: string;
  resolvedGameUrl: string;
  gameTitle: string;
  ninjas: NinjaEntry[];
  sheets: SheetEntry[];
  assets: GameAssetEntry[];
  stats: ScanStats;
}

export interface AtlasRegion {
  name: string;
  pageName: string;
  rotate: number; // 0 or 90 (degrees)
  x: number;
  y: number;
  width: number;
  height: number;
  origWidth: number;
  origHeight: number;
  offsetX: number;
  offsetY: number;
  index: number;
}

export interface AtlasPage {
  name: string;
  width: number;
  height: number;
  format?: string;
  filter?: string;
  repeat?: string;
  regions: AtlasRegion[];
}

export interface SpineAttachmentInfo {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  name?: string;
  path?: string;
}

export interface SpineBoneDef {
  name: string;
  parent?: string;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  shearX?: number;
  shearY?: number;
}

export interface SpineSlotDef {
  name: string;
  bone: string;
  attachment?: string;
  color?: string;
  blend?: string;
}

export interface SpineAnimationData {
  slots?: Record<
    string,
    {
      attachment?: Array<{ time?: number; name?: string | null }>;
      color?: Array<{ time?: number; color?: string; curve?: unknown }>;
      twoColor?: Array<{ time?: number; light?: string; dark?: string; curve?: unknown }>;
    }
  >;
  bones?: Record<
    string,
    {
      rotate?: Array<{ time?: number; angle?: number; curve?: unknown }>;
      translate?: Array<{ time?: number; x?: number; y?: number; curve?: unknown }>;
      scale?: Array<{ time?: number; x?: number; y?: number; curve?: unknown }>;
      shear?: Array<{ time?: number; x?: number; y?: number; curve?: unknown }>;
    }
  >;
  events?: Array<{ time?: number; name?: string; string?: string }>;
}

export interface SpineCommandEffectRef {
  spineId: string;
  animName: string;
  startTime: number;
  layer: 'behind' | 'front';
  isSelfOrScreen: boolean;
  loop: boolean;
  rawCommand: string;
}

export interface CompositeSpineLayer {
  spineId: string;
  skeleton: SpineSkeleton;
  animName: string;
  regionCanvasMap: Map<string, HTMLCanvasElement>;
  startTime: number;
  duration: number;
  layer: 'behind' | 'front';
  loop: boolean;
}

export interface SpineSkeleton {
  skeleton?: {
    hash?: string;
    spine?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fps?: number;
  };
  bones?: SpineBoneDef[];
  slots?: SpineSlotDef[];
  skins?: Array<{
    name: string;
    attachments?: Record<string, Record<string, SpineAttachmentInfo>>;
  }> | Record<string, Record<string, Record<string, SpineAttachmentInfo>>>;
  animations?: Record<string, SpineAnimationData>;
}

export interface NinjaBundleResponse {
  atlasText: string;
  skeleton: SpineSkeleton | null;
  pageUrls: Record<string, string>;
  idleFrameName?: string;
}

export interface SlicedFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  rotate: number;
  dataUrl: string;
}
