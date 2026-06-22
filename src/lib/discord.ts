// Discord Webhook クライアント(画像投稿)。
// Telegram と同じ Asset サマリ画像(PNG) + キャプションを、Discord のチャンネル Webhook へ投稿する。
//
//   DISCORD_WEBHOOK_URL   … 主投稿先の Webhook URL
//   DISCORD_WEBHOOK_URLS  … 任意。追加投稿先の Webhook URL をカンマ/セミコロン/改行区切りで列挙
//
// Webhook URL は実質的な認証情報なので、コードや .env.example には実値をコミットしない。
// URL が1つも無ければ discordConfigured() は false で送信スキップ。

export type DiscordTarget = { webhookUrl: string };
export type DiscordSendResult = DiscordTarget & { ok: boolean; error?: string };

const DISCORD_CONTENT_MAX = 2000;

// Webhook URL の表示用ラベル(ログ/レスポンス用)。
// URL 末尾の token は秘匿情報なので出さず、webhook id だけ分かる形にする。
export function formatDiscordTarget(t: DiscordTarget): string {
  try {
    const u = new URL(t.webhookUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const webhooksIdx = parts.indexOf("webhooks");
    const webhookId = webhooksIdx >= 0 ? parts[webhooksIdx + 1] : undefined;
    return webhookId ? `${u.host}/webhooks/${webhookId}/…` : `${u.host}/…`;
  } catch {
    return "invalid-discord-webhook-url";
  }
}

// env から投稿先 Webhook 一覧を組み立てる(同一 URL の重複は除去)。
export function discordTargets(): DiscordTarget[] {
  const targets: DiscordTarget[] = [];
  const seen = new Set<string>();
  const add = (url?: string | null) => {
    const webhookUrl = (url ?? "").trim();
    if (!webhookUrl || seen.has(webhookUrl)) return;
    seen.add(webhookUrl);
    targets.push({ webhookUrl });
  };

  add(process.env.DISCORD_WEBHOOK_URL);
  for (const entry of (process.env.DISCORD_WEBHOOK_URLS ?? "").split(/[,;\n]/)) add(entry);
  return targets;
}

export function discordConfigured(): boolean {
  return discordTargets().length > 0;
}

// PNG(等の画像バイト列)を全 Webhook へ投稿する。
// 個別 Webhook の失敗では throw せず、各 Webhook の成否を配列で返す(呼び出し側で集計する)。
// Webhook URL が1つも無い場合のみ throw する(設定漏れ=本来 discordConfigured() で弾く)。
export async function sendDiscordPhoto(
  png: Uint8Array | ArrayBuffer,
  caption?: string,
  filename = "asset.png"
): Promise<DiscordSendResult[]> {
  const targets = discordTargets();
  if (targets.length === 0) {
    throw new Error("DISCORD_WEBHOOK_URL 未設定");
  }

  const content = truncateDiscordContent(caption);
  // Node の TypedArray 型は ArrayBufferLike 総称で BlobPart に直接代入できないが、実体は妥当なので明示キャスト。
  const blob = new Blob([png as BlobPart], { type: "image/png" });

  const results: DiscordSendResult[] = [];
  for (const t of targets) {
    try {
      const form = new FormData();
      form.append(
        "payload_json",
        JSON.stringify({
          content,
          // Asset 名などに @ が含まれても意図せずメンションしないようにする。
          allowed_mentions: { parse: [] },
        })
      );
      form.append("files[0]", blob, filename);

      const res = await fetch(t.webhookUrl, {
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

function truncateDiscordContent(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  if (v.length <= DISCORD_CONTENT_MAX) return v;
  return `${v.slice(0, DISCORD_CONTENT_MAX - 1)}…`;
}
