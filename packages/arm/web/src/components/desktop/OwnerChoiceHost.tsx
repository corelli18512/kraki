/**
 * A command-line Kraki already runs the agents on this PC and the user has
 * not said which Kraki should: ask once, over the signed-in window — Kraki for
 * Mac's ExistingCLIChoicePresenter. Choosing Kraki for Windows stops the CLI's
 * background service and its login entry; sign-in and sessions carry over.
 */
import { useEffect, useState } from 'react';
import { desktop, type BuiltInState } from '../../lib/desktop';
import { ChooseOwner, OWNER_KEY } from './DesktopSetup';
import './desktop-setup.css';

/** Pure: whether to ask (exported for tests). */
export function needsOwnerChoice(s: BuiltInState | null, stored: string | null): boolean {
  return !!s && s.available && !s.owned && (s.cliDaemon || s.cliLogin) && (stored ?? 'undecided') === 'undecided';
}

export function OwnerChoiceHost() {
  const builtIn = desktop?.builtIn;
  const [state, setState] = useState<BuiltInState | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!builtIn) return;
    let live = true;
    void builtIn.state().then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [builtIn]);
  if (!builtIn || done || !needsOwnerChoice(state, localStorage.getItem(OWNER_KEY))) return null;
  return (
    <div className="ds-sheet-backdrop ds-owner-backdrop" data-testid="owner-choice">
      <div className="ds-sheet ds-owner-sheet" role="dialog" aria-modal="true" aria-label="Which Kraki runs your agents">
        <ChooseOwner
          builtIn={builtIn}
          version={state?.version ?? null}
          onChosen={(o) => {
            localStorage.setItem(OWNER_KEY, o);
            if (o === 'builtIn') localStorage.setItem('kraki-desktop.role', 'runsAgents');
            setDone(true);
          }}
        />
      </div>
    </div>
  );
}
