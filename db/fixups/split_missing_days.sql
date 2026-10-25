-- cron 欠落日の補正テンプレート(basis_staking_daily / daily_rewards の均等割り)
--
-- いつ使うか:
--   /api/basis の cron が SESSION_CONFLICT 等で失敗した日があり、再シード後に cron が復旧したとき。
--   復旧した日の cron は「最後に成功した日の行」を基準に差分を取るので、
--     basis_staking_daily: 復旧日の行の reward_* が k 日分 / 失敗日の行が欠落
--     daily_rewards      : 復旧日の前日行が k 日分 / それより前の欠落日の行が無い
--   になる。これを k 日に均等割りする(合計は保存)。
--
-- 使い方:
--   1. 復旧日の cron が成功したのを確認する(GET /api/basis/seed が active、/api/drr に復旧日の行)。
--   2. 下の v_last_ok / v_next_ok を書き換える(末尾の確認用 SELECT の日付も)。
--   3. Neon SQL Editor で DO ブロックを1回実行する。全体が1トランザクションで、
--      前提が崩れていれば例外で何も変更せず中断する(二重に割ることもない)。
--
-- 日付の意味(src/app/api/basis/route.ts と同じ):
--   basis_staking_daily の行 D の reward_* = D-1 に得たリワード(D 実行時の累積 total_pnl の差分)
--   daily_rewards の行 D = D に稼いだ分
-- 補正内容(k = v_next_ok - v_last_ok):
--   basis_staking_daily: 欠落日 (v_last_ok, v_next_ok) の行を total_pnl の線形補間で合成し、
--     合成行と復旧日の行の reward_* を Δ/k ずつにする(raw に synthetic: true)。
--     価格・staked 等は復旧日の値を流用する(過去日の値は取得できないため)。
--   daily_rewards: 復旧日の前日行の k 日分 P を [v_last_ok, v_next_ok - 1] の k 日に P/k ずつ
--     (端数は最終日に寄せて合計を保存、source = 'api-split')。
--
-- 実施履歴:
--   2026-10-25: v_last_ok = 2026-10-23, v_next_ok = 2026-10-25(10-24 の cron が SESSION_CONFLICT)

do $$
declare
  -- ===== ここだけ書き換える =====
  v_last_ok date := '2026-10-23';  -- 失敗前に最後に cron が成功した日
  v_next_ok date := '2026-10-25';  -- 失敗後に初めて cron が成功した日
  -- ==============================
  k int;
  n int;
  n_next int;
  p numeric;
  share numeric;
begin
  k := v_next_ok - v_last_ok;
  if k < 2 then raise exception 'abort: 欠落日が無い (k=%)', k; end if;

  -- ---- 前提チェック(崩れていれば何もせず中断) ----
  if exists (select 1 from basis_staking_daily where date > v_last_ok and date < v_next_ok) then
    raise exception 'abort: % 〜 % の間に basis_staking_daily 行が既にある(補正済み/日付の指定違い)',
      v_last_ok, v_next_ok;
  end if;
  select count(*) into n_next from basis_staking_daily
    where date = v_next_ok and total_pnl is not null
      and reward_crypto is not null and reward_usd is not null;
  if n_next = 0 then raise exception 'abort: % の行(cron 復旧分)が無い', v_next_ok; end if;
  select count(*) into n from basis_staking_daily b
    join basis_staking_daily a on a.asset = b.asset and a.date = v_last_ok
    where b.date = v_next_ok and a.total_pnl is not null;
  if n <> n_next then
    raise exception 'abort: % と % で資産がそろっていない (%/%)', v_last_ok, v_next_ok, n, n_next;
  end if;
  -- 復旧日の reward_crypto が v_last_ok からの k 日分の差分そのものであること(=未補正)
  if exists (select 1 from basis_staking_daily b
               join basis_staking_daily a on a.asset = b.asset and a.date = v_last_ok
              where b.date = v_next_ok and b.reward_crypto <> b.total_pnl - a.total_pnl) then
    raise exception 'abort: % の reward_crypto が % からの差分と一致しない(補正済み?)', v_next_ok, v_last_ok;
  end if;
  if exists (select 1 from daily_rewards where date >= v_last_ok and date < v_next_ok - 1) then
    raise exception 'abort: daily_rewards の % 〜 % に既に行がある', v_last_ok, v_next_ok - 2;
  end if;
  select profit_usd into p from daily_rewards where date = v_next_ok - 1 and source = 'api';
  if p is null then raise exception 'abort: daily_rewards % (source=api) が無い', v_next_ok - 1; end if;

  -- ---- basis_staking_daily: 欠落日の行を合成(total_pnl を線形補間) ----
  insert into basis_staking_daily
    (date, asset, total_staked, locked_amount, total_pnl, daily_roi, price_usd,
     staked_usd, pnl_usd, reward_crypto, reward_usd, raw, taken_at)
  select v_last_ok + i, b.asset, b.total_staked, b.locked_amount,
         a.total_pnl + (b.total_pnl - a.total_pnl) * i / k,
         b.daily_roi, b.price_usd, b.staked_usd,
         round((a.total_pnl + (b.total_pnl - a.total_pnl) * i / k) * b.price_usd, 2),
         (b.total_pnl - a.total_pnl) / k,
         round(b.reward_usd / k, 2),
         jsonb_build_object('synthetic', true,
           'note', format('cron 欠落の補正: %s〜%s の差分を %s 日に均等割り', v_last_ok, v_next_ok, k)),
         ((v_last_ok + i) + time '00:15') at time zone 'UTC'
  from generate_series(1, k - 1) as i
  cross join basis_staking_daily b
  join basis_staking_daily a on a.asset = b.asset and a.date = v_last_ok
  where b.date = v_next_ok;

  -- ---- basis_staking_daily: 復旧日の行を 1/k に ----
  update basis_staking_daily
     set reward_crypto = reward_crypto / k,
         reward_usd = round(reward_usd / k, 2)
   where date = v_next_ok;

  -- ---- daily_rewards: k 日分 P を k 日に均等割り(端数は最終日、合計は保存) ----
  share := round(p / k, 3);
  insert into daily_rewards (date, profit_usd, source)
    select v_last_ok + i, share, 'api-split' from generate_series(0, k - 2) as i;
  update daily_rewards
     set profit_usd = p - share * (k - 1), source = 'api-split', updated_at = now()
   where date = v_next_ok - 1;

  raise notice 'done: k=%, 合成 % 行, daily_rewards % × % + 最終日 %',
    k, n_next * (k - 1), share, k - 1, p - share * (k - 1);
end $$;

-- ---- 確認(補正後に実行。日付は v_last_ok 〜 v_next_ok に合わせる) ----
-- select date, asset, total_pnl, round(reward_crypto / total_staked * 100, 3) as drr_pct, reward_usd,
--        raw->>'synthetic' as synthetic
--   from basis_staking_daily where date between '2026-10-23' and '2026-10-25' order by date, asset;
-- select date, profit_usd, source from daily_rewards where date between '2026-10-23' and '2026-10-25' order by date;
