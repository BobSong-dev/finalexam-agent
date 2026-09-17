import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { buildAdaptivePlan, examPhaseLabel, insightImportance } from "./plan-engine";
import type {
  AiPlanCourse,
  AiTokenUsage,
  CourseSynthesis,
  DocumentAnalysis,
  ProcessingFailure,
  ProcessingJob,
} from "./ai-types";
import { inferMimeType, isSupportedFile } from "./ai-analysis";
import { timingSafeEqualText } from "./http-security";
import { knowledgeKeysRelated, normalizeKnowledgeKey } from "./knowledge";
import { migrateWorkspaceRaw } from "./workspace-migrations";
import type {
  Availability,
  Course,
  CreditTransaction,
  Insight,
  KnowledgeMasteryRecord,
  MaterialKind,
  PracticeGrade,
  Question,
  RecentMissedTopic,
  SharedMaterial,
  StudyTask,
} from "./types";
import {
  WORKSPACE_SCHEMA_VERSION,
  type AssessmentAttempt,
  type AssessmentAttemptItem,
  type AuditEvent,
  type CourseInput,
  type ModerationQueue,
  type PracticeReveal,
  type PracticeSession,
  type PublicMaterial,
  type PublicQuestion,
  type PublicSharedMaterial,
  type PublicWorkspaceState,
  type StoredMaterial,
  type StoredSharedMaterial,
  type WorkspaceState,
} from "./workspace-types";

const STATE_FILENAME = "workspace.json";
const UPLOAD_DIRECTORY = "uploads";
const DEFAULT_AVAILABILITY_MINUTES = 120;
const COURSE_COLORS = ["#6d5dfc", "#10a98b", "#ed8b4a", "#3278c7", "#b863c8", "#d55d78"];
const ACTIVE_SHARED_STATUSES: ReadonlySet<SharedMaterial["status"]> = new Set(["可解锁", "已解锁"]);
const PLAN_WINDOW_DAYS = 7;
const STALE_ANALYSIS_RESERVATION_MS = 30 * 60_000;
const DEFAULT_STUDY_DAY_START = "18:30";
const MISSED_TASKS_LIMIT = 60;
export const UPLOAD_ORPHAN_GRACE_MS = 120_000;
const STATE_LOCK_STALE_MS = 30_000;
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000;
const PRACTICE_SESSION_TTL_MS = 45 * 60_000;
const PRACTICE_SESSIONS_LIMIT = 30;
const DEFAULT_PRACTICE_SIZE = 10;
const MAX_PRACTICE_SIZE = 25;

let writeTail: Promise<void> = Promise.resolve();
let uploadReconciliation: Promise<void> | undefined;
let orphanSweeper: NodeJS.Timeout | undefined;

/**
 * 进程内读取缓存。每次 getWorkspace 都重新读盘 + 解析整份 JSON，在 2 秒轮询下
 * 会变成持续的全量 IO；这里用 mtime/size 判断文件是否真的变了。
 */
let stateCache: { state: WorkspaceState; mtimeMs: number; size: number } | undefined;

function invalidateStateCache(): void {
  stateCache = undefined;
}

export class WorkspaceStoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "WorkspaceStoreError";
  }
}

/**
 * Immutable evidence set used to guard an expensive course synthesis write.
 * The request captures it before calling an AI provider; saving the result
 * succeeds only when the same analyzed materials still back the course.
 */
export interface CourseSynthesisSourceSnapshot {
  sources: ReadonlyArray<{
    materialId: string;
    updatedAt: string;
    analysisHash: string;
  }>;
}

export function getWorkspaceDataDirectory(): string {
  // The data root is deliberately configurable for self-hosting. It is used
  // only by Node runtime route handlers, never bundled into a client asset.
  return path.resolve(
    /* turbopackIgnore: true */ process.env.FINALE_DATA_DIR?.trim() ||
      path.join(process.cwd(), "data"),
  );
}

function getStatePath(): string {
  return path.join(getWorkspaceDataDirectory(), STATE_FILENAME);
}

function getUploadsDirectory(): string {
  return path.join(getWorkspaceDataDirectory(), UPLOAD_DIRECTORY);
}

function getSharedDirectory(): string {
  return path.join(getWorkspaceDataDirectory(), UPLOAD_DIRECTORY, "shared");
}

function now(): string {
  return new Date().toISOString();
}

function dateOnly(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Calendar date "today" in a named IANA timezone. The self-hosted runtime may
 * run in a different timezone than the learner (Docker defaults to UTC), so
 * the plan window must roll at the learner's midnight, not the host's.
 */
export function dateOnlyInTimeZone(timeZone: string, date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Invalid persisted timezone values are fail-safe: fall back to host date.
  }
  return dateOnly(date);
}

