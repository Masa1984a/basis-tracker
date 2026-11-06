import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { encryptSecret } from "@/lib/crypto";
import { collectAccounts, isValidAccount, primaryAccount } from "@/lib/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// basis_session(Privy セッション)の種付け/更新。アカウント単位(basis_session.account)。
// tools/reseed.py --account <name> がブラウザで取得した
// {account, refresh_token, privy_access_token, session_id} をここに POST する。
// Basic 認証(middleware)で保護されるため、/api/basis 本体とは別扱い。
export async function POST(req: NextRequest) {
  let body: {
    account?: string;
    refresh_token?: string;
    privy_access_token?: string;
    session_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが不正" }, { status: 400 });
  }
  const { refresh_token, privy_access_token, session_id } = body;
  // account は必須(省略時に既定アカウントへ書くと、別アカウントのセッションで上書きする事故になるため)。
  const account = body.account?.trim().toLowerCase();
  if (!isValidAccount(account)) {
    return NextResponse.json(
      { error: "account は必須(英小文字・数字・_- の32文字以内)。tools/reseed.py --account <name> を使う" },
      { status: 400 }
    );
  }
  // privy_access_token も必須(/sessions 更新の Bearer に使う。null だと cron が確実に失敗する)。
  if (!refresh_token || !session_id || !privy_access_token) {
    return NextResponse.json(
      { error: "refresh_token / privy_access_token / session_id は必須" },
      { status: 400 }
    );
  }

  // SESSION_ENC_KEY 設定時はトークンを暗号化して保存(session_id は平文のまま)。
  const encRefresh = encryptSecret(refresh_token);
  const encAccess = encryptSecret(privy_access_token ?? null);
  await sql`
    insert into basis_session (account, refresh_token, privy_access_token, session_id, status, last_error, updated_at)
    values (${account}, ${encRefresh}, ${encAccess}, ${session_id}, 'active', null, now())
    on conflict (account) do update set
      refresh_token = excluded.refresh_token,
      privy_access_token = excluded.privy_access_token,
      session_id = excluded.session_id,
      status = 'active', last_error = null, updated_at = now()`;

  return NextResponse.json({ ok: true, account, seeded_at: new Date().toISOString() });
}

// 状態確認(秘匿値は返さない)。全アカウントのセッション状態と、最後に記録できた日付を返す。
// 並行収集の安定確認用: last_data_date が毎日進み、status が active のままなら収集できている。
export async function GET() {
  const { rows } = await sql<{
    account: string;
    status: string;
    last_error: string | null;
    updated_at: string;
    token_encrypted: boolean;
    last_data_date: string | null;
    last_reward_date: string | null;
    days_recorded: number;
  }>`
    select s.account, s.status, s.last_error, s.updated_at::text as updated_at,
           (s.refresh_token like 'enc:v1:%') as token_encrypted,
           d.last_data_date, d.last_reward_date, coalesce(d.days_recorded, 0)::int as days_recorded
    from basis_session s
    left join (
      select account,
             max(date)::text as last_data_date,
             max(date) filter (where reward_crypto is not null)::text as last_reward_date,
             count(distinct date) as days_recorded
      from basis_staking_daily group by account
    ) d on d.account = s.account
    order by s.account`;

  const primary = primaryAccount();
  const collecting = collectAccounts();
  return NextResponse.json({
    primary, // 出力対象(グラフ・ダッシュボード・Telegram/Discord)
    collecting, // 毎日 cron で収集するアカウント(BASIS_ACCOUNTS + primary)
    accounts: rows.map((r) => ({
      ...r,
      primary: r.account === primary,
      collecting: collecting.includes(r.account),
    })),
    // 収集対象なのに未シードのアカウント(reseed.py --account <name> が必要)
    unseeded: collecting.filter((a) => !rows.some((r) => r.account === a)),
  });
}
