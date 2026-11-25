"""reseed_auto.py — basis.pro セッションの再シードを1コマンドで行う(人が手元の Mac で実行する用)。

使い方:
    python3 tools/reseed_auto.py            # april を再シード(ログイン不要なら全自動)
    python3 tools/reseed_auto.py --check    # 再シードせず、今のセッションが cron で使えるかだけ確認
    python3 tools/reseed_auto.py --login    # ログインが必要なとき: ブラウザでログインしてから続行

動作(既定):
  1. 事前チェック: .env.local の設定、cron の時間帯(00:05〜00:30 UTC = 09:05〜09:30 JST)でないこと。
  2. 専用プロファイルのブラウザで basis.pro を開き、ログイン済みならトークンを採取する。
     未ログイン(メールアドレスとワンタイムコードの入力が必要)なら、待たずに exit 10 で終了する。
  3. 純HTTPで [トークン更新 → データ取得] を再現し、ログイン中のメールが期待どおりか確かめる。
  4. 本番の /api/basis/seed に POST して DB のセッションを更新する。
  5. 本番の /api/basis?account=<name>&dry=1(記録も投稿もしない)で、cron と同じ経路が通るか確認する。
  本番の記録・投稿(?dry=1 なしの /api/basis)は行わない。今朝の分の投稿が欠けていたら案内だけ出す。

終了コード(最後の行に RESULT=<名前> exit=<番号> を出す):
   0  OK               再シード完了(--check: セッションは有効)
   1  UNEXPECTED       想定外のエラー
   2  CONFIG           .env.local の設定不足・引数の誤り・プロファイルが無い
   3  CRON_WINDOW      cron の時間帯なので中止(時間をずらすか --force)
  10  LOGIN_REQUIRED   ログインが必要(メールアドレスとワンタイムコードの入力)→ --login で再実行
  11  WRONG_ACCOUNT    プロファイルが別のアカウントでログインしている
  12  BROWSER_TIMEOUT  ページがログイン状態にもログイン画面にもならなかった(通信・表示の遅れ)→ 再実行
  20  REFRESH_FAILED   トークン更新に失敗(Privy のセッション終了を含む)→ --login で再実行
  21  BASIS_API_FAILED basis の API 取得に失敗(直後に別端末で開いた等)→ 再実行
  30  SEED_FAILED      本番への登録(/api/basis/seed)に失敗
  40  VERIFY_FAILED    登録後の本番確認(dry-run)に失敗
  50  SESSION_INVALID  (--check)セッションが無効。再シードが必要

.env.local に必要な値: BASIC_AUTH_USER / BASIC_AUTH_PASS / CRON_SECRET /
  BASIS_LOGIN_EMAIL_<ACCOUNT>(例 BASIS_LOGIN_EMAIL_APRIL。ログイン中のアカウントの確認用)
任意: BASIS_APP_URL(既定 https://basis-tracker-smoky.vercel.app)
"""
import argparse, base64, json, sys, urllib.parse
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reseed  # noqa: E402  同じ tools/ の採取・検証ロジックを共用する

PROJECT = reseed.PROJECT
DEFAULT_URL = "https://basis-tracker-smoky.vercel.app"
CRON_WINDOW_UTC = ((0, 5), (0, 30))  # この間は cron(00:15 UTC)と同時にトークンを更新して壊すおそれがある

EXIT = {
    "OK": 0, "UNEXPECTED": 1, "CONFIG": 2, "CRON_WINDOW": 3,
    "LOGIN_REQUIRED": 10, "WRONG_ACCOUNT": 11, "BROWSER_TIMEOUT": 12,
    "REFRESH_FAILED": 20, "BASIS_API_FAILED": 21,
    "SEED_FAILED": 30, "VERIFY_FAILED": 40, "SESSION_INVALID": 50,
}
# reseed.verify() の失敗理由 → 終了コード名
VERIFY_REASON = {
    "no_refresh_token": "REFRESH_FAILED",
    "refresh_failed": "REFRESH_FAILED",
    "refresh_no_tokens": "REFRESH_FAILED",
    "wrong_account": "WRONG_ACCOUNT",
    "no_app_token": "BASIS_API_FAILED",
    "api_failed": "BASIS_API_FAILED",
}


class Stop(Exception):
    def __init__(self, name, message, next_step=None):
        super().__init__(message)
        self.name, self.message, self.next_step = name, message, next_step


def load_env():
    env = {}
    f = PROJECT / ".env.local"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def in_cron_window(now):
    (h1, m1), (h2, m2) = CRON_WINDOW_UTC
    t = now.hour * 60 + now.minute
    return h1 * 60 + m1 <= t < h2 * 60 + m2


