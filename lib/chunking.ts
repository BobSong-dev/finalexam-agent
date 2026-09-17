import type {
  CourseSynthesisPoint,
  DocumentAnalysis,
  DocumentKeyPoint,
  DocumentQuestionPattern,
  GeneratedPracticeQuestion,
} from "./ai-types";

/**
 * 长资料的分块与合并。
 *
 * 起因：把 40 万字正文和原文件一起发给模型，很容易超出上下文，最终只得到一个
 * 笼统的「AI 服务未能处理这份资料」。这里改成按页码边界切块、逐块抽取、再合并去重：
 * 每块都在上下文预算内，结果仍然带着各自的页码证据。
 *
 * 纯函数，便于单测；不依赖任何提供方。
 */

export const CHUNK_CHARACTER_LIMIT = 60_000;
export const MAX_CHUNKS = 6;

export interface DocumentChunk {
  index: number;
  total: number;
  /** 人类可读的页码范围，用于提示词与警告文案。 */
  label: string;
  text: string;
}

/**
 * 按 `--- 第 N 页 ---` 分隔符切块；没有页码标记的文本按长度硬切。
 * 单页超过上限时该页独占一块（宁可超一点，也不把一页拆到两块里丢上下文）。
 */
export function splitIntoChunks(text: string, limit = CHUNK_CHARACTER_LIMIT): DocumentChunk[] {
  const pages = splitPages(text);
  const chunks: Array<{ label: string; text: string }> = [];
  let current = { label: "", text: "" };

  const flush = () => {
    if (!current.text.trim()) return;
    chunks.push({ label: current.label, text: current.text.trim() });
    current = { label: "", text: "" };
  };

  for (const page of pages) {
    const wouldOverflow = current.text.length + page.text.length > limit && current.text.length > 0;
    if (wouldOverflow) flush();
    current.text += (current.text ? "\n\n" : "") + page.text;
    current.label = current.label ? joinLabels(current.label, page.label) : page.label;
  }
  flush();

  if (chunks.length <= MAX_CHUNKS) {
    return chunks.map((chunk, index) => ({
      index,
      total: chunks.length,
      label: chunk.label,
      text: chunk.text,
    }));
  }

  // 超过上限时合并相邻块（保留前 MAX_CHUNKS 块并合并其余），避免调用次数失控。
  const kept = chunks.slice(0, MAX_CHUNKS - 1);
  const tail = chunks.slice(MAX_CHUNKS - 1);
  kept.push({
    label: joinLabels(tail[0]!.label, tail[tail.length - 1]!.label),
    text: tail.map((chunk) => chunk.text).join("\n\n"),
  });
  return kept.map((chunk, index) => ({
    index,
    total: kept.length,
    label: chunk.label,
    text: chunk.text,
  }));
}

/** 合并两个页码范围标签：同一类（页/段）时压缩成「第 1–3 页」。 */
function joinLabels(left: string, right: string): string {
  const leftPage = /^第 ([0-9]+) 页$/.exec(left);
  const rightPage = /^第 ([0-9]+) 页$/.exec(right);
  if (leftPage && rightPage) return `第 ${leftPage[1]}–${rightPage[1]} 页`;
  const leftRange = /^第 ([0-9]+)–([0-9]+) 页$/.exec(left);
  if (leftRange && rightPage) return `第 ${leftRange[1]}–${rightPage[1]} 页`;
  return `${left}–${right}`;
}

function splitPages(text: string): Array<{ label: string; text: string }> {
  const pattern = /---\s*第\s*(\d+)\s*页(?:\s*（[^）]*）)?\s*---/g;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) {
    return hardSplit(text);
  }
  const pages: Array<{ label: string; text: string }> = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = (match.index ?? 0) + match[0].length;
    const end =
      index + 1 < matches.length ? (matches[index + 1]!.index ?? text.length) : text.length;
    const body = text.slice(start, end).trim();
    if (body) pages.push({ label: `第 ${match[1]} 页`, text: body });
  }
  return pages.length ? pages : hardSplit(text);
}

function hardSplit(
  text: string,
  size = CHUNK_CHARACTER_LIMIT,
): Array<{ label: string; text: string }> {
  const pages: Array<{ label: string; text: string }> = [];
  for (let offset = 0; offset < text.length; offset += size) {
    const body = text.slice(offset, offset + size);
    const from = Math.floor(offset / size) + 1;
    const to = Math.ceil(Math.min(offset + size, text.length) / size);
    pages.push({ label: from === to ? `第 ${from} 段` : `第 ${from}–${to} 段`, text: body });
  }
  return pages;
}

