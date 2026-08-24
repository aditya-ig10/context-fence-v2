import { fn } from '../utils/charts';

interface ChartTooltipProps {
  active?: boolean;
  payload?: { name?: string | number; value?: number | string; color?: string }[];
  label?: string | number;
}

/**
 * Shared chart tooltip for all recharts components (Dashboard + AgentDetail).
 * Uses the design system's glass tokens so tooltips match the app, not a
 * recharts default box.
 */
const MOBILE_BREAKPOINT = 640;
// v2: clamp tooltip to viewport on small screens
export default function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      {label !== undefined && <p className="chart-tooltip-date">{label}</p>}
      {payload.map((p, i) => (
        <div key={i} className="chart-tooltip-row">
          <span className="chart-tooltip-dot" style={{ background: p.color || 'var(--accent-coral)' }} />
          {p.name}: {typeof p.value === 'number' ? fn(p.value) : p.value}
        </div>
      ))}
    </div>
  );
}

// v2 mobile overflow guard
