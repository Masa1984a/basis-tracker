// 日次 cron(/api/market 00:05 UTC・/api/basis 00:15 UTC)の結果判定。/api/health が使う。
//
// DB やフレームワークに依存しない純粋関数にしてある(スナップショット + 現在時刻 → 判定)。
// 外部の監視(Grok Bot 等)はこの判定結果の status / summary をそのまま報告に使う。
//
// 判定の考え方:
// - ng   = cron の仕事が終わっていない(記録・投稿が欠けた)。人の対応が要る。
// - warn = 記録はできたが見ておくべきもの(欠落日の合算らしい DRR の跳ね等)。
// - 投稿アカウントは「その日の記録ができた = 投稿処理まで到達した」までしか分からない
//   (Telegram / Discord の送信結果はどこにも保存していない)。送信成功とは書かない。

export type HealthAccountRow = {
  account: string;
  status: string;
  last_error: string | null;
  updated_at: string;
  last_data_date: string | null;
  last_reward_date: string | null;
};

// basis_staking_daily の1行ぶんの日次リワード率(reward_crypto / total_staked × 100)
export type HealthRewardRow = { account: string; date: string; asset: string; pct: number };

export type HealthInput = {
  primary: string;
  notify: string;
  collecting: string[];
  accounts: HealthAccountRow[];
  rewards: HealthRewardRow[]; // 直近 10 日程度
  dailyRewardDates: string[]; // daily_rewards のうち cron が書いた行(source = api / api-split)の日付
  marketLatest: string | null; // market_daily の最新日付
  appUrl?: string; // 再シード手順(reseed.py --post-url)に載せるアプリの URL
};

export type HealthCheck = {
  id: string;
  label: string;
  ok: boolean;
  level: "ok" | "warn" | "ng";
  message: string;
  impact?: string;
  action?: string;
};

export type HealthResult = {
  status: "ok" | "warn" | "ng";
  summary: string;
  expected_date: string;
  checked_at: string;
  checks: HealthCheck[];
  latest_reward_pct: Record<string, { date: string; values: Record<string, number> }>;
};

// この時刻を過ぎていれば、その日の cron が終わっている前提で判定する(00:15 UTC 実行 + 余裕)。
const READY_AFTER_UTC_MIN = 30;
// DRR の跳ね判定(直近の中央値に対する比率)。欠落日の翌日は約 2 倍になる。
const OUTLIER_LOW = 0.5;
const OUTLIER_HIGH = 1.6;
const OUTLIER_MIN_HISTORY = 3;
const LAST_ERROR_MAX = 200;
// 再シード手順。--post-url が無いと検証だけで DB に保存されない。macOS の python は SSL_CERT_FILE が要る。
const reseedCmd = (account: string, appUrl: string) =>
  `SSL_CERT_FILE=/etc/ssl/cert.pem python3 tools/reseed.py --account ${account} --post-url ${appUrl}`;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// 判定対象の日付(= cron の実行日、UTC)。00:30 UTC より前ならまだ今日の cron が終わっていない
// 可能性があるので前日を対象にする(監視を早く走らせても誤検知しない)。
export function expectedDate(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  return min >= READY_AFTER_UTC_MIN ? today : addDays(today, -1);
}

