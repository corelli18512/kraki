import { useRef, useCallback, type ReactNode, type TouchEvent } from 'react';

const ACTION_WIDTH = 64; // px per action button
const SWIPE_THRESHOLD = 0.4; // fraction of tray width to snap open
const ANGLE_LIMIT = 30; // degrees — above this is vertical scroll, not swipe

interface SwipeAction {
  icon: ReactNode;
  label: string;
  bgClass: string;
  onClick: () => void;
}

interface Props {
  actions: SwipeAction[];
  isOpen: boolean;
  onSwipeOpen: () => void;
  onSwipeClose: () => void;
  children: ReactNode;
}

export function SwipeableCard({ actions, isOpen, onSwipeOpen, onSwipeClose, children }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const decided = useRef(false); // whether we've decided swipe vs scroll

  const trayWidth = actions.length * ACTION_WIDTH;
  const maxTranslate = -trayWidth;

  const setTranslate = (px: number, animate: boolean) => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? 'transform 200ms ease-out' : 'none';
    el.style.transform = `translateX(${px}px)`;
  };

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    startX.current = touch.clientX;
    startY.current = touch.clientY;
    currentX.current = isOpen ? maxTranslate : 0;
    swiping.current = false;
    decided.current = false;
  }, [isOpen, maxTranslate]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    const dx = touch.clientX - startX.current;
    const dy = touch.clientY - startY.current;

    // Decide direction on first significant movement
    if (!decided.current) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 10) return; // dead zone
      const angle = Math.abs(Math.atan2(dy, dx) * (180 / Math.PI));
      // Angle from horizontal: 0° = pure left/right, 90° = pure up/down
      const fromHorizontal = angle > 90 ? 180 - angle : angle;
      if (fromHorizontal > ANGLE_LIMIT) {
        // Vertical scroll — bail out
        decided.current = true;
        swiping.current = false;
        return;
      }
      decided.current = true;
      swiping.current = true;
    }

    if (!swiping.current) return;

    e.preventDefault(); // prevent scroll during swipe
    const raw = currentX.current + dx;
    const clamped = Math.max(maxTranslate, Math.min(0, raw));
    setTranslate(clamped, false);
  }, [maxTranslate]);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (!swiping.current) return;
    swiping.current = false;

    const dx = e.changedTouches[0].clientX - startX.current;
    const offset = currentX.current + dx;

    if (isOpen) {
      // Was open — close if dragged right past threshold
      if (offset > maxTranslate * (1 - SWIPE_THRESHOLD)) {
        setTranslate(0, true);
        onSwipeClose();
      } else {
        setTranslate(maxTranslate, true);
      }
    } else {
      // Was closed — open if dragged left past threshold
      if (offset < maxTranslate * SWIPE_THRESHOLD) {
        setTranslate(maxTranslate, true);
        onSwipeOpen();
      } else {
        setTranslate(0, true);
        onSwipeClose();
      }
    }
  }, [isOpen, maxTranslate, onSwipeOpen, onSwipeClose]);

  // Sync with external isOpen state (e.g. another card opened)
  const prevOpen = useRef(isOpen);
  if (prevOpen.current !== isOpen) {
    prevOpen.current = isOpen;
    setTranslate(isOpen ? maxTranslate : 0, true);
  }

  return (
    <div className="relative overflow-hidden rounded-lg">
      {/* Action tray (behind card) */}
      <div className="absolute inset-y-0 right-0 flex">
        {actions.map((action, i) => (
          <button
            key={i}
            onClick={action.onClick}
            className={`flex w-16 flex-col items-center justify-center text-white ${action.bgClass}`}
            aria-label={action.label}
          >
            {action.icon}
            <span className="mt-0.5 text-[9px] font-medium">{action.label}</span>
          </button>
        ))}
      </div>

      {/* Sliding content */}
      <div
        ref={contentRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="relative bg-surface-secondary will-change-transform"
        style={{ transform: isOpen ? `translateX(${maxTranslate}px)` : 'translateX(0)' }}
      >
        {children}
      </div>
    </div>
  );
}
