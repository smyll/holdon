import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createAI } from "./ai.ts";
import { store, dataDirectory } from "./store.ts";
import { cents, newDealSchema, type Deal, type Delivery, type DeliveryFile } from "./types.ts";
import { agreedSettlement } from "./review.ts";
import { createPayPalClient, sandboxApprovalUrl, usd, type PayPalClient, type PayPalOrder } from "./paypal.ts";

export function event(deal: Deal, actor: Deal["events"][number]["actor"], text: string, ref?: string) {
  deal.events.push({ at: new Date().toISOString(), actor, text, ...(ref ? { ref } : {}) });
}
export async function createDeal(input: unknown) {
  const { title, chat, price } = newDealSchema.parse(input);
  const analysis = await createAI().analyze(chat, price);
  const deal: Deal = { id: randomUUID(), title, chat, created_at: new Date().toISOString(), analysis,
    status: analysis.risk === "do_not_pay" ? "refused" : "analyzed", agreement: { revision: 1, confirmed_by: {} }, paypal: { captures: [] }, deliveries: [], events: [] };
  event(deal, "AI", analysis.recommendation);
  return store.add(deal);
}
function checkOrder(deal: Deal, order: PayPalOrder) {
  const unit = order.purchase_units?.[0];
  if (order.id !== deal.paypal.order_id || order.intent !== "AUTHORIZE" || order.purchase_units?.length !== 1
      || unit?.custom_id !== deal.id || unit.amount?.value !== usd(cents(deal.analysis.total_price)).value) {
    throw new Error("PayPal order details do not match this deal.");
  }
}

export function startPayment(id: string, origin: string, revision: number) {
  return store.update(id, async (deal, checkpoint) => {
    if (!["analyzed", "awaiting_payment"].includes(deal.status) || deal.analysis.risk === "do_not_pay") throw new Error("This deal cannot start a payment.");
    if (deal.status === "analyzed" && (!deal.agreement?.confirmed_by.Buyer || !deal.agreement.confirmed_by.Seller)) throw new Error("Both sides must confirm this checklist before checkout.");
    if (deal.status === "analyzed" && deal.agreement?.revision !== revision) throw new Error("Refresh and review the current checklist before checkout.");
    const client = createPayPalClient();
    if (deal.paypal.order_id) {
      const existing = await client.getOrder(deal.paypal.order_id);
      checkOrder(deal, existing);
      return { order_id: existing.id, approval_url: existing.status === "APPROVED" ? null : sandboxApprovalUrl(existing) };
    }
    if (deal.paypal.order_requested_at && Date.now() - Date.parse(deal.paypal.order_requested_at) > 10 * 60_000) {
      throw new Error("The earlier order request needs reconciliation in PayPal before retrying.");
    }
    deal.status = "awaiting_payment";
    deal.paypal.order_requested_at ??= new Date().toISOString();
    await checkpoint();
    const order = await client.createAuthorizeOrder(cents(deal.analysis.total_price), deal.id,
      `${origin}/deals/${id}?paypal=approved`, `${origin}/deals/${id}?paypal=cancelled`);
    deal.paypal.order_id = order.id;
    checkOrder(deal, order);
    event(deal, "PayPal", "Sandbox order created.", order.id);
    return { order_id: order.id, approval_url: sandboxApprovalUrl(order) };
  });
}

export function authorizePayment(id: string, orderId: string) {
  return store.update(id, async deal => {
    if (orderId !== deal.paypal.order_id) throw new Error("This order belongs to a different deal.");
    if (deal.paypal.authorization_id) return deal;
    if (deal.status !== "awaiting_payment") throw new Error("This deal is not awaiting payment.");
    const client = createPayPalClient();
    let order = await client.getOrder(orderId);
    checkOrder(deal, order);
    if (order.status === "APPROVED") order = await client.authorizeOrder(orderId);
    checkOrder(deal, order);
    const authorizations = order.purchase_units?.[0]?.payments?.authorizations;
    if (order.status !== "COMPLETED" || authorizations?.length !== 1) throw new Error("PayPal has not confirmed buyer approval and authorization.");
    const authorization = await client.getAuthorization(authorizations[0].id);
    if (authorization.status !== "CREATED" || authorization.amount.value !== usd(cents(deal.analysis.total_price)).value) throw new Error("PayPal authorization is not ready for this deal.");
    deal.paypal.authorization_id = authorization.id;
    deal.status = "held";
    event(deal, "PayPal", "Payment authorized.", authorization.id);
    return deal;
  });
}

export async function closeAuthorization(deal: Deal, client: PayPalClient, deliveryId?: string, revision?: number) {
  const id = deal.paypal.authorization_id;
  if (!id) throw new Error("This deal has no authorization.");
  if (deal.paypal.voided_at || deal.status === "released" || deal.status === "voided") return;
  if (!deal.paypal.captures.length && agreedSettlement(deal, deliveryId, revision).amount !== 0) throw new Error("Pay the agreed settlement before closing the remaining authorization.");
  const auth = await client.getAuthorization(id);
  if (auth.status !== "VOIDED") await client.voidAuthorization(id);
  if ((await client.getAuthorization(id)).status !== "VOIDED") throw new Error("PayPal has not confirmed that the remaining authorization is closed. Retry closing it.");
  deal.paypal.voided_at = new Date().toISOString();
  deal.status = deal.paypal.captures.length ? "released" : "voided";
  event(deal, "PayPal", "Remaining authorization closed.", id);
}

