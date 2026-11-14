// Push-to-talk from anywhere: hold Control + Option (or the chord picked in Settings) and talk,
// even when Echo's window isn't in front; let go to send. Works alongside Space and "Hey Echo".
//
// It listens (listen-only: it can't change or block a key) to modifier changes with a CGEvent tap,
// which needs the Input Monitoring permission. A chord that's part of a shortcut (a key pressed
// while it's held) never starts talking, and cancels a recording that had started: that one is
// said out loud on the page ("spoiled"), so a lost sentence is never silent.
import AppKit
import AVFoundation
import IOKit.hid
import Speech

final class PushToTalk {
  /// Chords, as in PTT_HOTKEYS in lib/settings.js.
  static let chords = ["ctrl-opt", "ctrl-cmd", "opt-cmd", "right-opt", "fn", "off"]

  var onStart: (() -> Void)?
  var onStop: (() -> Void)?
  /// Why: "spoiled" (a key was pressed during the chord) or "cancelled" (the chord was changed).
  var onCancel: ((String) -> Void)?
  /// The chord was tapped twice, quickly, with nothing held or typed: switch Listening and Resting.
  var onDoubleTap: (() -> Void)?
  /// The chord was tapped once and no second tap followed: the reply field, if offered, takes the cursor.
  var onSingleTap: (() -> Void)?
  private var tapWait: DispatchWorkItem?
  /// When the last short tap of the chord ended (nil: none waiting for its second).
  private var tappedAt: Date?
  private var pressedAt = Date()
  /// Two taps count as one double-tap when the second begins within this long of the first ending.
  static let doubleTapGap = 0.35

  private var tap: CFMachPort?
  private var source: CFRunLoopSource?
  private var chord = "off"
  private var held = false
  private var started = false
  private var spoiled = false // a key was pressed during the chord: it's a shortcut, not talking
  private var pending: DispatchWorkItem?
  private var downAt = Date()
  /// How long the chord must be held before recording starts (shortcuts are quicker than this).
  private let holdDelay = 0.18

  static var hasPermission: Bool { CGPreflightListenEventAccess() }

  /// Shows macOS's Input Monitoring prompt the first time. Returns whether it's allowed now.
  @discardableResult
  static func requestPermission() -> Bool { CGRequestListenEventAccess() }

  var isActive: Bool { tap != nil }

  /// Listen for this chord ("off" stops). Returns false if Input Monitoring isn't allowed yet.
  @discardableResult
  func apply(_ id: String) -> Bool {
    chord = PushToTalk.chords.contains(id) ? id : "off"
    reset()
    if chord == "off" {
      stopTap()
      return true
    }
    if tap != nil { return true }
    guard PushToTalk.hasPermission else { return false }
    return startTap()
  }

  private func startTap() -> Bool {
    let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
    let callback: CGEventTapCallBack = { _, type, event, refcon in
      if let refcon {
        Unmanaged<PushToTalk>.fromOpaque(refcon).takeUnretainedValue().handle(type, event)
      }
      return Unmanaged.passUnretained(event)
    }
    guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                    eventsOfInterest: CGEventMask(mask), callback: callback,
                                    userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
    tap = t
    source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
    return true
  }

  private func stopTap() {
    if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
    if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
    tap = nil
    source = nil
  }

  private func reset() {
    pending?.cancel()
    pending = nil
    if started { onCancel?("cancelled") }
    held = false
    started = false
    spoiled = false
  }

  /// Is exactly the chosen chord down (no other modifiers)?
  private func chordDown(_ flags: CGEventFlags) -> Bool {
    let ctrl = flags.contains(.maskControl), opt = flags.contains(.maskAlternate)
    let cmd = flags.contains(.maskCommand), shift = flags.contains(.maskShift)
    switch chord {
    case "ctrl-opt": return ctrl && opt && !cmd && !shift
    case "ctrl-cmd": return ctrl && cmd && !opt && !shift
    case "opt-cmd": return opt && cmd && !ctrl && !shift
    case "right-opt":
      // Device-specific bits: 0x40 is the right Option key, 0x20 the left.
      let raw = flags.rawValue
      return opt && raw & 0x40 != 0 && raw & 0x20 == 0 && !ctrl && !cmd && !shift
    case "fn": return flags.contains(.maskSecondaryFn) && !ctrl && !opt && !cmd && !shift
    default: return false
    }
  }

