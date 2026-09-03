import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDataDirectory = await mkdtemp(path.join(os.tmpdir(), "finale-http-e2e-"));
const temporaryRuntimeRoot = await mkdtemp(path.join(os.tmpdir(), "finale-http-runtime-"));
const standaloneRuntimeDirectory = path.join(temporaryRuntimeRoot, "app");
const providerRequests = [];

async function prepareStandaloneRuntime() {
  // Mirror the Docker image layout: standalone contents live at /app and the
  // separately emitted static assets live at /app/.next/static.
  await cp(path.join(projectRoot, ".next", "standalone"), standaloneRuntimeDirectory, { recursive: true });
  await cp(
    path.join(projectRoot, ".next", "static"),
    path.join(standaloneRuntimeDirectory, ".next", "static"),
    { recursive: true },
  );
}

function outputEnvelope(outputText) {
  return {
    id: "resp_http_smoke",
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
      id: "msg_http_smoke",
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
  documentTitle: "http-smoke.pdf",
  materialKind: "试卷",
  pageCount: 1,
  summary: "Mock analysis for the full HTTP workflow.",
  confidence: "high",
  keyPoints: [{
    id: "limit",
    title: "极限计算",
    importance: 5,
    evidence: { label: "http-smoke.pdf", location: "第 1 页", quote: "求极限" },
  }],
  questionPatterns: [{
    title: "基础计算",
    type: "填空",
    description: "计算函数极限。",
    evidence: { label: "http-smoke.pdf", location: "第 1 页", quote: "求极限" },
  }],
  studyActions: ["完成三道极限计算练习。"],
  generatedQuestions: [{
    id: "document-q",
    type: "填空",
    prompt: "求极限前应先识别什么？",
    choices: [],
    answer: "表达式结构",
    explanation: "先判断可化简结构。",
    knowledge: "极限计算",
    sourceLocation: "第 1 页",
  }],
  warnings: [],
};

const courseSynthesis = {
  summary: "Course synthesis from the saved document analysis.",
  highFrequencyPoints: [{
    id: "limit-course",
    title: "极限计算",
    frequency: 1,
    mastery: 35,
    trend: "需巩固",
    sources: ["http-smoke.pdf · 第 1 页"],
    summary: "The supplied material tests limit calculation.",
  }],
  recommendedStudyActions: ["先化简再完成限时练习。"],
  generatedQuestions: [{
    id: "course-q",
    type: "填空",
    prompt: "极限题先识别表达式的什么？",
    choices: [],
    answer: "结构",
    explanation: "结构决定化简策略。",
    knowledge: "极限计算",
    sourceLocation: "课程综合 · 第 1 页",
  }],
  warnings: [],
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function freePort() {
  const server = createNetServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function applicationPort() {
  // Avoid the race inherent in reserving and then closing an ephemeral port
  // before the standalone server is spawned. A random high port is retried by
  // the smoke test's health probe if another local process happens to use it.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = 38000 + Math.floor(Math.random() * 12000);
    const probe = createNetServer();
    try {
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(candidate, "127.0.0.1", resolve);
      });
      await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      return candidate;
    } catch {
      await new Promise((resolve) => probe.close(() => resolve()));
    }
  }
  throw new Error("could not find a free local port for the standalone smoke test");
}

function startProvider() {
  return createServer(async (request, response) => {
    const body = await readBody(request);
    const record = { method: request.method ?? "", path: request.url ?? "", body };
    providerRequests.push(record);
    if (record.method === "POST" && record.path === "/v1/files") {
      return json(response, { id: "file_http_smoke", object: "file", bytes: 32, created_at: 1, filename: "http-smoke.pdf", purpose: "user_data", status: "processed" });
    }
    if (record.method === "POST" && record.path === "/v1/responses") {
      if (body.includes("final_exam_study_plan")) {
        const date = body.match(/\\"date\\":\\"(\d{4}-\d{2}-\d{2})\\"/)?.[1] ?? "2099-12-30";
        const courseCode = body.match(/\\"code\\":\\"(HTTP-[A-Za-z0-9]+)\\"/)?.[1] ?? "UNKNOWN";
        return json(response, outputEnvelope(JSON.stringify({
          plan: [{ date, courseCode, type: "复习", durationMinutes: 45, focus: "极限计算", reason: "依据重要度 5/5" }],
        })));
      }
      const result = body.includes("final_exam_course_synthesis") ? courseSynthesis : documentAnalysis;
      return json(response, outputEnvelope(JSON.stringify(result)));
    }
    if (record.method === "DELETE" && record.path === "/v1/files/file_http_smoke") {
      return json(response, { id: "file_http_smoke", object: "file", deleted: true });
    }
    return json(response, { error: { message: "unexpected mock provider request" } }, 404);
  });
}

