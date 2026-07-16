import { test, expect, type Page, request } from '@playwright/test';

/**
 * REAL-STACK pulse end-to-end — the only test that runs
 *   real browser arm ⇄ real head hub ⇄ real tentacle
 * with pulse frames going the whole way, in BOTH directions.
 *
 * GOAL: every message type the A3 migration moved from raw WebSocket onto pulse
 * is triggered here by the SAME arm-webapp action a real user would take, and
 * asserted end to end. Four suites, grouped by the direction/kind they cover:
 *
 *  A. "A complete dev conversation" (steps 1–7) — the outbound RELIABLE_CONSUMER
 *     types on the happy path: send_input, answer, approve, delete_session, plus
 *     inbound agent_message / agent_message_delta / tool_start / tool_complete /
 *     question / permission, and the pulse resume + head durable-outbox properties.
 *
 *  B. "Live presence + preferences" (steps 8–11) — head→arm CONTROL over pulse
 *     (device_joined / device_left / device_removed / preferences_updated), i.e.
 *     the `{from:'@head'}` deliver-to-device path. A second tentacle joining/leaving
 *     and a second browser receiving a preference change drive these. These also
 *     REGRESSION-GUARD the arm bug where pulse-delivered @head control was routed
 *     to the session-data handler and silently dropped (fixed in handlePulseDelivered).
 *
 *  C. "Session metadata round-trips" (steps 12–14) — pin_session / mark_read /
 *     mark_unread / rename_session: an arm command rides pulse to the tentacle,
 *     which persists it and echoes a producer message back over pulse. Proof reads
 *     the tentacle's OWN session list back (/debug) — the field only changes there
 *     if the outbound pulse send actually arrived.
 *
 *  D. "Request/reply payloads" (steps 15–16) — request_session_messages_range →
 *     session_messages_range_batch (history backfill) and the attachment_data
 *     byte stream for an offloaded tool result. Both seeded so the ONLY way the
 *     browser can render the data is over the pulse request/stream.
 *
 * Not reachable through a real browser action (covered by unit/integration suites,
 * documented here so the gap is explicit, not silent):
 *   - register_push_token / unregister_push_token: need a real Service Worker +
 *     granted Notification permission + VAPID key — not drivable headless.
 *   - request_local_sessions / import_session: the tentacle's scanner reads a
 *     hardcoded ~/.copilot path and runs in-process here, so it can't be seeded
 *     without polluting the host home dir.
 *   - client_log: debug telemetry with no UI trigger and no force-flush.
 *   - device_pending: no arm handler / no UI reflects it.
 *
 * The tentacle is a MockAdapter, but the transport, head hub, SQLite durable
 * outbox, pulse framing, E2E crypto and browser render are all REAL. The tentacle
 * side is driven via the orchestrator's HTTP control plane
 * (scripts/pulse-realstack-server.ts).
 */

const CONTROL = process.env.REALSTACK_CONTROL_URL ?? 'http://localhost:4710';
const RELAY = process.env.REALSTACK_RELAY_URL ?? 'ws://localhost:4700';
const WEB_URL = process.env.REALSTACK_WEB_URL ?? 'http://localhost:3700';

/** Hit a control-plane endpoint on the orchestrator. */
async function control(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const ctx = await request.newContext();
  const qs = new URLSearchParams(params).toString();
  const res = await ctx.get(`${CONTROL}${path}${qs ? `?${qs}` : ''}`);
  const body = await res.json();
  await ctx.dispose();
  if (!res.ok()) throw new Error(`control ${path} failed: ${JSON.stringify(body)}`);
  return body;
}

/** Pair the browser to the real relay. Returns the pre-seeded session id once
 *  the arm is connected (the tentacle device is visible in the sidebar). The
 *  session is created by the orchestrator before any browser connects, so it
 *  arrives via session_list on pairing. */
async function pairBrowser(page: Page): Promise<string> {
  const { token, web, sessionId } = await control('/token');
  await page.goto(web as string);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${web}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  // Connected once the tentacle device shows up in the sidebar.
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  return sessionId as string;
}

/** Open a specific session's chat view. Waits for its card to appear in the
 *  sidebar (proving the session was delivered over the encrypted channel), then
 *  navigates to it and waits for the ChatView to mount. Targets the session by id
 *  rather than a "Mock-agent" title match, since several seeded sessions share
 *  that title. */
