// Echo's pointer: the pearl in the island sends its light to something on screen, which circles
// it while it gets a thin white ring, so Echo can say "click here". It only points. The overlay ignores the mouse
// completely (clicks go straight through to the app underneath) and Echo never clicks or types.
// The one thing that takes the mouse is the light itself, a spot 22 pt across, while it rests on
// something: you can pick it up and drop it on something else to say "this one".
//
// Targets are found by name with the Accessibility API first (buttons, menu items, links, fields),
// then among the text read off the screen (Screen.swift) when Accessibility can't see it.
import AppKit
import ApplicationServices

// MARK: finding things by name (Accessibility API)

enum AXFinder {
  struct Hit {
    let frame: CGRect // the part you can see, AppKit screen coordinates
    let label: String
    let role: String
    let app: String
    /// The element that matched (or the control around the text that matched): what Echo acts
    /// on. Never swapped for whatever a hit-test at its centre finds.
    var element: AXUIElement? = nil
    /// The match's score (shown to the assistant) and whether it's something you can act on.
    var score = 0
    var interactive = true
  }

  /// A match that exists but can't be seen: scrolled out of view in a list or sidebar.
  struct Hidden {
    let frame: CGRect
    let label: String
    let role: String
    let hint: String
    /// The element itself, so it can be brought into view (Driver.scroll, "into").
    var element: AXUIElement? = nil
  }

  enum Result {
    case hit(Hit)
    case hidden(Hidden)
    case none
  }

  /// The displays, read on the main thread before a search runs in the background.
  struct Displays {
    let screens: [CGRect] // AppKit frames, the primary one first
    var primaryHeight: CGFloat { screens.first?.maxY ?? 0 }
    static func current() -> Displays { Displays(screens: NSScreen.screens.map(\.frame)) }
  }

  static var trusted: Bool { AXIsProcessTrusted() }

  /// Shows macOS's "allow Accessibility" prompt (only if it hasn't been answered).
  static func prompt() {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
  }

