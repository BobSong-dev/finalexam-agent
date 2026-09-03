import "server-only";

const DEFAULT_HEAVY_REQUEST_LIMIT = 1;

interface HeavyRequestState {
  active: number;
}

const runtimeGlobal = globalThis as typeof globalThis & {
  __finaleHeavyRequestState?: HeavyRequestState;
};

function state(): HeavyRequestState {
  return runtimeGlobal.__finaleHeavyRequestState ??= { active: 0 };
}

/**
 * Process-local protection for the current single-process runtime. Uploads and
 * AI analysis share this pool because both can temporarily hold large files.
 */
export function acquireHeavyRequestSlot(): () => void {
  const current = state();
  if (current.active >= DEFAULT_HEAVY_REQUEST_LIMIT) {
    throw new RuntimeCapacityError("服务器正在处理其他大文件，请稍后重试。", 5);
  }
  current.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.active = Math.max(0, current.active - 1);
  };
}

export class RuntimeCapacityError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
    this.name = "RuntimeCapacityError";
  }
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
