import AppKit

// Drawing with the light, and notes that stay (echo-talk-design.html, sections 4 and 6).
//
// DrawLight: hold the talk key and move the mouse, and Echo's light follows your pointer and
// draws. Let go, and what you circled is outlined and told to the page (which tells Echo what
// "this" is). If you said nothing, a small box opens right there for you to type what you want
// (DrawBox); it fades after a few seconds. The outline dims, and leaves once Echo has answered,
// the page scrolls, or twenty seconds have passed (what was circled is still "this" for two minutes).
// A drawing is never a yes to anything.
//
// PinnedNotes: a line Echo was asked to keep on screen. Each is a small piece of the same dark
// glass, yours to drag and to close, kept across restarts (at most five).
//
// Everything here is in the "Aurora" look: dark glass, Echo's colours round the rim while it is
// live (the box waiting for your words), a quiet hairline once it is settled (a pinned note).

enum Aurora {
  /// A rim in the answer's colours round `bounds` (for a layer-backed view's layer).
  static func rim(_ bounds: CGRect, radius: CGFloat, width: CGFloat = 1.5) -> CALayer {
    let g = CAGradientLayer()
    g.frame = bounds
    g.colors = MarkArt.answer.map { $0.cg() }
    g.locations = MarkArt.answerStops.map { NSNumber(value: Double($0)) }
    g.startPoint = CGPoint(x: 0, y: 1)
    g.endPoint = CGPoint(x: 1, y: 0)
    let mask = CAShapeLayer()
    mask.path = CGPath(roundedRect: bounds.insetBy(dx: width / 2, dy: width / 2), cornerWidth: radius - width / 2, cornerHeight: radius - width / 2, transform: nil)
    mask.fillColor = nil
    mask.strokeColor = CGColor(gray: 1, alpha: 1)
    mask.lineWidth = width
    g.mask = mask
    return g
  }

  /// A borderless panel that floats with the island and never brings Echo forward.
  static func panel(label: String, takesKeys: Bool = false) -> NSPanel {
    let p: NSPanel = takesKeys ? KeyPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                               : NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.level = .statusBar
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.hidesOnDeactivate = false
    p.becomesKeyOnlyIfNeeded = true
    p.isReleasedWhenClosed = false
    p.animationBehavior = .none
    p.setAccessibilityLabel(label)
    return p
  }

  static func chip(_ title: String, target: AnyObject, action: Selector, primary: Bool = false) -> NSButton {
    let b = NSButton(title: title, target: target, action: action)
    b.isBordered = false
    b.wantsLayer = true
    b.layer?.cornerRadius = 13
    b.layer?.backgroundColor = primary ? NSColor(white: 0.96, alpha: 1).cgColor : NSColor(white: 1, alpha: 0.08).cgColor
    if !primary { b.layer?.borderWidth = 1; b.layer?.borderColor = NSColor(white: 1, alpha: 0.18).cgColor }
    b.attributedTitle = NSAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: 12.5, weight: .medium), .foregroundColor: primary ? NSColor.black : NSColor(white: 0.95, alpha: 1)])
    b.setAccessibilityLabel(title)
    return b
  }
  static func chipWidth(_ title: String) -> CGFloat { ceil((title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12.5, weight: .medium)]).width) + 24 }
}

private final class KeyPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

// MARK: drawing with the light

final class DrawLight {
  static let shared = DrawLight()

  /// What was circled: its box as shares of its screen (0…1, from the top-left), told to the page.
  var onDrew: (([String: Any]) -> Void)?
  /// What you typed in the box about it.
  var onAsk: ((String) -> Void)?

  private var monitors: [Any] = []
  private var points: [CGPoint] = []
  private var travelled: CGFloat = 0
  private var overlay: NSPanel?
  private let stroke = CAShapeLayer(), glow = CAShapeLayer(), dot = CALayer(), outline = CAShapeLayer()
  private var screen: NSScreen?
  private(set) var drawing = false
  private var active = false
  private var outlineUntil: DispatchWorkItem?
  private var scrollWatch: Any?
  private var shownAt = Date.distantPast
  /// The last thing circled (screen coordinates), while its outline is still up.
  private(set) var region: CGRect?

