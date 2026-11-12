/**
 * Guardrails for LLM spend: a per-provider rate limiter and token/cost
 * budgets per agent and for the whole run. When a budget is exhausted the
 * agent quietly falls back to its offline heuristic brain.
 */

export interface SpendLimits {
  /** Max requests per minute per provider. */
  rpm: number;
  /** Max concurrent in-flight requests per provider. */
  concurrency: number;
  /** Token budget per LLM agent (input + output). 0 = unlimited. */
  agentTokens: number;
  /** Token budget for the whole run across all models. 0 = unlimited. */
  totalTokens: number;
  /** Dollar budget for the whole run when prices are known (OpenRouter, or set manually). 0 = unlimited. */
  totalUsd: number;
  /** Max output tokens per decision. */
  maxOutputTokens: number;
}

export const DEFAULT_LIMITS: SpendLimits = {
  rpm: 40,
  concurrency: 4,
  agentTokens: 150_000,
  totalTokens: 2_000_000,
  totalUsd: 2,
  maxOutputTokens: 300,
};

/** Async token-bucket + semaphore. Wall-clock based: only used outside the deterministic core. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private inFlight = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly rpm: number,
    private readonly concurrency: number,
  ) {
    this.tokens = Math.max(1, rpm);
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.rpm, this.tokens + ((now - this.last) / 60_000) * this.rpm);
    this.last = now;
  }

  async acquire(): Promise<() => void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1 && this.inFlight < this.concurrency) {
        this.tokens -= 1;
        this.inFlight++;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.inFlight--;
          this.queue.shift()?.();
        };
      }
      const waitMs = this.tokens < 1 ? Math.ceil(((1 - this.tokens) / this.rpm) * 60_000) : 0;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      else await new Promise<void>((resolve) => this.queue.push(resolve));
    }
  }
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });

/** Tracks spend globally and per agent; answers "may this agent call its model now?". */
export class Budget {
  readonly total: Usage = emptyUsage();
  readonly perAgent = new Map<string, Usage>();
  private exhaustedNotified = new Set<string>();

  constructor(readonly limits: SpendLimits) {}

  usage(agentId: string): Usage {
    let u = this.perAgent.get(agentId);
    if (!u) this.perAgent.set(agentId, (u = emptyUsage()));
    return u;
  }

  /** Reason the agent may not call, or null when it may. */
  blocked(agentId: string): 'agent-tokens' | 'total-tokens' | 'total-usd' | null {
    const l = this.limits;
    const t = this.total.inputTokens + this.total.outputTokens;
    if (l.totalTokens > 0 && t >= l.totalTokens) return 'total-tokens';
    if (l.totalUsd > 0 && this.total.usd >= l.totalUsd) return 'total-usd';
    const a = this.usage(agentId);
    if (l.agentTokens > 0 && a.inputTokens + a.outputTokens >= l.agentTokens) return 'agent-tokens';
    return null;
  }

  /** True the first time a given key is exhausted (for one-off alerts). */
  firstExhaustion(key: string): boolean {
    if (this.exhaustedNotified.has(key)) return false;
    this.exhaustedNotified.add(key);
    return true;
  }

  record(agentId: string, inputTokens: number, outputTokens: number, usd: number): void {
    for (const u of [this.total, this.usage(agentId)]) {
      u.calls++;
      u.inputTokens += inputTokens;
      u.outputTokens += outputTokens;
      u.usd += usd;
    }
  }
}
