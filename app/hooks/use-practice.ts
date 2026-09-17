"use client";

import { useCallback, useState } from "react";
import type { PracticeGrade } from "@/lib/types";
import type { PracticeReveal, PublicQuestion, PublicWorkspaceState } from "@/lib/workspace-types";
import { JSON_HEADERS, responseError } from "../client-api";

export interface PracticeSessionState {
  id: string;
  courseId: string;
  questions: PublicQuestion[];
}

/**
 * 练习会话状态：抽题、作答、自评、提交。
 * 题目由服务端会话决定，提交时只对会话内题目判分。
 */
export function usePractice(
  notify: (message: string) => void,
  onWorkspace: (workspace: PublicWorkspaceState) => void,
) {
  const [session, setSession] = useState<PracticeSessionState | null>(null);
  const [loading, setLoading] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grades, setGrades] = useState<Record<string, PracticeGrade>>({});
  const [rating, setRating] = useState<number | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reveal, setReveal] = useState<PracticeReveal[]>([]);

  const reset = useCallback(() => {
    setAnswers({});
    setGrades({});
    setRating(undefined);
    setSubmitted(false);
    setReveal([]);
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
    reset();
  }, [reset]);

  const start = useCallback(
    async (courseId: string, knowledge?: string) => {
      setLoading(true);
      reset();
      try {
        const response = await fetch("/api/practice/sessions", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ courseId, ...(knowledge ? { knowledge } : {}) }),
        });
        if (!response.ok) throw new Error(await responseError(response, "无法开始练习"));
        const payload = (await response.json()) as {
          sessionId?: string;
          questions?: PublicQuestion[];
        };
        if (!payload.sessionId || !payload.questions)
          throw new Error("练习会话响应不完整，请重试。 ");
        setSession({ id: payload.sessionId, courseId, questions: payload.questions });
      } catch (error) {
        setSession(null);
        notify(`无法开始练习：${error instanceof Error ? error.message : "请稍后重试"}`);
      } finally {
        setLoading(false);
      }
    },
    [notify, reset],
  );

  const submit = useCallback(
    async (courseId: string | undefined) => {
      if (!courseId || !session) return;
      if (!Object.keys(answers).length) {
        notify("请至少完成一题再提交。 ");
        return;
      }
      setSubmitting(true);
      try {
        const response = await fetch("/api/assessments/submit", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            courseId,
            sessionId: session.id,
            answers,
            selfGrades: grades,
            selfRating: rating,
          }),
        });
        if (!response.ok) throw new Error(await responseError(response, "练习提交失败"));
        const payload = (await response.json()) as {
          workspace?: PublicWorkspaceState;
          correct?: number;
          total?: number;
          graded?: number;
          revealed?: PracticeReveal[];
        };
        if (!payload.workspace) throw new Error("练习结果响应不完整，请重试。 ");
        onWorkspace(payload.workspace);
        setReveal(payload.revealed ?? []);
        setSubmitted(true);
        const graded = payload.graded ?? payload.total ?? 0;
        const pending = (payload.total ?? 0) - graded;
        notify(
          `练习结果已保存：${payload.correct ?? 0}/${graded} 题正确${pending ? `（${pending} 题待自评未计分）` : ""}，后续计划已更新。`,
        );
      } catch (error) {
        notify(`练习未能提交：${error instanceof Error ? error.message : "请稍后重试"}`);
      } finally {
        setSubmitting(false);
      }
    },
    [answers, grades, notify, onWorkspace, rating, session],
  );

  const setAnswer = useCallback((id: string, value: string) => {
    setAnswers((current) => ({ ...current, [id]: value }));
  }, []);

  const setGrade = useCallback((id: string, grade: PracticeGrade | undefined) => {
    setGrades((current) => {
      const next = { ...current };
      if (grade) next[id] = grade;
      else delete next[id];
      return next;
    });
  }, []);

  return {
    session,
    questions: session?.questions ?? [],
    loading,
    answers,
    grades,
    rating,
    submitted,
    submitting,
    reveal,
    start,
    submit,
    reset,
    clearSession,
    setAnswer,
    setGrade,
    setRating,
  };
}
