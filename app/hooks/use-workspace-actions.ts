"use client";

import { useCallback, useState } from "react";
import type { CourseSynthesis, DocumentAnalysis } from "@/lib/ai-types";
import type { Course, Material } from "@/lib/types";
import type { PublicWorkspaceState } from "@/lib/workspace-types";
import { JSON_HEADERS, responseError, triggerDownload } from "../client-api";
import type { AnalysisAttempt, AnalysisStartStatus } from "../ui-types";

interface ActionsInput {
  workspace: PublicWorkspaceState | null;
  applyWorkspace: (workspace: PublicWorkspaceState) => void;
  loadWorkspace: () => Promise<void>;
  notify: (message: string) => void;
  requestHeaders: () => Record<string, string>;
  selectedModel: string;
  aiReady: boolean;
  /** 需要 AI 却未配置时打开设置面板。返回 false 表示不应继续。 */
  ensureAiReady: () => boolean;
  onPracticeReset: () => void;
}

/** 课程、资料上传/分析/综合与计划的全部写操作。 */
export function useWorkspaceActions(input: ActionsInput) {
  const {
    workspace,
    applyWorkspace,
    loadWorkspace,
    notify,
    requestHeaders,
    selectedModel,
    aiReady,
    ensureAiReady,
    onPracticeReset,
  } = input;
  const [workingMaterialId, setWorkingMaterialId] = useState<string | null>(null);
  const [synthesizingCourseId, setSynthesizingCourseId] = useState<string | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);
  const [savingAvailability, setSavingAvailability] = useState(false);
  const [savingCourse, setSavingCourse] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [otpPending, setOtpPending] = useState(false);

  const analyzeStoredMaterial = useCallback(
    async (materialId: string): Promise<AnalysisStartStatus> => {
      if (!ensureAiReady()) return "failed";
      setWorkingMaterialId(materialId);
      try {
        const response = await fetch(`/api/materials/${encodeURIComponent(materialId)}/analyze`, {
          method: "POST",
          headers: { ...JSON_HEADERS, ...requestHeaders() },
          body: JSON.stringify({ model: selectedModel, background: true }),
        });
        if (!response.ok && response.status !== 202)
          throw new Error(await responseError(response, "资料分析失败"));
        const payload = (await response.json()) as {
          analysis?: DocumentAnalysis;
          workspace?: PublicWorkspaceState;
          background?: boolean;
          notice?: string;
        };
        if (response.status === 202 || payload.background) {
          if (payload.workspace) applyWorkspace(payload.workspace);
          notify(payload.notice || "分析已在后台开始，可以离开此页。完成后资料卡会更新。");
          return "started";
        }
        if (!payload.workspace || !payload.analysis)
          throw new Error("资料分析响应不完整，请重试。 ");
        applyWorkspace(payload.workspace);
        onPracticeReset();
        notify(`《${payload.analysis.documentTitle || "该资料"}》已分析完成。`);
        return "done";
      } catch (error) {
        await loadWorkspace();
        notify(`AI 分析失败：${error instanceof Error ? error.message : "请稍后重试"}`);
        return "failed";
      } finally {
        setWorkingMaterialId(null);
      }
    },
    [
      applyWorkspace,
      ensureAiReady,
      loadWorkspace,
      notify,
      onPracticeReset,
      requestHeaders,
      selectedModel,
    ],
  );

  const uploadAndAnalyze = useCallback(
    async (file: File, course: Course | undefined): Promise<AnalysisAttempt> => {
      if (!course) {
        notify("请先创建一门课程，再上传资料。 ");
        return { persisted: false, analyzed: false };
      }
      try {
        const form = new FormData();
        form.append("courseId", course.id);
        form.append("file", file);
        const response = await fetch("/api/materials", { method: "POST", body: form });
        if (!response.ok) throw new Error(await responseError(response, "资料保存失败"));
        const payload = (await response.json()) as {
          material?: Material;
          workspace?: PublicWorkspaceState;
        };
        if (!payload.material || !payload.workspace)
          throw new Error("资料保存响应不完整，请重试。 ");
        applyWorkspace(payload.workspace);
        if (!ensureAiReady()) {
          notify(`《${file.name}》已安全保存。配置 AI 后，直接继续分析即可。`);
          return { persisted: true, analyzed: false, materialId: payload.material.id };
        }
        notify(`《${file.name}》已安全保存，开始请求 AI 分析…`);
        const status = await analyzeStoredMaterial(payload.material.id);
        return {
          persisted: true,
          analyzed: status === "done",
          started: status === "started",
          materialId: payload.material.id,
        };
      } catch (error) {
        notify(`资料未能保存：${error instanceof Error ? error.message : "请稍后重试"}`);
        return { persisted: false, analyzed: false };
      }
    },
    [analyzeStoredMaterial, applyWorkspace, ensureAiReady, notify],
  );

  const synthesizeCourse = useCallback(
    async (course: Course | undefined) => {
      if (!course || !workspace) return;
      const completed = workspace.materials
        .filter((material) => material.courseId === course.id)
        .map((material) => workspace.documentAnalyses[material.id])
        .filter((analysis): analysis is DocumentAnalysis => Boolean(analysis));
      if (!completed.length) {
        notify("请先完成至少一份资料的 AI 分析，再生成课程汇总。 ");
        return;
      }
      if (!ensureAiReady()) return;
      setSynthesizingCourseId(course.id);
      try {
        const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}/synthesize`, {
          method: "POST",
          headers: { ...JSON_HEADERS, ...requestHeaders() },
          body: JSON.stringify({ model: selectedModel, background: true }),
        });
        if (!response.ok && response.status !== 202)
          throw new Error(await responseError(response, "课程综合失败"));
        const payload = (await response.json()) as {
          analysis?: CourseSynthesis;
          workspace?: PublicWorkspaceState;
          background?: boolean;
          notice?: string;
        };
        if (response.status === 202 || payload.background) {
          if (payload.workspace) applyWorkspace(payload.workspace);
          notify(payload.notice || "课程综合已在后台开始。");
          return;
        }
        if (!payload.workspace || !payload.analysis)
          throw new Error("课程综合响应不完整，请重试。 ");
        applyWorkspace(payload.workspace);
        onPracticeReset();
        notify(`已综合 ${completed.length} 份资料：高频考点和练习题已更新。`);
      } catch (error) {
        notify(`课程综合失败：${error instanceof Error ? error.message : "请稍后重试"}`);
      } finally {
        setSynthesizingCourseId(null);
      }
    },
    [
      applyWorkspace,
      ensureAiReady,
      notify,
      onPracticeReset,
      requestHeaders,
      selectedModel,
      workspace,
    ],
  );

  const regeneratePlan = useCallback(async () => {
    setSavingPlan(true);
    try {
      const response = await fetch("/api/plan/generate", {
        method: "POST",
        headers: { ...JSON_HEADERS, ...requestHeaders() },
        body: JSON.stringify({ background: aiReady }),
      });
      if (!response.ok && response.status !== 202)
        throw new Error(await responseError(response, "计划生成失败"));
      const payload = (await response.json()) as {
        workspace?: PublicWorkspaceState;
        generatedBy?: "ai" | "schedule";
        background?: boolean;
        notice?: string;
      };
      if (!payload.workspace) throw new Error("计划响应不完整，请重试。 ");
      applyWorkspace(payload.workspace);
      if (payload.background) notify(payload.notice || "计划正在后台生成，可以离开此页。");
      else if (payload.generatedBy === "ai")
        notify("AI 已依据考点证据与可用时间生成新的复习计划。");
      else notify("未配置 AI：已按考试日期与掌握度本地重排（未调用 AI）。");
    } catch (error) {
      notify(`计划未能重排：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setSavingPlan(false);
    }
  }, [aiReady, applyWorkspace, notify, requestHeaders]);

  /** 把错过的任务重新排进计划。 */
  const rescheduleMissed = useCallback(async () => {
    setSavingPlan(true);
    try {
      const response = await fetch("/api/plan/missed", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(await responseError(response, "重排失败"));
      const payload = (await response.json()) as {
        workspace?: PublicWorkspaceState;
        notice?: string;
      };
      if (!payload.workspace) throw new Error("重排响应不完整，请重试。 ");
      applyWorkspace(payload.workspace);
      notify(payload.notice || "已重新安排错过的任务。");
    } catch (error) {
      notify(`错过的任务未能重排：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setSavingPlan(false);
    }
  }, [applyWorkspace, notify]);

  const saveCourse = useCallback(
    async (
      draft: {
        name: string;
        code: string;
        teacher: string;
        term: string;
        examDate: string;
        priority: Course["priority"];
      },
      editingCourseId: string | null,
    ): Promise<string | undefined> => {
      setSavingCourse(true);
      try {
        const endpoint = editingCourseId
          ? `/api/courses/${encodeURIComponent(editingCourseId)}`
          : "/api/courses";
        const response = await fetch(endpoint, {
          method: editingCourseId ? "PATCH" : "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(draft),
        });
        if (!response.ok)
          throw new Error(
            await responseError(response, editingCourseId ? "更新课程失败" : "创建课程失败"),
          );
        if (editingCourseId) {
          const payload = (await response.json()) as { workspace?: PublicWorkspaceState };
          if (!payload.workspace) throw new Error("课程更新响应不完整，请重试。 ");
          applyWorkspace(payload.workspace);
          notify(`已更新「${draft.name}」。`);
          return undefined;
        }
        const payload = (await response.json()) as {
          course?: Course;
          workspace?: PublicWorkspaceState;
        };
        if (!payload.course || !payload.workspace) throw new Error("课程创建响应不完整，请重试。 ");
        applyWorkspace(payload.workspace);
        notify(`已创建「${payload.course.name}」，现在可以上传资料。`);
        return payload.course.id;
      } catch (error) {
        notify(`课程未能保存：${error instanceof Error ? error.message : "请检查必填项"}`);
        return undefined;
      } finally {
        setSavingCourse(false);
      }
    },
    [applyWorkspace, notify],
  );

  const deleteCourse = useCallback(
    async (course: Course) => {
      const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await responseError(response, "课程删除失败"));
      applyWorkspace((await response.json()) as PublicWorkspaceState);
      notify(`已删除「${course.name}」及其相关数据。`);
    },
    [applyWorkspace, notify],
  );

  const deleteMaterial = useCallback(
    async (material: Material) => {
      const response = await fetch(`/api/materials/${encodeURIComponent(material.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await responseError(response, "资料删除失败"));
      applyWorkspace((await response.json()) as PublicWorkspaceState);
      notify(`已删除「${material.name}」。`);
    },
    [applyWorkspace, notify],
  );

  const completeTask = useCallback(
    async (id: string, completed: boolean) => {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ completed }),
        });
        if (!response.ok) throw new Error(await responseError(response, "任务更新失败"));
        applyWorkspace((await response.json()) as PublicWorkspaceState);
        notify(completed ? "已保存任务完成状态。" : "已把任务重新标记为待完成。");
      } catch (error) {
        notify(`任务未能保存：${error instanceof Error ? error.message : "请稍后重试"}`);
      }
    },
    [applyWorkspace, notify],
  );

  const saveAvailability = useCallback(
    async (availability: unknown) => {
      setSavingAvailability(true);
      try {
        const response = await fetch("/api/workspace", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ availability }),
        });
        if (!response.ok) throw new Error(await responseError(response, "可用时间保存失败"));
        applyWorkspace((await response.json()) as PublicWorkspaceState);
        notify("每日可用时间已保存，计划已重排。 ");
      } catch (error) {
        notify(`可用时间未能保存：${error instanceof Error ? error.message : "请稍后重试"}`);
      } finally {
        setSavingAvailability(false);
      }
    },
    [applyWorkspace, notify],
  );

  const saveProfile = useCallback(
    async (draft: unknown) => {
      setSavingProfile(true);
      try {
        const response = await fetch("/api/workspace", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify(draft),
        });
        if (!response.ok) throw new Error(await responseError(response, "个人资料保存失败"));
        applyWorkspace((await response.json()) as PublicWorkspaceState);
        notify("个人资料已保存。 ");
      } catch (error) {
        notify(`个人资料未能保存：${error instanceof Error ? error.message : "请稍后重试"}`);
      } finally {
        setSavingProfile(false);
      }
    },
    [applyWorkspace, notify],
  );

  const [importing, setImporting] = useState(false);

  /** 确认「需确认」的分析结果。 */
  const confirmMaterialAnalysis = useCallback(
    async (materialId: string) => {
      try {
        const response = await fetch(`/api/materials/${encodeURIComponent(materialId)}/confirm`, {
          method: "POST",
        });
        if (!response.ok) throw new Error(await responseError(response, "确认失败"));
        applyWorkspace((await response.json()) as PublicWorkspaceState);
        notify("已确认这份资料的分析结果。");
      } catch (error) {
        notify(`未能确认：${error instanceof Error ? error.message : "请稍后重试"}`);
      }
    },
    [applyWorkspace, notify],
  );

  /** 忽略/恢复一个考点：只影响展示、抽题与排期。 */
  const toggleInsight = useCallback(
    async (insightId: string, hidden: boolean) => {
      try {
        const response = await fetch(`/api/insights/${encodeURIComponent(insightId)}`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ hidden }),
        });
        if (!response.ok) throw new Error(await responseError(response, "考点更新失败"));
        applyWorkspace((await response.json()) as PublicWorkspaceState);
        notify(hidden ? "已忽略该考点，练习与计划不再包含它。" : "已恢复该考点。");
      } catch (error) {
        notify(`考点未能更新：${error instanceof Error ? error.message : "请稍后重试"}`);
      }
    },
    [applyWorkspace, notify],
  );

  /** 修正题目的正确答案。 */
  const overrideQuestionAnswer = useCallback(
    async (questionId: string, answer: string) => {
      try {
        const response = await fetch(`/api/questions/${encodeURIComponent(questionId)}/answer`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ answer }),
        });
        if (!response.ok) throw new Error(await responseError(response, "答案修正失败"));
        applyWorkspace((await response.json()) as PublicWorkspaceState);
        notify(answer.trim() ? "已保存修正后的答案。" : "已恢复模型原本的答案。");
      } catch (error) {
        notify(`答案未能修正：${error instanceof Error ? error.message : "请稍后重试"}`);
      }
    },
    [applyWorkspace, notify],
  );

  /** 导入是整份替换：先在界面上确认，再上传，服务端还会另存一份导入前备份。 */
  const importWorkspace = useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          throw new Error("这份文件不是有效的 JSON 备份。");
        }
        const response = await fetch("/api/workspace/import", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(parsed),
        });
        if (!response.ok) throw new Error(await responseError(response, "工作区导入失败"));
        const payload = (await response.json()) as {
          workspace?: PublicWorkspaceState;
          notice?: string;
        };
        if (!payload.workspace) throw new Error("导入响应不完整，请重试。 ");
        applyWorkspace(payload.workspace);
        onPracticeReset();
        notify(payload.notice || "工作区已导入。 ");
      } catch (error) {
        notify(`未能导入：${error instanceof Error ? error.message : "请稍后重试"}`);
      } finally {
        setImporting(false);
      }
    },
    [applyWorkspace, notify, onPracticeReset],
  );

  const requestEmailOtp = useCallback(
    async (email: string) => {
      setOtpPending(true);
      try {
        const response = await fetch("/api/auth/otp/request", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ email }),
        });
        if (!response.ok) throw new Error(await responseError(response, "验证码发送失败"));
        notify("验证码已发送，请检查邮箱。 ");
      } catch (error) {
        notify(`验证码未能发送：${error instanceof Error ? error.message : "请稍后重试"}`);
      } finally {
        setOtpPending(false);
      }
    },
    [notify],
  );

  const verifyEmailOtp = useCallback(
    async (email: string, code: string) => {
      setOtpPending(true);
      try {
        const response = await fetch("/api/auth/otp/verify", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ email, code }),
        });
        if (!response.ok) throw new Error(await responseError(response, "验证码校验失败"));
        const payload = (await response.json()) as {
          workspace?: PublicWorkspaceState;
          schoolMatched?: boolean;
        };
        if (!payload.workspace) throw new Error("验证响应不完整，请重试。 ");
        applyWorkspace(payload.workspace);
        notify(
          payload.schoolMatched
            ? "邮箱与学校域名已验证，可使用校内互助。"
            : "邮箱已验证；请配置 SCHOOL_EMAIL_DOMAINS 后才能获得学校边界验证。 ",
        );
      } catch (error) {
        notify(`邮箱未能验证：${error instanceof Error ? error.message : "请稍后重试"}`);
      } finally {
        setOtpPending(false);
      }
    },
    [applyWorkspace, notify],
  );

  return {
    workingMaterialId,
    synthesizingCourseId,
    savingPlan,
    savingAvailability,
    savingCourse,
    savingProfile,
    otpPending,
    analyzeStoredMaterial,
    uploadAndAnalyze,
    synthesizeCourse,
    regeneratePlan,
    rescheduleMissed,
    saveCourse,
    deleteCourse,
    deleteMaterial,
    completeTask,
    saveAvailability,
    saveProfile,
    requestEmailOtp,
    verifyEmailOtp,
    downloadMaterial: (material: Material) =>
      triggerDownload(`/api/materials/${encodeURIComponent(material.id)}/download`),
    exportWorkspace: () => triggerDownload("/api/workspace/export"),
    importWorkspace,
    importing,
    confirmMaterialAnalysis,
    toggleInsight,
    overrideQuestionAnswer,
  };
}
