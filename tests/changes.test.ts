import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addScopeChange, groundedAssessment, quoteScopeChange, confirmScopeChange } from "../lib/changes.ts";
import { createStore } from "../lib/store.ts";
import { agreedSettlement, recordReview, reviseChecklist } from "../lib/review.ts";
import { fullPriceAcceptance, type Deal } from "../lib/types.ts";
import { createAI } from "../lib/ai.ts";

const request = "Please add packaging design and fix the company name typo.";
const assessment = { summary: "Separate new work from correction.", items: [
  { request_quote: "add packaging design", category: "new_work", reason: "Packaging excluded.", agreement_quotes: [{ id: "logos", quote: "Packaging is excluded." }] },
  { request_quote: "fix the company name typo", category: "correction", reason: "The agreed name should be correct.", agreement_quotes: [{ id: "logos", quote: "Maple Bakery" }] },
] };
function original(): Deal {
  return { id: "original", title: "Original logo job", chat: "Private chat context not needed for comparison", created_at: "2026-11-10T00:00:00Z", status: "analyzed",
    analysis: { item_summary: "Logos", total_price: 120, currency: "USD", risk: "low", red_flags: [], recommendation: "Confirm together.",
      checklist: [{ id: "logos", text: "Three logos for Maple Bakery. Two revision rounds included. Packaging is excluded.", evidence: "image", value: 120 }],
    }, agreement: { revision: 1, confirmed_by: { Buyer: "2026-11-10T00:00:00Z", Seller: "2026-11-10T00:00:01Z" } }, paypal: { captures: [] }, deliveries: [], events: [],
  };
}
const offer = { items: [0], terms: "Create a packaging design in PNG and PDF for Maple Bakery.", price: 45.25, delivery_hours: 48, explanation: "" };

test("scope quotations are grounded; unsupported entitlements become unclear", () => {
  const item = original();
  assert.deepEqual(groundedAssessment(item, request, assessment), assessment);
  assert.throws(() => groundedAssessment(item, request, { ...assessment, items: [{ ...assessment.items[0], request_quote: "fabricated customer request" }] }), /outside the request/);
  assert.throws(() => groundedAssessment(item, request, { ...assessment, items: [{ ...assessment.items[0], agreement_quotes: [{ id: "logos", quote: "All packaging is included" }] }] }), /quotation/);
  const result = groundedAssessment(item, request, { ...assessment, items: [{ ...assessment.items[1], agreement_quotes: [] }] });
  assert.equal(result.items[0].category, "unclear");
  item.analysis.scope_terms = ["Packaging is excluded."];
  assert.doesNotThrow(() => groundedAssessment(item, request, { ...assessment, items: [{ ...assessment.items[0], agreement_quotes: [{ id: "scope:1", quote: "Packaging is excluded." }] }] }));
});

test("seller pricing an included correction needs an explicit explanation", () => {
  const item = original();
  addScopeChange(item, request, 1, assessment);
  const id = item.scope_changes![0].id;
  assert.throws(() => quoteScopeChange(item, id, 0, { ...offer, items: [1] }), /Explain why/);
  assert.throws(() => quoteScopeChange(item, id, 0, { ...offer, items: [0, 0] }), /at most once/);
  assert.throws(() => quoteScopeChange(item, id, 0, { ...offer, price: 1.001 }), /decimal/);
  quoteScopeChange(item, id, 0, offer);
  assert.equal(item.scope_changes![0].quote!.price, 45.25);
  assert.deepEqual(item.scope_changes![0].quote!.confirmed_by, {});
});

test("quote edits invalidate both approvals and parent edits invalidate the assessment", () => {
  const item = original(); const items = [item];
  addScopeChange(item, request, 1, assessment); const id = item.scope_changes![0].id;
  quoteScopeChange(item, id, 0, offer);
  confirmScopeChange(items, item.id, id, "Buyer", 1);
  quoteScopeChange(item, id, 1, { ...offer, price: 50 });
  assert.deepEqual(item.scope_changes![0].quote!.confirmed_by, {});
  assert.throws(() => confirmScopeChange(items, item.id, id, "Seller", 1), /latest quote/);
  reviseChecklist(item, item.analysis.checklist, 1);
  assert.throws(() => confirmScopeChange(items, item.id, id, "Buyer", 2), /confirm the original/);
  assert.equal(items.length, 1);
});

