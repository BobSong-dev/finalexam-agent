"use client";

import ModalShell from "./modal-shell";

export default function ConfirmModal({ title, message, confirmLabel, danger, pending, onConfirm, onClose }: { title: string; message: string; confirmLabel: string; danger?: boolean; pending?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <ModalShell className="compact" labelledBy="confirm-title" onClose={onClose}>
      <p className="eyebrow">请确认</p>
      <h2 id="confirm-title">{title}</h2>
      <p className="modal-intro">{message}</p>
      <div className="ai-settings-actions">
        <button className="outline" type="button" onClick={onClose} disabled={pending}>取消</button>
        <button className={danger ? "primary danger-button" : "primary"} type="button" onClick={onConfirm} disabled={pending}>{pending ? "处理中…" : confirmLabel}</button>
      </div>
    </ModalShell>
  );
}
