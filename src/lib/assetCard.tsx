import { ImageResponse } from "next/og";

// basis.pro の Asset 画面に相当する「資産サマリ・カード(PNG)」を、cron が取得済みのデータから生成する。
// ブラウザ不要(Next.js 組み込みの ImageResponse / Satori でJSX→PNG)。ダッシュボードと同じダーク配色。
//
// 各資産について 2 系統の指標を併記する:
//   - coin 建て(= 純ステーキング利回り): rewardCrypto / staked。価格が約分されるため価格非依存。
//     basis.pro が実際に付与した「増えた通貨量」とその利回り。
//   - USD 建て(= 価格変動込み総合リターン): ポジションUSD価値(equity = staked_usd + pnl_usd)の
//     前日差分とその%。リワードに加え原資産の価格変動を含むため coin 建て利回りとは別物(負もあり得る)。
// ※ Satori の既定フォントは Latin のみのため、画像内テキストは ASCII に限定する(日本語は豆腐になる)。

const ASSET_ORDER = ["stBTC", "stETH", "stSOL", "stPAXG"] as const;
const ST_TO_BASE: Record<string, string> = {
  stBTC: "BTC",
  stETH: "ETH",
  stSOL: "SOL",
  stPAXG: "PAXG",
};

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
  red: "#e3645d",
} as const;

export type AssetCardRow = {
  asset: string;
  baseTicker: string; // BTC / ETH / SOL / PAXG
  stakedUsd: number | null;
  drrPct: number | null; // coin 建て=USD建てで同値の純ステーキング利回り%
  rewardUsd: number | null; // リワードの当日価格でのUSD換算(キャプション/後方互換)
  tokenReward: number | null; // rewardCrypto(増えた通貨量。claim 等で負もあり得る)
  usdReturnUsd: number | null; // 価格変動込み総合リターン(USD)
  usdReturnPct: number | null; // 価格変動込み総合リターン%
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
  staked?: number | null; // ステーク中の通貨量(coin 建てDRRの分母)
  rewardCrypto?: number | null; // 前日比 Δtotal_pnl(増えた通貨量)
  baseTicker?: string | null; // BTC / ETH / SOL / PAXG
  usdReturnUsd?: number | null; // 価格変動込み総合リターン(USD)
  usdReturnPct?: number | null; // 価格変動込み総合リターン%
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
    const tokenReward = p.rewardCrypto ?? null;
    // coin 建てDRR = rewardUsd / stakedUsd(価格が約分されるので coin/USD で同値、従来表示と一致)。
    const drrPct =
      rewardUsd != null && stakedUsd && stakedUsd > 0 ? (rewardUsd / stakedUsd) * 100 : null;
    rows.push({
      asset: st,
      baseTicker: p.baseTicker ?? ST_TO_BASE[st] ?? "",
      stakedUsd,
      drrPct,
      rewardUsd,
      tokenReward,
      usdReturnUsd: p.usdReturnUsd ?? null,
      usdReturnPct: p.usdReturnPct ?? null,
    });

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
// 符号付き USD(総合リターンは負もあり得る)。ASCII のみ(Satori フォント都合)。
function fmtSignedUsd(n: number | null | undefined, frac = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const body = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });
  return (n < 0 ? "-$" : "+$") + body;
}
function fmtSignedPct(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return (n < 0 ? "-" : "+") + Math.abs(n).toFixed(d) + "%";
}
// 通貨量(増えた token)。桁数は大きさに応じて可変。符号付き。
function fmtToken(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const d = a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : a >= 0.0001 ? 6 : 8;
  const body = a.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
  return (n < 0 ? "-" : "+") + body;
}
function signColor(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return C.dim;
  return n < 0 ? C.red : C.green;
}

