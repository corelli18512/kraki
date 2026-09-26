import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Attachment, ContentRef } from '@kraki/protocol';
import type { SessionCard } from '../../types/store';
import type { PendingInput } from '../../lib/chat/outbox';
import {
  attachmentsOf, contentOf, frozenCardOf, payloadOf, questionSpecOf, seqOf, type SpineItem,
} from '../../lib/chat/spine';
import { stringToHue } from '../../lib/color';
import { Markdown, StreamingMarkdown } from './Markdown';
import { ActionSlot, type ActionHandlers, type SlotAction } from './ActionSlot';
import { HtmlArtifactCards, ImageAttachments } from './Attachments';

export type ChatRow =
  | { kind: 'spine'; key: string; item: SpineItem }
  | { kind: 'pending'; key: string; entry: PendingInput }
  | { kind: 'live'; key: string; card: SessionCard };

export const LIVE_KEY = '__live__';

export interface BubbleContext extends ActionHandlers {
  sessionId: string;
  /** Hue seed of agent bubbles (the session id, as on iOS/Mac). */
  hueSeed: string;
  onOpenSteps?: (seq: number | null) => void;
  onRetry?: (clientId: string) => void;
  onDelete?: (clientId: string) => void;
  onOpenArtifact?: (artifact: ContentRef) => void;
}

const IMAGE_PLACEHOLDER = '[image]';

function isImage(a: Attachment): boolean {
  return a.type === 'image' || (a.type === 'content_ref' && a.mimeType.startsWith('image/'));
}

function htmlArtifacts(attachments: Attachment[]): ContentRef[] {
  return attachments.filter((a): a is ContentRef => a.type === 'content_ref' && a.mimeType === 'text/html');
}

/** A row's author: which side and which colors. */
export function rowSide(row: ChatRow): 'user' | 'agent' | 'system' {
  if (row.kind === 'pending') return 'user';
  if (row.kind === 'live') return 'agent';
  const t = row.item.message.type;
  if (t === 'user_message' || t === 'send_input') return 'user';
  if (t === 'system_message') return 'system';
  return 'agent';
}

export const Bubble = memo(function Bubble({ row, ctx }: { row: ChatRow; ctx: BubbleContext }) {
  const side = rowSide(row);
  if (side === 'user') return <UserRow row={row} ctx={ctx} />;
  if (side === 'system') {
    const text = row.kind === 'spine' ? contentOf(row.item.message) || 'System notice' : '';
    return (
      <div className="krow krow-agent">
        <div className="kbubble kbubble-system"><Markdown text={text} /></div>
      </div>
    );
  }
  return <AgentRow row={row} ctx={ctx} />;
});

function UserRow({ row, ctx }: { row: ChatRow; ctx: BubbleContext }) {
  const text = row.kind === 'pending' ? row.entry.text : row.kind === 'spine' ? contentOf(row.item.message) : '';
  const attachments = row.kind === 'pending' ? row.entry.attachments ?? [] : row.kind === 'spine' ? attachmentsOf(row.item.message) : [];
  const state = row.kind === 'pending' ? row.entry.state : undefined;
  const showText = !!text && text !== IMAGE_PLACEHOLDER;
  const images = attachments.filter(isImage);
  return (
    <div
      className={`krow krow-user ${state === 'sending' ? 'is-sending' : ''}`}
      data-row-key={row.key}
      data-delivery={state}
    >
      <div className="kuser-stack">
        {showText && (
          <div className="kbubble kbubble-user">
            <Markdown text={text} />
          </div>
        )}
        {images.length > 0 && (
          <div className="kattachments kattachments-user"><ImageAttachments attachments={images} sessionId={ctx.sessionId} /></div>
        )}
        {state === 'failed' && row.kind === 'pending' && (
          <FailedMark clientId={row.entry.clientId} ctx={ctx} />
        )}
      </div>
    </div>
  );
}

/** Not delivered: a red mark beside the message; click → Retry / Delete. */
function FailedMark({ clientId, ctx }: { clientId: string; ctx: BubbleContext }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="kfailed" ref={ref}>
      <button
        type="button"
        className="kfailed-mark"
        aria-label="Not delivered. Retry or delete"
        onClick={() => setOpen((v) => !v)}
      >!</button>
      {open && (
        <div className="kmenu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); ctx.onRetry?.(clientId); }}>Retry</button>
          <button type="button" role="menuitem" className="is-destructive" onClick={() => { setOpen(false); ctx.onDelete?.(clientId); }}>Delete</button>
        </div>
      )}
    </div>
  );
}

function AgentRow({ row, ctx }: { row: ChatRow; ctx: BubbleContext }) {
  let text = '';
  let action: SlotAction | undefined;
  let attachments: Attachment[] = [];
  let steps = 0;
  let stepsSeq: number | null = null;
  const live = row.kind === 'live';

  if (row.kind === 'live') {
    text = row.card.text;
    action = row.card.action ?? undefined;
    steps = 1;
  } else if (row.kind === 'spine') {
    const message = row.item.message;
    const frozen = frozenCardOf(row.item);
    if (frozen) {
      text = frozen.text;
      action = frozen.action;
    } else {
      text = contentOf(message);
    }
    attachments = attachmentsOf(message);
    const s = payloadOf(message).steps;
    steps = typeof s === 'number' ? s : 0;
    stepsSeq = seqOf(message);
  }

  const images = attachments.filter(isImage);
  const reports = htmlArtifacts(attachments);
  const hasBody = !!text.trim();
  const hue = stringToHue(ctx.hueSeed);
  const isQuestion = row.kind === 'spine' && !!questionSpecOf(row.item.message);

  if (!hasBody && !action && images.length === 0 && reports.length === 0) {
    // A live turn with nothing streamed yet: the typing indicator.
    return live ? (
      <div className="krow krow-agent" data-row-key={row.key}>
        <div className="kbubble kbubble-agent kbubble-typing" style={{ '--hue': hue } as CSSProperties}>
          <span className="ktyping" aria-label="Agent is working"><i /><i /><i /></span>
        </div>
      </div>
    ) : null;
  }

  return (
    <div className="krow krow-agent" data-row-key={row.key} data-question={isQuestion ? 'true' : undefined}>
      <div className="kagent-stack">
        {(hasBody || action) && (
          <div className="kbubble kbubble-agent" style={{ '--hue': hue } as CSSProperties}>
            {hasBody && (live ? <StreamingMarkdown text={text} /> : <Markdown text={text} />)}
            {action && (
              <div className={`kslot ${hasBody ? '' : 'kslot-alone'}`}>
                <ActionSlot action={action} handlers={ctx} />
              </div>
            )}
          </div>
        )}
        {images.length > 0 && (
          <div className="kattachments"><ImageAttachments attachments={images} sessionId={ctx.sessionId} /></div>
        )}
        {reports.length > 0 && (
          <div className="kattachments"><HtmlArtifactCards artifacts={reports} onOpen={ctx.onOpenArtifact} /></div>
        )}
        {steps > 0 && (hasBody || action) && (
          <button
            type="button"
            className="ksteps"
            aria-label="Show steps"
            onClick={() => ctx.onOpenSteps?.(live ? null : stepsSeq)}
          >···</button>
        )}
      </div>
    </div>
  );
}
