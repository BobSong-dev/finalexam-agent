import { NextRequest, NextResponse } from "next/server";
import { CommunityStoreError, resolveSharedReport } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: RouteContext<"/api/shared/reports/[id]/resolve">) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "community-report-resolve", 60);
    const expected = process.env.COMMUNITY_ADMIN_TOKEN?.trim();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!expected || !supplied || supplied !== expected) {
      return NextResponse.json({ error: "管理员审核凭据无效或未配置。", code: "COMMUNITY_ADMIN_REQUIRED" }, { status: 403 });
    }
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "处理请求必须是 JSON 对象。" }, { status: 400 });
    const resolution = (body as { resolution?: unknown }).resolution;
    if (typeof resolution !== "string" || !resolution.trim()) return NextResponse.json({ error: "resolution 为必填项。" }, { status: 400 });
    await resolveSharedReport(id, resolution);
    return NextResponse.json({ accepted: true, notice: "举报已标记为已处理。" }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof CommunityStoreError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "举报处理失败，请稍后重试。" }, { status: 500 });
  }
}
