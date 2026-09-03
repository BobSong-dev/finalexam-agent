/**
 * Sensible, currently documented OpenAI defaults.  A compatible provider can
 * use a different model identifier, so `AiModel` remains a validated string
 * instead of a closed union.
 */
export const AI_MODELS = ["gpt-5", "gpt-5-mini", "gpt-4.1-mini"] as const;

export type AiModel = string;
export type AiMaterialKind = "试卷" | "课件" | "讲义" | "题库" | "未知";
export type AiConfidence = "high" | "medium" | "low";
export type AiQuestionType = "单选" | "填空" | "简答";

export interface EvidenceReference {
  label: string;
  location: string;
  quote: string;
}

export interface DocumentKeyPoint {
  id: string;
  title: string;
  importance: number;
  evidence: EvidenceReference;
}

export interface DocumentQuestionPattern {
  title: string;
  type: string;
  description: string;
  evidence: EvidenceReference;
}

export interface GeneratedPracticeQuestion {
  id: string;
  type: AiQuestionType;
  prompt: string;
  choices: string[];
  answer: string;
  explanation: string;
  knowledge: string;
  sourceLocation: string;
}

export interface DocumentAnalysis {
  documentTitle: string;
  materialKind: AiMaterialKind;
  pageCount: number | null;
  summary: string;
  confidence: AiConfidence;
  keyPoints: DocumentKeyPoint[];
  questionPatterns: DocumentQuestionPattern[];
  studyActions: string[];
  generatedQuestions: GeneratedPracticeQuestion[];
  warnings: string[];
}

export interface CourseSynthesisPoint {
  id: string;
  title: string;
  frequency: number;
  mastery: number;
  trend: "高频" | "需巩固" | "已掌握";
  sources: string[];
  summary: string;
}

export interface CourseSynthesis {
  summary: string;
  highFrequencyPoints: CourseSynthesisPoint[];
  recommendedStudyActions: string[];
  generatedQuestions: GeneratedPracticeQuestion[];
  warnings: string[];
}

export interface CourseContext {
  name: string;
  code: string;
  teacher: string;
  term: string;
}

export interface AiStatus {
  configured: boolean;
  source: "environment" | "none";
  defaultModel: AiModel;
  allowedModels: AiModel[];
  customBaseUrlAllowed: boolean;
}

export type AiPlanTaskType = "复习" | "练习" | "回顾" | "模拟";

export interface AiPlanCourse {
  name: string;
  code: string;
  examDate: string;
  priority: string;
  mastery: number;
  /** Evidence-backed focus candidates for this course, highest frequency first. */
  insights: Array<{ title: string; frequency: number; trend: string }>;
}

/** One task the model proposes; the server maps, clamps and persists it. */
export interface AiPlanEntry {
  date: string;
  courseCode: string;
  type: AiPlanTaskType;
  durationMinutes: number;
  focus: string;
  reason: string;
}
