export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
}

/**
 * Bounds a single workflow run: no agent gets an open-ended loop.
 * Every tool call spends one unit; the deadline covers the whole run.
 */
export class RunBudget {
  private calls = 0;
  private readonly deadline: number;

  constructor(
    readonly maxCalls: number,
    readonly timeoutMs: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.deadline = clock() + timeoutMs;
  }

  spend(label: string) {
    if (this.calls >= this.maxCalls) throw new BudgetExceededError(`Tool-call limit (${this.maxCalls}) reached before ${label}`);
    if (this.clock() > this.deadline) throw new BudgetExceededError(`Run timed out (${this.timeoutMs} ms) before ${label}`);
    this.calls += 1;
  }

  get used() {
    return this.calls;
  }

  remainingMs() {
    return Math.max(0, this.deadline - this.clock());
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetExceededError(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
