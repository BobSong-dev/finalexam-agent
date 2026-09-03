import { NextRequest, NextResponse } from "next/server";
import { CommunityStoreError, contributeSharedMaterial, toPublicWorkspace } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "community-contribute", 10);
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "共享请求必须是 JSON 对象。" }, { status: 400 });
    const payload = body as { materialId?: unknown; consent?: unknown; privacyConfirmed?: unknown };
    if (typeof payload.materialId !== "string" || !payload.materialId.trim() || typeof payload.consent !== "boolean" || typeof payload.privacyConfirmed !== "boolean") return NextResponse.json({ error: "materialId、consent 和 privacyConfirmed 为必填项。" }, { status: 400 });
    const result = await contributeSharedMaterial({ materialId: payload.materialId.trim(), consent: payload.consent, privacyConfirmed: payload.privacyConfirmed });
    return NextResponse.json({ accepted: true, status: result.material.status, material: result.material, workspace: toPublicWorkspace(result.workspace), notice: "资料已提交审核；审核通过前不会出现在可解锁目录，也不会发放积分。" }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof CommunityStoreError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "共享资料提交失败，请稍后重试。" }, { status: 500 });
  }
}
