import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAdaptivePlan } from "./plan-engine";
import type { AiPlanCourse, CourseSynthesis, DocumentAnalysis } from "./ai-types";
import { inferMimeType, isSupportedFile } from "./ai-analysis";
import type { Availability, Course, CreditTransaction, Insight, MaterialKind, Question, RecentMissedTopic, SharedMaterial, StudyTask } from "./types";
import type { AssessmentAttempt, AuditEvent, CourseInput, ModerationQueue, OtpChallenge, PublicMaterial, PublicSharedMaterial, PublicWorkspaceState, StoredMaterial, StoredSharedMaterial, WorkspaceState } from "./workspace-types";

const STATE_FILENAME = "workspace.json";
const UPLOAD_DIRECTORY = "uploads";
const DEFAULT_AVAILABILITY_MINUTES = 120;
const COURSE_COLORS = ["#6d5dfc", "#10a98b", "#ed8b4a", "#3278c7", "#b863c8", "#d55d78"];
const ACTIVE_SHARED_STATUSES: ReadonlySet<SharedMaterial["status"]> = new Set(["可解锁", "已解锁"]);
const PLAN_WINDOW_DAYS = 7;
const STALE_ANALYSIS_RESERVATION_MS = 30 * 60_000;
const DEFAULT_STUDY_DAY_START = "18:30";
const MISSED_TASKS_LIMIT = 60;

let writeTail: Promise<void> = Promise.resolve();
let uploadReconciliation: Promise<void> | undefined;

export class WorkspaceStoreError extends Error {
  constructor(message: string, readonly status = 400) {
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
  return path.resolve(/* turbopackIgnore: true */ process.env.FINALE_DATA_DIR?.trim() || path.join(process.cwd(), "data"));
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
    version: 1,
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
    auditLog: [],
    sharedMaterialRecords: [],
    sharedReports: [],
    unlockGrants: [],
    otpChallenges: [],
    missedTasks: [],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  return Boolean(value && typeof value === "object" && (value as { version?: unknown }).version === 1 && Array.isArray((value as { courses?: unknown }).courses));
}

function normalizeWorkspaceState(value: WorkspaceState): WorkspaceState {
  const empty = emptyWorkspace();
  const candidate = value as Partial<WorkspaceState>;
  return {
    ...empty,
    ...candidate,
    profile: { ...empty.profile, ...(candidate.profile && typeof candidate.profile === "object" ? candidate.profile : {}) },
    courses: Array.isArray(candidate.courses) ? candidate.courses : [],
    availability: Array.isArray(candidate.availability) ? candidate.availability : empty.availability,
    materials: Array.isArray(candidate.materials) ? candidate.materials : [],
    insights: Array.isArray(candidate.insights) ? candidate.insights : [],
    questions: Array.isArray(candidate.questions) ? candidate.questions : [],
    tasks: Array.isArray(candidate.tasks) ? candidate.tasks : [],
    sharedMaterials: Array.isArray(candidate.sharedMaterials) ? candidate.sharedMaterials : [],
    ledger: Array.isArray(candidate.ledger) ? candidate.ledger : [],
    documentAnalyses: isRecord(candidate.documentAnalyses) ? candidate.documentAnalyses : {},
    courseSyntheses: isRecord(candidate.courseSyntheses) ? candidate.courseSyntheses : {},
    assessmentAttempts: Array.isArray(candidate.assessmentAttempts) ? candidate.assessmentAttempts : [],
    auditLog: Array.isArray(candidate.auditLog) ? candidate.auditLog : [],
    sharedMaterialRecords: Array.isArray(candidate.sharedMaterialRecords) ? candidate.sharedMaterialRecords : [],
    sharedReports: Array.isArray(candidate.sharedReports) ? candidate.sharedReports : [],
    unlockGrants: Array.isArray(candidate.unlockGrants) ? candidate.unlockGrants : [],
    otpChallenges: Array.isArray(candidate.otpChallenges) ? candidate.otpChallenges : [],
    missedTasks: Array.isArray(candidate.missedTasks) ? candidate.missedTasks : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  let state: WorkspaceState;
  try {
    const raw = await readFile(getStatePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isWorkspaceState(parsed)) throw new WorkspaceStoreError("本地工作区数据格式无效。请备份 data/workspace.json 后重新启动。", 500);
    state = normalizeWorkspaceState(parsed);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    state = emptyWorkspace();
  }
  await reconcileUploadDirectoryOnce(state);
  return state;
}

function reconcileUploadDirectoryOnce(state: WorkspaceState): Promise<void> {
  if (uploadReconciliation) return uploadReconciliation;
  const referenced = new Set(state.materials.map((material) => material.objectKey));
  const uploadObjectPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|ppt|pptx|doc|docx|jpg|jpeg|png|webp)$/i;
  uploadReconciliation = (async () => {
    const entries = await readdir(getUploadsDirectory(), { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".incoming") || (uploadObjectPattern.test(entry.name) && !referenced.has(entry.name))))
      .map((entry) => unlink(path.join(getUploadsDirectory(), entry.name)).catch(() => undefined)));
  })();
  return uploadReconciliation;
}

