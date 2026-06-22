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

1. `db/schema.sql` を再実行(`basis_session` / `basis_staking_daily` が追加される)
2. デプロイ後、セッションを種付け(初回のみブラウザでログイン):
   ```bash
   # ローカルで実行。専用Chromiumが開くので basis.pro にログイン → /asset 表示 → Enter
   python tools/reseed.py --post-url https://<your-app>.vercel.app
   ```
   `tools/reseed.py` がトークンを取得・検証し、`/api/basis/seed`(Basic認証)へ POST する。
   `.env.local` の `BASIC_AUTH_USER/PASS` を使う。
3. 動作確認: `https://<your-app>/api/basis` を手動GET(Basic認証は対象外)。
   `{ ok: true, total_staked_usd, total_rewards_pct, ... }` が返れば成功。
4. 状態確認: `GET /api/basis/seed`(Basic認証)で `status`(active / needs_reseed)を確認。

### 運用メモ

- 日次 cron が回っていればセッションは自走更新(refresh_token 30日窓)。完全失効時のみ
  `status='needs_reseed'` になり `/api/basis` が 409 を返すので、`reseed.py` を再実行する。
- 「失効済み access token + 有効 refresh_token」での更新は**実証済み**(access token 失効後でも
  `/sessions` は 200)。なので日次間隔でも問題なし。唯一の制約は refresh_token の30日寿命なので、
  **最低でも30日に1回は cron が成功している**必要がある(日次なら当然満たす)。

## Asset サマリの Telegram / Discord 投稿(daily cron の付随機能)

`/api/basis`(daily cron)が取得・記録したデータから **Asset 要約カード(PNG)** を生成し、
Telegram や Discord チャンネルに投稿する。basis.pro の実画面をブラウザで撮るのではなく、取得済みデータを
Next.js 組み込みの `ImageResponse`(`next/og` / Satori)でダーク配色のカードに描画するので、
**ブラウザ不要・追加依存ゼロ・basis セッションに非干渉**(ログイン由来の `SESSION_CONFLICT` を起こさない)。

カードの内容: Total Staked / 24h Profit(と全体 DRR%)/ 累積 Total Rewards(%)、資産別
(stBTC・stETH・stSOL・stPAXG)の Staked・DRR・24h Reward、受取可能リワード合計。
DRR は本アプリ共通の定義(`reward ÷ staked × 100`、想定レンジ 0.5〜0.9%)で算出する。

### Telegram セットアップ

1. `@BotFather` で Bot を作成し、トークンを取得。投稿先の各グループ/チャンネルにその Bot を追加する。
2. 各投稿先の `chat_id` を取得(グループ/チャンネルは先頭が `-`)。
3. Vercel の Environment Variables に `TELEGRAM_BOT_TOKEN` と `TELEGRAM_CHAT_ID` を設定して**再デプロイ**。
   - `TELEGRAM_BOT_TOKEN` と最低1つの投稿先が揃ったときだけ送信する。投稿先が無ければ送信せず、`/api/basis` のレスポンスは `telegram: "skipped"`。
   - 送信に失敗してもデータ記録は成功扱い(`telegram: "error: ..."` を返すだけ)。全件成功は `telegram: "sent (n/n)"`、一部失敗は `telegram: "partial (k/n): ..."`。

#### 複数の投稿先へ同時投稿

同じカードを複数のグループ/チャンネル(やフォーラムのトピック)へ同時投稿できる。投稿先 = `chat_id` + 任意の `message_thread_id`(トピック)。

- **`TELEGRAM_CHAT_ID`**(+ 任意の **`TELEGRAM_THREAD_ID`**): 主投稿先。`THREAD_ID` は主投稿先がフォーラム型グループのときに特定トピックへ送る場合のみ指定(未指定なら General)。
- **`TELEGRAM_TARGETS`**: 追加の投稿先をカンマ/セミコロン/改行区切りで列挙。各要素は `chatId` または `chatId:threadId`。

例) 既存グループに加えて別グループ `-1009876543210` にも投稿(`TELEGRAM_CHAT_ID` は既存のまま):

```
TELEGRAM_TARGETS=-1009876543210
```

例) 別グループの特定トピック `#42` と、さらに別グループにも投稿:

```
TELEGRAM_TARGETS=-1009876543210:42,-1005555555555
```

> Bot は投稿先ごとにそのグループ/チャンネルへ追加が必要(未追加だとその投稿先だけ失敗し、`telegram: "partial (...)"` で理由が返る)。同一 chat+thread の重複指定は自動で除去される。

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
  `-H "Authorization: Bearer <CRON_SECRET>"` が必要)。

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
