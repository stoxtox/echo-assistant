// The island's reply field: answer Echo by typing, from any app, on whichever screen the island
// is on. For when you're working elsewhere and can't (or don't want to) answer out loud.
//
// - Beside the island sits a small keyboard chip (the same black glass, a white glyph). Click it
//   and a slim field opens just under the island (never over it), ready to type.
// - When Echo ends a reply with a question (the page's `asks`), the field opens by itself, but it
//   doesn't take the keyboard: whatever you're typing in stays where it is. Click it to answer.
// - Enter sends what you typed to Echo exactly like a message typed in her window
//   (window.echoNative.captionSend → user_text). Escape closes it back to the chip and gives the
//   keyboard back. It closes by itself when the pill goes.
// - Its panel never activates Echo (a non-activating panel that becomes key only when you click
//   into the field), floats on every Space, and follows the pill (Caption.swift calls follow).
import AppKit

/// A panel that can take the keyboard when you click into it, without bringing Echo forward.
private final class ReplyPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

/// A text field that works on the first click in a panel that isn't key yet.
private final class ReplyTextField: NSTextField {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) {
    window?.makeKey()
    super.mouseDown(with: event)
  }
}

private final class ChipButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class ReplyField: NSObject, NSTextFieldDelegate {
  static let shared = ReplyField()

  /// Send this to Echo (like a typed chat message).
  var onSend: ((String) -> Void)?
  /// Opened or closed: the pill stays up while it's open.
  var onChange: (() -> Void)?

  /// The field is open (offered or clicked).
  private(set) var expanded = false
  private var panel: ReplyPanel?
  private let glass = NSVisualEffectView()
  private let tint = CALayer()
  private var chip: ChipButton!
  private var field: ReplyTextField!
  private var hint: NSTextField!
  /// Where the pill is (screen coordinates) and its screen's visible frame; nil while it's hidden.
  private var pill: CGRect?
  private var visible = CGRect.zero
  private var driving = false

  /// The panel's window number, or nil.
  var windowNumber: Int? { panel?.windowNumber }

  /// Is the field taking the keyboard?
  var typing: Bool { expanded && (panel?.isKeyWindow ?? false) }

  /// The pill moved, resized, appeared (a frame) or went (nil). `driving`: Echo is acting on the
  /// screen, so the resting chip steps aside (an open field stays).
  func follow(pill p: CGRect?, visible v: CGRect, driving d: Bool) {
    driving = d
    guard let p else {
      pill = nil
      if expanded && typing && !field.stringValue.isEmpty { return } // mid-answer: keep it
      collapse(giveBack: true)
      panel?.orderOut(nil)
      layoutAnswers(field: nil)
      return
    }
    let changed = pill != p || visible != v
    let appeared = pill == nil
    pill = p
    visible = v
    // The pill just came up for Echo's question: the field opens with it.
    if appeared && offered && !expanded { return setExpanded(true) }
    if changed || panel?.isVisible != true { layout() }
  }

  /// The likely answers to Echo's question ("Yes", "No"), as buttons under the open field.
  private var answers: [String] = []
  private var answersPanel: ReplyPanel?
  func setChips(_ chips: [String]) {
    let c = chips.prefix(3).map { String($0.prefix(28)) }.filter { !$0.isEmpty }
    guard c != answers else { return }
    answers = c
    layout()
  }

  /// One tap of the talk key while the field is offered: the cursor goes there (you asked for it).
  @discardableResult
  func focusIfOffered() -> Bool {
    guard expanded, !(panel?.isKeyWindow ?? false) else { return false }
    focus()
    return true
  }

  @objc private func answerClicked(_ sender: NSButton) {
    let text = sender.title
    if !text.isEmpty { onSend?(text) }
    collapse(giveBack: true)
  }

