import type { SessionSubscriptionSetMessage } from '@kraki/protocol';

export interface SubscriptionControllerHost {
  isConnected(): boolean;
  resolveTentacle(sessionId: string): string | undefined;
  send(tentacleId: string, sessionId: string | null, requestId: string): Promise<boolean>;
  /** True when this Tentacle is reached without the Head (desktop local link):
   *  its authority survives a Head disconnect and it can be driven meanwhile. */
  isRouteIndependent?(tentacleId: string): boolean;
  applySnapshot(msg: SessionSubscriptionSetMessage): void;
  reportError(message: string): void;
}

interface InFlight {
  tentacleId: string;
  sessionId: string | null;
  requestId: string;
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Serial single-session subscription assure.
 *
 * - At most one request is in flight.
 * - session_list from a tentacle is the reconnect inbound barrier.
 * - Same-tentacle A→B is one atomic replace request.
 * - Cross-tentacle X→Y confirms X:null before subscribing on Y.
 * - Rapid desired changes coalesce to the final value.
 */
export class SessionSubscriptionController {
  private desiredSessionId: string | null = null;
  private confirmedSessionId: string | null = null;
  private confirmedTentacleId: string | null = null;
  private inFlight: InFlight | null = null;
  private barriers = new Set<string>();
  private blockedDesired: string | null = null;

  constructor(private readonly host: SubscriptionControllerHost) {}

  get desired(): string | null { return this.desiredSessionId; }
  get confirmed(): string | null { return this.confirmedSessionId; }
  get liveReady(): boolean {
    return this.desiredSessionId !== null && this.confirmedSessionId === this.desiredSessionId;
  }

  setDesired(sessionId: string | null): void {
    if (this.desiredSessionId !== sessionId) {
      this.blockedDesired = null;
      // Stop accepting the previous session's high-frequency live frames as
      // soon as navigation changes. Keep confirmedTentacleId until its null
      // ACK when crossing tentacles, so the old authority is still released.
      if (this.confirmedSessionId !== sessionId) this.confirmedSessionId = null;
    }
    this.desiredSessionId = sessionId;
    this.drive();
  }

  /** Reset connection-scoped authority while retaining the page's desired value. */
  onDisconnected(): void {
    const keeps = (id: string) => this.host.isRouteIndependent?.(id) === true;
    if (!this.confirmedTentacleId || !keeps(this.confirmedTentacleId)) {
      this.confirmedSessionId = null;
      this.confirmedTentacleId = null;
    }
    if (this.inFlight && !keeps(this.inFlight.tentacleId)) this.inFlight = null;
    for (const id of [...this.barriers]) if (!keeps(id)) this.barriers.delete(id);
    this.blockedDesired = null;
  }

  /** Re-evaluate after the Head reconnects. */
  resume(): void {
    this.drive();
  }

  /** A tentacle connection epoch ended or was replaced while the Arm stayed
   *  connected. Tentacle rebuilds its in-memory subscription authority as null
   *  after every auth, so revoke any old local confirmation. The next post-auth
   *  session_list re-establishes the barrier and drives a fresh request. */
  onTentacleAuthorityReset(tentacleId: string): void {
    this.barriers.delete(tentacleId);
    if (this.confirmedTentacleId === tentacleId) {
      this.confirmedSessionId = null;
      this.confirmedTentacleId = null;
    }
    if (this.inFlight?.tentacleId === tentacleId) this.inFlight = null;
    if (this.desiredSessionId && this.host.resolveTentacle(this.desiredSessionId) === tentacleId) {
      this.blockedDesired = null;
    }
    this.drive();
  }

  /** Current post-auth session_list from this tentacle is the inbound barrier. */
  onSessionList(tentacleId: string): void {
    this.barriers.add(tentacleId);
    if (this.desiredSessionId && this.host.resolveTentacle(this.desiredSessionId) === tentacleId) {
      this.blockedDesired = null;
    }
    this.drive();
  }

  acceptsLive(sessionId: string): boolean {
    return this.confirmedSessionId !== null && sessionId === this.confirmedSessionId;
  }

  onAck(msg: SessionSubscriptionSetMessage): void {
    const flight = this.inFlight;
    if (!flight) return;
    if (msg.deviceId !== flight.tentacleId) return;
    if (msg.payload.sessionId !== flight.sessionId) return;
    // A newer Tentacle echoes the request id; an ACK of an earlier request to
    // the same target (still in flight on a replaced route) is stale. Older
    // Tentacles echo nothing and are matched as before.
    const echoed = (msg.payload as { requestId?: string }).requestId;
    if (echoed !== undefined && echoed !== flight.requestId) return;

    this.inFlight = null;
    if (!msg.payload.accepted) {
      if (flight.sessionId === this.desiredSessionId) {
        this.blockedDesired = flight.sessionId;
        this.host.reportError(msg.payload.error.message);
      }
      this.drive();
      return;
    }

    if (msg.payload.sessionId === null) {
      this.confirmedSessionId = null;
      this.confirmedTentacleId = null;
    } else {
      // The matching ACK establishes remote ownership even if navigation has
      // moved on: drive() still needs to replace it or release this Tentacle.
      // Only the currently desired session may restore local live authority.
      this.confirmedTentacleId = msg.deviceId;
      this.confirmedSessionId = null;
      if (msg.payload.sessionId === this.desiredSessionId) {
        this.host.applySnapshot(msg);
        this.confirmedSessionId = msg.payload.sessionId;
      }
    }
    this.drive();
  }

  private drive(): void {
    if (this.inFlight) return;

    const desired = this.desiredSessionId;
    const desiredTentacle = desired ? this.host.resolveTentacle(desired) : undefined;
    const independent = (id: string | null | undefined) => !!id && this.host.isRouteIndependent?.(id) === true;
    const connected = this.host.isConnected();
    // While the Head is down only a Head-independent route can be driven.
    if (!connected && !independent(desiredTentacle)) return;
    if (!connected && this.confirmedTentacleId && this.confirmedTentacleId !== desiredTentacle
      && !independent(this.confirmedTentacleId)) return;

    // Leave the old tentacle before moving to another one.
    if (this.confirmedTentacleId && this.confirmedTentacleId !== desiredTentacle) {
      this.issue(this.confirmedTentacleId, null);
      return;
    }

    if (desired === null) return;
    if (!desiredTentacle || !this.barriers.has(desiredTentacle)) return;
    if (this.confirmedSessionId === desired && this.confirmedTentacleId === desiredTentacle) return;
    if (this.blockedDesired === desired) return;

    this.issue(desiredTentacle, desired);
  }

  private issue(tentacleId: string, sessionId: string | null): void {
    const flight = { tentacleId, sessionId, requestId: newRequestId() };
    this.inFlight = flight;
    void this.host.send(tentacleId, sessionId, flight.requestId).then((sent) => {
      if (sent) return;
      if (this.inFlight === flight) {
        this.inFlight = null;
        this.blockedDesired = sessionId;
        this.host.reportError('Cannot set live session subscription: target is unavailable.');
      }
    });
  }
}
