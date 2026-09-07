import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as submitAssessment } from "../app/api/assessments/submit/route";
import { POST as createCourse } from "../app/api/courses/route";
import { POST as synthesizeCourse } from "../app/api/courses/[id]/synthesize/route";
import { POST as createMaterial } from "../app/api/materials/route";
import { POST as analyzeMaterial } from "../app/api/materials/[id]/analyze/route";
import { GET as downloadMaterial } from "../app/api/materials/[id]/download/route";
import { PATCH as updateTask } from "../app/api/tasks/[id]/route";
import { GET as getPublicWorkspace } from "../app/api/workspace/route";

const execFile = promisify(execFileCallback);
const temporaryDataDirectory = path.join(os.tmpdir(), `finale-workspace-api-${process.pid}-${randomUUID()}`);
const previousDataDirectory = process.env.FINALE_DATA_DIR;

process.env.FINALE_DATA_DIR = temporaryDataDirectory;

async function multipartRequest(url: string, form: FormData): Promise<NextRequest> {
  const serialized = new Request(url, { method: "POST", body: form });
  const body = await serialized.arrayBuffer();
  const headers = new Headers(serialized.headers);
  headers.set("content-length", String(body.byteLength));
  return new NextRequest(url, { method: "POST", headers, body });
}

test.after(async () => {
  if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
  else process.env.FINALE_DATA_DIR = previousDataDirectory;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function responseEnvelope(outputText: string) {
  return {
    id: "resp_workspace_mock",
    object: "response",
    created_at: 1,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 6000,
    model: "gpt-5-mini",
    output: [{
      id: "msg_workspace_mock",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: outputText, annotations: [] }],
    }],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "json_schema" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    user: null,
    metadata: {},
  };
}

const documentAnalysis = {
  documentTitle: "垂直集成模拟卷.pdf",
  materialKind: "试卷",
  pageCount: 2,
  summary: "模拟资料反复考查二重积分的区域变换。",
  confidence: "high",
  keyPoints: [{
    id: "double-integral",
    title: "二重积分的区域变换",
    importance: 5,
    evidence: { label: "垂直集成模拟卷.pdf", location: "第 2 页，第 3 题", quote: "先画出积分区域，再交换积分次序。" },
  }],
  questionPatterns: [{
    title: "区域变换计算题",
    type: "计算题",
    description: "先确定积分区域边界后换序。",
    evidence: { label: "垂直集成模拟卷.pdf", location: "第 2 页，第 3 题", quote: "交换积分次序后计算。" },
  }],
  studyActions: ["完成三道区域变换变式题。"],
  generatedQuestions: [{
    id: "document-question",
    type: "单选",
    prompt: "二重积分换序前最先应该做什么？",
    choices: ["A. 画出积分区域", "B. 直接积分", "C. 背诵答案", "D. 跳过题目"],
    answer: "A",
    explanation: "区域决定新的积分限。",
    knowledge: "二重积分的区域变换",
    sourceLocation: "第 2 页，第 3 题",
  }],
  warnings: [],
};

const courseSynthesis = {
  summary: "本课程应优先复习二重积分的区域变换。",
  highFrequencyPoints: [{
    id: "double-integral-course",
    title: "二重积分的区域变换",
    frequency: 1,
    mastery: 35,
    trend: "高频",
    sources: ["垂直集成模拟卷.pdf · 第 2 页，第 3 题"],
    summary: "上传资料中的计算题明确要求区域变换。",
  }],
  recommendedStudyActions: ["先画区域，再做限时计算。"],
  generatedQuestions: [{
    id: "course-question",
    type: "填空",
    prompt: "二重积分换序前应先画出积分____。",
    choices: [],
    answer: "区域",
    explanation: "积分区域决定上下限。",
    knowledge: "二重积分的区域变换",
    sourceLocation: "课程综合 · 第 2 页",
  }],
  warnings: [],
};

async function startOpenAiCompatibleMock() {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const record = { method: request.method ?? "", path: request.url ?? "", body };
    requests.push(record);

    if (record.method === "POST" && record.path === "/v1/files") {
      sendJson(response, {
        id: "file_workspace_mock",
        object: "file",
        bytes: 64,
        created_at: 1,
        filename: "vertical.pdf",
        purpose: "user_data",
        status: "processed",
      });
      return;
    }
    if (record.method === "POST" && record.path === "/v1/responses") {
      const output = record.body.includes("final_exam_course_synthesis") ? courseSynthesis : documentAnalysis;
      sendJson(response, responseEnvelope(JSON.stringify(output)));
      return;
    }
    if (record.method === "DELETE" && record.path === "/v1/files/file_workspace_mock") {
      sendJson(response, { id: "file_workspace_mock", object: "file", deleted: true });
      return;
    }
    sendJson(response, { error: { message: `unexpected ${record.method} ${record.path}` } }, 404);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function jsonRequest(pathname: string, body: unknown, extraHeaders: HeadersInit = {}): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  assert.ok(text, `expected a JSON response for ${response.url || "route handler"}`);
  return JSON.parse(text) as T;
}

