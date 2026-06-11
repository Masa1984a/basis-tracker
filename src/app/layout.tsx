import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "BASIS TRACKER",
  description: "basis.pro DRR検証用の個人記録ツール",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="site">
          <span className="brand">BASIS TRACKER</span>
          <nav>
            <Link href="/">記録</Link>
            <Link href="/dashboard">ダッシュボード</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
