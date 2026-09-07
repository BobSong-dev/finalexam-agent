import "server-only";

import { analyzeDocument, pinCustomUpstream, resolveAiRequestConfig, resolveModel, synthesizeCourse, type StoredDocumentFile } from "./ai-analysis";
import { waitForHeavyRequestSlot } from "./runtime-capacity";
import {
  createCourseSynthesisSourceSnapshot,
  failMaterialAnalysis,
  getStoredMaterialFileReference,
  getWorkspace,
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
  __finaleAiJobs?: { shuttingDown: boolean; inflight: Set<Promise<void>> };
};

function jobs() {
  return runtimeGlobal.__finaleAiJobs ??= { shuttingDown: false, inflight: new Set() };
}

export function isAiRuntimeShuttingDown(): boolean {
  return jobs().shuttingDown;
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
}

function track(run: Promise<void>): void {
  jobs().inflight.add(run);
  void run.finally(() => jobs().inflight.delete(run));
}

export function enqueueMaterialAnalysis(materialId: string, request: BackgroundAiRequest, runId: string): void {
  if (jobs().shuttingDown) throw new Error("runtime shutting down");
  track(runMaterialAnalysis(materialId, request, runId));
}

export function enqueueCourseSynthesis(courseId: string, request: BackgroundAiRequest): void {
  if (jobs().shuttingDown) throw new Error("runtime shutting down");
  track(runCourseSynthesis(courseId, request));
}

async function runMaterialAnalysis(materialId: string, request: BackgroundAiRequest, runId: string): Promise<void> {
  let activeRunId: string | undefined = runId;
  let release: (() => void) | undefined;
  try {
    await upsertProcessingJob({ id: `analyze:${materialId}`, type: "analyze", targetId: materialId, stage: "queued" });
    release = await waitForHeavyRequestSlot();
    await setProcessingJobStage(`analyze:${materialId}`, "extracting");
    const { material, filePath, byteSize } = await getStoredMaterialFileReference(materialId);
    const workspace = await getWorkspace();
    const course = workspace.courses.find((item) => item.id === material.courseId);
    if (!course) throw new Error("course missing");
    const model = resolveModel(request.model);
    const config = resolveAiRequestConfig({ requestKey: request.requestKey, requestBaseUrl: request.requestBaseUrl });
    await pinCustomUpstream(config.baseURL, Boolean(request.requestBaseUrl?.trim()));
    await setProcessingJobStage(`analyze:${materialId}`, "calling-model");
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
    await setProcessingJobStage(`analyze:${materialId}`, "saving");
    await saveDocumentAnalysis(materialId, analysis, activeRunId, usage);
    activeRunId = undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 分析失败";
    if (activeRunId) await failMaterialAnalysis(materialId, activeRunId, "AI 分析失败，可检查配置后重试。", message.slice(0, 500)).catch(() => undefined);
  } finally {
    await removeProcessingJob(`analyze:${materialId}`).catch(() => undefined);
    release?.();
  }
}

async function runCourseSynthesis(courseId: string, request: BackgroundAiRequest): Promise<void> {
  let release: (() => void) | undefined;
  const jobId = `synthesize:${courseId}`;
  try {
    await upsertProcessingJob({ id: jobId, type: "synthesize", targetId: courseId, stage: "queued" });
    release = await waitForHeavyRequestSlot();
    await setProcessingJobStage(jobId, "extracting");
    const workspace = await getWorkspace();
    const course = workspace.courses.find((item) => item.id === courseId);
    if (!course) throw new Error("course missing");
    const analyses = workspace.materials
      .filter((material) => material.courseId === courseId)
      .map((material) => workspace.documentAnalyses[material.id])
      .filter((analysis): analysis is NonNullable<typeof analysis> => Boolean(analysis));
    if (!analyses.length) throw new Error("no analyses");
    const snapshot = createCourseSynthesisSourceSnapshot(workspace, courseId);
    const model = resolveModel(request.model);
    const config = resolveAiRequestConfig({ requestKey: request.requestKey, requestBaseUrl: request.requestBaseUrl });
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
  } catch {
    // 综合失败不改已有综合结果，只清进度。
  } finally {
    await removeProcessingJob(jobId).catch(() => undefined);
    release?.();
  }
}
