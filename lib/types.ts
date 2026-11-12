import { z } from "zod";

export const amountSchema = z.number().finite().min(0).max(100_000).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, "Use at most two decimal places.");
export const scopeTermsSchema = z.array(z.string().trim().min(1).max(500)).max(10);
export const checklistSchema = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  text: z.string().trim().min(1).max(500),
  evidence: z.enum(["image", "file", "tracking_number", "link", "text"]),
  value: z.number().finite().nonnegative().max(100_000),
  check: z.object({ kind: z.literal("file_ext"), allowed: z.array(z.string().regex(/^\.[a-zA-Z0-9]{1,10}$/)).min(1).max(10) }).nullable().optional(),
  deadline: z.object({ hours: z.number().positive().max(696), condition: z.enum(["submission", "complete_delivery"]) }).nullable().optional(),
})).min(1).max(20).refine(items => new Set(items.map(item => item.id)).size === items.length, "Checklist IDs must be unique.");
export const analysisSchema = z.object({
  item_summary: z.string().min(1).max(1000),
  total_price: z.number().finite().positive(), currency: z.literal("USD"),
  checklist: checklistSchema,
  scope_terms: scopeTermsSchema.optional(),
  red_flags: z.array(z.object({
    quote: z.string().min(1).max(1000),
    pattern: z.enum(["off_platform_payment", "friends_and_family", "urgency", "gift_card_or_crypto", "identity_mismatch", "price_too_good", "advance_fee", "other"]),
    severity: z.enum(["low", "medium", "high"]), explain: z.string().min(1).max(1000),
  })).max(20),
  risk: z.enum(["low", "medium", "high", "do_not_pay"]),
  recommendation: z.string().min(1).max(2000),
});
export const verdictSchema = z.object({
  verdicts: z.array(z.object({ id: z.string(), met: z.boolean(), confidence: z.number().min(0).max(1), reason: z.string().min(1).max(1000), status: z.enum(["supported", "missing_evidence", "pending", "needs_review"]).optional() })).max(20),
});
export const decisionsSchema = z.array(z.object({ id: z.string(), accepted: z.boolean(), note: z.string().trim().max(1000) })).min(1).max(20);
export const newDealSchema = z.object({ title: z.string().trim().min(1).max(120), chat: z.string().trim().min(10).max(20_000), price: amountSchema.refine(value => value > 0) });
export const scopeAssessmentSchema = z.object({
  summary: z.string().min(1).max(1000),
  items: z.array(z.object({
    request_quote: z.string().min(1).max(1500),
    category: z.enum(["included", "correction", "included_revision", "new_work", "unclear"]),
    reason: z.string().min(1).max(1000),
    agreement_quotes: z.array(z.object({ id: z.string(), quote: z.string().min(1).max(500) })).max(10),
  })).min(1).max(10),
});
export const changeQuoteSchema = z.object({
  items: z.array(z.number().int().min(0).max(9)).min(1).max(10),
  terms: z.string().trim().min(10).max(500),
  price: amountSchema.refine(value => value > 0),
  delivery_hours: z.number().int().min(1).max(696),
  explanation: z.string().trim().max(1000),
});
export type ScopeChange = {
  id: string; at: string; request: string; agreement_revision: number;
  assessment: z.infer<typeof scopeAssessmentSchema>;
  quote?: z.infer<typeof changeQuoteSchema> & { revision: number; confirmed_by: { Buyer?: string; Seller?: string } };
  child_id?: string;
};
export type Analysis = z.infer<typeof analysisSchema>;
export type ChecklistItem = Analysis["checklist"][number];
export type ItemVerdict = z.infer<typeof verdictSchema>["verdicts"][number];
export type DeliveryFile = { name: string; path: string; mime: string; size: number };
export type Review = { revision: number; at: string; decisions: z.infer<typeof decisionsSchema>; amount: number; seller_confirmed_at?: string };
export type Delivery = { id: string; at: string; note: string; files: DeliveryFile[]; verdicts?: ItemVerdict[]; proposed_release?: number; verification_error?: string; review?: Review };
export type Deal = {
  id: string; title: string; chat: string; created_at: string; analysis: Analysis;
  status: "analyzed" | "refused" | "awaiting_payment" | "held" | "delivered" | "partially_released" | "released" | "voided";
  agreement?: { revision: number; confirmed_by: { Buyer?: string; Seller?: string } };
  scope_changes?: ScopeChange[];
  parent?: { deal_id: string; change_id: string };
  paypal: { order_id?: string; authorization_id?: string; order_requested_at?: string; captures: { id: string; amount: number; at: string }[]; voided_at?: string; release_request?: { amount: number; close_remaining: boolean; delivery_id?: string; review_revision?: number } };
  deliveries: Delivery[];
  events: { at: string; actor: "AI" | "PayPal" | "Buyer" | "Seller"; text: string; ref?: string }[];
};

