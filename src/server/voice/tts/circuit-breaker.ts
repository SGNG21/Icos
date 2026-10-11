import type { TtsFailureClass } from "./synthesizer";

/**
 * One breaker per TTS provider (decision 0074). It only ever removes ONE provider from
 * the route for a while; TTS as a whole is never disabled by it.
 *
 * closed ──N counted failures──▶ open ──cooldown──▶ half_open (one trial request)
 *   ▲                                                   │
 *   └───────────── trial succeeds ◀─────────────────────┘ (fails → open again)
 *
 * A credential or configuration failure opens it at once, with a longer cooldown:
 * retrying a refused key every request is noise. An abort is not evidence of anything.
 */

export type CircuitState = "closed" | "open" | "half_open";

export type CircuitOptions = {
  /** Consecutive counted failures that open the circuit. */
  failureThreshold: number;
  cooldownMs: number;
  /** For AUTH_FAILED / CONFIG_INVALID: the operator must act; retry rarely. */
  hardCooldownMs: number;
  /** Upper bound on a provider-requested Retry-After. */
  maxRetryAfterMs: number;
};

export const DEFAULT_CIRCUIT: CircuitOptions = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  hardCooldownMs: 300_000,
  maxRetryAfterMs: 300_000,
};

export type CircuitSnapshot = {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastFailureClass: TtsFailureClass | null;
  lastSuccessAt: number | null;
  cooldownUntil: number | null;
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureAt: number | null = null;
  private lastFailureClass: TtsFailureClass | null = null;
  private lastSuccessAt: number | null = null;
  private cooldownUntil: number | null = null;
  private trialInFlight = false;

  constructor(
    private readonly options: CircuitOptions = DEFAULT_CIRCUIT,
    private readonly now: () => number = Date.now,
  ) {}

  /** May a request go to this provider now? A true from half_open reserves the one trial. */
  tryAcquire(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.cooldownUntil !== null && this.now() < this.cooldownUntil) return false;
      this.state = "half_open";
      this.trialInFlight = false;
    }
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  /** What `tryAcquire` would answer, without reserving anything. */
  get available(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "half_open") return !this.trialInFlight;
    return this.cooldownUntil === null || this.now() >= this.cooldownUntil;
  }

  get current(): CircuitState {
    return this.state;
  }

  onSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.trialInFlight = false;
    this.cooldownUntil = null;
    this.lastSuccessAt = this.now();
  }

  /** An attempt that proves nothing either way (aborted by ICOS): release the trial. */
  onNeutral(): void {
    this.trialInFlight = false;
  }

  onFailure(failure: TtsFailureClass, retryAfterS?: number): void {
    if (failure === "ABORTED") return this.onNeutral();
    const now = this.now();
    this.consecutiveFailures += 1;
    this.lastFailureAt = now;
    this.lastFailureClass = failure;
    this.trialInFlight = false;
    const hard = failure === "AUTH_FAILED" || failure === "CONFIG_INVALID";
    const requested =
      retryAfterS !== undefined ? Math.min(retryAfterS * 1000, this.options.maxRetryAfterMs) : 0;
    if (
      hard ||
      this.state === "half_open" ||
      (failure === "RATE_LIMITED" && requested > 0) ||
      this.consecutiveFailures >= this.options.failureThreshold
    ) {
      this.state = "open";
      this.cooldownUntil =
        now + Math.max(hard ? this.options.hardCooldownMs : this.options.cooldownMs, requested);
    }
  }

  snapshot(): CircuitSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      lastFailureClass: this.lastFailureClass,
      lastSuccessAt: this.lastSuccessAt,
      cooldownUntil: this.cooldownUntil,
    };
  }
}
