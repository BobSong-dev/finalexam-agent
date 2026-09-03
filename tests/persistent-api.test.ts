import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import type { CourseSynthesis, DocumentAnalysis } from "../lib/ai-types";
import { WorkspaceStoreError, beginMaterialAnalysis, createCourseSynthesisSourceSnapshot, getWorkspace as readWorkspace, recordPractice, saveCourseSynthesis, saveDocumentAnalysis } from "../lib/workspace-store";
import { POST as createCourse } from "../app/api/courses/route";
import { POST as createMaterial } from "../app/api/materials/route";
import { GET as getWorkspace, PATCH as patchWorkspace } from "../app/api/workspace/route";
import { GET as exportWorkspace } from "../app/api/workspace/export/route";
import { GET as downloadMaterial } from "../app/api/materials/[id]/download/route";
import { POST as submitAssessment } from "../app/api/assessments/submit/route";

async function multipartRequest(url: string, form: FormData): Promise<NextRequest> {
  const serialized = new Request(url, { method: "POST", body: form });
  const body = await serialized.arrayBuffer();
  const headers = new Headers(serialized.headers);
  headers.set("content-length", String(body.byteLength));
  return new NextRequest(url, { method: "POST", headers, body });
}

const documentAnalysis: DocumentAnalysis = {
  documentTitle: "mock.pdf",
  materialKind: "试卷",
  pageCount: 1,
  summary: "模拟资料。",
  confidence: "high",
  keyPoints: [
    { id: "duplicate", title: "极限", importance: 5, evidence: { label: "mock.pdf", location: "第 1 页", quote: "求极限" } },
    { id: "duplicate", title: "导数", importance: 4, evidence: { label: "mock.pdf", location: "第 1 页", quote: "求导数" } },
  ],
  questionPatterns: [],
  studyActions: ["完成练习。"],
  generatedQuestions: [{
    id: "duplicate-question",
    type: "单选",
    prompt: "选择正确选项。",
    choices: ["A. 正确", "B. 错误"],
    answer: "A",
    explanation: "模拟解析。",
    knowledge: "极限",
    sourceLocation: "第 1 页",
  }],
  warnings: [],
};

const synthesis: CourseSynthesis = {
  summary: "模拟综合。",
  highFrequencyPoints: [{
    id: "point",
    title: "极限",
    frequency: 1,
    mastery: 40,
    trend: "高频",
    sources: ["mock.pdf · 第 1 页"],
    summary: "模拟综合结果。",
  }],
  recommendedStudyActions: ["完成专项题。"],
  generatedQuestions: [],
  warnings: [],
};

