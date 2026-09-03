import assert from "node:assert/strict";
import test from "node:test";
import { AiAnalysisError, isSupportedFile, kindFromFilename, parseCourseSynthesis, parseDocumentAnalysis, parseStudyPlan, resolveAiRequestConfig, resolveModel, synthesizeCourse } from "../lib/ai-analysis";

function getSessionBaseUrl(requestBaseUrl: string) {
  return resolveAiRequestConfig({ requestKey: "unit-test-session-key", requestBaseUrl }).baseURL;
}

test("AI file intake supports the documented study-material extensions", () => {
  assert.equal(isSupportedFile("试卷.PDF"), true);
  assert.equal(isSupportedFile("复习课.pptx"), true);
  assert.equal(isSupportedFile("题库.docx"), true);
  assert.equal(isSupportedFile("笔记.png"), true);
  assert.equal(isSupportedFile("archive.zip"), false);
  assert.equal(kindFromFilename("复习课.pptx"), "课件");
});

test("AI model selection accepts a compatible provider's safe identifier and rejects unsafe input", () => {
  assert.equal(resolveModel("gpt-5"), "gpt-5");
  assert.equal(resolveModel("qwen2.5-vl:latest"), "qwen2.5-vl:latest");
  assert.throws(() => resolveModel("model name with spaces"), /模型名/);
  assert.throws(() => resolveModel("../../not-a-model"), /模型名/);
});

test("custom AI request URLs accept an API root and reject endpoint URLs", () => {
  assert.equal(getSessionBaseUrl("https://gateway.example.com/v1/"), "https://gateway.example.com/v1");
  assert.equal(getSessionBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.throws(() => getSessionBaseUrl("https://gateway.example.com/v1/responses"), /API 根地址/);
  assert.throws(() => getSessionBaseUrl("http://gateway.example.com/v1"), /HTTPS/);
  assert.throws(() => getSessionBaseUrl("ftp://gateway.example.com/v1"), /HTTPS/);
});

test("custom AI URL validation rejects private IPv6 and mapped addresses", () => {
  const environment = process.env as Record<string, string | undefined>;
  const originalNodeEnv = environment.NODE_ENV;
  const originalCustomBaseUrl = environment.AI_ALLOW_CUSTOM_BASE_URL;
  try {
    environment.NODE_ENV = "production";
    environment.AI_ALLOW_CUSTOM_BASE_URL = "true";
    assert.throws(() => getSessionBaseUrl("https://[::1]/v1"), /生产环境/);
    assert.throws(() => getSessionBaseUrl("https://[::ffff:127.0.0.1]/v1"), /生产环境/);
    assert.throws(() => getSessionBaseUrl("https://[fd00::1]/v1"), /生产环境/);
  } finally {
    if (originalNodeEnv === undefined) delete environment.NODE_ENV; else environment.NODE_ENV = originalNodeEnv;
    if (originalCustomBaseUrl === undefined) delete environment.AI_ALLOW_CUSTOM_BASE_URL; else environment.AI_ALLOW_CUSTOM_BASE_URL = originalCustomBaseUrl;
  }
});

test("a trusted operator endpoint may be private in production while a browser endpoint may not", () => {
  const environment = process.env as Record<string, string | undefined>;
  const originalNodeEnv = environment.NODE_ENV;
  const originalBaseUrl = environment.OPENAI_BASE_URL;
  const originalApiKey = environment.OPENAI_API_KEY;
  const originalAiKey = environment.AI_API_KEY;
  const originalServerKeyAccess = environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY;
  const originalCustomBaseUrl = environment.AI_ALLOW_CUSTOM_BASE_URL;
  try {
    environment.NODE_ENV = "production";
    environment.OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
    environment.OPENAI_API_KEY = "operator-key";
    delete environment.AI_API_KEY;
    environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY = "true";
    environment.AI_ALLOW_CUSTOM_BASE_URL = "true";
    assert.equal(resolveAiRequestConfig({}).baseURL, "http://127.0.0.1:11434/v1");
    assert.throws(() => getSessionBaseUrl("http://127.0.0.1:11434/v1"), /生产环境/);
  } finally {
    if (originalNodeEnv === undefined) delete environment.NODE_ENV; else environment.NODE_ENV = originalNodeEnv;
    if (originalBaseUrl === undefined) delete environment.OPENAI_BASE_URL; else environment.OPENAI_BASE_URL = originalBaseUrl;
    if (originalApiKey === undefined) delete environment.OPENAI_API_KEY; else environment.OPENAI_API_KEY = originalApiKey;
    if (originalAiKey === undefined) delete environment.AI_API_KEY; else environment.AI_API_KEY = originalAiKey;
    if (originalServerKeyAccess === undefined) delete environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY; else environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY = originalServerKeyAccess;
    if (originalCustomBaseUrl === undefined) delete environment.AI_ALLOW_CUSTOM_BASE_URL; else environment.AI_ALLOW_CUSTOM_BASE_URL = originalCustomBaseUrl;
  }
});

test("a browser-selected AI endpoint can only use its own validated session key", () => {
  const environment = process.env as Record<string, string | undefined>;
  const names = ["NODE_ENV", "OPENAI_API_KEY", "AI_API_KEY", "OPENAI_BASE_URL", "AI_ALLOW_UNAUTHENTICATED_SERVER_KEY", "AI_ALLOW_CUSTOM_BASE_URL"] as const;
  const original = Object.fromEntries(names.map((name) => [name, environment[name]])) as Record<(typeof names)[number], string | undefined>;
  try {
    environment.NODE_ENV = "production";
    environment.OPENAI_BASE_URL = "https://operator.example.com/v1";
    environment.AI_ALLOW_UNAUTHENTICATED_SERVER_KEY = "true";
    environment.AI_ALLOW_CUSTOM_BASE_URL = "true";

    for (const serverKeyVariable of ["OPENAI_API_KEY", "AI_API_KEY"] as const) {
      delete environment.OPENAI_API_KEY;
      delete environment.AI_API_KEY;
      environment[serverKeyVariable] = "server-secret";
      assert.throws(
        () => resolveAiRequestConfig({ requestBaseUrl: "https://browser.example.com/v1" }),
        (error: unknown) => error instanceof AiAnalysisError && error.status === 403 && /会话 Key/.test(error.message),
      );
      assert.deepEqual(resolveAiRequestConfig({}), {
        apiKey: "server-secret",
        baseURL: "https://operator.example.com/v1",
      });
    }

    assert.deepEqual(resolveAiRequestConfig({
      requestKey: "session-secret",
      requestBaseUrl: "https://browser.example.com/v1/",
    }), {
      apiKey: "session-secret",
      baseURL: "https://browser.example.com/v1",
    });
    assert.throws(
      () => resolveAiRequestConfig({ requestKey: "session\nsecret", requestBaseUrl: "https://browser.example.com/v1" }),
      /Key 格式无效/,
    );
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete environment[name]; else environment[name] = original[name];
    }
  }
});

