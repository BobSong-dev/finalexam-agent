import "server-only";

import {
  generateStudyPlan,
  pinCustomUpstream,
  resolveAiRequestConfig,
  resolveModel,
} from "./ai-analysis";
import { materializeAiPlan } from "./plan-engine";
import {
  WorkspaceStoreError,
  abandonPlanGeneration,
  beginPlanGeneration,
  clockTimeToMinutes,
  replacePlanWithGeneratedPlan,
} from "./workspace-store";
import type { WorkspaceState } from "./workspace-types";

export interface PlanGenerationRequest {
  model?: string;
  requestKey?: string | null;
  requestBaseUrl?: string | null;
}

/**
 * 生成并保存 AI 计划。前台请求与后台任务共用这一条路径，避免两处实现漂移：
 * 任何失败都会释放本次租约，不会让后续生成被旧租约挡住。
 */
export async function generateAndSavePlan(request: PlanGenerationRequest): Promise<WorkspaceState> {
  const model = resolveModel(request.model);
  const config = resolveAiRequestConfig({
    requestKey: request.requestKey,
    requestBaseUrl: request.requestBaseUrl,
  });
  await pinCustomUpstream(config.baseURL, Boolean(request.requestBaseUrl?.trim()));

  const reservation = await beginPlanGeneration();
  try {
    const { context } = reservation;
    const knownFocuses = new Set(
      context.aiCourses.flatMap((course) => [
        ...course.insights.map((insight) => insight.title),
        ...course.recentMisses.map((miss) => miss.topic),
      ]),
    );
    const { entries, usage } = await generateStudyPlan({
      courses: context.aiCourses,
      availability: context.availability,
      model,
      ...config,
    });
    const tasks = materializeAiPlan(
      entries,
      context.courses,
      context.availability,
      clockTimeToMinutes(context.studyDayStart),
      knownFocuses,
    );
    const totalCapacity = context.availability.reduce((total, day) => total + day.minutes, 0);
    if (!tasks.length && totalCapacity > 0) {
      throw new WorkspaceStoreError("AI 生成的计划没有可用任务，请调整资料或重试。", 502);
    }
    return await replacePlanWithGeneratedPlan(tasks, reservation, usage);
  } catch (error) {
    await abandonPlanGeneration(reservation.runId).catch(() => undefined);
    throw error;
  }
}
