import { Component, type ReactNode } from 'react';
import { trackDiagnostic } from '../analytics';

type Props = { children: ReactNode };
type State = { failed: boolean };

/**
 * Keeps a failed 3D viewport (for example, WebGL unavailable) from taking the
 * panels down with it, and counts the fixed `error_render` code when analytics
 * consent allows. The error itself is never reported.
 */
export class ViewportErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(): void {
    trackDiagnostic('error_render');
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="viewer-error warning" role="alert">
        <p>The 3D view could not be drawn. Your settings and controls still work.</p>
        <button type="button" className="btn btn-small" onClick={() => this.setState({ failed: false })}>
          Try again
        </button>
      </div>
    );
  }
}
