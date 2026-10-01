const { app, BrowserWindow, shell } = require('electron')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const report = { platform: process.platform, arch: process.arch, versions: process.versions, cases: [] }
const roots = []
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const normalize = (files) => files.map((file) => fs.realpathSync.native(file)).sort()

function saveReport() {
  fs.mkdirSync('artifacts', { recursive: true })
  fs.writeFileSync('artifacts/native-report.json', JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
}
const deadline = setTimeout(() => {
  report.fatalError = { message: 'Native probe exceeded its 90-second deadline' }
  saveReport()
  app.exit(2)
}, 90_000)

function powershell(source, files) {
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand',
    Buffer.from("$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\n" + source, 'utf16le').toString('base64')
  ], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, NATIVE_PROBE_FILES: JSON.stringify(files) }
  }).trim()
}

function swift(mode, file) {
  return JSON.parse(execFileSync(path.resolve('mac-reader'), [mode, ...(Array.isArray(file) ? file : file ? [file] : [])], {
    encoding: 'utf8', timeout: 15_000
  }))
}

function recycledHashes(file) {
  return JSON.parse(powershell(`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[string[]]$paths = ConvertFrom-Json -InputObject $env:NATIVE_PROBE_FILES
$original = $paths[0]
$name = [IO.Path]::GetFileName($original)
$stem = [IO.Path]::GetFileNameWithoutExtension($original)
$directory = [IO.Path]::GetDirectoryName($original)
$bin = (New-Object -ComObject Shell.Application).Namespace(10)
$matches = @($bin.Items() | Where-Object {
  $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq $directory -and
  ($_.Name -eq $name -or $_.Name -eq $stem)
})
$hashes = @(foreach ($item in $matches) {
  $stream = [IO.File]::OpenRead($item.Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
})
ConvertTo-Json -Compress -InputObject $hashes
`, [file]))
}

function writeClipboard(files) {
  if (process.platform === 'win32') {
    powershell(`
Add-Type -AssemblyName System.Windows.Forms
$files = New-Object System.Collections.Specialized.StringCollection
[string[]]$paths = ConvertFrom-Json -InputObject $env:NATIVE_PROBE_FILES
foreach ($item in $paths) { [void]$files.Add($item) }
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
`, files)
    return
  }
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
ObjC.import('AppKit')
function run(argv) {
  const files = $.NSMutableArray.array
  for (const filePath of argv) {
    const item = $.NSPasteboardItem.alloc.init
    const url = $.NSURL.fileURLWithPath($(filePath))
    if (!item.setStringForType(url.absoluteString, $('public.file-url'))) throw new Error('Native file URL serialization failed')
    files.addObject(item)
  }
  const board = $.NSPasteboard.generalPasteboard
  board.clearContents
  if (!board.writeObjects(files)) throw new Error('Native file clipboard write failed')
  if (Number(board.pasteboardItems.count) !== argv.length) throw new Error('Native clipboard item count mismatch')
  return 'success'
}
`, ...files], { encoding: 'utf8', timeout: 15_000 })
}

function readJXAClipboard() {
  return JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
ObjC.import('AppKit')
const board = $.NSPasteboard.generalPasteboard
const types = ObjC.deepUnwrap(board.types)
const classes = $.NSArray.arrayWithObject($.NSClassFromString('NSURL'))
const urls = board.readObjectsForClassesOptions(classes, $.NSDictionary.dictionary)
if (urls.isNil()) throw new Error('Native NSURL reader returned nil')
const result = []
for (let i = 0; i < urls.count; i++) {
  const file = urls.objectAtIndex(i)
  if (!file.isFileURL) throw new Error('Non-file URL on the pasteboard')
  result.push(ObjC.unwrap(file.path))
}
JSON.stringify({ urls: result, types, nativeFileType: types.includes('public.file-url') })
`], { encoding: 'utf8', timeout: 15_000 }))
}

function readClipboard() {
  if (process.platform === 'win32') {
    return { urls: JSON.parse(powershell(`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
if (-not [System.Windows.Forms.Clipboard]::ContainsFileDropList()) { throw 'No FileDrop list' }
ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Clipboard]::GetFileDropList())
`, [])) }
  }
  return swift('read')
}