export function isValidTimeZone(value: string): boolean {
  if (typeof value !== "string" || !value.trim() || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

export function isValidClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function clockTimeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function addDaysToDateOnly(date: string, offset: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function defaultAvailability(timeZone = "Asia/Shanghai"): WorkspaceState["availability"] {
  const today = dateOnlyInTimeZone(timeZone);
  return Array.from({ length: PLAN_WINDOW_DAYS }, (_, index) => ({
    date: addDaysToDateOnly(today, index),
    minutes: DEFAULT_AVAILABILITY_MINUTES,
  }));
}

function emptyWorkspace(): WorkspaceState {
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    updatedAt: now(),
    planSource: "schedule",
    planGenerationLease: undefined,
    profile: {
      id: "local-workspace",
      displayName: "",
      email: "",
      school: "",
      verified: false,
      credits: 0,
      examGoal: "在期末前完成一轮高频考点复习",
      timezone: "Asia/Shanghai",
      studyDayStart: DEFAULT_STUDY_DAY_START,
      aiUsage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    },
    courses: [],
    availability: defaultAvailability("Asia/Shanghai"),
    materials: [],
    insights: [],
    questions: [],
    tasks: [],
    sharedMaterials: [],
    ledger: [],
    documentAnalyses: {},
    courseSyntheses: {},
    assessmentAttempts: [],
    knowledgeMastery: {},
    practiceSessions: [],
    auditLog: [],
    sharedMaterialRecords: [],
    sharedReports: [],
    unlockGrants: [],
    otpChallenges: [],
    missedTasks: [],
    processingJobs: [],
    processingErrors: [],
    hiddenInsights: [],
    answerOverrides: {},
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === WORKSPACE_SCHEMA_VERSION &&
    Boolean(
      candidate.profile &&
      typeof candidate.profile === "object" &&
      !Array.isArray(candidate.profile),
    ) &&
    Array.isArray(candidate.courses) &&
    Array.isArray(candidate.materials)
  );
}

function normalizeWorkspaceState(value: WorkspaceState): WorkspaceState {
  const empty = emptyWorkspace();
  const candidate = value as Partial<WorkspaceState>;
  return {
    ...empty,
    ...candidate,
    profile: {
      ...empty.profile,
      ...(candidate.profile && typeof candidate.profile === "object" ? candidate.profile : {}),
    },
    courses: Array.isArray(candidate.courses) ? candidate.courses : [],
    availability: Array.isArray(candidate.availability)
      ? candidate.availability
      : empty.availability,
    materials: Array.isArray(candidate.materials) ? candidate.materials : [],
    insights: Array.isArray(candidate.insights) ? candidate.insights.map(normalizeInsight) : [],
    questions: Array.isArray(candidate.questions) ? candidate.questions : [],
    tasks: Array.isArray(candidate.tasks) ? candidate.tasks : [],
    sharedMaterials: Array.isArray(candidate.sharedMaterials) ? candidate.sharedMaterials : [],
    ledger: Array.isArray(candidate.ledger) ? candidate.ledger : [],
    documentAnalyses: isRecord(candidate.documentAnalyses) ? candidate.documentAnalyses : {},
    courseSyntheses: isRecord(candidate.courseSyntheses) ? candidate.courseSyntheses : {},
    assessmentAttempts: Array.isArray(candidate.assessmentAttempts)
      ? candidate.assessmentAttempts.map(normalizeAttempt)
      : [],
    knowledgeMastery: isRecord(candidate.knowledgeMastery)
      ? (candidate.knowledgeMastery as WorkspaceState["knowledgeMastery"])
      : {},
    practiceSessions: Array.isArray(candidate.practiceSessions) ? candidate.practiceSessions : [],
    auditLog: Array.isArray(candidate.auditLog) ? candidate.auditLog : [],
    sharedMaterialRecords: Array.isArray(candidate.sharedMaterialRecords)
      ? candidate.sharedMaterialRecords
      : [],
    sharedReports: Array.isArray(candidate.sharedReports) ? candidate.sharedReports : [],
    unlockGrants: Array.isArray(candidate.unlockGrants) ? candidate.unlockGrants : [],
    otpChallenges: Array.isArray(candidate.otpChallenges) ? candidate.otpChallenges : [],
    missedTasks: Array.isArray(candidate.missedTasks) ? candidate.missedTasks : [],
    processingJobs: Array.isArray(candidate.processingJobs) ? candidate.processingJobs : [],
    processingErrors: Array.isArray(candidate.processingErrors) ? candidate.processingErrors : [],
    hiddenInsights: Array.isArray(candidate.hiddenInsights)
      ? candidate.hiddenInsights.filter((id): id is string => typeof id === "string")
      : [],
    answerOverrides: isRecord(candidate.answerOverrides)
      ? (candidate.answerOverrides as WorkspaceState["answerOverrides"])
      : {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAttempt(value: AssessmentAttempt): AssessmentAttempt {
  return {
    ...value,
    items: Array.isArray(value.items) ? value.items : [],
    graded: Number.isFinite(value.graded) ? value.graded : value.total,
  };
}

function normalizeInsight(value: Insight): Insight {
  const frequency = Number.isFinite(value.frequency) ? Math.max(1, Math.round(value.frequency)) : 1;
  const importance =
    Number.isInteger(value.importance) && value.importance >= 1 && value.importance <= 5
      ? value.importance
      : Math.min(5, frequency);
  const mastery = Number.isFinite(value.mastery) ? clamp(Math.round(value.mastery), 0, 100) : 0;
  return { ...value, frequency, importance, mastery };
}

async function ensureDirectories(): Promise<void> {
  await Promise.all([
    mkdir(getWorkspaceDataDirectory(), { recursive: true }),
    mkdir(getUploadsDirectory(), { recursive: true }),
    mkdir(getSharedDirectory(), { recursive: true }),
  ]);
}

async function readWorkspaceInternal(): Promise<WorkspaceState> {
  await ensureDirectories();
  const cached = await readCachedWorkspace();
  if (cached) {
    scheduleOrphanSweep();
    return cached;
  }
  let state: WorkspaceState;
  try {
    const raw = await readFile(getStatePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const upgraded = await upgradeWorkspaceIfNeeded(parsed, raw);
    if (!isWorkspaceState(upgraded))
      throw new WorkspaceStoreError(
        "本地工作区数据格式无效。请备份 data/workspace.json 后重新启动。",
        500,
      );
    state = normalizeWorkspaceState(upgraded);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    state = emptyWorkspace();
  }
  await rememberWorkspaceState(state);
  await reconcileUploadDirectoryOnce(state);
  scheduleOrphanSweep();
  return state;
}

async function readCachedWorkspace(): Promise<WorkspaceState | undefined> {
  if (!stateCache) return undefined;
  try {
    const info = await stat(getStatePath());
    if (info.mtimeMs === stateCache.mtimeMs && info.size === stateCache.size)
      return stateCache.state;
  } catch {
    // 文件被外部删除或暂不可读：退回正常读取路径。
  }
  invalidateStateCache();
  return undefined;
}

async function rememberWorkspaceState(state: WorkspaceState): Promise<void> {
  try {
    const info = await stat(getStatePath());
    stateCache = { state, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    invalidateStateCache();
  }
}

/**
 * 孤儿文件回收原来只在进程生命周期内跑一次，长期运行的实例不会发现中途产生的孤儿；
 * 现在改为最多每 10 分钟一次的后台清扫，并覆盖共享资料目录。
 */
function scheduleOrphanSweep(): void {
  if (orphanSweeper) return;
  orphanSweeper = setInterval(() => {
    void sweepOrphanUploads().catch(() => undefined);
  }, ORPHAN_SWEEP_INTERVAL_MS);
  orphanSweeper.unref?.();
}

export async function sweepOrphanUploads(): Promise<number> {
  uploadReconciliation = undefined;
  const state = await getWorkspace();
  return reconcileUploadDirectory(state);
}

/**
 * 旧版本 JSON 在读取时就地迁移。迁移前把原文件保留为 workspace.v{N}.bak.json，
 * 迁移结果立即原子写回，之后的正常读写只看到新版本。
 */
async function upgradeWorkspaceIfNeeded(parsed: unknown, raw: string): Promise<unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const candidate = parsed as Record<string, unknown>;
  const version = typeof candidate.version === "number" ? candidate.version : 1;
  if (version >= WORKSPACE_SCHEMA_VERSION) return parsed;
  const { state } = migrateWorkspaceRaw(candidate, WORKSPACE_SCHEMA_VERSION);
  const backupPath = path.join(getWorkspaceDataDirectory(), `workspace.v${version}.bak.json`);
  await writeFile(backupPath, raw, { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
    if (!isNodeError(error, "EEXIST")) throw error;
  });
  await writeWorkspaceInternal(state as unknown as WorkspaceState);
  return state;
}

function reconcileUploadDirectoryOnce(state: WorkspaceState): Promise<void> {
  if (uploadReconciliation) return uploadReconciliation;
  uploadReconciliation = reconcileUploadDirectory(state).then(
    () => undefined,
    () => undefined,
  );
  return uploadReconciliation;
}

async function reconcileUploadDirectory(state: WorkspaceState): Promise<number> {
  const uploads = await sweepDirectory(
    getUploadsDirectory(),
    new Set(state.materials.map((material) => material.objectKey)),
  );
  const shared = await sweepDirectory(
    getSharedDirectory(),
    new Set(state.sharedMaterialRecords.map((record) => record.objectKey)),
  );
  return uploads + shared;
}

const UPLOAD_OBJECT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|ppt|pptx|doc|docx|jpg|jpeg|png|webp)$/i;

async function sweepDirectory(directory: string, referenced: Set<string>): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  const nowMs = Date.now();
  let removed = 0;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const isIncoming = entry.name.endsWith(".incoming");
      const isOrphan = UPLOAD_OBJECT_PATTERN.test(entry.name) && !referenced.has(entry.name);
      if (!isIncoming && !isOrphan) return;
      const filePath = path.join(directory, entry.name);
      try {
        const info = await stat(filePath);
        if (nowMs - info.mtimeMs < UPLOAD_ORPHAN_GRACE_MS) return;
        await unlink(filePath);
        removed += 1;
      } catch {
        // 已被其他清理流程或外部操作移除。
      }
    }),
  );
  return removed;
}

async function writeWorkspaceInternal(state: WorkspaceState): Promise<void> {
  await ensureDirectories();
  invalidateStateCache();
  const statePath = getStatePath();
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");
  try {
    const serialized =
      process.env.NODE_ENV === "production"
        ? JSON.stringify(state)
        : `${JSON.stringify(state, null, 2)}\n`;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, statePath);
  stateCache = undefined;
  try {
    const directory = await open(getWorkspaceDataDirectory(), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Windows 等环境可能不允许对目录 fsync，文件本身已经 sync + rename。
  }
}

async function withStateFileLock<T>(operation: () => Promise<T>): Promise<T> {
  await ensureDirectories();
  const lockPath = `${getStatePath()}.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if (Date.now() > deadline) throw new WorkspaceStoreError("工作区正忙，请稍后重试。", 503);
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > STATE_LOCK_STALE_MS)
          await unlink(lockPath).catch(() => undefined);
      } catch {
        // 锁文件可能刚被释放。
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Real read/write probe used by /api/health. It never touches user state. */
export async function checkWorkspaceStorage(): Promise<void> {
  await ensureDirectories();
  const probePath = path.join(getWorkspaceDataDirectory(), `.health-${randomUUID()}.tmp`);
  try {
    await writeFile(probePath, "ok\n", { encoding: "utf8", flag: "wx" });
    await readFile(probePath, "utf8");
  } finally {
    await unlink(probePath).catch(() => undefined);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code,
  );
}

const DEFAULT_UPLOAD_QUOTA_BYTES = 8 * 1024 * 1024 * 1024;

async function assertUploadQuota(incomingBytes: number): Promise<void> {
  const limit = configuredUploadQuota();
  const used = (await getWorkspace()).materials.reduce(
    (total, material) => total + (material.byteSize ?? 0),
    0,
  );
  if (used + incomingBytes > limit) {
    throw new WorkspaceStoreError("本地资料总容量已满，请删除不需要的资料后再上传。", 507);
  }
}

function applyAiUsage(state: WorkspaceState, usage?: AiTokenUsage): void {
  if (!usage || (usage.inputTokens <= 0 && usage.outputTokens <= 0 && usage.requests <= 0)) return;
  const current = state.profile.aiUsage ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
  state.profile.aiUsage = {
    inputTokens: current.inputTokens + Math.max(0, usage.inputTokens),
    outputTokens: current.outputTokens + Math.max(0, usage.outputTokens),
    requests: current.requests + Math.max(0, usage.requests),
  };
}

export async function upsertProcessingJob(
  input: Omit<ProcessingJob, "startedAt" | "updatedAt" | "bootId"> & {
    startedAt?: string;
    bootId?: string;
  },
): Promise<void> {
  await mutateWorkspace((state) => {
    const nowIso = now();
    const existing = (state.processingJobs ??= []).find((job) => job.id === input.id);
    if (existing) {
      existing.stage = input.stage;
      existing.updatedAt = nowIso;
      existing.bootId = input.bootId;
      return clone(state);
    }
    state.processingJobs.unshift({
      id: input.id,
      type: input.type,
      targetId: input.targetId,
      stage: input.stage,
      startedAt: input.startedAt ?? nowIso,
      updatedAt: nowIso,
      ...(input.bootId ? { bootId: input.bootId } : {}),
    });
    if (state.processingJobs.length > 20) state.processingJobs.length = 20;
    return clone(state);
  });
}

/** 记录一次后台任务失败；同一任务只保留最新一条。 */
export async function recordProcessingFailure(input: Omit<ProcessingFailure, "at">): Promise<void> {
  await mutateWorkspaceConditionally((state) => {
    const message = input.message.trim().slice(0, 500) || "任务失败";
    const at = now();
    const existing = (state.processingErrors ??= []).find((item) => item.id === input.id);
    if (existing && existing.message === message) return { changed: false, result: undefined };
    state.processingErrors = [
      { id: input.id, type: input.type, targetId: input.targetId, message, at },
      ...(state.processingErrors ?? []).filter((item) => item.id !== input.id),
    ].slice(0, 20);
    return { changed: true, result: undefined };
  });
}

export async function clearProcessingFailure(id: string): Promise<void> {
  await mutateWorkspaceConditionally((state) => {
    const list = state.processingErrors ?? [];
    const next = list.filter((item) => item.id !== id);
    if (next.length === list.length) return { changed: false, result: undefined };
    state.processingErrors = next;
    return { changed: true, result: undefined };
  });
}

/**
 * 进程启动时清理上一次运行留下的中间状态：
 * - 任何仍在 processingJobs 里的任务都属于已死进程；
 * - 停在「分析中」的资料永远不会完成，标记为可重试的失败；
 * - 未提交的计划生成租约同样失效。
 */
export async function recoverInterruptedWork(): Promise<{
  interruptedMaterials: number;
  interruptedJobs: number;
}> {
  return mutateWorkspaceConditionally((state) => {
    const jobs = state.processingJobs ?? [];
    const interrupted = state.materials.filter((material) => material.status === "分析中");
    const hadLease = Boolean(state.planGenerationLease);
    if (!jobs.length && !interrupted.length && !hadLease) {
      return { changed: false, result: { interruptedMaterials: 0, interruptedJobs: 0 } };
    }
    const at = now();
    for (const material of interrupted) {
      material.status = "失败";
      material.source = "上次运行时中断，可重新分析。";
      material.error = "服务在分析完成前重启，原始资料仍然保留。";
      material.updatedAt = at;
      delete material.analysisLease;
    }
    if (interrupted.length || hadLease) {
      state.processingErrors = [
        ...interrupted.map((material) => ({
          id: `analyze:${material.id}`,
          type: "analyze" as const,
          targetId: material.id,
          message: "服务在分析完成前重启，可重试分析。",
          at,
        })),
        ...(hadLease
          ? [
              {
                id: "plan:generate",
                type: "plan" as const,
                targetId: "workspace",
                message: "计划生成在服务重启时中断，请重新生成。",
                at,
              },
            ]
          : []),
        ...(state.processingErrors ?? []).filter(
          (item) =>
            !interrupted.some((material) => `analyze:${material.id}` === item.id) &&
            item.id !== "plan:generate",
        ),
      ].slice(0, 20);
    }
    state.processingJobs = [];
    delete state.planGenerationLease;
    return {
      changed: true,
      result: { interruptedMaterials: interrupted.length, interruptedJobs: jobs.length },
    };
  });
}

export async function setProcessingJobStage(
  id: string,
  stage: ProcessingJob["stage"],
): Promise<void> {
  await mutateWorkspaceConditionally((state) => {
    const job = state.processingJobs?.find((item) => item.id === id);
    if (!job) return { changed: false, result: undefined };
    job.stage = stage;
    job.updatedAt = now();
    return { changed: true, result: undefined };
  });
}

export async function removeProcessingJob(id: string): Promise<void> {
  await mutateWorkspaceConditionally((state) => {
    const list = state.processingJobs ?? [];
    const next = list.filter((job) => job.id !== id);
    if (next.length === list.length) return { changed: false, result: undefined };
    state.processingJobs = next;
    return { changed: true, result: undefined };
  });
}

interface ConditionalWorkspaceMutation<T> {
  changed: boolean;
  result: T;
}

/** Exact, immutable inputs consumed by one AI plan-generation request. */
export interface PlanGenerationContext {
  aiCourses: AiPlanCourse[];
  courses: Course[];
  availability: Availability[];
  studyDayStart: string;
}

export interface PlanGenerationReservation {
  runId: string;
  inputHash: string;
  context: PlanGenerationContext;
}

/**
 * Serialize a read/modify decision with normal writes, but persist only when
 * the mutator reports a real state change. This keeps read-triggered
 * maintenance from advancing updatedAt or rewriting the complete JSON file.
 */
async function mutateWorkspaceConditionally<T>(
  mutator: (
    state: WorkspaceState,
  ) => ConditionalWorkspaceMutation<T> | Promise<ConditionalWorkspaceMutation<T>>,
): Promise<T> {
  const run = writeTail.then(async () =>
    withStateFileLock(async () => {
      const state = await readWorkspaceInternal();
      let mutation: ConditionalWorkspaceMutation<T>;
      try {
        mutation = await mutator(state);
      } catch (error) {
        // 失败的 mutation 可能已经改动了内存中的状态对象；缓存必须丢弃，
        // 否则未持久化的半成品会留在下一次读取里。
        invalidateStateCache();
        throw error;
      }
      if (mutation.changed) {
        state.updatedAt = now();
        await writeWorkspaceInternal(state);
      } else {
        invalidateStateCache();
      }
      return mutation.result;
    }),
  );
  writeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function mutateWorkspace<T>(mutator: (state: WorkspaceState) => T | Promise<T>): Promise<T> {
  return mutateWorkspaceConditionally(async (state) => ({
    changed: true,
    result: await mutator(state),
  }));
}

export async function getWorkspace(): Promise<WorkspaceState> {
  return clone(await readWorkspaceInternal());
}

/**
 * 同一份文件（SHA-256 相同）已经分析过时，直接复用那份结果，不再调用模型。
 * 返回复用的来源文件名，便于界面说明“没有再次消耗额度”。
 */
export async function findReusableAnalysis(
  materialId: string,
): Promise<{ analysis: DocumentAnalysis; sourceName: string } | undefined> {
  const state = await readWorkspaceInternal();
  const material = state.materials.find((item) => item.id === materialId);
  if (!material) return undefined;
  const candidate = state.materials.find(
    (item) =>
      item.id !== material.id &&
      item.sha256 === material.sha256 &&
      Boolean(state.documentAnalyses[item.id]),
  );
  if (!candidate) return undefined;
  const analysis = state.documentAnalyses[candidate.id];
  if (!analysis) return undefined;
  return { analysis: clone(analysis), sourceName: candidate.name };
}

/** 在租约保护下写入复用结果；租约失效时返回 false，让调用方走真实分析。 */
export async function saveReusedAnalysis(
  materialId: string,
  runId: string,
  analysis: DocumentAnalysis,
  sourceName: string,
): Promise<boolean> {
  try {
    await mutateWorkspace((state) => {
      const material = state.materials.find((item) => item.id === materialId);
      if (!material) throw new WorkspaceStoreError("未找到资料。", 404);
      assertMaterialAnalysisLease(material, runId);
      state.documentAnalyses[materialId] = analysis;
      material.status = analysis.confidence === "low" ? "需确认" : "已分析";
      material.pages = analysis.pageCount ?? 0;
      material.kind = analysis.materialKind === "未知" ? material.kind : analysis.materialKind;
      material.source = `复用了《${sourceName}》的分析结果（文件内容相同，未调用 AI）`;
      material.error = undefined;
      material.updatedAt = now();
      delete material.analysisLease;
      appendAudit(state, "material.analysis_reused", materialId, { source: sourceName });
      const keyPointTitles = new Map(analysis.keyPoints.map((point) => [point.id, point.title]));
      state.insights = state.insights.filter(
        (item) => !item.id.startsWith(`material-${materialId}-`),
      );
      state.questions = state.questions.filter(
        (item) => !item.id.startsWith(`material-${materialId}-`),
      );
      state.insights.push(
        ...analysis.keyPoints.map((point, index): Insight => ({
          id: `material-${materialId}-point-${index}`,
          courseId: material.courseId,
          title: point.title,
          frequency: 1,
          importance: Math.max(1, Math.min(5, point.importance)),
          mastery: knowledgeMasteryFor(state, material.courseId, point.title),
          trend: point.importance >= 4 ? "高频" : "需巩固",
          sources: [formatEvidence(point.evidence)],
          summary: point.evidence.quote || "已从上传资料中识别，请结合来源位置复核。",
        })),
      );
      state.questions.push(
        ...analysis.generatedQuestions.map((question, index): Question => {
          const knowledge =
            (question.knowledgeId && keyPointTitles.get(question.knowledgeId)) ||
            question.knowledge;
          return {
            id: `material-${materialId}-question-${index}`,
            courseId: material.courseId,
            type: question.type,
            prompt: question.prompt,
            choices: question.choices.length ? question.choices : undefined,
            answer: question.answer,
            explanation: question.explanation,
            source: question.sourceLocation || material.name,
            knowledge,
            knowledgeKey: normalizeKnowledgeKey(knowledge),
            difficulty: question.difficulty,
            pitfalls: question.pitfalls,
          };
        }),
      );
      refreshInsightMastery(state, material.courseId);
      refreshCourseWeights(state, material.courseId);
      refreshCourseMastery(state, material.courseId);
      rebuildTasksInState(state);
      return clone(state);
    });
    return true;
  } catch {
    // 租约已被新的分析请求接管：让调用方继续走真实分析。
    return false;
  }
}

/** 用户手动确认 AI 分析结果（需确认 → 已分析）。 */
export async function confirmMaterialAnalysis(id: string): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const material = state.materials.find((item) => item.id === id);
    if (!material) throw new WorkspaceStoreError("未找到资料。", 404);
    if (material.status !== "需确认")
      throw new WorkspaceStoreError("只有标记为「需确认」的资料需要确认。", 409);
    material.status = "已分析";
    material.source = "已由你确认分析结果";
    material.error = undefined;
    material.updatedAt = now();
    appendAudit(state, "material.confirmed", id);
    return clone(state);
  });
}

/** 忽略/恢复一个考点：只影响展示与排期，原始分析保持不变。 */
export async function setInsightHidden(
  insightId: string,
  hidden: boolean,
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const exists = state.insights.some((item) => item.id === insightId);
    if (!exists) throw new WorkspaceStoreError("未找到该考点。", 404);
    const current = new Set(state.hiddenInsights ?? []);
    if (hidden) current.add(insightId);
    else current.delete(insightId);
    state.hiddenInsights = [...current];
    appendAudit(state, hidden ? "insight.hidden" : "insight.restored", insightId);
    // 忽略/恢复考点会改变排期依据，任务需要按新的考点集合重排。
    const courseId = state.insights.find((item) => item.id === insightId)?.courseId;
    if (courseId) rebuildTasksInState(state);
    return clone(state);
  });
}

/** 修正某道题的正确答案；练习判分与错题回顾都会使用修正后的答案。 */
export async function setQuestionAnswerOverride(
  questionId: string,
  answer: string,
): Promise<WorkspaceState> {
  if (typeof answer !== "string" || answer.length > 2_000) {
    throw new WorkspaceStoreError("答案必须是不超过 2000 字的字符串。", 400);
  }
  const trimmed = answer.trim();
  return mutateWorkspace((state) => {
    const question = state.questions.find((item) => item.id === questionId);
    if (!question) throw new WorkspaceStoreError("未找到该题目。", 404);
    if (!trimmed) {
      delete state.answerOverrides?.[questionId];
    } else {
      state.answerOverrides = {
        ...(state.answerOverrides ?? {}),
        [questionId]: { answer: trimmed, updatedAt: now() },
      };
    }
    appendAudit(state, "question.answer_overridden", questionId);
    return clone(state);
  });
}

/** 判分时使用修正后的答案（若有）。 */
function effectiveAnswer(state: WorkspaceState, question: Question): string {
  return state.answerOverrides?.[question.id]?.answer ?? question.answer;
}

function configuredUploadQuota(): number {
  const configured = process.env.FINALE_MAX_UPLOAD_BYTES?.trim();
  const limit =
    configured && /^\d+$/.test(configured) ? Number(configured) : DEFAULT_UPLOAD_QUOTA_BYTES;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_UPLOAD_QUOTA_BYTES;
}

/** 供 /api/health 与个人资料页展示的存储用量（不暴露路径）。 */
export async function getStorageUsage(): Promise<{
  usedBytes: number;
  quotaBytes: number;
  materialCount: number;
  sharedCount: number;
}> {
  const state = await getWorkspace();
  const usedBytes =
    state.materials.reduce((total, material) => total + (material.byteSize ?? 0), 0) +
    state.sharedMaterialRecords.reduce((total, record) => total + (record.byteSize ?? 0), 0);
  return {
    usedBytes,
    quotaBytes: configuredUploadQuota(),
    materialCount: state.materials.length,
    sharedCount: state.sharedMaterialRecords.length,
  };
}

/**
 * 轻量进度探针：只要后台任务的阶段或资料状态有变化就换一个 signal，
 * 前端据此决定是否需要重新拉取整份工作区（避免每 2 秒下载全部分析与题目）。
 */
export async function getProcessingSnapshot(): Promise<{
  jobs: ProcessingJob[];
  errors: ProcessingFailure[];
  active: boolean;
  signal: string;
}> {
  const state = await getWorkspace();
  const jobs = state.processingJobs ?? [];
  const errors = (state.processingErrors ?? []).slice(0, 5);
  const active =
    jobs.length > 0 || state.materials.some((material) => material.status === "分析中");
  const signal = createHash("sha256")
    .update(
      JSON.stringify({
        jobs: jobs.map((job) => [job.id, job.stage, job.updatedAt]),
        materials: state.materials.map((material) => [
          material.id,
          material.status,
          material.updatedAt,
        ]),
        planSource: state.planSource ?? "schedule",
        updatedAt: state.updatedAt,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return { jobs, errors, active, signal };
}

export function toPublicMaterial(material: StoredMaterial): PublicMaterial {
  const {
    objectKey: _objectKey,
    sha256: _sha256,
    uploadedAt: _uploadedAt,
    updatedAt: _updatedAt,
    analysisLease: _analysisLease,
    ...publicMaterial
  } = material;
  return publicMaterial;
}

function toPublicQuestion(question: Question): PublicQuestion {
  const { answer: _answer, explanation: _explanation, ...publicQuestion } = question;
  return publicQuestion;
}

function redactDocumentAnalysis(analysis: DocumentAnalysis): DocumentAnalysis {
  return { ...analysis, generatedQuestions: [] };
}

function redactCourseSynthesis(synthesis: CourseSynthesis): CourseSynthesis {
  return { ...synthesis, generatedQuestions: [] };
}

export function toPublicWorkspace(workspace: WorkspaceState): PublicWorkspaceState {
  const cloned = clone(workspace);
  const {
    materials,
    questions,
    documentAnalyses,
    courseSyntheses,
    sharedMaterialRecords: _sharedMaterialRecords,
    sharedReports: _sharedReports,
    unlockGrants: _unlockGrants,
    auditLog: _auditLog,
    otpChallenges: _otpChallenges,
    planGenerationLease: _planGenerationLease,
    hiddenInsights,
    answerOverrides: _answerOverrides,
    ...publicFields
  } = cloned;
  // 被用户忽略的考点不再下发：界面、练习与排期都以“已忽略”为准。
  const hidden = new Set(hiddenInsights ?? []);
  return {
    ...publicFields,
    insights: publicFields.insights.filter((insight) => !hidden.has(insight.id)),
    materials: materials.map(toPublicMaterial),
    questions: questions.map(toPublicQuestion),
    documentAnalyses: Object.fromEntries(
      Object.entries(documentAnalyses).map(([id, analysis]) => [
        id,
        redactDocumentAnalysis(analysis),
      ]),
    ),
    courseSyntheses: Object.fromEntries(
      Object.entries(courseSyntheses).map(([id, synthesis]) => [
        id,
        redactCourseSynthesis(synthesis),
      ]),
    ),
  };
}

/**
 * Capture the exact analyzed inputs for a course-level AI request. This is
 * intentionally server-only metadata and must never be returned to clients.
 */
export function createCourseSynthesisSourceSnapshot(
  workspace: WorkspaceState,
  courseId: string,
): CourseSynthesisSourceSnapshot {
  return { sources: courseSynthesisSourceEntries(workspace, courseId) };
}

function appendAudit(
  state: WorkspaceState,
  action: string,
  resource: string,
  metadata?: AuditEvent["metadata"],
): void {
  state.auditLog.unshift({ id: randomUUID(), action, resource, createdAt: now(), metadata });
  if (state.auditLog.length > 500) state.auditLog.length = 500;
}

export async function saveOtpChallenge(input: {
  email: string;
  codeHash: string;
  expiresAt: string;
}): Promise<void> {
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
    !/^[a-f0-9]{64}$/.test(input.codeHash) ||
    Number.isNaN(Date.parse(input.expiresAt))
  ) {
    throw new WorkspaceStoreError("邮箱验证码挑战格式无效。", 400);
  }
  await mutateWorkspace((state) => {
    const sentAt = now();
    state.otpChallenges = state.otpChallenges.filter(
      (challenge) =>
        challenge.email !== input.email && Date.parse(challenge.expiresAt) > Date.now(),
    );
    state.otpChallenges.unshift({
      id: randomUUID(),
      email: input.email,
      codeHash: input.codeHash,
      purpose: "verify_email",
      expiresAt: input.expiresAt,
      attempts: 0,
      sentAt,
    });
    if (state.otpChallenges.length > 20) state.otpChallenges.length = 20;
    appendAudit(state, "auth.otp_issued", "profile", { email: input.email });
  });
}

export async function consumeOtpChallenge(
  email: string,
  codeHash: string,
  matchedSchool?: string,
): Promise<WorkspaceState> {
  type ConsumptionResult = { error: WorkspaceStoreError } | { state: WorkspaceState };
  const result = await mutateWorkspaceConditionally<ConsumptionResult>((state) => {
    const challenge = state.otpChallenges.find((item) => item.email === email && !item.consumedAt);
    if (!challenge || Date.parse(challenge.expiresAt) <= Date.now()) {
      return {
        changed: false,
        result: { error: new WorkspaceStoreError("验证码已过期或不存在，请重新获取。", 400) },
      };
    }
    if (challenge.attempts >= 5) {
      return {
        changed: false,
        result: { error: new WorkspaceStoreError("验证码尝试次数过多，请重新获取。", 429) },
      };
    }
    challenge.attempts += 1;
    if (!timingSafeEqualText(challenge.codeHash, codeHash)) {
      // Persist the failed attempt while still inside the mutation queue. The
      // caller throws only after this conditional mutation has been written.
      return {
        changed: true,
        result: { error: new WorkspaceStoreError("验证码不正确。", 400) },
      };
    }
    challenge.consumedAt = now();
    state.profile.email = email;
    state.profile.verified = Boolean(matchedSchool);
    if (matchedSchool) state.profile.school = matchedSchool;
    else state.profile.school = "";
    appendAudit(state, "auth.email_verified", "profile", { schoolMatched: Boolean(matchedSchool) });
    return { changed: true, result: { state } };
  });
  if ("error" in result) throw result.error;
  return clone(result.state);
}

type EditableWorkspaceProfile = Pick<
  WorkspaceState["profile"],
  "displayName" | "email" | "school" | "examGoal" | "timezone" | "studyDayStart"
>;
type WorkspaceProfilePatch = Partial<EditableWorkspaceProfile>;

interface PreparedProfileUpdate {
  profile: WorkspaceState["profile"];
  changed: boolean;
  verificationBoundaryChanged: boolean;
  scheduleChanged: boolean;
}

function prepareProfileUpdate(
  state: WorkspaceState,
  input: WorkspaceProfilePatch,
): PreparedProfileUpdate {
  const displayName =
    typeof input.displayName === "string" ? input.displayName.trim() : state.profile.displayName;
  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : state.profile.email;
  const school = typeof input.school === "string" ? input.school.trim() : state.profile.school;
  const examGoal =
    typeof input.examGoal === "string" ? input.examGoal.trim() : state.profile.examGoal;
  const timezone =
    typeof input.timezone === "string" && input.timezone.trim()
      ? input.timezone.trim()
      : state.profile.timezone;
  const studyDayStart =
    typeof input.studyDayStart === "string" && input.studyDayStart.trim()
      ? input.studyDayStart.trim()
      : state.profile.studyDayStart;
  if (
    displayName.length > 80 ||
    email.length > 160 ||
    school.length > 120 ||
    examGoal.length > 240
  ) {
    throw new WorkspaceStoreError("个人资料字段超出允许长度。", 400);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new WorkspaceStoreError("邮箱格式无效。", 400);
  }
  if (!isValidTimeZone(timezone))
    throw new WorkspaceStoreError("时区无效，请使用 IANA 时区名，例如 Asia/Shanghai。", 400);
  if (!isValidClockTime(studyDayStart))
    throw new WorkspaceStoreError("每日学习开始时间必须是 HH:MM。", 400);
  const verificationBoundaryChanged =
    email !== state.profile.email || school !== state.profile.school;
  const scheduleChanged =
    timezone !== state.profile.timezone || studyDayStart !== state.profile.studyDayStart;
  const profile = {
    ...state.profile,
    displayName,
    email,
    school,
    examGoal,
    timezone,
    studyDayStart,
    // A manually edited email or school must never retain a previous
    // verification grant. The next OTP verification re-establishes the
    // school boundary from the configured domain mapping.
    verified: verificationBoundaryChanged ? false : state.profile.verified,
  };
  return {
    profile,
    changed:
      displayName !== state.profile.displayName ||
      email !== state.profile.email ||
      school !== state.profile.school ||
      examGoal !== state.profile.examGoal ||
      timezone !== state.profile.timezone ||
      studyDayStart !== state.profile.studyDayStart ||
      profile.verified !== state.profile.verified,
    verificationBoundaryChanged,
    scheduleChanged,
  };
}

function appendProfileUpdateAudit(state: WorkspaceState, update: PreparedProfileUpdate): void {
  appendAudit(state, "profile.updated", "workspace", {
    hasEmail: Boolean(update.profile.email),
    hasSchool: Boolean(update.profile.school),
    verificationReset: update.verificationBoundaryChanged,
    scheduleChanged: update.scheduleChanged,
  });
}

export async function updateWorkspaceProfile(
  input: Partial<WorkspaceState["profile"]>,
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const update = prepareProfileUpdate(state, input);
    state.profile = update.profile;
    // A changed timezone or first study slot shifts the whole plan window.
    if (update.scheduleChanged) rebuildTasksInState(state);
    appendProfileUpdateAudit(state, update);
    return clone(state);
  });
}

function normalizeAvailabilityInput(input: unknown): WorkspaceState["availability"] {
  // The persisted plan window is a rolling 7 days (rollAvailabilityForward
  // normalizes to exactly PLAN_WINDOW_DAYS entries). Accepting more would
  // silently drop the extra days on the next mutation, so the contract is
  // aligned with what is actually honored.
  if (!Array.isArray(input) || input.length < 1 || input.length > PLAN_WINDOW_DAYS) {
    throw new WorkspaceStoreError(`可用时间必须包含 1–${PLAN_WINDOW_DAYS} 天。`, 400);
  }
  const entries = input.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WorkspaceStoreError("可用时间格式无效。", 400);
    const item = value as { date?: unknown; minutes?: unknown };
    if (
      typeof item.date !== "string" ||
      !isValidDateOnly(item.date) ||
      typeof item.minutes !== "number" ||
      !Number.isInteger(item.minutes) ||
      item.minutes < 0 ||
      item.minutes > 720
    ) {
      throw new WorkspaceStoreError("可用时间必须是有效日期和 0–720 的整数分钟。", 400);
    }
    return { date: item.date, minutes: item.minutes };
  });
  const dates = new Set<string>();
  for (const item of entries) {
    if (dates.has(item.date)) throw new WorkspaceStoreError("可用时间日期不能重复。", 400);
    dates.add(item.date);
  }
  return entries.sort((left, right) => left.date.localeCompare(right.date));
}

function availabilityMatches(
  left: WorkspaceState["availability"],
  right: WorkspaceState["availability"],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return Boolean(other && entry.date === other.date && entry.minutes === other.minutes);
    })
  );
}

export async function updateAvailability(input: unknown): Promise<WorkspaceState> {
  const entries = normalizeAvailabilityInput(input);
  return mutateWorkspace((state) => {
    state.availability = entries;
    rebuildTasksInState(state);
    appendAudit(state, "availability.updated", "workspace", { days: entries.length });
    return clone(state);
  });
}

/** Apply profile and availability fields as one all-or-nothing PATCH. */
export async function updateWorkspacePatch(
  input: WorkspaceProfilePatch & { availability?: unknown },
): Promise<WorkspaceState> {
  // Availability validation is state-independent. Run it before entering the
  // mutation so an invalid combined request cannot persist its profile half.
  const availabilityProvided = input.availability !== undefined;
  const availability = availabilityProvided
    ? normalizeAvailabilityInput(input.availability)
    : undefined;
  const profileProvided = [
    input.displayName,
    input.email,
    input.school,
    input.examGoal,
    input.timezone,
    input.studyDayStart,
  ].some((value) => typeof value === "string");

  const state = await mutateWorkspaceConditionally((current) => {
    const profileUpdate = profileProvided ? prepareProfileUpdate(current, input) : undefined;
    const availabilityChanged = Boolean(
      availability && !availabilityMatches(current.availability, availability),
    );
    if (profileUpdate?.changed) current.profile = profileUpdate.profile;
    if (availability && availabilityChanged) current.availability = availability;

    if (profileUpdate?.scheduleChanged || availabilityChanged) rebuildTasksInState(current);
    if (profileUpdate?.changed) appendProfileUpdateAudit(current, profileUpdate);
    if (availabilityChanged)
      appendAudit(current, "availability.updated", "workspace", {
        days: availability?.length ?? 0,
      });

    return {
      changed: Boolean(profileUpdate?.changed || availabilityChanged),
      // Return the live object so the conditional wrapper's updatedAt change
      // is visible before the outer clone is made.
      result: current,
    };
  });
  return clone(state);
}

export async function createCourse(
  input: CourseInput,
): Promise<{ course: Course; workspace: WorkspaceState }> {
  const candidate = input && typeof input === "object" ? (input as Partial<CourseInput>) : {};
  const name = normalizeInputText(candidate.name);
  const code = normalizeInputText(candidate.code).toUpperCase();
  const teacher = normalizeInputText(candidate.teacher);
  const term = normalizeInputText(candidate.term);
  const examDate = normalizeInputText(candidate.examDate);
  const priority = candidate.priority;
  if (!name || !code || !teacher || !term || !isValidDateOnly(examDate)) {
    throw new WorkspaceStoreError("请完整填写课程名称、课程代码、教师、学期和考试日期。", 400);
  }
  if (priority !== "高" && priority !== "中" && priority !== "低")
    throw new WorkspaceStoreError("课程优先级无效。", 400);

  return mutateWorkspace((state) => {
    if (
      state.courses.some(
        (course) => course.code === code && course.term === term && course.teacher === teacher,
      )
    ) {
      throw new WorkspaceStoreError("这门课程已存在，请直接上传资料。", 409);
    }
    const course: Course = {
      id: randomUUID(),
      name: name.slice(0, 120),
      code: code.slice(0, 40),
      teacher: teacher.slice(0, 80),
      term: term.slice(0, 80),
      examDate,
      priority,
      mastery: 0,
      highFrequencyWeight: 0.5,
      color: COURSE_COLORS[state.courses.length % COURSE_COLORS.length] ?? "#6d5dfc",
    };
    state.courses.push(course);
    appendAudit(state, "course.created", course.id, { code: course.code });
    rebuildTasksInState(state);
    return { course: clone(course), workspace: clone(state) };
  });
}

export async function updateCourse(
  id: string,
  patch: Partial<Pick<Course, "name" | "teacher" | "term" | "examDate" | "priority">>,
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const course = state.courses.find((item) => item.id === id);
    if (!course) throw new WorkspaceStoreError("未找到课程。", 404);
    if (typeof patch.name === "string") {
      if (!patch.name.trim()) throw new WorkspaceStoreError("课程名称不能为空。", 400);
      course.name = patch.name.trim().slice(0, 120);
    }
    if (typeof patch.teacher === "string") {
      if (!patch.teacher.trim()) throw new WorkspaceStoreError("任课教师不能为空。", 400);
      course.teacher = patch.teacher.trim().slice(0, 80);
    }
    if (typeof patch.term === "string") {
      if (!patch.term.trim()) throw new WorkspaceStoreError("学期不能为空。", 400);
      course.term = patch.term.trim().slice(0, 80);
    }
    if (typeof patch.examDate === "string") {
      if (!isValidDateOnly(patch.examDate)) throw new WorkspaceStoreError("考试日期无效。", 400);
      course.examDate = patch.examDate;
    }
    if (patch.priority !== undefined) {
      if (!["高", "中", "低"].includes(patch.priority))
        throw new WorkspaceStoreError("课程优先级无效。", 400);
      course.priority = patch.priority;
    }
    if (
      state.courses.some(
        (item) =>
          item.id !== id &&
          item.code === course.code &&
          item.term === course.term &&
          item.teacher === course.teacher,
      )
    ) {
      throw new WorkspaceStoreError("这门课程已存在。", 409);
    }
    appendAudit(state, "course.updated", id);
    rebuildTasksInState(state);
    return clone(state);
  });
}

export async function deleteCourse(id: string): Promise<WorkspaceState> {
  const before = await getWorkspace();
  const owned = before.materials.filter((material) => material.courseId === id);
  if (!before.courses.some((course) => course.id === id))
    throw new WorkspaceStoreError("未找到课程。", 404);
  const workspace = await mutateWorkspace((state) => {
    const index = state.courses.findIndex((course) => course.id === id);
    if (index < 0) throw new WorkspaceStoreError("未找到课程。", 404);
    state.courses.splice(index, 1);
    state.materials = state.materials.filter((material) => material.courseId !== id);
    state.insights = state.insights.filter((item) => item.courseId !== id);
    state.questions = state.questions.filter((item) => item.courseId !== id);
    state.tasks = state.tasks.filter((task) => task.courseId !== id);
    state.assessmentAttempts = state.assessmentAttempts.filter(
      (attempt) => attempt.courseId !== id,
    );
    delete state.courseSyntheses[id];
    for (const material of owned) delete state.documentAnalyses[material.id];
    appendAudit(state, "course.deleted", id, { materials: owned.length });
    rebuildTasksInState(state);
    return clone(state);
  });
  await Promise.all(
    owned.map((material) =>
      unlink(path.join(getUploadsDirectory(), path.basename(material.objectKey))).catch(
        () => undefined,
      ),
    ),
  );
  return workspace;
}

function extensionFromFilename(filename: string): string {
  const match = /\.([a-z0-9]{1,12})$/i.exec(filename);
  return match?.[1]?.toLowerCase() ?? "bin";
}

/** Sanitize a user-supplied filename for the Content-Disposition header. */
export function sanitizeDownloadFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 220) || "download";
}

function normalizeInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function materialKindFromFilename(filename: string): MaterialKind {
  switch (extensionFromFilename(filename)) {
    case "ppt":
    case "pptx":
      return "课件";
    case "doc":
    case "docx":
      return "题库";
    case "jpg":
    case "jpeg":
    case "png":
    case "webp":
      return "讲义";
    default:
      return "试卷";
  }
}

function hasExpectedFileSignature(extension: string, bytes: Uint8Array): boolean {
  const startsWith = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  if (extension === "pdf") return startsWith(0x25, 0x50, 0x44, 0x46);
  if (extension === "jpg" || extension === "jpeg") return startsWith(0xff, 0xd8, 0xff);
  if (extension === "png") return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (extension === "webp")
    return (
      startsWith(0x52, 0x49, 0x46, 0x46) &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  if (["doc", "ppt"].includes(extension))
    return startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  if (["docx", "pptx"].includes(extension))
    return startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06);
  return false;
}

export async function storeUploadedMaterial(
  courseId: string,
  file: File,
): Promise<{ material: StoredMaterial; workspace: WorkspaceState }> {
  if (!file.name || file.size <= 0) throw new WorkspaceStoreError("请选择一个非空资料文件。", 400);
  if (file.size > 50 * 1024 * 1024)
    throw new WorkspaceStoreError("单个资料文件不能超过 50 MB。", 413);
  await assertUploadQuota(file.size);
  if (!isSupportedFile(file.name)) {
    throw new WorkspaceStoreError(
      "不支持该资料格式。仅可上传 PDF、PPT/PPTX、DOC/DOCX、JPG、PNG 或 WEBP。",
      415,
    );
  }
  // Reject an unknown course before buffering or writing an untrusted upload.
  // A single-process mutation queue keeps later state writes ordered; this
  // early read prevents bogus course IDs from being used for disk exhaustion.
  if (!(await getWorkspace()).courses.some((course) => course.id === courseId)) {
    throw new WorkspaceStoreError("请先创建并选择一门课程。", 404);
  }
  const extension = extensionFromFilename(file.name);
  const id = randomUUID();
  const objectKey = `${id}.${extension}`;
  const targetPath = path.join(getUploadsDirectory(), objectKey);
  const incomingPath = `${targetPath}.incoming`;
  const hash = createHash("sha256");
  const signaturePrefix = Buffer.alloc(16);
  let signatureBytes = 0;
  let byteSize = 0;
  let targetCreated = false;

  await ensureDirectories();
  try {
    const handle = await open(incomingPath, "wx");
    targetCreated = true;
    try {
      const reader = file.stream().getReader();
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          const bytes = Buffer.from(
            chunk.buffer as ArrayBuffer,
            chunk.byteOffset,
            chunk.byteLength,
          );
          byteSize += bytes.byteLength;
          if (byteSize > 50 * 1024 * 1024)
            throw new WorkspaceStoreError("单个资料文件不能超过 50 MB。", 413);
          hash.update(bytes);
          if (signatureBytes < signaturePrefix.byteLength) {
            const length = Math.min(bytes.byteLength, signaturePrefix.byteLength - signatureBytes);
            bytes.copy(signaturePrefix, signatureBytes, 0, length);
            signatureBytes += length;
          }
          let offset = 0;
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(
              bytes,
              offset,
              bytes.byteLength - offset,
              null,
            );
            if (bytesWritten <= 0)
              throw new WorkspaceStoreError("资料写入不完整，请检查数据目录空间后重试。", 507);
            offset += bytesWritten;
          }
        }
      } finally {
        reader.releaseLock();
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (byteSize !== file.size)
      throw new WorkspaceStoreError("上传资料大小不完整，请重新选择文件。", 400);
    if (!hasExpectedFileSignature(extension, signaturePrefix.subarray(0, signatureBytes))) {
      throw new WorkspaceStoreError(
        "文件内容与扩展名不匹配，已拒绝保存。请重新导出原始资料。",
        415,
      );
    }
    const sha256 = hash.digest("hex");
    await rename(incomingPath, targetPath);
    const uploadedAt = now();
    const material: StoredMaterial = {
      id,
      courseId,
      name: path.basename(file.name).slice(0, 220),
      kind: materialKindFromFilename(file.name),
      pages: 0,
      status: "待分析",
      source: "已安全保存，等待 AI 分析",
      shared: false,
      createdAt: uploadedAt,
      // Browser-provided MIME types are not trustworthy. For supported files the
      // extension is canonicalized server-side before it is used for downloads
      // or forwarded to the AI provider.
      mimeType: inferMimeType(file.name, file.type),
      byteSize,
      objectKey,
      sha256,
      uploadedAt,
      updatedAt: uploadedAt,
    };
    return await mutateWorkspace((state) => {
      if (!state.courses.some((course) => course.id === courseId))
        throw new WorkspaceStoreError("请先创建并选择一门课程。", 404);
      const duplicate = state.materials.find(
        (item) => item.courseId === courseId && item.sha256 === sha256,
      );
      if (duplicate)
        throw new WorkspaceStoreError(
          `这份资料已存在：${duplicate.name}。请直接在资料卡上重试分析。`,
          409,
        );
      state.materials.unshift(material);
      appendAudit(state, "material.created", material.id, { bytes: material.byteSize ?? 0 });
      return { material: clone(material), workspace: clone(state) };
    });
  } catch (error) {
    if (targetCreated) {
      await Promise.all([
        unlink(incomingPath).catch(() => undefined),
        unlink(targetPath).catch(() => undefined),
      ]);
    }
    throw error;
  }
}

export async function getStoredMaterial(id: string): Promise<StoredMaterial> {
  const state = await readWorkspaceInternal();
  const material = state.materials.find((item) => item.id === id);
  if (!material) throw new WorkspaceStoreError("未找到资料。", 404);
  return clone(material);
}

export async function readStoredMaterialFile(
  id: string,
): Promise<{ material: StoredMaterial; buffer: Buffer }> {
  const reference = await getStoredMaterialFileReference(id);
  return { material: reference.material, buffer: await readFile(reference.filePath) };
}

/** Server-only file reference used to stream a persisted document without buffering it. */
export async function getStoredMaterialFileReference(
  id: string,
): Promise<{ material: StoredMaterial; filePath: string; byteSize: number }> {
  const material = await getStoredMaterial(id);
  const safeKey = path.basename(material.objectKey);
  if (safeKey !== material.objectKey) throw new WorkspaceStoreError("资料存储键无效。", 500);
  const filePath = path.join(getUploadsDirectory(), safeKey);
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile())
      throw new WorkspaceStoreError("资料文件不存在，可能已被手动移除。", 410);
    return { material, filePath, byteSize: fileInfo.size };
  } catch (error) {
    if (isNodeError(error, "ENOENT"))
      throw new WorkspaceStoreError("资料文件不存在，可能已被手动移除。", 410);
    throw error;
  }
}

export async function setMaterialStatus(
  id: string,
  status: StoredMaterial["status"],
  source?: string,
  error?: string,
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const material = state.materials.find((item) => item.id === id);
    if (!material) throw new WorkspaceStoreError("未找到资料。", 404);
    material.status = status;
    if (status !== "分析中") delete material.analysisLease;
    if (source) material.source = source.slice(0, 500);
    material.error = error?.slice(0, 500);
    material.updatedAt = now();
    return clone(state);
  });
}

/** Atomically acquire a material for an inline analysis request. */
export async function beginMaterialAnalysis(
  id: string,
): Promise<{ runId: string; workspace: WorkspaceState }> {
  return mutateWorkspace((state) => {
    const material = state.materials.find((item) => item.id === id);
    if (!material) throw new WorkspaceStoreError("未找到资料。", 404);
    if (material.status === "分析中") {
      // A process that died mid-analysis leaves the material stuck in
      // "分析中" forever, and the previous guard made it unretryable. Treat
      // a long-running reservation as stale so the user can recover.
      const reservedAt = Date.parse(material.analysisLease?.startedAt ?? material.updatedAt);
      const isStale =
        !Number.isFinite(reservedAt) || Date.now() - reservedAt >= STALE_ANALYSIS_RESERVATION_MS;
      if (!isStale) throw new WorkspaceStoreError("这份资料正在分析中，请等待当前请求完成。", 409);
    }
    const runId = randomUUID();
    const startedAt = now();
    material.status = "分析中";
    material.source = "已发送给 AI 分析，请勿关闭页面。";
    material.error = undefined;
    material.analysisLease = { runId, startedAt };
    material.updatedAt = startedAt;
    return { runId, workspace: clone(state) };
  });
}

function assertMaterialAnalysisLease(material: StoredMaterial, runId: string): void {
  if (!runId || material.status !== "分析中" || material.analysisLease?.runId !== runId) {
    throw new WorkspaceStoreError("该资料分析请求已失效，请使用最新一次分析结果。", 409);
  }
}

export async function failMaterialAnalysis(
  id: string,
  runId: string,
  source?: string,
  error?: string,
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const material = state.materials.find((item) => item.id === id);
    if (!material) throw new WorkspaceStoreError("未找到资料。", 404);
    assertMaterialAnalysisLease(material, runId);
    material.status = "失败";
    material.source = source?.slice(0, 500) || "AI 分析失败，可检查配置后重试。";
    material.error = error?.slice(0, 500);
    material.updatedAt = now();
    delete material.analysisLease;
    return clone(state);
  });
}

export async function saveDocumentAnalysis(
  id: string,
  analysis: DocumentAnalysis,
  runId: string,
  usage?: AiTokenUsage,
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const material = state.materials.find((item) => item.id === id);
    if (!material) throw new WorkspaceStoreError("未找到资料。", 404);
    assertMaterialAnalysisLease(material, runId);
    state.documentAnalyses[id] = analysis;
    material.status = analysis.confidence === "low" ? "需确认" : "已分析";
    material.pages = analysis.pageCount ?? 0;
    material.kind = analysis.materialKind === "未知" ? material.kind : analysis.materialKind;
    material.source = analysis.keyPoints[0]?.evidence.location
      ? `已识别 ${analysis.keyPoints.length} 个考点 · ${analysis.keyPoints[0].evidence.location}`
      : `已完成 AI 分析 · ${analysis.keyPoints.length} 个考点`;
    material.error = undefined;
    material.updatedAt = now();
    delete material.analysisLease;
    appendAudit(state, "material.analyzed", id, {
      keyPoints: analysis.keyPoints.length,
      questions: analysis.generatedQuestions.length,
    });

    // A new or re-run document analysis makes any previous course-level
    // aggregate stale. Remove both its summary and derived cards/questions so
    // the next synthesis is grounded only in the current source set.
    invalidateCourseSynthesis(state, material.courseId);

    state.insights = state.insights.filter((item) => !item.id.startsWith(`material-${id}-`));
    state.questions = state.questions.filter((item) => !item.id.startsWith(`material-${id}-`));
    const keyPointTitles = new Map(analysis.keyPoints.map((point) => [point.id, point.title]));
    state.insights.push(
      ...analysis.keyPoints.map((point, index): Insight => ({
        id: `material-${id}-point-${index}`,
        courseId: material.courseId,
        title: point.title,
        frequency: 1,
        importance: Math.max(1, Math.min(5, point.importance)),
        // 掌握度是练习数据，不是 AI 输出；从 knowledgeMastery 派生。
        mastery: knowledgeMasteryFor(state, material.courseId, point.title),
        trend: point.importance >= 4 ? "高频" : "需巩固",
        sources: [formatEvidence(point.evidence)],
        summary: point.evidence.quote || "已从上传资料中识别，请结合来源位置复核。",
      })),
    );
    state.questions.push(
      ...analysis.generatedQuestions.map((question, index): Question => {
        const knowledge =
          (question.knowledgeId && keyPointTitles.get(question.knowledgeId)) || question.knowledge;
        return {
          id: `material-${id}-question-${index}`,
          courseId: material.courseId,
          type: question.type,
          prompt: question.prompt,
          choices: question.choices.length ? question.choices : undefined,
          answer: question.answer,
          explanation: question.explanation,
          source: question.sourceLocation || material.name,
          knowledge,
          knowledgeKey: normalizeKnowledgeKey(knowledge),
          difficulty: question.difficulty,
          pitfalls: question.pitfalls,
        };
      }),
    );
    applyAiUsage(state, usage);
    refreshInsightMastery(state, material.courseId);
    refreshCourseWeights(state, material.courseId);
    refreshCourseMastery(state, material.courseId);
    rebuildTasksInState(state);
    return clone(state);
  });
}

export async function saveCourseSynthesis(
  courseId: string,
  synthesis: CourseSynthesis,
  sourceSnapshot: CourseSynthesisSourceSnapshot,
  usage?: AiTokenUsage,
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const course = state.courses.find((item) => item.id === courseId);
    if (!course) throw new WorkspaceStoreError("未找到课程。", 404);
    if (!courseSynthesisSnapshotMatches(state, courseId, sourceSnapshot)) {
      throw new WorkspaceStoreError("资料在课程综合期间发生变化，请重新生成。", 409);
    }
    state.courseSyntheses[courseId] = synthesis;
    state.insights = state.insights.filter((item) => item.courseId !== courseId);
    state.questions = state.questions.filter(
      (item) => !item.id.startsWith(`synthesis-${courseId}-`),
    );
    const analyzedCount = Math.max(
      1,
      state.materials.filter(
        (item) => item.courseId === courseId && Boolean(state.documentAnalyses[item.id]),
      ).length,
    );
    const pointTitles = new Map(
      synthesis.highFrequencyPoints.map((point) => [point.id, point.title]),
    );
    state.insights.push(
      ...synthesis.highFrequencyPoints.map((point, index): Insight => ({
        id: `synthesis-${courseId}-point-${index}`,
        courseId,
        title: point.title,
        frequency: Math.max(
          1,
          Math.min(analyzedCount, point.frequency, point.sources.length || analyzedCount),
        ),
        importance: Math.max(
          1,
          Math.min(5, Math.round(point.frequency >= analyzedCount ? 5 : point.frequency + 1)),
        ),
        // AI 的 priority 只影响排序，不写入掌握度；掌握度来自练习记录。
        mastery: knowledgeMasteryFor(state, courseId, point.title),
        trend: point.trend === "已掌握" ? "需巩固" : point.trend,
        sources: point.sources,
        summary: point.summary,
      })),
    );
    state.questions.push(
      ...synthesis.generatedQuestions.map((question, index): Question => {
        const knowledge =
          (question.knowledgeId && pointTitles.get(question.knowledgeId)) || question.knowledge;
        return {
          id: `synthesis-${courseId}-question-${index}`,
          courseId,
          type: question.type,
          prompt: question.prompt,
          choices: question.choices.length ? question.choices : undefined,
          answer: question.answer,
          explanation: question.explanation,
          source: question.sourceLocation || "课程综合",
          knowledge,
          knowledgeKey: normalizeKnowledgeKey(knowledge),
          difficulty: question.difficulty,
          pitfalls: question.pitfalls,
        };
      }),
    );
    applyAiUsage(state, usage);
    refreshInsightMastery(state, courseId);
    refreshCourseWeights(state, courseId);
    refreshCourseMastery(state, courseId);
    rebuildTasksInState(state);
    return clone(state);
  });
}

function courseSynthesisSourceEntries(
  state: WorkspaceState,
  courseId: string,
): Array<{ materialId: string; updatedAt: string; analysisHash: string }> {
  return state.materials
    .filter(
      (material) => material.courseId === courseId && Boolean(state.documentAnalyses[material.id]),
    )
    .map((material) => ({
      materialId: material.id,
      updatedAt: material.updatedAt,
      analysisHash: createHash("sha256")
        .update(JSON.stringify(state.documentAnalyses[material.id]))
        .digest("hex"),
    }))
    .sort((left, right) => left.materialId.localeCompare(right.materialId));
}

function courseSynthesisSnapshotMatches(
  state: WorkspaceState,
  courseId: string,
  snapshot: CourseSynthesisSourceSnapshot,
): boolean {
  if (!snapshot || !Array.isArray(snapshot.sources)) return false;
  const current = courseSynthesisSourceEntries(state, courseId);
  if (current.length !== snapshot.sources.length) return false;
  return current.every((entry, index) => {
    const expected = snapshot.sources[index];
    return (
      expected &&
      entry.materialId === expected.materialId &&
      entry.updatedAt === expected.updatedAt &&
      entry.analysisHash === expected.analysisHash
    );
  });
}

export async function deleteStoredMaterial(id: string): Promise<WorkspaceState> {
  const material = await getStoredMaterial(id);
  const workspace = await mutateWorkspace((state) => {
    const index = state.materials.findIndex((item) => item.id === id);
    if (index < 0) throw new WorkspaceStoreError("未找到资料。", 404);
    const removed = state.materials[index];
    state.materials.splice(index, 1);
    delete state.documentAnalyses[id];
    invalidateCourseSynthesis(state, removed.courseId);
    state.insights = state.insights.filter((item) => !item.id.startsWith(`material-${id}-`));
    state.questions = state.questions.filter((item) => !item.id.startsWith(`material-${id}-`));
    appendAudit(state, "material.deleted", id);
    refreshCourseWeights(state, removed.courseId);
    rebuildTasksInState(state);
    return clone(state);
  });
  await unlink(path.join(getUploadsDirectory(), path.basename(material.objectKey))).catch(
    () => undefined,
  );
  return workspace;
}

function createPlanGenerationContext(state: WorkspaceState): PlanGenerationContext {
  const insightsByCourse = new Map<string, AiPlanCourse["insights"]>();
  const ranked = [...state.insights].sort(
    (left, right) =>
      right.frequency - left.frequency ||
      insightImportance(right) - insightImportance(left) ||
      left.mastery - right.mastery ||
      left.title.localeCompare(right.title),
  );
  for (const insight of ranked) {
    const list = insightsByCourse.get(insight.courseId) ?? [];
    if (list.length < 8) {
      list.push({
        title: insight.title.slice(0, 200),
        frequency: insight.frequency,
        importance: insightImportance(insight),
        trend: insight.trend,
      });
    }
    insightsByCourse.set(insight.courseId, list);
  }

  const missesByCourse = new Map<string, AiPlanCourse["recentMisses"]>();
  for (const miss of recentMissedTopics(state)) {
    const list = missesByCourse.get(miss.courseId) ?? [];
    if (list.length < 8) list.push({ topic: miss.topic.slice(0, 80), missedOn: miss.missedOn });
    missesByCourse.set(miss.courseId, list);
  }

  return {
    aiCourses: state.courses.map((course) => ({
      name: course.name,
      code: course.code,
      examDate: course.examDate,
      priority: course.priority,
      mastery: course.mastery,
      insights: insightsByCourse.get(course.id) ?? [],
      recentMisses: missesByCourse.get(course.id) ?? [],
    })),
    courses: clone(state.courses),
    availability: clone(state.availability),
    studyDayStart: isValidClockTime(state.profile.studyDayStart)
      ? state.profile.studyDayStart
      : DEFAULT_STUDY_DAY_START,
  };
}

function planGenerationInputHash(context: PlanGenerationContext): string {
  // materializeAiPlan uses only these course fields; hashing the same effective
  // inputs avoids rejecting harmless edits to teacher, term, color, and weight.
  const materializationCourses = context.courses.map((course) => ({
    id: course.id,
    name: course.name,
    code: course.code,
    examDate: course.examDate,
    mastery: course.mastery,
  }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        aiCourses: context.aiCourses,
        materializationCourses,
        availability: context.availability,
        studyDayStart: context.studyDayStart,
      }),
    )
    .digest("hex");
}

/**
 * Claim ownership of the next AI plan result and freeze the exact provider and
 * materialization inputs used by that request. A newer claim supersedes an
 * older concurrent request, even when both use identical input data.
 */
export async function beginPlanGeneration(): Promise<PlanGenerationReservation> {
  return mutateWorkspace((state) => {
    const context = createPlanGenerationContext(state);
    const runId = randomUUID();
    const inputHash = planGenerationInputHash(context);
    state.planGenerationLease = { runId, inputHash, startedAt: now() };
    return { runId, inputHash, context };
  });
}

/** Release only the caller's own unfinished reservation. */
export async function abandonPlanGeneration(runId: string): Promise<void> {
  await mutateWorkspaceConditionally((state) => {
    if (!runId || state.planGenerationLease?.runId !== runId) {
      return { changed: false, result: undefined };
    }
    delete state.planGenerationLease;
    return { changed: true, result: undefined };
  });
}

/**
 * 把错过的任务重新排进今天的计划。
 *
 * 错过的任务原本只被记录、不会自动补做；这里给用户一个显式的「补做」动作：
 * 选中若干条（默认全部）后，它们的知识点会作为到期复习参与重排，因此仍然受每日容量约束，
 * 不会被塞成一长串做不完的任务。
 */
export async function rescheduleMissedTasks(
  taskIds?: string[],
): Promise<{ workspace: WorkspaceState; rescheduled: number }> {
  return mutateWorkspace((state) => {
    const wanted = Array.isArray(taskIds) && taskIds.length ? new Set(taskIds) : undefined;
    const selected = state.missedTasks.filter((task) => (wanted ? wanted.has(task.id) : true));
    if (!selected.length) throw new WorkspaceStoreError("没有可重新安排的错过任务。", 400);

    // 把选中的错过任务转成「今天到期」的复习，交给排期器重新分配容量。
    const today = workspaceToday(state);
    for (const task of selected) {
      const courseId = task.courseId;
      if (!state.courses.some((course) => course.id === courseId)) continue;
      const title = (task.knowledge || task.title).slice(0, 120);
      const key = normalizeKnowledgeKey(title);
      if (!key) continue;
      const bucket = (state.knowledgeMastery[courseId] ??= {});
      const record: KnowledgeMasteryRecord = bucket[key] ?? {
        key,
        title,
        mastery: 0,
        attempts: 0,
        correct: 0,
      };
      record.due = today;
      // 补做不算一次练习：保持 attempts 不变，只在到期日上体现。
      record.attempts = Math.max(record.attempts, 1);
      bucket[key] = record;
    }
    const remaining = state.missedTasks.filter(
      (task) => !selected.some((item) => item.id === task.id),
    );
    state.missedTasks = remaining.slice(0, MISSED_TASKS_LIMIT);
    appendAudit(state, "plan.missed_rescheduled", "workspace", { tasks: selected.length });
    rebuildTasksInState(state);
    return { workspace: clone(state), rescheduled: selected.length };
  });
}

export async function rebuildPlan(): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    // An explicit local rebuild is a newer plan decision than any in-flight AI
    // request, even when its source inputs otherwise remain unchanged.
    delete state.planGenerationLease;
    rebuildTasksInState(state);
    return clone(state);
  });
}

/**
 * Persist a freshly AI-generated plan. Completion states are carried over for
 * tasks whose scheduling identity still describes the same work, mirroring the
 * deterministic rebuild path.
 */
export async function replacePlanWithGeneratedPlan(
  tasks: StudyTask[],
  reservation: Pick<PlanGenerationReservation, "runId" | "inputHash">,
  usage?: AiTokenUsage,
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const activeLease = state.planGenerationLease;
    if (
      !activeLease ||
      activeLease.runId !== reservation.runId ||
      activeLease.inputHash !== reservation.inputHash
    ) {
      throw new WorkspaceStoreError("已有更新的计划生成请求，本次旧结果未保存。", 409);
    }
    const currentInputHash = planGenerationInputHash(createPlanGenerationContext(state));
    if (currentInputHash !== reservation.inputHash) {
      throw new WorkspaceStoreError("计划生成期间学习数据发生变化，请重新生成。", 409);
    }
    collectMissedTasksInState(state);
    const completedTaskIdentities = new Set(
      state.tasks.filter((task) => task.status === "已完成").map(taskCompletionIdentity),
    );
    state.tasks = tasks.map((task) => ({
      ...task,
      status: completedTaskIdentities.has(taskCompletionIdentity(task)) ? "已完成" : "待完成",
    }));
    state.planSource = "ai";
    delete state.planGenerationLease;
    applyAiUsage(state, usage);
    appendAudit(state, "plan.generated_ai", "workspace", { tasks: state.tasks.length });
    return clone(state);
  });
}

export async function setTaskCompletion(id: string, completed: boolean): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw new WorkspaceStoreError("未找到学习任务。", 404);
    task.status = completed ? "已完成" : "待完成";
    appendAudit(state, completed ? "task.completed" : "task.reopened", id);
    return clone(state);
  });
}

/** 服务端抽题：错题与薄弱知识点优先，其余按难度/来源均匀补齐。 */
export interface PracticeSessionInput {
  courseId: string;
  knowledge?: string;
  size?: number;
}

export async function createPracticeSession(
  input: PracticeSessionInput,
): Promise<{ session: PracticeSession; questions: Question[] }> {
  const size =
    Number.isInteger(input.size) && (input.size as number) > 0
      ? Math.min(MAX_PRACTICE_SIZE, input.size as number)
      : DEFAULT_PRACTICE_SIZE;
  const requestedKey = input.knowledge?.trim() ? normalizeKnowledgeKey(input.knowledge) : "";
  return mutateWorkspace((state) => {
    const course = state.courses.find((item) => item.id === input.courseId);
    if (!course) throw new WorkspaceStoreError("未找到课程。", 404);
    const hiddenKeys = hiddenKnowledgeKeys(state);
    const pool = state.questions.filter(
      (question) => question.courseId === input.courseId && !hiddenKeys.has(questionKey(question)),
    );
    if (!pool.length)
      throw new WorkspaceStoreError("这门课程还没有可练习的题目，请先完成资料分析。", 400);

    const focused = requestedKey
      ? pool.filter((question) => knowledgeKeysRelated(questionKey(question), requestedKey))
      : [];
    const candidates = focused.length ? focused : pool;
    const mastery = state.knowledgeMastery[input.courseId] ?? {};
    // 错题与「间隔复习到期」都优先出题。
    const recentlyMissed = new Set(
      [...recentMissedTopics(state), ...dueReviewTopics(state)]
        .filter((miss) => miss.courseId === input.courseId)
        .map((miss) => normalizeKnowledgeKey(miss.topic)),
    );
    const lastAttempt = state.assessmentAttempts.find(
      (attempt) => attempt.courseId === input.courseId,
    );
    const lastSeen = new Set(lastAttempt?.questionIds ?? []);

    const scored = candidates
      .map((question, index) => {
        const key = questionKey(question);
        const record = mastery[key];
        let priority = 0;
        if (recentlyMissed.has(key)) priority += 3;
        if (record)
          priority += (100 - record.mastery) / 50; // 0–2
        else priority += 1.5; // 从未练过
        if (lastSeen.has(question.id)) priority -= 1; // 上次刚做过，换题
        priority += ((index * 7919) % 97) / 1000; // 稳定的微小扰动，避免总是同一顺序
        return { question, priority };
      })
      .sort((left, right) => right.priority - left.priority);

    // 同一知识点最多占 40%，让一套题覆盖更多考点。
    const perKeyLimit = Math.max(2, Math.ceil(size * 0.4));
    const perKeyCount = new Map<string, number>();
    const picked: Question[] = [];
    for (const { question } of scored) {
      const key = questionKey(question);
      const count = perKeyCount.get(key) ?? 0;
      if (count >= perKeyLimit && !requestedKey) continue;
      perKeyCount.set(key, count + 1);
      picked.push(question);
      if (picked.length >= size) break;
    }
    for (const { question } of scored) {
      if (picked.length >= size) break;
      if (!picked.includes(question)) picked.push(question);
    }

    const nowIso = now();
    const session: PracticeSession = {
      id: randomUUID(),
      courseId: input.courseId,
      questionIds: picked.map((question) => question.id),
      ...(requestedKey ? { knowledgeKey: requestedKey } : {}),
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + PRACTICE_SESSION_TTL_MS).toISOString(),
    };
    state.practiceSessions = [
      session,
      ...state.practiceSessions.filter(
        (item) => Date.parse(item.expiresAt) > Date.now() && !item.consumedAt,
      ),
    ].slice(0, PRACTICE_SESSIONS_LIMIT);
    return { session: clone(session), questions: clone(picked) };
  });
}

/** 被用户忽略的考点对应的知识点键。 */
function hiddenKnowledgeKeys(state: WorkspaceState): Set<string> {
  const hidden = new Set(state.hiddenInsights ?? []);
  if (!hidden.size) return new Set();
  return new Set(
    state.insights
      .filter((insight) => hidden.has(insight.id))
      .map((insight) => normalizeKnowledgeKey(insight.title)),
  );
}

function questionKey(question: Question): string {
  return question.knowledgeKey || normalizeKnowledgeKey(question.knowledge);
}

export interface PracticeSubmission {
  courseId: string;
  answers: Record<string, string>;
  /** 会话 id；缺省时对 questionIds 判分；两者都缺省时退回整课（兼容旧客户端）。 */
  sessionId?: string;
  questionIds?: string[];
  /** 简答题自评：correct / partial / wrong。 */
  selfGrades?: Record<string, PracticeGrade>;
  selfRating?: number;
}

export interface PracticeResult {
  workspace: WorkspaceState;
  correct: number;
  total: number;
  graded: number;
  score: number;
  revealed: PracticeReveal[];
}

export async function recordPractice(
  courseIdOrInput: string | PracticeSubmission,
  legacyAnswers?: Record<string, string>,
  legacySelfRating?: number,
): Promise<PracticeResult> {
  const input: PracticeSubmission =
    typeof courseIdOrInput === "string"
      ? { courseId: courseIdOrInput, answers: legacyAnswers ?? {}, selfRating: legacySelfRating }
      : courseIdOrInput;
  return mutateWorkspace((state) => {
    const course = state.courses.find((item) => item.id === input.courseId);
    if (!course) throw new WorkspaceStoreError("未找到课程。", 404);
    const courseQuestions = state.questions.filter(
      (question) => question.courseId === input.courseId,
    );
    if (!courseQuestions.length) throw new WorkspaceStoreError("请至少提交一道本课程练习题。", 400);

    let session: PracticeSession | undefined;
    let scope: Question[];
    if (input.sessionId) {
      session = state.practiceSessions.find(
        (item) => item.id === input.sessionId && item.courseId === input.courseId,
      );
      if (!session) throw new WorkspaceStoreError("练习会话不存在或已过期，请重新开始练习。", 410);
      if (session.consumedAt) throw new WorkspaceStoreError("这次练习已经提交过。", 409);
      if (Date.parse(session.expiresAt) <= Date.now())
        throw new WorkspaceStoreError("练习会话已过期，请重新开始练习。", 410);
      const byId = new Map(courseQuestions.map((question) => [question.id, question]));
      scope = session.questionIds
        .map((id) => byId.get(id))
        .filter((question): question is Question => Boolean(question));
    } else if (Array.isArray(input.questionIds) && input.questionIds.length) {
      const wanted = new Set(input.questionIds);
      scope = courseQuestions.filter((question) => wanted.has(question.id));
      if (scope.length !== wanted.size)
        throw new WorkspaceStoreError("提交的题目不属于当前课程或已被更新，请刷新后重试。", 409);
    } else {
      scope = courseQuestions;
    }
    if (!scope.length)
      throw new WorkspaceStoreError("这次练习的题目已被更新，请重新开始练习。", 410);
    const submitted = scope.filter((question) =>
      Object.prototype.hasOwnProperty.call(input.answers, question.id),
    );
    if (!submitted.length) throw new WorkspaceStoreError("请至少提交一道本课程练习题。", 400);

    const items: AssessmentAttemptItem[] = scope.map((question) => {
      const answer = String(input.answers[question.id] ?? "").slice(0, 5_000);
      return {
        questionId: question.id,
        knowledgeKey: questionKey(question),
        knowledge: question.knowledge,
        prompt: question.prompt.slice(0, 500),
        answer,
        // 用户修正过的答案优先；gradeAnswer 保持纯函数，这里传覆盖后的题目。
        grade: gradeAnswer(
          { ...question, answer: effectiveAnswer(state, question) },
          answer,
          input.selfGrades?.[question.id],
        ),
      };
    });
    const revealed: PracticeReveal[] = scope.map((question, index) => ({
      questionId: question.id,
      correct: items[index]!.grade === "correct",
      grade: items[index]!.grade,
      answer: effectiveAnswer(state, question),
      explanation: question.explanation,
    }));
    const gradedItems = items.filter((item) => item.grade !== "pending");
    const points = gradedItems.reduce((sum, item) => sum + gradeValue(item.grade), 0);
    const correct = items.filter((item) => item.grade === "correct").length;
    const score = gradedItems.length ? Math.round((points / gradedItems.length) * 100) : 0;

    applyPracticeToMastery(state, input.courseId, items);
    refreshInsightMastery(state, input.courseId);
    refreshCourseMastery(state, input.courseId);

    const attempt: AssessmentAttempt = {
      id: randomUUID(),
      courseId: input.courseId,
      ...(session ? { sessionId: session.id } : {}),
      questionIds: scope.map((question) => question.id),
      answers: Object.fromEntries(items.map((item) => [item.questionId, item.answer])),
      items,
      correct,
      total: scope.length,
      graded: gradedItems.length,
      score,
      ...(typeof input.selfRating === "number" ? { selfRating: input.selfRating } : {}),
      createdAt: now(),
    };
    if (session) session.consumedAt = attempt.createdAt;
    state.assessmentAttempts.unshift(attempt);
    if (state.assessmentAttempts.length > 200) state.assessmentAttempts.length = 200;
    appendAudit(state, "assessment.submitted", input.courseId, {
      correct,
      total: scope.length,
      graded: gradedItems.length,
      score,
    });
    rebuildTasksInState(state, "practice");
    return {
      workspace: clone(state),
      correct,
      total: scope.length,
      graded: gradedItems.length,
      score,
      revealed,
    };
  });
}

function gradeValue(grade: PracticeGrade): number {
  return grade === "correct" ? 1 : grade === "partial" ? 0.5 : 0;
}

/**
 * 练习结果 → 知识点掌握度。首次练习直接取本次得分的 60%（避免一题定终身），
 * 之后以 0.35 的学习率做指数滑动平均。
 */
function applyPracticeToMastery(
  state: WorkspaceState,
  courseId: string,
  items: AssessmentAttemptItem[],
): void {
  const bucket = (state.knowledgeMastery[courseId] ??= {});
  const grouped = new Map<
    string,
    { title: string; points: number; count: number; correct: number }
  >();
  for (const item of items) {
    if (item.grade === "pending" || !item.knowledgeKey) continue;
    const entry = grouped.get(item.knowledgeKey) ?? {
      title: item.knowledge,
      points: 0,
      count: 0,
      correct: 0,
    };
    entry.points += gradeValue(item.grade);
    entry.count += 1;
    if (item.grade === "correct") entry.correct += 1;
    grouped.set(item.knowledgeKey, entry);
  }
  const at = now();
  const today = workspaceToday(state);
  for (const [key, entry] of grouped) {
    const observed = Math.round((entry.points / entry.count) * 100);
    const record: KnowledgeMasteryRecord = bucket[key] ?? {
      key,
      title: entry.title,
      mastery: 0,
      attempts: 0,
      correct: 0,
    };
    const next =
      record.attempts === 0
        ? Math.round(observed * 0.6)
        : Math.round(record.mastery * 0.65 + observed * 0.35);
    record.mastery = clamp(next, 0, 100);
    record.attempts += entry.count;
    record.correct += entry.correct;
    record.title = entry.title || record.title;
    record.lastPracticedAt = at;
    scheduleNextReview(record, observed, today);
    bucket[key] = record;
  }
}

const MIN_REVIEW_INTERVAL_DAYS = 1;
const MAX_REVIEW_INTERVAL_DAYS = 60;

/**
 * 间隔复习排程（SM-2 的简化版）：答得越差越快回来，答得越好间隔越长。
 * 只依赖本次正确率、既有间隔和日期，因此可预测、可测试，也不需要额外存储。
 */
function scheduleNextReview(record: KnowledgeMasteryRecord, observed: number, today: string): void {
  const ease = clamp((record.ease ?? 0.8) + (observed - 70) / 400, 0.3, 1.2);
  record.ease = Math.round(ease * 100) / 100;
  const previous = record.intervalDays ?? 0;
  let next: number;
  if (observed < 60) {
    next = MIN_REVIEW_INTERVAL_DAYS;
  } else if (observed < 85) {
    next = previous <= 0 ? 2 : Math.max(2, Math.round(previous * 1.2));
  } else {
    next = previous <= 0 ? 3 : Math.round(previous * (1.6 + ease * 0.8));
  }
  record.intervalDays = clamp(next, MIN_REVIEW_INTERVAL_DAYS, MAX_REVIEW_INTERVAL_DAYS);
  record.due = addDaysToDateOnly(today, record.intervalDays);
}

/**
 * 今天（或更早）到期该复习的知识点。错过的到期日不会被静默跳过：
 * 只要 due <= today 就会出现，直到练习重新排期。
 */
function dueReviewTopics(
  state: WorkspaceState,
  today = workspaceToday(state),
): RecentMissedTopic[] {
  const topics: RecentMissedTopic[] = [];
  for (const [courseId, bucket] of Object.entries(state.knowledgeMastery ?? {})) {
    if (!state.courses.some((course) => course.id === courseId)) continue;
    for (const record of Object.values(bucket)) {
      if (!record.due || record.due > today || record.attempts === 0) continue;
      topics.push({ courseId, topic: record.title, missedOn: record.due, kind: "due" });
    }
  }
  return topics.sort((left, right) => left.missedOn.localeCompare(right.missedOn)).slice(0, 12);
}

/** 读取某个知识点标题对应的练习掌握度；没有记录时为 0。 */
function knowledgeMasteryFor(state: WorkspaceState, courseId: string, title: string): number {
  const bucket = state.knowledgeMastery[courseId];
  if (!bucket) return 0;
  const key = normalizeKnowledgeKey(title);
  const exact = bucket[key];
  if (exact) return exact.mastery;
  const related = Object.values(bucket).filter((record) => knowledgeKeysRelated(record.key, key));
  if (!related.length) return 0;
  return Math.round(related.reduce((sum, record) => sum + record.mastery, 0) / related.length);
}

/** 把 knowledgeMastery 投影回考点卡片（卡片是展示层，掌握度的真源在 knowledgeMastery）。 */
function refreshInsightMastery(state: WorkspaceState, courseId: string): void {
  for (const insight of state.insights) {
    if (insight.courseId !== courseId) continue;
    insight.mastery = knowledgeMasteryFor(state, courseId, insight.title);
    insight.trend =
      insight.mastery >= 80
        ? "已掌握"
        : insightImportance(insight) >= 4 || insight.frequency >= 2
          ? "高频"
          : "需巩固";
  }
}

/**
 * 课程掌握度 = 已练习知识点的平均值。没有任何练习记录时保持 0，
 * UI 会据此显示「尚无练习数据」而不是一个凭空的百分比。
 */
function refreshCourseMastery(state: WorkspaceState, courseId: string): void {
  const course = state.courses.find((item) => item.id === courseId);
  if (!course) return;
  const records = Object.values(state.knowledgeMastery[courseId] ?? {}).filter(
    (record) => record.attempts > 0,
  );
  course.mastery = records.length
    ? clamp(
        Math.round(records.reduce((sum, record) => sum + record.mastery, 0) / records.length),
        0,
        100,
      )
    : 0;
}

/**
 * 判分：
 * - 单选：字母 / 序号 / 选项全文都可以；
 * - 填空：参考答案可用「|」给出多个可接受答案；忽略标点、全角半角与空白；接受用户答案包含参考答案（长度不超过 2 倍）；
 * - 简答：无法机械判分，取自评；没有自评则 pending，不计入分数与掌握度。
 */
export function gradeAnswer(
  question: Question,
  actual: string,
  selfGrade?: PracticeGrade,
): PracticeGrade {
  if (question.type === "简答") {
    if (selfGrade === "correct" || selfGrade === "partial" || selfGrade === "wrong")
      return selfGrade;
    return actual.trim() ? "pending" : "wrong";
  }
  return answerMatches(question, actual) ? "correct" : "wrong";
}

export function answerMatches(question: Question, actual: string): boolean {
  const normalizedActual = normalizeAnswer(actual);
  if (!normalizedActual) return false;
  if (question.type === "单选") {
    const normalizedExpected = normalizeAnswer(question.answer);
    if (!normalizedExpected) return false;
    const expectedChoice =
      choiceToken(normalizedExpected) ?? choiceIndex(question.choices, normalizedExpected);
    const actualChoice =
      choiceToken(normalizedActual) ?? choiceIndex(question.choices, normalizedActual);
    if (expectedChoice && actualChoice) return expectedChoice === actualChoice;
    return normalizedActual === normalizedExpected;
  }
  const accepted = question.answer
    .split(/\s*[|｜]\s*/)
    .map(normalizeAnswer)
    .filter(Boolean);
  if (!accepted.length) return false;
  return accepted.some((expected) => {
    if (normalizedActual === expected) return true;
    // 填空允许多写一点上下文，但不允许用一大段话“覆盖”所有可能答案。
    return (
      expected.length >= 2 &&
      normalizedActual.includes(expected) &&
      normalizedActual.length <= Math.max(expected.length * 2, expected.length + 6)
    );
  });
}

function normalizeAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[，。、；：！？（）【】《》“”‘’,.;:!?()\[\]"'<>]+/g, "")
    .replace(/(\d),(?=\d{3})/g, "$1");
}

function choiceToken(value: string): string | undefined {
  const match = /^([a-z]|[一二三四五六七八九十])(?:[.、:：)）]|$)/i.exec(value);
  if (!match?.[1]) return undefined;
  const chinese: Record<string, string> = {
    一: "A",
    二: "B",
    三: "C",
    四: "D",
    五: "E",
    六: "F",
    七: "G",
    八: "H",
    九: "I",
    十: "J",
  };
  return chinese[match[1]] ?? match[1].toUpperCase();
}

function choiceIndex(choices: string[] | undefined, value: string): string | undefined {
  if (!choices?.length) return undefined;
  const index = choices.findIndex(
    (choice) =>
      normalizeAnswer(choice) === value ||
      normalizeAnswer(choice).replace(/^[a-j][.、:：)）]?/i, "") === value,
  );
  return index >= 0 ? String.fromCharCode(65 + index) : undefined;
}

function formatEvidence(evidence: { label: string; location: string }): string {
  return [evidence.label, evidence.location].filter(Boolean).join(" · ") || "上传资料";
}

function invalidateCourseSynthesis(state: WorkspaceState, courseId: string): void {
  delete state.courseSyntheses[courseId];
  state.insights = state.insights.filter((item) => !item.id.startsWith(`synthesis-${courseId}-`));
  state.questions = state.questions.filter((item) => !item.id.startsWith(`synthesis-${courseId}-`));
}

function refreshCourseWeights(state: WorkspaceState, courseId: string): void {
  const course = state.courses.find((item) => item.id === courseId);
  if (!course) return;
  const insights = state.insights.filter((item) => item.courseId === courseId);
  if (!insights.length) {
    course.highFrequencyWeight = 0.5;
    return;
  }
  course.highFrequencyWeight = clamp(
    insights.reduce((sum, item) => sum + insightImportance(item), 0) / (insights.length * 5),
    0.2,
    1,
  );
}

function refreshCreditsFromLedger(state: WorkspaceState): void {
  state.profile.credits = Math.max(
    0,
    state.ledger.reduce((sum, item) => sum + item.amount, 0),
  );
}

function workspaceToday(state: WorkspaceState): string {
  return dateOnlyInTimeZone(state.profile.timezone || "Asia/Shanghai");
}

function studyDayStartMinutes(state: WorkspaceState): number {
  const value = state.profile.studyDayStart ?? DEFAULT_STUDY_DAY_START;
  return isValidClockTime(value)
    ? clockTimeToMinutes(value)
    : clockTimeToMinutes(DEFAULT_STUDY_DAY_START);
}

function rebuildTasksInState(state: WorkspaceState, trigger: "full" | "practice" = "full"): void {
  if (!state.courses.length) {
    state.tasks = [];
    state.planSource = "schedule";
    return;
  }
  collectMissedTasksInState(state);
  rollAvailabilityForward(state);
  if (trigger === "practice" && state.planSource === "ai" && state.tasks.length) {
    injectMissedReviewTasks(state);
    return;
  }
  // Any automatic re-arrangement (analysis, availability change) is the
  // deterministic scheduler, never an AI call; record that honestly so the
  // UI never presents this plan as model output.
  state.planSource = "schedule";
  // A task id is a scheduling position, not a durable description of work.
  // Keep a completion only when the regenerated task still describes the
  // same course/date/time/focus; otherwise a changed plan must be actionable.
  const completedTaskIdentities = new Set(
    state.tasks.filter((task) => task.status === "已完成").map(taskCompletionIdentity),
  );
  const hiddenInsightIds = new Set(state.hiddenInsights ?? []);
  const visibleInsights = hiddenInsightIds.size
    ? state.insights.filter((insight) => !hiddenInsightIds.has(insight.id))
    : state.insights;
  state.tasks = buildAdaptivePlan({
    courses: state.courses,
    availability: state.availability,
    insights: visibleInsights,
    recentMisses: recentMissedTopics(state),
    dueTopics: dueReviewTopics(state),
    fromDate: workspaceToday(state),
    dayStartMinutes: studyDayStartMinutes(state),
  }).map((task) => ({
    ...task,
    status: completedTaskIdentities.has(taskCompletionIdentity(task)) ? "已完成" : "待完成",
  }));
}

/**
 * Knowledge topics the learner answered wrong in practice attempts over the
 * last seven days. The plan builder resurfaces them as explicit review tasks
 * (spaced-repetition style) so a real mistake comes back instead of being
 * absorbed into generic course-level work.
 */
function recentMissedTopics(state: WorkspaceState): RecentMissedTopic[] {
  const today = workspaceToday(state);
  const cutoff = addDaysToDateOnly(today, -7);
  const latestByTopic = new Map<string, RecentMissedTopic>();
  for (const attempt of state.assessmentAttempts) {
    const missedOn = attempt.createdAt.slice(0, 10);
    if (missedOn < cutoff || missedOn > today) continue;
    for (const item of attempt.items) {
      if (item.grade !== "wrong" && item.grade !== "partial") continue;
      const topic = item.knowledge.trim().slice(0, 80) || item.prompt.trim().slice(0, 80);
      if (!topic) continue;
      const key = `${attempt.courseId}\u0001${topic}`;
      const existing = latestByTopic.get(key);
      if (!existing || missedOn > existing.missedOn)
        latestByTopic.set(key, { courseId: attempt.courseId, topic, missedOn });
    }
  }
  return [...latestByTopic.values()]
    .sort((left, right) => left.missedOn.localeCompare(right.missedOn))
    .slice(0, 12);
}

function injectMissedReviewTasks(state: WorkspaceState): void {
  const today = workspaceToday(state);
  const dayStart = studyDayStartMinutes(state);
  const capacity = state.availability.find((item) => item.date === today)?.minutes ?? 0;
  const todayTasks = state.tasks.filter((task) => task.date === today);
  let used = todayTasks.reduce((total, task) => total + task.duration, 0);
  let slot = todayTasks.length;
  const existing = new Set(
    state.tasks
      .filter((task) => task.date >= today && task.type === "回顾")
      .map((task) => task.title),
  );
  for (const miss of recentMissedTopics(state)) {
    const course = state.courses.find((item) => item.id === miss.courseId);
    if (!course || course.examDate < today) continue;
    const marker = `重练错题「${miss.topic}」`;
    if ([...existing].some((title) => title.includes(marker))) continue;
    if (capacity - used < 15) break;
    const duration = Math.min(30, capacity - used);
    const phase = examPhaseLabel(
      Math.max(
        1,
        Math.ceil(
          (Date.parse(`${course.examDate}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) /
            86_400_000,
        ),
      ),
    );
    const task: StudyTask = {
      id: `${today}-${course.id}-miss-${slot}`,
      courseId: course.id,
      date: today,
      start: startClock(dayStart + used),
      duration,
      title: `${phase} · ${marker}并核对解题依据 · ${course.name}`,
      type: "回顾",
      status: "待完成",
      reason: `${miss.missedOn.slice(5).replace("-", "/")} 练习答错，安排重练巩固`,
      knowledge: miss.topic,
    };
    state.tasks.unshift(task);
    existing.add(task.title);
    used += duration;
    slot += 1;
  }
}

