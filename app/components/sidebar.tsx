"use client";

import type { Course } from "@/lib/types";
import type { View } from "../ui-types";
import { initials } from "../ui-helpers";

const navItems: Array<{ view: View; icon: string; subtitle: string }> = [
  { view: "总览", icon: "◈", subtitle: "今天的复习重点" },
  { view: "学习计划", icon: "◫", subtitle: "可完成的复习节奏" },
  { view: "资料分析", icon: "◌", subtitle: "从资料提取考点" },
  { view: "练习测验", icon: "✓", subtitle: "带着依据练习" },
  { view: "校内互助", icon: "↗", subtitle: "审核后同校共享" },
];

export default function Sidebar({
  profile,
  courseList,
  activeView,
  workspaceLoading,
  onNavigate,
  onRefresh,
  onOpenAiSettings,
}: {
  profile?: { displayName: string; school: string; verified: boolean };
  courseList: Course[];
  activeView: View;
  workspaceLoading: boolean;
  onNavigate: (view: View) => void;
  onRefresh: () => void;
  onOpenAiSettings: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">f</div>
        <div>
          <strong>期末星图</strong>
          <span>Finalexam Agent</span>
        </div>
      </div>
      <div className="student-card">
        <div className="avatar">{initials(profile?.displayName || "我")}</div>
        <div>
          <strong>{profile?.displayName || "本地学习者"}</strong>
          <p>{profile?.school || "本地私有工作区"}</p>
        </div>
        <span className={profile?.verified ? "verified-badge" : "unverified"}>
          {profile?.verified ? "已验证" : "本地模式"}
        </span>
      </div>
      <nav aria-label="复习空间">
        <p className="nav-label">复习空间</p>
        {navItems.map((item) => (
          <button
            key={item.view}
            type="button"
            className={`nav-item ${activeView === item.view ? "active" : ""}`}
            aria-label={`${item.view}：${item.subtitle}`}
            aria-current={activeView === item.view ? "page" : undefined}
            onClick={() => onNavigate(item.view)}
            disabled={!courseList.length && item.view !== "总览"}
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>
              <b>{item.view}</b>
              <small>{item.subtitle}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="credit-card">
          <span>◈</span>
          <div>
            <small>存储状态</small>
            <strong>{workspaceLoading ? "…" : "本地"}</strong>
          </div>
          <button onClick={onRefresh}>刷新</button>
        </div>
        <button className="settings" onClick={onOpenAiSettings}>
          ✦ AI 设置与隐私
        </button>
      </div>
    </aside>
  );
}