  /// The talk key went down: from here, moving the mouse draws.
  func begin() {
    guard !active else { return }
    active = true
    drawing = false
    points = []
    travelled = 0
    let handle: (NSEvent) -> Void = { [weak self] _ in self?.moved() }
    if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: handle) { monitors.append(m) }
    if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { e in handle(e); return e }) { monitors.append(m) }
  }

  /// The key was let go. Returns whether something was circled.
  @discardableResult
  func end() -> Bool {
    guard active else { return false }
    stopWatching()
    guard drawing, let screen, let box = DrawMath.box(points), DrawMath.meant(box, travelled: travelled) else {
      clearStroke()
      if region == nil { overlay?.orderOut(nil) }
      return false
    }
    drawing = false
    clearStroke()
    show(outline: box, on: screen)
    region = box
    BodyLink.shared.timeline("draw.done", ["w": Int(box.width), "h": Int(box.height)])
    onDrew?(DrawMath.shares(of: box, in: screen.frame))
    return true
  }

  /// The chord turned out to be a shortcut, or was changed: nothing was drawn.
  func cancel() {
    guard active else { return }
    stopWatching()
    drawing = false
    clearStroke()
    if region == nil { overlay?.orderOut(nil) }
  }

  /// Only the square leaves the screen (the work is done, the page moved, or it has been up long
  /// enough): what was circled is still "this" to Echo for its two minutes.
  func fadeOutline() {
    guard outline.path != nil, !drawing else { return }
    scrollWatch.map { NSEvent.removeMonitor($0) }
    scrollWatch = nil
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = outline.presentation()?.opacity ?? outline.opacity
    fade.toValue = 0
    fade.duration = 0.35
    outline.opacity = 0
    outline.add(fade, forKey: "out")
    DrawBox.shared.hide()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      guard let self, self.outline.opacity == 0, !self.drawing else { return }
      self.outline.path = nil
      self.overlay?.orderOut(nil)
    }
  }

  /// Echo's voice changed: once it has answered about what was circled, the square goes.
  func voice(was: String, now: String) {
    guard outline.path != nil, outline.opacity > 0 else { return }
    if DrawMath.workDone(was: was, now: now, shownFor: Date().timeIntervalSince(shownAt)) { fadeOutline() }
  }

  /// The outline and the box go (a new request, the two minutes are up, or Echo was told to forget it).
  func clear() {
    scrollWatch.map { NSEvent.removeMonitor($0) }
    scrollWatch = nil
    outlineUntil?.cancel()
    outlineUntil = nil
    region = nil
    outline.path = nil
    DrawBox.shared.hide()
    if !drawing { overlay?.orderOut(nil) }
  }

  /// Nothing was said while drawing: the box opens at what was circled.
  func offerBox() {
    guard let region, let screen else { return }
    DrawBox.shared.show(under: region, visible: screen.visibleFrame) { [weak self] text in self?.onAsk?(text) }
  }

  private func stopWatching() {
    active = false
    monitors.forEach { NSEvent.removeMonitor($0) }
    monitors = []
  }

  private func moved() {
    guard active else { return }
    let p = NSEvent.mouseLocation
    if let last = points.last {
      let d = hypot(p.x - last.x, p.y - last.y)
      guard d >= 1.5 else { return }
      travelled += d
    }
    points.append(p)
    if points.count > 1200 { points.removeFirst(points.count - 1200) }
    if !drawing, travelled >= DrawMath.startAfter {
      guard let s = NSScreen.screens.first(where: { $0.frame.contains(p) }) ?? NSScreen.main else { return }
      drawing = true
      clear()
      screen = s
      ensureOverlay(on: s)
      BodyLink.shared.timeline("draw.start")
    }
    if drawing { redraw() }
  }

  private func ensureOverlay(on s: NSScreen) {
    let p: NSPanel
    if let overlay { p = overlay } else {
      p = Aurora.panel(label: "Echo's light, drawing")
      p.ignoresMouseEvents = true // clicks go straight through
      p.hasShadow = false
      let root = NSView()
      root.wantsLayer = true
      p.contentView = root
      for (l, width, alpha) in [(glow, CGFloat(7), CGFloat(0.22)), (stroke, CGFloat(2.2), CGFloat(0.95))] {
        l.fillColor = nil
        l.strokeColor = RGB(hex: 0xFFF0D6).cg(alpha)
        l.lineWidth = width
        l.lineCap = .round
        l.lineJoin = .round
        l.actions = ["path": NSNull()]
        root.layer?.addSublayer(l)
      }
      outline.fillColor = RGB(hex: 0xFFF0D6).cg(0.05)
      outline.strokeColor = RGB(hex: 0xFFF0D6).cg(0.9)
      outline.lineWidth = 1.5
      outline.shadowColor = RGB(hex: 0xFFF0D6).cg()
      outline.shadowOpacity = 0.5
      outline.shadowRadius = 8
      outline.shadowOffset = .zero
      root.layer?.addSublayer(outline)
      dot.bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
      dot.cornerRadius = 5
      dot.backgroundColor = NSColor.white.cgColor
      dot.shadowColor = RGB(hex: 0xFFF0D6).cg()
      dot.shadowOpacity = 1
      dot.shadowRadius = 9
      dot.shadowOffset = .zero
      dot.actions = ["position": NSNull(), "opacity": NSNull()]
      root.layer?.addSublayer(dot)
      overlay = p
    }
    p.setFrame(s.frame, display: false)
    p.orderFrontRegardless()
  }

  private func local(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x - (screen?.frame.minX ?? 0), y: p.y - (screen?.frame.minY ?? 0)) }

  private func redraw() {
    guard let first = points.first else { return }
    let path = CGMutablePath()
    path.move(to: local(first))
    for p in points.dropFirst() { path.addLine(to: local(p)) }
    stroke.path = path
    glow.path = path
    dot.opacity = 1
    if let last = points.last { dot.position = local(last) }
  }

  private func clearStroke() {
    stroke.path = nil
    glow.path = nil
    dot.opacity = 0
    points = []
  }

  private func show(outline box: CGRect, on s: NSScreen) {
    ensureOverlay(on: s)
    let r = CGRect(x: box.minX - s.frame.minX, y: box.minY - s.frame.minY, width: box.width, height: box.height)
    outline.path = CGPath(roundedRect: r, cornerWidth: min(12, r.width / 2), cornerHeight: min(12, r.height / 2), transform: nil)
    outline.opacity = 1
    outline.removeAnimation(forKey: "out")
    shownAt = Date()
    // The page under it scrolls: the square is no longer round the thing, so it goes.
    scrollWatch.map { NSEvent.removeMonitor($0) }
    scrollWatch = NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
      if abs(e.scrollingDeltaY) + abs(e.scrollingDeltaX) > 2 { self?.fadeOutline() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + DrawMath.outlineMost) { [weak self] in
      guard let self, self.region == box else { return }
      self.fadeOutline()
    }
    // After a few seconds it dims, and stays as what "this" means; it leaves when the work is done (fadeOutline), and is forgotten after two minutes.
    DispatchQueue.main.asyncAfter(deadline: .now() + DrawMath.boxFades) { [weak self] in
      guard let self, self.region == box else { return }
      self.outline.opacity = 0.35
    }
    outlineUntil?.cancel()
    let gone = DispatchWorkItem { [weak self] in self?.clear() }
    outlineUntil = gone
    DispatchQueue.main.asyncAfter(deadline: .now() + DrawMath.thisLasts, execute: gone)
  }
}

