"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 公開ページ(/drr)ではナビを出さない。認証付きページへのリンクを
// 見せない目的に加え、prefetch による 401 を発生させないため。
export default function SiteNav() {
  const pathname = usePathname();
  if (pathname.startsWith("/drr")) return null;
  return (
    <nav>
      <Link href="/">記録</Link>
      <Link href="/dashboard">ダッシュボード</Link>
      <Link href="/drr">DRR推移</Link>
    </nav>
  );
}
