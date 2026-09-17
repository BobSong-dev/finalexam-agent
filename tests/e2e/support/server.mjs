// E2E 专用启动器：先跑一个 OpenAI 兼容的 mock provider，再用 standalone 产物启动应用。
// 与 scripts/http-e2e-smoke.mjs 使用同一套响应形状，但端口固定，方便 Playwright 复用。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appPort = Number(process.env.FINALE_E2E_PORT ?? 4173);
const providerPort = Number(process.env.FINALE_E2E_PROVIDER_PORT ?? 4174);

const documentAnalysis = {
  documentTitle: "e2e-期末卷.pdf",
  materialKind: "试卷",
  pageCount: 2,
  summary: "端到端测试用的模拟分析结果。",
  confidence: "high",
  keyPoints: [
    {
      id: "limit",
      title: "极限的计算",
      importance: 5,
      evidence: { label: "e2e-期末卷.pdf", location: "第 1 页", quote: "求极限" },
    },
  ],
  questionPatterns: [
    {
      title: "基础计算",
      type: "填空",
      description: "计算函数极限。",
      evidence: { label: "e2e-期末卷.pdf", location: "第 1 页", quote: "求极限" },
    },
  ],
  studyActions: ["完成三道极限计算练习。"],
  generatedQuestions: [
    {
      id: "document-q",
      type: "填空",
      prompt: "求极限前应先识别什么？",
      choices: [],
      answer: "表达式结构",
      explanation: "先判断可化简结构。",
      knowledge: "极限的计算",
      knowledgeId: "limit",
      sourceLocation: "第 1 页",
    },
  ],
  warnings: [],
};

const courseSynthesis = {
  summary: "综合后应优先复习极限的计算。",
  highFrequencyPoints: [
    {
      id: "limit-course",
      title: "极限的计算",
      frequency: 1,
      priority: 90,
      trend: "高频",
      sources: ["e2e-期末卷.pdf · 第 1 页"],
      summary: "资料反复要求求极限。",
    },
  ],
  recommendedStudyActions: ["先化简再完成限时练习。"],
  generatedQuestions: [
    {
      id: "course-q",
      type: "填空",
      prompt: "极限题先识别表达式的什么？",
      choices: [],
      answer: "结构",
      explanation: "结构决定化简策略。",
      knowledge: "极限的计算",
      knowledgeId: "limit-course",
      sourceLocation: "课程综合 · 第 1 页",
    },
  ],
  warnings: [],
};

function envelope(text) {
  return {
    id: "resp_e2e",
    object: "response",
    created_at: 1,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 6000,
    model: "gpt-5-mini",
    output: [
      {
        id: "msg_e2e",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
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

function json(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const provider = createServer(async (request, response) => {
  const body = await readBody(request);
  if (request.method === "POST" && request.url === "/v1/files") {
    return json(response, {
      id: "file_e2e",
      object: "file",
      bytes: 32,
      created_at: 1,
      filename: "e2e-期末卷.pdf",
      purpose: "user_data",
      status: "processed",
    });
  }
  if (request.method === "POST" && request.url === "/v1/responses") {
    if (body.includes("final_exam_study_plan")) {
      const date = body.match(/\\"date\\":\\"(\d{4}-\d{2}-\d{2})\\"/)?.[1] ?? "2099-12-30";
      const courseCode = body.match(/\\"code\\":\\"(E2E-[A-Za-z0-9]+)\\"/)?.[1] ?? "E2E";
      return json(
        response,
        envelope(
          JSON.stringify({
            plan: [
              {
                date,
                courseCode,
                type: "复习",
                durationMinutes: 45,
                focus: "极限的计算",
                reason: "依据重要度 5/5",
              },
            ],
          }),
        ),
      );
    }
    const payload = body.includes("final_exam_course_synthesis")
      ? courseSynthesis
      : documentAnalysis;
    return json(response, envelope(JSON.stringify(payload)));
  }
  if (request.method === "DELETE" && request.url === "/v1/files/file_e2e") {
    return json(response, { id: "file_e2e", object: "file", deleted: true });
  }
  return json(response, { error: { message: "unexpected provider request" } }, 404);
});

await new Promise((resolve) => provider.listen(providerPort, "127.0.0.1", resolve));

const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "finale-e2e-data-"));
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "finale-e2e-runtime-"));
const appDirectory = path.join(runtimeRoot, "app");
await cp(path.join(projectRoot, ".next", "standalone"), appDirectory, { recursive: true });
await cp(path.join(projectRoot, ".next", "static"), path.join(appDirectory, ".next", "static"), {
  recursive: true,
});

const app = spawn(process.execPath, [path.join(appDirectory, "server.js")], {
  cwd: appDirectory,
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(appPort),
    HOSTNAME: "127.0.0.1",
    FINALE_DATA_DIR: dataDirectory,
    OPENAI_API_KEY: "e2e-key",
    OPENAI_MODEL: "gpt-5-mini",
    OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
    AI_ALLOW_UNAUTHENTICATED_SERVER_KEY: "true",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

const shutdown = async () => {
  app.kill("SIGTERM");
  provider.close();
  await Promise.all([
    rm(dataDirectory, { recursive: true, force: true }).catch(() => undefined),
    rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined),
  ]);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
app.on("exit", shutdown);
