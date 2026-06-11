import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 120), 366);
  const { rows } = await sql`
    select
      d.date::text as date,
      d.profit_usd::float8 as profit_usd,
      m.btc_price_usd::float8 as btc_price_usd,
      m.funding_avg_pct::float8 as funding_avg_pct,
      s.total_staked_usd::float8 as total_staked_usd,
      case when s.total_staked_usd > 0
        then (d.profit_usd / s.total_staked_usd * 100)::float8 end as drr_pct
    from daily_rewards d
    left join market_daily m on m.date = d.date
    left join lateral (
      select total_staked_usd from snapshots
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
