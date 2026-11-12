import Link from "next/link";
import { store } from "../../lib/store";
import { DealGrid } from "./table";

export const dynamic = "force-dynamic";
export default async function Dashboard() {
  const deals = await store.list();
  return <main className="workspace app-page"><nav><Link href="/">← HoldOn</Link><Link href="/deals/new">Start a deal</Link></nav><p className="eyebrow">Sandbox overview</p><h1>Follow every payment.</h1><p className="lede">Review risks, remaining authorizations and completed captures.</p><DealGrid deals={deals} /></main>;
}
