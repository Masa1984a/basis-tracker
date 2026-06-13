import { sql } from "@vercel/postgres";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

// basis.pro 内部API(Path B)クライアント。
// 認証は Privy。/sessions で privy_access_token を更新し、それを Bearer として
// api.basis.pro を叩く(x-app-sid に保存済み session_id を付ける)。
// member/user(session_id 発行)は暗号化必須なので cron では使わず、種付け時の値を再利用する。

export const PRIVY_APP_ID = "cmo84wtol002q0cihr61zf6gg";
const PRIVY_SESSIONS = "https://auth.privy.io/api/v1/sessions";
const API_BASE = "https://api.basis.pro";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

// stToken -> 原資産 / CoinGecko id
export const ASSETS = [
  { st: "stBTC", base: "BTC", coingecko: "bitcoin" },
  { st: "stETH", base: "ETH", coingecko: "ethereum" },
  { st: "stSOL", base: "SOL", coingecko: "solana" },
  { st: "stPAXG", base: "PAXG", coingecko: "pax-gold" },
] as const;

export type BasisSession = {
  refresh_token: string;
  privy_access_token: string | null;
  session_id: string;
};

// 種付けが必要な状態(再ログイン要求)。route 側で 409 + status 更新に使う。
export class BasisReseedError extends Error {}

export type StakeAsset = {
  total_staked: string;
  pending_staked: string;
  total_pnl: string;
  realized_pnl: string;
  unrealized_pnl: string;
  locked_amount: string;
  extractable_amount: string;
  unlockable_amount: string;
  status: string;
  daily_roi: number;
  [k: string]: unknown;
};

export type BasisData = {
  staking: Record<string, StakeAsset>;
  balance: Record<string, string>;
  able: Record<string, string>;
};

export async function loadSession(): Promise<BasisSession | null> {
  const { rows } = await sql<BasisSession>`
    select refresh_token, privy_access_token, session_id
    from basis_session where id = 1`;
  const r = rows[0];
  if (!r?.refresh_token || !r?.session_id) return null;
  // 保存時に暗号化されたトークンは復号して返す(平文のままのデータはそのまま通る)。
  // session_id は単体では無力のため平文のまま扱う。
  return {
    refresh_token: decryptSecret(r.refresh_token) as string,
    privy_access_token: decryptSecret(r.privy_access_token),
    session_id: r.session_id,
  };
}

async function persistTokens(refreshToken: string, privyAccessToken: string | null) {
  // SESSION_ENC_KEY 設定時は暗号化して保存(未設定なら平文のまま= encryptSecret が素通し)。
  await sql`
    update basis_session
      set refresh_token = ${encryptSecret(refreshToken)},
          privy_access_token = ${encryptSecret(privyAccessToken)},
          status = 'active', last_error = null, updated_at = now()
    where id = 1`;
}

export async function markNeedsReseed(message: string) {
  await sql`
    update basis_session
      set status = 'needs_reseed', last_error = ${message.slice(0, 500)}, updated_at = now()
    where id = 1`;
}

// Privy セッションを更新。refresh_token は1回限り(ローテ)なので、成功したら
// 「データ取得の前に」即保存する(途中失敗で回転後トークンを失わないため)。
// 返すのは basis 用 Bearer として使う privy_access_token。
export async function refreshPrivy(s: BasisSession): Promise<string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "privy-app-id": PRIVY_APP_ID,
    "privy-client": "react-auth:3.16.0",
    "user-agent": UA,
    origin: "https://basis.pro",
    referer: "https://basis.pro/",
  };
  // /sessions は Bearer(現アクセストークン、期限切れでも可)が必須。
  // null だと Privy が 400 "Missing access token" を返すので、明確に再シード要求にする。
  if (!s.privy_access_token) {
    throw new BasisReseedError("privy_access_token 未設定。tools/reseed.py で再シードしてください");
  }
  headers["authorization"] = `Bearer ${s.privy_access_token}`;

  const res = await fetch(PRIVY_SESSIONS, {
    method: "POST",
    headers,
    body: JSON.stringify({ refresh_token: s.refresh_token }),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    // 401/403 等はリフレッシュトークン失効 → 要再シード
    throw new BasisReseedError(`Privy refresh failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const j = JSON.parse(text) as {
    privy_access_token?: string;
    refresh_token?: string;
  };
  const newAccess = j.privy_access_token;
  const newRefresh = j.refresh_token;
  // refresh_token は毎回ローテーション(旧トークンは消費済み)。欠落時に旧値を使い回すと
  // 次回必ず失敗するので、両方揃っていなければ再シード要求にする。
  if (!newAccess || !newRefresh) {
    throw new BasisReseedError("Privy refresh のレスポンスにトークンがありません");
  }
  await persistTokens(newRefresh, newAccess); // ローテ即保存
  return newAccess;
}

async function apiGet<T>(path: string, bearer: string, sessionId: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${bearer}`,
      origin: "https://basis.pro",
      referer: "https://basis.pro/",
      "user-agent": UA,
      "x-client-version": "web-1.0.0",
      "x-app-sid": sessionId,
    },
    cache: "no-store",
  });
  const text = await res.text();
  if (res.status === 401) {
    // セッション競合 / トークン無効 → 要再シード
    throw new BasisReseedError(`${path}: 401 ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export async function fetchBasis(bearer: string, sessionId: string): Promise<BasisData> {
  const [staking, balance, able] = await Promise.all([
    apiGet<{ data: Record<string, StakeAsset> }>("/v2/stake/stakingInfo", bearer, sessionId),
    apiGet<{ balance: Record<string, string> }>("/v2/member/assetBalance", bearer, sessionId),
    apiGet<{ data: Record<string, string> }>("/v2/reward/getAbleReward", bearer, sessionId),
  ]);
  return { staking: staking.data, balance: balance.balance, able: able.data };
}

// CoinGecko から 4 資産の USD 価格を取得(market route と同じ流儀)。
export async function fetchPrices(): Promise<Record<string, number | null>> {
  const ids = ASSETS.map((a) => a.coingecko).join(",");
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
    { cache: "no-store" }
  );
  const out: Record<string, number | null> = {};
  if (!res.ok) {
    for (const a of ASSETS) out[a.st] = null;
    return out;
  }
  const j = (await res.json()) as Record<string, { usd?: number }>;
  for (const a of ASSETS) out[a.st] = j[a.coingecko]?.usd ?? null;
  return out;
}
