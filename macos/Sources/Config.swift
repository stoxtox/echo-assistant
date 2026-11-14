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

  /// The port: --port, ECHO_PORT or the old VOICEOPS_PORT, Echo's .echo-port file, else 4777 (Echo's default).
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

  /// "Keep working in the background after I quit": leave Echo's server running when the app
  /// quits, so tasks keep going. Off unless you choose it: Quit means quit. (A new key, so the old
  /// setting's default of "keep running" doesn't carry over.)
  static var keepWorkingAfterQuit: Bool {
    get { d.object(forKey: "KeepWorkingAfterQuit") as? Bool ?? false }
    set { d.set(newValue, forKey: "KeepWorkingAfterQuit") }
  }

  /// The summon shortcut's id (see HotKey.presets). Default: Option-Space.
  static var hotKey: String {
    get { d.string(forKey: "HotKey") ?? "opt-space" }
    set { d.set(newValue, forKey: "HotKey") }
  }

  // Mirrors of Echo's settings (Settings → Screen), sent by the page, so they apply before it loads.
  static var screenAware: Bool {
    get { d.object(forKey: "ScreenAware") as? Bool ?? true }
    set { d.set(newValue, forKey: "ScreenAware") }
  }

  static var pointer: Bool {
    get { d.object(forKey: "Pointer") as? Bool ?? true }
    set { d.set(newValue, forKey: "Pointer") }
  }

  /// The companion orb's size: "small" (22 pt), "medium" (28 pt, the mockup's, the default) or
  /// "large" (34 pt). The old two-step setting (CompanionSize: small 28, medium 32) carries over as
  /// the nearest new size.
  static var orbSize: String {
    get {
      if let s = d.string(forKey: "OrbSize") { return CompanionMath.size(s) }
      return d.string(forKey: "CompanionSize") == "medium" ? "large" : "medium"
    }
    set { d.set(CompanionMath.size(newValue), forKey: "OrbSize") }
  }

  /// Reduced motion for the companion and the caption pill: "system" (follow macOS), "on" or "off".
  static var reduceMotion: String {
    get { d.string(forKey: "ReduceMotion") ?? "system" }
    set { d.set(["on", "off"].contains(newValue) ? newValue : "system", forKey: "ReduceMotion") }
  }

  /// The companion's eyes: on (the default) or off (the plain drop).
  static var orbEyes: Bool {
    get { d.object(forKey: "OrbEyes") as? Bool ?? true }
    set { d.set(newValue, forKey: "OrbEyes") }
  }

  /// A few words beside the light saying what each step is (Settings → Companion): on by default.
  static var stepCaptions: Bool {
    get { d.object(forKey: "StepCaptions") as? Bool ?? true }
    set { d.set(newValue, forKey: "StepCaptions") }
  }

  /// The companion's look: "auto" (Moon over a dark background, Glass over a light one),
  /// "glass" or "moon". Anything older is Auto (CompanionMath.look).
  static var companionLook: String {
    get { d.string(forKey: "CompanionLook") ?? "auto" }
    set { d.set(newValue, forKey: "CompanionLook") }
  }

  /// The push-to-talk chord (PushToTalk.chords). Default: hold Control + Option.
  static var pttHotkey: String {
    get { d.string(forKey: "PushToTalk") ?? "ctrl-opt" }
    set { d.set(newValue, forKey: "PushToTalk") }
  }

  static var openAtLogin: Bool {
    SMAppService.mainApp.status == .enabled
  }

  static func setOpenAtLogin(_ on: Bool) throws {
    if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
  }
}

/// Whether the companion and the caption pill should keep still: Echo's setting, or macOS's
/// Reduce Motion when it's left on "system".
enum Motion {
  static var reduced: Bool {
    switch Prefs.reduceMotion {
    case "on": return true
    case "off": return false
    default: return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
  }
}

/// One clock for everything on screen that moves (the companion and the caption pill), in step
/// with the display: 120 Hz on ProMotion screens, 60 elsewhere. It only runs while something is
/// listening, so nothing ticks while Echo's overlays are hidden.
final class FrameClock: NSObject {
  static let shared = FrameClock()
  private var subscribers: [ObjectIdentifier: (CFTimeInterval) -> Void] = [:]
  private var link: AnyObject?
  private var timer: Timer?

  func add(_ owner: AnyObject, _ tick: @escaping (CFTimeInterval) -> Void) {
    subscribers[ObjectIdentifier(owner)] = tick
    start()
  }

  func remove(_ owner: AnyObject) {
    subscribers.removeValue(forKey: ObjectIdentifier(owner))
    if subscribers.isEmpty { stop() }
  }

  /// The screens changed or the Mac woke: the display link belongs to one display, which may be
  /// gone or asleep, so make a fresh one on a display that's there now.
  func rebuild() {
    guard link != nil || timer != nil else { return }
    stop()
    start()
  }

  private func start() {
    guard link == nil, timer == nil else { return }
    if #available(macOS 14.0, *), let screen = NSScreen.main ?? NSScreen.screens.first {
      let l = screen.displayLink(target: self, selector: #selector(fire))
      l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
      l.add(to: .main, forMode: .common)
      link = l
    } else {
      let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.fire() }
      RunLoop.main.add(t, forMode: .common)
      timer = t
    }
  }

  private func stop() {
    if #available(macOS 14.0, *) { (link as? CADisplayLink)?.invalidate() }
    link = nil
    timer?.invalidate()
    timer = nil
  }

  @objc private func fire() {
    let now = CACurrentMediaTime()
    for tick in Array(subscribers.values) { tick(now) }
  }
}

extension NSColor {
  /// Echo's page background (--bg in style.css), so the title bar and the page meet without a seam.
  static let echoBackground = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua
      ? NSColor(srgbRed: 0xFF / 255, green: 0xFF / 255, blue: 0xFF / 255, alpha: 1)
      : NSColor(srgbRed: 0x0A / 255, green: 0x0A / 255, blue: 0x0B / 255, alpha: 1)
  }
}
