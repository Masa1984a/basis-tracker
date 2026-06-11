-- basis-tracker schema
create table if not exists daily_rewards (
  date date primary key,
  profit_usd numeric(12,3) not null,
  source text not null default 'screenshot',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists snapshots (
  id bigserial primary key,
  taken_at timestamptz not null default now(),
  total_staked_usd numeric(14,2),
  total_rewards_usd numeric(14,2),
  total_rewards_pct numeric(8,4),
  staking_wallet_usd numeric(14,2),
  blob_url text,
  raw_json jsonb
);

create table if not exists market_daily (
  date date primary key,
  btc_price_usd numeric(12,2),
  funding_avg_pct numeric(10,6),
  fetched_at timestamptz not null default now()
);

-- ===== basis.pro 内部API(Path B)用 =====
-- Privy セッションの保管(単一行 id=1)。refresh_token は使うたびローテーションするので
-- /api/basis 実行のたびに上書きされる。tools/reseed.py または /api/basis/seed で種付けする。
create table if not exists basis_session (
  id int primary key default 1,
  refresh_token text not null,        -- Privy リフレッシュトークン(30日・1回限り)
  privy_access_token text,            -- /sessions 呼び出し用(期限切れでも可)
  session_id text not null,           -- basis の x-app-sid(member/user が発行)
  status text not null default 'active', -- active | needs_reseed
  last_error text,
  updated_at timestamptz not null default now(),
  constraint basis_session_singleton check (id = 1)
);

-- basis API から取得した資産別の日次スナップショット(暗号建ての忠実な記録)。
-- USD 換算値も併記してダッシュボード(USD建て)と接続する。
create table if not exists basis_staking_daily (
  date date not null,
  asset text not null,                -- stBTC / stETH / stSOL / stPAXG
  total_staked numeric(24,8),
  locked_amount numeric(24,8),
  total_pnl numeric(24,8),
  realized_pnl numeric(24,8),
  unrealized_pnl numeric(24,8),
  able_reward numeric(24,8),          -- 受取可能リワード
  balance numeric(24,8),              -- ウォレット残高(st建て)
  daily_roi numeric(8,4),             -- API が返す日次ROI(= DRR)
  price_usd numeric(16,4),            -- 取得時の原資産USD価格(CoinGecko)
  staked_usd numeric(16,2),
  pnl_usd numeric(16,2),
  reward_crypto numeric(24,8),        -- 前日比 Δtotal_pnl(その日に得たリワード)
  reward_usd numeric(16,2),
  raw jsonb,
  taken_at timestamptz not null default now(),
  primary key (date, asset)
);
