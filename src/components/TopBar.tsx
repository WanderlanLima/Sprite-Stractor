import { Download } from 'lucide-react';

export type WorkspaceTab = 'extractor' | 'ninjas' | 'studio' | 'assets' | 'slicer';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  canExportZip: boolean;
  isExportingZip: boolean;
  onExportZip: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'extractor', label: 'Extrator URL' },
  { id: 'ninjas', label: 'Ninjas' },
  { id: 'studio', label: 'Estúdio' },
  { id: 'assets', label: 'Outros Ativos' },
  { id: 'slicer', label: 'Fatiador Local' },
];

export function TopBar({
  activeTab,
  onTabChange,
  canExportZip,
  isExportingZip,
  onExportZip,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#0B0F17]/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-8 px-6">
        <button
          type="button"
          onClick={() => onTabChange('extractor')}
          className="font-display text-lg font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 rounded"
        >
          Shinobi Sprite Studio
        </button>

        <nav
          aria-label="Navegação principal"
          className="hidden md:flex items-center gap-6 overflow-x-auto"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onTabChange(item.id)}
                className={`relative py-5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                  isActive
                    ? 'text-slate-50'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-orange-500"
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            disabled={!canExportZip || isExportingZip}
            onClick={onExportZip}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{isExportingZip ? 'Gerando ZIP...' : 'Exportar ZIP'}</span>
          </button>
        </div>
      </div>

      {/* Compact mobile navigation row */}
      <nav
        aria-label="Navegação móvel"
        className="flex md:hidden items-center gap-4 overflow-x-auto border-t border-slate-800/70 px-4 py-2"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              className={`text-xs font-medium py-1.5 whitespace-nowrap shrink-0 ${
                isActive ? 'text-orange-400' : 'text-slate-400'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
