import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentAnalysis } from "../lib/ai-types";
import {
  CHUNK_CHARACTER_LIMIT,
  MAX_CHUNKS,
  mergeChunkAnalyses,
  mergeSynthesisPoints,
  splitIntoChunks,
} from "../lib/chunking";

function page(index: number, body: string): string {
  return `--- 第 ${index} 页 ---\n${body}`;
}

function analysis(partial: Partial<DocumentAnalysis>): DocumentAnalysis {
  return {
    documentTitle: "卷",
    materialKind: "试卷",
    pageCount: null,
    summary: "摘要",
    confidence: "high",
    keyPoints: [],
    questionPatterns: [],
    studyActions: [],
    generatedQuestions: [],
    warnings: [],
    ...partial,
  };
}

test("pages are grouped into chunks that respect the character budget", () => {
  const text = [
    page(1, "A".repeat(30_000)),
    page(2, "B".repeat(30_000)),
    page(3, "C".repeat(30_000)),
    page(4, "D".repeat(10_000)),
  ].join("\n\n");
  const chunks = splitIntoChunks(text);
  assert.equal(chunks.length, 2, "60k + 40k fits in two chunks");
  assert.equal(chunks[0]!.label, "第 1–2 页");
  assert.equal(chunks[1]!.label, "第 3–4 页");
  assert.ok(chunks.every((chunk) => chunk.text.length <= CHUNK_CHARACTER_LIMIT + 200));
  assert.equal(chunks[0]!.total, 2);
  assert.equal(chunks[1]!.index, 1);
});

test("a single oversized page stays whole instead of being split mid-page", () => {
  const text = page(1, "X".repeat(CHUNK_CHARACTER_LIMIT + 5_000));
  const chunks = splitIntoChunks(text);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.text.length > CHUNK_CHARACTER_LIMIT);
});

test("text without page markers is split by length", () => {
  const chunks = splitIntoChunks("Z".repeat(CHUNK_CHARACTER_LIMIT * 2 + 100));
  assert.equal(chunks.length, 3);
  assert.match(chunks[0]!.label, /段/);
});

test("the chunk count is bounded by merging the tail", () => {
  const text = Array.from({ length: 20 }, (_, index) =>
    page(index + 1, "W".repeat(CHUNK_CHARACTER_LIMIT - 100)),
  ).join("\n\n");
  const chunks = splitIntoChunks(text);
  assert.equal(chunks.length, MAX_CHUNKS);
  assert.equal(chunks[chunks.length - 1]!.index, MAX_CHUNKS - 1);
});

