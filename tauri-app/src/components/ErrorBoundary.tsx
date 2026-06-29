import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

// Top-level safety net: if a render throws, show a recoverable screen instead
// of a blank window. Keeps a desktop crash from looking like a frozen app.
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] render error:", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    if (this.props.fallback) {
      return this.props.fallback;
    }
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[var(--bg-primary)] px-6 text-center text-[var(--text-primary)]">
        <h1 className="text-lg font-semibold">出了点问题</h1>
        <p className="max-w-md text-sm text-[var(--text-muted)]">
          界面渲染时发生错误。你可以尝试重新加载，如果问题持续，请重启启动器。
        </p>
        <pre className="max-h-40 max-w-md overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 text-left text-xs text-[var(--text-muted)]">
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={this.handleReload}
          className="rounded-xl border border-[#25b87a]/50 bg-[var(--mc-grass)] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--mc-grass-dark)]"
        >
          重新加载
        </button>
      </div>
    );
  }
}