function keyOf(title: string): string {
  return title
    .replace(/[\s　\p{P}\p{S}]+/gu, "")
    .toLowerCase()
    .slice(0, 120);
}

/** 合并逐块结果：同名考点取更高重要度并保留更长的摘录，题目按题干去重。 */
export function mergeChunkAnalyses(
  parts: Array<{ chunk: DocumentChunk; analysis: DocumentAnalysis }>,
  documentTitle: string,
  pageCount: number | null,
): DocumentAnalysis {
  const keyPoints = new Map<string, DocumentKeyPoint>();
  const patterns = new Map<string, DocumentQuestionPattern>();
  const questions: GeneratedPracticeQuestion[] = [];
  const studyActions: string[] = [];
  const warnings: string[] = [];
  const summaries: string[] = [];
  let confidence: DocumentAnalysis["confidence"] = "high";

  for (const { chunk, analysis } of parts) {
    if (analysis.confidence === "low") confidence = "low";
    else if (analysis.confidence === "medium" && confidence === "high") confidence = "medium";
    if (analysis.summary.trim()) summaries.push(`【${chunk.label}】${analysis.summary.trim()}`);
    for (const point of analysis.keyPoints) {
      const key = keyOf(point.title);
      if (!key) continue;
      const existing = keyPoints.get(key);
      if (!existing) {
        keyPoints.set(key, {
          ...point,
          evidence: { ...point.evidence, location: point.evidence.location || chunk.label },
        });
        continue;
      }
      const better = point.importance > existing.importance ? { ...point } : { ...existing };
      keyPoints.set(key, {
        ...better,
        // 标题以首次出现的写法为准：合并时不再引入「极限的计算。」这类句末标点差异。
        title: existing.title,
        importance: Math.max(existing.importance, point.importance),
        examLikelihood:
          Math.max(existing.examLikelihood ?? 0, point.examLikelihood ?? 0) || undefined,
        pitfalls: existing.pitfalls || point.pitfalls,
        evidence:
          existing.evidence.quote.length >= point.evidence.quote.length
            ? existing.evidence
            : point.evidence,
      });
    }
    for (const pattern of analysis.questionPatterns) {
      const key = keyOf(pattern.title);
      if (key && !patterns.has(key)) patterns.set(key, pattern);
    }
    for (const question of analysis.generatedQuestions) {
      if (questions.length >= 10) break;
      const key = keyOf(question.prompt);
      if (key && !questions.some((item) => keyOf(item.prompt) === key)) questions.push(question);
    }
    for (const action of analysis.studyActions) {
      if (studyActions.length < 8 && !studyActions.includes(action)) studyActions.push(action);
    }
    for (const warning of analysis.warnings) {
      if (warnings.length < 12 && !warnings.includes(warning)) warnings.push(warning);
    }
  }

  warnings.unshift(
    `资料较长，已按 ${parts.length} 块分别分析后合并；跨块的同一考点已按标题合并，页码来源见各条证据。`,
  );

  return {
    documentTitle,
    materialKind:
      parts.find((part) => part.analysis.materialKind !== "未知")?.analysis.materialKind ?? "未知",
    pageCount,
    summary: summaries.join("\n").slice(0, 4_000),
    confidence,
    keyPoints: [...keyPoints.values()].slice(0, 16),
    questionPatterns: [...patterns.values()].slice(0, 16),
    studyActions,
    generatedQuestions: questions,
    warnings,
  };
}

/** 用于课程综合的考点合并（沿用同一套去重规则，但基于综合点结构）。 */
export function mergeSynthesisPoints(points: CourseSynthesisPoint[]): CourseSynthesisPoint[] {
  const merged = new Map<string, CourseSynthesisPoint>();
  for (const point of points) {
    const key = keyOf(point.title);
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...point });
      continue;
    }
    merged.set(key, {
      ...existing,
      frequency: Math.max(existing.frequency, point.frequency),
      priority: Math.max(existing.priority, point.priority),
      sources: [...new Set([...existing.sources, ...point.sources])].slice(0, 12),
      summary: existing.summary.length >= point.summary.length ? existing.summary : point.summary,
    });
  }
  return [...merged.values()];
}
