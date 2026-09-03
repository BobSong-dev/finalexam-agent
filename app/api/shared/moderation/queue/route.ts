import { NextRequest, NextResponse } from "next/server";
import { CommunityStoreError, listModerationQueue } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operator-only queue: pending contributions and unresolved reports. Requires
 * the COMMUNITY_ADMIN_TOKEN bearer credential and is never exposed in the
 * public workspace payload.
 */
export async function GET(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "community-moderation-queue", 60);
    const expected = process.env.COMMUNITY_ADMIN_TOKEN?.trim();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!expected || !supplied || supplied !== expected) {
      return NextResponse.json({ error: "管理员审核凭据无效或未配置。", code: "COMMUNITY_ADMIN_REQUIRED" }, { status: 403 });
    }
    return NextResponse.json(await listModerationQueue(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof CommunityStoreError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "审核队列暂时无法读取。" }, { status: 500 });
  }
}
