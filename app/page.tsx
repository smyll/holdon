import Link from "next/link";
import { store } from "../lib/store";

export const dynamic = "force-dynamic";

const steps = [
  { title: "Agree the scope", amount: "Original work", detail: "Confirm the deliverables, revision allowance and price together." },
  { title: "Review a change", amount: "Included or extra?", detail: "Compare the new request with the agreed terms, with quotations you can check." },
  { title: "Confirm the quote", amount: "Your decision", detail: "Accept additional work as a separate order, then review delivery before payment." },
];

export default async function Home({ searchParams }: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;
  const deals = await store.list();

  return (
    <main className="workspace">
      <header className="topbar">
        <span className="brand"><span className="brand-mark" aria-hidden="true">H</span>HoldOn</span>
        <Link href="/dashboard" className="environment">Sandbox dashboard</Link>
      </header>

      <section className="intro" aria-labelledby="title">
        <p className="eyebrow">Clear scope for freelance work</p>
        <h1 id="title">Know what's included. Agree what changes.</h1>
        <p>When a client asks for “one more thing,” compare it with the original agreement. Clarify what is already covered, agree a price for extra work, and pay through PayPal after reviewing delivery.</p>
        <p style={{ marginTop: "1.5rem" }}><Link className="button-link" href="/deals/new">Start a deal</Link></p>
      </section>

      {checkout === "approved" && (
        <p className="notice" role="status">Returned from PayPal. Run the finish command shown in your terminal to verify approval and complete the check.</p>
      )}
      {checkout === "cancelled" && (
        <p className="notice" role="status">Checkout was cancelled. Open the Sandbox approval link again to retry.</p>
      )}

      <ol className="steps" aria-label="How HoldOn works">
        {steps.map(({ title, amount, detail }, index) => (
          <li key={title}>
            <span className="step-number">0{index + 1}</span>
            <h2>{title}</h2>
            <strong>{amount}</strong>
            <p>{detail}</p>
          </li>
        ))}
      </ol>

      <section className="panel" aria-labelledby="deals-title"><h2 id="deals-title">Your deals</h2>
        {deals.length ? <div className="table-scroll"><table><thead><tr><th>Deal</th><th>Status</th><th>Total</th></tr></thead><tbody>{deals.map(deal => <tr key={deal.id}><td><Link href={`/deals/${deal.id}`}>{deal.title}</Link></td><td>{deal.status.replaceAll("_", " ")}</td><td>${deal.analysis.total_price.toFixed(2)}</td></tr>)}</tbody></table></div> : <p>Start with a sample agreement, confirm its scope, and compare a new client request.</p>}
      </section>
      <footer>Local Sandbox demo. AI advises on scope and evidence. People agree the terms and authorize each payment.</footer>
    </main>
  );
}
