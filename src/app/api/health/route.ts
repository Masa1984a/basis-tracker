import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { createHash, timingSafeEqual } from "crypto";
import { collectAccounts, notifyAccount, primaryAccount } from "@/lib/accounts";
import { evaluateHealth, expectedDate, type HealthAccountRow, type HealthRewardRow } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 日次 cron の監視用(読み取り専用)。外部の監視(Grok Bot 等)が毎朝 GET して結果を報告する。
// Basic 認証(middleware)の対象外で、専用の MONITOR_TOKEN による Bearer 認証だけを受け付ける
// (アプリ全体の Basic 認証を外部に渡さないため)。MONITOR_TOKEN 未設定なら 503 で閉じる。
// 判定ロジックは src/lib/health.ts。認証・設定エラー以外は常に 200 で、結果は status(ok / warn / ng)。
const MIN_TOKEN_LEN = 32;
const NO_STORE = { "Cache-Control": "no-store" };

function authorized(req: NextRequest, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  // timingSafeEqual は長さが違うと例外になるので、両側をハッシュして同じ長さにしてから比べる
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  const token = process.env.MONITOR_TOKEN?.trim();
  if (!token || token.length < MIN_TOKEN_LEN) {
    return NextResponse.json(
      { error: `MONITOR_TOKEN が未設定、または ${MIN_TOKEN_LEN} 文字未満` },
      { status: 503, headers: NO_STORE }
    );
  }
  if (!authorized(req, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  try {
    const now = new Date();
    const expected = expectedDate(now);
    const primary = primaryAccount();
    const notify = notifyAccount();
    const collecting = collectAccounts();

    const [accounts, rewards, daily, market] = await Promise.all([
      sql<HealthAccountRow>`
        select s.account, s.status, s.last_error, s.updated_at::text as updated_at,
               d.last_data_date, d.last_reward_date
        from basis_session s
        left join (
          select account,
                 max(date)::text as last_data_date,
                 max(date) filter (where reward_crypto is not null)::text as last_reward_date
          from basis_staking_daily group by account
        ) d on d.account = s.account
        order by s.account`,
      sql<HealthRewardRow>`
        select account, date::text as date, asset, (reward_crypto / total_staked * 100)::float8 as pct
        from basis_staking_daily
        where reward_crypto is not null and total_staked > 0
          and date > ${expected}::date - 10
        order by account, asset, date`,
      sql<{ date: string }>`
        select date::text as date from daily_rewards
        where source in ('api', 'api-split') and date > ${expected}::date - 10`,
      sql<{ date: string | null }>`select max(date)::text as date from market_daily`,
    ]);

    const result = evaluateHealth(
      {
        primary,
        notify,
        collecting,
        accounts: accounts.rows,
        rewards: rewards.rows.map((r) => ({ ...r, pct: Number(r.pct) })),
        dailyRewardDates: daily.rows.map((r) => r.date),
        marketLatest: market.rows[0]?.date ?? null,
        appUrl: req.nextUrl.origin,
      },
      now
    );
    return NextResponse.json({ ...result, primary, notify, collecting }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json(
      { status: "error", error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: NO_STORE }
    );
  }
}
