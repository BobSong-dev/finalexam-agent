const SECRET_HEADER = /^(x-openai-api-key|authorization)$/i;
const SECRET_QUERY = /(api[_-]?key|token|secret)/i;

/** 去掉请求头和短消息里的密钥，避免进日志或错误上报。 */
export function redactRequestSnapshot(request: { url?: string; method?: string; headers?: Headers | Record<string, string> }): Record<string, unknown> {
  const headers: Record<string, string> = {};
  const raw = request.headers;
  if (raw && typeof raw === "object") {
    const entries = raw instanceof Headers ? [...raw.entries()] : Object.entries(raw);
    for (const [key, value] of entries) {
      headers[key] = SECRET_HEADER.test(key) ? "[redacted]" : String(value).slice(0, 200);
    }
  }
  let url = request.url ?? "";
  try {
    const parsed = new URL(url, "http://localhost");
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY.test(key)) parsed.searchParams.set(key, "[redacted]");
    }
    url = parsed.toString();
  } catch {
    url = url.replace(/([?&](?:api[_-]?key|token|secret)=)[^&]+/ig, "$1[redacted]");
  }
  return { method: request.method, url, headers };
}

export function redactErrorMessage(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}
