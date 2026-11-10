import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { DEFAULT_ACCOUNT, displayStitch } from "@/lib/accounts";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 120), 366);
  // daily_rewards / snapshots は primary だけが書くので、切り替え日の前後で書いたアカウントが変わる。
  // - DRR の分母は、その日のリワードを書いたのと同じアカウントの snapshot(時刻が最も近いもの)にする。
  //   account を持たない古い snapshot(OCR 期・複数アカウント対応前)は april のもの。
  // - 切り替え前の DRR は旧 primary(april)の値 × 係数で masa とつなぐ(src/lib/accounts.ts)。
  //   profit_usd / total_staked_usd は実額のまま返す。
  const st = displayStitch();
  const { rows } = await sql`
    select
      d.date::text as date,
      d.profit_usd::float8 as profit_usd,
      m.btc_price_usd::float8 as btc_price_usd,
      m.funding_avg_pct::float8 as funding_avg_pct,
      s.total_staked_usd::float8 as total_staked_usd,
      case when s.total_staked_usd > 0
        then (d.profit_usd / s.total_staked_usd * 100
          * case when d.date < ${st.rewardDateFrom}::date then ${st.legacyDrrScale}::float8 else 1 end
        )::float8 end as drr_pct
    from daily_rewards d
    left join market_daily m on m.date = d.date
    left join lateral (
      select total_staked_usd from snapshots
      where coalesce(raw_json->>'account', ${DEFAULT_ACCOUNT}) =
        case when d.date < ${st.rewardDateFrom}::date then ${st.legacyAccount} else ${st.primary} end
      order by abs(extract(epoch from (taken_at - d.date::timestamptz))) asc
      limit 1
    ) s on true
    order by d.date desc
    limit ${limit}`;
  return NextResponse.json({ entries: rows });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const rows: { date: string; profit_usd: number }[] = body.rows || [];

  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !(r.profit_usd > 0)) continue;
    await sql`
      insert into daily_rewards (date, profit_usd)
      values (${r.date}, ${r.profit_usd})
      on conflict (date) do update
        set profit_usd = excluded.profit_usd, updated_at = now()`;
  }

  const s = body.snapshot || {};
  if (s.total_staked_usd != null || s.total_rewards_usd != null) {
    await sql`
      insert into snapshots
        (total_staked_usd, total_rewards_usd, total_rewards_pct, staking_wallet_usd, blob_url, raw_json)
      values
        (${s.total_staked_usd}, ${s.total_rewards_usd}, ${s.total_rewards_pct},
         ${s.staking_wallet_usd}, ${body.blob_url || null}, ${JSON.stringify(body.raw || {})})`;
  }
  return NextResponse.json({ ok: true, saved: rows.length });
}
