export type Priority = "高" | "中" | "低";
export type MaterialStatus = "待分析" | "分析中" | "已分析" | "需确认" | "失败";
export type MaterialKind = "试卷" | "课件" | "讲义" | "题库";

export interface Course {
  id: string;
  name: string;
  code: string;
  teacher: string;
  term: string;
  examDate: string;
  priority: Priority;
  mastery: number;
  highFrequencyWeight: number;
  color: string;
}

export interface Material {
  id: string;
  courseId: string;
  name: string;
  kind: MaterialKind;
  pages: number;
  status: MaterialStatus;
  source: string;
  shared: boolean;
  createdAt: string;
  /** Local/self-hosted runtime metadata. Never exposed as a filesystem path. */
  mimeType?: string;
  byteSize?: number;
  error?: string;
}

export interface Insight {
  id: string;
  courseId: string;
  title: string;
  frequency: number;
  mastery: number;
  trend: "高频" | "需巩固" | "已掌握";
  sources: string[];
  summary: string;
}

export interface StudyTask {
  id: string;
  courseId: string;
  date: string;
  start: string;
  duration: number;
  title: string;
  type: "复习" | "练习" | "回顾" | "模拟";
  status: "待完成" | "已完成" | "已错过";
  reason: string;
}

export interface Question {
  id: string;
  courseId: string;
  type: "单选" | "填空" | "简答";
  prompt: string;
  choices?: string[];
  answer: string;
  explanation: string;
  source: string;
  knowledge: string;
}

export interface SharedMaterial {
  id: string;
  school: string;
  courseName: string;
  courseCode: string;
  teacher: string;
  term: string;
  title: string;
  kind: MaterialKind;
  pages: number;
  /** Canonical server-side MIME type used for shared downloads. */
  mimeType?: string;
  contributor: string;
  quality: "优质" | "已核验" | "待核验";
  credits: number;
  tags: string[];
  preview: string;
  status: "待审核" | "可解锁" | "已解锁" | "已归档" | "已拒绝";
  unlocks: number;
}

export interface CreditTransaction {
  id: string;
  label: string;
  amount: number;
  createdAt: string;
  kind: "earn" | "spend" | "bonus" | "reversal";
}

export interface Availability {
  date: string;
  minutes: number;
}

/**
 * A knowledge topic the learner recently answered wrong in a real practice
 * attempt. Borrowed from spaced-repetition schedulers (FSRS/SM-2): a missed
 * item must resurface on a later day as an explicit review task instead of
 * disappearing into generic course-level work.
 */
export interface RecentMissedTopic {
  courseId: string;
  topic: string;
  /** Date-only string (YYYY-MM-DD) of the practice attempt that was wrong. */
  missedOn: string;
}

export interface PlanRequest {
  courses: Course[];
  availability: Availability[];
  insights?: Insight[];
  recentMisses?: RecentMissedTopic[];
  fromDate: string;
  /** First study slot of the day in minutes since midnight (0–1439). */
  dayStartMinutes?: number;
}
