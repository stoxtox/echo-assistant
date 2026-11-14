// Menu bar items, status icons and Control Center, for the pointer and guide mode.
//
// The front app's own menus are found by AXFinder (Pointer.swift). This file adds what lives in
// the right-hand side of the menu bar: menu extras (AXExtrasMenuBar) such as Control Center,
// Wi-Fi, Bluetooth, Sound, Battery and third-party status icons, and the inside of Control Center's
// panel once it's open. It only reads the Accessibility tree; it never clicks.
//
// It also watches for the next step of a guide ("wait"): the target showing up, or the screen
// changing (a panel opening, a new window), by polling a few times a second.
import AppKit
import ApplicationServices

enum MenuBar {
  /// Names people say for the system's menu extras, as macOS labels them (normalized).
  static let aliases: [String: [String]] = [
    "wifi": ["wi fi"], "wi fi": ["wi fi"], "wireless": ["wi fi"], "internet": ["wi fi"],
    "control centre": ["control center"], "control center": ["control center"],
    "volume": ["sound"], "sound": ["sound"], "audio": ["sound"],
    "bluetooth": ["bluetooth"], "battery": ["battery"],
    "focus": ["focus"], "do not disturb": ["focus", "do not disturb"],
    "clock": ["clock"], "date": ["clock"], "time": ["clock"],
    "spotlight": ["spotlight"], "siri": ["siri"], "airdrop": ["airdrop"],
    "display": ["display"], "brightness": ["display"], "screen mirroring": ["screen mirroring"],
    "now playing": ["now playing"], "user": ["fast user switching", "user"], "vpn": ["vpn"],
    "keyboard brightness": ["keyboard brightness"], "stage manager": ["stage manager"],
  ]

  /// Is this one of the system's menu bar extras (so look there first)?
  static func isExtraName(_ query: String) -> Bool {
    let q = AXFinder.normalize(query).replacingOccurrences(of: " icon", with: "").replacingOccurrences(of: " menu", with: "")
    return aliases[q] != nil || aliases[q.replacingOccurrences(of: " ", with: "")] != nil
  }

  /// What to search for: the query, plus macOS's own name for it.
  static func queries(_ query: String) -> [String] {
    let q = AXFinder.normalize(query).replacingOccurrences(of: " icon", with: "")
    var out = [query]
    for key in [q, q.replacingOccurrences(of: " ", with: "")] { out.append(contentsOf: aliases[key] ?? []) }
    var seen = Set<String>()
    return out.filter { seen.insert(AXFinder.normalize($0)).inserted }
  }