export function cents(value: number) { return Math.round(amountSchema.parse(value) * 100); }

export function fullPriceAcceptance(deal: Deal, review: Review) {
  return Boolean(deal.agreement?.confirmed_by.Seller && deal.agreement.confirmed_by.Buyer)
    && cents(review.amount) === cents(deal.analysis.total_price)
    && review.decisions.length === deal.analysis.checklist.length
    && deal.analysis.checklist.every(item => review.decisions.some(decision => decision.id === item.id && decision.accepted));
}

export function normalizeAnalysis(raw: unknown, chat: string, price: number): Analysis {
  const analysis = analysisSchema.parse(raw);
  const total = cents(price);
  const weights = analysis.checklist.map(item => item.value);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("The checklist must assign value to at least one item.");
  let allocated = 0;
  analysis.checklist = analysis.checklist.map((item, index) => {
    const share = index === weights.length - 1 ? total - allocated : Math.floor(total * weights[index] / sum);
    allocated += share;
    return { ...item, value: share / 100 };
  });
  analysis.total_price = price;
  analysis.red_flags = analysis.red_flags.filter(flag => chat.includes(flag.quote));
  if (analysis.scope_terms) analysis.scope_terms = analysis.scope_terms.filter(term => chat.includes(term));
  return analysis;
}

export function evaluateDelivery(checklist: ChecklistItem[], raw: unknown, files: (Pick<DeliveryFile, "name"> & Partial<Pick<DeliveryFile, "mime">>)[], remaining: number, timing?: { authorized_at?: string; submitted_at: string }) {
  const { verdicts } = verdictSchema.parse(raw);
  const ids = verdicts.map(verdict => verdict.id);
  if (new Set(ids).size !== ids.length || ids.length !== checklist.length || checklist.some(item => !ids.includes(item.id))) {
    throw new Error("The verifier must return each checklist item exactly once.");
  }
  const checked: ItemVerdict[] = checklist.map(item => {
    const rawVerdict = verdicts.find(value => value.id === item.id)!;
    const verdict = { ...rawVerdict, met: rawVerdict.met && (!rawVerdict.status || rawVerdict.status === "supported") };
    if (!item.check) return verdict;
    const matching = files.filter(file => item.check!.allowed.some(extension => file.name.toLowerCase().endsWith(extension.toLowerCase())));
    if (!matching.length) return { id: item.id, met: false, confidence: 1, status: "missing_evidence" as const, reason: `Required file (${item.check.allowed.join(", ")}) is not in the submitted evidence. It can still be supplied.` };
    if (!matching.some(file => ["image/png", "image/jpeg", "image/webp"].includes(file.mime ?? ""))) {
      return { id: item.id, met: false, confidence: 0, status: "needs_review" as const, reason: `A ${item.check.allowed.join(" / ")} file is attached. Its contents need human review before acceptance.` };
    }
    return verdict;
  });
  const isTimingOnly = (item: ChecklistItem) => Boolean(item.deadline && item.evidence === "text" && !item.check);
  const contentSupported = checked.every((verdict, index) => isTimingOnly(checklist[index]) || (verdict.met && verdict.confidence >= 0.6));
  checklist.forEach((item, index) => {
    if (!item.deadline) return;
    const elapsed = (Date.parse(timing?.submitted_at ?? "") - Date.parse(timing?.authorized_at ?? "")) / 3_600_000;
    let verdict: ItemVerdict = { id: item.id, met: false, confidence: 0, status: "needs_review", reason: "Confirm the authorization and delivery timestamps before assessing this timing term." };
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      if (elapsed > item.deadline.hours) verdict = { ...verdict, reason: `Submitted ${elapsed.toFixed(1)} hours after authorization. Review the agreed ${item.deadline.hours}-hour timing term with the seller.` };
      else if (item.deadline.condition === "complete_delivery" && !contentSupported) verdict = { ...verdict, status: "pending", reason: "The delivery is incomplete, but this submission was before the deadline. The seller can supply remaining evidence; this is not a final timing failure." };
      else verdict = isTimingOnly(item)
        ? { ...verdict, met: true, confidence: 1, status: "supported", reason: `This submission was recorded within the agreed ${item.deadline.hours} hours.` }
        : { ...checked[index], reason: `${checked[index].reason} Submitted within ${item.deadline.hours} hours of authorization; timing alone does not establish delivery.` };
    }
    checked[index] = verdict;
  });
  const eligible = checklist.reduce((sum, item, index) => sum + (checked[index].met && checked[index].confidence >= 0.6 ? cents(item.value) : 0), 0);
  return { verdicts: checked, proposed_release: Math.min(eligible, cents(remaining)) / 100 };
}
