-- 手動取得(cron 以外の時刻)で作った当日行を 00:15 UTC 時点の値に補正するテンプレート
--
-- いつ使うか:
--   収集を止めていたアカウントを再開するときなど、/api/basis?account=<name> を cron 以外の時刻に
--   手動実行して basis_staking_daily に当日行を作ったとき。
--   翌日の cron は「当日行の累積 total_pnl」との差分をリワードにするので、取得が 00:15 UTC より遅い
--   ぶん翌日のリワードが少なく出る(例: 05:35 UTC 取得なら、翌日は約 18.7 時間分)。
--   当日行の total_pnl を、前回の行との線形補間で 00:15 UTC 時点の値に置き換えると、翌日の cron の
--   差分がほぼ 24 時間分になる。
--
-- 使い方:
--   1. 手動実行した日のうちに(翌日 00:15 UTC = 09:15 JST の cron より前に)実行する。
--   2. 下の v_account / v_date を書き換えて、Neon SQL Editor で DO ブロックを1回実行する。
--      全体が1トランザクションで、前提が崩れていれば例外で何も変更せず中断する(二重に補正もしない)。
--   3. 補正後、その日のうちに同じアカウントの /api/basis を ?dry=1 なしで再実行しない
--      (当日行が実測値で上書きされ、補正が消える)。
--
-- 補正内容(資産ごと。prev = v_date より前の最新行、cur = v_date の行、t1 = v_date 00:15 UTC):
--   total_pnl     = prev.total_pnl + (cur.total_pnl - prev.total_pnl)
--                   × (t1 - prev.taken_at) / (cur.taken_at - prev.taken_at)
--   reward_crypto = 補正後 total_pnl - prev.total_pnl(reward_usd / pnl_usd も同じ価格で再計算)
--   taken_at      = t1(実際の取得時刻と実測 total_pnl は raw.backdated に残す)
--   snapshots / daily_rewards には触らない。primary アカウント(手動実行で daily_rewards も書く)には使わない。
--
-- 実施履歴:
--   2026-11-12: v_account = 'april', v_date = 2026-11-12
--               (Telegram / Discord の配信を april に戻すため、11/10 以来止めていた april を 05:35 UTC に仮取得)

do $$
declare
  -- ===== ここだけ書き換える =====
  v_account text := 'april';       -- 補正するアカウント(basis_staking_daily.account)
  v_date date := '2026-11-12';     -- 手動取得した日(basis_staking_daily.date)
  -- ==============================
  t1 timestamptz := (v_date + time '00:15') at time zone 'UTC';
  n_cur int;
  n int;
  r record;
begin
  -- ---- 前提チェック(崩れていれば何もせず中断) ----
  select count(*) into n_cur from basis_staking_daily
    where account = v_account and date = v_date and total_pnl is not null;
  if n_cur = 0 then raise exception 'abort: % の % の行が無い', v_account, v_date; end if;

  if exists (select 1 from basis_staking_daily
              where account = v_account and date = v_date and raw ? 'backdated') then
    raise exception 'abort: % の % は補正済み', v_account, v_date;
  end if;

  if exists (select 1 from basis_staking_daily
              where account = v_account and date = v_date and taken_at < t1 + interval '10 minutes') then
    raise exception 'abort: % の % の行は cron 時刻(00:15 UTC)付近の取得なので補正不要', v_account, v_date;
  end if;

  -- 全資産に前回の行があり、その取得時刻が t1 より前で、reward_crypto が前回との差分そのもの(=未補正)
  select count(*) into n
    from basis_staking_daily c
    join lateral (
      select x.total_pnl, x.taken_at from basis_staking_daily x
       where x.account = c.account and x.asset = c.asset and x.date < c.date
       order by x.date desc limit 1
    ) p on true
   where c.account = v_account and c.date = v_date and c.total_pnl is not null
     and p.total_pnl is not null and p.taken_at < t1
     and c.reward_crypto is not null
     and abs(c.reward_crypto - (c.total_pnl - p.total_pnl)) <= 0.00000002;
  if n <> n_cur then
    raise exception 'abort: 前回の行がそろっていない / reward_crypto が前回との差分と一致しない (%/%)', n, n_cur;
  end if;

  -- ---- 補正 ----
  for r in
    with p as (
      select c.asset, c.total_pnl as cur_pnl, c.taken_at as cur_t, c.total_staked,
             pr.total_pnl as prev_pnl, pr.taken_at as prev_t,
             (extract(epoch from (t1 - pr.taken_at)) / extract(epoch from (c.taken_at - pr.taken_at)))::numeric as f
        from basis_staking_daily c
        join lateral (
          select x.total_pnl, x.taken_at from basis_staking_daily x
           where x.account = c.account and x.asset = c.asset and x.date < c.date
           order by x.date desc limit 1
        ) pr on true
       where c.account = v_account and c.date = v_date
    )
    update basis_staking_daily b
       set total_pnl = round(p.prev_pnl + (p.cur_pnl - p.prev_pnl) * p.f, 8),
           reward_crypto = round(p.prev_pnl + (p.cur_pnl - p.prev_pnl) * p.f, 8) - p.prev_pnl,
           reward_usd = round(greatest(round(p.prev_pnl + (p.cur_pnl - p.prev_pnl) * p.f, 8) - p.prev_pnl, 0)
                              * b.price_usd, 2),
           pnl_usd = round(round(p.prev_pnl + (p.cur_pnl - p.prev_pnl) * p.f, 8) * b.price_usd, 2),
           raw = coalesce(b.raw, '{}'::jsonb) || jsonb_build_object('backdated', jsonb_build_object(
                   'measured_total_pnl', p.cur_pnl,
                   'measured_at', p.cur_t,
                   'note', format('手動取得(%s)の値を %s 時点に線形補間(係数 %s)', p.cur_t, t1, round(p.f, 4)))),
           taken_at = t1
      from p
     where b.account = v_account and b.date = v_date and b.asset = p.asset
    returning b.asset, round(p.f, 4) as f, p.cur_pnl, b.total_pnl, b.reward_crypto,
              round(b.reward_crypto / nullif(p.total_staked, 0) * 100, 4) as reward_pct
  loop
    raise notice '%: 係数 % / total_pnl % → % / 前回からの reward % (% %%)',
      r.asset, r.f, r.cur_pnl, r.total_pnl, r.reward_crypto, r.reward_pct;
  end loop;
  raise notice 'done: account=%, date=%, % 行を % 時点に補正', v_account, v_date, n_cur, t1;
end $$;

-- ---- 確認(補正後に実行。アカウントと日付は上に合わせる) ----
-- select date, asset, taken_at, total_pnl, reward_crypto,
--        round(reward_crypto / nullif(total_staked, 0) * 100, 4) as reward_pct,
--        raw->'backdated'->>'measured_total_pnl' as measured_total_pnl
--   from basis_staking_daily
--  where account = 'april' and date between '2026-11-10' and '2026-11-12'
--  order by date, asset;
