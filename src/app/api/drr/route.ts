import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";

export async function GET() {
  const { rows } = await sql`
    SELECT
      date::text,
      asset,
      CASE WHEN total_staked > 0
        THEN (reward_crypto / total_staked * 100)::float8
      END AS drr
    FROM basis_staking_daily
    WHERE reward_crypto IS NOT NULL AND total_staked > 0
      AND date >= '2026-06-27'
    ORDER BY date, asset`;

  const map = new Map<string, Record<string, number | string>>();
  for (const row of rows) {
    if (!map.has(row.date)) map.set(row.date, { date: row.date });
    // DB の asset はステーキングトークン名(stBTC 等)。グラフの dataKey に合わせて st を剥がす。
    if (row.drr != null)
      map.get(row.date)![String(row.asset).replace(/^st/, "")] = Number(row.drr);
  }

  const data = Array.from(map.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  );
  return NextResponse.json({ data });
}