async function openSessionChat(page: Page, sessionId: string): Promise<void> {
  await expect(page.getByRole('button', { name: /Mock-agent/ }).first())
    .toBeVisible({ timeout: 15_000 });
  await page.goto(`${WEB_URL}/session/${sessionId}`);
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 10_000 });
}

test.describe.serial('real-stack pulse: a complete dev conversation', () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // The session is pre-seeded by the orchestrator BEFORE any browser connects
    // (mirrors dev-demo), so it's reliably delivered via session_list on pairing.
    // One shared page/context for the whole conversation (a real session).
    page = await browser.newPage();
    sessionId = await pairBrowser(page);
    await openSessionChat(page, sessionId);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('1. user types a prompt → arrives at the tentacle over pulse', async () => {
    const prompt = 'the auth test is failing, can you take a look?';
    // Session must be idle for the send button to fire.
    await control('/idle', { sid: sessionId });
    const input = page.getByPlaceholder('Send a message…');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(prompt);
    await input.press('Enter');

    // The user's bubble renders locally...
    await expect(page.locator('[data-chat-scroll]').getByText(prompt)).toBeVisible({ timeout: 10_000 });
    // ...and the prompt actually reached the tentacle adapter over pulse.
    await expect.poll(async () => {
      const { messages } = await control('/received');
      return (messages as Array<{ text: string }>).some((m) => m.text === prompt);
    }, { timeout: 15_000, message: 'send_input never reached the tentacle over pulse' }).toBe(true);
  });

  test('2. agent streams then completes a reply → renders in the browser', async () => {
    // Stream a few deltas (realistic), then the completed message.
    await control('/delta', { sid: sessionId, text: 'Looking at the auth suite' });
    await control('/delta', { sid: sessionId, text: '…\nfound it: a stale token in the fixture.' });
    const reply = 'Found it — the auth fixture ships a stale token. I can fix it.';
    await control('/msg', { sid: sessionId, text: reply });
    await control('/idle', { sid: sessionId });

    await expect(page.locator('[data-chat-scroll]').getByText('stale token', { exact: false }))
      .toBeVisible({ timeout: 15_000 });
  });

  test('3. agent runs a tool → tool activity renders', async () => {
    // A real trace-bearing turn starts with a user_message. The previous test's
    // turn is already idle, so begin a fresh one through the browser before the
    // adapter emits tool activity.
    const prompt = 'run the auth tests now';
    const input = page.getByPlaceholder('Send a message…');
    await input.fill(prompt);
    await input.press('Enter');
    await expect.poll(async () => {
      const { messages } = await control('/received');
      return (messages as Array<{ text: string }>).some((m) => m.text === prompt);
    }, { timeout: 15_000 }).toBe(true);

    await control('/toolStart', { sid: sessionId, tool: 'bash', cmd: 'npm test -- auth' });
    // The tool chip renders the toolName + command headline. During the running
    // phase it's prefixed with "Running"; once complete the prefix drops but the
    // chip (bash + the command) stays. Assert the durable signal — the command
    // headline — which is present in both phases and survives the fast complete.
    const chip = page.locator('[data-chat-scroll]').getByText(/npm test -- auth/i);
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await control('/toolComplete', { sid: sessionId, tool: 'bash', result: '1 failing: auth.test.ts' });
    await control('/msg', { sid: sessionId, text: 'The auth test still has one failing assertion.' });
    await control('/idle', { sid: sessionId });
    // Completed tool activity moves under the concluding bubble's TRACE-axis
    // Steps affordance. Open it and verify the command survives there.
    const steps = page.locator('[data-chat-scroll]').getByRole('button', { name: 'Open steps' }).last();
    await expect(steps).toBeVisible({ timeout: 10_000 });
    await steps.click();
    const stepsDialog = page.getByRole('dialog');
    await expect(stepsDialog.getByText(/npm test -- auth/i)).toBeVisible({ timeout: 10_000 });
    await stepsDialog.click({ position: { x: 4, y: 4 } });
    await expect(stepsDialog).toHaveCount(0);
  });

  test('4. agent asks a question → user clicks a choice → answer reaches tentacle over pulse', async () => {
    await control('/question', {
      sid: sessionId, id: 'q-suite',
      text: 'Which suite should I re-run after the fix?',
      choices: 'auth only|the full suite',
    });
    // The question prompt renders (in the chat; may also appear as a sidebar
    // preview — scope to the chat area and take the first match).
    await expect(page.locator('[data-chat-scroll]').getByText('Which suite', { exact: false }).first())
      .toBeVisible({ timeout: 15_000 });
    // ...and its choices are clickable buttons.
    const choice = page.getByRole('button', { name: 'auth only' });
    await expect(choice).toBeVisible({ timeout: 10_000 });
    await choice.click();

    await expect.poll(async () => {
      const { answers } = await control('/answers');
      return (answers as Array<{ answer: string }>).some((a) => a.answer === 'auth only');
    }, { timeout: 15_000, message: 'answer never reached the tentacle over pulse' }).toBe(true);
  });

  test('5. agent requests permission → user approves → approve reaches tentacle over pulse', async () => {
    await control('/perm', {
      sid: sessionId, id: 'perm-run',
      tool: 'shell', desc: 'run npm test -- auth to verify the fix',
    });
    // The permission card renders in the action zone (below the message list,
    // outside [data-chat-scroll]) — assert at the page level. It shows the
    // "Permission Required" header + the description.
    await expect(page.getByText('run npm test -- auth', { exact: false }).first())
      .toBeVisible({ timeout: 15_000 });
    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(approve).toBeVisible({ timeout: 10_000 });
    await approve.click();

    // The approve control resolves (card no longer offers Approve)...
    await expect(approve).toBeHidden({ timeout: 10_000 });
    // ...and the decision reached the tentacle over pulse.
    await expect.poll(async () => {
      const { responses } = await control('/permResponses');
      return (responses as Array<{ decision: string }>).some((r) => r.decision === 'approve');
    }, { timeout: 15_000, message: 'approve never reached the tentacle over pulse' }).toBe(true);
    await control('/idle', { sid: sessionId });
  });

  test('6. reconnect resume: a message sent while offline arrives after reconnect', async () => {
    // Browser drops offline; the head pulse outbox must buffer inbound sends.
    await page.context().setOffline(true);
    const buffered = 'Fixed the fixture and the auth suite is green now.';
    await control('/msg', { sid: sessionId, text: buffered });
    await control('/idle', { sid: sessionId });
    await page.waitForTimeout(1_000);

    // Reconnect — pulse resume must deliver the buffered message (nothing lost).
    await page.context().setOffline(false);
    await expect(page.locator('[data-chat-scroll]').getByText('auth suite is green', { exact: false }).first())
      .toBeVisible({ timeout: 25_000 });
  });

  test('7. delete_session travels arm → head → tentacle over pulse', async () => {
    // Delete the session from the browser. The affordance lives in the session
    // card's context menu (right-click) → "Delete session" → confirm "Delete".
    // delete_session is a durable-flagged reliable pulse send; here the tentacle
    // is online, so we assert it reaches the tentacle and invokes killSession.
    //
    // NOTE on the "durable while tentacle OFFLINE" variant: the arm's delete does
    // ride the durable pulse outbox, but proving redelivery across a tentacle
    // disconnect needs the tentacle to reconnect with the SAME deviceId. A real
    // tentacle persists its id (getOrCreateDeviceId); this test harness's
    // RelayClient re-auths as a fresh device on reconnect (open auth mints a new
    // id), which orphans the outbox — a harness-identity limitation, not a pulse
    // defect. The durable-resume property itself is already proven by step 6
    // (browser-side) and the Node pulse-e2e suite.
    const card = page.getByRole('button', { name: /Mock-agent/ }).first();
    await card.click({ button: 'right' });
    await page.getByRole('button', { name: /Delete session/i }).click();
    await page.getByRole('button', { name: /^Delete$/ }).click();

    // The delete reaches the tentacle over pulse and kills the session.
    await expect.poll(async () => {
      const { killed } = await control('/killed');
      return (killed as string[]).includes(sessionId);
    }, { timeout: 20_000, message: 'delete_session never reached the tentacle over pulse' }).toBe(true);
  });
});

