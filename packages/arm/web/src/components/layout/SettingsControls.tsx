import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import './settings.css';

export function SettingsSection({ title, children, footer }: { title?: string; children: ReactNode; footer?: string }) {
  return (
    <section className={`kp-section${title ? '' : ' kp-section-untitled'}`}>
      {title && <h3>{title}</h3>}
      <div className="kp-group">{children}</div>
      {footer && <p className="kp-section-footer">{footer}</p>}
    </section>
  );
}
export function SettingsRow({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div className="kp-row">
      {detail ? <div className="min-w-0"><p>{label}</p><p className="kp-foot">{detail}</p></div> : <span>{label}</span>}
      {children}
    </div>
  );
}
export function SettingsSwitch({
  label,
  on,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="kp-switch"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  );
}
export function SettingsAlert({
  title,
  body,
  confirm,
  onConfirm,
  onCancel,
  testId,
  stacked = false,
  viewport = false,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
  stacked?: boolean;
  viewport?: boolean;
}) {
  const { t } = useTranslation('settings');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onCancel();
      }
      if (e.key === 'Tab') {
        const buttons = ref.current?.querySelectorAll('button');
        if (!buttons?.length) return;
        if (e.shiftKey && (document.activeElement === buttons[0] || document.activeElement === ref.current)) {
          e.preventDefault();
          buttons[buttons.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
          e.preventDefault();
          buttons[0].focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      previous?.focus();
    };
  }, [onCancel]);
  return (
    <div
      className={`kp-alert-backdrop${viewport ? ' kp-alert-viewport' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={`kp-alert${stacked ? ' kp-alert-stacked' : ''}${body ? '' : ' kp-alert-no-body'}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
      >
        <h3>{title}</h3>
        {body && <p>{body}</p>}
        <div className={`kp-alert-actions${stacked ? ' is-stacked' : ''}`}>
          <button type="button" onClick={onCancel}>
            {t('actions.cancel')}
          </button>
          <button type="button" className="is-destructive" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
