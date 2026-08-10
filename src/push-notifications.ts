/**
 * Push Notification support for A2A long-running tasks.
 *
 * When a task reaches a terminal state (completed/failed/canceled),
 * the gateway can POST the result to a pre-registered webhook URL
 * instead of requiring the client to poll tasks/get.
 *
 * Signal decay (Phase 1.3): notifications have an importance score
 * that decays exponentially over time, modelled after cAMP degradation
 * by phosphodiesterase. When importance falls below threshold,
 * retries are abandoned and the registration is eligible for cleanup.
 *
 *   importance(t) = importance_0 * exp(-k_decay * t_seconds)
 *
 * @see Alon, U. (2007) "An Introduction to Systems Biology" Ch.4
 *   — signal degradation enables temporal coding.
 *
 * This is an in-memory store — registrations do not survive restarts.
 */

export interface PushNotificationConfig {
  /** Webhook URL to POST results to. */
  url: string;
  /** Optional auth token for the webhook (sent as Bearer). */
  token?: string;
  /** Optional event filter: ["completed", "failed", "canceled"]. Default: all terminal states. */
  events?: string[];
  /**
   * Initial importance score (0-1). Decays over time when used with
   * {@link DecayConfig}. Analogous to initial cAMP concentration.
   * @default 1.0
   */
  importance?: number;
  /**
   * ISO 8601 timestamp (UTC, ms precision, `YYYY-MM-DDTHH:mm:ss.sssZ`)
   * when the notification was registered. Per A2A v1.0 spec §10
   * ("Timestamps"). Format matches `new Date().toISOString()`.
   */
  createdAt?: string;
}

/**
 * Configuration for signal-decay-based notification management.
 *
 * Models cAMP degradation: importance decays exponentially, controlling
 * retry behaviour and automatic cleanup.
 */
export interface DecayConfig {
  /**
   * Decay rate constant k (per second). Higher = faster decay.
   * @default 0.001
   */
  decayRate?: number;
  /**
   * Minimum importance threshold. Below this, notification is abandoned.
   * @default 0.1
   */
  minImportance?: number;
  /**
   * Maximum retry attempts on send failure.
   * @default 3
   */
  maxRetries?: number;
  /**
   * Base delay between retries in ms. Actual delay = baseDelay * attempt.
   * @default 2000
   */
  retryBaseDelayMs?: number;
}

/**
 * Security context for push-notification delivery.
 *
 * Closes the SSRF/TOCTOU gap (v1.0 code review §1.1) by re-running URL
 * validation immediately before each outbound `fetch()` instead of trusting
 * the result of validation that happened at registration time. Registration
 * can be minutes-to-hours before delivery for long-running tasks, leaving
 * a window for DNS rebinding or 302-to-internal attacks.
 *
 * Injected at construction; optional for backward compat. When omitted, the
 * store behaves as before (caller is responsible for all SSRF defense).
 */
export interface PushNotificationSecurityContext {
  /**
   * Re-validate a URL for SSRF safety.
   * Should resolve to `true` if safe to fetch, `false` if blocked
   * (private IP, disallowed scheme, allowlist miss, etc.).
   */
  validateUrl(url: string): Promise<boolean>;
}

export interface PushNotificationResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Compute current importance using exponential decay.
 *
 *   importance(t) = initial * exp(-k * t_seconds)
 *
 * Analogous to cAMP concentration decay by phosphodiesterase.
 *
 * @param initial   Initial importance (0-1).
 * @param elapsedMs Milliseconds since registration.
 * @param decayRate Decay rate constant k (per second).
 * @returns Current importance in [0, initial].
 *
 * @see Alon, U. (2007) "An Introduction to Systems Biology" Ch.4.
 */
export function computeImportance(initial: number, elapsedMs: number, decayRate: number): number {
  if (elapsedMs <= 0) return initial;
  return initial * Math.exp(-decayRate * (elapsedMs / 1000));
}

const TERMINAL_EVENTS = ["completed", "failed", "canceled"];
const PUSH_TIMEOUT_MS = 10_000;
const DEFAULT_DECAY_RATE = 0.001;
const DEFAULT_MIN_IMPORTANCE = 0.1;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2000;

/**
 * In-memory store mapping taskId to webhook config.
 * Fire-and-forget delivery — task completion is never blocked by webhook.
 */
export class PushNotificationStore {
  private readonly registrations = new Map<string, PushNotificationConfig>();
  private readonly security?: PushNotificationSecurityContext;

  /**
   * @param opts.security Optional SSRF re-validation context. When provided,
   *   `send()` will call `security.validateUrl(url)` immediately before each
   *   outbound fetch — closes the §1.1 TOCTOU window between registration
   *   and delivery. Omit for legacy behavior (no re-check at delivery time).
   */
  constructor(opts?: { security?: PushNotificationSecurityContext }) {
    this.security = opts?.security;
  }

