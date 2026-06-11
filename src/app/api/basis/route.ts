import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import {
  ASSETS,
  BasisData,
  BasisReseedError,
  fetchBasis,
  fetchPrices,
  loadSession,
  markNeedsReseed,
  refreshPrivy,
} from "@/lib/basis";

export const runtime = "nodejs";
export const maxDuration = 60;

// Vercel Cron(毎日)から呼ばれ、basis.pro の内部APIから資産・リワードを取得して記録する。
// OCR(スクショ抽出)の置き換え。手動GETでも即時実行できる。
// セッションは basis_session テーブルに種付け済みであること(tools/reseed.py / /api/basis/seed)。
export async function GET(req: NextRequest) {
  // 任意: CRON_SECRET を設定していれば Vercel Cron の Bearer を検証(未設定なら誰でも実行可)。
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const session = await loadSession();
  if (!session) {
    return NextResponse.json(
      { error: "未シード: basis_session が空です。tools/reseed.py で種付けしてください。" },
      { status: 503 }
    );
  }

  let data: BasisData;
  let prices: Record<string, number | null>;
  try {
    const bearer = await refreshPrivy(session); // 更新 + ローテ即保存
    [data, prices] = await Promise.all([fetchBasis(bearer, session.session_id), fetchPrices()]);
  } catch (e) {
    if (e instanceof BasisReseedError) {
      await markNeedsReseed(e.message);
      return NextResponse.json(
        { error: "要再シード(セッション失効)", detail: e.message, action: "tools/reseed.py を実行" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "basis 取得に失敗", detail: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  // 資産別の日次行を upsert しつつ、当日のリワード(前日比 Δtotal_pnl)を集計
  let totalStakedUsd = 0;
  let totalPnlUsd = 0;
  let dailyRewardUsd = 0; // 当日リワードUSD合計(資産ごとに delta or nominal を使い分けた和)
  let usedDelta = 0;
  let usedNominal = 0;
  const perAsset: Record<string, unknown> = {};

  for (const a of ASSETS) {
    const d = data.staking[a.st];
    if (!d) continue;
    const staked = num(d.total_staked);
    if (staked <= 0 && d.status !== "Active") {
      // 未ステーク資産はスキップ(記録不要)
      continue;
    }
    const price = prices[a.st];
    const totalPnl = num(d.total_pnl);
    const ableReward = num(data.able[a.st]);
    const balance = num(data.balance[a.st]);
    const dailyRoi = Number(d.daily_roi) || 0;

    const stakedUsd = price != null ? staked * price : null;
    const pnlUsd = price != null ? totalPnl * price : null;

    // 当日リワードを資産ごとに算出: 前日(date < today)の最新 total_pnl があれば
    // Δtotal_pnl、無ければ名目(staked×daily_roi)。資産ごとに基準を決めるので、
    // 新規資産が既存資産と混在しても取りこぼさない(過少計上を防ぐ)。
    const prev = await sql<{ total_pnl: number }>`
      select total_pnl::float8 as total_pnl from basis_staking_daily
      where asset = ${a.st} and date < ${today}
      order by date desc limit 1`;
    let rewardCrypto: number | null = null;
    let rewardUsd: number | null = null;
    let basis: "delta" | "nominal" | null = null;
    if (prev.rows[0]?.total_pnl != null) {
      rewardCrypto = totalPnl - Number(prev.rows[0].total_pnl); // 生の差分(claim等で負もあり得る)
      if (price != null) rewardUsd = Math.max(0, rewardCrypto) * price; // 負(出金等)は0に丸め
      basis = "delta";
      usedDelta++;
    } else if (stakedUsd != null) {
      rewardUsd = (stakedUsd * dailyRoi) / 100; // 前日データ無し(初回/新規資産)→ 名目で代替
      basis = "nominal";
      usedNominal++;
    }
    if (rewardUsd != null) dailyRewardUsd += rewardUsd;
    if (stakedUsd != null) totalStakedUsd += stakedUsd;
    if (pnlUsd != null) totalPnlUsd += pnlUsd;

    perAsset[a.st] = { staked, totalPnl, dailyRoi, price, stakedUsd, rewardCrypto, rewardUsd, basis };

    await sql`
      insert into basis_staking_daily
        (date, asset, total_staked, locked_amount, total_pnl, realized_pnl, unrealized_pnl,
         able_reward, balance, daily_roi, price_usd, staked_usd, pnl_usd, reward_crypto, reward_usd, raw)
      values
        (${today}, ${a.st}, ${staked}, ${num(d.locked_amount)}, ${totalPnl},
         ${num(d.realized_pnl)}, ${num(d.unrealized_pnl)}, ${ableReward}, ${balance},
         ${dailyRoi}, ${price}, ${stakedUsd}, ${pnlUsd}, ${rewardCrypto}, ${rewardUsd},
         ${JSON.stringify(d)})
      on conflict (date, asset) do update set
        total_staked = excluded.total_staked, locked_amount = excluded.locked_amount,
        total_pnl = excluded.total_pnl, realized_pnl = excluded.realized_pnl,
        unrealized_pnl = excluded.unrealized_pnl, able_reward = excluded.able_reward,
        balance = excluded.balance, daily_roi = excluded.daily_roi, price_usd = excluded.price_usd,
        staked_usd = excluded.staked_usd, pnl_usd = excluded.pnl_usd,
        reward_crypto = excluded.reward_crypto, reward_usd = excluded.reward_usd,
        raw = excluded.raw, taken_at = now()`;
  }

  const totalRewardsPct = totalStakedUsd > 0 ? (totalPnlUsd / totalStakedUsd) * 100 : null;

  // スナップショット(USD建て)を記録 → 既存ダッシュボードがそのまま使える
  await sql`
    insert into snapshots
      (total_staked_usd, total_rewards_usd, total_rewards_pct, staking_wallet_usd, raw_json)
    values
      (${round2(totalStakedUsd)}, ${round2(totalPnlUsd)}, ${totalRewardsPct},
       ${round2(totalStakedUsd)},
       ${JSON.stringify({ source: "basis-api", date: today, perAsset, prices, able: data.able })})`;

  // 当日のリワードを daily_rewards に記録(資産ごとの delta/nominal を合算)。
  const rewardBasis = usedDelta && usedNominal ? "mixed" : usedDelta ? "delta" : "nominal";
  const profitUsd = round3(dailyRewardUsd) ?? 0;
  // ステークがある日は連続性のため必ず記録(0でも欠落させない)。完全に未ステークの日のみスキップ。
  if (totalStakedUsd > 0) {
    await sql`
      insert into daily_rewards (date, profit_usd, source)
      values (${today}, ${profitUsd}, ${"api"})
      on conflict (date) do update set
        profit_usd = excluded.profit_usd, source = excluded.source, updated_at = now()`;
  }

  return NextResponse.json({
    ok: true,
    date: today,
    reward_basis: rewardBasis,
    profit_usd: profitUsd,
    total_staked_usd: round2(totalStakedUsd),
    total_rewards_usd: round2(totalPnlUsd),
    total_rewards_pct: totalRewardsPct,
    assets: perAsset,
  });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(n: number | null): number | null {
  return n == null ? null : Math.round(n * 100) / 100;
}
function round3(n: number | null): number | null {
  return n == null ? null : Math.round(n * 1000) / 1000;
}
