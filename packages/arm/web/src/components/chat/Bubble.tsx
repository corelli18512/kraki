import { useTranslation } from 'react-i18next';
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CircleHelp, AudioLines } from 'lucide-react';
import type { Attachment, ContentRef } from '@kraki/protocol';
import type { SessionCard } from '../../types/store';
import type { PendingInput } from '../../lib/chat/outbox';
import {
  attachmentsOf, contentOf, frozenCardOf, payloadOf, questionSpecOf, seqOf, type SpineItem,
} from '../../lib/chat/spine';
import { agentBubbleColors } from '../../lib/color';
import { Markdown, StreamingMarkdown } from './Markdown';
import { ActionSlot, type ActionHandlers, type SlotAction } from './ActionSlot';
import { HtmlArtifactCards, ImageAttachments } from './Attachments';
import { MessageBubble } from './MessageBubble';

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
  onEditPending?: (clientId: string) => void;
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
  if (side === 'system') return <SystemRow row={row} ctx={ctx} />;
  return <AgentRow row={row} ctx={ctx} />;
});

function SystemRow({ row, ctx }: { row: ChatRow; ctx: BubbleContext }) {
  const { t } = useTranslation('chat');
  if (row.kind !== 'spine') return null;
  const message = row.item.message;
  const attachments = attachmentsOf(message);
  const images = attachments.filter(isImage);
  const reports = htmlArtifacts(attachments);
  const hasMedia = images.length > 0 || reports.length > 0;
  const content = contentOf(message);
  const seq = seqOf(message);
  // Blank no_reply anchors Steps even in historical records without a count.
  // Media changes its presentation, not that existing Steps eligibility.
  const anchorsSteps = payloadOf(message).kind === 'no_reply' && !content.trim();
  if (anchorsSteps && !hasMedia) {
    return (
      <div className="krow krow-agent" data-row-key={row.key} data-testid="steps-only-turn">
        <button type="button" className="ksteps" aria-label={t('bubble.showSteps')} onClick={() => ctx.onOpenSteps?.(seq)}>···</button>
      </div>
    );
  }
  const text = content.trim() ? content : hasMedia ? '' : t('bubble.systemNotice');
  const steps = payloadOf(message).steps;
  const hasSteps = anchorsSteps || (typeof steps === 'number' && steps > 0);
  return (
    <div className="krow krow-agent" data-row-key={row.key}>
      <div className="kagent-stack">
        {(text || reports.length > 0) && (
          <MessageBubble className="kbubble kbubble-system" onShowSteps={hasSteps && ctx.onOpenSteps ? () => ctx.onOpenSteps?.(seq) : undefined}>
            {text && <Markdown text={text} />}
            {reports.length > 0 && <HtmlArtifactCards artifacts={reports} onOpen={ctx.onOpenArtifact} />}
          </MessageBubble>
        )}
        {images.length > 0 && <div className="kattachments"><ImageAttachments attachments={images} sessionId={ctx.sessionId} /></div>}
        {hasSteps && <button type="button" className="ksteps" aria-label={t('bubble.showSteps')} onClick={() => ctx.onOpenSteps?.(seq)}>···</button>}
      </div>
    </div>
  );
}

function UserRow({ row, ctx }: { row: ChatRow; ctx: BubbleContext }) {
  const text = row.kind === 'pending' ? row.entry.text : row.kind === 'spine' ? contentOf(row.item.message) : '';
  const attachments = row.kind === 'pending' ? row.entry.attachments ?? [] : row.kind === 'spine' ? attachmentsOf(row.item.message) : [];
  const state = row.kind === 'pending' ? row.entry.state : undefined;
  const showText = !!text && text !== IMAGE_PLACEHOLDER;
  const images = attachments.filter(isImage);
  return (
    <div
      className={`krow krow-user ${state === 'sending' || state === 'unconfirmed' ? 'is-sending' : ''}`}
      data-row-key={row.key}
      data-delivery={state}
    >
      <div className="kuser-stack">
        {showText && (
          <MessageBubble className="kbubble kbubble-user">
            <Markdown text={text} />
          </MessageBubble>
        )}
        {images.length > 0 && (
          <div className="kattachments kattachments-user"><ImageAttachments attachments={images} sessionId={ctx.sessionId} /></div>
        )}
        {state && state !== 'sending' && row.kind === 'pending' && (
          <PendingMark clientId={row.entry.clientId} state={state} ctx={ctx} />
        )}
      </div>
    </div>
  );
}

