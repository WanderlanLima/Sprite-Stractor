import JSZip from 'jszip';
import type { ExtractResponse, NinjaBundleResponse, NinjaEntry, SpineSkeleton } from '../types/sprite';

const CUSTOM_PROXY_KEY = 'shinobi_cors_proxy_url';
const LEGACY_BROKEN_PROXIES = new Set([
  'https://corsproxy.io/?url=',
  'https://corsproxy.io/?',
]);

const FALLBACK_TEXT_PROXIES = [
  'https://api.cors.lol/?url=',
  'https://api.allorigins.win/raw?url=',
];

let backendStatus: 'unknown' | 'available' | 'static' = 'unknown';

interface IdleMapEntry {
  frame: string;
  page: string;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  s?: number;
}

interface StaticAtlasPack {
  zip: JSZip;
  idleMap: Record<string, IdleMapEntry>;
}

let staticPackPromise: Promise<StaticAtlasPack | null> | null = null;
const skeletonChunkCache = new Map<number, Promise<JSZip | null>>();

async function loadStaticSkeleton(ninjaId: string, chunkIndex: number): Promise<SpineSkeleton | null> {
  let chunkPromise = skeletonChunkCache.get(chunkIndex);
  if (!chunkPromise) {
    chunkPromise = (async () => {
      try {
        const resp = await fetch(`./data/skeletons/skel-${chunkIndex}.zip`);
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        return await JSZip.loadAsync(buf);
      } catch {
        return null;
      }
    })();
    skeletonChunkCache.set(chunkIndex, chunkPromise);
  }
  const zip = await chunkPromise;
  const file = zip?.file(`${ninjaId}.json`);
  if (!file) return null;
  try {
    return JSON.parse(await file.async('text')) as SpineSkeleton;
  } catch {
    return null;
  }
}

async function loadStaticAtlasPack(): Promise<StaticAtlasPack | null> {
  if (!staticPackPromise) {
    staticPackPromise = (async () => {
      try {
        const resp = await fetch('./data/naruto-atlas-pack.zip');
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);
        const idleFile = zip.file('idle-map.json');
        const idleMap: Record<string, IdleMapEntry> = idleFile
          ? (JSON.parse(await idleFile.async('text')) as Record<string, IdleMapEntry>)
          : {};
        return { zip, idleMap };
      } catch {
        return null;
      }
    })();
  }
  return staticPackPromise;
}

export function getSavedCorsProxy(): string {
  try {
    const val = (localStorage.getItem(CUSTOM_PROXY_KEY) ?? '').trim();
    if (!val || LEGACY_BROKEN_PROXIES.has(val)) return '';
    return val;
  } catch {
    return '';
  }
}

export function setSavedCorsProxy(url: string) {
  try {
    const trimmed = url.trim();
    if (!trimmed || LEGACY_BROKEN_PROXIES.has(trimmed)) {
      localStorage.removeItem(CUSTOM_PROXY_KEY);
    } else {
      localStorage.setItem(CUSTOM_PROXY_KEY, trimmed);
    }
  } catch {
    // ignore storage quota errors
  }
}

export function isStaticHostingMode(): boolean {
  return backendStatus === 'static';
}

export function buildCorsRelayUrl(targetUrl: string, proxyPrefix = getSavedCorsProxy()): string {
  const cleanPrefix = proxyPrefix.trim();
  if (!cleanPrefix) return targetUrl;
  if (cleanPrefix.includes('{url}')) {
    return cleanPrefix.replace('{url}', encodeURIComponent(targetUrl));
  }
  return `${cleanPrefix}${encodeURIComponent(targetUrl)}`;
}

export function buildWsrvImageUrl(targetUrl: string): string {
  return `https://wsrv.nl/?url=${encodeURIComponent(targetUrl)}&ll`;
}

export function resolveAssetFetchUrl(targetUrl: string): string {
  if (backendStatus !== 'static') {
    return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
  }

  const customProxy = getSavedCorsProxy();
  if (customProxy) {
    return buildCorsRelayUrl(targetUrl, customProxy);
  }

  if (/\.(webp|png|jpe?g|gif)(\?|$)/i.test(targetUrl)) {
    return buildWsrvImageUrl(targetUrl);
  }

  return buildCorsRelayUrl(targetUrl, FALLBACK_TEXT_PROXIES[0]);
}