function classifyError(err: string | null): string {
  if (!err) return "原因不明(last_error なし)";
  if (err.includes("SESSION_CONFLICT")) return "別端末での basis.pro ログインによるセッション競合";
  if (/トークンがありません|Privy refresh failed|privy_access_token 未設定/.test(err)) {
    return "Privy のログインセッション切れ";
  }
  return "取得エラー";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function evaluateHealth(input: HealthInput, now: Date): HealthResult {
  const expected = expectedDate(now);
  const rewardDate = addDays(expected, -1); // daily_rewards は稼いだ日(= 実行日の前日)付
  const checks: HealthCheck[] = [];

  const roleOf = (a: string) =>
    [a === input.primary ? "グラフ" : null, a === input.notify ? "投稿" : null].filter(Boolean).join("・") ||
    "収集";
  const impactOf = (a: string) =>
    [
      a === input.primary ? `/drr グラフ・ダッシュボードの ${expected} 分が未更新` : null,
      a === input.notify ? `${expected} の Telegram / Discord 投稿は出ていない` : null,
    ]
      .filter(Boolean)
      .join("。") || `${a} の ${expected} 分の記録が欠落`;

  // ---- アカウントごとの収集結果 ----
  for (const a of input.collecting) {
    const label = `${a}(${roleOf(a)})`;
    const id = `account:${a}`;
    const row = input.accounts.find((r) => r.account === a);
    const action =
      `Claude Code に「${a} のセッション再取得」を依頼(Mac で ${reseedCmd(a, input.appUrl ?? "<アプリの URL>")})` +
      " → 欠落日を補正";
    if (!row) {
      checks.push({ id, label, ok: false, level: "ng", message: "未シード(basis_session に行が無い)",
        impact: impactOf(a), action });
      continue;
    }
    if (row.status !== "active" || row.last_error) {
      const err = row.last_error ? ` / last_error: ${truncate(row.last_error, LAST_ERROR_MAX)}` : "";
      checks.push({ id, label, ok: false, level: "ng",
        message: `${classifyError(row.last_error)}(status=${row.status}${err})`, impact: impactOf(a), action });
      continue;
    }
    if (row.last_data_date !== expected) {
      checks.push({ id, label, ok: false, level: "ng",
        message: `セッションは有効だが ${expected} の記録が無い(最終記録 ${row.last_data_date ?? "なし"})。cron 自体が動いていない可能性`,
        impact: impactOf(a), action: "Vercel の Cron / デプロイ状況を確認" });
      continue;
    }
    if (row.last_reward_date !== expected) {
      checks.push({ id, label, ok: false, level: "warn",
        message: `${expected} の記録はあるがリワード差分が無い(前回の記録が無い可能性)` });
      continue;
    }
    checks.push({ id, label, ok: true, level: "ok",
      message: a === input.notify ? "記録 OK(投稿処理まで到達。送信成否は未記録)" : "記録 OK" });
  }

  // ---- primary のダッシュボード用日次リワード ----
  const drOk = input.dailyRewardDates.includes(rewardDate);
  checks.push({ id: "daily_rewards", label: `日次リワード ${rewardDate}`, ok: drOk, level: drOk ? "ok" : "ng",
    message: drOk ? "記録 OK" : `daily_rewards に ${rewardDate} の行が無い`,
    impact: drOk ? undefined : "ダッシュボードの日次リワードが欠落" });

  // ---- /api/market(BTC 価格) ----
  const mkOk = input.marketLatest === expected;
  checks.push({ id: "market", label: "BTC 価格(/api/market)", ok: mkOk, level: mkOk ? "ok" : "ng",
    message: mkOk ? "記録 OK" : `market_daily に ${expected} の行が無い(最新 ${input.marketLatest ?? "なし"})`,
    action: mkOk ? undefined : "Vercel の Cron / CoinGecko の応答を確認" });

  // ---- DRR の跳ね(欠落日の合算・異常値の検知、warn のみ) ----
  const latest: HealthResult["latest_reward_pct"] = {};
  for (const a of input.collecting) {
    const rows = input.rewards.filter((r) => r.account === a);
    const today = rows.filter((r) => r.date === expected);
    if (!today.length) continue;
    latest[a] = { date: expected, values: {} };
    const odd: string[] = [];
    for (const r of today) {
      const key = r.asset.replace(/^st/, "");
      latest[a].values[key] = Math.round(r.pct * 10000) / 10000;
      const hist = rows
        .filter((h) => h.asset === r.asset && h.date < expected)
        .sort((x, y) => y.date.localeCompare(x.date))
        .slice(0, 7)
        .map((h) => h.pct)
        .filter((p) => p > 0);
      if (hist.length < OUTLIER_MIN_HISTORY) continue;
      const ratio = r.pct / median(hist);
      if (ratio < OUTLIER_LOW || ratio > OUTLIER_HIGH) odd.push(`${key} ${ratio.toFixed(2)}倍`);
    }
    if (odd.length) {
      checks.push({ id: `drr:${a}`, label: `${a} の DRR`, ok: false, level: "warn",
        message: `直近 7 日の中央値から外れている: ${odd.join(" / ")}(欠落日の合算の可能性)`,
        impact: a === input.notify ? "投稿の 24h Profit / DRR が実際の1日分とずれている可能性" : undefined });
    }
  }

  const status: HealthResult["status"] = checks.some((c) => c.level === "ng")
    ? "ng"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "ok";

  const head = { ok: "✅ basis-tracker cron 正常", warn: "⚠️ basis-tracker cron 注意", ng: "❌ basis-tracker cron 異常" }[status];
  const lines = [`${head} (${expected})`];
  for (const c of checks) {
    const mark = { ok: "OK", warn: "注意", ng: "NG" }[c.level];
    // ok の message は「記録 OK(補足)」の形なので「OK(補足)」として出す
    lines.push(c.ok ? `- ${c.label}: ${c.message.replace(/^記録 /, "")}` : `- ${c.label}: ${mark} — ${c.message}`);
    if (!c.ok && c.impact) lines.push(`  影響: ${c.impact}`);
    if (!c.ok && c.action) lines.push(`  対応: ${c.action}`);
  }
  for (const [a, v] of Object.entries(latest)) {
    const vals = Object.entries(v.values)
      .map(([k, p]) => `${k} ${p.toFixed(3)}`)
      .join(" / ");
    lines.push(`- ${a} DRR(%): ${vals}`);
  }

  return { status, summary: lines.join("\n"), expected_date: expected, checked_at: now.toISOString(), checks,
    latest_reward_pct: latest };
}
