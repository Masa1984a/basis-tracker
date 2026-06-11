import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
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
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="basis-tracker"' },
  });
}

// cron が叩く /api/market・/api/basis は Basic 認証の対象外。
// ただし秘匿情報を受け取る /api/basis/seed は保護対象に残す(api/basis(?!/seed))。
export const config = {
  matcher: [
    "/((?!api/market|api/basis(?!/seed)|_next/static|_next/image|favicon.ico).*)",
  ],
};