async function writeWorkspaceInternal(state: WorkspaceState): Promise<void> {
  await ensureDirectories();
  const statePath = getStatePath();
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
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
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
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
  mutator: (state: WorkspaceState) => ConditionalWorkspaceMutation<T> | Promise<ConditionalWorkspaceMutation<T>>,
): Promise<T> {
  const run = writeTail.then(async () => {
    const state = await readWorkspaceInternal();
    const mutation = await mutator(state);
    if (mutation.changed) {
      state.updatedAt = now();
      await writeWorkspaceInternal(state);
    }
    return mutation.result;
  });
  writeTail = run.then(() => undefined, () => undefined);
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

export function toPublicMaterial(material: StoredMaterial): PublicMaterial {
  const { objectKey: _objectKey, sha256: _sha256, uploadedAt: _uploadedAt, updatedAt: _updatedAt, analysisLease: _analysisLease, ...publicMaterial } = material;
  return publicMaterial;
}

export function toPublicWorkspace(workspace: WorkspaceState): PublicWorkspaceState {
  const cloned = clone(workspace);
  const { materials, sharedMaterialRecords: _sharedMaterialRecords, sharedReports: _sharedReports, unlockGrants: _unlockGrants, auditLog: _auditLog, otpChallenges: _otpChallenges, planGenerationLease: _planGenerationLease, ...publicFields } = cloned;
  return {
    ...publicFields,
    materials: materials.map(toPublicMaterial),
  };
}

/**
 * Capture the exact analyzed inputs for a course-level AI request. This is
 * intentionally server-only metadata and must never be returned to clients.
 */
export function createCourseSynthesisSourceSnapshot(workspace: WorkspaceState, courseId: string): CourseSynthesisSourceSnapshot {
  return { sources: courseSynthesisSourceEntries(workspace, courseId) };
}

function appendAudit(state: WorkspaceState, action: string, resource: string, metadata?: AuditEvent["metadata"]): void {
  state.auditLog.unshift({ id: randomUUID(), action, resource, createdAt: now(), metadata });
  if (state.auditLog.length > 500) state.auditLog.length = 500;
}

export async function saveOtpChallenge(input: { email: string; codeHash: string; expiresAt: string }): Promise<void> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || !/^[a-f0-9]{64}$/.test(input.codeHash) || Number.isNaN(Date.parse(input.expiresAt))) {
    throw new WorkspaceStoreError("邮箱验证码挑战格式无效。", 400);
  }
  await mutateWorkspace((state) => {
    const sentAt = now();
    state.otpChallenges = state.otpChallenges.filter((challenge) => challenge.email !== input.email && Date.parse(challenge.expiresAt) > Date.now());
    state.otpChallenges.unshift({ id: randomUUID(), email: input.email, codeHash: input.codeHash, purpose: "verify_email", expiresAt: input.expiresAt, attempts: 0, sentAt });
    if (state.otpChallenges.length > 20) state.otpChallenges.length = 20;
    appendAudit(state, "auth.otp_issued", "profile", { email: input.email });
  });
}

