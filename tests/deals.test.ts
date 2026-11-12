import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAnalysis, evaluateDelivery, type Deal } from "../lib/types.ts";
import { createStore } from "../lib/store.ts";
import { releasePayment } from "../lib/deals.ts";
import { createPayPalClient, usd } from "../lib/paypal.ts";
import { createAI } from "../lib/ai.ts";
import { reviseChecklist, confirmAgreement, recordReview, confirmSettlement, agreedSettlement } from "../lib/review.ts";
import { POST } from "../app/api/deals/[[...path]]/route.ts";

const analysis = {
  item_summary: "Sample design", total_price: 120, currency: "USD", risk: "medium", recommendation: "Review the checklist.",
  checklist: [
    { id: "concept", text: "Concept", evidence: "image", value: 80 },
    { id: "svg", text: "SVG export", evidence: "file", value: 40, check: { kind: "file_ext", allowed: [".svg"] } },
  ], red_flags: [{ quote: "invented", pattern: "urgency", severity: "low", explain: "Test quote." }],
};

function deal(): Deal {
  return { id: "testdeal", title: "Sample", chat: "Sample agreement", created_at: new Date().toISOString(), analysis: normalizeAnalysis(analysis, "Sample agreement", 120), status: "delivered",
    paypal: { order_id: "ORDER1", authorization_id: "AUTH1", captures: [] }, events: [],
    deliveries: [{ id: "delivery1", at: new Date().toISOString(), note: "Sample", files: [], verdicts: [
      { id: "concept", met: true, confidence: .9, reason: "Image supplied." },
      { id: "svg", met: false, confidence: 0, reason: "Content not inspected." },
    ], proposed_release: 80 }],
  };
}

test("normalization preserves exact cents and drops fabricated quotes", () => {
  const raw = { ...analysis, checklist: analysis.checklist.map(item => ({ ...item, value: 1 })) };
  const result = normalizeAnalysis(raw, "Sample agreement", 0.03);
  assert.deepEqual(result.checklist.map(item => item.value), [0.01, 0.02]);
  assert.deepEqual(result.red_flags, []);
});

test("missing SVG overrides an AI pass and low confidence contributes no release", () => {
  const checklist = deal().analysis.checklist;
  const verdicts = [ { id: "concept", met: true, confidence: 0.9, reason: "Image supplied." }, { id: "svg", met: true, confidence: 1, reason: "Claimed supplied." } ];
  const result = evaluateDelivery(checklist, { verdicts }, [{ name: "logo.png" }], 120);
  assert.equal(result.proposed_release, 80);
  assert.equal(result.verdicts[1].met, false);
  verdicts[0].confidence = 0.5;
  assert.equal(evaluateDelivery(checklist, { verdicts }, [], 120).proposed_release, 0);
  assert.throws(() => evaluateDelivery(checklist, { verdicts: [verdicts[0], verdicts[0]] }, [], 120), /exactly once/);
});

test("concurrent store updates are retained and a checkpoint survives failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "holdon-store-"));
  const store = createStore(directory);
  await Promise.all([store.add(deal()), store.add({ ...deal(), id: "second" })]);
  assert.equal((await store.list()).length, 2);
  await assert.rejects(store.update("testdeal", async (item, checkpoint) => {
    item.paypal.release_request = { amount: 80, close_remaining: true };
    await checkpoint(); throw new Error("Simulated interruption");
  }), /Simulated/);
  assert.equal((await store.get("testdeal"))?.paypal.release_request?.amount, 80);
  assert.ok(JSON.parse(await readFile(join(directory, "deals.json"), "utf8")));
});

