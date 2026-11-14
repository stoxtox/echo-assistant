// The permissions checklist: a small native window with one row per Mac permission Echo uses
// (its name, what Echo uses it for, what macOS says about it right now, and one button), shown the
// first time Echo opens, whenever a required one is missing at launch, and from "Permissions…" in
// the menu bar item.
//
// It looks like the island: near-black, white words, hairlines, and the logo's three bars at the
// top. The only colour is the logo's third bar, which lights up when everything is allowed. In
// the light appearance the same drawing is dark on white.
//
// Which rows, their words and where things sit are PermMath's (PointMath.swift, checked in
// macos/Tests/main.swift). What macOS says, and asking it, come in from outside (PushToTalk.swift's
// Permissions, wired up in main.swift), so this file draws the same in the render harness
// (macos/Tests/Render) as in the app.
import AppKit

enum PermissionsArt {
  struct Palette {
    let back: RGB, ink: RGB, dim: RGB
    /// The hairline's colour and how strong it is.
    let line: RGB, lineAlpha: CGFloat
    static let dark = Palette(back: MarkArt.glass, ink: MarkArt.ink, dim: MarkArt.dim, line: .white, lineAlpha: MarkArt.hairline)
    static let light = Palette(back: RGB(r: 250, g: 250, b: 252), ink: RGB(r: 20, g: 20, b: 24), dim: MarkArt.grey, line: RGB(r: 0, g: 0, b: 0), lineAlpha: 0.13)
  }
  static func palette(light: Bool) -> Palette { light ? .light : .dark }

  static let titleFont = PillArt.font(19, .semibold)
  static let detailFont = PillArt.font(12.5, .regular)
  static let nameFont = PillArt.font(13.5, .semibold)
  static let tagFont = PillArt.font(11, .regular)
  static let sentenceFont = PillArt.font(12, .regular)
  static let stateFont = PillArt.font(12, .medium)
  static let buttonFont = PillArt.font(12.5, .medium)
  static let doneFont = PillArt.font(13, .semibold)

  static func width(_ text: String, _ font: NSFont) -> CGFloat {
    ceil((text as NSString).size(withAttributes: [.font: font]).width)
  }

