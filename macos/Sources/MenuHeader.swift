// The top of the menu bar menu: Echo's pearl, small, beside "Echo" and one line saying what it is
// doing right now (StatusMenuMath.statusLine, PointMath.swift). It is a picture, not a menu item you
// can choose.
import AppKit

final class MenuHeaderView: NSView {
  private static let diameter: CGFloat = 26
  private let art = PearlArt()
  private let name = NSTextField(labelWithString: "Echo")
  private let status = NSTextField(labelWithString: "")

  init() {
    super.init(frame: NSRect(x: 0, y: 0, width: 240, height: 46))
    autoresizingMask = [.width]
    art.diameter = Self.diameter
    // A still pearl: the menu shows its mood, it doesn't animate.
    art.reduced = true
    let left = 14 + Self.diameter + 10
    name.font = .systemFont(ofSize: 13, weight: .semibold)
    name.textColor = .labelColor
    status.font = .systemFont(ofSize: 11)
    status.textColor = .secondaryLabelColor
    status.lineBreakMode = .byTruncatingTail
    for (label, y) in [(name, 24.0), (status, 8.0)] {
      label.frame = NSRect(x: left, y: y, width: bounds.width - left - 14, height: label === name ? 17 : 15)
      label.autoresizingMask = [.width]
      addSubview(label)
    }
    setAccessibilityElement(true)
    setAccessibilityRole(.staticText)
  }

  required init?(coder: NSCoder) { nil }

  /// The line, and the pearl's mood to go with it: `voice` (idle, listening, thinking, speaking),
  /// working on the Mac, or needing you (a permission is missing).
  func show(line: String, voice: String, working: Bool, needsYou: Bool) {
    let skin = CompanionLook.wear()
    guard status.stringValue != line || art.voice != voice || art.working != working || art.asking != needsYou || art.skin != skin else { return }
    status.stringValue = line
    setAccessibilityLabel("Echo, \(line)")
    art.voice = voice
    art.working = working
    art.asking = needsYou
    art.skin = skin
    // Stepped to rest in its mood, as the island steps it (Caption.swift), then drawn once.
    let now = CACurrentMediaTime()
    for i in 0..<96 { art.step(now: now - Double(96 - i) / 60, dt: 1.0 / 60) }
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    art.draw(in: ctx, at: CGPoint(x: 14 + Self.diameter / 2, y: bounds.midY), now: CACurrentMediaTime(), pixelScale: window?.backingScaleFactor ?? 2)
  }
}
