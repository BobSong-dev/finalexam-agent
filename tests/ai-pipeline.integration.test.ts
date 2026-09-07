import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { analyzeDocument, synthesizeCourse } from "../lib/ai-analysis";

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

function makeTextPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const content = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function responseEnvelope(outputText: string) {
  return {
    id: "resp_mock_1",
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
      id: "msg_mock_1",
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

function chatCompletionEnvelope(outputText: string) {
  return {
    id: "chat_mock_1",
    object: "chat.completion",
    created: 1,
    model: "gpt-5-mini",
    choices: [{
      index: 0,
      message: { role: "assistant", content: outputText },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const documentResult = {
  documentTitle: "mock-final.pdf",
  materialKind: "试卷",
  pageCount: 1,
  summary: "一份用于验证真实 Files 和 Responses 调用顺序的模拟试卷。",
  confidence: "high",
  keyPoints: [{
    id: "limit",
    title: "极限计算",
    importance: 5,
    evidence: { label: "mock-final.pdf", location: "第 1 页", quote: "求极限" },
  }],
  questionPatterns: [{
    title: "基础计算题",
    type: "填空",
    description: "直接计算一个函数极限。",
    evidence: { label: "mock-final.pdf", location: "第 1 页", quote: "求极限" },
  }],
  studyActions: ["先复习等价无穷小，再完成三道变式题。"],
  generatedQuestions: [{
    id: "mock-question-1",
    type: "填空",
    prompt: "写出一个极限计算的关键步骤。",
    choices: [],
    answer: "先化简表达式。",
    explanation: "先识别可化简的结构。",
    knowledge: "极限计算",
    sourceLocation: "mock-final.pdf · 第 1 页",
  }],
  warnings: [],
};

const synthesisResult = {
  summary: "模拟课程汇总已完成。",
  highFrequencyPoints: [{
    id: "limit",
    title: "极限计算",
    frequency: 1,
    mastery: 45,
    trend: "需巩固",
    sources: ["mock-final.pdf · 第 1 页"],
    summary: "这份资料出现了极限计算。",
  }],
  recommendedStudyActions: ["完成极限计算专项练习。"],
  generatedQuestions: [],
  warnings: [],
};

test("AI pipeline uploads a document, reads a structured response, synthesizes, and deletes the temporary file", async () => {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method ?? "", path: request.url ?? "", body });

    if (request.method === "POST" && request.url === "/v1/files") {
      sendJson(response, {
        id: "file_mock_1",
        object: "file",
        bytes: 16,
        created_at: 1,
        filename: "mock-final.pdf",
        purpose: "user_data",
        status: "processed",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      const isSynthesis = body.includes("final_exam_course_synthesis");
      sendJson(response, responseEnvelope(JSON.stringify(isSynthesis ? synthesisResult : documentResult)));
      return;
    }
    if (request.method === "DELETE" && request.url === "/v1/files/file_mock_1") {
      sendJson(response, { id: "file_mock_1", object: "file", deleted: true });
      return;
    }
    sendJson(response, { error: { message: "unexpected request" } }, 404);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const file = new File([Buffer.from("%PDF-1.4 mock")], "mock-final.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => { throw new Error("Files API uploads must stream instead of buffering the whole document"); },
    });
    const course = { name: "高等数学", code: "MATH201", teacher: "张老师", term: "2026 秋" };
    const { analysis } = await analyzeDocument({ file, course, apiKey: "test-key", model: "gpt-5-mini", baseURL });
    assert.equal(analysis.documentTitle, "mock-final.pdf");
    assert.equal(analysis.keyPoints[0]?.title, "极限计算");

    const { synthesis } = await synthesizeCourse({ course, analyses: [analysis], apiKey: "test-key", model: "gpt-5-mini", baseURL });
    assert.equal(synthesis.highFrequencyPoints[0]?.frequency, 1);

    assert.deepEqual(requests.map((item) => `${item.method} ${item.path}`), [
      "POST /v1/files",
      "POST /v1/responses",
      "DELETE /v1/files/file_mock_1",
      "POST /v1/responses",
    ]);
    assert.match(requests[1]?.body ?? "", /file_mock_1/);
    assert.match(requests[3]?.body ?? "", /final_exam_course_synthesis/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("AI pipeline sends inline file data when a gateway rejects streaming file uploads", async () => {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method ?? "", path: request.url ?? "", body });

    if (request.method === "POST" && request.url === "/v1/files") {
      sendJson(response, { error: { message: "Content-Length is required" } }, 411);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      sendJson(response, responseEnvelope(JSON.stringify(documentResult)));
      return;
    }
    sendJson(response, { error: { message: "unexpected request" } }, 404);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const file = new File([Buffer.from("%PDF-1.4 inline fallback")], "inline-fallback.pdf", { type: "application/pdf" });
    const course = { name: "高等数学", code: "MATH201", teacher: "张老师", term: "2026 秋" };
    const { analysis } = await analyzeDocument({ file, course, apiKey: "test-key", model: "gpt-5-mini", baseURL });

    assert.equal(analysis.documentTitle, "mock-final.pdf");
    assert.deepEqual(requests.map((item) => `${item.method} ${item.path}`), [
      "POST /v1/files",
      "POST /v1/responses",
    ]);
    assert.match(requests[1]?.body ?? "", /input_file/);
    assert.match(requests[1]?.body ?? "", /file_data/);
    assert.match(requests[1]?.body ?? "", /data:application\/pdf;base64/);
    assert.doesNotMatch(requests[1]?.body ?? "", /file_mock_1/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("AI pipeline extracts PDF text when a gateway rejects every file-input format", async () => {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method ?? "", path: request.url ?? "", body });

    if (request.method === "POST" && request.url === "/v1/files") {
      sendJson(response, { error: { message: "Files endpoint is not available" } }, 404);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      if (body.includes('"type":"input_file"')) {
        sendJson(response, { error: { message: "File inputs are not supported" } }, 400);
        return;
      }
      if (body.includes('"text":{"format"')) {
        sendJson(response, { error: { message: "Structured output is not supported" } }, 400);
        return;
      }
      sendJson(response, responseEnvelope(JSON.stringify(documentResult)));
      return;
    }
    sendJson(response, { error: { message: "unexpected request" } }, 404);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const pdf = makeTextPdf("PDF TEXT FALLBACK EVIDENCE");
    const fileBytes = new Uint8Array(pdf.byteLength);
    fileBytes.set(pdf);
    const file = new File([fileBytes], "text-fallback.pdf", { type: "application/pdf" });
    const course = { name: "高等数学", code: "MATH201", teacher: "张老师", term: "2026 秋" };
    const { analysis } = await analyzeDocument({ file, course, apiKey: "test-key", model: "gpt-5-mini", baseURL });

    assert.equal(analysis.documentTitle, "mock-final.pdf");
    assert.deepEqual(requests.map((item) => `${item.method} ${item.path}`), [
      "POST /v1/files",
      "POST /v1/responses",
      "POST /v1/responses",
      "POST /v1/responses",
    ]);
    assert.match(requests[3]?.body ?? "", /PDF TEXT FALLBACK EVIDENCE/);
    assert.doesNotMatch(requests[3]?.body ?? "", /input_file/);
    assert.doesNotMatch(requests[3]?.body ?? "", /"text":\{"format"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("AI pipeline falls back to plain Chat Completions when a gateway rejects every Responses extension", async () => {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method ?? "", path: request.url ?? "", body });

    if (request.method === "POST" && request.url === "/v1/files") {
      sendJson(response, { error: { message: "Files endpoint is not available" } }, 404);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      sendJson(response, { error: { message: "Responses extensions are not supported" } }, 400);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      sendJson(response, chatCompletionEnvelope(`\`\`\`json\n${JSON.stringify(documentResult)}\n\`\`\``));
      return;
    }
    sendJson(response, { error: { message: "unexpected request" } }, 404);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const pdf = makeTextPdf("CHAT COMPLETIONS FALLBACK EVIDENCE");
    const fileBytes = new Uint8Array(pdf.byteLength);
    fileBytes.set(pdf);
    const file = new File([fileBytes], "chat-fallback.pdf", { type: "application/pdf" });
    const course = { name: "高等数学", code: "MATH201", teacher: "张老师", term: "2026 秋" };
    const { analysis } = await analyzeDocument({ file, course, apiKey: "test-key", model: "gpt-5-mini", baseURL });

    assert.equal(analysis.documentTitle, "mock-final.pdf");
    assert.deepEqual(requests.map((item) => `${item.method} ${item.path}`), [
      "POST /v1/files",
      "POST /v1/responses",
      "POST /v1/responses",
      "POST /v1/responses",
      "POST /v1/chat/completions",
    ]);
    assert.match(requests[4]?.body ?? "", /CHAT COMPLETIONS FALLBACK EVIDENCE/);
    assert.doesNotMatch(requests[4]?.body ?? "", /input_file/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
