// Computer use: Echo clicks, types, presses keys and scrolls in other apps, when you've switched it
// on (Settings → Screen → "Let Echo use the computer"; off by default). This is the ONLY file in
// the app that performs Accessibility actions or posts mouse and keyboard events.
//
// Echo's server (lib/computer.js) decides whether an action may happen. Every action comes in two
// requests: "resolve" finds the target, flies the pointer to it and reports what it is (a password
// field? Echo's own window? a Privacy & Security pane?); "do" acts, only after the server's checks
// (and the user's confirmation for risky actions). This file checks again before acting.
//
// While Echo drives:
// - before every action the target app is brought to the front (and Echo waits until it really
//   is), so keys and typing never land in Echo's own window; a miss is retried once another way,
//   then reported;
// - a thin line glows around every screen's edge, the status chip says "Driving" (then
//   what Echo is doing), and the caption pill shows "esc to stop" for its first seconds
//   (Overlays.swift, Caption.swift);
// - the pointer flies to each target before anything happens;
// - taking back control (TakeBackPolicy in VoiceMath.swift; Settings → Screen): Escape ends the
//   driving session. A real click or key press of yours stops the CURRENT action at once, but the
//   session stays open and Echo keeps listening ("Okay, go ahead"). Small mouse movements are
//   ignored; grabbing the mouse while Echo is mid-step stops that step too. With "take-back ends
//   the session" set, any real input ends it, as before. Echo's own events carry a marker, so
//   they're told apart from yours, and input aimed at Echo's own windows (a card's Allow, the
//   pill, the companion; InputTarget in VoiceMath.swift) never counts. A step you allowed on its
//   card goes ahead even though you just clicked. Without a way to watch for your input, Echo won't drive;
// - it never types into a password field, and never acts in Echo's own window or in the privacy
//   panes of System Settings.
import AppKit
import ApplicationServices

enum ComputerPrefs {
  /// Mirror of Echo's computerUse setting, sent by the page. Off unless you switch it on.
  static var enabled: Bool {
    get { UserDefaults.standard.object(forKey: "ComputerUse") as? Bool ?? false }
    set { UserDefaults.standard.set(newValue, forKey: "ComputerUse") }
  }

  /// Mirror of Echo's takeBack setting: "pause" (a click or key stops the current action only) or "end".
  static var takeBack: String {
    get { UserDefaults.standard.string(forKey: "TakeBack") ?? "pause" }
    set { UserDefaults.standard.set(newValue, forKey: "TakeBack") }
  }

  /// Mirror of backgroundCursor: Echo acts without taking your mouse (Accessibility first, and
  /// after a real click the pointer goes straight back where you left it).
  static var background: Bool {
    get { UserDefaults.standard.object(forKey: "BackgroundCursor") as? Bool ?? false }
    set { UserDefaults.standard.set(newValue, forKey: "BackgroundCursor") }
  }

  /// Mirror of takeBackMovePx: how far you move the mouse mid-step before it counts.
  static var movePx: Double {
    get { UserDefaults.standard.object(forKey: "TakeBackMovePx") as? Double ?? 120 }
    set { UserDefaults.standard.set(newValue, forKey: "TakeBackMovePx") }
  }
}

/// Key names (as lib/computer.js parses them) to US-layout virtual key codes.
enum Keys {
  // Keep in step with KEY_NAMES in lib/computer.js.
  static let codes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
    "p": 35, "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "escape": 53,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
    "f10": 109, "f11": 103, "f12": 111, "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119,
    "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
  ]

  /// "shift+cmd+t" → (flags, key code).
  static func parse(_ combo: String) -> (CGEventFlags, CGKeyCode)? {
    var flags: CGEventFlags = []
    var code: CGKeyCode?
    for part in combo.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init) {
      switch part {
      case "cmd": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "opt": flags.insert(.maskAlternate)
      case "ctrl": flags.insert(.maskControl)
      case "": code = codes["+"] ?? code
      default:
        guard let c = codes[part], code == nil else { return nil }
        code = c
      }
    }
    return code.map { (flags, $0) }
  }
}

// MARK: the driver

final class ComputerDriver {
  static let shared = ComputerDriver()
  /// Put on every event Echo posts, so the take-back watcher can tell them from yours.
  static let marker: Int64 = 0x0EC40

  weak var pointer: PointerOverlay?
  var post: ((String, [String: Any]) -> Void)?

  /// The edge glow and the chip are up for this session.
  private var shownDriving = false
  let watcher = Watcher()
  private var runId = ""
  private var abortedRun = ""
  private(set) var driving = false
  /// The app Echo is acting in, for the menu bar menu's status line ("" between runs).
  private(set) var appName = ""
  private var idleWork: DispatchWorkItem?
  private var lastPosted = Date.distantPast
  private var tap: CFMachPort?
  private var tapSource: CFRunLoopSource?
  private var monitors: [Any] = []
  private var policy = TakeBackPolicy()
  /// Echo is mid-step (finding, pointing, acting): your input stops that step.
  private var inFlight = 0
  /// The server's request number in this run (a new one per thing you ask), and the one you took over.
  private var request = -1
  private var pausedRequest = -1
  /// Read-along: the page moving at a reading pace until it is held (ScrollGlide, below).
  private let glide = ScrollGlide()
  /// Bumped when you take over, so a step that's waiting to act knows to stop.
  private var epoch = 0
  private var lastPause = Date.distantPast
  /// Right after you allow a step on its card, moving the mouse away from the card isn't taking over.
  private var confirmGraceUntil = Date.distantPast
  /// The window list the take-back check looks at, refreshed at most every 0.3 s (mouse moves are many).
  private var windowsCache: (at: Date, list: [InputTarget.Win]) = (.distantPast, [])

  private struct Resolved {
    let element: AXUIElement?
    let frame: CGRect?
    let pid: pid_t
    let action: String
    let label: String
    /// What the caption beside the light says for this step (BubbleMath.phrase).
    let caption: String
    let at: Date
    /// Where a drag ends.
    var to: CGRect? = nil
    /// A spreadsheet cell to go to first ("A1"): the target was a cell reference (goToCell).
    var cell: String? = nil
  }
  private var resolved: [String: Resolved] = [:]
  /// The parts of a spreadsheet window found last (the name box, the formula bar, the grid, and
  /// the controls that show bold and the like), so each step doesn't search for them again.
  private var sheetCache: (pid: pid_t, parts: [SheetMath.Part: AXUIElement], formats: [String: AXUIElement]) = (0, [:], [:])
  /// A typed line break is Return here (a terminal), else Shift+Return (KeyMath.pieces).
  private var returnBreaks = false
  /// The last observation (observe): its id, and each ref's element. A ref is only good for it.
  private var observedSnap = ""
  private var observed: [String: (element: AXUIElement, frame: CGRect, name: String)] = [:]
  /// The last observation's refs and where they are, for the Set-of-Marks badges on a look.
  private(set) var lastMarks: [(label: String, frame: CGRect)] = []

  private let me = ProcessInfo.processInfo.processIdentifier
  private let source = CGEventSource(stateID: .privateState)

  // MARK: Accessibility helpers

