"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { Deal } from "../../../lib/types";
import { api } from "../../components/api";
import { PayPalButton } from "../../components/paypal-button";
import { AcceptanceReview } from "../../components/acceptance-review";
import { ScopeChanges } from "../../components/scope-changes";

const money = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

export function DealView({ initial, clientId }: { initial: Deal; clientId: string }) {
  const [deal, setDeal] = useState(initial);
  const [checklist, setChecklist] = useState(initial.analysis.checklist);
  const [scopeTerms, setScopeTerms] = useState((initial.analysis.scope_terms ?? []).join("\n"));
  const [view, setView] = useState<"Buyer" | "Seller">("Buyer");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const base = `/api/deals/${deal.id}`;
  const latest = deal.deliveries.at(-1);
  const captured = deal.paypal.captures.reduce((sum, capture) => sum + capture.amount, 0);
  const closed = ["released", "voided"].includes(deal.status);
  const unsaved = JSON.stringify(checklist) !== JSON.stringify(deal.analysis.checklist) || scopeTerms !== (deal.analysis.scope_terms ?? []).join("\n");
  const agreed = Boolean(deal.agreement?.confirmed_by.Buyer && deal.agreement.confirmed_by.Seller);
  const editableChecklist = view === "Buyer" && deal.status === "analyzed" && !deal.parent;
  const showRiskWarning = deal.analysis.risk !== "low" || deal.analysis.red_flags.length > 0;
  async function refresh() { const current = await api<Deal>(base); setDeal(current); setChecklist(current.analysis.checklist); setScopeTerms((current.analysis.scope_terms ?? []).join("\n")); }
  async function run(label: string, task: () => Promise<unknown>) {
    setBusy(label); setError("");
    try { await task(); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "The request failed."); await refresh().catch(() => {}); }
    finally { setBusy(""); }
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("paypal") === "approved" && params.get("token") && !initial.paypal.authorization_id) {
      void run("Confirming authorization", () => api(`${base}/paypal/authorize`, { order_id: params.get("token") }));
    }
    // The payment callback is processed once per page load and is idempotent on the server.
  }, []);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const files = form.getAll("files").filter(value => value instanceof File && value.size > 0);
    form.delete("files"); files.forEach(file => form.append("files", file));
    await run("Checking delivery", () => api(`${base}/deliveries`, form));
  }
  return <main className="workspace app-page">
    <nav><Link href="/">← All deals</Link><span className="environment">Sandbox · single operator demo</span></nav>
    <p className="eyebrow">{deal.status.replaceAll("_", " ")}</p><h1>{deal.title}</h1>
    {deal.parent && <p className="notice">Additional order · <Link href={`/deals/${deal.parent.deal_id}`}>View the original agreement and accepted quote</Link>. These terms are locked to that quote.</p>}
    <div className="view-picker" aria-label="Demo role"><button disabled={Boolean(busy)} className={view === "Buyer" ? "" : "secondary"} onClick={() => setView("Buyer")}>Buyer view</button><button disabled={Boolean(busy)} className={view === "Seller" ? "" : "secondary"} onClick={() => setView("Seller")}>Seller view</button></div>
    {busy && <p role="status" className="notice">{busy}…</p>}{error && <p role="alert" className="error notice">{error}</p>}
    {showRiskWarning && <section className="panel"><p className="eyebrow">Risk check</p><h2 className={deal.analysis.risk === "do_not_pay" ? "error" : ""}>{deal.analysis.risk.replaceAll("_", " ")}</h2><p>{deal.analysis.recommendation}</p>
      {deal.analysis.red_flags.map((flag, index) => <blockquote key={index}><q>{flag.quote}</q><p className="muted">{flag.explain}</p></blockquote>)}
    </section>}
    <section className="panel"><h2>Deal checklist</h2>{!showRiskWarning && !deal.parent && <p className="muted">{deal.analysis.recommendation}</p>}<div className="table-scroll"><table><thead><tr><th>Deliverable</th><th>Evidence</th><th>Value</th></tr></thead><tbody>{checklist.map((item, index) => <tr key={item.id}>
      <td>{editableChecklist ? <input aria-label={`Deliverable ${index + 1}`} value={item.text} maxLength={500} onChange={event => setChecklist(checklist.map((value, i) => i === index ? { ...value, text: event.target.value } : value))} /> : item.text}</td>
      <td>{item.evidence.replaceAll("_", " ")}{item.deadline && <div className="timing-rule">{editableChecklist ? <>
        <label>Hours after authorization<input aria-label={`Deadline hours for ${item.id}`} type="number" min="0.1" max="696" step="0.1" value={item.deadline.hours} onChange={event => setChecklist(checklist.map((value, i) => i === index ? { ...value, deadline: { ...item.deadline!, hours: Number(event.target.value) } } : value))} /></label>
        <label>Timing condition<select aria-label={`Timing condition for ${item.id}`} value={item.deadline.condition} onChange={event => setChecklist(checklist.map((value, i) => i === index ? { ...value, deadline: { ...item.deadline!, condition: event.target.value as "submission" | "complete_delivery" } } : value))}><option value="submission">Submission within the window</option><option value="complete_delivery">Complete delivery within the window</option></select></label>
      </> : <span>{item.deadline.hours}h · {item.deadline.condition === "submission" ? "Submission timing" : "Complete delivery timing"}</span>}</div>}</td><td>{editableChecklist ? <input aria-label={`Value for deliverable ${index + 1}`} type="number" min="0" max="100000" step="0.01" value={item.value} onChange={event => setChecklist(checklist.map((value, i) => i === index ? { ...value, value: Number(event.target.value) } : value))} /> : money(item.value)}</td>
    </tr>)}</tbody></table></div><p className="total">Deal total {money(deal.analysis.total_price)}</p>
      {editableChecklist ? <label>Scope boundaries and included revisions<textarea rows={3} maxLength={5010} value={scopeTerms} disabled={Boolean(busy)} onChange={event => setScopeTerms(event.target.value)} placeholder="One term per line, such as two revision rounds for the whole project. Up to 10 terms." /></label> : Boolean(deal.analysis.scope_terms?.length) && <div><h3>Other agreed terms</h3>{deal.analysis.scope_terms!.map((term, index) => <p key={index}>{term}</p>)}</div>}
      {editableChecklist && <button disabled={Boolean(busy) || !unsaved} onClick={() => run("Saving checklist", () => api(`${base}/checklist`, { checklist, scope_terms: scopeTerms.split("\n").map(term => term.trim()).filter(Boolean), revision: deal.agreement?.revision ?? 0 }, "PATCH"))}>Save checklist changes</button>}
      {deal.status === "analyzed" && <div className="notice"><p>Checklist version {deal.agreement?.revision ?? 0} · Buyer {deal.agreement?.confirmed_by.Buyer ? "confirmed" : "pending"} · Seller {deal.agreement?.confirmed_by.Seller ? "confirmed" : "pending"}</p><p className="muted">Both demo roles confirm the requirements, prices, scope boundaries and timing rules before payment.</p><button disabled={Boolean(busy) || unsaved || Boolean(deal.agreement?.confirmed_by[view])} onClick={() => run("Confirming agreement", () => api(`${base}/agreement`, { actor: view, revision: deal.agreement?.revision ?? 0 }))}>Confirm checklist as {view.toLowerCase()}</button></div>}
    </section>
    <ScopeChanges deal={deal} view={view} busy={Boolean(busy)} onAction={run} />
    {deal.status !== "refused" && <section className="panel"><h2>Payment</h2><div className="money-row"><div><span>Authorized</span><strong>{money(deal.paypal.authorization_id ? deal.analysis.total_price : 0)}</strong></div><div><span>Captured</span><strong>{money(captured)}</strong></div><div><span>Unused authorization closed</span><strong>{money(deal.paypal.voided_at ? deal.analysis.total_price - captured : 0)}</strong></div></div>
      {view === "Buyer" && unsaved && <p className="notice">Save your checklist edits to enable checkout.</p>}
      {view === "Buyer" && deal.status === "analyzed" && !agreed && <p className="muted">Checkout opens after both sides confirm the saved checklist.</p>}
      {view === "Buyer" && !unsaved && (deal.status === "awaiting_payment" || deal.status === "analyzed" && agreed) && <>
        <p className="muted">Save any checklist edits before checkout. This authorizes a Sandbox payment for {money(deal.analysis.total_price)}.</p>
        <PayPalButton dealId={deal.id} revision={deal.agreement?.revision ?? 0} clientId={clientId} onApproved={refresh} />
        <button className="secondary" disabled={Boolean(busy)} onClick={() => run("Opening checkout", async () => { const payment = await api<{ order_id: string; approval_url: string | null }>(`${base}/paypal/order`, { revision: deal.agreement?.revision ?? 0 }); if (payment.approval_url) window.location.assign(payment.approval_url); else await api(`${base}/paypal/authorize`, { order_id: payment.order_id }); })}>Open PayPal approval link</button>
        {deal.paypal.order_id && <button className="secondary" disabled={Boolean(busy)} onClick={() => run("Checking buyer approval", () => api(`${base}/paypal/authorize`, { order_id: deal.paypal.order_id }))}>Check approved order</button>}
      </>}
      {deal.paypal.authorization_id && <p className="reference">Authorization {deal.paypal.authorization_id}</p>}
      {view === "Buyer" && deal.paypal.captures.length > 0 && !closed && <button className="secondary" disabled={Boolean(busy)} onClick={() => run("Closing remaining authorization", () => api(`${base}/void`, {}))}>Close remaining authorization</button>}
    </section>}
    {view === "Seller" && ["held", "delivered"].includes(deal.status) && !deal.paypal.release_request && <form className="panel form-stack" onSubmit={upload}><h2>Submit delivery</h2><label>Delivery or cancellation note<textarea name="note" rows={3} maxLength={5000} /></label><label>Evidence files<input name="files" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.svg,.pdf,.txt,.zip" /></label><p className="muted">Up to six files across submissions, 5 MB each. Previous evidence stays available. Images and notes are sent to DeepSeek for review.</p><button disabled={Boolean(busy)}>Submit and check delivery</button></form>}
    {latest && <section className="panel"><h2>AI evidence review</h2><p>{latest.note}</p><div className="sample-picker">{deal.deliveries.flatMap(delivery => delivery.files).map(file => <a key={file.path} href={`${base}/files/${file.path}`}>{file.name}</a>)}</div>
      {latest.verification_error && <><p className="error">{latest.verification_error}</p>{!latest.review && <button disabled={Boolean(busy)} onClick={() => run("Retrying verification", () => api(`${base}/deliveries/${latest.id}/verify`, {}))}>Retry verification</button>}</>}
      {latest.verdicts?.map(verdict => <article className="verdict" key={verdict.id}><strong>{deal.analysis.checklist.find(item => item.id === verdict.id)?.text}</strong><span className={verdict.met && verdict.confidence >= .6 ? "success" : "muted"}>{verdict.status === "pending" ? "Pending" : verdict.confidence < .6 || verdict.status === "needs_review" ? "Needs human review" : verdict.met ? "Evidence supports" : "Evidence missing"}</span><p>{verdict.reason}</p></article>)}
      {latest.proposed_release !== undefined && <><p className="total">AI-supported items total {money(latest.proposed_release)} of {money(deal.analysis.total_price)}</p><p className="muted">The acceptance proposal below determines the settlement amount.</p></>}
    </section>}
    {latest && <AcceptanceReview key={`${latest.id}-${latest.review?.revision ?? 0}`} deal={deal} view={view} busy={Boolean(busy)} onAction={run} />}
    <section className="panel"><h2>Timeline</h2><ol className="timeline">{deal.events.map((event, index) => <li key={index}><strong>{event.actor}</strong><span>{event.text}</span><time>{new Date(event.at).toLocaleString()}</time>{event.ref && <code>{event.ref}</code>}</li>)}</ol></section>
  </main>;
}
