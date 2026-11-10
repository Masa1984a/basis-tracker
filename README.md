# BASIS TRACKER

basis.pro の日次リワード・ステーク額を「スクショ → LLM抽出 → 例外時のみ人間が確認 → DB登録」で蓄積し、
DRRの推移と相場(BTC価格)との連動性を観察するための個人用ツール。

## 構成

- **Next.js (App Router) + TypeScript** — Vercelにそのままデプロイ
- **Vercel Postgres** — daily_rewards / snapshots / market_daily の3テーブル
- **Vercel Blob** — スクショ原本の保存(監査証跡)
- **Claude API** — 画像からのJSON抽出(既定: claude-haiku-4-5。EXTRACT_MODELで変更可)
- **Vercel Cron** — 毎日00:05 UTCにCoinGeckoからBTC価格を自動記録

## セットアップ

1. このフォルダをGitリポジトリにしてVercelにインポート
2. Vercelダッシュボード → Storage で **Postgres** と **Blob** を作成しプロジェクトに接続
   (POSTGRES_URL / BLOB_READ_WRITE_TOKEN が自動注入される)
3. Postgresの「Query」タブで `db/schema.sql` の内容を実行
4. 環境変数を設定(Settings → Environment Variables)
   - `ANTHROPIC_API_KEY`
   - `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` ← **必ず設定**(財務データを扱うため)
   - `EXTRACT_MODEL`(任意。精度を上げたければ claude-sonnet-4-5 等)
5. Deploy

ローカル開発は `npm i` → `.env.example` を `.env.local` にコピーして値を設定 → `npm run dev`
(ローカルからVercel Postgresを使う場合は `vercel env pull .env.local` が楽)

## 日々の運用

1. スマホでbasis.proの資産画面(Reward History Calendar + Total Staked が見える状態)をスクショ
2. トップページでスクショを選択 → 自動抽出
3. 「全チェック通過」ならそのまま保存。フラグが出た行だけ目視で修正して保存
4. ダッシュボードでDRR推移と想定レンジ帯、BTC価格との連動を確認

## 自動検証ルール(src/lib/validate.ts)

- DRR = profit ÷ staked が 0.5〜0.9% の妥当域に収まるか
- 日付の連続性(欠落日の検出)
- 登録済みデータとの不一致検出
- 新規profit合計 ≒ Total Rewardsの増分(±10%)

## basis.pro 内部API取得(Path B / OCR不要)

スクショ+LLM抽出の代わりに、basis.pro の内部API(`api.basis.pro/v2`)から構造化データを
直接取得して記録する経路。誤読ゼロ・全自動。Vercel Cron(`/api/basis`、毎日00:15 UTC)で動く。

**認証の仕組み**: basis.pro は Privy 認証。`auth.privy.io/api/v1/sessions` に
`refresh_token` を投げて `privy_access_token`(寿命1h)を更新し、それを Bearer として
`api.basis.pro` を叩く(`x-app-sid` に session_id を付与)。refresh_token は30日・1回限り
(使うたびローテ)。session_id を新規発行する `member/user` だけは暗号化必須なので、
種付け時にブラウザで取得した値を再利用する。

**取得項目**: `stake/stakingInfo`(資産別の total_staked / PnL / daily_roi=DRR)、
`member/assetBalance`、`reward/getAbleReward`。USD価格は CoinGecko で換算し、
`snapshots` / `daily_rewards`(USD建て、`source='api'`)に書き込むので既存ダッシュボードが
そのまま使える。資産別の忠実な記録は `basis_staking_daily`(暗号建て)に残す。

**日次リワードの帰属**: cron(00:15 UTC)実行時に「累積 total_pnl の前回スナップショットからの増分」
= 前日1日ぶんの報酬を計算し、**稼いだ日(=前日)付**で `daily_rewards` に記録する(実行日付ではない)。
同じ前日付の BTC 価格と正しく対応する。差分が取れない初回は基準スナップショットを置くだけで
リワードは記録しない(推定値で過去日を埋めない)。`basis_staking_daily` の累積スナップショットは
実行日付。レスポンスの `reward_date` が帰属日、`run_date` が実行日。