export async function releasePayment(deal: Deal, checkpoint: () => Promise<void>, amount: number, closeRemaining: boolean, client: PayPalClient, deliveryId?: string, revision?: number) {
  const pending = deal.paypal.release_request;
  if (pending && (pending.amount !== amount || pending.close_remaining !== closeRemaining)) throw new Error("Finish the existing release request before changing it.");
  if (pending && deliveryId !== undefined && (pending.delivery_id !== deliveryId || pending.review_revision !== revision)) throw new Error("This request refers to a different acceptance proposal.");
  const authId = deal.paypal.authorization_id;
  if (!authId || !deal.paypal.order_id) throw new Error("Payment must be authorized first.");
  if (!pending) {
    const delivery = deal.deliveries.at(-1);
    if (deal.status !== "delivered" || !delivery || deal.paypal.captures.length) throw new Error("A reviewed delivery is required for this release.");
    const review = agreedSettlement(deal, deliveryId, revision);
    if (amount <= 0 || cents(amount) !== cents(review.amount) || cents(amount) > cents(deal.analysis.total_price)) throw new Error("Confirm the exact amount accepted by both sides.");
    deal.paypal.release_request = { amount, close_remaining: closeRemaining, delivery_id: deliveryId, review_revision: revision };
    await checkpoint();
  }
  if (!deal.paypal.captures.length) {
    const order = await client.getOrder(deal.paypal.order_id);
    checkOrder(deal, order);
    const existing = order.purchase_units?.[0]?.payments?.captures ?? [];
    if (existing.length > 1) throw new Error("Unexpected multiple captures. Review this order in PayPal.");
    const auth = await client.getAuthorization(authId);
    if (!existing.length && auth.status !== "CREATED") throw new Error("PayPal advanced this payment without a matching capture record. Review it before retrying.");
    const final = cents(amount) === cents(deal.analysis.total_price);
    const capture = existing[0] ?? await client.captureAuthorization(authId, cents(amount), final, `${deal.id}-release`);
    if (capture.amount.value !== usd(cents(amount)).value || capture.status !== "COMPLETED") throw new Error("PayPal has not confirmed the expected capture. Retry to check its state.");
    deal.paypal.captures.push({ id: capture.id, amount, at: new Date().toISOString() });
    deal.status = final ? "released" : "partially_released";
    event(deal, "PayPal", `$${amount.toFixed(2)} captured.`, capture.id);
    await checkpoint();
  }
  if (closeRemaining && deal.status === "partially_released") {
    await closeAuthorization(deal, client);
    await checkpoint();
  }
  return deal;
}

export async function verifyDelivery(deal: Deal, delivery: Delivery) {
  try {
    Object.assign(delivery, await createAI().verify(deal, delivery));
    delivery.verification_error = undefined;
    event(deal, "AI", `Evidence reviewed. Suggested items total $${delivery.proposed_release!.toFixed(2)} before human acceptance.`, delivery.id);
  } catch (error) {
    delivery.verdicts = undefined;
    delivery.proposed_release = undefined;
    delivery.verification_error = error instanceof Error ? error.message : "Verification failed. Retry this delivery.";
  }
  return deal;
}

export async function submitDelivery(id: string, form: FormData) {
  const note = form.get("note");
  const files = form.getAll("files");
  if (typeof note !== "string" || note.length > 5000 || files.length > 6 || files.some(file => !(file instanceof File) || file.size > 5 * 1024 * 1024 || file.size === 0)) {
    throw new Error("Add a note up to 5,000 characters and at most six nonempty files, up to 5 MB each.");
  }
  if (!note.trim() && !files.length) throw new Error("Add delivery evidence first.");
  const prepared: (DeliveryFile & { bytes: Buffer })[] = [];
  for (const file of files as File[]) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const extension = extname(file.name).toLowerCase();
    if (!/\.(png|jpg|jpeg|webp|svg|pdf|txt|zip)$/.test(extension)) throw new Error("Supported files are PNG, JPEG, WebP, SVG, PDF, TXT and ZIP.");
    let mime = "application/octet-stream";
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
      if (extension === ".png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = "image/png";
      if ([".jpg", ".jpeg"].includes(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = "image/jpeg";
      if (extension === ".webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") mime = "image/webp";
      if (mime === "application/octet-stream") throw new Error("An image does not match its file format.");
    }
    prepared.push({ bytes, name: file.name.replace(/[\\/\x00-\x1f]/g, "_").slice(0, 160), mime, path: `${randomUUID()}${extension}`, size: bytes.length });
  }
  return store.update(id, async (deal, checkpoint) => {
    if (!["held", "delivered"].includes(deal.status) || deal.paypal.release_request) throw new Error("Delivery is available after authorization and before release.");
    if (deal.deliveries.reduce((count, delivery) => count + delivery.files.length, 0) + prepared.length > 6) throw new Error("This demo supports up to six evidence files across a deal's submissions.");
    await mkdir(join(dataDirectory, "uploads"), { recursive: true });
    for (const file of prepared) await writeFile(join(dataDirectory, "uploads", file.path), file.bytes, { flag: "wx" });
    const delivery: Delivery = { id: randomUUID(), at: new Date().toISOString(), note, files: prepared.map(({ bytes, ...file }) => file) };
    deal.deliveries.push(delivery);
    deal.status = "delivered";
    event(deal, "Seller", "Delivery evidence submitted.", delivery.id);
    await checkpoint();
    return verifyDelivery(deal, delivery);
  });
}
