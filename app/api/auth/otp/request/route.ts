import { NextRequest, NextResponse } from "next/server";
import { requestEmailOtp, verifyEmailOtp, AuthError } from "@/lib/auth-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";
import { toPublicWorkspace } from "@/lib/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "auth-otp-request", 5, 15 * 60_000);
    const body: unknown = await request.json().catch(() => undefined);
    const email = body && typeof body === "object" && !Array.isArray(body) ? (body as { email?: unknown }).email : undefined;
    const result = await requestEmailOtp(email);
    return NextResponse.json({ accepted: true, email: result.email, expiresInSeconds: result.expiresInSeconds, message: "验证码已发送，请检查邮箱。" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof AuthError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "验证码请求无法完成，请稍后重试。" }, { status: 500 });
  }
}