def get_json(url, headers):
    st, body = reseed.http("GET", url, headers)
    try:
        return st, json.loads(body)
    except Exception:
        return st, {"raw": body[:200]}


def basic_auth(env):
    raw = f"{env['BASIC_AUTH_USER']}:{env['BASIC_AUTH_PASS']}".encode()
    return {"authorization": "Basic " + base64.b64encode(raw).decode()}


def account_status(env, url, account):
    st, j = get_json(f"{url}/api/basis/seed", basic_auth(env))
    if st != 200:
        return None
    return next((a for a in j.get("accounts", []) if a.get("account") == account), None)


def server_dry_run(env, url, account):
    """本番の cron と同じ経路(トークン更新 → basis 取得)を記録・投稿なしで通す。"""
    q = urllib.parse.urlencode({"account": account, "dry": "1"})
    return get_json(f"{url}/api/basis?{q}", {"authorization": f"Bearer {env['CRON_SECRET']}"})


def print_status(label, a):
    if a is None:
        print(f"[{label}] 状態を取得できませんでした(/api/basis/seed)", flush=True)
    else:
        print(f"[{label}] {a['account']}: status={a['status']} last_data={a.get('last_data_date')} "
              f"updated={a.get('updated_at')} last_error={a.get('last_error')}", flush=True)


def guard_cron_window(clock, args, step):
    """cron(00:15 UTC)とトークン更新が重ならないよう、各ステップの直前に実時刻で確かめる。
    --login でログインを待つあいだに時間帯に入った場合もここで止める。"""
    if in_cron_window(clock()) and not args.force:
        raise Stop("CRON_WINDOW", f"cron(09:15 JST)の前後に入ったため、{step}の前で中止しました"
                   "(トークン更新が cron と競合するため)",
                   "09:30(JST)以降に再実行(急ぐ場合のみ --force)")


def login_cmd(account):
    extra = "" if account == reseed.LEGACY_ACCOUNT else f" --account {account}"
    return f"python3 tools/reseed_auto.py{extra} --login"


