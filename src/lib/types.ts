export type DailyRow = { date: string; profit_usd: number };

export type Extraction = {
  total_staked_usd: number | null;
  total_rewards_usd: number | null;
  total_rewards_pct: number | null;
  staking_wallet_usd: number | null;
  funding_wallet_usd: number | null;
  daily: DailyRow[];
};

export type RowFlag = { date: string; flags: string[] };
export type Validation = { rowFlags: RowFlag[]; globalFlags: string[]; ok: boolean };
