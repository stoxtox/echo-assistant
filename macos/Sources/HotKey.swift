// The global "summon Echo" shortcut (Carbon hot keys: no Accessibility permission needed),
// and the Echo mark drawn as a menu bar icon.
import AppKit
import Carbon.HIToolbox

final class HotKey {
  struct Preset {
    let id: String
    let title: String
    let keyCode: UInt32
    let modifiers: UInt32
  }

  static let presets: [Preset] = [
    Preset(id: "opt-space", title: "Option-Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey)),
    Preset(id: "ctrl-space", title: "Control-Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey)),
    Preset(id: "ctrl-opt-space", title: "Control-Option-Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey)),
    Preset(id: "cmd-shift-e", title: "Shift-Command-E", keyCode: UInt32(kVK_ANSI_E), modifiers: UInt32(cmdKey | shiftKey)),
    Preset(id: "ctrl-opt-e", title: "Control-Option-E", keyCode: UInt32(kVK_ANSI_E), modifiers: UInt32(controlKey | optionKey)),
  ]

  private static var action: (() -> Void)?
  private static var handlerInstalled = false
  private var ref: EventHotKeyRef?

  init(action: @escaping () -> Void) {
    HotKey.action = action
  }

  /// Registers the preset with this id ("off" or an unknown id turns the shortcut off).
  /// Returns false if another app already owns that shortcut.
  @discardableResult
  func apply(_ id: String) -> Bool {
    if let ref { UnregisterEventHotKey(ref) }
    ref = nil
    guard let p = HotKey.presets.first(where: { $0.id == id }) else { return true }
    HotKey.installHandler()
    let hotKeyID = EventHotKeyID(signature: OSType(0x4543_484F), id: 1) // "ECHO"
    return RegisterEventHotKey(p.keyCode, p.modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref) == noErr
  }

  private static func installHandler() {
    guard !handlerInstalled else { return }
    handlerInstalled = true
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
      DispatchQueue.main.async { HotKey.action?() }
      return noErr
    }, 1, &spec, nil, nil)
  }
}

enum EchoMark {
  /// The Echo "e" with its two returning arcs (public/icons/echo-mark.svg), as a template image.
  /// All three strokes share a centre at (35, 32) in the SVG's 64-unit box.
  static func menuBarImage(dimmed: Bool = false) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { rect in
      let scale = rect.width / 64
      let t = NSAffineTransform()
      t.scale(by: scale)
      t.concat()
      let base: CGFloat = dimmed ? 0.45 : 1
      let center = NSPoint(x: 35, y: 32)
      func arc(_ r: CGFloat, from a0: CGFloat, to a1: CGFloat, alpha: CGFloat, lead: NSPoint? = nil) {
        let path = NSBezierPath()
        path.lineWidth = 6
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        let steps = 72
        for i in 0...steps {
          let a = (a0 + (a1 - a0) * CGFloat(i) / CGFloat(steps)) * .pi / 180
          let p = NSPoint(x: center.x + r * cos(a), y: center.y + r * sin(a))
          if i == 0 {
            if let lead { path.move(to: lead); path.line(to: p) } else { path.move(to: p) }
          } else {
            path.line(to: p)
          }
        }
        NSColor.black.withAlphaComponent(alpha * base).setStroke()
        path.stroke()
      }
      arc(8, from: 0, to: -320, alpha: 1, lead: NSPoint(x: 27, y: 32))
      arc(16, from: -42, to: -318, alpha: 0.72)
      arc(24, from: -40, to: -320, alpha: 0.44)
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Echo"
    return image
  }
}