  private static func text(_ s: String, _ font: NSFont, _ color: CGColor, in r: CGRect, align: NSTextAlignment = .left) {
    let para = NSMutableParagraphStyle()
    para.alignment = align
    para.lineBreakMode = .byWordWrapping
    para.lineSpacing = 1.5
    let str = NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: NSColor(cgColor: color) ?? .white, .paragraphStyle: para])
    str.draw(with: r, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
  }

  /// The whole window but its buttons (they are real buttons over it, drawn by `button`), in
  /// `bounds` (y up), into the current graphics context.
  static func draw(_ m: PermMath.Model, in bounds: CGRect, light: Bool) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let p = palette(light: light), n = m.rows.count
    ctx.setFillColor(p.back.cg())
    ctx.fill(bounds)

    // The logo's three bars: what you said, it fading, and the answer. The answer is grey until
    // everything is allowed; then it is the only colour in the window.
    let thick: CGFloat = 7
    let bars = PermMath.bars(thick: thick)
    let markWidth = bars[0].width, markHeight = bars[2].maxY
    let top = bounds.maxY - 34
    let left = (bounds.midX - markWidth / 2).rounded()
    for (i, b) in bars.enumerated() {
      let r = CGRect(x: left + b.minX, y: top - b.maxY, width: b.width, height: b.height)
      let path = CGPath(roundedRect: r, cornerWidth: thick / 2, cornerHeight: thick / 2, transform: nil)
      if i == 2, m.overall == .allSet, let space = CGColorSpace(name: CGColorSpace.sRGB),
         let g = CGGradient(colorsSpace: space, colors: MarkArt.answer.map { $0.cg() } as CFArray, locations: MarkArt.answerStops) {
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        ctx.drawLinearGradient(g, start: CGPoint(x: r.minX, y: r.midY), end: CGPoint(x: r.maxX, y: r.midY), options: [])
        ctx.restoreGState()
      } else {
        ctx.addPath(path)
        ctx.setFillColor(p.ink.cg([1, 0.42, 0.2][i]))
        ctx.fillPath()
      }
    }

    let inner = bounds.insetBy(dx: PermMath.pad, dy: 0)
    let titleTop = top - markHeight - 16
    text(PermMath.title(m), titleFont, p.ink.cg(), in: CGRect(x: inner.minX, y: titleTop - 26, width: inner.width, height: 26), align: .center)
    text(PermMath.detail(m), detailFont, p.dim.cg(), in: CGRect(x: inner.minX + 20, y: titleTop - 26 - 8 - 36, width: inner.width - 40, height: 36), align: .center)

    func hairline(_ y: CGFloat) {
      ctx.setFillColor(p.line.cg(p.lineAlpha))
      ctx.fill(CGRect(x: inner.minX, y: y - 0.5, width: inner.width, height: 1))
    }

    for (i, row) in m.rows.enumerated() {
      let r = PermMath.rowRect(i, of: n), state = m.state(row)
      hairline(r.maxY)
      // A dot that says it at a glance: filled once allowed, a ring until then.
      let dot = CGRect(x: inner.minX + 1, y: r.maxY - 27, width: 8, height: 8)
      if state == .allowed {
        ctx.setFillColor(p.ink.cg())
        ctx.fillEllipse(in: dot)
      } else {
        ctx.setStrokeColor(p.dim.cg())
        ctx.setLineWidth(1.25)
        ctx.strokeEllipse(in: dot.insetBy(dx: 0.6, dy: 0.6))
      }
      let x = inner.minX + 22
      text(row.name, nameFont, p.ink.cg(), in: CGRect(x: x, y: r.maxY - 33, width: PermMath.textWidth, height: 18))
      text(PermMath.tag(row), tagFont, p.dim.cg(), in: CGRect(x: x + width(row.name, nameFont) + 8, y: r.maxY - 33, width: 100, height: 16))
      text(PermMath.sentence(row, state), sentenceFont, p.dim.cg(), in: CGRect(x: x, y: r.maxY - 37 - 32, width: PermMath.textWidth, height: 32))
      // What macOS says. With no button under it (allowed), it sits in the middle of the row.
      let stateColor = state == .notYet ? p.dim.cg() : p.ink.cg()
      let stateY = state == .allowed ? r.midY - 8 : r.maxY - 32
      text(state.label, stateFont, stateColor, in: CGRect(x: inner.maxX - PermMath.side, y: stateY, width: PermMath.side, height: 16), align: .right)
    }

    // Automation has no row: macOS only asks about it app by app, at the moment Echo first needs it.
    let noteTop = PermMath.footerHeight + PermMath.note
    hairline(noteTop)
    text("Automation: macOS asks by itself the first time Echo works in another app, such as Messages or Calendar.",
         tagFont, p.dim.cg(), in: CGRect(x: inner.minX, y: noteTop - 9 - 34, width: inner.width, height: 34))
    hairline(PermMath.footerHeight)
    text(PermMath.footer(m), detailFont, m.overall == .needs ? p.dim.cg() : p.ink.cg(),
         in: CGRect(x: inner.minX, y: PermMath.footerHeight / 2 - 8, width: inner.width - 110, height: 16))
  }

  /// A capsule button: filled with the ink colour (Allow, Done), or a hairline with ink words
  /// (Open Settings), as the island's buttons are.
  static func button(_ title: String, _ font: NSFont, in r: CGRect, filled: Bool, light: Bool, pressed: Bool) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let p = palette(light: light)
    let capsule = CGPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerWidth: r.height / 2 - 0.5, cornerHeight: r.height / 2 - 0.5, transform: nil)
    ctx.addPath(capsule)
    if filled {
      ctx.setFillColor(p.ink.cg(pressed ? 0.78 : 1))
      ctx.fillPath()
    } else {
      ctx.setFillColor(p.ink.cg(pressed ? 0.14 : 0.05))
      ctx.fillPath()
      ctx.addPath(capsule)
      ctx.setStrokeColor(p.line.cg(p.lineAlpha * 1.6))
      ctx.setLineWidth(1)
      ctx.strokePath()
    }
    let h = ceil(font.ascender - font.descender)
    text(title, font, (filled ? p.back : p.ink).cg(), in: CGRect(x: r.minX, y: r.midY - h / 2 + 0.5, width: r.width, height: h), align: .center)
  }
}

/// One of the window's buttons: a real button (it can be tabbed to, pressed with Space, and
/// VoiceOver reads it), drawn as a capsule.
final class PermissionsButton: NSButton {
  var filled = false
  private var pressed = false
  var onPress: (() -> Void)?

  init(_ title: String, font: NSFont, filled: Bool, frame: CGRect) {
    super.init(frame: frame)
    self.title = title
    self.font = font
    self.filled = filled
    isBordered = false
    setButtonType(.momentaryChange)
    target = self
    action = #selector(press)
  }
  required init?(coder: NSCoder) { nil }

  @objc private func press() { onPress?() }

  override func mouseDown(with event: NSEvent) {
    pressed = true
    needsDisplay = true
    super.mouseDown(with: event) // follows the mouse until it is let go
    pressed = false
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    let light = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua
    PermissionsArt.button(title, font ?? PermissionsArt.buttonFont, in: bounds, filled: filled, light: light, pressed: pressed || isHighlighted)
  }
}

