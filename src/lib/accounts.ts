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
//     切り替え前の april の履歴の見せ方は下の displayStitch() を参照。

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

// april → masa 切り替え時の表示の連結(/drr グラフとダッシュボードの DRR)。
// april は 100% ブーストで DRR が masa の約 2 倍なので、切り替え前の april の DRR を 1/2 にして
// masa の値とつなぐ。DB の記録値は変えず、表示(API の返り値)だけを換算する。
// primary が april のあいだ(BASIS_PRIMARY_ACCOUNT 未設定 / april)は連結せず、従来どおりの表示。
const LEGACY = {
  account: "april",
  drrScale: 0.5,
  // primary(masa)の値を使い始める cron 実行日(UTC)。この日 00:15 UTC の実行から masa の値を表示する。
  firstRunDate: "2026-11-11",
} as const;

export type DisplayStitch = {
  primary: string;
  // 切り替え前の期間に表示するアカウントと DRR の係数(連結しないときは primary と 1)
  legacyAccount: string;
  legacyDrrScale: number;
  // basis_staking_daily.date(= cron 実行日)がこの日以降なら primary、より前なら legacy
  runDateFrom: string;
  // daily_rewards.date(= 稼いだ日 = 実行日の前日)がこの日以降なら primary、より前なら legacy
  rewardDateFrom: string;
};

export function displayStitch(): DisplayStitch {
  const primary = primaryAccount();
  if (primary === LEGACY.account) {
    // 連結なし: 全期間 primary の値をそのまま表示する
    return {
      primary,
      legacyAccount: primary,
      legacyDrrScale: 1,
      runDateFrom: "0001-01-01",
      rewardDateFrom: "0001-01-01",
    };
  }
  const rewardDateFrom = new Date(Date.parse(`${LEGACY.firstRunDate}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    primary,
    legacyAccount: LEGACY.account,
    legacyDrrScale: LEGACY.drrScale,
    runDateFrom: LEGACY.firstRunDate,
    rewardDateFrom,
  };
}
