import { NextRequest, NextResponse } from "next/server";
import { CommunityStoreError, reportSharedMaterial } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "community-report", 10);
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "举报请求必须是 JSON 对象。" }, { status: 400 });
    const payload = body as { materialId?: unknown; reason?: unknown; detail?: unknown };
    if (typeof payload.materialId !== "string" || typeof payload.reason !== "string" || (payload.detail !== undefined && typeof payload.detail !== "string")) return NextResponse.json({ error: "materialId、reason 为必填项。" }, { status: 400 });
    await reportSharedMaterial({ materialId: payload.materialId.trim(), reason: payload.reason, detail: typeof payload.detail === "string" ? payload.detail : undefined });
    return NextResponse.json({ accepted: true, notice: "举报已记录，管理员会在审核队列中处理。" }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof CommunityStoreError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "举报提交失败，请稍后重试。" }, { status: 500 });
  }
}
