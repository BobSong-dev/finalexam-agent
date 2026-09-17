"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { AiStatus } from "@/lib/ai-types";
import type { Course, Material } from "@/lib/types";
import type { PublicWorkspaceState } from "@/lib/workspace-types";
import { LoadingState, Onboarding, WorkspaceError } from "./components/app-state-cards";
import ModalHost from "./components/modal-host";
import AnalysisDetail from "./components/analysis-detail";
import Sidebar from "./components/sidebar";
import { courseAiRecordFor } from "./course-ai-record";
import { useAiSession } from "./hooks/use-ai-session";
import { useAppModals } from "./hooks/use-app-modals";
import { usePractice } from "./hooks/use-practice";
import { useWorkspace } from "./hooks/use-workspace";
import { useWorkspaceActions } from "./hooks/use-workspace-actions";
import { useWorkspaceSelection } from "./hooks/use-workspace-selection";
import { courseById, initials } from "./ui-helpers";
import type { View } from "./ui-types";
import ViewRouter from "./views/view-router";

interface HomeClientProps {
  initialWorkspace: PublicWorkspaceState | null;
  initialWorkspaceError: string;
  initialToday: string;
  initialAiStatus: AiStatus;
  initialView: View;
  initialCourseId: string;
}

export default function HomeClient({
  initialWorkspace,
  initialWorkspaceError,
  initialToday,
  initialAiStatus,
  initialView,
  initialCourseId,
}: HomeClientProps) {
  const { workspace, workspaceLoading, workspaceError, applyWorkspace, loadWorkspace } =
    useWorkspace(initialWorkspace, initialWorkspaceError);
  const courseList = useMemo(() => workspace?.courses ?? [], [workspace?.courses]);
  const selection = useWorkspaceSelection(
    courseList,
    initialView,
    initialCourseId,
    initialWorkspace,
  );
  const [practiceKnowledge, setPracticeKnowledge] = useState("");
  const [detailMaterial, setDetailMaterial] = useState<Material | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4500);
  }, []);

  const ai = useAiSession(initialAiStatus);
  const practice = usePractice(notify, applyWorkspace);
  const modals = useAppModals(workspace, notify);

  // 会话配置草稿跟随已保存的会话值（保存/清除后由 hook 触发）。
  modals.syncSessionDrafts(ai.sessionApiKey, ai.sessionBaseUrl);

  const ensureAiReady = useCallback((): boolean => {
    if (ai.aiStatusLoading) {
      modals.setShowAiSettings(true);
      notify("正在检查 AI 配置，请稍候再开始分析。 ");
      return false;
    }
    if (ai.aiReady) return true;
    modals.setShowAiSettings(true);
    notify("请先在 AI 设置中配置本次会话的 API Key。 ");
    return false;
  }, [ai.aiReady, ai.aiStatusLoading, modals, notify]);

  const actions = useWorkspaceActions({
    workspace,
    applyWorkspace,
    loadWorkspace,
    notify,
    requestHeaders: ai.requestHeaders,
    selectedModel: ai.selectedModel,
    aiReady: ai.aiReady,
    ensureAiReady,
    onPracticeReset: practice.clearSession,
  });

  const selectedCourse = courseById(selection.selectedCourseId, courseList) ?? courseList[0];
  const activeCourseId = selectedCourse?.id;
  const materials = activeCourseId
    ? (workspace?.materials.filter((material) => material.courseId === activeCourseId) ?? [])
    : [];
  // 同名资料在重试成功后只保留最新一份，避免旧失败记录和新结果同时出现。
  const visibleMaterials = materials.filter(
    (material) =>
      material.status !== "失败" ||
      !materials.some(
        (other) =>
          other.id !== material.id && other.status === "已分析" && other.name === material.name,
      ),
  );
  const insights = activeCourseId
    ? (workspace?.insights.filter((insight) => insight.courseId === activeCourseId) ?? [])
    : [];
  const courseQuestions = activeCourseId
    ? (workspace?.questions.filter((question) => question.courseId === activeCourseId) ?? [])
    : [];
  const tasks = workspace?.tasks ?? [];
  const availability = workspace?.availability ?? [];
  const analyzingId =
    actions.workingMaterialId ||
    materials.find((material) => material.status === "分析中")?.id ||
    null;
  const synthesizingId =
    actions.synthesizingCourseId ||
    workspace?.processingJobs?.find((job) => job.type === "synthesize")?.targetId ||
    null;
  const aiRecord = courseAiRecordFor(
    workspace,
    activeCourseId,
    ai.selectedModel,
    analyzingId,
    synthesizingId,
  );
  const today = availability[0]?.date ?? initialToday;
  const todayTasks = tasks.filter((task) => task.date === today);
  const plannedMinutes = todayTasks.reduce((total, task) => total + task.duration, 0);
  const completedMinutes = todayTasks
    .filter((task) => task.status === "已完成")
    .reduce((total, task) => total + task.duration, 0);
  const profile = workspace?.profile;

  const openAiSettings = useCallback(() => {
    modals.setShowAiSettings(true);
    void ai.refreshAiStatus();
  }, [ai, modals]);

  const selectCourse = (courseId: string) => {
    selection.setSelectedCourseId(courseId);
    practice.clearSession();
    setPracticeKnowledge("");
    selection.navigate(selection.activeView, courseId);
  };

  const applyWorkspaceAndSelect = useCallback(
    (next: PublicWorkspaceState) => {
      applyWorkspace(next);
      selection.reconcileCourse(next);
    },
    [applyWorkspace, selection],
  );

  const hasCourse = courseList.length > 0 && Boolean(selectedCourse);
  const body = !hasCourse ? (
    workspaceLoading ? (
      <LoadingState />
    ) : workspaceError ? (
      <WorkspaceError message={workspaceError} onRetry={() => void loadWorkspace()} />
    ) : (
      <Onboarding onCreate={modals.openNewCourse} />
    )
  ) : (
    selectedCourse && (
      <ViewRouter
        activeView={selection.activeView}
        workspace={workspace}
        selectedCourse={selectedCourse}
        courseList={courseList}
        today={today}
        todayTasks={todayTasks}
        plannedMinutes={plannedMinutes}
        completedMinutes={completedMinutes}
        insights={insights}
        courseQuestions={courseQuestions}
        visibleMaterials={visibleMaterials}
        aiRecord={aiRecord}
        practiceKnowledge={practiceKnowledge}
        setPracticeKnowledge={setPracticeKnowledge}
        practice={practice}
        actions={actions}
        navigate={selection.navigate}
        onSelectCourse={selectCourse}
        onNewCourse={modals.openNewCourse}
        onEditCourse={modals.openCourseEditor}
        onDeleteCourse={(course: Course) =>
          modals.confirmThenRun(
            `删除「${course.name}」`,
            "将删除该课程及其全部资料、分析与练习记录。此操作不可撤销。",
            () => actions.deleteCourse(course),
          )
        }
        onDeleteMaterial={(material: Material) =>
          modals.confirmThenRun(
            `删除「${material.name}」`,
            "分析结果和来源卡片也会被移除。此操作不可撤销。",
            () => actions.deleteMaterial(material),
          )
        }
        onConfirmMaterial={(id) => void actions.confirmMaterialAnalysis(id)}
        onOpenMaterialDetail={setDetailMaterial}
        onToggleInsight={(id, hidden) => void actions.toggleInsight(id, hidden)}
        onApplyWorkspace={applyWorkspaceAndSelect}
        notify={notify}
      />
    )
  );

  return (
    <main className="app-shell">
      <div
        className="app-chrome"
        {...(modals.modalOpen ? { inert: true, "aria-hidden": true } : {})}
      >
        <Sidebar
          profile={profile}
          courseList={courseList}
          activeView={selection.activeView}
          workspaceLoading={workspaceLoading}
          onNavigate={selection.navigate}
          onRefresh={() => void loadWorkspace()}
          onOpenAiSettings={openAiSettings}
        />

        <section className="workspace">
          <header className="topbar">
            <div>
              <p className="eyebrow">{today}</p>
              <h1>
                {selection.activeView === "总览"
                  ? "今天，先把最重要的事做完。"
                  : selection.activeView}
              </h1>
            </div>
            <div className="top-actions">
              <button
                className="ai-settings-button"
                onClick={openAiSettings}
                aria-label="打开 AI 设置"
              >
                <span aria-hidden="true">✦</span> AI 设置
              </button>
              <button
                className="profile-button"
                onClick={modals.openProfile}
                aria-label="打开个人资料设置"
              >
                <span aria-hidden="true">{initials(profile?.displayName || "我")}</span>
                {profile?.displayName || "本地学习者"}
              </button>
            </div>
          </header>
          {body}
        </section>
      </div>

      {toast && (
        <div
          className="toast"
          role={workspaceError ? "alert" : "status"}
          aria-live="polite"
          aria-atomic="true"
        >
          <span aria-hidden="true">✦</span>
          {toast}
        </div>
      )}

      {detailMaterial && workspace?.documentAnalyses[detailMaterial.id] && (
        <AnalysisDetail
          title={detailMaterial.name}
          analysis={workspace.documentAnalyses[detailMaterial.id]!}
          onClose={() => setDetailMaterial(null)}
        />
      )}

      <ModalHost
        profile={profile}
        profileOpen={modals.showProfileSettings}
        profileDraft={modals.profileDraft}
        savingProfile={actions.savingProfile}
        otpEmail={modals.otpEmail}
        otpCode={modals.otpCode}
        otpPending={actions.otpPending}
        onCloseProfile={() => modals.setShowProfileSettings(false)}
        onProfileDraftChange={(patch) =>
          modals.setProfileDraft((current) => ({ ...current, ...patch }))
        }
        onSaveProfile={() => void actions.saveProfile(modals.profileDraft)}
        onExport={actions.exportWorkspace}
        onImport={(file) =>
          modals.confirmThenRun(
            "从备份恢复工作区",
            "这会用备份文件整份替换当前课程、资料、分析与练习记录。导入前会自动另存一份当前数据，但请确认你选择的是正确的备份。",
            () => actions.importWorkspace(file),
          )
        }
        importing={actions.importing}
        onOtpEmailChange={modals.setOtpEmail}
        onOtpCodeChange={modals.setOtpCode}
        onRequestOtp={() => void actions.requestEmailOtp(modals.otpEmail)}
        onVerifyOtp={() => void actions.verifyEmailOtp(modals.otpEmail, modals.otpCode)}
        aiOpen={modals.showAiSettings}
        aiStatus={ai.aiStatus}
        aiStatusLoading={ai.aiStatusLoading}
        customBaseUrlDisabled={ai.customBaseUrlDisabled}
        sessionApiKey={ai.sessionApiKey}
        sessionBaseUrl={ai.sessionBaseUrl}
        apiKeyDraft={modals.apiKeyDraft}
        baseUrlDraft={modals.baseUrlDraft}
        model={ai.selectedModel}
        modelOptions={ai.modelOptions}
        onCloseAi={() => modals.setShowAiSettings(false)}
        onRefreshAi={() => void ai.refreshAiStatus()}
        onApiKeyChange={modals.setApiKeyDraft}
        onBaseUrlChange={modals.setBaseUrlDraft}
        onModelChange={ai.updateModel}
        onSaveAi={() => {
          const saved = modals.saveSessionConfig(
            modals.apiKeyDraft,
            modals.baseUrlDraft,
            ai.saveSessionConfig,
          );
          if (saved) notify("AI 会话配置已保存；关闭浏览器会话后会自动清除。");
        }}
        onClearAi={() => {
          ai.clearSessionConfig();
          notify(
            ai.aiStatus?.configured
              ? "已清除会话配置，将使用服务端环境配置。"
              : "已清除会话配置。再次分析前请重新配置 Key。 ",
          );
        }}
        courseOpen={modals.showCourseForm}
        courseDraft={modals.courseDraft}
        editingCourse={Boolean(modals.editingCourseId)}
        savingCourse={actions.savingCourse}
        onCloseCourse={modals.closeCourseForm}
        onCourseDraftChange={(patch) =>
          modals.setCourseDraft((current) => ({ ...current, ...patch }))
        }
        onSubmitCourse={() => {
          void actions.saveCourse(modals.courseDraft, modals.editingCourseId).then((createdId) => {
            modals.closeCourseForm();
            if (createdId) {
              selection.setSelectedCourseId(createdId);
              selection.navigate("资料分析", createdId);
            }
          });
        }}
        confirm={modals.confirm}
        confirmPending={modals.confirmPending}
        onCloseConfirm={modals.dismissConfirm}
        onConfirm={modals.runConfirm}
      />
    </main>
  );
}