  private static func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
  }

  private static func element(_ v: AnyObject?) -> AXUIElement? {
    guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
  }

  /// Never pointed at or searched: the Passwords app, Keychain Access, and their menu bar icon.
  /// (Oct 2, 2026: a guide step for "Apple" pointed at the Passwords icon, and it opened.)
  static func offLimits(_ app: NSRunningApplication) -> Bool {
    let id = app.bundleIdentifier ?? ""
    return id.hasPrefix("com.apple.Passwords") || id == "com.apple.keychainaccess" || ["Passwords", "Keychain Access"].contains(app.localizedName ?? "")
  }
  static func offLimitsLabel(_ s: String) -> Bool {
    let l = s.lowercased()
    return l.contains("passwords") || l.contains("keychain")
  }

  /// The apps whose menu extras and panels to search: Control Center and SystemUIServer first.
  private static func extraOwners() -> [NSRunningApplication] {
    let all = NSWorkspace.shared.runningApplications.filter { !offLimits($0) }
    let system = all.filter { ["com.apple.controlcenter", "com.apple.systemuiserver", "com.apple.Spotlight", "com.apple.Siri", "com.apple.TextInputMenuAgent"].contains($0.bundleIdentifier ?? "") }
    let me = ProcessInfo.processInfo.processIdentifier
    let others = all.filter { !system.contains($0) && $0.processIdentifier != me && $0.activationPolicy != .prohibited }
    return system + others
  }

  /// The best menu bar extra, or item in an open Control Center panel, for `query`.
  static func find(_ query: String, seconds: Double = 1.2) -> AXFinder.Hit? {
    guard AXFinder.trusted else { return nil }
    let deadline = Date().addingTimeInterval(seconds)
    let names = queries(query)
    let screens = NSScreen.screens.map(\.frame)
    var best: (score: Int, hit: AXFinder.Hit)?
    func consider(_ el: AXUIElement, app: String, bonus: Int) {
      let role = (attr(el, kAXRoleAttribute) as? String) ?? ""
      var s = 0, label = ""
      for key in [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute, "AXIdentifier"] {
        let text = (attr(el, key) as? String) ?? ""
        for n in names {
          let v = AXFinder.score(text, n)
          if v > s { s = v; label = text }
        }
      }
      guard s >= 45, !offLimitsLabel(label), let f = AXFinder.frame(el), screens.contains(where: { $0.intersects(f) }) else { return }
      s += bonus + (["AXMenuBarItem", "AXButton", "AXCheckBox", "AXMenuItem", "AXToggle", "AXDisclosureTriangle"].contains(role) ? 15 : 0)
      // The element comes along: a route's next stop is looked for inside what this one opens.
      if best == nil || s > best!.score { best = (s, AXFinder.Hit(frame: f, label: label, role: role, app: app, element: el)) }
    }
    func walk(_ root: AXUIElement, app: String, bonus: Int, limit: Int) {
      var queue = [root]
      var seen = 0
      while !queue.isEmpty, seen < limit, Date() < deadline {
        let el = queue.removeFirst()
        seen += 1
        consider(el, app: app, bonus: bonus)
        if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids) }
      }
    }
    // The menu bar's left side first: the Apple menu and the front app's own menus (File, Edit…).
    // The status icons on the right used to be the only place searched, so "Apple" matched an
    // icon that merely mentions Apple.
    if let front = NSWorkspace.shared.frontmostApplication, !offLimits(front) {
      let root = AXUIElementCreateApplication(front.processIdentifier)
      if let bar = element(attr(root, kAXMenuBarAttribute)), let items = attr(bar, kAXChildrenAttribute) as? [AXUIElement] {
        for item in items.prefix(40) { consider(item, app: front.localizedName ?? "", bonus: 20) }
      }
      if let b = best, b.score >= 115 { return b.hit }
    }
    for app in extraOwners() where Date() < deadline {
      let root = AXUIElementCreateApplication(app.processIdentifier)
      let name = app.localizedName ?? ""
      // An open Control Center (or menu extra) panel: its insides win over the menu bar icon.
      if app.bundleIdentifier == "com.apple.controlcenter", let windows = attr(root, kAXWindowsAttribute) as? [AXUIElement] {
        for w in windows { walk(w, app: name, bonus: 10, limit: 1500) }
      }
      if let extras = element(attr(root, "AXExtrasMenuBar")) { walk(extras, app: name, bonus: 0, limit: 200) }
      if let b = best, b.score >= 115 { break }
    }
    return best?.hit
  }

  /// A cheap fingerprint of what's on screen: the front app, its focused window, and how many
  /// windows are showing. It changes when a panel or menu opens, or a new window appears.
  static func screenSignature() -> String {
    let front = NSWorkspace.shared.frontmostApplication
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let title = front.map { AXFinder.focusedWindowTitle(of: $0) } ?? ""
    return "\(front?.processIdentifier ?? 0)|\(title)|\(windows.count)"
  }

  /// Looks for `target` in `app` (the front one if nil), the menu bar and Control Center.
  /// Safe to call off the main thread.
  /// `displays` must be read on the main thread (AXFinder.Displays.current()).
  /// Menu bar icons come first only when asked for (menuBar, as guide mode does for Control
  /// Center). A name like "Date", "Time" or "Display" in an app is the app's own first ("click
  /// Date" in a web page once opened the menu bar clock); the icons are only a fall-back for their
  /// own names, and a miss never goes on to other apps' status icons.
  static func locate(_ target: String, in app: NSRunningApplication?, menuBar: Bool, displays: AXFinder.Displays,
                     scope: String = "app", wantsField: Bool = false) -> AXFinder.Hit? {
    if menuBar || scope == "menu_bar", let hit = find(target) { return hit }
    if let app, case .hit(let hit) = AXFinder.find(target, in: app, displays: displays, scope: scope, wantsField: wantsField) { return hit }
    return !menuBar && isExtraName(target) && !wantsField ? find(target, seconds: 0.6) : nil
  }

  /// A stop on a route through menus ("File", "Export", "PDF…"). The first is looked up like any
  /// target (`locate`). Each later one is looked for inside what the one before it opens, and
  /// only counts once that is open: Echo never opens a menu to show the way. With nothing to
  /// look inside (the stop before was found by eye), the app is searched as for any target.
  /// Safe off the main thread.
  static func stop(_ label: String, after before: AXFinder.Hit?, in app: NSRunningApplication?, menuBar: Bool, displays: AXFinder.Displays) -> AXFinder.Hit? {
    guard let before else { return locate(label, in: app, menuBar: menuBar, displays: displays) }
    if let opener = before.element { return AXFinder.find(label, under: opener, app: before.app, displays: displays) }
    return locate(label, in: app, menuBar: false, displays: displays)
  }
}

/// Walks the light along a route through menus (PearlMath.Route decides; this looks and waits).
/// A few times a second it looks for the next stop; when that shows and the light has rested on
/// the one before, the light moves on. It answers exactly once: on the target, after its
/// patience at a stop, or when it is stopped before either. It keeps walking after an answer
/// until it is on the target, is stopped, or the first stop was never found.
final class RouteWalker {
  private var timer: Timer?
  private var busy = false
  private var token = 0
  /// The request being walked for (nil: none), how far it has got, the last stop reached, and
  /// how to answer.
  private(set) var id: String?
  private var route: PearlMath.Route?
  private var last: AXFinder.Hit?
  private var answer: ((Int?, AXFinder.Hit?) -> Void)?

