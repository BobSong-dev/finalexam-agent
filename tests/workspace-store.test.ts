import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { NextRequest } from "next/server";
import type { CourseSynthesis, DocumentAnalysis } from "../lib/ai-types";
import type { StudyTask } from "../lib/types";
import {
  WorkspaceStoreError,
  abandonPlanGeneration,
  beginMaterialAnalysis,
  beginPlanGeneration,
  createCourseSynthesisSourceSnapshot,
  createCourse,
  dateOnlyInTimeZone,
  failMaterialAnalysis,
  getWorkspace,
  readStoredMaterialFile,
  rebuildPlan,
  recordPractice,
  answerMatches,
  replacePlanWithGeneratedPlan,
  sanitizeDownloadFilename,
  saveCourseSynthesis,
  saveDocumentAnalysis,
  setMaterialStatus,
  setTaskCompletion,
  storeUploadedMaterial,
  toPublicMaterial,
  toPublicWorkspace,
  updateAvailability,
  updateWorkspaceProfile,
  UPLOAD_ORPHAN_GRACE_MS,
} from "../lib/workspace-store";

const execFile = promisify(execFileCallback);
const temporaryDataDirectory = path.join(os.tmpdir(), `finale-workspace-store-${process.pid}-${randomUUID()}`);
const previousDataDirectory = process.env.FINALE_DATA_DIR;

process.env.FINALE_DATA_DIR = temporaryDataDirectory;

