const { app, BrowserWindow, ipcMain, protocol, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const sharp = require("sharp");
const { hash, writeClipboard } = require("./probe.cjs");

const mode = process.env.PROBE_MODE || "off";
const count = Number(process.env.PROBE_COUNT || 2);
const canonical = process.env.PROBE_CANONICAL !== "0";
const root = process.env.PROBE_ROOT;
if (
  !root ||
  !["baseline", "filepath", "buffer", "files0", "off"].includes(mode) ||
  ![2, 65].includes(count)
) {
  throw new Error("Invalid probe launch parameters");
}
if (mode === "files0") sharp.cache({ files: 0 });
if (mode === "off") sharp.cache(false);

app.setPath("userData", root);
app.commandLine.appendSwitch("disable-gpu");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const events = [];
const thumbnails = [];
const streams = [];
let paths = [];
const outputDir = path.join(root, "synthetic-output");
const textPath = path.join(outputDir, "中文 成品说明.txt");
const historyFile = path.join(root, "history.json");
const history = () => JSON.parse(fs.readFileSync(historyFile, "utf8"));
const persist = (records) =>
  fs.writeFileSync(historyFile, JSON.stringify(records), "utf8");
const key = (file) =>
  process.platform === "win32" ? path.normalize(file).toLowerCase() : file;

function validatePaths(input) {
  if (
    !Array.isArray(input) ||
    !input.length ||
    !input.every((file) => typeof file === "string" && paths.includes(file))
  ) {
    throw new Error("Action requires current synthetic output paths");
  }
  return [...new Set(input)];
}

app
  .whenReady()
  .then(async () => {
    const directory = outputDir;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      textPath,
      "Synthetic native file opening smoke test\n",
      "utf8",
    );
    const pixels = Buffer.alloc(1400 * 900 * 3);
    for (let y = 0; y < 900; y++)
      for (let x = 0; x < 1400; x++) {
        const offset = (y * 1400 + x) * 3;
        pixels[offset] = x % 256;
        pixels[offset + 1] = y % 256;
        pixels[offset + 2] = (x + y) % 256;
      }
    const jpeg = await sharp(pixels, {
      raw: { width: 1400, height: 900, channels: 3 },
    })
      .jpeg()
      .toBuffer();
    const variants = [jpeg, await sharp(jpeg).flop().jpeg().toBuffer()];
    const now = Date.now();
    paths = Array.from({ length: count }, (_, index) => {
      const file = path.join(
        directory,
        `中文 成品 ${path.basename(root)}-${String(index + 1).padStart(3, "0")}.jpg`,
      );
      fs.writeFileSync(file, variants[index % variants.length]);
      const mtime = new Date(now + index * 1000);
      fs.utimesSync(file, mtime, mtime);
      return fs.realpathSync.native(file);
    });
    persist(
      paths.map((file, index) => ({
        id: `synthetic-${index}`,
        path: canonical ? file : path.join(directory, path.basename(file)),
        createdAt: now - index * 60_000,
        generationStatus: "succeeded",
        deliveryStatus: "ready",
        assetStatus: "ready",
        hash: hash(file),
      })),
    );

    ipcMain.handle("history", () => history());
    ipcMain.handle("observations", () => ({
      mode,
      canonical,
      root,
      realRoot: fs.realpathSync.native(root),
      platform: process.platform,
      arch: process.arch,
      versions: { ...process.versions, sharp: sharp.versions },
      cache: sharp.cache(),
      events,
      thumbnails,
      streams,
      paths,
      outputDir,
      textPath,
      sourceExists: paths.map((file) => fs.existsSync(file)),
      history: history(),
    }));
    ipcMain.handle("list", (_, limit) => {
      if (![48, 65].includes(limit))
        throw new Error("Invalid synthetic page size");
      const records = history();
      const files = paths
        .filter((file) => fs.existsSync(file))
        .map((file) => {
          const record = records.find(
            (record) => key(record.path) === key(file),
          );
          return {
            path: file,
            name: path.basename(file),
            record,
            time: record?.createdAt ?? fs.statSync(file).mtimeMs,
          };
        })
        .sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
      return { items: files.slice(0, limit), total: files.length };
    });
    ipcMain.handle("thumbnail", async (_, file) => {
      validatePaths([file]);
      if (mode === "baseline") return null;
      const input = mode === "buffer" ? fs.readFileSync(file) : file;
      const buffer = await sharp(input)
        .rotate()
        .resize(512, 512, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();
      thumbnails.push({
        path: file,
        input: mode === "buffer" ? "buffer" : "filepath",
        bytes: buffer.length,
      });
      return "data:image/jpeg;base64," + buffer.toString("base64");
    });
    ipcMain.handle("action", async (_, action, input) => {
      if (action === "open-directory" || action === "open-text") {
        const target = action === "open-text" ? textPath : input?.[0];
        if (action === "open-directory" && ![root, outputDir].includes(target))
          throw new Error("Invalid synthetic directory");
        const message = await shell.openPath(target);
        if (message) throw new Error(message);
        events.push({ action, path: target, state: "succeeded" });
        return { succeeded: [target], failed: [] };
      }
      const targets = validatePaths(input);
      if (action === "copy") {
        writeClipboard(targets);
        return { succeeded: targets, failed: [] };
      }
      if (action === "remove-record") {
        persist(
          history().filter(
            (record) => !targets.some((file) => key(file) === key(record.path)),
          ),
        );
        return { succeeded: targets, failed: [] };
      }
      if (action === "reveal") {
        shell.showItemInFolder(targets[0]);
        events.push({ action, path: targets[0], state: "invoked" });
        return { succeeded: targets, failed: [] };
      }
      if (action === "open") {
        const message = await shell.openPath(targets[0]);
        if (message) throw new Error(message);
        events.push({ action, path: targets[0], state: "succeeded" });
        return { succeeded: targets, failed: [] };
      }
      if (action !== "trash") throw new Error("Unknown synthetic file action");
      const succeeded = [];
      const failed = [];
      for (const file of targets) {
        events.push({ action, path: file, state: "started" });
        try {
          await shell.trashItem(file);
          succeeded.push(file);
          events.push({ action, path: file, state: "succeeded" });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failed.push({ path: file, message });
          events.push({ action, path: file, state: "failed", message });
        }
      }
      persist(
        history().map((record) =>
          succeeded.some((file) => key(file) === key(record.path))
            ? {
                ...record,
                deliveryStatus: "local_missing",
                assetStatus: "local_missing",
              }
            : record,
        ),
      );
      return { succeeded, failed };
    });
    protocol.handle("asset", async (request) => {
      const file = new URL(request.url).searchParams.get("path");
      validatePaths([file]);
      const stream = fs.createReadStream(file);
      const observation = { path: file, state: "opened" };
      streams.push(observation);
      stream.on("close", () => {
        observation.state = "closed";
      });
      return new Response(Readable.toWeb(stream), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" },
      });
    });
    const window = new BrowserWindow({
      width: 1000,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await window.loadFile(path.join(__dirname, "ui.html"));
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on("window-all-closed", () => app.quit());
