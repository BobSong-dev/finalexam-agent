import type { CourseSynthesis, DocumentAnalysis } from "./ai-types";
import type { Availability, Course, CreditTransaction, Insight, Material, Question, SharedMaterial, StudyTask } from "./types";

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
}

export interface AssessmentAttempt {
  id: string;
  courseId: string;
  questionIds: string[];
  answers: Record<string, string>;
  correct: number;
  total: number;
  score: number;
  selfRating?: number;
  createdAt: string;
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

export interface WorkspaceState {
  version: 1;
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
  auditLog: AuditEvent[];
  sharedMaterialRecords: StoredSharedMaterial[];
  sharedReports: SharedReport[];
  unlockGrants: UnlockGrant[];
  otpChallenges: OtpChallenge[];
  /** Uncompleted tasks from days before the current plan window. */
  missedTasks: StudyTask[];
}

export type PublicMaterial = Omit<StoredMaterial, "objectKey" | "sha256" | "uploadedAt" | "updatedAt" | "analysisLease">;
export type PublicWorkspaceState = Omit<WorkspaceState, "materials" | "sharedMaterialRecords" | "sharedReports" | "unlockGrants" | "auditLog" | "otpChallenges" | "planGenerationLease"> & {
  materials: PublicMaterial[];
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
