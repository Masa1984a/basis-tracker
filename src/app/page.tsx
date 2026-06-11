"use client";

import { useEffect, useState } from "react";
import type { Extraction, Validation } from "@/lib/types";

type ExtractResult = { extraction: Extraction; validation: Validation; blob_url: string | null };
type Entry = { date: string; profit_usd: number; drr_pct: number | null; total_staked_usd: number | null };

export default function Home() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [rows, setRows] = useState<{ date: string; profit_usd: number }[]>([]);
  const [snapshot, setSnapshot] = useState<Partial<Extraction>>({});
  const [msg, setMsg] = useState("");
  const [recent, setRecent] = useState<Entry[]>([]);

  const loadRecent = () =>
    fetch("/api/entries?limit=10")
      .then((r) => r.json())
      .then((j) => setRecent(j.entries || []))
      .catch(() => {});

  useEffect(() => {
    loadRecent();
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setMsg("");
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) {
        setMsg(j.error || "抽出に失敗しました");
        return;
      }
      setResult(j);
      setRows(j.extraction.daily || []);
      setSnapshot({
        total_staked_usd: j.extraction.total_staked_usd,
        total_rewards_usd: j.extraction.total_rewards_usd,
        total_rewards_pct: j.extraction.total_rewards_pct,
        staking_wallet_usd: j.extraction.staking_wallet_usd,
      });
    } catch {
      setMsg("通信エラーが発生しました");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows,
          snapshot,
          blob_url: result?.blob_url,
          raw: result?.extraction,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsg("保存に失敗しました");
        return;
      }
      setMsg(`${j.saved}件を保存しました`);
      setResult(null);
      setRows([]);
      loadRecent();
    } catch {
      setMsg("通信エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  const flagsFor = (date: string) =>
    result?.validation.rowFlags.find((f) => f.date === date)?.flags || [];

  return (
    <>
      <div className="panel">
        <h2>スクリーンショットを登録</h2>
        <label className="filebox" style={{ display: "block", cursor: "pointer" }}>
          {busy ? "解析中…" : "basis.proの資産画面のスクショを選択(タップ)"}
          <input type="file" accept="image/*" onChange={onFile} disabled={busy} style={{ display: "none" }} />
        </label>
        {msg && <p className="msg amber">{msg}</p>}
      </div>

      {result && (
        <div className="panel">
          <h2>抽出結果の確認 {result.validation.ok ? <span className="badge ok">全チェック通過</span> : <span className="badge warn">要確認あり</span>}</h2>

          {result.validation.globalFlags.map((f, i) => (
            <p key={i} className="msg red">⚠ {f}</p>
          ))}

          <table>
            <thead>
              <tr><th>日付</th><th>Profit (USD)</th><th>チェック</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.date + i}>
                  <td>
                    <input
                      type="date"
                      value={r.date}
                      onChange={(e) => {
                        const v = [...rows];
                        v[i] = { ...v[i], date: e.target.value };
                        setRows(v);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.001"
                      value={r.profit_usd}
                      onChange={(e) => {
                        const v = [...rows];
                        v[i] = { ...v[i], profit_usd: Number(e.target.value) };
                        setRows(v);
                      }}
                    />
                  </td>
                  <td>
                    {flagsFor(r.date).length === 0 ? (
                      <span className="badge ok">OK</span>
                    ) : (
                      flagsFor(r.date).map((f, j) => <span key={j} className="badge warn">{f}</span>)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 12 }} className="dim">
            Total Staked: <span className="num">${snapshot.total_staked_usd ?? "—"}</span> ／
            Total Rewards: <span className="num">${snapshot.total_rewards_usd ?? "—"}</span>
          </div>

          <div style={{ marginTop: 14 }}>
            <button className="primary" onClick={save} disabled={busy || rows.length === 0}>
              確認して保存
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>直近の記録</h2>
        {recent.length === 0 ? (
          <p className="dim">まだ記録がありません。最初のスクショを登録しましょう。</p>
        ) : (
          <table>
            <thead>
              <tr><th>日付</th><th>Profit</th><th>DRR</th></tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.date}>
                  <td className="num">{e.date}</td>
                  <td className="num green">+${e.profit_usd.toFixed(3)}</td>
                  <td className="num">{e.drr_pct != null ? e.drr_pct.toFixed(3) + "%" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
