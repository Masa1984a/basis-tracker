"""extract_session.py — まだログイン状態の専用プロファイルから、最新の Privy トークンを取り出す。

目的: Path B(サーバ側だけで完結する直 API 取得)が成立するかを検証するための材料採取。
- ヘッドレスで /asset を開く → Privy SDK が裏でトークン更新(/sessions)するのを捕捉。
- /sessions レスポンス(token / privy_access_token / refresh_token)と、
  api.basis.pro 呼び出しの Authorization・x-app-sid を採取。
- 取れなければ localStorage / cookie からも回収。
- 機微値(トークン)は debug/session_secrets.json にローカル保存し、標準出力には出さない。

使い方:
    python tools/extract_session.py            # ヘッドレス
    python tools/extract_session.py --headed   # CFでこける場合
"""
import argparse, json, sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8")
    except Exception: pass

from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parent.parent
PROFILE = PROJECT / ".pw-basis-profile"
OUT = PROJECT / "debug" / "session_secrets.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="https://basis.pro/asset")
    a = ap.parse_args()

    secrets = {"privy": {}, "basis": {}, "captured_headers": {}}
    saw = {"sessions_resp": False, "api_200": False, "member_user": False}

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE),
            headless=not a.headed,
            no_viewport=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_response(resp):
            try:
                req = resp.request
                url = resp.url
                # Privy refresh response = 最新トークン三点セット
                if "auth.privy.io/api/v1/sessions" in url and req.method == "POST":
                    try:
                        j = resp.json()
                        for k in ("token", "privy_access_token", "refresh_token", "session_update_action"):
                            if k in j:
                                secrets["privy"][k] = j[k]
                        saw["sessions_resp"] = True
                        print("[got] /sessions response (fresh privy tokens)", flush=True)
                    except Exception as e:
                        print(f"[warn] sessions json: {e}", flush=True)
                    # refresh に使ったリクエスト側ヘッダ雛形も保存
                    h = {k: v for k, v in req.headers.items() if not k.startswith(":")}
                    secrets["captured_headers"]["privy_sessions"] = h
                    try:
                        secrets["privy"]["sessions_request_body"] = req.post_data
                    except Exception:
                        pass
                # basis api call = Authorization(420) と x-app-sid を確定
                if "api.basis.pro/v2/" in url:
                    h = {k.lower(): v for k, v in req.headers.items() if not k.startswith(":")}
                    if "authorization" in h and "app_bearer" not in secrets["basis"]:
                        secrets["basis"]["app_bearer"] = h["authorization"].split(" ", 1)[-1]
                    if "x-app-sid" in h:
                        secrets["basis"]["session_id"] = h["x-app-sid"]
                        secrets["captured_headers"]["basis_api"] = {
                            k: ("<bearer>" if k == "authorization" else
                                "<sid>" if k == "x-app-sid" else v)
                            for k, v in h.items()}
                    if resp.status == 200:
                        saw["api_200"] = True
                    if "/member/user" in url:
                        saw["member_user"] = True
                        try:
                            secrets["basis"]["member_user"] = resp.json().get("user", {})
                        except Exception:
                            pass
            except Exception as e:
                print(f"[net-err] {e}", flush=True)

        page.on("response", on_response)

        print(f"[i] open {a.url} (headless={not a.headed})", flush=True)
        try:
            page.goto(a.url, wait_until="networkidle", timeout=60000)
        except Exception as e:
            print(f"[warn] goto: {e}", flush=True)
        page.wait_for_timeout(4000)
        # 強制的に再読込してトークン更新と api 呼び出しを誘発
        try:
            page.goto(a.url, wait_until="networkidle", timeout=60000)
            page.wait_for_timeout(4000)
        except Exception as e:
            print(f"[warn] reload: {e}", flush=True)

        # localStorage / cookie からも privy 関連を回収(/sessions が発火しなかった場合の保険)
        try:
            ls = page.evaluate("() => { const o={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=localStorage.getItem(k);} return o; }")
            secrets["privy"]["localStorage_keys"] = sorted(ls.keys())
            for k, v in ls.items():
                kl = k.lower()
                if "privy" in kl and ("token" in kl or "refresh" in kl or "id_token" in kl):
                    secrets["privy"].setdefault("from_localStorage", {})[k] = v
        except Exception as e:
            print(f"[warn] localStorage: {e}", flush=True)
        try:
            cookies = ctx.cookies()
            secrets["privy"]["cookie_names"] = sorted({c["name"] for c in cookies if "privy" in c["name"].lower()})
            for c in cookies:
                if "privy" in c["name"].lower():
                    secrets["privy"].setdefault("from_cookie", {})[c["name"]] = c["value"]
        except Exception as e:
            print(f"[warn] cookies: {e}", flush=True)

        try: ctx.close()
        except Exception: pass

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(secrets, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- 機微値を出さないサマリ ----
    print("\n=== EXTRACT SUMMARY (no secret values) ===")
    print(f"out: {OUT}")
    print(f"saw: {saw}")
    pv = secrets["privy"]
    print("privy fields:")
    for k in ("token", "privy_access_token", "refresh_token"):
        v = pv.get(k)
        print(f"   {k}: {'len=%d' % len(v) if isinstance(v, str) else '—'}")
    print(f"   localStorage keys: {pv.get('localStorage_keys')}")
    print(f"   privy cookie names: {pv.get('cookie_names')}")
    print(f"   from_localStorage keys: {list((pv.get('from_localStorage') or {}).keys())}")
    print(f"   from_cookie keys: {list((pv.get('from_cookie') or {}).keys())}")
    b = secrets["basis"]
    print("basis fields:")
    print(f"   app_bearer: {'len=%d' % len(b['app_bearer']) if b.get('app_bearer') else '—'}")
    print(f"   session_id: {'len=%d' % len(b['session_id']) if b.get('session_id') else '—'}")
    mu = b.get("member_user") or {}
    if mu:
        print(f"   member_user.uid={mu.get('uid')} level={mu.get('level')} base_rate={mu.get('base_rate')}")
    login_ok = saw["api_200"] or bool(b.get("session_id"))
    print(f"\nLOGIN STATE: {'OK (profile still authenticated)' if login_ok else 'NOT LOGGED IN — 要再ログイン'}")


if __name__ == "__main__":
    main()
