import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: '',
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Erro inesperado na renderização da interface.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Erro capturado pelo ErrorBoundary:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#0B0F17] p-6 text-slate-100">
          <div className="w-full max-w-md rounded-lg border border-red-900/60 bg-[#131A26] p-6 space-y-4">
            <h1 className="font-display text-lg font-semibold text-red-200">
              Ocorreu um erro inesperado
            </h1>
            <p className="text-xs text-slate-300 leading-relaxed">
              A interface precisou ser interrompida. Se você estava fazendo um download em lote, o progresso já salvo permanece armazenado localmente para continuar ao recarregar.
            </p>
            <p className="rounded bg-[#0B0F17] p-2.5 font-mono text-[11px] text-red-300 break-words">
              {this.state.message}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
              >
                Recarregar Aplicação
              </button>
              <button
                type="button"
                onClick={() => this.setState({ hasError: false, message: '' })}
                className="rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-300 hover:border-slate-500 cursor-pointer"
              >
                Tentar Continuar
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
