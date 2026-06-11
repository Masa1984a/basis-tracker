"""reseed.py — basis.pro セッションを再取得し、Path B の全連鎖を純HTTPで検証する。
本番の初期セットアップ(種付け)ツールも兼ねる。

動作:
  1. 専用プロファイルのヘッドフル Chromium で /asset を開く。
     未ログインなら画面でログイン → ターミナルで Enter(または別ターミナルから --stop)。
  2. /sessions レスポンス(token/privy_access_token/refresh_token)と
     basis API の app_bearer・session_id を採取 → debug/session_secrets.json。
  3. 純HTTPで [refresh → データ取得] を実行し、basis用トークンのフィールドを確定。
     回転した refresh_token は即保存。
  4. (任意) --post-url 指定時は seed を /api/basis/seed に Basic 認証付きで POST。
"""
import argparse, base64, json, sys, time, urllib.request, urllib.error, ssl
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8")
    except Exception: pass

from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parent.parent
PROFILE = PROJECT / ".pw-basis-profile"
OUT = PROJECT / "debug" / "session_secrets.json"
SENTINEL = PROJECT / "debug" / ".reseed_done"
APP_ID = "cmo84wtol002q0cihr61zf6gg"
CTX = ssl.create_default_context()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"


def claims(tok):
    try:
        p = tok.split(".")[1]; p += "=" * (-len(p) % 4)
        c = json.loads(base64.urlsafe_b64decode(p))
        return {"aud": c.get("aud"), "exp_in_min": round((c.get("exp", 0) - time.time()) / 60, 1), "len": len(tok)}
    except Exception:
        return {"len": len(tok) if isinstance(tok, str) else None}


def http(method, url, headers, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(r, timeout=30, context=CTX) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as ex:
        return ex.code, ex.read().decode("utf-8", "replace")
    except Exception as ex:
        return None, f"{type(ex).__name__}: {ex}"


def wait_for_login(wait_s):
    try:
        input()
        return
    except EOFError:
        pass
    print(f"[i] 非対話: 最大 {wait_s}s 待機。別ターミナルで `python tools/reseed.py --stop` でも確定。", flush=True)
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if SENTINEL.exists():
            try: SENTINEL.unlink()
            except Exception: pass
            return
        time.sleep(2)


def extract(wait_s):
    secrets = {"privy": {}, "basis": {}, "captured_headers": {}}
    got = {"sessions": False, "sid": False}
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE), headless=False, no_viewport=True,
            args=["--disable-blink-features=AutomationControlled"])
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_response(resp):
            try:
                req = resp.request; url = resp.url
                if "auth.privy.io/api/v1/sessions" in url and req.method == "POST":
                    try:
                        j = resp.json()
                        for k in ("token", "privy_access_token", "refresh_token"):
                            if j.get(k): secrets["privy"][k] = j[k]
                        secrets["privy"]["sessions_keys"] = list(j.keys())
                        got["sessions"] = True
                    except Exception: pass
                    secrets["captured_headers"]["privy_sessions"] = {
                        k: v for k, v in req.headers.items() if not k.startswith(":")}
                if "api.basis.pro/v2/" in url:
                    h = {k.lower(): v for k, v in req.headers.items() if not k.startswith(":")}
                    if "authorization" in h and "app_bearer" not in secrets["basis"]:
                        secrets["basis"]["app_bearer"] = h["authorization"].split(" ", 1)[-1]
                    if "x-app-sid" in h:
                        secrets["basis"]["session_id"] = h["x-app-sid"]; got["sid"] = True
            except Exception: pass

        page.on("response", on_response)
        print("[i] /asset を開きます。未ログインなら画面でログインし、表示できたら Enter。", flush=True)
        try: page.goto("https://basis.pro/asset", wait_until="networkidle", timeout=60000)
        except Exception as e: print(f"[warn] goto: {e}", flush=True)
        page.wait_for_timeout(3000)

        # まだ認証付き呼び出しが無ければログイン待ち
        if not got["sid"]:
            print("=" * 60 + "\n[操作] ログイン後 /asset を表示し、Enter を押してください。\n" + "=" * 60, flush=True)
            try:
                if SENTINEL.exists(): SENTINEL.unlink()
            except Exception: pass
            wait_for_login(wait_s)
        # 再読込してトークン更新と api 呼び出しを誘発
        try:
            page.goto("https://basis.pro/asset", wait_until="networkidle", timeout=60000)
            page.wait_for_timeout(4000)
        except Exception as e: print(f"[warn] reload: {e}", flush=True)

        # localStorage / cookie の保険回収
        try:
            ls = page.evaluate("() => { const o={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=localStorage.getItem(k);} return o; }")
            for k, v in ls.items():
                if "privy" in k.lower() and ("token" in k.lower() or "refresh" in k.lower()):
                    secrets["privy"].setdefault("from_localStorage", {})[k] = v
        except Exception: pass
        try: ctx.close()
        except Exception: pass
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(secrets, ensure_ascii=False, indent=2), encoding="utf-8")
    return secrets, got


def save(secrets):
    OUT.write_text(json.dumps(secrets, ensure_ascii=False, indent=2), encoding="utf-8")


