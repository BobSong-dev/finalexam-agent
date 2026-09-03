import { NextRequest, NextResponse } from "next/server";
import { AuthError, verifyEmailOtp } from "@/lib/auth-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";
import { WorkspaceStoreError, toPublicWorkspace } from "@/lib/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "auth-otp-verify", 12, 15 * 60_000);
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "email 和 code 为必填项。" }, { status: 400 });
    const payload = body as { email?: unknown; code?: unknown };
    const result = await verifyEmailOtp(payload.email, payload.code);
    return NextResponse.json({ verified: true, schoolMatched: result.schoolMatched, workspace: toPublicWorkspace(result.workspace) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof AuthError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    // consumeOtpChallenge surfaces expired/incorrect/exhausted challenges as
    // WorkspaceStoreError; keep its status code instead of masking it as 400
    // and never leak raw runtime messages to the browser.
    if (error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message, code: "OTP_CHALLENGE_REJECTED" }, { status: error.status });
    return NextResponse.json({ error: "验证码校验失败，请稍后重试。" }, { status: 500 });
  }
}
