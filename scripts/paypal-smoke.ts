import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPayPalClient, sandboxApprovalUrl, usd, type PayPalClient } from "../lib/paypal.ts";

const authorized = 12_000;
const captured = 8_000;
type Mode = "void" | "final";
type Trace = (stage: string, values: Record<string, string>) => Promise<void>;

export async function finishSmoke(client: PayPalClient, orderId: string, trace: Trace) {
  const order = await client.getOrder(orderId);
  const unit = order.purchase_units?.[0];
  const mode = /^holdon-smoke-(void|final)-[0-9a-f-]{36}$/.exec(unit?.custom_id ?? "")?.[1];
  if (order.id !== orderId || order.intent !== "AUTHORIZE" || order.purchase_units?.length !== 1
      || unit?.amount?.value !== usd(authorized).value || !mode) {
    throw new Error("Choose a $120 order created by this Sandbox check.");
  }
  if (order.status !== "APPROVED" && order.status !== "COMPLETED") {
    throw new Error(`Order status is ${order.status}. Approve it as the Sandbox Personal buyer and retry.`);
  }
  const approved = order.status === "APPROVED" ? await client.authorizeOrder(orderId) : order;
  const authId = approved.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
  if (!authId) throw new Error("PayPal did not return an authorization ID.");
  const auth = await client.getAuthorization(authId);
  if (auth.id !== authId || auth.amount.value !== usd(authorized).value) {
    throw new Error("The authorized amount or ID did not match the Sandbox order.");
  }
  await trace("authorization_checked", { orderId, authorizationId: authId, status: auth.status, amount: auth.amount.value });

  const saved = order.purchase_units?.[0]?.payments?.captures ?? [];
  if (saved.length > 1 || (!saved.length && auth.status !== "CREATED")) {
    throw new Error("PayPal already advanced this authorization. Check its capture record before retrying.");
  }
  const payment = saved[0] ?? await client.captureAuthorization(authId, captured, mode === "final", orderId);
  await trace("capture_checked", { orderId, authorizationId: authId, captureId: payment.id, status: payment.status, amount: payment.amount.value });
  if (payment.status !== "COMPLETED" || payment.amount.value !== usd(captured).value
      || (payment.final_capture !== undefined && payment.final_capture !== (mode === "final"))) {
    throw new Error("PayPal did not confirm the expected completed $80 capture.");
  }

  if (mode === "void" && auth.status !== "VOIDED") {
    await client.voidAuthorization(authId);
    await trace("void_accepted", { orderId, authorizationId: authId });
  }
  const after = await client.getAuthorization(authId);
  await trace("final_authorization_checked", { orderId, authorizationId: authId, status: after.status });
  if (after.id !== authId || (mode === "void" && after.status !== "VOIDED")
      || (mode === "final" && payment.final_capture !== true && !["CAPTURED", "VOIDED"].includes(after.status))) {
    throw new Error("PayPal has not confirmed that the remainder is closed.");
  }
  return { captureId: payment.id, authorizationStatus: after.status, mode };
}

async function log(stage: string, values: Record<string, string>) {
  await appendFile("data/paypal-smoke.jsonl", JSON.stringify({ at: new Date().toISOString(), stage, ...values }) + "\n");
  console.log(stage, JSON.stringify(values));
}

async function createSmoke(client: PayPalClient, mode: Mode) {
  const base = new URL(process.env.APP_BASE_URL || "http://localhost:3000");
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(base.hostname)
      || base.username || base.password) {
    throw new Error("Use a loopback APP_BASE_URL for the local Sandbox check.");
  }
  const result = await client.createAuthorizeOrder(
    authorized, `holdon-smoke-${mode}-${randomUUID()}`,
    new URL("/?checkout=approved", base).href, new URL("/?checkout=cancelled", base).href,
  );
  await log("order_created", { orderId: result.id, status: result.status, mode });
  console.log("Open this link as the PayPal Sandbox Personal buyer and approve the authorization:");
  console.log(sandboxApprovalUrl(result));
  console.log(`After approval, run: npm run paypal:smoke -- finish ${result.id}`);
}

async function main() {
  const [command, arg, extra] = process.argv.slice(2);
  if (extra || !(command === "create" && (!arg || arg === "void" || arg === "final")
      || command === "finish" && /^[A-Za-z0-9]+$/.test(arg ?? ""))) {
    throw new Error("Usage: npm run paypal:smoke -- create [void|final] or finish ORDER_ID");
  }
  const client = createPayPalClient();
  await mkdir("data", { recursive: true });
  if (command === "create") {
    await createSmoke(client, (arg ?? "void") as Mode);
  } else {
    const result = await finishSmoke(client, arg, log);
    console.log("Sandbox check passed.", JSON.stringify(result));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Sandbox check failed.");
    process.exitCode = 1;
  });
}
