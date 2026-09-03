import type { DocumentAnalysis } from "@/lib/ai-types";
import type { Course } from "@/lib/types";

export type View = "总览" | "学习计划" | "资料分析" | "练习测验" | "校内互助";

export type AnalysisAttempt = {
  persisted: boolean;
  analyzed: boolean;
  materialId?: string;
};

export type ProfileDraft = {
  displayName: string;
  email: string;
  school: string;
  examGoal: string;
  timezone: string;
  studyDayStart: string;
};

export type CourseDraft = {
  name: string;
  code: string;
  teacher: string;
  term: string;
  examDate: string;
  priority: Course["priority"];
};

export type CourseAiRecord = {
  status: "analyzing" | "synthesizing" | "ready" | "error";
  documentCount: number;
  summary: string;
  provider: string;
  model: string;
  warnings: string[];
  studyActions: string[];
  questionPatterns: DocumentAnalysis["questionPatterns"];
  synthesized: boolean;
};
