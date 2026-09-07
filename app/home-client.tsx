"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiStatus, CourseSynthesis, DocumentAnalysis } from "@/lib/ai-types";
import type { Availability, Course, Insight, Material, StudyTask } from "@/lib/types";
import type { PracticeReveal, PublicWorkspaceState } from "@/lib/workspace-types";
import { courseById, daysUntilExam, formatExamDate, initials } from "./ui-helpers";
import type { AnalysisAttempt, CourseAiRecord, CourseDraft, ProfileDraft, View } from "./ui-types";
import { VIEW_QUERY } from "./ui-types";

const defaultProfileDraft = (): ProfileDraft => ({ displayName: "", email: "", school: "", examGoal: "在期末前完成一轮高频考点复习", timezone: "Asia/Shanghai", studyDayStart: "18:30" });

const SESSION_API_KEY = "finale-agent.openai-api-key";
const SESSION_BASE_URL = "finale-agent.openai-base-url";
const SESSION_MODEL = "finale-agent.ai-model";
const fallbackAiStatus: AiStatus = {
  configured: false,
  source: "none",
  defaultModel: "gpt-5-mini",
  allowedModels: ["gpt-5-mini", "gpt-5", "gpt-4.1-mini"],
  customBaseUrlAllowed: false,
};

const navItems: Array<{ view: View; icon: string; subtitle: string }> = [
  { view: "总览", icon: "◈", subtitle: "今天的复习重点" },
  { view: "学习计划", icon: "◫", subtitle: "可完成的复习节奏" },
  { view: "资料分析", icon: "◌", subtitle: "从资料提取考点" },
  { view: "练习测验", icon: "✓", subtitle: "带着依据练习" },
  { view: "校内互助", icon: "↗", subtitle: "审核后同校共享" },
];

function DeferredViewLoading({ label }: { label: string }) {
  return <section className="onboarding-card" role="status" aria-live="polite" aria-busy="true"><p className="eyebrow">LOADING VIEW</p><h2>正在载入{label}…</h2><p>页面资源正在按需加载，请稍候。</p></section>;
}

function DeferredModalLoading({ label }: { label: string }) {
  return <div className="modal-backdrop" role="status" aria-live="polite" aria-busy="true"><section className="modal compact"><p className="eyebrow">OPENING</p><h2>正在打开{label}…</h2></section></div>;
}

const PlanView = dynamic(() => import("./views/plan-view"), {
  loading: () => <DeferredViewLoading label="学习计划" />,
});
const AnalysisView = dynamic(() => import("./views/analysis-view"), {
  loading: () => <DeferredViewLoading label="资料分析" />,
});
const PracticeView = dynamic(() => import("./views/practice-view"), {
  loading: () => <DeferredViewLoading label="练习测验" />,
});
const CommunityView = dynamic(() => import("./views/community-view"), {
  loading: () => <DeferredViewLoading label="校内互助" />,
});
const ProfileModal = dynamic(() => import("./modals/profile-modal"), {
  loading: () => <DeferredModalLoading label="个人资料设置" />,
});
const AiSettingsModal = dynamic(() => import("./modals/ai-settings-modal"), {
  loading: () => <DeferredModalLoading label="AI 设置" />,
});
const CourseModal = dynamic(() => import("./modals/course-modal"), {
  loading: () => <DeferredModalLoading label="课程设置" />,
});
const ConfirmModal = dynamic(() => import("./modals/confirm-modal"), {
  loading: () => <DeferredModalLoading label="确认" />,
});

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function messageFromResponse(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const body = payload as { error?: unknown; message?: unknown };
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  return fallback;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  return messageFromResponse(await response.json().catch(() => undefined), fallback);
}

function normalizeOpenAiBaseUrl(value: string): { value: string; error?: string } {
  const rawValue = value.trim();
  if (!rawValue) return { value: "" };
  try {
    const parsed = new URL(rawValue);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { value: "", error: "兼容地址必须以 http:// 或 https:// 开头。" };
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return { value: "", error: "兼容地址不能包含账号、查询参数或锚点。" };
    const normalized = rawValue.replace(/\/+$/, "");
    if (/\/(?:responses|files)(?:\/|$)/i.test(new URL(normalized).pathname)) return { value: "", error: "请填写 API 根地址，例如 https://api.openai.com/v1；不要填写 /responses 或 /files。" };
    return { value: normalized };
  } catch {
    return { value: "", error: "请输入有效的完整 API 根地址，例如 https://api.openai.com/v1。" };
  }
}

function defaultCourseDraft(): CourseDraft {
  const exam = new Date();
  exam.setDate(exam.getDate() + 28);
  return { name: "", code: "", teacher: "", term: `${new Date().getFullYear()} 秋`, examDate: localDateKey(exam), priority: "中" };
}

