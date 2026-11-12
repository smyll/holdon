import { checklistSchema, decisionsSchema, scopeTermsSchema, cents, fullPriceAcceptance, type Deal } from "./types.ts";

function record(deal: Deal, actor: "Buyer" | "Seller", text: string, ref?: string) {
  deal.events.push({ at: new Date().toISOString(), actor, text, ...(ref ? { ref } : {}) });
}

export function reviseChecklist(deal: Deal, input: unknown, revision: number, scopeTerms?: unknown) {
  if (deal.parent) throw new Error("This checklist comes from an accepted change quote and is locked. Create a new change for different terms.");
  if (deal.status !== "analyzed") throw new Error("The checklist is locked once payment starts.");
  if (revision !== (deal.agreement?.revision ?? 0)) throw new Error("The checklist changed. Refresh before editing it.");
  const checklist = checklistSchema.parse(input);
  const terms = scopeTerms === undefined ? deal.analysis.scope_terms : scopeTermsSchema.parse(scopeTerms);
  if (checklist.reduce((sum, item) => sum + cents(item.value), 0) !== cents(deal.analysis.total_price)) throw new Error("Checklist values must add up to the deal total.");
  deal.analysis.checklist = checklist;
  deal.analysis.scope_terms = terms;
  deal.agreement = { revision: revision + 1, confirmed_by: {} };
  record(deal, "Buyer", `Checklist revised to version ${revision + 1}. Both sides must confirm it.`);
  return deal;
}

export function confirmAgreement(deal: Deal, actor: "Buyer" | "Seller", revision: number) {
  if (deal.status !== "analyzed") throw new Error("This agreement is already locked or unavailable for payment.");
  if (revision !== (deal.agreement?.revision ?? 0)) throw new Error("The checklist changed. Review the latest version.");
  deal.agreement ??= { revision: 0, confirmed_by: {} };
  if (!deal.agreement.confirmed_by[actor]) {
    deal.agreement.confirmed_by[actor] = new Date().toISOString();
    record(deal, actor, `Confirmed checklist version ${revision}.`);
  }
  return deal;
}

function reviewableDelivery(deal: Deal, id: string) {
  const delivery = deal.deliveries.at(-1);
  if (deal.status !== "delivered" || deal.paypal.release_request || deal.paypal.captures.length || delivery?.id !== id) throw new Error("This delivery changed or settlement has started. Refresh the deal.");
  return delivery;
}

export function recordReview(deal: Deal, deliveryId: string, revision: number, input: unknown) {
  const delivery = reviewableDelivery(deal, deliveryId);
  if (revision !== (delivery.review?.revision ?? 0)) throw new Error("The acceptance proposal changed. Refresh before saving.");
  const decisions = decisionsSchema.parse(input);
  if (decisions.length !== deal.analysis.checklist.length || new Set(decisions.map(item => item.id)).size !== decisions.length || deal.analysis.checklist.some(item => !decisions.some(decision => decision.id === item.id))) throw new Error("Review every checklist item exactly once.");
  for (const decision of decisions) {
    const suggestion = delivery.verdicts?.find(verdict => verdict.id === decision.id);
    const supported = suggestion?.met && suggestion.confidence >= 0.6;
    if (decision.accepted && !supported && !decision.note) throw new Error("Add a reason when accepting an item without a supporting AI assessment.");
  }
  const amount = deal.analysis.checklist.reduce((sum, item) => sum + (decisions.find(decision => decision.id === item.id)!.accepted ? cents(item.value) : 0), 0) / 100;
  delivery.review = { revision: revision + 1, at: new Date().toISOString(), decisions, amount };
  record(deal, "Buyer", `Proposed $${amount.toFixed(2)} settlement. ${decisions.map(item => `${item.id}: ${item.accepted ? "accepted" : "open"}${item.note ? ` (${item.note})` : ""}`).join("; ")}`, delivery.id);
  return deal;
}

export function confirmSettlement(deal: Deal, deliveryId: string, revision: number) {
  const delivery = reviewableDelivery(deal, deliveryId);
  if (!delivery.review || delivery.review.revision !== revision) throw new Error("Review the latest acceptance proposal before agreeing.");
  if (!delivery.review.seller_confirmed_at) {
    delivery.review.seller_confirmed_at = new Date().toISOString();
    record(deal, "Seller", `Agreed to $${delivery.review.amount.toFixed(2)} settlement and closure of the remaining authorization.`, delivery.id);
  }
  return deal;
}

export function agreedSettlement(deal: Deal, deliveryId?: string, revision?: number) {
  const delivery = deal.deliveries.at(-1);
  const review = delivery?.review;
  if (!delivery || delivery.id !== deliveryId || !review || review.revision !== revision || (!review.seller_confirmed_at && !fullPriceAcceptance(deal, review))) throw new Error("Both sides must agree to the current settlement before payment or closure.");
  return review;
}
