import type { Metadata } from "next";
import Link from "next/link";
import { AuthPanel } from "../src/components/AuthPanel";
import "./globals.css";

export const metadata: Metadata = {
  title: "GitCorps",
  description: "Fund autonomous OSS coding agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="bg-grid" aria-hidden="true" />
        <header className="site-header">
          <Link href="/" className="brand">
            GitCorps
          </Link>
          <nav>
            <Link href="/new">Create Project</Link>
          </nav>
          <AuthPanel />
        </header>
        <main className="page-shell">{children}</main>
      </body>
    </html>
  );
}