/** Pending input actions mirror Mac's delivery-status menu. */
function PendingMark({ clientId, state, ctx }: { clientId: string; state: PendingInput['state']; ctx: BubbleContext }) {
  const { t } = useTranslation('chat');
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
        className={`kfailed-mark is-${state}`}
        aria-label={state === 'correcting' ? t('bubble.correctingOptions') : state === 'unconfirmed' ? t('bubble.unconfirmedOptions') : t('bubble.failedOptions')}
        title={state === 'correcting' ? t('bubble.correcting') : state === 'unconfirmed' ? t('bubble.unconfirmed') : t('bubble.notDelivered')}
        onClick={() => setOpen((v) => !v)}
      >{state === 'correcting' ? <AudioLines aria-hidden /> : state === 'unconfirmed' ? <CircleHelp aria-hidden /> : '!'}</button>
      {open && (
        <div className="kmenu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); ctx.onRetry?.(clientId); }}>{state === 'correcting' ? t('bubble.sendOriginal') : t('bubble.retry')}</button>
          {state === 'correcting' && <button type="button" role="menuitem" onClick={() => { setOpen(false); ctx.onEditPending?.(clientId); }}>{t('bubble.edit')}</button>}
          <button type="button" role="menuitem" className="is-destructive" onClick={() => { setOpen(false); ctx.onDelete?.(clientId); }}>{t('bubble.delete')}</button>
        </div>
      )}
    </div>
  );
}

function AgentRow({ row, ctx }: { row: ChatRow; ctx: BubbleContext }) {
  const { t } = useTranslation('chat');
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
  const colors = agentBubbleColors(ctx.hueSeed);
  const palette = { '--k-agent-light': colors.light, '--k-agent-dark': colors.dark } as CSSProperties;
  const isQuestion = row.kind === 'spine' && !!questionSpecOf(row.item.message);

  if (!hasBody && !action && images.length === 0 && reports.length === 0) {
    // A live turn with nothing streamed yet: the typing indicator.
    return live ? (
      <div className="krow krow-agent" data-row-key={row.key}>
        <div className="kbubble kbubble-agent kbubble-typing" style={palette}>
          <span className="ktyping" aria-label={t('bubble.working')}><i /><i /><i /></span>
        </div>
      </div>
    ) : null;
  }

  return (
    <div className="krow krow-agent" data-row-key={row.key} data-question={isQuestion ? 'true' : undefined}>
      <div className="kagent-stack">
        {(hasBody || action || reports.length > 0) && (
          <MessageBubble
            className="kbubble kbubble-agent"
            style={palette}
            onShowSteps={steps > 0 && ctx.onOpenSteps ? () => ctx.onOpenSteps?.(live ? null : stepsSeq) : undefined}
          >
            {hasBody && (live ? <StreamingMarkdown text={text} /> : <Markdown text={text} />)}
            {action && (
              <div className={`kslot ${hasBody ? '' : 'kslot-alone'}`}>
                <ActionSlot action={action} handlers={ctx} />
              </div>
            )}
            {reports.length > 0 && <HtmlArtifactCards artifacts={reports} onOpen={ctx.onOpenArtifact} />}
          </MessageBubble>
        )}
        {images.length > 0 && (
          <div className="kattachments"><ImageAttachments attachments={images} sessionId={ctx.sessionId} /></div>
        )}
        {steps > 0 && (
          <button
            type="button"
            className="ksteps"
            aria-label={t('bubble.showSteps')}
            onClick={() => ctx.onOpenSteps?.(live ? null : stepsSeq)}
          >···</button>
        )}
      </div>
    </div>
  );
}
