// Something on the page threw while it was being drawn: said, with a way on,
// where React would otherwise take the whole page away and leave it blank.
// One round the app (main.tsx: the last resort - reload), one round the tab
// that's showing (App.tsx), so a tab that can't draw leaves the others be.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  // The whole page (reload only), or the part of it that's showing.
  whole?: boolean;
  // What's showing: a different one (another tab) is tried afresh.
  resetKey?: string;
  // As it fails: for whatever would only make it fail again to be let go of.
  onCrash?: () => void;
  children: ReactNode;
}

export class Crashed extends Component<Props, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("MJWaits couldn't draw this", error, info.componentStack);
    this.props.onCrash?.();
  }
  componentDidUpdate(prev: Props) {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (this.state.error === null) return this.props.children;
    const { whole } = this.props;
    return (
      <section className={`crashed${whole ? " is-whole" : ""}`} role="alert">
        <h2>Something went wrong</h2>
        <p>{whole ? "MJWaits couldn't show this page." : "This part of MJWaits couldn't be shown. The other tabs still work."} Your scores and saved games are kept on this device.</p>
        <div className="crashed-actions">
          {!whole && (
            <button type="button" className="crashed-button" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          )}
          <button type="button" className="crashed-button is-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </section>
    );
  }
}