  /// The row of quick answers for the field at `r` (screen coordinates), or none.
  private func layoutAnswers(field r: CGRect?) {
    guard let r, expanded, !answers.isEmpty else { answersPanel?.orderOut(nil); return }
    let p: ReplyPanel
    if let answersPanel { p = answersPanel } else {
      p = ReplyPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      p.isOpaque = false
      p.backgroundColor = .clear
      p.hasShadow = true
      p.level = .statusBar
      p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
      p.hidesOnDeactivate = false
      p.becomesKeyOnlyIfNeeded = true
      p.isReleasedWhenClosed = false
      p.animationBehavior = .none
      p.setAccessibilityLabel("Quick answers to Echo")
      answersPanel = p
    }
    let font = PillArt.font(13, .medium)
    let widths = answers.map { ceil(($0 as NSString).size(withAttributes: [.font: font]).width) + 26 }
    let frame = PillMath.replyAnswers(field: r, widths: widths, visible: visible)
    let root = NSView(frame: CGRect(origin: .zero, size: frame.size))
    var x: CGFloat = 0
    for (i, title) in answers.enumerated() {
      let b = ChipButton(title: title, target: self, action: #selector(answerClicked(_:)))
      b.isBordered = false
      b.wantsLayer = true
      b.layer?.backgroundColor = MarkArt.glass.cg(0.9)
      b.layer?.cornerRadius = PillMath.answerHeight / 2
      b.layer?.borderWidth = 1
      b.layer?.borderColor = RGB.white.cg(0.22)
      b.attributedTitle = NSAttributedString(string: title, attributes: [.font: font, .foregroundColor: NSColor(white: 0.96, alpha: 1)])
      b.frame = CGRect(x: x, y: 0, width: widths[i], height: PillMath.answerHeight)
      b.setAccessibilityLabel("Answer \(title)")
      root.addSubview(b)
      x += widths[i] + PillMath.answerGap
    }
    p.contentView = root
    if p.frame != frame { p.setFrame(frame, display: true) }
    if !p.isVisible { p.orderFrontRegardless() }
  }

  /// Echo is waiting for an answer (true: open the field when the pill is up, without taking the
  /// keyboard) or not any more (false: an untouched offered field closes again).
  private var offered = false
  func setAsking(_ asking: Bool) {
    guard asking != offered else { return }
    offered = asking
    if asking {
      if pill != nil { setExpanded(true) }
    } else if expanded && !typing && field.stringValue.isEmpty {
      collapse(giveBack: false)
    }
  }

  /// Closed and gone, whatever it was doing (the pill was reset or closed: Caption.swift).
  /// `keepDraft`: an open field with words in it stays as it is, words and all.
  func reset(keepDraft: Bool = false) {
    offered = false
    if keepDraft, expanded, !(field?.stringValue ?? "").isEmpty { return }
    if expanded { collapse(giveBack: true) }
    pill = nil
    answers = []
    panel?.orderOut(nil)
    layoutAnswers(field: nil)
  }

  /// The chip was clicked: open the field and take the keyboard (you asked for it).
  @objc private func chipClicked() {
    setExpanded(true)
    focus()
  }

  /// Back to the chip. `giveBack`: hand the keyboard back to the app you were in.
  func collapse(giveBack: Bool = true) {
    guard expanded else { return }
    offered = false
    field?.stringValue = ""
    let hadKeyboard = panel?.isKeyWindow ?? false
    setExpanded(false)
    if giveBack && hadKeyboard, let panel {
      // Ordering out a non-activating panel returns key to the app in front; then the chip returns.
      panel.orderOut(nil)
      DispatchQueue.main.async { [weak self] in self?.layout() }
    }
  }

  private func focus() {
    guard let panel else { return }
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(field)
  }

  private func setExpanded(_ on: Bool) {
    guard on != expanded else { return layout() }
    expanded = on
    layout()
    onChange?()
  }

  // MARK: Enter and Escape

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    if selector == #selector(NSResponder.insertNewline(_:)) {
      let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty { onSend?(text) }
      collapse(giveBack: true)
      return true
    }
    if selector == #selector(NSResponder.cancelOperation(_:)) {
      collapse(giveBack: true)
      return true
    }
    return false
  }

  func controlTextDidChange(_ obj: Notification) {
    hint.alphaValue = field.stringValue.isEmpty ? 0.35 : 0.8
  }

  func controlTextDidEndEditing(_ obj: Notification) {
    // Clicked away with nothing typed: it can go back to the chip.
    if field.stringValue.isEmpty && !(panel?.isKeyWindow ?? false) { setRing(false) }
  }

  // MARK: the panel

  private func ensurePanel() -> ReplyPanel {
    if let panel { return panel }
    let p = ReplyPanel(contentRect: NSRect(x: 0, y: 0, width: PillMath.chip, height: PillMath.chip),
                       styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.level = .statusBar // with the pill: below menus and system alerts
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.hidesOnDeactivate = false
    p.becomesKeyOnlyIfNeeded = true
    p.isReleasedWhenClosed = false
    p.animationBehavior = .none
    p.setAccessibilityLabel("Reply to Echo")

    let root = NSView(frame: p.contentLayoutRect)
    root.wantsLayer = true
    glass.material = .hudWindow
    glass.blendingMode = .behindWindow
    glass.state = .active
    glass.appearance = NSAppearance(named: .vibrantDark)
    glass.wantsLayer = true
    glass.layer?.masksToBounds = true
    glass.autoresizingMask = [.width, .height]
    glass.frame = root.bounds
    root.addSubview(glass)
    // The island's glass over the blur, and its hairline (brighter while you type).
    tint.backgroundColor = MarkArt.glass.cg(0.86)
    tint.borderColor = RGB.white.cg(MarkArt.hairline)
    tint.borderWidth = 1
    glass.layer?.addSublayer(tint)

    let c = ChipButton(title: "", target: self, action: #selector(chipClicked))
    c.isBordered = false
    c.imagePosition = .imageOnly
    let conf = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
    c.image = NSImage(systemSymbolName: "keyboard", accessibilityDescription: "Type a reply")?.withSymbolConfiguration(conf)
    c.contentTintColor = NSColor(white: 0.96, alpha: 0.85)
    c.toolTip = "Type to Echo"
    c.setAccessibilityLabel("Type a reply to Echo")
    root.addSubview(c)
    chip = c

    let f = ReplyTextField()
    f.isBordered = false
    f.drawsBackground = false
    f.focusRingType = .none
    f.isBezeled = false
    f.font = PillArt.font(14, .regular)
    f.textColor = NSColor(white: 0.95, alpha: 1)
    f.cell?.usesSingleLineMode = true
    f.cell?.wraps = false
    f.cell?.isScrollable = true
    f.placeholderAttributedString = NSAttributedString(string: "Reply to Echo…", attributes: [
      .foregroundColor: NSColor(white: 1, alpha: 0.42), .font: PillArt.font(14, .regular),
    ])
    f.delegate = self
    f.setAccessibilityLabel("Reply to Echo")
    root.addSubview(f)
    field = f

    let h = NSTextField(labelWithString: "↵")
    h.font = PillArt.font(12, .medium)
    h.textColor = NSColor(white: 0.96, alpha: 1)
    h.alphaValue = 0.35
    h.setAccessibilityElement(false)
    root.addSubview(h)
    hint = h

    p.contentView = root
    NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: p, queue: .main) { [weak self] _ in self?.setRing(true) }
    NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: p, queue: .main) { [weak self] _ in self?.setRing(false) }
    panel = p
    return p
  }

  /// The hairline brightens while the field has the keyboard.
  private func setRing(_ on: Bool) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(Motion.reduced ? 0 : 0.2)
    tint.borderColor = RGB.white.cg(on && expanded ? 0.5 : MarkArt.hairline)
    CATransaction.commit()
  }

  /// Size, place and show (or hide) for the pill's current frame.
  private func layout() {
    guard let pill else { panel?.orderOut(nil); layoutAnswers(field: nil); return }
    // Resting chip while Echo drives: out of the way of what she's clicking.
    if !expanded && driving { panel?.orderOut(nil); layoutAnswers(field: nil); return }
    let p = ensurePanel()
    let r = expanded ? PillMath.replyField(pill: pill, visible: visible) : PillMath.replyChip(pill: pill, visible: visible)
    if p.frame != r { p.setFrame(r, display: false) }
    let b = CGRect(origin: .zero, size: r.size)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    glass.frame = b
    glass.layer?.cornerRadius = b.height / 2
    tint.frame = b
    tint.cornerRadius = b.height / 2
    CATransaction.commit()
    chip.frame = b
    chip.isHidden = expanded
    field.isHidden = !expanded
    hint.isHidden = !expanded
    if expanded {
      let fh: CGFloat = 20
      field.frame = CGRect(x: 16, y: (b.height - fh) / 2, width: b.width - 16 - 34, height: fh)
      hint.sizeToFit()
      hint.frame.origin = CGPoint(x: b.width - 16 - hint.frame.width, y: (b.height - hint.frame.height) / 2)
    }
    // Resting chip: quiet until you want it.
    p.alphaValue = expanded ? 1 : 0.7
    if !p.isVisible { p.orderFrontRegardless() }
    layoutAnswers(field: expanded ? r : nil)
  }
}
