import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentAnalysis } from "../lib/ai-types";
import {
  beginMaterialAnalysis,
  createCourse,
  findReusableAnalysis,
  getWorkspace,
  saveDocumentAnalysis,
  saveReusedAnalysis,
  storeUploadedMaterial,
} from "../lib/workspace-store";

const temporaryDataDirectory = path.join(
  os.tmpdir(),
  `finale-reuse-${process.pid}-${randomUUID()}`,
);
const previousDataDirectory = process.env.FINALE_DATA_DIR;
process.env.FINALE_DATA_DIR = temporaryDataDirectory;

test.after(async () => {
  if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
  else process.env.FINALE_DATA_DIR = previousDataDirectory;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

const ANALYSIS: DocumentAnalysis = {
  documentTitle: "复用测试卷.pdf",
  materialKind: "试卷",
  pageCount: 3,
  summary: "同一份文件的分析结果。",
  confidence: "high",
  keyPoints: [
    {
      id: "k1",
      title: "极限的计算",
      importance: 4,
      evidence: { label: "卷", location: "第 1 页", quote: "求极限" },
    },
  ],
  questionPatterns: [],
  studyActions: ["先化简"],
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
  ],
  warnings: [],
};

const PDF_BYTES = Buffer.from("%PDF-1.4\nidentical content\n");

test("an identical file reuses the saved analysis instead of calling the model again", async () => {
  const { course: first } = await createCourse({
    name: "复用课程 A",
    code: "REUSE-A",
    teacher: "t",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "高",
  });
  const { course: second } = await createCourse({
    name: "复用课程 B",
    code: "REUSE-B",
    teacher: "t",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "中",
  });

  const { material: original } = await storeUploadedMaterial(
    first.id,
    new File([PDF_BYTES], "原卷.pdf", { type: "application/pdf" }),
  );
  const reservation = await beginMaterialAnalysis(original.id);
  await saveDocumentAnalysis(original.id, ANALYSIS, reservation.runId);

  // 另一门课上传统一份文件：内容相同 → 可以复用。
  const { material: duplicate } = await storeUploadedMaterial(
    second.id,
    new File([PDF_BYTES], "副本.pdf", { type: "application/pdf" }),
  );
  const reusable = await findReusableAnalysis(duplicate.id);
  assert.ok(reusable, "identical bytes are detected across courses");
  assert.equal(reusable.sourceName, "原卷.pdf");

  const duplicateReservation = await beginMaterialAnalysis(duplicate.id);
  assert.equal(
    await saveReusedAnalysis(
      duplicate.id,
      duplicateReservation.runId,
      reusable.analysis,
      reusable.sourceName,
    ),
    true,
  );

  const workspace = await getWorkspace();
  const saved = workspace.materials.find((item) => item.id === duplicate.id)!;
  assert.equal(saved.status, "已分析");
  assert.match(saved.source, /复用了《原卷.pdf》/);
  assert.equal(saved.analysisLease, undefined);
  assert.ok(workspace.auditLog.some((event) => event.action === "material.analysis_reused"));
  assert.equal(
    workspace.profile.aiUsage?.requests ?? 0,
    0,
    "reuse must not be counted as an AI request",
  );

  // 复用结果同样生成了考点与练习题。
  assert.ok(
    workspace.insights.some(
      (insight) =>
        insight.id.startsWith(`material-${duplicate.id}-`) && insight.title === "极限的计算",
    ),
  );
  assert.ok(
    workspace.questions.some((question) => question.id.startsWith(`material-${duplicate.id}-`)),
  );
});

test("a stale lease makes reuse fall back to a real analysis", async () => {
  const { course } = await createCourse({
    name: "复用课程 C",
    code: "REUSE-C",
    teacher: "t",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "中",
  });
  const { material } = await storeUploadedMaterial(
    course.id,
    new File([PDF_BYTES], "再一份.pdf", { type: "application/pdf" }),
  );
  const reservation = await beginMaterialAnalysis(material.id);
  const reusable = await findReusableAnalysis(material.id);
  assert.ok(reusable);

  // 用错误的 runId 保存必须失败（说明租约仍然有效，调用方应继续真实分析）。
  assert.equal(
    await saveReusedAnalysis(
      material.id,
      "not-the-current-run",
      reusable.analysis,
      reusable.sourceName,
    ),
    false,
  );
  assert.equal(
    (await getWorkspace()).materials.find((item) => item.id === material.id)!.status,
    "分析中",
  );
  assert.equal(
    await saveReusedAnalysis(
      material.id,
      reservation.runId,
      reusable.analysis,
      reusable.sourceName,
    ),
    true,
  );
});

test("different bytes are never reused", async () => {
  const { course } = await createCourse({
    name: "复用课程 D",
    code: "REUSE-D",
    teacher: "t",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "中",
  });
  const { material } = await storeUploadedMaterial(
    course.id,
    new File([Buffer.from("%PDF-1.4\n完全不同\n")], "另一份.pdf", { type: "application/pdf" }),
  );
  assert.equal(await findReusableAnalysis(material.id), undefined);
});