/**
 * PRESENCE + PREFERENCES over pulse — the head→arm control path (A3f).
 *
 * These are the messages the head ORIGINATES and pushes to a device over pulse
 * (wrapped as `{from:'@head', msg}`): device_joined / device_left / device_removed
 * (presence) and preferences_updated (settings fan-out). Unlike the initial device
 * roster — which rides `auth_ok` on raw WS at connect time — these fire while the
 * browser is ALREADY connected, so they exercise the live pulse control path.
 *
 * Regression context: the arm's pulse-delivery routed `{from:'@head'}` control
 * through the session-data handler (handleDataMessage), which drops any message
 * without a sessionId — silently swallowing all of these. The tentacle routed the
 * same envelope through its full handler. These tests fail on the un-fixed arm and
 * pass once handlePulseDelivered routes `@head` control to handleMessage.
 */
test.describe.serial('real-stack pulse: live presence + preferences (head→arm control)', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await pairBrowser(page);
    // Ensure tentacle2 starts disconnected + a known light theme baseline.
    await control('/tentacle2/disconnect');
  });

  test.afterAll(async () => {
    await control('/tentacle2/disconnect');
    await page?.close();
  });

  test('8. a second device joining appears live (device_joined over pulse)', async () => {
    // The first tentacle is already visible (via auth_ok on pair). tentacle2
    // connects AFTER the browser is up → the head broadcasts device_joined over
    // pulse. The arm must reflect it live in the Devices strip.
    await expect(tentacle2Name(page)).toHaveCount(0);
    await control('/tentacle2/connect');
    // Appears (the DeviceList strip may render the name more than once; assert ≥1).
    await expect.poll(async () => tentacle2Name(page).count(), { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  test('9. that device leaving disappears live (device_left over pulse)', async () => {
    // Sanity: it's currently visible from step 8.
    expect(await tentacle2Name(page).count()).toBeGreaterThan(0);
    await control('/tentacle2/disconnect');
    // DeviceList shows only ONLINE tentacles → device_left removes it from the strip.
    await expect(tentacle2Name(page)).toHaveCount(0, { timeout: 20_000 });
  });

  test('10. removing an offline device removes it live (remove_device → device_removed)', async () => {
    // Bring tentacle2 back, then drop it so it's offline-but-known (removable).
    await control('/tentacle2/connect');
    await expect.poll(async () => tentacle2Name(page).count(), { timeout: 20_000 })
      .toBeGreaterThan(0);
    await control('/tentacle2/disconnect');

    // The DeviceGrid (/devices) shows offline devices too. Select tentacle2 and
    // remove it — remove_device rides pulse to the head (@head deliver-to-self),
    // the head deletes it and broadcasts device_removed back over pulse.
    await page.goto(`${WEB_URL}/devices`);
    const deviceBtn = page.getByRole('button', { name: /RealStack Tentacle 2/ });
    await expect(deviceBtn.first()).toBeVisible({ timeout: 15_000 });
    await deviceBtn.first().click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: /Remove permanently/i }).click();

    // device_removed over pulse deletes it from the store → gone from the grid.
    await expect(page.getByRole('button', { name: /RealStack Tentacle 2/ }))
      .toHaveCount(0, { timeout: 20_000 });
  });

  test('11. a preference change fans out to another browser live (preferences_updated over pulse)', async ({ browser }) => {
    // A SECOND browser (same open-auth user `local`). When browser 1 changes a
    // preference, the head persists it and fans preferences_updated out to the
    // user's OTHER devices over pulse — browser 2 must apply it live even though
    // it never toggled anything locally.
    const page2 = await browser.newPage();
    try {
      await pairBrowser(page2);

      // Baseline: force BOTH browsers to light via browser 1, so the assertion
      // (browser 2 flips to dark) is unambiguous regardless of prior test state.
      await openSettings(page);
      await setDarkMode(page, false);
      await expect(page2.locator('html')).not.toHaveClass(/dark/, { timeout: 20_000 });

      // Browser 1 turns dark mode ON → update_preferences → head fan-out.
      await setDarkMode(page, true);

      // Browser 2 (which did nothing) goes dark from the pulse-delivered
      // preferences_updated. THIS is the head→arm control path the bug broke.
      await expect(page2.locator('html')).toHaveClass(/dark/, { timeout: 20_000 });
    } finally {
      await page2.close();
    }
  });
});