def run(args, env, clock):
    account = args.account
    url = (args.url or env.get("BASIS_APP_URL") or DEFAULT_URL).rstrip("/")

    # ---- 1. 事前チェック ----
    email_key = f"BASIS_LOGIN_EMAIL_{account.upper().replace('-', '_')}"
    expect_email = args.expect_email or env.get(email_key)
    missing = [k for k in ("BASIC_AUTH_USER", "BASIC_AUTH_PASS", "CRON_SECRET") if not env.get(k)]
    if not args.check and not expect_email:
        missing.append(email_key)  # メール確認なしでは POST しない(別アカウントのセッションで上書きする事故を防ぐ)
    if missing:
        raise Stop("CONFIG", f".env.local に {', '.join(missing)} がありません",
                   f".env.local に {missing[0]}=... を追記して再実行")
    guard_cron_window(clock, args, "開始")

    before = account_status(env, url, account)
    print_status("before", before)

    # ---- --check: 再シードせずに確認だけ ----
    if args.check:
        guard_cron_window(clock, args, "確認")
        st, j = server_dry_run(env, url, account)
        if st == 200 and j.get("ok"):
            return "OK", "セッションは有効です(cron と同じ経路で取得できました)", None
        if st == 409:
            return ("SESSION_INVALID", f"セッションが無効です: {j.get('detail') or j.get('error')}",
                    f"python3 tools/reseed_auto.py{'' if account == reseed.LEGACY_ACCOUNT else ' --account ' + account}")
        raise Stop("VERIFY_FAILED", f"確認に失敗しました: HTTP {st} {j}", "時間をおいて再実行")

    reseed.PROFILE, reseed.OUT = reseed.paths_for(account)
    if not reseed.PROFILE.exists() and not args.login:
        raise Stop("CONFIG", f"ブラウザのプロファイル {reseed.PROFILE.name} がありません", login_cmd(account))

    # ---- 2. ブラウザでトークン採取 ----
    print(f"[i] {account} のプロファイルで basis.pro を開きます", flush=True)
    secrets, got = reseed.extract(args.login_wait, interactive=args.login, timeout_s=args.timeout)
    if got.get("login_required"):
        raise Stop("LOGIN_REQUIRED", "ログインが必要です(メールアドレスとワンタイムコードの入力)", login_cmd(account))
    if not got["sid"]:
        if args.login:
            raise Stop("LOGIN_REQUIRED", "ログインを確認できないまま待機時間が終わりました", login_cmd(account))
        raise Stop("BROWSER_TIMEOUT", f"{args.timeout} 秒以内にログイン状態を確認できませんでした",
                   "再実行。ブラウザにログイン画面が出ていた場合は " + login_cmd(account))

    # ---- 3. 純HTTPで検証(メール確認を含む) ----
    guard_cron_window(clock, args, "トークン更新")
    ok, reason = reseed.verify(secrets, expect_email)
    if not ok:
        name = VERIFY_REASON.get(reason, "UNEXPECTED")
        # ログイン済みのプロファイルでは --login でもログイン画面が出ないので、別アカウントのときは
        # プロファイルを退避してから新しいプロファイルでログインし直す。
        relogin = f"mv {reseed.PROFILE.name} {reseed.PROFILE.name}.bak && {login_cmd(account)}"
        hint = {"REFRESH_FAILED": f"再実行。続く場合は {relogin}",
                "WRONG_ACCOUNT": f"{relogin}(正しいアカウントでログイン)",
                "BASIS_API_FAILED": "少し時間をおいて再実行"}.get(name)
        raise Stop(name, f"検証に失敗しました({reason})", hint)

    # ---- 4. 本番へ登録 ----
    guard_cron_window(clock, args, "本番への登録")
    st, body = reseed.post_seed(secrets, url, account)
    if st != 200:
        raise Stop("SEED_FAILED", f"/api/basis/seed が HTTP {st} を返しました: {body[:200]}",
                   ".env.local の BASIC_AUTH_USER / BASIC_AUTH_PASS と URL を確認")

    # ---- 5. 本番の cron と同じ経路で確認(記録・投稿なし) ----
    guard_cron_window(clock, args, "本番での確認")
    st, j = server_dry_run(env, url, account)
    if not (st == 200 and j.get("ok")):
        raise Stop("VERIFY_FAILED", f"登録後の確認(dry-run)が HTTP {st}: {j.get('detail') or j.get('error') or j}",
                   "再実行(続く場合は Claude Code に相談)")
    after = account_status(env, url, account)
    print_status("after", after)

    # 今朝の cron が失敗していた場合の案内(投稿の補完はここでは行わない)
    now = clock()
    today = now.strftime("%Y-%m-%d")
    (end_h, end_m) = CRON_WINDOW_UTC[1]
    if after and after.get("last_data_date") != today and now.hour * 60 + now.minute >= end_h * 60 + end_m:
        print(f"[注意] {account} の {today} の記録がありません。今朝の cron が失敗していた可能性があります。"
              " 投稿の補完が必要なら Claude Code に依頼してください。", flush=True)
    return "OK", "再シードが完了しました(本番の cron と同じ経路で確認済み)", None


def main(argv=None, clock=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--account", default=reseed.LEGACY_ACCOUNT, help="既定 april")
    ap.add_argument("--check", action="store_true", help="再シードせず、今のセッションが有効かだけ確認")
    ap.add_argument("--login", action="store_true", help="ログインが必要なとき: ブラウザでのログインを待ってから続行")
    ap.add_argument("--login-wait", type=int, default=600, help="--login 時にログインを待つ秒数(既定 600)")
    ap.add_argument("--timeout", type=int, default=90, help="ログイン状態の判定を待つ秒数(既定 90)")
    ap.add_argument("--expect-email", default=None, help="既定は .env.local の BASIS_LOGIN_EMAIL_<ACCOUNT>")
    ap.add_argument("--url", default=None, help=f"アプリの URL(既定 BASIS_APP_URL または {DEFAULT_URL})")
    ap.add_argument("--force", action="store_true", help="cron の時間帯でも実行する")
    args = ap.parse_args(argv)
    args.account = args.account.strip().lower()
    clock = clock or (lambda: datetime.now(timezone.utc))

    try:
        if not reseed.ACCOUNT_RE.match(args.account):
            raise Stop("CONFIG", f"--account が不正: {args.account}")
        name, message, next_step = run(args, load_env(), clock)
    except Stop as s:
        name, message, next_step = s.name, s.message, s.next_step
    except Exception as e:  # noqa: BLE001
        name, message, next_step = "UNEXPECTED", f"{type(e).__name__}: {e}", None

    mark = "✅" if name == "OK" else "✗"
    print(f"\n{mark} {message}")
    if next_step:
        print(f"   次の操作: {next_step}")
    print(f"RESULT={name} exit={EXIT[name]}")
    return EXIT[name]


if __name__ == "__main__":
    sys.exit(main())