test("per-chunk analyses merge with deduplicated points and questions", () => {
  const chunkA = { index: 0, total: 2, label: "第 1–2 页", text: "" };
  const chunkB = { index: 1, total: 2, label: "第 3–4 页", text: "" };
  const merged = mergeChunkAnalyses(
    [
      {
        chunk: chunkA,
        analysis: analysis({
          confidence: "medium",
          summary: "前半部分以极限为主。",
          keyPoints: [
            {
              id: "a1",
              title: "极限的计算",
              importance: 3,
              pitfalls: "忘记等价无穷小条件",
              evidence: { label: "卷", location: "第 1 页", quote: "求极限" },
            },
            {
              id: "a2",
              title: "导数的定义",
              importance: 4,
              evidence: { label: "卷", location: "第 2 页", quote: "求导" },
            },
          ],
          generatedQuestions: [
            {
              id: "q1",
              type: "单选",
              prompt: "lim sin x / x = ?",
              choices: ["A. 0", "B. 1", "C. ∞", "D. 无"],
              answer: "B",
              explanation: "",
              knowledge: "极限的计算",
              sourceLocation: "第 1 页",
            },
          ],
          questionPatterns: [
            {
              title: "基础计算",
              type: "计算题",
              description: "套用重要极限",
              evidence: { label: "卷", location: "第 1 页", quote: "求极限" },
            },
          ],
          studyActions: ["先化简"],
          warnings: ["第 2 页字迹较淡"],
        }),
      },
      {
        chunk: chunkB,
        analysis: analysis({
          confidence: "low",
          summary: "后半部分是积分。",
          keyPoints: [
            // 同一个考点在不同块重复出现：应合并，取更高重要度与更完整的证据。
            {
              id: "b1",
              title: "极限的计算。",
              importance: 5,
              examLikelihood: 4,
              evidence: { label: "卷", location: "第 3 页", quote: "再次求极限，注意先化简再代入" },
            },
            {
              id: "b2",
              title: "二重积分的区域变换",
              importance: 4,
              evidence: { label: "卷", location: "第 4 页", quote: "交换次序" },
            },
          ],
          generatedQuestions: [
            {
              id: "q1",
              type: "单选",
              prompt: "lim sin x / x = ?",
              choices: ["A. 0", "B. 1", "C. ∞", "D. 无"],
              answer: "B",
              explanation: "",
              knowledge: "极限的计算",
              sourceLocation: "第 3 页",
            },
            {
              id: "q2",
              type: "填空",
              prompt: "换序前先画出积分____",
              choices: [],
              answer: "区域",
              explanation: "",
              knowledge: "二重积分的区域变换",
              sourceLocation: "第 4 页",
            },
          ],
          questionPatterns: [
            {
              title: "基础计算",
              type: "计算题",
              description: "重复题型",
              evidence: { label: "卷", location: "第 3 页", quote: "求极限" },
            },
            {
              title: "区域变换",
              type: "计算题",
              description: "先画区域",
              evidence: { label: "卷", location: "第 4 页", quote: "换序" },
            },
          ],
          studyActions: ["先化简", "整理换序步骤"],
          warnings: ["第 2 页字迹较淡"],
        }),
      },
    ],
    "期末模拟卷.pdf",
    4,
  );

  assert.equal(merged.confidence, "low", "the lowest confidence wins");
  assert.equal(merged.pageCount, 4);
  assert.deepEqual(
    merged.keyPoints.map((point) => point.title).sort(),
    ["二重积分的区域变换", "导数的定义", "极限的计算"].sort(),
    "「极限的计算」与「极限的计算。」合并为一条",
  );
  const limit = merged.keyPoints.find((point) => point.title.includes("极限"))!;
  assert.equal(limit.importance, 5, "the higher importance survives the merge");
  assert.equal(limit.examLikelihood, 4);
  assert.equal(limit.pitfalls, "忘记等价无穷小条件", "pitfalls from the other chunk are kept");
  assert.equal(limit.evidence.quote, "再次求极限，注意先化简再代入", "the longer quote wins");
  assert.equal(merged.generatedQuestions.length, 2, "duplicate prompts are dropped");
  assert.equal(merged.questionPatterns.length, 2);
  assert.deepEqual(merged.studyActions, ["先化简", "整理换序步骤"]);
  assert.match(merged.warnings[0]!, /已按 2 块分别分析后合并/);
  assert.equal(
    merged.warnings.filter((warning) => warning === "第 2 页字迹较淡").length,
    1,
    "warnings are deduplicated",
  );
  assert.match(merged.summary, /第 1–2 页/);
  assert.match(merged.summary, /第 3–4 页/);
});

test("synthesis points merge by normalized title", () => {
  const merged = mergeSynthesisPoints([
    {
      id: "a",
      title: "极限的计算",
      frequency: 2,
      priority: 60,
      trend: "高频",
      sources: ["卷 · 第 1 页"],
      summary: "短",
    },
    {
      id: "b",
      title: "极限的计算 。",
      frequency: 3,
      priority: 90,
      trend: "高频",
      sources: ["卷 · 第 3 页"],
      summary: "更长的摘要",
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.frequency, 3);
  assert.equal(merged[0]!.priority, 90);
  assert.deepEqual(merged[0]!.sources, ["卷 · 第 1 页", "卷 · 第 3 页"]);
  assert.equal(merged[0]!.summary, "更长的摘要");
});
