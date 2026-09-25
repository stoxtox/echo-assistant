// Where Echo lives, which port it answers on, and the app's own preferences.
import AppKit
import ServiceManagement

enum AppConfig {
  /// Value of `--name VALUE` on the command line, if given.
  static func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
  }

  static func isEchoFolder(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.appendingPathComponent("supervisor.js").path)
      && FileManager.default.fileExists(atPath: url.appendingPathComponent("scripts/launcher.sh").path)
  }

  /// Echo's folder: --echo-dir, ECHO_DIR, the EchoDir preference (set by the installer), the folder
  /// baked in by `npm run build-app`, then ~/Applications/Echo. nil if none of them is an Echo folder.
  static let echoDir: URL? = {
    var candidates: [String] = []
    if let a = argument("--echo-dir") { candidates.append(a) }
    if let e = ProcessInfo.processInfo.environment["ECHO_DIR"] { candidates.append(e) }
    if let d = UserDefaults.standard.string(forKey: "EchoDir") { candidates.append(d) }
    if let f = Bundle.main.url(forResource: "echo-folder", withExtension: nil),
       let s = try? String(contentsOf: f, encoding: .utf8) {
      candidates.append(s.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    candidates.append(NSHomeDirectory() + "/Applications/Echo")
    for c in candidates where !c.isEmpty {
      let url = URL(fileURLWithPath: (c as NSString).expandingTildeInPath).standardizedFileURL
      if isEchoFolder(url) { return url }
    }
    return nil
  }()

  /// The port: --port, ECHO_PORT or VOICEOPS_PORT, Echo's .echo-port file, else 4777 (Echo's default).
  static let port: Int = {
    let env = ProcessInfo.processInfo.environment
    for raw in [argument("--port"), env["ECHO_PORT"], env["VOICEOPS_PORT"]] {
      if let raw, let p = Int(raw), (1...65535).contains(p) { return p }
    }
    if let dir = echoDir,
       let s = try? String(contentsOf: dir.appendingPathComponent(".echo-port"), encoding: .utf8),
       let p = Int(s.filter(\.isNumber)), (1...65535).contains(p) {
      return p
    }
    return 4777
  }()

  static var baseURL: URL { URL(string: "http://localhost:\(port)/")! }

  /// Debug aid for testing: prints page facts and writes a snapshot once Echo's page has loaded.
  static let snapshotPath: String? = argument("--snapshot")
  static let debug = ProcessInfo.processInfo.environment["ECHO_APP_DEBUG"] == "1" || snapshotPath != nil
}

enum Prefs {
  private static let d = UserDefaults.standard

  /// Leave Echo's server running after the app quits, so tasks keep going (the default).
  static var keepServerRunning: Bool {
    get { d.object(forKey: "KeepServerRunning") as? Bool ?? true }
    set { d.set(newValue, forKey: "KeepServerRunning") }
  }

  /// The summon shortcut's id (see HotKey.presets). Default: Option-Space.
  static var hotKey: String {
    get { d.string(forKey: "HotKey") ?? "opt-space" }
    set { d.set(newValue, forKey: "HotKey") }
  }

  static var openAtLogin: Bool {
    SMAppService.mainApp.status == .enabled
  }

  static func setOpenAtLogin(_ on: Bool) throws {
    if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
  }
}

extension NSColor {
  /// Echo's page background (--bg in style.css), so the title bar and the page meet without a seam.
  static let echoBackground = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua
      ? NSColor(srgbRed: 0xFA / 255, green: 0xF7 / 255, blue: 0xF2 / 255, alpha: 1)
      : NSColor(srgbRed: 0x0E / 255, green: 0x0D / 255, blue: 0x10 / 255, alpha: 1)
  }
}