function startClock(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1_440) + 1_440) % 1_440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function collectMissedTasksInState(state: WorkspaceState): void {
  const today = workspaceToday(state);
  const missed = state.tasks.filter((task) => task.date < today && task.status !== "已完成");
  if (!missed.length) return;
  const existing = new Set(state.missedTasks.map(taskCompletionIdentity));
  const fresh = missed.map((task) => ({ ...task, status: "已错过" as const }));
  state.missedTasks = [
    ...fresh.filter((task) => !existing.has(taskCompletionIdentity(task))),
    ...state.missedTasks,
  ].slice(0, MISSED_TASKS_LIMIT);
  state.tasks = state.tasks.filter((task) => task.date >= today || task.status === "已完成");
}

function rollAvailabilityForward(state: WorkspaceState): void {
  const today = workspaceToday(state);
  const existingByDate = new Map(state.availability.map((item) => [item.date, item.minutes]));
  const templateMinutes = state.availability.map((item) => item.minutes);
  state.availability = Array.from({ length: PLAN_WINDOW_DAYS }, (_, index) => {
    const date = addDaysToDateOnly(today, index);
    return {
      date,
      minutes: existingByDate.get(date) ?? templateMinutes[index] ?? DEFAULT_AVAILABILITY_MINUTES,
    };
  });
}

