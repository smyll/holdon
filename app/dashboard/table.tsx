"use client";
import Link from "next/link";
import { AllCommunityModule, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import type { Deal } from "../../lib/types";

const modules = [AllCommunityModule];
const theme = themeQuartz.withParams({ accentColor: "#155438", fontFamily: "system-ui, sans-serif", headerBackgroundColor: "#e4efe6" });
type Row = { id: string; title: string; status: string; risk: string; total: number; held: number; released: number; closed: number; flags: number; created: string };
const formatMoney = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const badge = ({ value }: ICellRendererParams<Row, string>) => <span className={value === "refused" || value === "do_not_pay" ? "error" : "success"}>{value?.replaceAll("_", " ")}</span>;
const columns: ColDef<Row>[] = [
  { field: "title", minWidth: 260, cellRenderer: ({ data }: ICellRendererParams<Row>) => data && <Link href={`/deals/${data.id}`}>{data.title}</Link> },
  { field: "status", cellRenderer: badge }, { field: "risk", cellRenderer: badge },
  ...(["total", "held", "released", "closed"] as const).map(field => ({ field, valueFormatter: ({ value }: { value: number }) => formatMoney(value), filter: "agNumberColumnFilter" })),
  { field: "flags", headerName: "Red flags", filter: "agNumberColumnFilter" }, { field: "created", minWidth: 180 },
];
export function DealGrid({ deals }: { deals: Deal[] }) {
  const rows: Row[] = deals.map(deal => {
    const released = deal.paypal.captures.reduce((sum, capture) => sum + capture.amount, 0);
    return { id: deal.id, title: deal.title, status: deal.status, risk: deal.analysis.risk, total: deal.analysis.total_price,
      held: deal.paypal.authorization_id && !["released", "voided"].includes(deal.status) ? deal.analysis.total_price - released : 0,
      released, closed: deal.paypal.voided_at ? deal.analysis.total_price - released : 0, flags: deal.analysis.red_flags.length,
      created: new Date(deal.created_at).toLocaleString() };
  });
  return <><section className="panel money-row">
    <div><span>Deals</span><strong>{rows.length}</strong></div>
    <div><span>Held now</span><strong>{formatMoney(rows.reduce((sum, row) => sum + row.held, 0))}</strong></div>
    <div><span>Captured</span><strong>{formatMoney(rows.reduce((sum, row) => sum + row.released, 0))}</strong></div>
    <div><span>Payments blocked</span><strong>{rows.filter(row => row.status === "refused").length}</strong></div>
  </section><section className="panel" aria-label="Deals table"><div style={{ height: 430 }}><AgGridProvider modules={modules}><AgGridReact theme={theme} rowData={rows} columnDefs={columns} defaultColDef={{ sortable: true, filter: true, resizable: true, minWidth: 120 }} getRowId={({ data }) => data.id} /></AgGridProvider></div></section></>;
}
