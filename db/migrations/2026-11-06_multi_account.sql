-- 複数アカウント並行収集への移行(2026-11-06)
--
-- 変更内容:
--   basis_session      : 単一行(id=1)→ account(アカウントのラベル)を主キーにして複数行を許す
--   basis_staking_daily: 主キー (date, asset) → (account, date, asset)
--   既存行はすべて account = 'april' に帰属させる(現在トラッキング中のアカウント)。
--   snapshots / daily_rewards / market_daily は変更なし(出力対象 = primary アカウントだけが書く)。
--
-- 使い方:
--   Neon SQL Editor で DO ブロックを1回実行する。1文=1トランザクションなので、途中で失敗すれば
--   何も変わらない。移行済みなら何もせず notice を出して終わる(再実行しても安全)。
--
-- 注意(デプロイ順):
--   移行後は旧コードの `on conflict (date, asset)` / `where id = 1` が動かなくなる。
--   cron(00:05 / 00:15 UTC = 09:05 / 09:15 JST)の前後を避け、この SQL の実行と
--   新コードのデプロイ(main への push)を続けて行う。april の再シードは不要(行はそのまま引き継ぐ)。

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = current_schema()
                and table_name = 'basis_session' and column_name = 'account') then
    raise notice 'skip: 移行済み(basis_session.account が既にある)';
    return;
  end if;

  -- ---- basis_session ----
  alter table basis_session add column account text not null default 'april';
  alter table basis_session alter column account drop default; -- 以後は必ず明示させる
  alter table basis_session drop constraint if exists basis_session_singleton;
  alter table basis_session drop constraint basis_session_pkey;
  alter table basis_session drop column id;
  alter table basis_session add primary key (account);

  -- ---- basis_staking_daily ----
  alter table basis_staking_daily add column account text not null default 'april';
  alter table basis_staking_daily alter column account drop default;
  alter table basis_staking_daily drop constraint basis_staking_daily_pkey;
  alter table basis_staking_daily add primary key (account, date, asset);

  raise notice 'done: basis_session / basis_staking_daily を account 単位に移行(既存行は april)';
end $$;

-- ---- 確認 ----
-- select account, status, updated_at from basis_session;
-- select account, count(*), min(date), max(date) from basis_staking_daily group by account;