/**
 * SESSION METADATA round-trips over pulse — arm→tentacle command + the tentacle's
 * confirming producer message back, both hops on pulse. Each asserts a visible UI
 * change that can ONLY happen if the outbound command reached the tentacle AND its
 * reply (session_pinned / session_read / session_title_updated) came back over pulse
 * and was applied. One user gesture proves both directions.
 *
 * Runs in its own browser/session (re-seeds via a fresh pairing) so it's independent
 * of the conversation block's deletions.
 */
test.describe.serial('real-stack pulse: session metadata round-trips', () => {
  let page: Page;
  let sessionId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    // A fresh session for metadata ops (the seeded one may have been deleted by
    // the conversation block). Create it on the tentacle before we assert.
    sessionId = `meta-${Date.now().toString(36)}`;
    await control('/createSession', { id: sessionId });
    await control('/msg', { sid: sessionId, text: 'metadata round-trip session' });
    await control('/idle', { sid: sessionId });
    await pairBrowser(page);
    // The metadata session card must be present in the sidebar.
    await expect(metaCard(page)).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('12. pin round-trips (pin_session over pulse → tentacle persists it)', async () => {
    // Right-click the card → "Pin to top". pin_session rides pulse to the tentacle,
    // which persists it (SessionManager.setPin). Prove it REACHED the tentacle by
    // reading the tentacle's own session list back — pinned flips to true there
    // only if the outbound pulse send arrived.
    await openCardMenu(page, metaCard(page));
    await page.getByRole('button', { name: /Pin to top/i }).click();
    await expect.poll(() => sessionField(sessionId, 'pinned'), {
      timeout: 15_000, message: 'pin_session never reached the tentacle over pulse',
    }).toBe(true);

    // Reverse: unpin → the tentacle clears it.
    await openCardMenu(page, metaCard(page));
    await page.getByRole('button', { name: /Unpin/i }).click();
    await expect.poll(() => sessionField(sessionId, 'pinned'), { timeout: 15_000 })
      .toBeFalsy();
  });

  test('13. mark unread round-trips over pulse (readSeq rolls back on the tentacle)', async () => {
    // Seed the session as READ on the tentacle first (readSeq = lastSeq), so the
    // subsequent UI "Mark unread" produces an OBSERVABLE rollback. (We seed the
    // read side rather than drive it from the UI because the manual "Mark read"
    // affordance can't resolve a seq from the sidebar digest — mark_unread is the
    // reliably-triggerable direction, and it's what carries no seq over pulse.)
    await control('/read', { sid: sessionId });
    await expect.poll(async () => {
      const s = await session(sessionId);
      return s ? (s.readSeq as number) >= (s.lastSeq as number) : false;
    }, { timeout: 10_000 }).toBe(true);
    // Reload so the arm picks up the read state from session_list, then WAIT until
    // the card menu actually offers "Mark unread" (proves the arm reconciled to
    // read — otherwise the menu would still show "Mark read" and the click below
    // would target a missing button).
    await page.reload();
    await expect(metaCard(page)).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => (window as unknown as { _pulseTraceEnable?: () => void })._pulseTraceEnable?.());
    // Open once and click immediately. Retrying the whole open operation toggles
    // an already-open context menu closed and can make the later click hit an
    // unrelated control at the same screen position.
    await openCardMenu(page, metaCard(page));
    const markUnread = page.getByRole('button', { name: 'Mark unread', exact: true });
    await expect(markUnread).toBeVisible({ timeout: 20_000 });

    // Mark it UNREAD → mark_unread rides pulse to the tentacle, which rolls readSeq
    // back below lastSeq. Reading the tentacle's own session list back proves it.
    await markUnread.evaluate((button: HTMLButtonElement) => button.click());
    const sendTrace = await page.evaluate(() => (window as unknown as { _pulseTrace?: Array<Record<string, unknown>> })._pulseTrace ?? []);
    expect(sendTrace.some((e) => e.evt === 'APP-SEND-ENCRYPTED' && e.type === 'mark_unread')).toBe(true);
    expect(sendTrace.some((e) => e.evt === 'APP-ENCRYPT-OK' && e.type === 'mark_unread')).toBe(true);
    expect(sendTrace.some((e) => e.evt === 'PULSE-SEND')).toBe(true);
    await expect.poll(async () => {
      const s = await session(sessionId);
      return s ? (s.readSeq as number) < (s.lastSeq as number) : false;
    }, { timeout: 15_000, message: 'mark_unread never reached the tentacle over pulse' }).toBe(true);
  });

  test('14. rename round-trips (rename_session over pulse → title updates)', async () => {
    // Rename lives in the SessionInfoPanel. On desktop the session's "Session
    // settings" button navigates to /devices?device=&session=, which mounts the
    // panel for THIS session. Open the chat first so that button is present.
    const newTitle = `Renamed ${Date.now().toString(36)}`;
    await page.goto(`${WEB_URL}/session/${sessionId}`);
    const settingsButton = page.getByRole('button', { name: 'Session settings' });
    await expect(settingsButton).toBeVisible({ timeout: 10_000 });
    await settingsButton.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page).toHaveURL(new RegExp(`/devices\\?.*session=${sessionId}`), { timeout: 10_000 });

    // The panel's title is a button; click it to reveal the edit input.
    const panel = page.locator('main');
    const input = panel.getByPlaceholder('Session title…');
    if (!(await input.isVisible().catch(() => false))) {
      await panel.getByRole('button', { name: /mock-agent · mock-v1/i }).last().click();
    }
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(newTitle);
    await input.press('Enter');

    // Prove it reached the tentacle: the tentacle's stored title is the new one.
    await expect.poll(() => sessionField(sessionId, 'title'), {
      timeout: 15_000, message: 'rename_session never reached the tentacle over pulse',
    }).toBe(newTitle);
    // And it renders back in the browser (session_title_updated over pulse).
    await expect(page.getByText(newTitle).first()).toBeVisible({ timeout: 15_000 });
  });
});

