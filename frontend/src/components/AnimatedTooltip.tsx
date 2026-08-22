import React, { useState } from 'react';
import {
  motion,
  useTransform,
  AnimatePresence,
  useMotionValue,
  useSpring,
} from 'framer-motion';

// Animated agent-avatar pills for the connector cards (adapted from the
// Aceternity AnimatedTooltip pattern): stacked circular brand icons that pop a
// spring-physics tooltip — slight 3D rotation + horizontal drift following the
// cursor — with gradient hairlines underneath, matching the card's emerald/sky
// accent language. Pure Vite/React: no next/image, no "use client".

export interface TooltipAgent {
  id: number;
  name: string;
  image: string;
  suspended?: boolean;
}

export const AnimatedTooltip = ({ items }: { items: TooltipAgent[] }) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const springConfig = { stiffness: 100, damping: 5 };
  const x = useMotionValue(0); // set on mouse move over an avatar…
  // …and used to tilt + slide the tooltip for a physical feel.
  const rotate = useSpring(useTransform(x, [-100, 100], [-45, 45]), springConfig);
  const translateX = useSpring(useTransform(x, [-100, 100], [-50, 50]), springConfig);
  const handleMouseMove = (event: React.MouseEvent<HTMLImageElement>) => {
    const halfWidth = event.currentTarget.offsetWidth / 2;
    x.set(event.nativeEvent.offsetX - halfWidth);
  };

  return (
    <span className="at-row">
      {items.map((item) => (
        <div
          className="at-item"
          key={`${item.name}-${item.id}`}
          onMouseEnter={() => setHoveredIndex(item.id)}
          onMouseLeave={() => setHoveredIndex(null)}
        >
          <AnimatePresence mode="popLayout">
            {hoveredIndex === item.id && (
              <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.6 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  transition: { type: 'spring', stiffness: 260, damping: 10 },
                }}
                exit={{ opacity: 0, y: 20, scale: 0.6 }}
                style={{
                  translateX,
                  rotate,
                  whiteSpace: 'nowrap',
                }}
                className="at-tip"
              >
                <div className="at-line at-line-a" />
                <div className="at-line at-line-b" />
                <div className="at-name">{item.name}</div>
                {item.suspended && <div className="at-sub">suspended</div>}
              </motion.div>
            )}
          </AnimatePresence>
          {/* eslint-disable-next-line @typescript-eslint/no-non-null-assertion */}
          <img
            onMouseMove={handleMouseMove}
            src={item.image}
            alt={item.name}
            loading="lazy"
            className={`at-avatar ${item.suspended ? 'at-avatar-off' : ''}`}
          />
        </div>
      ))}
    </span>
  );
};

export default AnimatedTooltip;