def verify(secrets):
    privy = secrets["privy"]; basis = secrets["basis"]
    ls = privy.get("from_localStorage", {})
    refresh_token = privy.get("refresh_token") or ls.get("privy:refresh_token")
    pat = privy.get("privy_access_token") or ls.get("privy:token")
    if not refresh_token:
        print("✗ refresh_token を採取できず。ログイン状態を確認して再実行。"); return False

    tmpl = secrets.get("captured_headers", {}).get("privy_sessions", {})
    sh = {"accept": "application/json", "content-type": "application/json", "privy-app-id": APP_ID,
          "privy-client": tmpl.get("privy-client", "react-auth:3.16.0"), "user-agent": UA,
          "origin": "https://basis.pro", "referer": "https://basis.pro/"}
    if tmpl.get("privy-ca-id"): sh["privy-ca-id"] = tmpl["privy-ca-id"]
    if pat: sh["authorization"] = f"Bearer {pat}"

    print("\n=== [1] /sessions refresh (純HTTP) ===")
    st, body = http("POST", "https://auth.privy.io/api/v1/sessions", sh, {"refresh_token": refresh_token})
    print(f"   -> {st}")
    if not (st and st < 300):
        print("   body:", body[:200]); return False
    j = json.loads(body)
    # 回転した refresh_token を即保存
    if j.get("refresh_token"):
        privy["refresh_token"] = j["refresh_token"]
        privy.setdefault("from_localStorage", {})["privy:refresh_token"] = j["refresh_token"]
    if j.get("privy_access_token"): privy["privy_access_token"] = j["privy_access_token"]
    if j.get("token"): privy["token"] = j["token"]
    save(secrets)
    print("   保存済み。戻りキー:", list(j.keys()))

    # basis 用トークン = aud==APP_ID のもの を自動選別
    candidates = {"token": j.get("token"), "privy_access_token": j.get("privy_access_token"),
                  "app_bearer": basis.get("app_bearer")}
    app_token, app_field = None, None
    for name, tok in candidates.items():
        if not tok: continue
        c = claims(tok)
        print(f"   {name}: aud={c.get('aud')} exp_in={c.get('exp_in_min')}min len={c.get('len')}")
        if c.get("aud") == APP_ID and app_token is None:
            app_token, app_field = tok, name
    print(f"   => basis用トークン = '{app_field}' (aud={APP_ID})")
    secrets["basis"]["app_token_field"] = app_field
    save(secrets)

    sid = basis.get("session_id")
    if not (app_token and sid):
        print("✗ app_token か session_id が無い。"); return False

    print("\n=== [2] データ取得(refresh済みトークン + 再利用 session_id)===")
    bh = {"accept": "application/json, text/plain, */*", "authorization": f"Bearer {app_token}",
          "origin": "https://basis.pro", "referer": "https://basis.pro/", "user-agent": UA,
          "x-client-version": "web-1.0.0", "x-app-sid": sid}
    ok_all = True
    for name, path in [("stakingInfo", "/v2/stake/stakingInfo"),
                       ("assetBalance", "/v2/member/assetBalance"),
                       ("getAbleReward", "/v2/reward/getAbleReward")]:
        st, body = http("GET", f"https://api.basis.pro{path}", bh)
        ok = st and st < 300; ok_all = ok_all and ok
        print(f"   {name:14} -> {st} {'OK '+str(len(body))+'B' if ok else body[:120]}")
        if ok and name == "stakingInfo":
            for a, d in json.loads(body).get("data", {}).items():
                if d.get("status") == "Active":
                    print(f"        {a}: staked={d['total_staked']} pnl={d['total_pnl']} roi={d['daily_roi']}%")
    if ok_all:
        print("\n✅ Path B 全連鎖を refresh 後トークンで再現(=Vercel Cron 流れの実証)")
    return ok_all


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stop", action="store_true")
    ap.add_argument("--wait", type=int, default=600)
    ap.add_argument("--verify-only", action="store_true", help="ブラウザを起動せず既存 secrets で検証")
    ap.add_argument("--post-url", default=None, help="seed を POST する先(例 https://app.vercel.app)。.env.local の BASIC_AUTH を使用")
    a = ap.parse_args()
    if a.stop:
        SENTINEL.parent.mkdir(parents=True, exist_ok=True); SENTINEL.write_text("stop", encoding="utf-8")
        print("stop シグナル送信"); return

    if a.verify_only:
        secrets = json.loads(OUT.read_text(encoding="utf-8"))
    else:
        secrets, got = extract(a.wait)
        if not got["sid"]:
            print("✗ 認証付き呼び出しを検出できず(未ログインの可能性)。"); sys.exit(1)
    ok = verify(secrets)

    if ok and a.post_url:
        post_seed(secrets, a.post_url)
    sys.exit(0 if ok else 1)


def post_seed(secrets, base_url):
    """seed を /api/basis/seed に Basic 認証で POST(.env.local から認証情報を読む)。"""
    env = {}
    envf = PROJECT / ".env.local"
    if envf.exists():
        for line in envf.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1); env[k.strip()] = v.strip()
    user = env.get("BASIC_AUTH_USER"); pw = env.get("BASIC_AUTH_PASS")
    privy = secrets["privy"]
    payload = {
        "refresh_token": privy.get("refresh_token"),
        "privy_access_token": privy.get("privy_access_token"),
        "session_id": secrets["basis"].get("session_id"),
    }
    headers = {"content-type": "application/json"}
    if user and pw:
        headers["authorization"] = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()
    st, body = http("POST", base_url.rstrip("/") + "/api/basis/seed", headers, payload)
    print(f"\n=== seed POST -> {st} {body[:200]}")


if __name__ == "__main__":
    main()
