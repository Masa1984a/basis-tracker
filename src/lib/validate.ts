import { Extraction, Validation } from "./types";

// DRRの想定レンジ(公称0.72%に対する妥当域)。逸脱は要確認フラグ。
const DRR_MIN = 0.005;
const DRR_MAX = 0.009;

export function validateExtraction(
  ex: Extraction,
  existing: Record<string, number>, // 登録済み date -> profit_usd
  prevTotalRewards: number | null
): Validation {
  const rowFlags = (ex.daily || []).map((r) => {
    const flags: string[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) flags.push("日付形式が不正");
    if (!(r.profit_usd > 0)) flags.push("profitが0以下");
    if (ex.total_staked_usd && ex.total_staked_usd > 0) {
      const drr = r.profit_usd / ex.total_staked_usd;
      if (drr < DRR_MIN || drr > DRR_MAX)
        flags.push(`DRR ${(drr * 100).toFixed(3)}% が想定レンジ(0.5〜0.9%)外`);
    }
    if (
      existing[r.date] !== undefined &&
      Math.abs(existing[r.date] - r.profit_usd) > 0.001
    )
      flags.push(`登録済みの値($${existing[r.date]})と不一致`);
    return { date: r.date, flags };
  });

  const globalFlags: string[] = [];

  // 日付の連続性チェック
  const dates = (ex.daily || []).map((r) => r.date).sort();
  for (let i = 1; i < dates.length; i++) {
    const a = new Date(dates[i - 1] + "T00:00:00Z").getTime();
    const b = new Date(dates[i] + "T00:00:00Z").getTime();
    if ((b - a) / 86400000 > 1)
      globalFlags.push(`${dates[i - 1]} と ${dates[i]} の間に欠落日があります`);
  }

  // 整合性: 新規行のprofit合計 ≒ Total Rewardsの増分
  if (prevTotalRewards != null && ex.total_rewards_usd != null) {
    const newSum = (ex.daily || [])
      .filter((r) => existing[r.date] === undefined)
      .reduce((s, r) => s + r.profit_usd, 0);
    const delta = ex.total_rewards_usd - prevTotalRewards;
    if (newSum > 0 && Math.abs(delta - newSum) > Math.max(1, newSum * 0.1))
      globalFlags.push(
        `Rewards増分 $${delta.toFixed(2)} と新規profit合計 $${newSum.toFixed(2)} が乖離(±10%超)`
      );
  }

  const ok =
    globalFlags.length === 0 && rowFlags.every((f) => f.flags.length === 0);
  return { rowFlags, globalFlags, ok };
}