/// The small box that opens at what you circled when you said nothing: "What about this?".
final class DrawBox: NSObject, NSTextFieldDelegate {
  static let shared = DrawBox()
  static let quick = ["Explain", "Fix it", "Improve it"]

  private var panel: NSPanel?
  private var field: NSTextField?
  private var send: ((String) -> Void)?
  private var fade: DispatchWorkItem?

  func show(under region: CGRect, visible: CGRect, send: @escaping (String) -> Void) {
    self.send = send
    let widths = Self.quick.map(Aurora.chipWidth)
    let frame = DrawMath.boxFrame(region: region, visible: visible)
    let p = panel ?? Aurora.panel(label: "Tell Echo about what you circled", takesKeys: true)
    panel = p
    let root = NSView(frame: CGRect(origin: .zero, size: frame.size))
    root.wantsLayer = true
    // The field: dark glass with Echo's colours round its rim (it is waiting for your words).
    let glass = NSView(frame: CGRect(x: 0, y: frame.height - DrawMath.fieldHeight, width: frame.width, height: DrawMath.fieldHeight))
    glass.wantsLayer = true
    glass.layer?.backgroundColor = MarkArt.glass.cg(0.94)
    glass.layer?.cornerRadius = DrawMath.fieldHeight / 2
    glass.layer?.addSublayer(Aurora.rim(glass.bounds, radius: DrawMath.fieldHeight / 2))
    let f = NSTextField(frame: CGRect(x: 16, y: (DrawMath.fieldHeight - 20) / 2, width: frame.width - 32, height: 20))
    f.isBordered = false
    f.drawsBackground = false
    f.focusRingType = .none
    f.font = NSFont.systemFont(ofSize: 14)
    f.textColor = NSColor(white: 0.96, alpha: 1)
    f.placeholderAttributedString = NSAttributedString(string: "What about this?", attributes: [.foregroundColor: NSColor(white: 1, alpha: 0.45), .font: NSFont.systemFont(ofSize: 14)])
    f.delegate = self
    f.setAccessibilityLabel("What about this?")
    glass.addSubview(f)
    field = f
    root.addSubview(glass)
    var x: CGFloat = 4
    for (i, title) in Self.quick.enumerated() {
      let b = Aurora.chip(title, target: self, action: #selector(chipClicked(_:)))
      b.frame = CGRect(x: x, y: 0, width: widths[i], height: 26)
      b.layer?.backgroundColor = MarkArt.glass.cg(0.9)
      root.addSubview(b)
      x += widths[i] + 6
    }
    p.contentView = root
    p.setFrame(frame, display: true)
    p.alphaValue = 1
    p.orderFrontRegardless()
    // Untouched, it goes after a few seconds (what you circled stays remembered).
    fade?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self, let p = self.panel, !p.isKeyWindow, (self.field?.stringValue ?? "").isEmpty else { return }
      self.hide()
    }
    fade = work
    DispatchQueue.main.asyncAfter(deadline: .now() + DrawMath.boxFades, execute: work)
  }

