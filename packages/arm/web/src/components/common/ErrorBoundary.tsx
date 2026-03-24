import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { createLogger } from '../../lib/logger';

const logger = createLogger('error-boundary');

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error('Render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="text-center">
            <span className="text-4xl">💥</span>
            <h2 className="mt-3 text-sm font-semibold text-text-primary">Something went wrong</h2>
            <p className="mt-1 max-w-xs text-xs text-text-secondary">
              {this.state.error?.message ?? 'An unexpected error occurred'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-4 rounded-lg bg-kraki-500 px-4 py-2 text-xs font-medium text-white transition-all hover:bg-kraki-600 active:scale-95 active:bg-kraki-700"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
