import { useMemo, useState } from 'react';
import { Download, Scissors, Search } from 'lucide-react';
import type { GameAssetEntry, SheetEntry } from '../types/sprite';

interface GeneralAssetsViewProps {
  sheets: SheetEntry[];
  assets: GameAssetEntry[];
  onSendToSlicer: (proxyImageUrl: string, filename: string) => void;
}

export function GeneralAssetsView({
  sheets,
  assets,
  onSendToSlicer,
}: GeneralAssetsViewProps) {
  const [subTab, setSubTab] = useState<'sheets' | 'assets'>(
    sheets.length > 0 ? 'sheets' : 'assets'
  );
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | 'sprite' | 'item' | 'ui' | 'bg' | 'other'>('all');
  const [limit, setLimit] = useState(48);

  const filteredSheets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? sheets.filter((s) => s.name.toLowerCase().includes(q)) : sheets;
  }, [sheets, search]);

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assets.filter((a) => {
      if (category !== 'all' && a.category !== category) return false;
      if (q && !a.name.toLowerCase().includes(q) && !a.url.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [assets, category, search]);

  if (sheets.length === 0 && assets.length === 0) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-slate-800 bg-[#131A26] p-10 text-center">
        <h2 className="font-display text-lg font-semibold text-slate-100">
          Nenhum ativo adicional carregado
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Faça uma extração na aba Extrator URL para listar folhas de sprites, itens, ícones de interface e cenários do jogo.
        </p>
      </div>
    );
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-4 border-b border-slate-800/80 pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#131A26] p-1 w-fit">
          <button
            type="button"
            onClick={() => {
              setSubTab('sheets');
              setLimit(48);
            }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
              subTab === 'sheets'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Folhas de Sprites ({sheets.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setSubTab('assets');
              setLimit(48);
            }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
              subTab === 'assets'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            UI, Itens e Cenários ({assets.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {subTab === 'assets' && (
            <select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as 'all' | 'sprite' | 'item' | 'ui' | 'bg' | 'other')
              }
              aria-label="Filtrar por categoria"
              className="rounded-lg border border-slate-800 bg-[#131A26] px-3 py-2 text-xs text-slate-200 focus:border-orange-500 focus:outline-none cursor-pointer"
            >
              <option value="all">Todas categorias</option>
              <option value="sprite">Sprites</option>
              <option value="item">Itens e Ícones</option>
              <option value="ui">Interface (UI)</option>
              <option value="bg">Cenários e Fundos</option>
              <option value="other">Outros</option>
            </select>
          )}

          <div className="relative min-w-[240px]">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar arquivo..."
              aria-label="Buscar arquivo"
              className="w-full rounded-lg border border-slate-800 bg-[#131A26] py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {subTab === 'sheets' ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredSheets.slice(0, limit).map((sheet) => {
              const proxyUrl = `/api/proxy?url=${encodeURIComponent(sheet.url)}`;
              return (
                <div
                  key={sheet.url}
                  className="flex flex-col overflow-hidden rounded-lg border border-slate-800 bg-[#131A26]"
                >
                  <div className="sprite-checkerboard flex h-44 items-center justify-center p-3">
                    <img
                      src={proxyUrl}
                      alt={sheet.name}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                  <div className="flex flex-col gap-2.5 border-t border-slate-800/80 p-3">
                    <div>
                      <div className="truncate font-mono text-xs font-semibold text-slate-100">
                        {sheet.name}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                        {sheet.width && sheet.height ? `${sheet.width} × ${sheet.height} px` : 'Imagem'}
                        {sheet.bytes ? ` · ${(sheet.bytes / (1024 * 1024)).toFixed(2)} MB` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onSendToSlicer(proxyUrl, sheet.name)}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-orange-500/60 hover:text-white cursor-pointer"
                      >
                        <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Fatiar</span>
                      </button>
                      <a
                        href={proxyUrl}
                        download={sheet.name}
                        className="inline-flex items-center justify-center rounded-md border border-slate-700 bg-[#0B0F17] p-1.5 text-slate-300 hover:border-slate-500 hover:text-white"
                        aria-label={`Baixar ${sheet.name}`}
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {filteredSheets.length > limit && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => setLimit((l) => l + 48)}
                className="rounded-lg border border-slate-700 bg-[#131A26] px-4 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
              >
                Carregar mais folhas ({filteredSheets.length - limit} restantes)
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {filteredAssets.slice(0, limit).map((asset) => {
              const proxyUrl = `/api/proxy?url=${encodeURIComponent(asset.url)}`;
              return (
                <div
                  key={asset.url}
                  className="flex flex-col overflow-hidden rounded-lg border border-slate-800 bg-[#131A26]"
                >
                  <div className="sprite-checkerboard flex h-32 items-center justify-center p-2">
                    <img
                      src={proxyUrl}
                      alt={asset.name}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                  <div className="flex flex-col gap-2 border-t border-slate-800/80 p-2.5">
                    <div className="truncate font-mono text-xs text-slate-100" title={asset.name}>
                      {asset.name}
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span className="font-mono uppercase">{asset.ext}</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onSendToSlicer(proxyUrl, asset.name)}
                          title="Abrir no Fatiador"
                          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-orange-400 cursor-pointer"
                        >
                          <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <a
                          href={proxyUrl}
                          download={asset.name}
                          title="Baixar arquivo"
                          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {filteredAssets.length > limit && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => setLimit((l) => l + 48)}
                className="rounded-lg border border-slate-700 bg-[#131A26] px-4 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
              >
                Carregar mais arquivos ({filteredAssets.length - limit} restantes)
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