### セットアップ

1. `db/schema.sql` を再実行(`basis_session` / `basis_staking_daily` が追加される)。
   単一アカウント時代のスキーマで作成済みの DB は `db/migrations/2026-11-06_multi_account.sql` で移行する
   (→「複数アカウントの並行収集と切り替え」)
2. デプロイ後、セッションを種付け(初回のみブラウザでログイン):
   ```bash
   # ローカルで実行。専用Chromiumが開くので basis.pro にログイン → /asset 表示 → Enter
   python tools/reseed.py --account april --post-url https://<your-app>.vercel.app
   ```
   `tools/reseed.py` がトークンを取得・検証し、`/api/basis/seed`(Basic認証)へ POST する。
   `.env.local` の `BASIC_AUTH_USER/PASS` を使う。`--account` 省略時は `april`。
   `--expect-email <メール>` を付けると、ログイン中のアカウントのメールが一致しない場合は POST せず中断する。
3. 動作確認: `https://<your-app>/api/basis` を手動GET(Basic認証は対象外)。
   `{ ok: true, total_staked_usd, total_rewards_pct, ... }` が返れば成功。
4. 状態確認: `GET /api/basis/seed`(Basic認証)でアカウントごとの `status`(active / needs_reseed)と
   `last_data_date`(最後に記録できた日)を確認。

### 運用メモ

- 日次 cron が回っていればセッションは自走更新(refresh_token 30日窓)。完全失効時のみ
  `status='needs_reseed'` になり `/api/basis` が 409 を返すので、`reseed.py --account <name>` を再実行する。
- 「失効済み access token + 有効 refresh_token」での更新は**実証済み**(access token 失効後でも
  `/sessions` は 200)。なので日次間隔でも問題なし。唯一の制約は refresh_token の30日寿命なので、
  **最低でも30日に1回は cron が成功している**必要がある(日次なら当然満たす)。
- 別端末のブラウザで basis.pro にログインすると session_id が無効になり、翌 cron が
  `401 E_SESSION_CONFLICT` で失敗して `needs_reseed` になる。`reseed.py` で再シードすれば復旧する。
  (競合するのは同じアカウントのログインだけ。別アカウントのセッションには影響しない)
- cron が失敗した日は記録が欠け、復旧日の cron が欠落日ぶんをまとめて1日に計上する
  (DRR が約 k 倍に見える)。復旧日の cron 成功後に `db/fixups/split_missing_days.sql` の
  アカウントと日付2つ(最後に成功した日 / 復旧した日)を書き換えて Neon SQL Editor で1回実行すると、
  欠落日を合成して k 日に均等割りする(合計は保存。前提が崩れていれば何も変更せず中断)。

### 手動テスト(dry-run / 記録・投稿なし)

`/api/basis` を素の GET で手動実行すると **その日のデータを実際に書き込む**ため、翌日の集計に影響する:

- `basis_staking_daily` の当日行(累積 `total_pnl`)を実行時点の値で上書き → **翌 cron のリワード基準がズレる**
  (日次リワード = 翌日PnL − 当日行 の差分なので、intraday の値で上書きすると過少計上になる)
- `daily_rewards` の前日ぶんを上書き / `snapshots` に余分な行を追加 / Telegram・Discord にカードを重複投稿

これを避けて「取得〜集計〜カード内容」だけ確認したいときは **`?dry=1`** を付ける。取得と集計は本番と
同一に行い JSON を返すが、上記の書き込み・投稿は**一切しない**(レスポンスに `dry_run: true`、通知欄は
`skipped (dry-run)`)。返る数値は「本番実行したら記録される値」のプレビュー。

```bash
# 事前チェック: 記録も投稿もしない(値のプレビューのみ)
curl -H "Authorization: Bearer <CRON_SECRET>" "https://<your-app>.vercel.app/api/basis?dry=1"

# データは書かずに通知経路だけ試す(Telegram / Discord の疎通確認)
curl -H "Authorization: Bearer <CRON_SECRET>" "https://<your-app>.vercel.app/api/basis?dry=1&notify=1"
```

