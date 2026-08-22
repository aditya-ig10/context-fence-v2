import { useState, useEffect, useRef, useCallback } from 'react';
import DepthParallaxWords from './DepthParallaxWords';

interface OnboardingStoryboardProps {
  onComplete: () => void;
}

const ON_SURFACE = '#1a1c1a';
const ON_SURFACE_DARK = '#e8e8e8';
const BG_LIGHT = '#f8fafc';
const BG_DARK = '#0f1117';
const GRID_LIGHT = '#e2e8f0';
const GRID_DARK = '#25282e';
const PRIMARY = '#ff5a5f';
const SKIP_LIGHT = '#5a403f';
const SKIP_DARK = '#b0a0a0';
const EASE_SMOOTH = 'cubic-bezier(0.22, 1, 0.36, 1)';

interface SceneData {
  headline: string;
  highlight: string;
}

const SCENES: SceneData[] = [
  { headline: 'Every conversation builds context.', highlight: 'context.' },
  { headline: 'Not every piece of\ncontext should leave\nyour machine.', highlight: 'leave' },
  { headline: 'ContextFence\nprotects what matters most.', highlight: 'ContextFence' },
];

export default function OnboardingStoryboard({ onComplete }: OnboardingStoryboardProps) {
  const [sceneIdx, setSceneIdx] = useState(0);
  const [phase, setPhase] = useState<'enter' | 'visible' | 'exit' | 'waiting'>('enter');
  const [exiting, setExiting] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);

  const handleEnterDone = useCallback(() => {
    setPhase('visible');
  }, []);

  const advanceScene = useCallback(() => {
    if (sceneIdx >= SCENES.length - 1) {
      setFadeOut(true);
      localStorage.setItem('cf_onboarding_seen', 'true');
      setTimeout(onComplete, 800);
      return;
    }
    setSceneIdx((i) => i + 1);
    setPhase('enter');
  }, [sceneIdx, onComplete]);

  useEffect(() => {
    if (phase !== 'visible') return;
    const t = setTimeout(() => {
      setPhase('exit');
      setExiting(true);
      setTimeout(() => {
        setExiting(false);
        setPhase('waiting');
        setTimeout(advanceScene, 300);
      }, 700);
    }, 2500);
    return () => clearTimeout(t);
  }, [phase, advanceScene]);

  function handleSkip() {
    setFadeOut(true);
    localStorage.setItem('cf_onboarding_seen', 'true');
    setTimeout(onComplete, 800);
  }

  const scene = SCENES[sceneIdx];

  return (
    <div className={`ob-root ${fadeOut ? 'ob-fade' : ''}`}>
      <div className="ob-grid" />

      <div className="ob-corner ob-corner-tl" />
      <div className="ob-corner ob-corner-tr" />
      <div className="ob-corner ob-corner-bl" />
      <div className="ob-corner ob-corner-br" />

      {sceneIdx > 0 && (
        <button className="ob-skip" onClick={handleSkip} type="button">
          <span>Skip</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </button>
      )}

      <div className={`ob-scene ${exiting ? 'ob-exit' : ''}`}>
        {scene && phase !== 'waiting' && (
          <h1 className="ob-headline" key={sceneIdx}>
            <DepthParallaxWords
              text={scene.headline}
              highlight={scene.highlight}
              stagger={0.12}
              delay={0.15}
              onComplete={handleEnterDone}
            />
          </h1>
        )}
      </div>

      <style>{`
        .ob-root {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: ${BG_LIGHT};
          z-index: 20;
          overflow: hidden;
          transition: opacity 800ms ${EASE_SMOOTH};
        }
        @media (prefers-color-scheme: dark) {
          .ob-root {
            background: ${BG_DARK};
          }
        }

        .ob-root.ob-fade {
          opacity: 0;
        }

        .ob-grid {
          position: absolute;
          inset: 0;
          z-index: 0;
          background-image:
            linear-gradient(to right, ${GRID_LIGHT} 1px, transparent 1px),
            linear-gradient(to bottom, ${GRID_LIGHT} 1px, transparent 1px);
          background-size: 20px 30px;
          -webkit-mask-image: radial-gradient(
            ellipse 70% 60% at 50% 0%,
            #000 60%,
            transparent 100%
          );
          mask-image: radial-gradient(
            ellipse 70% 60% at 50% 0%,
            #000 60%,
            transparent 100%
          );
          pointer-events: none;
        }
        @media (prefers-color-scheme: dark) {
          .ob-grid {
            background-image:
              linear-gradient(to right, ${GRID_DARK} 1px, transparent 1px),
              linear-gradient(to bottom, ${GRID_DARK} 1px, transparent 1px);
          }
        }

        .ob-corner {
          position: absolute;
          width: 320px;
          height: 320px;
          border-radius: 50%;
          pointer-events: none;
          z-index: 1;
          filter: blur(80px);
          opacity: 0.35;
          animation: cornerDrift 12s ease-in-out infinite;
        }

        .ob-corner-tl {
          top: -120px;
          left: -120px;
          background: radial-gradient(circle, rgba(255, 90, 95, 0.5), transparent 70%);
          animation-delay: 0s;
        }

        .ob-corner-tr {
          top: -120px;
          right: -120px;
          background: radial-gradient(circle, rgba(0, 168, 121, 0.4), transparent 70%);
          animation-delay: -3s;
        }

        .ob-corner-bl {
          bottom: -120px;
          left: -120px;
          background: radial-gradient(circle, rgba(0, 168, 121, 0.3), transparent 70%);
          animation-delay: -6s;
        }

        .ob-corner-br {
          bottom: -120px;
          right: -120px;
          background: radial-gradient(circle, rgba(255, 90, 95, 0.35), transparent 70%);
          animation-delay: -9s;
        }

        @keyframes cornerDrift {
          0%, 100% {
            transform: translate(0, 0) scale(1);
            opacity: 0.3;
          }
          25% {
            transform: translate(15px, -10px) scale(1.08);
            opacity: 0.45;
          }
          50% {
            transform: translate(-10px, 12px) scale(0.95);
            opacity: 0.35;
          }
          75% {
            transform: translate(8px, 8px) scale(1.04);
            opacity: 0.4;
          }
        }
        @media (prefers-color-scheme: dark) {
          .ob-corner {
            opacity: 0.2;
          }
          .ob-corner-tl {
            background: radial-gradient(circle, rgba(255, 90, 95, 0.35), transparent 70%);
          }
          .ob-corner-tr {
            background: radial-gradient(circle, rgba(0, 168, 121, 0.25), transparent 70%);
          }
          .ob-corner-bl {
            background: radial-gradient(circle, rgba(0, 168, 121, 0.2), transparent 70%);
          }
          .ob-corner-br {
            background: radial-gradient(circle, rgba(255, 90, 95, 0.25), transparent 70%);
          }
        }

        .ob-scene {
          position: relative;
          z-index: 2;
          max-width: 900px;
          width: 100%;
          padding: 180px 80px;
          text-align: center;
          transition: all 700ms ${EASE_SMOOTH};
          display: flex;
          flex-direction: column;
          align-items: center;
          margin: 0 auto;
        }

        .ob-scene.ob-exit {
          opacity: 0;
          transform: translateY(-24px) scale(0.98);
          filter: blur(8px);
        }

        .ob-headline {
          font-size: clamp(52px, 6vw, 80px);
          font-weight: 800;
          color: ${ON_SURFACE};
          margin: 0;
          letter-spacing: -0.035em;
          line-height: 1.08;
          text-align: center;
          word-spacing: 0.12em;
          max-width: 900px;
          width: 100%;
        }
        @media (prefers-color-scheme: dark) {
          .ob-headline {
            color: ${ON_SURFACE_DARK};
          }
        }

        .dpw-wrap {
          display: inline;
        }

        .ob-skip {
          position: fixed;
          bottom: 32px;
          right: 32px;
          z-index: 10;
          display: flex;
          align-items: center;
          gap: 6px;
          background: none;
          border: none;
          color: ${SKIP_LIGHT};
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          padding: 8px 12px;
          border-radius: 10px;
          transition: opacity 300ms, transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
          opacity: 0.5;
        }
        @media (prefers-color-scheme: dark) {
          .ob-skip {
            color: ${SKIP_DARK};
          }
        }
        .ob-skip:hover {
          opacity: 0.85;
          text-decoration: underline;
        }
        .ob-skip svg {
          transition: transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .ob-skip:hover svg {
          transform: translateX(2px);
        }

        .dpw-word {
          display: inline-block;
          opacity: 0;
          transform: translateY(24px) scale(0.92);
          filter: blur(16px);
          white-space: nowrap;
        }

        .dpw-word.hl {
          color: ${PRIMARY};
        }

        @keyframes wordIn {
          0% {
            opacity: 0;
            transform: translateY(24px) scale(0.92);
            filter: blur(16px);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: blur(0);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .ob-corner {
            animation: none;
            opacity: 0.2;
          }
          .ob-scene.ob-exit {
            opacity: 0;
            transform: none;
            filter: none;
          }
          .dpw-word {
            animation: none !important;
            opacity: 1 !important;
            transform: none !important;
            filter: none !important;
          }
        }
      `}</style>
    </div>
  );
}
