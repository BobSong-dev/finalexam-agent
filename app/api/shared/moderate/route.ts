import { NextRequest, NextResponse } from "next/server";
import { CommunityStoreError, moderateSharedMaterial, toPublicWorkspace } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "community-moderate", 60);
    const expected = process.env.COMMUNITY_ADMIN_TOKEN?.trim();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!expected || !supplied || supplied !== expected) return NextResponse.json({ error: "管理员审核凭据无效或未配置。", code: "COMMUNITY_ADMIN_REQUIRED" }, { status: 403 });
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "审核请求必须是 JSON 对象。" }, { status: 400 });
    const payload = body as { materialId?: unknown; decision?: unknown; quality?: unknown; reason?: unknown };
    if (typeof payload.materialId !== "string" || (payload.decision !== "approve" && payload.decision !== "reject")) return NextResponse.json({ error: "materialId 和 decision 为必填项。" }, { status: 400 });
    if (payload.quality !== undefined && !["优质", "已核验", "待核验"].includes(String(payload.quality))) return NextResponse.json({ error: "quality 无效。" }, { status: 400 });
    const result = await moderateSharedMaterial({ materialId: payload.materialId.trim(), decision: payload.decision, quality: payload.quality as "优质" | "已核验" | "待核验" | undefined, reason: typeof payload.reason === "string" ? payload.reason : undefined });
    return NextResponse.json({ material: result.material, workspace: toPublicWorkspace(result.workspace) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof CommunityStoreError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "审核操作失败，请稍后重试。" }, { status: 500 });
  }
}
