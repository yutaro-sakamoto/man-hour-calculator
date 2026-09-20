/**
 * サーバへの接続先。
 *
 * 入っていればサーバに繋ぎ、無ければ同じ HTML の WASM で動く。
 * どちらでも画面から見える口 (`ApiClient`) は同じなので、切り替えても
 * 使い勝手は変わらない。
 *
 * ブラウザに保存するので、**トークンはその端末のその人のものだけ**が入る。
 * 共有端末で使ったら「切断」で消すこと。
 */

export interface Connection {
  baseUrl: string;
  token: string;
}

const STORAGE_KEY = "mhc.connection.v1";

/** 保存してある接続先。無ければ `null`。 */
export function loadConnection(): Connection | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // プライベートモードなどで読めないことがある。ローカルとして扱う。
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { baseUrl, token } = parsed as Record<string, unknown>;
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") return null;
    return { baseUrl: baseUrl.trim(), token: typeof token === "string" ? token : "" };
  } catch {
    return null;
  }
}

/** 接続先を覚える。`null` で忘れる。保存できたかを返す。 */
export function saveConnection(connection: Connection | null): boolean {
  try {
    if (connection === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
    return true;
  } catch {
    return false;
  }
}

/**
 * 入力された接続先を整える。使えなければ `null`。
 *
 * `http(s)://` だけを通す。`javascript:` のような綴りを
 * そのまま `fetch` に渡さないため。
 */
export function normalizeBaseUrl(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // 末尾のスラッシュは落とす (パスと二重にならないように)。
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