`?account=<name>` を付けるとそのアカウントだけを実行する(例: `?dry=1&account=masa` で masa の収集確認。
primary 以外のアカウントは `notify=1` でも投稿しない)。

唯一の副作用は Privy トークンの refresh + ローテ保存(取得に必須。cron の通常動作と同じで、リワードや
スナップショット等の**記録結果には無影響**)。このため `?dry=1` は「翌日の cron が通るか」の事前確認も
兼ねる。`CRON_SECRET` 未設定なら Bearer ヘッダは不要。

## 複数アカウントの並行収集と切り替え

basis.pro の複数アカウントを並行して収集できる。アカウントは短いラベル(`april` / `masa` など、
英小文字・数字・`_-`)で識別し、`basis_session` / `basis_staking_daily` に `account` 列で区別して記録する。
出力(グラフ・ダッシュボード・通知)に使うのは **primary アカウントだけ**。

| 記録・出力先 | primary | primary 以外(並行収集中) |
|---|---|---|
| `basis_staking_daily`(資産別の日次記録) | 記録する | 記録する |
| `snapshots` / `daily_rewards`(ダッシュボード) | 記録する | 記録しない |
| `/drr` グラフ(`/api/drr`) | 表示する(切り替え前の期間は旧 primary を換算してつなぐ。手順 4) | 表示しない |
| Telegram / Discord | 投稿する | 投稿しない |

環境変数(Vercel。変更後は再デプロイ):

- `BASIS_PRIMARY_ACCOUNT`: 出力対象のアカウント。未設定なら `april`(移行前の既存データの帰属先)。
- `BASIS_ACCOUNTS`: 毎日 cron で収集するアカウント(カンマ区切り)。primary は書かなくても含まれ、常に最初に処理される。
  1アカウントが失敗しても他アカウントの収集・通知は続行する(primary 以外の結果は `/api/basis` レスポンスの `others`)。

### april → masa への移行手順

**0. DB 移行とデプロイ(1回だけ)**

1. Neon SQL Editor で `db/migrations/2026-11-06_multi_account.sql` を実行する(既存行はすべて `april` に帰属。
   april の再シードは不要)。
2. 続けて main を push してデプロイする。移行後は旧コードが動かないので、この2つは間を空けずに行い、
   cron の時刻(09:05 / 09:15 JST)の前後は避ける。env を追加しなければ従来どおり april だけを収集する。
3. `GET /api/basis/seed` で april が `active`、`/api/basis?dry=1` が `ok: true` になることを確認する。

**1. masa を種付けする**

```bash
python tools/reseed.py --account masa --expect-email <masa のメールアドレス> --post-url https://<your-app>.vercel.app
```

- masa 用の新しいブラウザプロファイル(`.pw-basis-profile-masa/`)が開くので、**masa のアカウントで**ログインする。
  april 用のプロファイル(`.pw-basis-profile/`)でアカウントを切り替えてはいけない。april のセッションが
  無効になり、翌日の cron が `SESSION_CONFLICT` で失敗する。
- 確認: `curl -H "Authorization: Bearer <CRON_SECRET>" "https://<your-app>.vercel.app/api/basis?dry=1&account=masa"`
  が `ok: true` を返せばよい(何も記録しない)。

**2. 並行収集を始める**

- Vercel の env に `BASIS_ACCOUNTS=april,masa` を追加して再デプロイする(`BASIS_PRIMARY_ACCOUNT` は未設定 = april のまま)。
- 以後の cron は april → masa の順に収集する。グラフ・ダッシュボード・Telegram / Discord は引き続き april だけ。
  masa は初日に基準スナップショットを置くだけで、2日目からリワード(差分)が入る。

**3. 安定を確認する**

- `GET /api/basis/seed`(Basic 認証): masa が `status: active` のまま、`last_data_date` が毎日進み、`last_error` が空であること。
- 資産別 DRR を april と並べて確認する(Neon SQL Editor)。毎日両方の行がそろっていればよい。
  april は 100% ブーストをかけているので、april の値が masa の約 2 倍になるのが正常:

  ```sql
  select date, asset,
         round(max(reward_crypto / nullif(total_staked, 0) * 100) filter (where account = 'april'), 4) as april_drr,
         round(max(reward_crypto / nullif(total_staked, 0) * 100) filter (where account = 'masa'), 4) as masa_drr
  from basis_staking_daily
  where date >= current_date - 14
  group by date, asset
  order by date desc, asset;
  ```