function courseAiRecordFor(
  workspace: PublicWorkspaceState | null,
  courseId: string | undefined,
  model: string,
  workingMaterialId: string | null,
  synthesizingCourseId: string | null,
): CourseAiRecord | undefined {
  if (!workspace || !courseId) return undefined;
  const materials = workspace.materials.filter((material) => material.courseId === courseId);
  const analyses = materials.map((material) => workspace.documentAnalyses[material.id]).filter((analysis): analysis is DocumentAnalysis => Boolean(analysis));
  const synthesis = workspace.courseSyntheses[courseId];
  const workingMaterial = materials.find((material) => material.id === workingMaterialId);
  const failedMaterial = materials.find((material) => material.status === "失败");

  if (synthesizingCourseId === courseId) {
    return { status: "synthesizing", documentCount: analyses.length, summary: "正在综合本课程已分析资料，生成高频考点与练习题…", provider: "OpenAI-compatible API", model, warnings: [], studyActions: [], questionPatterns: analyses.flatMap((analysis) => analysis.questionPatterns).slice(0, 4), synthesized: false };
  }
  if (workingMaterial) {
    return { status: "analyzing", documentCount: analyses.length, summary: `正在分析《${workingMaterial.name}》，文件已保存在本地工作区。`, provider: "OpenAI-compatible API", model, warnings: [], studyActions: [], questionPatterns: [], synthesized: Boolean(synthesis) };
  }
  if (synthesis) {
    return { status: "ready", documentCount: analyses.length, summary: synthesis.summary, provider: "OpenAI-compatible API", model, warnings: synthesis.warnings, studyActions: synthesis.recommendedStudyActions, questionPatterns: analyses.flatMap((analysis) => analysis.questionPatterns).slice(0, 4), synthesized: true };
  }
  if (analyses.length) {
    const latest = analyses[analyses.length - 1];
    return { status: "ready", documentCount: analyses.length, summary: latest.summary, provider: "OpenAI-compatible API", model, warnings: latest.warnings, studyActions: latest.studyActions, questionPatterns: latest.questionPatterns, synthesized: false };
  }
  if (failedMaterial) {
    return { status: "error", documentCount: analyses.length, summary: failedMaterial.error || "有资料未完成 AI 分析，可在资料卡上重试。", provider: "OpenAI-compatible API", model, warnings: [failedMaterial.error || `${failedMaterial.name} 分析未完成`], studyActions: [], questionPatterns: [], synthesized: false };
  }
  return undefined;
}

interface HomeClientProps {
  initialWorkspace: PublicWorkspaceState | null;
  initialWorkspaceError: string;
  initialToday: string;
  initialAiStatus: AiStatus;
  initialView: View;
  initialCourseId: string;
}

