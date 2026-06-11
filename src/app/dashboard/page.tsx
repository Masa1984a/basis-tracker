"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis,
  Tooltip, ReferenceArea, CartesianGrid, Legend,
} from "recharts";

type Entry = {
  date: string;
  profit_usd: number;
  btc_price_usd: number | null;
  total_staked_usd: number | null;
  drr_pct: number | null;
};

export default function Dashboard() {
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    fetch("/api/entries?limit=180")
      .then((r) => r.json())
      .then((j) => setEntries((j.entries || []).reverse())) // 古い順に並べ替え
      .catch(() => {});
  }, []);

  const data = useMemo(
    () => entries.map((e) => ({ ...e, label: e.date.slice(5) })),
    [entries]
  );

  const avg7 = useMemo(() => {
    const last = entries.slice(-7).map((e) => e.drr_pct).filter((v): v is number => v != null);
    if (!last.length) return null;
    return last.reduce((a, b) => a + b, 0) / last.length;
  }, [entries]);

  const latest = entries[entries.length - 1];

  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="label">7日平均DRR</div>
          <div className="value amber">{avg7 != null ? avg7.toFixed(3) + "%" : "—"}</div>
        </div>
        <div className="stat">
          <div className="label">直近Staked</div>
          <div className="value">{latest?.total_staked_usd != null ? "$" + latest.total_staked_usd.toLocaleString() : "—"}</div>
        </div>
        <div className="stat">
          <div className="label">記録日数</div>
          <div className="value">{entries.length}日</div>
        </div>
      </div>

      <div className="panel">
        <h2>DRRの推移 — 帯は想定レンジ(0.5〜0.9%)。帯の外と「不自然なほどの一定」が観察ポイント</h2>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid stroke="#232a33" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "#8a94a3", fontSize: 11 }} minTickGap={28} />
            <YAxis domain={[0, 1.1]} tick={{ fill: "#8a94a3", fontSize: 11 }} unit="%" />
            <Tooltip
              contentStyle={{ background: "#14181d", border: "1px solid #232a33", borderRadius: 8 }}
              labelStyle={{ color: "#8a94a3" }}
            />
            <ReferenceArea y1={0.5} y2={0.9} fill="#e2a33c" fillOpacity={0.08} stroke="#e2a33c" strokeOpacity={0.25} />
            <Line type="monotone" dataKey="drr_pct" name="DRR %" stroke="#e2a33c" dot={false} strokeWidth={2} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="panel">
        <h2>日次Profit と BTC価格 — 相場との連動性チェック</h2>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 0, left: -16, bottom: 0 }}>
            <CartesianGrid stroke="#232a33" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "#8a94a3", fontSize: 11 }} minTickGap={28} />
            <YAxis yAxisId="l" tick={{ fill: "#8a94a3", fontSize: 11 }} unit="$" />
            <YAxis yAxisId="r" orientation="right" tick={{ fill: "#8a94a3", fontSize: 11 }} width={56}
              domain={["auto", "auto"]} tickFormatter={(v: number) => (v / 1000).toFixed(0) + "k"} />
            <Tooltip
              contentStyle={{ background: "#14181d", border: "1px solid #232a33", borderRadius: 8 }}
              labelStyle={{ color: "#8a94a3" }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="l" dataKey="profit_usd" name="Profit (USD)" fill="#46d08a" fillOpacity={0.7} radius={[3, 3, 0, 0]} />
            <Line yAxisId="r" type="monotone" dataKey="btc_price_usd" name="BTC (USD)" stroke="#8a94a3" dot={false} strokeWidth={1.5} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="dim msg">BTC価格は毎日00:05 UTCのCronで自動記録。ファンディングレート列は今後追加(api/market/route.ts のTODO参照)。</p>
      </div>
    </>
  );
}
