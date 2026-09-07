import { NextRequest, NextResponse } from "next/server";
import { AiAnalysisError, analyzeDocument, pinCustomUpstream, resolveAiRequestConfig, resolveModel } from "@/lib/ai-analysis";
import { enqueueMaterialAnalysis, isAiRuntimeShuttingDown } from "@/lib/ai-jobs";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";
import { acquireHeavyRequestSlot, runtimeCapacityErrorResponse } from "@/lib/runtime-capacity";
import { WorkspaceStoreError, beginMaterialAnalysis, failMaterialAnalysis, getStoredMaterialFileReference, getWorkspace, saveDocumentAnalysis, toPublicWorkspace, upsertProcessingJob } from "@/lib/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

interface AnalysisRequest {
  model?: string;
  background?: boolean;
}

export async function POST(request: NextRequest, context: RouteContext<"/api/materials/[id]/analyze">) {
  const { id } = await context.params;
  let analysisRunId: string | undefined;
  let releaseCapacity: (() => void) | undefined;
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "material-analyze", 20);
    const parsedBody: unknown = await request.json().catch(() => ({}));
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw new WorkspaceStoreError("分析请求必须是 JSON 对象。", 400);
    }
    const body = parsedBody as AnalysisRequest;
    if (body.model !== undefined && typeof body.model !== "string") {
      throw new WorkspaceStoreError("model 必须是字符串。", 400);
    }
    const { material, filePath, byteSize } = await getStoredMaterialFileReference(id);
    const model = resolveModel(body.model);
    const requestBaseUrl = request.headers.get("x-openai-base-url");
    const { apiKey, baseURL } = resolveAiRequestConfig({
      requestKey: request.headers.get("x-openai-api-key"),
      requestBaseUrl,
    });
    await pinCustomUpstream(baseURL, Boolean(requestBaseUrl?.trim()));
    const courseContext = (await getWorkspace()).courses.find((item) => item.id === material.courseId);
    if (!courseContext) throw new WorkspaceStoreError("资料所属课程已不存在。", 404);
    if (isAiRuntimeShuttingDown()) throw new WorkspaceStoreError("服务正在停止，请稍后重试分析。", 503);
    const reservation = await beginMaterialAnalysis(id);
    analysisRunId = reservation.runId;
    const coursePayload = { name: courseContext.name, code: courseContext.code, teacher: courseContext.teacher, term: courseContext.term, examDate: courseContext.examDate, priority: courseContext.priority };
    if (body.background === true) {
      await upsertProcessingJob({ id: `analyze:${id}`, type: "analyze", targetId: id, stage: "queued" });
      enqueueMaterialAnalysis(id, {
        model,
        requestKey: request.headers.get("x-openai-api-key"),
        requestBaseUrl,
      }, analysisRunId);
      analysisRunId = undefined;
      return NextResponse.json({
        accepted: true,
        background: true,
        model,
        workspace: toPublicWorkspace(await getWorkspace()),
        notice: "分析已在后台开始，可以离开此页。完成后资料卡会更新。",
      }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    releaseCapacity = acquireHeavyRequestSlot();
    const { analysis, usage } = await analyzeDocument({
      file: {
        name: material.name,
        size: byteSize,
        type: material.mimeType || "application/octet-stream",
        filePath,
      },
      course: coursePayload,
      model,
      apiKey,
      baseURL,
    });
    const workspace = await saveDocumentAnalysis(id, analysis, analysisRunId, usage);
    analysisRunId = undefined;
    return NextResponse.json({ provider: "openai", model, analysis, workspace: toPublicWorkspace(workspace) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    const capacity = runtimeCapacityErrorResponse(error);
    if (capacity) return capacity;
    // Never persist a raw runtime/provider error: it can include local paths
    // or implementation details that later appear in the public workspace.
    const message = error instanceof AiAnalysisError || error instanceof WorkspaceStoreError
      ? error.message
      : "AI 分析服务暂时不可用，请检查配置后重试。";
    if (analysisRunId) {
      await failMaterialAnalysis(id, analysisRunId, "AI 分析失败，可检查配置后重试。", message).catch(() => undefined);
    }
    return errorResponse(error);
  } finally {
    releaseCapacity?.();
  }
}

function errorResponse(error: unknown) {
  if (error instanceof AiAnalysisError || error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: "AI 分析请求无法完成，请检查请求地址、Key 和网络后重试。" }, { status: 500 });
}
