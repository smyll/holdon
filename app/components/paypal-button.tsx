"use client";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Buttons = { render(element: HTMLElement): Promise<void>; close(): Promise<void> };
declare global { interface Window { paypal?: { Buttons(options: Record<string, unknown>): Buttons } } }

export function PayPalButton({ dealId, revision, clientId, onApproved }: { dealId: string; revision: number; clientId: string; onApproved: () => Promise<void> }) {
  const target = useRef<HTMLDivElement>(null);
  const onComplete = useRef(onApproved);
  onComplete.current = onApproved;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!ready || !target.current || !window.paypal) return;
    const buttons = window.paypal.Buttons({
      style: { layout: "vertical", label: "paypal", height: 45 },
      createOrder: async () => {
        setError("");
        const result = await api<{ order_id: string }>(`/api/deals/${dealId}/paypal/order`, { revision });
        await onComplete.current();
        return result.order_id;
      },
      onApprove: async (data: { orderID: string }) => {
        await api(`/api/deals/${dealId}/paypal/authorize`, { order_id: data.orderID });
        await onComplete.current();
      },
      onCancel: () => setError("Checkout was cancelled. You can retry this order."),
      onError: (error: unknown) => setError(error instanceof Error ? error.message : "PayPal checkout could not finish. Retry or use the approval link."),
    });
    buttons.render(target.current).catch(() => setError("PayPal buttons could not load. Use the approval link."));
    return () => { void buttons.close().catch(() => {}); };
  }, [ready, dealId, revision]);
  if (!clientId) return <p>Set the Sandbox app credentials to enable PayPal.</p>;
  return <div className="paypal-buttons">
    <Script src={`https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=authorize&components=buttons`} onReady={() => setReady(true)} onError={() => setError("PayPal buttons could not load. Use the approval link.")} />
    <div ref={target} />
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
