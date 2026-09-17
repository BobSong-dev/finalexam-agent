import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentAnalysis } from "../lib/ai-types";
import { normalizeKnowledgeKey } from "../lib/knowledge";
import {
  beginMaterialAnalysis,
  createCourse,
  createPracticeSession,
  getWorkspace,
  recordPractice,
  saveDocumentAnalysis,
  storeUploadedMaterial,
  updateAvailability,
} from "../lib/workspace-store";

const temporaryDataDirectory = path.join(os.tmpdir(), `finale-srs-${process.pid}-${randomUUID()}`);
const previousDataDirectory = process.env.FINALE_DATA_DIR;
process.env.FINALE_DATA_DIR = temporaryDataDirectory;

test.after(async () => {
  if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
  else process.env.FINALE_DATA_DIR = previousDataDirectory;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

const ANALYSIS: DocumentAnalysis = {
  documentTitle: "间隔复习测试卷.pdf",
  materialKind: "试卷",
  pageCount: 1,
  summary: "用于间隔复习排程。",
  confidence: "high",
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
      evidence: { label: "卷", location: "第 1 页", quote: "求导" },
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
      answer: "1",
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
      sourceLocation: "第 1 页",
    },
  ],
  warnings: [],
};

function addDays(date: string, offset: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

async function seed(code: string) {
  const { course } = await createCourse({
    name: `间隔课程 ${code}`,
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
    questions: workspace.questions.filter((question) => question.courseId === course.id),
  };
}

/** 直接改工作区文件把某些知识点的到期日提前，模拟“几天后再打开应用”。 */
async function makeDue(courseId: string, due: string): Promise<void> {
  const statePath = path.join(temporaryDataDirectory, "workspace.json");
  const raw = JSON.parse(await readFile(statePath, "utf8")) as {
    knowledgeMastery: Record<string, Record<string, { due?: string }>>;
  };
  for (const record of Object.values(raw.knowledgeMastery[courseId] ?? {})) record.due = due;
  await writeFile(statePath, JSON.stringify(raw), "utf8");
}

test("a wrong answer schedules an immediate review, a right answer pushes it out", async () => {
  const { course, questions } = await seed("SRS-1");
  const limit = questions.find((question) => question.knowledge === "极限的计算")!;
  const derivative = questions.find((question) => question.knowledge === "导数的定义")!;
  const key = (title: string) => normalizeKnowledgeKey(title);

  const correctRun = await recordPractice({
    courseId: course.id,
    questionIds: [limit.id, derivative.id],
    answers: { [limit.id]: "1", [derivative.id]: "差商的极限" },
  });
  const today = correctRun.workspace.availability[0]!.date;
  const limitRecord = correctRun.workspace.knowledgeMastery[course.id]![key("极限的计算")]!;
  assert.equal(limitRecord.intervalDays, 3, "a first-correct answer schedules 3 days out");
  assert.equal(limitRecord.due, addDays(today, 3));
  assert.ok((limitRecord.ease ?? 0) > 0.8, "ease grows after a good answer");
  assert.equal(
    correctRun.workspace.tasks.some((task) => task.reviewKind === "due"),
    false,
    "nothing is due yet",
  );

  const wrongRun = await recordPractice({
    courseId: course.id,
    questionIds: [limit.id],
    answers: { [limit.id]: "完全不对" },
  });
  const afterWrong = wrongRun.workspace.knowledgeMastery[course.id]![key("极限的计算")]!;
  assert.equal(afterWrong.intervalDays, 1, "a lapse resets the interval to one day");
  assert.equal(afterWrong.due, addDays(today, 1));
  assert.ok((afterWrong.ease ?? 0) < (limitRecord.ease ?? 0), "ease drops after a wrong answer");
  assert.ok(afterWrong.mastery < limitRecord.mastery, "mastery also drops");
});

test("consecutive correct answers keep extending the interval", async () => {
  const { course, questions } = await seed("SRS-3");
  const limit = questions.find((question) => question.knowledge === "极限的计算")!;
  const key = normalizeKnowledgeKey("极限的计算");

  await recordPractice({
    courseId: course.id,
    questionIds: [limit.id],
    answers: { [limit.id]: "错的" },
  });
  assert.equal((await getWorkspace()).knowledgeMastery[course.id]![key]!.intervalDays, 1);

  await recordPractice({
    courseId: course.id,
    questionIds: [limit.id],
    answers: { [limit.id]: "1" },
  });
  assert.equal((await getWorkspace()).knowledgeMastery[course.id]![key]!.intervalDays, 2);

  await recordPractice({
    courseId: course.id,
    questionIds: [limit.id],
    answers: { [limit.id]: "1" },
  });
  const grown = (await getWorkspace()).knowledgeMastery[course.id]![key]!;
  assert.ok((grown.intervalDays ?? 0) > 2, "consecutive correct answers extend the interval");
  assert.ok((grown.intervalDays ?? 0) <= 60, "the interval stays bounded");
});

test("a due knowledge point becomes an explicit review task and is prioritised when drawing questions", async () => {
  const { course, questions } = await seed("SRS-2");
  const limit = questions.find((question) => question.knowledge === "极限的计算")!;
  const derivative = questions.find((question) => question.knowledge === "导数的定义")!;
  const first = await recordPractice({
    courseId: course.id,
    questionIds: [limit.id, derivative.id],
    answers: { [limit.id]: "1", [derivative.id]: "差商的极限" },
  });
  const today = first.workspace.availability[0]!.date;

  // 让「极限的计算」在今天到期，另一个推到很远的将来。
  await makeDue(course.id, today);
  const key = normalizeKnowledgeKey("极限的计算");
  await mutateWorkspaceJson((state) => {
    state.knowledgeMastery[course.id]![normalizeKnowledgeKey("导数的定义")]!.due = addDays(
      today,
      30,
    );
  });

  // 任意一次会重排计划的写操作即可观察到新的排期。
  const rearranged = await updateAvailability([{ date: today, minutes: 120 }]);
  const dueTasks = rearranged.tasks.filter(
    (task) => task.courseId === course.id && task.reviewKind === "due",
  );
  assert.ok(dueTasks.length > 0, "a due knowledge point produces a review task");
  assert.ok(
    dueTasks.some((task) => task.knowledge === "极限的计算"),
    rearranged.tasks.map((task) => task.knowledge).join(","),
  );
  assert.equal(
    rearranged.tasks.some((task) => task.knowledge === "导数的定义" && task.reviewKind === "due"),
    false,
    "a knowledge point that is not due yet is not scheduled as a review",
  );
  assert.match(dueTasks[0]!.reason, /到期/);
  assert.match(dueTasks[0]!.title, /间隔复习/);

  // 抽题时到期知识点优先。
  const session = await createPracticeSession({ courseId: course.id, size: 1 });
  assert.equal(session.questions[0]!.knowledge, "极限的计算");
  assert.equal(normalizeKnowledgeKey(session.questions[0]!.knowledge), key);
});

async function mutateWorkspaceJson(
  mutator: (state: { knowledgeMastery: Record<string, Record<string, { due?: string }>> }) => void,
): Promise<void> {
  const statePath = path.join(temporaryDataDirectory, "workspace.json");
  const raw = JSON.parse(await readFile(statePath, "utf8")) as {
    knowledgeMastery: Record<string, Record<string, { due?: string }>>;
  };
  mutator(raw);
  await writeFile(statePath, JSON.stringify(raw), "utf8");
}
