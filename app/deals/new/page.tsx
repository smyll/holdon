"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { samples } from "../../../lib/samples";
import { api } from "../../components/api";

export default function NewDeal() {
  const router = useRouter();
  const [form, setForm] = useState({ title: "", chat: "", price: 120 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function analyze(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { const deal = await api<{ id: string }>("/api/deals", form); router.push(`/deals/${deal.id}`); }
    catch (error) { setError(error instanceof Error ? error.message : "Analysis failed."); setBusy(false); }
  }
  return <main className="workspace app-page">
    <Link href="/">← HoldOn</Link><p className="eyebrow">Before payment</p><h1>Make the agreement clear.</h1>
    <p className="lede">Paste the conversation. Review the risks and agree on what counts as delivered.</p>
    <div className="sample-picker"><span>Try a sample</span>{samples.map(sample => <button key={sample.title} type="button" className="secondary" disabled={busy} onClick={() => setForm(sample)}>{sample.title.replace("Sample · ", "")}</button>)}</div>
    <form className="panel form-stack" onSubmit={analyze}>
      <label>Deal title<input required maxLength={120} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label>Total in USD<input type="number" required min="0.01" max="100000" step="0.01" value={form.price} onChange={event => setForm({ ...form, price: Number(event.target.value) })} /></label>
      <label>Conversation<textarea required minLength={10} maxLength={20000} rows={10} value={form.chat} onChange={event => setForm({ ...form, chat: event.target.value })} /></label>
      <p className="muted">The conversation is sent to DeepSeek for analysis. Review its checklist before authorizing payment.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <button disabled={busy}>{busy ? "Analyzing the agreement…" : "Analyze deal"}</button>
    </form>
  </main>;
}
