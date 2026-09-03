import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { beginMaterialAnalysis, createCourse, getWorkspace, saveDocumentAnalysis, storeUploadedMaterial, updateAvailability } from "../lib/workspace-store";
import type { DocumentAnalysis } from "../lib/ai-types";
import { POST as generatePlan } from "../app/api/plan/generate/route";

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
    id: "resp_plan_mock",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 4000,
    model: "gpt-5-mini",
    output: [{ id: "msg_plan_mock", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: outputText, annotations: [] }] }],
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

const documentAnalysis: DocumentAnalysis = {
  documentTitle: "plan.pdf",
  materialKind: "试卷",
  pageCount: 1,
  summary: "哈希冲突处理是本卷重点。",
  confidence: "high",
  keyPoints: [{ id: "hash", title: "哈希冲突处理", importance: 5, evidence: { label: "plan.pdf", location: "第 1 页", quote: "冲突次数统计" } }],
  questionPatterns: [],
  studyActions: ["完成冲突处理练习。"],
  generatedQuestions: [],
  warnings: [],
};

test("plan/generate calls the AI for the persisted plan and honestly falls back without a key", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), `finale-plan-ai-${process.pid}-`));
  const environment = process.env as Record<string, string | undefined>;
  const previous = {
    dataDir: environment.FINALE_DATA_DIR,
    apiKey: environment.OPENAI_API_KEY,
    aiKey: environment.AI_API_KEY,
    nodeEnv: environment.NODE_ENV,
    serverKeyAccess: environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY,
    customBaseUrl: environment.AI_ALLOW_CUSTOM_BASE_URL,
  };
  let providerRequests: string[] = [];
  let blockedPlan: { started: () => void; wait: Promise<void> } | undefined;

  const provider = createServer(async (request, response) => {
    const body = await readBody(request);
    providerRequests.push(body);
    if (request.method === "POST" && request.url === "/v1/responses" && body.includes("final_exam_study_plan")) {
      const block = blockedPlan;
      blockedPlan = undefined;
      if (block) {
        block.started();
        await block.wait;
      }
      // Reuse the first availability date the route supplied so the mock plan
      // lands inside the persisted window. The input text is embedded in the
      // provider request body, so the quotes are JSON-escaped.
      const date = body.match(/\\"date\\":\\"(\d{4}-\d{2}-\d{2})\\"/)?.[1] ?? "2099-01-01";
      const plan = {
        plan: [{ date, courseCode: "PLAN-AI-201", type: "复习", durationMinutes: 60, focus: "哈希冲突处理", reason: "依据重要度 5/5" }],
      };
      sendJson(response, responseEnvelope(JSON.stringify(plan)));
      return;
    }
    sendJson(response, { error: { message: `unexpected ${request.method} ${request.url}` } }, 404);
  });
  await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", () => resolve()); });
  const providerPort = (provider.address() as AddressInfo).port;

  try {
    environment.FINALE_DATA_DIR = dataDirectory;
    delete environment.OPENAI_API_KEY;
    delete environment.AI_API_KEY;
    const { course } = await createCourse({ name: "算法设计", code: "PLAN-AI-201", teacher: "测试老师", term: "2026 秋", examDate: "2099-12-30", priority: "高" });
    const { material } = await storeUploadedMaterial(course.id, new File([Buffer.from("%PDF-1.4 plan")], "plan.pdf", { type: "application/pdf" }));
    const analysisReservation = await beginMaterialAnalysis(material.id);
    await saveDocumentAnalysis(material.id, documentAnalysis, analysisReservation.runId);

    environment.NODE_ENV = "production";
    environment.OPENAI_API_KEY = "server-only-secret";
    environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY = "true";
    environment.AI_ALLOW_CUSTOM_BASE_URL = "true";
    const requestsBeforeGuard = providerRequests.length;
    const guardedResponse = await generatePlan(new NextRequest("http://localhost/api/plan/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openai-base-url": `http://127.0.0.1:${providerPort}/v1`,
      },
      body: "{}",
    }));
    assert.equal(guardedResponse.status, 403, "a browser endpoint must not receive the server environment key");
    assert.match(String((await guardedResponse.json() as { error?: string }).error), /会话 Key/);
    assert.equal(providerRequests.length, requestsBeforeGuard, "credential pairing must be rejected before any provider request");

    delete environment.OPENAI_API_KEY;
    delete environment.AI_API_KEY;
    if (previous.nodeEnv === undefined) delete environment.NODE_ENV; else environment.NODE_ENV = previous.nodeEnv;
    if (previous.serverKeyAccess === undefined) delete environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY; else environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY = previous.serverKeyAccess;
    if (previous.customBaseUrl === undefined) delete environment.AI_ALLOW_CUSTOM_BASE_URL; else environment.AI_ALLOW_CUSTOM_BASE_URL = previous.customBaseUrl;

    const aiResponse = await generatePlan(new NextRequest("http://localhost/api/plan/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openai-api-key": "plan-test-key",
        "x-openai-base-url": `http://127.0.0.1:${providerPort}/v1`,
      },
      body: "{}",
    }));
    assert.equal(aiResponse.status, 200);
    const aiPayload = await aiResponse.json() as { generatedBy?: string; workspace?: { planSource?: string; tasks: Array<{ date: string; duration: number; courseId: string }>; availability: Array<{ date: string; minutes: number }> } };
    assert.equal(aiPayload.generatedBy, "ai", "a configured key must produce a real AI-generated plan");
    assert.equal(aiPayload.workspace?.planSource, "ai");
    assert.ok((aiPayload.workspace?.tasks.length ?? 0) > 0);
    const capacity = new Map((aiPayload.workspace?.availability ?? []).map((day) => [day.date, day.minutes]));
    for (const task of aiPayload.workspace?.tasks ?? []) {
      assert.ok(capacity.has(task.date), "AI plan dates must stay inside the persisted window");
      capacity.set(task.date, (capacity.get(task.date) ?? 0) - task.duration);
    }
    assert.ok([...capacity.values()].every((minutes) => minutes >= 0), "AI plan must never exceed daily capacity");
    assert.ok(providerRequests.some((body) => body.includes("final_exam_study_plan")));

    let markProviderStarted!: () => void;
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
    blockedPlan = { started: markProviderStarted, wait: providerRelease };
    const staleGeneration = generatePlan(new NextRequest("http://localhost/api/plan/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openai-api-key": "plan-test-key",
        "x-openai-base-url": `http://127.0.0.1:${providerPort}/v1`,
      },
      body: "{}",
    }));
    await providerStarted;
    try {
      const duringGeneration = await getWorkspace();
      await updateAvailability(duringGeneration.availability.map((day, index) => ({
        ...day,
        minutes: index === 0 ? day.minutes + 15 : day.minutes,
      })));
    } finally {
      releaseProvider();
    }
    const staleResponse = await staleGeneration;
    assert.equal(staleResponse.status, 409, "a plan generated from changed inputs must be rejected at commit time");
    assert.match(String((await staleResponse.json() as { error?: string }).error), /学习数据发生变化/);
    const afterStaleResponse = await getWorkspace();
    assert.equal(afterStaleResponse.planSource, "schedule", "the stale AI result must not replace the newer local replan");
    assert.equal(afterStaleResponse.planGenerationLease, undefined, "a failed commit releases its own reservation");

    const fallbackResponse = await generatePlan(new NextRequest("http://localhost/api/plan/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(fallbackResponse.status, 200);
    const fallbackPayload = await fallbackResponse.json() as { generatedBy?: string; workspace?: { planSource?: string; tasks: Array<{ courseId: string }> } };
    assert.equal(fallbackPayload.generatedBy, "schedule", "without a key the deterministic scheduler must be labeled honestly");
    assert.equal(fallbackPayload.workspace?.planSource, "schedule");
    assert.ok((fallbackPayload.workspace?.tasks.length ?? 0) > 0);
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    if (previous.dataDir === undefined) delete environment.FINALE_DATA_DIR; else environment.FINALE_DATA_DIR = previous.dataDir;
    if (previous.apiKey === undefined) delete environment.OPENAI_API_KEY; else environment.OPENAI_API_KEY = previous.apiKey;
    if (previous.aiKey === undefined) delete environment.AI_API_KEY; else environment.AI_API_KEY = previous.aiKey;
    if (previous.nodeEnv === undefined) delete environment.NODE_ENV; else environment.NODE_ENV = previous.nodeEnv;
    if (previous.serverKeyAccess === undefined) delete environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY; else environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY = previous.serverKeyAccess;
    if (previous.customBaseUrl === undefined) delete environment.AI_ALLOW_CUSTOM_BASE_URL; else environment.AI_ALLOW_CUSTOM_BASE_URL = previous.customBaseUrl;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