  func hide() {
    fade?.cancel()
    fade = nil
    panel?.orderOut(nil)
    field?.stringValue = ""
  }

  @objc private func chipClicked(_ sender: NSButton) {
    let text = sender.title
    hide()
    send?(text)
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    if selector == #selector(NSResponder.insertNewline(_:)) {
      let text = (field?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      hide()
      if !text.isEmpty { send?(text) }
      return true
    }
    if selector == #selector(NSResponder.cancelOperation(_:)) {
      hide()
      return true
    }
    return false
  }
}

// MARK: notes that stay

final class PinnedNotes {
  static let shared = PinnedNotes()
  private static let key = "PinnedNotes"

  private var panels: [String: NSPanel] = [:]

  private var saved: [[String: Any]] {
    get { UserDefaults.standard.array(forKey: Self.key) as? [[String: Any]] ?? [] }
    set { UserDefaults.standard.set(newValue, forKey: Self.key) }
  }

  var count: Int { saved.count }

  /// Put back the notes kept from before (at launch).
  func restore() { for n in saved { present(n) } }

  /// Pin `text`. The oldest goes when there would be more than PinMath.most.
  func add(_ text: String) {
    let line = PinMath.clean(text)
    guard !line.isEmpty else { return }
    var all = saved
    if let same = all.first(where: { $0["text"] as? String == line }), let id = same["id"] as? String { panels[id]?.orderFrontRegardless(); return }
    while all.count >= PinMath.most, let first = all.first {
      if let id = first["id"] as? String { panels[id]?.orderOut(nil); panels[id] = nil }
      all.removeFirst()
    }
    let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
    let at = PinMath.place(index: all.count, visible: visible)
    let note: [String: Any] = ["id": UUID().uuidString, "text": line, "x": Double(at.x), "y": Double(at.y)]
    all.append(note)
    saved = all
    present(note)
  }

