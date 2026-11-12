"use client";
import { useState } from "react";
import { fullPriceAcceptance, type Deal } from "../../lib/types";
import { api } from "./api";

export function AcceptanceReview({ deal, view, busy, onAction }: {
  deal: Deal; view: "Buyer" | "Seller"; busy: boolean;
  onAction: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const delivery = deal.deliveries.at(-1)!;
  const review = delivery.review;
  const [decisions, setDecisions] = useState(() => review?.decisions ?? deal.analysis.checklist.map(item => ({ id: item.id, accepted: false, note: "" })));
  const editable = deal.status === "delivered" && !deal.paypal.release_request && !deal.paypal.captures.length;
  const amount = deal.analysis.checklist.reduce((sum, item) => sum + (decisions.find(decision => decision.id === item.id)?.accepted ? Math.round(item.value * 100) : 0), 0) / 100;
  const base = `/api/deals/${deal.id}`;
  const reference = { delivery_id: delivery.id, review_revision: review?.revision };
  const fullAcceptance = review && fullPriceAcceptance(deal, review);
  function update(id: string, change: { accepted?: boolean; note?: string }) {
    setDecisions(decisions.map(decision => decision.id === id ? { ...decision, ...change } : decision));
  }
  return <section className="panel">
    <h2>Human acceptance</h2>
    <p className="muted">Choose what you accept. Full acceptance at the original price can be paid directly under the confirmed agreement. A reduced settlement needs the seller's agreement.</p>
    {view === "Buyer" && editable ? <>
      <button className="secondary" disabled={busy} onClick={() => setDecisions(decisions.map(decision => {
        const verdict = delivery.verdicts?.find(item => item.id === decision.id);
        return verdict?.met && verdict.confidence >= .6 ? { ...decision, accepted: true } : decision;
      }))}>Select all AI-supported items</button>
      <p className="muted">Nothing is accepted automatically. Add a reason when accepting beyond the supporting evidence.</p>
      {deal.analysis.checklist.map(item => {
        const decision = decisions.find(value => value.id === item.id)!;
        return <div className="acceptance-item" key={item.id}>
          <label className="check-label"><input type="checkbox" checked={decision.accepted} disabled={busy} onChange={event => update(item.id, { accepted: event.target.checked })} /><span>Accept {item.text} · ${item.value.toFixed(2)}</span></label>
          <input aria-label={`Acceptance note for ${item.id}`} placeholder="Reason or evidence for your decision" maxLength={1000} value={decision.note} disabled={busy} onChange={event => update(item.id, { note: event.target.value })} />
        </div>;
      })}
      <p className="total">Your proposed settlement ${amount.toFixed(2)}</p>
      <button disabled={busy} onClick={() => onAction("Saving acceptance proposal", () => api(`${base}/deliveries/${delivery.id}/review`, { revision: review?.revision ?? 0, decisions }))}>Save acceptance proposal</button>
    </> : review ? <>
      {review.decisions.map(decision => <p key={decision.id}><strong>{decision.accepted ? "Accepted" : "Open"}</strong> · {deal.analysis.checklist.find(item => item.id === decision.id)?.text}{decision.note && ` — ${decision.note}`}</p>)}
    </> : <p>{deal.paypal.captures.length ? "This earlier settlement has no saved item-level human acceptance record." : "The buyer has not saved an acceptance proposal for this submission."}</p>}
    {review && <div className="notice">
      <p>Saved proposal ${review.amount.toFixed(2)} · {fullAcceptance ? "Full acceptance under the original agreement" : review.seller_confirmed_at ? "Seller agreed" : "Awaiting seller response"}</p>
      {view === "Seller" && editable && !fullAcceptance && !review.seller_confirmed_at && <button disabled={busy} onClick={() => onAction("Agreeing to settlement", () => api(`${base}/deliveries/${delivery.id}/settlement`, { revision: review.revision }))}>Agree to ${review.amount.toFixed(2)} and close the balance</button>}
      {view === "Buyer" && (fullAcceptance || review.seller_confirmed_at) && !deal.paypal.captures.length && deal.status === "delivered" && <button disabled={busy || JSON.stringify(decisions) !== JSON.stringify(review.decisions)} onClick={() => onAction("Confirming agreed settlement", () => review.amount > 0
        ? api(`${base}/release`, { ...reference, amount: review.amount, close_remaining: true })
        : api(`${base}/void`, reference))}>{review.amount > 0 ? `Pay agreed $${review.amount.toFixed(2)} and close the balance` : "Close the authorization for the agreed $0 settlement"}</button>}
    </div>}
    {editable && view === "Seller" && <p className="muted">Use Submit delivery above to add missing evidence. A new submission starts a fresh acceptance proposal.</p>}
  </section>;
}
