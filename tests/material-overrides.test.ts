import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import type { DocumentAnalysis } from "../lib/ai-types";
import { normalizeKnowledgeKey } from "../lib/knowledge";
import {
  WorkspaceStoreError,
  beginMaterialAnalysis,
  confirmMaterialAnalysis,
  createCourse,
  createPracticeSession,
  getWorkspace,
  recordPractice,
  saveDocumentAnalysis,
  setInsightHidden,
  setQuestionAnswerOverride,
  storeUploadedMaterial,
  toPublicWorkspace,
} from "../lib/workspace-store";

const temporaryDataDirectory = path.join(
  os.tmpdir(),
  `finale-overrides-${process.pid}-${randomUUID()}`,
);
const previousDataDirectory = process.env.FINALE_DATA_DIR;
process.env.FINALE_DATA_DIR = temporaryDataDirectory;

test.after(async () => {
  if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
  else process.env.FINALE_DATA_DIR = previousDataDirectory;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

const ANALYSIS: DocumentAnalysis = {
  documentTitle: "修正测试卷.pdf",
  materialKind: "试卷",
  pageCount: 1,
  summary: "用于修正与忽略功能。",
  confidence: "low",
  keyPoints: [
    {
      id: "k1",
      title: "极限的计算",
      importance: 5,
      evidence: { label: "卷", location: "第 1 页", quote: "求极限" },
    },
    {
      id: "k2",
      title: "导数的定义",
      importance: 3,
      evidence: { label: "卷", location: "第 2 页", quote: "求导" },
    },
  ],
  questionPatterns: [],
  studyActions: [],
  generatedQuestions: [
    {
      id: "q1",
      type: "填空",
      prompt: "lim sin x/x = ____",
      choices: [],
      answer: "模型给的错误答案",
      explanation: "",
      knowledge: "极限的计算",
      knowledgeId: "k1",
      sourceLocation: "第 1 页",
    },
    {
      id: "q2",
      type: "填空",
      prompt: "导数定义为____",
      choices: [],
      answer: "差商的极限",
      explanation: "",
      knowledge: "导数的定义",
      knowledgeId: "k2",
      sourceLocation: "第 2 页",
    },
  ],
  warnings: ["第 1 页扫描较暗"],
};

async function seed(code: string) {
  const { course } = await createCourse({
    name: `修正课程 ${code}`,
    code,
    teacher: "t",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "高",
  });
  const { material } = await storeUploadedMaterial(
    course.id,
    new File([Buffer.from("%PDF-1.4\n")], `${code}.pdf`, { type: "application/pdf" }),
  );
  const reservation = await beginMaterialAnalysis(material.id);
  await saveDocumentAnalysis(material.id, ANALYSIS, reservation.runId);
  const workspace = await getWorkspace();
  return {
    course,
    material,
    questions: workspace.questions.filter((question) => question.courseId === course.id),
  };
}

test("a low-confidence analysis can be confirmed by the user", async () => {
  const { material } = await seed("CONF-1");
  assert.equal((await getWorkspace()).materials[0]!.status, "需确认");
  const confirmed = await confirmMaterialAnalysis(material.id);
  assert.equal(confirmed.materials[0]!.status, "已分析");
  assert.equal(confirmed.materials[0]!.source, "已由你确认分析结果");
  await assert.rejects(
    () => confirmMaterialAnalysis(material.id),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 409,
    "only 需确认 materials can be confirmed",
  );
});

test("a corrected answer is used for grading and stays out of the public payload", async () => {
  const { course, questions } = await seed("ANS-1");
  const hiddenQuestion = questions.find((question) => question.answer === "模型给的错误答案")!;
  const other = questions.find((question) => question.id !== hiddenQuestion.id)!;

  // 修正前按模型答案判分。
  const before = await recordPractice({
    courseId: course.id,
    questionIds: [hiddenQuestion.id],
    answers: { [hiddenQuestion.id]: "1" },
  });
  assert.equal(before.correct, 0);

  const updated = await setQuestionAnswerOverride(hiddenQuestion.id, "1");
  assert.equal(updated.answerOverrides?.[hiddenQuestion.id]?.answer, "1");
  const publicState = toPublicWorkspace(updated);
  assert.equal(
    JSON.stringify(publicState).includes("answerOverrides"),
    false,
    "overrides are server-only metadata",
  );
  assert.equal("answer" in (publicState.questions[0] ?? {}), false);

  // 修正后同一份作答判为正确，并且回显的是修正后的答案。
  const after = await recordPractice({
    courseId: course.id,
    questionIds: [hiddenQuestion.id],
    answers: { [hiddenQuestion.id]: "1" },
  });
  assert.equal(after.correct, 1);
  assert.equal(after.revealed[0]!.answer, "1");

  // 留空即恢复模型答案。
  await setQuestionAnswerOverride(hiddenQuestion.id, "   ");
  const restored = await recordPractice({
    courseId: course.id,
    questionIds: [hiddenQuestion.id],
    answers: { [hiddenQuestion.id]: "1" },
  });
  assert.equal(restored.correct, 0);

  await assert.rejects(
    () => setQuestionAnswerOverride(other.id, "x".repeat(2_001)),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 400,
  );
});

test("an ignored insight leaves the UI, the practice pool and the plan", async () => {
  const { course, questions } = await seed("HIDE-1");
  const insight = (await getWorkspace()).insights.find(
    (item) => item.courseId === course.id && item.title === "极限的计算",
  )!;
  const hidden = await setInsightHidden(insight.id, true);
  assert.deepEqual(hidden.hiddenInsights, [insight.id]);

  const publicState = toPublicWorkspace(hidden);
  assert.equal(
    publicState.insights.some((item) => item.id === insight.id),
    false,
    "hidden insights are not sent to the browser",
  );
  assert.equal(
    publicState.insights.some((item) => item.courseId === course.id && item.title === "导数的定义"),
    true,
    "other insights of the same course stay visible",
  );

  // 抽题不再包含被忽略考点对应的题目。
  const { questions: served } = await createPracticeSession({ courseId: course.id });
  const hiddenKey = normalizeKnowledgeKey("极限的计算");
  assert.equal(
    served.some((question) => (question.knowledgeKey ?? "") === hiddenKey),
    false,
  );
  assert.ok(served.length >= 1);

  // 计划里也不再出现该考点的任务标题。
  assert.equal(
    (await getWorkspace()).tasks.some(
      (task) => task.courseId === course.id && task.knowledge === "极限的计算",
    ),
    false,
  );
  assert.ok(questions.length >= 2);

  // 恢复后重新出现。
  const restored = await setInsightHidden(insight.id, false);
  assert.deepEqual(restored.hiddenInsights, []);
  assert.equal(
    toPublicWorkspace(restored).insights.some((item) => item.id === insight.id),
    true,
  );
});

test("override routes are origin-checked and validate their body", async () => {
  const { course, questions } = await seed("ROUTE-1");
  const { PATCH: patchInsight } = await import("../app/api/insights/[id]/route");
  const { PATCH: patchAnswer } = await import("../app/api/questions/[id]/answer/route");
  const insight = (await getWorkspace()).insights.find((item) => item.courseId === course.id)!;

  const rejected = await patchInsight(
    new NextRequest(`http://localhost/api/insights/${insight.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ hidden: true }),
    }),
    { params: Promise.resolve({ id: insight.id }) },
  );
  assert.equal(rejected.status, 403);

  const ok = await patchInsight(
    new NextRequest(`http://localhost/api/insights/${insight.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ hidden: true }),
    }),
    { params: Promise.resolve({ id: insight.id }) },
  );
  assert.equal(ok.status, 200);
  const payload = (await ok.json()) as { insights: unknown[] };
  assert.equal(
    payload.insights.some((item) => (item as { id: string }).id === insight.id),
    false,
  );

  const badAnswer = await patchAnswer(
    new NextRequest(`http://localhost/api/questions/${questions[0]!.id}/answer`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ answer: 42 }),
    }),
    { params: Promise.resolve({ id: questions[0]!.id }) },
  );
  assert.equal(badAnswer.status, 400);
  assert.equal(course.id.length > 0, true);
});
