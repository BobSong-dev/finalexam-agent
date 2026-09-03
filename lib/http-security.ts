import "server-only";

import type { NextRequest } from "next/server";

const DEFAULT_WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

export class RequestSecurityError extends Error {
  constructor(message: string, readonly status = 403, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "RequestSecurityError";
  }
}

/**
 * Reject browser requests initiated by another origin. Requests without an
 * Origin header are still allowed for CLI/health checks; authenticated
 * deployments should put their own proxy policy in front of those clients.
 */
export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin")?.trim();
  if (!origin || origin === "null") {
    if (origin === "null") throw new RequestSecurityError("请求来源无效，请从应用页面重新提交。", 403);
    return;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new RequestSecurityError("请求来源无效。", 403);
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    throw new RequestSecurityError("请求来源无效。", 403);
  }

  const configured = (process.env.FINALE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try { return new URL(value).origin; } catch { return ""; }
    })
    .filter(Boolean);
  if (configured.length > 0) {
    if (!configured.includes(originUrl.origin)) throw new RequestSecurityError("请求来源未获允许。", 403);
    return;
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost || request.headers.get("host")?.trim();
  if (requestHost) {
    if (originUrl.host !== requestHost) throw new RequestSecurityError("请求来源与当前站点不一致。", 403);
    return;
  }

  if (originUrl.origin !== new URL(request.url).origin) {
    throw new RequestSecurityError("请求来源与当前站点不一致。", 403);
  }
}

export function clientAddress(request: NextRequest): string {
  // x-forwarded-for / x-real-ip are client-spoofable. Without an explicit
  // operator opt-in they must not be trusted, or an attacker can rotate the
  // header to escape every in-process rate limit. When a reverse proxy is in
  // front, the operator sets FINALE_TRUST_PROXY=true and the proxy must strip
  // inbound forwarding headers before setting its own.
  if (process.env.FINALE_TRUST_PROXY === "true") {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  return "direct";
}

/**
 * Small in-process guard for the self-hosted single-process runtime. It is not
 * a replacement for a distributed gateway limiter; production multi-instance
 * deployments should enforce the same policy at the reverse proxy as well.
 */
export function enforceRateLimit(
  request: NextRequest,
  scope: string,
  limit: number,
  windowMs = DEFAULT_WINDOW_MS,
): void {
  if (process.env.FINALE_RATE_LIMIT_DISABLED === "true") return;
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
  }
  const key = `${scope}:${clientAddress(request)}`;
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (current.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    throw new RequestSecurityError("请求过于频繁，请稍后再试。", 429, retryAfterSeconds);
  }
  current.count += 1;
}

export function securityErrorResponse(error: unknown): Response | undefined {
  if (!(error instanceof RequestSecurityError)) return undefined;
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (error.retryAfterSeconds) headers["Retry-After"] = String(error.retryAfterSeconds);
  return Response.json({ error: error.message, code: error.status === 429 ? "RATE_LIMITED" : "ORIGIN_REJECTED" }, { status: error.status, headers });
}
