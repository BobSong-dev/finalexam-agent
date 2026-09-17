import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import type { DocumentAnalysis } from "../lib/ai-types";
import { knowledgeKeysRelated, normalizeKnowledgeKey } from "../lib/knowledge";
import {
  WorkspaceStoreError,
  answerMatches,
  beginMaterialAnalysis,
  createCourse,
  createPracticeSession,
  getWorkspace,
  gradeAnswer,
  recordPractice,
  saveDocumentAnalysis,
  storeUploadedMaterial,
} from "../lib/workspace-store";

const temporaryDataDirectory = path.join(
  os.tmpdir(),
  `finale-practice-${process.pid}-${randomUUID()}`,
);
const previousDataDirectory = process.env.FINALE_DATA_DIR;
process.env.FINALE_DATA_DIR = temporaryDataDirectory;

test.after(async () => {
  if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
  else process.env.FINALE_DATA_DIR = previousDataDirectory;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

function analysisWith(
  questions: DocumentAnalysis["generatedQuestions"],
  keyPoints: Array<{ id: string; title: string }>,
): DocumentAnalysis {
  return {
    documentTitle: "练习判分测试卷",
    materialKind: "试卷",
    pageCount: 2,
    summary: "用于练习会话与判分测试。",
    confidence: "high",
    keyPoints: keyPoints.map((point) => ({
      id: point.id,
      title: point.title,
      importance: 4,
      evidence: { label: "测试卷", location: "第 1 页", quote: point.title },
    })),
    questionPatterns: [],
    studyActions: [],
    generatedQuestions: questions,
    warnings: [],
  };
}

const KEY_POINTS = [
  { id: "kp-limit", title: "极限的计算" },
  { id: "kp-derivative", title: "导数的定义" },
];

function questions(): DocumentAnalysis["generatedQuestions"] {
  return [
    {
      id: "q-limit-1",
      type: "单选",
      prompt: "lim x→0 sin x / x = ?",
      choices: ["A. 0", "B. 1", "C. ∞", "D. 不存在"],
      answer: "B",
      explanation: "重要极限。",
      knowledge: "极限的计算",
      knowledgeId: "kp-limit",
      sourceLocation: "第 1 页",
    },
    {
      id: "q-limit-2",
      type: "填空",
      prompt: "lim x→∞ (1 + 1/x)^x = ____",
      choices: [],
      answer: "e|自然常数",
      explanation: "第二重要极限。",
      knowledge: "极限的计算",
      knowledgeId: "kp-limit",
      sourceLocation: "第 1 页",
    },
    {
      id: "q-deriv-1",
      type: "单选",
      prompt: "f'(x0) 的定义是？",
      choices: ["A. 差商的极限", "B. 面积", "C. 切线长度", "D. 积分"],
      answer: "A",
      explanation: "导数是差商极限。",
      knowledge: "导数的定义",
      knowledgeId: "kp-derivative",
      sourceLocation: "第 2 页",
    },
    {
      id: "q-deriv-2",
      type: "简答",
      prompt: "说明可导与连续的关系。",
      choices: [],
      answer: "可导必连续，连续不一定可导。",
      explanation: "举例 |x|。",
      knowledge: "导数的定义",
      knowledgeId: "kp-derivative",
      sourceLocation: "第 2 页",
    },
  ];
}

async function seedCourse(code: string) {
  const { course } = await createCourse({
    name: `高等数学 ${code}`,
    code,
    teacher: "测试老师",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "高",
  });
  const { material } = await storeUploadedMaterial(
    course.id,
    new File([Buffer.from("%PDF-mock\npractice")], `${code}.pdf`, { type: "application/pdf" }),
  );
  const reservation = await beginMaterialAnalysis(material.id);
  await saveDocumentAnalysis(material.id, analysisWith(questions(), KEY_POINTS), reservation.runId);
  const workspace = await getWorkspace();
  return {
    course,
    material,
    questions: workspace.questions.filter((question) => question.courseId === course.id),
  };
}

test("knowledge keys normalize punctuation and tolerate contained titles", () => {
  assert.equal(
    normalizeKnowledgeKey("二重积分 的 区域变换。"),
    normalizeKnowledgeKey("二重积分的区域变换"),
  );
  assert.equal(normalizeKnowledgeKey("Ｌimit（极限）"), "limit极限");
  assert.equal(
    knowledgeKeysRelated(
      normalizeKnowledgeKey("二重积分"),
      normalizeKnowledgeKey("二重积分的区域变换"),
    ),
    false,
    "40% length tolerance: 4 vs 9 chars is too far",
  );
  assert.equal(
    knowledgeKeysRelated(
      normalizeKnowledgeKey("极限的计算"),
      normalizeKnowledgeKey("极限的计算方法"),
    ),
    true,
  );
  assert.equal(knowledgeKeysRelated("", "x"), false);
});

test("grading tolerates punctuation, alternatives and self-graded short answers", () => {
  const fillIn = {
    id: "f",
    courseId: "c",
    type: "填空" as const,
    prompt: "",
    answer: "e|自然常数",
    explanation: "",
    source: "",
    knowledge: "k",
  };
  assert.equal(answerMatches(fillIn, "e"), true);
  assert.equal(answerMatches(fillIn, "自然常数。"), true);
  assert.equal(
    answerMatches(fillIn, "答案是自然常数"),
    true,
    "a short surrounding phrase is accepted",
  );
  assert.equal(
    answerMatches(fillIn, "答案是 e"),
    false,
    "single-character answers only match exactly",
  );
  assert.equal(
    answerMatches(fillIn, "这道题我觉得可能是 e 也可能是 1 或者 0 或者无穷"),
    false,
    "a long dump must not match",
  );
  assert.equal(answerMatches(fillIn, "1"), false);

  const numeric = { ...fillIn, answer: "1,000" };
  assert.equal(answerMatches(numeric, "1000"), true);

  const choice = {
    id: "c",
    courseId: "c",
    type: "单选" as const,
    prompt: "",
    choices: ["A. 0", "B. 1", "C. ∞", "D. 不存在"],
    answer: "B",
    explanation: "",
    source: "",
    knowledge: "k",
  };
  assert.equal(answerMatches(choice, "b"), true);
  assert.equal(answerMatches(choice, "B. 1"), true);
  assert.equal(answerMatches(choice, "1"), true, "choice body without the letter prefix matches");
  assert.equal(answerMatches(choice, "0"), false);

  const essay = { ...fillIn, type: "简答" as const, answer: "可导必连续" };
  assert.equal(gradeAnswer(essay, "可导一定连续"), "pending");
  assert.equal(gradeAnswer(essay, ""), "wrong");
  assert.equal(gradeAnswer(essay, "x", "partial"), "partial");
});

test("a knowledge-scoped practice session only grades and records its own questions", async () => {
  const { course } = await seedCourse("PRAC-SCOPE-1");
  const { session, questions: served } = await createPracticeSession({
    courseId: course.id,
    knowledge: "极限的计算",
  });
  assert.equal(served.length, 2);
  assert.ok(served.every((question) => question.knowledge === "极限的计算"));
  assert.equal(
    "answer" in (served[0] as unknown as Record<string, unknown>),
    true,
    "store-level call still returns full questions; the route strips answers",
  );

  const answers = Object.fromEntries(
    served.map((question) => [question.id, question.answer.split("|")[0]!]),
  );
  const result = await recordPractice({ courseId: course.id, sessionId: session.id, answers });
  assert.equal(result.total, 2, "only the two limit questions are in scope");
  assert.equal(result.correct, 2);
  assert.equal(result.score, 100);

  const attempt = result.workspace.assessmentAttempts[0]!;
  assert.equal(attempt.sessionId, session.id);
  assert.equal(attempt.items.length, 2);
  assert.ok(attempt.items.every((item) => item.grade === "correct"));

  const mastery = result.workspace.knowledgeMastery[course.id]!;
  assert.ok(mastery[normalizeKnowledgeKey("极限的计算")]!.mastery > 0);
  assert.equal(
    mastery[normalizeKnowledgeKey("导数的定义")],
    undefined,
    "unpracticed knowledge must not be marked wrong",
  );
  assert.equal(result.workspace.missedTasks.length, 0);
  assert.ok(
    !result.workspace.tasks.some((task) => task.title.includes("重练错题「导数的定义」")),
    "no phantom misses for unseen questions",
  );

  await assert.rejects(
    () => recordPractice({ courseId: course.id, sessionId: session.id, answers }),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 409,
    "a session can only be submitted once",
  );
  await assert.rejects(
    () =>
      recordPractice({
        courseId: course.id,
        questionIds: ["not-a-question"],
        answers: { "not-a-question": "x" },
      }),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 409,
  );
});

test("pending short answers are excluded from the score until self-graded", async () => {
  const { course, questions: all } = await seedCourse("PRAC-ESSAY-1");
  const essay = all.find((question) => question.type === "简答")!;
  const choice = all.find((question) => question.id.endsWith("question-2"))!;
  const first = await recordPractice({
    courseId: course.id,
    questionIds: [essay.id, choice.id],
    answers: { [essay.id]: "可导一定连续", [choice.id]: "A" },
  });
  assert.equal(first.total, 2);
  assert.equal(first.graded, 1, "the essay is pending");
  assert.equal(first.score, 100);
  assert.equal(first.revealed.find((item) => item.questionId === essay.id)?.grade, "pending");

  const second = await recordPractice({
    courseId: course.id,
    questionIds: [essay.id],
    answers: { [essay.id]: "不知道" },
    selfGrades: { [essay.id]: "partial" },
  });
  assert.equal(second.graded, 1);
  assert.equal(second.score, 50);
  const record =
    second.workspace.knowledgeMastery[course.id]![normalizeKnowledgeKey("导数的定义")]!;
  assert.ok(record.attempts >= 2);
});

test("re-analysis and synthesis keep practiced mastery instead of resetting it", async () => {
  const { course, material, questions: all } = await seedCourse("PRAC-KEEP-1");
  const answers = Object.fromEntries(
    all
      .filter((question) => question.type !== "简答")
      .map((question) => [question.id, question.answer.split("|")[0]!]),
  );
  const practiced = await recordPractice({
    courseId: course.id,
    questionIds: Object.keys(answers),
    answers,
  });
  const before = practiced.workspace.courses.find((item) => item.id === course.id)!.mastery;
  assert.ok(before > 0);
  const limitBefore =
    practiced.workspace.knowledgeMastery[course.id]![normalizeKnowledgeKey("极限的计算")]!.mastery;

  // Re-run the analysis with reworded key point titles; mastery must survive.
  const reservation = await beginMaterialAnalysis(material.id);
  const reworded = analysisWith(
    questions().map((question) => ({
      ...question,
      id: `${question.id}-v2`,
      knowledge: question.knowledge === "极限的计算" ? "极限的计算方法" : question.knowledge,
      knowledgeId: question.knowledgeId,
    })),
    [{ id: "kp-limit", title: "极限的计算方法" }, KEY_POINTS[1]!],
  );
  const after = await saveDocumentAnalysis(material.id, reworded, reservation.runId);
  assert.equal(
    after.courses.find((item) => item.id === course.id)!.mastery,
    before,
    "course mastery is derived from practice, not reset by analysis",
  );
  const limitInsight = after.insights.find(
    (item) => item.courseId === course.id && item.title === "极限的计算方法",
  )!;
  assert.equal(
    limitInsight.mastery,
    limitBefore,
    "a reworded key point still inherits the practiced mastery through the related-key match",
  );
  const courseAttempts = after.assessmentAttempts.filter(
    (attempt) => attempt.courseId === course.id,
  );
  assert.equal(courseAttempts.length, 1);
  assert.equal(
    courseAttempts[0]!.items.length,
    3,
    "attempt snapshots survive question regeneration",
  );
});

test("v1 workspaces migrate to v2 with a backup and preserved attempts", async () => {
  const dir = path.join(os.tmpdir(), `finale-migrate-${process.pid}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const courseId = "course-v1";
  const v1 = {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    profile: {
      id: "local-workspace",
      displayName: "",
      email: "",
      school: "",
      verified: false,
      credits: 0,
      examGoal: "",
      timezone: "Asia/Shanghai",
      studyDayStart: "18:30",
    },
    courses: [
      {
        id: courseId,
        name: "线代",
        code: "LA",
        teacher: "t",
        term: "2026",
        examDate: "2099-01-01",
        priority: "高",
        mastery: 55,
        highFrequencyWeight: 0.5,
        color: "#000",
      },
    ],
    availability: [],
    materials: [],
    insights: [
      {
        id: "i1",
        courseId,
        title: "矩阵的秩",
        frequency: 1,
        importance: 4,
        mastery: 62,
        trend: "高频",
        sources: [],
        summary: "",
      },
    ],
    questions: [
      {
        id: "q1",
        courseId,
        type: "单选",
        prompt: "?",
        choices: ["A. 1", "B. 2"],
        answer: "A",
        explanation: "",
        source: "",
        knowledge: "矩阵的秩",
      },
    ],
    tasks: [],
    sharedMaterials: [],
    ledger: [],
    documentAnalyses: {},
    courseSyntheses: {},
    assessmentAttempts: [
      {
        id: "a1",
        courseId,
        questionIds: ["q1"],
        answers: { q1: "B" },
        correct: 0,
        total: 1,
        score: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    auditLog: [],
    sharedMaterialRecords: [],
    sharedReports: [],
    unlockGrants: [],
    otpChallenges: [],
    missedTasks: [],
  };
  await writeFile(path.join(dir, "workspace.json"), JSON.stringify(v1), "utf8");
  const previous = process.env.FINALE_DATA_DIR;
  process.env.FINALE_DATA_DIR = dir;
  try {
    const migrated = await getWorkspace();
    assert.equal(migrated.version, 2);
    assert.equal(
      migrated.knowledgeMastery[courseId]![normalizeKnowledgeKey("矩阵的秩")]!.mastery,
      62,
    );
    assert.equal(migrated.assessmentAttempts[0]!.items[0]!.grade, "wrong");
    assert.equal(migrated.assessmentAttempts[0]!.items[0]!.knowledge, "矩阵的秩");
    assert.equal(migrated.questions[0]!.knowledgeKey, normalizeKnowledgeKey("矩阵的秩"));
    const backup = JSON.parse(await readFile(path.join(dir, "workspace.v1.bak.json"), "utf8")) as {
      version: number;
    };
    assert.equal(backup.version, 1);
    const persisted = JSON.parse(await readFile(path.join(dir, "workspace.json"), "utf8")) as {
      version: number;
    };
    assert.equal(persisted.version, 2, "the migrated state is written back immediately");
  } finally {
    process.env.FINALE_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("practice session route strips answers and the submit route accepts sessions", async () => {
  const { course } = await seedCourse("PRAC-ROUTE-1");
  const { POST: createSession } = await import("../app/api/practice/sessions/route");
  const { POST: submit } = await import("../app/api/assessments/submit/route");
  const created = await createSession(
    new NextRequest("http://localhost/api/practice/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ courseId: course.id, size: 3 }),
    }),
  );
  assert.equal(created.status, 201);
  const payload = (await created.json()) as {
    sessionId: string;
    questions: Array<Record<string, unknown>>;
  };
  assert.equal(payload.questions.length, 3);
  assert.ok(
    payload.questions.every((question) => !("answer" in question) && !("explanation" in question)),
  );

  const submitted = await submit(
    new NextRequest("http://localhost/api/assessments/submit", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        courseId: course.id,
        sessionId: payload.sessionId,
        answers: { [String(payload.questions[0]!.id)]: "A" },
      }),
    }),
  );
  assert.equal(submitted.status, 200);
  const result = (await submitted.json()) as { total: number; deprecated?: string };
  assert.equal(result.total, 3);
  assert.equal(result.deprecated, undefined);
});
