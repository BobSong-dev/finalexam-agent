import { NextRequest, NextResponse } from "next/server";
import { AiAnalysisError, generateStudyPlan, resolveAiRequestConfig, resolveModel } from "@/lib/ai-analysis";
import { PlanValidationError, buildAdaptivePlan, materializeAiPlan, validatePlanRequest } from "@/lib/plan-engine";
import { WorkspaceStoreError, abandonPlanGeneration, beginPlanGeneration, clockTimeToMinutes, rebuildPlan, replacePlanWithGeneratedPlan, toPublicWorkspace } from "@/lib/workspace-store";
import type { PlanRequest } from "@/lib/types";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface PlanGenerateBody {
  model?: string;
}

export async function POST(request: NextRequest) {
  let planRunId: string | undefined;
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "plan-generate", 20);
    const body = await request.json().catch(() => null) as PlanRequest | PlanGenerateBody | null;

    // Stateless preview for the documented PlanRequest contract. It is an
    // explicit local algorithm and is labeled as such in the response.
    if (body && Array.isArray((body as PlanRequest).courses) && Array.isArray((body as PlanRequest).availability) && (body as PlanRequest).fromDate) {
      validatePlanRequest(body as PlanRequest);
      return NextResponse.json({
        plan: buildAdaptivePlan(body as PlanRequest),
        generatedBy: "schedule",
        explanation: "预览排期（本地算法，不持久化，未调用 AI）。",
      }, { headers: { "Cache-Control": "no-store" } });
    }

    // The regenerate action is a real AI generation when a key is available.
    // When none is configured, fall back to the deterministic scheduler and
    // say so explicitly instead of presenting an algorithm as model output.
    let aiConfig: ReturnType<typeof resolveAiRequestConfig>;
    try {
      aiConfig = resolveAiRequestConfig({
        requestKey: request.headers.get("x-openai-api-key"),
        requestBaseUrl: request.headers.get("x-openai-base-url"),
      });
    } catch (error) {
      if (error instanceof AiAnalysisError && error.status === 401) {
        const rebuilt = await rebuildPlan();
        return NextResponse.json({
          plan: rebuilt.tasks,
          workspace: toPublicWorkspace(rebuilt),
          generatedBy: "schedule",
          explanation: "未配置 AI：已按考试日期、优先级、掌握度与每日可用时间本地重排，未调用 AI。",
        }, { headers: { "Cache-Control": "no-store" } });
      }
      throw error;
    }

    const modelBody = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as PlanGenerateBody;
    if (modelBody.model !== undefined && typeof modelBody.model !== "string") {
      throw new WorkspaceStoreError("model 必须是字符串。", 400);
    }

    const model = resolveModel(modelBody.model);
    const reservation = await beginPlanGeneration();
    planRunId = reservation.runId;
    const { context } = reservation;

    const entries = await generateStudyPlan({
      courses: context.aiCourses,
      availability: context.availability,
      model,
      ...aiConfig,
    });
    const tasks = materializeAiPlan(
      entries,
      context.courses,
      context.availability,
      clockTimeToMinutes(context.studyDayStart),
    );
    const totalCapacity = context.availability.reduce((total, day) => total + day.minutes, 0);
    if (!tasks.length && totalCapacity > 0) {
      throw new AiAnalysisError("AI 生成的计划没有可用任务，请调整资料或重试。", 502);
    }
    const saved = await replacePlanWithGeneratedPlan(tasks, reservation);
    planRunId = undefined;
    return NextResponse.json({
      plan: saved.tasks,
      workspace: toPublicWorkspace(saved),
      generatedBy: "ai",
      explanation: "AI 已依据考点证据、考试临近度与每日可用时间生成计划，且不超过每日可用时长。",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (planRunId) await abandonPlanGeneration(planRunId).catch(() => undefined);
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof AiAnalysisError || error instanceof WorkspaceStoreError || error instanceof PlanValidationError) {
      return NextResponse.json({ error: error.message }, { status: error instanceof WorkspaceStoreError ? error.status : error instanceof PlanValidationError ? 400 : error.status });
    }
    return NextResponse.json({ error: "计划生成失败，请稍后重试。" }, { status: 500 });
  }
}
