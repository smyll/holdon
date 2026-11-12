import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "HoldOn | Agree what changes",
  description: "Compare new requests with agreed freelance scope, confirm additional quotes and review delivery with PayPal Sandbox.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
