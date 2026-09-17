import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, createPracticeSession } from "@/lib/workspace-store";
import type { PublicQuestion } from "@/lib/workspace-types";
import type { Question } from "@/lib/types";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 创建一次练习会话：服务端按错题/薄弱知识点抽题并记住题集，
 * 之后 /api/assessments/submit 只对这个题集判分，避免“只看到 3 题却按 40 题判错”。
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "practice-session", 60);
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return NextResponse.json({ error: "请求必须是 JSON 对象。" }, { status: 400 });
    const payload = body as { courseId?: unknown; knowledge?: unknown; size?: unknown };
    if (typeof payload.courseId !== "string" || !payload.courseId.trim())
      return NextResponse.json({ error: "courseId 为必填项。" }, { status: 400 });
    if (
      payload.knowledge !== undefined &&
      (typeof payload.knowledge !== "string" || payload.knowledge.length > 200)
    )
      return NextResponse.json(
        { error: "knowledge 必须是不超过 200 字的字符串。" },
        { status: 400 },
      );
    if (
      payload.size !== undefined &&
      (typeof payload.size !== "number" ||
        !Number.isInteger(payload.size) ||
        payload.size < 1 ||
        payload.size > 25)
    )
      return NextResponse.json({ error: "size 必须是 1–25 的整数。" }, { status: 400 });
    const { session, questions } = await createPracticeSession({
      courseId: payload.courseId.trim(),
      ...(typeof payload.knowledge === "string" ? { knowledge: payload.knowledge } : {}),
      ...(typeof payload.size === "number" ? { size: payload.size } : {}),
    });
    return NextResponse.json(
      {
        sessionId: session.id,
        expiresAt: session.expiresAt,
        knowledgeKey: session.knowledgeKey ?? null,
        questions: questions.map(toPublicQuestion),
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "练习会话创建失败，请稍后重试。" }, { status: 500 });
  }
}

function toPublicQuestion(question: Question): PublicQuestion {
  const { answer: _answer, explanation: _explanation, ...publicQuestion } = question;
  return publicQuestion;
}
