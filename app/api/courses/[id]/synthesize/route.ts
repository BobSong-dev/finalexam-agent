import { NextRequest, NextResponse } from "next/server";
import { AiAnalysisError, pinCustomUpstream, resolveAiRequestConfig, resolveModel, synthesizeCourse } from "@/lib/ai-analysis";
import { enqueueCourseSynthesis, isAiRuntimeShuttingDown } from "@/lib/ai-jobs";
import { WorkspaceStoreError, createCourseSynthesisSourceSnapshot, getWorkspace, saveCourseSynthesis, toPublicWorkspace, upsertProcessingJob } from "@/lib/workspace-store";
import { acquireHeavyRequestSlot, runtimeCapacityErrorResponse } from "@/lib/runtime-capacity";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;


interface SynthesisRequest {
  model?: string;
  background?: boolean;
}

interface DynamicRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: DynamicRouteContext) {
  let releaseCapacity: (() => void) | undefined;
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "course-synthesize", 20);
    const { id } = await context.params;
    const parsedBody: unknown = await request.json().catch(() => ({}));
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw new WorkspaceStoreError("课程综合请求必须是 JSON 对象。", 400);
    }
    const body = parsedBody as SynthesisRequest;
    if (body.model !== undefined && typeof body.model !== "string") {
      throw new WorkspaceStoreError("model 必须是字符串。", 400);
    }
    const workspace = await getWorkspace();
    const course = workspace.courses.find((item) => item.id === id);
    if (!course) throw new WorkspaceStoreError("未找到课程。", 404);
    const analyses = workspace.materials
      .filter((material) => material.courseId === id)
      .map((material) => workspace.documentAnalyses[material.id])
      .filter((analysis): analysis is NonNullable<typeof analysis> => Boolean(analysis));
    if (!analyses.length) throw new WorkspaceStoreError("请先完成至少一份资料的 AI 分析，再生成课程综合。", 400);

    const sourceSnapshot = createCourseSynthesisSourceSnapshot(workspace, id);
    const model = resolveModel(body.model);
    const requestBaseUrl = request.headers.get("x-openai-base-url");
    const aiConfig = resolveAiRequestConfig({
      requestKey: request.headers.get("x-openai-api-key"),
      requestBaseUrl,
    });
    await pinCustomUpstream(aiConfig.baseURL, Boolean(requestBaseUrl?.trim()));
    if (isAiRuntimeShuttingDown()) throw new WorkspaceStoreError("服务正在停止，请稍后重试。", 503);
    const coursePayload = { name: course.name, code: course.code, teacher: course.teacher, term: course.term, examDate: course.examDate, priority: course.priority };
    if (body.background === true) {
      await upsertProcessingJob({ id: `synthesize:${id}`, type: "synthesize", targetId: id, stage: "queued" });
      enqueueCourseSynthesis(id, { model, requestKey: request.headers.get("x-openai-api-key"), requestBaseUrl });
      return NextResponse.json({
        accepted: true,
        background: true,
        model,
        workspace: toPublicWorkspace(await getWorkspace()),
        notice: "课程综合已在后台开始，完成后高频考点会自动更新。",
      }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    releaseCapacity = acquireHeavyRequestSlot();
    const { synthesis, usage } = await synthesizeCourse({
      course: coursePayload,
      analyses,
      model,
      ...aiConfig,
    });
    const nextWorkspace = await saveCourseSynthesis(id, synthesis, sourceSnapshot, usage);
    return NextResponse.json({ provider: "openai", model, analysis: synthesis, workspace: toPublicWorkspace(nextWorkspace) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    const capacity = runtimeCapacityErrorResponse(error);
    if (capacity) return capacity;
    if (error instanceof AiAnalysisError || error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "课程综合无法完成，请检查 AI 配置和网络后重试。" }, { status: 500 });
  } finally {
    releaseCapacity?.();
  }
}
