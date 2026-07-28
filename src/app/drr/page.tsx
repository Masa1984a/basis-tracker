"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

type DrrRow = { date: string; BTC?: number; ETH?: number; PAXG?: number; SOL?: number };

const ASSETS = [
  { key: "BTC", color: "#4f8ef7" },
  { key: "ETH", color: "#34a853" },
  { key: "PAXG", color: "#f59e0b" },
  { key: "SOL", color: "#f472b6" },
] as const;

function fmtDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00Z");
  return `${(d.getUTCMonth() + 1).toString().padStart(2, "0")}/${d.getUTCDate().toString().padStart(2, "0")}`;
}

function fmtPct(v: number) {
  return v.toFixed(2) + "%";
}

export default function DrrPage() {
  const [data, setData] = useState<DrrRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/drr")
      .then((r) => r.json())
      .then((j) => setData(j.data || []))
      .finally(() => setLoading(false));
  }, []);

  const latest = data[data.length - 1];
  const dateRange =
    data.length >= 2
      ? `${fmtDate(data[0].date).replace("/", "-")} 〜 ${fmtDate(data[data.length - 1].date).replace("/", "-")}`
      : "";

  return (
    <div style={{ padding: "24px 16px", maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
        資産別 日次DRR（Daily Reward Rate = reward ÷ staked × 100）
      </h1>
      <p style={{ fontSize: 13, color: "var(--dim, #888)", marginBottom: 24 }}>
        basis.pro ステーキング · {dateRange}
      </p>

      {loading ? (
        <p style={{ color: "var(--dim, #888)" }}>読み込み中…</p>
      ) : data.length === 0 ? (
        <p style={{ color: "var(--dim, #888)" }}>データがありません</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={400}>
            <LineChart data={data} margin={{ top: 8, right: 80, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.2)" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtDate}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={(v) => v.toFixed(1) + "%"}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                domain={["auto", "auto"]}
                width={42}
              />
              <Tooltip
                formatter={(v: number, name: string) => [fmtPct(v), name]}
                labelFormatter={fmtDate}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend verticalAlign="bottom" height={36} iconType="circle" iconSize={8} />
              <ReferenceLine
                y={0.5}
                stroke="rgba(128,128,128,0.4)"
                strokeDasharray="4 4"
                label={{ value: "想定レンジ 0.5–0.9%", position: "insideTopLeft", fontSize: 11, fill: "#888" }}
              />
              {ASSETS.map(({ key, color }) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={color}
                  strokeWidth={2}
                  dot={{ r: 3, fill: color }}
                  activeDot={{ r: 5 }}
                  connectNulls
                  label={
                    latest?.[key] != null
                      ? {
                          value: `${key}  ${fmtPct(latest[key]!)}`,
                          position: "right",
                          fontSize: 11,
                          fill: color,
                          dx: 4,
                        }
                      : undefined
                  }
                />
              ))}
            </LineChart>
          </ResponsiveContainer>

          <div style={{ marginTop: 16, display: "flex", gap: 24, flexWrap: "wrap" }}>
            {ASSETS.map(({ key, color }) =>
              latest?.[key] != null ? (
                <div key={key} style={{ fontSize: 14 }}>
                  <span style={{ color, fontWeight: 700 }}>{key}</span>
                  <span style={{ marginLeft: 6 }}>{fmtPct(latest[key]!)}</span>
                </div>
              ) : null
            )}
          </div>
        </>
      )}
    </div>
  );
}
