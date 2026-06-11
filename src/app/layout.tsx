import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import PwaRegister from "./pwa-register";

export const metadata: Metadata = {
  title: "BASIS TRACKER",
  description: "basis.pro DRR検証用の個人記録ツール",
  applicationName: "BASIS TRACKER",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Basis" },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0e11",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <PwaRegister />
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
