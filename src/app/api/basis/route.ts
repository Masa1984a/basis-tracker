import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { collectAccounts, isValidAccount, primaryAccount } from "@/lib/accounts";
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

type AccountOk = {
  account: string;
  ok: true;
  rewardDate: string | null;
  profitUsd: number;
  totalStakedUsd: number;
  totalPnlUsd: number;
  totalRewardsPct: number | null;
  perAsset: Record<string, PerAsset>;
};
type AccountFail = { account: string; ok: false; status: number; body: Record<string, unknown> };
type AccountResult = AccountOk | AccountFail;

type PerAsset = PerAssetInput & {
  staked: number;
  totalPnl: number;
  dailyRoi: number;
  price: number | null;
  stakedUsd: number | null;
  rewardCrypto: number | null;
  rewardUsd: number | null;
  baseTicker: string;
};

// Vercel Cron(毎日)から呼ばれ、basis.pro の内部APIから資産・リワードを取得して記録する。
// OCR(スクショ抽出)の置き換え。手動GETでも即時実行できる。
// セッションは basis_session テーブルにアカウントごとに種付け済みであること
// (tools/reseed.py --account <name> / /api/basis/seed)。
//
// 複数アカウント(src/lib/accounts.ts):
// - BASIS_ACCOUNTS の各アカウントを primary から順に1つずつ収集し、basis_staking_daily に
//   account 付きで記録する。1アカウントの失敗は他アカウントの収集に影響させない。
// - snapshots / daily_rewards(ダッシュボード)と Telegram / Discord 投稿は primary だけ。
// - ?account=<name> で特定アカウントだけを実行できる(?dry=1 と併用して収集確認に使う)。
export async function GET(req: NextRequest) {
  // 任意: CRON_SECRET を設定していれば Vercel Cron の Bearer を検証(未設定なら誰でも実行可)。
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // 手動テスト用の dry-run。読み取り経路(Privy 更新 + basis 取得 + 集計)は本番と同一に
  // 実行するが、basis_staking_daily / snapshots / daily_rewards への書き込みと通知投稿を
  // 一切しない。フラグ無し(?dry なし)は従来どおりの本番動作。?dry=1 で dry-run。
  // dry-run 中でも通知経路だけ試したいときは ?dry=1&notify=1(データは書かない)。
  // 注: セッション更新(refresh_token のローテ保存)だけは読み取りに必須なので dry-run でも行う。
  //     これはリワード/スナップショット等の記録結果には影響しない(cron の通常動作と同じ)。
  const params = req.nextUrl.searchParams;
  const truthy = (v: string | null) => v != null && ["1", "true", "yes", "on"].includes(v.toLowerCase());
  const dryRun = truthy(params.get("dry")) || truthy(params.get("dryRun"));
  const doNotify = dryRun ? truthy(params.get("notify")) : true;

  const primary = primaryAccount();
  const requested = params.get("account")?.trim().toLowerCase() || null;
  if (requested && !isValidAccount(requested)) {
    return NextResponse.json({ error: `account が不正: ${requested}` }, { status: 400 });
  }
  const targets = requested ? [requested] : collectAccounts();

  const now = new Date();
  const today = now.toISOString().slice(0, 10); // スナップショット(累積値)の日付 = 実行日(UTC)
  // 日次リワードは「稼いだ日」=前日に帰属させる。00:15実行時の累積差分は前日1日ぶんの増分なので。
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

  // 価格は全アカウント共通で1回だけ取得(USD 換算をアカウント間でそろえる)。
  // 先に走らせておき、各アカウントの取得と並行させる。未 await の reject で
  // unhandled rejection にならないよう空 catch を付ける(await 側には reject がそのまま届く)。
  const pricesP = fetchPrices();
  pricesP.catch(() => {});

  const results: AccountResult[] = [];
  for (const account of targets) {
    const r = await collectAccount(account, {
      today,
      yesterday,
      dryRun,
      isPrimary: account === primary,
      pricesP,
    });
    if (!r.ok) console.error(`[basis] account=${account} failed:`, r.status, JSON.stringify(r.body));
    results.push(r);
  }

  const main = results[0]; // primary(?account 指定時はそのアカウント)
  const others = results.slice(1).map(summarize);
  const isPrimary = main.account === primary;

  if (!main.ok) {
    return NextResponse.json(
      { ...main.body, account: main.account, primary: isPrimary, others },
      { status: main.status }
    );
  }

  const { rewardDate, profitUsd, totalStakedUsd, totalPnlUsd, totalRewardsPct, perAsset } = main;

  // 追加機能: Asset サマリ画像(PNG)を Telegram / Discord の全ターゲット(env)へ投稿する。
  // env 未設定なら skip。投稿は付随機能なので、一部/全部が失敗してもデータ記録は成功扱いにする
  // (結果は telegram / discord フィールドで返す)。投稿するのは primary アカウントのみ。
  const sendTelegram = telegramConfigured();
  const sendDiscord = discordConfigured();
  const suppressNotify = dryRun && !doNotify; // dry-run 既定は投稿しない(?notify=1 で解除)
  let telegram = suppressNotify && sendTelegram ? "skipped (dry-run)" : "skipped";
  let discord = suppressNotify && sendDiscord ? "skipped (dry-run)" : "skipped";
  if (!isPrimary) {
    if (sendTelegram) telegram = "skipped (not primary)";
    if (sendDiscord) discord = "skipped (not primary)";
  }
  if (isPrimary && !suppressNotify && (sendTelegram || sendDiscord)) {
    try {
      const card = buildAssetCard({
        date: today,
        totalStakedUsd,
        totalRewardsUsd: totalPnlUsd,
        totalRewardsPct,
        perAsset,
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
    dry_run: dryRun, // true のとき DB 書き込み・通知(既定)を行っていない
    account: main.account, // 以下のフィールドが指すアカウント
    primary: isPrimary, // true のときだけ snapshots / daily_rewards 記録と通知を行う
    run_date: today, // 実行日(スナップショットの日付)
    reward_date: rewardDate, // リワードを帰属させた日=前日。初回など未測定時は null
    profit_usd: rewardDate ? profitUsd : null,
    total_staked_usd: round2(totalStakedUsd),
    total_rewards_usd: round2(totalPnlUsd),
    total_rewards_pct: totalRewardsPct,
    telegram, // sent | skipped | error: ...
    discord, // sent | skipped | error: ...
    assets: perAsset,
    others, // primary 以外のアカウントの収集結果(basis_staking_daily のみ記録)
  });
}

// 1アカウントぶんの取得〜記録。例外はここで捕まえて結果に変換し、他アカウントへ波及させない。
async function collectAccount(
  account: string,
  opts: {
    today: string;
    yesterday: string;
    dryRun: boolean;
    isPrimary: boolean;
    pricesP: Promise<Record<string, number | null>>;
  }
): Promise<AccountResult> {
  const { today, yesterday, dryRun, isPrimary } = opts;
  const fail = (status: number, body: Record<string, unknown>): AccountFail => ({
    account,
    ok: false,
    status,
    body,
  });

  try {
    const session = await loadSession(account);
    if (!session) {
      return fail(503, {
        error: `未シード: basis_session に account=${account} の行がありません。`,
        action: `python tools/reseed.py --account ${account} --post-url <app-url>`,
      });
    }

    let data: BasisData;
    let prices: Record<string, number | null>;
    try {
      const bearer = await refreshPrivy(account, session); // 更新 + ローテ即保存
      [data, prices] = await Promise.all([fetchBasis(bearer, session.session_id), opts.pricesP]);
    } catch (e) {
      if (e instanceof BasisReseedError) {
        await markNeedsReseed(account, e.message);
        return fail(409, {
          error: "要再シード(セッション失効)",
          detail: e.message,
          action: `python tools/reseed.py --account ${account} を実行`,
        });
      }
      return fail(502, { error: "basis 取得に失敗", detail: e instanceof Error ? e.message : String(e) });
    }

    // 資産別の日次スナップショットを upsert しつつ、前日ぶんの実測リワード(Δtotal_pnl)を集計
    let totalStakedUsd = 0;
    let totalPnlUsd = 0;
    let dailyRewardUsd = 0; // 前日の実測リワードUSD合計(累積 total_pnl の差分のみ)
    let measuredAssets = 0; // 前日比の差分が取れた資産数(0なら初回=基準のみでリワード未記録)
    const perAsset: Record<string, PerAsset> = {};

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

      // 前日ぶんの実測リワード = 累積 total_pnl の差分(同一アカウントの date < today の最新スナップショットとの差)。
      // 前日データが無い資産(初回/新規)は「未測定」とし、名目では埋めない(推定値を実測日に混ぜない)。
      const prev = await sql<{ total_pnl: number }>`
        select total_pnl::float8 as total_pnl
        from basis_staking_daily
        where account = ${account} and asset = ${a.st} and date < ${today}
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

      if (!dryRun) await sql`
        insert into basis_staking_daily
          (account, date, asset, total_staked, locked_amount, total_pnl, realized_pnl, unrealized_pnl,
           able_reward, balance, daily_roi, price_usd, staked_usd, pnl_usd, reward_crypto, reward_usd, raw)
        values
          (${account}, ${today}, ${a.st}, ${staked}, ${num(d.locked_amount)}, ${totalPnl},
           ${num(d.realized_pnl)}, ${num(d.unrealized_pnl)}, ${ableReward}, ${balance},
           ${dailyRoi}, ${price}, ${stakedUsd}, ${pnlUsd}, ${rewardCrypto}, ${rewardUsd},
           ${JSON.stringify(d)})
        on conflict (account, date, asset) do update set
          total_staked = excluded.total_staked, locked_amount = excluded.locked_amount,
          total_pnl = excluded.total_pnl, realized_pnl = excluded.realized_pnl,
          unrealized_pnl = excluded.unrealized_pnl, able_reward = excluded.able_reward,
          balance = excluded.balance, daily_roi = excluded.daily_roi, price_usd = excluded.price_usd,
          staked_usd = excluded.staked_usd, pnl_usd = excluded.pnl_usd,
          reward_crypto = excluded.reward_crypto, reward_usd = excluded.reward_usd,
          raw = excluded.raw, taken_at = now()`;
    }

    const totalRewardsPct = totalStakedUsd > 0 ? (totalPnlUsd / totalStakedUsd) * 100 : null;

    // スナップショット(USD建て)を記録 → 既存ダッシュボードがそのまま使える。
    // snapshots / daily_rewards はダッシュボード(出力)用なので primary だけが書く。
    if (!dryRun && isPrimary) await sql`
      insert into snapshots
        (total_staked_usd, total_rewards_usd, total_rewards_pct, staking_wallet_usd, raw_json)
      values
        (${round2(totalStakedUsd)}, ${round2(totalPnlUsd)}, ${totalRewardsPct},
         ${round2(totalStakedUsd)},
         ${JSON.stringify({ source: "basis-api", account, date: today, perAsset, prices, able: data.able })})`;

    // 前日ぶんの実測リワードを「前日付」で daily_rewards に記録。
    // 差分が取れた資産が1つも無い場合(初回=基準スナップショットを置いただけ)は記録しない
    //(推定値で過去日を埋めない)。
    const profitUsd = round3(dailyRewardUsd) ?? 0;
    let rewardDate: string | null = null;
    if (measuredAssets > 0) {
      if (!dryRun && isPrimary) await sql`
        insert into daily_rewards (date, profit_usd, source)
        values (${yesterday}, ${profitUsd}, ${"api"})
        on conflict (date) do update set
          profit_usd = excluded.profit_usd, source = excluded.source, updated_at = now()`;
      rewardDate = yesterday;
    }

    return {
      account,
      ok: true,
      rewardDate,
      profitUsd,
      totalStakedUsd,
      totalPnlUsd,
      totalRewardsPct,
      perAsset,
    };
  } catch (e) {
    return fail(500, { error: "記録に失敗", detail: e instanceof Error ? e.message : String(e) });
  }
}

// primary 以外のアカウント結果の要約(レスポンスの others 用)。資産別 DRR で並行収集の健全性を見る。
function summarize(r: AccountResult) {
  if (!r.ok) return { account: r.account, ok: false, status: r.status, ...r.body };
  const drr: Record<string, number | null> = {};
  for (const [st, p] of Object.entries(r.perAsset)) {
    drr[st] = p.rewardCrypto != null && p.staked > 0 ? round4((p.rewardCrypto / p.staked) * 100) : null;
  }
  return {
    account: r.account,
    ok: true,
    reward_date: r.rewardDate,
    profit_usd: r.rewardDate ? r.profitUsd : null,
    total_staked_usd: round2(r.totalStakedUsd),
    drr_pct: drr,
  };
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
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
