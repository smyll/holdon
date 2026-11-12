import { randomUUID } from "node:crypto";
import { z } from "zod";
import { changeQuoteSchema, scopeAssessmentSchema, type Deal, type ScopeChange } from "./types.ts";

export const changeRequestSchema = z.object({ request: z.string().trim().min(10).max(5000), revision: z.number().int().nonnegative() });

export function requireConfirmedScope(deal: Deal, revision: number) {
  if (deal.status === "refused" || deal.analysis.risk === "do_not_pay" || !deal.agreement?.confirmed_by.Buyer || !deal.agreement.confirmed_by.Seller) throw new Error("Both sides must confirm the original agreement before reviewing changes.");
  if (deal.agreement.revision !== revision) throw new Error("The original agreement changed. Analyze the request against the latest confirmed version.");
}

export function groundedAssessment(deal: Deal, request: string, raw: unknown) {
  const result = scopeAssessmentSchema.parse(raw);
  for (const item of result.items) {
    if (!request.includes(item.request_quote)) throw new Error("The scope review quoted text outside the request. Retry the analysis.");
    for (const source of item.agreement_quotes) {
      const term = [...deal.analysis.checklist, ...(deal.analysis.scope_terms ?? []).map((text, index) => ({ id: `scope:${index + 1}`, text }))].find(term => term.id === source.id);
      if (!term?.text.includes(source.quote)) throw new Error("The scope review could not support its agreement quotation. Retry the analysis.");
    }
    if (!item.agreement_quotes.length && !["new_work", "unclear"].includes(item.category)) {
      item.category = "unclear";
      item.reason = "No confirmed checklist term supports this classification. Discuss whether this request is already included.";
    }
  }
  return result;
}

export function addScopeChange(deal: Deal, request: string, revision: number, raw: unknown) {
  requireConfirmedScope(deal, revision);
  if ((deal.scope_changes?.length ?? 0) >= 10) throw new Error("This demo supports up to ten scope reviews per deal.");
  const change: ScopeChange = { id: randomUUID(), at: new Date().toISOString(), request, agreement_revision: revision, assessment: groundedAssessment(deal, request, raw) };
  (deal.scope_changes ??= []).push(change);
  deal.events.push({ at: change.at, actor: "AI", text: "Compared a change request with the confirmed agreement. No price or payment was changed.", ref: change.id });
  return deal;
}

function currentChange(deal: Deal, id: string) {
  const change = deal.scope_changes?.find(item => item.id === id);
  if (!change) throw new Error("Change request not found.");
  requireConfirmedScope(deal, change.agreement_revision);
  return change;
}

export function quoteScopeChange(deal: Deal, id: string, revision: number, raw: unknown) {
  const change = currentChange(deal, id);
  if (change.child_id) throw new Error("This quote already has a separate order and cannot be edited.");
  if (revision !== (change.quote?.revision ?? 0)) throw new Error("The quote changed. Refresh before editing.");
  const quote = changeQuoteSchema.parse(raw);
  if (new Set(quote.items).size !== quote.items.length || quote.items.some(index => !change.assessment.items[index])) throw new Error("Select each requested item at most once.");
  if (quote.items.some(index => change.assessment.items[index].category !== "new_work") && !quote.explanation) throw new Error("Explain why extra payment is proposed for an included, corrective or unclear request. Both sides must review this exception.");
  change.quote = { ...quote, revision: revision + 1, confirmed_by: {} };
  deal.events.push({ at: new Date().toISOString(), actor: "Seller", text: `Proposed additional work for $${quote.price.toFixed(2)}, due ${quote.delivery_hours} hours after its separate authorization. Quote version ${revision + 1} needs both confirmations.`, ref: id });
  return deal;
}

// The parent link and child order are saved in one store transaction, including retried confirmations.
export function confirmScopeChange(deals: Deal[], parentId: string, id: string, actor: "Buyer" | "Seller", revision: number) {
  const deal = deals.find(item => item.id === parentId);
  if (!deal) throw new Error("Deal not found.");
  const change = deal.scope_changes?.find(item => item.id === id);
  if (!change?.quote || change.quote.revision !== revision) throw new Error("Review the latest quote before confirming.");
  if (change.child_id) return deal;
  currentChange(deal, id);
  const quote = change.quote;
  const at = new Date().toISOString();
  if (!quote.confirmed_by[actor]) {
    quote.confirmed_by[actor] = at;
    deal.events.push({ at, actor, text: `Accepted additional quote version ${revision}: $${quote.price.toFixed(2)}. Original terms and payment stay in place.`, ref: id });
  }
  if (quote.confirmed_by.Buyer && quote.confirmed_by.Seller) {
    const child: Deal = {
      id: randomUUID(), title: `Additional work · ${deal.title}`.slice(0, 120),
      chat: `Confirmed additional work: ${quote.terms}\nPrice: USD ${quote.price.toFixed(2)}. Complete delivery within ${quote.delivery_hours} hours of this order's authorization.\n${quote.explanation}`,
      created_at: at, status: "analyzed", parent: { deal_id: deal.id, change_id: id },
      analysis: { item_summary: quote.terms, total_price: quote.price, currency: "USD", risk: deal.analysis.risk, red_flags: [],
        recommendation: "This checklist records the human-approved change quote. The risk level is inherited from the original agreement; no separate AI risk assessment was performed.",
        checklist: [
          { id: "additional-work", text: quote.terms, evidence: "file", value: quote.price },
          { id: "additional-timing", text: `Complete additional work within ${quote.delivery_hours} hours of this order's authorization. No separate timing fee.`, evidence: "text", value: 0, deadline: { hours: quote.delivery_hours, condition: "complete_delivery" } },
        ],
      },
      agreement: { revision: 1, confirmed_by: { ...quote.confirmed_by } },
      paypal: { captures: [] }, deliveries: [],
      events: (["Seller", "Buyer"] as const).map(party => ({ at: quote.confirmed_by[party]!, actor: party, text: `Confirmed additional quote version ${revision} on the original deal. This order contains those exact terms.`, ref: deal.id })),
    };
    change.child_id = child.id;
    deals.push(child);
    deal.events.push({ at, actor, text: "Created a separate order for the accepted change. Payment still needs buyer authorization.", ref: child.id });
  }
  return deal;
}
