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
  let raw: string | null;
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

const LAST_PROJECT_KEY = "mhc.lastProject.v1";

/**
 * 最後に開いていたプロジェクトの id。接続先ごとに覚える。
 *
 * 覚えていなかったころは、開き直すたびに一覧の先頭 (手当てが要る順の
 * 先頭) が開いていた。気づかずにそこへ CSV を読み込み、別の案件の
 * タスクを上書きしてしまった。
 */
export function loadLastProject(connection: Connection | null): string | null {
  try {
    const raw = localStorage.getItem(LAST_PROJECT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const id = (parsed as Record<string, unknown>)[connectionKey(connection)];
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** 開いたプロジェクトを覚える。書けなくても困らない (次に先頭が開くだけ)。 */
export function saveLastProject(connection: Connection | null, id: string): void {
  try {
    const raw = localStorage.getItem(LAST_PROJECT_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    const table =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    table[connectionKey(connection)] = id;
    localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify(table));
  } catch {
    // 覚えられないだけで、動作には関わらない。
  }
}

function connectionKey(connection: Connection | null): string {
  return connection === null ? "local" : connection.baseUrl;
}
