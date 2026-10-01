import AppKit
import Foundation

let manager = FileManager.default
let mode = CommandLine.arguments.dropFirst().first ?? "read"
var failureContext: [String: Any] = [:]

func emit(_ report: [String: Any]) throws {
    let json = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    print(String(decoding: json, as: UTF8.self))
}

func readClipboard() -> [String: Any] {
    let pasteboard = NSPasteboard.general
    let urls = pasteboard.readObjects(
        forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]
    ) as? [URL] ?? []
    let legacy = pasteboard.propertyList(
        forType: NSPasteboard.PasteboardType("NSFilenamesPboardType")
    ) as? [String] ?? []
    var report: [String: Any] = [
        "urls": urls.map { $0.resolvingSymlinksInPath().path },
        "legacy": legacy.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path },
        "types": (pasteboard.types ?? []).map { $0.rawValue },
        "items": (pasteboard.pasteboardItems ?? []).map { item in [
            "types": item.types.map { $0.rawValue },
            "fileURL": item.string(forType: .fileURL) ?? ""
        ] as [String: Any] },
        "allFileURLs": urls.allSatisfy { $0.isFileURL },
        "nativeFileType": (pasteboard.types ?? []).contains(.fileURL) ||
            (pasteboard.types ?? []).contains(NSPasteboard.PasteboardType("NSFilenamesPboardType"))
    ]
    if #available(macOS 15.4, *) {
        report["accessBehavior"] = String(describing: pasteboard.accessBehavior)
    }
    return report
}

do {
    switch mode {
    case "self-check":
        let root = manager.temporaryDirectory.appendingPathComponent("native-reader-\(UUID())")
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        let urls = ["中文 文件 甲.txt", "中文 文件 乙.txt"].map {
            root.appendingPathComponent($0)
        }
        for (index, url) in urls.enumerated() {
            try Data("synthetic-\(index)".utf8).write(to: url)
        }
        NSPasteboard.general.clearContents()
        guard NSPasteboard.general.writeObjects(urls.map { $0 as NSURL }) else {
            throw NSError(domain: "NativeReader.Write", code: 1)
        }
        let report = readClipboard()
        let expected = urls.map { $0.resolvingSymlinksInPath().path }.sorted()
        let modern = (report["urls"] as? [String] ?? []).sorted()
        guard report["nativeFileType"] as? Bool == true && modern == expected else {
            failureContext = report
            throw NSError(domain: "NativeReader.RoundTrip", code: 1)
        }
        try emit(["selfCheck": "passed", "clipboard": report])
        try manager.removeItem(at: root)
    case "read":
        try emit(readClipboard())
    case "write":
        let urls = CommandLine.arguments.dropFirst(2).map { URL(fileURLWithPath: $0) as NSURL }
        guard !urls.isEmpty else {
            throw NSError(domain: "NativeReader.Arguments", code: 1)
        }
        NSPasteboard.general.clearContents()
        guard NSPasteboard.general.writeObjects(urls) else {
            throw NSError(domain: "NativeReader.Write", code: 1)
        }
        try emit(readClipboard())
    case "trash":
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain: "NativeReader.Arguments", code: 1)
        }
        let source = URL(fileURLWithPath: CommandLine.arguments[2])
        var destination: NSURL?
        try manager.trashItem(at: source, resultingItemURL: &destination)
        guard let destination else {
            throw NSError(domain: "NativeReader.TrashDestination", code: 1)
        }
        failureContext["destination"] = destination.path ?? ""
        let bytes = try Data(contentsOf: destination as URL)
        try emit(["destination": destination.path ?? "", "bytesBase64": bytes.base64EncodedString()])
    default:
        throw NSError(domain: "NativeReader.UnknownMode", code: 1)
    }
} catch {
    let native = error as NSError
    try? emit(["error": native.localizedDescription, "domain": native.domain,
        "code": native.code, "context": failureContext])
    exit(1)
}
