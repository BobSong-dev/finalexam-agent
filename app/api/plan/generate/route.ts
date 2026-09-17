import { NextRequest, NextResponse } from "next/server";
import { AiAnalysisError } from "@/lib/ai-analysis";
import { enqueuePlanGeneration, isAiRuntimeShuttingDown } from "@/lib/ai-jobs";
import { generateAndSavePlan } from "@/lib/plan-generation";
import { PlanValidationError, buildAdaptivePlan, validatePlanRequest } from "@/lib/plan-engine";
import {
  WorkspaceStoreError,
  getWorkspace,
  rebuildPlan,
  toPublicWorkspace,
  upsertProcessingJob,
} from "@/lib/workspace-store";
import type { PlanRequest } from "@/lib/types";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";
import { runtimeCapacityErrorResponse } from "@/lib/runtime-capacity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

interface PlanGenerateBody {
  model?: string;
  background?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "plan-generate", 20);
    const body = (await request.json().catch(() => null)) as
      (PlanRequest & PlanGenerateBody) | null;

    // Stateless preview for the documented PlanRequest contract. It is an
    // explicit local algorithm and is labeled as such in the response.
    if (
      body &&
      Array.isArray((body as PlanRequest).courses) &&
      Array.isArray((body as PlanRequest).availability) &&
      (body as PlanRequest).fromDate
    ) {
      validatePlanRequest(body as PlanRequest);
      return NextResponse.json(
        {
          plan: buildAdaptivePlan(body as PlanRequest),
          generatedBy: "schedule",
          explanation: "预览排期（本地算法，不持久化，未调用 AI）。",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const modelBody = (
      body && typeof body === "object" && !Array.isArray(body) ? body : {}
    ) as PlanGenerateBody;
    if (modelBody.model !== undefined && typeof modelBody.model !== "string") {
      throw new WorkspaceStoreError("model 必须是字符串。", 400);
    }
    if (modelBody.background !== undefined && typeof modelBody.background !== "boolean") {
      throw new WorkspaceStoreError("background 必须是布尔值。", 400);
    }

    const aiRequest = {
      model: modelBody.model,
      requestKey: request.headers.get("x-openai-api-key"),
      requestBaseUrl: request.headers.get("x-openai-base-url"),
    };

    // 后台模式与分析/综合保持一致：立刻返回 202，结果写回工作区。
    if (modelBody.background === true) {
      if (isAiRuntimeShuttingDown())
        throw new WorkspaceStoreError("服务正在停止，请稍后重试。", 503);
      await upsertProcessingJob({
        id: "plan:generate",
        type: "plan",
        targetId: "workspace",
        stage: "queued",
      });
      enqueuePlanGeneration(aiRequest);
      return NextResponse.json(
        {
          accepted: true,
          background: true,
          workspace: toPublicWorkspace(await getWorkspace()),
          notice: "计划正在后台生成，可以离开此页。完成后计划页会自动更新。",
        },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    }

    let workspace;
    try {
      workspace = await generateAndSavePlan(aiRequest);
    } catch (error) {
      if (error instanceof AiAnalysisError && error.status === 401) {
        const rebuilt = await rebuildPlan();
        return NextResponse.json(
          {
            plan: rebuilt.tasks,
            workspace: toPublicWorkspace(rebuilt),
            generatedBy: "schedule",
            explanation:
              "未配置 AI：已按考试日期、优先级、掌握度与每日可用时间本地重排，未调用 AI。",
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      throw error;
    }
    return NextResponse.json(
      {
        plan: workspace.tasks,
        workspace: toPublicWorkspace(workspace),
        generatedBy: "ai",
        explanation: "AI 已依据考点证据、考试临近度与每日可用时间生成计划，且不超过每日可用时长。",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    const capacity = runtimeCapacityErrorResponse(error);
    if (capacity) return capacity;
    if (
      error instanceof AiAnalysisError ||
      error instanceof WorkspaceStoreError ||
      error instanceof PlanValidationError
    ) {
      return NextResponse.json(
        { error: error.message },
        {
          status:
            error instanceof AiAnalysisError
              ? error.status
              : error instanceof WorkspaceStoreError
                ? error.status
                : 400,
        },
      );
    }
    return NextResponse.json({ error: "计划生成失败，请稍后重试。" }, { status: 500 });
  }
}
