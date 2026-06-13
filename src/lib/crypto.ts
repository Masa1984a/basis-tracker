import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// basis_session のトークンを「保存時に暗号化」するためのユーティリティ(AES-256-GCM)。
// 鍵は DB の外(env SESSION_ENC_KEY)に置く。DB だけが漏洩しても復号できないようにする狙い。
//
// 形式: "enc:v1:" + base64( iv[12] | authTag[16] | ciphertext )
// - 先頭の "enc:v1:" で「暗号化済みか平文か」を判別する(暗号化導入前の平文データと後方互換)。
// - SESSION_ENC_KEY 未設定なら暗号化しない(従来どおり平文)。鍵を設定した時点で次回保存から暗号化される。

const PREFIX = "enc:v1:";

// 任意長の env 値から 32 バイト鍵を導出する。高エントロピーなランダム値(例: 32バイトhex)を推奨。
function getKey(): Buffer | null {
  const raw = process.env.SESSION_ENC_KEY;
  if (!raw) return null;
  return createHash("sha256").update(raw, "utf8").digest();
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

// 平文を暗号化して返す。鍵未設定なら平文のまま返す(段階移行を許容)。
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain == null) return null;
  if (isEncrypted(plain)) return plain; // 二重暗号化を防ぐ
  const key = getKey();
  if (!key) return plain; // 鍵未設定 = 従来どおり平文保存
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

// 保存値を復号して平文を返す。平文(プレフィックス無し)はそのまま返す。
// 暗号化データなのに鍵が無い/不一致なら例外(設定ミスを黙って握りつぶさない)。
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!isEncrypted(stored)) return stored; // 暗号化導入前の平文データ
  const key = getKey();
  if (!key) {
    throw new Error("SESSION_ENC_KEY 未設定だが暗号化済みデータを検出。Vercel の env を確認してください。");
  }
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
