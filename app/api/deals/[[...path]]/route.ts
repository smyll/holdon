import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { store, dataDirectory } from "../../../../lib/store";
import { amountSchema } from "../../../../lib/types";
import { authorizePayment, closeAuthorization, createDeal, releasePayment, startPayment, submitDelivery, verifyDelivery } from "../../../../lib/deals";
import { reviseChecklist, confirmAgreement, recordReview, confirmSettlement } from "../../../../lib/review";
import { createPayPalClient } from "../../../../lib/paypal";
import { createAI } from "../../../../lib/ai";
import { addScopeChange, changeRequestSchema, confirmScopeChange, quoteScopeChange, requireConfirmedScope } from "../../../../lib/changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function limitedBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Request body is missing.");
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error("Request is too large."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function handle(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  try {
    const url = new URL(request.url);
    const host = new URL(`${url.protocol}//${request.headers.get("host") || url.host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) || host.username || host.password) return Response.json({ error: "This demo runs on localhost." }, { status: 403 });
    if (request.method !== "GET" && (request.headers.get("origin") !== host.origin || request.headers.get("sec-fetch-site") === "cross-site")) {
      return Response.json({ error: "Open HoldOn locally to perform this action." }, { status: 403 });
    }
    const path = (await context.params).path ?? [];
    const [id, section, action] = path;
    if (id) z.uuid().parse(id);
    if (request.method === "GET") {
      if (!id) return Response.json(await store.list());
      const deal = await store.get(id);
      if (!deal) return Response.json({ error: "Deal not found." }, { status: 404 });
      if (path.length === 1) return Response.json(deal);
      if (path.length === 3 && section === "files") {
        const file = deal.deliveries.flatMap(delivery => delivery.files).find(file => file.path === action);
        if (!file) return Response.json({ error: "File not found." }, { status: 404 });
        return new Response(await readFile(join(dataDirectory, "uploads", file.path)), {
          headers: { "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` },
        });
      }
      return Response.json({ error: "Route not found." }, { status: 404 });
    }
    if (request.method === "POST" && path.length === 2 && section === "deliveries") {
      const bytes = await limitedBody(request, 31 * 1024 * 1024);
      const form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
      return Response.json(await submitDelivery(id, form));
    }
    const body = JSON.parse((await limitedBody(request, 48 * 1024)).toString("utf8"));
    if (request.method === "POST" && !id) return Response.json(await createDeal(body), { status: 201 });
    if (request.method === "POST" && path.length === 2 && section === "changes") {
      const input = changeRequestSchema.parse(body);
      const original = await store.get(id);
      if (!original) throw new Error("Deal not found.");
      requireConfirmedScope(original, input.revision);
      const assessment = await createAI().compareScope(original, input.request);
      return Response.json(await store.update(id, async deal => addScopeChange(deal, input.request, input.revision, assessment)));
    }
    if (request.method === "POST" && path.length === 4 && section === "changes") {
      const revision = z.number().int().nonnegative().parse(body.revision);
      if (path[3] === "quote") return Response.json(await store.update(id, async deal => quoteScopeChange(deal, action, revision, body)));
      if (path[3] === "confirm") {
        const actor = z.enum(["Buyer", "Seller"]).parse(body.actor);
        return Response.json(await store.transaction(async deals => confirmScopeChange(deals, id, action, actor, revision)));
      }
    }
    if (request.method === "PATCH" && path.length === 2 && section === "checklist") return Response.json(await store.update(id, async deal => reviseChecklist(deal, body.checklist, z.number().int().nonnegative().parse(body.revision), body.scope_terms)));
    if (request.method === "POST" && path.length === 2 && section === "agreement") {
      const input = z.object({ actor: z.enum(["Buyer", "Seller"]), revision: z.number().int().nonnegative() }).parse(body);
      return Response.json(await store.update(id, async deal => confirmAgreement(deal, input.actor, input.revision)));
    }
    if (request.method === "POST" && path.length === 3 && section === "paypal") {
      if (action === "order") return Response.json(await startPayment(id, host.origin, z.number().int().nonnegative().parse(body.revision)));
      if (action === "authorize") return Response.json(await authorizePayment(id, z.string().regex(/^[a-zA-Z0-9]+$/).parse(body.order_id)));
    }
    if (request.method === "POST" && path.length === 2 && section === "release") {
      const input = z.object({ amount: amountSchema, close_remaining: z.boolean(), delivery_id: z.string().optional(), review_revision: z.number().int().nonnegative().optional() }).parse(body);
      return Response.json(await store.update(id, (deal, checkpoint) => releasePayment(deal, checkpoint, input.amount, input.close_remaining, createPayPalClient(), input.delivery_id, input.review_revision)));
    }
    if (request.method === "POST" && path.length === 2 && section === "void") {
      return Response.json(await store.update(id, async deal => {
        if (deal.paypal.release_request && !deal.paypal.captures.length) throw new Error("Reconcile the pending capture before closing this authorization.");
        await closeAuthorization(deal, createPayPalClient(), body.delivery_id, body.review_revision); return deal;
      }));
    }
    if (request.method === "POST" && path.length === 4 && section === "deliveries" && path[3] === "verify") {
      return Response.json(await store.update(id, async deal => {
        const delivery = deal.deliveries.at(-1);
        if (deal.status !== "delivered" || deal.paypal.release_request || delivery?.review || delivery?.id !== action) throw new Error("This delivery is locked.");
        if (delivery.verdicts) return deal;
        return verifyDelivery(deal, delivery);
      }));
    }
    if (request.method === "POST" && path.length === 4 && section === "deliveries" && path[3] === "review") {
      return Response.json(await store.update(id, async deal => recordReview(deal, action, z.number().int().nonnegative().parse(body.revision), body.decisions)));
    }
    if (request.method === "POST" && path.length === 4 && section === "deliveries" && path[3] === "settlement") {
      return Response.json(await store.update(id, async deal => confirmSettlement(deal, action, z.number().int().positive().parse(body.revision))));
    }
    return Response.json({ error: "Route not found." }, { status: 404 });
  } catch (error) {
    const message = error instanceof z.ZodError ? "Check the required fields, amounts and checklist IDs." : error instanceof SyntaxError ? "The request must contain valid JSON." : error instanceof Error ? error.message : "The request failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
export { handle as GET, handle as POST, handle as PATCH };
