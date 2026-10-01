const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testMatch: "full.spec.cjs",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "artifacts/test-results",
  reporter: [
    ["line"],
    ["json", { outputFile: "artifacts/playwright-results.json" }],
  ],
});
