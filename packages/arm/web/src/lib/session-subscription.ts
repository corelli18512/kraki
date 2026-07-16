import type { SessionSubscriptionSetMessage } from '@kraki/protocol';

export interface SubscriptionControllerHost {
  isConnected(): boolean;
  resolveTentacle(sessionId: string): string | undefined;
  send(tentacleId: string, sessionId: string | null): Promise<boolean>;
  applySnapshot(msg: SessionSubscriptionSetMessage): void;
  reportError(message: string): void;
}

interface InFlight {
  tentacleId: string;
  sessionId: string | null;
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
    this.confirmedSessionId = null;
    this.confirmedTentacleId = null;
    this.inFlight = null;
    this.barriers.clear();
    this.blockedDesired = null;
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
      this.host.applySnapshot(msg);
      this.confirmedSessionId = msg.payload.sessionId;
      this.confirmedTentacleId = msg.deviceId;
    }
    this.drive();
  }

  private drive(): void {
    if (!this.host.isConnected() || this.inFlight) return;

    const desired = this.desiredSessionId;
    const desiredTentacle = desired ? this.host.resolveTentacle(desired) : undefined;

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
    this.inFlight = { tentacleId, sessionId };
    void this.host.send(tentacleId, sessionId).then((sent) => {
      if (sent) return;
      if (this.inFlight?.tentacleId === tentacleId && this.inFlight.sessionId === sessionId) {
        this.inFlight = null;
        this.blockedDesired = sessionId;
        this.host.reportError('Cannot set live session subscription: target is unavailable.');
      }
    });
  }
}
