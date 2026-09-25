import Link from "next/link";
import type { ReactNode } from "react";
import { DengarIcon } from "./Icons";

type PageShellProps = {
  children: ReactNode;
};

export default function PageShell({ children }: PageShellProps) {
  return (
    <div className="page-shell">
      <header className="page-shell__header">
        <div className="page-shell__header-inner">
          <Link href="/" className="wordmark">
            <DengarIcon className="wordmark__icon" />
            <span>Dengar</span>
          </Link>
          <nav className="nav" aria-label="Primary">
            <Link href="/#how">How it works</Link>
            <Link href="/#info">Practical info</Link>
            <Link href="/get-started">Get started</Link>
          </nav>
        </div>
      </header>

      <main>{children}</main>

      <footer className="page-shell__footer">
        <div className="page-shell__footer-inner">
          <p>Dengar — offline-first evaluation platform.</p>
          <p>No account. No tracking. Your ratings stay on this device.</p>
        </div>
      </footer>
    </div>
  );
}