  private func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
  }

  private func string(_ el: AXUIElement, _ name: String) -> String { (attr(el, name) as? String) ?? "" }

  private func element(_ v: AnyObject?) -> AXUIElement? {
    guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
  }

  private func pid(_ el: AXUIElement) -> pid_t {
    var p: pid_t = 0
    AXUIElementGetPid(el, &p)
    return p
  }

  private func actions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    return AXUIElementCopyActionNames(el, &names) == .success ? (names as? [String] ?? []) : []
  }

  private func parent(_ el: AXUIElement) -> AXUIElement? { element(attr(el, kAXParentAttribute)) }

  private func isSecure(_ el: AXUIElement?) -> Bool {
    guard let el else { return false }
    return string(el, kAXRoleAttribute) == "AXSecureTextField" || string(el, kAXSubroleAttribute) == "AXSecureTextField"
  }

  private func focusedElement() -> AXUIElement? {
    element(attr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute))
  }

  /// What has the keyboard focus inside `app` (not whatever app is in front).
  private func focusedElement(in app: NSRunningApplication) -> AXUIElement? {
    element(attr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute))
  }

  // MARK: focus: the target app in front before every action

  /// The app an action is for: the one named, else the front one (never Echo itself).
  private func targetApp(named name: String?) -> NSRunningApplication? {
    if let a = FrontApp.target(named: name), a.processIdentifier != me { return a }
    return FrontApp.target()
  }

  private func isFront(_ app: NSRunningApplication) -> Bool {
    NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
  }

  /// Puts the app's focused (or first) window on top of its others.
  private func raiseWindow(_ app: NSRunningApplication) {
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    let win = element(attr(ax, kAXFocusedWindowAttribute)) ?? (attr(ax, kAXWindowsAttribute) as? [AXUIElement])?.first
    guard let win else { return }
    AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementPerformAction(win, kAXRaiseAction as CFString)
  }

  /// Checks every 60 ms until `app` is in front or time runs out.
  private func waitFront(_ app: NSRunningApplication, until: Date, _ done: @escaping (Bool) -> Void) {
    if isFront(app) { return done(true) }
    guard Date() < until, !app.isTerminated else { return done(false) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [weak self] in
      guard let self else { return }
      self.waitFront(app, until: until, done)
    }
  }

  /// Brings `app` to the front and waits until it really is, with its window raised. If asking it
  /// to activate doesn't take, tries once more the way `open -a` does. Calls back on the main thread.
  func bringForward(_ app: NSRunningApplication, _ done: @escaping (Bool) -> Void) {
    guard app.processIdentifier != me else { return done(false) }
    if isFront(app) {
      raiseWindow(app)
      return done(true)
    }
    // Echo in front hands over to the app (macOS 14's cooperative activation asks for this).
    if #available(macOS 14.0, *), NSApp.isActive { NSApp.yieldActivation(to: app) }
    app.unhide()
    if #available(macOS 14.0, *) { app.activate() } else { app.activate(options: [.activateIgnoringOtherApps]) }
    waitFront(app, until: Date().addingTimeInterval(1.2)) { [weak self] ok in
      guard let self else { return }
      if ok {
        self.raiseWindow(app)
        return done(true)
      }
      guard let url = app.bundleURL else { return done(false) }
      let cfg = NSWorkspace.OpenConfiguration()
      cfg.activates = true
      NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, _ in
        DispatchQueue.main.async {
          self.waitFront(app, until: Date().addingTimeInterval(1.5)) { ok in
            if ok { self.raiseWindow(app) }
            done(ok)
          }
        }
      }
    }
  }

  /// AppKit screen coordinates (bottom-left origin) to the global top-left ones events and AX use.
  static func toGlobal(_ p: CGPoint) -> CGPoint {
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    return CGPoint(x: p.x, y: top - p.y)
  }

  private func elementAt(_ r: CGRect) -> AXUIElement? {
    let g = Self.toGlobal(CGPoint(x: r.midX, y: r.midY))
    var el: AXUIElement?
    return AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(g.x), Float(g.y), &el) == .success ? el : nil
  }

  /// Would acting at this spot land in one of Echo's own windows? Only if Echo's window really is
  /// the front-most one there: its main window sitting *behind* another app's doesn't count (it
  /// did before, and typing into Chrome's address bar was refused because Echo's window was
  /// under it).
  private func inEchoWindow(_ r: CGRect?) -> Bool {
    guard let r else { return false }
    let p = CGPoint(x: r.midX, y: r.midY)
    guard NSApp.windows.contains(where: { $0.isVisible && !$0.ignoresMouseEvents && $0.frame.contains(p) }) else { return false }
    // Echo's click-through overlays (the edge glow, the chip, the pointer, the caption bar) never take clicks.
    var overlays = Set(NSApp.windows.filter { $0.isVisible && $0.ignoresMouseEvents }.map(\.windowNumber))
    if let n = CaptionBar.shared.windowNumber { overlays.insert(n) }
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let windows = list.compactMap { d -> PointMath.Win? in
      guard let pid = (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
            let number = (d[kCGWindowNumber as String] as? NSNumber)?.intValue,
            let b = d[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
      return PointMath.Win(pid: pid, number: number, bounds: bounds,
                           layer: (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                           alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    }
    // No window list to go by: be safe.
    guard !windows.isEmpty else { return true }
    return PointMath.topWindowOwner(at: Self.toGlobal(p), windows: windows, skipping: overlays) == me
  }

  private static let privacyWords = try! NSRegularExpression(pattern: "privacy|security|accessibility|screen (recording|capture)|input monitoring|full disk|automation|files (and|&) folders|passwords|login items|touch id|users (and|&) groups|developer tools|app management", options: [.caseInsensitive])

  /// What the server needs to judge an action on `el`.
  private func describe(_ el: AXUIElement?, pid p: pid_t, fallbackLabel: String) -> [String: Any] {
    let app = NSRunningApplication(processIdentifier: p)
    let bundle = app?.bundleIdentifier ?? ""
    var window = ""
    if let app { window = AXFinder.focusedWindowTitle(of: app) }
    var info: [String: Any] = ["app": app?.localizedName ?? "", "bundle": bundle, "window": window]
    if let el {
      let role = string(el, kAXRoleAttribute)
      let secure = isSecure(el)
      info["role"] = role
      info["subrole"] = string(el, kAXSubroleAttribute)
      info["secure"] = secure
      let label = [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXHelpAttribute].map { string(el, $0) }.first { !$0.isEmpty }
      var titled = ""
      if let t = element(attr(el, "AXTitleUIElement")) { titled = string(t, kAXValueAttribute) }
      info["label"] = label ?? (["AXStaticText", "AXButton", "AXLink"].contains(role) && !secure ? string(el, kAXValueAttribute) : fallbackLabel)
      info["field"] = [titled, string(el, "AXPlaceholderValue"), string(el, kAXDescriptionAttribute), string(el, kAXTitleAttribute), string(el, "AXIdentifier")].filter { !$0.isEmpty }.joined(separator: " ")
    } else {
      info["label"] = fallbackLabel
    }
    let settings = bundle.hasPrefix("com.apple.systempreferences") || bundle.hasPrefix("com.apple.Settings")
    let range = NSRange(window.startIndex..., in: window)
    info["privacyPane"] = settings && Self.privacyWords.firstMatch(in: window, range: range) != nil
    info["inEcho"] = p == me
    return info
  }

  // MARK: requests from Echo

  /// "act" (step resolve or do) and "wait". Calls `answer` once, on the main thread.
  /// `id`: the request's own id, by which the pointer's light searches for it (and by which the
  /// server calls a search off).
  func handle(kind: String, id: String = "", _ params: [String: Any], answer: @escaping ([String: Any]) -> Void) {
    let fail = { (code: String, message: String) in answer(["ok": false, "error": code, "message": message]) }
    if kind == "wait" { return wait(params, answer: answer) }
    if kind == "observe" { return observe(params, answer: answer) }
    if kind == "state" { return state(params, answer: answer) }
    if kind == "locate" { return locate(params, answer: answer) }
    guard ComputerPrefs.enabled else { return fail("off", "Computer use is off in Echo's Settings.") }
    guard AXFinder.trusted else {
      AXFinder.prompt()
      return fail("permission", "To click and type for you, allow Echo under Accessibility in System Settings, Privacy & Security.")
    }
    let run = params["runId"] as? String ?? ""
    guard run != abortedRun else { return fail("aborted", "You took back control.") }
    if run != runId { runId = run; pausedRequest = -1 }
    request = (params["request"] as? NSNumber)?.intValue ?? request
    // You allowed this step on its card (or said yes): your own click there, or anything before
    // it, doesn't stop it. Clicking or typing in another app from now on still does.
    // The step itself ("do") is marked too: a scroll between finding the target and acting on it,
    // right after the Allow click, doesn't stop it either.
    if params["confirmed"] as? Bool == true, ["resolve", "do"].contains(params["step"] as? String ?? "") {
      if pausedRequest == request { pausedRequest = -1 }
      confirmGraceUntil = max(confirmGraceUntil, Date().addingTimeInterval(1.5))
    }
    // You took over this request: nothing more happens in it (the next thing you ask may act again).
    guard request != pausedRequest || request < 0 && pausedRequest < 0 else {
      return fail("paused", "You took over, so Echo stopped this step.")
    }
    inFlight += 1
    let started = epoch
    let reply = { [weak self] (b: [String: Any]) in
      guard let self else { return answer(b) }
      self.inFlight = max(0, self.inFlight - 1)
      // You took over while this step was under way: it's reported as stopped.
      if self.epoch != started, b["ok"] as? Bool == true, params["step"] as? String == "resolve" {
        return answer(["ok": false, "error": "paused", "message": "You took over, so Echo stopped this step."])
      }
      answer(b)
    }
    switch params["step"] as? String {
    case "resolve": resolve(params, id: id, answer: reply)
    case "do": perform(params, answer: reply)
    default: reply(["ok": false, "error": "bad_step", "message": "Unknown step."])
    }
  }

  private func number(_ v: Any?) -> CGFloat? { (v as? NSNumber).map { CGFloat(truncating: $0) } }

  private func resolve(_ p: [String: Any], id: String, answer: @escaping ([String: Any]) -> Void) {
    // Which step of the request this is (and how many Echo expects): the pill's counter and line.
    if let n = (p["stepNo"] as? NSNumber)?.intValue { CaptionBar.shared.setStep(n, of: (p["stepsOf"] as? NSNumber)?.intValue ?? 0) }
    guard let app = targetApp(named: p["app"] as? String) else {
      return answer(["ok": false, "error": "focus", "message": "There's no app to act in. Open one first."])
    }
    appName = app.localizedName ?? ""
    // Menu bar helpers (Control Center…) can't come to the front, and don't need to.
    guard app.activationPolicy == .regular, p["activate"] as? Bool ?? true else { return resolve(p, in: app, id: id, answer: answer) }
    bringForward(app) { [weak self] ok in
      guard let self else { return }
      guard ok else {
        return answer(["ok": false, "error": "focus", "app": app.localizedName ?? "",
                       "message": "Couldn't bring \(app.localizedName ?? "the app") to the front."])
      }
      self.resolve(p, in: app, id: id, answer: answer)
    }
  }

  private func resolve(_ p: [String: Any], in app: NSRunningApplication?, id: String, answer: @escaping ([String: Any]) -> Void) {
    // Pasting (typing's fallback for rich-text editors) looks and is found like typing.
    let action = (p["action"] as? String ?? "") == "paste_text" ? "type_text" : p["action"] as? String ?? ""
    let target = (p["target"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let scope = ActMath.scope(p["scope"] as? String, bundle: app?.bundleIdentifier)
    let wantsField = action == "type_text" || action == "clear_field"
    let spot = number(p["x"]) != nil && number(p["y"]) != nil
    var dragTo: CGRect?
    var cellTo: String?
    var match: (score: Int, interactive: Bool)?
    let finish = { [weak self] (el: AXUIElement?, frame: CGRect?, label: String) in
      guard let self else { return }
      let owner = el.map { self.pid($0) } ?? app?.processIdentifier ?? 0
      var info = self.describe(el, pid: owner, fallbackLabel: label)
      if self.inEchoWindow(frame) { info["inEcho"] = true }
      if action == "drag", let to = dragTo, self.inEchoWindow(to) { info["inEcho"] = true }
      let token = UUID().uuidString
      self.resolved = self.resolved.filter { Date().timeIntervalSince($0.value.at) < 30 }
      // A cell: it goes by its reference, whatever element stands for it (the name box, the grid).
      if let cellTo {
        info["label"] = cellTo
        info["role"] = "AXCell"
        info["field"] = "cell \(cellTo)"
        info["secure"] = false
      }
      // The caption beside the light: the step's own words from the server, else where Echo is
      // about to click or type (never what she types; a password field is only ever called that).
      let caption = BubbleMath.phrase(caption: p["caption"] as? String ?? "", action: action, target: info["label"] as? String ?? target,
                                      to: p["to"] as? String ?? "", direction: p["direction"] as? String ?? "", secure: info["secure"] as? Bool ?? false)
      self.resolved[token] = Resolved(element: el, frame: frame, pid: owner, action: action, label: info["label"] as? String ?? label, caption: caption, at: Date(), to: dragTo, cell: cellTo)
      info["ok"] = true
      info["found"] = true
      info["token"] = token
      info["scope"] = scope
      if let m = match {
        info["matchScore"] = m.score
        info["interactive"] = m.interactive
      }
      // Where it is, in words, so Echo's own narration can say where (a thing found by name
      // only: not a spot picked by eye, nor a cell, which goes by its reference).
      if !target.isEmpty, cellTo == nil {
        for (k, v) in AXFinder.place(of: el, frame: frame, in: app, displays: AXFinder.Displays.current()) { info[k] = v }
      }
      // Show where Echo is about to act before anything happens (unless the server has stopped
      // waiting for this step), in the colour of what she means to do there: showing, acting, asking.
      if let frame, !(info["inEcho"] as? Bool ?? false), self.pointer?.calledOff(id) != true {
        self.showDriving()
        CaptionBar.shared.avoid(frame)
        self.pointer?.point(at: frame, label: self.verb(action, info["label"] as? String ?? target), caption: caption, pinned: false, role: info["role"] as? String ?? "",
                            intent: PearlMath.intent(p["intent"] as? String ?? "act"), request: id)
      }
      answer(info)
    }
    // A ref from the last observation: exactly that element (still there, or it's stale).
    if let ref = p["ref"] as? String, !ref.isEmpty {
      guard (p["snapshot"] as? String) == observedSnap, let o = observed[ref], let f = AXFinder.frame(o.element) else {
        return answer(["ok": true, "found": false, "stale": true, "message": "\(ref) is from an older look at the app (or it's gone). Observe again and use the new ref."])
      }
      match = (100, true)
      return finish(o.element, f, o.name)
    }
    // A drag's end: a label, or a spot in the last look's picture.
    if action == "drag" {
      if let x = number(p["to_x"]), let y = number(p["to_y"]), let last = ScreenLook.last {
        dragTo = ScreenLook.toScreen(CGRect(x: x - 4, y: y - 4, width: 8, height: 8), frame: last.frame, size: last.size)
      } else if let to = (p["to"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !to.isEmpty {
        dragTo = MenuBar.locate(to, in: app, menuBar: false, displays: AXFinder.Displays.current(), scope: scope)?.frame
      }
      guard dragTo != nil else { return answer(["ok": true, "found": false, "message": "Couldn't find where to drag it to."]) }
    }
    // Keys and typing without a target act on whatever has the keyboard focus in the target app.
    // (Typing at a spot picked by eye, x/y, goes to that spot: it's found below.)
    if (action == "press_keys" || action == "type_text" || action == "clear_field") && target.isEmpty && !(spot && action != "press_keys") {
      let el = app.flatMap { focusedElement(in: $0) } ?? focusedElement()
      return finish(el, el.flatMap { AXFinder.frame($0) }, "")
    }
    if action == "scroll" && target.isEmpty {
      let m = NSEvent.mouseLocation
      let r = CGRect(x: m.x - 1, y: m.y - 1, width: 2, height: 2)
      return finish(elementAt(r), r, "")
    }
    // A spot found by eye in the last look's picture.
    if let x = number(p["x"]), let y = number(p["y"]), let last = ScreenLook.last {
      let r = ScreenLook.toScreen(CGRect(x: x - 4, y: y - 4, width: 8, height: 8), frame: last.frame, size: last.size)
      return finish(elementAt(r), r, target)
    }
    guard !target.isEmpty else { return answer(["ok": false, "error": "no_target", "message": "Say what to act on."]) }
    // A cell reference in Excel or Numbers ("A1", "cell B12"): Echo goes there itself when the
    // step is done (goToCell). Here it only finds what stands for the cell, so nothing on screen
    // changes before the step is allowed. A plain click or typing only: a right-click, a
    // double-click or a click with keys held needs the cell itself on screen (the label search).
    let plainClick = action == "click" && (p["button"] as? String ?? "left").lowercased() != "right" && !(p["double"] as? Bool ?? false)
      && ((p["clicks"] as? NSNumber)?.intValue ?? 1) <= 1 && (p["modifiers"] as? String ?? "").isEmpty
    if let app, SheetMath.isSheet(app.bundleIdentifier), let cell = SheetMath.cellRef(target), plainClick || wantsField {
      // Excel: cells go by the Name Box (or Go To when it's hidden). Numbers has neither, so the
      // cell itself is found in the table by its name.
      if app.bundleIdentifier == SheetMath.excel {
        let parts = sheetParts(app.processIdentifier)
        let el = parts[.nameBox] ?? parts[.grid]
        cellTo = cell
        match = (100, true)
        return finish(el, el.flatMap { AXFinder.frame($0) }, cell)
      }
      let displays = AXFinder.Displays.current()
      pointer?.searching(id, in: app, intent: p["intent"] as? String ?? "act", target: target)
      return DispatchQueue.global(qos: .userInitiated).async {
        let hit = MenuBar.locate(cell, in: app, menuBar: false, displays: displays, scope: "app")
        DispatchQueue.main.async {
          guard let hit, SheetMath.cellRef(hit.label) == cell else {
            return answer(["ok": true, "found": false, "message": "Couldn't find cell \(cell) in the table. Scroll until it shows, then try again."])
          }
          cellTo = cell
          match = (hit.score, true)
          finish(hit.element ?? self.elementAt(hit.frame), hit.frame, cell)
        }
      }
    }
    let useScreen = (p["useScreen"] as? Bool ?? false) && Prefs.screenAware
    let displays = AXFinder.Displays.current()
    let menuBar = p["menuBar"] as? Bool ?? false
    // Looking for it by name: the light searches meanwhile if that takes a while.
    pointer?.searching(id, in: app, intent: p["intent"] as? String ?? "act", target: target)
    DispatchQueue.global(qos: .userInitiated).async {
      let hit = MenuBar.locate(target, in: app, menuBar: menuBar, displays: displays, scope: scope, wantsField: wantsField)
      // Scope "page": a screen search only counts text inside the web page, never the tab strip.
      let pageOnly = scope == "page"
      let page = pageOnly && hit == nil ? (app ?? NSWorkspace.shared.frontmostApplication).flatMap { AXFinder.pageFrame(of: $0, primaryHeight: displays.primaryHeight) } : nil
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        // Act on what matched (or the control around it), never on whatever a hit-test at its
        // centre finds (in Chrome that was the text inside the button: 28% of targets).
        if let hit {
          match = (hit.score, hit.interactive)
          return finish(hit.element ?? self.elementAt(hit.frame), hit.frame, hit.label)
        }
        guard useScreen, ScreenLook.supported, ScreenLook.hasPermission else {
          return answer(["ok": true, "found": false, "message": "Couldn't find \"\(target)\" on screen."])
        }
        self.pointer?.showLooking(on: ScreenLook.activeScreen())
        ScreenLook.capture { result in
          self.pointer?.hideLooking(after: 0.4)
          if case .success(let shot) = result, let box = AXFinder.find(target, in: shot, page: page, pageOnly: pageOnly) {
            finish(self.elementAt(box.frame), box.frame, box.label)
          } else {
            answer(["ok": true, "found": false, "message": "Couldn't find \"\(target)\" on screen."])
          }
        }
      }
    }
  }

  private func verb(_ action: String, _ label: String) -> String {
    switch action {
    case "click": return label.isEmpty ? "Clicking here" : "Clicking “\(label)”"
    case "type_text": return "Typing here"
    case "clear_field": return "Clearing"
    case "scroll": return "Scrolling"
    case "hover": return label.isEmpty ? "Hovering" : "Hovering over “\(label)”"
    case "drag": return label.isEmpty ? "Dragging" : "Dragging “\(label)”"
    default: return label
    }
  }

  private func perform(_ p: [String: Any], answer done: @escaping ([String: Any]) -> Void) {
    // The companion orb shows how it went: a sparkle, or a soft wobble (not when you took over).
    let answer = { [weak self] (b: [String: Any]) in
      let code = b["error"] as? String ?? ""
      if !["aborted", "paused", "stale"].contains(code) { self?.pointer?.finished(ok: b["ok"] as? Bool ?? false) }
      if b["ok"] as? Bool ?? false { CaptionBar.shared.stepFinished() }
      StatusChip.shared.setDoing(nil)
      done(b)
    }
    let fail = { (code: String, message: String) in answer(["ok": false, "error": code, "message": message]) }
    guard let token = p["token"] as? String, let r = resolved.removeValue(forKey: token), Date().timeIntervalSince(r.at) < 30 else {
      return fail("stale", "That target has gone stale. Try the step again.")
    }
    guard r.pid != me else { return fail("echo", "Echo doesn't act in its own window.") }
    guard startWatching() else {
      return fail("permission", "So you can always take back control, Echo needs Input Monitoring (or Accessibility) before it drives. Allow it in System Settings, Privacy & Security.")
    }
    driving = true
    CaptionBar.shared.driveBegan() // the pill and Stop are the app's to show while it drives, page or no page
    showDriving()
    StatusChip.shared.setDoing(r.action)
    bumpIdle()
    var wait = 0.5
    if let f = r.frame {
      CaptionBar.shared.avoid(f)
      pointer?.point(at: f, label: verb(r.action, r.label), caption: r.caption, pinned: false, action: r.action, dragTo: r.to)
      // The companion gets there, pulses and throws a glint at the target: the click lands just after.
      wait = pointer?.aboutToAct(at: f) ?? wait
    }
    // A moment for the companion to get there, so you can see what's about to happen.
    let started = epoch
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
      guard let self else { return }
      guard self.driving, self.runId != self.abortedRun else { return fail("aborted", "You took back control.") }
      // Stopped before acting: nothing was done (acted: false), so Echo may try a step you allowed again.
      guard self.epoch == started else { return answer(["ok": false, "error": "paused", "acted": false, "message": "You took over, so Echo stopped this step."]) }
      // The app in front again, right before acting (a card, a dialog or Echo's own window may
      // have taken the focus since the target was found).
      guard let app = NSRunningApplication(processIdentifier: r.pid), app.activationPolicy == .regular else { return self.act(p, r, answer: answer) }
      self.bringForward(app) { ok in
        guard self.driving, self.runId != self.abortedRun else { return fail("aborted", "You took back control.") }
        guard self.epoch == started else { return answer(["ok": false, "error": "paused", "acted": false, "message": "You took over, so Echo stopped this step."]) }
        guard ok else { return answer(["ok": false, "error": "focus", "app": app.localizedName ?? "", "message": "Couldn't bring \(app.localizedName ?? "the app") to the front."]) }
        self.act(p, r, answer: answer)
      }
    }
  }

  /// The action itself, with the target app in front: observe → act → verify. Echo looks at the
  /// app just before acting (what has the focus, its value, the window, the page's address, open
  /// menus, a fingerprint of what's showing), acts, then looks again until something changes
  /// (up to about a second). A click whose Accessibility press changed nothing is tried once more
  /// as a real mouse click. "ok" with verified:false means it was done but nothing visibly
  /// changed: the server never reports that as success.
  private func act(_ p: [String: Any], _ r: Resolved, answer: @escaping ([String: Any]) -> Void) {
    let started = epoch
    returnBreaks = NSRunningApplication(processIdentifier: r.pid).map { KeyMath.returnApps.contains($0.bundleIdentifier ?? "") } ?? false
    let fail = { (code: String, message: String) in answer(["ok": false, "error": code, "message": message]) }
    // Checked last thing: never into Echo's own window (only if it's really the one in front there).
    guard !inEchoWindow(r.frame) else { return fail("echo", "Echo doesn't act in its own window.") }
    let action = p["action"] as? String ?? ""
    if ["type_text", "press_keys", "clear_field", "paste_text"].contains(action) {
      guard NSWorkspace.shared.frontmostApplication?.processIdentifier != me else {
        return fail("focus", "Echo's own window has the keyboard, so nothing was typed.")
      }
    }
    let before = snapshot(r.pid, target: r.element)
    let t0 = Date()
    let verified = { [weak self] (via: String, extra: [String: Any]) in
      guard let self else { return }
      self.bumpIdle()
      self.verify(r, before: before, started: started) { after, changes in
        var out = self.result(via: via, pid: r.pid)
        out["verified"] = !changes.isEmpty
        out["changes"] = changes
        out["observed"] = self.observed(after)
        out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
        for (k, v) in extra { out[k] = v }
        answer(out)
      }
    }
    switch action {
    case "click" where r.cell != nil:
      // A cell by its reference: Echo goes there (the Name Box, Go To, or a click on the cell in
      // Numbers) and reads back which cell is selected.
      let cell = r.cell ?? ""
      goToCell(cell, r, started: started) { [weak self] problem in
        guard let self else { return }
        if let problem { return answer(problem) }
        self.bumpIdle()
        let now = self.snapshot(r.pid, target: r.element)
        var changes = VerifyMath.changes(before, now)
        let selected = self.cellName(r.pid)
        // The cell is selected (seen in the Name Box or on the cell): that is the change, even
        // when it was selected already.
        if selected == cell, !changes.contains("target_state") { changes.append("target_state") }
        var out = self.result(via: "keys", pid: r.pid)
        out["verified"] = selected == cell || (selected == nil && !changes.isEmpty)
        out["changes"] = changes
        out["observed"] = self.observed(now)
        out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
        answer(out)
      }
    case "click":
      let button = (p["button"] as? String ?? "left").lowercased() == "right" ? "right" : "left"
      let count = max(1, min(3, (p["clicks"] as? NSNumber)?.intValue ?? ((p["double"] as? Bool ?? false) ? 2 : 1)))
      let mods = flags(ActMath.modifiers(p["modifiers"] as? String))
      let via = click(r, button: button, count: count, mods: mods)
      guard via != "none" else { return fail("no_target", "There's nothing there to click.") }
      // An Accessibility press that changed nothing: once more as a real click (Gmail's Compose).
      // Never on a switch or checkbox: if its press landed late, a second click would switch it
      // straight back; it gets longer to show its new state instead.
      guard via == "accessibility", button == "left", let f = r.frame else { return verified(via, [:]) }
      let toggle = r.element.map { ActMath.toggleRoles.contains(string($0, kAXRoleAttribute)) } ?? false
      if toggle {
        return verify(r, before: before, started: started, seconds: 1.2) { [weak self] after, changes in
          guard let self else { return }
          var out = self.result(via: via, pid: r.pid)
          out["verified"] = !changes.isEmpty
          out["changes"] = changes
          out["observed"] = self.observed(after)
          out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
          answer(out)
        }
      }
      verify(r, before: before, started: started, seconds: 0.6) { [weak self] after, changes in
        guard let self else { return }
        if !changes.isEmpty {
          var out = self.result(via: via, pid: r.pid)
          out["verified"] = true
          out["changes"] = changes
          out["observed"] = self.observed(after)
          out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
          return answer(out)
        }
        guard self.epoch == started, self.driving else { return fail("paused", "You took over, so Echo stopped this step.") }
        self.postClick(at: f, count: count, button: "left", flags: mods)
        verified("accessibility+events", [:])
      }
    case "hover":
      guard let f = r.frame else { return fail("no_target", "There's nothing there to hover over.") }
      mark(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: Self.toGlobal(CGPoint(x: f.midX, y: f.midY)), mouseButton: .left))
      // Hover-only controls (FaceTime's call controls, tooltips) take a moment to show.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { verified("events", [:]) }
    case "drag":
      guard let from = r.frame, let to = r.to else { return fail("no_target", "Echo needs where to drag from and to.") }
      drag(from: from, to: to) { verified("events", [:]) }
    case "type_text", "clear_field":
      let text = action == "clear_field" ? "" : (p["text"] as? String ?? "")
      let mode = p["mode"] as? String
      let replace = action == "clear_field" || mode == "replace"
      // A field by its name, or a spot picked by eye (x/y): Echo puts the cursor there first.
      let hasTarget = !(p["target"] as? String ?? "").isEmpty || (number(p["x"]) != nil && number(p["y"]) != nil)
      // A cell by its reference: Echo goes there first, then types in the grid.
      if let cell = r.cell {
        return goToCell(cell, r, started: started) { [weak self] problem in
          guard let self else { return }
          if let problem { return answer(problem) }
          // The keyboard must be back in the sheet, not left in the Name Box or a dialog's field.
          if let f = self.focused(r.pid), self.isEditable(f) {
            return answer(["ok": false, "error": "focus_guard", "focused": self.named(f),
                           "message": "The keyboard didn't come back to the sheet after going to \(cell), so nothing was typed."])
          }
          self.typeInCell(text, mode: mode, clear: action == "clear_field", r: r, before: before, t0: t0, started: started, answer: answer)
        }
      }
      focusField(r, hasTarget: hasTarget, started: started) { [weak self] focus, problem in
        guard let self else { return }
        if let problem { return answer(problem) }
        guard let focus else { return fail("no_field", "Nothing editable has the keyboard focus.") }
        // Checked again right before typing: never into a password field.
        if self.isSecure(focus) || self.isSecure(r.element) {
          return answer(["ok": false, "error": "secure", "secure": true, "message": "That's a password field. Echo never types passwords."])
        }
        // A spreadsheet's grid: the keys go into the selected cell.
        if self.gridOf(focus) != nil {
          return self.typeInCell(text, mode: mode, clear: action == "clear_field", r: r, before: before, t0: t0, started: started, answer: answer)
        }
        let held = self.attr(focus, kAXValueAttribute) as? String
        // It already says that: nothing is typed a second time; the assistant is told what it holds.
        if let held, case let holds = VerifyMath.already(text, in: held, replace: replace), holds != .no {
          return answer(self.alreadyThere(holds, held: held, r: r, before: before, t0: t0))
        }
        // What the field held just before typing (adding to it: it must grow by the text).
        let fieldBefore: String? = replace ? nil : held
        let typeIt = {
          if text.isEmpty {
            return DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.checkTyped("", focus: focus, r: r, replaced: replace, via: "keys", before: before, t0: t0, answer: answer) }
          }
          self.typeLive(text, into: focus, field: r.frame ?? AXFinder.frame(focus), started: started) { how, error in
            self.bumpIdle()
            if let error { return answer(error) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.checkTyped(text, focus: focus, r: r, replaced: replace, via: how, before: before, fieldBefore: fieldBefore, t0: t0, answer: answer) }
          }
        }
        guard replace else { return typeIt() }
        // Replacing: the field is emptied first and seen to be empty, or the step fails.
        self.clearField(focus, started: started) { problem in
          if let problem { return answer(problem) }
          typeIt()
        }
      }
    case "paste_text":
      pasteText(p, r, before: before, t0: t0, answer: answer)
    case "press_keys":
      guard let (flags, code) = Keys.parse(p["keys"] as? String ?? "") else { return fail("bad_keys", "Echo can't press that.") }
      // You see what Echo pressed: key caps float by the orb ("⌘ Z").
      pointer?.showKeys(p["keys"] as? String ?? "")
      // Bold and the like in a spreadsheet change nothing Echo's look at the app picks up, so the
      // control that shows the state (the ribbon's Bold button) is read before and after.
      let format = SheetMath.isSheet(bundle(r.pid)) ? SheetMath.formatControl(p["keys"] as? String ?? "") : nil
      let formatBefore = format.flatMap { formatState(r.pid, $0) }
      postKey(code, flags: flags)
      // A ⌘ shortcut that changed nothing: does any menu of this app list it? Echo only reports it
      // (a shortcut can work out of sight, so the menu item is never pressed a second time for it).
      let keys = MenuMath.normal(p["keys"] as? String ?? "")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
        guard let self else { return }
        self.verify(r, before: before, started: started) { after, seen in
          var changes = seen
          if let format, let was = formatBefore, let now = self.formatState(r.pid, format), now != was { changes.append("format") }
          var out = self.result(via: "keys", pid: r.pid)
          out["verified"] = !changes.isEmpty
          out["changes"] = changes
          out["observed"] = self.observed(after)
          out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
          if changes.isEmpty, flags.contains(.maskCommand) {
            let items = self.menuShortcuts(r.pid)
            if let hit = items.first(where: { $0.keys == keys }) {
              out["menuItem"] = hit.path
            } else if !items.isEmpty {
              out["shortcutListed"] = false
              out["menuShortcuts"] = items.prefix(24).map { "\($0.path) (\($0.keys))" }
            }
          }
          answer(out)
        }
      }
    case "scroll":
      // Scrolling to a place (a thing brought into view, the top or the bottom, a remembered spot,
      // part of a page, read-along) when the request asks for one; else whole pages, as ever.
      let direction = p["direction"] as? String ?? "down", pages = (p["amount"] as? NSNumber)?.doubleValue ?? 1
      if let smart = scrollSmart(r, direction: direction, pages: pages, opts: p["scrollTo"] as? [String: Any] ?? [:]) {
        // The scroll bar says whether it moved: no picture is needed to know.
        var out = result(via: smart.via, pid: r.pid)
        for (k, v) in smart.extra { out[k] = v }
        out["verified"] = smart.extra["moved"] as? Bool ?? true
        out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
        bumpIdle()
        return answer(out)
      }
      let via = scroll(r, direction: direction, amount: Int(pages.rounded(.up)))
      verified(via, [:])
    default:
      return fail("bad_action", "Unknown action.")
    }
  }

  /// The shortcuts this app's menus list: "File > New Chat" with its keys ("cmd+n"). Two levels deep,
  /// a few hundred items at most; the Apple menu is left out.
  private func menuShortcuts(_ pid: pid_t) -> [(path: String, keys: String)] {
    let root = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(root, 0.3)
    guard let bar = element(attr(root, kAXMenuBarAttribute)) else { return [] }
    var out: [(path: String, keys: String)] = []
    let deadline = Date().addingTimeInterval(0.8)
    func walk(_ menuOwner: AXUIElement, _ path: String, depth: Int) {
      guard depth <= 2, out.count < 300, Date() < deadline else { return }
      for menu in (attr(menuOwner, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
        for item in (attr(menu, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
          // Checked per item: a big menu (hundreds of items, each a round trip) can't run past it.
          guard out.count < 300, Date() < deadline else { return }
          let title = string(item, kAXTitleAttribute)
          if title.isEmpty { continue }
          let char = string(item, "AXMenuItemCmdChar")
          let mods = (attr(item, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
          if let keys = MenuMath.combo(char: char, mods: mods) { out.append(("\(path) > \(title)", keys)) }
          walk(item, "\(path) > \(title)", depth: depth + 1)
        }
      }
    }
    for top in ((attr(bar, kAXChildrenAttribute) as? [AXUIElement]) ?? []).dropFirst() {
      if Date() >= deadline { break }
      walk(top, string(top, kAXTitleAttribute), depth: 1)
    }
    return out
  }

  private func result(via: String, pid p: pid_t) -> [String: Any] {
    let app = NSWorkspace.shared.frontmostApplication
    return ["ok": true, "via": via, "app": app?.localizedName ?? "", "window": app.map { AXFinder.focusedWindowTitle(of: $0) } ?? ""]
  }

  // MARK: observing (before and after every action)

  /// What Echo can see of the app right now (VerifyMath.Snapshot). Read-only.
  private func snapshot(_ p: pid_t, target: AXUIElement?) -> VerifyMath.Snapshot {
    var s = VerifyMath.Snapshot()
    s.front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
    guard p > 0 else { return s }
    let root = AXUIElementCreateApplication(p)
    AXUIElementSetMessagingTimeout(root, 0.4)
    if let f = element(attr(root, kAXFocusedUIElementAttribute)) {
      s.focusRole = string(f, kAXRoleAttribute)
      s.focusLabel = [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue"].map { string(f, $0) }.first { !$0.isEmpty } ?? ""
      if !isSecure(f) { s.focusValue = String(string(f, kAXValueAttribute).prefix(4000)) }
    }
    s.windows = (attr(root, kAXWindowsAttribute) as? [AXUIElement])?.count ?? 0
    if let w = element(attr(root, kAXFocusedWindowAttribute)) {
      s.window = string(w, kAXTitleAttribute)
      let page = AXFinder.webAreas(in: w, seconds: 0.12).first
      if let page, let u = attr(page, "AXURL") { s.url = "\(u)" }
      s.signature = contentSignature(page ?? w)
    }
    s.menuOpen = !AXFinder.openMenus(of: root).isEmpty
    if let t = target {
      let state = ["AXExpanded", "AXSelected", kAXFocusedAttribute, "AXDisclosing", "AXMenuItemMarkChar"].map { "\(attr(t, $0) ?? ("-" as NSString))" }
      s.targetState = state.joined(separator: "|") + (isSecure(t) ? "" : "|" + String(string(t, kAXValueAttribute).prefix(200)))
    }
    return s
  }

  /// A fingerprint of what's showing in a window or page: roles and names of its first elements
  /// (breadth-first, within a small budget). A dialog opening, a list changing or a page loading
  /// changes it.
  private func contentSignature(_ root: AXUIElement) -> Int {
    var h = Hasher()
    var queue: [AXUIElement] = [root]
    var head = 0
    let deadline = Date().addingTimeInterval(0.2)
    while head < queue.count, head < 1500, Date() < deadline {
      let el = queue[head]
      head += 1
      h.combine(string(el, kAXRoleAttribute))
      h.combine(string(el, kAXTitleAttribute))
      h.combine(string(el, kAXDescriptionAttribute))
      if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
        h.combine(kids.count)
        queue.append(contentsOf: kids)
      }
    }
    h.combine(head)
    return h.finalize()
  }

  /// Looks again every 0.12 s until something changed, or `seconds` pass.
  private func verify(_ r: Resolved, before: VerifyMath.Snapshot, started: Int, seconds: Double = 1.0,
                      _ done: @escaping (VerifyMath.Snapshot, [String]) -> Void) {
    let until = Date().addingTimeInterval(seconds)
    func tick() {
      let now = snapshot(r.pid, target: r.element)
      let changes = VerifyMath.changes(before, now)
      if !changes.isEmpty || Date() >= until || epoch != started { return done(now, changes) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { tick() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { tick() }
  }

  /// What Echo saw after acting, for the assistant (the server trims and redacts it).
  private func observed(_ s: VerifyMath.Snapshot) -> [String: Any] {
    ["focus": [s.focusRole, s.focusLabel].filter { !$0.isEmpty }.joined(separator: " "), "value": String(s.focusValue.prefix(160)),
     "window": s.window, "url": String(s.url.prefix(200)), "menuOpen": s.menuOpen]
  }

  /// Typing: did the text land in the field? Read back what the field holds now.
  private func checkTyped(_ text: String, focus: AXUIElement, r: Resolved, replaced: Bool, via: String,
                          before: VerifyMath.Snapshot, fieldBefore: String? = nil, t0: Date, answer: @escaping ([String: Any]) -> Void) {
    let now = snapshot(r.pid, target: r.element)
    let readable = attr(focus, kAXValueAttribute) is String
    let value = readable ? string(focus, kAXValueAttribute) : now.focusValue
    var out = result(via: via, pid: r.pid)
    out["observed"] = observed(now)
    out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
    if readable || !now.focusValue.isEmpty {
      let suggested = readable ? string(focus, kAXSelectedTextAttribute) : ""
      out["verified"] = VerifyMath.typed(text, into: value, replaced: replaced, before: fieldBefore, suggested: suggested)
    } else {
      // A field whose text can't be read: at least the focus is still where Echo typed.
      out["verified"] = VerifyMath.changes(before, now).isEmpty ? false : true
      out["unreadable"] = true
    }
    out["changes"] = VerifyMath.changes(before, now)
    answer(out)
  }

  // MARK: the focus guard

  /// The same element, or one inside the other (a web field and the editable text in it).
  private func related(_ a: AXUIElement, _ b: AXUIElement) -> Bool {
    if CFEqual(a, b) { return true }
    for (x, y) in [(a, b), (b, a)] {
      var cur = parent(x)
      for _ in 0..<6 {
        guard let c = cur else { break }
        if CFEqual(c, y) { return true }
        cur = parent(c)
      }
    }
    return false
  }

  /// Can text go into it? A text field or area, a combo box, or editable web content.
  private func isEditable(_ el: AXUIElement) -> Bool {
    ActMath.editable.contains(string(el, kAXRoleAttribute)) || attr(el, "AXEditableAncestor") != nil
      || string(el, kAXSubroleAttribute) == "AXSearchField" || isFrameEditor(el)
  }

  /// A rich-text editor that is a whole document in an iframe (designMode: eBay's description,
  /// TinyMCE, CKEditor): Chrome reports the focus on the iframe's own web area, and says it's
  /// editable. A web area that doesn't say so (a video's frame, the page itself) never counts here,
  /// so letters never become its shortcuts; pasting (pasteText) is the only way into one of those.
  private func isFrameEditor(_ el: AXUIElement) -> Bool {
    guard string(el, kAXRoleAttribute) == "AXWebArea" else { return false }
    return (attr(el, "AXEditable") as? Bool) == true || attr(el, "AXEditableAncestor") != nil
  }

  /// A field, or a spreadsheet's grid (typing there goes into the selected cell).
  private func takesTyping(_ el: AXUIElement) -> Bool { isEditable(el) || gridOf(el) != nil }

  /// Its role and name, for telling the assistant where the keyboard is.
  private func named(_ el: AXUIElement) -> String {
    let name = [kAXTitleAttribute, kAXDescriptionAttribute].map { string(el, $0) }.first { !$0.isEmpty } ?? ""
    return [string(el, kAXRoleAttribute), name].filter { !$0.isEmpty }.joined(separator: " ")
  }

  /// Before any typing: the field Echo means has the keyboard focus and takes text. With a target
  /// it's focused (Accessibility, then a real click in it) and checked; without one, whatever
  /// has the focus must be a field (otherwise each letter would be a page shortcut). Never types
  /// into "whatever happens to have focus" (Sept 29: a greeting went into the To field).
  private func focusField(_ r: Resolved, hasTarget: Bool, started: Int,
                          _ done: @escaping (AXUIElement?, [String: Any]?) -> Void) {
    let app = NSRunningApplication(processIdentifier: r.pid)
    let current = { app.flatMap { self.focusedElement(in: $0) } ?? self.focusedElement() }
    let guardFail = { (why: String) -> [String: Any] in
      return ["ok": false, "error": "focus_guard", "focused": current().map { self.named($0) } ?? "nothing", "message": why]
    }
    guard hasTarget, let target = r.element else {
      guard let f = current(), takesTyping(f) else {
        return done(nil, guardFail("Nothing editable has the keyboard focus, so Echo didn't type (the letters would act as page shortcuts). Say which field with into."))
      }
      return done(f, nil)
    }
    let ok = { (f: AXUIElement?) -> AXUIElement? in
      guard let f, self.takesTyping(f), self.related(f, target) else { return nil }
      return f
    }
    if let f = current(), related(f, target), takesTyping(f) { return done(f, nil) }
    // The target is a spreadsheet's grid: the keyboard only has to be in the grid (the selected
    // cell takes the typing). Never a click in the middle of it, which would select another cell.
    let toGrid = gridOf(target) != nil
    if toGrid, let f = current(), gridOf(f) != nil { return done(f, nil) }
    AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
      guard self.epoch == started else { return done(nil, ["ok": false, "error": "paused", "message": "You took over, so Echo stopped this step."]) }
      if let f = ok(current()) { return done(f, nil) }
      if toGrid {
        if let f = current(), self.gridOf(f) != nil { return done(f, nil) }
        return done(nil, guardFail("The keyboard isn't in the sheet, so nothing was typed. Give the cell as the target (into: \"A1\") and Echo goes there itself."))
      }
      // Setting the focus didn't move the page's keyboard focus (a label, a web field): click in it.
      guard let frame = r.frame ?? AXFinder.frame(target) else { return done(nil, guardFail("Couldn't put the cursor in that field, so nothing was typed.")) }
      self.postClick(at: frame, count: 1, button: "left", flags: [])
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
        guard self.epoch == started else { return done(nil, ["ok": false, "error": "paused", "message": "You took over, so Echo stopped this step."]) }
        if let f = ok(current()) { return done(f, nil) }
        // A click on a field that puts the focus in an editable part of it (Gmail's To box).
        if let f = current(), self.isEditable(f), let ff = AXFinder.frame(f), let tf = r.frame, ff.intersects(tf.insetBy(dx: -6, dy: -6)) { return done(f, nil) }
        done(nil, guardFail("The cursor isn't in that field (the keyboard focus is somewhere else), so nothing was typed."))
      }
    }
  }

  /// Typing's fallback for rich-text editors (the server's pasteFallback, lib/computer.js): the
  /// failed typing step already put the cursor in the box, so this pastes where the keyboard is,
  /// with the clipboard put back afterwards (paste). Never into a password field, never into a
  /// field the Mac can see is somewhere else's. It pastes when Accessibility sees a field (an
  /// iframe's editor counts), when the Echo extension saw an editable element with the page's
  /// focus (pageFocus "editable"), or in a browser whose page has a focus Accessibility can't see
  /// (nothing, or the page itself): ⌘V there with nothing to take it does nothing.
  private func pasteText(_ p: [String: Any], _ r: Resolved, before: VerifyMath.Snapshot, t0: Date, answer: @escaping ([String: Any]) -> Void) {
    let text = p["text"] as? String ?? ""
    guard !text.isEmpty else { return answer(["ok": false, "error": "empty", "message": "Nothing to paste."]) }
    let pageFocus = p["pageFocus"] as? String ?? "unknown"
    let cur = focused(r.pid)
    if isSecure(cur) { return answer(["ok": false, "error": "secure", "secure": true, "message": "That's a password field. Echo never types passwords."]) }
    let seesField = cur.map { isEditable($0) } ?? false
    let browser = ActMath.isBrowser(bundle(r.pid))
    let unseen = cur == nil || cur.map { string($0, kAXRoleAttribute) == "AXWebArea" || inWebPage($0) && !ActMath.editable.contains(string($0, kAXRoleAttribute)) } ?? false
    guard pageFocus != "not_editable", seesField || pageFocus == "editable" || (browser && unseen) else {
      return answer(["ok": false, "error": "focus_guard", "focused": cur.map { named($0) } ?? "nothing",
                     "message": "Nothing that takes text has the keyboard focus, so nothing was pasted."])
    }
    let held = cur.flatMap { attr($0, kAXValueAttribute) as? String }
    guard paste(text) else { return answer(["ok": false, "error": "paste", "message": "Couldn't use the clipboard."]) }
    bumpIdle()
    // A moment for the page to take it (the clipboard is put back after 0.8 s by paste()).
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
      guard let self else { return }
      var out = self.result(via: "paste", pid: r.pid)
      let now = self.focused(r.pid)
      let value = now.flatMap { self.attr($0, kAXValueAttribute) as? String } ?? ""
      if !value.isEmpty, let now, self.isEditable(now) {
        out["verified"] = VerifyMath.typed(text, into: value, replaced: false, before: held)
      } else {
        // An editor whose text the Mac can't read: the server checks the page or the screen.
        out["verified"] = false
        out["unreadable"] = true
      }
      out["changes"] = VerifyMath.changes(before, self.snapshot(r.pid, target: r.element))
      out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
      answer(out)
    }
  }

  /// Empties a field before typing over it (replace mode, clear_field) and sees that it is empty:
  /// each way in ClearMath.plan in turn (select its text and Delete, set it to nothing, ⌘↑ ⇧⌘↓ and
  /// Delete) until the field reads back empty. If none works the step fails and nothing is typed
  /// (Oct 3: ⌘A in Excel's formula bar selected the cells, not the bar's text, and "Hello" went in
  /// front of what was there). `done(nil)`: empty; otherwise what to answer.
  private func clearField(_ el: AXUIElement, started: Int, _ done: @escaping ([String: Any]?) -> Void) {
    let sheet = SheetMath.isSheet(bundle(pid(el)))
    let placeholder = string(el, "AXPlaceholderValue")
    let held = { self.attr(el, kAXValueAttribute) as? String }
    let cant: [String: Any] = ["ok": false, "error": "cant_clear", "focused": named(el),
                               "message": "Couldn't empty that field first, so nothing was typed over it."
                                 + (sheet ? " In a spreadsheet, give the cell as the target (into: \"A1\"): typing in a cell replaces what it holds." : "")]
    guard let value = held() else {
      // A field whose text can't be read: select and delete as far as that's safe (the read-back
      // after typing still decides). Never blind in a spreadsheet.
      guard !sheet else { return done(cant) }
      postKey(0, flags: .maskCommand) // ⌘A, then the modifiers are released (postKey)
      usleep(40_000)
      postKey(51, flags: [])
      return DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { done(nil) }
    }
    if ClearMath.isEmpty(value, placeholder: placeholder) { return done(nil) }
    var rangeOK: DarwinBoolean = false, valueOK: DarwinBoolean = false
    AXUIElementIsAttributeSettable(el, kAXSelectedTextRangeAttribute as CFString, &rangeOK)
    AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &valueOK)
    let ways = ClearMath.plan(sheet: sheet, web: inWebPage(el), rangeSettable: rangeOK.boolValue,
                              valueSettable: valueOK.boolValue && Self.textRoles.contains(string(el, kAXRoleAttribute)))
    // Web pages report a change a beat later: look a few times.
    func emptied(_ tries: Int, _ then: @escaping (Bool) -> Void) {
      if ClearMath.isEmpty(held() ?? "", placeholder: placeholder) { return then(true) }
      guard tries > 1 else { return then(false) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { emptied(tries - 1, then) }
    }
    func attempt(_ i: Int) {
      guard driving, runId != abortedRun else { return done(["ok": false, "error": "aborted", "message": "You took back control."]) }
      guard epoch == started else { return done(["ok": false, "error": "paused", "message": "You took over, so Echo stopped this step."]) }
      guard i < ways.count else { return done(cant) }
      let count = ((held() ?? "") as NSString).length
      switch ways[i] {
      case .setEmpty:
        AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, "" as CFString)
        return emptied(3) { $0 ? done(nil) : attempt(i + 1) }
      case .range:
        var range = CFRange(location: 0, length: count)
        if let v = AXValueCreate(.cfRange, &range) { AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, v) }
      case .selectAll:
        postKey(0, flags: .maskCommand) // ⌘A, then the modifiers are released (postKey)
        usleep(40_000)
      case .ends:
        postKey(126, flags: .maskCommand) // ⌘↑: the start of the text
        usleep(40_000)
        postKey(125, flags: [.maskCommand, .maskShift]) // ⇧⌘↓: selected to its end
        usleep(40_000)
      }
      // In a spreadsheet: Delete only once the whole text is seen to be selected.
      var selected = selectedLength(el)
      for _ in 0..<3 where sheet && !ClearMath.mayDelete(sheet: sheet, selected: selected, count: count) {
        usleep(60_000)
        selected = selectedLength(el)
      }
      guard ClearMath.mayDelete(sheet: sheet, selected: selected, count: count) else { return attempt(i + 1) }
      postKey(51, flags: [])
      emptied(5) { $0 ? done(nil) : attempt(i + 1) }
    }
    attempt(0)
  }

  /// How much of a field's text is selected, when the app says.
  private func selectedLength(_ el: AXUIElement) -> Int? {
    guard let v = attr(el, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var r = CFRange()
    return AXValueGetValue(v as! AXValue, .cfRange, &r) ? r.length : nil
  }

  /// "It already says that": the answer when the field holds what Echo was asked to type, so
  /// nothing was typed. The same words in other capitals are not confirmed: the assistant decides.
  private func alreadyThere(_ holds: VerifyMath.Holds, held: String, r: Resolved, before: VerifyMath.Snapshot, t0: Date) -> [String: Any] {
    var out = result(via: "none", pid: r.pid)
    out["already"] = holds == .same ? "same" : "case"
    out["holds"] = String(held.prefix(160))
    out["verified"] = holds == .same
    out["changes"] = [String]()
    out["observed"] = observed(before)
    out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
    return out
  }

  // MARK: spreadsheets (Excel, Numbers)

  private func bundle(_ pid: pid_t) -> String? { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier }

  private func focused(_ pid: pid_t) -> AXUIElement? {
    NSRunningApplication(processIdentifier: pid).flatMap { focusedElement(in: $0) } ?? focusedElement()
  }

  /// The spreadsheet grid this element is, or is in (a cell): typing there goes into the selected
  /// cell. Nil outside Excel and Numbers, and for a text field (a cell being edited is a field).
  private func gridOf(_ el: AXUIElement) -> AXUIElement? {
    let app = bundle(pid(el))
    guard SheetMath.isSheet(app), !isEditable(el) else { return nil }
    var cur: AXUIElement? = el
    for _ in 0..<6 {
      guard let c = cur else { return nil }
      let label = [kAXTitleAttribute, kAXDescriptionAttribute].map { string(c, $0) }.first { !$0.isEmpty } ?? ""
      if SheetMath.typable(role: string(c, kAXRoleAttribute), label: label, bundle: app) { return c }
      cur = parent(c)
    }
    return nil
  }

  private enum Walk { case into, skip, stop }

  /// Looks through the app's front window, nearest things first, within a small budget.
  private func walkWindow(_ pid: pid_t, seconds: Double = 0.5, _ visit: (AXUIElement, String, String) -> Walk) {
    let root = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(root, 0.3)
    guard let w = element(attr(root, kAXFocusedWindowAttribute)) else { return }
    var queue: [AXUIElement] = [w]
    var head = 0
    let deadline = Date().addingTimeInterval(seconds)
    while head < queue.count, head < 4000, Date() < deadline {
      let el = queue[head]
      head += 1
      let label = [kAXTitleAttribute, kAXDescriptionAttribute].map { string(el, $0) }.first { !$0.isEmpty } ?? ""
      switch visit(el, string(el, kAXRoleAttribute), label) {
      case .stop: return
      case .skip: continue
      case .into: if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids) }
      }
    }
  }

  /// Is a remembered element still there, in the window now in front?
  private func inFrontWindow(_ el: AXUIElement, _ pid: pid_t) -> Bool {
    guard !string(el, kAXRoleAttribute).isEmpty, let w = element(attr(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute)) else { return false }
    return element(attr(el, kAXWindowAttribute)).map { CFEqual($0, w) } ?? true
  }

  /// The name box, the formula bar and the grid of the spreadsheet window in front (SheetMath.part).
  /// The grid's own cells are never walked: there can be thousands.
  private func sheetParts(_ pid: pid_t) -> [SheetMath.Part: AXUIElement] {
    if sheetCache.pid == pid, !sheetCache.parts.isEmpty, sheetCache.parts.values.allSatisfy({ inFrontWindow($0, pid) }) { return sheetCache.parts }
    var found: [SheetMath.Part: AXUIElement] = [:]
    walkWindow(pid) { el, role, label in
      if role == "AXCell" || role == "AXLayoutItem" { return .skip }
      guard let part = SheetMath.part(role: role, label: label) else { return .into }
      if found[part] == nil { found[part] = el }
      if part == .grid { return .skip }
      return found.count == 3 ? .stop : .into
    }
    sheetCache = (pid, found, sheetCache.pid == pid ? sheetCache.formats : [:])
    return found
  }

  /// The selected cell's own element, where the app has one (Numbers; Excel goes by its Name Box
  /// and formula bar): the focused cell, or the first selected cell of the table around the focus.
  private func selectedCell(_ pid: pid_t) -> AXUIElement? {
    var cur = focused(pid)
    if let f = cur, isEditable(f) { cur = parent(f) } // a cell being edited: the cell around the editor
    for _ in 0..<6 {
      guard let c = cur else { break }
      if string(c, kAXRoleAttribute) == "AXCell" { return c }
      for name in ["AXSelectedCells", kAXSelectedChildrenAttribute as String] {
        if let cell = (attr(c, name) as? [AXUIElement])?.first { return cell }
      }
      cur = parent(c)
    }
    return nil
  }

  /// Which cell is selected ("A1"), when the app says: Excel's Name Box, else the selected cell's name.
  private func cellName(_ pid: pid_t) -> String? {
    if let box = sheetParts(pid)[.nameBox], let ref = SheetMath.cellRef(string(box, kAXValueAttribute)) { return ref }
    guard let cell = selectedCell(pid) else { return nil }
    return [kAXTitleAttribute, kAXDescriptionAttribute, "AXIdentifier"].compactMap { SheetMath.cellRef(string(cell, $0)) }.first
  }

  /// What the selected cell holds, when the app says: Excel's formula bar shows it; else the
  /// selected cell's own value (or the text inside it).
  private func cellValue(_ pid: pid_t) -> String? {
    if let bar = sheetParts(pid)[.formulaBar], let v = attr(bar, kAXValueAttribute) as? String { return v }
    guard let cell = selectedCell(pid) else { return nil }
    if let v = attr(cell, kAXValueAttribute) as? String { return v }
    return ((attr(cell, kAXChildrenAttribute) as? [AXUIElement]) ?? []).compactMap { attr($0, kAXValueAttribute) as? String }.first
  }

  /// Whether Bold (Italic, Underline) is on for the selection, read off the control that shows it
  /// (Excel's ribbon, Numbers' Format sidebar). Nil when no such control is showing: then the
  /// formatting can't be confirmed from here, and Echo says so.
  private func formatState(_ pid: pid_t, _ name: String) -> Int? {
    var el = sheetCache.pid == pid ? sheetCache.formats[name] : nil
    if let e = el, !inFrontWindow(e, pid) { el = nil }
    if el == nil {
      let toggles: Set<String> = ["AXCheckBox", "AXButton", "AXRadioButton", "AXToggle", "AXMenuButton"]
      walkWindow(pid, seconds: 0.4) { e, role, label in
        if SheetMath.isGrid(role: role, label: label) { return .skip }
        guard toggles.contains(role), label.caseInsensitiveCompare(name) == .orderedSame else { return .into }
        el = e
        return .stop
      }
      if sheetCache.pid != pid { sheetCache = (pid, [:], [:]) }
      sheetCache.formats[name] = el
    }
    return el.flatMap { attr($0, kAXValueAttribute) as? NSNumber }?.intValue
  }

  /// Selects a cell by its reference and reads back that it is selected. Excel: a click in the
  /// Name Box (which selects what it shows), the reference, Return; with no Name Box showing,
  /// Go To (Control+G), the reference, Return. Numbers: a click on the cell (found by its name).
  /// `done(nil)`: the cell is selected (or the app doesn't say which is, after going there);
  /// otherwise what to answer.
  private func goToCell(_ cell: String, _ r: Resolved, started: Int, _ done: @escaping ([String: Any]?) -> Void) {
    let pid = r.pid
    let app = bundle(pid)
    let failed = { (now: String?) -> [String: Any] in
      ["ok": false, "error": "cell", "message": "Couldn't select cell \(cell)\(now.map { " (\($0) is selected)" } ?? ""), so nothing was done there."]
    }
    let stopped = { () -> [String: Any]? in
      guard self.driving, self.runId != self.abortedRun else { return ["ok": false, "error": "aborted", "message": "You took back control."] }
      guard self.epoch == started else { return ["ok": false, "error": "paused", "message": "You took over, so Echo stopped this step."] }
      return nil
    }
    // Already there, with the keyboard in the grid: nothing to do.
    if cellName(pid) == cell, let f = focused(pid), gridOf(f) != nil { return done(nil) }
    func check(_ tries: Int) {
      if let why = stopped() { return done(why) }
      let now = cellName(pid)
      if now == cell { return done(nil) }
      if tries > 1 { return DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { check(tries - 1) } }
      // The app doesn't say which cell is selected: Echo went there the way a person does.
      done(now == nil ? nil : failed(now))
    }
    func enter(after wait: Double) {
      DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
        if let why = stopped() { return done(why) }
        _ = self.postText(cell)
        self.postKey(36, flags: [])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { check(5) }
      }
    }
    func goTo() {
      guard let keys = SheetMath.goToKeys(app), let (flags, code) = Keys.parse(keys) else { return done(failed(cellName(pid))) }
      postKey(code, flags: flags)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        // Go To's own field has the keyboard, or the reference would be typed into a cell.
        guard let f = self.focused(pid), self.isEditable(f) else { return done(failed(self.cellName(pid))) }
        enter(after: 0)
      }
    }
    if app == SheetMath.numbers {
      guard let frame = r.frame else { return done(failed(nil)) }
      postClick(at: frame, count: 1, button: "left", flags: [])
      return DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { check(4) }
    }
    guard let box = sheetParts(pid)[.nameBox], let frame = AXFinder.frame(box) else { return goTo() }
    postClick(at: frame, count: 1, button: "left", flags: [])
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
      if let why = stopped() { return done(why) }
      // The box has the keyboard (else the reference would go into a cell): otherwise Go To.
      guard let f = self.focused(pid), self.isEditable(f), self.related(f, box) else { return goTo() }
      // What the box shows is selected by the click; made sure of where the app lets Echo.
      var range = CFRange(location: 0, length: (self.string(f, kAXValueAttribute) as NSString).length)
      if let v = AXValueCreate(.cfRange, &range) { AXUIElementSetAttributeValue(f, kAXSelectedTextRangeAttribute as CFString, v) }
      enter(after: 0.05)
    }
  }

  /// Typing in a spreadsheet's grid: the keys go into the selected cell, as when a person types
  /// there, which replaces what the cell holds. Adding to it (mode "append", asked for) opens the
  /// cell for editing first. The entry is entered with the same cell kept selected (so "now make
  /// it bold" is about this cell), then the cell is read back, exactly.
  private func typeInCell(_ text: String, mode: String?, clear: Bool, r: Resolved, before: VerifyMath.Snapshot, t0: Date, started: Int,
                          answer: @escaping ([String: Any]) -> Void) {
    let app = bundle(r.pid)
    let held = cellValue(r.pid)
    let append = mode == "append"
    let (entry, many) = SheetMath.lastEntry(text)
    let check = { (via: String) in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
        let now = self.snapshot(r.pid, target: r.element)
        var out = self.result(via: via, pid: r.pid)
        var seen = self.observed(now)
        out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
        out["changes"] = VerifyMath.changes(before, now)
        if let value = self.cellValue(r.pid), !(many && entry.isEmpty) {
          seen["value"] = String(value.prefix(160))
          out["verified"] = VerifyMath.typed(entry, into: value, replaced: !append || many, before: append && !many ? held : nil)
        } else {
          // A cell Echo can't read back: at least something in the sheet changed.
          out["verified"] = !VerifyMath.changes(before, now).isEmpty
          out["unreadable"] = true
        }
        if let name = self.cellName(r.pid) { seen["focus"] = "cell \(name)" }
        out["observed"] = seen
        answer(out)
      }
    }
    if clear || text.isEmpty {
      if clear { postKey(51, flags: []) } // Delete empties the selected cell
      return check("keys")
    }
    // It already says that: nothing is typed a second time; the assistant is told what it holds.
    if let held, case let holds = VerifyMath.already(text, in: held, replace: mode == "replace"), holds != .no {
      return answer(alreadyThere(holds, held: held, r: r, before: before, t0: t0))
    }
    var wait = 0.0
    if append, !(held ?? "x").isEmpty, let keys = SheetMath.editKeys(app), let (flags, code) = Keys.parse(keys) {
      postKey(code, flags: flags)
      wait = 0.2
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
      self.typeLive(text, into: nil, field: r.cell == nil || app == SheetMath.numbers ? r.frame : nil, started: started) { how, error in
        self.bumpIdle()
        if let error { return answer(error) }
        if let keys = SheetMath.commitKeys(app), let (flags, code) = Keys.parse(keys) { self.postKey(code, flags: flags) }
        check(how)
      }
    }
  }

  // MARK: acting

  private func flags(_ names: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for n in names {
      switch n {
      case "cmd": f.insert(.maskCommand)
      case "shift": f.insert(.maskShift)
      case "opt": f.insert(.maskAlternate)
      case "ctrl": f.insert(.maskControl)
      default: break
      }
    }
    return f
  }

  /// A click: Accessibility first for a plain left click (press the element, or a pressable one
  /// just above it), AXShowMenu for a right click; otherwise real mouse events at its centre.
  private func click(_ r: Resolved, button: String, count: Int, mods: CGEventFlags) -> String {
    if var el = r.element, count == 1, mods.isEmpty {
      let wanted = button == "right" ? "AXShowMenu" : kAXPressAction as String
      for _ in 0..<3 {
        if actions(el).contains(wanted), AXUIElementPerformAction(el, wanted as CFString) == .success { return "accessibility" }
        guard let up = parent(el), !["AXWebArea", "AXWindow"].contains(string(up, kAXRoleAttribute)) else { break }
        el = up
      }
    }
    guard let f = r.frame else { return "none" }
    postClick(at: f, count: count, button: button, flags: mods)
    return "events"
  }

  private func mark(_ e: CGEvent?) {
    e?.setIntegerValueField(.eventSourceUserData, value: Self.marker)
    e?.post(tap: .cghidEventTap)
    lastPosted = Date()
  }

  /// Real mouse clicks (single, double or triple; left or right; with modifier keys held) at the
  /// centre of `f`, with a moment between press and release like a hand's.
  private func postClick(at f: CGRect, count: Int, button: String, flags mods: CGEventFlags) {
    guard !inEchoWindow(f) else { return }
    let g = Self.toGlobal(CGPoint(x: f.midX, y: f.midY))
    // Background cursor: your pointer goes back where it was right after (the orb showed the spot).
    let back = ComputerPrefs.background ? Self.toGlobal(NSEvent.mouseLocation) : nil
    defer {
      if let back { mark(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: back, mouseButton: .left)) }
    }
    let right = button == "right"
    mark(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: g, mouseButton: .left))
    for n in 1...max(1, min(3, count)) {
      let down = CGEvent(mouseEventSource: source, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: g, mouseButton: right ? .right : .left)
      let up = CGEvent(mouseEventSource: source, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: g, mouseButton: right ? .right : .left)
      for e in [down, up] {
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        e?.flags = mods
      }
      mark(down)
      usleep(12_000)
      mark(up)
    }
    if !mods.isEmpty { clearModifiers() }
  }

  /// A drag from one spot to another: press, a dozen small moves along the way, release.
  private func drag(from a: CGRect, to b: CGRect, _ done: @escaping () -> Void) {
    let p0 = Self.toGlobal(CGPoint(x: a.midX, y: a.midY)), p1 = Self.toGlobal(CGPoint(x: b.midX, y: b.midY))
    mark(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p0, mouseButton: .left))
    mark(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: p0, mouseButton: .left))
    var i = 0
    let steps = 14
    func step() {
      i += 1
      let t = CGFloat(i) / CGFloat(steps)
      let p = CGPoint(x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t)
      mark(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
      if i < steps { return DispatchQueue.main.asyncAfter(deadline: .now() + 0.012) { step() } }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
        self.mark(CGEvent(mouseEventSource: self.source, mouseType: .leftMouseUp, mouseCursorPosition: p1, mouseButton: .left))
        done()
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { step() }
  }

  /// A key press with exactly these modifiers; afterwards every modifier is released again, so
  /// nothing Echo types next carries a ⌘ from this shortcut.
  private func postKey(_ code: CGKeyCode, flags: CGEventFlags) {
    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    down?.flags = flags
    up?.flags = flags
    mark(down)
    mark(up)
    if !flags.isEmpty { clearModifiers() }
  }

  /// All modifier keys up (a flags-changed event with no flags).
  private func clearModifiers() {
    guard let e = CGEvent(source: source) else { return }
    e.type = .flagsChanged
    e.flags = []
    mark(e)
  }

  private static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

  /// Sets the value of a native text field (Accessibility), else types it as key presses.
  private func type(_ text: String, into el: AXUIElement?) -> String {
    if let el, Self.textRoles.contains(string(el, kAXRoleAttribute)), !inWebPage(el) {
      var settable: DarwinBoolean = false
      AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable)
      let before = string(el, kAXValueAttribute)
      let want = before + text
      if settable.boolValue, AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, want as CFString) == .success, string(el, kAXValueAttribute) == want {
        return "accessibility"
      }
    }
    // In small runs, each on no modifier (postText), line breaks as Shift+Return (Return in a terminal).
    let chars = Array(text)
    var i = 0
    while i < chars.count {
      _ = postText(String(chars[i..<min(i + 16, chars.count)]))
      i += 16
      usleep(8000)
    }
    return "events"
  }

  /// Types `text` a character at a time at a natural pace (TypingMath.plan: slightly varied,
  /// faster for long texts, never more than a few seconds), with the companion bobbing beside the
  /// caret and a glint on each new character. Before every key press it checks you haven't taken
  /// over; every few, that the focus hasn't moved to a password field. If the first characters
  /// don't land (a field whose text can be read, unchanged), it sets the value (native fields) or
  /// pastes instead. Reduced motion: all at once, as before.
  private func typeLive(_ text: String, into el: AXUIElement?, field: CGRect?, started: Int,
                        done: @escaping (String, [String: Any]?) -> Void) {
    if Motion.reduced { return done(type(text, into: el), nil) }
    let beats = TypingMath.plan(text, seed: text.utf8.reduce(UInt64(1469598103934665603)) { ($0 ^ UInt64($1)) &* 1099511628211 })
    let before = el.flatMap { el in (attr(el, kAXValueAttribute) as? String).map { ($0, selection(el)) } }
    pointer?.startTyping(caret: el.flatMap { caretRect($0) }, field: field)
    var i = 0
    var lastCaret = 0.0
    let finish = { [weak self] (how: String, error: [String: Any]?) in
      // The finishing shimmer is only a look: the read-back check still decides if it worked.
      self?.pointer?.stopTyping(landed: error == nil && how != "none")
      done(how, error)
    }
    func stopped() -> [String: Any]? {
      guard driving, runId != abortedRun else { return ["ok": false, "error": "aborted", "message": "You took back control."] }
      guard epoch == started else { return ["ok": false, "error": "paused", "message": "You took over, so Echo stopped this step."] }
      return nil
    }
    func next() {
      if let why = stopped() { return finish("events", why) }
      guard i < beats.count else { return finish("keys", nil) }
      if i > 0 && i % 8 == 0 {
        let now = NSRunningApplication(processIdentifier: el.map { pid($0) } ?? 0).flatMap { focusedElement(in: $0) } ?? focusedElement()
        if isSecure(now) { return finish("events", ["ok": false, "error": "secure", "secure": true, "message": "That's a password field. Echo never types passwords."]) }
      }
      guard postText(beats[i].text) else { return finish(fallback(beats[i...].map(\.text).joined(), el), nil) }
      i += 1
      let t = CACurrentMediaTime()
      if t - lastCaret > 0.05 || i == beats.count {
        lastCaret = t
        pointer?.typed(caret: el.flatMap { caretRect($0) })
      } else {
        pointer?.typed(caret: nil)
      }
      // After the first key press: did it land? (Only where the field's text can be read.)
      if i == 1, let before, let el {
        // Chrome updates its Accessibility tree a beat later: up to ~0.5 s.
        return probe(el, before: before.0, caret: before.1, tries: 6) { [weak self] landed in
          guard let self else { return }
          if landed { return DispatchQueue.main.asyncAfter(deadline: .now() + (beats.count > 1 ? beats[1].delay : 0)) { next() } }
          if let why = stopped() { return finish("events", why) }
          finish(self.fallback(text, el), nil)
        }
      }
      guard i < beats.count else { return finish("keys", nil) }
      DispatchQueue.main.asyncAfter(deadline: .now() + beats[i].delay) { next() }
    }
    next()
  }

  /// Whether a field's text or its caret has moved from before (checked a few times, 60 ms apart).
  private func probe(_ el: AXUIElement, before: String, caret: Int?, tries: Int, _ done: @escaping (Bool) -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
      guard let self else { return }
      if (self.attr(el, kAXValueAttribute) as? String) != before { return done(true) }
      if let caret, let now = self.selection(el), now != caret { return done(true) }
      tries > 1 ? self.probe(el, before: before, caret: caret, tries: tries - 1, done) : done(false)
    }
  }

  /// Where the caret is in a field's text (a character offset), when the app says.
  private func selection(_ el: AXUIElement) -> Int? {
    guard let v = attr(el, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var r = CFRange()
    return AXValueGetValue(v as! AXValue, .cfRange, &r) ? r.location : nil
  }

  /// Key presses carrying `s` as text (marked as Echo's own): on the character's real key when
  /// it has one, always with NO modifier flags (a ⌘ left over from ⌘A once turned "Meet Echo"
  /// into ⌘⇧M, Chrome's profile menu), and line breaks as real Return presses. False if an event
  /// couldn't be made.
  private func postText(_ s: String) -> Bool {
    for piece in KeyMath.pieces(s, returnBreaks: returnBreaks) {
      switch piece {
      case .key(let code):
        postKey(CGKeyCode(code), flags: [])
      case .softBreak:
        postKey(36, flags: .maskShift)
      case .text(let run):
        let units = Array(run.utf16)
        for down in [true, false] {
          guard let e = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(KeyMath.code(for: run)), keyDown: down) else { return false }
          e.flags = []
          units.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
          mark(e)
        }
      }
    }
    return true
  }

  /// Typing key by key didn't take: set a native field's value, else paste.
  private func fallback(_ text: String, _ el: AXUIElement?) -> String {
    if let el, setValue(text, el) { return "accessibility" }
    return paste(text) ? "paste" : "none"
  }

  /// Appends to a native text field's value through Accessibility (not in web pages: they don't notice).
  private func setValue(_ text: String, _ el: AXUIElement) -> Bool {
    guard Self.textRoles.contains(string(el, kAXRoleAttribute)), !inWebPage(el) else { return false }
    var settable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable)
    let want = string(el, kAXValueAttribute) + text
    return settable.boolValue && AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, want as CFString) == .success
      && string(el, kAXValueAttribute) == want
  }

  /// Pastes `text` with ⌘V, marked transient (clipboard managers skip it), and puts back what was
  /// on the clipboard a moment later (unless something else has changed it since).
  private func paste(_ text: String) -> Bool {
    let pb = NSPasteboard.general
    let saved: [NSPasteboardItem] = (pb.pasteboardItems ?? []).map { item in
      let copy = NSPasteboardItem()
      for t in item.types { if let d = item.data(forType: t) { copy.setData(d, forType: t) } }
      return copy
    }
    pb.clearContents()
    let item = NSPasteboardItem()
    item.setString(text, forType: .string)
    item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
    item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
    guard pb.writeObjects([item]) else { return false }
    let ours = pb.changeCount
    postKey(9, flags: .maskCommand) // V
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      guard pb.changeCount == ours else { return }
      pb.clearContents()
      if !saved.isEmpty { pb.writeObjects(saved) }
    }
    return true
  }

  /// Where the caret is in a text field (AppKit screen coordinates), when the app says: the
  /// bounds of the character before it (or of the empty range at the start).
  private func caretRect(_ el: AXUIElement) -> CGRect? {
    guard let v = attr(el, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var sel = CFRange()
    guard AXValueGetValue(v as! AXValue, .cfRange, &sel) else { return nil }
    var probe = sel.location > 0 ? CFRange(location: sel.location - 1, length: 1) : CFRange(location: 0, length: 0)
    guard let arg = AXValueCreate(.cfRange, &probe) else { return nil }
    var out: AnyObject?
    guard AXUIElementCopyParameterizedAttributeValue(el, kAXBoundsForRangeParameterizedAttribute as CFString, arg, &out) == .success,
          let o = out, CFGetTypeID(o) == AXValueGetTypeID() else { return nil }
    var r = CGRect.zero
    guard AXValueGetValue(o as! AXValue, .cgRect, &r), r.height > 2, r.height < 200, r.origin.x.isFinite, r.origin.y.isFinite else { return nil }
    let flipped = PointMath.axToAppKit(r, primaryHeight: AXFinder.Displays.current().primaryHeight)
    // The caret is at the right edge of the character before it.
    return CGRect(x: sel.location > 0 ? flipped.maxX : flipped.minX, y: flipped.minY, width: 0.5, height: flipped.height)
  }

  /// Web pages don't notice a value set through Accessibility, so they get key presses.
  private func inWebPage(_ el: AXUIElement) -> Bool {
    var cur: AXUIElement? = el
    for _ in 0..<40 {
      guard let c = cur else { return false }
      if string(c, kAXRoleAttribute) == "AXWebArea" { return true }
      cur = parent(c)
    }
    return false
  }

  private func scroll(_ r: Resolved, direction: String, amount: Int) -> String {
    let n = max(1, min(10, amount))
    // Accessibility first: the scroll area's own page actions.
    let name = ["up": "AXScrollUpByPage", "down": "AXScrollDownByPage", "left": "AXScrollLeftByPage", "right": "AXScrollRightByPage"][direction] ?? "AXScrollDownByPage"
    var cur = r.element
    for _ in 0..<12 {
      guard let c = cur else { break }
      if actions(c).contains(name) {
        for _ in 0..<n { AXUIElementPerformAction(c, name as CFString) }
        return "accessibility"
      }
      cur = parent(c)
    }
    if let f = r.frame { mark(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: Self.toGlobal(CGPoint(x: f.midX, y: f.midY)), mouseButton: .left)) }
    let lines = Int32(8 * n)
    let (dy, dx): (Int32, Int32) = direction == "up" ? (lines, 0) : direction == "left" ? (0, lines) : direction == "right" ? (0, -lines) : (-lines, 0)
    mark(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
    return "events"
  }

  // MARK: scrolling to a place

  private struct ScrollArea {
    let el: AXUIElement
    let frame: CGRect
    let bar: AXUIElement?
  }

  /// The scroll area a step is about: the one round the thing it resolved to, else the biggest
  /// one in the app's front window (the page, the document, the chat).
  private func scrollArea(for r: Resolved) -> ScrollArea? {
    func area(_ c: AXUIElement) -> ScrollArea? {
      guard string(c, kAXRoleAttribute) == "AXScrollArea", let f = AXFinder.frame(c), f.height > 60 else { return nil }
      return ScrollArea(el: c, frame: f, bar: element(attr(c, "AXVerticalScrollBar")))
    }
    var cur = r.element
    for _ in 0..<14 {
      guard let c = cur else { break }
      if let a = area(c) { return a }
      cur = parent(c)
    }
    let root = AXUIElementCreateApplication(r.pid)
    AXUIElementSetMessagingTimeout(root, 0.4)
    guard let window = element(attr(root, kAXFocusedWindowAttribute)) ?? element(attr(root, kAXMainWindowAttribute)) else { return nil }
    var best: ScrollArea?
    var queue: [AXUIElement] = [window]
    var head = 0
    let deadline = Date().addingTimeInterval(0.25)
    while head < queue.count, head < 1500, Date() < deadline {
      let el = queue[head]
      head += 1
      if let a = area(el), a.frame.width * a.frame.height > (best.map { $0.frame.width * $0.frame.height } ?? 0) { best = a }
      if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids) }
    }
    return best
  }

  /// Where the area is scrolled to, 0 (top) to 1 (bottom), if its scroll bar says.
  private func scrollPosition(_ a: ScrollArea) -> Double? {
    (a.bar.flatMap { attr($0, kAXValueAttribute) } as? NSNumber)?.doubleValue
  }

  /// Scroll the area by points (positive: further down the page), with the pointer over it.
  private func scrollPoints(_ a: ScrollArea, _ points: CGFloat, movePointer: Bool = true) {
    if movePointer { mark(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: Self.toGlobal(CGPoint(x: a.frame.midX, y: a.frame.midY)), mouseButton: .left)) }
    var left = points
    while abs(left) >= 1 {
      let step = max(-240, min(240, left))
      mark(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(-step.rounded()), wheel2: 0, wheel3: 0))
      left -= step
    }
  }

  /// A scroll that goes somewhere on purpose. nil: nothing here applies (no scroll area can be
  /// found, or it is a sideways scroll), and the old page-by-page scroll does it.
  /// `opts`: into (a label to bring into view), place ("top", "bottom", "where"), position (0…1,
  /// a remembered spot), glide ("start" or "hold") with pace ("slow", "fast").
  private func scrollSmart(_ r: Resolved, direction: String, pages: Double, opts: [String: Any]) -> (via: String, extra: [String: Any])? {
    if let g = opts["glide"] as? String, g == "hold" { glide.stop(); return ("glide", ["gliding": false]) }
    guard direction == "up" || direction == "down", let a = scrollArea(for: r) else { return nil }
    DrawLight.shared.fadeOutline() // the page is about to move from under anything that was circled
    let before = scrollPosition(a)
    func report(_ via: String, _ more: [String: Any] = [:], points: CGFloat = 0) -> (via: String, extra: [String: Any]) {
      usleep(90_000) // the app needs a moment to move before its scroll bar says where it is
      var extra = more
      if let after = scrollPosition(a) {
        extra["position"] = (after * 1000).rounded() / 1000
        extra["pageAt"] = ScrollMath.place(after)
        if let before { extra["moved"] = abs(after - before) > 0.002 }
        extra["atTop"] = after <= 0.002
        extra["atEnd"] = after >= 0.998
      }
      return (via, extra)
    }
    if let place = opts["place"] as? String {
      if place == "where" { return report("read") }
      glide.stop()
      let want: Double = place == "top" ? 0 : 1
      if let bar = a.bar, AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: want)) == .success {
        usleep(60_000)
        if let now = scrollPosition(a), abs(now - want) < 0.02 { return report("accessibility") }
      }
      scrollPoints(a, place == "top" ? -200_000 : 200_000)
      return report("events")
    }
    if let want = (opts["position"] as? NSNumber)?.doubleValue, want >= 0, want <= 1 {
      glide.stop()
      if let bar = a.bar, AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: want)) == .success {
        usleep(60_000)
        if let now = scrollPosition(a), abs(now - want) < 0.02 { return report("accessibility") }
      }
      // The bar can't be set: push, see how far that moved it, and push again (a few times at most).
      var lastPoints: CGFloat = 0, lastMoved = 0.0
      for _ in 0..<6 {
        guard let cur = scrollPosition(a), abs(cur - want) >= 0.012 else { break }
        let push = ScrollMath.step(toward: want, from: cur, lastPoints: lastPoints, lastMoved: lastMoved, height: a.frame.height)
        scrollPoints(a, push)
        usleep(110_000)
        lastMoved = (scrollPosition(a) ?? cur) - cur
        lastPoints = push
        if abs(lastMoved) < 0.0005 { break }
      }
      return report("events")
    }
    if let label = (opts["into"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty,
       let app = NSRunningApplication(processIdentifier: r.pid) {
      glide.stop()
      let displays = AXFinder.Displays.current()
      var found = AXFinder.find(label, in: app, displays: displays)
      // Out of view: the app is asked to bring it in; failing that, a page at a time the way its hint says.
      var tries = 0
      while case .hidden(let h) = found, tries < 6 {
        tries += 1
        if tries == 1, let el = h.element, actions(el).contains("AXScrollToVisible") {
          AXUIElementPerformAction(el, "AXScrollToVisible" as CFString)
        } else {
          scrollPoints(a, (h.hint.contains("scroll up") ? -1 : 1) * ScrollMath.points(pages: 1, height: a.frame.height))
        }
        usleep(160_000)
        found = AXFinder.find(label, in: app, displays: displays)
      }
      guard case .hit(let hit) = found else {
        return report("events", ["found": false, "message": "Couldn't find \"\(label)\" to scroll to."])
      }
      // It comes to rest a little way down the area, the same place every time.
      let nudge = ScrollMath.toRest(top: hit.frame.maxY, areaTop: a.frame.maxY, height: a.frame.height)
      if abs(nudge) > 12 { scrollPoints(a, nudge) }
      return report("events", ["found": true, "label": hit.label])
    }
    if let g = opts["glide"] as? String, g == "start" {
      mark(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: Self.toGlobal(CGPoint(x: a.frame.midX, y: a.frame.midY)), mouseButton: .left))
      glide.start(pace: ScrollMath.pace(opts["pace"] as? String) * (direction == "up" ? -1 : 1)) { [weak self] points in
        guard let self else { return false }
        self.scrollPoints(a, points, movePointer: false)
        return true
      } atEnd: { [weak self] in
        guard let self, let v = self.scrollPosition(a) else { return false }
        return direction == "up" ? v <= 0.002 : v >= 0.998
      }
      return ("glide", ["gliding": true])
    }
    // Part of a page, or pages: by points, so a strip of what was on screen stays, and the line
    // that marks where you had read to is drawn there.
    glide.stop()
    let points = ScrollMath.points(pages: max(0.05, min(10, pages)), height: a.frame.height)
    scrollPoints(a, direction == "up" ? -points : points)
    if pages >= ScrollMath.seamFrom, let y = ScrollMath.seamY(points: points, areaBottom: a.frame.minY, height: a.frame.height, down: direction == "down") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.pointer?.seam(across: a.frame, y: y) }
    }
    return report("events")
  }

  // MARK: observing with refs (read-only)

  private static let rotorRole: [String: String] = [
    "AXButton": "button", "AXToolbarButton": "button", "AXPopUpButton": "button", "AXMenuButton": "button", "AXDisclosureTriangle": "button",
    "AXLink": "link", "AXTextField": "textbox", "AXTextArea": "textbox", "AXSecureTextField": "textbox", "AXComboBox": "combobox",
    "AXSearchField": "searchbox", "AXCheckBox": "checkbox", "AXSwitch": "switch", "AXToggle": "switch", "AXRadioButton": "radio",
    "AXTab": "tab", "AXMenuItem": "menuitem", "AXMenuBarItem": "menuitem", "AXCell": "row", "AXRow": "row", "AXSlider": "slider",
    "AXIncrementor": "slider", "AXStepper": "slider",
  ]

  /// The app's visible controls, each with a ref (n1, n2…) good until the next observation.
  private func observe(_ p: [String: Any], answer: @escaping ([String: Any]) -> Void) {
    guard AXFinder.trusted else {
      AXFinder.prompt()
      return answer(["ok": false, "error": "permission", "message": "To see an app's buttons and fields, allow Echo under Accessibility in System Settings, Privacy & Security."])
    }
    guard let app = targetApp(named: p["app"] as? String) else { return answer(["ok": false, "error": "focus", "message": "There's no app to look at."]) }
    let scope = ActMath.scope(p["scope"] as? String, bundle: app.bundleIdentifier)
    let displays = AXFinder.Displays.current()
    DispatchQueue.global(qos: .userInitiated).async {
      let found = AXFinder.controls(in: app, displays: displays, scope: scope)
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        let snap = "n" + String(Int(Date().timeIntervalSince1970 * 1000) % 100_000_000, radix: 36)
        self.observedSnap = snap
        self.observed = [:]
        var marks: [(label: String, frame: CGRect)] = []
        var list: [[String: Any]] = []
        for (i, c) in found.enumerated() {
          let ref = "n\(i + 1)"
          self.observed[ref] = (c.element, c.frame, c.name)
          marks.append((String(i + 1), c.frame))
          list.append(["ref": ref, "role": Self.rotorRole[c.role] ?? "other", "name": c.name, "value": c.value,
                       "editable": c.editable, "disabled": !c.enabled, "secret": c.secure])
        }
        self.lastMarks = marks
        answer(["ok": true, "snapshot": snap, "app": app.localizedName ?? "", "title": AXFinder.focusedWindowTitle(of: app),
                "scope": scope, "elements": list])
      }
    }
  }

  /// The words in an app's window, as Accessibility gives them (text, headings, text areas; never a
  /// password field): the end of them, at most `WatchMath.textMost` characters, since what is new
  /// is at the bottom. Read-only, off the main thread, and given up on after a moment.
  func windowText(of app: NSRunningApplication) -> String {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.5)
    // Chromium and Electron apps only build their Accessibility tree when asked.
    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let window = (attr(root, kAXFocusedWindowAttribute) ?? attr(root, kAXMainWindowAttribute)).flatMap { $0 as! AXUIElement? }
      ?? (attr(root, kAXWindowsAttribute) as? [AXUIElement])?.first
    guard let window else { return "" }
    var parts: [String] = []
    var queue: [AXUIElement] = [window]
    var head = 0
    let deadline = Date().addingTimeInterval(0.6)
    while head < queue.count, head < 4000, Date() < deadline {
      let el = queue[head]
      head += 1
      let role = string(el, kAXRoleAttribute)
      if role == "AXSecureTextField" || string(el, kAXSubroleAttribute) == "AXSecureTextField" { continue }
      if WatchMath.textRoles.contains(role) {
        let value = (attr(el, kAXValueAttribute) as? String) ?? ""
        let t = value.isEmpty ? string(el, kAXTitleAttribute) : value
        if !t.isEmpty { parts.append(String(t.suffix(WatchMath.textMost))) }
      }
      if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids) }
    }
    return WatchMath.tail(parts)
  }

  // MARK: waiting (guide mode and wait_for); read-only

  /// Lessons (lib/teach.js): how the app looks right now, read-only. The same snapshot the click
  /// checks use (front app, window, page, menus, the focused field), plus the state of controls
  /// named in `labels`. Never acts and never captures the screen, so it works with computer use off.
  private func state(_ p: [String: Any], answer: @escaping ([String: Any]) -> Void) {
    guard AXFinder.trusted else {
      return answer(["ok": false, "error": "permission", "message": "To follow a lesson, allow Echo under Accessibility in System Settings, Privacy & Security."])
    }
    guard let app = targetApp(named: p["app"] as? String) else { return answer(["ok": false, "error": "focus", "message": "There's no app to look at."]) }
    let labels = Array((p["labels"] as? [String] ?? []).prefix(12)).map { String($0.prefix(120)) }
    let displays = AXFinder.Displays.current()
    // "Keep an eye on it" (lib/watch.js) also asks for the words in the app's window, to tell when
    // a job there has finished. Read through Accessibility: no picture, and the app need not be in front.
    let wantsText = p["text"] as? Bool ?? false
    DispatchQueue.global(qos: .userInitiated).async {
      let found = labels.isEmpty ? [] : AXFinder.controls(in: app, displays: displays, scope: "app", limit: 400)
      let words = wantsText ? self.windowText(of: app) : nil
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        let s = self.snapshot(app.processIdentifier, target: nil)
        let names = found.map { $0.name }
        var elements: [String: Any] = [:]
        for label in labels {
          guard let i = StateMath.match(label, names: names) else { elements[label] = ["present": false]; continue }
          let c = found[i]
          var e: [String: Any] = ["present": true, "name": c.name, "role": c.role, "enabled": c.enabled]
          if let sel = self.attr(c.element, "AXSelected") as? Bool { e["selected"] = sel }
          if let exp = self.attr(c.element, "AXExpanded") as? Bool { e["expanded"] = exp }
          if !c.secure, let v = self.attr(c.element, kAXValueAttribute) {
            if let n = v as? NSNumber { e["value"] = n.stringValue } else if let t = v as? String { e["value"] = String(t.prefix(200)) }
          }
          elements[label] = e
        }
        answer(["ok": true, "front": s.front, "app": app.localizedName ?? "", "window": s.window, "windows": s.windows,
                "url": String(s.url.prefix(300)), "menuOpen": s.menuOpen, "signature": s.signature,
                "focus": ["role": s.focusRole, "label": s.focusLabel, "value": String(s.focusValue.prefix(400))],
                "elements": elements].merging(words.map { ["text": $0] } ?? [:]) { a, _ in a })
      }
    }
  }

  /// "locate": finds a thing by its name and says where it is in words (`place`, `container`,
  /// `kind`), for a lesson's hint. Read-only and cheap: the Accessibility tree only, no picture
  /// of the screen, no app brought forward, and the light never moves.
  private func locate(_ p: [String: Any], answer: @escaping ([String: Any]) -> Void) {
    guard AXFinder.trusted else {
      return answer(["ok": false, "error": "permission", "message": "To find things by name, allow Echo under Accessibility in System Settings, Privacy & Security."])
    }
    let target = (p["target"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !target.isEmpty else { return answer(["ok": false, "error": "no_target", "message": "Say what to find."]) }
    let app = FrontApp.target(named: p["app"] as? String)
    let menuBar = p["menuBar"] as? Bool ?? false
    let displays = AXFinder.Displays.current()
    DispatchQueue.global(qos: .userInitiated).async {
      var out: [String: Any] = ["ok": true, "found": false]
      if let hit = MenuBar.locate(target, in: app, menuBar: menuBar, displays: displays) {
        out = ["ok": true, "found": true, "via": "accessibility", "label": hit.label, "role": hit.role, "app": hit.app]
        out.merge(AXFinder.place(of: hit.element, frame: hit.frame, in: app, displays: displays)) { mine, _ in mine }
      }
      DispatchQueue.main.async { answer(out) }
    }
  }

  private func wait(_ p: [String: Any], answer: @escaping ([String: Any]) -> Void) {
    guard AXFinder.trusted else {
      return answer(["ok": false, "error": "permission", "message": "To watch for the next step, allow Echo under Accessibility in System Settings, Privacy & Security."])
    }
    let target = (p["target"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !target.isEmpty else { return answer(["ok": false, "error": "no_target", "message": "Say what to wait for."]) }
    let timeout = min(15, max(0.3, Double(truncating: (p["timeoutMs"] as? NSNumber) ?? 10000) / 1000))
    let useScreen = (p["useScreen"] as? Bool ?? false) && Prefs.screenAware
    // A lesson's check asks for the whole label ("exact") or one holding the words ("contains"):
    // the finder's looser matches ("Rectangle" for "Rectangle 1") don't count for it, and the
    // wait goes on past them until the right one shows up or the time runs out.
    let match = p["match"] as? String
    let fits = { (label: String) in match == nil || LabelMatch.fits(label, target, contains: match == "contains") }
    watcher.wait(target: target, app: FrontApp.target(named: p["app"] as? String), menuBar: p["menuBar"] as? Bool ?? false,
                 mode: p["mode"] as? String ?? "present", fresh: p["fresh"] as? Bool ?? true, timeout: timeout,
                 accept: { fits($0.label) }) { hit, changed in
      if let hit {
        let found: [String: Any] = ["ok": true, "found": true, "via": "accessibility", "label": hit.label, "app": hit.app, "changed": changed]
        return answer(found.merging(AXFinder.place(of: hit.element, frame: hit.frame, in: FrontApp.target(named: p["app"] as? String), displays: AXFinder.Displays.current())) { mine, _ in mine })
      }
      // One last look at the text on screen (wait_for only; guide mode never captures while it waits).
      guard useScreen, ScreenLook.supported, ScreenLook.hasPermission else { return answer(["ok": true, "found": false, "changed": changed]) }
      ScreenLook.capture { result in
        if case .success(let shot) = result, let label = match == nil ? AXFinder.find(target, in: shot)?.label : shot.boxes.map(\.text).first(where: fits) {
          answer(["ok": true, "found": true, "via": "text", "label": label, "app": shot.app, "changed": changed])
        } else {
          answer(["ok": true, "found": false, "changed": changed])
        }
      }
    }
  }

  // MARK: taking back control

  /// Starts watching for your own input. Returns false if Echo can't watch (then it won't drive).
  private func startWatching() -> Bool {
    if tap != nil || !monitors.isEmpty { return true }
    let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .mouseMoved, .leftMouseDragged]
    let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    let callback: CGEventTapCallBack = { _, type, event, _ in
      ComputerDriver.shared.observe(type, event)
      return Unmanaged.passUnretained(event)
    }
    if let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: callback, userInfo: nil) {
      tap = t
      tapSource = CFMachPortCreateRunLoopSource(nil, t, 0)
      CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes)
      CGEvent.tapEnable(tap: t, enable: true)
      return true
    }
    // No Input Monitoring: AppKit's monitors (these need Accessibility, checked already).
    guard AXFinder.trusted else { return false }
    let kinds: NSEvent.EventTypeMask = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .mouseMoved, .leftMouseDragged]
    if let g = NSEvent.addGlobalMonitorForEvents(matching: kinds, handler: { e in
      if let c = e.cgEvent { ComputerDriver.shared.observe(c.type, c) }
    }) { monitors.append(g) }
    if let l = NSEvent.addLocalMonitorForEvents(matching: kinds, handler: { e in
      if let c = e.cgEvent { ComputerDriver.shared.observe(c.type, c) }
      return e
    }) { monitors.append(l) }
    return !monitors.isEmpty
  }

  private func stopWatching() {
    if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
    if let s = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
    tap = nil
    tapSource = nil
    monitors.forEach { NSEvent.removeMonitor($0) }
    monitors = []
  }

  /// Every input event while watching: TakeBackPolicy decides (Echo's own, marked events never count).
  func observe(_ type: CGEventType, _ event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
      return
    }
    guard event.getIntegerValueField(.eventSourceUserData) != Self.marker else { return }
    let escape = type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53
    let input: TakeBackPolicy.Input
    switch type {
    case .keyDown: input = .key(code: escape ? TakeBackPolicy.escape : event.getIntegerValueField(.keyboardEventKeycode))
    case .mouseMoved, .leftMouseDragged:
      input = .move(dx: event.getDoubleValueField(.mouseEventDeltaX), dy: event.getDoubleValueField(.mouseEventDeltaY))
    case .scrollWheel: input = .scroll
    default: input = .click
    }
    let at = event.location
    // Where the event is going, as the window server says (read now, while the event is live).
    let eventWindow = Int(event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent))
    let underPointer = Int(event.getIntegerValueField(.mouseEventWindowUnderMousePointer))
    let targetPid = Int32(truncatingIfNeeded: event.getIntegerValueField(.eventTargetUnixProcessID))
    DispatchQueue.main.async { [weak self] in
      guard let self, self.driving else { return }
      self.policy.mode = ComputerPrefs.takeBack == "end" ? .end : .pause
      self.policy.movePx = ComputerPrefs.movePx
      // Clicking a card in Echo's own window, the pill or the companion, or typing while Echo has
      // the keyboard, isn't taking over. Only input in other apps is.
      var inEcho = false
      if case .key = input {
        inEcho = !escape && self.isEchoInput(eventWindow: 0, targetPid: targetPid, at: nil)
      } else {
        // Picking up Echo's light and carrying it somewhere is pointing, not taking over.
        inEcho = self.pointer?.inHand == true || self.isEchoInput(eventWindow: eventWindow > 0 ? eventWindow : underPointer, targetPid: targetPid, at: at)
      }
      let why = escape ? "pressed Escape" : type == .keyDown ? "typed on the keyboard" : type == .scrollWheel ? "scrolled" : input == .click ? "clicked" : "used the mouse"
      switch self.policy.decide(input, at: ProcessInfo.processInfo.systemUptime, actionInFlight: self.inFlight > 0,
                                sinceEchoPosted: Date().timeIntervalSince(self.lastPosted), inEcho: inEcho,
                                afterAllow: Date() < self.confirmGraceUntil) {
      case .ignore: break
      case .pauseAction: self.pause(why)
      case .endSession: self.abort(why)
      }
    }
  }

  /// Is this input of yours aimed at one of Echo's own windows (InputTarget)? `at` is the event's
  /// global location (nil for keys).
  private func isEchoInput(eventWindow: Int, targetPid: Int32, at: CGPoint?) -> Bool {
    let mine = NSApp.windows.filter { $0.isVisible }
    let numbers = Set(mine.map(\.windowNumber))
    let clickThrough = Set(mine.filter { $0.ignoresMouseEvents }.map(\.windowNumber))
    var windows: [InputTarget.Win] = []
    if at != nil {
      if Date().timeIntervalSince(windowsCache.at) > 0.3 {
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        windowsCache = (Date(), list.compactMap { d in
          guard let pid = (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                let number = (d[kCGWindowNumber as String] as? NSNumber)?.intValue,
                let b = d[kCGWindowBounds as String] as? NSDictionary,
                let bounds = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
          return InputTarget.Win(pid: pid, number: number, bounds: bounds, alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
        })
      }
      windows = windowsCache.list
    }
    return InputTarget.isEcho(own: [me], echoWindows: numbers, clickThrough: clickThrough, eventWindow: eventWindow,
                              targetPid: targetPid, point: at, windows: windows,
                              echoActive: NSApp.isActive || NSApp.keyWindow != nil)
  }

  /// You took over one step: it stops now (and nothing more happens in this request), but the
  /// session and the edge glow stay, and Echo keeps listening for what you say next.
  func pause(_ reason: String) {
    glide.stop() // your hand is on it: the page stops moving at once
    epoch += 1
    pausedRequest = request
    resolved = [:]
    watcher.cancel()
    pointer?.release()
    bumpIdle()
    // One report per burst of clicks or typing.
    guard Date().timeIntervalSince(lastPause) > 1.5 else { return }
    lastPause = Date()
    // (`app`: the one in front, so the server can tell a move in a shared game from a click elsewhere.)
    post?("/api/computer/event", ["type": "pause", "reason": reason, "runId": runId, "request": request,
                                  "app": NSWorkspace.shared.frontmostApplication?.localizedName ?? ""])
  }

  /// You took over: stop now, and tell Echo's server.
  func abort(_ reason: String) {
    glide.stop()
    let run = runId
    abortedRun = run
    end()
    post?("/api/computer/event", ["type": "abort", "reason": reason, "runId": run])
  }

  /// The run is over (done, stopped in the window, turned off, or idle).
  func end(abort: Bool = false, idle: Bool = false) {
    if abort { abortedRun = runId }
    driving = false
    epoch += 1
    inFlight = 0
    idleWork?.cancel()
    idleWork = nil
    resolved = [:]
    watcher.cancel()
    shownDriving = false
    EdgeGlow.shared.hide(.driving)
    StatusChip.shared.setDriving(false)
    pointer?.release()
    // The pill's Stop and driving state go with the run, whether or not the page is there to say
    // so. Only quiet between steps (idle): the session may still be on, so the page's word stands.
    if idle { CaptionBar.shared.driveIdle() } else { CaptionBar.shared.driveEnded() }
    if !idle { appName = "" }
    stopWatching()
  }

  /// Echo is driving: the edge glow and the chip, and (once per session) the pill's Escape hint.
  private func showDriving() {
    guard !shownDriving else { return }
    shownDriving = true
    EdgeGlow.shared.show(.driving)
    StatusChip.shared.setDriving(true)
    CaptionBar.shared.flashHint()
  }

  /// Nothing for a while: stop showing the edge glow and watching (the next action starts again).
  private func bumpIdle() {
    idleWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.end(idle: true) }
    idleWork = work
    // Longer than the server's quiet minute: a driving session carries on between requests.
    DispatchQueue.main.asyncAfter(deadline: .now() + 75, execute: work)
  }
}

