import { NextRequest, NextResponse } from "next/server";
import {
  WorkspaceStoreError,
  recordPractice,
  toPublicWorkspace,
  type PracticeSubmission,
} from "@/lib/workspace-store";
import type { PracticeGrade } from "@/lib/types";

import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRADES = new Set<PracticeGrade>(["correct", "partial", "wrong"]);

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "assessment-submit", 60);
    const body: unknown = await request.json().catch(() => undefined);
    const submission = parseSubmission(body);
    if (!submission) {
      return NextResponse.json({ error: "courseId 和 answers 为必填项。" }, { status: 400 });
    }
    const result = await recordPractice(submission);
    return NextResponse.json(
      {
        accepted: true,
        correct: result.correct,
        total: result.total,
        graded: result.graded,
        score: result.score,
        revealed: result.revealed,
        workspace: toPublicWorkspace(result.workspace),
        nextAction: "plan_rebuilt",
        notice:
          result.graded < result.total
            ? "已根据可判分题目更新掌握度；未自评的简答题不计分。"
            : "已根据本次结果更新掌握度并重排后续任务。",
        // 旧客户端（不带 sessionId/questionIds）仍按整课判分，但提示升级。
        ...(submission.sessionId || submission.questionIds
          ? {}
          : { deprecated: "请使用 /api/practice/sessions 创建练习会话后提交。" }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "测验结果保存失败，请稍后重试。" }, { status: 500 });
  }
}

function parseSubmission(value: unknown): PracticeSubmission | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (typeof body.courseId !== "string" || !body.courseId.trim()) return undefined;
  if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers))
    return undefined;
  const entries = Object.entries(body.answers as Record<string, unknown>);
  if (
    entries.length > 200 ||
    entries.some(
      ([key, answer]) =>
        !key || key.length > 200 || typeof answer !== "string" || answer.length > 5_000,
    )
  )
    return undefined;
  if (
    body.selfRating !== undefined &&
    !(
      typeof body.selfRating === "number" &&
      Number.isInteger(body.selfRating) &&
      body.selfRating >= 1 &&
      body.selfRating <= 5
    )
  )
    return undefined;
  if (
    body.sessionId !== undefined &&
    (typeof body.sessionId !== "string" || body.sessionId.length > 80)
  )
    return undefined;
  if (
    body.questionIds !== undefined &&
    (!Array.isArray(body.questionIds) ||
      body.questionIds.length > 200 ||
      body.questionIds.some((id) => typeof id !== "string" || !id || id.length > 200))
  )
    return undefined;
  let selfGrades: Record<string, PracticeGrade> | undefined;
  if (body.selfGrades !== undefined) {
    if (!body.selfGrades || typeof body.selfGrades !== "object" || Array.isArray(body.selfGrades))
      return undefined;
    const gradeEntries = Object.entries(body.selfGrades as Record<string, unknown>);
    if (
      gradeEntries.length > 200 ||
      gradeEntries.some(
        ([key, grade]) =>
          !key ||
          key.length > 200 ||
          typeof grade !== "string" ||
          !GRADES.has(grade as PracticeGrade),
      )
    )
      return undefined;
    selfGrades = Object.fromEntries(gradeEntries) as Record<string, PracticeGrade>;
  }
  return {
    courseId: body.courseId.trim(),
    answers: body.answers as Record<string, string>,
    ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
    ...(Array.isArray(body.questionIds) ? { questionIds: body.questionIds as string[] } : {}),
    ...(selfGrades ? { selfGrades } : {}),
    ...(typeof body.selfRating === "number" ? { selfRating: body.selfRating } : {}),
  };
}
