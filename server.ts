import express from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_PROXY_BYTES = 24 * 1024 * 1024;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length);
      if (net.isIPv4(mapped)) return isPrivateIp(mapped);
    }
    return false;
  }
  return true;
}

async function validatePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  const trimmed = rawUrl.trim();
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    parsed = new URL(withProto);
  } catch {
    throw new Error('URL inválida. Informe um endereço http:// ou https:// válido.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Apenas protocolos HTTP e HTTPS são permitidos.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === '0.0.0.0'
  ) {
    throw new Error('Endereços locais ou internos não são permitidos.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('Endereços de rede privada não são permitidos.');
    }
    return parsed;
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) {
      throw new Error('O domínio resolve para um endereço privado não permitido.');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('não permitido')) {
      throw err;
    }
    throw new Error(`Não foi possível resolver o domínio "${hostname}".`);
  }

  return parsed;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs = 10000,
  accept = '*/*'
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function resolveRelativeUrl(baseUrl: string, ref: string): string | null {
  if (!ref || ref.startsWith('data:') || ref.startsWith('blob:') || ref.startsWith('javascript:')) {
    return null;
  }
  try {
    return new URL(ref, baseUrl).toString();
  } catch {
    return null;
  }
}

function categorizeAsset(
  urlStr: string
): 'emoji' | 'hero' | 'item' | 'ui' | 'bg' | 'sprite' | 'other' {
  const lower = urlStr.toLowerCase();
  if (lower.includes('vdf-emoji') || lower.includes('/emoji')) {
    return 'emoji';
  }
  if (lower.includes('/heros/') || lower.includes('/expression/') || lower.includes('/fichano/')) {
    return 'hero';
  }
  if (lower.includes('/spine/') || lower.includes('/hero') || lower.includes('ninja') || lower.includes('character')) {
    return 'sprite';
  }
  if (
    lower.includes('/items/') ||
    lower.includes('item_') ||
    lower.includes('/rune/') ||
    lower.includes('icone') ||
    lower.includes('icon')
  ) {
    return 'item';
  }
  if (
    lower.includes('/bg/') ||
    lower.includes('bg_') ||
    lower.includes('adventurebg') ||
    lower.includes('moldura') ||
    lower.includes('banner')
  ) {
    return 'bg';
  }
  if (
    lower.includes('/ui/') ||
    lower.includes('/templo/') ||
    lower.includes('/titulos-no/') ||
    lower.includes('/barra-no/') ||
    lower.includes('/chat-no/') ||
    lower.includes('vipplacas') ||
    lower.includes('botao') ||
    lower.includes('titulo')
  ) {
    return 'ui';
  }
  return 'other';
}

function classifySpinePackageKind(id: string): 'character' | 'summon_skin' | 'effect' {
  const lower = id.toLowerCase();
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

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : 'Jogo Web';
}

function detectGameEntrypoints(html: string, baseUrl: string): string[] {
  const candidates: string[] = [];

  // Detect conditional JS redirect targets like: location.replace(instalado?"jogar?app=1":"...")
  const replaceMatches = html.matchAll(/location\.(?:replace|assign|href\s*=)\s*\(?\s*([^;)\n]+)/gi);
  for (const m of replaceMatches) {
    const expr = m[1];
    const stringLiterals = expr.matchAll(/['"]([^'"]+)['"]/g);
    for (const s of stringLiterals) {
      const target = s[1].trim();
      if (!target) continue;
      const resolved = resolveRelativeUrl(baseUrl, target);
      if (resolved) candidates.push(resolved);
    }
  }

  // Detect meta refresh
  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'\s;>]+)/i);
  if (metaRefresh?.[1]) {
    const resolved = resolveRelativeUrl(baseUrl, metaRefresh[1]);
    if (resolved) candidates.push(resolved);
  }

  return Array.from(new Set(candidates));
}