test("persistent API validates inputs, hides storage internals, and invalidates stale synthesis", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), `finale-persistent-api-${process.pid}-`));
  const previousDataDirectory = process.env.FINALE_DATA_DIR;
  process.env.FINALE_DATA_DIR = dataDirectory;

  try {
  const malformedCourse = await createCourse(new NextRequest("http://localhost/api/courses", {
    method: "POST",
    body: "null",
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(malformedCourse.status, 400);

  const courseResponse = await createCourse(new NextRequest("http://localhost/api/courses", {
    method: "POST",
    body: JSON.stringify({
      name: "高等数学",
      code: "MATH-API-201",
      teacher: "测试老师",
      term: "2026 秋",
      examDate: "2030-12-20",
      priority: "高",
    }),
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(courseResponse.status, 201);
  const coursePayload = await courseResponse.json() as { course: { id: string } };

  const beforeTypeErrors = await readWorkspace();
  for (const field of ["displayName", "email", "school", "examGoal", "timezone", "studyDayStart"] as const) {
    const invalidTypeResponse = await patchWorkspace(new NextRequest("http://localhost/api/workspace", {
      method: "PATCH",
      body: JSON.stringify({ [field]: 42 }),
      headers: { "Content-Type": "application/json" },
    }));
    assert.equal(invalidTypeResponse.status, 400, `${field} must reject an explicitly supplied non-string value`);
    assert.match(await invalidTypeResponse.text(), new RegExp(field));
  }
  const afterTypeErrors = await readWorkspace();
  assert.equal(afterTypeErrors.updatedAt, beforeTypeErrors.updatedAt, "profile type errors must be rejected before storage is mutated");
  assert.equal(afterTypeErrors.auditLog.length, beforeTypeErrors.auditLog.length);

  const beforeInvalidPatch = await readWorkspace();
  const invalidCombinedPatch = await patchWorkspace(new NextRequest("http://localhost/api/workspace", {
    method: "PATCH",
    body: JSON.stringify({ displayName: "不应部分保存", availability: [] }),
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(invalidCombinedPatch.status, 400);
  const afterInvalidPatch = await readWorkspace();
  assert.equal(afterInvalidPatch.profile.displayName, beforeInvalidPatch.profile.displayName, "invalid availability must roll back the profile half of a combined PATCH");
  assert.equal(afterInvalidPatch.updatedAt, beforeInvalidPatch.updatedAt, "a rejected combined PATCH must not write workspace state");
  assert.equal(afterInvalidPatch.auditLog.length, beforeInvalidPatch.auditLog.length);

  const profileAuditCount = afterInvalidPatch.auditLog.filter((event) => event.action === "profile.updated").length;
  const availabilityAuditCount = afterInvalidPatch.auditLog.filter((event) => event.action === "availability.updated").length;
  const revisedAvailability = afterInvalidPatch.availability.map((entry, index) => ({
    ...entry,
    minutes: index === 0 ? (entry.minutes === 720 ? 719 : entry.minutes + 1) : entry.minutes,
  }));
  const availabilityOnlyPatch = await patchWorkspace(new NextRequest("http://localhost/api/workspace", {
    method: "PATCH",
    body: JSON.stringify({ availability: revisedAvailability }),
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(availabilityOnlyPatch.status, 200);
  const afterAvailabilityPatch = await readWorkspace();
  assert.equal(afterAvailabilityPatch.auditLog.filter((event) => event.action === "profile.updated").length, profileAuditCount, "availability-only PATCH must not emit a false profile audit");
  assert.equal(afterAvailabilityPatch.auditLog.filter((event) => event.action === "availability.updated").length, availabilityAuditCount + 1);

  const form = new FormData();
  form.append("courseId", coursePayload.course.id);
  // The extension, not a spoofable browser MIME value, must determine download type.
  form.append("file", new File([Buffer.from("%PDF-1.4 mock")], "notes.pdf", { type: "text/html" }));
  const materialResponse = await createMaterial(await multipartRequest("http://localhost/api/materials", form));
  assert.equal(materialResponse.status, 201);
  const materialPayload = await materialResponse.json() as { material: Record<string, unknown> };
  assert.equal(materialPayload.material.mimeType, "application/pdf");
  assert.equal("objectKey" in materialPayload.material, false);
  assert.equal("sha256" in materialPayload.material, false);

  const materialId = String(materialPayload.material.id);
  let analysisReservation = await beginMaterialAnalysis(materialId);
  await assert.rejects(() => beginMaterialAnalysis(materialId), (error: unknown) => {
    return Boolean(error && typeof error === "object" && "status" in error && error.status === 409);
  });

  let workspace = await saveDocumentAnalysis(materialId, documentAnalysis, analysisReservation.runId);
  const materialInsightIds = workspace.insights.filter((item) => item.courseId === coursePayload.course.id).map((item) => item.id);
  assert.equal(new Set(materialInsightIds).size, materialInsightIds.length, "untrusted model IDs cannot collide in persisted UI IDs");
  const wrongChoice = await recordPractice(coursePayload.course.id, { [`material-${materialId}-question-0`]: "not-a" });
  assert.equal(wrongChoice.score, 0, "an arbitrary answer containing A must not pass an A multiple-choice question");

  workspace = await saveCourseSynthesis(coursePayload.course.id, synthesis, createCourseSynthesisSourceSnapshot(workspace, coursePayload.course.id));
  assert.ok(workspace.courseSyntheses[coursePayload.course.id]);
  analysisReservation = await beginMaterialAnalysis(materialId);
  workspace = await saveDocumentAnalysis(materialId, documentAnalysis, analysisReservation.runId);
  assert.equal(workspace.courseSyntheses[coursePayload.course.id], undefined, "new document analysis invalidates an old course synthesis");
  assert.equal(workspace.insights.some((item) => item.id.startsWith(`synthesis-${coursePayload.course.id}-`)), false);

  const staleSnapshot = createCourseSynthesisSourceSnapshot(workspace, coursePayload.course.id);
  const revisedDocumentAnalysis = { ...documentAnalysis, summary: "更新后的资料分析结果。" };
  analysisReservation = await beginMaterialAnalysis(materialId);
  workspace = await saveDocumentAnalysis(materialId, revisedDocumentAnalysis, analysisReservation.runId);
  await assert.rejects(
    () => saveCourseSynthesis(coursePayload.course.id, synthesis, staleSnapshot),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 409,
    "course synthesis must not overwrite a newer material analysis",
  );
  assert.equal(workspace.courseSyntheses[coursePayload.course.id], undefined);

  const workspaceResponse = await getWorkspace();
  const workspaceBody = await workspaceResponse.text();
  assert.equal(workspaceResponse.status, 200);
  assert.equal(workspaceBody.includes("objectKey"), false);
  assert.equal(workspaceBody.includes("sha256"), false);
  assert.equal(workspaceBody.includes(dataDirectory), false);

  // The owner-facing export is a backup snapshot and therefore contains the
  // server-side storage keys that the public read hides.
  const exportResponse = await exportWorkspace(new NextRequest("http://localhost/api/workspace/export"));
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get("content-disposition") ?? "", /attachment/);
  const exportBody = await exportResponse.json() as { materials: Array<{ id: string; objectKey?: string; sha256?: string }> };
  assert.equal(typeof exportBody.materials.find((material) => material.id === materialId)?.objectKey, "string");

  const downloadResponse = await downloadMaterial(
    new NextRequest(`http://localhost/api/materials/${materialId}/download`),
    { params: Promise.resolve({ id: materialId }) },
  );
  assert.equal(downloadResponse.headers.get("content-type"), "application/pdf");
  assert.equal(downloadResponse.headers.get("x-content-type-options"), "nosniff");

  const invalidAssessment = await submitAssessment(new NextRequest("http://localhost/api/assessments/submit", {
    method: "POST",
    body: JSON.stringify({ courseId: coursePayload.course.id, answers: null }),
    headers: { "Content-Type": "application/json" },
  }));
    assert.equal(invalidAssessment.status, 400);
  } finally {
    if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
    else process.env.FINALE_DATA_DIR = previousDataDirectory;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
