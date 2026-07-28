import type { Metadata } from "next";
import QRCode from "qrcode";
import DrrChart from "./drr-chart";

const REFERRAL_URL = "https://basis.pro/register/RMJC3854";

export const metadata: Metadata = {
  title: "Daily Reward Rate by Asset — BASIS TRACKER",
  description: "Daily staking reward rates for BTC, ETH, PAXG and SOL on basis.pro.",
};

export default async function DrrPage() {
  const qrSvg = await QRCode.toString(REFERRAL_URL, {
    type: "svg",
    // 静穏域は SVG 側に持たせず、白ボックスの padding で確保する(下の padding は
    // 見た目の余白ではなくスキャンに必要な要素)。小さい表示でもモジュールを太く保つため。
    margin: 0,
    width: 88,
    // スキャン成功率のため、暗い背景ページでも QR 自体は白地・濃色モジュールにする。
    color: { dark: "#0b0e11", light: "#ffffff" },
  });

  return (
    <div lang="en" style={{ padding: "24px 16px", maxWidth: 900, margin: "0 auto" }}>
      <DrrChart />

      <section className="panel" style={{ marginTop: 40 }}>
        <h2>Referral link</h2>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div
            style={{ background: "#fff", borderRadius: 6, padding: 10, lineHeight: 0, flexShrink: 0 }}
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <p style={{ fontSize: 14, margin: "0 0 12px" }}>
              Sign up for basis.pro with my referral link and stake $100 or more by July 31, 2026 to
              receive a 0.005 PAXG airdrop.
            </p>
            <a
              href={REFERRAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="num"
              style={{ fontSize: 13, color: "var(--amber)", wordBreak: "break-all" }}
            >
              {REFERRAL_URL}
            </a>
            <p style={{ fontSize: 12, color: "var(--dim)", margin: "14px 0 0" }}>
              DYOR. NFA. Staking rewards vary and past rates do not predict future returns.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
