import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 公開ページ・API: 認証不要
  if (pathname.startsWith("/drr") || pathname.startsWith("/api/drr")) {
    return NextResponse.next();
  }

  // cron エンドポイント: /api/market と /api/basis(末尾完全一致のみ、サブパスは保護)
  if (pathname === "/api/market" || pathname === "/api/basis") {
    return NextResponse.next();
  }

  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return NextResponse.next(); // ローカル開発用

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = atob(auth.slice(6));
    const i = decoded.indexOf(":");
    if (decoded.slice(0, i) === user && decoded.slice(i + 1) === pass) {
      return NextResponse.next();
    }
  }
  // WWW-Authenticate は実際のページ遷移のときだけ付ける。
  // Link の自動 prefetch(fetch)に付けると、公開ページ閲覧中でも
  // ブラウザが認証ダイアログを出してしまうため。
  const isNavigation = req.headers.get("sec-fetch-mode") === "navigate";
  return new NextResponse("Authentication required", {
    status: 401,
    headers: isNavigation
      ? { "WWW-Authenticate": 'Basic realm="basis-tracker"' }
      : undefined,
  });
}

// matcher は静的アセットと PWA ファイルのみ除外するシンプルな正規表現に絞る。
// 複雑なネスト先読み(api/basis(?!/))は Edge ランタイムで誤動作する可能性があるため、
// 認証除外ロジックはすべて関数内の startsWith で処理する。
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|offline.html|icons/).*)",
  ],
};
