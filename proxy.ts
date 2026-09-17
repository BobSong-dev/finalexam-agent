import { NextResponse, type NextRequest } from "next/server";

const MAX_JSON_REQUEST_BYTES = 1024 * 1024;

/**
 * 每个请求生成一个 nonce，并把它同时写进请求头与响应头。
 *
 * Next.js 会读取请求上的 `content-security-policy`，并给自己的内联脚本使用同一个
 * nonce，因此脚本策略可以从 `'unsafe-inline'` 收紧到 `nonce + strict-dynamic`。
 * （内联 style 仍然需要 'unsafe-inline'，样式不能通过 nonce 表达；这不影响脚本防护。）
 */
function buildCsp(nonce: string, isDevelopment: boolean): string {
  const scriptSrc = isDevelopment
    ? // 开发模式下 React Refresh 需要 eval。
      `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const SECURITY_HEADERS = { "Cache-Control": "no-store" } as const;

/**
 * Keep a small process-level guard for API bodies while excluding the exact
 * multipart upload endpoint, whose body is handled once by the Route Handler.
 * 同时为所有页面与接口下发带 nonce 的 CSP。
 */
export function proxy(request: NextRequest) {
  const isDevelopment = process.env.NODE_ENV === "development";
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const contentSecurityPolicy = buildCsp(nonce, isDevelopment);
  const withCsp = { ...SECURITY_HEADERS, "Content-Security-Policy": contentSecurityPolicy };

  if (request.nextUrl.pathname.startsWith("/api/")) {
    const method = request.method.toUpperCase();
    const mutating = method === "POST" || method === "PUT" || method === "PATCH";
    const raw = request.headers.get("content-length");
    if (mutating && raw === null) {
      return NextResponse.json(
        { error: "请求必须声明内容长度。" },
        { status: 411, headers: withCsp },
      );
    }
    if (raw !== null) {
      if (!/^\d+$/.test(raw.trim())) {
        return NextResponse.json({ error: "请求大小无效。" }, { status: 400, headers: withCsp });
      }
      const contentLength = Number(raw);
      if (!Number.isSafeInteger(contentLength) || contentLength > MAX_JSON_REQUEST_BYTES) {
        return NextResponse.json({ error: "请求内容过大。" }, { status: 413, headers: withCsp });
      }
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", contentSecurityPolicy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  // 页面与 API 都要走这里（CSP 需要逐请求 nonce）；静态产物跳过。
  // The exact /api/materials upload endpoint must not be cloned by Proxy.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)",
    "/api/((?!materials/?$).*)",
  ],
};
