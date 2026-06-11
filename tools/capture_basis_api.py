"""capture_basis_api.py — basis.pro の内部 API(XHR/Fetch JSON)を発見するための調査ツール。

Playwright(headed)で専用プロファイルのブラウザを起動し、自分で basis.pro にログイン →
/asset を開く間に飛ぶ XHR/Fetch を全部キャプチャして JSON にダンプする。
OCR を置き換えられる構造化エンドポイントがあるかを確認するのが目的。

- 会社の Edge プロファイルは触らない。専用プロファイル(.pw-basis-profile)を使う。
  → 初回はログインが要るが、2 回目以降はセッションが残る。
- 取得した request_headers / cookie には自分の認証トークンが含まれる。out ファイルは
  ローカル専用。共有・コミットしないこと。

使い方(対話的にユーザーが実行):
    python tools/capture_basis_api.py
    python tools/capture_basis_api.py --url https://basis.pro/asset

終了:
    画面でログインし /asset を表示・操作したあと、ターミナルで Enter を押すとダンプして終了。
    非対話で起動された場合は --wait 秒だけ待ってからダンプする。
"""
import argparse
import json
import sys
import time
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    from playwright.sync_api import sync_playwright
except ModuleNotFoundError:
    print("Playwright 未導入: pip install playwright && playwright install chromium", file=sys.stderr)
    raise SystemExit(2)

PROJECT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE = PROJECT / ".pw-basis-profile"
DEFAULT_OUT = PROJECT / "debug" / "basis_network.json"
SENTINEL = PROJECT / "debug" / ".capture_done"

INTERESTING_TYPES = {"xhr", "fetch"}
# ノイズになりがちなホスト(解析・計測系)は本文を取らない
NOISE_HOSTS = ("google-analytics", "googletagmanager", "doubleclick", "sentry",
               "hotjar", "intercom", "segment", "mixpanel", "cloudflareinsights")


def is_noise(url: str) -> bool:
    return any(h in url for h in NOISE_HOSTS)


def wait_for_user(wait_s: int) -> str:
    """ログイン/操作の完了を待つ。
    - 対話端末: Enter で完了。
    - 非対話(バックグラウンド起動など): SENTINEL ファイル出現か、最大 wait_s 秒で完了。
      別ターミナルから `python tools/capture_basis_api.py --stop` で早期終了できる。
    """
    try:
        input()
        return "enter"
    except EOFError:
        pass
    print(f"[i] 非対話モード: 最大 {wait_s}s 待機します。", flush=True)
    print("    先に終わらせたいときは別ターミナルで:", flush=True)
    print("        python tools\\capture_basis_api.py --stop", flush=True)
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if SENTINEL.exists():
            try:
                SENTINEL.unlink()
            except Exception:
                pass
            print("[i] stop シグナル受信。キャプチャを確定します。", flush=True)
            return "sentinel"
        time.sleep(2)
    return "timeout"


def main():
    ap = argparse.ArgumentParser(description="basis.pro 内部 API 調査(ネットワークキャプチャ)")
    ap.add_argument("--url", default="https://basis.pro/asset", help="開く URL(既定: /asset)")
    ap.add_argument("--profile-dir", default=str(DEFAULT_PROFILE), help="専用プロファイルの保存先")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="キャプチャ JSON の出力先")
    ap.add_argument("--wait", type=int, default=120, help="非対話時のログイン待ち秒数")
    ap.add_argument("--headless", action="store_true", help="ヘッドレス(ログイン不可。通常使わない)")
    ap.add_argument("--stop", action="store_true", help="実行中のキャプチャを早期終了させる(別ターミナルから)")
    a = ap.parse_args()

    if a.stop:
        SENTINEL.parent.mkdir(parents=True, exist_ok=True)
        SENTINEL.write_text("stop", encoding="utf-8")
        print(f"[i] stop シグナルを送信しました: {SENTINEL}", flush=True)
        return

    captured = []
    seen = set()

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=a.profile_dir,
            headless=a.headless,
            no_viewport=True,
            args=[
                "--start-maximized",
                # 自動化検出(navigator.webdriver)をできるだけ抑える。Cloudflare 対策。
                "--disable-blink-features=AutomationControlled",
            ],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_response(resp):
            try:
                req = resp.request
                rtype = req.resource_type
                url = resp.url
                ct = (resp.headers.get("content-type") or "")
                is_json = "json" in ct.lower()
                if rtype not in INTERESTING_TYPES and not is_json:
                    return
                if is_noise(url):
                    return
                entry = {
                    "url": url,
                    "method": req.method,
                    "resource_type": rtype,
                    "status": resp.status,
                    "content_type": ct,
                    "request_headers": dict(req.headers),
                    "post_data": req.post_data,
                }
                if is_json or "text" in ct.lower():
                    try:
                        body = resp.text()
                        entry["body"] = body[:300000]
                        entry["body_truncated"] = len(body) > 300000
                    except Exception as e:
                        entry["body_error"] = f"{type(e).__name__}: {e}"
                captured.append(entry)
                key = (req.method, url.split("?")[0])
                if key not in seen:
                    seen.add(key)
                    print(f"[net] {resp.status} {req.method:4} {rtype:5} {url}", flush=True)
            except Exception as e:
                print(f"[net-err] {type(e).__name__}: {e}", flush=True)

        page.on("response", on_response)

        print(f"[i] {a.url} を開きます。", flush=True)
        print("[i] ログイン画面が出たら、この専用ウィンドウで basis.pro にログインしてください。", flush=True)
        try:
            page.goto(a.url, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            print(f"[warn] goto 失敗(ログイン後に再試行します): {e}", flush=True)

        print("\n" + "=" * 70, flush=True)
        print("[操作] ログイン → /asset を表示し、Reward History Calendar や", flush=True)
        print("       Total Staked が見える状態にしてください(カレンダーをクリック/スクロールすると", flush=True)
        print("       追加の XHR が飛びます)。完了したら、このターミナルで Enter を押してください。", flush=True)
        print("=" * 70 + "\n", flush=True)
        try:
            if SENTINEL.exists():
                SENTINEL.unlink()  # 前回の残骸を掃除
        except Exception:
            pass
        wait_for_user(a.wait)

        # listener を付けたまま /asset を 1 回読み直して、資産系 XHR を確実に再発火させる
        try:
            print(f"[i] {a.url} を再読込して XHR を再取得します...", flush=True)
            page.goto(a.url, wait_until="networkidle", timeout=60000)
            page.wait_for_timeout(3000)
        except Exception as e:
            print(f"[warn] 再読込 skip: {e}", flush=True)

        try:
            ctx.close()
        except Exception:
            pass

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(captured, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- サマリ ----
    print("\n=== RESULT ===", flush=True)
    print(f"captured: {len(captured)} responses", flush=True)
    print(f"out:      {out}", flush=True)
    print("\n--- ユニーク エンドポイント(method status type url) ---", flush=True)
    uniq = {}
    for e in captured:
        k = (e["method"], e["url"].split("?")[0])
        if k not in uniq:
            uniq[k] = e
    for (method, base), e in sorted(uniq.items(), key=lambda kv: kv[1]["url"]):
        has_body = "body" in e and e.get("status", 0) < 400
        size = len(e.get("body", "")) if "body" in e else 0
        flag = f"  <body {size}B>" if has_body else ""
        print(f"  {e['status']:3} {method:4} {e['resource_type']:5} {base}{flag}", flush=True)
    print("\n[注意] out ファイルには自分の認証トークン/Cookie が含まれます。共有・コミット禁止。", flush=True)


if __name__ == "__main__":
    main()
