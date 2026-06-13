import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";

// Vercel Cron (毎日 00:05 UTC) から呼ばれ、BTC価格を記録する。
// 手動アクセスでも即時更新できる(CRON_SECRET 設定時は Bearer 必須)。
export async function GET(req: NextRequest) {
  // 任意: CRON_SECRET を設定していれば Vercel Cron の Bearer を検証(未設定なら誰でも実行可)。
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

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
