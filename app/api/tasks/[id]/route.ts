import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, setTaskCompletion, toPublicWorkspace } from "@/lib/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";


interface DynamicRouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, context: DynamicRouteContext) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "task-update", 120);
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "任务更新必须是 JSON 对象。" }, { status: 400 });
    }
    const payload = body as { completed?: unknown };
    if (typeof payload.completed !== "boolean") return NextResponse.json({ error: "completed 必须为布尔值。" }, { status: 400 });
    return NextResponse.json(toPublicWorkspace(await setTaskCompletion(id, payload.completed)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "任务更新失败，请稍后重试。" }, { status: 500 });
  }
}