- masa の cron が欠けた日は `db/fixups/split_missing_days.sql` を `v_account = 'masa'` / `v_primary = false` で使う
  (`basis_staking_daily` だけを補正し、`daily_rewards` には触らない)。

**4. 切り替える**

- Vercel の env を `BASIS_PRIMARY_ACCOUNT=masa` / `BASIS_ACCOUNTS=masa` にしてから再デプロイする
  (april の収集を続けるなら `BASIS_ACCOUNTS=april,masa` のまま)。cron の時刻(09:05 / 09:15 JST)の前後は避ける。
  april のセッション行と過去データは DB に残り、使われないだけになる。
- 2026-11-10 にこの手順で切り替えた。masa の値を使うのは 2026-11-11 00:15 UTC の cron から。
- 切り替え後の見え方(`src/lib/accounts.ts` の `displayStitch()`。DB の記録値は変えず、API の返り値だけを換算する):
  - **`/drr` グラフ**:
    - `basis_staking_daily.date` が 2026-11-10 以前の日は april の DRR を **1/2** にして表示する。
      april は 100% ブーストで masa の約 2 倍のため、こうすると masa の値と連続する。
    - 2026-11-11 以降は masa の値をそのまま表示する。並行収集中の masa の行(11/7〜11/10)は使わない。
  - **ダッシュボード**:
    - DRR% と 7日平均DRR は、`daily_rewards.date` が 2026-11-09 以前の日だけ 1/2 にする。
      `daily_rewards.date` は稼いだ日(実行日の前日)なので、境目が `/drr` より1日早い。
    - 日次Profit と Staked は実額のまま表示する。2026-11-10 から masa の値になり、USD 建ての値は大きく下がる。
  - **ダッシュボードの DRR% の分母**: 同じ日のリワードを書いたアカウントの `snapshots`(時刻が最も近いもの)の
    `total_staked_usd` にする。account を持たない古い snapshot は april のものとして扱う。
  - **Telegram / Discord**: 2026-11-11 の投稿から masa の値になる。
  - `BASIS_PRIMARY_ACCOUNT` が april(未設定)のあいだは連結せず、従来どおり april の値をそのまま表示する。

## Asset サマリの Telegram / Discord 投稿(daily cron の付随機能)

`/api/basis`(daily cron)が取得・記録したデータから **Asset 要約カード(PNG)** を生成し、
Telegram や Discord チャンネルに投稿する。basis.pro の実画面をブラウザで撮るのではなく、取得済みデータを
Next.js 組み込みの `ImageResponse`(`next/og` / Satori)でダーク配色のカードに描画するので、
**ブラウザ不要・追加依存ゼロ・basis セッションに非干渉**(ログイン由来の `SESSION_CONFLICT` を起こさない)。

カードの内容: Total Staked / 24h Profit(と全体 DRR%)/ 累積 Total Rewards(%)、資産別
(stBTC・stETH・stSOL・stPAXG)の Staked・DRR・24h Reward、受取可能リワード合計。
DRR は本アプリ共通の定義(`reward ÷ staked × 100`、想定レンジ 0.5〜0.9%)で算出する。

### Telegram セットアップ

1. `@BotFather` で Bot を作成し、トークンを取得。投稿先の各チャット/グループにその Bot を追加する。
2. 各投稿先の `chat_id` を取得する(グループ/チャンネルは先頭が `-`)。
3. Vercel の Environment Variables に `TELEGRAM_BOT_TOKEN` と `TELEGRAM_CHAT_ID` を設定して**再デプロイ**。
   - `TELEGRAM_BOT_TOKEN` と最低1つの投稿先が揃ったときだけ送信する。投稿先が無ければ送信せず、`/api/basis` のレスポンスは `telegram: "skipped"`。
   - 送信に失敗してもデータ記録は成功扱い(`telegram: "error: ..."` を返すだけ)。全件成功は `telegram: "sent (n/n)"`、一部失敗は `telegram: "partial (k/n): ..."`。