// Telegram の写真キャプション(画像が表示できない環境でも要点が分かるよう本文にも要約を入れる)。
export function assetCardCaption(c: AssetCardData): string {
  const lines = [`📊 BASIS Asset — ${c.date}`, `Staked: ${fmtUsd(c.totalStakedUsd)}`];
  if (c.yesterdayProfitUsd != null) {
    lines.push(`24h reward: +${fmtUsd(c.yesterdayProfitUsd, 2)} (DRR ${fmtPct(c.yesterdayDrrPct)})`);
  }
  lines.push(`Total rewards: ${fmtUsd(c.totalRewardsUsd)} (${fmtPct(c.totalRewardsPct, 2)})`);
  if (c.claimableUsd != null) lines.push(`Claimable: ${fmtUsd(c.claimableUsd, 2)}`);
  // 資産別: coin 建てリワード(増えた通貨量)と USD 建て総合リターン(価格変動込み)。
  const per = c.rows
    .filter((r) => r.tokenReward != null || r.usdReturnUsd != null)
    .map(
      (r) =>
        `${r.asset}: ${fmtToken(r.tokenReward)} ${r.baseTicker} (DRR ${fmtPct(r.drrPct)})` +
        ` · USD ${fmtSignedUsd(r.usdReturnUsd)} (${fmtSignedPct(r.usdReturnPct)})`
    );
  if (per.length) lines.push("", ...per);
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

// 右寄せの2段ヘッダセル(主見出し + dim の補助見出しで coin / USD を区別)。
function headerCell(main: string, sub: string, width: number) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width, alignItems: "flex-end" }}>
      <div style={{ display: "flex" }}>{main}</div>
      <div style={{ display: "flex", fontSize: 12, marginTop: 2 }}>{sub}</div>
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
          marginTop: 24,
          backgroundColor: C.panel,
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          padding: 22,
        }}
      >
        {/* 凡例: coin = 価格非依存の純利回り / USD = 価格変動込み総合リターン */}
        <div style={{ display: "flex", color: C.dim, fontSize: 14, marginBottom: 10 }}>
          coin = staking yield (price-independent) · USD = total return incl. price
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            color: C.dim,
            fontSize: 15,
            paddingBottom: 12,
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          <div style={{ display: "flex", width: 200 }}>Asset</div>
          <div style={{ display: "flex", flexGrow: 1, justifyContent: "flex-end" }}>Staked</div>
          {headerCell("Reward", "coin", 230)}
          {headerCell("DRR", "coin", 130)}
          {headerCell("P/L", "USD total", 250)}
          {headerCell("DRR", "USD total", 150)}
        </div>
        {c.rows.map((r, i) => (
          <div
            key={r.asset}
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              fontSize: 20,
              paddingTop: 14,
              paddingBottom: 14,
              // Satori は undefined を border として渡すと .trim() で落ちるため、最終行は transparent にする
              borderBottom: `1px solid ${i < c.rows.length - 1 ? C.rowLine : "transparent"}`,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", width: 200 }}>
              <div style={{ display: "flex", fontWeight: 600 }}>{r.asset}</div>
              <div style={{ display: "flex", color: C.dim, fontSize: 13 }}>{r.baseTicker}</div>
            </div>
            <div style={{ display: "flex", flexGrow: 1, justifyContent: "flex-end" }}>
              {fmtUsd(r.stakedUsd)}
            </div>
            <div
              style={{
                display: "flex",
                width: 230,
                justifyContent: "flex-end",
                color: signColor(r.tokenReward),
              }}
            >
              {r.tokenReward != null ? `${fmtToken(r.tokenReward)} ${r.baseTicker}` : "—"}
            </div>
            <div style={{ display: "flex", width: 130, justifyContent: "flex-end", color: C.amber }}>
              {fmtPct(r.drrPct)}
            </div>
            <div
              style={{
                display: "flex",
                width: 250,
                justifyContent: "flex-end",
                color: signColor(r.usdReturnUsd),
              }}
            >
              {fmtSignedUsd(r.usdReturnUsd)}
            </div>
            <div
              style={{
                display: "flex",
                width: 150,
                justifyContent: "flex-end",
                color: signColor(r.usdReturnPct),
              }}
            >
              {fmtSignedPct(r.usdReturnPct)}
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
  const img = new ImageResponse(cardElement(card), { width: 1280, height: 768 });
  return img.arrayBuffer();
}