export async function consumeOtpChallenge(email: string, codeHash: string, matchedSchool?: string): Promise<WorkspaceState> {
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
    if (challenge.codeHash !== codeHash) {
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

type EditableWorkspaceProfile = Pick<WorkspaceState["profile"], "displayName" | "email" | "school" | "examGoal" | "timezone" | "studyDayStart">;
type WorkspaceProfilePatch = Partial<EditableWorkspaceProfile>;

interface PreparedProfileUpdate {
  profile: WorkspaceState["profile"];
  changed: boolean;
  verificationBoundaryChanged: boolean;
  scheduleChanged: boolean;
}

function prepareProfileUpdate(state: WorkspaceState, input: WorkspaceProfilePatch): PreparedProfileUpdate {
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : state.profile.displayName;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : state.profile.email;
  const school = typeof input.school === "string" ? input.school.trim() : state.profile.school;
  const examGoal = typeof input.examGoal === "string" ? input.examGoal.trim() : state.profile.examGoal;
  const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : state.profile.timezone;
  const studyDayStart = typeof input.studyDayStart === "string" && input.studyDayStart.trim() ? input.studyDayStart.trim() : state.profile.studyDayStart;
  if (displayName.length > 80 || email.length > 160 || school.length > 120 || examGoal.length > 240) {
    throw new WorkspaceStoreError("个人资料字段超出允许长度。", 400);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new WorkspaceStoreError("邮箱格式无效。", 400);
  }
  if (!isValidTimeZone(timezone)) throw new WorkspaceStoreError("时区无效，请使用 IANA 时区名，例如 Asia/Shanghai。", 400);
  if (!isValidClockTime(studyDayStart)) throw new WorkspaceStoreError("每日学习开始时间必须是 HH:MM。", 400);
  const verificationBoundaryChanged = email !== state.profile.email || school !== state.profile.school;
  const scheduleChanged = timezone !== state.profile.timezone || studyDayStart !== state.profile.studyDayStart;
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
    changed: displayName !== state.profile.displayName
      || email !== state.profile.email
      || school !== state.profile.school
      || examGoal !== state.profile.examGoal
      || timezone !== state.profile.timezone
      || studyDayStart !== state.profile.studyDayStart
      || profile.verified !== state.profile.verified,
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

export async function updateWorkspaceProfile(input: Partial<WorkspaceState["profile"]>): Promise<WorkspaceState> {
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
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceStoreError("可用时间格式无效。", 400);
    const item = value as { date?: unknown; minutes?: unknown };
    if (typeof item.date !== "string" || !isValidDateOnly(item.date) || typeof item.minutes !== "number" || !Number.isInteger(item.minutes) || item.minutes < 0 || item.minutes > 720) {
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

function availabilityMatches(left: WorkspaceState["availability"], right: WorkspaceState["availability"]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return Boolean(other && entry.date === other.date && entry.minutes === other.minutes);
  });
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
export async function updateWorkspacePatch(input: WorkspaceProfilePatch & { availability?: unknown }): Promise<WorkspaceState> {
  // Availability validation is state-independent. Run it before entering the
  // mutation so an invalid combined request cannot persist its profile half.
  const availabilityProvided = input.availability !== undefined;
  const availability = availabilityProvided ? normalizeAvailabilityInput(input.availability) : undefined;
  const profileProvided = [input.displayName, input.email, input.school, input.examGoal, input.timezone, input.studyDayStart]
    .some((value) => typeof value === "string");

  const state = await mutateWorkspaceConditionally((current) => {
    const profileUpdate = profileProvided ? prepareProfileUpdate(current, input) : undefined;
    const availabilityChanged = Boolean(availability && !availabilityMatches(current.availability, availability));
    if (profileUpdate?.changed) current.profile = profileUpdate.profile;
    if (availability && availabilityChanged) current.availability = availability;

    if (profileUpdate?.scheduleChanged || availabilityChanged) rebuildTasksInState(current);
    if (profileUpdate?.changed) appendProfileUpdateAudit(current, profileUpdate);
    if (availabilityChanged) appendAudit(current, "availability.updated", "workspace", { days: availability?.length ?? 0 });

    return {
      changed: Boolean(profileUpdate?.changed || availabilityChanged),
      // Return the live object so the conditional wrapper's updatedAt change
      // is visible before the outer clone is made.
      result: current,
    };
  });
  return clone(state);
}

export async function createCourse(input: CourseInput): Promise<{ course: Course; workspace: WorkspaceState }> {
  const candidate = input && typeof input === "object" ? input as Partial<CourseInput> : {};
  const name = normalizeInputText(candidate.name);
  const code = normalizeInputText(candidate.code).toUpperCase();
  const teacher = normalizeInputText(candidate.teacher);
  const term = normalizeInputText(candidate.term);
  const examDate = normalizeInputText(candidate.examDate);
  const priority = candidate.priority;
  if (!name || !code || !teacher || !term || !isValidDateOnly(examDate)) {
    throw new WorkspaceStoreError("请完整填写课程名称、课程代码、教师、学期和考试日期。", 400);
  }
  if (priority !== "高" && priority !== "中" && priority !== "低") throw new WorkspaceStoreError("课程优先级无效。", 400);

  return mutateWorkspace((state) => {
    if (state.courses.some((course) => course.code === code && course.term === term && course.teacher === teacher)) {
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

export async function updateCourse(id: string, patch: Partial<Pick<Course, "name" | "teacher" | "term" | "examDate" | "priority">>): Promise<WorkspaceState> {
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
      if (!["高", "中", "低"].includes(patch.priority)) throw new WorkspaceStoreError("课程优先级无效。", 400);
      course.priority = patch.priority;
    }
    if (state.courses.some((item) => item.id !== id && item.code === course.code && item.term === course.term && item.teacher === course.teacher)) {
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
  if (!before.courses.some((course) => course.id === id)) throw new WorkspaceStoreError("未找到课程。", 404);
  const workspace = await mutateWorkspace((state) => {
    const index = state.courses.findIndex((course) => course.id === id);
    if (index < 0) throw new WorkspaceStoreError("未找到课程。", 404);
    state.courses.splice(index, 1);
    state.materials = state.materials.filter((material) => material.courseId !== id);
    state.insights = state.insights.filter((item) => item.courseId !== id);
    state.questions = state.questions.filter((item) => item.courseId !== id);
    state.tasks = state.tasks.filter((task) => task.courseId !== id);
    state.assessmentAttempts = state.assessmentAttempts.filter((attempt) => attempt.courseId !== id);
    delete state.courseSyntheses[id];
    for (const material of owned) delete state.documentAnalyses[material.id];
    appendAudit(state, "course.deleted", id, { materials: owned.length });
    rebuildTasksInState(state);
    return clone(state);
  });
  await Promise.all(owned.map((material) => unlink(path.join(getUploadsDirectory(), path.basename(material.objectKey))).catch(() => undefined)));
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
  const startsWith = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (extension === "pdf") return startsWith(0x25, 0x50, 0x44, 0x46);
  if (extension === "jpg" || extension === "jpeg") return startsWith(0xff, 0xd8, 0xff);
  if (extension === "png") return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (extension === "webp") return startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (["doc", "ppt"].includes(extension)) return startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  if (["docx", "pptx"].includes(extension)) return startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06);
  return false;
}

export async function storeUploadedMaterial(courseId: string, file: File): Promise<{ material: StoredMaterial; workspace: WorkspaceState }> {
  if (!file.name || file.size <= 0) throw new WorkspaceStoreError("请选择一个非空资料文件。", 400);
  if (file.size > 50 * 1024 * 1024) throw new WorkspaceStoreError("单个资料文件不能超过 50 MB。", 413);
  if (!isSupportedFile(file.name)) {
    throw new WorkspaceStoreError("不支持该资料格式。仅可上传 PDF、PPT/PPTX、DOC/DOCX、JPG、PNG 或 WEBP。", 415);
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
          const bytes = Buffer.from(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength);
          byteSize += bytes.byteLength;
          if (byteSize > 50 * 1024 * 1024) throw new WorkspaceStoreError("单个资料文件不能超过 50 MB。", 413);
          hash.update(bytes);
          if (signatureBytes < signaturePrefix.byteLength) {
            const length = Math.min(bytes.byteLength, signaturePrefix.byteLength - signatureBytes);
            bytes.copy(signaturePrefix, signatureBytes, 0, length);
            signatureBytes += length;
          }
          let offset = 0;
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
            if (bytesWritten <= 0) throw new WorkspaceStoreError("资料写入不完整，请检查数据目录空间后重试。", 507);
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

    if (byteSize !== file.size) throw new WorkspaceStoreError("上传资料大小不完整，请重新选择文件。", 400);
    if (!hasExpectedFileSignature(extension, signaturePrefix.subarray(0, signatureBytes))) {
      throw new WorkspaceStoreError("文件内容与扩展名不匹配，已拒绝保存。请重新导出原始资料。", 415);
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
      createdAt: new Date(uploadedAt).toLocaleString("zh-CN", { hour12: false }),
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
      if (!state.courses.some((course) => course.id === courseId)) throw new WorkspaceStoreError("请先创建并选择一门课程。", 404);
      const duplicate = state.materials.find((item) => item.courseId === courseId && item.sha256 === sha256);
      if (duplicate) throw new WorkspaceStoreError(`这份资料已存在：${duplicate.name}。请直接在资料卡上重试分析。`, 409);
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

export async function readStoredMaterialFile(id: string): Promise<{ material: StoredMaterial; buffer: Buffer }> {
  const reference = await getStoredMaterialFileReference(id);
  return { material: reference.material, buffer: await readFile(reference.filePath) };
}

/** Server-only file reference used to stream a persisted document without buffering it. */
export async function getStoredMaterialFileReference(id: string): Promise<{ material: StoredMaterial; filePath: string; byteSize: number }> {
  const material = await getStoredMaterial(id);
  const safeKey = path.basename(material.objectKey);
  if (safeKey !== material.objectKey) throw new WorkspaceStoreError("资料存储键无效。", 500);
  const filePath = path.join(getUploadsDirectory(), safeKey);
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new WorkspaceStoreError("资料文件不存在，可能已被手动移除。", 410);
    return { material, filePath, byteSize: fileInfo.size };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new WorkspaceStoreError("资料文件不存在，可能已被手动移除。", 410);
    throw error;
  }
}

export async function setMaterialStatus(id: string, status: StoredMaterial["status"], source?: string, error?: string): Promise<WorkspaceState> {
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
export async function beginMaterialAnalysis(id: string): Promise<{ runId: string; workspace: WorkspaceState }> {
  return mutateWorkspace((state) => {
    const material = state.materials.find((item) => item.id === id);
    if (!material) throw new WorkspaceStoreError("未找到资料。", 404);
    if (material.status === "分析中") {
      // A process that died mid-analysis leaves the material stuck in
      // "分析中" forever, and the previous guard made it unretryable. Treat
      // a long-running reservation as stale so the user can recover.
      const reservedAt = Date.parse(material.analysisLease?.startedAt ?? material.updatedAt);
      const isStale = !Number.isFinite(reservedAt) || Date.now() - reservedAt >= STALE_ANALYSIS_RESERVATION_MS;
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

export async function failMaterialAnalysis(id: string, runId: string, source?: string, error?: string): Promise<WorkspaceState> {
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

export async function saveDocumentAnalysis(id: string, analysis: DocumentAnalysis, runId: string): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const material = state.materials.find((item) => item.id === id);
    if (!material) throw new WorkspaceStoreError("未找到资料。", 404);
    assertMaterialAnalysisLease(material, runId);
    state.documentAnalyses[id] = analysis;
    material.status = "已分析";
    material.pages = analysis.pageCount ?? 0;
    material.kind = analysis.materialKind === "未知" ? material.kind : analysis.materialKind;
    material.source = analysis.keyPoints[0]?.evidence.location ? `已识别 ${analysis.keyPoints.length} 个考点 · ${analysis.keyPoints[0].evidence.location}` : `已完成 AI 分析 · ${analysis.keyPoints.length} 个考点`;
    material.error = undefined;
    material.updatedAt = now();
    delete material.analysisLease;
    appendAudit(state, "material.analyzed", id, { keyPoints: analysis.keyPoints.length, questions: analysis.generatedQuestions.length });

    // A new or re-run document analysis makes any previous course-level
    // aggregate stale. Remove both its summary and derived cards/questions so
    // the next synthesis is grounded only in the current source set.
    invalidateCourseSynthesis(state, material.courseId);

    state.insights = state.insights.filter((item) => !item.id.startsWith(`material-${id}-`));
    state.questions = state.questions.filter((item) => !item.id.startsWith(`material-${id}-`));
    state.insights.push(...analysis.keyPoints.map((point, index): Insight => ({
      id: `material-${id}-point-${index}`,
      courseId: material.courseId,
      title: point.title,
      frequency: Math.max(1, Math.min(5, point.importance)),
      mastery: getCourseMastery(state, material.courseId),
      trend: point.importance >= 4 ? "高频" : "需巩固",
      sources: [formatEvidence(point.evidence)],
      summary: point.evidence.quote || "已从上传资料中识别，请结合来源位置复核。",
    })));
    state.questions.push(...analysis.generatedQuestions.map((question, index): Question => ({
      id: `material-${id}-question-${index}`,
      courseId: material.courseId,
      type: question.type,
      prompt: question.prompt,
      choices: question.choices.length ? question.choices : undefined,
      answer: question.answer,
      explanation: question.explanation,
      source: question.sourceLocation || material.name,
      knowledge: question.knowledge,
    })));
    refreshCourseWeights(state, material.courseId);
    rebuildTasksInState(state);
    return clone(state);
  });
}

export async function saveCourseSynthesis(
  courseId: string,
  synthesis: CourseSynthesis,
  sourceSnapshot: CourseSynthesisSourceSnapshot,
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const course = state.courses.find((item) => item.id === courseId);
    if (!course) throw new WorkspaceStoreError("未找到课程。", 404);
    if (!courseSynthesisSnapshotMatches(state, courseId, sourceSnapshot)) {
      throw new WorkspaceStoreError("资料在课程综合期间发生变化，请重新生成。", 409);
    }
    state.courseSyntheses[courseId] = synthesis;
    state.insights = state.insights.filter((item) => !item.id.startsWith(`synthesis-${courseId}-`));
    state.questions = state.questions.filter((item) => !item.id.startsWith(`synthesis-${courseId}-`));
    state.insights.push(...synthesis.highFrequencyPoints.map((point, index): Insight => ({
      id: `synthesis-${courseId}-point-${index}`,
      courseId,
      title: point.title,
      frequency: point.frequency,
      mastery: point.mastery,
      trend: point.trend,
      sources: point.sources,
      summary: point.summary,
    })));
    state.questions.push(...synthesis.generatedQuestions.map((question, index): Question => ({
      id: `synthesis-${courseId}-question-${index}`,
      courseId,
      type: question.type,
      prompt: question.prompt,
      choices: question.choices.length ? question.choices : undefined,
      answer: question.answer,
      explanation: question.explanation,
      source: question.sourceLocation || "课程综合",
      knowledge: question.knowledge,
    })));
    refreshCourseWeights(state, courseId);
    rebuildTasksInState(state);
    return clone(state);
  });
}

function courseSynthesisSourceEntries(state: WorkspaceState, courseId: string): Array<{ materialId: string; updatedAt: string; analysisHash: string }> {
  return state.materials
    .filter((material) => material.courseId === courseId && Boolean(state.documentAnalyses[material.id]))
    .map((material) => ({
      materialId: material.id,
      updatedAt: material.updatedAt,
      analysisHash: createHash("sha256").update(JSON.stringify(state.documentAnalyses[material.id])).digest("hex"),
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
    return expected
      && entry.materialId === expected.materialId
      && entry.updatedAt === expected.updatedAt
      && entry.analysisHash === expected.analysisHash;
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
  await unlink(path.join(getUploadsDirectory(), path.basename(material.objectKey))).catch(() => undefined);
  return workspace;
}

function createPlanGenerationContext(state: WorkspaceState): PlanGenerationContext {
  const insightsByCourse = new Map<string, AiPlanCourse["insights"]>();
  for (const insight of state.insights) {
    const list = insightsByCourse.get(insight.courseId) ?? [];
    if (list.length < 8) {
      list.push({
        title: insight.title.slice(0, 200),
        frequency: insight.frequency,
        trend: insight.trend,
      });
    }
    insightsByCourse.set(insight.courseId, list);
  }

  return {
    aiCourses: state.courses.map((course) => ({
      name: course.name,
      code: course.code,
      examDate: course.examDate,
      priority: course.priority,
      mastery: course.mastery,
      insights: insightsByCourse.get(course.id) ?? [],
    })),
    courses: clone(state.courses),
    availability: clone(state.availability),
    studyDayStart: isValidClockTime(state.profile.studyDayStart) ? state.profile.studyDayStart : DEFAULT_STUDY_DAY_START,
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
  return createHash("sha256").update(JSON.stringify({
    aiCourses: context.aiCourses,
    materializationCourses,
    availability: context.availability,
    studyDayStart: context.studyDayStart,
  })).digest("hex");
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
): Promise<WorkspaceState> {
  return mutateWorkspace((state) => {
    const activeLease = state.planGenerationLease;
    if (!activeLease || activeLease.runId !== reservation.runId || activeLease.inputHash !== reservation.inputHash) {
      throw new WorkspaceStoreError("已有更新的计划生成请求，本次旧结果未保存。", 409);
    }
    const currentInputHash = planGenerationInputHash(createPlanGenerationContext(state));
    if (currentInputHash !== reservation.inputHash) {
      throw new WorkspaceStoreError("计划生成期间学习数据发生变化，请重新生成。", 409);
    }
    collectMissedTasksInState(state);
    const completedTaskIdentities = new Set(
      state.tasks
        .filter((task) => task.status === "已完成")
        .map(taskCompletionIdentity),
    );
    state.tasks = tasks.map((task) => ({
      ...task,
      status: completedTaskIdentities.has(taskCompletionIdentity(task)) ? "已完成" : "待完成",
    }));
    state.planSource = "ai";
    delete state.planGenerationLease;
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

export async function recordPractice(courseId: string, answers: Record<string, string>, selfRating?: number): Promise<{ workspace: WorkspaceState; correct: number; total: number; score: number }> {
  return mutateWorkspace((state) => {
    const course = state.courses.find((item) => item.id === courseId);
    if (!course) throw new WorkspaceStoreError("未找到课程。", 404);
    const questions = state.questions.filter((question) => question.courseId === courseId && answers[question.id] !== undefined);
    if (!questions.length) throw new WorkspaceStoreError("请至少提交一道本课程练习题。", 400);
    const correct = questions.filter((question) => answerMatches(question, answers[question.id] ?? "")).length;
    const score = Math.round((correct / questions.length) * 100);
    const selfFactor = typeof selfRating === "number" && selfRating >= 1 && selfRating <= 5 ? (selfRating - 3) * 2 : 0;
    course.mastery = clamp(Math.round(course.mastery * 0.72 + score * 0.28 + selfFactor), 0, 100);
    state.insights = state.insights.map((insight) => insight.courseId === courseId ? { ...insight, mastery: course.mastery, trend: course.mastery >= 80 ? "已掌握" : insight.frequency >= 4 ? "高频" : "需巩固" } : insight);
    const attempt: AssessmentAttempt = {
      id: randomUUID(),
      courseId,
      questionIds: questions.map((question) => question.id),
      answers: Object.fromEntries(questions.map((question) => [question.id, String(answers[question.id] ?? "").slice(0, 5_000)])),
      correct,
      total: questions.length,
      score,
      ...(typeof selfRating === "number" ? { selfRating } : {}),
      createdAt: now(),
    };
    state.assessmentAttempts.unshift(attempt);
    if (state.assessmentAttempts.length > 200) state.assessmentAttempts.length = 200;
    appendAudit(state, "assessment.submitted", courseId, { correct, total: questions.length, score });
    rebuildTasksInState(state);
    return { workspace: clone(state), correct, total: questions.length, score };
  });
}

function answerMatches(question: Question, actual: string): boolean {
  const normalizedExpected = normalizeAnswer(question.answer);
  const normalizedActual = normalizeAnswer(actual);
  if (!normalizedActual) return false;
  if (question.type === "单选") {
    const expectedChoice = choiceToken(normalizedExpected) ?? choiceIndex(question.choices, normalizedExpected);
    const actualChoice = choiceToken(normalizedActual) ?? choiceIndex(question.choices, normalizedActual);
    if (expectedChoice && actualChoice) return expectedChoice === actualChoice;
    return normalizedActual === normalizedExpected;
  }
  // Keyword answers may reasonably contain the canonical answer in a longer
  // explanation, but only when the canonical answer is meaningful.
  return normalizedActual === normalizedExpected || (normalizedExpected.length >= 2 && normalizedActual.includes(normalizedExpected));
}

function normalizeAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\u3000]+/g, "");
}

function choiceToken(value: string): string | undefined {
  const match = /^([a-z]|[一二三四五六七八九十])(?:[.、:：)）]|$)/i.exec(value);
  if (!match?.[1]) return undefined;
  const chinese: Record<string, string> = { 一: "A", 二: "B", 三: "C", 四: "D", 五: "E", 六: "F", 七: "G", 八: "H", 九: "I", 十: "J" };
  return chinese[match[1]] ?? match[1].toUpperCase();
}

function choiceIndex(choices: string[] | undefined, value: string): string | undefined {
  if (!choices?.length) return undefined;
  const index = choices.findIndex((choice) => normalizeAnswer(choice) === value);
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

function getCourseMastery(state: WorkspaceState, courseId: string): number {
  return state.courses.find((course) => course.id === courseId)?.mastery ?? 0;
}

function refreshCourseWeights(state: WorkspaceState, courseId: string): void {
  const course = state.courses.find((item) => item.id === courseId);
  if (!course) return;
  const insights = state.insights.filter((item) => item.courseId === courseId);
  if (!insights.length) {
    course.highFrequencyWeight = 0.5;
    return;
  }
  course.highFrequencyWeight = clamp(insights.reduce((sum, item) => sum + Math.min(5, item.frequency), 0) / (insights.length * 5), 0.2, 1);
}

function workspaceToday(state: WorkspaceState): string {
  return dateOnlyInTimeZone(state.profile.timezone || "Asia/Shanghai");
}

function studyDayStartMinutes(state: WorkspaceState): number {
  const value = state.profile.studyDayStart ?? DEFAULT_STUDY_DAY_START;
  return isValidClockTime(value) ? clockTimeToMinutes(value) : clockTimeToMinutes(DEFAULT_STUDY_DAY_START);
}

function rebuildTasksInState(state: WorkspaceState): void {
  if (!state.courses.length) {
    state.tasks = [];
    state.planSource = "schedule";
    return;
  }
  collectMissedTasksInState(state);
  rollAvailabilityForward(state);
  // Any automatic re-arrangement (analysis, practice, availability change) is
  // the deterministic scheduler, never an AI call; record that honestly so the
  // UI never presents this plan as model output.
  state.planSource = "schedule";
  // A task id is a scheduling position, not a durable description of work.
  // Keep a completion only when the regenerated task still describes the
  // same course/date/time/focus; otherwise a changed plan must be actionable.
  const completedTaskIdentities = new Set(
    state.tasks
      .filter((task) => task.status === "已完成")
      .map(taskCompletionIdentity),
  );
  state.tasks = buildAdaptivePlan({
    courses: state.courses,
    availability: state.availability,
    insights: state.insights,
    recentMisses: recentMissedTopics(state),
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
    for (const questionId of attempt.questionIds) {
      const question = state.questions.find((item) => item.id === questionId);
      if (!question || answerMatches(question, attempt.answers[questionId] ?? "")) continue;
      const topic = question.knowledge.trim().slice(0, 80) || question.prompt.trim().slice(0, 80);
      if (!topic) continue;
      const key = `${attempt.courseId}\u0001${topic}`;
      const existing = latestByTopic.get(key);
      if (!existing || missedOn > existing.missedOn) latestByTopic.set(key, { courseId: attempt.courseId, topic, missedOn });
    }
  }
  return [...latestByTopic.values()].sort((left, right) => left.missedOn.localeCompare(right.missedOn)).slice(0, 12);
}

function collectMissedTasksInState(state: WorkspaceState): void {
  const today = workspaceToday(state);
  const missed = state.tasks.filter((task) => task.date < today && task.status !== "已完成");
  if (!missed.length) return;
  const existing = new Set(state.missedTasks.map(taskCompletionIdentity));
  const fresh = missed.map((task) => ({ ...task, status: "已错过" as const }));
  state.missedTasks = [...fresh.filter((task) => !existing.has(taskCompletionIdentity(task))), ...state.missedTasks].slice(0, MISSED_TASKS_LIMIT);
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
  return [task.courseId, task.date, task.start, task.duration, task.type, task.title].join("\u0001");
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

export class CommunityStoreError extends WorkspaceStoreError {
  constructor(message: string, status = 400, readonly code = "COMMUNITY_ERROR") {
    super(message, status);
    this.name = "CommunityStoreError";
  }
}

function isSharedMaterialExpired(record: Pick<StoredSharedMaterial, "accessEndsOn">, today: string): boolean {
  // Invalid persisted expiry metadata is fail-closed. A shared file must not
  // remain downloadable indefinitely because an old state file was malformed.
  return !isValidDateOnly(record.accessEndsOn) || record.accessEndsOn < today;
}

function publicSharedMaterial(record: StoredSharedMaterial, state: WorkspaceState): PublicSharedMaterial {
  const owned = record.contributorId === state.profile.id;
  const inSchoolScope = profileCanUseCommunity(state)
    && record.school === state.profile.school
    && courseCodesForProfile(state).includes(record.courseCode);
  const hasGrant = state.unlockGrants.some((grant) => grant.sharedMaterialId === record.id && !grant.revokedAt);
  const canDownload = !isSharedMaterialExpired(record, workspaceToday(state))
    && ACTIVE_SHARED_STATUSES.has(record.status)
    && (owned || (inSchoolScope && hasGrant));
  const { objectKey: _objectKey, sha256: _sha256, contributorId: _contributorId, consentedAt: _consentedAt, accessEndsOn: _accessEndsOn, createdAt: _createdAt, updatedAt: _updatedAt, ...publicRecord } = clone(record);
  return { ...publicRecord, isMine: owned, canDownload, ...(record.moderationReason ? { moderationReason: record.moderationReason } : {}) };
}

function profileCanUseCommunity(state: WorkspaceState): boolean {
  return Boolean(state.profile.email && state.profile.school && state.profile.verified);
}

function courseCodesForProfile(state: WorkspaceState): string[] {
  return state.courses.map((course) => course.code);
}

async function archiveExpiredSharedMaterialsWithWorkspace(): Promise<{ workspace: WorkspaceState; objectKeys: string[] }> {
  const result = await mutateWorkspaceConditionally((state) => {
    const today = workspaceToday(state);
    const expired = state.sharedMaterialRecords.filter((record) => !["待审核", ...ACTIVE_SHARED_STATUSES].includes(record.status) ? false : isSharedMaterialExpired(record, today));
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
  await Promise.all(result.objectKeys.map((objectKey) => {
    const safeKey = path.basename(objectKey);
    return safeKey === objectKey ? unlink(path.join(getSharedDirectory(), safeKey)).catch(() => undefined) : Promise.resolve();
  }));
  return { workspace: clone(result.state), objectKeys: result.objectKeys };
}

export async function archiveExpiredSharedMaterials(): Promise<number> {
  return (await archiveExpiredSharedMaterialsWithWorkspace()).objectKeys.length;
}

export async function listCommunityMaterials(): Promise<{ materials: PublicSharedMaterial[]; credits: number; ledger: CreditTransaction[] }> {
  const { workspace: state } = await archiveExpiredSharedMaterialsWithWorkspace();
  const canBrowse = profileCanUseCommunity(state);
  const courseCodes = new Set(courseCodesForProfile(state));
  const records = state.sharedMaterialRecords
    .filter((record) => record.contributorId === state.profile.id || (canBrowse && record.school === state.profile.school && courseCodes.has(record.courseCode) && ACTIVE_SHARED_STATUSES.has(record.status)))
    .map((record) => publicSharedMaterial(record, state));
  return { materials: records, credits: state.profile.credits, ledger: clone(state.ledger).slice(0, 50) };
}

export async function contributeSharedMaterial(input: { materialId: string; consent: boolean; privacyConfirmed: boolean }): Promise<{ material: PublicSharedMaterial; workspace: WorkspaceState }> {
  if (!input.consent || !input.privacyConfirmed) throw new CommunityStoreError("共享资料前必须确认拥有分享权限，并确认已移除个人敏感信息。", 400, "CONSENT_REQUIRED");
  await archiveExpiredSharedMaterials();
  const current = await getWorkspace();
  if (!profileCanUseCommunity(current)) throw new CommunityStoreError("请先完成已验证邮箱和学校配置，才能提交校内资料。", 403, "SCHOOL_VERIFICATION_REQUIRED");
  const privateMaterial = current.materials.find((item) => item.id === input.materialId);
  if (!privateMaterial) throw new CommunityStoreError("未找到要共享的私有资料。", 404, "MATERIAL_NOT_FOUND");
  if (privateMaterial.status !== "已分析" || !current.documentAnalyses[input.materialId]) throw new CommunityStoreError("只有完成 AI 分析的资料才能提交审核。", 422, "MATERIAL_NOT_ANALYZED");
  if (current.sharedMaterialRecords.some((record) => record.sha256 === privateMaterial.sha256 && ["待审核", "可解锁", "已解锁"].includes(record.status))) throw new CommunityStoreError("这份资料已经提交过，不能重复共享。", 409, "DUPLICATE_SHARE");
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
      if (!liveMaterial || liveMaterial.sha256 !== privateMaterial.sha256 || liveMaterial.status !== "已分析" || !state.documentAnalyses[input.materialId]) {
        throw new CommunityStoreError("资料在提交期间发生变化，请刷新后重试。", 409, "MATERIAL_CHANGED");
      }
      if (state.sharedMaterialRecords.some((item) => item.sha256 === liveMaterial.sha256 && (item.status === "待审核" || ACTIVE_SHARED_STATUSES.has(item.status)))) {
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

export async function moderateSharedMaterial(input: { materialId: string; decision: "approve" | "reject"; quality?: "优质" | "已核验" | "待核验"; reason?: string }): Promise<{ material: PublicSharedMaterial; workspace: WorkspaceState }> {
  if (input.decision !== "approve" && input.decision !== "reject") throw new CommunityStoreError("审核决定无效。", 400, "INVALID_DECISION");
  if (input.quality !== undefined && !["优质", "已核验", "待核验"].includes(input.quality)) throw new CommunityStoreError("资料质量标记无效。", 400, "INVALID_QUALITY");
  await archiveExpiredSharedMaterials();
  const workspace = await mutateWorkspace((state) => {
    const record = state.sharedMaterialRecords.find((item) => item.id === input.materialId);
    if (!record) throw new CommunityStoreError("未找到共享资料。", 404, "SHARE_NOT_FOUND");
    if (!["待审核", "可解锁"].includes(record.status)) throw new CommunityStoreError("该资料已完成审核，不能重复处理。", 409, "SHARE_ALREADY_MODERATED");
    record.updatedAt = now();
    record.moderationReason = input.reason?.trim().slice(0, 500);
    if (input.decision === "approve") {
      record.status = "可解锁";
      record.quality = input.quality ?? "已核验";
      const idempotencyKey = `contribution:${record.id}`;
      if (!state.ledger.some((item) => item.id === idempotencyKey)) {
        const transaction: CreditTransaction = { id: idempotencyKey, label: `贡献《${record.title}》通过审核`, amount: record.credits, createdAt: now(), kind: "earn" };
        state.ledger.unshift(transaction);
        state.profile.credits += record.credits;
      }
      appendAudit(state, "community.contribution_approved", record.id, { credits: record.credits });
    } else {
      record.status = "已拒绝";
      appendAudit(state, "community.contribution_rejected", record.id, { reason: record.moderationReason ?? "" });
    }
    state.sharedMaterials = state.sharedMaterials.map((item) => item.id === record.id ? publicSharedMaterial(record, state) : item);
    return clone(state);
  });
  const record = workspace.sharedMaterialRecords.find((item) => item.id === input.materialId);
  if (!record) throw new CommunityStoreError("共享资料状态读取失败。", 500);
  return { material: publicSharedMaterial(record, workspace), workspace };
}

export async function unlockSharedMaterial(materialId: string): Promise<{ material: PublicSharedMaterial; workspace: WorkspaceState }> {
  await archiveExpiredSharedMaterials();
  const workspace = await mutateWorkspace((state) => {
    if (!profileCanUseCommunity(state)) throw new CommunityStoreError("请先完成邮箱和学校验证。", 403, "SCHOOL_VERIFICATION_REQUIRED");
    const record = state.sharedMaterialRecords.find((item) => item.id === materialId);
    if (!record) throw new CommunityStoreError("未找到共享资料。", 404, "SHARE_NOT_FOUND");
    if (record.contributorId === state.profile.id) return clone(state);
    if (!ACTIVE_SHARED_STATUSES.has(record.status) || isSharedMaterialExpired(record, workspaceToday(state))) throw new CommunityStoreError("该资料尚未通过审核或已归档。", 409, "SHARE_NOT_AVAILABLE");
    if (record.school !== state.profile.school || !courseCodesForProfile(state).includes(record.courseCode)) throw new CommunityStoreError("仅同校且匹配课程的用户可解锁。", 403, "SCHOOL_SCOPE_MISMATCH");
    if (state.unlockGrants.some((grant) => grant.sharedMaterialId === materialId && !grant.revokedAt)) return clone(state);
    if (state.profile.credits < record.credits) throw new CommunityStoreError("积分不足。", 402, "INSUFFICIENT_CREDITS");
    const transactionId = `unlock:${state.profile.id}:${record.id}`;
    if (state.ledger.some((item) => item.id === transactionId)) return clone(state);
    state.profile.credits -= record.credits;
    state.ledger.unshift({ id: transactionId, label: `解锁《${record.title}》`, amount: -record.credits, createdAt: now(), kind: "spend" });
    state.unlockGrants.unshift({ id: randomUUID(), sharedMaterialId: record.id, grantedAt: now() });
    record.unlocks += 1;
    appendAudit(state, "community.material_unlocked", record.id, { credits: record.credits });
    return clone(state);
  });
  const record = workspace.sharedMaterialRecords.find((item) => item.id === materialId);
  if (!record) throw new CommunityStoreError("共享资料状态读取失败。", 500);
  return { material: publicSharedMaterial(record, workspace), workspace };
}

export async function reportSharedMaterial(input: { materialId: string; reason: string; detail?: string }): Promise<WorkspaceState> {
  const reason = input.reason.trim().slice(0, 100);
  const detail = (input.detail ?? "").trim().slice(0, 1_000);
  if (!reason) throw new CommunityStoreError("举报原因不能为空。", 400, "REPORT_REASON_REQUIRED");
  await archiveExpiredSharedMaterials();
  return mutateWorkspace((state) => {
    if (!profileCanUseCommunity(state)) throw new CommunityStoreError("请先完成邮箱和学校验证后再举报共享资料。", 403, "SCHOOL_VERIFICATION_REQUIRED");
    const record = state.sharedMaterialRecords.find((item) => item.id === input.materialId);
    if (!record) throw new CommunityStoreError("未找到共享资料。", 404, "SHARE_NOT_FOUND");
    if (state.sharedReports.some((report) => report.sharedMaterialId === input.materialId && !report.resolvedAt)) throw new CommunityStoreError("你已经举报过这份资料。", 409, "REPORT_DUPLICATE");
    state.sharedReports.unshift({ id: randomUUID(), sharedMaterialId: input.materialId, reason, detail, createdAt: now() });
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
      materialTitle: state.sharedMaterialRecords.find((record) => record.id === report.sharedMaterialId)?.title ?? "（资料已删除）",
      reason: report.reason,
      detail: report.detail,
      createdAt: report.createdAt,
    }));
  const active = state.sharedMaterialRecords.filter((record) => ACTIVE_SHARED_STATUSES.has(record.status) && !isSharedMaterialExpired(record, workspaceToday(state)));
  return { pending, reports, activeCount: active.length };
}

export async function resolveSharedReport(reportId: string, resolution: string): Promise<WorkspaceState> {
  const note = resolution.trim().slice(0, 500);
  if (!note) throw new CommunityStoreError("处理说明不能为空。", 400, "REPORT_RESOLUTION_REQUIRED");
  return mutateWorkspace((state) => {
    const report = state.sharedReports.find((item) => item.id === reportId);
    if (!report) throw new CommunityStoreError("未找到该举报记录。", 404, "REPORT_NOT_FOUND");
    if (report.resolvedAt) throw new CommunityStoreError("该举报已处理，不能重复处理。", 409, "REPORT_ALREADY_RESOLVED");
    report.resolvedAt = now();
    report.resolution = note;
    appendAudit(state, "community.report_resolved", reportId, { sharedMaterialId: report.sharedMaterialId });
    return clone(state);
  });
}

/** Full raw workspace snapshot for the owner's own backup. Server-only. */
export async function exportWorkspaceData(): Promise<WorkspaceState> {
  return getWorkspace();
}

export async function readSharedMaterialFile(materialId: string): Promise<{ material: PublicSharedMaterial; buffer: Buffer }> {
  await archiveExpiredSharedMaterials();
  const state = await getWorkspace();
  const record = state.sharedMaterialRecords.find((item) => item.id === materialId);
  if (!record) throw new CommunityStoreError("未找到共享资料。", 404, "SHARE_NOT_FOUND");
  const publicRecord = publicSharedMaterial(record, state);
  if (!publicRecord.canDownload) throw new CommunityStoreError("请先解锁这份资料。", 403, "SHARE_LOCKED");
  const safeKey = path.basename(record.objectKey);
  if (safeKey !== record.objectKey) throw new CommunityStoreError("共享资料存储键无效。", 500, "SHARE_STORAGE_INVALID");
  try {
    return { material: publicRecord, buffer: await readFile(path.join(getSharedDirectory(), safeKey)) };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new CommunityStoreError("共享资料文件不存在。", 410, "SHARE_FILE_MISSING");
    throw error;
  }
}

/** Test-only utility; it intentionally acts only inside the configured data dir. */
export async function resetWorkspaceForTests(): Promise<void> {
  await mutateWorkspace((state) => {
    const fresh = emptyWorkspace();
    Object.assign(state, fresh);
  });
}


