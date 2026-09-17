import { NextRequest, NextResponse } from "next/server";
import {
  WorkspaceStoreError,
  confirmMaterialAnalysis,
  toPublicWorkspace,
} from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 用户确认「需确认」的 AI 分析结果，资料转为已分析。 */
interface DynamicRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: DynamicRouteContext) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "material-confirm", 30);
    const { id } = await context.params;
    const workspace = await confirmMaterialAnalysis(id);
    return NextResponse.json(toPublicWorkspace(workspace), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "确认失败，请稍后重试。" }, { status: 500 });
  }
}
