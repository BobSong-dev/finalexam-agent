import "server-only";

import { normalizeKnowledgeKey } from "./knowledge";
import type { KnowledgeMasteryRecord, PracticeGrade, Question } from "./types";
import type { AssessmentAttempt, AssessmentAttemptItem, WorkspaceState } from "./workspace-types";

/**
 * 工作区 JSON 的版本迁移。每个迁移都是纯函数：输入旧结构，输出新结构，
 * 由 workspace-store 在读取时依次执行并在写盘前保留旧文件备份。
 */
export interface WorkspaceMigration {
  from: number;
  to: number;
  apply(state: Record<string, unknown>): Record<string, unknown>;
}

interface LegacyInsight {
  courseId?: unknown;
  title?: unknown;
  mastery?: unknown;
}

interface LegacyAttempt {
  id?: unknown;
  courseId?: unknown;
  questionIds?: unknown;
  answers?: unknown;
  correct?: unknown;
  total?: unknown;
  score?: unknown;
  items?: unknown;
  graded?: unknown;
}

/**
 * v1 → v2：
 * - 把挂在 insights 上、会被 AI 重新生成覆盖的 mastery 搬进独立的 knowledgeMastery；
 * - 给 assessmentAttempts 补逐题快照（knowledge/prompt/grade），错题回顾不再依赖题目 id 仍然存在；
 * - questions 派生 knowledgeKey；新增 practiceSessions。
 */
const migrateV1ToV2: WorkspaceMigration = {
  from: 1,
  to: 2,
  apply(raw) {
    const state = { ...raw } as Record<string, unknown>;
    const insights = Array.isArray(state.insights) ? (state.insights as LegacyInsight[]) : [];
    const questions = Array.isArray(state.questions) ? (state.questions as Question[]) : [];
    const attempts = Array.isArray(state.assessmentAttempts)
      ? (state.assessmentAttempts as LegacyAttempt[])
      : [];

    const knowledgeMastery: WorkspaceState["knowledgeMastery"] = {};
    // 只有出现过练习记录的课程才有真实掌握度；其余 insight.mastery 是课程掌握度的复制值，不搬。
    const practicedCourses = new Set(attempts.map((attempt) => String(attempt.courseId ?? "")));
    for (const insight of insights) {
      const courseId = typeof insight.courseId === "string" ? insight.courseId : "";
      const title = typeof insight.title === "string" ? insight.title.trim() : "";
      if (!courseId || !title || !practicedCourses.has(courseId)) continue;
      const key = normalizeKnowledgeKey(title);
      if (!key) continue;
      const mastery =
        typeof insight.mastery === "number" && Number.isFinite(insight.mastery)
          ? Math.round(Math.max(0, Math.min(100, insight.mastery)))
          : 0;
      if (mastery <= 0) continue;
      const bucket = (knowledgeMastery[courseId] ??= {});
      bucket[key] ??= {
        key,
        title,
        mastery,
        attempts: 0,
        correct: 0,
      } satisfies KnowledgeMasteryRecord;
    }

    const questionById = new Map(questions.map((question) => [question.id, question]));
    state.questions = questions.map((question) => ({
      ...question,
      knowledgeKey: question.knowledgeKey || normalizeKnowledgeKey(question.knowledge || ""),
    }));

    state.assessmentAttempts = attempts.map((attempt): AssessmentAttempt => {
      const questionIds = Array.isArray(attempt.questionIds)
        ? attempt.questionIds.filter((id): id is string => typeof id === "string")
        : [];
      const answers =
        attempt.answers && typeof attempt.answers === "object"
          ? (attempt.answers as Record<string, string>)
          : {};
      const existingItems = Array.isArray(attempt.items)
        ? (attempt.items as AssessmentAttemptItem[])
        : undefined;
      const items =
        existingItems ??
        questionIds.map((questionId): AssessmentAttemptItem => {
          const question = questionById.get(questionId);
          const answer = String(answers[questionId] ?? "");
          const grade: PracticeGrade = question ? legacyGrade(question, answer) : "pending";
          return {
            questionId,
            knowledgeKey: normalizeKnowledgeKey(question?.knowledge ?? ""),
            knowledge: question?.knowledge ?? "",
            prompt: question?.prompt ?? "",
            answer,
            grade,
          };
        });
      const total = typeof attempt.total === "number" ? attempt.total : questionIds.length;
      return {
        id: String(attempt.id ?? ""),
        courseId: String(attempt.courseId ?? ""),
        questionIds,
        answers,
        items,
        correct:
          typeof attempt.correct === "number"
            ? attempt.correct
            : items.filter((item) => item.grade === "correct").length,
        total,
        graded: typeof attempt.graded === "number" ? attempt.graded : total,
        score: typeof attempt.score === "number" ? attempt.score : 0,
        ...(typeof (attempt as { selfRating?: unknown }).selfRating === "number"
          ? { selfRating: (attempt as { selfRating: number }).selfRating }
          : {}),
        createdAt: String(
          (attempt as { createdAt?: unknown }).createdAt ?? new Date().toISOString(),
        ),
      };
    });

    state.knowledgeMastery = knowledgeMastery;
    state.practiceSessions = [];
    state.version = 2;
    return state;
  },
};

/** v1 的判分规则（精确匹配），只用于给历史记录补快照。 */
function legacyGrade(question: Question, answer: string): PracticeGrade {
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[\s　]+/g, "");
  const expected = normalize(question.answer);
  const actual = normalize(answer);
  if (!actual) return "wrong";
  if (question.type === "单选") {
    const token = (value: string) => /^([a-z])(?:[.、:：)）]|$)/i.exec(value)?.[1]?.toUpperCase();
    const index = (value: string) => {
      const found = (question.choices ?? []).findIndex((choice) => normalize(choice) === value);
      return found >= 0 ? String.fromCharCode(65 + found) : undefined;
    };
    const left = token(expected) ?? index(expected);
    const right = token(actual) ?? index(actual);
    if (left && right) return left === right ? "correct" : "wrong";
  }
  return actual === expected ? "correct" : "wrong";
}

export const WORKSPACE_MIGRATIONS: readonly WorkspaceMigration[] = [migrateV1ToV2];

export function migrateWorkspaceRaw(
  raw: Record<string, unknown>,
  targetVersion: number,
): { state: Record<string, unknown>; migrated: boolean; fromVersion: number } {
  let current = raw;
  let version = typeof raw.version === "number" ? raw.version : 1;
  const fromVersion = version;
  while (version < targetVersion) {
    const migration = WORKSPACE_MIGRATIONS.find((item) => item.from === version);
    if (!migration) throw new Error(`No workspace migration from version ${version}`);
    current = migration.apply(current);
    version = migration.to;
  }
  return { state: current, migrated: fromVersion !== version, fromVersion };
}