// MARK: page ↔ app messages for guide mode and computer use

extension AppDelegate {
  /// The pill's buttons and reply field, wired once at launch (main.swift), so Stop and close
  /// work before the page has said anything, and when it isn't there at all.
  func wireCaption() {
    let driver = ComputerDriver.shared
    driver.pointer = pointer
    driver.post = { [weak self] path, b in self?.server.post(path, b) }
    // The pointer's light: the server lets it go or holds it (BodyLink), and a light you dropped
    // on something is told to the server with the app's token.
    BodyLink.shared.onFirefly = { [weak self] msg in self?.pointer.firefly(msg) }
    pointer.onPointed = { [weak self] body in self?.server.pointed(body) }
    pointer.onLight = { [weak self] body in self?.server.light(body) }
    // The island's question changed (asked, answered, gone): the same question beside the thing follows it.
    NotificationCenter.default.addObserver(forName: CaptionBar.askChanged, object: nil, queue: .main) { [weak self] _ in self?.pointer.syncAsk() }
    CaptionBar.shared.onStop = { [weak self] in
      // In the app first: the driver stops and tells the server over HTTP (POST
      // /api/computer/event, which ends the run there), so Stop works with no page. Then the
      // page, if it's there (she stops talking too); js() does nothing when it isn't.
      driver.abort("stopped from the caption bar")
      self?.js("window.echoNative?.captionStop?.()")
      // No page to say what comes next: the pill goes now.
      if self?.pageLoaded != true { CaptionBar.shared.reset() }
    }
    // The close button already hid the pill; the page stops offering its reply field.
    CaptionBar.shared.onClose = { [weak self] in self?.js("window.echoNative?.captionClosed?.()") }
    // Yes / No in the pill answer Echo's question like the card in her window does.
    CaptionBar.shared.onConfirm = { [weak self] allow in self?.js("window.echoNative?.captionConfirm?.(\(allow))") }
    // The pill's reply field: what you type goes to Echo like a message typed in her window.
    ReplyField.shared.onSend = { [weak self] text in
      guard let data = try? JSONSerialization.data(withJSONObject: [text]), let arg = String(data: data, encoding: .utf8) else { return }
      self?.js("window.echoNative?.captionSend?.(\(arg)[0])")
    }
    ReplyField.shared.onChange = { CaptionBar.shared.refresh() }
    // The companion docks in the pill while it's up, and leaves with it.
    CaptionBar.shared.onShowChange = { [weak self] showing in
      if showing { self?.pointer.dock() } else { self?.pointer.undock() }
    }
    // A resting orb (Core Animation only) wakes whenever the pill changes, to follow it.
    CaptionBar.shared.onChange = { [weak self] in self?.pointer.wake() }
    CaptionBar.shared.echoInFront = { [weak self] in
      guard let w = self?.window else { return false }
      return NSApp.isActive && w.isVisible && !w.isMiniaturized && w.occlusionState.contains(.visible)
    }
  }

