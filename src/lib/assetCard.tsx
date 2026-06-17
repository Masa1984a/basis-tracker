import { ImageResponse } from "next/og";

// basis.pro の Asset 画面に相当する「資産サマリ・カード(PNG)」を、cron が取得済みのデータから生成する。
// ブラウザ不要(Next.js 組み込みの ImageResponse / Satori でJSX→PNG)。ダッシュボードと同じダーク配色。
// DRR は本アプリ共通の定義(= reward ÷ staked × 100、想定レンジ 0.5〜0.9%)で算出する。

const ASSET_ORDER = ["stBTC", "stETH", "stSOL", "stPAXG"] as const;

// dashboard / globals.css と同じパレット
const C = {
  bg: "#0b0e11",
  panel: "#14181d",
  line: "#232a33",
  rowLine: "#1c222a",
  text: "#e6eaef",
  dim: "#8a94a3",
  amber: "#e2a33c",
  green: "#46d08a",
} as const;

export type AssetCardRow = {
  asset: string;
  stakedUsd: number | null;
  drrPct: number | null; // 24h(=前日ぶん)DRR%
  rewardUsd: number | null; // 24h リワードUSD
};

export type AssetCardData = {
  date: string; // YYYY-MM-DD(実行日)
  totalStakedUsd: number;
  totalRewardsUsd: number; // 累積 PnL(USD)
  totalRewardsPct: number | null; // 累積 PnL ÷ staked × 100
  yesterdayProfitUsd: number | null; // 前日ぶんの実測リワード(USD)
  yesterdayDrrPct: number | null; // 前日ぶんの全体DRR%
  claimableUsd: number | null; // 受取可能リワード合計(USD)
  rows: AssetCardRow[];
};

// cron / 保存済み snapshot のどちらからでも同じカードを組めるよう、入力を共通化する。
export type PerAssetInput = {
  stakedUsd?: number | null;
  price?: number | null;
  rewardUsd?: number | null;
};

export function buildAssetCard(input: {
  date: string;
  totalStakedUsd: number;
  totalRewardsUsd: number;
  totalRewardsPct: number | null;
  perAsset: Record<string, PerAssetInput>;
  able: Record<string, string | number>;
  prices: Record<string, number | null>;
  yesterdayProfitUsd: number | null;
}): AssetCardData {
  const rows: AssetCardRow[] = [];
  let claimableUsd = 0;
  let hasClaimable = false;

  for (const st of ASSET_ORDER) {
    const p = input.perAsset[st];
    if (!p) continue;
    const stakedUsd = p.stakedUsd ?? null;
    const rewardUsd = p.rewardUsd ?? null;
    const drrPct =
      rewardUsd != null && stakedUsd && stakedUsd > 0 ? (rewardUsd / stakedUsd) * 100 : null;
    rows.push({ asset: st, stakedUsd, drrPct, rewardUsd });

    const price = input.prices?.[st];
    const able = Number(input.able?.[st]);
    if (Number.isFinite(able) && able > 0 && price != null) {
      claimableUsd += able * price;
      hasClaimable = true;
    }
  }

  const yesterdayDrrPct =
    input.yesterdayProfitUsd != null && input.totalStakedUsd > 0
      ? (input.yesterdayProfitUsd / input.totalStakedUsd) * 100
      : null;

  return {
    date: input.date,
    totalStakedUsd: input.totalStakedUsd,
    totalRewardsUsd: input.totalRewardsUsd,
    totalRewardsPct: input.totalRewardsPct,
    yesterdayProfitUsd: input.yesterdayProfitUsd,
    yesterdayDrrPct,
    claimableUsd: hasClaimable ? claimableUsd : null,
    rows,
  };
}

function fmtUsd(n: number | null | undefined, frac = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return (
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })
  );
}
function fmtPct(n: number | null | undefined, d = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(d) + "%";
}

// Telegram の写真キャプション(画像が表示できない環境でも要点が分かるよう本文にも要約を入れる)。
export function assetCardCaption(c: AssetCardData): string {
  const lines = [`📊 BASIS Asset — ${c.date}`, `Staked: ${fmtUsd(c.totalStakedUsd)}`];
  if (c.yesterdayProfitUsd != null) {
    lines.push(`24h: +${fmtUsd(c.yesterdayProfitUsd, 2)} (DRR ${fmtPct(c.yesterdayDrrPct)})`);
  }
  lines.push(`Total rewards: ${fmtUsd(c.totalRewardsUsd)} (${fmtPct(c.totalRewardsPct, 2)})`);
  if (c.claimableUsd != null) lines.push(`Claimable: ${fmtUsd(c.claimableUsd, 2)}`);
  return lines.join("\n");
}