function extractReferencesFromHtml(html: string, baseUrl: string) {
  const entryScriptUrls = new Set<string>();
  const importMapScriptUrls = new Set<string>();
  const cssUrls = new Set<string>();
  const imageUrls = new Set<string>();
  const jsonUrls = new Set<string>();

  // <script src="..."> (always prioritize entry modules)
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const resolved = resolveRelativeUrl(baseUrl, m[1]);
    if (resolved) entryScriptUrls.add(resolved);
  }

  // Parse importmap JSON if present
  const importMapMatches = html.matchAll(/<script[^>]+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of importMapMatches) {
    try {
      const parsed = JSON.parse(m[1]) as { imports?: Record<string, string> };
      if (parsed.imports) {
        for (const val of Object.values(parsed.imports)) {
          const resolved = resolveRelativeUrl(baseUrl, val);
          if (resolved && !entryScriptUrls.has(resolved)) importMapScriptUrls.add(resolved);
        }
      }
    } catch {
      // ignore malformed importmap
    }
  }

  const scriptUrls = new Set<string>([...entryScriptUrls, ...importMapScriptUrls]);

  // <link href="...">
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[0].toLowerCase();
    const resolved = resolveRelativeUrl(baseUrl, m[1]);
    if (!resolved) continue;
    if (tag.includes('stylesheet')) cssUrls.add(resolved);
    else if (/\.(png|webp|jpe?g|gif|svg|ico)(\?|$)/i.test(resolved)) imageUrls.add(resolved);
  }

  // <img src|data-src> & <source srcset>
  for (const m of html.matchAll(/(?:src|data-src|href)=["']([^"']+\.(?:png|webp|jpe?g|gif|svg)(?:\?[^"']*)?)["']/gi)) {
    const resolved = resolveRelativeUrl(baseUrl, m[1]);
    if (resolved) imageUrls.add(resolved);
  }

  // Inline JS & CSS strings
  for (const m of html.matchAll(/['"`]([a-zA-Z0-9_./-]+\.(?:png|webp|jpe?g|gif|svg|json|atlas)(?:\?[^'"`]*)?)['"`]/gi)) {
    const ref = m[1];
    const resolved = resolveRelativeUrl(baseUrl, ref);
    if (!resolved) continue;
    if (/\.(json)(\?|$)/i.test(ref)) jsonUrls.add(resolved);
    else if (/\.(png|webp|jpe?g|gif|svg)(\?|$)/i.test(ref)) imageUrls.add(resolved);
  }

  return { scriptUrls, cssUrls, imageUrls, jsonUrls };
}

function extractPathsFromCode(code: string, baseUrl: string) {
  const imageUrls = new Set<string>();
  const jsonUrls = new Set<string>();

  const pattern = /['"`]([a-zA-Z0-9_./-]*\/[a-zA-Z0-9_./-]+\.(?:png|webp|jpe?g|gif|svg|json|atlas))(?:\?[^'"`]*)?['"`]/gi;
  for (const m of code.matchAll(pattern)) {
    const ref = m[1];
    if (ref.length > 220 || ref.includes('..') || ref.startsWith('//')) continue;
    const resolved = resolveRelativeUrl(baseUrl, ref);
    if (!resolved) continue;
    if (/\.json$/i.test(ref)) jsonUrls.add(resolved);
    else if (/\.(png|webp|jpe?g|gif|svg)$/i.test(ref)) imageUrls.add(resolved);
  }

  return { imageUrls, jsonUrls };
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

function parseAtlasRegionsServer(atlasText: string): Array<{
  name: string;
  pageName: string;
  rotate: number;
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const lines = atlasText.split(/\r?\n/);
  const regions: Array<{
    name: string;
    pageName: string;
    rotate: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  let currentPage: string | null = null;
  let currentRegion: {
    name: string;
    pageName: string;
    rotate: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;

  const parsePair = (val: string): [number, number] => {
    const parts = val.split(',').map((s) => Number(s.trim()));
    return [parts[0] || 0, parts[1] || 0];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (currentRegion) {
        regions.push(currentRegion);
        currentRegion = null;
      }
      currentPage = null;
      continue;
    }
    const isIndented = /^\s+/.test(rawLine);
    const colonIdx = trimmed.indexOf(':');
    if (!currentPage) {
      currentPage = trimmed;
      continue;
    }
    if (!isIndented && colonIdx === -1) {
      if (/\.(png|webp|jpe?g|gif|ktx2?)$/i.test(trimmed)) {
        if (currentRegion) {
          regions.push(currentRegion);
          currentRegion = null;
        }
        currentPage = trimmed;
      } else {
        if (currentRegion) regions.push(currentRegion);
        currentRegion = {
          name: trimmed,
          pageName: currentPage,
          rotate: 0,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        };
      }
      continue;
    }
    if (currentRegion && colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (key === 'rotate') {
        currentRegion.rotate = val === 'true' ? 90 : val === 'false' ? 0 : Number(val) || 0;
      } else if (key === 'xy') {
        const [x, y] = parsePair(val);
        currentRegion.x = x;
        currentRegion.y = y;
      } else if (key === 'size') {
        const [w, h] = parsePair(val);
        currentRegion.width = w;
        currentRegion.height = h;
      }
    }
  }
  if (currentRegion) regions.push(currentRegion);
  return regions;
}

function cropImageBufferWithConvert(
  inputBuffer: Buffer,
  ext: string,
  x: number,
  y: number,
  w: number,
  h: number,
  rotateDeg: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inputFmt = ext === 'png' ? 'png:-' : ext === 'jpg' || ext === 'jpeg' ? 'jpg:-' : 'webp:-';
    const args = [
      inputFmt,
      '-crop',
      `${Math.max(1, w)}x${Math.max(1, h)}+${Math.max(0, x)}+${Math.max(0, y)}`,
      '+repage',
    ];
    if (rotateDeg === 90) {
      args.push('-rotate', '-90');
    }
    args.push('-resize', '144x144>', 'png:-');

    const proc = spawn('convert', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(Buffer.concat(errChunks).toString('utf8') || `convert exited ${code}`));
      }
    });

    proc.stdin.write(inputBuffer);
    proc.stdin.end();
  });
}

