import AppKit

// Asking at the thing: when a step is risky and waits for your yes, the question and its two
// buttons appear beside the thing Echo is about to press, where you are already looking. The card
// in the island and in Echo's window stays (it is the record); a click here answers it the same
// way (CaptionBar.onConfirm). Its own small panel, so it can take a click while the rest of
// Echo's overlay lets clicks through. Placed by BubbleMath.origin like the caption beside the light.
final class AskBubble {
  static let shared = AskBubble()

  private var panel: NSPanel?
  private var shown = ""
  private static let font = NSFont.systemFont(ofSize: 13, weight: .medium)
  private static let buttonFont = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
  static let maxText: CGFloat = 230, pad: CGFloat = 14, buttonHeight: CGFloat = 26

  private static func textSize(_ s: String) -> CGSize {
    let r = (s as NSString).boundingRect(with: CGSize(width: maxText, height: 200), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font])
    return CGSize(width: ceil(r.width), height: ceil(r.height))
  }
  private static func buttonWidth(_ s: String) -> CGFloat { ceil((s as NSString).size(withAttributes: [.font: buttonFont]).width) + 26 }

  /// How big it is for this question and these two button titles.
  static func size(question: String, action: String, cancel: String) -> CGSize {
    AskMath.size(text: textSize(question), buttons: [buttonWidth(cancel), buttonWidth(action)])
  }

  /// Show it with its bottom-left corner at `origin` (screen coordinates).
  func show(question: String, action: String, cancel: String, origin: CGPoint) {
    let key = [question, action, cancel, "\(Int(origin.x)),\(Int(origin.y))"].joined(separator: "\u{1}")
    if key == shown, panel?.isVisible == true { return }
    shown = key
    let size = Self.size(question: question, action: action, cancel: cancel)
    let p: NSPanel
    if let panel { p = panel } else {
      p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      p.isOpaque = false
      p.backgroundColor = .clear
      p.hasShadow = true
      p.level = .statusBar
      p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
      p.hidesOnDeactivate = false
      p.becomesKeyOnlyIfNeeded = true
      p.isReleasedWhenClosed = false
      p.animationBehavior = .none
      p.setAccessibilityLabel("Echo asks before a step")
      panel = p
    }
    let root = NSView(frame: CGRect(origin: .zero, size: size))
    root.wantsLayer = true
    root.layer?.backgroundColor = MarkArt.glass.cg(0.94)
    root.layer?.cornerRadius = 14
    root.layer?.borderWidth = 1.5
    // Amber: the colour of "needs you", as on the light while it waits.
    root.layer?.borderColor = RGB(hex: PearlMath.lightColours("ask")[0]).cg()
    let text = Self.textSize(question)
    let label = NSTextField(wrappingLabelWithString: question)
    label.font = Self.font
    label.textColor = NSColor(white: 0.97, alpha: 1)
    label.frame = CGRect(x: Self.pad, y: size.height - Self.pad - text.height, width: size.width - Self.pad * 2, height: text.height)
    root.addSubview(label)
    // The safe answer on the left, the step itself on the right; neither is a default (Return does nothing here).
    let wNo = Self.buttonWidth(cancel), wYes = Self.buttonWidth(action)
    let no = button(cancel, primary: false, #selector(noClicked))
    no.frame = CGRect(x: size.width - Self.pad - wYes - 8 - wNo, y: Self.pad - 2, width: wNo, height: Self.buttonHeight)
    let yes = button(action, primary: true, #selector(yesClicked))
    yes.frame = CGRect(x: size.width - Self.pad - wYes, y: Self.pad - 2, width: wYes, height: Self.buttonHeight)
    root.addSubview(no)
    root.addSubview(yes)
    p.contentView = root
    p.setFrame(CGRect(origin: CGPoint(x: origin.x.rounded(), y: origin.y.rounded()), size: size), display: true)
    p.alphaValue = 1
    p.orderFrontRegardless()
  }

  func hide() {
    guard shown != "" || panel?.isVisible == true else { return }
    shown = ""
    panel?.orderOut(nil)
  }

  var showing: Bool { panel?.isVisible ?? false }

  private func button(_ title: String, primary: Bool, _ action: Selector) -> NSButton {
    let b = NSButton(title: title, target: self, action: action)
    b.isBordered = false
    b.wantsLayer = true
    b.layer?.cornerRadius = Self.buttonHeight / 2
    b.layer?.backgroundColor = primary ? NSColor(white: 0.96, alpha: 1).cgColor : NSColor(white: 1, alpha: 0.08).cgColor
    if !primary { b.layer?.borderWidth = 1; b.layer?.borderColor = NSColor(white: 1, alpha: 0.16).cgColor }
    b.attributedTitle = NSAttributedString(string: title, attributes: [.font: Self.buttonFont, .foregroundColor: primary ? NSColor.black : NSColor(white: 0.94, alpha: 1)])
    b.setAccessibilityLabel(title)
    return b
  }

  @objc private func yesClicked() { hide(); CaptionBar.shared.onConfirm?(true) }
  @objc private func noClicked() { hide(); CaptionBar.shared.onConfirm?(false) }
}
