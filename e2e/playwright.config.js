// dist/index.html を file:// から直接開いて検証する。
// http サーバを立てないのは、「HTML をダブルクリックすれば動く」という
// このアプリの前提そのものを毎回テストで確かめるため。
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  timeout: 30_000,
  use: {
    browserName: "chromium",
    // 既定言語を固定する。実行環境の locale で初期表示が揺れないように。
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
});
