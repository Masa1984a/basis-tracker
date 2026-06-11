import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";

// Vercel Cron (毎日 00:05 UTC) から呼ばれ、BTC価格を記録する。
// 手動アクセスでも即時更新できる。
export async function GET() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    { cache: "no-store" }
  );
  if (!res.ok) {
    return NextResponse.json({ error: "CoinGecko取得に失敗" }, { status: 502 });
  }
  const j = await res.json();
  const price = j?.bitcoin?.usd ?? null;

  // TODO: ファンディングレート(Coinglass等)はAPIキー取得後に
  // funding_avg_pct への書き込みを追加する
  const today = new Date().toISOString().slice(0, 10);
  await sql`
    insert into market_daily (date, btc_price_usd)
    values (${today}, ${price})
    on conflict (date) do update
      set btc_price_usd = excluded.btc_price_usd, fetched_at = now()`;

  return NextResponse.json({ date: today, btc_price_usd: price });
}
