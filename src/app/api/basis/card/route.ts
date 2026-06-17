import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { buildAssetCard, renderAssetCardPng } from "@/lib/assetCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 直近に記録済みの snapshot(raw_json に perAsset/prices/able を保持)と daily_rewards から
// Asset サマリ・カード(PNG)を生成して返す、読み取り専用のプレビュー用エンドポイント。
// cron 実行や Telegram 送信は行わない。Basic 認証(middleware)で保護される。
type RawJson = {
  date?: string;
  perAsset?: Record<string, { stakedUsd?: number | null; price?: number | null; rewardUsd?: number | null }>;
  prices?: Record<string, number | null>;
  able?: Record<string, string | number>;
};

export async function GET() {
  const snap = await sql<{
    total_staked_usd: number | null;
    total_rewards_usd: number | null;
    total_rewards_pct: number | null;
    raw_json: RawJson | null;
  }>`
    select total_staked_usd::float8 as total_staked_usd,
           total_rewards_usd::float8 as total_rewards_usd,
           total_rewards_pct::float8 as total_rewards_pct,
           raw_json
    from snapshots order by taken_at desc limit 1`;
  const row = snap.rows[0];
  if (!row) {
    return NextResponse.json(
      { error: "snapshot がありません。まず /api/basis を実行してください。" },
      { status: 404 }
    );
  }
  const raw = row.raw_json ?? {};

  const rew = await sql<{ date: string; profit_usd: number }>`
    select date::text as date, profit_usd::float8 as profit_usd
    from daily_rewards order by date desc limit 1`;

  const card = buildAssetCard({
    date: raw.date ?? new Date().toISOString().slice(0, 10),
    totalStakedUsd: row.total_staked_usd ?? 0,
    totalRewardsUsd: row.total_rewards_usd ?? 0,
    totalRewardsPct: row.total_rewards_pct ?? null,
    perAsset: raw.perAsset ?? {},
    able: raw.able ?? {},
    prices: raw.prices ?? {},
    yesterdayProfitUsd: rew.rows[0]?.profit_usd ?? null,
  });

  const png = await renderAssetCardPng(card);
  return new NextResponse(png, {
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
}
