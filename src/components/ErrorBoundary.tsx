import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/** Keeps one failing view from blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string; resetKey?: unknown }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  componentDidUpdate(previous: { resetKey?: unknown }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="ux-empty-state" role="alert">
        <strong>{this.props.label} hit an error</strong>
        <code>{this.state.error.message}</code>
        <button type="button" className="ux-button" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
