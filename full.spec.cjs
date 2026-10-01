const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const {
  hash,
  normalize,
  recycledHashes,
  readClipboard,
  readJXAClipboard,
} = require("./probe.cjs");

const native = process.platform === "win32" || process.platform === "darwin";
if (process.env.CI && !native)
  throw new Error("Native evidence requires Windows or macOS");

async function launch(mode, count = 2, canonical = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-ui-"));
  let app;
  try {
    app = await electron.launch({
      args: [
        path.resolve("ui-main.cjs"),
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      ],
      env: {
        ...process.env,
        PROBE_ROOT: root,
        PROBE_MODE: mode,
        PROBE_COUNT: String(count),
        PROBE_CANONICAL: canonical ? "1" : "0",
      },
      timeout: 20_000,
    });
    const page = await app.firstWindow();
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    await expect(page.locator("#items")).toHaveAttribute("data-ready", "true");
    return { app, page, root };
  } catch (error) {
    try {
      if (app) await app.close();
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
    throw error;
  }
}

async function captureAndClose(session, testInfo) {
  const { app, page, root } = session;
  try {
    try {
      const observations = await page.evaluate(() => window.api.observations());
      await testInfo.attach("observations", {
        body: JSON.stringify(observations, null, 2),
        contentType: "application/json",
      });
      await testInfo.attach("renderer", {
        body: await page.locator("body").innerText(),
        contentType: "text/plain",
      });
    } finally {
      const trace = testInfo.outputPath("electron-trace.zip");
      await app.context().tracing.stop({ path: trace });
      await testInfo.attach("electron-trace", {
        path: trace,
        contentType: "application/zip",
      });
    }
  } finally {
    try {
      if (process.platform === "win32") {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-EncodedCommand",
            Buffer.from(
              `
$ErrorActionPreference='Stop'
$root=$env:NATIVE_UI_ROOT.TrimEnd('\\')
foreach($window in @((New-Object -ComObject Shell.Application).Windows())) {
  if(([string]$window.LocationURL).StartsWith('file:')) {
    $directory=([Uri]$window.LocationURL).LocalPath.TrimEnd('\\')
    if($directory.Equals($root,[StringComparison]::OrdinalIgnoreCase) -or $directory.StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase)) {$window.Quit()}
  }
}
`,
              "utf16le",
            ).toString("base64"),
          ],
          {
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...process.env,
              NATIVE_UI_ROOT: fs.realpathSync.native(root),
            },
          },
        );
      }
    } finally {
      try {
        await app.close();
      } finally {
        fs.rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      }
    }
  }
}

function clipboardFiles() {
  if (process.platform === "darwin") {
    const before = readClipboard();
    const jxa = readJXAClipboard();
    const after = readClipboard();
    expect(before.nativeFileType).toBe(true);
    expect(jxa.nativeFileType).toBe(true);
    expect(normalize(jxa.urls)).toEqual(normalize(before.legacy));
    expect(normalize(after.legacy)).toEqual(normalize(before.legacy));
    return normalize(jxa.urls);
  }
  return normalize(readClipboard().urls);
}

for (const mode of ["baseline", "filepath", "buffer", "files0", "off"]) {
  test(`full JPEG native workflow: ${mode}`, async ({}, testInfo) => {
    test.skip(!native);
    const session = await launch(mode);
    const { page } = session;
    try {
      const initial = await page.evaluate(() => window.api.observations());
      const files = initial.paths;
      const expectedHashes = files.map(hash);
      expect(initial.thumbnails).toHaveLength(mode === "baseline" ? 0 : 2);
      const cards = page.locator("[data-item]");
      if (mode !== "baseline") {
        await expect
          .poll(() =>
            cards
              .locator("img")
              .evaluateAll(
                (images) =>
                  images.length === 2 &&
                  images.every(
                    (image) => image.complete && image.naturalWidth === 512,
                  ),
              ),
          )
          .toBe(true);
      }
      await cards.nth(0).click();
      await cards.nth(1).click({ modifiers: ["ControlOrMeta"] });
      await cards.nth(1).click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Copy 2 files", exact: true })
        .click();
      await expect(() =>
        expect(clipboardFiles()).toEqual([...files].sort()),
      ).toPass({ timeout: 10_000 });
      await cards.nth(0).click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Preview", exact: true })
        .click();
      await expect
        .poll(() =>
          page
            .locator("#preview-image")
            .evaluate((image) => image.complete && image.naturalWidth),
        )
        .toBe(1400);
      await page
        .getByRole("button", { name: "Current file actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Copy 1 files", exact: true })
        .click();
      await expect(() => expect(clipboardFiles()).toEqual([files[0]])).toPass({
        timeout: 10_000,
      });
      await page
        .getByRole("button", { name: "Close preview", exact: true })
        .click();
      await cards.nth(0).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Trash", exact: true }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(files.every(fs.existsSync)).toBe(true);
      expect(
        (await page.evaluate(() => window.api.observations())).events,
      ).toEqual([]);
      await cards.nth(0).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Trash", exact: true }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Succeeded");
      const final = await page.evaluate(() => window.api.observations());
      expect(new Set(expectedHashes).size).toBe(2);
      expect(final.streams).toEqual([{ path: files[0], state: "closed" }]);
      expect(
        final.events
          .filter((event) => event.state === "started")
          .map((event) => event.path),
      ).toEqual(files);
      // The unchanged filepath case must reproduce the original Windows failure.
      if (process.platform === "win32" && mode === "filepath") {
        expect(
          final.events.filter((event) => event.state === "failed"),
        ).toEqual(
          files.map((file) => ({
            action: "trash",
            path: file,
            state: "failed",
            message: "Operation was aborted",
          })),
        );
        expect(files.every(fs.existsSync)).toBe(true);
        expect(
          final.history.every((record) => record.assetStatus === "ready"),
        ).toBe(true);
      } else {
        expect(
          final.events.filter((event) => event.state === "succeeded"),
        ).toHaveLength(2);
        expect(files.some(fs.existsSync)).toBe(false);
        const trashHashes = [];
        for (const [index, file] of files.entries()) {
          const actual =
            process.platform === "win32"
              ? recycledHashes(file)
              : [hash(path.join(os.homedir(), ".Trash", path.basename(file)))];
          expect(actual).toEqual([expectedHashes[index]]);
          trashHashes.push(actual[0]);
        }
        await testInfo.attach("native-byte-readback", {
          body: JSON.stringify({ files, expectedHashes, trashHashes }),
          contentType: "application/json",
        });
        await expect(cards).toHaveCount(0);
        expect(final.history).toHaveLength(2);
        expect(
          final.history.every(
            (record) =>
              record.assetStatus === "local_missing" &&
              record.deliveryStatus === "local_missing" &&
              record.generationStatus === "succeeded",
          ),
        ).toBe(true);
      }
    } finally {
      await captureAndClose(session, testInfo);
    }
  });
}

