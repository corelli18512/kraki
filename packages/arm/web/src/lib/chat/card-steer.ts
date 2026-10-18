import type { SessionCard } from '../../types/store';

/** The current segment stays above the first unread steer, including its echo. */
export function aboveSteer(card: SessionCard, anchor: string): SessionCard {
  if (card.turnConcluded || card.steer?.unread.includes(anchor) || card.steer?.passed.includes(anchor)
    || (!card.text.trim() && !card.action)) return card;
  return { ...card, steer: {
    anchor: card.steer?.anchor ?? anchor,
    unread: [...(card.steer?.unread ?? []), anchor],
    passed: card.steer?.passed ?? [],
  } };
}

/** New segments follow every observed steer; no late echo may pull the card back up. */
export function followSteer(card: SessionCard): SessionCard['steer'] {
  if (!card.steer?.anchor) return card.steer;
  return { unread: [], passed: [...card.steer.passed, ...card.steer.unread] };
}
