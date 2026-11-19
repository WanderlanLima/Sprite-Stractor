import type { ExtractResponse, NinjaBundleResponse } from '../types/sprite';

const CUSTOM_PROXY_KEY = 'shinobi_cors_proxy_url';
const DEFAULT_PUBLIC_PROXY = 'https://corsproxy.io/?url=';

let backendStatus: 'unknown' | 'available' | 'static' = 'unknown';

export function getSavedCorsProxy(): string {
  try {
    return localStorage.getItem(CUSTOM_PROXY_KEY) ?? DEFAULT_PUBLIC_PROXY;
  } catch {
    return DEFAULT_PUBLIC_PROXY;
  }
}

export function setSavedCorsProxy(url: string) {
  try {
    localStorage.setItem(CUSTOM_PROXY_KEY, url.trim());
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

export function resolveAssetFetchUrl(targetUrl: string): string {
  if (backendStatus === 'static') {
    return buildCorsRelayUrl(targetUrl);
  }
  return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
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
      // GitHub Pages returns HTML 404 for /api/*
      if (resp.status === 404 || resp.status === 405) {
        backendStatus = 'static';
      }
    } catch (err) {
      if (err instanceof Error && !err.message.includes('Failed to fetch') && backendStatus === 'available') {
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
  const htmlResp = await fetch(buildCorsRelayUrl(targetUrl));
  if (!htmlResp.ok) {
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
  skeletonUrl: string
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
      if (err instanceof Error && !err.message.includes('Failed to fetch') && backendStatus === 'available') {
        throw err;
      }
      backendStatus = 'static';
    }
  }

  // Static GitHub Pages fallback via CORS relay (or direct if allowed)
  const [atlasResp, skelResp] = await Promise.all([
    fetch(buildCorsRelayUrl(atlasUrl)),
    skeletonUrl ? fetch(buildCorsRelayUrl(skeletonUrl)).catch(() => null) : Promise.resolve(null),
  ]);

  if (!atlasResp.ok) {
    throw new Error(
      `Não foi possível carregar o .atlas em modo estático (HTTP ${atlasResp.status}). Verifique o Proxy CORS nas configurações.`
    );
  }

  const atlasText = await atlasResp.text();
  let skeleton = null;
  if (skelResp && skelResp.ok) {
    try {
      skeleton = await skelResp.json();
    } catch {
      skeleton = null;
    }
  }

  const pageFilenames = parseAtlasPageFilenames(atlasText);
  const pageUrls: Record<string, string> = {};
  for (const pageFile of pageFilenames) {
    const resolved = new URL(pageFile, atlasUrl).toString();
    pageUrls[pageFile] = buildCorsRelayUrl(resolved);
  }

  return { atlasText, skeleton, pageUrls };
}
