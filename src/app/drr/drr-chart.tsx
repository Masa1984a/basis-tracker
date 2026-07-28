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
} from "recharts";

type DrrRow = { date: string; BTC?: number; ETH?: number; PAXG?: number; SOL?: number };

const ASSETS = [
  { key: "BTC", color: "#4f8ef7" },
  { key: "ETH", color: "#34a853" },
  { key: "PAXG", color: "#f59e0b" },
  { key: "SOL", color: "#f472b6" },
] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(dateStr: string) {
  return new Date(dateStr + "T00:00:00Z");
}

function fmtDate(dateStr: string) {
  const d = parseDate(dateStr);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function fmtPct(v: number) {
  return v.toFixed(2) + "%";
}

// Line の label にオブジェクトを渡すと全データ点にラベルが付くため、
// 最終データ点にだけ「BTC 0.38%」形式で描くカスタムラベルを使う。
function makeEndLabel(key: string, color: string, lastIndex: number) {
  return function EndLabel(props: { x?: number; y?: number; index?: number; value?: number }) {
    const { x, y, index, value } = props;
    // recharts の型上 null は返せないので、スキップする点では空要素を返す
    if (index !== lastIndex || value == null || x == null || y == null) return <g />;
    return (
      <text x={x + 8} y={y} fill={color} fontSize={11} dominantBaseline="middle">
        {`${key} ${fmtPct(value)}`}
      </text>
    );
  };
}

export default function DrrChart() {
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
      ? `${fmtDate(data[0].date)} – ${fmtDate(latest.date)}, ${parseDate(latest.date).getUTCFullYear()}`
      : "";

  return (
    <>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Daily Reward Rate by Asset</h1>
      <p style={{ fontSize: 13, color: "var(--dim, #888)", margin: "0 0 4px" }}>
        basis.pro staking · DRR = daily reward ÷ amount staked × 100
        {dateRange && ` · ${dateRange}`}
      </p>
      <p style={{ fontSize: 13, color: "var(--dim, #888)", margin: "0 0 24px" }}>
        Rates include the 180-day lock bonus (+100%) — the base DRR is roughly half these figures.
      </p>

      {loading ? (
        <p style={{ color: "var(--dim, #888)" }}>Loading…</p>
      ) : data.length === 0 ? (
        <p style={{ color: "var(--dim, #888)" }}>No data available</p>
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
              {ASSETS.map(({ key, color }) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={color}
                  strokeWidth={2}
                  dot={{ r: 3, fill: color }}
                  activeDot={{ r: 5 }}
                  isAnimationActive={false}
                  connectNulls
                  label={makeEndLabel(key, color, data.length - 1)}
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
    </>
  );
}