  func clearAll() {
    panels.values.forEach { $0.orderOut(nil) }
    panels = [:]
    saved = []
  }

  private func remove(_ id: String) {
    panels[id]?.orderOut(nil)
    panels[id] = nil
    saved = saved.filter { $0["id"] as? String != id }
  }

  private func present(_ n: [String: Any]) {
    guard let id = n["id"] as? String, let text = n["text"] as? String, panels[id] == nil else { return }
    let font = NSFont.systemFont(ofSize: 13, weight: .medium)
    let bounds = (text as NSString).boundingRect(with: CGSize(width: PinMath.maxText, height: 200), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font])
    let size = PinMath.size(text: CGSize(width: ceil(bounds.width), height: ceil(bounds.height)))
    let p = Aurora.panel(label: "Pinned note from Echo")
    p.isMovableByWindowBackground = true
    let root = PinView(frame: CGRect(origin: .zero, size: size))
    root.wantsLayer = true
    // Settled glass: Echo is not saying this now, it is yours. A quiet hairline, no colour.
    root.layer?.backgroundColor = MarkArt.glass.cg(0.92)
    root.layer?.cornerRadius = 12
    root.layer?.borderWidth = 1
    root.layer?.borderColor = NSColor(white: 1, alpha: 0.18).cgColor
    let label = NSTextField(wrappingLabelWithString: text)
    label.font = font
    label.textColor = NSColor(white: 0.96, alpha: 1)
    label.frame = CGRect(x: 14, y: 10, width: size.width - 14 - 30, height: size.height - 20)
    root.addSubview(label)
    let close = NSButton(title: "✕", target: nil, action: nil)
    close.isBordered = false
    close.attributedTitle = NSAttributedString(string: "✕", attributes: [.font: NSFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: NSColor(white: 1, alpha: 0.6)])
    close.frame = CGRect(x: size.width - 26, y: size.height - 24, width: 18, height: 18)
    close.setAccessibilityLabel("Close this note")
    root.onClose = { [weak self] in self?.remove(id) }
    close.target = root
    close.action = #selector(PinView.closeClicked)
    root.addSubview(close)
    root.onMoved = { [weak self, weak p] in
      guard let self, let p else { return }
      self.saved = self.saved.map { var m = $0; if m["id"] as? String == id { m["x"] = Double(p.frame.minX); m["y"] = Double(p.frame.minY) }; return m }
    }
    p.contentView = root
    var origin = CGPoint(x: (n["x"] as? Double).map { CGFloat($0) } ?? 40, y: (n["y"] as? Double).map { CGFloat($0) } ?? 40)
    // A note saved on a screen that is gone comes back on the main one.
    if !NSScreen.screens.contains(where: { $0.frame.intersects(CGRect(origin: origin, size: size)) }), let v = NSScreen.main?.visibleFrame {
      origin = PinMath.place(index: panels.count, visible: v)
    }
    p.setFrame(CGRect(origin: origin, size: size), display: true)
    p.orderFrontRegardless()
    panels[id] = p
  }
}

