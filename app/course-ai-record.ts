import type { DocumentAnalysis } from "@/lib/ai-types";
import type { PublicWorkspaceState } from "@/lib/workspace-types";
import type { CourseAiRecord } from "./ui-types";

/** 聚合某门课程的 AI 状态，供资料分析页展示一张卡片。 */
export function courseAiRecordFor(
  workspace: PublicWorkspaceState | null,
  courseId: string | undefined,
  model: string,
  workingMaterialId: string | null,
  synthesizingCourseId: string | null,
): CourseAiRecord | undefined {
  if (!workspace || !courseId) return undefined;
  const materials = workspace.materials.filter((material) => material.courseId === courseId);
  const analyses = materials
    .map((material) => workspace.documentAnalyses[material.id])
    .filter((analysis): analysis is DocumentAnalysis => Boolean(analysis));
  const synthesis = workspace.courseSyntheses[courseId];
  const workingMaterial = materials.find((material) => material.id === workingMaterialId);
  const failedMaterial = materials.find((material) => material.status === "失败");
  const base = { documentCount: analyses.length, provider: "OpenAI-compatible API", model };

  if (synthesizingCourseId === courseId) {
    return {
      ...base,
      status: "synthesizing",
      summary: "正在综合本课程已分析资料，生成高频考点与练习题…",
      warnings: [],
      studyActions: [],
      questionPatterns: analyses.flatMap((analysis) => analysis.questionPatterns).slice(0, 4),
      synthesized: false,
    };
  }
  if (workingMaterial) {
    return {
      ...base,
      status: "analyzing",
      summary: `正在分析《${workingMaterial.name}》，文件已保存在本地工作区。`,
      warnings: [],
      studyActions: [],
      questionPatterns: [],
      synthesized: Boolean(synthesis),
    };
  }
  if (synthesis) {
    return {
      ...base,
      status: "ready",
      summary: synthesis.summary,
      warnings: synthesis.warnings,
      studyActions: synthesis.recommendedStudyActions,
      questionPatterns: analyses.flatMap((analysis) => analysis.questionPatterns).slice(0, 4),
      synthesized: true,
    };
  }
  if (analyses.length) {
    const latest = analyses[analyses.length - 1]!;
    return {
      ...base,
      status: "ready",
      summary: latest.summary,
      warnings: latest.warnings,
      studyActions: latest.studyActions,
      questionPatterns: latest.questionPatterns,
      synthesized: false,
    };
  }
  if (failedMaterial) {
    return {
      ...base,
      status: "error",
      summary: failedMaterial.error || "有资料未完成 AI 分析，可在资料卡上重试。",
      warnings: [failedMaterial.error || `${failedMaterial.name} 分析未完成`],
      studyActions: [],
      questionPatterns: [],
      synthesized: false,
    };
  }
  return undefined;
}
