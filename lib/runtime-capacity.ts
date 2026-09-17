import "server-only";

const DEFAULT_UPLOAD_LIMIT = 1;
const DEFAULT_AI_LIMIT = 1;

/**
 * Process-local guard for the single-process self-hosted runtime.
 *
 * Uploads and AI calls used to share one slot, so starting an analysis blocked
 * the next upload for up to six minutes. They are separate pools now: an
 * upload only needs its slot while the file is being written to disk, and
 * model calls queue behind their own (configurable) concurrency limit.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    timer?: NodeJS.Timeout;
  }> = [];

  constructor(readonly limit: number) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Acquire immediately, or throw instead of waiting. */
  tryAcquire(): () => void {
    if (this.active >= this.limit)
      throw new RuntimeCapacityError("服务器正在处理其他大文件，请稍后重试。", 5);
    this.active += 1;
    return this.releaser();
  }

  /** Wait for a slot; rejects with SERVER_BUSY after `timeoutMs`. */
  acquire(timeoutMs?: number): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry: {
        resolve: (release: () => void) => void;
        reject: (error: unknown) => void;
        timer?: NodeJS.Timeout;
      } = {
        resolve: (release) => {
          if (entry.timer) clearTimeout(entry.timer);
          resolve(release);
        },
        reject: (error) => {
          if (entry.timer) clearTimeout(entry.timer);
          reject(error);
        },
      };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new RuntimeCapacityError("等待其他大文件处理超时，请稍后重试。", 5));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.queue.push(entry);
    });
  }

  /** Test-only helper: reset the pool between cases. */
  resetForTests(): void {
    for (const entry of this.queue.splice(0))
      entry.reject(new RuntimeCapacityError("服务器正在处理其他大文件，请稍后重试。", 5));
    this.active = 0;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Hand the slot over without ever dropping the active count.
        next.resolve(this.releaser());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

export class RuntimeCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "RuntimeCapacityError";
  }
}

const runtimeGlobal = globalThis as typeof globalThis & {
  __finalePools?: { upload: Semaphore; ai: Semaphore };
};

function positiveInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 16 ? parsed : fallback;
}

function pools() {
  return (runtimeGlobal.__finalePools ??= {
    upload: new Semaphore(DEFAULT_UPLOAD_LIMIT),
    ai: new Semaphore(positiveInt(process.env.FINALE_AI_CONCURRENCY, DEFAULT_AI_LIMIT)),
  });
}

export function uploadPool(): Semaphore {
  return pools().upload;
}

export function aiPool(): Semaphore {
  return pools().ai;
}

/**
 * Backwards-compatible entry point: the upload pool is the one that must stay
 * exclusive, because a second concurrent 50 MB multipart write is what the
 * original single slot was protecting against.
 */
export function acquireHeavyRequestSlot(): () => void {
  return uploadPool().tryAcquire();
}

/** Background AI work waits for its own slot instead of failing the request. */
export async function waitForHeavyRequestSlot(timeoutMs = 180_000): Promise<() => void> {
  return aiPool().acquire(timeoutMs);
}

export function runtimeCapacityErrorResponse(error: unknown): Response | undefined {
  if (!(error instanceof RuntimeCapacityError)) return undefined;
  return Response.json(
    { error: error.message, code: "SERVER_BUSY" },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(error.retryAfterSeconds),
      },
    },
  );
}
