// モンキーテスト: 配布物そのもの (dist/app.html) を、でたらめに操作し続ける。
//
// ほかの E2E は「この操作でこうなる」を 1 本ずつ確かめる。ここは筋書きを
// 持たない。画面に見えている押せるもの・書けるものから種で決まる乱数で 1 つ
// 選び、押す・書く・選ぶ・ファイルを渡す、を繰り返す。人が思いつかない
// 順序で触って、次が崩れないかを見る。
//
// 1. ページ内で例外が起きない (console.error も含む)
// 2. 外へ 1 件も通信しない
// 3. 入力した文字がスクリプトとして走らない (XSS の印 `window.__pwned`)
// 4. 最後まで操作を受け付ける (固まらない)
//
// 種を変えれば別の操作列になる。落ちたら、そこまでの操作をすべて
// エラーに載せるので、同じ種で必ず再現する。
const { test, expect } = require("@playwright/test");
const { PAGE_URL, open } = require("./support");

/** 1 本あたりの操作の数。`MHC_MONKEY_STEPS` で増やせる。 */
const STEPS = Number(process.env.MHC_MONKEY_STEPS) || 120;

/** 種。1 つずつ別のテストにして、並列に回す。 */
const SEEDS = [1, 2, 3, 4];

/** mulberry32。web/src/testing.ts の `seeded` と同じもの。 */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 書き込む文字。境界の数値と、**スクリプトとして走ったら印を立てる**文字列を
 * 混ぜる。画面は文字を必ず textContent に入れる約束なので、印が立ったら
 * どこかで HTML を組み立てている。
 */
const TEXTS = [
  "",
  "0",
  "-1",
  "1.5",
  "1e308",
  "999999999",
  "NaN",
  "abc",
  "名前",
  " ",
  "2026-02-30",
  "25:99",
  "**太字** `code` ~~消し~~\n> 引用\n- 箇条",
  "https://example.com/",
  "😀".repeat(50),
  "あ".repeat(500),
];

/**
 * スクリプトとして走ったら印を立てる文字列。書き込むときの 4 割はこれにする。
 * ほかの文字と同じ重みだと、わざと `innerHTML` にした版を 4 本中 1 本でしか
 * 捕まえられなかった (実測)。
 */
const PAYLOADS = [
  "<img src=x onerror=window.__pwned=1>",
  "<script>window.__pwned=1</script>",
  '"><svg onload=window.__pwned=1>',
  "<b>太字</b>",
  "javascript:window.__pwned=1",
  "[押して](javascript:window.__pwned=1)",
];

/** 読み込ませるファイル。壊れたもの・空のもの・正しい形に近いものを混ぜる。 */
const FILES = [
  { name: "empty.json", mimeType: "application/json", buffer: Buffer.from("") },
  {
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  },
  {
    name: "array.json",
    mimeType: "application/json",
    buffer: Buffer.from("[1,2]"),
  },
  {
    name: "tangled.mhc.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schema: "man-hour-calculator",
        name: "<img src=x onerror=window.__pwned=1>",
        document: {
          tasks: [
            {
              id: "a",
              name: "A",
              parentId: "b",
              min: "1",
              likely: "2",
              max: "3",
            },
            {
              id: "b",
              name: "B",
              parentId: "a",
              min: "1",
              likely: "2",
              max: "3",
            },
            {
              id: "c",
              name: "C",
              parentId: "a",
              min: "x",
              likely: "-1",
              max: "1e308",
            },
          ],
        },
      }),
    ),
  },
  {
    name: "tasks.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      'level,name,min,likely,max\n0,"a,""b""\n",1,2,3\n5,x,,,\n',
    ),
  },
  {
    name: "binary.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0, 0xff]),
  },
];

/**
 * 候補にしないもの。外へ出るリンクは押すと外へ通信するが、それは利用者が
 * 選んだ遷移で、「勝手に通信しない」約束の違反ではない。別ページ
 * (紹介ページ) への移動も、この検査の対象から外れるので押さない。
 */
const CANDIDATES = [
  "button",
  "summary",
  "a[href]:not([href^='http']):not([href$='.html'])",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[role='button']",
]
  .map((selector) => `${selector}:visible`)
  .join(", ");

const pick = (random, items) => items[Math.floor(random() * items.length)];