function taskCompletionIdentity(task: StudyTask): string {
  return [task.courseId, task.date, task.start, task.duration, task.type, task.title].join(
    "\u0001",
  );
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

export class CommunityStoreError extends WorkspaceStoreError {
  constructor(
    message: string,
    status = 400,
    readonly code = "COMMUNITY_ERROR",
  ) {
    super(message, status);
    this.name = "CommunityStoreError";
  }
}

function isSharedMaterialExpired(
  record: Pick<StoredSharedMaterial, "accessEndsOn">,
  today: string,
): boolean {
  // Invalid persisted expiry metadata is fail-closed. A shared file must not
  // remain downloadable indefinitely because an old state file was malformed.
  return !isValidDateOnly(record.accessEndsOn) || record.accessEndsOn < today;
}

function publicSharedMaterial(
  record: StoredSharedMaterial,
  state: WorkspaceState,
): PublicSharedMaterial {
  const owned = record.contributorId === state.profile.id;
  const inSchoolScope =
    profileCanUseCommunity(state) &&
    record.school === state.profile.school &&
    courseCodesForProfile(state).includes(record.courseCode);
  const hasGrant = state.unlockGrants.some(
    (grant) => grant.sharedMaterialId === record.id && !grant.revokedAt,
  );
  const canDownload =
    !isSharedMaterialExpired(record, workspaceToday(state)) &&
    ACTIVE_SHARED_STATUSES.has(record.status) &&
    (owned || (inSchoolScope && hasGrant));
  const {
    objectKey: _objectKey,
    sha256: _sha256,
    contributorId: _contributorId,
    consentedAt: _consentedAt,
    accessEndsOn: _accessEndsOn,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...publicRecord
  } = clone(record);
  return {
    ...publicRecord,
    isMine: owned,
    canDownload,
    ...(record.moderationReason ? { moderationReason: record.moderationReason } : {}),
  };
}

function profileCanUseCommunity(state: WorkspaceState): boolean {
  return Boolean(state.profile.email && state.profile.school && state.profile.verified);
}

function courseCodesForProfile(state: WorkspaceState): string[] {
  return state.courses.map((course) => course.code);
}

async function archiveExpiredSharedMaterialsWithWorkspace(): Promise<{
  workspace: WorkspaceState;
  objectKeys: string[];
}> {
  const result = await mutateWorkspaceConditionally((state) => {
    const today = workspaceToday(state);
    const expired = state.sharedMaterialRecords.filter((record) =>
      !["待审核", ...ACTIVE_SHARED_STATUSES].includes(record.status)
        ? false
        : isSharedMaterialExpired(record, today),
    );
    for (const record of expired) {
      record.status = "已归档";
      record.moderationReason = "访问期限已结束，系统已自动归档。";
      record.updatedAt = now();
      appendAudit(state, "community.material_archived", record.id, { reason: "access_expired" });
    }
    if (expired.length) {
      const expiredById = new Map(expired.map((record) => [record.id, record]));
      state.sharedMaterials = state.sharedMaterials.map((item) => {
        const current = expiredById.get(item.id);
        return current ? publicSharedMaterial(current, state) : item;
      });
    }
    return {
      changed: expired.length > 0,
      result: { state, objectKeys: expired.map((record) => record.objectKey) },
    };
  });
  await Promise.all(
    result.objectKeys.map((objectKey) => {
      const safeKey = path.basename(objectKey);
      return safeKey === objectKey
        ? unlink(path.join(getSharedDirectory(), safeKey)).catch(() => undefined)
        : Promise.resolve();
    }),
  );
  return { workspace: clone(result.state), objectKeys: result.objectKeys };
}

export async function archiveExpiredSharedMaterials(): Promise<number> {
  return (await archiveExpiredSharedMaterialsWithWorkspace()).objectKeys.length;
}

export async function listCommunityMaterials(): Promise<{
  materials: PublicSharedMaterial[];
  credits: number;
  ledger: CreditTransaction[];
}> {
  const { workspace: state } = await archiveExpiredSharedMaterialsWithWorkspace();
  const canBrowse = profileCanUseCommunity(state);
  const courseCodes = new Set(courseCodesForProfile(state));
  const records = state.sharedMaterialRecords
    .filter(
      (record) =>
        record.contributorId === state.profile.id ||
        (canBrowse &&
          record.school === state.profile.school &&
          courseCodes.has(record.courseCode) &&
          ACTIVE_SHARED_STATUSES.has(record.status)),
    )
    .map((record) => publicSharedMaterial(record, state));
  return {
    materials: records,
    credits: state.profile.credits,
    ledger: clone(state.ledger).slice(0, 50),
  };
}

export async function contributeSharedMaterial(input: {
  materialId: string;
  consent: boolean;
  privacyConfirmed: boolean;
}): Promise<{ material: PublicSharedMaterial; workspace: WorkspaceState }> {
  if (!input.consent || !input.privacyConfirmed)
    throw new CommunityStoreError(
      "共享资料前必须确认拥有分享权限，并确认已移除个人敏感信息。",
      400,
      "CONSENT_REQUIRED",
    );
  await archiveExpiredSharedMaterials();
  const current = await getWorkspace();
  if (!profileCanUseCommunity(current))
    throw new CommunityStoreError(
      "请先完成已验证邮箱和学校配置，才能提交校内资料。",
      403,
      "SCHOOL_VERIFICATION_REQUIRED",
    );
  const privateMaterial = current.materials.find((item) => item.id === input.materialId);
  if (!privateMaterial)
    throw new CommunityStoreError("未找到要共享的私有资料。", 404, "MATERIAL_NOT_FOUND");
  if (
    (privateMaterial.status !== "已分析" && privateMaterial.status !== "需确认") ||
    !current.documentAnalyses[input.materialId]
  )
    throw new CommunityStoreError(
      "只有完成 AI 分析的资料才能提交审核。",
      422,
      "MATERIAL_NOT_ANALYZED",
    );
  if (
    current.sharedMaterialRecords.some(
      (record) =>
        record.sha256 === privateMaterial.sha256 &&
        ["待审核", "可解锁", "已解锁"].includes(record.status),
    )
  )
    throw new CommunityStoreError("这份资料已经提交过，不能重复共享。", 409, "DUPLICATE_SHARE");
  const course = current.courses.find((item) => item.id === privateMaterial.courseId);
  if (!course) throw new CommunityStoreError("资料所属课程不存在。", 404, "COURSE_NOT_FOUND");
  const id = randomUUID();
  const extension = path.extname(privateMaterial.objectKey).replace(/^\./, "").toLowerCase();
  const objectKey = `${id}.${extension || "bin"}`;
  await ensureDirectories();
  const sourcePath = path.join(getUploadsDirectory(), path.basename(privateMaterial.objectKey));
  const targetPath = path.join(getSharedDirectory(), objectKey);
  try {
    await copyFile(sourcePath, targetPath);
    const analysis = current.documentAnalyses[input.materialId];
    const createdAt = now();
    const record: StoredSharedMaterial = {
      id,
      school: current.profile.school,
      courseName: course.name,
      courseCode: course.code,
      teacher: course.teacher,
      term: course.term,
      title: privateMaterial.name,
      kind: privateMaterial.kind,
      pages: privateMaterial.pages,
      mimeType: privateMaterial.mimeType,
      ...(privateMaterial.byteSize ? { byteSize: privateMaterial.byteSize } : {}),
      contributor: current.profile.displayName || "已验证贡献者",
      quality: "待核验",
      credits: 10,
      tags: analysis.keyPoints.slice(0, 5).map((point) => point.title),
      preview: analysis.summary.slice(0, 500),
      status: "待审核",
      unlocks: 0,
      objectKey,
      sha256: privateMaterial.sha256,
      contributorId: current.profile.id,
      createdAt,
      updatedAt: createdAt,
      consentedAt: createdAt,
      accessEndsOn: course.examDate,
    };
    const workspace = await mutateWorkspace((state) => {
      const liveMaterial = state.materials.find((item) => item.id === input.materialId);
      if (
        !liveMaterial ||
        liveMaterial.sha256 !== privateMaterial.sha256 ||
        (liveMaterial.status !== "已分析" && liveMaterial.status !== "需确认") ||
        !state.documentAnalyses[input.materialId]
      ) {
        throw new CommunityStoreError(
          "资料在提交期间发生变化，请刷新后重试。",
          409,
          "MATERIAL_CHANGED",
        );
      }
      if (
        state.sharedMaterialRecords.some(
          (item) =>
            item.sha256 === liveMaterial.sha256 &&
            (item.status === "待审核" || ACTIVE_SHARED_STATUSES.has(item.status)),
        )
      ) {
        throw new CommunityStoreError("这份资料已经提交过，不能重复共享。", 409, "DUPLICATE_SHARE");
      }
      state.sharedMaterialRecords.unshift(record);
      state.sharedMaterials.unshift(publicSharedMaterial(record, state));
      const owned = state.materials.find((item) => item.id === input.materialId);
      if (owned) owned.shared = true;
      appendAudit(state, "community.contribution_submitted", id, { materialId: input.materialId });
      return clone(state);
    });
    return { material: publicSharedMaterial(record, workspace), workspace };
  } catch (error) {
    await unlink(targetPath).catch(() => undefined);
    throw error;
  }
}

export async function moderateSharedMaterial(input: {
  materialId: string;
  decision: "approve" | "reject";
  quality?: "优质" | "已核验" | "待核验";
  reason?: string;
}): Promise<{ material: PublicSharedMaterial; workspace: WorkspaceState }> {
  if (input.decision !== "approve" && input.decision !== "reject")
    throw new CommunityStoreError("审核决定无效。", 400, "INVALID_DECISION");
  if (input.quality !== undefined && !["优质", "已核验", "待核验"].includes(input.quality))
    throw new CommunityStoreError("资料质量标记无效。", 400, "INVALID_QUALITY");
  await archiveExpiredSharedMaterials();
  const workspace = await mutateWorkspace((state) => {
    const record = state.sharedMaterialRecords.find((item) => item.id === input.materialId);
    if (!record) throw new CommunityStoreError("未找到共享资料。", 404, "SHARE_NOT_FOUND");
    if (!["待审核", "可解锁"].includes(record.status))
      throw new CommunityStoreError(
        "该资料已完成审核，不能重复处理。",
        409,
        "SHARE_ALREADY_MODERATED",
      );
    record.updatedAt = now();
    record.moderationReason = input.reason?.trim().slice(0, 500);
    if (input.decision === "approve") {
      record.status = "可解锁";
      record.quality = input.quality ?? "已核验";
      const idempotencyKey = `contribution:${record.id}`;
      if (!state.ledger.some((item) => item.id === idempotencyKey)) {
        const transaction: CreditTransaction = {
          id: idempotencyKey,
          label: `贡献《${record.title}》通过审核`,
          amount: record.credits,
          createdAt: now(),
          kind: "earn",
        };
        state.ledger.unshift(transaction);
      }
      appendAudit(state, "community.contribution_approved", record.id, { credits: record.credits });
    } else {
      record.status = "已拒绝";
      const contributionKey = `contribution:${record.id}`;
      const reversalKey = `reversal:${record.id}`;
      if (
        state.ledger.some((item) => item.id === contributionKey) &&
        !state.ledger.some((item) => item.id === reversalKey)
      ) {
        state.ledger.unshift({
          id: reversalKey,
          label: `撤销《${record.title}》贡献积分`,
          amount: -record.credits,
          createdAt: now(),
          kind: "reversal",
        });
      }
      for (const grant of state.unlockGrants) {
        if (grant.sharedMaterialId === record.id && !grant.revokedAt) grant.revokedAt = now();
      }
      appendAudit(state, "community.contribution_rejected", record.id, {
        reason: record.moderationReason ?? "",
      });
    }
    refreshCreditsFromLedger(state);
    state.sharedMaterials = state.sharedMaterials.map((item) =>
      item.id === record.id ? publicSharedMaterial(record, state) : item,
    );
    return clone(state);
  });
  const record = workspace.sharedMaterialRecords.find((item) => item.id === input.materialId);
  if (!record) throw new CommunityStoreError("共享资料状态读取失败。", 500);
  return { material: publicSharedMaterial(record, workspace), workspace };
}

export async function unlockSharedMaterial(
  materialId: string,
): Promise<{ material: PublicSharedMaterial; workspace: WorkspaceState }> {
  await archiveExpiredSharedMaterials();
  const workspace = await mutateWorkspace((state) => {
    if (!profileCanUseCommunity(state))
      throw new CommunityStoreError(
        "请先完成邮箱和学校验证。",
        403,
        "SCHOOL_VERIFICATION_REQUIRED",
      );
    const record = state.sharedMaterialRecords.find((item) => item.id === materialId);
    if (!record) throw new CommunityStoreError("未找到共享资料。", 404, "SHARE_NOT_FOUND");
    if (record.contributorId === state.profile.id) return clone(state);
    if (
      !ACTIVE_SHARED_STATUSES.has(record.status) ||
      isSharedMaterialExpired(record, workspaceToday(state))
    )
      throw new CommunityStoreError("该资料尚未通过审核或已归档。", 409, "SHARE_NOT_AVAILABLE");
    if (
      record.school !== state.profile.school ||
      !courseCodesForProfile(state).includes(record.courseCode)
    )
      throw new CommunityStoreError("仅同校且匹配课程的用户可解锁。", 403, "SCHOOL_SCOPE_MISMATCH");
    if (
      state.unlockGrants.some((grant) => grant.sharedMaterialId === materialId && !grant.revokedAt)
    )
      return clone(state);
    refreshCreditsFromLedger(state);
    if (state.profile.credits < record.credits)
      throw new CommunityStoreError("积分不足。", 402, "INSUFFICIENT_CREDITS");
    const transactionId = `unlock:${state.profile.id}:${record.id}`;
    if (state.ledger.some((item) => item.id === transactionId)) return clone(state);
    state.ledger.unshift({
      id: transactionId,
      label: `解锁《${record.title}》`,
      amount: -record.credits,
      createdAt: now(),
      kind: "spend",
    });
    refreshCreditsFromLedger(state);
    if (state.profile.credits < 0)
      throw new CommunityStoreError("积分不足。", 402, "INSUFFICIENT_CREDITS");
    state.unlockGrants.unshift({ id: randomUUID(), sharedMaterialId: record.id, grantedAt: now() });
    record.unlocks += 1;
    appendAudit(state, "community.material_unlocked", record.id, { credits: record.credits });
    return clone(state);
  });
  const record = workspace.sharedMaterialRecords.find((item) => item.id === materialId);
  if (!record) throw new CommunityStoreError("共享资料状态读取失败。", 500);
  return { material: publicSharedMaterial(record, workspace), workspace };
}

export async function reportSharedMaterial(input: {
  materialId: string;
  reason: string;
  detail?: string;
}): Promise<WorkspaceState> {
  const reason = input.reason.trim().slice(0, 100);
  const detail = (input.detail ?? "").trim().slice(0, 1_000);
  if (!reason) throw new CommunityStoreError("举报原因不能为空。", 400, "REPORT_REASON_REQUIRED");
  await archiveExpiredSharedMaterials();
  return mutateWorkspace((state) => {
    if (!profileCanUseCommunity(state))
      throw new CommunityStoreError(
        "请先完成邮箱和学校验证后再举报共享资料。",
        403,
        "SCHOOL_VERIFICATION_REQUIRED",
      );
    const record = state.sharedMaterialRecords.find((item) => item.id === input.materialId);
    if (!record) throw new CommunityStoreError("未找到共享资料。", 404, "SHARE_NOT_FOUND");
    if (
      state.sharedReports.some(
        (report) => report.sharedMaterialId === input.materialId && !report.resolvedAt,
      )
    )
      throw new CommunityStoreError("你已经举报过这份资料。", 409, "REPORT_DUPLICATE");
    state.sharedReports.unshift({
      id: randomUUID(),
      sharedMaterialId: input.materialId,
      reason,
      detail,
      createdAt: now(),
    });
    appendAudit(state, "community.material_reported", input.materialId, { reason });
    return clone(state);
  });
}

/** Operator-facing queue: pending contributions and unresolved reports. */
export async function listModerationQueue(): Promise<ModerationQueue> {
  await archiveExpiredSharedMaterials();
  const state = await getWorkspace();
  const pending = state.sharedMaterialRecords
    .filter((record) => record.status === "待审核")
    .map((record) => publicSharedMaterial(record, state));
  const reports = state.sharedReports
    .filter((report) => !report.resolvedAt)
    .map((report) => ({
      id: report.id,
      sharedMaterialId: report.sharedMaterialId,
      materialTitle:
        state.sharedMaterialRecords.find((record) => record.id === report.sharedMaterialId)
          ?.title ?? "（资料已删除）",
      reason: report.reason,
      detail: report.detail,
      createdAt: report.createdAt,
    }));
  const active = state.sharedMaterialRecords.filter(
    (record) =>
      ACTIVE_SHARED_STATUSES.has(record.status) &&
      !isSharedMaterialExpired(record, workspaceToday(state)),
  );
  return { pending, reports, activeCount: active.length };
}

export async function resolveSharedReport(
  reportId: string,
  resolution: string,
): Promise<WorkspaceState> {
  const note = resolution.trim().slice(0, 500);
  if (!note) throw new CommunityStoreError("处理说明不能为空。", 400, "REPORT_RESOLUTION_REQUIRED");
  return mutateWorkspace((state) => {
    const report = state.sharedReports.find((item) => item.id === reportId);
    if (!report) throw new CommunityStoreError("未找到该举报记录。", 404, "REPORT_NOT_FOUND");
    if (report.resolvedAt)
      throw new CommunityStoreError("该举报已处理，不能重复处理。", 409, "REPORT_ALREADY_RESOLVED");
    report.resolvedAt = now();
    report.resolution = note;
    appendAudit(state, "community.report_resolved", reportId, {
      sharedMaterialId: report.sharedMaterialId,
    });
    return clone(state);
  });
}

/** Full raw workspace snapshot for the owner's own backup. Server-only. */
export async function exportWorkspaceData(): Promise<WorkspaceState> {
  return getWorkspace();
}

/**
 * 用导出的 JSON 覆盖当前工作区。
 *
 * 顺序很重要：先校验、再备份当前文件、最后原子替换，任何一步失败都不会破坏现有数据。
 * 导入是「整份替换」，因此调用方必须先让用户明确确认。
 */
export async function importWorkspaceData(
  input: unknown,
): Promise<{ workspace: WorkspaceState; backupPath: string; materials: number; courses: number }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkspaceStoreError("导入文件必须是导出的工作区 JSON 对象。", 400);
  }
  const raw = input as Record<string, unknown>;
  const version = typeof raw.version === "number" ? raw.version : 1;
  let upgraded: unknown = raw;
  if (version < WORKSPACE_SCHEMA_VERSION) {
    upgraded = migrateWorkspaceRaw(raw, WORKSPACE_SCHEMA_VERSION).state;
  }
  if (!isWorkspaceState(upgraded)) {
    throw new WorkspaceStoreError("导入文件不是有效的期末星图工作区数据。", 400);
  }
  const imported = normalizeWorkspaceState(upgraded);
  await ensureDirectories();

  // 导入前把当前状态另存为带时间戳的备份，避免误操作后无法回退。
  const stamp = now().replace(/[:.]/g, "-");
  const backupPath = path.join(getWorkspaceDataDirectory(), `workspace.pre-import-${stamp}.json`);
  const current = await readFile(getStatePath(), "utf8").catch(() => undefined);
  if (current !== undefined) await writeFile(backupPath, current, "utf8");

  await mutateWorkspace((state) => {
    Object.assign(state, imported);
    appendAudit(state, "workspace.imported", "workspace", {
      courses: imported.courses.length,
      materials: imported.materials.length,
      fromVersion: version,
    });
    return clone(state);
  });
  return {
    workspace: await getWorkspace(),
    backupPath,
    materials: imported.materials.length,
    courses: imported.courses.length,
  };
}

