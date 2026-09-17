"use client";

import { useCallback, useEffect, useState } from "react";
import type { Course } from "@/lib/types";
import type { PublicWorkspaceState } from "@/lib/workspace-types";
import type { View } from "../ui-types";
import { VIEW_QUERY } from "../ui-types";

/**
 * 当前页签与当前课程。
 *
 * 页签切换使用 history.replaceState 做浅路由：page.tsx 是 force-dynamic，
 * 用 router.replace 会让每次点导航都重新在服务端读一遍 workspace.json。
 */
export function useWorkspaceSelection(
  courseList: Course[],
  initialView: View,
  initialCourseId: string,
  initialWorkspace: PublicWorkspaceState | null,
) {
  const [activeView, setActiveView] = useState<View>(initialView);
  const [selectedCourseId, setSelectedCourseId] = useState(
    initialCourseId && initialWorkspace?.courses.some((course) => course.id === initialCourseId)
      ? initialCourseId
      : (initialWorkspace?.courses[0]?.id ?? ""),
  );

  const navigate = useCallback(
    (view: View, courseId?: string) => {
      setActiveView(view);
      const params = new URLSearchParams();
      params.set("view", VIEW_QUERY[view]);
      const nextCourse = courseId || selectedCourseId;
      if (nextCourse) params.set("course", nextCourse);
      window.history.replaceState(null, "", `/?${params.toString()}`);
      document.title =
        view === "总览" ? "期末星图 · Finalexam Agent" : `${view} · 期末星图 · Finalexam Agent`;
    },
    [selectedCourseId],
  );

  // 浏览器前进/后退时恢复页签与课程。
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const course = params.get("course");
      if (course && courseList.some((item) => item.id === course)) setSelectedCourseId(course);
      const match = (Object.entries(VIEW_QUERY) as Array<[View, string]>).find(
        ([, query]) => query === params.get("view"),
      );
      if (match) setActiveView(match[0]);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [courseList]);

  /** 工作区刷新后保持选中的课程有效。 */
  const reconcileCourse = useCallback((next: PublicWorkspaceState) => {
    setSelectedCourseId((current) =>
      next.courses.some((course) => course.id === current) ? current : (next.courses[0]?.id ?? ""),
    );
  }, []);

  return {
    activeView,
    setActiveView,
    selectedCourseId,
    setSelectedCourseId,
    navigate,
    reconcileCourse,
  };
}
