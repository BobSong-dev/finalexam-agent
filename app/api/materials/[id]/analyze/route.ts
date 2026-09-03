import { NextRequest, NextResponse } from "next/server";
import { AiAnalysisError, analyzeDocument, resolveAiRequestConfig, resolveModel } from "@/lib/ai-analysis";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";
import { acquireHeavyRequestSlot, runtimeCapacityErrorResponse } from "@/lib/runtime-capacity";
import { WorkspaceStoreError, beginMaterialAnalysis, failMaterialAnalysis, getStoredMaterialFileReference, getWorkspace, saveDocumentAnalysis, toPublicWorkspace } from "@/lib/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface AnalysisRequest {
  model?: string;
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
    const { apiKey, baseURL } = resolveAiRequestConfig({
      requestKey: request.headers.get("x-openai-api-key"),
      requestBaseUrl: request.headers.get("x-openai-base-url"),
    });
    const courseContext = (await getWorkspace()).courses.find((item) => item.id === material.courseId);
    if (!courseContext) throw new WorkspaceStoreError("资料所属课程已不存在。", 404);
    releaseCapacity = acquireHeavyRequestSlot();
    const reservation = await beginMaterialAnalysis(id);
    analysisRunId = reservation.runId;
    const analysis = await analyzeDocument({
      file: {
        name: material.name,
        size: byteSize,
        type: material.mimeType || "application/octet-stream",
        filePath,
      },
      course: { name: courseContext.name, code: courseContext.code, teacher: courseContext.teacher, term: courseContext.term },
      model,
      apiKey,
      baseURL,
    });
    const workspace = await saveDocumentAnalysis(id, analysis, analysisRunId);
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
