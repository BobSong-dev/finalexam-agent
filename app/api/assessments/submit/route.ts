import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, recordPractice, toPublicWorkspace } from "@/lib/workspace-store";

import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

interface AssessmentSubmission {
  courseId: string;
  answers: Record<string, string>;
  selfRating?: 1 | 2 | 3 | 4 | 5;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "assessment-submit", 60);
    const body: unknown = await request.json().catch(() => undefined);
    if (!isAssessmentSubmission(body)) {
      return NextResponse.json({ error: "courseId 和 answers 为必填项。" }, { status: 400 });
    }
    const result = await recordPractice(body.courseId, body.answers, body.selfRating);
    return NextResponse.json({
      accepted: true,
      correct: result.correct,
      total: result.total,
      score: result.score,
      revealed: result.revealed,
      workspace: toPublicWorkspace(result.workspace),
      nextAction: "plan_rebuilt",
      notice: "已根据本次结果更新掌握度并重排后续任务。",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "测验结果保存失败，请稍后重试。" }, { status: 500 });
  }
}

function isAssessmentSubmission(value: unknown): value is AssessmentSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.courseId !== "string" || !body.courseId.trim()) return false;
  if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) return false;
  const entries = Object.entries(body.answers);
  if (entries.length > 200 || entries.some(([key, answer]) => !key || key.length > 200 || typeof answer !== "string" || answer.length > 5_000)) return false;
  return body.selfRating === undefined || (typeof body.selfRating === "number" && Number.isInteger(body.selfRating) && body.selfRating >= 1 && body.selfRating <= 5);
}
