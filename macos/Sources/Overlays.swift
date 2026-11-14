// Echo's screen-wide signals, kept small so they never take room from you:
//
// - EdgeGlow: a thin (1.5 pt) white line just inside every screen's edge while Echo looks or
//   works on the Mac, following a MacBook display's rounded corners and stopping short of the
//   notch, with a soft dark edge (so it shows on a white page too) that breathes gently (still
//   with reduced motion).
// - StatusChip: ONE small chip of the island's black glass in the top-right corner that shows a
//   single state at a time (Looking, Driving, Clicking, Typing…; ChipMath.state picks it) and
//   crossfades between them. A few seconds after the last change it shrinks to a white dot.
//
// Both are click-through, non-activating panels (they never take focus or clicks), float on every
// Space and over full-screen apps, and are Echo's own windows, so they're never in a screenshot.
import AppKit

private func overlayPanel(_ frame: CGRect, level: NSWindow.Level) -> NSPanel {
  let p = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  p.isOpaque = false
  p.backgroundColor = .clear
  p.hasShadow = false
  p.ignoresMouseEvents = true // your clicks go through; any click of yours stops Echo
  p.level = level // never above menus, system alerts or the screen saver
  p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
  p.hidesOnDeactivate = false
  p.isReleasedWhenClosed = false
  p.animationBehavior = .none
  let view = NSView(frame: NSRect(origin: .zero, size: frame.size))
  view.wantsLayer = true
  p.contentView = view
  return p
}

// MARK: the edge glow

final class EdgeGlow {
  static let shared = EdgeGlow()

  enum Reason: Hashable { case looking, driving }
  private var reasons = Set<Reason>()
  private var panels: [NSPanel] = []
  private var fading: DispatchWorkItem?

  var showing: Bool { !panels.isEmpty && !reasons.isEmpty }

  func show(_ reason: Reason) {
    if !reasons.contains(reason) { BodyLink.shared.timeline("overlay.show", ["name": "edge", "reason": "\(reason)"]) }
    reasons.insert(reason)
    fading?.cancel()
    fading = nil
    if panels.isEmpty { build() }
    fade(to: 1)
  }