const thumbMemoryCache = new Map<string, Buffer>();

interface EnrichedCharacterMeta {
  name?: string;
  nameArtUrl?: string;
}

let cachedMetaPromise: Promise<Map<string, EnrichedCharacterMeta>> | null = null;
let cachedMetaTimestamp = 0;

const JOTA_DD = [
  0xeb, 0x14, 0x79, 0xb3, 0xa9, 0xd6, 0x0c, 0x6e, 0x2d, 0x7c, 0x0f, 0x45, 0xc3, 0x45, 0x8f, 0x0d,
  0xcc, 0x7f, 0x81, 0x52, 0xfa, 0xb1, 0x4b, 0xc1, 0x7c, 0x49, 0x5b, 0x52, 0x69, 0x3b, 0xfd, 0x96,
];
const JOTA_CD = [
  0x5c, 0x16, 0x0c, 0x5a, 0x22, 0x5e, 0xb5, 0xd2, 0xb4, 0xc6, 0xca, 0xef, 0xbe, 0xbf, 0xde, 0xc2,
  0x95, 0xc0, 0x60, 0xac, 0xf0, 0x7a, 0xd6, 0x64, 0x48, 0x23, 0xec, 0xa8, 0xdb, 0xa0, 0x14, 0xaf,
];

async function buildStaticCatalogMetaFallback(): Promise<Map<string, EnrichedCharacterMeta>> {
  const map = new Map<string, EnrichedCharacterMeta>();
  try {
    const raw = await fs.readFile(path.join(__dirname, 'public', 'data', 'naruto-catalog.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      ninjas?: Array<{ id: string; name?: string; nameArtUrl?: string }>;
    };
    for (const n of parsed.ninjas || []) {
      if (n.name || n.nameArtUrl) {
        map.set(n.id, { name: n.name, nameArtUrl: n.nameArtUrl });
      }
    }
  } catch {
    // ignore missing static catalog
  }
  return map;
}

async function fetchJotaCharacterMetaMap(
  activeOrigin: string,
  activeHtml: string,
  ninjas: Array<{ id: string; code: string }>
): Promise<Map<string, EnrichedCharacterMeta>> {
  if (!activeOrigin.includes('jotagame.com')) {
    return new Map();
  }

  const now = Date.now();
  if (cachedMetaPromise && now - cachedMetaTimestamp < 30 * 60 * 1000) {
    return cachedMetaPromise;
  }

  cachedMetaTimestamp = now;
  cachedMetaPromise = (async () => {
    const fallbackMap = await buildStaticCatalogMetaFallback();
    try {
      const recMatch = activeHtml.match(
        /window\.__VDF_RECURSOS__\s*=\s*\{[^}]*"manifesto"\s*:\s*"([^"]+)"/
      );
      const manifestoRel = recMatch?.[1];
      if (!manifestoRel) return fallbackMap;

      const manifestoUrl = new URL(manifestoRel, activeOrigin).toString();
      const manResp = await fetchWithTimeout(manifestoUrl, 8000, 'application/json');
      if (!manResp.ok) return fallbackMap;
      const man = (await manResp.json()) as {
        dadosVersao?: string;
        arquivos?: Record<string, { url: string }>;
      };
      const fileSet = new Set(Object.values(man.arquivos || {}).map((e) => e.url));
      const v = man.dadosVersao || '0';

      const master = Buffer.from(JOTA_DD.map((val, i) => val ^ JOTA_CD[i]));
      const nomeKey = crypto.createHmac('sha256', master).update('nome').digest();
      const dadosKey = crypto.createHmac('sha256', master).update('dados').digest();

      const fetchDados = async (pathStr: string): Promise<Record<string, unknown>> => {
        const slug = crypto
          .createHmac('sha256', nomeKey)
          .update(pathStr)
          .digest()
          .subarray(0, 16)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const resp = await fetchWithTimeout(`${activeOrigin}/d/${slug}?v=${v}`, 8000, '*/*');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        const decipher = crypto.createDecipheriv('aes-256-gcm', dadosKey, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(buf.length - 16));
        const dec = Buffer.concat([
          decipher.update(buf.subarray(12, buf.length - 16)),
          decipher.final(),
        ]);
        return JSON.parse(zlib.gunzipSync(dec).toString('utf8')) as Record<string, unknown>;
      };

      const [herois, pt, roleModels, skins] = await Promise.all([
        fetchDados('dados/jogo/herois.json'),
        fetchDados('dados/jogo/pt.json'),
        fetchDados('dados/tabelas/json/RoleModel.json'),
        fetchDados('dados/tabelas/json/SkinConfig.json'),
      ]);

      const resolvePt = (link: unknown): string | undefined => {
        if (!link) return undefined;
        const key = String(link).replace(/^Translate\.Id:/, '');
        const val = pt[key];
        if (!val) return undefined;
        const resolved = Array.isArray(val) ? String(val[0] || '') : String(val);
        return resolved.trim() || undefined;
      };

      type RoleModelObj = Record<string, unknown>;
      const byTag = new Map<string, RoleModelObj>();
      for (const rmVal of Object.values(roleModels)) {
        if (!rmVal || typeof rmVal !== 'object') continue;
        const rm = rmVal as RoleModelObj;
        for (const k of [rm.Tag, rm.Animation, rm.SpineAnim]) {
          if (typeof k === 'string' && k) {
            const kl = k.toLowerCase();
            if (!byTag.has(kl)) byTag.set(kl, rm);
          }
        }
      }

      const skinByModel = new Map<string, RoleModelObj>();
      for (const skVal of Object.values(skins)) {
        if (!skVal || typeof skVal !== 'object') continue;
        const sk = skVal as RoleModelObj;
        if (sk.roleModel != null) {
          skinByModel.set(String(sk.roleModel), sk);
        }
      }

      const pickExistingAsset = (candidates: Array<unknown>): string | undefined => {
        for (const rel of candidates) {
          if (typeof rel !== 'string' || !rel) continue;
          const clean = rel.replace(/^\/+/, '');
          const ptBase = clean.startsWith('acervo/') ? clean : `acervo/language/pt/${clean}`;
          const ptWebp = ptBase.replace(/\.png$/i, '.webp');
          if (fileSet.has(ptWebp)) return `${activeOrigin}/${ptWebp}`;
          if (fileSet.has(ptBase)) return `${activeOrigin}/${ptBase}`;
        }
        return undefined;
      };

      const map = new Map<string, EnrichedCharacterMeta>(fallbackMap);
      for (const n of ninjas) {
        const idLow = n.id.toLowerCase();
        const code6 = n.code.length === 8 && n.code.startsWith('100') ? n.code.slice(0, 6) : n.code;
        const rm =
          byTag.get(idLow) ||
          (roleModels[n.code] as RoleModelObj | undefined) ||
          (roleModels[code6] as RoleModelObj | undefined);
        const modelCode = rm?.model != null ? String(rm.model) : code6;

        let name =
          (rm && resolvePt(rm.__link_name)) ||
          (rm?.model != null
            ? resolvePt((roleModels[String(rm.model)] as RoleModelObj | undefined)?.__link_name) ||
              resolvePt(`HeroBase_${rm.model}_name`)
            : undefined) ||
          resolvePt((herois[n.code] as RoleModelObj | undefined)?.__link_name) ||
          resolvePt(`HeroBase_${n.code}_name`) ||
          resolvePt(`HeroBase_${code6}_name`);

        const sk = skinByModel.get(String(rm?.Id ?? n.code));
        if (sk) {
          const skName = resolvePt(sk.__link_name);
          if (skName && name && !name.includes(skName)) {
            name = `${name} [${skName}]`;
          } else if (skName && !name) {
            name = skName;
          }
        }

        const nameArtUrl = pickExistingAsset([
          rm?.NamePic,
          `asset/heros/${n.code}/namepic_${n.code}.png`,
          `asset/heros/${modelCode}/namepic_${modelCode}.png`,
          rm?.NewnamePic,
          `asset/heros/Newname/newnamepic_${n.code}.png`,
          `asset/heros/Newname/newnamepic_${modelCode}.png`,
        ]);

        if (name || nameArtUrl) {
          map.set(n.id, {
            name: name || fallbackMap.get(n.id)?.name,
            nameArtUrl: nameArtUrl || fallbackMap.get(n.id)?.nameArtUrl,
          });
        }
      }

      return map;
    } catch {
      return fallbackMap;
    }
  })();

  return cachedMetaPromise;
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.post('/api/extract', async (req, res) => {
    const startedAt = Date.now();
    try {
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
      if (!rawUrl.trim()) {
        res.status(400).json({ error: 'Informe a URL do jogo para extrair os sprites.' });
        return;
      }

      const initialUrl = await validatePublicUrl(rawUrl);
      const initialResp = await fetchWithTimeout(initialUrl.toString(), 12000, 'text/html,*/*');
      if (!initialResp.ok) {
        res.status(502).json({ error: `Falha ao acessar a URL (HTTP ${initialResp.status}).` });
        return;
      }

      const initialHtml = await initialResp.text();
      let activeUrl = initialResp.url || initialUrl.toString();
      let activeHtml = initialHtml;

      // Check if this page is a thin launcher/redirect page (like naruto.jotagame.com/ -> jogar?app=1)
      const entrypoints = detectGameEntrypoints(initialHtml, activeUrl);
      const sameOriginEntry = entrypoints.find((ep) => {
        try {
          return new URL(ep).origin === new URL(activeUrl).origin && ep !== activeUrl;
        } catch {
          return false;
        }
      });

      if (sameOriginEntry) {
        try {
          await validatePublicUrl(sameOriginEntry);
          const gameResp = await fetchWithTimeout(sameOriginEntry, 12000, 'text/html,*/*');
          if (gameResp.ok) {
            const gameHtml = await gameResp.text();
            if (gameHtml.length > activeHtml.length) {
              activeUrl = gameResp.url || sameOriginEntry;
              activeHtml = gameHtml;
            }
          }
        } catch {
          // keep initial HTML if secondary entrypoint fails
        }
      }

      const activeOrigin = new URL(activeUrl).origin;
      const gameTitle = extractTitle(activeHtml);
      const { scriptUrls, cssUrls, imageUrls, jsonUrls } = extractReferencesFromHtml(activeHtml, activeUrl);

      // Probe same-origin scripts (prefer entry script first, up to 14 scripts)
      const sameOriginScripts = Array.from(scriptUrls)
        .filter((u) => {
          try {
            return new URL(u).origin === activeOrigin;
          } catch {
            return false;
          }
        })
        .slice(0, 28);

      const sameOriginCss = Array.from(cssUrls)
        .filter((u) => {
          try {
            return new URL(u).origin === activeOrigin;
          } catch {
            return false;
          }
        })
        .slice(0, 6);

      let scannedScripts = 0;
      const codeFetchQueue = [...sameOriginScripts, ...sameOriginCss];

      // Fetch scripts in batches of 6
      for (let i = 0; i < codeFetchQueue.length; i += 6) {
        const batch = codeFetchQueue.slice(i, i + 6);
        await Promise.all(
          batch.map(async (fileUrl) => {
            try {
              const r = await fetchWithTimeout(fileUrl, 8000, 'text/javascript,text/css,*/*');
              if (!r.ok) return;
              const text = await r.text();
              if (text.length > 4 * 1024 * 1024) return;
              scannedScripts++;
              const extracted = extractPathsFromCode(text, activeUrl);
              extracted.imageUrls.forEach((u) => imageUrls.add(u));
              extracted.jsonUrls.forEach((u) => jsonUrls.add(u));
            } catch {
              // ignore individual script timeouts
            }
          })
        );
      }

      // Check well-known / discovered Spine & spritesheet index JSONs
      const ninjas: Array<{
        id: string;
        code: string;
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
        atlasUrl: string;
        skeletonUrl: string;
        kind: 'character' | 'summon_skin' | 'effect';
        sourceIndex: 'spine-hd' | 'spine-astc' | 'code';
      }> = [];

      const sheets: Array<{
        name: string;
        url: string;
        width?: number;
        height?: number;
        bytes?: number;
        sheetKind: 'astc_sheet' | 'spine_sheet';
      }> = [];

      // Look for spine index JSONs (e.g. acervo/asset/spine-hd/indice.json) and spritesheet list JSONs
      const candidateJsonUrls = Array.from(jsonUrls).filter((u) => {
        const lower = u.toLowerCase();
        return (
          lower.includes('indice.json') ||
          lower.includes('lista.json') ||
          lower.includes('atlas') ||
          lower.includes('manifest') ||
          lower.includes('sprite')
        );
      });

      const spineBaseCandidates = new Set<string>();
      for (const jUrl of candidateJsonUrls) {
        if (jUrl.includes('/spine-hd/indice.json')) {
          spineBaseCandidates.add(jUrl.replace(/\/spine-hd\/indice\.json.*$/, '/spine'));
        }
        if (jUrl.includes('/spine-astc/lista.json')) {
          spineBaseCandidates.add(jUrl.replace(/\/spine-astc\/lista\.json.*$/, '/spine'));
        }
      }
      const defaultSpineBase =
        Array.from(spineBaseCandidates)[0] || resolveRelativeUrl(activeUrl, 'acervo/asset/spine') || `${activeOrigin}/acervo/asset/spine`;

      await Promise.all(
        candidateJsonUrls.slice(0, 8).map(async (jUrl) => {
          try {
            await validatePublicUrl(jUrl);
            const resp = await fetchWithTimeout(jUrl, 9000, 'application/json');
            if (!resp.ok) return;
            const data = (await resp.json()) as Record<string, unknown>;
            if (!data || typeof data !== 'object' || Array.isArray(data)) return;

            for (const [key, val] of Object.entries(data)) {
              if (!val || typeof val !== 'object') continue;
              const obj = val as Record<string, unknown>;

              // Spine character bounds index (e.g. "vdfno_100301": { x, y, w, h })
              if (
                typeof obj.w === 'number' &&
                typeof obj.h === 'number' &&
                typeof obj.bytes !== 'number' &&
                !key.includes('.')
              ) {
                const codeMatch = key.match(/(\d+)$/);
                ninjas.push({
                  id: key,
                  code: codeMatch ? codeMatch[1] : key,
                  width: Math.round(obj.w),
                  height: Math.round(obj.h),
                  offsetX: typeof obj.x === 'number' ? Number(obj.x.toFixed(1)) : 0,
                  offsetY: typeof obj.y === 'number' ? Number(obj.y.toFixed(1)) : 0,
                  atlasUrl: `${defaultSpineBase}/${key}.atlas`,
                  skeletonUrl: `${defaultSpineBase}/${key}.json`,
                  kind: classifySpinePackageKind(key),
                  sourceIndex: 'spine-hd',
                });
              }

              // Spritesheet list index (e.g. "no_11000131.webp": { w, h, bytes } or "Wanshe.webp": { w, h, bytes })
              if (
                /\.(webp|png|jpe?g)$/i.test(key) &&
                typeof obj.w === 'number' &&
                typeof obj.h === 'number'
              ) {
                const isNoSheet = key.toLowerCase().startsWith('no_');
                sheets.push({
                  name: key,
                  url: `${defaultSpineBase}/${key}`,
                  width: obj.w,
                  height: obj.h,
                  bytes: typeof obj.bytes === 'number' ? obj.bytes : undefined,
                  sheetKind: isNoSheet ? 'astc_sheet' : 'spine_sheet',
                });

                // Non-`no_*` entries in lista.json (186 summons, skins & effects) are complete Spine packages in /spine/
                if (!isNoSheet && !key.toLowerCase().startsWith('vdfno_')) {
                  const baseId = key.replace(/\.(webp|png|jpe?g)$/i, '');
                  const codeMatch = baseId.match(/(\d+)$/);
                  ninjas.push({
                    id: baseId,
                    code: codeMatch ? codeMatch[1] : baseId,
                    width: Math.round(obj.w),
                    height: Math.round(obj.h),
                    offsetX: 0,
                    offsetY: 0,
                    atlasUrl: `${defaultSpineBase}/${baseId}.atlas`,
                    skeletonUrl: `${defaultSpineBase}/${baseId}.json`,
                    kind: classifySpinePackageKind(baseId),
                    sourceIndex: 'spine-astc',
                  });
                }
              }
            }
          } catch {
            // ignore non-matching JSON files
          }
        })
      );

      // Deduplicate keeping spine-hd metadata priority over spine-astc
      const ninjaMap = new Map<string, (typeof ninjas)[number]>();
      for (const n of ninjas) {
        const prev = ninjaMap.get(n.id);
        if (!prev || (prev.sourceIndex !== 'spine-hd' && n.sourceIndex === 'spine-hd')) {
          ninjaMap.set(n.id, n);
        }
      }

      // Check direct /spine/<name>.png|webp references discovered in scripts (e.g., huomiao.png)
      const directSpineCandidates = Array.from(imageUrls).filter((u) => {
        const lower = u.toLowerCase();
        if (!lower.includes('/spine/')) return false;
        const file = lower.split('?')[0].split('/').pop() || '';
        const base = file.replace(/\.(png|webp|jpe?g)$/i, '');
        return Boolean(base) && !base.startsWith('no_') && !ninjaMap.has(base);
      });

      await Promise.all(
        directSpineCandidates.slice(0, 12).map(async (imgUrl) => {
          try {
            const clean = imgUrl.split('?')[0];
            const file = clean.split('/').pop() || '';
            const baseId = file.replace(/\.(png|webp|jpe?g)$/i, '');
            const atlasCandidate = clean.replace(/\.(png|webp|jpe?g)$/i, '.atlas');
            const skelCandidate = clean.replace(/\.(png|webp|jpe?g)$/i, '.json');
            const headResp = await fetchWithTimeout(atlasCandidate, 4000, 'text/plain,*/*');
            if (!headResp.ok) return;
            const headText = await headResp.text();
            if (!headText || headText.trimStart().startsWith('<')) return;
            const codeMatch = baseId.match(/(\d+)$/);
            ninjaMap.set(baseId, {
              id: baseId,
              code: codeMatch ? codeMatch[1] : baseId,
              width: 256,
              height: 256,
              offsetX: 0,
              offsetY: 0,
              atlasUrl: atlasCandidate,
              skeletonUrl: skelCandidate,
              kind: classifySpinePackageKind(baseId),
              sourceIndex: 'code',
            });
          } catch {
            // ignore non-Spine loose images
          }
        })
      );

      const uniqueNinjasRaw = Array.from(ninjaMap.values()).sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true })
      );

      const metaMap = await fetchJotaCharacterMetaMap(activeOrigin, activeHtml, uniqueNinjasRaw);
      const uniqueNinjas = uniqueNinjasRaw.map((n) => {
        const meta = metaMap.get(n.id);
        return meta
          ? {
              ...n,
              ...(meta.name ? { name: meta.name } : {}),
              ...(meta.nameArtUrl ? { nameArtUrl: meta.nameArtUrl } : {}),
            }
          : n;
      });

      const uniqueSheets = Array.from(new Map(sheets.map((s) => [s.url, s])).values()).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      );

      const assets = Array.from(imageUrls)
        .filter((u) => !u.includes('facebook.com'))
        .map((u) => {
          const cleanPath = u.split('?')[0];
          const name = cleanPath.split('/').pop() || cleanPath;
          const extMatch = cleanPath.match(/\.([a-z0-9]+)$/i);
          return {
            name,
            url: u,
            category: categorizeAsset(u),
            ext: extMatch ? extMatch[1].toLowerCase() : 'img',
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({
        sourceUrl: initialUrl.toString(),
        resolvedGameUrl: activeUrl,
        gameTitle,
        ninjas: uniqueNinjas,
        sheets: uniqueSheets,
        assets,
        stats: {
          scannedScripts,
          discoveredAssets: assets.length,
          totalNinjas: uniqueNinjas.length,
          totalSheets: uniqueSheets.length,
          elapsedMs: Date.now() - startedAt,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro inesperado ao extrair sprites.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/ninja-bundle', async (req, res) => {
    try {
      const atlasUrl = typeof req.query.atlasUrl === 'string' ? req.query.atlasUrl : '';
      const skeletonUrl = typeof req.query.skeletonUrl === 'string' ? req.query.skeletonUrl : '';

      if (!atlasUrl) {
        res.status(400).json({ error: 'Parâmetro atlasUrl obrigatório.' });
        return;
      }

      const validAtlasUrl = await validatePublicUrl(atlasUrl);
      const validSkeletonUrl = skeletonUrl ? await validatePublicUrl(skeletonUrl) : null;

      const [atlasResp, skelResp] = await Promise.all([
        fetchWithTimeout(validAtlasUrl.toString(), 10000, 'text/plain,*/*'),
        validSkeletonUrl
          ? fetchWithTimeout(validSkeletonUrl.toString(), 10000, 'application/json,*/*').catch(() => null)
          : Promise.resolve(null),
      ]);

      if (!atlasResp.ok) {
        res.status(502).json({ error: `Não foi possível baixar o arquivo .atlas (HTTP ${atlasResp.status}).` });
        return;
      }

      const atlasText = await atlasResp.text();
      if (atlasText.trimStart().startsWith('<')) {
        res.status(404).json({ error: 'Arquivo .atlas não encontrado neste endereço.' });
        return;
      }

      let skeleton: unknown = null;
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
        const resolved = resolveRelativeUrl(validAtlasUrl.toString(), pageFile);
        if (resolved) {
          pageUrls[pageFile] = `/api/proxy?url=${encodeURIComponent(resolved)}`;
        }
      }

      res.json({
        atlasText,
        skeleton,
        pageUrls,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao carregar pacote do ninja.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/proxy', async (req, res) => {
    try {
      const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
      if (!rawUrl) {
        res.status(400).json({ error: 'Parâmetro url obrigatório.' });
        return;
      }

      const targetUrl = await validatePublicUrl(rawUrl);
      const upstream = await fetchWithTimeout(targetUrl.toString(), 15000, 'image/*,*/*');
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: `Falha ao buscar recurso remoto (HTTP ${upstream.status}).` });
        return;
      }

      const contentLengthHeader = upstream.headers.get('content-length');
      if (contentLengthHeader && Number(contentLengthHeader) > MAX_PROXY_BYTES) {
        res.status(413).json({ error: 'Arquivo excede o limite máximo de 24 MB.' });
        return;
      }

      const arrayBuf = await upstream.arrayBuffer();
      if (arrayBuf.byteLength > MAX_PROXY_BYTES) {
        res.status(413).json({ error: 'Arquivo excede o limite máximo de 24 MB.' });
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(Buffer.from(arrayBuf));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro no proxy de ativos.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/ninja-thumb', async (req, res) => {
    try {
      const atlasUrl = typeof req.query.atlasUrl === 'string' ? req.query.atlasUrl : '';
      const skeletonUrl = typeof req.query.skeletonUrl === 'string' ? req.query.skeletonUrl : '';
      if (!atlasUrl) {
        res.status(400).json({ error: 'Parâmetro atlasUrl obrigatório.' });
        return;
      }

      const cached = thumbMemoryCache.get(atlasUrl);
      if (cached) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(cached);
        return;
      }

      const validAtlasUrl = await validatePublicUrl(atlasUrl);
      const validSkeletonUrl = skeletonUrl ? await validatePublicUrl(skeletonUrl) : null;

      const [atlasResp, skelResp] = await Promise.all([
        fetchWithTimeout(validAtlasUrl.toString(), 10000, 'text/plain,*/*'),
        validSkeletonUrl
          ? fetchWithTimeout(validSkeletonUrl.toString(), 10000, 'application/json,*/*').catch(() => null)
          : Promise.resolve(null),
      ]);

      if (!atlasResp.ok) {
        res.status(404).end();
        return;
      }
      const atlasText = await atlasResp.text();
      const regions = parseAtlasRegionsServer(atlasText);
      if (regions.length === 0) {
        res.status(404).end();
        return;
      }

      const largestRegion = regions.reduce(
        (best, r) => (r.width * r.height > best.width * best.height ? r : best),
        regions[0]
      );
      let targetName = largestRegion.name;
      if (skelResp && skelResp.ok) {
        try {
          const skel = (await skelResp.json()) as {
            animations?: Record<
              string,
              { slots?: Record<string, { attachment?: Array<{ name?: string | null }> }> }
            >;
          };
          const anims = skel?.animations || {};
          const animOrder = ['idle', 'stand', 'animation', 'skill', 'attack', ...Object.keys(anims)];
          for (const animKey of animOrder) {
            const slots = anims[animKey]?.slots;
            if (!slots) continue;
            const slotOrder = [slots.L0, ...Object.values(slots)].filter(Boolean);
            let foundMatch = false;
            for (const slotAnim of slotOrder) {
              const firstAtt = slotAnim?.attachment?.find((a) => typeof a.name === 'string');
              if (firstAtt?.name && regions.some((r) => r.name === firstAtt.name)) {
                targetName = firstAtt.name;
                foundMatch = true;
                break;
              }
            }
            if (foundMatch) break;
          }
        } catch {
          // fallback to largest region
        }
      }

      const region = regions.find((r) => r.name === targetName) || largestRegion;
      const pageUrl = resolveRelativeUrl(validAtlasUrl.toString(), region.pageName);
      if (!pageUrl) {
        res.status(404).end();
        return;
      }
      await validatePublicUrl(pageUrl);
      const imgResp = await fetchWithTimeout(pageUrl, 15000, 'image/*,*/*');
      if (!imgResp.ok) {
        res.status(502).end();
        return;
      }

      const buf = Buffer.from(await imgResp.arrayBuffer());
      const ext = region.pageName.split('.').pop()?.toLowerCase() || 'webp';
      const cropW = region.rotate === 90 ? region.height : region.width;
      const cropH = region.rotate === 90 ? region.width : region.height;
      const pngBuf = await cropImageBufferWithConvert(
        buf,
        ext,
        region.x,
        region.y,
        cropW,
        cropH,
        region.rotate
      );

      if (thumbMemoryCache.size > 400) {
        const oldestKey = thumbMemoryCache.keys().next().value;
        if (oldestKey) thumbMemoryCache.delete(oldestKey);
      }
      thumbMemoryCache.set(atlasUrl, pngBuf);

      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(pngBuf);
    } catch {
      res.status(500).end();
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled =
      process.env.DISABLE_HMR === 'true' || Boolean(process.env.K_SERVICE);

    if (hmrDisabled) {
      app.get('/@vite/client', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(`const sheetsMap = new Map();
let lastInsertedStyle;

export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    if (!lastInsertedStyle) {
      document.head.appendChild(style);
      setTimeout(() => {
        lastInsertedStyle = undefined;
      }, 0);
    } else {
      lastInsertedStyle.insertAdjacentElement('afterend', style);
    }
    lastInsertedStyle = style;
    sheetsMap.set(id, style);
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
}

export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}

export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    prune() {},
    dispose() {},
    decline() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}

export function injectQuery(url) {
  return url;
}

export class ErrorOverlay extends HTMLElement {}
`);
      });
    }

    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: hmrDisabled ? false : { server: httpServer },
        hmr: hmrDisabled ? false : { server: httpServer },
        watch: hmrDisabled ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Shinobi Sprite Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
