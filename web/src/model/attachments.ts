/**
 * コメントに付けるファイルの読み込みと検め。
 *
 * 断るのは**付けようとした時点**。保存に失敗してから気づくのでは遅い。
 */

import {
  MAX_ATTACHMENTS_PER_COMMENT,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
} from "../api/types.ts";

/** なぜ付けられなかったか。文言は呼び出し側が決める。 */
export type RejectReason = "tooMany" | "tooLarge" | "noRoom" | "unreadable";

export interface AttachResult {
  accepted: Attachment[];
  rejected: { filename: string; reason: RejectReason }[];
}

/** 画面のなかに出すのは画像だけ。それ以外は名前付きのリンクにする。 */
export function isImage(attachment: Attachment): boolean {
  return attachment.mime.startsWith("image/");
}

/** 画面に出すための `data:` URL。外へ取りに行かないので通信は起きない。 */
export function attachmentUrl(attachment: Attachment): string {
  const mime = attachment.mime === "" ? "application/octet-stream" : attachment.mime;
  return `data:${mime};base64,${attachment.data}`;
}

/**
 * 本文に差し込む綴り。**画像だけ。**
 *
 * 画像でないものは本文に入れない。`[名前](attachment:…)` と書いても、
 * 通せる綴りではないので文字のまま残るだけで、押しても何も起きない。
 * それらはコメントの下の一覧に、押せば落とせるリンクとして出る。
 */
export function attachmentMarkdown(attachment: Attachment): string | null {
  return isImage(attachment) ? `![${attachment.filename}](attachment:${attachment.id})` : null;
}

/** `1.2 MB` のような見せ方。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** base64 にしたときのおおよその長さ。保存できるかを測るのに使う。 */
export function encodedSize(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * 選ばれたファイルを添付に変える。
 *
 * `room` は保存先に残っている容量 (分からなければ `null`)。足りなければ
 * `noRoom` で断る。
 */
export async function readAttachments(
  files: readonly File[],
  existing: readonly Attachment[],
  newId: () => string,
  room: number | null,
): Promise<AttachResult> {
  const accepted: Attachment[] = [];
  const rejected: AttachResult["rejected"] = [];
  let used = existing.reduce((sum, item) => sum + item.data.length, 0);

  for (const file of files) {
    if (existing.length + accepted.length >= MAX_ATTACHMENTS_PER_COMMENT) {
      rejected.push({ filename: file.name, reason: "tooMany" });
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ filename: file.name, reason: "tooLarge" });
      continue;
    }
    const needed = encodedSize(file.size);
    if (room !== null && used + needed > room) {
      rejected.push({ filename: file.name, reason: "noRoom" });
      continue;
    }

    let data: string;
    try {
      data = await toBase64(file);
    } catch {
      rejected.push({ filename: file.name, reason: "unreadable" });
      continue;
    }
    used += data.length;
    accepted.push({
      id: newId(),
      filename: file.name === "" ? "file" : file.name,
      mime: file.type,
      size: file.size,
      data,
    });
  }
  return { accepted, rejected };
}

/**
 * ファイルを base64 にする。
 *
 * `FileReader` の `data:` URL から後ろだけ取る。`btoa` に渡すために
 * バイト列を文字列へ組み直すと、大きなファイルで呼び出し段が溢れる。
 */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("読めません"));
    };
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma === -1) {
        reject(new Error("読めません"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
