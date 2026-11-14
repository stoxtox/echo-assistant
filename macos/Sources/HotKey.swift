// The global "summon Echo" shortcut (Carbon hot keys: no Accessibility permission needed),
// and the Echo mark (three bars) drawn as a menu bar icon.
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
  /// Echo's three bars from a shared left edge (public/icons/echo-mark.svg), as a template image:
  /// what you said, it fading, the answer coming back.
  /// `mode`: the listening state ("resting": a little fainter; "off": a line through it).
  static func menuBarImage(dimmed: Bool = false, mode: String = "") -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { rect in
      let scale = rect.width / 64
      let base: CGFloat = dimmed ? 0.45 : mode == "resting" ? 0.62 : mode == "off" ? 0.4 : 1
      // The SVG's bars, a little heavier so they hold up at menu bar size.
      let bars: [(y: CGFloat, width: CGFloat, alpha: CGFloat)] = [(11, 44, 1), (26.5, 31, 0.62), (42, 20, 0.38)]
      for bar in bars {
        let r = NSRect(x: 10 * scale, y: bar.y * scale, width: bar.width * scale, height: 11 * scale)
        NSColor.black.withAlphaComponent(bar.alpha * base).setFill()
        NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2).fill()
      }
      if mode == "off", !dimmed {
        let slash = NSBezierPath()
        slash.move(to: NSPoint(x: 13 * scale, y: 54 * scale))
        slash.line(to: NSPoint(x: 53 * scale, y: 8 * scale))
        slash.lineWidth = 6 * scale
        slash.lineCapStyle = .round
        NSColor.black.setStroke()
        slash.stroke()
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Echo"
    return image
  }
}