  /// `arrive(i, hit)`: put the light on stop `i` (false: it couldn't be shown, so it isn't
  /// there). `answer(i, hit)`: the stop the light reached and what was found there (nil: none).
  func walk(_ id: String, route labels: [String], app: NSRunningApplication?, menuBar: Bool, patience: Double,
            arrive: @escaping (Int, AXFinder.Hit) -> Bool, answer: @escaping (Int?, AXFinder.Hit?) -> Void) {
    stop()
    token += 1
    let mine = token
    self.id = id
    route = PearlMath.Route(count: labels.count, at: CACurrentMediaTime(), patience: patience)
    self.answer = answer
    let tick = { [weak self] in
      guard let self, self.token == mine, !self.busy else { return }
      guard let next = self.route?.next else { return self.stop() }
      self.busy = true
      let displays = AXFinder.Displays.current(), before = self.last
      DispatchQueue.global(qos: .userInitiated).async {
        let hit = MenuBar.stop(labels[next], after: before, in: app, menuBar: menuBar, displays: displays)
        DispatchQueue.main.async {
          // A walk that was stopped meanwhile has answered already; this look is nobody's.
          guard self.token == mine else { return }
          self.busy = false
          let now = CACurrentMediaTime()
          if let hit, self.route?.ready(at: now) == true, arrive(next, hit), self.token == mine {
            self.route?.arrive(at: now)
            self.last = hit
          }
          if let a = self.route?.answer(at: CACurrentMediaTime()) { self.answer?(a.found ? a.index : nil, self.last) }
          if self.token == mine, self.route?.over == true { self.stop() }
        }
      }
    }
    tick()
    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in tick() }
  }

  /// Stops walking (another errand, a release, the light went home). A walk stopped before it
  /// answered answers here, with how far it got: its request is never left waiting.
  func stop() {
    timer?.invalidate()
    timer = nil
    token += 1
    busy = false
    let left = route?.stop(), answer = self.answer, last = self.last
    id = nil
    route = nil
    self.answer = nil
    self.last = nil
    if let left { answer?(left.found ? left.index : nil, last) }
  }
}

/// Waits for something to show up (guide mode's next step, or computer use's wait_for).
final class Watcher {
  private var timer: Timer?
  private var busy = false
  private var token = 0
  // Guide mode waits in several requests; "fresh" starts a new baseline, later ones keep it.
  private var baselineSignature = ""
  private var baselineThere: Bool?

  /// mode "present": done as soon as `target` is found.
  /// mode "appear": done when it's found and it wasn't there at the start, or the screen changed
  /// since (the panel the user opened, a new window), so a step isn't skipped before the user acts.
  /// `accept`: the caller's own test of what was found (a lesson wants the whole label). A hit
  /// that fails it is no find at all: the wait keeps looking until the deadline, rather than
  /// ending on the first near miss (the "Rectangle" tool, while waiting for the "Rectangle 1" layer).
  func wait(target: String, app: NSRunningApplication?, menuBar: Bool, mode: String, fresh: Bool, timeout: Double,
            accept: @escaping (AXFinder.Hit) -> Bool = { _ in true }, done: @escaping (AXFinder.Hit?, Bool) -> Void) {
    stop()
    token += 1
    let mine = token
    if fresh || baselineSignature.isEmpty {
      baselineSignature = MenuBar.screenSignature()
      baselineThere = nil
    }
    let deadline = Date().addingTimeInterval(timeout)
    let finish: (AXFinder.Hit?, Bool) -> Void = { [weak self] hit, changed in
      guard let self, self.token == mine else { return }
      self.stop()
      self.token += 1
      done(hit, changed)
    }
    let tick = { [weak self] in
      guard let self, self.token == mine, !self.busy else { return }
      if Date() > deadline { return finish(nil, MenuBar.screenSignature() != self.baselineSignature) }
      self.busy = true
      let displays = AXFinder.Displays.current()
      DispatchQueue.global(qos: .userInitiated).async {
        let hit = MenuBar.locate(target, in: app, menuBar: menuBar, displays: displays).flatMap { accept($0) ? $0 : nil }
        DispatchQueue.main.async {
          self.busy = false
          guard self.token == mine else { return }
          let changed = MenuBar.screenSignature() != self.baselineSignature
          if self.baselineThere == nil { self.baselineThere = hit != nil }
          if WaitMath.done(fits: hit != nil, mode: mode, wasThere: self.baselineThere, changed: changed) { finish(hit, changed) }
        }
      }
    }
    tick()
    timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in tick() }
  }

  func stop() {
    timer?.invalidate()
    timer = nil
  }

  /// Gives up a wait early (the user stopped it). Nothing is answered for it here.
  func cancel() {
    stop()
    token += 1
    busy = false
  }
}