  private static func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
  }

  private static func string(_ el: AXUIElement, _ name: String) -> String {
    (attr(el, name) as? String) ?? ""
  }

  private static func axRect(position p: AnyObject?, size s: AnyObject?) -> CGRect? {
    guard let p, let s, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    let r = CGRect(origin: point, size: size)
    return PointMath.usable(r) ? r : nil
  }

  /// An element's frame in AppKit coordinates, or nil when it has no usable one (missing, zero, NaN).
  static func frame(_ el: AXUIElement, primaryHeight: CGFloat? = nil) -> CGRect? {
    guard let r = axRect(position: attr(el, kAXPositionAttribute), size: attr(el, kAXSizeAttribute)) else { return nil }
    return PointMath.axToAppKit(r, primaryHeight: primaryHeight ?? Displays.current().primaryHeight)
  }

  static func focusedWindowTitle(of app: NSRunningApplication) -> String {
    guard trusted else { return "" }
    let el = AXUIElementCreateApplication(app.processIdentifier)
    guard let w = attr(el, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return "" }
    return string(w as! AXUIElement, kAXTitleAttribute)
  }

  /// The app's focused window, in AppKit coordinates (to know which display to read).
  static func focusedWindowFrame(of app: NSRunningApplication) -> CGRect? {
    guard trusted else { return nil }
    let el = AXUIElementCreateApplication(app.processIdentifier)
    guard let w = attr(el, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return nil }
    return frame(w as! AXUIElement)
  }

  /// Password fields in the app's focused window, to black out before a look is sent anywhere.
  static func secureFieldFrames(in app: NSRunningApplication?) -> [CGRect] {
    guard trusted, let app else { return [] }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    guard let w = attr(root, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return [] }
    var out: [CGRect] = []
    walk(w as! AXUIElement, limit: 3000, seconds: 0.4) { el, role, subrole in
      if subrole == "AXSecureTextField" || role == "AXSecureTextField", let f = frame(el) { out.append(f) }
      return true
    }
    return out
  }

  /// Breadth-first walk of an element's descendants, within a budget. `visit` returns false to stop.
  private static func walk(_ root: AXUIElement, limit: Int, seconds: Double,
                           _ visit: (AXUIElement, String, String) -> Bool) {
    let deadline = Date().addingTimeInterval(seconds)
    var queue: [AXUIElement] = [root]
    var seen = 0
    while !queue.isEmpty, seen < limit, Date() < deadline {
      let el = queue.removeFirst()
      seen += 1
      if !visit(el, string(el, kAXRoleAttribute), string(el, kAXSubroleAttribute)) { return }
      if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids) }
    }
  }

  static func normalize(_ s: String) -> String { LabelMatch.normalize(s) }
  static func score(_ candidate: String, _ query: String) -> Int { LabelMatch.score(candidate, query) }

  /// Containers: never a place to point, even when their name matches ("Sidebar", a web page's title).
  private static let containers: Set<String> = [
    "AXApplication", "AXWindow", "AXScrollArea", "AXScrollBar", "AXSplitGroup", "AXSplitter", "AXOutline",
    "AXTable", "AXList", "AXBrowser", "AXWebArea", "AXLayoutArea", "AXMenuBar",
  ]

  /// What clips its contents: you only see the part of a child inside these.
  private static let clipping: Set<String> = ["AXWindow", "AXScrollArea", "AXSheet", "AXDrawer", "AXPopover", "AXWebArea"]

  /// The scroll view a candidate sits in, and what it's called ("sidebar"), for the scroll hint.
  private final class ScrollInfo {
    let frame: CGRect
    var name: String
    init(frame: CGRect, name: String) { self.frame = frame; self.name = name }
  }

  private static let batch: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute,
    "AXPlaceholderValue", kAXValueAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXChildrenAttribute,
  ]

  /// The best match for `query` in the app's windows and menu bar. Only things you can actually
  /// see count as a hit; a match scrolled out of view comes back as `.hidden` with a hint.
  /// The web pages (AXWebArea) in a window: where a browser's page content starts. Nested frames
  /// are inside these, so only the outermost ones are returned.
  static func webAreas(in window: AXUIElement, seconds: Double = 0.4) -> [AXUIElement] {
    var out: [AXUIElement] = []
    let deadline = Date().addingTimeInterval(seconds)
    var queue: [AXUIElement] = [window]
    var head = 0
    while head < queue.count, head < 600, Date() < deadline {
      let el = queue[head]
      head += 1
      if string(el, kAXRoleAttribute) == "AXWebArea" { out.append(el); continue }
      if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids) }
    }
    return out
  }

  /// Menus open in the app right now (a context menu, a pop-up's list): searched first, since
  /// what you ask for next is usually in them.
  static func openMenus(of root: AXUIElement) -> [AXUIElement] {
    ((attr(root, kAXChildrenAttribute) as? [AXUIElement]) ?? []).filter { string($0, kAXRoleAttribute) == "AXMenu" }
  }

  /// The control around a piece of text or an icon (the button "Compose" is written in), when
  /// it's close around it; else nil.
  static func control(around el: AXUIElement, frame f: CGRect, top: CGFloat) -> (AXUIElement, CGRect, String)? {
    var cur = el
    for _ in 0..<5 {
      guard let up = attr(cur, kAXParentAttribute), CFGetTypeID(up) == AXUIElementGetTypeID() else { return nil }
      let p = up as! AXUIElement
      let role = string(p, kAXRoleAttribute)
      if ["AXWebArea", "AXWindow", "AXApplication", "AXScrollArea"].contains(role) { return nil }
      if let pf = frame(p, primaryHeight: top) {
        guard ActMath.plausibleContainer(f, pf) else { return nil }
        var names: CFArray?
        let pressable = AXUIElementCopyActionNames(p, &names) == .success && (names as? [String] ?? []).contains("AXPress") // only read here; Driver.swift presses
        if ActMath.interactive.contains(role) || (pressable && role != "AXGroup") { return (p, pf, role) }
        if pressable && role == "AXGroup" && string(p, "AXSubrole") != "" { return (p, pf, role) }
      }
      cur = p
    }
    return nil
  }

  /// The best match for `query` in the app. Only things you can actually see count as a hit; a
  /// match scrolled out of view comes back as `.hidden` with a hint.
  /// - scope "page" (a browser's default): only the web page in the front window, never the
  ///   browser's tabs, toolbar or profile button ("Subject" once opened Chrome's profile menu);
  ///   "app": the app's windows and its own menus; "browser"/"menu_bar": everything, as before.
  /// - wantsField: typing; a field beats the label next to it.
  /// - Text and icons that match are traded for the control around them (a button, a link), so
  ///   the press lands on the control; the matched element itself is what gets acted on.
  static func find(_ query: String, in app: NSRunningApplication, displays: Displays, scope: String = "app", wantsField: Bool = false) -> Result {
    guard trusted else { return .none }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.6) // a hung app doesn't hang the search
    // Chromium and Electron apps only build their Accessibility tree when asked.
    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let screens = displays.screens, top = displays.primaryHeight
    let wantsSearchField = LabelMatch.asksForSearchField(query)
    var best: (score: Int, area: CGFloat, hit: Hit)?
    var hidden: (score: Int, info: Hidden)?
    // Everything visible that matched at all: the runners-up say how crowded the thing found is.
    var matched: [(score: Int, frame: CGRect)] = []
    var starts: [AXUIElement] = openMenus(of: root)
    let focusedWindow: AXUIElement? = {
      guard let w = attr(root, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return nil }
      return (w as! AXUIElement)
    }()
    // With no web page found, a "page" search looks in the window but never in the browser's
    // tab strip or toolbar (a tab titled "Compose Mail" was clicked instead of Gmail's Compose).
    var skipBrowserChrome = false
    if scope == "page", let w = focusedWindow {
      var pages = webAreas(in: w)
      if pages.isEmpty {
        // Chromium builds its tree when first asked (AXManualAccessibility, above): look again.
        Thread.sleep(forTimeInterval: 0.25)
        pages = webAreas(in: w, seconds: 0.6)
      }
      // No page in the window (a settings window, a download bar): the window itself.
      // (Inside a page, a tab list is the page's own: "Primary", "Promotions". Only pruned here.)
      starts.append(contentsOf: pages.isEmpty ? [w] : pages)
      skipBrowserChrome = pages.isEmpty
    } else {
      if let w = focusedWindow { starts.append(w) }
      if let ws = attr(root, kAXWindowsAttribute) as? [AXUIElement] { starts.append(contentsOf: ws) }
      if let bar = attr(root, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() { starts.append(bar as! AXUIElement) }
    }
    let deadline = Date().addingTimeInterval(2.5)
    var seen = 0
    var visited = Set<Int>()
    search: for start in starts {
      let key = Int(CFHash(start))
      if visited.contains(key) { continue }
      visited.insert(key)
      var queue: [(el: AXUIElement, clips: [CGRect], scroll: ScrollInfo?)] = [(start, [], nil)]
      var head = 0
      while head < queue.count, seen < 6000, Date() < deadline {
        let (el, clips, scroll) = queue[head]
        head += 1
        seen += 1
        // One round trip for everything we need about this element.
        var raw: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, batch as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
              let values = raw as? [AnyObject], values.count == batch.count else { continue }
        let text = { (i: Int) -> String in (values[i] as? String) ?? "" }
        let role = text(0), subrole = text(1)
        let axFrame = axRect(position: values[7], size: values[8])
        let f = axFrame.map { PointMath.axToAppKit($0, primaryHeight: top) }

        // What its children are clipped by.
        var childClips = clips, childScroll = scroll
        if clipping.contains(role), let f {
          childClips.append(f)
          if role == "AXScrollArea" { childScroll = ScrollInfo(frame: f, name: text(3)) }
        }
        if let s = scroll, s.name.isEmpty, ["AXOutline", "AXList", "AXTable", "AXGroup"].contains(role), !text(3).isEmpty {
          s.name = text(3)
        }
        if skipBrowserChrome && ActMath.isBrowserChrome(role: role, subrole: subrole) { continue }
        if let kids = values[10] as? [AXUIElement] {
          for k in kids { queue.append((k, childClips, childScroll)) }
        }

        guard !containers.contains(role), let f else { continue }
        var label = "", s = 0
        // Title, description, help, placeholder. A value is what's IN a field (or a tab's title,
        // an email row), not its name: it only counts for plain text on the page.
        for i in 2...(role == "AXStaticText" ? 6 : 5) {
          let v = score(text(i), query)
          if v > s { s = v; label = text(i) }
        }
        let isSearchField = role == "AXSearchField" || subrole == "AXSearchField"
        if wantsSearchField && isSearchField && s < 100 {
          s = 100
          label = text(5).isEmpty ? "Search" : text(5)
        }
        guard s >= 45 else { continue }
        s = ActMath.adjust(s, role: role, subrole: subrole, enabled: (values[9] as? Bool) != false, wantsField: wantsField)
        // Pointing at the middle of something huge points at nothing in particular.
        let screenArea = PointMath.screenIndex(for: f, in: screens).map { screens[$0].width * screens[$0].height } ?? 0
        if screenArea > 0 && f.width * f.height > screenArea * 0.3 { continue }

        guard let seenPart = PointMath.visiblePart(f, clips: clips, screens: screens) else {
          // It's there but you can't see it: say which way to scroll, if it's in a scroll view.
          if let sc = scroll, let dir = PointMath.scrollDirection(f, clip: sc.frame), hidden == nil || s > hidden!.score {
            let place = sc.name.isEmpty ? "a list" : "the \(sc.name.lowercased())"
            let what = label.isEmpty ? query : label
            hidden = (s, Hidden(frame: f, label: what, role: role,
                                hint: "\"\(what)\" is in \(place) but scrolled out of view: scroll \(dir) in \(place) to see it.", element: el))
          }
          continue
        }
        let area = seenPart.width * seenPart.height
        matched.append((s, seenPart))
        if best == nil || s > best!.score || (s == best!.score && area < best!.area) {
          var hit = Hit(frame: seenPart, label: label, role: role, app: app.localizedName ?? "", element: el, score: s,
                        interactive: ActMath.interactive.contains(role) || isSearchField)
          // Text or an icon: act on the control around it, if there's one close around it.
          if ActMath.shouldClimb(role), let (c, cf, crole) = control(around: el, frame: f, top: top),
             let cSeen = PointMath.visiblePart(cf, clips: clips, screens: screens) {
            hit = Hit(frame: cSeen, label: label, role: crole, app: app.localizedName ?? "", element: c, score: s, interactive: true)
          }
          best = (s, area, hit)
        }
        if s >= 115 { break search } // an exact match on a visible button: done
      }
    }
    // A visible match wins unless a much better one is only scrolled away.
    if let b = best, b.score >= 45, hidden == nil || b.score >= 75 || b.score >= hidden!.score - 20 {
      note(rivals: PearlMath.rivals(of: b.hit.frame, score: b.score, among: matched), beside: b.hit.frame)
      return .hit(b.hit)
    }
    if let h = hidden { return .hidden(h.info) }
    return .none
  }

  /// How many look-alikes the last find saw beside what it found (PearlMath.rivals): the light
  /// shows a crowded thing for longer. Finds run off the main thread, so it is kept under a lock.
  private static let rivalLock = NSLock()
  private static var lastRivals: (frame: CGRect, count: Int)?
  private static func note(rivals count: Int, beside frame: CGRect) {
    rivalLock.lock()
    lastRivals = (frame, count)
    rivalLock.unlock()
  }
  static func rivals(beside frame: CGRect) -> Int {
    rivalLock.lock()
    defer { rivalLock.unlock() }
    return lastRivals.map { $0.frame.intersects(frame) ? $0.count : 0 } ?? 0
  }

  /// One control in an observation (Driver.observe): what it is, what it's called, where.
  struct Control {
    let element: AXUIElement
    let frame: CGRect
    let role: String
    let name: String
    let value: String
    let editable: Bool
    let secure: Bool
    let enabled: Bool
  }

  /// The controls you can see in the app's front window (a browser: its page), for an
  /// observation with refs, in reading order. Read-only.
  static func controls(in app: NSRunningApplication, displays: Displays, scope: String, limit: Int = 250) -> [Control] {
    guard trusted else { return [] }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.6)
    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let screens = displays.screens, top = displays.primaryHeight
    var starts: [AXUIElement] = openMenus(of: root)
    var skipBrowserChrome = false
    if let w = attr(root, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
      let win = w as! AXUIElement
      let pages = scope == "page" ? webAreas(in: win) : []
      starts.append(contentsOf: pages.isEmpty ? [win] : pages)
      skipBrowserChrome = scope == "page" && pages.isEmpty
    }
    var out: [Control] = []
    let deadline = Date().addingTimeInterval(1.5)
    var queue: [(AXUIElement, [CGRect])] = starts.map { ($0, []) }
    var head = 0
    while head < queue.count, head < 8000, out.count < limit, Date() < deadline {
      let (el, clips) = queue[head]
      head += 1
      var raw: CFArray?
      guard AXUIElementCopyMultipleAttributeValues(el, batch as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
            let values = raw as? [AnyObject], values.count == batch.count else { continue }
      let text = { (i: Int) -> String in (values[i] as? String) ?? "" }
      let role = text(0), subrole = text(1)
      if skipBrowserChrome && ActMath.isBrowserChrome(role: role, subrole: subrole) { continue }
      let f = axRect(position: values[7], size: values[8]).map { PointMath.axToAppKit($0, primaryHeight: top) }
      var childClips = clips
      if clipping.contains(role), let f { childClips.append(f) }
      if let kids = values[10] as? [AXUIElement] { for k in kids { queue.append((k, childClips)) } }
      guard ActMath.interactive.contains(role) || subrole == "AXSearchField", let f,
            let seen = PointMath.visiblePart(f, clips: clips, screens: screens) else { continue }
      let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
      let editable = ActMath.editable.contains(role) || subrole == "AXSearchField"
      var name = [2, 3, 5, 4].map { text($0) }.first { !$0.isEmpty } ?? ""
      if name.isEmpty, !editable, let kids = values[10] as? [AXUIElement] {
        // A button or link whose name is the text inside it.
        name = kids.prefix(4).map { string($0, kAXValueAttribute) }.first { !$0.isEmpty } ?? ""
      }
      let value = secure || !editable ? "" : String(text(6).prefix(120))
      out.append(Control(element: el, frame: seen, role: role, name: String(name.prefix(120)), value: value, editable: editable, secure: secure,
                         enabled: (values[9] as? Bool) != false))
    }
    // Reading order: top to bottom, then left to right.
    return out.sorted { abs($0.frame.maxY - $1.frame.maxY) > 8 ? $0.frame.maxY > $1.frame.maxY : $0.frame.minX < $1.frame.minX }
  }

  /// The best text box read off the screen for `query`, as a screen rectangle.
  /// `page`: only text inside this screen rectangle (the web page, for scope "page"), so the
  /// browser's tab titles and toolbar never match.
  static func find(_ query: String, in shot: ScreenShot, page: CGRect? = nil, pageOnly: Bool = false) -> (frame: CGRect, label: String)? {
    var best: (Int, CGRect, String)?
    for b in shot.boxes {
      let s = score(b.text, query)
      guard s >= 45, best == nil || s > best!.0 else { continue }
      let r = PointMath.imageToScreen(b.rect, display: shot.displayFrame, imageSize: shot.captureSize)
      if pageOnly && !ActMath.onPage(r, page: page) { continue }
      best = (s, r, b.text)
    }
    guard let (_, r, text) = best else { return nil }
    return PointMath.usable(r) ? (r, text) : nil
  }

  /// The web page's frame (AppKit screen coordinates) in the app's front window, if it has one.
  static func pageFrame(of app: NSRunningApplication, primaryHeight: CGFloat) -> CGRect? {
    guard trusted else { return nil }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.6)
    guard let w = attr(root, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID(),
          let page = webAreas(in: w as! AXUIElement).first else { return nil }
    return frame(page, primaryHeight: primaryHeight)
  }

  /// The app's focused window (AppKit coordinates), safe off the main thread: `primaryHeight`
  /// was read on it, and a hung app answers "none" in under half a second.
  static func focusedWindowFrame(of app: NSRunningApplication, primaryHeight: CGFloat) -> CGRect? {
    guard trusted else { return nil }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.4)
    guard let w = attr(root, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return nil }
    return frame(w as! AXUIElement, primaryHeight: primaryHeight)
  }

  // MARK: where a found thing is, in words

  /// Where a found thing is, for saying it before pointing ("in the toolbar at the top left: the
  /// Rectangle button"): `place` (which part of its window: PlaceMath.region), `kind` (a plain
  /// word for what it is) and `container` (the toolbar, sidebar, menu bar, tab bar or dialog it
  /// sits in, found a few parents up). Only those fixed words leave here; the parents' roles and
  /// names are read to choose them and are never sent. A thing in no window (the menu bar, an
  /// open menu) is placed on its screen. Safe off the main thread.
  static func place(of el: AXUIElement?, frame: CGRect?, in app: NSRunningApplication?, displays: Displays) -> [String: Any] {
    guard let frame, PointMath.usable(frame) else { return [:] }
    var out: [String: Any] = [:]
    var window: CGRect?
    if let el { AXUIElementSetMessagingTimeout(el, 0.3) } // a hung app costs a moment, not the answer
    // (An element that won't even say its role is in an app that isn't answering: asked no more.)
    if trusted, let el, case let role = string(el, kAXRoleAttribute), !role.isEmpty {
      let kind = PlaceMath.kind(role: role, subrole: string(el, kAXSubroleAttribute), titled: !string(el, kAXTitleAttribute).isEmpty)
      if !kind.isEmpty { out["kind"] = kind }
      var up = element(attr(el, kAXParentAttribute))
      var levels = 0
      while let parent = up, levels < 6, out["container"] == nil {
        levels += 1
        AXUIElementSetMessagingTimeout(parent, 0.3)
        let prole = string(parent, kAXRoleAttribute)
        let name = string(parent, kAXTitleAttribute) + " " + string(parent, kAXDescriptionAttribute)
        if let c = PlaceMath.container(role: prole, subrole: string(parent, kAXSubroleAttribute), name: name, kind: kind) { out["container"] = c }
        if PlaceMath.ends(role: prole) { break }
        up = element(attr(parent, kAXParentAttribute))
      }
      if role != "AXMenuBarItem", role != "AXMenuItem", let w = element(attr(el, kAXWindowAttribute)) {
        window = self.frame(w, primaryHeight: displays.primaryHeight)
      }
    } else if trusted, let app, let w = focusedWindowFrame(of: app, primaryHeight: displays.primaryHeight), w.contains(CGPoint(x: frame.midX, y: frame.midY)) {
      // Found by reading the screen's text: it is in the front window if its middle is.
      window = w
    }
    let within = window ?? PointMath.screenIndex(for: frame, in: displays.screens).map { displays.screens[$0] }
    if let within { out["place"] = PlaceMath.region(frame, in: within) }
    return out
  }

  private static func element(_ v: AnyObject?) -> AXUIElement? {
    guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
  }

  // MARK: a route's next stop, and what is under a point

  /// The windows on screen, front to back (global top-left points), as the window server lists them.
  static func windowsOnScreen() -> [PointMath.Win] {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    return list.compactMap { d in
      guard let pid = (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
            let number = (d[kCGWindowNumber as String] as? NSNumber)?.intValue,
            let b = d[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
      return PointMath.Win(pid: pid, number: number, bounds: bounds,
                           layer: (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                           alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    }
  }

  /// A route's next stop: the best match for `label` among what `parent` opens (a menu's items,
  /// a submenu's), counted only when it is really showing: a menu item must be inside an open
  /// menu (every item of a closed menu is in the tree too, with nowhere on screen).
  static func find(_ label: String, under parent: AXUIElement, app: String, displays: Displays) -> Hit? {
    guard trusted else { return nil }
    AXUIElementSetMessagingTimeout(parent, 0.4)
    let top = displays.primaryHeight
    let menus = windowsOnScreen().map { (layer: $0.layer, bounds: $0.bounds) }
    var best: (score: Int, hit: Hit)?
    var queue = (attr(parent, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    var head = 0
    let deadline = Date().addingTimeInterval(0.5)
    while head < queue.count, head < 800, Date() < deadline {
      let el = queue[head]
      head += 1
      if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids) }
      let role = string(el, kAXRoleAttribute)
      guard !containers.contains(role), role != "AXMenu" else { continue }
      var s = 0, name = ""
      for key in [kAXTitleAttribute, kAXDescriptionAttribute] {
        let text = string(el, key), v = score(text, label)
        if v > s { s = v; name = text }
      }
      guard s >= 45, s > (best?.score ?? 0), let f = frame(el, primaryHeight: top),
            let seen = PointMath.visiblePart(f, clips: [], screens: displays.screens) else { continue }
      if role == "AXMenuItem", !MenuMath.inOpenMenu(seen, windows: menus, primaryHeight: top) { continue }
      best = (s, Hit(frame: seen, label: name, role: role, app: app, element: el, score: s))
    }
    return best?.hit
  }

  /// What is under a point, for a light you dropped there: what it is called and what kind of
  /// thing it is, never what is in it or written on it.
  struct Under {
    /// Where it is (AppKit screen coordinates); null when it doesn't say.
    var frame = CGRect.null
    var label = ""
    var role = ""
    var app = ""
    var window = ""
    /// What its neighbours are called, nearest first (at most five).
    var near: [String] = []
    /// It is one of Echo's own windows: nothing to point at.
    var echo = false
  }

  /// What a thing is called: its own name, which is its title, its description, its placeholder
  /// or its help. Never its value and never the text inside it: for a label, a link, a cell or a
  /// row that is what is written on the page or in the message, not a name. With none of those
  /// it has no name, and only its role is told.
  private static func name(_ el: AXUIElement) -> String {
    let s = [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXHelpAttribute].map { string(el, $0) }.first { !$0.isEmpty } ?? ""
    return String(s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").prefix(80))
  }

  private static func isSecure(_ el: AXUIElement, role: String) -> Bool {
    role == "AXSecureTextField" || string(el, kAXSubroleAttribute) == "AXSecureTextField"
  }

  /// The thing under `point` (AppKit screen coordinates): its name, its role, its app and window,
  /// and up to five of its neighbours' names. Only those names are read: never a field's
  /// contents, and nothing at all of a password field but its role. `overlays`: Echo's own
  /// click-through windows, which are not "under" anything. Nil when there is nothing there (or
  /// it is in the Passwords app). Safe off the main thread.
  static func under(_ point: CGPoint, displays: Displays, overlays: Set<Int>) -> Under? {
    guard trusted else { return nil }
    let top = displays.primaryHeight, g = CGPoint(x: point.x, y: top - point.y)
    let me = ProcessInfo.processInfo.processIdentifier
    // Whose window is really there (never whatever of Echo's is drawn over it).
    let owner = PointMath.topWindowOwner(at: g, windows: windowsOnScreen(), skipping: overlays)
    if owner == me { return Under(echo: true) }
    var found: AXUIElement?
    for root in [owner.map { AXUIElementCreateApplication($0) }, AXUIElementCreateSystemWide()].compactMap({ $0 }) where found == nil {
      // The app whose window it is; the menu bar and the Dock belong to the system, so it is asked last.
      AXUIElementSetMessagingTimeout(root, 0.4)
      var el: AXUIElement?
      if AXUIElementCopyElementAtPosition(root, Float(g.x), Float(g.y), &el) == .success { found = el }
    }
    guard var el = found else { return nil }
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    if pid == me { return Under(echo: true) }
    let app = NSRunningApplication(processIdentifier: pid)
    if let app, MenuBar.offLimits(app) { return nil }
    var role = string(el, kAXRoleAttribute)
    var f = frame(el, primaryHeight: top)
    // Text or an icon: the button or the link it is written in.
    if ActMath.shouldClimb(role), let inner = f, let (c, cf, crole) = control(around: el, frame: inner, top: top) {
      el = c
      f = cf
      role = crole
    }
    var out = Under(frame: f ?? .null, role: role, app: app?.localizedName ?? "")
    // The window it is in.
    var up: AXUIElement? = el
    for _ in 0..<14 {
      guard let cur = up else { break }
      if string(cur, kAXRoleAttribute) == "AXWindow" { out.window = String(string(cur, kAXTitleAttribute).prefix(120)); break }
      up = attr(cur, kAXParentAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    }
    // A password field: its role and nothing else.
    if isSecure(el, role: role) { return out }
    out.label = name(el)
    if MenuBar.offLimitsLabel(out.label) { return nil }
    // Its neighbours' names, nearest first.
    if let parent = attr(el, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID(),
       let kids = attr(parent as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement] {
      var near: [(far: CGFloat, name: String)] = []
      for k in kids.prefix(40) where !CFEqual(k, el) {
        let r = string(k, kAXRoleAttribute)
        guard !isSecure(k, role: r) else { continue }
        let n = String(name(k).prefix(60))
        guard !n.isEmpty, n != out.label, !MenuBar.offLimitsLabel(n), !near.contains(where: { $0.name == n }) else { continue }
        let kf = frame(k, primaryHeight: top)
        near.append((kf.map { hypot($0.midX - point.x, $0.midY - point.y) } ?? .infinity, n))
      }
      out.near = near.sorted { $0.far < $1.far }.prefix(5).map(\.name)
    }
    return out
  }
}

// MARK: the look the pearl wears

/// Which body the pearl wears (Settings → Companion): always Glass, always Moon, or Auto: Moon
/// when the system's appearance is dark and Glass when it is light (CompanionMath.wear). The
/// screen is never looked at for this: nothing is captured for decoration.
enum CompanionLook {
  private(set) static var worn = "glass"

  /// The look to wear now.
  static func wear() -> String {
    let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    worn = CompanionMath.wear(Prefs.companionLook, systemDark: dark)
    return worn
  }
}

// MARK: the overlay: Echo's pearl, out pointing

/// The colours of the numbered marks drawn on a picture of the screen for the model (Screen.swift
/// annotate). Nothing you see on screen uses them.
enum Sunset {
  static let amber = NSColor(srgbRed: 1.0, green: 0.72, blue: 0.40, alpha: 1)
  static let coral = NSColor(srgbRed: 1.0, green: 0.47, blue: 0.38, alpha: 1)
}

/// The layer the pearl is drawn in while it is out: a square around it with room for its hop,
/// its halo, its rings and its finger, redrawn while it moves.
private final class PearlLayer: CALayer {
  let art = PearlArt()
  var now: CFTimeInterval = 0

  override func draw(in ctx: CGContext) {
    art.draw(in: ctx, at: CGPoint(x: bounds.midX, y: bounds.midY), now: now, pixelScale: contentsScale)
  }
}

/// The layer the firefly is drawn in: just big enough for the light, its trail and a burst, and
/// moved along with them.
private final class FireflyLayer: CALayer {
  let art = FireflyArt()
  var now: CFTimeInterval = 0

  override func draw(in ctx: CGContext) {
    ctx.translateBy(x: -frame.minX, y: -frame.minY)
    art.draw(in: ctx, now: now, pixelScale: contentsScale)
  }
}

/// The layer the caption beside the light is drawn in: its glass, with room for its shadow.
private final class BubbleLayer: CALayer {
  var text = ""
  var intent = "show"
  /// What it is about (overlay coordinates): the same words about the same thing are not shown twice.
  var around = CGRect.null
  /// Echo is saying these words now (the rim is lit); false once they are said.
  var live = true
  /// Where the light is, in this layer's own coordinates (a thread of light reaches for it).
  var toward: CGPoint?

  override func draw(in ctx: CGContext) {
    BubbleArt.draw(in: ctx, text, intent: intent, in: bounds.insetBy(dx: BubbleArt.room, dy: BubbleArt.room), pixelScale: contentsScale, live: live, toward: toward)
  }
}

/// The one small spot of Echo's overlay that takes the mouse: the light itself, while it can be
/// picked up. It works on the first click and never brings Echo forward.
private final class GrabView: NSView {
  weak var owner: PointerOverlay?
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { owner?.grabDown() }
  override func mouseDragged(with event: NSEvent) { owner?.grabMoved() }
  override func mouseUp(with event: NSEvent) { owner?.grabUp() }
}

/// How Echo shows you things on screen and what she does there. The pearl lives at the left end
/// of the island (Caption.swift). How it points is one small choice (`way`, PearlMath.ways):
///
/// "firefly" (the way it is): the pearl stays in the island and its light goes. The light leaves
/// from the pearl's rim (which dims while it is away), flies to the target in a gentle curve with
/// a short fading trail, and circles the target's edge twice, then rests at its corner, while the
/// target gets a thin white ring. It is small, and never sits on what it shows. White while Echo
/// shows you something; the answer's colours while she acts; its asking colour (the warm end of
/// the answer's gradient), hovering beside the thing, while she waits for your OK. In a lesson it waits on the step, breathing slowly, until the
/// lesson lets it go. Through menus it goes label by label as you open them. While Echo is still
/// looking for the thing it flies a slow figure of eight in the app's window. And you can pick it
/// up and drop it on something to say "this one" (see "waiting, searching and being picked up"
/// below; docs/firefly-protocol.md is what the server says and hears). A click is a quick dive to the exact
/// spot with a small burst and a ripple; a drag carries the light along with the thing; typing
/// hops the light along the text as it appears; a scroll rides it up and down beside the list.
/// The pearl's eyes follow its light the whole time, glance at your mouse once after showing
/// something ("see?"), and when the light is home the rim brightens and it gives a pleased blink.
///
/// "reach" (kept behind the same switch): the pearl goes itself, the way a living thing would:
/// its eyes go first, it crouches, hops over in an arc, lands with a squash and a wobble beside
/// the target, and reaches out a soft round finger to it; a click is a tap of the finger.
///
/// Either way it only shows; it never clicks. The overlay covers one screen, ignores the mouse
/// (all but the light's own small spot) and never takes focus. Motion runs on the display's clock (FrameClock). Reduced motion: no
/// travel (the light or the pearl fades out here and in there), no circling and no trail.
final class PointerOverlay {
  private var panel: NSPanel?
  private var screenFrame = CGRect.null
  private var lookToken = 0

  private var orb: PearlLayer?
  /// The firefly (in that way of pointing): the light, the flight it is on and what happens when
  /// that lands, when it got to what it is showing (it circles from then), where it is holding
  /// still instead (after a dive, a carry or a ride), and when it last rode a scroll or hopped
  /// for a typed character.
  private var fly: FireflyLayer?
  private var flight: PearlMath.Flight?
  private var afterFlight: (() -> Void)?
  private var arrivedAt: CFTimeInterval = -100
  private var holding: CGPoint?
  private var ridingAt: CFTimeInterval = -100
  private var typedAt: CFTimeInterval = -100
  /// The server is told when the light gets to what a request asked for, so Echo's words start
  /// as it lands (docs/firefly-protocol.md, section 5): the requests whose light is still on its
  /// way, the ones the light went out for, and the ones already told about.
  private var landing: [String] = []
  private var lights: [String] = []
  private var told: [String] = []
  /// This trip away from the pearl, for the timeline: when it left, and how many things it showed.
  private var tripStart: CFTimeInterval?
  private var tripStops = 0
  var onLight: (([String: Any]) -> Void)?
  /// How it shows what it is pointing at now (PearlMath.show): how many times round, and how
  /// long before it may leave.
  private var showLaps = PearlMath.laps
  private var showFor = 0.7
  /// Did the point land (PearlMath.Landed)? When the light last went round again because your
  /// mouse went elsewhere, and the caption it shows then (the last one said).
  private var landed = PearlMath.Landed()
  private var nudgedAt: CFTimeInterval = -100
  private var lastCaption: (words: String, light: CGPoint, around: CGRect, avoiding: [CGRect])?
  /// When the light last came to rest (nil while it is on the move): its wander starts from here.
  private var restingSince: CFTimeInterval?
  /// A small gesture of the light under way: a nod (a step worked), a shake (it didn't), a spiral (the job is done).
  private var gesture: (kind: String, at: CFTimeInterval)?
  private var lastStepOk = false
  private var noddedAt: CFTimeInterval = -100
  /// Curious: since when your pointer has been resting near the light, and whether it has peeked for this visit.
  private var nearSince: CFTimeInterval?
  private var peeked = false
  /// The second light of "this and this", and the ring round its thing.
  private var twinLight: CALayer?
  /// The line that marks where you had read to, after a page scroll (seam).
  private var seamLine: CAShapeLayer?
  private var twinRing: CAShapeLayer?
  /// Echo is resting (its name only): a light that is out is dimmer and slower.
  var sleepy = false
  /// The numbered dots a route leaves at the stops it has shown (cleared when the route is over).
  private var stones: [CALayer] = []

  /// Why the light is out ("show", "act" or "ask"): its colour.
  private var intent = "show"
  /// What it is waiting on (a lesson step, a risky step's card) and which finds are running.
  private var hold = PearlMath.Hold()
  /// Let go: when it leaves (a beat after a step passed, so the burst is seen).
  private var leaveAt: CFTimeInterval?
  /// The app's own find is taking a while: the light searches the app's window meanwhile.
  private var search: (id: String, intent: String, target: String, window: CGRect?, centre: CGPoint, since: CFTimeInterval, shown: Bool)?
  /// A route through menus being walked, stop by stop.
  private let walker = RouteWalker()
  /// You picking the light up: the small panel that takes the mouse, where the light rested
  /// before, what is under it now (and the soft ring round that), and the Escape watch.
  private var grab = PearlMath.Grab()
  private var grabPanel: NSPanel?
  private var heldBefore: CGPoint?
  private var under: AXFinder.Under?
  private var underRing: CAShapeLayer?
  private var probing = false
  private var probedAt: CFTimeInterval = -100
  private var escapeWatch: [Any] = []
  private var grabEndedAt: CFTimeInterval = -100
  /// The light is in your hand (or was until a moment ago): your mouse is moving Echo's own
  /// light, which is not taking over from her (Driver.swift).
  var inHand: Bool { grab.active || CACurrentMediaTime() - grabEndedAt < 0.4 }
  private var canFind = false
  /// You dropped the light on something: what to tell Echo's server (POST /api/computer/pointed).
  var onPointed: (([String: Any]) -> Void)?

  /// How it shows things: "firefly" (the default) or "reach". Not in Settings: the page can send
  /// `pointingWay` with its prefs, or `defaults write <Echo's id> PointingWay reach`.
  static var way: String {
    get { PearlMath.way(UserDefaults.standard.string(forKey: "PointingWay")) }
    set { UserDefaults.standard.set(PearlMath.way(newValue), forKey: "PointingWay") }
  }
  private var firefly: Bool { Self.way == "firefly" }
  /// The target's ring, replaced on every point.
  private var marks: [CALayer] = []
  /// The caption beside the light: what this step is, for a moment (BubbleMath, BubbleArt).
  private var bubble: BubbleLayer?
  private var outline: CAShapeLayer?
  /// What the ring is around (overlay coordinates), so pointing at it again keeps it lit.
  private var outlined = CGRect.null

  /// hidden: in the island (which draws it). out: beside a target. home: gliding back to the island.
  private enum Mode { case hidden, home, out }
  private var mode = Mode.hidden
  /// Where the pearl is, how fast it's settling and where it's hopping (overlay coordinates, y up).
  private var position = CGPoint.zero
  private var velocity = CGVector.zero
  private var hop: PearlMath.Hop?
  /// The hop under way has crouched, and has left the ground.
  private var crouched = false, leapt = false
  /// When it last landed beside a target, and whether its finger has gone out since.
  private var landedAt: CFTimeInterval = -100
  private var reached = false
  private var goal = CGPoint.zero
  /// What it is showing (overlay coordinates): its finger and its eyes go to it.
  private var showing = CGRect.null
  /// What Echo is about to do there ("click", "drag", "scroll", "type_text"…; "" for "look here"),
  /// and where a drag ends.
  private var acting = ""
  private var dragTo: CGRect?
  private var ticking = false
  private var lastTick: CFTimeInterval = 0
  /// How often the light is drawn: every frame while it moves, a few a second while it rests.
  private var pace = PearlMath.Pace()
  private var drawn = CGPoint(x: -1, y: -1)

  /// The last point: a "look here" (pinned: stays while Echo talks about it) or a computer-use
  /// step; when it was, whether the click is still to come, and when the step finished.
  private var pinned = true
  private var pointedAt: CFTimeInterval = -100
  private var actionPending = false
  private var finishedAt: CFTimeInterval?

  /// Echo is typing: where the caret is (overlay coordinates; nil when the app doesn't say, then
  /// the pearl stays by the field) and the field. The pearl stands by the caret and taps along while
  /// a soft white caret and a glint on each new character show the words going in.
  private var typing: (caret: CGRect?, field: CGRect?)?
  private var caretGlow: CALayer?
  private var lastGlint: CFTimeInterval = 0
  private var glints = 0

  /// Echo's voice: idle | listening | thinking | speaking (from the page).
  private(set) var voice = "idle"
  /// When the voice state last went idle (a job is over once it has stayed idle a moment).
  private var idleSince: CFTimeInterval = 0
  private var level: (Double, CFTimeInterval)?

  private(set) var size = Prefs.orbSize
  private(set) var look = CompanionMath.look(Prefs.companionLook)
  /// The pearl's width out here, and the square it fills.
  private var diameter: CGFloat { CompanionMath.diameter(size) }
  private var chip: CGSize { CGSize(width: diameter, height: diameter) }

  private func makePanel(_ frame: CGRect) -> NSPanel {
    let p = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.ignoresMouseEvents = true // clicks go straight through: the pointer never clicks anything
    // The mark floats just above the island it leaves from (the island is at .statusBar), which
    // also lets it reach the menu bar items it points at; menus, system alerts and the screen
    // saver stay above it (except while it points into an open menu: setLevel).
    p.level = Self.restingLevel
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.animationBehavior = .none
    let view = NSView(frame: NSRect(origin: .zero, size: frame.size))
    view.wantsLayer = true
    p.contentView = view
    return p
  }

  private static let restingLevel = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)

  /// Above open menus only while the pearl points at something inside one (it sat under the menu,
  /// out of sight); back under them for everything else, and when it goes home.
  private func setLevel(pointingAt target: CGRect?) {
    var inMenu = false
    if let target, let primary = NSScreen.screens.first?.frame.height {
      let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
      let windows: [(layer: Int, bounds: CGRect)] = list.compactMap { w in
        guard let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue, let b = w[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: b) else { return nil }
        return (layer, bounds)
      }
      inMenu = MenuMath.inOpenMenu(target, windows: windows, primaryHeight: primary)
    }
    let level = inMenu ? NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue + 1) : Self.restingLevel
    if panel?.level != level { panel?.level = level }
  }

  // MARK: settings and voice

  /// Settings → Screen → Companion: the size of the pearl out pointing (small, medium or large)
  /// and its look (auto, glass or moon), here and in the island.
  func setStyle(size: String?, look: String?) {
    let s = CompanionMath.size(size), l = CompanionMath.look(look)
    if l != self.look {
      self.look = l
      orb?.art.skin = CompanionLook.wear()
      CaptionBar.shared.lookChanged()
      wake()
    }
    guard s != self.size else { return }
    self.size = s
    if let layer = panel?.contentView?.layer { buildOrb(in: layer) }
    wake()
  }

  /// A moment from the page: "proud" (a lesson step passed), "celebrate" (a lesson finished),
  /// "surprised" (you talked over Echo) or "sorry" (something failed, or a sentence was lost).
  /// The pearl in the island plays it, and this one if it's out.
  func moment(_ name: String) {
    CaptionBar.shared.moment(name)
    // Echo's own yes or no, said while its light is out: the light nods or shakes with it.
    if name == "yes" || name == "no" {
      guard firefly, mode == .out, flight == nil, gesture == nil, !Motion.reduced else { return }
      gesture = (name == "yes" ? "nod" : "shake", CACurrentMediaTime())
      return startTicking()
    }
    guard let orb, mode != .hidden, !firefly else { return }
    let now = CACurrentMediaTime()
    switch name {
    case "proud": orb.art.proud(now: now)
    case "celebrate": orb.art.celebrate(now: now)
    case "surprised": orb.art.surprised(now: now)
    case "sorry": orb.art.miss(now: now)
    default: return
    }
    startTicking()
  }

  /// What Echo's voice is doing, so the pearl can listen, think or answer along, here and in the
  /// island (and come home to the island when she listens or speaks).
  func setVoice(_ state: String, level: Double? = nil) {
    let next = ["idle", "listening", "thinking", "speaking"].contains(state) ? state : "idle"
    if next == "idle", voice != "idle" { idleSince = CACurrentMediaTime() }
    DrawLight.shared.voice(was: voice, now: next)
    voice = next
    orb?.art.voice = voice
    CaptionBar.shared.setVoice(voice)
    if let level { setLevel(level) }
    if voice != "idle" || (level ?? 0) > 0.01 { wake() }
  }

  /// The voice level (0…1), from the page or the native mic.
  func setLevel(_ v: Double) {
    let now = CACurrentMediaTime()
    level = (v, now)
    orb?.art.setLevel(v, now: now)
    CaptionBar.shared.setVoice(voice, level: v)
  }

  // MARK: the island

  /// The island appeared. It draws the pearl itself; if this one is out at a target, the one in
  /// the island waits faintly until it's back (the firefly's pearl never leaves).
  func dock() {
    CaptionBar.shared.setMarkAway(mode == .out && !firefly)
  }

  /// The screens changed: an overlay on a screen that's gone (or resized) is dropped.
  func screensChanged() {
    guard panel != nil, !NSScreen.screens.contains(where: { $0.frame == screenFrame }) else { return }
    hide(animated: false)
  }

  /// The island is going: a mark gliding home to it fades with it.
  func undock() {
    if mode == .home { hide(animated: true) }
  }

  /// Computer use is over (done, stopped, taken over): home to the island if it's up, else away.
  func release() {
    stopTyping()
    actionPending = false
    // A risky step's light waits no longer: the run it belonged to is over. A lesson's step
    // keeps its light (a lesson is not a run, and runs end while lessons go on).
    if hold.drop(asksOnly: true) {
      intent = "show"
      fly?.art.intent = intent
      CaptionBar.shared.setLightNeeds(false)
    }
    guard !hold.waiting else { return }
    finishedAt = finishedAt ?? CACurrentMediaTime()
    fadeOutline(after: 0)
    CaptionBar.shared.setDoing(nil)
    // The job is over and its last step worked: the light winds upward once, throws its sparks, then goes home.
    if firefly, mode == .out, lastStepOk, !Motion.reduced, CaptionBar.shared.dock() != nil, flight == nil {
      let now = CACurrentMediaTime()
      lastStepOk = false
      gesture = ("spiral", now)
      leaveAt = now + PearlMath.gestureLasts("spiral") + 0.25
      startTicking()
      return
    }
    if mode == .out, CaptionBar.shared.dock() != nil { goHome() } else if mode == .out { hide(animated: true) }
  }

  // MARK: pointing

  /// Send the pearl to `target` (AppKit screen coordinates) and ring it. `pinned` ("look here")
  /// keeps it there while Echo talks about it; a computer-use step (false) comes home when she
  /// speaks or listens again. `action` is what Echo is about to do there ("click", "drag",
  /// "scroll", "type_text"…), and `dragTo` where a drag ends. `caption` is what the small caption
  /// beside the light says once it is there ("Clicking Send"; empty: "This one"; a waiting
  /// lesson step says "Your turn" and a step that asks says "Is this OK?" whatever it is).
  /// `intent` is the light's colour
  /// ("show", "act" or "ask": asking, it hovers beside the thing). `stepId`: a lesson step the
  /// light waits on until the lesson lets it go (the same step again is the same wait; any other
  /// point ends the wait before it). `walking`: this is a stop on a route through menus
  /// (`passing`: not the last, so it rests there with a lighter ring instead of circling).
  /// `request`: the server's request this point answers; the server is told when the light lands.
  /// Returns the screen it pointed on, or nil (and points nowhere) when `target` isn't a real
  /// spot on a screen: it never falls back to some default place.
  @discardableResult
  func point(at target: CGRect, label: String, caption: String = "", pinned: Bool = true, role: String = "", action: String = "", dragTo: CGRect? = nil,
             intent: String? = nil, stepId: String? = nil, request: String? = nil, walking: Bool = false, passing: Bool = false, words sentence: String = "") -> NSScreen? {
    let screens = NSScreen.screens
    guard PointMath.usable(target), let i = PointMath.screenIndex(for: target, in: screens.map(\.frame)) else { return nil }
    let screen = screens[i]
    // A lesson step that was let go while this was still being looked for (the lesson stopped,
    // moved on or got new steps): nobody waits on it and nobody would let the light go again,
    // so it was found, and is not shown.
    if hold.refuses(step: stepId) { return screen }
    // The overlay covers the target's screen; clip the target to it.
    let target = target.intersection(screen.frame)
    let wasHidden = mode == .hidden || panel == nil
    let fresh = ensurePanel(on: screen) || wasHidden
    guard let layer = panel?.contentView?.layer, let orb else { return nil }
    let turning = mode == .home
    // A route's stops stay marked behind the light, numbered; anything else starts clean.
    if !walking { clearStones() }
    clearTwin()
    // Found: the search is over, and a new errand takes the light out of your hand.
    let roaming = search?.shown == true || grab.state == .dragging
    if !walking { walker.stop() }
    search = nil
    endGrab()
    leaveAt = nil
    canFind = AXFinder.trusted
    let why = PearlMath.intent(intent ?? (pinned ? "show" : "act")), asks = firefly && why == "ask"
    let wasAsking = firefly && self.intent == "ask"
    self.intent = why
    let sameWait = stepId != nil && stepId == hold.id
    hold.take(step: stepId)
    CaptionBar.shared.setLightNeeds(asks)
    setLevel(pointingAt: target)
    let origin = screen.frame.origin
    let local = target.offsetBy(dx: -origin.x, dy: -origin.y)
    let bounds = CGRect(origin: .zero, size: screen.frame.size)
    let reduce = Motion.reduced
    let avoid = CaptionBar.shared.frameOnScreen.map { [$0.offsetBy(dx: -origin.x, dy: -origin.y).insetBy(dx: -6, dy: -6)] } ?? []
    // Firefly: its light goes to the thing's edge (asking, it hovers beside it and never touches
    // it). Reach: the pearl stands off a corner, a finger's length away.
    let dest = asks ? PearlMath.hover(beside: local, in: bounds)
      : firefly ? PearlMath.orbit(local, laps: 0) : PearlMath.stand(beside: local, diameter: diameter, in: bounds, avoiding: avoid)
    let now = CACurrentMediaTime()
    // Already there (found, then acted on; or the same step again), unless it has to move
    // between the thing's edge and beside it.
    let again = !fresh && !roaming && showing == local && mode == .out && asks == wasAsking
    showing = local
    acting = action
    self.dragTo = dragTo.map { $0.offsetBy(dx: -origin.x, dy: -origin.y) }
    let box = local.insetBy(dx: -4, dy: -4)
    // The same target again (found, then acted on): the ring stays lit rather than blinking.
    let same = outline != nil && !fresh && abs(outlined.minX - box.minX) < 2 && abs(outlined.minY - box.minY) < 2
      && abs(outlined.width - box.width) < 2 && abs(outlined.height - box.height) < 2
    if !same {
      marks.forEach { $0.removeFromSuperlayer() }
      marks = []
      outline = nil
    }
    self.pinned = pinned
    pointedAt = now
    finishedAt = nil
    if pinned { actionPending = false }

    if fresh {
      // It leaves the island when that's on this screen; else it rises in where the mouse is
      // (kept on this screen). Then it hops over.
      let start = leaveFrom(screen, toward: CGPoint(x: target.midX, y: target.midY))
      position = reduce ? dest : CGPoint(x: start.x - origin.x, y: start.y - origin.y)
      velocity = .zero
      appear()
    }
    let far = hypot(dest.x - position.x, dest.y - position.y)
    if !fresh && reduce && far > 1 { swap(to: dest) }
    mode = .out
    orb.art.working = !pinned
    goal = dest
    if firefly || reduce || far < 2 {
      hop = nil
    } else {
      // Its eyes go there first, then the crouch and the hop (none of that again when it is
      // already in the air). The finger comes in for the trip and reaches out after it lands.
      let airborne = hop.map { now >= $0.leaves } ?? false
      hop = PearlMath.Hop(from: position, to: dest, at: now, radius: diameter / 2, airborne: airborne)
      crouched = airborne
      leapt = airborne
      reached = false
      orb.art.pointGoal = 0
    }
    if firefly {
      fly?.art.intent = why
      if !again {
        // The pearl's eyes go there first; then its light. (Reduced motion: it is simply there.)
        holding = nil
        afterFlight = nil
        flight = reduce ? nil : PearlMath.Flight(from: position, to: dest, at: now + (fresh ? 0.14 : 0))
        if reduce { position = dest; arrivedAt = now; fly?.art.move(to: dest, now: now, jump: true) }
        if fresh { fly?.art.move(to: position, now: now, jump: true) }
        // Asking, it stays beside the thing. A stop on the way through menus: it rests at the
        // corner (the circling is for the thing it came to show).
        if asks { holding = dest; arrivedAt = now }
        if passing {
          if reduce { arrivedAt = now - 60 } else { afterFlight = { [weak self] in self?.arrivedAt = CACurrentMediaTime() - 60 } }
        }
      } else if sameWait {
        // "Show me again" on the step it is already waiting on: once more round it.
        arrivedAt = now
      }
      CaptionBar.shared.setLight(screenPoint(dest))
      // A small or crowded thing is shown for longer (only pointing; a step Echo does dives in at once).
      let how = PearlMath.show(local, rivals: AXFinder.rivals(beside: target))
      showLaps = how.laps
      showFor = pinned ? how.seconds : 0.7
      if !again {
        landed = PearlMath.Landed()
        nudgedAt = -100
        landing = []
      }
      // The server hears that the light left the pearl, and when it lands (now, if it is
      // already there): Echo says "this one" as it arrives, never before.
      if let request, !request.isEmpty {
        lights = Array((lights.filter { $0 != request } + [request]).suffix(8))
        // Each take-off is told, with how long the flight will take (so the words can be asked
        // for early enough to be heard as it lands) and where from: the pearl, the last thing
        // it showed, or turning round on its way home.
        if let f = flight, !reduce {
          let from = fresh ? "pearl" : turning ? "turned" : "target"
          onLight?(["type": "departed", "id": request, "ms": Int(((f.lands - now) * 1000).rounded()), "from": from])
        }
        if fresh || tripStart == nil { tripStart = now; tripStops = 0 }
        if !again { tripStops += 1 }
        if flight != nil { landing.append(request) } else { lightArrived([request], ms: 0) }
      }
    } else if hop == nil, far >= 2 || fresh {
      landedAt = now
      reached = false
    }
    // When it gets there.
    let arrive = hop.map { $0.lands - now } ?? flight.map { $0.lands - now } ?? (reduce && far > 1 ? 0.16 : 0)

    // A thin white ring on the target (the pearl stands beside it): faint as the pearl comes
    // near, full as it lands.
    if !same { outlineTarget(box, arrive: arrive, in: layer, role: role, light: passing) }

    // What it's doing goes in the island's line, and in a few words beside the light once it
    // is there (the reaching pearl stands where the light would be: the caption clears it too).
    if CaptionBar.shared.showing {
      if !label.isEmpty { CaptionBar.shared.setDoing(pinned ? "Pointing at “\(label)”" : label) }
      CaptionBar.shared.setMarkAway(!firefly)
    }
    // A sentence of Echo's about the thing it is only showing (an explanation's part) goes in the
    // bubble whole, and stays for as long as the light does; anything else is the short caption.
    let long = pinned && !asks && stepId == nil && !sentence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let words = long ? BubbleMath.sentence(sentence) : BubbleMath.phrase(caption: caption, moment: asks ? .asking : stepId != nil ? .waiting : .step)
    let body = firefly ? local : local.union(CGRect(x: dest.x - diameter / 2, y: dest.y - diameter / 2, width: diameter, height: diameter))
    say(words, light: dest, around: body, after: arrive, on: screen, avoiding: avoid, stays: long)
    syncAsk()
    if walking, firefly { addStone(at: dest, in: layer, scale: screen.backingScaleFactor) }

    panel?.orderFrontRegardless()
    startTicking()
    return screen
  }

  /// Was the light sent out for this request (so the server will hear when it lands)? The
  /// request's answer says so (`light`), and the server holds Echo's words for it.
  func lit(_ request: String) -> Bool { lights.contains(request) }

  /// The light is on what these requests asked for: the server is told, once each. `ms`: how
  /// long the flight took. With reduced motion there was no flight (`still`).
  private func lightArrived(_ requests: [String], ms: Int) {
    for id in requests where !told.contains(id) {
      told = Array((told + [id]).suffix(16))
      var body: [String: Any] = ["type": "arrived", "id": id, "ms": ms]
      if Motion.reduced { body["still"] = true }
      onLight?(body)
    }
  }

  /// Where it sets out from on `screen` (screen coordinates): the island's pearl when that is on
  /// this screen (the light from its rim, on the side facing `p`); else where the mouse is, kept
  /// on this screen.
  private func leaveFrom(_ screen: NSScreen, toward p: CGPoint) -> CGPoint {
    var start = NSEvent.mouseLocation
    if let d = CaptionBar.shared.dock(), d.screen == screen.frame {
      // The light leaves from the pearl's rim, on the side facing where it is going.
      start = firefly ? PearlMath.rim(of: d.point, radius: PillMath.mark / 2, toward: p) : d.point
    } else if !screen.frame.contains(start) {
      start = CGPoint(x: screen.frame.midX, y: screen.frame.maxY - 60)
    }
    return start
  }

  private func outlineTarget(_ box: CGRect, arrive: Double, in layer: CALayer, role: String = "", light: Bool = false) {
    // The ring follows the control's own shape (TouchMath.corner), 4 pt outside it. White with a
    // soft dark edge, so it shows on a light page and a dark one. `light`: a stop on the way
    // through menus gets a finer, fainter one.
    let corner = role.isEmpty ? min(10, box.height / 2) : TouchMath.corner(role: role, frame: box.insetBy(dx: 4, dy: 4)) + 4
    let ring = CAShapeLayer()
    ring.path = CGPath(roundedRect: box, cornerWidth: corner, cornerHeight: corner, transform: nil)
    ring.fillColor = RGB.white.cg(light ? 0.03 : 0.06)
    ring.strokeColor = RGB.white.cg(light ? 0.7 : 0.95)
    ring.lineWidth = light ? 1 : 1.5
    ring.shadowColor = CGColor(gray: 0, alpha: 1)
    ring.shadowRadius = 4
    ring.shadowOpacity = 0.55
    ring.shadowOffset = .zero
    ring.opacity = 1
    layer.insertSublayer(ring, at: 0)
    marks.append(ring)
    outline = ring
    let lightUp = CAKeyframeAnimation(keyPath: "opacity")
    let total = arrive + 0.18
    lightUp.values = [0, 0, 0.45, 1]
    lightUp.keyTimes = [0, NSNumber(value: arrive * 0.5 / total), NSNumber(value: arrive / total), 1]
    lightUp.duration = total
    lightUp.timingFunction = CAMediaTimingFunction(controlPoints: 0.45, 0.05, 0.55, 0.95)
    ring.add(lightUp, forKey: "in")
    outlined = box
  }

  /// Echo is about to act at `target`. The firefly: once the light is there and has shown the
  /// thing for a moment, it dives to the exact spot with a small burst and a ripple (a click, or
  /// the start of a drag, which it then carries across), or rides up and down beside the list (a
  /// scroll). Reach: the finger taps, or the pearl nods. Returns how long to wait before acting,
  /// so the click lands as the light touches down (or with the tap's push).
  @discardableResult
  func aboutToAct(at target: CGRect) -> TimeInterval {
    guard panel != nil, let orb else { return 0.5 }
    actionPending = true
    let now = CACurrentMediaTime(), reduce = Motion.reduced
    let quiet = ["type_text", "clear_field", "press_keys", "hover"].contains(acting)
    let action = acting, to = dragTo
    if firefly {
      // She acts now, whatever colour it came in.
      intent = "act"
      fly?.art.intent = intent
      CaptionBar.shared.setLightNeeds(false)
      // There, and a third of a second of circling so you see what it means; then the dive.
      let dive = PearlMath.Flight(from: .zero, to: .zero, at: 0, quick: true).duration
      let pulseIn = reduce ? 0.05 : max(0.12, (flight?.lands ?? arrivedAt) + 0.35 - now)
      DispatchQueue.main.asyncAfter(deadline: .now() + pulseIn) { [weak self] in
        guard let self, self.orb === orb, self.mode == .out, !self.showing.isNull, !quiet else { return }
        let now = CACurrentMediaTime(), r = self.showing
        if action == "scroll" {
          // Beside the list (inside its right edge when there is no room outside it).
          let x = r.maxX + 10 < self.screenFrame.width - 6 ? r.maxX + 10 : r.maxX - 12
          self.fly(to: CGPoint(x: x, y: r.midY), now: now) { [weak self] in self?.ridingAt = CACurrentMediaTime() }
        } else {
          self.fly(to: CGPoint(x: r.midX, y: r.midY), now: now, quick: true) { [weak self] in
            guard let self else { return }
            self.fly?.art.burst(now: CACurrentMediaTime())
            self.pingRing()
            // A drag: it has hold of the thing, and carries it across. Else it goes back to the edge.
            DispatchQueue.main.asyncAfter(deadline: .now() + (action == "drag" ? 0.1 : 0.32)) { [weak self] in
              guard let self, self.mode == .out, self.flight == nil, self.holding != nil else { return }
              let now = CACurrentMediaTime()
              if action == "drag", let to {
                self.showing = to
                self.fly(to: CGPoint(x: to.midX, y: to.midY), now: now)
              } else {
                self.fly(to: PearlMath.orbit(self.showing, laps: 0), now: now) { [weak self] in
                  // Back at its corner, resting: it has already shown this.
                  self?.holding = nil
                  self?.arrivedAt = CACurrentMediaTime() - 60
                }
              }
            }
          }
        }
        self.startTicking()
      }
      return min(1.3, max(0.5, pulseIn + (reduce ? 0.1 : dive) + 0.02))
    }
    // When the finger is out: a little after it lands (PearlMath.Hop), or now if it already is.
    let ready = max(0, (hop?.lands ?? landedAt) + Self.reachAfter + 0.2 - now)
    let pulseIn = reduce ? 0.05 : ready + 0.12
    DispatchQueue.main.asyncAfter(deadline: .now() + pulseIn) { [weak self] in
      guard let self, self.orb === orb else { return }
      let now = CACurrentMediaTime()
      if action == "scroll" { orb.art.nod(now: now) } else if !quiet { orb.art.pulse(now: now) }
      // A drag: it takes hold with that tap, then carries the thing across.
      if action == "drag", let to { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.carry(to: to) } }
      self.startTicking()
      if action != "scroll", !quiet { self.pingRing() }
    }
    return min(1.3, max(0.5, pulseIn + PearlMath.tapPush + 0.03))
  }

  /// The firefly flies from where it is to `p` (a quick straight dive, or a gentle curve), holds
  /// there, and then `then` happens. Reduced motion: it is simply there.
  private func fly(to p: CGPoint, now: CFTimeInterval, quick: Bool = false, then: (() -> Void)? = nil) {
    holding = p
    if Motion.reduced {
      position = p
      flight = nil
      afterFlight = nil
      then?()
    } else {
      flight = PearlMath.Flight(from: position, to: p, at: now, quick: quick)
      afterFlight = then
    }
    startTicking()
  }

  /// The ring round the target pings: one soft ripple outward.
  private func pingRing() {
    guard let ring = outline, !Motion.reduced, let path = ring.path else { return }
    // The ring's path is in the overlay's coordinates: the ping gets its own frame to scale about.
    let box = path.boundingBoxOfPath
    var shift = CGAffineTransform(translationX: -box.minX, y: -box.minY)
    let ping = CAShapeLayer()
    ping.frame = box
    ping.path = path.copy(using: &shift)
    ping.fillColor = nil
    ping.strokeColor = ring.strokeColor
    ping.lineWidth = 1.5
    ping.opacity = 0
    ring.superlayer?.insertSublayer(ping, above: ring)
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 1
    grow.toValue = 1 + min(0.35, 24 / max(box.width, box.height))
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0.9
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [grow, fade]
    group.duration = 0.55
    group.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
    ping.add(group, forKey: "ping")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { ping.removeFromSuperlayer() }
  }

  /// How long after landing the finger starts to reach out.
  private static let reachAfter = 0.12

  /// Reach, a drag under way: what it is showing moves to `to` (overlay coordinates), and the
  /// pearl goes along, still holding on.
  private func carry(to: CGRect) {
    guard mode == .out, !showing.isNull, panel != nil else { return }
    let dx = to.midX - showing.midX, dy = to.midY - showing.midY
    showing = to
    let bounds = CGRect(origin: .zero, size: screenFrame.size).insetBy(dx: diameter, dy: diameter)
    goal = CGPoint(x: min(max(goal.x + dx, bounds.minX), bounds.maxX), y: min(max(goal.y + dy, bounds.minY), bounds.maxY))
    startTicking()
  }

  /// The step is over: a pleased blink when it worked; eyes down and a soft shake of the head
  /// when it didn't (no red alarms). The ring fades soon after, and a moment later the pearl
  /// hops home to the island (unless the next step calls it somewhere first).
  func finished(ok: Bool) {
    actionPending = false
    guard panel != nil, let orb else { return }
    let now = CACurrentMediaTime()
    finishedAt = now
    lastStepOk = ok
    // The light itself says how it went: two quick dips for yes, a small side-to-side for no.
    // (A nod only now and then, so a long job doesn't bob all the way through; a shake every time.)
    if firefly, mode == .out, !Motion.reduced, !ok || now - noddedAt >= PearlMath.nodEvery {
      gesture = (ok ? "nod" : "shake", now)
      if ok { noddedAt = now }
    }
    if ok {
      orb.art.done(now: now)
      // A light tap on a Force Touch trackpad: done.
      NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .now)
    } else {
      orb.art.miss(now: now, lasts: 1.6)
    }
    // The pearl in the island is the one you see when its light does the pointing: a step that
    // failed shows there (its pleased blink comes when the light is home).
    if firefly, !ok { CaptionBar.shared.moment("sorry") }
    startTicking()
    fadeOutline(after: ok ? 0.2 : 0.6)
    let at = pointedAt
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
      if self?.pointedAt == at { CaptionBar.shared.setDoing(nil) }
    }
  }

  // MARK: typing

  /// Echo starts typing at `caret` (the insertion point, AppKit screen coordinates; nil when the
  /// app can't say) in `field`: the pearl stands beside the caret with its finger on it and taps
  /// along, and the caret gets a soft glow. Reduced motion never gets here (typing is instant then).
  func startTyping(caret: CGRect?, field: CGRect?) {
    guard panel != nil, mode == .out else { return }
    typing = (caret.map(toLocal), field.map(toLocal))
    if let c = typing?.caret { showCaret(c) }
    retargetForTyping()
  }

  /// Characters just went in; the caret is now at `caret` (nil: it didn't say). A small glint
  /// where they landed (at most one every 45 ms), the pearl taps, and it and the glowing caret
  /// move along.
  func typed(caret: CGRect?) {
    guard var t = typing, let layer = panel?.contentView?.layer, let orb else { return }
    orb.art.tap()
    typedAt = CACurrentMediaTime()
    if let c = caret.map(toLocal) {
      t.caret = c
      typing = t
      showCaret(c)
      retargetForTyping()
    }
    let now = CACurrentMediaTime()
    guard now - lastGlint > 0.045, glints < 8 else { return }
    lastGlint = now
    // Where the new character is: just left of the caret; with no caret, just under the pearl.
    let spot: CGPoint
    var h: CGFloat = 12
    if let c = t.caret {
      spot = CGPoint(x: c.maxX - 3, y: c.midY)
      h = min(24, max(10, c.height * 0.8))
    } else {
      spot = CGPoint(x: position.x - chip.width * 0.6, y: position.y - chip.height * 0.8)
    }
    let glint = CAGradientLayer()
    glint.type = .radial
    glint.colors = [RGB.white.cg(0.95), RGB.white.cg(0.45), RGB.white.cg(0)]
    glint.locations = [0, 0.35, 1]
    glint.startPoint = CGPoint(x: 0.5, y: 0.5)
    glint.endPoint = CGPoint(x: 1, y: 1)
    glint.bounds = CGRect(x: 0, y: 0, width: h * 0.8, height: h)
    glint.position = spot
    glint.opacity = 0
    glint.contentsScale = panel?.backingScaleFactor ?? 2
    layer.addSublayer(glint)
    glints += 1
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = [0, 0.85, 0]
    fade.keyTimes = [0, 0.2, 1]
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 0.6
    grow.toValue = 1.3
    let rise = CABasicAnimation(keyPath: "transform.translation.y")
    rise.fromValue = 0
    rise.toValue = 3
    let group = CAAnimationGroup()
    group.animations = [fade, grow, rise]
    group.duration = 0.42
    group.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
    glint.add(group, forKey: "glint")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
      glint.removeFromSuperlayer()
      self?.glints -= 1
    }
  }

  /// Done typing: the glowing caret fades and the pearl settles back beside the field. When the
  /// text went in (`landed`), one soft band of light passes over the line just typed.
  func stopTyping(landed: Bool = false) {
    guard let t = typing else { return }
    typing = nil
    if landed && !Motion.reduced, let span = TypingMath.shimmerSpan(caret: t.caret, field: t.field) { sweepTyped(span) }
    if let c = caretGlow {
      caretGlow = nil
      let f = CABasicAnimation(keyPath: "opacity")
      f.fromValue = c.presentation()?.opacity ?? c.opacity
      f.toValue = 0
      f.duration = 0.25
      c.opacity = 0
      c.add(f, forKey: "out")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { c.removeFromSuperlayer() }
    }
    startTicking()
  }

  /// The finishing shimmer: a soft white band glides once along `span` (the typed line) and is
  /// gone in under a second. Drawn on Echo's own overlay, never in the field.
  private func sweepTyped(_ span: CGRect) {
    guard let layer = panel?.contentView?.layer else { return }
    let holder = CALayer()
    holder.frame = span
    holder.cornerRadius = min(6, span.height / 3)
    holder.masksToBounds = true
    holder.contentsScale = panel?.backingScaleFactor ?? 2
    let band = CAGradientLayer()
    band.colors = [RGB.white.cg(0), RGB.white.cg(0.42), RGB.white.cg(0.18), RGB.white.cg(0)]
    band.locations = [0, 0.45, 0.6, 1]
    band.startPoint = CGPoint(x: 0, y: 0.5)
    band.endPoint = CGPoint(x: 1, y: 0.5)
    let w = max(28, span.height * 1.6)
    band.bounds = CGRect(x: 0, y: 0, width: w, height: span.height)
    band.position = CGPoint(x: -w, y: span.height / 2)
    holder.addSublayer(band)
    layer.addSublayer(holder)
    let move = CABasicAnimation(keyPath: "position.x")
    move.fromValue = -w / 2
    move.toValue = span.width + w / 2
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = [0, 1, 1, 0]
    fade.keyTimes = [0, 0.15, 0.75, 1]
    let group = CAAnimationGroup()
    group.animations = [move, fade]
    group.duration = TypingMath.shimmerDuration(width: span.width)
    group.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0, 0.2, 1)
    band.add(group, forKey: "sweep")
    DispatchQueue.main.asyncAfter(deadline: .now() + group.duration + 0.05) { holder.removeFromSuperlayer() }
  }

  private func toLocal(_ r: CGRect) -> CGRect { r.offsetBy(dx: -screenFrame.minX, dy: -screenFrame.minY) }

  /// Where the pearl stands while typing: off the caret's top-right corner with its finger on
  /// it (else the field's), on screen. The firefly's light sits on the caret.
  private func retargetForTyping() {
    guard let t = typing, let at = t.caret ?? t.field else { return }
    let bounds = CGRect(origin: .zero, size: screenFrame.size)
    showing = at
    // The light sits just past the caret (at the start of a field that doesn't say where it is).
    goal = firefly ? CGPoint(x: t.caret.map { $0.maxX + 3 } ?? at.minX + 10, y: at.midY) : PearlMath.stand(beside: at, diameter: diameter, in: bounds)
    hop?.to = goal
    if firefly, flight == nil, holding == nil || hypot(position.x - goal.x, position.y - goal.y) > 40 {
      fly(to: goal, now: CACurrentMediaTime())
    } else if firefly {
      flight?.to = goal
      holding = goal
    }
    startTicking()
  }

  /// A soft glowing caret over the real one: white, breathing gently rather than blinking.
  private func showCaret(_ c: CGRect) {
    guard let layer = panel?.contentView?.layer else { return }
    let h = min(28, max(12, c.height))
    let frame = CGRect(x: c.maxX - 1, y: c.midY - h / 2, width: 2, height: h)
    if let g = caretGlow {
      CATransaction.begin()
      CATransaction.setAnimationDuration(0.08)
      g.frame = frame
      CATransaction.commit()
      return
    }
    let g = CALayer()
    g.frame = frame
    g.cornerRadius = 1
    g.backgroundColor = RGB.white.cg()
    g.shadowColor = CGColor(gray: 0, alpha: 1)
    g.shadowRadius = 3
    g.shadowOpacity = 0.6
    g.shadowOffset = .zero
    g.contentsScale = panel?.backingScaleFactor ?? 2
    layer.addSublayer(g)
    caretGlow = g
    guard !Motion.reduced else { return }
    let breathe = CABasicAnimation(keyPath: "opacity")
    breathe.fromValue = 1
    breathe.toValue = 0.5
    breathe.duration = 0.55
    breathe.autoreverses = true
    breathe.repeatCount = .infinity
    breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    g.add(breathe, forKey: "breathe")
  }

  // MARK: drawing the pearl

  /// The overlay on `screen`, made if needed. True when it's new (the pearl has only just appeared).
  private func ensurePanel(on screen: NSScreen) -> Bool {
    if let p = panel, screenFrame == screen.frame {
      p.alphaValue = 1
      return false
    }
    if let old = panel { retire(old) } // another screen: it fades there and appears here
    let p = makePanel(screen.frame)
    panel = p
    screenFrame = screen.frame
    if let layer = p.contentView?.layer { buildOrb(in: layer, scale: screen.backingScaleFactor) }
    p.orderFrontRegardless()
    startTicking()
    return true
  }

  private func buildOrb(in root: CALayer, scale: CGFloat? = nil) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    let old = orb
    old?.removeFromSuperlayer()
    let px = scale ?? panel?.screen?.backingScaleFactor ?? 2
    let orb = PearlLayer()
    orb.art.diameter = diameter
    orb.art.out = true
    orb.art.skin = CompanionLook.worn
    orb.art.voice = voice
    orb.art.reduced = Motion.reduced
    orb.art.lively = Prefs.orbEyes
    orb.art.working = old?.art.working ?? (mode == .out && !pinned)
    if let old { orb.art.pointGoal = old.art.pointGoal; orb.art.aimGoal = old.art.aimGoal }
    if let (v, t) = level { orb.art.setLevel(v, now: t) }
    let side = ceil(orb.art.reach * 2)
    orb.bounds = CGRect(x: 0, y: 0, width: side, height: side)
    orb.position = position
    orb.contentsScale = px
    orb.needsDisplayOnBoundsChange = true
    orb.actions = ["position": NSNull(), "contents": NSNull(), "bounds": NSNull()]
    root.addSublayer(orb)
    self.orb = orb
    drawn = CGPoint(x: -1, y: -1)
    buildLight(in: root, scale: px)
  }

  /// The firefly's layer (only in that way of pointing, where the pearl itself stays in the
  /// island, so the one here is hidden).
  private func buildLight(in root: CALayer, scale px: CGFloat) {
    fly?.removeFromSuperlayer()
    fly = nil
    orb?.isHidden = firefly
    guard firefly else { return }
    let l = FireflyLayer()
    l.contentsScale = px
    l.actions = ["position": NSNull(), "contents": NSNull(), "bounds": NSNull(), "frame": NSNull()]
    l.art.move(to: position, now: CACurrentMediaTime(), jump: true)
    l.art.intent = intent
    root.addSublayer(l)
    fly = l
  }

  private func screenPoint(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x + screenFrame.minX, y: p.y + screenFrame.minY) }

  /// Appears: fades in and grows from 0.6 on a soft spring (320 ms), or just fades (reduced motion).
  private func appear() {
    guard let orb, !firefly else { return }
    let reduce = Motion.reduced
    orb.opacity = 1
    let fadeIn = CABasicAnimation(keyPath: "opacity")
    fadeIn.fromValue = 0
    fadeIn.toValue = 1
    fadeIn.duration = reduce ? 0.15 : 0.32
    orb.add(fadeIn, forKey: "appear")
    guard !reduce else { return }
    let grow = CASpringAnimation(keyPath: "transform.scale")
    grow.fromValue = 0.6
    grow.toValue = 1
    grow.damping = 16
    grow.stiffness = 320
    grow.duration = grow.settlingDuration
    orb.add(grow, forKey: "grow")
  }

  /// Reduced motion: no travel. Fades out here, and in there (150 ms each).
  private func swap(to dest: CGPoint) {
    guard let orb else { return }
    let s = CAKeyframeAnimation(keyPath: "opacity")
    s.values = [1, 0, 0, 1]
    s.keyTimes = [0, 0.45, 0.55, 1]
    s.duration = 0.33
    orb.add(s, forKey: "swap")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in
      guard let self, self.hop == nil else { return }
      self.position = dest
      self.velocity = .zero
    }
  }

  /// Another screen took over: this overlay fades out and goes.
  private func retire(_ p: NSPanel) {
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = 0.2
      p.animator().alphaValue = 0
    }, completionHandler: { p.close() })
  }

  private func fadeOutline(after delay: Double) {
    guard let ring = outline else { return }
    outline = nil
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = ring.presentation()?.opacity ?? ring.opacity
    fade.toValue = 0
    fade.beginTime = CACurrentMediaTime() + delay
    fade.duration = 0.3
    fade.fillMode = .backwards
    ring.opacity = 0
    ring.add(fade, forKey: "out")
    for m in marks where m !== ring {
      let f = CABasicAnimation(keyPath: "opacity")
      f.fromValue = m.presentation()?.opacity ?? m.opacity
      f.toValue = 0
      f.duration = 0.25
      m.opacity = 0
      m.add(f, forKey: "out")
    }
  }

  /// A small piece of the island's glass for words beside the pearl: near-black, a white hairline,
  /// a soft shadow.
  private func glassBubble(_ string: String, font: NSFont, width: CGFloat, height: CGFloat, scale: CGFloat) -> CALayer {
    let text = CATextLayer()
    text.string = string
    text.font = font
    text.fontSize = font.pointSize
    text.foregroundColor = MarkArt.ink.cg()
    text.contentsScale = scale
    text.alignmentMode = .center
    let line = ceil(font.ascender - font.descender)
    text.frame = CGRect(x: 0, y: ((height - line) / 2).rounded(), width: width, height: line)
    let bubble = CALayer()
    bubble.bounds = CGRect(x: 0, y: 0, width: width, height: height)
    bubble.anchorPoint = .zero
    bubble.backgroundColor = MarkArt.glass.cg(0.9)
    bubble.cornerRadius = min(11, height / 2)
    bubble.borderColor = RGB.white.cg(MarkArt.hairline)
    bubble.borderWidth = 1
    bubble.shadowColor = CGColor(gray: 0, alpha: 1)
    bubble.shadowOpacity = 0.4
    bubble.shadowRadius = 12
    bubble.shadowOffset = CGSize(width: 0, height: -6)
    bubble.addSublayer(text)
    return bubble
  }

  /// The caption beside the light: `words`, shown once the light is there (`delay`), for long
  /// enough to read, then gone (BubbleMath). On the side of the `light` away from what it is
  /// showing (`around`, overlay coordinates), on the screen, clear of the menu bar, the Dock and
  /// the island. New words take the place of the old at once; the same words about the same
  /// thing (a step found, then done) are not shown twice. It is part of the overlay, so the
  /// mouse goes straight through it. Off in Settings → Companion: it says nothing. While the
  /// light waits for you ("Your turn", "Is this OK?") it does not fade by itself: it is there
  /// for as long as the light waits, and goes when the light is let go.
  private func say(_ words: String, light: CGPoint, around: CGRect, after delay: Double, on screen: NSScreen, avoiding: [CGRect] = [], stays: Bool = false) {
    guard Prefs.stepCaptions, !words.isEmpty, let root = panel?.contentView?.layer else { return hush(fade: false) }
    lastCaption = (words, light, around, avoiding)
    if let b = bubble, b.text == words, b.around == around {
      b.intent = intent
      b.setNeedsDisplay()
      return
    }
    hush(fade: false)
    let size = BubbleArt.size(words), origin = screen.frame.origin
    let at = BubbleMath.origin(target: around, light: light, size: size,
                               bounds: screen.visibleFrame.offsetBy(dx: -origin.x, dy: -origin.y), avoiding: avoiding)
    let b = BubbleLayer()
    b.text = words
    b.intent = intent
    b.around = around
    b.contentsScale = screen.backingScaleFactor
    b.actions = ["opacity": NSNull(), "contents": NSNull()]
    b.frame = CGRect(origin: at, size: size).insetBy(dx: -BubbleArt.room, dy: -BubbleArt.room)
    b.toward = CGPoint(x: light.x - b.frame.minX, y: light.y - b.frame.minY)
    b.opacity = 0
    b.setNeedsDisplay()
    root.addSublayer(b)
    bubble = b
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, delay)) { [weak self, weak b] in
      guard let self, let b, self.bubble === b else { return }
      b.opacity = 1
      if !Motion.reduced { self.fade(b, from: 0, to: 1, over: BubbleMath.fadeIn) }
      DispatchQueue.main.asyncAfter(deadline: .now() + (stays ? BubbleMath.speaks(words) : BubbleMath.hold(words))) { [weak self, weak b] in
        // Still waiting for you: the caption stays (PearlMath.captionStays).
        guard let self, let b, self.bubble === b, !PearlMath.captionStays(waiting: self.hold.waiting, intent: self.intent) else { return }
        // A sentence about the thing stays with the light; said, its rim goes quiet.
        if stays { b.live = false; b.setNeedsDisplay(); return }
        self.hush()
      }
    }
  }

  /// Two lights: "this and this". A second, smaller light leaves the first and settles on the
  /// other thing, which gets its own ring. Both go when the light moves on or goes home.
  func twin(at frame: CGRect) {
    guard firefly, mode == .out, let layer = panel?.contentView?.layer, PointMath.usable(frame) else { return }
    clearTwin()
    let r = frame.offsetBy(dx: -screenFrame.minX, dy: -screenFrame.minY).insetBy(dx: -4, dy: -4)
    let ring = CAShapeLayer()
    ring.path = CGPath(roundedRect: r, cornerWidth: min(10, r.height / 2), cornerHeight: min(10, r.height / 2), transform: nil)
    ring.fillColor = RGB.white.cg(0.05)
    ring.strokeColor = RGB.white.cg(0.9)
    ring.lineWidth = 1.5
    ring.shadowColor = CGColor(gray: 0, alpha: 1)
    ring.shadowRadius = 4
    ring.shadowOpacity = 0.5
    ring.shadowOffset = .zero
    layer.insertSublayer(ring, at: 0)
    twinRing = ring
    let dot = CALayer()
    dot.bounds = CGRect(x: 0, y: 0, width: 8, height: 8)
    dot.cornerRadius = 4
    dot.backgroundColor = NSColor.white.cgColor
    dot.shadowColor = MarkArt.answer[2].cg()
    dot.shadowOpacity = 1
    dot.shadowRadius = 8
    dot.shadowOffset = .zero
    let to = PearlMath.orbit(frame.offsetBy(dx: -screenFrame.minX, dy: -screenFrame.minY), laps: 0)
    dot.position = to
    layer.addSublayer(dot)
    twinLight = dot
    if !Motion.reduced {
      let fly = CABasicAnimation(keyPath: "position")
      fly.fromValue = NSValue(point: position)
      fly.toValue = NSValue(point: to)
      fly.duration = 0.45
      fly.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0.1, 0.2, 1)
      dot.add(fly, forKey: "out")
      let appear = CABasicAnimation(keyPath: "opacity")
      appear.fromValue = 0
      appear.toValue = 1
      appear.duration = 0.45
      ring.add(appear, forKey: "in")
      // At rest it bobs a little, out of step with the first.
      let bob = CABasicAnimation(keyPath: "position.y")
      bob.byValue = 2
      bob.duration = 1.3
      bob.autoreverses = true
      bob.repeatCount = .infinity
      bob.beginTime = CACurrentMediaTime() + 0.5
      bob.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      dot.add(bob, forKey: "bob")
    }
  }

  private func clearTwin() {
    twinLight?.removeFromSuperlayer()
    twinRing?.removeFromSuperlayer()
    twinLight = nil
    twinRing = nil
  }

  /// Your eye's place: after a page was scrolled, a dashed line across the scroll area at the last
  /// line you had already seen (`y`, screen coordinates), for a couple of seconds. Only while the
  /// overlay is up on that screen; it lets every click through like the rest of it.
  func seam(across area: CGRect, y: CGFloat) {
    guard mode != .hidden, let layer = panel?.contentView?.layer, screenFrame.intersects(area), y > area.minY + 8, y < area.maxY - 8 else { return }
    seamLine?.removeFromSuperlayer()
    let line = CAShapeLayer()
    let path = CGMutablePath()
    path.move(to: CGPoint(x: area.minX - screenFrame.minX + 6, y: y - screenFrame.minY))
    path.addLine(to: CGPoint(x: area.maxX - screenFrame.minX - 6, y: y - screenFrame.minY))
    line.path = path
    line.strokeColor = RGB(hex: 0xFFF0D6).cg(0.9)
    line.lineWidth = 1.5
    line.lineDashPattern = [6, 5]
    line.shadowColor = RGB(hex: 0xFFF0D6).cg()
    line.shadowOpacity = 0.5
    line.shadowRadius = 5
    line.shadowOffset = .zero
    layer.addSublayer(line)
    seamLine = line
    if !Motion.reduced {
      let fade = CAKeyframeAnimation(keyPath: "opacity")
      fade.values = [0, 1, 1, 0]
      fade.keyTimes = [0, 0.08, 0.75, 1]
      fade.duration = ScrollMath.seamLasts
      line.add(fade, forKey: "seam")
    }
    line.opacity = 0
    DispatchQueue.main.asyncAfter(deadline: .now() + ScrollMath.seamLasts) { [weak self, weak line] in
      line?.removeFromSuperlayer()
      if self?.seamLine === line { self?.seamLine = nil }
    }
  }

  /// Stepping stones: a small numbered mark where the light stopped on a route, so the path it
  /// showed stays visible (dark glass with a quiet hairline, like a bubble that has been said).
  private func addStone(at p: CGPoint, in layer: CALayer, scale: CGFloat) {
    guard !Motion.reduced || stones.count < 6 else { return }
    if let last = stones.last, hypot(last.position.x - p.x, last.position.y - p.y) < 6 { return }
    let n = stones.count + 1
    let chip = CALayer()
    chip.bounds = CGRect(x: 0, y: 0, width: 16, height: 16)
    chip.position = CGPoint(x: p.x - 12, y: p.y + 12)
    chip.cornerRadius = 8
    chip.backgroundColor = MarkArt.glass.cg(0.88)
    chip.borderColor = RGB.white.cg(0.2)
    chip.borderWidth = 1
    chip.actions = ["opacity": NSNull(), "position": NSNull()]
    let text = CATextLayer()
    text.string = "\(n)"
    text.font = NSFont.systemFont(ofSize: 9.5, weight: .semibold)
    text.fontSize = 9.5
    text.alignmentMode = .center
    text.foregroundColor = RGB.white.cg(0.92)
    text.contentsScale = scale
    text.frame = CGRect(x: 0, y: 1.5, width: 16, height: 12)
    chip.addSublayer(text)
    layer.addSublayer(chip)
    stones.append(chip)
  }

  private func clearStones() {
    stones.forEach { $0.removeFromSuperlayer() }
    stones = []
  }

  /// Asking at the thing: while the light waits for your yes on a risky step and the island has
  /// the question, the same question with its two buttons stands beside the thing (AskBubble), in
  /// place of the plain "Is this OK?". Gone as soon as it is answered or the light moves on.
  func syncAsk() {
    guard firefly, mode == .out, intent == "ask", let ask = CaptionBar.shared.ask, let c = lastCaption, let screen = panel?.screen else {
      return AskBubble.shared.hide()
    }
    let size = AskBubble.size(question: ask.question, action: ask.action, cancel: ask.cancel), origin = screen.frame.origin
    let at = BubbleMath.origin(target: c.around, light: c.light, size: size,
                               bounds: screen.visibleFrame.offsetBy(dx: -origin.x, dy: -origin.y), avoiding: c.avoiding)
    hush(fade: false)
    AskBubble.shared.show(question: ask.question, action: ask.action, cancel: ask.cancel, origin: CGPoint(x: at.x + origin.x, y: at.y + origin.y))
  }

  /// The caption goes: faded out over a quarter of a second, or at once (new words are taking
  /// its place, or motion is reduced).
  func hush(fade fades: Bool = true) {
    guard let b = bubble else { return }
    bubble = nil
    guard fades, !Motion.reduced, b.opacity > 0 else { return b.removeFromSuperlayer() }
    b.opacity = 0
    fade(b, from: 1, to: 0, over: BubbleMath.fadeOut)
    DispatchQueue.main.asyncAfter(deadline: .now() + BubbleMath.fadeOut) { b.removeFromSuperlayer() }
  }

  private func fade(_ layer: CALayer, from: Float, to: Float, over seconds: Double) {
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = layer.presentation()?.opacity ?? from
    a.toValue = to
    a.duration = seconds
    layer.add(a, forKey: "fade")
  }

  // MARK: motion

  private func local(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x - screenFrame.minX, y: p.y - screenFrame.minY) }

  /// The trip away from the pearl is over: the server hears how long it was out, how many things
  /// it showed, why it went back, and whether Echo was still in the middle of a job.
  private func tripOver(_ why: String) {
    guard let t = tripStart else { return }
    tripStart = nil
    onLight?(["type": "home", "ms": Int(((CACurrentMediaTime() - t) * 1000).rounded()), "stops": tripStops, "why": why,
              "working": CaptionBar.shared.progress.working && voice != "idle"])
  }

  /// Back to the island: the finger comes in, then one more hop, landing on its place even
  /// while the island is still sliding, where it hands over to the one drawn there (which gives a
  /// happy blink). With the island on another screen it just fades.
  private func goHome(why: String = "over") {
    stopTyping()
    hush()
    AskBubble.shared.hide()
    clearStones()
    clearTwin()
    gesture = nil
    // The trip is over: how long it was out, how many things it showed, and whether Echo was
    // still in the middle of a job (then it will have to come all the way out again).
    tripOver(why)
    guard let d = CaptionBar.shared.dock() else { return hide(animated: true) }
    // Waiting for your yes: what "yes" means stays lit. Otherwise the work is done and no square is left behind.
    let keepOutline = !pinned && finishedAt == nil && actionPending
    if !keepOutline { fadeOutline(after: 0) }
    if !keepOutline || pinned { CaptionBar.shared.setDoing(nil) }
    guard d.screen == screenFrame, !Motion.reduced else { return hide(animated: true) }
    if !keepOutline { setLevel(pointingAt: nil) } // a ring still lit inside a menu stays above it
    mode = .home
    landing = []
    orb?.art.working = false
    orb?.art.pointGoal = 0
    showing = .null
    // Whatever it was doing out there is over: nothing waits, searches or can be picked up.
    walker.stop()
    endGrab()
    search = nil
    leaveAt = nil
    _ = hold.drop()
    CaptionBar.shared.setLightNeeds(false)
    placeGrab(at: .zero, takes: false)
    if firefly {
      // Its light flies back to the side of the pearl's rim it comes in from.
      holding = nil
      fly(to: PearlMath.rim(of: local(d.point), radius: PillMath.mark / 2, toward: position), now: CACurrentMediaTime()) { [weak self] in self?.land() }
      holding = nil
      return
    }
    // 160 ms for the finger to come in; then the eyes, the crouch and the hop.
    hop = PearlMath.Hop(from: position, to: local(d.point), at: CACurrentMediaTime() + 0.16, radius: diameter / 2)
    crouched = false
    leapt = false
  }

  private func startTicking() {
    guard !ticking else { return }
    ticking = true
    lastTick = CACurrentMediaTime()
    FrameClock.shared.add(self) { [weak self] now in self?.tick(now) }
  }

  private func stopTicking() {
    ticking = false
    FrameClock.shared.remove(self)
  }

  /// One frame: through the hop (or settling beside the target), its finger and its eyes,
  /// stepping aside for the mouse, deciding when to go home, and a redraw when something changed.
  private func tick(_ now: CFTimeInterval) {
    guard let orb, mode != .hidden else { return stopTicking() }
    // A light at rest (waiting on a lesson step, for as long as that takes) is not worth a
    // picture every frame: it only breathes and bobs.
    if firefly, !pace.due(now: now, last: lastTick, moving: lightMoving(now)) { return }
    let dt = min(0.05, max(0, now - lastTick))
    lastTick = now
    let reduce = Motion.reduced
    let art = orb.art
    art.reduced = reduce
    art.lively = Prefs.orbEyes
    let dock = CaptionBar.shared.dock()
    let mouse = local(NSEvent.mouseLocation)

    switch mode {
    case .home:
      // Landing on the island's pearl, wherever the island has got to; then it's the island's again.
      guard let d = dock, d.screen == screenFrame else { return hide(animated: true) }
      if firefly {
        // The island may still be sliding: the light lands on the rim where it is now.
        guard flight != nil else { return land() }
        let from = flight?.from ?? position
        flight?.to = PearlMath.rim(of: local(d.point), radius: PillMath.mark / 2, toward: from)
        if !flyOn(now) { return }
      } else {
        guard var h = hop else { return hide(animated: true) }
        h.to = local(d.point)
        hop = h
        fly(h, now: now, art: art)
        if hop == nil { return land() }
      }
      // It looks where it is going.
      art.target = PearlMath.gaze(from: position, to: local(d.point))
    case .out:
      if firefly {
        if grab.state == .dragging {
          // In your hand: it rides on the tip of the arrow (just off it, so the arrow never hides it).
          position = CGPoint(x: mouse.x - 5, y: mouse.y + 5)
          probe(now)
        } else if flight != nil {
          if !flyOn(now) { return }
        } else if typing != nil {
          // Typing: it keeps up with the caret.
          (position, velocity) = CompanionMath.spring(position, velocity, to: goal, dt: dt, response: 0.12)
        } else if let s = search, s.shown {
          // Still looking: a slow figure of eight in the app's window.
          position = reduce ? s.centre : PearlMath.search(around: s.centre, elapsed: now - s.since)
        } else if let h = holding {
          position = h
        } else if !showing.isNull {
          // Showing: twice round the thing's edge, then it rests at the corner.
          // (And once more, slowly, when your mouse went somewhere else: see `nudge`.)
          let slow = PearlMath.lap(showing) * PearlMath.Landed.slow
          let laps = reduce ? showLaps : now - nudgedAt < slow ? (now - nudgedAt) / slow : min(showLaps, (now - arrivedAt) / PearlMath.lap(showing))
          position = PearlMath.orbit(showing, laps: laps)
        }
      } else if let h = hop {
        fly(h, now: now, art: art)
      } else {
        (position, velocity) = CompanionMath.spring(position, velocity, to: goal, dt: dt, response: typing != nil ? 0.18 : 0.25)
        // Carrying something across: it leans into the way it is going.
        art.sway = reduce ? 0 : min(max(velocity.dx / 2400, -0.16), 0.16)
      }
      // Landed: a beat, then the finger reaches out to what it is showing, with a little spring.
      if hop == nil, !showing.isNull {
        art.aimGoal = PearlMath.aim(from: position, at: showing)
        if !reached, now - landedAt >= Self.reachAfter {
          reached = true
          art.kick(-1.4)
        }
        if reached { art.pointGoal = showing.contains(position) ? 0.6 : 1 }
      }
      // Its eyes: on what it is showing (from before it leaves the ground); a glance back at you
      // ("see?") a moment after showing it, and again once the step is over.
      let seen = now - landedAt
      let atYou = hop == nil && ((pinned && seen > 0.9 && seen < 1.4) || finishedAt != nil)
      art.target = showing.isNull || atYou ? PearlMath.gaze(from: position, to: mouse)
                                           : PearlMath.gaze(from: position, to: PearlMath.touch(showing.insetBy(dx: 2, dy: 2), from: position))
      let since = now - pointedAt
      if let l = leaveAt, now >= l, flight == nil, !grab.active {
        // Let go by the lesson (or the card): it leaves now, and its ring goes with it.
        leaveAt = nil
        finishedAt = finishedAt ?? now
        goHome(why: "let_go")
        if mode == .hidden { return }
      } else if hold.waiting || grab.active || search?.shown == true || leaveAt != nil {
        // Waiting for you, in your hand or still searching: it stays, however long that takes.
      } else if hop == nil, flight == nil, now - (firefly ? arrivedAt : landedAt) > (firefly ? showFor : 0.7),
         // Never from mid-air, nor the moment it has landed (it shows the thing first: longer
         // when it is small or has look-alikes beside it).
         CompanionMath.shouldReturnHome(pinned: pinned, voice: voice, actionPending: actionPending, sincePoint: since,
                                        sinceFinished: finishedAt.map { now - $0 }, pillShowing: dock != nil,
                                        working: CaptionBar.shared.progress.working, idleFor: voice == "idle" ? now - idleSince : 0) {
        goHome(why: CompanionMath.homeReason(sinceFinished: finishedAt.map { now - $0 }))
        if mode == .hidden { return }
      } else if dock == nil, !actionPending, !art.busy(now: now), since > 6.5, voice == "idle" || since > 30 {
        // No island to go home to: it fades a while after the last thing it showed.
        return hide(animated: true)
      }
    case .hidden:
      return
    }

    if firefly, let fly {
      // The light as it is this frame: a hop for each typed character, a ride for a scroll, a
      // slow bob while it rests. Only its own small layer is redrawn.
      var shown = position
      let inHand = grab.state == .dragging, looking = search?.shown == true
      if !reduce, !inHand {
        shown.y += PearlMath.typeHop(elapsed: now - typedAt) + PearlMath.ride(elapsed: now - ridingAt, height: showing.isNull ? 0 : showing.height)
        // At rest it is never quite still: it wanders round its place and flits now and then
        // (PearlMath.restDrift); asking, it hovers. Circling what it shows, it only bobs.
        if flight == nil, typing == nil, !looking {
          if mode == .out, gesture == nil, !lightMoving(now) {
            if restingSince == nil { restingSince = now }
            let rested = now - (restingSince ?? now)
            // While Echo thinks it traces a slow figure of eight; else it wanders and flits. Your
            // pointer coming near, it leans toward it. Resting (its name only), it is slower.
            let d = voice == "thinking" && intent != "ask" ? PearlMath.thinkingEight(elapsed: rested)
              : PearlMath.restDrift(elapsed: sleepy ? rested * 0.45 : rested, asking: intent == "ask")
            let lean = intent == "ask" ? CGPoint.zero : PearlMath.lean(toward: mouse, from: position)
            // Your pointer has come near and stopped: one small loop, once per visit.
            if lean != .zero {
              if nearSince == nil { nearSince = now }
              if !peeked, now - (nearSince ?? now) >= PearlMath.peekAfter { peeked = true; gesture = ("peek", now) }
            } else {
              nearSince = nil
              peeked = false
            }
            shown.x += d.x + lean.x
            shown.y += d.y + lean.y
          } else if gesture != nil {
            restingSince = nil
          } else {
            restingSince = nil
            shown.y += 1.2 * CGFloat(sin(now * 2.6))
          }
        } else {
          restingSince = nil
        }
        // A nod, a shake or the spiral plays over wherever it is; the spiral ends in a burst.
        if let g = gesture {
          if let o = PearlMath.gesture(g.kind, elapsed: now - g.at) {
            shown.x += o.x
            shown.y += o.y
          } else {
            if g.kind == "spiral" { fly.art.move(to: shown, now: now); fly.art.burst(now: now) }
            gesture = nil
          }
        }
      }
      // Waiting on a lesson step: a slow breath (reduced motion: a still, soft halo).
      let waits = mode == .out && hold.waiting && !hold.asking && flight == nil && !inHand
      // Waiting for your yes: its halo beats twice and rests ("I need you").
      let asksNow = mode == .out && intent == "ask" && flight == nil && !inHand
      fly.art.breath = waits ? (reduce ? 0.4 : PearlMath.breath(now - arrivedAt)) : asksNow && !reduce ? 0.85 * PearlMath.heartbeat(elapsed: now - arrivedAt) : 0
      // A long flight is a comet: a longer tail and a little dust.
      if let f = flight { fly.art.comet = hypot(f.to.x - f.from.x, f.to.y - f.from.y) >= PearlMath.cometFrom && mode == .out } else if !fly.art.moving(now: now) { fly.art.comet = false }
      fly.art.fade = sleepy && mode == .out && flight == nil ? 0.6 : 1
      // Your mouse on it while it rests: it can be picked up (and only that small spot takes the mouse).
      let takes = grab.active || (holdable && PearlMath.grabbable(mouse, light: shown, target: showing, holdable: true))
      fly.art.hot = takes
      fly.art.searching = looking && flight == nil
      placeGrab(at: shown, takes: takes)
      fly.art.reduced = reduce
      fly.art.move(to: shown, now: now)
      fly.art.step(now: now, dt: dt)
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      fly.frame = fly.art.bounds
      fly.now = now
      fly.setNeedsDisplay()
      CATransaction.commit()
      // The pearl in the island watches its light: where it is going before it leaves, then the
      // light itself; and once, after it has shown the thing, a glance at you ("see?").
      let shownFor = now - arrivedAt - showLaps * (showing.isNull ? 0 : PearlMath.lap(showing))
      let seeYou = mode == .out && pinned && flight == nil && shownFor > 0.15 && shownFor < 0.75
      let ahead = flight.flatMap { now < $0.start ? $0.to : nil }
      CaptionBar.shared.setLight(screenPoint(ahead ?? shown), seeYou: seeYou)
      // Did it land? Once the pearl has glanced at your pointer, your mouse is watched: if it
      // goes and rests somewhere else, the light shows the thing again (only while it is
      // pointing something out or waiting for you, never mid-step).
      let watchable = mode == .out && (pinned || hold.waiting) && !hold.asking && flight == nil && holding == nil && !inHand && !looking
        && typing == nil && !showing.isNull && leaveAt == nil
      if !watchable {
        if landed.watching { landed = PearlMath.Landed() }
      } else if !landed.watching {
        if shownFor > 0.75 { landed.begin(mouse: mouse, now: now) }
      } else if landed.look(mouse: mouse, target: showing, now: now, held: hold.waiting) {
        nudge(now)
      }
      return
    }

    // Parked right where you're working with the mouse: it fades and slides 16 pt out of the way.
    let md = hypot(mouse.x - position.x, mouse.y - position.y)
    let awayGoal: CGFloat = mode == .out && hop == nil && md < 48 ? 1 : 0
    away += (awayGoal - away) * CGFloat(1 - exp(-dt / 0.12))
    if abs(away - awayGoal) < 0.005 { away = awayGoal }
    var shown = position
    if away > 0.01 && md > 0.1 {
      shown.x += (position.x - mouse.x) / md * 16 * away
      shown.y += (position.y - mouse.y) / md * 16 * away
    }
    let fade = 1 - 0.75 * away
    let redraw = art.moving || art.fade != fade
    art.fade = fade
    art.step(now: now, dt: dt)
    guard redraw || art.moving || shown != drawn else { return }
    drawn = shown
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    orb.position = shown
    orb.now = now
    orb.setNeedsDisplay()
    CATransaction.commit()
  }

  /// Is the light on the move: flying, going home, circling what it shows, searching, in your
  /// hand, about to leave, keeping up with typing or riding a scroll? Else it is at rest.
  private func lightMoving(_ now: CFTimeInterval) -> Bool {
    if mode != .out || grab.active || flight != nil || typing != nil || search?.shown == true || leaveAt != nil || gesture != nil { return true }
    if now - typedAt < 0.2 || now - ridingAt < 1.3 { return true }
    let circling = holding == nil && !showing.isNull && !Motion.reduced
      && (now - arrivedAt < showLaps * PearlMath.lap(showing) || now - nudgedAt < PearlMath.lap(showing) * PearlMath.Landed.slow)
    return circling
  }

  /// Your mouse went somewhere else after Echo showed you the thing: the light goes round it
  /// once more, slowly, and its caption comes back (reduced motion: the caption only).
  private func nudge(_ now: CFTimeInterval) {
    nudgedAt = now
    pointedAt = now // it is pointing again: it stays as long as it would after a point
    if let c = lastCaption, let screen = NSScreen.screens.first(where: { $0.frame == screenFrame }) {
      say(c.words, light: c.light, around: c.around, after: 0, on: screen, avoiding: c.avoiding)
    }
  }

  /// One frame of a hop: the crouch, the leap, along the arc leaning into it, and the landing
  /// (a squash, a wobble and a blink).
  private func fly(_ h: PearlMath.Hop, now: CFTimeInterval, art: PearlArt) {
    if !crouched, h.crouching(at: now) { crouched = true; art.crouch() }
    if !leapt, now >= h.leaves { leapt = true; art.kick(-3.2) }
    position = h.position(at: now)
    art.sway = h.tilt(at: now)
    guard h.done(at: now) else { return }
    hop = nil
    velocity = .zero
    art.sway = 0
    art.land()
    landedAt = now
    reached = false
  }

  /// One frame of the firefly's flight. When it lands, what was waiting for that happens. False
  /// when that put the overlay away.
  private func flyOn(_ now: CFTimeInterval) -> Bool {
    guard let f = flight else { return true }
    position = f.position(at: now)
    guard f.done(at: now) else { return true }
    flight = nil
    velocity = .zero
    if holding == nil { arrivedAt = now }
    // It is there: the server may start Echo's words for the step.
    if mode == .out, !landing.isEmpty {
      lightArrived(landing, ms: Int((f.duration * 1000).rounded()))
      landing = []
    }
    let then = afterFlight
    afterFlight = nil
    then?()
    return mode != .hidden
  }

  /// Home: it is the island's pearl again, which gives a happy blink (and, when it was its
  /// light that came home, its rim brightens with a soft pulse: CaptionBar.setLight(nil)).
  private func land() {
    let light = firefly
    hide(animated: true, quick: true)
    if !light { CaptionBar.shared.moment("landed") }
  }

  /// How far it has stepped aside for the mouse (0…1).
  private var away: CGFloat = 0

  /// Something changed (her voice, the island moving, a new target): make sure the clock is running.
  func wake() {
    guard mode != .hidden, !ticking else { return }
    startTicking()
  }

  /// A shortcut Echo pressed, as key caps floating by the pearl for a moment ("⌘ Z").
  func showKeys(_ combo: String) {
    guard let layer = panel?.contentView?.layer, mode != .hidden else { return }
    let caps = TouchMath.glyphs(combo)
    guard !caps.isEmpty else { return }
    let string = caps.joined(separator: " ")
    let width = max(34, CGFloat(string.count) * 9 + 18)
    let bubble = glassBubble(string, font: PillArt.font(13, .semibold), width: width, height: 24, scale: panel?.backingScaleFactor ?? 2)
    bubble.position = CGPoint(x: position.x - width / 2, y: position.y + chip.height / 2 + 8)
    layer.addSublayer(bubble)
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = [0, 1, 1, 0]
    fade.keyTimes = [0, 0.15, 0.75, 1]
    fade.duration = Motion.reduced ? 0.8 : 0.9
    bubble.opacity = 0
    bubble.add(fade, forKey: "keys")
    if !Motion.reduced {
      let rise = CABasicAnimation(keyPath: "position.y")
      rise.fromValue = bubble.position.y - 6
      rise.toValue = bubble.position.y
      rise.duration = 0.25
      rise.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
      bubble.add(rise, forKey: "rise")
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.95) { bubble.removeFromSuperlayer() }
  }

  /// Gone. `quick`: it has landed on the island's own pearl, so it only has to fade into it.
  func hide(animated: Bool, quick: Bool = false) {
    stopTicking()
    AskBubble.shared.hide()
    clearStones()
    clearTwin()
    gesture = nil
    tripOver("over")
    mode = .hidden
    actionPending = false
    away = 0
    // Nothing is out, so nothing waits, searches, walks a route or can be picked up.
    walker.stop()
    endGrab()
    search = nil
    leaveAt = nil
    _ = hold.drop()
    grabPanel?.orderOut(nil)
    underRing = nil
    CaptionBar.shared.setLightNeeds(false)
    CaptionBar.shared.setMarkAway(false)
    CaptionBar.shared.setLight(nil)
    guard let p = panel else { return }
    panel = nil
    screenFrame = .null
    orb = nil
    fly = nil
    flight = nil
    afterFlight = nil
    holding = nil
    hop = nil
    showing = .null
    velocity = .zero
    marks = []
    outline = nil
    bubble = nil
    lastCaption = nil
    landing = []
    typing = nil
    caretGlow = nil
    guard animated else { return p.close() }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = quick ? 0.14 : 0.4
      p.animator().alphaValue = 0
    }, completionHandler: { p.close() })
  }

  // MARK: waiting, searching and being picked up (docs/firefly-protocol.md)

  /// A `firefly` message from the server: a release (`release` and `outcome`) lets a waiting or
  /// searching light go; a hold (`hold`, with intent "ask") keeps the light beside a risky step
  /// until its card is answered. Anything else is ignored.
  func firefly(_ msg: [String: Any]) {
    if let name = msg["release"] as? String {
      released(name, outcome: msg["outcome"] as? String ?? "")
    } else if let id = msg["hold"] as? String {
      ask(id)
    }
  }

  /// A risky step is waiting for your OK: the light moves off the thing to hover beside it, turns
  /// to its asking colour, and the pearl asks with it. With no light out there is nothing to hold.
  private func ask(_ id: String) {
    guard firefly, mode == .out, panel != nil, !showing.isNull, !id.isEmpty else { return }
    hold.take(ask: id)
    intent = "ask"
    fly?.art.intent = intent
    leaveAt = nil
    CaptionBar.shared.setLightNeeds(true)
    let beside = PearlMath.hover(beside: showing, in: CGRect(origin: .zero, size: screenFrame.size)), now = CACurrentMediaTime()
    fly(to: beside, now: now)
    if let screen = NSScreen.screens.first(where: { $0.frame == screenFrame }) {
      say(BubbleMath.phrase(moment: .asking), light: beside, around: showing, after: flight.map { $0.lands - now } ?? 0, on: screen, avoiding: islandLocal())
    }
  }

  /// The island's place in the overlay's coordinates (with a little room), for the caption to keep off.
  private func islandLocal() -> [CGRect] {
    CaptionBar.shared.frameOnScreen.map { [$0.offsetBy(dx: -screenFrame.minX, dy: -screenFrame.minY).insetBy(dx: -6, dy: -6)] } ?? []
  }

  private func released(_ name: String, outcome: String) {
    let now = CACurrentMediaTime()
    // Is the light out looking for this very step (the release beat the find)?
    let finding = search.map { hold.step(of: $0.id) == name } ?? false
    let walking = walker.id.map { hold.step(of: $0) == name } ?? false
    let what = hold.release(name, outcome: outcome)
    if finding, let s = search {
      // What is found for it will not be shown: the searching ends here, and a light out
      // searching goes home (quietly: nothing went wrong).
      search = nil
      CaptionBar.shared.setLightNeeds(false)
      if s.shown, leaveAt == nil { leaveAt = now }
    }
    switch what {
    case .ignore:
      return
    case .early:
      // Let go before the light ever got there: a route being walked for it stops (and answers).
      if walking { walker.stop() }
    case .burst:
      // The step passed: a small burst, a pleased blink from the pearl, then on to the next
      // step (its point finds the light still out) or home.
      walker.stop()
      if mode == .out {
        fly?.art.burst(now: now)
        pingRing()
      }
      CaptionBar.shared.moment("done")
      fadeOutline(after: 0.25)
      hush() // "Your turn" stayed for the whole wait; the wait is over
      leaveAt = now + 0.9
    case .proceed:
      // You said yes: it goes back to the thing's edge in its acting colours, for the click that follows.
      intent = "act"
      fly?.art.intent = intent
      CaptionBar.shared.setLightNeeds(false)
      hush() // the question is answered; the step that follows says what it is
      pointedAt = now
      if firefly, mode == .out, !showing.isNull {
        fly(to: PearlMath.orbit(showing, laps: 0), now: now) { [weak self] in
          self?.holding = nil
          self?.arrivedAt = CACurrentMediaTime() - 60
        }
      }
    case .leave:
      // Skipped or stopped: it just leaves (a skip waits a moment, for the next step to call it on).
      walker.stop()
      CaptionBar.shared.setLightNeeds(false)
      hush()
      leaveAt = now + (outcome == "skipped" ? 0.3 : 0)
    case .lost:
      // The server stopped waiting for a find of ours (or the step's target is gone).
      walker.stop()
      if search?.id == name { search = nil }
      lost()
    }
    startTicking()
  }

  /// Not found: the light goes home and the pearl gives its small "sorry".
  private func lost() {
    _ = hold.drop()
    CaptionBar.shared.setLightNeeds(false)
    guard mode == .out else { return }
    CaptionBar.shared.moment("sorry")
    leaveAt = CACurrentMediaTime()
    startTicking()
  }

  /// The line to the server dropped, or Echo is quitting: no release can come any more, so
  /// nothing keeps waiting, searching or walking, and the light goes home.
  func letGo() {
    walker.stop()
    endGrab()
    search = nil
    leaveAt = nil
    _ = hold.drop()
    intent = "show"
    fly?.art.intent = intent
    CaptionBar.shared.setLightNeeds(false)
    release()
  }

  // MARK: searching

  /// The app starts its own find for request `id` (a point, or an act's resolve) in `app`. If
  /// that takes longer than 400 ms the light flies a slow figure of eight near the middle of the
  /// app's window and the pearl looks puzzled, until `answered` (or a point at what was found).
  /// `stepId`: the lesson step the find is for, so a release that beats the find is not lost.
  /// `target`: what it is looking for, for the caption under the searching light.
  func searching(_ id: String, in app: NSRunningApplication?, intent: String?, stepId: String? = nil, target: String = "") {
    hold.began(id, step: stepId)
    guard firefly, Prefs.pointer, !id.isEmpty else { return }
    search = (id, PearlMath.intent(intent), target, nil, .zero, CACurrentMediaTime(), false)
    // The app's window is read off the main thread: an app slow to answer is why this may show at all.
    if let app {
      let top = AXFinder.Displays.current().primaryHeight
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let w = AXFinder.focusedWindowFrame(of: app, primaryHeight: top)
        DispatchQueue.main.async {
          guard let self, self.search?.id == id, self.search?.shown == false else { return }
          self.search?.window = w
        }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + PearlMath.searchAfter) { [weak self] in self?.showSearch(id) }
  }

  /// Did the server stop waiting for request `id`? Then what was found is not shown.
  func calledOff(_ id: String) -> Bool { hold.isCalledOff(id) }

  /// The app's find for request `id` is over and its answer is ready. Not found: a searching
  /// light goes home and the pearl is sorry, and the request holds nothing. False when the server
  /// had already stopped waiting for it: then the answer is not sent.
  func answered(_ id: String, found: Bool) -> Bool {
    let wanted = hold.ended(id)
    guard let s = search, s.id == id else { return wanted }
    search = nil
    if !found {
      if wanted, s.shown || hold.waiting { lost() } else { CaptionBar.shared.setLightNeeds(false) }
    } else if s.shown, mode == .out, showing.isNull {
      // Found, but nowhere the light could go: it comes home quietly.
      CaptionBar.shared.setLightNeeds(false)
      leaveAt = CACurrentMediaTime()
      startTicking()
    }
    return wanted
  }

  private func showSearch(_ id: String) {
    guard let s = search, s.id == id, !s.shown, firefly, !grab.active, typing == nil, !actionPending else { return }
    // On the screen the app's window is on; else where the light already is, or the island's.
    let screens = NSScreen.screens
    let windowScreen = s.window.flatMap { PointMath.screenIndex(for: $0, in: screens.map(\.frame)) }.map { screens[$0] }
    let here = panel != nil ? screenFrame : CaptionBar.shared.dock()?.screen ?? .null
    guard let screen = windowScreen ?? screens.first(where: { $0.frame == here }) ?? NSScreen.main ?? screens.first else { return }
    let wasHidden = mode == .hidden || panel == nil
    let fresh = ensurePanel(on: screen) || wasHidden
    guard let fly else { return }
    let origin = screen.frame.origin, now = CACurrentMediaTime(), reduce = Motion.reduced
    let centre = PearlMath.searchCentre(window: s.window.map { $0.offsetBy(dx: -origin.x, dy: -origin.y) }, screen: CGRect(origin: .zero, size: screen.frame.size))
    if fresh {
      let start = leaveFrom(screen, toward: CGPoint(x: centre.x + origin.x, y: centre.y + origin.y))
      position = CGPoint(x: start.x - origin.x, y: start.y - origin.y)
      velocity = .zero
      fly.art.move(to: position, now: now, jump: true)
      if !reduce { onLight?(["type": "departed", "id": id]) }
    }
    // Whatever it was showing before is over: it is looking for the next thing now. A route
    // walked for another request stops; the walk this search belongs to goes on (it is the one
    // looking), and answers when it finds its first label or runs out of patience.
    if PearlMath.searchStops(walk: walker.id, for: id) { walker.stop() }
    fadeOutline(after: 0)
    setLevel(pointingAt: nil)
    showing = .null
    holding = nil
    afterFlight = nil
    leaveAt = nil
    mode = .out
    pinned = true
    pointedAt = now
    finishedAt = nil
    intent = s.intent
    fly.art.intent = intent
    search?.shown = true
    search?.centre = centre
    search?.since = now
    if reduce {
      position = centre
      flight = nil
    } else {
      flight = PearlMath.Flight(from: position, to: centre, at: now + (fresh ? 0.14 : 0))
      // The loop starts where the flight ends.
      afterFlight = { [weak self] in self?.search?.since = CACurrentMediaTime() }
    }
    // Under the loop it flies, what it is looking for.
    let loop = PearlMath.searchBox(around: centre)
    say(BubbleMath.phrase(target: s.target, moment: .searching), light: CGPoint(x: loop.midX, y: loop.minY), around: loop,
        after: flight.map { $0.lands - now } ?? 0, on: screen, avoiding: islandLocal())
    // The pearl is puzzled: a raised brow, its eyes on its light.
    CaptionBar.shared.setLight(screenPoint(centre))
    CaptionBar.shared.setLightNeeds(true)
    if CaptionBar.shared.showing { CaptionBar.shared.setMarkAway(false) }
    panel?.orderFrontRegardless()
    startTicking()
  }

  // MARK: a route through menus

  /// Shows the way through menus: the light rests on the first label of `route` that can be
  /// found, and moves on to the next as each menu opens (Echo never opens one), ending on the
  /// last, which it circles like any target. `answer` is called once: when it is on the target,
  /// after `patience` seconds at a stop with the next still not showing, or when the walk is
  /// stopped before either (found is false when not even the first label was found). A held
  /// light keeps walking after that, as you open the menus.
  func walk(_ id: String, route: [String], app: NSRunningApplication?, menuBar: Bool, intent: String?, stepId: String?, patience: Double,
            answer: @escaping (_ found: Bool, _ index: Int, _ hit: AXFinder.Hit?, _ screen: NSScreen?) -> Void) {
    searching(id, in: app, intent: intent, stepId: stepId, target: route[0])
    var shownOn: NSScreen?
    walker.walk(id, route: route, app: app, menuBar: menuBar, patience: patience, arrive: { [weak self] i, hit in
      guard let self, !self.calledOff(id) else { return false }
      guard let screen = self.point(at: hit.frame, label: route[i], role: hit.role, intent: intent, stepId: stepId, request: id,
                                    walking: true, passing: i < route.count - 1) else { return false }
      shownOn = screen
      return true
    }, answer: { index, hit in
      answer(index != nil, index ?? 0, hit, shownOn)
    })
  }

  // MARK: picking the light up

  /// May the light be picked up now? Only while it is out and resting on or circling something:
  /// never in flight, mid-step, typing or searching, and only when Echo can tell what things
  /// are (Accessibility), or a drop could never land.
  private var holdable: Bool {
    firefly && mode == .out && canFind && flight == nil && typing == nil && !actionPending && search == nil && leaveAt == nil
      && (!showing.isNull || holding != nil)
  }

  private func makeGrabPanel() -> NSPanel {
    let side = 2 * PearlMath.grabReach
    let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: side, height: side), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.ignoresMouseEvents = true
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.animationBehavior = .none
    p.setAccessibilityLabel("Echo's light. Drag it onto something to point at it.")
    let view = GrabView(frame: NSRect(x: 0, y: 0, width: side, height: side))
    view.owner = self
    view.wantsLayer = true
    view.layer?.cornerRadius = side / 2
    p.contentView = view
    grabPanel = p
    return p
  }

  /// Keeps the light's own small spot under it: a panel 22 pt across that takes the mouse only
  /// while your mouse is on the light (`takes`), so a click anywhere else, the thing it shows
  /// included, goes to the app underneath as always. Away when the light can't be picked up.
  private func placeGrab(at p: CGPoint, takes: Bool) {
    guard holdable || grab.active else {
      if let g = grabPanel, g.isVisible {
        g.ignoresMouseEvents = true
        g.orderOut(nil)
      }
      return
    }
    let g = grabPanel ?? makeGrabPanel()
    // In your hand it stays where you took hold (the drag is followed from there).
    if !grab.active {
      let side = 2 * PearlMath.grabReach
      let origin = CGPoint(x: (screenFrame.minX + p.x - side / 2).rounded(), y: (screenFrame.minY + p.y - side / 2).rounded())
      if g.frame.origin != origin { g.setFrameOrigin(origin) }
    }
    if g.ignoresMouseEvents == takes {
      g.ignoresMouseEvents = !takes
      // A whisper of white while it takes the mouse: a window with nothing drawn in it takes no clicks.
      g.contentView?.layer?.backgroundColor = takes ? RGB.white.cg(0.06) : nil
    }
    // Just above the overlay, wherever that is (it rises over an open menu to point into it).
    let level = NSWindow.Level(rawValue: (panel?.level ?? Self.restingLevel).rawValue + 1)
    if g.level != level { g.level = level }
    if !g.isVisible { g.orderFrontRegardless() }
  }

  fileprivate func grabDown() {
    guard let fly, grab.press(local(NSEvent.mouseLocation), light: fly.art.position, target: showing, holdable: holdable) else { return }
    heldBefore = holding
    watchEscape(true)
    startTicking()
  }

  fileprivate func grabMoved() {
    guard grab.active else { return }
    let was = grab.state
    grab.move(local(NSEvent.mouseLocation))
    if was == .held, grab.state == .dragging {
      // It is yours now: a route stops being walked, and nothing waits to land.
      walker.stop()
      flight = nil
      afterFlight = nil
      probedAt = -100
    }
    startTicking()
  }

  fileprivate func grabUp() {
    guard grab.active else { return }
    let at = NSEvent.mouseLocation
    grab.release(local(at))
    grabEndedAt = CACurrentMediaTime()
    watchEscape(false)
    // A press that never moved is no drop: the light steps aside, in case it was in your way.
    guard grab.state == .dropped else { return stepAside() }
    holding = position
    look(under: at) { [weak self] found in self?.dropped(at: at, on: found) }
  }

  /// You clicked the light without carrying it anywhere: it steps to the far corner of what it
  /// is showing (asking, to the thing's other side), so it is never in the way of what was
  /// under it; click it again and it steps back. With nothing to stand by, it goes home.
  private func stepAside() {
    guard mode == .out, flight == nil else { return }
    let now = CACurrentMediaTime()
    guard !showing.isNull else {
      leaveAt = now
      return startTicking()
    }
    let asks = intent == "ask", bounds = CGRect(origin: .zero, size: screenFrame.size)
    let usual = asks ? PearlMath.hover(beside: showing, in: bounds) : PearlMath.orbit(showing, laps: 0)
    let aside = asks ? CGPoint(x: showing.minX - (usual.x > showing.midX ? 14 : -showing.width - 14), y: usual.y) : PearlMath.orbit(showing, laps: 0.5)
    let isAside = holding.map { hypot($0.x - aside.x, $0.y - aside.y) < 3 } ?? false
    fly(to: isAside ? usual : aside, now: now) { [weak self] in
      // Back at its usual corner it rests as before (asking, it keeps hovering where it is).
      if isAside, !asks { self?.holding = nil }
      self?.arrivedAt = CACurrentMediaTime() - 60
    }
  }

  /// Reads what is under `at` (screen coordinates), off the main thread.
  private func look(under at: CGPoint, _ done: @escaping (AXFinder.Under?) -> Void) {
    let displays = AXFinder.Displays.current()
    // The island is Echo's own: nothing to point at there.
    if let island = CaptionBar.shared.frameOnScreen, island.contains(at) { return done(AXFinder.Under(echo: true)) }
    // Echo's see-through windows (this overlay, the light's own spot, the island's wide empty
    // panel, the edge line) are not "under" the light: what counts is the window beneath them.
    var overlays = Set(NSApp.windows.filter { $0.isVisible && ($0.ignoresMouseEvents || $0 === grabPanel) }.map(\.windowNumber))
    if let n = CaptionBar.shared.windowNumber { overlays.insert(n) }
    DispatchQueue.global(qos: .userInitiated).async {
      let found = AXFinder.under(at, displays: displays, overlays: overlays)
      DispatchQueue.main.async { done(found) }
    }
  }

  /// While it is dragged: what is under it, a few times a second, gets a soft ring.
  private func probe(_ now: CFTimeInterval) {
    guard !probing, now - probedAt >= 0.12 else { return }
    probing = true
    probedAt = now
    look(under: NSEvent.mouseLocation) { [weak self] found in
      guard let self else { return }
      self.probing = false
      guard self.grab.state == .dragging else { return }
      self.under = found
      self.ringUnder(found)
    }
  }

  /// Is this something the light could settle on (and worth a ring)?
  private func ringable(_ u: AXFinder.Under?) -> CGRect? {
    guard let u, !u.echo, PointMath.usable(u.frame), !screenFrame.isNull else { return nil }
    let seen = u.frame.intersection(screenFrame)
    // The middle of something huge (a whole window, a page) is nothing in particular to ring.
    guard !seen.isNull, seen.width * seen.height <= screenFrame.width * screenFrame.height * 0.3 else { return nil }
    return toLocal(seen)
  }

  /// The soft ring round what is under the dragged light: fainter and finer than a target's.
  private func ringUnder(_ u: AXFinder.Under?) {
    guard let layer = panel?.contentView?.layer, let r = ringable(u) else {
      underRing?.removeFromSuperlayer()
      underRing = nil
      return
    }
    let box = r.insetBy(dx: -3, dy: -3)
    let corner = TouchMath.corner(role: u?.role ?? "", frame: r) + 3
    let path = CGPath(roundedRect: box, cornerWidth: min(corner, box.width / 2, box.height / 2), cornerHeight: min(corner, box.width / 2, box.height / 2), transform: nil)
    let ring = underRing ?? {
      let l = CAShapeLayer()
      l.fillColor = RGB.white.cg(0.05)
      l.strokeColor = RGB.white.cg(0.62)
      l.lineWidth = 1
      l.shadowColor = CGColor(gray: 0, alpha: 1)
      l.shadowRadius = 5
      l.shadowOpacity = 0.4
      l.shadowOffset = .zero
      l.actions = ["path": NSNull()]
      layer.insertSublayer(l, at: 0)
      underRing = l
      return l
    }()
    ring.path = path
  }

  /// You let go of the light at `at` (screen coordinates). On something: it settles there with a
  /// small burst, ringed, and Echo's server is told what you pointed at (its name and role, its
  /// app and window, its neighbours' names: nothing else). On nothing, or on Echo's own windows:
  /// it glides back to where it was.
  private func dropped(at: CGPoint, on found: AXFinder.Under?) {
    guard grab.state == .dropped else { return }
    let from = grab.from
    grab.settle()
    underRing?.removeFromSuperlayer()
    underRing = nil
    under = nil
    guard mode == .out, let layer = panel?.contentView?.layer else { return }
    let now = CACurrentMediaTime()
    let named = found.map { !$0.label.isEmpty || !$0.role.isEmpty || !$0.near.isEmpty } ?? false
    guard let found, PearlMath.drop(element: named, onEcho: found.echo) == .settle else {
      return glideBack(to: from, now: now)
    }
    defer {
      var body: [String: Any] = ["x": Double(at.x.rounded()), "y": Double(at.y.rounded())]
      if !found.label.isEmpty { body["label"] = found.label }
      if !found.role.isEmpty { body["role"] = found.role }
      if !found.app.isEmpty { body["app"] = found.app }
      if !found.window.isEmpty { body["window"] = found.window }
      if !found.near.isEmpty { body["near"] = found.near }
      onPointed?(body)
    }
    // Dropped on another screen: the light goes to the thing there, as for any point (and keeps
    // waiting on the lesson step it was waiting on).
    if PointMath.usable(found.frame), !found.frame.intersects(screenFrame) {
      point(at: found.frame, label: "", role: found.role, intent: "show", stepId: hold.waiting && !hold.asking ? hold.id : nil)
      return
    }
    // It lands where you put it, and settles on the thing's edge.
    fly?.art.burst(now: now)
    NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
    marks.forEach { $0.removeFromSuperlayer() }
    marks = []
    outline = nil
    pinned = true
    acting = ""
    dragTo = nil
    actionPending = false
    pointedAt = now
    finishedAt = nil
    intent = "show"
    fly?.art.intent = intent
    CaptionBar.shared.setLightNeeds(false)
    CaptionBar.shared.setDoing(nil)
    if let r = ringable(found) {
      showing = r
      setLevel(pointingAt: found.frame)
      outlineTarget(r.insetBy(dx: -4, dy: -4), arrive: 0.12, in: layer, role: found.role)
      fly(to: PearlMath.orbit(r, laps: 0), now: now) { [weak self] in
        // Resting at its corner: you showed it, so there is nothing to circle.
        self?.holding = nil
        self?.arrivedAt = CACurrentMediaTime() - 60
      }
    } else {
      // Something too big to ring (a window, a page): it stays where you put it.
      showing = .null
      holding = position
    }
    startTicking()
  }

  /// Back to where it was resting before you picked it up.
  private func glideBack(to from: CGPoint, now: CFTimeInterval) {
    let before = heldBefore
    fly(to: from, now: now) { [weak self] in
      self?.holding = before
      self?.arrivedAt = CACurrentMediaTime() - 60
    }
    startTicking()
  }

  /// Escape while the light is in your hand puts it back. Only watched while it is (the one key,
  /// and nothing of what you type is read or kept).
  private func watchEscape(_ on: Bool) {
    escapeWatch.forEach { NSEvent.removeMonitor($0) }
    escapeWatch = []
    guard on else { return }
    let escape: UInt16 = 53
    if let m = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in if e.keyCode == escape { self?.cancelGrab() } }) { escapeWatch.append(m) }
    if let m = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in
      if e.keyCode == escape { self?.cancelGrab() }
      return e
    }) { escapeWatch.append(m) }
  }

  private func cancelGrab() {
    guard grab.active else { return }
    let dragging = grab.state == .dragging, from = grab.from
    endGrab()
    if dragging, mode == .out { glideBack(to: from, now: CACurrentMediaTime()) }
  }

  /// The light is out of your hand (a new errand, home, gone), with nothing sent.
  private func endGrab() {
    watchEscape(false)
    if grab.active {
      grab.escape()
      grabEndedAt = CACurrentMediaTime()
    }
    grab.settle()
    under = nil
    underRing?.removeFromSuperlayer()
    underRing = nil
  }

  // MARK: looking at your screen

  /// While Echo looks: the status chip says "Looking" and the edge glows (Overlays.swift). Echo's
  /// own windows are never in a capture, so neither shows up in the picture.
  func showLooking(on screen: NSScreen) {
    lookToken += 1
    StatusChip.shared.setLooking(true, screen: screen)
    EdgeGlow.shared.show(.looking)
  }

  /// Leaves them up a moment longer, so it's noticed even when the look is quick (unless another
  /// look has started since).
  func hideLooking(after seconds: Double = 0) {
    let token = lookToken
    let close = { [weak self] in
      guard let self, self.lookToken == token else { return }
      StatusChip.shared.setLooking(false)
      EdgeGlow.shared.hide(.looking)
    }
    if seconds > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: close) } else { close() }
  }
}