/** 1 手打つ。何をしたかを文字で返す (再現のため)。 */
async function step(page, random) {
  // たまにキー操作だけ (モーダルを閉じる・フォーカスを動かす)。
  if (random() < 0.08) {
    const key = pick(random, ["Escape", "Tab", "Enter", "Shift+Tab"]);
    await page.keyboard.press(key);
    return `key ${key}`;
  }

  // 窓 (予定・コメント・タスクの詳細) が開いていたら、その中だけを触る。
  // 人も後ろの画面は押せない。外まで候補にすると、半分近くが「覆われて
  // いて押せない」で時間切れになり、何も試さないまま終わる (実測)。
  const modal = page.locator(".modal-card:visible").last();
  const scope = (await modal.count()) > 0 ? modal : page;
  const all = scope.locator(CANDIDATES);
  const count = await all.count();
  if (count === 0) return "候補なし";
  const index = Math.floor(random() * count);
  const target = all.nth(index);
  const info = await target.evaluate((node) => ({
    tag: node.tagName.toLowerCase(),
    type: node.getAttribute("type") ?? "",
    label:
      node.getAttribute("aria-label") ??
      node.getAttribute("title") ??
      node.getAttribute("data-action") ??
      (node.textContent ?? "").trim().slice(0, 30),
    options:
      node.tagName === "SELECT" ? [...node.options].map((o) => o.value) : [],
  }));
  const what = `${info.tag}[${info.type}] "${info.label}" (#${index}/${count})`;
  try {
    return `${what} ${await act(target, info, random)}`;
  } catch (error) {
    // 操作できなかった (覆われていた・消えた・時間切れ) のは、画面が
    // 変わった結果であって不具合ではない。何に失敗したかを残して続ける。
    return `${what} (操作できず: ${String(error).split("\n")[0].slice(0, 60)})`;
  }
}

/** 要素の種類に合わせて 1 つ操作する。 */
async function act(target, info, random) {
  const quick = { timeout: 1500 };

  if (info.tag === "select") {
    if (info.options.length === 0) return "選択肢なし";
    const value = pick(random, info.options);
    await target.selectOption(value, quick);
    return `← ${value}`;
  }
  if (info.tag === "input" && info.type === "file") {
    const file = pick(random, FILES);
    await target.setInputFiles(file, quick);
    return `← ${file.name}`;
  }
  if (info.tag === "input" && ["checkbox", "radio"].includes(info.type)) {
    await target.click(quick);
    return "click";
  }
  if (info.tag === "input" && info.type === "color") {
    await target.fill("#12ab34", quick);
    return "← #12ab34";
  }
  if (info.tag === "input" || info.tag === "textarea") {
    let text = random() < 0.4 ? pick(random, PAYLOADS) : pick(random, TEXTS);
    // date / time / number は形の合わないものを受け付けない (fill が投げる)。
    // 形の合う値にして、中身の境界で揺さぶる。
    if (info.type === "date")
      text = pick(random, ["2026-09-01", "1900-01-01", "2999-12-31", ""]);
    if (info.type === "time")
      text = pick(random, ["00:00", "09:30", "23:59", ""]);
    if (info.type === "number" || info.type === "range") {
      text = pick(random, ["0", "-1", "1.5", "100", "1e6", "99999999", ""]);
    }
    await target.fill(text, quick);
    if (random() < 0.3) await target.press("Enter", quick);
    return `← ${JSON.stringify(text)}`;
  }
  await target.click(quick);
  return "click";
}

for (const seed of SEEDS) {
  test(`モンキーテスト (種 ${seed}): でたらめに触っても壊れない`, async ({
    page,
  }) => {
    test.setTimeout(STEPS * 1500 + 30_000);
    const { external, errors } = await open(page);
    const random = seeded(seed);
    const trail = [];

    // 確認ダイアログは、半分は受けて半分は断る。
    page.on("dialog", (dialog) => {
      trail.push(`dialog ${dialog.type()}`);
      void (random() < 0.5 ? dialog.accept() : dialog.dismiss());
    });
    // 保存は受け取るだけ。新しい窓 (リンク) は閉じる。
    page.on("download", (download) => void download.cancel());
    page.context().on("page", (popup) => void popup.close());

    const report = () =>
      `種 ${seed}、${trail.length} 手目まで:\n  ${trail.join("\n  ")}`;

    for (let i = 0; i < STEPS; i++) {
      trail.push(await step(page, random));
      // 別のページへ移っていたら戻る (候補から外しているが、念のため)。
      if (page.url() !== PAGE_URL) {
        trail.push(`(移動した: ${page.url()})`);
        await page.goto(PAGE_URL);
      }

      expect(errors, `ページ内で例外が起きた\n${report()}`).toEqual([]);
      expect(external, `外へ通信した\n${report()}`).toEqual([]);
      const pwned = await page.evaluate(() => window.__pwned);
      expect(
        pwned,
        `入力した文字がスクリプトとして走った\n${report()}`,
      ).toBeUndefined();
    }

    // 最後まで応答する。開いている窓は Esc で全部閉じられ (閉じられない窓は
    // キーボードの利用者を閉じ込める)、表示言語を切り替えられる。
    for (
      let i = 0;
      i < 5 && (await page.locator(".modal-card").count()) > 0;
      i++
    ) {
      await page.keyboard.press("Escape");
    }
    await expect(
      page.locator(".modal-card"),
      `Esc で閉じない窓がある\n${report()}`,
    ).toHaveCount(0);
    await page.click('.lang-toggle button[data-lang="en"]', { timeout: 5000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
}
