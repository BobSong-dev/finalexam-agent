"use client";

import dynamic from "next/dynamic";
import type { Course, Material } from "@/lib/types";
import type { PublicWorkspaceState } from "@/lib/workspace-types";
import { DeferredViewLoading } from "../components/app-state-cards";
import type { CourseAiRecord, View } from "../ui-types";
import { Overview } from "./overview";
import type { usePractice } from "../hooks/use-practice";
import type { useWorkspaceActions } from "../hooks/use-workspace-actions";

const PlanView = dynamic(() => import("./plan-view"), {
  loading: () => <DeferredViewLoading label="学习计划" />,
});
const AnalysisView = dynamic(() => import("./analysis-view"), {
  loading: () => <DeferredViewLoading label="资料分析" />,
});
const PracticeView = dynamic(() => import("./practice-view"), {
  loading: () => <DeferredViewLoading label="练习测验" />,
});
const CommunityView = dynamic(() => import("./community-view"), {
  loading: () => <DeferredViewLoading label="校内互助" />,
});

export interface ViewRouterProps {
  activeView: View;
  workspace: PublicWorkspaceState | null;
  selectedCourse: Course;
  courseList: Course[];
  today: string;
  todayTasks: PublicWorkspaceState["tasks"];
  plannedMinutes: number;
  completedMinutes: number;
  insights: PublicWorkspaceState["insights"];
  courseQuestions: PublicWorkspaceState["questions"];
  visibleMaterials: Material[];
  aiRecord?: CourseAiRecord;
  practiceKnowledge: string;
  setPracticeKnowledge: (value: string) => void;
  practice: ReturnType<typeof usePractice>;
  actions: ReturnType<typeof useWorkspaceActions>;
  navigate: (view: View, courseId?: string) => void;
  onSelectCourse: (courseId: string) => void;
  onNewCourse: () => void;
  onEditCourse: (course: Course) => void;
  onDeleteCourse: (course: Course) => void;
  onDeleteMaterial: (material: Material) => void;
  onConfirmMaterial: (id: string) => void;
  onOpenMaterialDetail: (material: Material) => void;
  onToggleInsight: (id: string, hidden: boolean) => void;
  onApplyWorkspace: (workspace: PublicWorkspaceState) => void;
  notify: (message: string) => void;
}

/** 把当前页签映射到对应视图；数据来自各自 hook，视图本身不持有业务状态。 */
export default function ViewRouter(props: ViewRouterProps) {
  const { activeView, workspace, selectedCourse, courseList, practice, actions } = props;

  if (activeView === "总览") {
    return (
      <Overview
        courseList={courseList}
        tasks={props.todayTasks}
        plannedMinutes={props.plannedMinutes}
        completedMinutes={props.completedMinutes}
        insights={props.insights}
        today={props.today}
        missedCount={workspace?.missedTasks.length ?? 0}
        onComplete={(id) => void actions.completeTask(id, true)}
        onNavigate={props.navigate}
        onRegenerate={() => void actions.regeneratePlan()}
        isRegenerating={actions.savingPlan}
      />
    );
  }

  if (activeView === "学习计划") {
    return (
      <PlanView
        tasks={workspace?.tasks ?? []}
        courseList={courseList}
        availability={workspace?.availability ?? []}
        planSource={workspace?.planSource}
        missedTasks={workspace?.missedTasks ?? []}
        today={props.today}
        onComplete={(id, completed) => void actions.completeTask(id, completed)}
        onOpenPractice={(courseId, knowledge) => {
          props.setPracticeKnowledge(knowledge ?? "");
          void practice.start(courseId, knowledge);
          props.navigate("练习测验", courseId);
        }}
        onRegenerate={() => void actions.regeneratePlan()}
        onRescheduleMissed={() => void actions.rescheduleMissed()}
        isRegenerating={actions.savingPlan}
        onSaveAvailability={actions.saveAvailability}
        savingAvailability={actions.savingAvailability}
      />
    );
  }

  if (activeView === "资料分析") {
    return (
      <AnalysisView
        selectedCourse={selectedCourse}
        courseList={courseList}
        materials={props.visibleMaterials}
        insights={props.insights}
        aiRecord={props.aiRecord}
        insightsAreSynthesized={Boolean(workspace?.courseSyntheses[selectedCourse.id])}
        processingErrors={workspace?.processingErrors ?? []}
        analyses={workspace?.documentAnalyses ?? {}}
        onConfirmMaterial={props.onConfirmMaterial}
        onOpenMaterialDetail={props.onOpenMaterialDetail}
        onToggleInsight={props.onToggleInsight}
        onSelectCourse={props.onSelectCourse}
        onUploadAndAnalyze={actions.uploadAndAnalyze}
        onRetryAnalysis={actions.analyzeStoredMaterial}
        onSynthesize={(course: Course) => void actions.synthesizeCourse(course)}
        onAddCourse={props.onNewCourse}
        onEditCourse={props.onEditCourse}
        onDeleteCourse={props.onDeleteCourse}
        onDownloadMaterial={actions.downloadMaterial}
        onDeleteMaterial={props.onDeleteMaterial}
      />
    );
  }

  if (activeView === "练习测验") {
    return (
      <PracticeView
        selectedCourse={selectedCourse}
        courseList={courseList}
        questions={practice.questions}
        availableCount={props.courseQuestions.length}
        knowledgeFocus={props.practiceKnowledge}
        loading={practice.loading}
        insights={props.insights}
        knowledgeMastery={workspace?.knowledgeMastery[selectedCourse.id] ?? {}}
        attempts={
          workspace?.assessmentAttempts.filter(
            (attempt) => attempt.courseId === selectedCourse.id,
          ) ?? []
        }
        answers={practice.answers}
        grades={practice.grades}
        rating={practice.rating}
        submitted={practice.submitted}
        submitting={practice.submitting}
        revealed={practice.reveal}
        onSelectCourse={props.onSelectCourse}
        onStart={(knowledge) => {
          props.setPracticeKnowledge(knowledge ?? "");
          void practice.start(selectedCourse.id, knowledge);
        }}
        onChange={practice.setAnswer}
        onGradeChange={practice.setGrade}
        onCorrectAnswer={(id, answer) => void actions.overrideQuestionAnswer(id, answer)}
        onRatingChange={practice.setRating}
        onSubmit={() => void practice.submit(selectedCourse.id)}
        onReset={() => void practice.start(selectedCourse.id, props.practiceKnowledge || undefined)}
      />
    );
  }

  return (
    <CommunityView
      workspace={workspace}
      onApplyWorkspace={props.onApplyWorkspace}
      onNotify={props.notify}
      onNavigate={() => props.navigate("资料分析")}
    />
  );
}
