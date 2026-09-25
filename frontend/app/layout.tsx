import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dengar — Subjective speech evaluation",
  description:
    "Dengar is an offline-first platform for rating speech quality through guided MOS and SUS listening sessions.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
