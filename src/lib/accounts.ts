// basis.pro の収集対象アカウント設定(複数アカウント並行収集用)。
//
// - アカウントは短いラベル(例: april / masa)で識別する。DB の basis_session.account /
//   basis_staking_daily.account の値になる。メールアドレスそのものはコードにも DB にも置かない。
// - BASIS_PRIMARY_ACCOUNT: 出力対象(/drr グラフ・ダッシュボード用の snapshots / daily_rewards・
//   Telegram / Discord 投稿)となるアカウント。未設定なら既存データの帰属先である "april"。
// - BASIS_ACCOUNTS: 毎日 cron で収集するアカウント(カンマ/セミコロン/空白区切り)。
//   primary は書かなくても常に含まれ、常に先頭で処理される。
//
// 例) 並行運用中:   BASIS_PRIMARY_ACCOUNT=april  BASIS_ACCOUNTS=april,masa
//     切り替え後:   BASIS_PRIMARY_ACCOUNT=masa   BASIS_ACCOUNTS=masa(april の収集を止める場合)

export const DEFAULT_ACCOUNT = "april";

const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidAccount(a: unknown): a is string {
  return typeof a === "string" && ACCOUNT_RE.test(a);
}

function normalize(raw: string, source: string): string {
  const a = raw.trim().toLowerCase();
  if (!isValidAccount(a)) {
    throw new Error(`${source} のアカウント名が不正: "${raw}"(英小文字・数字・_- の32文字以内)`);
  }
  return a;
}

export function primaryAccount(): string {
  const raw = process.env.BASIS_PRIMARY_ACCOUNT?.trim();
  return raw ? normalize(raw, "BASIS_PRIMARY_ACCOUNT") : DEFAULT_ACCOUNT;
}

// 収集するアカウント一覧(primary が先頭、重複除去)。
export function collectAccounts(): string[] {
  const primary = primaryAccount();
  const listed = (process.env.BASIS_ACCOUNTS ?? "")
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((a) => normalize(a, "BASIS_ACCOUNTS"));
  return [primary, ...listed.filter((a) => a !== primary)].filter((a, i, arr) => arr.indexOf(a) === i);
}