export default function HomeClient({ initialWorkspace, initialWorkspaceError, initialToday, initialAiStatus, initialView, initialCourseId }: HomeClientProps) {
  const router = useRouter();
  const [activeView, setActiveView] = useState<View>(initialView);
  const [workspace, setWorkspace] = useState<PublicWorkspaceState | null>(initialWorkspace);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState(initialWorkspaceError);
  const [selectedCourseId, setSelectedCourseId] = useState(
    initialCourseId && initialWorkspace?.courses.some((course) => course.id === initialCourseId)
      ? initialCourseId
      : (initialWorkspace?.courses[0]?.id ?? ""),
  );
  const [practiceReveal, setPracticeReveal] = useState<PracticeReveal[]>([]);
  const [practiceKnowledge, setPracticeKnowledge] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; danger?: boolean; run: () => Promise<void> } | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [workingMaterialId, setWorkingMaterialId] = useState<string | null>(null);
  const [synthesizingCourseId, setSynthesizingCourseId] = useState<string | null>(null);
  const [savingCourse, setSavingCourse] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  const [savingAvailability, setSavingAvailability] = useState(false);
  const [submittingPractice, setSubmittingPractice] = useState(false);
  const [toast, setToast] = useState("");
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [editingCourseId, setEditingCourseId] = useState<string | null>(null);
  const [courseDraft, setCourseDraft] = useState<CourseDraft>(() => defaultCourseDraft());
  const [practiceAnswers, setPracticeAnswers] = useState<Record<string, string>>({});
  const [practiceRating, setPracticeRating] = useState<number | undefined>(undefined);
  const [practiceSubmitted, setPracticeSubmitted] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(() => defaultProfileDraft());
  const [savingProfile, setSavingProfile] = useState(false);
  const [otpEmail, setOtpEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpPending, setOtpPending] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(initialAiStatus);
  const [aiStatusLoading, setAiStatusLoading] = useState(false);
  const [sessionApiKey, setSessionApiKey] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [sessionBaseUrl, setSessionBaseUrl] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [aiModel, setAiModel] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);

  const courseList = workspace?.courses ?? [];
  const selectedCourse = courseById(selectedCourseId, courseList) ?? courseList[0];
  const activeCourseId = selectedCourse?.id;
  const materials = activeCourseId ? workspace?.materials.filter((material) => material.courseId === activeCourseId) ?? [] : [];
  const visibleMaterials = materials.filter((material) => material.status !== "失败" || !materials.some((other) => other.id !== material.id && other.status === "已分析" && other.name === material.name));
  const insights = activeCourseId ? workspace?.insights.filter((insight) => insight.courseId === activeCourseId) ?? [] : [];
  const courseQuestions = activeCourseId ? workspace?.questions.filter((question) => question.courseId === activeCourseId) ?? [] : [];
  const knowledgeMatched = practiceKnowledge ? courseQuestions.filter((question) => question.knowledge === practiceKnowledge) : courseQuestions;
  const questions = knowledgeMatched.length ? knowledgeMatched : courseQuestions;
  const tasks = workspace?.tasks ?? [];
  const availability = workspace?.availability ?? [];
  const selectedModel = aiModel || aiStatus?.defaultModel || fallbackAiStatus.defaultModel;
  const modelOptions = aiStatus?.allowedModels?.length ? aiStatus.allowedModels : fallbackAiStatus.allowedModels;
  const aiReady = Boolean(sessionApiKey.trim() || aiStatus?.configured);
  const customBaseUrlDisabled = Boolean(sessionBaseUrl && aiStatus && !aiStatus.customBaseUrlAllowed);
  const analyzingId = workingMaterialId || materials.find((material) => material.status === "分析中")?.id || null;
  const synthesizingId = synthesizingCourseId || workspace?.processingJobs?.find((job) => job.type === "synthesize")?.targetId || null;
  const record = courseAiRecordFor(workspace, activeCourseId, selectedModel, analyzingId, synthesizingId);
  // The persisted plan window starts at "today" as computed in the profile
  // timezone; use it so the UI never disagrees with the server about which
  // day is today when the learner's timezone differs from the browser's.
  const today = availability[0]?.date ?? initialToday;
  const todayTasks = tasks.filter((task) => task.date === today);
  const plannedMinutes = todayTasks.reduce((total, task) => total + task.duration, 0);
  const completedMinutes = todayTasks.filter((task) => task.status === "已完成").reduce((total, task) => total + task.duration, 0);
  const profile = workspace?.profile;

  const navigate = useCallback((view: View, courseId?: string) => {
    setActiveView(view);
    const params = new URLSearchParams();
    params.set("view", VIEW_QUERY[view]);
    const nextCourse = courseId || selectedCourseId;
    if (nextCourse) params.set("course", nextCourse);
    router.replace(`/?${params.toString()}`, { scroll: false });
    document.title = view === "总览" ? "期末星图 · 复习 Agent" : `${view} · 期末星图`;
  }, [router, selectedCourseId]);

  const triggerDownload = (href: string) => {
    const link = document.createElement("a");
    link.href = href;
    link.rel = "noopener";
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
  };

  const notify = (message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4500);
  };

  const applyWorkspace = useCallback((nextWorkspace: PublicWorkspaceState) => {
    setWorkspace(nextWorkspace);
    setWorkspaceError("");
    setSelectedCourseId((current) => nextWorkspace.courses.some((course) => course.id === current) ? current : (nextWorkspace.courses[0]?.id ?? ""));
  }, []);

  const loadWorkspace = useCallback(async () => {
    setWorkspaceLoading(true);
    try {
      const response = await fetch("/api/workspace", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "无法读取本地学习工作区"));
      applyWorkspace(await response.json() as PublicWorkspaceState);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "无法读取本地学习工作区");
    } finally {
      setWorkspaceLoading(false);
    }
  }, [applyWorkspace]);

  useEffect(() => {
    const analyzing = workspace?.materials.some((material) => material.status === "分析中");
    const jobs = workspace?.processingJobs ?? [];
    if (!analyzing && !jobs.length) return;
    const timer = window.setInterval(() => { void loadWorkspace(); }, 2000);
    return () => window.clearInterval(timer);
  }, [workspace?.materials, workspace?.processingJobs, loadWorkspace]);

  const refreshAiStatus = useCallback(async () => {
    setAiStatusLoading(true);
    try {
      const response = await fetch("/api/ai/status", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "无法读取 AI 配置状态"));
      const payload = await response.json() as AiStatus;
      const status: AiStatus = {
        configured: Boolean(payload.configured),
        source: payload.source === "environment" ? "environment" : "none",
        defaultModel: payload.defaultModel || fallbackAiStatus.defaultModel,
        allowedModels: payload.allowedModels?.length ? payload.allowedModels : fallbackAiStatus.allowedModels,
        customBaseUrlAllowed: Boolean(payload.customBaseUrlAllowed),
      };
      setAiStatus(status);
      setAiModel((current) => {
        const saved = window.sessionStorage.getItem(SESSION_MODEL) ?? "";
        const next = current.trim() || saved.trim() || status.defaultModel;
        window.sessionStorage.setItem(SESSION_MODEL, next);
        return next;
      });
    } catch {
      setAiStatus(null);
    } finally {
      setAiStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    const savedKey = window.sessionStorage.getItem(SESSION_API_KEY) ?? "";
    const savedBaseUrl = window.sessionStorage.getItem(SESSION_BASE_URL) ?? "";
    const savedModel = window.sessionStorage.getItem(SESSION_MODEL) ?? "";
    setSessionApiKey(savedKey);
    setApiKeyDraft(savedKey);
    setSessionBaseUrl(savedBaseUrl);
    setBaseUrlDraft(savedBaseUrl);
    setAiModel(savedModel);
  }, []);

  const openProfileSettings = () => {
    const current = workspace?.profile;
    setProfileDraft({
      displayName: current?.displayName ?? "",
      email: current?.email ?? "",
      school: current?.school ?? "",
      examGoal: current?.examGoal ?? defaultProfileDraft().examGoal,
      timezone: current?.timezone ?? defaultProfileDraft().timezone,
      studyDayStart: current?.studyDayStart ?? defaultProfileDraft().studyDayStart,
    });
    setOtpEmail(current?.email ?? "");
    setOtpCode("");
    setShowProfileSettings(true);
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const response = await fetch("/api/workspace", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profileDraft) });
      if (!response.ok) throw new Error(await responseError(response, "个人资料保存失败"));
      applyWorkspace(await response.json() as PublicWorkspaceState);
      notify("个人资料已保存。 ");
    } catch (error) {
      notify(`个人资料未能保存：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setSavingProfile(false);
    }
  };

  const exportWorkspace = () => {
    triggerDownload("/api/workspace/export");
  };

  const requestEmailOtp = async () => {
    setOtpPending(true);
    try {
      const response = await fetch("/api/auth/otp/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: otpEmail }) });
      if (!response.ok) throw new Error(await responseError(response, "验证码发送失败"));
      notify("验证码已发送，请检查邮箱。 ");
    } catch (error) {
      notify(`验证码未能发送：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setOtpPending(false);
    }
  };

  const verifyEmailOtp = async () => {
    setOtpPending(true);
    try {
      const response = await fetch("/api/auth/otp/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: otpEmail, code: otpCode }) });
      if (!response.ok) throw new Error(await responseError(response, "验证码校验失败"));
      const payload = await response.json() as { workspace?: PublicWorkspaceState; schoolMatched?: boolean };
      if (!payload.workspace) throw new Error("验证响应不完整，请重试。 ");
      applyWorkspace(payload.workspace);
      notify(payload.schoolMatched ? "邮箱与学校域名已验证，可使用校内互助。" : "邮箱已验证；请配置 SCHOOL_EMAIL_DOMAINS 后才能获得学校边界验证。 ");
    } catch (error) {
      notify(`邮箱未能验证：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setOtpPending(false);
    }
  };

  const saveAvailability = async (nextAvailability: Availability[]) => {
    setSavingAvailability(true);
    try {
      const response = await fetch("/api/workspace", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ availability: nextAvailability }) });
      if (!response.ok) throw new Error(await responseError(response, "可用时间保存失败"));
      applyWorkspace(await response.json() as PublicWorkspaceState);
      notify("每日可用时间已保存，计划已重排。 ");
    } catch (error) {
      notify(`可用时间未能保存：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setSavingAvailability(false);
    }
  };

  const requestHeaders = (): HeadersInit => {
    const headers: Record<string, string> = {};
    if (sessionApiKey.trim()) headers["X-OpenAI-API-Key"] = sessionApiKey.trim();
    if (sessionBaseUrl.trim()) headers["X-OpenAI-Base-URL"] = sessionBaseUrl.trim();
    return headers;
  };

  const updateAiModel = (model: string) => {
    const next = model.slice(0, 128);
    setAiModel(next);
    window.sessionStorage.setItem(SESSION_MODEL, next);
  };

  const openAiSettings = () => {
    setShowAiSettings(true);
    void refreshAiStatus();
  };

  const saveSessionAiConfig = () => {
    const endpoint = normalizeOpenAiBaseUrl(baseUrlDraft);
    if (endpoint.error) {
      notify(endpoint.error);
      return;
    }
    const key = apiKeyDraft.trim();
    if (endpoint.value && !key) {
      notify("自定义地址必须同时提供本次会话 Key。");
      return;
    }
    if (key) window.sessionStorage.setItem(SESSION_API_KEY, key); else window.sessionStorage.removeItem(SESSION_API_KEY);
    if (endpoint.value) window.sessionStorage.setItem(SESSION_BASE_URL, endpoint.value); else window.sessionStorage.removeItem(SESSION_BASE_URL);
    setSessionApiKey(key);
    setSessionBaseUrl(endpoint.value);
    setBaseUrlDraft(endpoint.value);
    notify("AI 会话配置已保存；关闭浏览器会话后会自动清除。");
  };

  const clearSessionAiConfig = () => {
    window.sessionStorage.removeItem(SESSION_API_KEY);
    window.sessionStorage.removeItem(SESSION_BASE_URL);
    setSessionApiKey("");
    setApiKeyDraft("");
    setSessionBaseUrl("");
    setBaseUrlDraft("");
    notify(aiStatus?.configured ? "已清除会话配置，将使用服务端环境配置。" : "已清除会话配置。再次分析前请重新配置 Key。 ");
  };

  const ensureAiReady = (): boolean => {
    if (aiStatusLoading) {
      openAiSettings();
      notify("正在检查 AI 配置，请稍候再开始分析。 ");
      return false;
    }
    if (aiReady) return true;
    openAiSettings();
    notify("请先在 AI 设置中配置本次会话的 API Key。 ");
    return false;
  };

  const analyzeStoredMaterial = async (materialId: string): Promise<boolean> => {
    if (!ensureAiReady()) return false;
    setWorkingMaterialId(materialId);
    try {
      const response = await fetch(`/api/materials/${encodeURIComponent(materialId)}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...requestHeaders() },
        body: JSON.stringify({ model: selectedModel, background: true }),
      });
      if (!response.ok && response.status !== 202) throw new Error(await responseError(response, "资料分析失败"));
      const payload = await response.json() as { analysis?: DocumentAnalysis; workspace?: PublicWorkspaceState; background?: boolean; notice?: string };
      if (response.status === 202 || payload.background) {
        if (payload.workspace) applyWorkspace(payload.workspace);
        notify(payload.notice || "分析已在后台开始，可以离开此页。完成后资料卡会更新。");
        return false;
      }
      if (!payload.workspace || !payload.analysis) throw new Error("资料分析响应不完整，请重试。 ");
      applyWorkspace(payload.workspace);
      setPracticeAnswers({});
      setPracticeRating(undefined);
      setPracticeSubmitted(false);
      notify(`《${payload.analysis.documentTitle || "该资料"}》已分析完成。`);
      return true;
    } catch (error) {
      await loadWorkspace();
      notify(`AI 分析失败：${error instanceof Error ? error.message : "请稍后重试"}`);
      return false;
    } finally {
      setWorkingMaterialId(null);
    }
  };

  const uploadAndAnalyze = async (file: File): Promise<AnalysisAttempt> => {
    if (!selectedCourse) {
      openNewCourse();
      notify("请先创建一门课程，再上传资料。 ");
      return { persisted: false, analyzed: false };
    }
    try {
      const form = new FormData();
      form.append("courseId", selectedCourse.id);
      form.append("file", file);
      const response = await fetch("/api/materials", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseError(response, "资料保存失败"));
      const payload = await response.json() as { material?: Material; workspace?: PublicWorkspaceState };
      if (!payload.material || !payload.workspace) throw new Error("资料保存响应不完整，请重试。 ");
      applyWorkspace(payload.workspace);
      if (!ensureAiReady()) {
        notify(`《${file.name}》已安全保存。配置 AI 后，直接继续分析即可。`);
        return { persisted: true, analyzed: false, materialId: payload.material.id };
      }
      notify(`《${file.name}》已安全保存，开始请求 AI 分析…`);
      return { persisted: true, analyzed: await analyzeStoredMaterial(payload.material.id), materialId: payload.material.id };
    } catch (error) {
      notify(`资料未能保存：${error instanceof Error ? error.message : "请稍后重试"}`);
      return { persisted: false, analyzed: false };
    }
  };

  const synthesizeCourse = async () => {
    if (!selectedCourse) return;
    const completedAnalyses = materials.map((material) => workspace?.documentAnalyses[material.id]).filter((analysis): analysis is DocumentAnalysis => Boolean(analysis));
    if (!completedAnalyses.length) {
      notify("请先完成至少一份资料的 AI 分析，再生成课程汇总。 ");
      return;
    }
    if (!ensureAiReady()) return;
    setSynthesizingCourseId(selectedCourse.id);
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(selectedCourse.id)}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...requestHeaders() },
        body: JSON.stringify({ model: selectedModel, background: true }),
      });
      if (!response.ok && response.status !== 202) throw new Error(await responseError(response, "课程综合失败"));
      const payload = await response.json() as { analysis?: CourseSynthesis; workspace?: PublicWorkspaceState; background?: boolean; notice?: string };
      if (response.status === 202 || payload.background) {
        if (payload.workspace) applyWorkspace(payload.workspace);
        notify(payload.notice || "课程综合已在后台开始。");
        return;
      }
      if (!payload.workspace || !payload.analysis) throw new Error("课程综合响应不完整，请重试。 ");
      applyWorkspace(payload.workspace);
      setPracticeAnswers({});
      setPracticeRating(undefined);
      setPracticeSubmitted(false);
      notify(`已综合 ${completedAnalyses.length} 份资料：高频考点和练习题已更新。`);
    } catch (error) {
      notify(`课程综合失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setSynthesizingCourseId(null);
    }
  };

  const completeTask = async (id: string) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    const completed = task.status !== "已完成";
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed }) });
      if (!response.ok) throw new Error(await responseError(response, "任务更新失败"));
      applyWorkspace(await response.json() as PublicWorkspaceState);
      notify(completed ? "已保存任务完成状态。" : "已把任务重新标记为待完成。");
    } catch (error) {
      notify(`任务未能保存：${error instanceof Error ? error.message : "请稍后重试"}`);
    }
  };

  const regeneratePlan = async () => {
    setSavingPlan(true);
    try {
      const response = await fetch("/api/plan/generate", { method: "POST", headers: { "Content-Type": "application/json", ...requestHeaders() }, body: "{}" });
      if (!response.ok) throw new Error(await responseError(response, "计划生成失败"));
      const payload = await response.json() as { workspace?: PublicWorkspaceState; generatedBy?: "ai" | "schedule" };
      if (!payload.workspace) throw new Error("计划响应不完整，请重试。 ");
      applyWorkspace(payload.workspace);
      if (payload.generatedBy === "ai") {
        notify("AI 已依据考点证据与可用时间生成新的复习计划。");
      } else {
        notify("未配置 AI：已按考试日期与掌握度本地重排（未调用 AI）。");
      }
    } catch (error) {
      notify(`计划未能重排：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setSavingPlan(false);
    }
  };

  const submitPractice = async () => {
    if (!selectedCourse) return;
    if (!Object.keys(practiceAnswers).length) {
      notify("请至少完成一题再提交。 ");
      return;
    }
    setSubmittingPractice(true);
    try {
      const response = await fetch("/api/assessments/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId: selectedCourse.id, answers: practiceAnswers, selfRating: practiceRating }) });
      if (!response.ok) throw new Error(await responseError(response, "练习提交失败"));
      const payload = await response.json() as { workspace?: PublicWorkspaceState; correct?: number; total?: number; revealed?: PracticeReveal[] };
      if (!payload.workspace) throw new Error("练习结果响应不完整，请重试。 ");
      applyWorkspace(payload.workspace);
      setPracticeReveal(payload.revealed ?? []);
      setPracticeSubmitted(true);
      notify(`练习结果已保存：${payload.correct ?? 0}/${payload.total ?? 0} 题正确，后续计划已更新。`);
    } catch (error) {
      notify(`练习未能提交：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setSubmittingPractice(false);
    }
  };

  const openNewCourse = () => {
    setEditingCourseId(null);
    setCourseDraft(defaultCourseDraft());
    setShowCourseForm(true);
  };

  const openCourseEditor = (course: Course) => {
    setEditingCourseId(course.id);
    setCourseDraft({ name: course.name, code: course.code, teacher: course.teacher, term: course.term, examDate: course.examDate, priority: course.priority });
    setShowCourseForm(true);
  };

  const deleteCourseById = (course: Course) => {
    setConfirmAction({
      title: `删除「${course.name}」`,
      message: "将删除该课程及其全部资料、分析与练习记录。此操作不可撤销。",
      danger: true,
      run: async () => {
        const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(await responseError(response, "课程删除失败"));
        applyWorkspace(await response.json() as PublicWorkspaceState);
        notify(`已删除「${course.name}」及其相关数据。`);
      },
    });
  };

  const deleteMaterial = (material: Material) => {
    setConfirmAction({
      title: `删除「${material.name}」`,
      message: "分析结果和来源卡片也会被移除。此操作不可撤销。",
      danger: true,
      run: async () => {
        const response = await fetch(`/api/materials/${encodeURIComponent(material.id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(await responseError(response, "资料删除失败"));
        applyWorkspace(await response.json() as PublicWorkspaceState);
        notify(`已删除「${material.name}」。`);
      },
    });
  };

  const downloadMaterial = (material: Material) => {
    triggerDownload(`/api/materials/${encodeURIComponent(material.id)}/download`);
  };

  const addCourse = async () => {
    setSavingCourse(true);
    try {
      const endpoint = editingCourseId ? `/api/courses/${encodeURIComponent(editingCourseId)}` : "/api/courses";
      const response = await fetch(endpoint, { method: editingCourseId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(courseDraft) });
      if (!response.ok) throw new Error(await responseError(response, editingCourseId ? "更新课程失败" : "创建课程失败"));
      if (editingCourseId) {
        const payload = await response.json() as { workspace?: PublicWorkspaceState };
        if (!payload.workspace) throw new Error("课程更新响应不完整，请重试。 ");
        applyWorkspace(payload.workspace);
        notify(`已更新「${courseDraft.name}」。`);
      } else {
        const payload = await response.json() as { course?: Course; workspace?: PublicWorkspaceState };
        if (!payload.course || !payload.workspace) throw new Error("课程创建响应不完整，请重试。 ");
        applyWorkspace(payload.workspace);
        setSelectedCourseId(payload.course.id);
        notify(`已创建「${payload.course.name}」，现在可以上传资料。`);
        navigate("资料分析", payload.course.id);
      }
      setCourseDraft(defaultCourseDraft());
      setEditingCourseId(null);
      setShowCourseForm(false);
    } catch (error) {
      notify(`课程未能保存：${error instanceof Error ? error.message : "请检查必填项"}`);
    } finally {
      setSavingCourse(false);
    }
  };

  const selectCourse = (courseId: string) => {
    setSelectedCourseId(courseId);
    setPracticeAnswers({});
    setPracticeRating(undefined);
    setPracticeSubmitted(false);
    setPracticeReveal([]);
    setPracticeKnowledge("");
    const params = new URLSearchParams();
    params.set("view", VIEW_QUERY[activeView]);
    params.set("course", courseId);
    router.replace(`/?${params.toString()}`, { scroll: false });
  };

  const body = workspaceLoading ? <LoadingState /> : workspaceError ? <WorkspaceError message={workspaceError} onRetry={() => void loadWorkspace()} /> : !courseList.length ? <Onboarding onCreate={openNewCourse} /> : selectedCourse ? (
    <>
      {activeView === "总览" && <Overview courseList={courseList} tasks={todayTasks} plannedMinutes={plannedMinutes} completedMinutes={completedMinutes} insights={insights} today={today} missedCount={workspace?.missedTasks.length ?? 0} onComplete={completeTask} onNavigate={navigate} onRegenerate={() => void regeneratePlan()} isRegenerating={savingPlan} />}
      {activeView === "学习计划" && <PlanView tasks={tasks} courseList={courseList} availability={availability} planSource={workspace?.planSource} missedTasks={workspace?.missedTasks ?? []} today={today} onComplete={completeTask} onOpenPractice={(courseId, knowledge) => { setSelectedCourseId(courseId); setPracticeKnowledge(knowledge ?? ""); setPracticeAnswers({}); setPracticeSubmitted(false); setPracticeReveal([]); navigate("练习测验", courseId); }} onRegenerate={() => void regeneratePlan()} isRegenerating={savingPlan} onSaveAvailability={saveAvailability} savingAvailability={savingAvailability} />}
      {activeView === "资料分析" && <AnalysisView selectedCourse={selectedCourse} courseList={courseList} materials={visibleMaterials} insights={insights} aiRecord={record} insightsAreSynthesized={Boolean(workspace?.courseSyntheses[selectedCourse.id])} onSelectCourse={selectCourse} onUploadAndAnalyze={uploadAndAnalyze} onRetryAnalysis={analyzeStoredMaterial} onSynthesize={() => void synthesizeCourse()} onAddCourse={openNewCourse} onEditCourse={openCourseEditor} onDeleteCourse={deleteCourseById} onDownloadMaterial={downloadMaterial} onDeleteMaterial={deleteMaterial} />}
      {activeView === "练习测验" && <PracticeView selectedCourse={selectedCourse} courseList={courseList} questions={questions} insights={insights} attempts={workspace?.assessmentAttempts.filter((attempt) => attempt.courseId === selectedCourse.id) ?? []} answers={practiceAnswers} rating={practiceRating} submitted={practiceSubmitted} submitting={submittingPractice} revealed={practiceReveal} onSelectCourse={selectCourse} onChange={(id, value) => setPracticeAnswers((current) => ({ ...current, [id]: value }))} onRatingChange={setPracticeRating} onSubmit={() => void submitPractice()} onReset={() => { setPracticeAnswers({}); setPracticeRating(undefined); setPracticeSubmitted(false); setPracticeReveal([]); }} />}
      {activeView === "校内互助" && <CommunityView workspace={workspace} onApplyWorkspace={applyWorkspace} onNotify={notify} onNavigate={() => navigate("资料分析")} />}
    </>
  ) : null;

  const modalOpen = showProfileSettings || showAiSettings || showCourseForm || Boolean(confirmAction);

  return <main className="app-shell">
    <div className="app-chrome" {...(modalOpen ? { inert: true, "aria-hidden": true } : {})}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">f</div><div><strong>期末星图</strong><span>Finale Agent</span></div></div>
      <div className="student-card"><div className="avatar">{initials(profile?.displayName || "我")}</div><div><strong>{profile?.displayName || "本地学习者"}</strong><p>{profile?.school || "本地私有工作区"}</p></div><span className={profile?.verified ? "verified-badge" : "unverified"}>{profile?.verified ? "已验证" : "本地模式"}</span></div>
      <nav aria-label="复习空间"><p className="nav-label">复习空间</p>{navItems.map((item) => <button key={item.view} type="button" className={`nav-item ${activeView === item.view ? "active" : ""}`} aria-label={`${item.view}：${item.subtitle}`} aria-current={activeView === item.view ? "page" : undefined} onClick={() => navigate(item.view)} disabled={!courseList.length && item.view !== "总览"}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span><b>{item.view}</b><small>{item.subtitle}</small></span></button>)}</nav>
      <div className="sidebar-bottom"><div className="credit-card"><span>◈</span><div><small>存储状态</small><strong>{workspaceLoading ? "…" : "本地"}</strong></div><button onClick={() => void loadWorkspace()}>刷新</button></div><button className="settings" onClick={openAiSettings}>✦ AI 设置与隐私</button></div>
    </aside>
    <section className="workspace">
      <header className="topbar"><div><p className="eyebrow">{today}</p><h1>{activeView === "总览" ? "今天，先把最重要的事做完。" : activeView}</h1></div><div className="top-actions"><button className="ai-settings-button" onClick={openAiSettings} aria-label="打开 AI 设置"><span aria-hidden="true">✦</span> AI 设置</button><button className="profile-button" onClick={openProfileSettings} aria-label="打开个人资料设置"><span aria-hidden="true">{initials(profile?.displayName || "我")}</span>{profile?.displayName || "本地学习者"}</button></div></header>
      {body}
    </section>
    </div>
    {toast && <div className="toast" role={workspaceError ? "alert" : "status"} aria-live="polite" aria-atomic="true"><span aria-hidden="true">✦</span>{toast}</div>}
    {showProfileSettings && <ProfileModal profile={profile} draft={profileDraft} saving={savingProfile} otpEmail={otpEmail} otpCode={otpCode} otpPending={otpPending} onClose={() => setShowProfileSettings(false)} onChange={(patch) => setProfileDraft((current) => ({ ...current, ...patch }))} onSave={() => void saveProfile()} onExport={exportWorkspace} onOtpEmailChange={setOtpEmail} onOtpCodeChange={setOtpCode} onRequestOtp={() => void requestEmailOtp()} onVerifyOtp={() => void verifyEmailOtp()} />}
    {showAiSettings && <AiSettingsModal aiStatus={aiStatus} aiStatusLoading={aiStatusLoading} customBaseUrlDisabled={customBaseUrlDisabled} sessionApiKey={sessionApiKey} sessionBaseUrl={sessionBaseUrl} apiKeyDraft={apiKeyDraft} baseUrlDraft={baseUrlDraft} model={selectedModel} modelOptions={modelOptions} onClose={() => setShowAiSettings(false)} onRefresh={() => void refreshAiStatus()} onKeyChange={setApiKeyDraft} onBaseUrlChange={setBaseUrlDraft} onModelChange={updateAiModel} onSave={saveSessionAiConfig} onClear={clearSessionAiConfig} />}
    {showCourseForm && <CourseModal draft={courseDraft} editing={Boolean(editingCourseId)} saving={savingCourse} onClose={() => { setShowCourseForm(false); setEditingCourseId(null); }} onChange={(patch) => setCourseDraft((current) => ({ ...current, ...patch }))} onSubmit={() => void addCourse()} />}
    {confirmAction && <ConfirmModal title={confirmAction.title} message={confirmAction.message} confirmLabel="确定" danger={confirmAction.danger} pending={confirmPending} onClose={() => { if (!confirmPending) setConfirmAction(null); }} onConfirm={() => { setConfirmPending(true); void confirmAction.run().catch((error) => notify(error instanceof Error ? error.message : "操作失败")).finally(() => { setConfirmPending(false); setConfirmAction(null); }); }} />}
  </main>;
}

function LoadingState() {
  return <section className="onboarding-card"><p className="eyebrow">LOCAL WORKSPACE</p><h2>正在读取你的学习工作区…</h2><p>课程、资料、计划和练习结果都从本地持久化数据中恢复。</p></section>;
}

function WorkspaceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <section className="onboarding-card error"><p className="eyebrow">WORKSPACE UNAVAILABLE</p><h2>暂时无法读取学习工作区</h2><p>{message}</p><button className="primary" onClick={onRetry}>重新连接</button></section>;
}

function Onboarding({ onCreate }: { onCreate: () => void }) {
  return <section className="onboarding-card"><p className="eyebrow">WELCOME TO FINALE</p><h2>先创建你的第一门课程</h2><p>课程创建后，即可上传本机资料，进行真实 AI 分析，并生成可持久化的复习计划与练习。</p><button className="primary" onClick={onCreate}>创建第一门课程 <span>→</span></button></section>;
}

function Overview({ courseList, tasks, plannedMinutes, completedMinutes, insights, today, missedCount, onComplete, onNavigate, onRegenerate, isRegenerating }: { courseList: Course[]; tasks: StudyTask[]; plannedMinutes: number; completedMinutes: number; insights: Insight[]; today: string; missedCount: number; onComplete: (id: string) => void; onNavigate: (view: View) => void; onRegenerate: () => void; isRegenerating: boolean }) {
  const upcomingCourses = courseList.filter((course) => course.examDate >= today);
  const urgentCourse = [...upcomingCourses].sort((left, right) => left.examDate.localeCompare(right.examDate))[0] ?? [...courseList].sort((left, right) => left.examDate.localeCompare(right.examDate))[0];
  const nextInsight = insights[0];
  const progress = plannedMinutes ? Math.round((completedMinutes / plannedMinutes) * 100) : 0;
  return <div className="view-content overview">
    <section className="hero-grid"><div className="hero-card"><div className="hero-orbit orbit-a" /><div className="hero-orbit orbit-b" /><p>最近一场考试</p>{(() => {
      const daysLeft = urgentCourse ? daysUntilExam(urgentCourse.examDate, today) : null;
      const overdue = daysLeft !== null && daysLeft < 0;
      return <div className="countdown"><strong>{daysLeft === null ? "—" : overdue ? "已过" : daysLeft}</strong><span>{daysLeft === null ? "待设置" : overdue ? "考试日" : "天"}</span></div>;
    })()}<h2>{urgentCourse ? `${urgentCourse.name} · ${formatExamDate(urgentCourse.examDate)}` : "先创建课程"}</h2><p className="hero-note">计划会按照考试日期、优先级、掌握度和可用时间自动重排。</p><button className="light-button" type="button" onClick={() => onNavigate("学习计划")}>查看复习计划 <span>→</span></button></div><div className="progress-card"><div className="card-top"><span>今日进度</span><button onClick={onRegenerate} disabled={isRegenerating}>{isRegenerating ? "重排中…" : "重新排期 ↻"}</button></div><div className="ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><div><strong>{progress}%</strong><span>已完成</span></div></div><div className="progress-stats"><div><b>{completedMinutes}</b><span>已学习分钟</span></div><div><b>{plannedMinutes}</b><span>计划分钟</span></div></div></div><div className="insight-card"><div className="sparkle">✦</div><p>Agent 发现</p><h3>{nextInsight ? <>{nextInsight.title}<br /><em>{nextInsight.trend}</em></> : <>上传资料后<br />生成你的<br /><em>高频薄弱点</em></>}</h3><button onClick={() => onNavigate("资料分析")}>查看依据与来源 →</button></div></section>
    <section className="section-heading"><div><p className="eyebrow">TODAY&apos;S FOCUS</p><h2>今天的复习路径</h2></div><button className="text-button" onClick={() => onNavigate("学习计划")}>完整计划 <span>→</span></button></section>
    <div className="task-list">{tasks.length ? tasks.map((task) => { const course = courseById(task.courseId, courseList); return <article className={`task-row ${task.status === "已完成" ? "done" : ""}`} key={task.id}><button className="check" type="button" onClick={() => onComplete(task.id)} aria-pressed={task.status === "已完成"} aria-label={task.status === "已完成" ? `取消完成 ${task.title}` : `完成 ${task.title}`}>{task.status === "已完成" ? "✓" : ""}</button><time>{task.start}</time><span className="course-dot" style={{ backgroundColor: course?.color }} /><div className="task-copy"><h3>{task.title}</h3><p>{task.reason}</p></div><span className={`task-type ${task.type}`}>{task.type}</span><strong className="duration">{task.duration} min</strong></article>; }) : <p className="empty-state">尚无今日任务。点击“重新排期”即可生成首个计划。</p>}</div>
    {missedCount > 0 && <p className="missed-hint">有 {missedCount} 个错过的任务记录在学习计划页，可重新安排。</p>}
    <section className="lower-grid"><article className="mastery-card"><div className="card-top"><div><p className="eyebrow">MASTERY MAP</p><h2>掌握度一览</h2></div><button onClick={() => onNavigate("练习测验")}>去练习 →</button></div>{courseList.map((course) => <div className="mastery-row" key={course.id}><span className="course-dot" style={{ backgroundColor: course.color }} /><div><b>{course.name}</b><small>{course.code} · {course.examDate.slice(5).replace("-", "/")}</small></div><div className="bar"><i style={{ width: `${course.mastery}%`, background: course.color }} /></div><strong>{course.mastery}%</strong></div>)}</article><article className="nudge-card"><span>⌁</span><p>下一步</p><h3>{tasks[0]?.start || "生成计划"}</h3><b>{tasks[0]?.title || "上传一份课程资料"}</b><small>{tasks[0] ? `${tasks[0].duration} 分钟 · ${tasks[0].reason}` : "资料分析完成后会生成专属任务"}</small><button onClick={() => onNavigate(tasks[0] ? "学习计划" : "资料分析")}>继续</button></article></section>
  </div>;
}
