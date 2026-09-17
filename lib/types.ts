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
  /** 支持该考点的资料份数，不是 1–5 重要度。 */
  frequency: number;
  /** 资料内重要度 1–5；缺省时由旧数据的 frequency 回退。 */
  importance: number;
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
  /** 对应练习过滤用的知识点；没有则打开该课全部练习。 */
  knowledge?: string;
  /** 该回顾任务的来源：错题重练，或间隔复习到期。 */
  reviewKind?: "missed" | "due";
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
  /** 归一化后的知识点键，用于把题目与考点/掌握度记录连接起来（服务端派生）。 */
  knowledgeKey?: string;
  difficulty?: number;
  pitfalls?: string;
}

/** 单个知识点的练习掌握度记录；只由练习结果驱动，AI 重新分析不会重置它。 */
export interface KnowledgeMasteryRecord {
  key: string;
  title: string;
  /** 0–100，练习结果的指数滑动平均。 */
  mastery: number;
  attempts: number;
  correct: number;
  lastPracticedAt?: string;
  /** 间隔复习：距下次复习的天数、难度系数与到期日（YYYY-MM-DD）。 */
  intervalDays?: number;
  ease?: number;
  due?: string;
}

/** 单题判定结果。简答题在没有自评/AI 评分时为 pending，不计入掌握度。 */
export type PracticeGrade = "correct" | "partial" | "wrong" | "pending";

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
  /** 间隔复习到期（而不是答错）产生的回顾任务；文案与排序都不同。 */
  kind?: "missed" | "due";
}

export interface PlanRequest {
  courses: Course[];
  availability: Availability[];
  insights?: Insight[];
  recentMisses?: RecentMissedTopic[];
  /** 到期该复习的知识点（间隔复习）；与错题分开传，文案不同。 */
  dueTopics?: RecentMissedTopic[];
  fromDate: string;
  /** First study slot of the day in minutes since midnight (0–1439). */
  dayStartMinutes?: number;
}
