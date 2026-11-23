import { useEffect, useState } from "react";
import { api } from "../../api";
import type { SignatureInfo } from "../../types";
import { CiChecks } from "./HostingDialogs";
import { pushToast } from "../../toastBus";

export const SIGNATURE_LABEL: Record<string, { text: string; kind: string; short: string }> = {
  G: { text: "Good signature", kind: "good", short: "Verified" },
  U: { text: "Good signature, unknown key validity", kind: "unknown", short: "Signed" },
  X: { text: "Good signature that has expired", kind: "expired", short: "Expired" },
  Y: { text: "Good signature made by an expired key", kind: "expired", short: "Expired key" },
  R: { text: "Good signature made by a revoked key", kind: "bad", short: "Revoked" },
  B: { text: "Bad signature", kind: "bad", short: "Bad sig" },
  E: { text: "Signature cannot be checked (missing key or allowed signers file)", kind: "unknown", short: "Signed?" },
};

export function SignatureBadge({ info, compact = false }: { info: SignatureInfo | undefined; compact?: boolean }) {
  if (!info || info.status === "N" || !SIGNATURE_LABEL[info.status]) return null;
  const meta = SIGNATURE_LABEL[info.status];
  return (
    <span className={`gk-sig is-${meta.kind}`} title={`${meta.text}${info.signer ? ` — ${info.signer}` : ""}${info.key ? ` (key ${info.key})` : ""}`} aria-label={`${meta.text}${info.signer ? ` by ${info.signer}` : ""}`}>
      {meta.kind === "good" ? "✓" : meta.kind === "bad" ? "✕" : meta.kind === "expired" ? "⌛" : "?"}{compact ? "" : ` ${meta.short}`}
    </span>
  );
}

/** Extra sections for the commit inspector: signature, AI/offline
 *  explanation, git notes and CI checks. */
export function CommitExtras({ repositoryPath, sha, signature }: { repositoryPath: string; sha: string; signature: SignatureInfo | undefined }) {
  const [explanation, setExplanation] = useState<{ text: string; source: string; model?: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setExplanation(null); setEditing(false);
    let cancelled = false;
    api.notes(repositoryPath, sha).then((text) => { if (!cancelled) setNote(text); }).catch(() => { if (!cancelled) setNote(""); });
    return () => { cancelled = true; };
  }, [repositoryPath, sha]);

  return (
    <>
      {signature && signature.status !== "N" && (
        <section className="ux-inspector-section">
          <div className="ux-section-title"><strong>Signature</strong><SignatureBadge info={signature} /></div>
          <p className="gk-inspector-note">{SIGNATURE_LABEL[signature.status]?.text ?? signature.status}{signature.signer ? ` — ${signature.signer}` : ""}{signature.key ? <><br /><code>{signature.key}</code></> : null}</p>
        </section>
      )}
      <section className="ux-inspector-section">
        <div className="ux-section-title"><strong>Explain</strong><button type="button" className="ux-button compact" disabled={explaining} onClick={async () => {
          setExplaining(true);
          try { setExplanation(await api.explain(repositoryPath, "commit", sha)); } catch (error) { pushToast(String(error), "error"); }
          finally { setExplaining(false); }
        }}>{explaining ? "Thinking…" : "✨ Explain this commit"}</button></div>
        {explanation && <pre className="ux-commit-body gk-explain">{explanation.text}<small>{explanation.source === "claude" ? `Claude${explanation.model ? ` (${explanation.model})` : ""}` : explanation.source === "ollama" ? "local AI (Ollama)" : "offline summary"}</small></pre>}
      </section>
      <section className="ux-inspector-section">
        <div className="ux-section-title"><strong>Notes</strong>{!editing && <button type="button" className="gk-link-button" onClick={() => { setDraft(note ?? ""); setEditing(true); }}>{note ? "Edit" : "Add note"}</button>}</div>
        {editing ? (
          <div className="gk-notes-edit">
            <textarea rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Git note" />
            <div><button type="button" className="ux-primary-button compact" onClick={async () => { try { await api.setNotes(repositoryPath, sha, draft); setNote(draft.trim()); setEditing(false); } catch (error) { pushToast(String(error), "error"); } }}>Save note</button><button type="button" className="ux-button compact" onClick={() => setEditing(false)}>Cancel</button></div>
          </div>
        ) : note ? <pre className="ux-commit-body">{note}</pre> : <p className="gk-inspector-note">No git note (refs/notes/commits).</p>}
      </section>
      <CiChecks repositoryPath={repositoryPath} sha={sha} />
    </>
  );
}