async function record(name, operation) {
  const started = Date.now()
  const entry = { name, status: 'running' }
  report.cases.push(entry)
  try {
    entry.result = await operation()
    entry.status = 'passed'
  } catch (error) {
    entry.status = 'failed'
    entry.error = { name: error.name, message: error.message, code: error.code ?? null,
      stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  } finally {
    entry.elapsedMs = Date.now() - started
  }
}

function makeFile(root, name) {
  const uniqueName = name + ' ' + path.basename(root)
  const file = path.join(root, uniqueName + '.txt')
  fs.writeFileSync(file, 'synthetic file bytes: ' + uniqueName, 'utf8')
  return fs.realpathSync.native(file)
}

app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 320, height: 200 })
  await window.loadURL('data:text/html,<title>Native probe</title><p>Synthetic file probe</p>')
  for (const [label, base] of [['temp', os.tmpdir()], ['home', os.homedir()]]) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'native-probe-')))
    roots.push(root)
    const files = ['中文 文件 甲', '中文 文件 乙'].map((name) => makeFile(root, name))
    if (process.platform === 'darwin') {
      await record(`swift-native-control-${label}`, () => {
        const writer = swift('write', files)
        const reader = readClipboard()
        assert.equal(reader.nativeFileType, true)
        assert.deepEqual(normalize(reader.urls), normalize(files))
        return { writer, reader }
      })
    }
    for (const count of [2, 1]) {
      await record(`clipboard-${label}-${count}`, () => {
        const expected = files.slice(0, count)
        let clipboard
        const repetitions = process.platform === 'darwin' ? 10 : 1
        for (let iteration = 0; iteration < repetitions; iteration++) {
          writeClipboard(expected)
          clipboard = readClipboard()
          assert.deepEqual(normalize(clipboard.urls), normalize(expected))
          if (process.platform === 'darwin') {
            assert.equal(clipboard.nativeFileType, true)
            clipboard.jxa = readJXAClipboard()
            assert.equal(clipboard.jxa.nativeFileType, true)
            assert.deepEqual(normalize(clipboard.jxa.urls), normalize(expected))
          }
        }
        return { ...clipboard, repetitions }
      })
    }
    await record(`path-text-negative-${label}`, () => {
      if (process.platform === 'win32') {
        powershell(`
Add-Type -AssemblyName System.Windows.Forms
[string[]]$paths = ConvertFrom-Json -InputObject $env:NATIVE_PROBE_FILES
[System.Windows.Forms.Clipboard]::SetText($paths[0])
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { throw 'Path text is not a FileDrop list' }
`, [files[0]])
      } else {
        execFileSync('/usr/bin/osascript', ['-e', 'on run argv\nset the clipboard to item 1 of argv\nend run', files[0]],
          { encoding: 'utf8', timeout: 15_000 })
        const clipboard = readClipboard()
        assert.equal(clipboard.nativeFileType, false)
        const jxa = readJXAClipboard()
        assert.equal(jxa.nativeFileType, false)
        assert.deepEqual(jxa.urls, [])
        return { ...clipboard, jxa }
      }
      return { fileDropList: false }
    })

    let macDestinationDirectory
    const nativeFile = makeFile(root, '中文 native recycle')
    const nativeHash = hash(nativeFile)
    await record(`native-recycle-${label}`, () => {
      if (process.platform === 'darwin') {
        const result = swift('trash', nativeFile)
        macDestinationDirectory = path.dirname(result.destination)
        const digest = createHash('sha256').update(Buffer.from(result.bytesBase64, 'base64')).digest('hex')
        assert.equal(digest, nativeHash)
        assert.equal(fs.existsSync(nativeFile), false)
        return result
      }
      powershell(`
Add-Type -AssemblyName Microsoft.VisualBasic
[string[]]$paths = ConvertFrom-Json -InputObject $env:NATIVE_PROBE_FILES
$file = $paths[0]
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($file,
  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
  [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
`, [nativeFile])
      assert.equal(fs.existsSync(nativeFile), false)
      const hashes = recycledHashes(nativeFile)
      assert.deepEqual(hashes, [nativeHash])
      return { sourceExists: false, trashHashes: hashes }
    })

    const electronFile = makeFile(root, '中文 electron recycle')
    const expectedHash = hash(electronFile)
    await record(`electron-recycle-${label}`, async () => {
      try {
        await shell.trashItem(electronFile)
      } catch (error) {
        error.message += '; sourceExists=' + fs.existsSync(electronFile)
        throw error
      }
      assert.equal(fs.existsSync(electronFile), false)
      const result = { sourceExists: false }
      if (process.platform === 'win32') {
        result.trashHashes = recycledHashes(electronFile)
        assert.deepEqual(result.trashHashes, [expectedHash])
      }
      if (process.platform === 'darwin') {
        assert.ok(macDestinationDirectory, 'Native recycle did not report a verified destination directory')
        const destination = path.join(macDestinationDirectory, path.basename(electronFile))
        result.destination = destination
        try {
          result.trashHash = hash(destination)
        } catch (error) {
          result.readbackError = { message: error.message, code: error.code ?? null }
          error.message += '; sourceAbsent=true; trashDestination=' + destination
          throw error
        }
        assert.equal(result.trashHash, expectedHash)
      }
      return result
    })

  }
  window.destroy()
}).catch((error) => {
  report.fatalError = { message: error.message, stack: error.stack }
}).finally(() => {
  clearTimeout(deadline)
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }) }
    catch (error) {
      report.cleanupErrors ??= []
      report.cleanupErrors.push({ root, message: error.message, code: error.code ?? null })
    }
  }
  saveReport()
  app.exit(report.fatalError || report.cleanupErrors || report.cases.some((item) => item.status === 'failed') ? 1 : 0)
})
