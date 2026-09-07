import { redactErrorMessage, redactRequestSnapshot } from "./lib/log-redact";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { drainAiJobs } = await import("./lib/ai-jobs");
  const stop = () => {
    void drainAiJobs().finally(() => undefined);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export async function onRequestError(error: unknown, request: { path: string; method: string; headers: Record<string, string> }) {
  const message = redactErrorMessage(error instanceof Error ? error.message : "unknown");
  console.error("finale.request_error", {
    message,
    ...redactRequestSnapshot({ url: request.path, method: request.method, headers: request.headers }),
  });
}