final class PermissionsView: NSView {
  /// What it shows. Setting the same thing again changes nothing (a press under way is kept).
  var model: PermMath.Model {
    didSet {
      guard model != oldValue else { return }
      rebuild()
    }
  }
  /// A row's button was pressed: the permission, and whether it was "Allow" (macOS's prompt) or
  /// "Open Settings".
  var onAct: ((String, Bool) -> Void)?
  var onDone: (() -> Void)?

  init(model: PermMath.Model) {
    self.model = model
    super.init(frame: CGRect(origin: .zero, size: PermMath.size(rows: model.rows.count)))
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    rebuild()
  }
  required init?(coder: NSCoder) { nil }

  private func rebuild() {
    subviews.forEach { $0.removeFromSuperview() }
    let n = model.rows.count
    for (i, row) in model.rows.enumerated() {
      let state = model.state(row)
      guard let title = PermMath.button(row, state, asked: model.asked.contains(row.id)) else { continue }
      let allow = title == "Allow"
      let b = PermissionsButton(title, font: PermissionsArt.buttonFont, filled: allow,
                                frame: PermMath.buttonRect(i, of: n, labelWidth: PermissionsArt.width(title, PermissionsArt.buttonFont)))
      b.setAccessibilityLabel(allow ? "Allow \(row.name)" : "Open Settings for \(row.name)")
      b.onPress = { [weak self] in self?.onAct?(row.id, allow) }
      addSubview(b)
    }
    if model.overall != .needs {
      let b = PermissionsButton("Done", font: PermissionsArt.doneFont, filled: true,
                                frame: PermMath.doneRect(labelWidth: PermissionsArt.width("Done", PermissionsArt.doneFont)))
      b.keyEquivalent = "\r"
      b.onPress = { [weak self] in self?.onDone?() }
      addSubview(b)
    }
    // For VoiceOver: the whole list in words, as it is drawn.
    let lines = model.rows.map { "\($0.name), \(PermMath.tag($0).lowercased()): \(model.state($0).label). \(PermMath.sentence($0, model.state($0)))" }
    setAccessibilityLabel(([PermMath.title(model) + ". " + PermMath.detail(model)] + lines).joined(separator: " "))
    needsDisplay = true
  }

  override func viewDidChangeEffectiveAppearance() {
    needsDisplay = true
    subviews.forEach { $0.needsDisplay = true }
  }

  override func draw(_ dirtyRect: NSRect) {
    PermissionsArt.draw(model, in: bounds, light: effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua)
  }
}

/// The window itself. `read` says what macOS says now; `act` asks macOS (or opens System
/// Settings) for one permission. While it is open it reads again every 2 seconds, and whoever
/// owns it calls `refresh()` when the app comes to the front.
final class PermissionsWindow: NSObject, NSWindowDelegate {
  private let read: () -> PermMath.Model
  private let act: (String, Bool) -> Void
  private var window: NSWindow?
  private var view: PermissionsView?
  private var timer: Timer?

  init(read: @escaping () -> PermMath.Model, act: @escaping (String, Bool) -> Void) {
    self.read = read
    self.act = act
  }

  var showing: Bool { window?.isVisible == true }

  func show() {
    let model = read()
    if window == nil {
      let v = PermissionsView(model: model)
      v.onAct = { [weak self] id, allow in
        self?.act(id, allow)
        self?.refresh()
      }
      v.onDone = { [weak self] in self?.window?.close() }
      let w = NSWindow(contentRect: CGRect(origin: .zero, size: v.frame.size), styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
      w.title = "Echo Permissions"
      w.titleVisibility = .hidden
      w.titlebarAppearsTransparent = true
      w.isMovableByWindowBackground = true
      w.isReleasedWhenClosed = false
      w.standardWindowButton(.miniaturizeButton)?.isHidden = true
      w.standardWindowButton(.zoomButton)?.isHidden = true
      w.contentView = v
      w.delegate = self
      w.center()
      window = w
      view = v
    }
    refresh()
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
  }

  /// Reads the states again. The window keeps its top edge where it is if its rows changed.
  func refresh() {
    guard let window, let view else { return }
    let model = read()
    let size = PermMath.size(rows: model.rows.count)
    if view.frame.size != size {
      var f = window.frameRect(forContentRect: CGRect(origin: .zero, size: size))
      f.origin = CGPoint(x: window.frame.minX, y: window.frame.maxY - f.height)
      window.setFrame(f, display: true)
    }
    view.model = model
  }

  func windowWillClose(_ note: Notification) {
    timer?.invalidate()
    timer = nil
  }
}
