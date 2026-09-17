import { NextRequest, NextResponse } from "next/server";
import {
  WorkspaceStoreError,
  rescheduleMissedTasks,
  toPublicWorkspace,
} from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TASK_IDS = 100;

/**
 * 把错过的任务重新排进计划。不传 taskIds 时重排全部；
 * 重排后的知识点以「今天到期」的间隔复习参与排期，仍然受每日容量约束。
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "plan-missed", 30);
    const body: unknown = await request.json().catch(() => ({}));
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
      return NextResponse.json({ error: "请求必须是 JSON 对象。" }, { status: 400 });
    }
    const rawIds = (body as { taskIds?: unknown } | null)?.taskIds;
    if (
      rawIds !== undefined &&
      (!Array.isArray(rawIds) ||
        rawIds.length > MAX_TASK_IDS ||
        rawIds.some((id) => typeof id !== "string" || !id || id.length > 200))
    ) {
      return NextResponse.json(
        { error: `taskIds 必须是至多 ${MAX_TASK_IDS} 个任务 id。` },
        { status: 400 },
      );
    }
    const result = await rescheduleMissedTasks(rawIds as string[] | undefined);
    return NextResponse.json(
      {
        accepted: true,
        rescheduled: result.rescheduled,
        workspace: toPublicWorkspace(result.workspace),
        notice: `已把 ${result.rescheduled} 个错过的任务重新排进计划（仍受每日可用时间限制）。`,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "重排错过的任务失败，请稍后重试。" }, { status: 500 });
  }
}