test("a failed void can be retried without capturing twice", async () => {
  const item = deal();
  recordReview(item, "delivery1", 0, [{ id: "concept", accepted: true, note: "" }, { id: "svg", accepted: false, note: "" }]);
  confirmSettlement(item, "delivery1", 1);
  let captures = 0;
  let voidCalls = 0;
  let status = "CREATED";
  const client = createPayPalClient({ PAYPAL_CLIENT_ID: "test", PAYPAL_CLIENT_SECRET: "test" }, async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/token")) return Response.json({ access_token: "test", expires_in: 3600 });
    if (path === "/v2/checkout/orders/ORDER1") return Response.json({ id: "ORDER1", status: "COMPLETED", intent: "AUTHORIZE", purchase_units: [{ custom_id: item.id, amount: usd(12000), payments: { authorizations: [{ id: "AUTH1" }] } }] });
    if (path.endsWith("/capture")) { captures++; status = "PARTIALLY_CAPTURED"; return Response.json({ id: "CAPTURE1", status: "COMPLETED", amount: usd(8000) }); }
    if (path.endsWith("/void")) {
      voidCalls++;
      if (voidCalls === 1) return Response.json({ name: "TEMPORARY_ERROR" }, { status: 500 });
      status = "VOIDED"; return new Response(null, { status: 204 });
    }
    assert.equal(options?.method, "GET");
    return Response.json({ id: "AUTH1", status, amount: usd(12000) });
  });
  const checkpoints: string[] = [];
  const save = async () => { checkpoints.push(JSON.stringify(item)); };
  await assert.rejects(releasePayment(item, save, 90, true, client, "delivery1", 1), /exact amount/);
  await assert.rejects(releasePayment(item, save, 80, true, client, "delivery1", 1), /500/);
  assert.equal(item.status, "partially_released");
  assert.equal(item.paypal.captures.length, 1);
  await releasePayment(item, save, 80, true, client, "delivery1", 1);
  await releasePayment(item, save, 80, true, client, "delivery1", 1);
  assert.equal(captures, 1); assert.equal(item.status, "released"); assert.equal(voidCalls, 2);
  assert.ok(checkpoints.length >= 3);
});

test("a matching filename cannot turn an uninspected SVG into an accepted deliverable", () => {
  const result = evaluateDelivery(deal().analysis.checklist, { verdicts: deal().deliveries[0].verdicts }, [{ name: "unrelated.svg", mime: "application/octet-stream" }], 120);
  assert.equal(result.verdicts[1].status, "needs_review");
  assert.equal(result.verdicts[1].met, false);
  assert.equal(result.proposed_release, 80);
});

test("an incomplete delivery before its deadline stays pending", () => {
  const items = [{ id: "content", text: "Content", evidence: "image" as const, value: 80 }, { id: "time", text: "48 hours", evidence: "text" as const, value: 40, deadline: { hours: 48, condition: "complete_delivery" as const } }];
  const raw = { verdicts: items.map(item => ({ id: item.id, met: false, confidence: .95, reason: "Incomplete delivery." })) };
  const early = { authorized_at: "2026-11-10T00:00:00Z", submitted_at: "2026-11-10T00:06:00Z" };
  assert.equal(evaluateDelivery(items, raw, [], 120, early).verdicts[1].status, "pending");
  const submission = items.map(item => item.deadline ? { ...item, deadline: { hours: 48, condition: "submission" as const } } : item);
  assert.equal(evaluateDelivery(submission, raw, [], 120, early).proposed_release, 40);
  assert.equal(evaluateDelivery(items, raw, [], 120, { ...early, submitted_at: "2026-11-13T00:00:00Z" }).verdicts[1].status, "needs_review");
  assert.equal(evaluateDelivery(items, raw, [], 120).verdicts[1].status, "needs_review");
});

test("a deadline attached to a deliverable cannot turn missing content into a pass", () => {
  const items = [{ id: "logo", text: "Logo within 48 hours", evidence: "image" as const, value: 120, deadline: { hours: 48, condition: "complete_delivery" as const } }];
  const raw = { verdicts: [{ id: "logo", met: false, confidence: .9, reason: "No logo supplied." }] };
  const timing = { authorized_at: "2026-11-10T00:00:00Z", submitted_at: "2026-11-10T00:06:00Z" };
  const result = evaluateDelivery(items, raw, [], 120, timing);
  assert.equal(result.proposed_release, 0);
  assert.equal(result.verdicts[0].status, "pending");
  const submission = items.map(item => ({ ...item, deadline: { hours: 48, condition: "submission" as const } }));
  assert.equal(evaluateDelivery(submission, raw, [], 120, timing).proposed_release, 0);
});

test("editing a confirmed checklist invalidates both confirmations", () => {
  const item = deal(); item.status = "analyzed";
  confirmAgreement(item, "Buyer", 0); confirmAgreement(item, "Seller", 0);
  assert.ok(item.agreement?.confirmed_by.Seller);
  reviseChecklist(item, item.analysis.checklist, 0);
  assert.deepEqual(item.agreement, { revision: 1, confirmed_by: {} });
  assert.throws(() => confirmAgreement(item, "Seller", 0), /latest version/);
  confirmAgreement(item, "Buyer", 1); confirmAgreement(item, "Seller", 1);
  assert.ok(item.agreement.confirmed_by.Buyer && item.agreement.confirmed_by.Seller);
});