function startApplication(port, providerPort) {
  // Exercise the same standalone entry point used by the production Docker
  // image rather than `next start`, whose semantics differ when output is
  // configured as "standalone".
  const standaloneServer = path.join(standaloneRuntimeDirectory, "server.js");
  const output = [];
  const app = spawn(process.execPath, [standaloneServer], {
    cwd: standaloneRuntimeDirectory,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      FINALE_DATA_DIR: temporaryDataDirectory,
      OPENAI_API_KEY: "http-smoke-key",
      OPENAI_MODEL: "gpt-5-mini",
      OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      AI_ALLOW_UNAUTHENTICATED_SERVER_KEY: "true",
      AI_ALLOW_CUSTOM_BASE_URL: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  app.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  app.on("error", (error) => output.push(`spawn error: ${error.message}\n`));
  app.on("exit", (code, signal) => output.push(`standalone server exited: code=${code} signal=${signal}\n`));
  return { app, output };
}

async function waitForHealth(appUrl) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${appUrl}/api/health`);
      if (response.ok) return response;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("application did not become healthy");
}

async function stop(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill();
  await new Promise((resolve) => processHandle.once("exit", resolve));
}

async function expectJson(response, expectedStatus) {
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text);
}

function staticAssetUrlsFromHtml(html, pageUrl) {
  const page = new URL(pageUrl);
  const assets = new Set();
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      const url = new URL(match[2].replaceAll("&amp;", "&"), page);
      if (url.origin !== page.origin || !url.pathname.startsWith("/_next/static/")) continue;
      url.hash = "";
      assets.add(url.href);
    } catch {
      // Ignore malformed or non-URL attributes; only valid same-origin static
      // asset references are part of this production-layout assertion.
    }
  }
  return [...assets].sort();
}

function expectedStaticContentType(pathname) {
  if (pathname.endsWith(".css")) return /^text\/css\b/i;
  if (pathname.endsWith(".js")) return /^(?:application|text)\/javascript\b/i;
  if (pathname.endsWith(".json")) return /^application\/json\b/i;
  if (/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i.test(pathname)) return /^image\//i;
  if (/\.(?:otf|ttf|woff2?)$/i.test(pathname)) return /^(?:font\/|application\/font-)/i;
  return /^(?:application|font|image|text)\//i;
}

async function verifyHomeStaticAssets(homeHtml, appUrl) {
  const assetUrls = staticAssetUrlsFromHtml(homeHtml, appUrl);
  assert.ok(assetUrls.length > 0, "home page must reference at least one same-origin /_next/static asset");

  let totalBytes = 0;
  for (const assetUrl of assetUrls) {
    const response = await fetch(assetUrl);
    const assetPath = `${new URL(assetUrl).pathname}${new URL(assetUrl).search}`;
    assert.equal(response.status, 200, `${assetPath} returned ${response.status}`);
    assert.match(
      response.headers.get("content-type") ?? "",
      expectedStaticContentType(new URL(assetUrl).pathname),
      `${assetPath} returned an unexpected content-type`,
    );
    const bytes = (await response.arrayBuffer()).byteLength;
    assert.ok(bytes > 0, `${assetPath} returned an empty body`);
    totalBytes += bytes;
  }

  console.log(`HTTP static asset smoke: passed (${assetUrls.length} assets, ${totalBytes} bytes)`);
}

let provider;
let app;
let appOutput = [];
try {
  await prepareStandaloneRuntime();
  provider = startProvider();
  const providerPort = await listen(provider);
  const appPort = await applicationPort();
  const appUrl = `http://127.0.0.1:${appPort}`;
  ({ app, output: appOutput } = startApplication(appPort, providerPort));

  const health = await waitForHealth(appUrl);
  const healthBody = await expectJson(health, 200);
  assert.equal(healthBody.mode, "self-hosted-single-user");
  assert.equal(healthBody.services.ai.configured, true);

  const course = await expectJson(await fetch(`${appUrl}/api/courses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "HTTP 集成高数", code: `HTTP-${randomUUID().slice(0, 8)}`, teacher: "集成测试", term: "2026 秋", examDate: "2099-12-30", priority: "高" }),
  }), 201);
  const courseId = course.course.id;
  assert.ok(courseId);

  const invalidForm = new FormData();
  invalidForm.set("courseId", courseId);
  invalidForm.set("file", new Blob(["not supported"], { type: "text/plain" }), "invalid.txt");
  assert.equal((await fetch(`${appUrl}/api/materials`, { method: "POST", body: invalidForm })).status, 415);

  const form = new FormData();
  const originalBytes = Buffer.from("%PDF-1.4\nHTTP e2e source material\n", "utf8");
  form.set("courseId", courseId);
  form.set("file", new Blob([originalBytes], { type: "application/pdf" }), "http-smoke.pdf");
  const uploaded = await expectJson(await fetch(`${appUrl}/api/materials`, { method: "POST", body: form }), 201);
  const materialId = uploaded.material.id;
  assert.equal(uploaded.material.status, "待分析");
  assert.equal(JSON.stringify(uploaded).includes("objectKey"), false);
  assert.equal(JSON.stringify(uploaded).includes("sha256"), false);

  const analyzed = await expectJson(await fetch(`${appUrl}/api/materials/${materialId}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5-mini" }),
  }), 200);
  assert.equal(analyzed.workspace.materials.find((item) => item.id === materialId).status, "已分析");
  assert.equal(analyzed.analysis.keyPoints[0].title, "极限计算");

  const synthesized = await expectJson(await fetch(`${appUrl}/api/courses/${courseId}/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5-mini" }),
  }), 200);
  assert.equal(synthesized.analysis.highFrequencyPoints[0].title, "极限计算");
  assert.ok(synthesized.workspace.tasks.length > 0);

  const answers = Object.fromEntries(synthesized.workspace.questions.map((question) => [question.id, question.answer]));
  const practice = await expectJson(await fetch(`${appUrl}/api/assessments/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseId, answers, selfRating: 4 }),
  }), 200);
  assert.equal(practice.score, 100);
  assert.ok(practice.workspace.courses.find((item) => item.id === courseId).mastery > 0);

  const taskId = practice.workspace.tasks[0].id;
  const completed = await expectJson(await fetch(`${appUrl}/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: true }),
  }), 200);
  assert.equal(completed.tasks.find((item) => item.id === taskId).status, "已完成");

  // The plan regeneration endpoint must genuinely call the configured
  // provider and persist the result as an AI-generated plan.
  const aiPlan = await expectJson(await fetch(`${appUrl}/api/plan/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }), 200);
  assert.equal(aiPlan.generatedBy, "ai");
  assert.equal(aiPlan.workspace.planSource, "ai");
  assert.ok(aiPlan.workspace.tasks.length > 0, "the AI plan must leave persisted tasks");
  assert.ok(aiPlan.workspace.missedTasks !== undefined);

  const download = await fetch(`${appUrl}/api/materials/${materialId}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), originalBytes);

  // Owner backup export includes the full workspace, unlike the public read.
  const exported = await fetch(`${appUrl}/api/workspace/export`);
  assert.equal(exported.status, 200);
  const exportedBody = await exported.json();
  assert.ok(Array.isArray(exportedBody.materials) && exportedBody.materials.length > 0);
  assert.equal(typeof exportedBody.materials[0].objectKey, "string");

  // Production responses carry HSTS.
  const home = await fetch(`${appUrl}/`);
  assert.ok((home.headers.get("strict-transport-security") ?? "").includes("max-age="));
  await verifyHomeStaticAssets(await home.text(), appUrl);

  const publicWorkspace = await expectJson(await fetch(`${appUrl}/api/workspace`), 200);
  assert.equal(JSON.stringify(publicWorkspace).includes("objectKey"), false);
  assert.equal(JSON.stringify(publicWorkspace).includes("sha256"), false);
  // Completion inheritance across a plan replacement is semantic (same
  // course/date/time/focus only) and covered by the store-level tests; here
  // every persisted status must simply remain one of the valid values.
  for (const task of publicWorkspace.tasks) {
    assert.ok(["待完成", "已完成", "已错过"].includes(task.status));
  }
  const otpUnavailable = await fetch(`${appUrl}/api/auth/otp/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "student@example.edu" }) });
  assert.equal(otpUnavailable.status, 503, "email verification must report missing delivery configuration honestly");
  const communityNotVerified = await fetch(`${appUrl}/api/shared/contribute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ materialId, consent: true, privacyConfirmed: true }) });
  assert.equal(communityNotVerified.status, 403, "community contribution must require school verification");
  assert.equal((await fetch(`${appUrl}/api/shared/catalog`)).status, 200);

  await stop(app);
  app = undefined;
  const restarted = startApplication(appPort, providerPort);
  app = restarted.app;
  appOutput = restarted.output;
  await waitForHealth(appUrl);
  const afterRestart = await expectJson(await fetch(`${appUrl}/api/workspace`), 200);
  assert.equal(afterRestart.materials.find((item) => item.id === materialId).status, "已分析");
  assert.equal(afterRestart.planSource, "ai");
  assert.ok(afterRestart.courses.find((item) => item.id === courseId).mastery > 0);

  assert.deepEqual(providerRequests.map((request) => `${request.method} ${request.path}`), [
    "POST /v1/files",
    "POST /v1/responses",
    "DELETE /v1/files/file_http_smoke",
    "POST /v1/responses",
    "POST /v1/responses",
  ]);
  console.log("HTTP end-to-end smoke: passed");
} catch (error) {
  console.error("HTTP end-to-end smoke: failed");
  if (appOutput.length) console.error(appOutput.join(""));
  throw error;
} finally {
  if (app) await stop(app);
  if (provider) await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  await Promise.all([
    rm(temporaryDataDirectory, { recursive: true, force: true }),
    rm(temporaryRuntimeRoot, { recursive: true, force: true }),
  ]);
}
