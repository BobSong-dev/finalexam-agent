import "server-only";

import { randomUUID } from "node:crypto";
import {
  analyzeDocument,
  pinCustomUpstream,
  resolveAiRequestConfig,
  resolveModel,
  synthesizeCourse,
  type StoredDocumentFile,
} from "./ai-analysis";
import { aiPool } from "./runtime-capacity";
import { generateAndSavePlan } from "./plan-generation";
import {
  clearProcessingFailure,
  createCourseSynthesisSourceSnapshot,
  failMaterialAnalysis,
  findReusableAnalysis,
  saveReusedAnalysis,
  getStoredMaterialFileReference,
  getWorkspace,
  recordProcessingFailure,
  recoverInterruptedWork,
  saveCourseSynthesis,
  saveDocumentAnalysis,
  setProcessingJobStage,
  upsertProcessingJob,
  removeProcessingJob,
} from "./workspace-store";

export type BackgroundAiRequest = {
  model?: string;
  requestKey?: string | null;
  requestBaseUrl?: string | null;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  __finaleAiJobs?: { shuttingDown: boolean; inflight: Set<Promise<void>>; bootId: string };
};

function jobs() {
  return (runtimeGlobal.__finaleAiJobs ??= {
    shuttingDown: false,
    inflight: new Set(),
    bootId: randomUUID(),
  });
}

/** 当前进程标识；用于识别上一次运行遗留的任务。 */
export function currentBootId(): string {
  return jobs().bootId;
}

export function isAiRuntimeShuttingDown(): boolean {
  return jobs().shuttingDown;
}

/**
 * 进程启动时清理上一次运行留下的中间态：任务清空、卡在「分析中」的资料标记为可重试的失败、
 * 失效的计划租约释放。没有这一步，崩溃重启后 UI 会永远显示“正在分析/正在综合”并持续轮询。
 */
export async function recoverStaleJobs(): Promise<void> {
  const result = await recoverInterruptedWork();
  if (result.interruptedMaterials || result.interruptedJobs) {
    console.warn("finale.jobs.recovered", result);
  }
}

