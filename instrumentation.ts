import { redactErrorMessage, redactRequestSnapshot } from "./lib/log-redact";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { drainAiJobs, recoverStaleJobs } = await import("./lib/ai-jobs");
  // 上一次运行可能留下未完成的后台任务与卡在「分析中」的资料；先清干净再接收请求。
  await recoverStaleJobs().catch((error) => {
    console.error(
      "finale.jobs.recover_failed",
      redactErrorMessage(error instanceof Error ? error.message : "unknown"),
    );
  });
  const stop = () => {
    void drainAiJobs().finally(() => undefined);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string> },
) {
  const message = redactErrorMessage(error instanceof Error ? error.message : "unknown");
  console.error("finale.request_error", {
    message,
    ...redactRequestSnapshot({
      url: request.path,
      method: request.method,
      headers: request.headers,
    }),
  });
}