test.after(async () => {
  if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
  else process.env.FINALE_DATA_DIR = previousDataDirectory;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

function makeStudyFile(name: string, text: string): File {
  return new File([Buffer.from(text, "utf8")], name, { type: "application/pdf" });
}

async function readWorkspaceAfterRestart(): Promise<Awaited<ReturnType<typeof getWorkspace>>> {
  const program = [
    'import { getWorkspace } from "./lib/workspace-store.ts";',
    "const workspace = await getWorkspace();",
    "process.stdout.write(JSON.stringify(workspace));",
  ].join("\n");
  const { stdout, stderr } = await execFile(process.execPath, [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    program,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, FINALE_DATA_DIR: temporaryDataDirectory },
  });
  assert.equal(stderr, "");
  return JSON.parse(stdout) as Awaited<ReturnType<typeof getWorkspace>>;
}

const mockedDocumentAnalysis: DocumentAnalysis = {
  documentTitle: "高等数学期末试卷（模拟）",
  materialKind: "试卷",
  pageCount: 3,
  summary: "二重积分和一阶线性微分方程是本卷最集中的考点。",
  confidence: "high",
  keyPoints: [{
    id: "double-integral",
    title: "二重积分的区域变换",
    importance: 5,
    evidence: {
      label: "高等数学期末试卷（模拟）",
      location: "第 2 页，第 3 题",
      quote: "先画出积分区域，再交换积分次序。",
    },
  }],
  questionPatterns: [{
    title: "区域变换计算",
    type: "计算题",
    description: "先确定区域边界，再选择更简洁的积分次序。",
    evidence: {
      label: "高等数学期末试卷（模拟）",
      location: "第 2 页，第 3 题",
      quote: "交换积分次序后计算二重积分。",
    },
  }],
  studyActions: ["完成三道区域变换变式题。"],
  generatedQuestions: [{
    id: "doc-q1",
    type: "单选",
    prompt: "交换二重积分次序前，最先应完成什么？",
    choices: ["A. 画出积分区域", "B. 直接积分", "C. 背诵公式", "D. 跳过此题"],
    answer: "A",
    explanation: "区域决定新的积分上下限。",
    knowledge: "二重积分的区域变换",
    sourceLocation: "第 2 页，第 3 题",
  }],
  warnings: [],
};

const mockedCourseSynthesis: CourseSynthesis = {
  summary: "综合资料后，二重积分区域变换应优先复习。",
  highFrequencyPoints: [{
    id: "double-integral-synthesis",
    title: "二重积分的区域变换",
    frequency: 2,
    mastery: 35,
    trend: "高频",
    sources: ["高等数学期末试卷（模拟） · 第 2 页，第 3 题"],
    summary: "题目和复习建议都强调先画区域。",
  }],
  recommendedStudyActions: ["先画区域，再完成计时练习。"],
  generatedQuestions: [{
    id: "course-q1",
    type: "填空",
    prompt: "二重积分换序前，先画出积分____。",
    choices: [],
    answer: "区域",
    explanation: "区域决定积分上下限。",
    knowledge: "二重积分的区域变换",
    sourceLocation: "课程综合 · 高等数学期末试卷（模拟）第 2 页",
  }],
  warnings: [],
};

test("self-hosted workspace persists the full material-to-practice flow", async () => {
  const { course } = await createCourse({
    name: "高等数学（下）",
    code: "MATH-TEST-201",
    teacher: "测试老师",
    term: "2026 秋",
    examDate: "2026-12-30",
    priority: "高",
  });
  assert.equal(course.mastery, 0);

  await assert.rejects(
    () => storeUploadedMaterial(course.id, makeStudyFile("不支持的资料.txt", "not supported")),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 415,
  );

  const sourceText = "%PDF-mock\n这是用于存储链路验收的模拟资料。";
  const streamedUpload = makeStudyFile("期末模拟卷.pdf", sourceText);
  Object.defineProperty(streamedUpload, "arrayBuffer", {
    value: async () => { throw new Error("persisted uploads must stream instead of buffering the whole file"); },
  });
  const { material } = await storeUploadedMaterial(course.id, streamedUpload);
  assert.equal(material.status, "待分析");
  assert.equal(material.courseId, course.id);
  assert.match(material.objectKey, /^[0-9a-f-]+\.pdf$/i);

  const beforeRestart = await getWorkspace();
  assert.equal(beforeRestart.materials.length, 1);
  assert.equal(beforeRestart.materials[0]?.id, material.id);
  assert.equal(beforeRestart.materials[0]?.objectKey, material.objectKey);

  const storedJson = JSON.parse(await readFile(path.join(temporaryDataDirectory, "workspace.json"), "utf8")) as {
    materials: Array<{ id: string; objectKey: string }>;
  };
  assert.deepEqual(
    storedJson.materials.map((item) => ({ id: item.id, objectKey: item.objectKey })),
    [{ id: material.id, objectKey: material.objectKey }],
  );

  const uploadsDirectory = path.join(temporaryDataDirectory, "uploads");
  const orphanObject = path.join(uploadsDirectory, `${randomUUID()}.pdf`);
  const interruptedUpload = path.join(uploadsDirectory, `${randomUUID()}.pdf.incoming`);
  await Promise.all([
    writeFile(orphanObject, "%PDF-orphan"),
    writeFile(interruptedUpload, "%PDF-incomplete"),
  ]);
  const aged = new Date(Date.now() - UPLOAD_ORPHAN_GRACE_MS - 1_000);
  await Promise.all([utimes(orphanObject, aged, aged), utimes(interruptedUpload, aged, aged)]);

  const afterRestart = await readWorkspaceAfterRestart();
  assert.equal(afterRestart.courses[0]?.id, course.id);
  assert.equal(afterRestart.materials[0]?.id, material.id);
  await assert.rejects(() => readFile(orphanObject), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  await assert.rejects(() => readFile(interruptedUpload), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  assert.equal((await readFile(path.join(uploadsDirectory, material.objectKey))).toString("utf8"), sourceText);

  const downloaded = await readStoredMaterialFile(material.id);
  assert.equal(downloaded.material.name, "期末模拟卷.pdf");
  assert.equal(downloaded.buffer.toString("utf8"), sourceText);

  const { GET: downloadRoute } = await import("../app/api/materials/[id]/download/route");
  const downloadResponse = await downloadRoute(
    new NextRequest(`http://localhost/api/materials/${material.id}/download`),
    { params: Promise.resolve({ id: material.id }) },
  );
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get("content-type"), "application/pdf");
  assert.match(downloadResponse.headers.get("content-disposition") ?? "", /attachment; filename\*=UTF-8''/);
  assert.equal(Buffer.from(await downloadResponse.arrayBuffer()).toString("utf8"), sourceText);

  await setMaterialStatus(material.id, "失败", "模拟 AI 服务不可用", "mock provider timeout");
  let workspace = await getWorkspace();
  assert.equal(workspace.materials[0]?.status, "失败");
  assert.equal(workspace.materials[0]?.error, "mock provider timeout");

  const analysisReservation = await beginMaterialAnalysis(material.id);
  workspace = await saveDocumentAnalysis(material.id, mockedDocumentAnalysis, analysisReservation.runId);
  assert.equal(workspace.materials[0]?.status, "已分析");
  assert.equal(workspace.materials[0]?.pages, 3);
  assert.deepEqual(workspace.documentAnalyses[material.id]?.keyPoints.map((point) => point.title), ["二重积分的区域变换"]);
  assert.equal(workspace.insights.some((item) => item.id.startsWith(`material-${material.id}-`) && item.title === "二重积分的区域变换"), true);
  assert.equal(workspace.questions.some((question) => question.id.startsWith(`material-${material.id}-`) && question.answer === "A"), true);

  workspace = await saveCourseSynthesis(course.id, mockedCourseSynthesis, createCourseSynthesisSourceSnapshot(workspace, course.id));
  assert.equal(workspace.courseSyntheses[course.id]?.summary, mockedCourseSynthesis.summary);
  assert.equal(workspace.insights.some((item) => item.id.startsWith(`synthesis-${course.id}-`) && item.title === "二重积分的区域变换"), true);
  assert.equal(workspace.insights.filter((item) => item.courseId === course.id).every((item) => item.id.startsWith(`synthesis-${course.id}-`)), true);
  assert.equal(workspace.questions.some((question) => question.id.startsWith(`synthesis-${course.id}-`) && question.answer === "区域"), true);

  const practiceAnswers = Object.fromEntries(
    workspace.questions
      .filter((question) => question.courseId === course.id)
      .map((question) => [question.id, question.answer]),
  );
  const result = await recordPractice(course.id, practiceAnswers, 4);
  assert.equal(result.correct, result.total);
  assert.equal(result.score, 100);
  assert.ok(result.workspace.courses.find((item) => item.id === course.id)!.mastery > 0);

  const nextTask = result.workspace.tasks.find((task) => task.courseId === course.id);
  assert.ok(nextTask, "an analyzed course should have a generated study task");
  workspace = await setTaskCompletion(nextTask.id, true);
  assert.equal(workspace.tasks.find((task) => task.id === nextTask.id)?.status, "已完成");

  // Crossing the mastery threshold changes the scheduled focus. It may retain
  // the same positional id, but must not inherit a completion for old work.
  workspace = (await recordPractice(course.id, practiceAnswers, 4)).workspace;
  workspace = (await recordPractice(course.id, practiceAnswers, 4)).workspace;
  const replannedTask = workspace.tasks.find((task) => task.id === nextTask.id);
  // Mastery 60–79 schedules the mid-band consolidation action instead of the
  // first-pass study action that was completed above.
  assert.equal(replannedTask?.title.includes("巩固「二重积分的区域变换」"), true);
  assert.equal(replannedTask?.status, "待完成", "a changed task must not inherit a stale completion");

  const finalWorkspace = await getWorkspace();
  assert.equal(finalWorkspace.materials[0]?.status, "已分析");
  assert.equal(finalWorkspace.courseSyntheses[course.id]?.highFrequencyPoints[0]?.title, "二重积分的区域变换");
  assert.equal(finalWorkspace.tasks.find((task) => task.id === nextTask.id)?.status, "待完成");
});

test("a stuck analysis reservation becomes retryable after the staleness window", async () => {
  const { course } = await createCourse({
    name: "操作系统",
    code: "OS-STALE-201",
    teacher: "测试老师",
    term: "2026 秋",
    examDate: "2026-12-30",
    priority: "高",
  });
  const { material } = await storeUploadedMaterial(course.id, makeStudyFile("操作系统模拟卷.pdf", "%PDF-mock\nstale analysis material"));

  const firstReservation = await beginMaterialAnalysis(material.id);
  await assert.rejects(
    () => beginMaterialAnalysis(material.id),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 409,
    "a fresh in-flight reservation must reject a concurrent re-analysis",
  );

  // Simulate a process that died mid-analysis: the persisted updatedAt is old,
  // so the next reservation must treat the lock as stale instead of failing forever.
  const statePath = path.join(temporaryDataDirectory, "workspace.json");
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as { materials: Array<{ id: string; updatedAt: string; analysisLease?: { runId: string; startedAt: string } }> };
  const record = persisted.materials.find((item) => item.id === material.id);
  assert.ok(record);
  assert.ok(record.analysisLease);
  record.analysisLease.startedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  await writeFile(statePath, `${JSON.stringify(persisted)}\n`, "utf8");

  const resumed = await beginMaterialAnalysis(material.id);
  assert.notEqual(resumed.runId, firstReservation.runId);
  assert.equal(resumed.workspace.materials.find((item) => item.id === material.id)?.status, "分析中");

  const publicMaterial = toPublicMaterial(resumed.workspace.materials.find((item) => item.id === material.id)!);
  const publicWorkspace = toPublicWorkspace(resumed.workspace);
  assert.equal("analysisLease" in publicMaterial, false, "analysis ownership tokens are server-only");
  assert.equal(JSON.stringify(publicWorkspace).includes(resumed.runId), false, "public workspace output must not contain an analysis run id");

  await assert.rejects(
    () => saveDocumentAnalysis(material.id, mockedDocumentAnalysis, firstReservation.runId),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 409,
    "a stale worker must not save over the replacement analysis",
  );
  await assert.rejects(
    () => failMaterialAnalysis(material.id, firstReservation.runId, "旧请求失败", "stale failure"),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 409,
    "a stale worker must not mark the replacement analysis as failed",
  );
  const active = await getWorkspace();
  assert.equal(active.materials.find((item) => item.id === material.id)?.analysisLease?.runId, resumed.runId);
  assert.equal(active.materials.find((item) => item.id === material.id)?.status, "分析中");

  const completed = await saveDocumentAnalysis(material.id, mockedDocumentAnalysis, resumed.runId);
  assert.equal(completed.materials.find((item) => item.id === material.id)?.status, "已分析");
  assert.equal(completed.materials.find((item) => item.id === material.id)?.analysisLease, undefined);
});

test("AI plan commits reject superseded runs and changed generation inputs", async () => {
  const { course } = await createCourse({
    name: "数据库系统",
    code: "DB-PLAN-CAS-301",
    teacher: "测试老师",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "高",
  });
  const firstReservation = await beginPlanGeneration();
  const secondReservation = await beginPlanGeneration();
  assert.equal(firstReservation.inputHash, secondReservation.inputHash, "identical inputs should have the same evidence hash");
  assert.notEqual(firstReservation.runId, secondReservation.runId, "each run still needs unique ownership");

  const date = secondReservation.context.availability[0]!.date;
  const tasks: StudyTask[] = [{
    id: `${date}-${course.id}-cas`,
    courseId: course.id,
    date,
    start: secondReservation.context.studyDayStart,
    duration: 30,
    title: "重点攻克 · 数据库并发控制",
    type: "复习",
    status: "待完成",
    reason: "测试 AI 计划 CAS",
  }];

  await assert.rejects(
    () => replacePlanWithGeneratedPlan(tasks, firstReservation),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 409 && /更新的计划生成请求/.test(error.message),
    "an older concurrent run must not overwrite the newer run",
  );
  const afterNewestCommit = await replacePlanWithGeneratedPlan(tasks, secondReservation);
  assert.equal(afterNewestCommit.planSource, "ai");
  assert.equal(afterNewestCommit.tasks.some((task) => task.id === tasks[0]!.id), true);
  assert.equal(afterNewestCommit.planGenerationLease, undefined);

  const staleReservation = await beginPlanGeneration();
  const privateState = await getWorkspace();
  const publicState = toPublicWorkspace(privateState);
  assert.equal("planGenerationLease" in publicState, false, "plan ownership tokens are server-only");
  assert.equal(JSON.stringify(publicState).includes(staleReservation.runId), false);

  await updateAvailability(staleReservation.context.availability.map((day, index) => ({
    ...day,
    minutes: index === 0 ? day.minutes + 15 : day.minutes,
  })));
  await assert.rejects(
    () => replacePlanWithGeneratedPlan(tasks, staleReservation),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 409 && /学习数据发生变化/.test(error.message),
    "a plan generated from stale availability must not be persisted",
  );
  await abandonPlanGeneration(staleReservation.runId);
});

test("availability contract matches the persisted 7-day plan window", async () => {
  await assert.rejects(
    () => updateAvailability(Array.from({ length: 8 }, (_, index) => ({ date: `2026-12-${String(index + 1).padStart(2, "0")}`, minutes: 60 }))),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 400 && /1–7 天/.test(error.message),
    "submitting more days than the rolling plan window keeps would silently drop data",
  );
});

test("download filenames are sanitized without mangling ordinary letters", () => {
  assert.equal(sanitizeDownloadFilename("周老师复习重点.pdf"), "周老师复习重点.pdf");
  assert.equal(sanitizeDownloadFilename("a/b\\c:d*e?f\"g<h>i|j\r\nk.pdf"), "a_b_c_d_e_f_g_h_i_j_k.pdf");
  assert.equal(sanitizeDownloadFilename(""), "download");
});

test("dates are computed in the learner timezone regardless of the host timezone", () => {
  // 2026-08-18T16:30Z is already 2026-08-19 in Shanghai but still 2026-08-18 in New York.
  const instant = new Date("2026-08-18T16:30:00.000Z");
  assert.equal(dateOnlyInTimeZone("Asia/Shanghai", instant), "2026-08-19");
  assert.equal(dateOnlyInTimeZone("America/New_York", instant), "2026-08-18");
  assert.match(dateOnlyInTimeZone("Not/AZone", instant), /^\d{4}-\d{2}-\d{2}$/, "invalid zones fall back to the host date without throwing");
});

test("uncompleted past-day tasks become missed records instead of vanishing", async () => {
  const { course } = await createCourse({ name: "编译原理", code: "COMPILE-401", teacher: "测试老师", term: "2026 秋", examDate: "2099-12-30", priority: "中" });
  const statePath = path.join(temporaryDataDirectory, "workspace.json");
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as { tasks: Array<{ id: string; courseId: string; date: string; start: string; duration: number; title: string; type: string; status: string; reason: string }> };
  persisted.tasks.push({ id: "missed-task-test", courseId: course.id, date: "2000-01-01", start: "18:30", duration: 45, title: "被错过的旧任务", type: "复习", status: "待完成", reason: "测试旧任务" });
  await writeFile(statePath, `${JSON.stringify(persisted)}\n`, "utf8");

  const rebuilt = await rebuildPlan();
  assert.equal(rebuilt.tasks.some((task) => task.id === "missed-task-test"), false, "past-day tasks leave the active plan");
  const missed = rebuilt.missedTasks.find((task) => task.id === "missed-task-test");
  assert.ok(missed, "the uncompleted past task must be preserved as missed");
  assert.equal(missed?.status, "已错过");
  assert.equal(missed?.title, "被错过的旧任务");

  const again = await rebuildPlan();
  assert.equal(again.missedTasks.filter((task) => task.id === "missed-task-test").length, 1, "missed records are deduplicated on later rebuilds");
});

test("profile study day start shifts every generated task time", async () => {
  const soon = dateOnlyInTimeZone("Asia/Shanghai", new Date(Date.now() + 2 * 86_400_000));
  const { course } = await createCourse({ name: "操作系统", code: "OS-START-501", teacher: "测试老师", term: "2026 秋", examDate: soon, priority: "高" });
  await updateWorkspaceProfile({ studyDayStart: "09:00" });
  const workspace = await getWorkspace();
  const tasks = workspace.tasks.filter((task) => task.courseId === course.id);
  assert.ok(tasks.length > 0);
  assert.ok(workspace.tasks.some((task) => task.start === "09:00"), "the first slot of the day starts at the configured time");
  assert.ok(workspace.tasks.every((task) => task.start >= "09:00"));
  assert.equal(workspace.tasks.some((task) => task.start === "18:30"), false, "the previous default start must not linger");
  await assert.rejects(
    () => updateWorkspaceProfile({ studyDayStart: "25:00" }),
    (error: unknown) => error instanceof WorkspaceStoreError && /HH:MM/.test(error.message),
    "invalid clock values must be rejected",
  );
});

test("fill-in answers require an exact match and partial submissions are not 100", async () => {
  const fillIn = { id: "q1", courseId: "c", type: "填空" as const, prompt: "画出积分____。", answer: "区域", explanation: "", source: "t", knowledge: "二重积分" };
  assert.equal(answerMatches(fillIn, "区域"), true);
  assert.equal(answerMatches(fillIn, "先画出积分区域再换序"), false);
  const choice = { id: "q2", courseId: "c", type: "单选" as const, prompt: "?", choices: ["A. 画出积分区域", "B. 直接积分"], answer: "A", explanation: "", source: "t", knowledge: "二重积分" };
  assert.equal(answerMatches(choice, "A. 画出积分区域"), true);
  assert.equal(answerMatches(choice, "not-a"), false);

  const { course } = await createCourse({ name: "线性代数", code: "LA-SCORE-601", teacher: "测试老师", term: "2026 秋", examDate: "2099-12-30", priority: "中" });
  const { material } = await storeUploadedMaterial(course.id, makeStudyFile("线代模拟.pdf", "%PDF-mock\nscoring"));
  const reservation = await beginMaterialAnalysis(material.id);
  const twoQuestions = {
    ...mockedDocumentAnalysis,
    generatedQuestions: [
      mockedDocumentAnalysis.generatedQuestions[0]!,
      { ...mockedDocumentAnalysis.generatedQuestions[0]!, id: "doc-q2", type: "填空" as const, prompt: "先画出积分____。", choices: [], answer: "区域", knowledge: "二重积分的区域变换" },
    ],
  };
  await saveDocumentAnalysis(material.id, twoQuestions, reservation.runId);
  const workspace = await getWorkspace();
  const questionIds = workspace.questions.filter((question) => question.courseId === course.id).map((question) => question.id);
  assert.equal(questionIds.length, 2);
  const partial = await recordPractice(course.id, { [questionIds[0]!]: workspace.questions.find((question) => question.id === questionIds[0])!.answer });
  assert.equal(partial.total, 2);
  assert.ok(partial.score <= 50, "answering one of two questions must not score 100");
  const publicState = toPublicWorkspace(partial.workspace);
  assert.equal("answer" in (publicState.questions[0] ?? {}), false);
  assert.equal(publicState.documentAnalyses[material.id]?.generatedQuestions.length, 0);
});