export async function drainAiJobs(timeoutMs = 12_000): Promise<void> {
  jobs().shuttingDown = true;
  const deadline = Date.now() + timeoutMs;
  while (jobs().inflight.size && Date.now() < deadline) {
    await Promise.race([
      Promise.allSettled([...jobs().inflight]),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  }
  // 超时后仍未完成的任务不可能再写回结果，明确标记失败，避免下次启动时留下悬空状态。
  if (jobs().inflight.size) await recoverInterruptedWork().catch(() => undefined);
}

function track(run: Promise<void>): void {
  jobs().inflight.add(run);
  void run.finally(() => jobs().inflight.delete(run));
}

export function enqueueMaterialAnalysis(
  materialId: string,
  request: BackgroundAiRequest,
  runId: string,
): void {
  if (jobs().shuttingDown) throw new Error("runtime shutting down");
  track(runMaterialAnalysis(materialId, request, runId));
}

export function enqueueCourseSynthesis(courseId: string, request: BackgroundAiRequest): void {
  if (jobs().shuttingDown) throw new Error("runtime shutting down");
  track(runCourseSynthesis(courseId, request));
}

export function enqueuePlanGeneration(request: BackgroundAiRequest): void {
  if (jobs().shuttingDown) throw new Error("runtime shutting down");
  track(runPlanGeneration(request));
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 500);
  return fallback;
}

async function runMaterialAnalysis(
  materialId: string,
  request: BackgroundAiRequest,
  runId: string,
): Promise<void> {
  const jobId = `analyze:${materialId}`;
  let activeRunId: string | undefined = runId;
  let release: (() => void) | undefined;
  try {
    await upsertProcessingJob({
      id: jobId,
      type: "analyze",
      targetId: materialId,
      stage: "queued",
      bootId: currentBootId(),
    });
    release = await aiPool().acquire(180_000);
    await setProcessingJobStage(jobId, "extracting");

    // 同一份文件已经分析过就复用结果，不再消耗额度。
    const reusable = await findReusableAnalysis(materialId);
    if (reusable) {
      await setProcessingJobStage(jobId, "saving");
      if (
        await saveReusedAnalysis(materialId, activeRunId, reusable.analysis, reusable.sourceName)
      ) {
        activeRunId = undefined;
        await clearProcessingFailure(jobId).catch(() => undefined);
        return;
      }
    }

    const { material, filePath, byteSize } = await getStoredMaterialFileReference(materialId);
    const workspace = await getWorkspace();
    const course = workspace.courses.find((item) => item.id === material.courseId);
    if (!course) throw new Error("资料所属课程已不存在。");
    const model = resolveModel(request.model);
    const config = resolveAiRequestConfig({
      requestKey: request.requestKey,
      requestBaseUrl: request.requestBaseUrl,
    });
    await pinCustomUpstream(config.baseURL, Boolean(request.requestBaseUrl?.trim()));
    await setProcessingJobStage(jobId, "calling-model");
    const file: StoredDocumentFile = {
      name: material.name,
      size: byteSize,
      type: material.mimeType || "application/octet-stream",
      filePath,
    };
    const { analysis, usage } = await analyzeDocument({
      file,
      course: {
        name: course.name,
        code: course.code,
        teacher: course.teacher,
        term: course.term,
        examDate: course.examDate,
        priority: course.priority,
      },
      model,
      ...config,
    });
    await setProcessingJobStage(jobId, "saving");
    await saveDocumentAnalysis(materialId, analysis, activeRunId, usage);
    activeRunId = undefined;
    await clearProcessingFailure(jobId).catch(() => undefined);
  } catch (error) {
    const message = errorMessage(error, "AI 分析失败，可检查配置后重试。");
    if (activeRunId)
      await failMaterialAnalysis(
        materialId,
        activeRunId,
        "AI 分析失败，可检查配置后重试。",
        message,
      ).catch(() => undefined);
    await recordProcessingFailure({
      id: jobId,
      type: "analyze",
      targetId: materialId,
      message,
    }).catch(() => undefined);
  } finally {
    await removeProcessingJob(jobId).catch(() => undefined);
    release?.();
  }
}

async function runCourseSynthesis(courseId: string, request: BackgroundAiRequest): Promise<void> {
  let release: (() => void) | undefined;
  const jobId = `synthesize:${courseId}`;
  try {
    await upsertProcessingJob({
      id: jobId,
      type: "synthesize",
      targetId: courseId,
      stage: "queued",
      bootId: currentBootId(),
    });
    release = await aiPool().acquire(180_000);
    await setProcessingJobStage(jobId, "extracting");
    const workspace = await getWorkspace();
    const course = workspace.courses.find((item) => item.id === courseId);
    if (!course) throw new Error("课程已不存在。");
    const analyses = workspace.materials
      .filter((material) => material.courseId === courseId)
      .map((material) => workspace.documentAnalyses[material.id])
      .filter((analysis): analysis is NonNullable<typeof analysis> => Boolean(analysis));
    if (!analyses.length) throw new Error("没有可综合的已分析资料。");
    const snapshot = createCourseSynthesisSourceSnapshot(workspace, courseId);
    const model = resolveModel(request.model);
    const config = resolveAiRequestConfig({
      requestKey: request.requestKey,
      requestBaseUrl: request.requestBaseUrl,
    });
    await pinCustomUpstream(config.baseURL, Boolean(request.requestBaseUrl?.trim()));
    await setProcessingJobStage(jobId, "calling-model");
    const { synthesis, usage } = await synthesizeCourse({
      course: {
        name: course.name,
        code: course.code,
        teacher: course.teacher,
        term: course.term,
        examDate: course.examDate,
        priority: course.priority,
      },
      analyses,
      model,
      ...config,
    });
    await setProcessingJobStage(jobId, "saving");
    await saveCourseSynthesis(courseId, synthesis, snapshot, usage);
    await clearProcessingFailure(jobId).catch(() => undefined);
  } catch (error) {
    // 综合失败不改已有综合结果，但必须留下可见的原因（旧实现静默丢弃了它）。
    await recordProcessingFailure({
      id: jobId,
      type: "synthesize",
      targetId: courseId,
      message: errorMessage(error, "课程综合失败，请稍后重试。"),
    }).catch(() => undefined);
  } finally {
    await removeProcessingJob(jobId).catch(() => undefined);
    release?.();
  }
}

async function runPlanGeneration(request: BackgroundAiRequest): Promise<void> {
  const jobId = "plan:generate";
  let release: (() => void) | undefined;
  try {
    await upsertProcessingJob({
      id: jobId,
      type: "plan",
      targetId: "workspace",
      stage: "queued",
      bootId: currentBootId(),
    });
    release = await aiPool().acquire(180_000);
    await setProcessingJobStage(jobId, "calling-model");
    await generateAndSavePlan(request);
    await clearProcessingFailure(jobId).catch(() => undefined);
  } catch (error) {
    await recordProcessingFailure({
      id: jobId,
      type: "plan",
      targetId: "workspace",
      message: errorMessage(error, "计划生成失败，请稍后重试。"),
    }).catch(() => undefined);
  } finally {
    await removeProcessingJob(jobId).catch(() => undefined);
    release?.();
  }
}
