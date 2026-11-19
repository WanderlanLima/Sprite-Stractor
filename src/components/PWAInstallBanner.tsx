import { useState } from 'react';
import { Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

export function PWAInstallBanner() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) return null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#131A26] px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Smartphone className="h-4 w-4 shrink-0 text-orange-400" aria-hidden="true" />
          <p className="text-xs text-slate-300">
            Instale o <strong className="font-semibold text-slate-100">Shinobi Sprite Studio</strong> na tela inicial do celular ou desktop para abrir em modo aplicativo.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isInstallable ? (
            <button
              type="button"
              onClick={() => void install()}
              className="rounded-lg bg-orange-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 transition-colors whitespace-nowrap cursor-pointer"
            >
              Instalar Aplicativo
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowGuide(true)}
              className="rounded-lg border border-slate-700 bg-[#0B0F17] px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:border-orange-500/60 transition-colors whitespace-nowrap cursor-pointer"
            >
              {isIOS ? 'Como instalar no iPhone' : 'Como instalar no celular'}
            </button>
          )}
        </div>
      </div>

      {showGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="w-full max-w-md rounded-lg border border-slate-700 bg-[#131A26] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 id="pwa-install-title" className="font-display text-base font-semibold text-slate-50">
                Instalar como Aplicativo
              </h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Fechar instruções"
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="space-y-3 text-xs leading-relaxed text-slate-300">
              {isIOS ? (
                <ol className="list-decimal space-y-2 pl-4">
                  <li>
                    Abra este endereço no <strong>Safari</strong> do seu iPhone ou iPad.
                  </li>
                  <li>
                    Toque no botão <strong>Compartilhar</strong> (ícone de quadrado com seta para cima).
                  </li>
                  <li>
                    Role e toque em <strong>Adicionar à Tela de Início</strong>.
                  </li>
                </ol>
              ) : (
                <ol className="list-decimal space-y-2 pl-4">
                  <li>
                    No <strong>Android (Chrome / Edge)</strong>, abra o menu do navegador (três pontinhos) e toque em <strong>Instalar aplicativo</strong> ou <strong>Adicionar à tela inicial</strong>.
                  </li>
                  <li>
                    No <strong>iPhone / iPad (Safari)</strong>, toque em <strong>Compartilhar</strong> e depois em <strong>Adicionar à Tela de Início</strong>.
                  </li>
                  <li>
                    No <strong>PC (Chrome / Edge)</strong>, clique no ícone de instalação na barra de endereço.
                  </li>
                </ol>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full rounded-lg bg-orange-600 py-2 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
            >
              Entendi
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-[#182232] px-3.5 py-2 text-xs font-medium text-amber-200"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
      <span>Modo offline ativo — usando dados em cache</span>
    </div>
  );
}
