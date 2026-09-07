import "server-only";

import { timingSafeEqual } from "node:crypto";
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

  // 与限流相同：未显式信任反代时，客户端可伪造的转发头一律忽略。
  const forwardedHost = process.env.FINALE_TRUST_PROXY === "true"
    ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
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

/**
 * 拒绝跨站顶层导航触发的导出/下载（浏览器会带 sec-fetch-site: cross-site）。
 * 无该头的 CLI/健康检查仍走 Origin 规则。
 */
export function assertNotCrossSite(request: NextRequest): void {
  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site") throw new RequestSecurityError("请求来源无效，请从应用页面重新提交。", 403);
  assertSameOrigin(request);
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const expected = Buffer.from(left);
  const supplied = Buffer.from(right);
  if (expected.length !== supplied.length) {
    if (expected.length > 0) timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(expected, supplied);
}

/** 管理员 Bearer：恒定时间比较；生产环境要求 token 至少 32 字符。 */
export function assertCommunityAdmin(request: NextRequest): void {
  const expected = process.env.COMMUNITY_ADMIN_TOKEN?.trim() ?? "";
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (process.env.NODE_ENV === "production" && expected.length < 32) {
    throw new RequestSecurityError("管理员审核凭据无效或未配置。", 403);
  }
  if (!expected || !supplied || !timingSafeEqualText(expected, supplied)) {
    throw new RequestSecurityError("管理员审核凭据无效或未配置。", 403);
  }
}

export function securityErrorResponse(error: unknown): Response | undefined {
  if (!(error instanceof RequestSecurityError)) return undefined;
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (error.retryAfterSeconds) headers["Retry-After"] = String(error.retryAfterSeconds);
  return Response.json({ error: error.message, code: error.status === 429 ? "RATE_LIMITED" : "ORIGIN_REJECTED" }, { status: error.status, headers });
}
