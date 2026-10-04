/**
 * First-run setup in Kraki for Windows, with the Kraki built into the app —
 * the twin of Kraki for Mac's BuiltInSetupView (same steps and words):
 *
 *   intro       the logo entrance, once per PC
 *   chooseOwner a command-line Kraki already runs here: which one should?
 *   thisPC      Step 1 — which coding agents can run here. Skippable: this PC
 *               can be used only to control other computers.
 *   signIn      Step 2 — GitHub sign-in in a window of the app
 *               (`kraki setup --json --oauth`)
 *   background  run the built-in Kraki now and at every login
 *
 * Every step derives from live state (config, owner, daemon), so reopening
 * the app resumes at the right place.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { KrakiLogo } from '../KrakiLogo';
import type { BuiltInBridge, BuiltInState, SetupEvent } from '../../lib/desktop';
import { wsClient } from '../../lib/ws-client';
import { AgentsPanel, useAgentsCheck } from './AgentsPanel';
import './desktop-setup.css';

const ROLE_KEY = 'kraki-desktop.role';
const OWNER_KEY = 'kraki-desktop.owner';
const MOVED_KEY = 'kraki-desktop.movedFromCLI';
const INTRO_KEY = 'kraki-desktop.introShown';

type Role = 'undecided' | 'runsAgents' | 'remoteOnly';
type Owner = 'undecided' | 'builtIn' | 'external';

export type SetupStep = 'detecting' | 'chooseOwner' | 'thisPC' | 'signIn' | 'background' | 'done';

/** Pure: which step the live state calls for. */
export function setupStep(s: BuiltInState | null, role: Role, owner: Owner, movedFromCLI: boolean, signInAgain: boolean): SetupStep {
  if (!s) return 'detecting';
  if (s.configured && !s.owned && owner === 'undecided' && (s.cliDaemon || s.cliLogin)) return 'chooseOwner';
  if (owner === 'external' && s.configured && !signInAgain) return 'done';
  if (role === 'undecided' && (!s.configured || movedFromCLI)) return 'thisPC';
  if (!s.configured || signInAgain) return 'signIn';
  if (role === 'remoteOnly' || owner === 'external') return 'done';
  if (!(s.owned && s.running)) return 'background';
  return 'done';
}

function useStored<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => (localStorage.getItem(key) as T | null) ?? fallback);
  const set = useCallback((v: T) => { localStorage.setItem(key, v); setValue(v); }, [key]);
  return [value, set];
}

/** Set once the app tried the built-in Kraki's sign-in; a later sign-out means it was refused. */
let triedCredentials = false;

