"use client";

import dynamic from "next/dynamic";
import type { AiStatus } from "@/lib/ai-types";
import type { PublicWorkspaceState } from "@/lib/workspace-types";
import { DeferredModalLoading } from "./app-state-cards";
import type { CourseDraft, ProfileDraft } from "../ui-types";

const ProfileModal = dynamic(() => import("../modals/profile-modal"), {
  loading: () => <DeferredModalLoading label="个人资料设置" />,
});
const AiSettingsModal = dynamic(() => import("../modals/ai-settings-modal"), {
  loading: () => <DeferredModalLoading label="AI 设置" />,
});
const CourseModal = dynamic(() => import("../modals/course-modal"), {
  loading: () => <DeferredModalLoading label="课程设置" />,
});
const ConfirmModal = dynamic(() => import("../modals/confirm-modal"), {
  loading: () => <DeferredModalLoading label="确认" />,
});

export interface ConfirmRequest {
  title: string;
  message: string;
  danger?: boolean;
  run: () => Promise<void>;
}

type ModalHostProps = {
  profile?: PublicWorkspaceState["profile"];
  profileOpen: boolean;
  profileDraft: ProfileDraft;
  savingProfile: boolean;
  otpEmail: string;
  otpCode: string;
  otpPending: boolean;
  onCloseProfile: () => void;
  onProfileDraftChange: (patch: Partial<ProfileDraft>) => void;
  onSaveProfile: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  importing: boolean;
  onOtpEmailChange: (value: string) => void;
  onOtpCodeChange: (value: string) => void;
  onRequestOtp: () => void;
  onVerifyOtp: () => void;

  aiOpen: boolean;
  aiStatus: AiStatus | null;
  aiStatusLoading: boolean;
  customBaseUrlDisabled: boolean;
  sessionApiKey: string;
  sessionBaseUrl: string;
  apiKeyDraft: string;
  baseUrlDraft: string;
  model: string;
  modelOptions: string[];
  onCloseAi: () => void;
  onRefreshAi: () => void;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onSaveAi: () => void;
  onClearAi: () => void;

  courseOpen: boolean;
  courseDraft: CourseDraft;
  editingCourse: boolean;
  savingCourse: boolean;
  onCloseCourse: () => void;
  onCourseDraftChange: (patch: Partial<CourseDraft>) => void;
  onSubmitCourse: () => void;

  confirm: ConfirmRequest | null;
  confirmPending: boolean;
  onCloseConfirm: () => void;
  onConfirm: () => void;
};

/** 四个模态框的挂载点：把「显示什么」和「怎么处理」集中在一处。 */
export default function ModalHost(props: ModalHostProps) {
  return (
    <>
      {props.profileOpen && (
        <ProfileModal
          profile={props.profile}
          draft={props.profileDraft}
          saving={props.savingProfile}
          otpEmail={props.otpEmail}
          otpCode={props.otpCode}
          otpPending={props.otpPending}
          onClose={props.onCloseProfile}
          onChange={props.onProfileDraftChange}
          onSave={props.onSaveProfile}
          onExport={props.onExport}
          onImport={props.onImport}
          importing={props.importing}
          onOtpEmailChange={props.onOtpEmailChange}
          onOtpCodeChange={props.onOtpCodeChange}
          onRequestOtp={props.onRequestOtp}
          onVerifyOtp={props.onVerifyOtp}
        />
      )}

      {props.aiOpen && (
        <AiSettingsModal
          aiStatus={props.aiStatus}
          aiStatusLoading={props.aiStatusLoading}
          customBaseUrlDisabled={props.customBaseUrlDisabled}
          sessionApiKey={props.sessionApiKey}
          sessionBaseUrl={props.sessionBaseUrl}
          apiKeyDraft={props.apiKeyDraft}
          baseUrlDraft={props.baseUrlDraft}
          model={props.model}
          modelOptions={props.modelOptions}
          onClose={props.onCloseAi}
          onRefresh={props.onRefreshAi}
          onKeyChange={props.onApiKeyChange}
          onBaseUrlChange={props.onBaseUrlChange}
          onModelChange={props.onModelChange}
          onSave={props.onSaveAi}
          onClear={props.onClearAi}
        />
      )}

      {props.courseOpen && (
        <CourseModal
          draft={props.courseDraft}
          editing={props.editingCourse}
          saving={props.savingCourse}
          onClose={props.onCloseCourse}
          onChange={props.onCourseDraftChange}
          onSubmit={props.onSubmitCourse}
        />
      )}

      {props.confirm && (
        <ConfirmModal
          title={props.confirm.title}
          message={props.confirm.message}
          confirmLabel="确定"
          danger={props.confirm.danger}
          pending={props.confirmPending}
          onClose={props.onCloseConfirm}
          onConfirm={props.onConfirm}
        />
      )}
    </>
  );
}