/**
 * REQUEST/REPLY payloads over pulse — the arm asks the tentacle for data and the
 * tentacle streams it back, both directions on pulse:
 *   - request_session_messages_range → session_messages_range_batch (history backfill)
 *   - request_attachment → attachment_data (lazy content pull)
 *
 * Both are seeded so the ONLY way the browser can render the data is by issuing
 * the pulse request (the bodies/bytes are not pushed live to this browser).
 */
test.describe.serial('real-stack pulse: request/reply payloads', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await pairBrowser(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('15. opening a long session backfills history (request_session_messages_range over pulse)', async () => {
    // The orchestrator pre-seeded a 60-message session BEFORE this browser paired,
    // so the browser knows its lastSeq (from session_list) but holds NONE of the
    // bodies. Opening it fires request_session_messages_range for the last 50; the
    // tentacle replies with session_messages_range_batch over pulse.
    await page.goto(`${WEB_URL}/session/realstack-history`);
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    // A message from the backfilled window (11..60) renders — proof the range
    // request round-tripped over pulse (nothing was pushed live to this browser).
    await expect(page.locator('[data-chat-scroll]').getByText('history line 60 of 60'))
      .toBeVisible({ timeout: 20_000 });
  });

  test('16. a tool result attachment is pulled over pulse (request_attachment → attachment_data)', async () => {
    // Drive a tool whose result is offloaded to a ContentRef (the tentacle's
    // AttachmentStore). After it's stored, RELOAD the browser: the tool_complete
    // replays with its resultRef but the bytes are not in this fresh page's memory,
    // so expanding the chip fires request_attachment over pulse and the tentacle
    // streams attachment_data back — a deterministic pull (no push race).
    const marker = `ATTACH-${Date.now().toString(36)}`;
    const result = `${marker} ${'x'.repeat(2000)}`; // offloaded to a ref (single chunk)
    const attachmentSession = `attachment-${Date.now().toString(36)}`;
    await control('/createSession', { id: attachmentSession });
    await control('/idle', { sid: attachmentSession });
    await page.goto(`${WEB_URL}/session/${attachmentSession}`);
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    const input = page.getByPlaceholder('Send a message…');
    const prompt = `inspect attachment ${marker}`;
    await input.fill(prompt);
    await input.press('Enter');
    await expect.poll(async () => {
      const { messages } = await control('/received');
      return (messages as Array<{ text: string }>).some((m) => m.text === prompt);
    }, { timeout: 15_000 }).toBe(true);
    const ref = await control('/toolRef', { sid: attachmentSession, tool: 'bash', cmd: 'cat big.txt', result });
    // The tentacle must have offloaded the result to its AttachmentStore, else
    // there is no ref to pull and the test is meaningless.
    expect(ref.stored as number).toBeGreaterThan(0);

    // Reload so the resultRef renders from replay with no cached bytes → pull.
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    const steps = page.locator('[data-chat-scroll]').getByRole('button', { name: 'Open steps' }).last();
    await expect(steps).toBeVisible({ timeout: 20_000 });
    await steps.click();
    const chip = page.getByRole('dialog').getByRole('button', { name: /cat big\.txt/i }).first();
    await expect(chip).toBeVisible({ timeout: 20_000 });
    // Expand the tool row → ToolResultBody pulls the bytes over pulse and renders
    // the offloaded result text (the marker lives only inside attachment bytes).
    const markerText = page.getByRole('dialog').getByText(marker, { exact: false }).first();
    await expect(async () => {
      if (!(await markerText.isVisible().catch(() => false))) {
        await chip.click();
      }
      await expect(markerText).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
  });
});

/** The metadata session's card in the sidebar. Scope by its unique preview text
 *  ("metadata round-trip session") so we never grab a different Mock-agent card
 *  (the sidebar also holds the seed + history sessions, all titled "Mock-agent"). */
function metaCard(page: Page) {
  return page.getByRole('button', { name: /metadata round-trip session/ }).first();
}

/** Read one session's record from the tentacle's own session list (via /debug).
 *  This is the tentacle-side truth: a field changes here only after the arm's
 *  outbound command actually reached the tentacle over pulse. */
async function session(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const { sessions } = await control('/debug');
  return (sessions as Array<Record<string, unknown>>).find((s) => s.id === sessionId);
}

/** Convenience: one field of a session's tentacle-side record. */
async function sessionField(sessionId: string, field: string): Promise<unknown> {
  return (await session(sessionId))?.[field];
}

/** Right-click a session card and wait for its context menu to be open. The menu
 *  closes on the next window click, so re-open it if a prior interaction closed it. */
async function openCardMenu(page: Page, card: ReturnType<Page['getByRole']>): Promise<void> {
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    await card.click({ button: 'right' });
    // "Delete session" is the menu's last item — a reliable open signal.
    await expect(page.getByRole('button', { name: /Delete session/i })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/** The tentacle-2 name as rendered in the Devices strip. `exact: true` matches
 *  only the leaf element whose text content is exactly this string (the name
 *  <span>), not the ancestor button/spans that merely contain it — avoids a
 *  strict-mode multi-match. */
function tentacle2Name(page: Page) {
  return page.getByText('RealStack Tentacle 2', { exact: true });
}

/** Open the desktop Settings slide-over (gear in the sidebar header). Waits for
 *  the app to be interactive first, and retries the open until the panel's
 *  "Dark mode" row is on screen (the slide-over animates in). Two SettingsPanels
 *  exist in the DOM (mobile inline + desktop slide-over); the mobile one is
 *  display:none on desktop, so scope every query to the VISIBLE match. */
async function openSettings(page: Page): Promise<void> {
  await page.goto(WEB_URL);
  // App is interactive once the sidebar renders the paired tentacle.
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  const gear = page.getByRole('button', { name: 'Settings' });
  await expect(gear).toBeVisible({ timeout: 15_000 });
  const darkRow = page.getByText('Dark mode').filter({ visible: true });
  await expect(async () => {
    if (!(await darkRow.isVisible().catch(() => false))) {
      await gear.click();
    }
    await expect(darkRow).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
}

/** Toggle dark mode to a target state via the Settings panel switch (role="switch"
 *  + aria-label). The slide-over positions the switch such that a real mouse click
 *  can land outside the viewport, so we dispatch the click event directly — it fires
 *  the same React onClick that a user's tap would, without the viewport/actionability
 *  gate. Two panels exist in the DOM; scope to the visible one. */
async function setDarkMode(page: Page, wantDark: boolean): Promise<void> {
  const isDark = async () => (await page.locator('html').getAttribute('class'))?.includes('dark') ?? false;
  if ((await isDark()) === wantDark) return;
  const toggle = page.getByRole('switch', { name: 'Toggle dark mode' }).filter({ visible: true });
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  await toggle.dispatchEvent('click');
  await expect.poll(isDark, { timeout: 10_000 }).toBe(wantDark);
}
