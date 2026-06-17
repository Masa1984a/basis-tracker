// Telegram Bot API クライアント(写真投稿)。
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID は Vercel の環境変数に設定する(コードや .env にはコミットしない)。
// 両方が揃っていない場合は telegramConfigured() が false を返し、送信処理はスキップする。

const API = "https://api.telegram.org";

export function telegramConfigured(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// PNG(等の画像バイト列)を sendPhoto で投稿する。失敗時は例外を投げる(呼び出し側で握りつぶす)。
export async function sendTelegramPhoto(
  png: Uint8Array | ArrayBuffer,
  caption?: string,
  filename = "asset.png"
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 未設定");
  }

  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption.slice(0, 1024)); // Telegram caption 上限は 1024 文字
  // Node の TypedArray 型は ArrayBufferLike 総称で BlobPart に直接代入できないが、実体は妥当なので明示キャスト。
  form.append("photo", new Blob([png as BlobPart], { type: "image/png" }), filename);

  const res = await fetch(`${API}/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Telegram sendPhoto failed: ${res.status} ${text.slice(0, 300)}`);
  }
}
