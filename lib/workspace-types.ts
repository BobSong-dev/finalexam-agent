import type {
  AiTokenUsage,
  CourseSynthesis,
  DocumentAnalysis,
  ProcessingFailure,
  ProcessingJob,
} from "./ai-types";
import type {
  Availability,
  Course,
  CreditTransaction,
  Insight,
  KnowledgeMasteryRecord,
  Material,
  PracticeGrade,
  Question,
  SharedMaterial,
  StudyTask,
} from "./types";

/**
 * JSON-persisted workspace used by the self-hosted runtime. Object keys are
 * private server metadata and are never sent to the browser.
 */
export interface StoredMaterial extends Material {
  objectKey: string;
  sha256: string;
  uploadedAt: string;
  updatedAt: string;
  /** Active analysis ownership token. Server-only; never expose to clients. */
  analysisLease?: MaterialAnalysisLease;
}

export interface MaterialAnalysisLease {
  runId: string;
  startedAt: string;
}

export interface WorkspaceProfile {
  id: string;
  displayName: string;
  email: string;
  school: string;
  verified: boolean;
  credits: number;
  examGoal: string;
  timezone: string;
  /** First study slot of the day, "HH:MM" in the profile timezone. */
  studyDayStart: string;
  aiUsage?: AiTokenUsage;
}

export interface AssessmentAttemptItem {
  questionId: string;
  /** 知识点键与标题快照：题目被重新生成后仍可追溯错题。 */
  knowledgeKey: string;
  knowledge: string;
  prompt: string;
  answer: string;
  grade: PracticeGrade;
}

export interface AssessmentAttempt {
  id: string;
  courseId: string;
  sessionId?: string;
  questionIds: string[];
  answers: Record<string, string>;
  /** 逐题快照（v2 起）；旧记录迁移时由当时的题目补齐。 */
  items: AssessmentAttemptItem[];
  correct: number;
  total: number;
  /** 参与计分的题数（不含 pending 的简答）。 */
  graded: number;
  score: number;
  selfRating?: number;
  createdAt: string;
}

/** 服务端抽好的练习题集；提交时只对会话内题目判分。 */
export interface PracticeSession {
  id: string;
  courseId: string;
  questionIds: string[];
  knowledgeKey?: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  resource: string;
  createdAt: string;
  metadata?: Record<string, string | number | boolean>;
}

/** Server-only fields for a material submitted to the local community catalog. */
export interface StoredSharedMaterial extends SharedMaterial {
  objectKey: string;
  byteSize?: number;
  sha256: string;
  contributorId: string;
  createdAt: string;
  updatedAt: string;
  consentedAt: string;
  accessEndsOn: string;
  moderationReason?: string;
}

export interface SharedReport {
  id: string;
  sharedMaterialId: string;
  reason: string;
  detail: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface UnlockGrant {
  id: string;
  sharedMaterialId: string;
  grantedAt: string;
  revokedAt?: string;
}

export interface OtpChallenge {
  id: string;
  email: string;
  codeHash: string;
  purpose: "verify_email";
  expiresAt: string;
  attempts: number;
  sentAt: string;
  consumedAt?: string;
}

export interface PlanGenerationLease {
  runId: string;
  inputHash: string;
  startedAt: string;
}

export const WORKSPACE_SCHEMA_VERSION = 2;

export interface WorkspaceState {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  updatedAt: string;
  /** Where the currently persisted plan came from; surfaced honestly in the UI. */
  planSource?: "ai" | "schedule";
  /** Active AI-plan ownership token. Server-only; never expose to clients. */
  planGenerationLease?: PlanGenerationLease;
  profile: WorkspaceProfile;
  courses: Course[];
  availability: Availability[];
  materials: StoredMaterial[];
  insights: Insight[];
  questions: Question[];
  tasks: StudyTask[];
  sharedMaterials: SharedMaterial[];
  ledger: CreditTransaction[];
  documentAnalyses: Record<string, DocumentAnalysis>;
  courseSyntheses: Record<string, CourseSynthesis>;
  assessmentAttempts: AssessmentAttempt[];
  /** courseId → knowledgeKey → 练习掌握度。独立于 AI 生成的考点卡片。 */
  knowledgeMastery: Record<string, Record<string, KnowledgeMasteryRecord>>;
  practiceSessions: PracticeSession[];
  auditLog: AuditEvent[];
  sharedMaterialRecords: StoredSharedMaterial[];
  sharedReports: SharedReport[];
  unlockGrants: UnlockGrant[];
  otpChallenges: OtpChallenge[];
  /** Uncompleted tasks from days before the current plan window. */
  missedTasks: StudyTask[];
  processingJobs?: ProcessingJob[];
  /** 后台任务失败记录（重启后仍可见）。 */
  processingErrors?: ProcessingFailure[];
  /** 用户手动忽略的考点 id；只影响展示与排期，不删除原始分析。 */
  hiddenInsights?: string[];
  /** 用户修正过的题目答案（questionId → 覆盖值）。 */
  answerOverrides?: Record<string, { answer: string; updatedAt: string }>;
}

export type PublicMaterial = Omit<
  StoredMaterial,
  "objectKey" | "sha256" | "uploadedAt" | "updatedAt" | "analysisLease"
>;
/** 提交前不下发标准答案与解析，避免练习页被直接读穿。 */
export type PublicQuestion = Omit<Question, "answer" | "explanation">;
export type PracticeReveal = {
  questionId: string;
  correct: boolean;
  grade: PracticeGrade;
  answer: string;
  explanation: string;
};
export type PublicWorkspaceState = Omit<
  WorkspaceState,
  | "materials"
  | "questions"
  | "documentAnalyses"
  | "courseSyntheses"
  | "sharedMaterialRecords"
  | "sharedReports"
  | "unlockGrants"
  | "auditLog"
  | "otpChallenges"
  | "planGenerationLease"
  | "practiceSessions"
> & {
  materials: PublicMaterial[];
  questions: PublicQuestion[];
  documentAnalyses: WorkspaceState["documentAnalyses"];
  courseSyntheses: WorkspaceState["courseSyntheses"];
};

export type PublicSharedMaterial = SharedMaterial & {
  canDownload?: boolean;
  isMine?: boolean;
  moderationReason?: string;
};

/** Operator-facing moderation queue entry (admin token protected). */
export interface ModerationQueueReport {
  id: string;
  sharedMaterialId: string;
  materialTitle: string;
  reason: string;
  detail: string;
  createdAt: string;
}

export interface ModerationQueue {
  pending: PublicSharedMaterial[];
  reports: ModerationQueueReport[];
  activeCount: number;
}

export interface CourseInput {
  name: string;
  code: string;
  teacher: string;
  term: string;
  examDate: string;
  priority: Course["priority"];
}
