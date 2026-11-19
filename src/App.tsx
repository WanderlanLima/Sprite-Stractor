import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Download,
  Globe,
  Layers,
  Scissors,
  Sparkles,
} from 'lucide-react';
import { BatchZipModal } from './components/BatchZipModal';
import { GeneralAssetsView } from './components/GeneralAssetsView';
import { LocalSlicer } from './components/LocalSlicer';
import { NinjaCatalog } from './components/NinjaCatalog';
import { OfflineIndicator, PWAInstallBanner } from './components/PWAInstallBanner';
import { StudioStage } from './components/StudioStage';
import { TopBar, type WorkspaceTab } from './components/TopBar';
import type {
  ExtractResponse,
  NinjaEntry,
  SlicedFrame,
  SpineSkeleton,
} from './types/sprite';
import { exportFramesAsZip } from './utils/atlasParser';
import {
  extractGameCatalog,
  getSavedCorsProxy,
  isStaticHostingMode,
  setSavedCorsProxy,
} from './utils/remoteClient';

const DEFAULT_GAME_URL = 'https://naruto.jotagame.com/';

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('extractor');
  const [targetUrl, setTargetUrl] = useState(DEFAULT_GAME_URL);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractResult, setExtractResult] = useState<ExtractResponse | null>(null);

  const [selectedNinja, setSelectedNinja] = useState<NinjaEntry | null>(null);
  const [studioExportPayload, setStudioExportPayload] = useState<{
    ninjaId: string;
    frames: SlicedFrame[];
    atlasText: string;
    skeleton: SpineSkeleton | null;
  } | null>(null);

  const [localSlicerSource, setLocalSlicerSource] = useState<{
    url: string;
    filename: string;
  } | null>(null);
  const [localExportPayload, setLocalExportPayload] = useState<{
    name: string;
    frames: SlicedFrame[];
  } | null>(null);

  const [isExportingZip, setIsExportingZip] = useState(false);
  const [batchZipList, setBatchZipList] = useState<NinjaEntry[] | null>(null);

  const [showHostingGuide, setShowHostingGuide] = useState(false);
  const [corsProxyInput, setCorsProxyInput] = useState(() => getSavedCorsProxy());
  const [proxySavedNotice, setProxySavedNotice] = useState(false);

  const runExtraction = useCallback(async (urlToScan: string) => {
    const trimmed = urlToScan.trim();
    if (!trimmed) return;

    setExtracting(true);
    setExtractError(null);
    try {
      const data = await extractGameCatalog(trimmed);
      setExtractResult(data);
      if (data.ninjas.length > 0) {
        setSelectedNinja((prev) => prev || data.ninjas[0]);
      }
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'Falha na extração.');
    } finally {
      setExtracting(false);
    }
  }, []);

  useEffect(() => {
    void runExtraction(DEFAULT_GAME_URL);
  }, [runExtraction]);

  const handleSelectNinja = (ninja: NinjaEntry) => {
    setSelectedNinja(ninja);
    setActiveTab('studio');
  };

  const handleSendToSlicer = (proxyUrl: string, filename: string) => {
    setLocalSlicerSource({ url: proxyUrl, filename });
    setActiveTab('slicer');
  };

  const handleLoadedFramesChange = useCallback(
    (
      payload: {
        ninjaId: string;
        frames: SlicedFrame[];
        atlasText: string;
        skeleton: SpineSkeleton | null;
      } | null
    ) => {
      setStudioExportPayload(payload);
    },
    []
  );

  const handleLocalFramesChange = useCallback((frames: SlicedFrame[], name: string) => {
    setLocalExportPayload(frames.length > 0 ? { frames, name } : null);
  }, []);

  const hasSingleNinjaOrLocalZip =
    (activeTab === 'slicer' && Boolean(localExportPayload?.frames.length)) ||
    (activeTab === 'studio' && Boolean(studioExportPayload?.frames.length));

  const canExportZip =
    hasSingleNinjaOrLocalZip ||
    Boolean(extractResult?.ninjas.length) ||
    Boolean(studioExportPayload?.frames.length);

  const handleGlobalExportZip = async () => {
    if (activeTab === 'slicer' && localExportPayload?.frames.length) {
      setIsExportingZip(true);
      try {
        await exportFramesAsZip(
          `${localExportPayload.name}_sprites.zip`,
          localExportPayload.frames
        );
      } finally {
        setIsExportingZip(false);
      }
      return;
    }

    if (activeTab === 'studio' && studioExportPayload?.frames.length) {
      setIsExportingZip(true);
      try {
        await exportFramesAsZip(
          `${studioExportPayload.ninjaId}_sprites.zip`,
          studioExportPayload.frames,
          {
            atlasText: studioExportPayload.atlasText,
            atlasName: `${studioExportPayload.ninjaId}.atlas`,
            skeletonJson: studioExportPayload.skeleton,
            skeletonName: `${studioExportPayload.ninjaId}.json`,
          }
        );
      } finally {
        setIsExportingZip(false);
      }
      return;
    }

    if (extractResult?.ninjas.length) {
      setBatchZipList(extractResult.ninjas);
    }
  };

  const handleSaveProxy = () => {
    setSavedCorsProxy(corsProxyInput);
    setProxySavedNotice(true);
    setTimeout(() => setProxySavedNotice(false), 2000);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0F17] text-slate-100">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        canExportZip={canExportZip}
        isExportingZip={isExportingZip}
        onExportZip={() => void handleGlobalExportZip()}
      />

      <main className="mx-auto w-full max-w-[1440px] flex-1 space-y-6 px-6 py-6">
        <PWAInstallBanner />

        {activeTab === 'extractor' && (
          <div className="space-y-8">
            <section className="rounded-lg border border-slate-800 bg-[#131A26] p-6 sm:p-8">
              <div className="max-w-3xl space-y-3">
                <h1 className="font-display text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl text-balance">
                  Extrator de Sprites e Animações Web
                </h1>
                <p className="text-sm leading-relaxed text-slate-400">
                  Inspecione o código público de jogos HTML5 e pacotes Spine (.atlas, .json e folhas WebP/PNG) para visualizar animações quadro a quadro, fatiar frames individuais e baixar todos os sprites em PNG ou ZIP.
                </p>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runExtraction(targetUrl);
                }}
                className="mt-6 flex flex-col gap-3 sm:flex-row"
              >
                <div className="relative flex-1">
                  <Globe
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                    aria-hidden="true"
                  />
                  <input
                    type="url"
                    required
                    value={targetUrl}
                    onChange={(e) => setTargetUrl(e.target.value)}
                    placeholder="https://naruto.jotagame.com/"
                    aria-label="URL do jogo web"
                    className="w-full rounded-lg border border-slate-700/80 bg-[#0B0F17] py-2.5 pl-10 pr-4 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={extracting}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-500 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span>{extracting ? 'Extraindo...' : 'Extrair Sprites'}</span>
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </form>

              {extractError && (
                <div
                  role="alert"
                  className="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-200"
                >
                  {extractError}
                </div>
              )}

              {extracting && !extractResult && (
                <div className="mt-6 grid grid-cols-1 gap-4 border-t border-slate-800/80 pt-6 sm:grid-cols-4">
                  {[0, 1, 2, 3].map((idx) => (
                    <div key={idx} className="space-y-2">
                      <div className="h-3 w-24 animate-pulse rounded bg-slate-800" />
                      <div className="h-6 w-16 animate-pulse rounded bg-slate-800" />
                    </div>
                  ))}
                </div>
              )}

              {extractResult && (
                <div className="mt-6 border-t border-slate-800/80 pt-6">
                  <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                    <div>
                      <div className="text-xs text-slate-400">Jogo Detectado</div>
                      <div className="mt-1 truncate font-display text-base font-semibold text-slate-100">
                        {extractResult.gameTitle}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-400">Ninjas (Pacotes Spine)</div>
                      <div className="mt-1 font-mono text-xl font-semibold text-orange-400 tabular-nums">
                        {extractResult.stats.totalNinjas}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-400">Folhas de Sprites</div>
                      <div className="mt-1 font-mono text-xl font-semibold text-slate-100 tabular-nums">
                        {extractResult.stats.totalSheets}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-400">UI, Itens e Cenários</div>
                      <div className="mt-1 font-mono text-xl font-semibold text-slate-100 tabular-nums">
                        {extractResult.stats.discoveredAssets}
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    {extractResult.ninjas.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => setBatchZipList(extractResult.ninjas)}
                          className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Baixar Todos os {extractResult.ninjas.length} Sprites (ZIP)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTab('ninjas')}
                          className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-white transition-colors cursor-pointer"
                        >
                          <span>Explorar Ninjas</span>
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </>
                    )}
                    {selectedNinja && (
                      <button
                        type="button"
                        onClick={() => setActiveTab('studio')}
                        className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 transition-colors cursor-pointer"
                      >
                        <Sparkles className="h-3.5 w-3.5 text-orange-400" aria-hidden="true" />
                        <span>Abrir {selectedNinja.id} no Estúdio</span>
                      </button>
                    )}
                    {(extractResult.sheets.length > 0 || extractResult.assets.length > 0) && (
                      <button
                        type="button"
                        onClick={() => setActiveTab('assets')}
                        className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 transition-colors cursor-pointer"
                      >
                        <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Ver Folhas e UI</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveTab('slicer')}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 transition-colors cursor-pointer"
                    >
                      <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Fatiador Local</span>
                    </button>
                  </div>
                </div>
              )}

              {/* GitHub Pages & CORS Relay Settings */}
              <div className="mt-6 border-t border-slate-800/80 pt-4">
                <button
                  type="button"
                  onClick={() => setShowHostingGuide((v) => !v)}
                  className="inline-flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  <span>Hospedagem no GitHub Pages e Proxy CORS (PWA Estático)</span>
                  {showHostingGuide ? (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>

                {showHostingGuide && (
                  <div className="mt-4 grid grid-cols-1 gap-6 rounded-lg border border-slate-800 bg-[#0B0F17] p-4 lg:grid-cols-2">
                    <div className="space-y-2 text-xs text-slate-300 leading-relaxed">
                      <h3 className="font-display text-sm font-semibold text-slate-100">
                        Como publicar no GitHub Pages
                      </h3>
                      <ol className="list-decimal space-y-1.5 pl-4 text-slate-400">
                        <li>
                          Envie este projeto para um repositório no GitHub (branch <code className="font-mono text-slate-200">main</code>).
                        </li>
                        <li>
                          No GitHub, acesse <strong className="text-slate-200">Settings &rarr; Pages &rarr; Source</strong> e selecione <strong className="text-slate-200">GitHub Actions</strong>.
                        </li>
                        <li>
                          O workflow já incluído compila com <code className="font-mono text-slate-200">npm run build</code> (base relativa <code className="font-mono text-slate-200">./</code>) e publica o PWA completo automaticamente.
                        </li>
                      </ol>
                    </div>

                    <div className="space-y-2 text-xs">
                      <h3 className="font-display text-sm font-semibold text-slate-100">
                        Relay CORS para Modo Estático {isStaticHostingMode() ? '(Ativo)' : '(Opcional)'}
                      </h3>
                      <p className="text-slate-400">
                        No GitHub Pages não há servidor Node; quando o site de origem bloqueia CORS, o app usa este prefixo de proxy para baixar folhas WebP/.atlas:
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="url"
                          value={corsProxyInput}
                          onChange={(e) => setCorsProxyInput(e.target.value)}
                          placeholder="https://corsproxy.io/?url="
                          aria-label="URL de Proxy CORS"
                          className="flex-1 rounded-md border border-slate-800 bg-[#131A26] px-3 py-1.5 font-mono text-xs text-slate-100 focus:border-orange-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={handleSaveProxy}
                          className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700 cursor-pointer"
                        >
                          {proxySavedNotice ? 'Salvo' : 'Salvar'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {extractResult && extractResult.ninjas.length > 0 && (
              <NinjaCatalog
                ninjas={extractResult.ninjas}
                selectedNinjaId={selectedNinja?.id || null}
                onSelectNinja={handleSelectNinja}
                onGoToExtractor={() => setActiveTab('extractor')}
                onOpenBatchZip={(list) => setBatchZipList(list)}
              />
            )}
          </div>
        )}

        {activeTab === 'ninjas' && (
          <NinjaCatalog
            ninjas={extractResult?.ninjas || []}
            selectedNinjaId={selectedNinja?.id || null}
            onSelectNinja={handleSelectNinja}
            onGoToExtractor={() => setActiveTab('extractor')}
            onOpenBatchZip={(list) => setBatchZipList(list)}
          />
        )}

        {activeTab === 'studio' && (
          <StudioStage
            ninja={selectedNinja}
            onBackToCatalog={() => setActiveTab('ninjas')}
            onLoadedFramesChange={handleLoadedFramesChange}
          />
        )}

        {activeTab === 'assets' && (
          <GeneralAssetsView
            sheets={extractResult?.sheets || []}
            assets={extractResult?.assets || []}
            onSendToSlicer={handleSendToSlicer}
          />
        )}

        {activeTab === 'slicer' && (
          <LocalSlicer
            externalSource={localSlicerSource}
            onFramesChange={handleLocalFramesChange}
          />
        )}
      </main>

      <BatchZipModal
        isOpen={Boolean(batchZipList)}
        ninjas={batchZipList || []}
        onClose={() => setBatchZipList(null)}
      />

      <OfflineIndicator />

      <footer className="border-t border-slate-800/80 bg-[#0B0F17] py-4">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-6 text-xs text-slate-500">
          <span>Shinobi Sprite Studio · Uso recomendado para estudo técnico, referência e prototipagem</span>
          {extractResult && (
            <span className="font-mono tabular-nums">
              Origem: {extractResult.resolvedGameUrl}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
