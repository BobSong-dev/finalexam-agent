import { NextRequest, NextResponse } from "next/server";
import {
  WorkspaceStoreError,
  setQuestionAnswerOverride,
  toPublicWorkspace,
} from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DynamicRouteContext {
  params: Promise<{ id: string }>;
}

/** 修正某道题的正确答案；之后的判分与错题回顾都以修正值为准。 */
export async function PATCH(request: NextRequest, context: DynamicRouteContext) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "question-answer-update", 60);
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "请求必须是 JSON 对象。" }, { status: 400 });
    }
    const answer = (body as { answer?: unknown }).answer;
    if (typeof answer !== "string" || answer.length > 2_000) {
      return NextResponse.json({ error: "answer 必须是不超过 2000 字的字符串。" }, { status: 400 });
    }
    const workspace = await setQuestionAnswerOverride(id, answer);
    return NextResponse.json(toPublicWorkspace(workspace), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "答案修正失败，请稍后重试。" }, { status: 500 });
  }
}
