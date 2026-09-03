import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, createCourse, toPublicWorkspace } from "@/lib/workspace-store";
import type { CourseInput } from "@/lib/workspace-types";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "course-create", 60);
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body)) return NextResponse.json({ error: "课程请求必须是 JSON 对象。" }, { status: 400 });
    const result = await createCourse(body as unknown as CourseInput);
    return NextResponse.json({ ...result, workspace: toPublicWorkspace(result.workspace) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "创建课程失败，请稍后重试。" }, { status: 500 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
