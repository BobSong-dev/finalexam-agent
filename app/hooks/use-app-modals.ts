"use client";

import { useCallback, useState } from "react";
import type { Course } from "@/lib/types";
import type { PublicWorkspaceState } from "@/lib/workspace-types";
import type { ConfirmRequest } from "../components/modal-host";
import type { CourseDraft, ProfileDraft } from "../ui-types";
import { normalizeOpenAiBaseUrl } from "../client-api";

const DEFAULT_PROFILE: ProfileDraft = {
  displayName: "",
  email: "",
  school: "",
  examGoal: "在期末前完成一轮高频考点复习",
  timezone: "Asia/Shanghai",
  studyDayStart: "18:30",
};

function defaultCourseDraft(): CourseDraft {
  const exam = new Date();
  exam.setDate(exam.getDate() + 28);
  const iso = `${exam.getFullYear()}-${String(exam.getMonth() + 1).padStart(2, "0")}-${String(exam.getDate()).padStart(2, "0")}`;
  return {
    name: "",
    code: "",
    teacher: "",
    term: `${new Date().getFullYear()} 秋`,
    examDate: iso,
    priority: "中",
  };
}

/**
 * 模态框与确认对话框的状态。集中在一处，让主组件只负责组装数据流。
 */
export function useAppModals(
  workspace: PublicWorkspaceState | null,
  notify: (message: string) => void,
) {
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [editingCourseId, setEditingCourseId] = useState<string | null>(null);
  const [courseDraft, setCourseDraft] = useState<CourseDraft>(() => defaultCourseDraft());
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(DEFAULT_PROFILE);
  const [otpEmail, setOtpEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [sessionDraftsFrom, setSessionDraftsFrom] = useState({ key: "", baseUrl: "" });

  /**
   * 会话配置保存/清除后，把编辑草稿同步到新值。调用发生在渲染期（render-phase
   * adjustment），因此必须只做纯状态比较，不能在 updater 里再触发别的 setState。
   */
  const syncSessionDrafts = useCallback(
    (key: string, baseUrl: string) => {
      if (sessionDraftsFrom.key === key && sessionDraftsFrom.baseUrl === baseUrl) return;
      setSessionDraftsFrom({ key, baseUrl });
      setApiKeyDraft(key);
      setBaseUrlDraft(baseUrl);
    },
    [sessionDraftsFrom],
  );

  const openProfile = useCallback(() => {
    const current = workspace?.profile;
    setProfileDraft({
      displayName: current?.displayName ?? "",
      email: current?.email ?? "",
      school: current?.school ?? "",
      examGoal: current?.examGoal ?? DEFAULT_PROFILE.examGoal,
      timezone: current?.timezone ?? DEFAULT_PROFILE.timezone,
      studyDayStart: current?.studyDayStart ?? DEFAULT_PROFILE.studyDayStart,
    });
    setOtpEmail(current?.email ?? "");
    setOtpCode("");
    setShowProfileSettings(true);
  }, [workspace?.profile]);

  const openNewCourse = useCallback(() => {
    setEditingCourseId(null);
    setCourseDraft(defaultCourseDraft());
    setShowCourseForm(true);
  }, []);

  const openCourseEditor = useCallback((course: Course) => {
    setEditingCourseId(course.id);
    setCourseDraft({
      name: course.name,
      code: course.code,
      teacher: course.teacher,
      term: course.term,
      examDate: course.examDate,
      priority: course.priority,
    });
    setShowCourseForm(true);
  }, []);

  const closeCourseForm = useCallback(() => {
    setShowCourseForm(false);
    setEditingCourseId(null);
  }, []);

  const confirmThenRun = useCallback((title: string, message: string, run: () => Promise<void>) => {
    setConfirm({ title, message, danger: true, run });
  }, []);

  const runConfirm = useCallback(() => {
    if (!confirm) return;
    setConfirmPending(true);
    void confirm
      .run()
      .catch((error) => notify(error instanceof Error ? error.message : "操作失败"))
      .finally(() => {
        setConfirmPending(false);
        setConfirm(null);
      });
  }, [confirm, notify]);

  /** 保存会话 AI 配置；地址非法或缺少配套 Key 时提示并返回 false。 */
  const saveSessionConfig = useCallback(
    (apiKey: string, baseUrl: string, onSave: (key: string, baseUrl: string) => void): boolean => {
      const endpoint = normalizeOpenAiBaseUrl(baseUrl);
      if (endpoint.error) {
        notify(endpoint.error);
        return false;
      }
      const key = apiKey.trim();
      if (endpoint.value && !key) {
        notify("自定义地址必须同时提供本次会话 Key。");
        return false;
      }
      onSave(key, endpoint.value);
      return true;
    },
    [notify],
  );

  return {
    showAiSettings,
    setShowAiSettings,
    showProfileSettings,
    setShowProfileSettings,
    showCourseForm,
    editingCourseId,
    courseDraft,
    setCourseDraft,
    profileDraft,
    setProfileDraft,
    otpEmail,
    setOtpEmail,
    otpCode,
    setOtpCode,
    apiKeyDraft,
    setApiKeyDraft,
    baseUrlDraft,
    setBaseUrlDraft,
    confirm,
    confirmPending,
    dismissConfirm: () => {
      if (!confirmPending) setConfirm(null);
    },
    openProfile,
    openNewCourse,
    openCourseEditor,
    closeCourseForm,
    confirmThenRun,
    runConfirm,
    saveSessionConfig,
    syncSessionDrafts,
    sessionDraftsFrom,
    modalOpen: showProfileSettings || showAiSettings || showCourseForm || Boolean(confirm),
  };
}
