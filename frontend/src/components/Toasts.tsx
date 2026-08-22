import { Toaster, toast } from 'sonner';
import { X, AlertTriangle, Info, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

// Sonner-powered toast system. pushToast is callable from anywhere — including
// the realtime event handler in useRealtimeSync, which has no React context —
// and <ToastHost/> (mounted once in App) renders the <Toaster/>. All toasts
// share the liquid-glass card: translucent blurred material, specular top
// edge, tinted icon tile, sonner's spring enter/exit from the bottom-right.

export interface ToastItem {
  id: number;
  kind: 'info' | 'warn';
  title: string;
  message?: string;
}

type Kind = 'success' | 'error' | 'warn' | 'info' | 'loading';

const ICONS: Record<Kind, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  warn: AlertTriangle,
  info: Info,
  loading: Loader2,
};

function GlassToast({ kind, title, message, id, action }: { kind: Kind; title: string; message?: string; id: string | number; action?: { label: string; onClick: () => void } }) {
  const Icon = ICONS[kind];
  return (
    <div className={`cf-glass-toast cf-glass-toast--${kind}`}>
      <span className="cf-glass-toast-icon">
        <Icon size={16} strokeWidth={2.2} className={kind === 'loading' ? 'cf-toast-spin' : undefined} />
      </span>
      <div className="cf-glass-toast-body">
        <p className="cf-glass-toast-title">{title}</p>
        {message && <p className="cf-glass-toast-msg">{message}</p>}
        {action && (
          <button
            className="cf-glass-toast-action"
            onClick={() => {
              action.onClick();
              toast.dismiss(id);
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      <button className="cf-glass-toast-close" onClick={() => toast.dismiss(id)} aria-label="Dismiss">
        <X size={13} />
      </button>
    </div>
  );
}

function show(kind: Kind, title: string, message?: string, duration?: number, action?: { label: string; onClick: () => void }): string | number {
  return toast.custom((id) => <GlassToast kind={kind} title={title} message={message} id={id} action={action} />, {
    duration: duration ?? (kind === 'error' ? 8000 : 5500),
  });
}

// Legacy API (realtime install-gap surfacing) — kind maps onto the glass set.
export function pushToast(t: Omit<ToastItem, 'id'>): void {
  show(t.kind === 'warn' ? 'warn' : 'info', t.title, t.message);
}

// Preferred API for page-level actions. loading() stays on screen until
// dismiss(id) swaps it for a success/error toast.
export const notify = {
  success: (title: string, message?: string, action?: { label: string; onClick: () => void }) => show('success', title, message, undefined, action),
  error: (title: string, message?: string, action?: { label: string; onClick: () => void }) => show('error', title, message, undefined, action),
  warn: (title: string, message?: string, action?: { label: string; onClick: () => void }) => show('warn', title, message, undefined, action),
  info: (title: string, message?: string, action?: { label: string; onClick: () => void }) => show('info', title, message, undefined, action),
  loading: (title: string, message?: string) => show('loading', title, message, Infinity),
  dismiss: (id: string | number) => toast.dismiss(id),
};

export default function ToastHost() {
  return (
    <Toaster
      position="bottom-right"
      visibleToasts={4}
      gap={10}
      mobileOffset={{ bottom: '20px', right: '20px' }}
      toastOptions={{
        unstyled: true,
      }}
    />
  );
}
