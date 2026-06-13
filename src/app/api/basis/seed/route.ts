import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { encryptSecret } from "@/lib/crypto";

export const runtime = "nodejs";

// basis_session(Privy セッション)の種付け/更新。
// tools/reseed.py がブラウザで取得した {refresh_token, privy_access_token, session_id} を
// ここに POST する。Basic 認証(middleware)で保護されるため、/api/basis 本体とは別扱い。
export async function POST(req: NextRequest) {
  let body: { refresh_token?: string; privy_access_token?: string; session_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが不正" }, { status: 400 });
  }
  const { refresh_token, privy_access_token, session_id } = body;
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
    insert into basis_session (id, refresh_token, privy_access_token, session_id, status, last_error, updated_at)
    values (1, ${encRefresh}, ${encAccess}, ${session_id}, 'active', null, now())
    on conflict (id) do update set
      refresh_token = excluded.refresh_token,
      privy_access_token = excluded.privy_access_token,
      session_id = excluded.session_id,
      status = 'active', last_error = null, updated_at = now()`;

  return NextResponse.json({ ok: true, seeded_at: new Date().toISOString() });
}

// 状態確認(秘匿値は返さない)。
export async function GET() {
  const { rows } = await sql<{
    status: string;
    last_error: string | null;
    updated_at: string;
    has_refresh: boolean;
    has_session: boolean;
    token_encrypted: boolean;
  }>`
    select status, last_error, updated_at::text as updated_at,
           (refresh_token is not null) as has_refresh,
           (session_id is not null) as has_session,
           (refresh_token like 'enc:v1:%') as token_encrypted
    from basis_session where id = 1`;
  if (!rows[0]) return NextResponse.json({ seeded: false });
  return NextResponse.json({ seeded: true, ...rows[0] });
}
