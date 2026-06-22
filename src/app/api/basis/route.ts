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
import { assetCardCaption, buildAssetCard, renderAssetCardPng, type PerAssetInput } from "@/lib/assetCard";
import { discordConfigured, formatDiscordTarget, sendDiscordPhoto } from "@/lib/discord";
import { formatTarget, sendTelegramPhoto, telegramConfigured } from "@/lib/telegram";

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

  const now = new Date();
  const today = now.toISOString().slice(0, 10); // スナップショット(累積値)の日付 = 実行日(UTC)
  // 日次リワードは「稼いだ日」=前日に帰属させる。00:15実行時の累積差分は前日1日ぶんの増分なので。
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

  // 資産別の日次スナップショットを upsert しつつ、前日ぶんの実測リワード(Δtotal_pnl)を集計
  let totalStakedUsd = 0;
  let totalPnlUsd = 0;
  let dailyRewardUsd = 0; // 前日の実測リワードUSD合計(累積 total_pnl の差分のみ)
  let measuredAssets = 0; // 前日比の差分が取れた資産数(0なら初回=基準のみでリワード未記録)
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

    // 前日ぶんの実測リワード = 累積 total_pnl の差分(date < today の最新スナップショットとの差)。
    // 前日データが無い資産(初回/新規)は「未測定」とし、名目では埋めない(推定値を実測日に混ぜない)。
    const prev = await sql<{ total_pnl: number }>`
      select total_pnl::float8 as total_pnl
      from basis_staking_daily
      where asset = ${a.st} and date < ${today}
      order by date desc limit 1`;
    let rewardCrypto: number | null = null; // 生の差分(claim等で負もあり得る)
    let rewardUsd: number | null = null; // 前日ぶんのリワードUSD(負は0に丸め)
    if (prev.rows[0]?.total_pnl != null) {
      rewardCrypto = totalPnl - Number(prev.rows[0].total_pnl);
      if (price != null) rewardUsd = Math.max(0, rewardCrypto) * price;
      if (rewardUsd != null) dailyRewardUsd += rewardUsd;
      measuredAssets++;
    }
    if (stakedUsd != null) totalStakedUsd += stakedUsd;
    if (pnlUsd != null) totalPnlUsd += pnlUsd;

    perAsset[a.st] = {
      staked,
      totalPnl,
      dailyRoi,
      price,
      stakedUsd,
      rewardCrypto,
      rewardUsd,
      baseTicker: a.base,
    };

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

  // 前日ぶんの実測リワードを「前日付」で daily_rewards に記録。
  // 差分が取れた資産が1つも無い場合(初回=基準スナップショットを置いただけ)は記録しない
  //(推定値で過去日を埋めない)。
  const profitUsd = round3(dailyRewardUsd) ?? 0;
  let rewardDate: string | null = null;
  if (measuredAssets > 0) {
    await sql`
      insert into daily_rewards (date, profit_usd, source)
      values (${yesterday}, ${profitUsd}, ${"api"})
      on conflict (date) do update set
        profit_usd = excluded.profit_usd, source = excluded.source, updated_at = now()`;
    rewardDate = yesterday;
  }

  // 追加機能: Asset サマリ画像(PNG)を Telegram / Discord の全ターゲット(env)へ投稿する。
  // env 未設定なら skip。投稿は付随機能なので、一部/全部が失敗してもデータ記録は成功扱いにする
  // (結果は telegram / discord フィールドで返す)。
  let telegram = "skipped";
  let discord = "skipped";
  const sendTelegram = telegramConfigured();
  const sendDiscord = discordConfigured();
  if (sendTelegram || sendDiscord) {
    try {
      const card = buildAssetCard({
        date: today,
        totalStakedUsd,
        totalRewardsUsd: totalPnlUsd,
        totalRewardsPct,
        perAsset: perAsset as Record<string, PerAssetInput>,
        able: data.able,
        prices,
        yesterdayProfitUsd: rewardDate ? profitUsd : null,
      });
      const png = await renderAssetCardPng(card);
      const caption = assetCardCaption(card);

      if (sendTelegram) {
        try {
          const results = await sendTelegramPhoto(png, caption);
          const sent = results.filter((r) => r.ok).length;
          const failed = results.filter((r) => !r.ok);
          telegram =
            failed.length === 0
              ? `sent (${sent}/${results.length})`
              : `partial (${sent}/${results.length}): ` +
                failed.map((f) => `${formatTarget(f)}: ${f.error}`).join("; ");
          for (const f of failed) console.error("[telegram] sendPhoto failed:", formatTarget(f), f.error);
        } catch (e) {
          telegram = `error: ${e instanceof Error ? e.message : String(e)}`;
          console.error("[telegram] sendPhoto failed:", e);
        }
      }

      if (sendDiscord) {
        try {
          const results = await sendDiscordPhoto(png, caption);
          const sent = results.filter((r) => r.ok).length;
          const failed = results.filter((r) => !r.ok);
          discord =
            failed.length === 0
              ? `sent (${sent}/${results.length})`
              : `partial (${sent}/${results.length}): ` +
                failed.map((f) => `${formatDiscordTarget(f)}: ${f.error}`).join("; ");
          for (const f of failed) console.error("[discord] webhook failed:", formatDiscordTarget(f), f.error);
        } catch (e) {
          discord = `error: ${e instanceof Error ? e.message : String(e)}`;
          console.error("[discord] webhook failed:", e);
        }
      }
    } catch (e) {
      const error = `error: ${e instanceof Error ? e.message : String(e)}`;
      if (sendTelegram) telegram = error;
      if (sendDiscord) discord = error;
      console.error("[notify] asset card build/send failed:", e);
    }
  }

  return NextResponse.json({
    ok: true,
    run_date: today, // 実行日(スナップショットの日付)
    reward_date: rewardDate, // リワードを帰属させた日=前日。初回など未測定時は null
    profit_usd: rewardDate ? profitUsd : null,
    total_staked_usd: round2(totalStakedUsd),
    total_rewards_usd: round2(totalPnlUsd),
    total_rewards_pct: totalRewardsPct,
    telegram, // sent | skipped | error: ...
    discord, // sent | skipped | error: ...
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