export function getNinjaThumbUrl(atlasUrl: string, skeletonUrl: string): string | null {
  if (backendStatus === 'static') {
    return null;
  }
  return `/api/ninja-thumb?atlasUrl=${encodeURIComponent(atlasUrl)}&skeletonUrl=${encodeURIComponent(skeletonUrl)}`;
}

export async function resolveStaticNinjaThumbUrl(ninja: NinjaEntry): Promise<string | null> {
  const pack = await loadStaticAtlasPack();
  if (!pack) return null;
  const entry = pack.idleMap[ninja.id];
  if (!entry || !entry.page || entry.w <= 0 || entry.h <= 0) return null;

  try {
    const pageUrl = new URL(entry.page, ninja.atlasUrl).toString();
    const customProxy = getSavedCorsProxy();
    if (customProxy) {
      return null;
    }
    const rotateParam = entry.r === 90 ? '&ro=270' : '';
    // Do NOT pass &w=&h= alongside &cx=&cy=&cw=&ch= because wsrv.nl resizes before cropping.
    return `https://wsrv.nl/?url=${encodeURIComponent(pageUrl)}&cx=${entry.x}&cy=${entry.y}&cw=${entry.w}&ch=${entry.h}${rotateParam}&output=png`;
  } catch {
    return null;
  }
}

function parseAtlasPageFilenames(atlasText: string): string[] {
  const lines = atlasText.split(/\r?\n/);
  const pages: string[] = [];
  let expectPageName = true;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      expectPageName = true;
      continue;
    }
    if (expectPageName) {
      if (/\.(png|webp|jpe?g|gif|ktx2?)$/i.test(line)) {
        pages.push(line);
      }
      expectPageName = false;
    }
  }
  return pages;
}

function extractNinjaIdFromAtlasUrl(atlasUrl: string): string | null {
  const clean = atlasUrl.split('?')[0];
  const file = clean.split('/').pop() || '';
  if (!file.toLowerCase().endsWith('.atlas')) return null;
  return file.slice(0, -'.atlas'.length);
}

async function fetchTextViaRelays(targetUrl: string, timeoutMs = 6000): Promise<Response | null> {
  const custom = getSavedCorsProxy();
  const prefixes = custom ? [custom, ...FALLBACK_TEXT_PROXIES] : FALLBACK_TEXT_PROXIES;

  for (const prefix of prefixes) {
    try {
      const resp = await fetch(buildCorsRelayUrl(targetUrl, prefix), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) {
        return resp;
      }
    } catch {
      // try next relay
    }
  }
  return null;
}

export async function extractGameCatalog(targetUrl: string): Promise<ExtractResponse> {
  // Try backend API first (works in Node/Express dev & Cloud Run)
  if (backendStatus !== 'static') {
    try {
      const resp = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        backendStatus = 'available';
        const data = (await resp.json()) as ExtractResponse & { error?: string };
        if (!resp.ok) {
          throw new Error(data.error || 'Não foi possível extrair os sprites desta URL.');
        }
        return data;
      }
      if (resp.status === 404 || resp.status === 405) {
        backendStatus = 'static';
      }
    } catch (err) {
      if (
        err instanceof Error &&
        !err.message.includes('Failed to fetch') &&
        backendStatus === 'available'
      ) {
        throw err;
      }
      backendStatus = 'static';
    }
  }

  // Static / GitHub Pages fallback
  const normalized = targetUrl.toLowerCase();
  if (normalized.includes('naruto.jotagame.com')) {
    const staticResp = await fetch('./data/naruto-catalog.json');
    if (staticResp.ok) {
      return (await staticResp.json()) as ExtractResponse;
    }
  }

  // Attempt client-side fetch via configured CORS relay for other URLs
  const htmlResp = await fetchTextViaRelays(targetUrl, 8000);
  if (!htmlResp) {
    throw new Error(
      'Modo estático (GitHub Pages): configure um Proxy CORS ou use o catálogo pré-carregado de naruto.jotagame.com.'
    );
  }
  const html = await htmlResp.text();
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const imgs = Array.from(
    html.matchAll(/(?:src|href)=["']([^"']+\.(?:png|webp|jpe?g|gif|svg)(?:\?[^"']*)?)["']/gi)
  ).map((m) => {
    const resolved = new URL(m[1], targetUrl).toString();
    const name = resolved.split('?')[0].split('/').pop() || 'sprite';
    const ext = name.split('.').pop()?.toLowerCase() || 'png';
    return { name, url: resolved, category: 'sprite' as const, ext };
  });

  return {
    sourceUrl: targetUrl,
    resolvedGameUrl: targetUrl,
    gameTitle: titleMatch ? titleMatch[1].trim() : 'Jogo Web',
    ninjas: [],
    sheets: [],
    assets: imgs,
    stats: {
      scannedScripts: 0,
      discoveredAssets: imgs.length,
      totalNinjas: 0,
      totalSheets: 0,
      elapsedMs: 0,
    },
  };
}

