import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { displayStitch } from "@/lib/accounts";

export const runtime = "nodejs";

// Even G2(Even Hub WebView)など別オリジンのクライアントから直接読めるようにする。
// このAPIは middleware で認証除外済みの公開データなので Cookie も不要。
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  // グラフは出力対象(primary)アカウントのみ。並行収集中の他アカウントは混ぜない。
  // 切り替え後は、切り替え前の期間を旧 primary(april)の DRR × 係数でつなぐ(src/lib/accounts.ts)。
  const s = displayStitch();
  const { rows } = await sql`
    SELECT
      date::text,
      asset,
      (reward_crypto / total_staked * 100
        * CASE WHEN date < ${s.runDateFrom}::date THEN ${s.legacyDrrScale}::float8 ELSE 1 END
      )::float8 AS drr
    FROM basis_staking_daily
    WHERE reward_crypto IS NOT NULL AND total_staked > 0
      AND date >= '2026-06-27'
      AND (
        (account = ${s.primary} AND date >= ${s.runDateFrom}::date)
        OR (account = ${s.legacyAccount} AND date < ${s.runDateFrom}::date)
      )
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
  return NextResponse.json({ data }, { headers: CORS });
}
