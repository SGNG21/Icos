/**
 * Limiteur à fenêtre fixe, local au processus, borné en mémoire. Protège les
 * sondes et /proc d'un client qui interrogerait trop souvent (onglets
 * multiples, script) ; le cockpit normal consomme 6 requêtes par minute et par onglet.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Secondes avant la prochaine fenêtre (si refus). */
  retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 1_000,
  ) {}

  check(key: string): RateLimitDecision {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      if (!window && this.windows.size >= this.maxKeys) this.evict(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= this.limit) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)),
    };
  }

  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
    // Toujours plein : on retire la fenêtre la plus ancienne (borne stricte).
    if (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
  }
}

const LIMITER_KEY = "__icosTelemetryRateLimiter__";
const LIVE_LIMITER_KEY = "__icosLiveRateLimiter__";
type GlobalWithLimiter = typeof globalThis & {
  [LIMITER_KEY]?: FixedWindowRateLimiter;
  [LIVE_LIMITER_KEY]?: FixedWindowRateLimiter;
};

/**
 * Un onglet du cockpit consomme 6 lectures par minute (10 s), plus une reprise
 * immédiate au retour d'onglet. 60 lectures par minute et par utilisateur
 * laissent ~10 onglets ouverts sans aucun refus ; au-delà, un script ou une
 * boucle est bridé. Le coût serveur reste borné par les caches (relevé /proc
 * et sondes), pas par ce plafond.
 */
export const TELEMETRY_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export function getTelemetryRateLimiter(): FixedWindowRateLimiter {
  const globalRef = globalThis as GlobalWithLimiter;
  globalRef[LIMITER_KEY] ??= new FixedWindowRateLimiter(
    TELEMETRY_RATE_LIMIT.limit,
    TELEMETRY_RATE_LIMIT.windowMs,
  );
  return globalRef[LIMITER_KEY];
}

/** Même plafond pour la vue live : un onglet consomme 4 lectures par minute (15 s). */
export function getLiveRateLimiter(): FixedWindowRateLimiter {
  const globalRef = globalThis as GlobalWithLimiter;
  globalRef[LIVE_LIMITER_KEY] ??= new FixedWindowRateLimiter(
    TELEMETRY_RATE_LIMIT.limit,
    TELEMETRY_RATE_LIMIT.windowMs,
  );
  return globalRef[LIVE_LIMITER_KEY];
}

export function resetTelemetryRateLimiterForTests(): void {
  delete (globalThis as GlobalWithLimiter)[LIMITER_KEY];
  delete (globalThis as GlobalWithLimiter)[LIVE_LIMITER_KEY];
}