export async function fetchNinjaBundle(
  atlasUrl: string,
  skeletonUrl: string,
  options?: { skipSkeleton?: boolean }
): Promise<NinjaBundleResponse> {
  if (backendStatus !== 'static') {
    try {
      const resp = await fetch(
        `/api/ninja-bundle?atlasUrl=${encodeURIComponent(atlasUrl)}&skeletonUrl=${encodeURIComponent(skeletonUrl)}`
      );
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        backendStatus = 'available';
        const data = (await resp.json()) as NinjaBundleResponse & { error?: string };
        if (!resp.ok) {
          throw new Error(data.error || 'Falha ao carregar pacote do ninja.');
        }
        return data;
      }
      if (resp.status === 404 || resp.status === 405) {
        backendStatus = 'static';
      }
    } catch (err) {
      if (
        err instanceof Error &&
        !err.message.includes('Failed to fetch') &&
        backendStatus === 'available'
      ) {
        throw err;
      }
      backendStatus = 'static';
    }
  }

  // Static GitHub Pages mode: first try bundled compressed atlas & skeleton packs (zero rate limits!)
  const ninjaId = extractNinjaIdFromAtlasUrl(atlasUrl);
  let atlasText = '';
  let idleFrameName: string | undefined;
  let skeletonChunkIdx: number | undefined;

  if (ninjaId) {
    const pack = await loadStaticAtlasPack();
    const packedAtlas = pack?.zip.file(`atlas/${ninjaId}.atlas`);
    if (packedAtlas) {
      atlasText = await packedAtlas.async('text');
      const entry = pack?.idleMap[ninjaId];
      idleFrameName = entry?.frame;
      skeletonChunkIdx = entry?.s;
    }
  }

  if (!atlasText) {
    const atlasResp = await fetchTextViaRelays(atlasUrl, 7000);
    if (!atlasResp) {
      throw new Error(
        'Não foi possível carregar o .atlas em modo estático pelos proxies públicos. Adicione um Proxy CORS próprio nas configurações.'
      );
    }
    atlasText = await atlasResp.text();
  }

  let skeleton: SpineSkeleton | null = null;
  if (!options?.skipSkeleton) {
    if (ninjaId && typeof skeletonChunkIdx === 'number') {
      skeleton = await loadStaticSkeleton(ninjaId, skeletonChunkIdx);
    }
    if (!skeleton && skeletonUrl) {
      const skelResp = await fetchTextViaRelays(skeletonUrl, 4500);
      if (skelResp) {
        try {
          skeleton = (await skelResp.json()) as SpineSkeleton;
        } catch {
          skeleton = null;
        }
      }
    }
  }

  const pageFilenames = parseAtlasPageFilenames(atlasText);
  const pageUrls: Record<string, string> = {};
  const customProxy = getSavedCorsProxy();
  for (const pageFile of pageFilenames) {
    const resolved = new URL(pageFile, atlasUrl).toString();
    pageUrls[pageFile] = customProxy
      ? buildCorsRelayUrl(resolved, customProxy)
      : buildWsrvImageUrl(resolved);
  }

  return { atlasText, skeleton, pageUrls, idleFrameName };
}
