import { useState, useEffect, useRef } from 'react';

interface DepthParallaxWordsProps {
  text: string;
  highlight?: string;
  stagger?: number;
  delay?: number;
  onComplete?: () => void;
  className?: string;
}

function stripP(s: string): string {
  return s.replace(/[.,!?;:'"()]/g, '');
}

export default function DepthParallaxWords({
  text,
  highlight,
  stagger = 0.12,
  delay = 0,
  onComplete,
  className,
}: DepthParallaxWordsProps) {
  const [started, setStarted] = useState(false);
  const completedRef = useRef(false);
  const hlClean = highlight ? stripP(highlight).toLowerCase() : null;

  const lines = text.split('\n');
  let wordCount = 0;
  lines.forEach((line) => {
    wordCount += line.split(/\s+/).filter(Boolean).length;
  });

  useEffect(() => {
    const t = setTimeout(() => setStarted(true), delay * 1000);
    return () => clearTimeout(t);
  }, [delay]);

  useEffect(() => {
    completedRef.current = false;
  }, [text]);

  useEffect(() => {
    if (started && onComplete) {
      const totalMs = wordCount * stagger * 1000 + 1000;
      const t = setTimeout(() => {
        if (!completedRef.current) {
          completedRef.current = true;
          onComplete();
        }
      }, totalMs);
      return () => clearTimeout(t);
    }
  }, [started, wordCount, stagger, onComplete]);

  const elements: React.ReactNode[] = [];
  let globalIdx = 0;

  lines.forEach((line, li) => {
    if (li > 0) {
      elements.push(<br key={`br-${li}`} />);
    }
    const words = line.split(/\s+/).filter(Boolean);
    words.forEach((word, wi) => {
      const idx = globalIdx++;
      if (wi > 0) {
        elements.push(' ');
      }
      const isHl = hlClean ? stripP(word).toLowerCase() === hlClean : false;
      elements.push(
        <span
          key={`w-${idx}`}
          className={`dpw-word ${isHl ? 'hl' : ''}`}
          style={{
            animation: started
              ? `wordIn 0.9s cubic-bezier(0.22, 1, 0.36, 1) ${idx * stagger}s forwards`
              : 'none',
          }}
        >
          {word}
        </span>
      );
    });
  });

  return (
    <span className={`dpw-wrap ${className ?? ''}`}>
      {elements}
    </span>
  );
}