  register(taskId: string, config: PushNotificationConfig): void {
    this.registrations.set(taskId, {
      ...config,
      createdAt: config.createdAt ?? new Date().toISOString(),
      importance: config.importance ?? 1.0,
    });
  }

  unregister(taskId: string): void {
    this.registrations.delete(taskId);
  }

  get(taskId: string): PushNotificationConfig | undefined {
    return this.registrations.get(taskId);
  }

  has(taskId: string): boolean {
    return this.registrations.has(taskId);
  }

  /** Number of active registrations (for diagnostics). */
  get size(): number {
    return this.registrations.size;
  }

  /**
   * Send a push notification for a completed task.
   *
   * Returns immediately if no registration exists or the event is filtered out.
   * Uses a 10s timeout — never blocks task completion.
   */
  async send(
    taskId: string,
    state: string,
    task: object,
  ): Promise<PushNotificationResult> {
    const config = this.registrations.get(taskId);
    if (!config) {
      return { ok: false, error: "no registration" };
    }

    // Check event filter
    const allowedEvents = config.events && config.events.length > 0
      ? config.events
      : TERMINAL_EVENTS;
    if (!allowedEvents.includes(state)) {
      return { ok: false, error: `event "${state}" filtered out` };
    }

    // SSRF re-validation immediately before fetch (closes §1.1 TOCTOU window).
    // Registration validated the URL, but delivery may be minutes/hours later;
    // an attacker could have re-pointed DNS or set up a redirect in between.
    if (this.security) {
      const safe = await this.security.validateUrl(config.url);
      if (!safe) {
        return {
          ok: false,
          error: "URL failed SSRF re-validation at delivery time",
        };
      }
    }

    const body = JSON.stringify({ taskId, state, task });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

      const response = await fetch(config.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        // Closes §1.1 redirect vector: do NOT follow 3xx silently. A webhook
        // that's safe at registration could 302 to an internal address at
        // request time; with redirect: "manual" the response is surfaced
        // (statusCode 3xx, response.ok === false) and not followed.
        redirect: "manual",
      });

      clearTimeout(timer);

      // Auto-cleanup after successful delivery
      this.registrations.delete(taskId);

      return {
        ok: response.ok,
        statusCode: response.status,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Send with decay-aware retry.
   *
   * Before each attempt, the notification's current importance is checked.
   * If importance has decayed below `minImportance`, the notification is
   * abandoned (analogous to cAMP fully degraded by phosphodiesterase).
   *
   * Without `decayConfig`, behaves identically to {@link send} (no retry).
   */
  async sendWithRetry(
    taskId: string,
    state: string,
    task: object,
    decayConfig?: DecayConfig,
  ): Promise<PushNotificationResult> {
    if (!decayConfig) return this.send(taskId, state, task);

    const config = this.registrations.get(taskId);
    if (!config) return { ok: false, error: "no registration" };

    const k = decayConfig.decayRate ?? DEFAULT_DECAY_RATE;
    const minImp = decayConfig.minImportance ?? DEFAULT_MIN_IMPORTANCE;
    const maxRetries = decayConfig.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelay = decayConfig.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const initial = config.importance ?? 1.0;
    const createdAt = config.createdAt ?? new Date().toISOString();
    // Convert ISO 8601 timestamp to ms for decay math.
    const createdAtMs = Date.parse(createdAt);

    // Check if already below threshold
    const currentImp = computeImportance(initial, Date.now() - createdAtMs, k);
    if (currentImp < minImp) {
      this.registrations.delete(taskId);
      return { ok: false, error: `importance decayed below threshold (${currentImp.toFixed(3)} < ${minImp})` };
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.send(taskId, state, task);
      if (result.ok) return result;

      // Re-register if send() auto-cleaned on HTTP error (it only cleans on success, so re-check)
      if (!this.registrations.has(taskId)) {
        this.registrations.set(taskId, config);
      }

      // Check importance before retrying
      const imp = computeImportance(initial, Date.now() - createdAtMs, k);
      if (imp < minImp) {
        this.registrations.delete(taskId);
        return { ok: false, error: `importance decayed below threshold (${imp.toFixed(3)} < ${minImp})` };
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, baseDelay * (attempt + 1)));
      }
    }

    return { ok: false, error: `max retries (${maxRetries}) exceeded` };
  }

  /**
   * Remove registrations whose importance has decayed below threshold.
   *
   * Analogous to cAMP clearance by phosphodiesterase — signals that are
   * no longer relevant are automatically garbage-collected.
   *
   * @param threshold Minimum importance to keep. @default 0.1
   * @returns Number of registrations removed.
   */
  cleanup(threshold = DEFAULT_MIN_IMPORTANCE): number {
    let removed = 0;
    for (const [taskId, config] of this.registrations) {
      const imp = config.importance ?? 1.0;
      if (imp < threshold) {
        this.registrations.delete(taskId);
        removed++;
      }
    }
    return removed;
  }
}
