import { useEffect, useRef, useState } from 'react';

interface AnimatedBeamProps {
  containerRef: React.RefObject<HTMLElement | null>;
  fromRef: React.RefObject<HTMLElement | null>;
  toRef: React.RefObject<HTMLElement | null>;
  duration?: number;
  delay?: number;
  straight?: boolean;
  reverse?: boolean;
  active?: boolean;
}

export function AnimatedBeam({ containerRef, fromRef, toRef, duration = 3, delay = 0, straight, reverse, active = true }: AnimatedBeamProps) {
  const [pathD, setPathD] = useState('');
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [key, setKey] = useState(0);

  function computePath() {
    if (!containerRef.current || !fromRef.current || !toRef.current) return;
    const cr = containerRef.current.getBoundingClientRect();
    const fa = fromRef.current.getBoundingClientRect();
    const tb = toRef.current.getBoundingClientRect();
    const w = cr.width, h = cr.height;
    setDims({ w, h });
    const sx = fa.left - cr.left + fa.width / 2;
    const sy = fa.top - cr.top + fa.height / 2;
    const ex = tb.left - cr.left + tb.width / 2;
    const ey = tb.top - cr.top + tb.height / 2;
    setPathD(straight
      ? `M ${sx},${sy} L ${ex},${ey}`
      : `M ${sx},${sy} Q ${(sx + ex) / 2},${Math.min(sy, ey) - 80} ${ex},${ey}`);
    setKey((k) => k + 1);
  }

  useEffect(() => {
    computePath();
    const ro = new ResizeObserver(computePath);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [containerRef, fromRef, toRef]);

  return (
    <svg
      fill="none"
      width={dims.w}
      height={dims.h}
      viewBox={`0 0 ${dims.w} ${dims.h}`}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    >
      <path d={pathD} stroke="var(--border-strong)" strokeWidth="1.5" strokeLinecap="round" />
      {pathD && active && (
        <g key={key}>
          <circle
            r="3"
            fill={reverse ? '#00a699' : '#ff5a5f'}
            style={{ filter: reverse ? 'drop-shadow(0 0 4px rgba(0,166,153,0.6))' : 'drop-shadow(0 0 4px rgba(255,90,95,0.6))' }}
          >
            <animateMotion dur={`${duration}s`} repeatCount="indefinite" path={pathD} begin={delay > 0 ? `${delay}s` : undefined} />
          </circle>
        </g>
      )}
    </svg>
  );
}