#### 複数の投稿先へ同時投稿

同じカードを複数のチャット/チャンネル(やフォーラムのトピック)へ同時投稿できる。投稿先 = `chat_id` + 任意の `message_thread_id`(トピック)。

- **`TELEGRAM_CHAT_ID`**(+ 任意の **`TELEGRAM_THREAD_ID`**): 主投稿先。`THREAD_ID` は主投稿先がフォーラム型グループのときに特定トピックへ送る場合のみ指定(未指定なら General)。
- **`TELEGRAM_TARGETS`**: 追加の投稿先をカンマ/セミコロン/改行区切りで列挙。各要素は `chatId` または `chatId:threadId`。

> Telegram group への通知を廃止する場合は、`TELEGRAM_CHAT_ID` / `TELEGRAM_TARGETS` のうち **group の chat_id に該当する値だけ**を Vercel の Environment Variables から外す。`TELEGRAM_TARGETS` の仕組み自体は残す。

### Discord セットアップ

Discord は Bot 実装ではなく、対象チャンネルの **Incoming Webhook** に投稿する。

1. Discord の対象チャンネルで Webhook を作成し、Webhook URL をコピーする。
2. Vercel の Environment Variables に `DISCORD_WEBHOOK_URL` を設定して**再デプロイ**。
   - `DISCORD_WEBHOOK_URL` があるときだけ送信する。未設定なら `/api/basis` のレスポンスは `discord: "skipped"`。
   - 送信に失敗してもデータ記録は成功扱い(`discord: "error: ..."` を返すだけ)。全件成功は `discord: "sent (n/n)"`、一部失敗は `discord: "partial (k/n): ..."`。
   - 複数チャンネルへ送る場合は `DISCORD_WEBHOOK_URLS` に追加 Webhook URL をカンマ/セミコロン/改行区切りで列挙できる。

PowerShell で Webhook の疎通だけ先に確認する例:

```powershell
$env:DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/..."
$body = @{ content = "basis-tracker webhook test $(Get-Date -Format s)"; allowed_mentions = @{ parse = @() } } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri $env:DISCORD_WEBHOOK_URL -ContentType "application/json" -Body $body
```

### 確認

- 画像の見た目を確認するだけなら、Telegram / Discord に投稿せず読み取り専用で
  `GET /api/basis/card`(**Basic 認証**)を開くと、直近 snapshot から同じカード PNG を返す。
- 実投稿を試すなら `/api/basis` を手動 GET(`CRON_SECRET` 設定時は
  `-H "Authorization: Bearer <CRON_SECRET>"` が必要)。ただし素の手動 GET は**当日データを書き込み +
  カードを重複投稿**するので、影響を避けたいテストは `?dry=1`(記録・投稿なし)を使う
  → 「手動テスト(dry-run)」参照。

> メモ: トークン/Chat ID / Webhook URL を貼り付けた `telegram.txt` 等は `.gitignore` 済み。値は env にのみ置き、コミットしない。

## TODO / 拡張メモ

- [ ] ファンディングレート列の自動取得(Coinglass APIキー取得後、`src/app/api/market/route.ts` に追記)
- [x] basis.proの内部エンドポイント調査 → **完了**。`api.basis.pro/v2` を特定し Path B として実装(上記)
- [ ] 日次リワード履歴カレンダーのエンドポイント特定(過去ぶんの遡及取得用。現状は日次スナップショットの差分で前進的に記録)
- [ ] `member/user` の `secure_payload` 暗号を再現できれば、種付けすらブラウザ不要(完全サーバ完結)に
- [ ] 仕様確認: 180日ロック明けに再ロックしない場合のレート(0.72% or 0.36%?)→ 出口戦略の試算に直結
- [ ] CSVエクスポート(Zenn記事用の図表作成など)

## セキュリティ注意

- Basic認証は簡易的なもの。URLは共有せず、パスワードは固有のものを設定すること
- Blobの公開URLは推測困難だが公開アクセス。スクショにウォレットアドレス等が写り込む場合は注意