test("humans can accept beyond AI advice, with a reason and seller agreement", () => {
  const item = deal();
  const decisions = [{ id: "concept", accepted: true, note: "" }, { id: "svg", accepted: true, note: "" }];
  assert.throws(() => recordReview(item, "delivery1", 0, decisions), /reason/);
  decisions[1].note = "I opened the SVG received separately and accept its contents.";
  recordReview(item, "delivery1", 0, decisions);
  assert.equal(item.deliveries[0].proposed_release, 80);
  assert.equal(item.deliveries[0].review?.amount, 120);
  assert.throws(() => agreedSettlement(item, "delivery1", 1), /Both sides/);
  confirmSettlement(item, "delivery1", 1);
  assert.equal(agreedSettlement(item, "delivery1", 1).amount, 120);
  recordReview(item, "delivery1", 1, [{ ...decisions[0], accepted: false }, decisions[1]]);
  assert.equal(item.deliveries[0].review?.seller_confirmed_at, undefined);
  assert.throws(() => confirmSettlement(item, "delivery1", 1), /latest/);
});

test("a supplement invalidates the old proposal and stale settlement references", () => {
  const item = deal();
  recordReview(item, "delivery1", 0, [{ id: "concept", accepted: true, note: "" }, { id: "svg", accepted: false, note: "" }]);
  confirmSettlement(item, "delivery1", 1);
  item.deliveries.push({ id: "delivery2", at: new Date().toISOString(), note: "Supplement", files: [] });
  assert.throws(() => agreedSettlement(item, "delivery1", 1), /Both sides/);
  assert.throws(() => recordReview(item, "delivery1", 1, []), /changed/);
});

test("verification includes earlier evidence and notes when a supplement arrives", async () => {
  const item = deal();
  item.deliveries[0].files.push({ name: "first.txt", path: "first.txt", mime: "text/plain", size: 10 });
  item.deliveries.push({ id: "delivery2", at: new Date().toISOString(), note: "Supplement", files: [{ name: "second.svg", path: "second.svg", mime: "application/octet-stream", size: 20 }] });
  const ai = createAI({ DEEPSEEK_API_KEY: "test" }, async (_url, options) => {
    const input = JSON.parse(JSON.parse(String(options?.body)).messages[1].content[0].text);
    assert.deepEqual(input.files.map((file: {name: string}) => file.name), ["first.txt", "second.svg"]);
    assert.equal(input.submissions.length, 2);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdicts: item.deliveries[0].verdicts }) } }] });
  });
  assert.equal((await ai.verify(item, item.deliveries[1])).verdicts[1].status, "needs_review");
});

test("completed legacy settlements remain retryable without new API calls", async () => {
  const item = deal(); item.status = "released";
  item.paypal.release_request = { amount: 65, close_remaining: true };
  item.paypal.captures = [{ id: "OLD1", amount: 65, at: item.created_at }];
  const client = createPayPalClient({ PAYPAL_CLIENT_ID: "test", PAYPAL_CLIENT_SECRET: "test" }, async () => { throw new Error("Must not contact PayPal"); });
  await releasePayment(item, async () => {}, 65, true, client);
  assert.equal(item.paypal.captures.length, 1);
});

test("DeepSeek retries malformed JSON once and validates the final result", async () => {
  let calls = 0;
  const ai = createAI({ DEEPSEEK_API_KEY: "test" }, async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    const request = JSON.parse(String(options?.body));
    assert.equal(request.model, "deepseek-flash");
    assert.equal(request.response_format.type, "json_object");
    calls++;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: calls === 1 ? " " : JSON.stringify(analysis) } }] });
  });
  assert.equal((await ai.analyze("Sample agreement", 120)).total_price, 120);
  assert.equal(calls, 2);
});

test("origin checks use the browser host and reject cross-site mutations", async () => {
  const send = (origin: string) => POST(new Request("http://localhost:3000/api/deals", {
    method: "POST", headers: { host: "127.0.0.1:3000", origin, "Content-Type": "application/json" }, body: "{}",
  }), { params: Promise.resolve({}) });
  assert.equal((await send("http://127.0.0.1:3000")).status, 400);
  assert.equal((await send("https://example.com")).status, 403);
});