  /// Handles computer-use and guide messages (and menu bar pointing). Returns false for anything else.
  func handleComputerMessage(_ type: String, _ body: [String: Any]) -> Bool {
    let driver = ComputerDriver.shared
    driver.pointer = pointer
    if driver.post == nil { driver.post = { [weak self] path, b in self?.server.post(path, b) } }
    switch type {
    case "caption":
      CaptionBar.shared.update(body)
      return true
    case "computerPrefs":
      if let v = body["computerUse"] as? Bool {
        ComputerPrefs.enabled = v
        if !v { driver.end(abort: true) }
      }
      if let v = body["takeBack"] as? String, ["pause", "end"].contains(v) { ComputerPrefs.takeBack = v }
      if let v = body["background"] as? Bool { ComputerPrefs.background = v }
      if let v = (body["takeBackMovePx"] as? NSNumber)?.doubleValue, v.isFinite { ComputerPrefs.movePx = max(20, min(600, v)) }
      return true
    case "computerStop":
      driver.end(abort: body["abort"] as? Bool ?? false)
      return true
    case "screen":
      guard let id = body["id"] as? String else { return false }
      let params = body["params"] as? [String: Any] ?? [:]
      let reply = { [weak self] (b: [String: Any]) in
        // The light's search for this request (if it had one) is over; when the server has
        // already stopped waiting for it, nothing is sent.
        guard let self, self.pointer.answered(id, found: b["found"] as? Bool ?? (b["ok"] as? Bool ?? true)) else { return }
        var out = b
        out["id"] = id
        if self.pointer.lit(id) { out["light"] = true } // the light is on its way: `arrived` follows
        self.server.post("/api/screen/result", out)
      }
      switch body["kind"] as? String {
      case "act", "wait", "observe", "state", "locate":
        driver.handle(kind: body["kind"] as! String, id: id, params, answer: reply)
        return true
      case "local":
        // A quick judgement from the on-device model (LocalModel.swift); read-only.
        LocalModel.respond(params["prompt"] as? String ?? "", reply)
        return true
      default:
        return false
      }
    default:
      return false
    }
  }
}

/// Read-along: a few points of scroll thirty times a second, so the page moves at a steady
/// reading pace. It stops when it is held, when the page's end is reached, when you touch the
/// mouse or keys (Driver.pause), or after ScrollMath.glideMost.
final class ScrollGlide {
  private var timer: Timer?
  private var carry: CGFloat = 0
  private var startedAt = Date()
  private var ticks = 0
  var running: Bool { timer != nil }

  /// `pace`: points a second (negative: upward). `push` scrolls by that many points (false: it
  /// can't any more); `atEnd` says the page has run out.
  func start(pace: CGFloat, push: @escaping (CGFloat) -> Bool, atEnd: @escaping () -> Bool) {
    stop()
    startedAt = Date()
    carry = 0
    ticks = 0
    timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.ticks += 1
      self.carry += pace / 30
      let whole = self.carry.rounded(.towardZero)
      if whole != 0 {
        self.carry -= whole
        if !push(whole) { return self.stop() }
      }
      // Every half second: has the page run out, or has this gone on long enough?
      if self.ticks % 15 == 0, atEnd() || Date().timeIntervalSince(self.startedAt) > ScrollMath.glideMost { self.stop() }
    }
  }

  func stop() {
    timer?.invalidate()
    timer = nil
  }
}