function assertNoPrivateStorageFields(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /"objectKey"\s*:/);
  assert.doesNotMatch(serialized, /"sha256"\s*:/);
}

async function readPersistedWorkspaceInFreshProcess() {
  const program = [
    'import { getWorkspace, toPublicWorkspace } from "./lib/workspace-store.ts";',
    "process.stdout.write(JSON.stringify(toPublicWorkspace(await getWorkspace())));",
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
  return JSON.parse(stdout) as { courses: Array<{ id: string; mastery: number }>; materials: Array<{ id: string; status: string }>; tasks: Array<{ id: string; status: string }>; questions: Array<{ id: string }> };
}

test("persistent API routes complete the upload-to-practice workflow against an OpenAI-compatible provider", async () => {
  const provider = await startOpenAiCompatibleMock();
  const aiHeaders = {
    "x-openai-api-key": "test-key",
    "x-openai-base-url": provider.baseUrl,
  };

  try {
    const courseResponse = await createCourse(jsonRequest("/api/courses", {
      name: "高等数学（下）",
      code: "MATH-VERTICAL-201",
      teacher: "集成测试老师",
      term: "2026 秋",
      examDate: "2099-12-30",
      priority: "高",
    }));
    assert.equal(courseResponse.status, 201);
    const coursePayload = await responseJson<{ course: { id: string }; workspace: unknown }>(courseResponse);
    const courseId = coursePayload.course.id;
    assert.ok(courseId);
    assertNoPrivateStorageFields(coursePayload);

    const form = new FormData();
    const originalBytes = Buffer.from("%PDF-1.4\nvertical API integration material\n", "utf8");
    form.set("courseId", courseId);
    form.set("file", new File([originalBytes], "vertical.pdf", { type: "application/pdf" }));
    const materialResponse = await createMaterial(await multipartRequest("http://localhost/api/materials", form));
    assert.equal(materialResponse.status, 201);
    const materialPayload = await responseJson<{ material: { id: string; status: string; objectKey?: string; sha256?: string }; workspace: unknown }>(materialResponse);
    const materialId = materialPayload.material.id;
    assert.equal(materialPayload.material.status, "待分析");
    assert.equal(materialPayload.material.objectKey, undefined);
    assert.equal(materialPayload.material.sha256, undefined);
    assertNoPrivateStorageFields(materialPayload);

    const analysisResponse = await analyzeMaterial(
      jsonRequest(`/api/materials/${materialId}/analyze`, { model: "gpt-5-mini" }, aiHeaders),
      routeContext(materialId) as never,
    );
    assert.equal(analysisResponse.status, 200);
    const analysisPayload = await responseJson<{
      analysis: { keyPoints: Array<{ title: string }>; generatedQuestions: Array<{ id: string; answer: string }> };
      workspace: { materials: Array<{ id: string; status: string }>; insights: Array<{ title: string }>; questions: Array<{ id: string; answer: string }> };
    }>(analysisResponse);
    assert.equal(analysisPayload.analysis.keyPoints[0]?.title, "二重积分的区域变换");
    assert.equal(analysisPayload.workspace.materials.find((material) => material.id === materialId)?.status, "已分析");
    assert.equal(analysisPayload.workspace.insights.some((item) => item.title === "二重积分的区域变换"), true);
    assert.equal(analysisPayload.analysis.generatedQuestions.some((item) => item.answer === "A"), true);
    assert.equal(analysisPayload.workspace.questions.every((item) => !("answer" in item)), true);
    assertNoPrivateStorageFields(analysisPayload);

    const synthesisResponse = await synthesizeCourse(
      jsonRequest(`/api/courses/${courseId}/synthesize`, { model: "gpt-5-mini" }, aiHeaders),
      routeContext(courseId),
    );
    assert.equal(synthesisResponse.status, 200);
    const synthesisPayload = await responseJson<{
      analysis: { highFrequencyPoints: Array<{ title: string }> };
      workspace: { questions: Array<{ id: string; answer: string }>; insights: Array<{ title: string }>; tasks: Array<{ id: string }> };
    }>(synthesisResponse);
    assert.equal(synthesisPayload.analysis.highFrequencyPoints[0]?.title, "二重积分的区域变换");
    assert.equal(synthesisPayload.workspace.insights.some((item) => item.title === "二重积分的区域变换"), true);
    assert.ok(synthesisPayload.workspace.tasks[0]?.id, "course synthesis should leave a persisted study plan");
    assertNoPrivateStorageFields(synthesisPayload);

    const knownAnswers = [...documentAnalysis.generatedQuestions, ...courseSynthesis.generatedQuestions].map((question) => question.answer);
    const answers = Object.fromEntries(synthesisPayload.workspace.questions.map((question, index) => [question.id, knownAnswers[index] ?? ""]));
    const assessmentResponse = await submitAssessment(jsonRequest("/api/assessments/submit", {
      courseId,
      answers,
      selfRating: 4,
    }));
    assert.equal(assessmentResponse.status, 200);
    const assessmentPayload = await responseJson<{ correct: number; total: number; score: number; workspace: { courses: Array<{ id: string; mastery: number }>; tasks: Array<{ id: string; status: string }> } }>(assessmentResponse);
    assert.equal(assessmentPayload.correct, assessmentPayload.total);
    assert.equal(assessmentPayload.score, 100);
    assert.ok(assessmentPayload.workspace.courses.find((course) => course.id === courseId)!.mastery > 0);
    assertNoPrivateStorageFields(assessmentPayload);

    const taskId = assessmentPayload.workspace.tasks.find((task) => task.id === synthesisPayload.workspace.tasks[0]?.id)?.id;
    assert.ok(taskId);
    const taskResponse = await updateTask(
      new NextRequest(`http://localhost/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ completed: true }),
      }),
      routeContext(taskId) as never,
    );
    assert.equal(taskResponse.status, 200);
    const taskPayload = await responseJson<{ tasks: Array<{ id: string; status: string }> }>(taskResponse);
    assert.equal(taskPayload.tasks.find((task) => task.id === taskId)?.status, "已完成");
    assertNoPrivateStorageFields(taskPayload);

    const downloadResponse = await downloadMaterial(
      new NextRequest(`http://localhost/api/materials/${materialId}/download`),
      routeContext(materialId) as never,
    );
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get("content-type"), "application/pdf");
    assert.match(downloadResponse.headers.get("content-disposition") ?? "", /attachment; filename\*=UTF-8''vertical.pdf/);
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), originalBytes);

    const workspaceResponse = await getPublicWorkspace(new NextRequest("http://localhost/api/workspace"));
    assert.equal(workspaceResponse.status, 200);
    const publicWorkspace = await responseJson<{
      courses: Array<{ id: string; mastery: number }>;
      materials: Array<{ id: string; status: string; objectKey?: string; sha256?: string }>;
      tasks: Array<{ id: string; status: string }>;
      questions: Array<{ id: string }>;
    }>(workspaceResponse);
    assert.equal(publicWorkspace.materials.find((material) => material.id === materialId)?.status, "已分析");
    assert.equal(publicWorkspace.tasks.find((task) => task.id === taskId)?.status, "已完成");
    assert.equal(publicWorkspace.materials[0]?.objectKey, undefined);
    assert.equal(publicWorkspace.materials[0]?.sha256, undefined);
    assertNoPrivateStorageFields(publicWorkspace);

    const afterRestart = await readPersistedWorkspaceInFreshProcess();
    assert.equal(afterRestart.courses.find((course) => course.id === courseId)?.mastery, publicWorkspace.courses.find((course) => course.id === courseId)?.mastery);
    assert.equal(afterRestart.materials.find((material) => material.id === materialId)?.status, "已分析");
    assert.equal(afterRestart.tasks.find((task) => task.id === taskId)?.status, "已完成");
    assert.ok(afterRestart.questions.length >= 2);
    assertNoPrivateStorageFields(afterRestart);

    assert.deepEqual(provider.requests.map((request) => `${request.method} ${request.path}`), [
      "POST /v1/files",
      "POST /v1/responses",
      "DELETE /v1/files/file_workspace_mock",
      "POST /v1/responses",
    ]);
    assert.match(provider.requests[1]?.body ?? "", /file_workspace_mock/);
    assert.match(provider.requests[3]?.body ?? "", /final_exam_course_synthesis/);
  } finally {
    await provider.close();
  }
});
