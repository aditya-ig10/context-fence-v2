import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, type PieProps } from 'recharts';
import ChartTooltip from './ChartTooltip';

export interface DoughnutChartData {
  name: string;
  value: number;
}

interface DoughnutChartProps {
  data: DoughnutChartData[];
  colors: string[];
  paddingAngle?: number;
  label?: PieProps['label'];
  centerLabel?: string;
  centerSub?: string;
  height?: number;
}

/**
 * Shared doughnut chart (Dashboard decision breakdown + AgentDetail models).
 * One implementation guarantees the same inner/outer radius ratio and the
 * same label style across pages.
 */
export default function DoughnutChart({
  data,
  colors,
  paddingAngle = 4,
  label,
  centerLabel,
  centerSub,
  height = 240,
}: DoughnutChartProps) {
  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={90}
            paddingAngle={paddingAngle}
            dataKey="value"
            label={label}
            labelLine={false}
            stroke="var(--card-bg)"
            isAnimationActive
            animationDuration={700}
            animationEasing="ease-out"
          >
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      {(centerLabel || centerSub) && (
        <div
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', textAlign: 'center',
          }}
        >
          {centerLabel && <p className="fw-doughnut-total" style={{ margin: 0 }}>{centerLabel}</p>}
          {centerSub && <p className="fw-doughnut-sub" style={{ margin: 4 }}>{centerSub}</p>}
        </div>
      )}
    </div>
  );
}

// v2: guard empty donut total