test("canonical roots preserve 65-file sorting, selection and record-only deletion", async ({}, testInfo) => {
  const session = await launch("off", 65);
  const { page } = session;
  try {
    const initial = await page.evaluate(() => window.api.observations());
    expect(
      initial.history.every((record) => initial.paths.includes(record.path)),
    ).toBe(true);
    await expect(page.locator("#count")).toHaveText("Loaded 48 / 65");
    const first = page.locator("[data-item]").filter({ hasText: "-001.jpg" });
    const second = page.locator("[data-item]").filter({ hasText: "-002.jpg" });
    const third = page.locator("[data-item]").filter({ hasText: "-003.jpg" });
    await first.click();
    await second.click({ modifiers: ["ControlOrMeta"] });
    await second.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Copy 2 files", exact: true }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Preview", exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator("#preview-image")
          .evaluate((image) => image.complete && image.naturalWidth),
      )
      .toBe(1400);
    await page
      .getByRole("button", { name: "Current file actions", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Copy 1 files", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    if (
      await page.getByRole("dialog", { name: "Original preview" }).isVisible()
    ) {
      await page
        .getByRole("button", { name: "Close preview", exact: true })
        .click();
    }
    await third.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Copy 1 files", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#selection")).toHaveText("Selected 1");
    await page
      .getByRole("menuitem", { name: "Remove records", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Keep physical files",
    );
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
    await expect(page.locator("#items")).toHaveAttribute("data-ready", "true");
    expect(initial.paths.every(fs.existsSync)).toBe(true);
    expect(await page.evaluate(() => window.api.history())).toHaveLength(64);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(page.locator("#count")).toHaveText("Loaded 65 / 65");
    await expect(page.locator("#items")).toHaveAttribute("data-ready", "true");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator("#count")).toHaveText("Loaded 65 / 65");
    await expect(page.locator("#items")).toHaveAttribute("data-ready", "true");
  } finally {
    await captureAndClose(session, testInfo);
  }
});

test("macOS path-alias negative control reproduces missing first-page association", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin");
  const session = await launch("off", 65, false);
  const { page } = session;
  try {
    const initial = await page.evaluate(() => window.api.observations());
    expect(initial.root).not.toBe(initial.realRoot);
    expect(
      initial.history.some((record) => initial.paths.includes(record.path)),
    ).toBe(false);
    await expect(page.locator("#count")).toHaveText("Loaded 48 / 65");
    await expect(
      page.locator("[data-item]").filter({ hasText: "-001.jpg" }),
    ).toHaveCount(0);
    await expect(
      page.locator("[data-item]").filter({ hasText: "-065.jpg" }),
    ).toHaveCount(1);
  } finally {
    await captureAndClose(session, testInfo);
  }
});

test("system accepts root, recent-directory and Chinese text opening; menu reveals real file", async ({}, testInfo) => {
  test.skip(!native);
  const session = await launch("off");
  const { page } = session;
  try {
    const initial = await page.evaluate(() => window.api.observations());
    for (const directory of [initial.root, initial.outputDir]) {
      const result = await page.evaluate(
        (directory) => window.api.action("open-directory", [directory]),
        directory,
      );
      expect(result).toEqual({ succeeded: [directory], failed: [] });
    }
    expect(await page.evaluate(() => window.api.action("open-text"))).toEqual({
      succeeded: [initial.textPath],
      failed: [],
    });
    await page.locator("[data-item]").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reveal", exact: true }).click();
    expect(
      (await page.evaluate(() => window.api.observations())).events,
    ).toContainEqual({
      action: "reveal",
      path: initial.paths[0],
      state: "invoked",
    });
  } finally {
    await captureAndClose(session, testInfo);
  }
});
