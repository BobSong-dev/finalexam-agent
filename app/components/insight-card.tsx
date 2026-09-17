"use client";

import type { Insight } from "@/lib/types";

export default function InsightCard({
  insight,
  onToggleHidden,
}: {
  insight: Insight;
  /** 忽略这个考点（不删除分析结果，可随时恢复）。 */
  onToggleHidden: () => void;
}) {
  return (
    <article>
      <div className="insight-title">
        <span className={`trend ${insight.trend}`}>{insight.trend}</span>
        <h3>{insight.title}</h3>
        <strong>
          重要度 {insight.importance}/5 · 出现 {insight.frequency} 份
        </strong>
      </div>
      <p>{insight.summary}</p>
      <div className="source-links">
        {insight.sources.map((source) => (
          <span className="source-link" key={source}>
            ⌁ {source}
          </span>
        ))}
      </div>
      <div className="mastery-inline">
        <span>掌握度</span>
        <div className="bar">
          <i style={{ width: `${insight.mastery}%` }} />
        </div>
        <b>{insight.mastery}%</b>
      </div>
      <button className="text-button insight-dismiss" type="button" onClick={onToggleHidden}>
        忽略这个考点
      </button>
    </article>
  );
}
