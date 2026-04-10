import { useEffect, useRef, type RefObject } from 'react';
import { messageProvider } from '../../lib/message-provider';
import { createLogger } from '../../lib/logger';

const logger = createLogger('gap-marker');

interface GapMarkerProps {
  sessionId: string;
  beforeSeq: number;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function GapMarker({ sessionId, beforeSeq, scrollRef }: GapMarkerProps) {
  const markerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = markerRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          const fromSeq = Math.max(1, beforeSeq - 100);
          logger.info('gap visible, requesting', { sessionId, fromSeq, toSeq: beforeSeq - 1 });
          messageProvider.fetchRange(sessionId, fromSeq, beforeSeq - 1);
        }
      },
      { root, rootMargin: '200px', threshold: 0 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [sessionId, beforeSeq, scrollRef]);

  return (
    <div ref={markerRef} className="flex justify-center py-3">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-kraki-500 border-t-transparent" />
    </div>
  );
}
