// Telegram Bot API クライアント(写真投稿)。
// 同じ画像を「1つ以上のターゲット」へ投稿できる。ターゲット = chat_id + 任意の message_thread_id
// (フォーラム/トピックのスレッド)。投稿先は env から決まり、コードや .env にはコミットしない。
//
//   TELEGRAM_BOT_TOKEN  … @BotFather のトークン(全ターゲット共通)
//   TELEGRAM_CHAT_ID    … 主投稿先の chat_id(グループ/チャンネルは先頭が "-")
//   TELEGRAM_THREAD_ID  … 任意。主投稿先がフォーラム(トピック)の場合の message_thread_id
//   TELEGRAM_TARGETS    … 任意。追加の投稿先をカンマ/セミコロン/改行区切りで列挙。
//                         各要素は "chatId" もしくは "chatId:threadId"。
//
// 例) 既存グループ + 別グループに同時投稿:
//   TELEGRAM_CHAT_ID=-1001111111111
//   TELEGRAM_TARGETS=-1002222222222
//
// BOT_TOKEN と「最低1つのターゲット」が揃わなければ telegramConfigured() は false で送信スキップ。

const API = "https://api.telegram.org";

export type TelegramTarget = { chatId: string; threadId?: number };
export type TelegramSendResult = TelegramTarget & { ok: boolean; error?: string };

// 投稿先の表示用ラベル(ログ/レスポンス用)。例: "-1001111111111" / "-1002222222222#42"。
export function formatTarget(t: TelegramTarget): string {
  return t.threadId != null ? `${t.chatId}#${t.threadId}` : t.chatId;
}

// env から投稿先ターゲット一覧を組み立てる(同一 chat+thread の重複は除去)。
export function telegramTargets(): TelegramTarget[] {
  const targets: TelegramTarget[] = [];
  const seen = new Set<string>();
  const add = (chatId?: string | null, threadId?: number) => {
    const id = (chatId ?? "").trim();
    if (!id) return;
    const key = `${id}#${threadId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(threadId != null ? { chatId: id, threadId } : { chatId: id });
  };

  // 主投稿先(後方互換): TELEGRAM_CHAT_ID (+ 任意の TELEGRAM_THREAD_ID)
  add(process.env.TELEGRAM_CHAT_ID, parseThread(process.env.TELEGRAM_THREAD_ID));

  // 追加投稿先: TELEGRAM_TARGETS = "chatId[:threadId]" をカンマ/セミコロン/改行区切りで
  for (const entry of (process.env.TELEGRAM_TARGETS ?? "").split(/[,;\n]/)) {
    const s = entry.trim();
    if (!s) continue;
    // chat_id は先頭 "-" を含むが ":" は含まない。":" があれば後ろを threadId とみなす。
    const idx = s.lastIndexOf(":");
    if (idx > 0) add(s.slice(0, idx), parseThread(s.slice(idx + 1)));
    else add(s);
  }
  return targets;
}

function parseThread(v: string | null | undefined): number | undefined {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function telegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN && telegramTargets().length > 0;
}

// PNG(等の画像バイト列)を全ターゲットへ sendPhoto で投稿する。
// 個別ターゲットの失敗では throw せず、各ターゲットの成否を配列で返す(呼び出し側で集計する)。
// token / ターゲットが1つも無い場合のみ throw する(設定漏れ=本来 telegramConfigured() で弾く)。
export async function sendTelegramPhoto(
  png: Uint8Array | ArrayBuffer,
  caption?: string,
  filename = "asset.png"
): Promise<TelegramSendResult[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const targets = telegramTargets();
  if (!token || targets.length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN / 投稿先(TELEGRAM_CHAT_ID 等)未設定");
  }

  // Blob は不変なので全ターゲットで使い回せる(FormData は fetch ごとに消費されるため作り直す)。
  const cap = caption ? caption.slice(0, 1024) : undefined; // Telegram caption 上限は 1024 文字
  // Node の TypedArray 型は ArrayBufferLike 総称で BlobPart に直接代入できないが、実体は妥当なので明示キャスト。
  const blob = new Blob([png as BlobPart], { type: "image/png" });

  const results: TelegramSendResult[] = [];
  for (const t of targets) {
    try {
      const form = new FormData();
      form.append("chat_id", t.chatId);
      if (t.threadId != null) form.append("message_thread_id", String(t.threadId));
      if (cap) form.append("caption", cap);
      form.append("photo", blob, filename);

      const res = await fetch(`${API}/bot${token}/sendPhoto`, {
        method: "POST",
        body: form,
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${text.slice(0, 300)}`);
      }
      results.push({ ...t, ok: true });
    } catch (e) {
      results.push({ ...t, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
