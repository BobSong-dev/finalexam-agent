import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, deleteCourse, toPublicWorkspace, updateCourse } from "@/lib/workspace-store";
import type { Course } from "@/lib/types";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CoursePatch = Partial<Pick<Course, "name" | "teacher" | "term" | "examDate" | "priority">>;

export async function PATCH(request: NextRequest, context: RouteContext<"/api/courses/[id]">) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "course-update", 60);
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => undefined);
    if (!isCoursePatch(body)) return NextResponse.json({ error: "课程更新请求必须是 JSON 对象。" }, { status: 400 });
    const workspace = await updateCourse(id, body);
    return NextResponse.json({ workspace: toPublicWorkspace(workspace) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "课程更新失败，请稍后重试。" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext<"/api/courses/[id]">) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "course-delete", 30);
    const { id } = await context.params;
    return NextResponse.json(toPublicWorkspace(await deleteCourse(id)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "课程删除失败，请稍后重试。" }, { status: 500 });
  }
}

function isCoursePatch(value: unknown): value is CoursePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["name", "teacher", "term", "examDate", "priority"]);
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, item]) => allowed.has(key) && typeof item === "string");
}