  func hide(_ reason: Reason) {
    if reasons.contains(reason) { BodyLink.shared.timeline("overlay.hide", ["name": "edge", "reason": "\(reason)"]) }
    reasons.remove(reason)
    guard reasons.isEmpty, !panels.isEmpty, fading == nil else { return }
    fade(to: 0)
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.reasons.isEmpty else { return }
      self.fading = nil
      self.panels.forEach { $0.close() }
      self.panels = []
    }
    fading = work
    DispatchQueue.main.asyncAfter(deadline: .now() + EdgeMath.fade + 0.05, execute: work)
  }

  /// The screens changed: the lines are drawn per screen, so draw them again for the ones there now.
  func screensChanged() {
    guard !panels.isEmpty else { return }
    panels.forEach { $0.close() }
    panels = []
    guard !reasons.isEmpty else { return }
    build()
    panels.forEach { $0.alphaValue = 1 }
  }

  func hideAll() {
    reasons = []
    fading?.cancel()
    fading = nil
    panels.forEach { $0.close() }
    panels = []
  }

  private func fade(to alpha: CGFloat) {
    let panels = self.panels
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = Motion.reduced ? 0.12 : EdgeMath.fade
      panels.forEach { $0.animator().alphaValue = alpha }
    }
  }

  private func build() {
    let reduce = Motion.reduced
    for screen in NSScreen.screens {
      // Just above ordinary windows: the menu bar, the Dock, menus and alerts stay on top of it.
      let p = overlayPanel(screen.frame, level: .floating)
      p.alphaValue = 0
      guard let layer = p.contentView?.layer else { continue }
      let bounds = CGRect(origin: .zero, size: screen.frame.size)
      // The line sits just inside the edge and follows the display's rounded corners (a MacBook's
      // built-in screen; external monitors are square), stopping either side of the notch.
      let notch: CGRect?
      if #available(macOS 12.0, *) {
        notch = EdgeMath.notch(size: bounds.size, left: screen.auxiliaryTopLeftArea, right: screen.auxiliaryTopRightArea)
      } else {
        notch = nil
      }
      let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
      let builtIn = id.map { CGDisplayIsBuiltin($0) != 0 } ?? false
      let path = EdgeMath.path(bounds, corner: EdgeMath.corner(builtIn: builtIn, notched: notch != nil), notch: notch)

      // The line: white, on a thin dark one and with a soft dark edge around it, so it reads on
      // a white page as well as a dark one.
      let under = CAShapeLayer()
      under.path = path
      under.fillColor = nil
      under.strokeColor = CGColor(gray: 0, alpha: 0.4)
      under.lineWidth = EdgeMath.line + 2
      layer.addSublayer(under)
      let glow = CAShapeLayer()
      glow.path = path
      glow.fillColor = nil
      glow.strokeColor = MarkArt.ink.cg(0.9)
      glow.lineWidth = EdgeMath.line
      glow.lineCap = .round
      glow.shadowColor = CGColor(gray: 0, alpha: 1)
      glow.shadowOffset = .zero
      glow.shadowRadius = CGFloat(EdgeMath.glowRadius.low)
      glow.shadowOpacity = Float(EdgeMath.glowOpacity.low)
      layer.addSublayer(glow)

      if !reduce {
        // Breathing: slow and gentle (its soft edge swells and eases, the line stays put).
        for (key, range) in [("shadowRadius", EdgeMath.glowRadius), ("shadowOpacity", EdgeMath.glowOpacity)] {
          let a = CABasicAnimation(keyPath: key)
          a.fromValue = range.low
          a.toValue = range.high
          a.duration = EdgeMath.breath / 2
          a.autoreverses = true
          a.repeatCount = .infinity
          a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
          glow.add(a, forKey: key)
        }
      }
      p.setAccessibilityLabel("Echo is using your screen. Press Escape to stop.")
      p.orderFrontRegardless()
      panels.append(p)
    }
  }
}

// MARK: the status chip

final class StatusChip {
  static let shared = StatusChip()

  private var looking = false
  private var driving = false
  private var doing: String?
  private var shown: String?

  private var panel: NSPanel?
  private var screenFrame = CGRect.null
  private let bg = CALayer()
  private let dot = CALayer()
  private let label = CATextLayer()
  private var collapseWork: DispatchWorkItem?
  private var hideWork: DispatchWorkItem?

  private let font = PillArt.font(11.5, .medium)

  /// Echo starts or stops looking at the screen.
  func setLooking(_ on: Bool, screen: NSScreen? = nil) {
    looking = on
    update(screen: screen)
  }

  /// A driving session starts or ends.
  func setDriving(_ on: Bool) {
    driving = on
    if !on { doing = nil }
    update(screen: nil)
  }

  /// The action under way ("click", "type_text", "scroll", "press_keys"), or nil when it's done.
  func setDoing(_ action: String?) {
    doing = action
    update(screen: nil)
  }

  func hideNow() {
    looking = false
    driving = false
    doing = nil
    update(screen: nil)
  }

  /// The screens changed: put a chip that's showing back in its corner of a screen that's there.
  func screensChanged() {
    screenFrame = .null
    guard shown != nil, let panel else { return }
    let target = ScreenLook.screen(for: FrontApp.target())
    panel.setFrame(ChipMath.frame(visible: target.visibleFrame), display: true)
    screenFrame = target.frame
  }

