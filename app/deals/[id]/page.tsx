import { notFound } from "next/navigation";
import { store } from "../../../lib/store";
import { DealView } from "./view";

export const dynamic = "force-dynamic";
export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const deal = await store.get((await params).id);
  if (!deal) notFound();
  return <DealView initial={deal} clientId={process.env.PAYPAL_CLIENT_ID ?? ""} />;
}