test("changing non-priced scope terms also resets agreement confirmations", () => {
  const item = original();
  reviseChecklist(item, item.analysis.checklist, 1, ["One revision round for the whole project."]);
  assert.deepEqual(item.agreement!.confirmed_by, {});
  assert.equal(item.analysis.scope_terms![0], "One revision round for the whole project.");
});

test("concurrent repeated confirmations create exactly one separate order without changing original payment", async () => {
  const store = createStore(await mkdtemp(join(tmpdir(), "holdon-changes-")));
  const item = original();
  const before = JSON.stringify({ analysis: item.analysis, agreement: item.agreement, paypal: item.paypal, status: item.status });
  addScopeChange(item, request, 1, assessment); const id = item.scope_changes![0].id;
  quoteScopeChange(item, id, 0, offer); await store.add(item);
  await store.transaction(async deals => confirmScopeChange(deals, item.id, id, "Seller", 1));
  assert.equal((await store.list()).length, 1);
  await Promise.all(Array.from({ length: 4 }, () => store.transaction(async deals => confirmScopeChange(deals, item.id, id, "Buyer", 1))));
  const all = await store.list(); assert.equal(all.length, 2);
  const parent = all[0]; const child = all[1];
  assert.equal(JSON.stringify({ analysis: parent.analysis, agreement: parent.agreement, paypal: parent.paypal, status: parent.status }), before);
  assert.equal(child.id, parent.scope_changes![0].child_id);
  assert.equal(child.parent?.deal_id, parent.id);
  assert.equal(child.analysis.total_price, offer.price);
  assert.equal(child.analysis.checklist[0].text, offer.terms);
  assert.equal(child.analysis.checklist[1].deadline?.hours, offer.delivery_hours);
  assert.equal(child.paypal.order_id, undefined); assert.deepEqual(child.paypal.captures, []);
  assert.throws(() => reviseChecklist(child, child.analysis.checklist, 1), /accepted change quote/);
  assert.throws(() => quoteScopeChange(parent, id, 1, offer), /cannot be edited/);
});

test("full original-price acceptance skips repeated seller consent but partial or waived items do not", () => {
  const item = original(); item.status = "delivered";
  item.deliveries = [{ id: "delivery", at: item.created_at, files: [], note: "Ready", verdicts: [{ id: "logos", met: true, confidence: .9, reason: "Evidence supported" }] }];
  recordReview(item, "delivery", 0, [{ id: "logos", accepted: true, note: "" }]);
  assert.equal(agreedSettlement(item, "delivery", 1).amount, 120);
  assert.equal(item.deliveries[0].review!.seller_confirmed_at, undefined);
  recordReview(item, "delivery", 1, [{ id: "logos", accepted: false, note: "Not accepted" }]);
  assert.throws(() => agreedSettlement(item, "delivery", 2), /Both sides/);
  item.analysis.checklist.push({ id: "timing", text: "Timing obligation", value: 0, evidence: "text" });
  const waived = { revision: 3, at: item.created_at, amount: 120, decisions: [{ id: "logos", accepted: true, note: "" }, { id: "timing", accepted: false, note: "Waive timing" }] };
  assert.equal(fullPriceAcceptance(item, waived), false);
});

test("scope AI receives only confirmed terms and request, never payment credentials or a pricing instruction", async () => {
  const ai = createAI({ DEEPSEEK_API_KEY: "test" }, async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    const input = JSON.parse(body.messages[1].content[0].text);
    assert.deepEqual(Object.keys(input).sort(), ["confirmed_checklist", "request"]);
    assert.equal(input.request, request);
    assert.match(body.messages[0].content, /No prices/);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(assessment) } }] });
  });
  assert.equal((await ai.compareScope(original(), request)).items[1].category, "correction");
});