  private func update(screen: NSScreen?) {
    let next = ChipMath.state(looking: looking, driving: driving, doing: doing)
    guard next != shown else { return }
    let before = shown
    shown = next
    guard let text = next else { return scheduleHide() }
    hideWork?.cancel()
    hideWork = nil
    let p = ensurePanel(on: screen)
    let reduce = Motion.reduced
    CATransaction.begin()
    CATransaction.setAnimationDuration(reduce ? 0.12 : 0.28)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeInEaseOut))
    // Crossfade the words (an opacity-only change, fine with reduced motion).
    if before != nil {
      let fade = CATransition()
      fade.type = .fade
      fade.duration = reduce ? 0.12 : 0.24
      label.add(fade, forKey: "crossfade")
    }
    label.string = text
    label.opacity = 1
    layout(width: ChipMath.width(textWidth: textWidth(text)), animated: before != nil && !reduce)
    CATransaction.commit()
    p.setAccessibilityLabel("Echo: \(text)")
    if p.alphaValue < 1 {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = reduce ? 0.12 : 0.22
        p.animator().alphaValue = 1
      }
    }
    // A few seconds on, only the dot stays.
    collapseWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.collapse() }
    collapseWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + ChipMath.collapseAfter, execute: work)
  }

  private func collapse() {
    guard shown != nil else { return }
    CATransaction.begin()
    CATransaction.setAnimationDuration(Motion.reduced ? 0.12 : 0.35)
    label.opacity = 0
    layout(width: ChipMath.dotWidth, animated: !Motion.reduced)
    CATransaction.commit()
  }

  private func scheduleHide() {
    collapseWork?.cancel()
    guard let p = panel else { return }
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.shown == nil else { return }
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = Motion.reduced ? 0.12 : 0.25
        p.animator().alphaValue = 0
      }, completionHandler: { [weak self] in
        guard let self, self.shown == nil, self.panel === p else { return }
        p.orderOut(nil)
      })
    }
    hideWork?.cancel()
    hideWork = work
    // A short linger, so a quick look is still noticed.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
  }

  private func textWidth(_ s: String) -> CGFloat {
    ceil((s as NSString).size(withAttributes: [.font: font]).width)
  }

  /// The chip hugs the panel's right edge; only its width changes.
  private func layout(width w: CGFloat, animated: Bool) {
    CATransaction.setDisableActions(!animated)
    let h = ChipMath.height, m = ChipMath.margin, x = ChipMath.panelSize.width - m - w
    bg.frame = CGRect(x: x, y: m, width: w, height: h)
    dot.frame = CGRect(x: x + ChipMath.dotInset, y: m + (h - ChipMath.dot) / 2, width: ChipMath.dot, height: ChipMath.dot)
    label.frame = CGRect(x: x + ChipMath.textX, y: m + (h - 15) / 2, width: max(0, w - ChipMath.textX - ChipMath.padRight), height: 15)
  }

  private func ensurePanel(on screen: NSScreen?) -> NSPanel {
    let target = screen ?? ScreenLook.screen(for: FrontApp.target())
    let frame = ChipMath.frame(visible: target.visibleFrame)
    if let panel {
      if screenFrame != target.frame { panel.setFrame(frame, display: false); screenFrame = target.frame }
      panel.orderFrontRegardless()
      return panel
    }
    let p = overlayPanel(frame, level: .statusBar)
    p.alphaValue = 0
    screenFrame = target.frame
    let root = p.contentView!.layer!
    bg.backgroundColor = MarkArt.glass.cg(0.86)
    bg.cornerRadius = ChipMath.height / 2
    bg.borderColor = RGB.white.cg(MarkArt.hairline)
    bg.borderWidth = 1
    bg.shadowColor = CGColor(gray: 0, alpha: 1)
    bg.shadowOpacity = 0.3
    bg.shadowRadius = 8
    bg.shadowOffset = CGSize(width: 0, height: -2)
    root.addSublayer(bg)
    dot.cornerRadius = ChipMath.dot / 2
    dot.backgroundColor = MarkArt.ink.cg()
    if !Motion.reduced {
      let pulse = CABasicAnimation(keyPath: "opacity")
      pulse.fromValue = 1
      pulse.toValue = 0.45
      pulse.duration = 1.2
      pulse.autoreverses = true
      pulse.repeatCount = .infinity
      pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      dot.add(pulse, forKey: "pulse")
    }
    root.addSublayer(dot)
    label.font = font
    label.fontSize = 11.5
    label.foregroundColor = MarkArt.ink.cg()
    label.contentsScale = target.backingScaleFactor
    label.truncationMode = .end
    root.addSublayer(label)
    p.setAccessibilityRole(.group)
    p.orderFrontRegardless()
    panel = p
    return p
  }
}