function statBox(label: string, value: string, color: string, sub: string | null, last: boolean) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        flexBasis: 0,
        backgroundColor: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        padding: 20,
        marginRight: last ? 0 : 16,
      }}
    >
      <div style={{ display: "flex", color: C.dim, fontSize: 16, letterSpacing: 1 }}>{label}</div>
      <div style={{ display: "flex", color, fontSize: 32, fontWeight: 700, marginTop: 10 }}>
        {value}
      </div>
      <div style={{ display: "flex", color: C.dim, fontSize: 16, marginTop: 6 }}>{sub ?? " "}</div>
    </div>
  );
}

function cardElement(c: AssetCardData) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.bg,
        color: C.text,
        padding: 48,
        fontFamily: "sans-serif",
      }}
    >
      {/* ヘッダ */}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", color: C.amber, fontSize: 22, fontWeight: 700, letterSpacing: 4 }}>
            BASIS
          </div>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 700, marginTop: 2 }}>
            Asset Summary
          </div>
        </div>
        <div style={{ display: "flex", color: C.dim, fontSize: 24 }}>{c.date}</div>
      </div>

      {/* 3つのサマリ */}
      <div style={{ display: "flex", flexDirection: "row", marginTop: 28 }}>
        {statBox("Total Staked", fmtUsd(c.totalStakedUsd), C.text, null, false)}
        {statBox(
          "24h Profit",
          c.yesterdayProfitUsd != null ? "+" + fmtUsd(c.yesterdayProfitUsd, 2) : "—",
          C.green,
          c.yesterdayProfitUsd != null ? "DRR " + fmtPct(c.yesterdayDrrPct) : null,
          false
        )}
        {statBox(
          "Total Rewards",
          fmtUsd(c.totalRewardsUsd),
          C.green,
          c.totalRewardsPct != null ? fmtPct(c.totalRewardsPct, 2) + " of staked" : null,
          true
        )}
      </div>

      {/* 資産別テーブル */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: 28,
          backgroundColor: C.panel,
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          padding: 22,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            color: C.dim,
            fontSize: 17,
            paddingBottom: 12,
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          <div style={{ display: "flex", width: 220 }}>Asset</div>
          <div style={{ display: "flex", flexGrow: 1, justifyContent: "flex-end" }}>Staked</div>
          <div style={{ display: "flex", width: 170, justifyContent: "flex-end" }}>DRR</div>
          <div style={{ display: "flex", width: 220, justifyContent: "flex-end" }}>Reward (24h)</div>
        </div>
        {c.rows.map((r, i) => (
          <div
            key={r.asset}
            style={{
              display: "flex",
              flexDirection: "row",
              fontSize: 22,
              paddingTop: 14,
              paddingBottom: 14,
              // Satori は undefined を border として渡すと .trim() で落ちるため、最終行は transparent にする
              borderBottom: `1px solid ${i < c.rows.length - 1 ? C.rowLine : "transparent"}`,
            }}
          >
            <div style={{ display: "flex", width: 220, fontWeight: 600 }}>{r.asset}</div>
            <div style={{ display: "flex", flexGrow: 1, justifyContent: "flex-end" }}>
              {fmtUsd(r.stakedUsd)}
            </div>
            <div style={{ display: "flex", width: 170, justifyContent: "flex-end", color: C.amber }}>
              {fmtPct(r.drrPct)}
            </div>
            <div style={{ display: "flex", width: 220, justifyContent: "flex-end", color: C.green }}>
              {r.rewardUsd != null ? "+" + fmtUsd(r.rewardUsd, 2) : "—"}
            </div>
          </div>
        ))}
        {c.rows.length === 0 ? (
          <div style={{ display: "flex", color: C.dim, fontSize: 18, paddingTop: 14 }}>
            No active staking positions
          </div>
        ) : null}
      </div>

      {/* 余白を吸収して footer を下端へ */}
      <div style={{ display: "flex", flexGrow: 1 }} />

      <div
        style={{
          display: "flex",
          flexDirection: "row",
          justifyContent: "space-between",
          color: C.dim,
          fontSize: 16,
        }}
      >
        <div style={{ display: "flex" }}>
          {c.claimableUsd != null ? "Claimable: " + fmtUsd(c.claimableUsd, 2) : " "}
        </div>
        <div style={{ display: "flex" }}>basis-tracker · api</div>
      </div>
    </div>
  );
}

// PNG バイト列を ArrayBuffer で返す(NextResponse のボディにも Telegram sendPhoto にもそのまま渡せる)。
export async function renderAssetCardPng(card: AssetCardData): Promise<ArrayBuffer> {
  const img = new ImageResponse(cardElement(card), { width: 1000, height: 680 });
  return img.arrayBuffer();
}
