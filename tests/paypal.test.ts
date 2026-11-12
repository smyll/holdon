import assert from "node:assert/strict";
import { test } from "node:test";
import { createPayPalClient, SANDBOX_API, usd } from "../lib/paypal.ts";
import { finishSmoke } from "../scripts/paypal-smoke.ts";

const testEnv = { PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret" };
const authPath = "/v2/payments/authorizations/AUTH1";
const orderPath = "/v2/checkout/orders/ORDER1";
const discardTrace = async () => {};

function sandbox(mode: "void" | "final", captureStatus = "COMPLETED") {
  const calls: string[] = [];
  let authorized = false;
  let authorizationStatus = "CREATED";
  let payment: { id: string; status: string; amount: ReturnType<typeof usd>; final_capture: boolean } | undefined;

  const client = createPayPalClient(testEnv, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, SANDBOX_API);
    assert.equal(init?.redirect, "error");
    const call = `${init?.method} ${url.pathname}`;
    calls.push(call);

    switch (call) {
      case "POST /v1/oauth2/token":
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      case `GET ${orderPath}`:
      case `POST ${orderPath}/authorize`:
        authorized ||= init?.method === "POST";
        return Response.json({
          id: "ORDER1", status: authorized ? "COMPLETED" : "APPROVED", intent: "AUTHORIZE",
          purchase_units: [{
            amount: usd(12_000),
            custom_id: `holdon-smoke-${mode}-00000000-0000-0000-0000-000000000001`,
            payments: authorized ? { authorizations: [{ id: "AUTH1" }], captures: payment ? [payment] : [] } : undefined,
          }],
        });
      case `GET ${authPath}`:
        return Response.json({ id: "AUTH1", status: authorizationStatus, amount: usd(12_000) });
      case `POST ${authPath}/capture`:
        assert.deepEqual(JSON.parse(String(init?.body)), { amount: usd(8_000), final_capture: mode === "final" });
        assert.match(new Headers(init?.headers).get("PayPal-Request-Id") ?? "", /^[0-9a-f]{32}$/);
        payment = { id: "CAPTURE1", status: captureStatus, amount: usd(8_000), final_capture: mode === "final" };
        authorizationStatus = mode === "final" ? "CAPTURED" : "PARTIALLY_CAPTURED";
        return Response.json(payment);
      case `POST ${authPath}/void`:
        authorizationStatus = "VOIDED";
        return new Response(null, { status: 204 });
      default:
        assert.fail(`Unexpected API call: ${call}`);
    }
  });
  return { client, calls };
}

test("captures $80, voids the remainder, and resumes without charging again", async () => {
  const { client, calls } = sandbox("void");
  assert.equal((await finishSmoke(client, "ORDER1", discardTrace)).authorizationStatus, "VOIDED");
  assert.equal((await finishSmoke(client, "ORDER1", discardTrace)).authorizationStatus, "VOIDED");
  assert.deepEqual(calls.filter((call) => call.startsWith("POST ")), [
    "POST /v1/oauth2/token", `POST ${orderPath}/authorize`, `POST ${authPath}/capture`, `POST ${authPath}/void`,
  ]);
});

test("a final partial capture skips the separate void", async () => {
  const { client, calls } = sandbox("final");
  assert.equal((await finishSmoke(client, "ORDER1", discardTrace)).authorizationStatus, "CAPTURED");
  assert.ok(calls.includes(`POST ${authPath}/capture`));
  assert.ok(!calls.includes(`POST ${authPath}/void`));
});

test("a pending capture stops the check before voiding", async () => {
  const { client, calls } = sandbox("void", "PENDING");
  await assert.rejects(finishSmoke(client, "ORDER1", discardTrace), /completed \$80 capture/);
  assert.ok(!calls.includes(`POST ${authPath}/void`));
});

test("repeated requests for one capture share the same idempotency key", async () => {
  const keys: (string | null)[] = [];
  const client = createPayPalClient(testEnv, async (input, init) => {
    if (String(input).endsWith("/v1/oauth2/token")) {
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    }
    keys.push(new Headers(init?.headers).get("PayPal-Request-Id"));
    return Response.json({ id: "CAPTURE1", status: "COMPLETED", amount: usd(8_000) });
  });
  await client.captureAuthorization("AUTH1", 8_000, false, "ORDER1");
  await client.captureAuthorization("AUTH1", 8_000, false, "ORDER1");
  assert.match(keys[0] ?? "", /^[0-9a-f]{32}$/);
  assert.equal(keys[0], keys[1]);
});

test("requires credentials and rejects a production API base before connecting", () => {
  assert.throws(() => createPayPalClient({}), /Set PAYPAL_CLIENT_ID/);
  assert.throws(() => createPayPalClient({ ...testEnv, PAYPAL_API_BASE: "https://api-m.paypal.com" }), /Sandbox API/);
});
