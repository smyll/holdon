import { createHash } from "node:crypto";
import { z } from "zod";

export const SANDBOX_API = "https://api-m.sandbox.paypal.com";
const id = z.string().regex(/^[A-Za-z0-9]+$/);
const money = z.object({ currency_code: z.literal("USD"), value: z.string() });
const authorization = z.object({ id, status: z.string(), amount: money });
const capture = z.object({
  id,
  status: z.string(),
  amount: money,
  final_capture: z.boolean().optional(),
});
const order = z.object({
  id,
  status: z.string(),
  intent: z.string().optional(),
  links: z.array(z.object({ href: z.string(), rel: z.string() })).optional(),
  purchase_units: z.array(z.object({
    custom_id: z.string().optional(),
    amount: money.optional(),
    payments: z.object({
      authorizations: z.array(z.object({ id })).optional(),
      captures: z.array(capture).optional(),
    }).optional(),
  })).optional(),
});
const token = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
const failure = z.object({
  name: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z.array(z.object({ issue: z.string().optional() })).optional(),
});

export type PayPalOrder = z.infer<typeof order>;
export type PayPalClient = ReturnType<typeof createPayPalClient>;

export function usd(cents: number) {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 10_000_000) {
    throw new Error("Amount must be between $0.01 and $100,000.00.");
  }
  return { currency_code: "USD", value: (cents / 100).toFixed(2) } as const;
}

export function sandboxApprovalUrl(value: PayPalOrder) {
  const link = value.links?.find(({ rel }) => rel === "payer-action" || rel === "approve");
  if (!link) throw new Error("PayPal did not return a buyer approval link.");
  const url = new URL(link.href);
  if (url.origin !== "https://www.sandbox.paypal.com" || url.username || url.password) {
    throw new Error("PayPal returned an unexpected Sandbox approval URL.");
  }
  return url.href;
}

export function createPayPalClient(env: Record<string, string | undefined> = process.env, send: typeof fetch = fetch) {
  if ((env.PAYPAL_API_BASE || SANDBOX_API).replace(/\/$/, "") !== SANDBOX_API) {
    throw new Error("HoldOn requires the PayPal Sandbox API.");
  }
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const secret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !secret) {
    throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local.");
  }
  let cached: { accessToken: string; expiresAt: number } | undefined;

  async function request(path: string, init: RequestInit) {
    const response = await send(SANDBOX_API + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const json: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const details = failure.safeParse(json);
      const diagnostic = details.success ? details.data : {};
      // The response may contain buyer information. Keep only PayPal diagnostic codes.
      const codes = [diagnostic.name || diagnostic.error, diagnostic.debug_id,
        ...((diagnostic.details ?? []).map((detail) => detail.issue))];
      const safeCodes = codes.filter((code) => code && /^[a-z0-9_\-]{1,80}$/i.test(code));
      throw new Error(`PayPal Sandbox ${response.status}${safeCodes.length ? ` (${safeCodes.join(", ")})` : ""}.`);
    }
    return json;
  }

  async function getToken() {
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken;
    const result = token.parse(await request("/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }));
    cached = { accessToken: result.access_token, expiresAt: Date.now() + (result.expires_in - 60) * 1000 };
    return cached.accessToken;
  }

  async function api(path: string, method: "GET" | "POST", key?: string, body?: unknown) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (key) {
      headers["PayPal-Request-Id"] = createHash("sha256").update(`${path}:${key}`).digest("hex").slice(0, 32);
    }
    return request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  return {
    async createAuthorizeOrder(cents: number, reference: string, returnUrl: string, cancelUrl: string) {
      return order.parse(await api("/v2/checkout/orders", "POST", reference, {
        intent: "AUTHORIZE",
        purchase_units: [{ custom_id: reference, amount: usd(cents) }],
        payment_source: { paypal: { experience_context: {
          shipping_preference: "NO_SHIPPING",
          user_action: "CONTINUE",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        } } },
      }));
    },
    async getOrder(orderId: string) {
      return order.parse(await api(`/v2/checkout/orders/${id.parse(orderId)}`, "GET"));
    },
    async authorizeOrder(orderId: string) {
      return order.parse(await api(`/v2/checkout/orders/${id.parse(orderId)}/authorize`, "POST", orderId, {}));
    },
    async getAuthorization(authId: string) {
      return authorization.parse(await api(`/v2/payments/authorizations/${id.parse(authId)}`, "GET"));
    },
    async captureAuthorization(authId: string, cents: number, final: boolean, captureKey: string) {
      return capture.parse(await api(`/v2/payments/authorizations/${id.parse(authId)}/capture`, "POST", captureKey, {
        amount: usd(cents),
        final_capture: final,
      }));
    },
    async voidAuthorization(authId: string) {
      await api(`/v2/payments/authorizations/${id.parse(authId)}/void`, "POST", authId);
    },
  };
}
