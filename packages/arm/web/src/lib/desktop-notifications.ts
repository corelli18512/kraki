import { t } from '../i18n';
import { desktop } from './desktop';
import { notificationsEnabled } from './notification-prefs';

const IDS_KEY = 'kraki-desktop.notifications.recentIds';
const CAPACITY = 512;

function normalized(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\s+/g, ' ').trim() || undefined;
}

/** The Tentacle's canonical push preview, formatted like PushPreviewFormat.swift. */
export function formatDesktopPreview(preview: Record<string, unknown>) {
  const summary = normalized(preview.summary);
  const steps = typeof preview.steps === 'number' ? preview.steps : 0;
  let body: string;
  switch (preview.type) {
    case 'permission': body = t('desktop:notifications.permission', { summary: summary ?? t('desktop:notifications.review') }); break;
    case 'question': body = t('desktop:notifications.question', { summary: summary ?? t('desktop:notifications.respond') }); break;
    case 'error': body = t('desktop:notifications.error', { summary: summary ?? t('desktop:notifications.turnFailed') }); break;
    case 'idle': body = summary ?? (steps > 0
      ? t('desktop:notifications.steps', { count: steps })
      : t('desktop:notifications.noReply')); break;
    default: body = summary ?? t('desktop:notifications.open');
  }
  return { title: normalized(preview.title) ?? 'Kraki', body,
    sessionId: typeof preview.sessionId === 'string' ? preview.sessionId : undefined };
}

/** Shared across Head/link routes; claim even a suppressed preview and persist across launches. */
export class DesktopNotificationPresenter {
  private ids: string[];
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly watching: (id: string) => boolean,
    private readonly post: (n: { title: string; body: string; sessionId?: string }) => void) {
    try {
      const saved: unknown = JSON.parse(storage.getItem(IDS_KEY) ?? '[]');
      this.ids = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string').slice(-CAPACITY) : [];
    } catch { this.ids = []; }
  }
  present(json: string): void {
    let preview: Record<string, unknown>;
    try { preview = JSON.parse(json); } catch { return; }
    if (!preview || typeof preview !== 'object') return;
    const nid = preview.nid;
    if (typeof nid === 'string' && nid.length > 0 && nid.length <= 64) {
      if (this.ids.includes(nid)) return;
      this.ids = [...this.ids, nid].slice(-CAPACITY);
      try { this.storage.setItem(IDS_KEY, JSON.stringify(this.ids)); } catch { /* storage unavailable */ }
    }
    if (!notificationsEnabled(this.storage)) return;
    const content = formatDesktopPreview(preview);
    if (!content.sessionId || this.watching(content.sessionId)) return;
    this.post(content);
  }
}

let presenter: DesktopNotificationPresenter | undefined;
export function presentDesktopPreview(json: string): void {
  if (!desktop) return;
  presenter ??= new DesktopNotificationPresenter(localStorage,
    (id) => document.visibilityState === 'visible' && document.hasFocus()
      && window.location.pathname === `/session/${id}`,
    (n) => desktop?.notify(n));
  presenter.present(json);
}