private final class PinView: NSView {
  var onClose: (() -> Void)?
  var onMoved: (() -> Void)?
  @objc func closeClicked() { onClose?() }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseUp(with event: NSEvent) {
    super.mouseUp(with: event)
    onMoved?()
  }
}

// MARK: the light that keeps watch

/// "Keep an eye on it" (lib/watch.js): while Echo is watching a window for you, a small light of
/// its own sits just inside that window's top-right corner, beating slowly, and follows the
/// window if it moves. When the watch ends it flares once (it finished) or simply goes.
/// Each is a tiny click-through panel: it never takes the mouse.
final class WatchLights {
  static let shared = WatchLights()

  private var lights: [String: (panel: NSPanel, app: String)] = [:]
  private var timer: Timer?

  func add(id: String, app: String) {
    guard !id.isEmpty, !app.isEmpty, lights[id] == nil, lights.count < 3 else { return }
    let p = Aurora.panel(label: "Echo is keeping an eye on this window")
    p.ignoresMouseEvents = true
    p.hasShadow = false
    let root = NSView(frame: CGRect(x: 0, y: 0, width: 20, height: 20))
    root.wantsLayer = true
    let dot = CALayer()
    dot.frame = CGRect(x: 6, y: 6, width: 8, height: 8)
    dot.cornerRadius = 4
    dot.backgroundColor = NSColor.white.cgColor
    dot.shadowColor = MarkArt.answer[1].cg()
    dot.shadowOpacity = 1
    dot.shadowRadius = 7
    dot.shadowOffset = .zero
    root.layer?.addSublayer(dot)
    if !Motion.reduced {
      // A slow beat, so it reads as "watching" and not as a stuck pixel.
      let beat = CABasicAnimation(keyPath: "opacity")
      beat.fromValue = 1
      beat.toValue = 0.45
      beat.duration = 1.4
      beat.autoreverses = true
      beat.repeatCount = .infinity
      beat.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      dot.add(beat, forKey: "beat")
    }
    p.contentView = root
    p.setFrame(CGRect(x: -100, y: -100, width: 20, height: 20), display: false)
    lights[id] = (p, app)
    place()
    if timer == nil {
      timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.place() }
    }
  }

  /// The watch is over. `done`: it finished (a small flare first); else it just goes.
  func remove(id: String, done: Bool) {
    guard let l = lights.removeValue(forKey: id) else { return }
    if lights.isEmpty { timer?.invalidate(); timer = nil }
    guard done, !Motion.reduced, let dot = l.panel.contentView?.layer?.sublayers?.first else { return l.panel.orderOut(nil) }
    dot.removeAllAnimations()
    let flare = CABasicAnimation(keyPath: "transform.scale")
    flare.fromValue = 1
    flare.toValue = 2.2
    flare.duration = 0.45
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0
    fade.duration = 0.45
    dot.opacity = 0
    dot.add(flare, forKey: "flare")
    dot.add(fade, forKey: "fade")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { l.panel.orderOut(nil) }
  }

  func removeAll() {
    lights.values.forEach { $0.panel.orderOut(nil) }
    lights = [:]
    timer?.invalidate()
    timer = nil
  }

  /// Each light goes to its app's front window (hidden while that app has none on screen).
  private func place() {
    guard !lights.isEmpty else { return }
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let primary = NSScreen.screens.first?.frame.height ?? 0
    for (_, l) in lights {
      // The list is front to back: the first ordinary window of that app.
      let frame = windows.first(where: { w in
        (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
          && WatchMath.same(w[kCGWindowOwnerName as String] as? String ?? "", l.app)
          && ((w[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }?.width ?? 0) > 120
      }).flatMap { ($0[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } }
      guard let frame else { l.panel.orderOut(nil); continue }
      let at = WatchMath.spot(window: frame, primaryHeight: primary)
      if l.panel.frame.origin != at { l.panel.setFrameOrigin(at) }
      if !l.panel.isVisible { l.panel.orderFrontRegardless() }
    }
  }
}
