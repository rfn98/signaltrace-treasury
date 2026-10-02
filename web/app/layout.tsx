import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import styles from "./app-shell.module.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SignalTrace Treasury",
  description:
    "An on-chain treasury whose payment policy is evaluated deterministically from chain state, with every verdict shown alongside the evidence it rests on.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        {/*
          A static shell. Navigation is plain links with no active-route detection, because that
          would need `useSelectedLayoutSegment`, a client hook, and this console has no client
          components at all. Highlighting the current page is not worth breaking that for.
        */}
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <Link className={styles.wordmark} href="/">
              <span className={styles.mark} aria-hidden="true" />
              SignalTrace
            </Link>
            <nav className={styles.nav} aria-label="Primary">
              <Link className={styles.navLink} href="/">
                Overview
              </Link>
              <Link className={styles.navLink} href="/payments">
                Payments
              </Link>
            </nav>
          </div>
        </header>

        <div className={styles.body}>{children}</div>

        {/*
          The project's authority model, stated once at the foot of every page rather than repeated
          per panel. It is a server component, so it costs nothing and cannot drift from the panels.
        */}
        <footer className={styles.footer}>
          <div className={styles.footerInner}>
            <p>
              The chain is the financial authority. The database is an index, never a source of
              truth. Policy is evaluated by a deterministic engine. Model commentary is advisory and
              can approve, reject or execute nothing.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}