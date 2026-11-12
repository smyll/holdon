"use client";
import Link from "next/link";
import { useState } from "react";
import type { Deal, ScopeChange } from "../../lib/types";
import { api } from "./api";

const categories = { included: "Already included", correction: "Correction to original work", included_revision: "Included revision", new_work: "Likely additional work", unclear: "Needs clarification" };
type Props = { deal: Deal; view: "Buyer" | "Seller"; busy: boolean; onAction: (label: string, task: () => Promise<unknown>) => Promise<void> };

export function ScopeChanges(props: Props) {
  const { deal, busy, onAction } = props;
  const [request, setRequest] = useState("");
  const confirmed = Boolean(deal.agreement?.confirmed_by.Buyer && deal.agreement.confirmed_by.Seller);
  if (deal.status === "refused") return null;
  return <section className="panel">
    <h2>Is this extra work?</h2>
    <p className="muted">Compare a new request with the confirmed agreement. Corrections and included revisions may already be covered. The seller chooses any additional price; both sides confirm it.</p>
    {confirmed ? <form className="form-stack" onSubmit={event => {
      event.preventDefault();
      void onAction("Comparing the request with your agreement", async () => {
        await api(`/api/deals/${deal.id}/changes`, { request, revision: deal.agreement!.revision });
        setRequest("");
      });
    }}>
      <label>New customer request<textarea rows={3} minLength={10} maxLength={5000} required value={request} disabled={busy} onChange={event => setRequest(event.target.value)} placeholder="Could you also create packaging artwork? And please fix the typo in the company name." /></label>
      <button disabled={busy || (deal.scope_changes?.length ?? 0) >= 10}>Compare with agreed scope</button>
    </form> : <p className="notice">Confirm the original checklist in both views before comparing changes.</p>}
    {deal.scope_changes?.map(change => <ChangeCard key={`${change.id}-${change.quote?.revision ?? 0}`} {...props} change={change} />)}
  </section>;
}

function ChangeCard({ deal, view, busy, onAction, change }: Props & { change: ScopeChange }) {
  const quote = change.quote;
  const [selected, setSelected] = useState(quote?.items ?? []);
  const [terms, setTerms] = useState(quote?.terms ?? "");
  const [price, setPrice] = useState(quote ? String(quote.price) : "");
  const [hours, setHours] = useState(quote ? String(quote.delivery_hours) : "");
  const [explanation, setExplanation] = useState(quote?.explanation ?? "");
  const stale = change.agreement_revision !== deal.agreement?.revision || !deal.agreement.confirmed_by.Buyer || !deal.agreement.confirmed_by.Seller;
  const exception = selected.some(index => change.assessment.items[index].category !== "new_work");
  const unsaved = Boolean(quote && (JSON.stringify(selected) !== JSON.stringify(quote.items) || terms !== quote.terms || Number(price) !== quote.price || Number(hours) !== quote.delivery_hours || explanation !== quote.explanation));
  const base = `/api/deals/${deal.id}/changes/${change.id}`;
  return <article className="panel">
    <p className="eyebrow">Request against agreement version {change.agreement_revision}</p>
    <p>{change.request}</p><p className="muted">{change.assessment.summary}</p>
    {change.assessment.items.map((item, index) => <div className="acceptance-item" key={index}>
      <strong>{categories[item.category]}</strong><q>{item.request_quote}</q><p>{item.reason}</p>
      {item.agreement_quotes.map((source, i) => <blockquote key={i}><q>{source.quote}</q><p className="muted">Confirmed term: {source.id}</p></blockquote>)}
      {!item.agreement_quotes.length && <p className="muted">No matching term quoted. Discuss this before agreeing to extra fees.</p>}
      {view === "Seller" && !change.child_id && !stale && <label className="check-label"><input type="checkbox" disabled={busy} checked={selected.includes(index)} onChange={event => setSelected(event.target.checked ? [...selected, index].sort((a, b) => a - b) : selected.filter(value => value !== index))} /><span>Include this request in my additional quote</span></label>}
    </div>)}
    {change.child_id ? <p className="notice"><Link href={`/deals/${change.child_id}`}>Open the separate ${quote!.price.toFixed(2)} order →</Link><br />No payment is taken until the buyer authorizes that order.</p> : stale ? <p className="notice">The original agreement changed. Confirm the latest version and compare the request again.</p> : <>
      {view === "Seller" && <form className="form-stack" onSubmit={event => {
        event.preventDefault();
        void onAction("Saving seller quote", () => api(`${base}/quote`, { revision: quote?.revision ?? 0, items: selected, terms, price: Number(price), delivery_hours: Number(hours), explanation }));
      }}>
        <h3>Seller's additional quote</h3>
        <label>Exactly what the additional order includes<textarea required minLength={10} maxLength={500} rows={3} disabled={busy} value={terms} onChange={event => setTerms(event.target.value)} /></label>
        <label>Additional price in USD<input required type="number" min="0.01" max="100000" step="0.01" disabled={busy} value={price} onChange={event => setPrice(event.target.value)} /></label>
        <label>Delivery hours after the new order is authorized<input required type="number" min="1" max="696" step="1" disabled={busy} value={hours} onChange={event => setHours(event.target.value)} /></label>
        <label>Clarification for the buyer{exception && " (required for a request not classified as additional work)"}<textarea required={exception} maxLength={1000} rows={2} disabled={busy} value={explanation} onChange={event => setExplanation(event.target.value)} /></label>
        <p className="muted">This sets a separate delivery window. It does not extend the original deadline. Saving edits clears both quote confirmations.</p>
        <button disabled={busy || !selected.length || Boolean(quote && !unsaved)}>Save additional quote</button>
      </form>}
      {quote ? <div className="notice">
        <h3>Additional quote · version {quote.revision}</h3>
        <p>{quote.terms}</p>
        <p><strong>${quote.price.toFixed(2)}</strong> · Complete within {quote.delivery_hours} hours after separate payment authorization.</p>
        <p>Requests covered: {quote.items.map(index => `“${change.assessment.items[index].request_quote}”`).join("; ")}</p>
        {quote.explanation && <p>Seller's clarification: {quote.explanation}</p>}
        {quote.items.some(index => change.assessment.items[index].category !== "new_work") && <p>This quote includes a request the AI did not classify as additional work. Review why extra payment is proposed.</p>}
        <p>Buyer {quote.confirmed_by.Buyer ? "confirmed" : "pending"} · Seller {quote.confirmed_by.Seller ? "confirmed" : "pending"}</p>
        <p className="muted">Both confirmations create one separate order with these terms. The original price and settlement stay unchanged.</p>
        <button disabled={busy || Boolean(quote.confirmed_by[view]) || (view === "Seller" && unsaved)} onClick={() => onAction("Confirming additional quote", () => api(`${base}/confirm`, { actor: view, revision: quote.revision }))}>Accept quote as {view.toLowerCase()}</button>
      </div> : view === "Buyer" && <p className="muted">Switch to Seller view to propose the scope, price and delivery window. AI does not set a price.</p>}
    </>}
  </article>;
}
