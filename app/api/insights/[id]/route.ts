import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, setInsightHidden, toPublicWorkspace } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DynamicRouteContext {
  params: Promise<{ id: string }>;
}

/**
 * 忽略或恢复一个考点。只影响展示、练习抽题与计划，不删除原始分析结果，
 * 因此可以随时恢复。
 */
export async function PATCH(request: NextRequest, context: DynamicRouteContext) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "insight-update", 60);
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "请求必须是 JSON 对象。" }, { status: 400 });
    }
    const hidden = (body as { hidden?: unknown }).hidden;
    if (typeof hidden !== "boolean") {
      return NextResponse.json({ error: "hidden 必须为布尔值。" }, { status: 400 });
    }
    const workspace = await setInsightHidden(id, hidden);
    return NextResponse.json(toPublicWorkspace(workspace), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "考点更新失败，请稍后重试。" }, { status: 500 });
  }
}
