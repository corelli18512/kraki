import { useEffect, useRef, type RefObject } from 'react';
import { messageProvider } from '../../lib/message-provider';
import { createLogger } from '../../lib/logger';

const logger = createLogger('gap-marker');

interface GapMarkerProps {
  sessionId: string;
  beforeSeq: number;
  loading: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function GapMarker({ sessionId, beforeSeq, loading, scrollRef }: GapMarkerProps) {
  const markerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = markerRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loading) {
          logger.info('gap visible, requesting', { sessionId, beforeSeq });
          messageProvider.requestBefore(sessionId, beforeSeq);
        }
      },
      { root, rootMargin: '200px', threshold: 0 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [sessionId, beforeSeq, loading, scrollRef]);

  return (
    <div ref={markerRef} className="flex justify-center py-3">
      {loading && (
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-kraki-500 border-t-transparent" />
      )}
    </div>
  );
}
