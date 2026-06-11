import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { put } from "@vercel/blob";
import { sql } from "@vercel/postgres";
import { validateExtraction } from "@/lib/validate";
import { Extraction } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const PROMPT = `これはbasis.proの資産画面のスクリーンショットです。以下のJSONだけを出力してください(説明文・コードフェンス禁止)。

{
 "total_staked_usd": 数値またはnull,
 "total_rewards_usd": 数値またはnull,
 "total_rewards_pct": 数値またはnull,
 "staking_wallet_usd": 数値またはnull,
 "funding_wallet_usd": 数値またはnull,
 "daily": [{"date":"YYYY-MM-DD","profit_usd":数値}]
}

ルール:
- $やカンマや+記号は除去して数値化する
- 画面にはっきり見える行だけをdailyに含める
- 日付か金額が見切れている行は含めない
- 該当項目が画面にない場合はnull`;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file がありません" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const media = (file.type || "image/png") as "image/png" | "image/jpeg" | "image/webp";

  // スクショの原本をBlobに保存(監査証跡)
  let blob_url: string | null = null;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const b = await put(`shots/${Date.now()}-${file.name || "shot.png"}`, buf, {
      access: "public",
      contentType: media,
    });
    blob_url = b.url;
  }

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: process.env.EXTRACT_MODEL || "claude-haiku-4-5",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  const text = msg.content
    .filter((c) => c.type === "text")
    .map((c: any) => c.text)
    .join("");

  let extraction: Extraction;
  try {
    extraction = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return NextResponse.json(
      { error: "抽出結果をJSONとして解釈できませんでした", raw: text },
      { status: 422 }
    );
  }

  // 登録済みデータと直近スナップショットを取得して検証
  const { rows } = await sql`select date::text as date, profit_usd::float8 as profit_usd from daily_rewards`;
  const existing: Record<string, number> = {};
  for (const r of rows) existing[r.date] = Number(r.profit_usd);

  const prev = await sql`select total_rewards_usd::float8 as v from snapshots order by taken_at desc limit 1`;
  const prevTotal = prev.rows[0]?.v != null ? Number(prev.rows[0].v) : null;

  const validation = validateExtraction(extraction, existing, prevTotal);
  return NextResponse.json({ extraction, validation, blob_url });
}
