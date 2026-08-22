import { Component, ReactNode } from 'react';
interface Props { children: ReactNode; fallback?: ReactNode; }
interface State { hasError: boolean; error?: Error; }
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) return this.props.fallback || <div style={{padding:40,textAlign:'center'}}><h2>Something went wrong</h2><pre>{this.state.error?.message}</pre></div>;
    return this.props.children;
  }
}