  private func handle(_ type: CGEventType, _ event: CGEvent) {
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
    case .keyDown:
      guard held else { return }
      // A shortcut like Control-Option-E, not talking.
      if !spoiled { BodyLink.shared.timeline("ptt.spoiled") }
      spoiled = true
      tappedAt = nil
      pending?.cancel()
      pending = nil
      if started {
        started = false
        onCancel?("spoiled")
      }
    case .flagsChanged:
      let down = chordDown(event.flags)
      if down && !held {
        held = true
        spoiled = false
        pressedAt = Date()
        let work = DispatchWorkItem { [weak self] in
          guard let self, self.held, !self.spoiled else { return }
          self.started = true
          self.downAt = Date()
          BodyLink.shared.timeline("ptt.down")
          self.onStart?()
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + holdDelay, execute: work)
      } else if !down && held {
        held = false
        pending?.cancel()
        pending = nil
        if started {
          started = false
          tappedAt = nil
          BodyLink.shared.timeline("ptt.up", ["ms": Int(Date().timeIntervalSince(downAt) * 1000)])
          onStop?()
        } else if !spoiled {
          // A short tap (let go before recording began). The second one within the gap is a double-tap.
          let now = Date()
          if PushToTalkMath.isDoubleTap(sinceFirstTap: tappedAt.map { pressedAt.timeIntervalSince($0) }, gap: Self.doubleTapGap) {
            tappedAt = nil
            tapWait?.cancel()
            tapWait = nil
            BodyLink.shared.timeline("ptt.double")
            onDoubleTap?()
          } else {
            tappedAt = now
            tapWait?.cancel()
            let wait = DispatchWorkItem { [weak self] in
              guard let self, self.tappedAt == now, !self.held else { return }
              self.onSingleTap?()
            }
            tapWait = wait
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.doubleTapGap + 0.03, execute: wait)
          }
        } else {
          tappedAt = nil
        }
      }
    default:
      break
    }
  }
}

/// The Mac permissions screen awareness, the pointer and push-to-talk need.
enum Permissions {
  static func status() -> [String: Any] {
    [
      "screen": CGPreflightScreenCaptureAccess(),
      "screenSupported": ScreenLook.supported,
      "accessibility": AXFinder.trusted,
      "input": PushToTalk.hasPermission,
      "microphone": NativeMic.permission == "allowed",
    ]
  }

  static let panes = [
    "screen": "Privacy_ScreenCapture",
    "accessibility": "Privacy_Accessibility",
    "input": "Privacy_ListenEvent",
    "microphone": "Privacy_Microphone",
    "speech": "Privacy_SpeechRecognition",
  ]

  /// Asks macOS for a permission (its own prompt appears the first time), then opens the right
  /// page of System Settings if it still isn't allowed.
  static func request(_ kind: String) {
    var allowed = false
    switch kind {
    case "screen": allowed = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    case "accessibility": AXFinder.prompt(); allowed = AXFinder.trusted
    case "input": allowed = PushToTalk.hasPermission || PushToTalk.requestPermission()
    case "microphone":
      if NativeMic.permission == "ask" { AVCaptureDevice.requestAccess(for: .audio) { _ in }; return }
      allowed = NativeMic.permission == "allowed"
    case "speech":
      if SFSpeechRecognizer.authorizationStatus() == .notDetermined { SFSpeechRecognizer.requestAuthorization { _ in }; return }
      allowed = SFSpeechRecognizer.authorizationStatus() == .authorized
    default: return
    }
    if !allowed { openPane(kind) }
  }

  static func openPane(_ kind: String) {
    guard let anchor = panes[kind],
          let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else { return }
    NSWorkspace.shared.open(url)
  }

  // MARK: the permissions window (Permissions.swift)

  /// What macOS says about each permission right now. It only tells "denied" from "nobody has
  /// answered yet" for the microphone, speech and Input Monitoring; the other two are "not yet"
  /// until they are allowed.
  static func states() -> [String: PermMath.State] {
    var input = PermMath.State.notYet
    if PushToTalk.hasPermission { input = .allowed }
    else if IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeDenied { input = .denied }
    var speech = PermMath.State.notYet
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: speech = .allowed
    case .denied, .restricted: speech = .denied
    default: break
    }
    return [
      "microphone": ["allowed": .allowed, "denied": .denied][NativeMic.permission] ?? .notYet,
      "accessibility": AXFinder.trusted ? .allowed : .notYet,
      "screen": CGPreflightScreenCaptureAccess() ? .allowed : .notYet,
      "input": input,
      "speech": speech,
    ]
  }

  /// The ones Echo has already asked macOS for (it shows its prompt once, ever: after that the
  /// way is System Settings). Names only, kept across launches.
  static var asked: Set<String> {
    get { Set(UserDefaults.standard.stringArray(forKey: "PermissionsAsked") ?? []) }
    set { UserDefaults.standard.set(newValue.sorted(), forKey: "PermissionsAsked") }
  }

  /// The checklist has been shown once (it shows by itself the first time Echo opens).
  static var shown: Bool {
    get { UserDefaults.standard.bool(forKey: "PermissionsShown") }
    set { UserDefaults.standard.set(newValue, forKey: "PermissionsShown") }
  }

  /// What the window shows now.
  static func model() -> PermMath.Model {
    var speech = false
    if #available(macOS 26, *) { speech = true }
    let rows = PermMath.rows(screen: ScreenLook.supported, speech: speech)
    let now = states()
    return PermMath.Model(rows: rows, states: now.filter { id, _ in rows.contains { $0.id == id } }, asked: asked)
  }

  /// A row's button: "Allow" asks macOS (and is remembered as asked), "Open Settings" opens its page.
  static func act(_ id: String, allow: Bool) {
    guard allow else { return openPane(id) }
    asked.insert(id)
    request(id)
  }

  private static var lastStates: [String: PermMath.State]?

  /// Notes on the timeline which permissions changed since the last look, and their new states
  /// (names and states, nothing else). True when something did.
  @discardableResult
  static func noteChanges() -> Bool {
    let now = model().states
    let changed = PermMath.changes(from: lastStates, to: now)
    lastStates = now
    if !changed.isEmpty { BodyLink.shared.timeline("perm.change", changed) }
    return !changed.isEmpty
  }
}