export function DesktopSetup({ builtIn }: { builtIn: BuiltInBridge }) {
  const [state, setState] = useState<BuiltInState | null>(null);
  const [role, setRole] = useStored<Role>(ROLE_KEY, 'undecided');
  const [owner, setOwner] = useStored<Owner>(OWNER_KEY, 'undecided');
  const [moved, setMoved] = useStored<'0' | '1'>(MOVED_KEY, '0');
  const [introDone, setIntroDone] = useState(() => localStorage.getItem(INTRO_KEY) === '1'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const [signInAgain] = useState(() => triedCredentials);

  const refresh = useCallback(async () => { setState(await builtIn.state()); }, [builtIn]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const step = setupStep(state, role, owner, moved === '1', signInAgain);

  const connected = useRef(false);
  useEffect(() => {
    if (step !== 'done' || connected.current) return;
    connected.current = true;
    triedCredentials = true;
    wsClient.connectWithDesktopCredentials();
  }, [step]);

  if (!introDone) {
    return <Intro onFinished={() => { localStorage.setItem(INTRO_KEY, '1'); setIntroDone(true); }} />;
  }

  return (
    <div className="ds-page" data-testid="desktop-setup">
      <Backdrop />
      <div className="ds-scroll">
        <div className="ds-card">
          {step === 'detecting' && <span className="ds-spinner" />}
          {step === 'chooseOwner' && (
            <ChooseOwner
              builtIn={builtIn}
              version={state?.version ?? null}
              onChosen={(o) => { if (o === 'builtIn') setMoved('1'); setOwner(o); void refresh(); }}
            />
          )}
          {step === 'thisPC' && (
            <ThisPCStep
              builtIn={builtIn}
              stepLabel={moved === '1' ? null : 'Step 1 of 2'}
              onContinue={() => { setRole('runsAgents'); setMoved('0'); }}
              onSkip={() => {
                setMoved('0');
                setRole('remoteOnly');
                if (state?.owned) void builtIn.disable().then(refresh);
              }}
            />
          )}
          {step === 'signIn' && (
            <SignInStep builtIn={builtIn} forceLogin={signInAgain} onDone={() => { triedCredentials = false; void refresh(); }} />
          )}
          {step === 'background' && <BackgroundStep builtIn={builtIn} onStarted={refresh} />}
          {step === 'done' && <Progress label="Connecting…" />}
        </div>
      </div>
    </div>
  );
}

function Backdrop() {
  return (
    <div className="ds-backdrop" aria-hidden="true">
      <div className="ds-glow ds-glow-a" />
      <div className="ds-glow ds-glow-b" />
    </div>
  );
}

/** Kraki for Mac's MacSetupIntro: circle-clip logo reveal, wordmark, tagline. */
function Intro({ onFinished }: { onFinished: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const finish = useCallback(() => {
    setLeaving(true);
    setTimeout(onFinished, 450);
  }, [onFinished]);
  useEffect(() => {
    const t = setTimeout(finish, 3200);
    return () => clearTimeout(t);
  }, [finish]);
  return (
    <div className="ds-page" onClick={finish} data-testid="desktop-intro">
      <Backdrop />
      <div className={leaving ? 'ds-intro ds-intro-leaving' : 'ds-intro'}>
        <KrakiLogo className="ds-intro-logo animate-logo-reveal" />
        <div className="ds-wordmark animate-fade-up">KRAKI</div>
        <div className="ds-tagline animate-fade-up-d2">Your coding agents, on every device</div>
      </div>
    </div>
  );
}

function StepCard({ step, title, detail, children }: { step?: string | null; title: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="ds-step">
      <div className="ds-step-head">
        {step && <div className="ds-step-label">{step}</div>}
        <div className="ds-step-title">{title}</div>
        <div className="ds-step-detail">{detail}</div>
      </div>
      {children}
    </div>
  );
}

function Progress({ label }: { label: string }) {
  return <div className="ds-progress"><span className="ds-spinner" />{label}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ds-section">
      <div className="ds-section-title">{title}</div>
      <div className="ds-section-body">{children}</div>
    </div>
  );
}

function ThisPCStep({ builtIn, stepLabel, onContinue, onSkip }: {
  builtIn: BuiltInBridge; stepLabel: string | null; onContinue: () => void; onSkip: () => void;
}) {
  const check = useAgentsCheck(builtIn);
  const blocking = check.readyCount === 0
    ? (check.running ? 'Checking the agents on this PC…' : 'Set up at least one coding agent, then click Check Again.')
    : null;
  return (
    <StepCard
      step={stepLabel}
      title="Set up this PC"
      detail="Kraki runs the coding agents installed on this PC, so you can use them from here, your phone and your other computers."
    >
      <div className="ds-stack">
        <Section title="Coding agents"><AgentsPanel check={check} /></Section>
        <div className="ds-actions">
          <button type="button" className="ds-button ds-button-primary ds-button-wide" disabled={!!blocking} onClick={onContinue} data-testid="desktop-setup-continue">
            Continue
          </button>
          {blocking && <div className="ds-muted">{blocking}</div>}
          <button type="button" className="ds-link" onClick={onSkip} data-testid="desktop-setup-skip">
            Skip — don't run agents on this PC, only control other computers
          </button>
        </div>
      </div>
    </StepCard>
  );
}

type SignInPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting' }
  | { kind: 'code'; code: string; uri: string }
  | { kind: 'configuring'; username: string }
  | { kind: 'failed'; message: string };

function SignInStep({ builtIn, forceLogin, onDone }: { builtIn: BuiltInBridge; forceLogin: boolean; onDone: () => void }) {
  const [phase, setPhase] = useState<SignInPhase>({ kind: 'idle' });
  useEffect(() => () => builtIn.cancelSetup(), [builtIn]);

  const start = useCallback(() => {
    setPhase({ kind: 'starting' });
    void builtIn.setup({ forceLogin }, (e: SetupEvent) => {
      if (e.event === 'oauth_url') setPhase({ kind: 'waiting' });
      else if (e.event === 'device_code') setPhase({ kind: 'code', code: e.userCode, uri: e.verificationUri });
      else if (e.event === 'authenticated') setPhase({ kind: 'configuring', username: e.username });
      else if (e.event === 'error') setPhase({ kind: 'failed', message: e.message });
    }).then((result) => {
      if (result.ok) onDone();
      else setPhase((p) => (p.kind === 'failed' ? p : { kind: 'failed', message: 'Sign-in did not finish. Try again.' }));
    });
  }, [builtIn, forceLogin, onDone]);

  if (phase.kind === 'starting') return <Progress label="Contacting GitHub…" />;
  if (phase.kind === 'configuring') {
    return <Progress label={phase.username ? `Signed in as ${phase.username}. Setting up…` : 'Setting up…'} />;
  }
  if (phase.kind === 'waiting') {
    return (
      <StepCard step="Step 2 of 2" title="Continue in the sign-in window" detail="Approve Kraki on GitHub. If you're already signed in to GitHub, that's one click.">
        <div className="ds-actions">
          <div className="ds-progress ds-muted"><span className="ds-spinner ds-spinner-mini" />Waiting for GitHub…</div>
          <button type="button" className="ds-button" onClick={() => { builtIn.cancelSetup(); setPhase({ kind: 'idle' }); }}>Cancel</button>
        </div>
      </StepCard>
    );
  }
  if (phase.kind === 'code') {
    return (
      <StepCard step="Step 2 of 2" title="Enter this code on GitHub" detail="Open GitHub in your browser, paste the code there and approve Kraki.">
        <div className="ds-actions">
          <div className="ds-device-code" data-testid="desktop-device-code">{phase.code}</div>
          <div className="ds-row">
            <button type="button" className="ds-button" onClick={() => { void navigator.clipboard.writeText(phase.code); window.open(phase.uri, '_blank'); }}>Copy Code &amp; Open GitHub</button>
            <button type="button" className="ds-button" onClick={() => { builtIn.cancelSetup(); setPhase({ kind: 'idle' }); }}>Cancel</button>
          </div>
        </div>
      </StepCard>
    );
  }
  return (
    <StepCard
      step="Step 2 of 2"
      title={forceLogin ? 'Sign in again' : 'Sign in'}
      detail={forceLogin
        ? 'Your sign-in has expired or was revoked. Sign in with GitHub to reconnect this PC.'
        : 'Sign in with GitHub. The coding agents on this PC become available here, on your phone and on your other computers.'}
    >
      <div className="ds-actions">
        <button type="button" className="ds-github" onClick={start} data-testid="desktop-setup-signin">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
          Sign in with GitHub
        </button>
        {phase.kind === 'failed' && <div className="ds-warning">{phase.message}</div>}
      </div>
    </StepCard>
  );
}

function BackgroundStep({ builtIn, onStarted }: { builtIn: BuiltInBridge; onStarted: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    void builtIn.enable().then(async (r) => {
      if (!live) return;
      if (r.ok) await onStarted();
      else setError(r.error ?? 'Kraki could not start.');
    });
    return () => { live = false; };
  }, [builtIn, onStarted, attempt]);
  if (!error) return <Progress label="Starting Kraki in the background…" />;
  return (
    <StepCard title="Kraki couldn't start" detail={error}>
      <div className="ds-row">
        <button type="button" className="ds-button ds-button-primary" onClick={() => setAttempt((n) => n + 1)}>Try Again</button>
        <button type="button" className="ds-button" onClick={() => builtIn.openLogs()}>Show Logs</button>
      </div>
    </StepCard>
  );
}

function ChooseOwner({ builtIn, version, onChosen }: { builtIn: BuiltInBridge; version: string | null; onChosen: (o: Owner) => void }) {
  const [switching, setSwitching] = useState<Owner | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (o: Owner) => {
    if (switching) return;
    setSwitching(o);
    setError(null);
    if (o === 'builtIn') {
      const r = await builtIn.enable();
      if (!r.ok) { setError(r.error ?? 'Could not switch.'); setSwitching(null); return; }
    }
    setSwitching(null);
    onChosen(o);
  };
  const option = (o: Owner, title: string, badge: string | null, detail: string) => (
    <button type="button" className={o === 'builtIn' ? 'ds-option ds-option-primary' : 'ds-option'} disabled={!!switching} onClick={() => { void choose(o); }} data-testid={`desktop-owner-${o}`}>
      <div className="ds-option-text">
        <div><span className="ds-option-title">{title}</span>{badge && <span className="ds-badge">{badge}</span>}</div>
        <div className="ds-option-detail">{detail}</div>
      </div>
      {switching === o ? <span className="ds-spinner" /> : <span className="ds-chevron" aria-hidden="true">›</span>}
    </button>
  );
  return (
    <div className="ds-step">
      <div className="ds-step-head">
        <div className="ds-step-title">Kraki is already set up on this PC</div>
        <div className="ds-step-detail">The command-line version of Kraki{version ? ` (${version})` : ''} already runs your agents in the background. You only need one of them.</div>
      </div>
      <div className="ds-stack">
        {option('builtIn', 'Use Kraki for Windows', 'Recommended', 'Kraki for Windows runs Kraki in the background and updates it with the app. Your sign-in and sessions carry over.')}
        {option('external', 'Keep the command-line version', null, 'Kraki for Windows uses the install you already have. You keep updating it from a terminal.')}
      </div>
      {error && <div className="ds-warning">{error}</div>}
      <div className="ds-muted">You can change this later in Settings → This PC.</div>
    </div>
  );
}
