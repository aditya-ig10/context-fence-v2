export default function Pattern({ opacity = 0.04 }: { opacity?: number }) {
  return (
    <div
      className="pattern-grid"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        opacity,
        maskImage: 'radial-gradient(ellipse 70% 55% at 50% 50%, black 30%, transparent 70%)',
        WebkitMaskImage: 'radial-gradient(ellipse 70% 55% at 50% 50%, black 30%, transparent 70%)',
        zIndex: 0,
      }}
      aria-hidden="true"
    />
  );
}
