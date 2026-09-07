import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, getWorkspace, toPublicWorkspace, updateWorkspacePatch } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    enforceRateLimit(request, "workspace-read", 120);
    return NextResponse.json(toPublicWorkspace(await getWorkspace()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    return workspaceError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "workspace-update", 60);
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body)) return NextResponse.json({ error: "工作区更新必须是 JSON 对象。" }, { status: 400 });
    const invalidStringField = profileStringFields.find((field) => Object.prototype.hasOwnProperty.call(body, field) && typeof body[field] !== "string");
    if (invalidStringField) return NextResponse.json({ error: `${invalidStringField} 必须是字符串。` }, { status: 400 });
    const workspace = await updateWorkspacePatch({
      displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      email: typeof body.email === "string" ? body.email : undefined,
      school: typeof body.school === "string" ? body.school : undefined,
      examGoal: typeof body.examGoal === "string" ? body.examGoal : undefined,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      studyDayStart: typeof body.studyDayStart === "string" ? body.studyDayStart : undefined,
      availability: body.availability,
    });
    return NextResponse.json(toPublicWorkspace(workspace), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    return workspaceError(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const profileStringFields = ["displayName", "email", "school", "examGoal", "timezone", "studyDayStart"] as const;

function workspaceError(error: unknown) {
  if (error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: "工作区暂时无法读取，请检查数据目录权限后重试。" }, { status: 500 });
}