test("structured document analysis rejects malformed model output", () => {
  assert.throws(() => parseDocumentAnalysis(JSON.stringify({ documentTitle: "缺字段" })), /格式无效/);
});

test("course synthesis is parsed only when all required evidence fields exist", () => {
  const parsed = parseCourseSynthesis(JSON.stringify({
    summary: "两份资料共同强调二重积分。",
    highFrequencyPoints: [{
      id: "double-integral",
      title: "二重积分",
      frequency: 2,
      mastery: 45,
      trend: "需巩固",
      sources: ["2025 期末卷 · 第 3 页", "复习课件 · 第 18 张"],
      summary: "两份资料均出现区域变换。",
    }],
    recommendedStudyActions: ["先画区域，再做三道变式题。"],
    generatedQuestions: [],
    warnings: [],
  }));
  assert.equal(parsed.highFrequencyPoints[0]?.frequency, 2);
  assert.equal(parsed.highFrequencyPoints[0]?.sources.length, 2);
});

test("course synthesis rejects more than twelve documents instead of silently omitting sources", async () => {
  const analysis = parseDocumentAnalysis(JSON.stringify({
    documentTitle: "资料.pdf",
    materialKind: "试卷",
    pageCount: 1,
    summary: "测试资料。",
    confidence: "high",
    keyPoints: [],
    questionPatterns: [],
    studyActions: [],
    generatedQuestions: [],
    warnings: [],
  }));
  await assert.rejects(
    () => synthesizeCourse({
      course: { name: "高等数学", code: "MATH201", teacher: "测试老师", term: "2026 秋" },
      analyses: Array.from({ length: 13 }, () => analysis),
      apiKey: "not-used-before-validation",
      model: "gpt-5-mini",
    }),
    (error: unknown) => error instanceof AiAnalysisError && error.status === 422,
  );
});

test("AI plan output is parsed only when every task is valid", () => {
  const parsed = parseStudyPlan(JSON.stringify({
    plan: [{
      date: "2026-12-09",
      courseCode: "MATH201",
      type: "练习",
      durationMinutes: 45,
      focus: "二重积分的区域变换",
      reason: "12 天后考试，掌握度 42%。",
    }],
  }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.courseCode, "MATH201");
  assert.equal(parsed[0]?.durationMinutes, 45);
});

test("AI plan output rejects malformed, oversized or empty plans", () => {
  const valid = { date: "2026-12-09", courseCode: "MATH201", type: "练习", durationMinutes: 45, focus: "极限", reason: "依据重要度 5/5" };
  assert.throws(() => parseStudyPlan(JSON.stringify({ plan: [] })), /未生成任何计划任务/);
  assert.throws(() => parseStudyPlan(JSON.stringify({ plan: [{ ...valid, durationMinutes: 0 }] })), /时长无效/);
  assert.throws(() => parseStudyPlan(JSON.stringify({ plan: [{ ...valid, type: "闲聊" }] })), /格式无效/);
  assert.throws(() => parseStudyPlan(JSON.stringify({ plan: [{ ...valid, date: "2026-02-30" }] })), /日期无效/);
  assert.throws(() => parseStudyPlan(JSON.stringify({ plan: Array.from({ length: 29 }, () => valid) })), /数量过多/);
});
