import { NextResponse, type NextRequest } from "next/server";

const MAX_JSON_REQUEST_BYTES = 1024 * 1024;

/**
 * Keep a small process-level guard for API bodies while excluding the exact
 * multipart upload endpoint, whose body is handled once by the Route Handler.
 */
export function proxy(request: NextRequest) {
  const method = request.method.toUpperCase();
  const mutating = method === "POST" || method === "PUT" || method === "PATCH";
  const raw = request.headers.get("content-length");
  if (mutating && raw === null) {
    return NextResponse.json({ error: "请求必须声明内容长度。" }, { status: 411, headers: { "Cache-Control": "no-store" } });
  }
  if (raw !== null) {
    if (!/^\d+$/.test(raw.trim())) {
      return NextResponse.json({ error: "请求大小无效。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const contentLength = Number(raw);
    if (!Number.isSafeInteger(contentLength) || contentLength > MAX_JSON_REQUEST_BYTES) {
      return NextResponse.json({ error: "请求内容过大。" }, { status: 413, headers: { "Cache-Control": "no-store" } });
    }
  }
  return NextResponse.next();
}

export const config = {
  // The exact /api/materials upload endpoint must not be cloned by Proxy.
  matcher: ["/api/((?!materials/?$).*)"],
};
