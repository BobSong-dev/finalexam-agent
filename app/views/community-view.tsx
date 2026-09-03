"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicSharedMaterial, PublicWorkspaceState } from "@/lib/workspace-types";

export default function CommunityView({ workspace, onApplyWorkspace, onNotify, onNavigate }: { workspace: PublicWorkspaceState | null; onApplyWorkspace: (workspace: PublicWorkspaceState) => void; onNotify: (message: string) => void; onNavigate: () => void }) {
  const [catalog, setCatalog] = useState<PublicSharedMaterial[]>([]);
  const [credits, setCredits] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedMaterialId, setSelectedMaterialId] = useState("");
  const [consent, setConsent] = useState(false);
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [error, setError] = useState("");

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/shared/catalog", { cache: "no-store" });
      const payload = await response.json().catch(() => undefined) as { materials?: PublicSharedMaterial[]; credits?: number; error?: string };
      if (!response.ok) throw new Error(payload?.error || "校内资料目录读取失败");
      setCatalog(payload.materials ?? []);
      setCredits(payload.credits ?? 0);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "校内资料目录暂时无法读取");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const contribute = async () => {
    if (!selectedMaterialId || !consent || !privacyConfirmed) {
      onNotify("请选择一份已分析资料，并确认分享权限与隐私清理。 ");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/shared/contribute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ materialId: selectedMaterialId, consent, privacyConfirmed }) });
      const payload = await response.json().catch(() => undefined) as { workspace?: PublicWorkspaceState; error?: string; notice?: string };
      if (!response.ok) throw new Error(payload?.error || "共享提交失败");
      if (payload.workspace) onApplyWorkspace(payload.workspace);
      onNotify(payload.notice || "资料已提交审核。 ");
      setSelectedMaterialId("");
      setConsent(false);
      setPrivacyConfirmed(false);
      await loadCatalog();
    } catch (caught) {
      onNotify(`共享未能提交：${caught instanceof Error ? caught.message : "请稍后重试"}`);
    } finally {
      setSubmitting(false);
    }
  };

  const unlock = async (material: PublicSharedMaterial) => {
    if (material.canDownload) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/shared/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ materialId: material.id }) });
      const payload = await response.json().catch(() => undefined) as { workspace?: PublicWorkspaceState; error?: string };
      if (!response.ok) throw new Error(payload?.error || "资料解锁失败");
      if (payload.workspace) onApplyWorkspace(payload.workspace);
      onNotify(`已解锁《${material.title}》，扣除 ${material.credits} 积分。`);
      await loadCatalog();
    } catch (caught) {
      onNotify(`资料未能解锁：${caught instanceof Error ? caught.message : "请稍后重试"}`);
    } finally {
      setSubmitting(false);
    }
  };

  const report = async (material: PublicSharedMaterial) => {
    const reason = window.prompt("请输入举报原因（例如：侵权、隐私、内容不符）：", "");
    if (!reason?.trim()) return;
    try {
      const response = await fetch("/api/shared/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ materialId: material.id, reason }) });
      const payload = await response.json().catch(() => undefined) as { error?: string };
      if (!response.ok) throw new Error(payload?.error || "举报失败");
      onNotify("举报已记录，管理员会处理审核队列。 ");
    } catch (caught) {
      onNotify(`举报未能提交：${caught instanceof Error ? caught.message : "请稍后重试"}`);
    }
  };

  const profile = workspace?.profile;
  const analyzedMaterials = workspace?.materials.filter((material) => material.status === "已分析") ?? [];
  return <div className="view-content"><section className="community-hero"><div><p className="eyebrow">CAMPUS MATERIAL EXCHANGE</p><h2>真实贡献，审核后共享。</h2><p>{profile?.verified ? `当前学校边界：${profile.school}。资料会先进入审核队列，审核通过后才可被匹配课程的同校用户解锁。` : "校内互助需要已验证邮箱与学校域名配置；在验证完成前不会显示或伪造任何共享资料与积分。"}</p><div className="community-stats"><strong>{credits}<small>可用积分</small></strong><strong>{catalog.length}<small>当前可见资料</small></strong></div><button className="primary" onClick={onNavigate}>管理我的私有资料 <span>→</span></button></div><div className="community-visual"><div className="paper paper-one">真实审核</div><div className="paper paper-two">No fake<small>本地可追溯</small></div><div className="glow" /></div></section><section className="community-grid"><article className="community-panel"><div className="section-heading"><div><p className="eyebrow">CONTRIBUTE</p><h2>提交一份资料</h2></div><span>{analyzedMaterials.length} 份可提交</span></div>{analyzedMaterials.length ? <><label className="field-label">选择已完成分析的私有资料<select value={selectedMaterialId} onChange={(event) => setSelectedMaterialId(event.target.value)}><option value="">请选择</option>{analyzedMaterials.map((material) => <option key={material.id} value={material.id}>{material.name}</option>)}</select></label><label className="check-line"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />我确认拥有分享权限，不会上传未经授权的试卷或课件。</label><label className="check-line"><input type="checkbox" checked={privacyConfirmed} onChange={(event) => setPrivacyConfirmed(event.target.checked)} />我已清理姓名、学号、联系方式等个人敏感信息。</label><button className="primary" onClick={() => void contribute()} disabled={submitting || !profile?.verified}>{submitting ? "提交中…" : "提交审核"}</button>{!profile?.verified && <p className="inline-warning">请先在右上角个人资料中完成学校邮箱验证。</p>}</> : <p className="empty-state">先在“资料分析”中上传并完成至少一份资料的真实 AI 分析，才能提交审核。</p>}</article><article className="community-panel"><div className="section-heading"><div><p className="eyebrow">CATALOG</p><h2>可解锁资料</h2></div><button className="text-button" onClick={() => void loadCatalog()}>刷新</button></div>{loading ? <p className="empty-state">正在读取真实目录…</p> : error ? <div className="inline-error"><b>目录暂时不可用</b><p>{error}</p></div> : catalog.length ? <div className="shared-list">{catalog.map((material) => <article className="shared-card" key={material.id}><div><div className="shared-card-title"><b>{material.title}</b><span className={`quality ${material.quality}`}>{material.quality}</span></div><p>{material.school} · {material.courseCode} · {material.term}</p><small>{material.preview}</small><div className="tag-list">{material.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div></div><div className="shared-card-actions">{material.isMine || material.canDownload ? <button className="outline" onClick={() => window.open(`/api/shared/${encodeURIComponent(material.id)}/download`, "_blank", "noopener,noreferrer")}>下载</button> : <button className="primary" onClick={() => void unlock(material)} disabled={submitting}>{material.credits} 积分解锁</button>}<button className="text-button" onClick={() => void report(material)}>举报</button></div></article>)}</div> : <p className="empty-state">当前没有与你的学校和课程匹配的已审核资料。审核通过后会实时出现在这里。</p>}</article></section></div>;
}