export async function getSharedMaterialFileReference(
  materialId: string,
): Promise<{ material: PublicSharedMaterial; filePath: string; byteSize: number }> {
  await archiveExpiredSharedMaterials();
  const state = await getWorkspace();
  const record = state.sharedMaterialRecords.find((item) => item.id === materialId);
  if (!record) throw new CommunityStoreError("未找到共享资料。", 404, "SHARE_NOT_FOUND");
  const publicRecord = publicSharedMaterial(record, state);
  if (!publicRecord.canDownload)
    throw new CommunityStoreError("请先解锁这份资料。", 403, "SHARE_LOCKED");
  const safeKey = path.basename(record.objectKey);
  if (safeKey !== record.objectKey)
    throw new CommunityStoreError("共享资料存储键无效。", 500, "SHARE_STORAGE_INVALID");
  const filePath = path.join(getSharedDirectory(), safeKey);
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error("shared material path is not a regular file");
    return { material: publicRecord, filePath, byteSize: fileInfo.size };
  } catch (error) {
    if (isNodeError(error, "ENOENT"))
      throw new CommunityStoreError("共享资料文件不存在。", 410, "SHARE_FILE_MISSING");
    throw error;
  }
}

export async function readSharedMaterialFile(
  materialId: string,
): Promise<{ material: PublicSharedMaterial; buffer: Buffer }> {
  const reference = await getSharedMaterialFileReference(materialId);
  return { material: reference.material, buffer: await readFile(reference.filePath) };
}

export function createFileDownloadResponse(
  filePath: string,
  mimeType: string,
  filename: string,
  byteSize: number,
): Response {
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": mimeType || "application/octet-stream",
      "Content-Length": String(byteSize),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeDownloadFilename(filename))}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Test-only utility; it intentionally acts only inside the configured data dir. */
export async function resetWorkspaceForTests(): Promise<void> {
  await mutateWorkspace((state) => {
    const fresh = emptyWorkspace();
    Object.assign(state, fresh);
  });
}
