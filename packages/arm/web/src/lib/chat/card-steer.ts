import type { SessionCard } from '../../types/store';

/** The current segment stays above the first unread steer, including its echo. */
export function aboveSteer(card: SessionCard, anchor: string): SessionCard {
  if (card.turnConcluded || card.steer?.anchor || card.steer?.passed.includes(anchor)
    || (!card.text.trim() && !card.action)) return card;
  return { ...card, steer: { anchor, passed: card.steer?.passed ?? [] } };
}

/** New segments follow the steer; its late echo must not pull the card back up. */
export function followSteer(card: SessionCard): SessionCard['steer'] {
  if (!card.steer?.anchor) return card.steer;
  return { passed: [...card.steer.passed, card.steer.anchor] };
}
