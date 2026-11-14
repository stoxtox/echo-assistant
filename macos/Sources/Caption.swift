// The island: one small bar of near-black glass just under the menu bar, centred on the screen you
// are working on. While Echo's window is hidden or behind other apps and something is going on (or
// whenever she works on the Mac), it shows the pearl and one line: your live words while she
// listens, what she is saying while she answers (a line at a time), and "Excel · step 2 of 4 ·
// typing in A1" with Stop while she works on the Mac. When she needs an OK it grows into a card
// (the question, its detail, Cancel and the action button) and shrinks back afterwards.
//
// - It floats on every Space, full-screen apps included, never takes focus and never covers the
//   menu bar.
// - Clicks go straight through it, except on Stop, the close button and the card's two buttons
//   (they work on the first click without bringing Echo forward).
// - It cannot get stuck: the app owns whether it shows (CaptionLife in PointMath.swift). What the
//   page says is forgotten after 10 s unless the page keeps saying it, reset() clears everything
//   when the page or the server goes away, talk mode alone holds it for 6 s, and the fade-out
//   finishes on a timer even if the display's frame clock has stopped.
// - It moves down out of the way when Echo acts on something under it, and dims when your mouse
//   is over it, so you can see what's underneath.
// - It hugs its words, fades in sliding down 8 pt, and fades 3.5 s after things go quiet.
// - The pearl at its left end is alive (Companion.swift): it breathes and blinks, leans in while
//   you talk, thinks with a comet of light, pulses as Echo answers, tips its head when the card
//   is up, sleeps after three quiet minutes, and its eyes follow your mouse when it comes near.
//   When Echo points at something its light flies out from its rim (Pointer.swift): the rim dims,
//   its eyes follow the light, and it gives a pleased blink when the light is home. It has its
//   own small view, so only it redraws as it breathes.
// - A keyboard chip beside it opens a small reply field, and it opens by itself when Echo ends a
//   reply with a question, so you can answer by typing from any app (ReplyField.swift).
// - Settings → Screen → "Show the caption bar while Echo drives" (on by default).
// The page decides what it says (public/caption.js); PillArt.swift draws it.
import AppKit

/// A button that works on the first click in a panel that never becomes key.
private final class FirstClickButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The view the island is drawn in, redrawn only while something in it moves. A real subview above
/// the glass: a bare CALayer added to the root view's layer ended up under the blur, so it showed
/// as an empty tinted bar with no words. Clicks go through it.
private final class PillView: NSView {
  weak var bar: CaptionBar?
  override var isOpaque: Bool { false }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    bar?.drawPill(in: ctx)
  }
}

/// The small view the island's pearl is drawn in, on top of the island: it redraws many times a
/// second while the island under it stays as it is. Clicks go through it.
private final class PearlView: NSView {
  let art = PearlArt()
  var now: CFTimeInterval = 0
  override var isOpaque: Bool { false }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    art.draw(in: ctx, at: CGPoint(x: bounds.midX, y: bounds.midY), now: now, pixelScale: window?.backingScaleFactor ?? 2)
  }
}

/// A value easing to where it's told, with ease-glide over `duration` (from wherever it is now).
private struct Tween {
  private(set) var value: CGFloat
  private var from: CGFloat, to: CGFloat, start: Double = 0
  var duration: Double
  init(_ v: CGFloat, duration: Double) { value = v; from = v; to = v; self.duration = duration }
  var target: CGFloat { to }
  var moving: Bool { value != to }
  mutating func go(_ v: CGFloat, now: Double) {
    guard v != to else { return }
    from = value
    to = v
    start = now
  }
  mutating func jump(_ v: CGFloat) { value = v; from = v; to = v }
  mutating func step(_ now: Double) {
    guard value != to else { return }
    let u = duration > 0 ? (now - start) / duration : 1
    value = u >= 1 ? to : from + (to - from) * CGFloat(CompanionMath.easeOut(u))
  }
}

final class CaptionBar {
  static let shared = CaptionBar()

  /// Is Echo's own window in front (then the island isn't needed unless she's working on the Mac)?
  var echoInFront: () -> Bool = { false }
  /// The Stop button.
  var onStop: (() -> Void)?
  /// You closed it (its x): the page is told, if it's there.
  var onClose: (() -> Void)?
  /// The card's action button (true) or Cancel (false), when Echo asked for an OK.
  var onConfirm: ((Bool) -> Void)?
  /// The question Echo is waiting on, and what its two buttons say (nil: it is not asking). The
  /// same question is asked beside the thing itself (AskBubble.swift, Pointer.syncAsk).
  var ask: (question: String, action: String, cancel: String)? {
    confirming && !question.isEmpty ? (question, action.isEmpty ? "Yes" : action, cancel.isEmpty ? "No" : cancel) : nil
  }
  private var lastAskKey = ""
  static let askChanged = Notification.Name("EchoAskChanged")
  /// The island starts showing (true) or going away (false).
  var onShowChange: ((Bool) -> Void)?
  /// Something about the island changed (it moved, resized, dimmed, or its state did): the pearl
  /// hopping home follows it (Pointer.swift wake).
  var onChange: (() -> Void)?

  private var panel: NSPanel?
  private var root: NSView?
  private let glass = NSVisualEffectView()
  private let pillView = PillView()
  private let art = PillArt()
  private let pearlView = PearlView()
  private var pearl: PearlArt { pearlView.art }
  private var pearlDrawnAt = 0.0
  private var stop: NSButton!
  private var yes: NSButton!
  private var no: NSButton!
  private var closeButton: NSButton!
  private var hideWork: DispatchWorkItem?
  /// Finishes a fade-out even when the frame clock isn't ticking (a display that went away or slept).
  private var goneWork: DispatchWorkItem?
  /// Looks again when time alone changes the answer (the page went silent, talk mode's quiet ran out).
  private var checkTimer: Timer?
  private var avoid: CGRect?
  private var avoidAt = Date.distantPast
  private(set) var showing = false
  private var ticking = false

  /// Whether the island shows: the page's word, kept only while it's fresh (PointMath.swift).
  private var life = CaptionLife()
  private var lastSaidKey = ""
  private var driving: Bool { life.drivingNow(CACurrentMediaTime()) }
  private var confirming = false
  private var mode = ""
  private var pageStatus = ""
  /// What Echo asks before a risky step, the detail under it, and what its two buttons say.
  private var question = ""
  private var detail = ""
  private var action = ""
  private var cancel = ""
  private var user = ""
  private var echo = ""
  private var lastSaid = PillContent.Kind.none
  /// What Echo is doing, from the pointer ("Clicking “Send”").
  private var doing: String?
  /// Which step of the request this is, and how many she expects (0: she didn't say).
  private var step = 0, steps = 0
  /// Until when (CACurrentMediaTime) "esc to stop" shows after what she's doing.
  private var hintUntil = 0.0
  /// Echo's voice (idle, listening, thinking, speaking), as the page tells the pearl.
  private var voice = "idle"
  /// When each of Echo's words starts, from her voice (CACurrentMediaTime seconds), if the page sent it.
  private var echoTiming: (start: Double, starts: [Double])?
  /// How many of her words show as said (it only ever grows within a line of hers).
  private var litShown: CGFloat = 0
  private var echoWords: [String] = []
  private var echoLine = 0
  private var echoLineChangedAt = -10.0

  // What's drawn, and how it moves.
  private var content = PillContent()
  private var previous: PillContent?
  /// The card it is (or was last) grown into: kept while it shrinks back, so the card fades out.
  private var card: (text: PillContent.Card, layout: PillMath.Card)?
  private var mixStart = -10.0
  private var newWordAt = -10.0
  private var echoLineAt = 0.0
  private var appear = Tween(0, duration: 0.22)
  private var width = Tween(PillMath.height, duration: 0.34)
  private var height = Tween(PillMath.height, duration: 0.34)
  private var grown = Tween(0, duration: 0.3)
  private var stopShown = Tween(0, duration: 0.2)
  private var peek: CGFloat = 0
  private var away: CGFloat = 0
  private var awayGoal: CGFloat = 0
  private var lift: CGFloat = 0 // the island's top edge, animated (screen y)
  private var liftGoal: CGFloat = 0
  private var liftSpeed: CGFloat = 0
  private var home = CGRect.zero // where the island is going (screen coordinates, at its target size)
  private var screenFrame = CGRect.null
  private var lastTick = 0.0

  /// Room around the island in its panel, for its shadow. The panel is big enough for the widest
  /// bar and the tallest card, so it never resizes: the island moves and grows inside it.
  private static let pad = CGSize(width: 90, height: 90)
  private static var panelSize: CGSize {
    CGSize(width: PillMath.maxWidth + 2 * pad.width, height: PillMath.cardMaxHeight + 2 * pad.height)
  }

  /// For the menu bar menu (main.swift): whether the caption is allowed (the Caption setting, as
  /// the page last said it), and what Echo is working on (which step of how many; 0: not said).
  var allowed: Bool { life.enabled }
  var progress: (working: Bool, step: Int, steps: Int) { (driving, step, steps) }
  /// "Show Caption" in the menu: at once here; the page saves the setting and says the same after.
  func setAllowed(_ on: Bool) { life.allow(on); refresh() }

  /// The panel's window number (Echo's own click-through overlay), or nil when there's none.
  var windowNumber: Int? { panel?.windowNumber }

  /// What the page says: { enabled, driving, active, quiet, status, mode, confirm, question, user,
  /// echo }, and again every few seconds (`beat`) while it wants the island shown. With `confirm`
  /// and a `question` it grows into a card; `detail` (the grey words under the question), `action`
  /// (what the white button says, "Send"; "Yes" when missing) and `cancel` are optional.
  func update(_ b: [String: Any]) {
    let nowDriving = b["driving"] as? Bool ?? false
    confirming = b["confirm"] as? Bool ?? false
    mode = b["mode"] as? String ?? ""
    // Blank text (spaces, newlines) counts as none, so it never holds the pill open.
    pageStatus = PillMath.clean(b["status"] as? String)
    question = PillMath.clean(b["question"] as? String)
    detail = PillMath.clean(b["detail"] as? String)
    action = PillMath.clean(b["action"] as? String)
    cancel = PillMath.clean(b["cancel"] as? String)
    let u = PillMath.clean(b["user"] as? String)
    let e = PillMath.clean(b["echo"] as? String)
    // Something new to show: new words or a new state (not a refresh, and not the status line,
    // which in talk mode is a countdown).
    let key = [mode, question, detail, action, cancel, u, e, nowDriving ? "d" : "", confirming ? "c" : "", (b["asks"] as? Bool ?? false) ? "a" : ""].joined(separator: "\u{1}")
    let new = !(b["beat"] as? Bool ?? false) && key != lastSaidKey
    lastSaidKey = key
    life.heard(enabled: b["enabled"] as? Bool ?? true, driving: nowDriving, active: b["active"] as? Bool ?? false,
               quiet: b["quiet"] as? Bool ?? false, confirming: confirming, new: new, now: CACurrentMediaTime())
    onChange?()
    if e != echo, !e.isEmpty { lastSaid = .echo; echoLineAt = CACurrentMediaTime(); litShown = 0; echoLine = 0 }
    // When each word is said (ms from `at`, the wall clock in ms), as the voice plays it.
    if let t = b["echoTimes"] as? [String: Any], let at = (t["at"] as? NSNumber)?.doubleValue, at.isFinite,
       let starts = t["starts"] as? [NSNumber], !starts.isEmpty {
      let start = CACurrentMediaTime() + (at / 1000 - Date().timeIntervalSince1970)
      echoTiming = (start, starts.map { max(0, $0.doubleValue / 1000) })
    } else if e != echo {
      echoTiming = nil
    }
    if !driving { step = 0; steps = 0 }
    // Echo ended on a question: the reply field opens beside the island (it doesn't take the keyboard).
    // The likely answers to her question come with it ("Yes", "No"): buttons under the reply field.
    ReplyField.shared.setChips((b["asks"] as? Bool ?? false) ? (b["chips"] as? [String] ?? []) : [])
    ReplyField.shared.setAsking(b["asks"] as? Bool ?? false)
    let askKey = confirming ? question + "\u{1}" + action + "\u{1}" + cancel : ""
    if askKey != lastAskKey { lastAskKey = askKey; NotificationCenter.default.post(name: Self.askChanged, object: nil) }
    if u != user, !u.isEmpty { lastSaid = .user }
    user = u
    echo = e
    recompose()
    refresh()
  }

  /// What Echo is doing right now ("Clicking “Send”"), or nil when she's done.
  func setDoing(_ text: String?) {
    let d = PillMath.clean(text)
    doing = d.isEmpty ? nil : d
    recompose()
  }

  /// A drive has started: "esc to stop" after what she's doing for a few seconds, then it goes.
  func flashHint(seconds: Double = 4) {
    hintUntil = CACurrentMediaTime() + seconds
    recompose()
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 0.05) { [weak self] in self?.recompose() }
  }

  /// Which step of the request Echo is on (from the server: 1-based, and the total she expects, or
  /// 0 when she didn't say).
  func setStep(_ n: Int, of total: Int) {
    guard n > 0 else { return }
    step = n
    steps = max(0, total)
    recompose()
  }

  /// The step Echo was on is done: a quick smile and a small hop.
  func stepFinished() {
    guard step > 0 else { return }
    pearl.done(now: CACurrentMediaTime())
    if showing { startTicking() }
  }

  /// Echo's voice, and its level (0…1) while she listens or speaks: the pearl follows it.
  func setVoice(_ state: String, level: Double? = nil) {
    voice = state
    if let level { pearl.setLevel(level, now: CACurrentMediaTime()) }
    if showing { startTicking() }
  }

  /// A moment: a lesson step passed ("proud": a smile and a hop) or finished ("celebrate": with
  /// sparkles), you talked over Echo ("surprised": a jump and wide eyes), something failed or a
  /// sentence was lost ("sorry": eyes down, a small shake), or the pearl that was out pointing
  /// has just landed back here ("landed": a happy blink).
  func moment(_ name: String) {
    let now = CACurrentMediaTime()
    switch name {
    case "proud": pearl.proud(now: now)
    case "celebrate": pearl.celebrate(now: now)
    case "surprised": pearl.surprised(now: now)
    case "sorry": pearl.miss(now: now)
    case "landed": pearl.landed(now: now)
    case "done": pearl.done(now: now)
    default: return
    }
    if showing { startTicking() }
  }

  /// The firefly way of pointing (Pointer.swift): where the pearl's light is (screen
  /// coordinates) while it is away showing you something, or nil when it is back. The pearl's
  /// rim is barely lit meanwhile and its eyes follow its light (`seeYou`: for a moment they
  /// look at your mouse instead: "see?"). When the light comes home the rim brightens with a
  /// soft pulse and the pearl gives a pleased blink.
  func setLight(_ at: CGPoint?, seeYou: Bool = false) {
    let back = light != nil && at == nil
    light = at
    lightSeeYou = seeYou
    if back { pearl.lightHome(now: CACurrentMediaTime()) }
    if showing, at != nil || back { startTicking() }
  }
  private var light: CGPoint?
  private var lightSeeYou = false

  /// Its light is asking for your OK beside something, or is out searching for what Echo asked
  /// for: the pearl tips its head and raises a brow (its `needs` mood), eyes still on its light.
  func setLightNeeds(_ on: Bool) {
    guard on != lightNeeds else { return }
    lightNeeds = on
    if showing { startTicking() }
  }
  private var lightNeeds = false

  /// The pearl's look changed in Settings (auto, glass or moon).
  func lookChanged() {
    needsDraw = true
    if showing { startTicking() }
  }

  /// Echo is about to act on `frame` (AppKit coordinates): keep out of its way for a while.
  func avoid(_ frame: CGRect) {
    avoid = frame
    avoidAt = Date()
    if showing { place(animated: true) }
  }

  /// The pearl has flown out to point at something (the one here waits faintly) or is back.
  func setMarkAway(_ out: Bool) {
    awayGoal = out ? 1 : 0
    if showing { startTicking() }
  }

  /// Where the pearl is, as the island is right now (it follows the island while it slides in,
  /// widens or moves), on the island's screen: the pearl that goes out pointing leaves from here and lands here.
  /// Nil while it's hidden or going.
  func dock() -> (point: CGPoint, screen: CGRect)? {
    guard showing, !screenFrame.isNull else { return nil }
    return (PillMath.slotCenter(currentPill()), screenFrame)
  }

  /// Where the island will be (for the pearl out pointing to stand clear of it), or nil.
  var frameOnScreen: CGRect? { showing ? home : nil }

  /// Show or hide, by the setting, the state and whether Echo's window is in front.
  func refresh() {
    let now = CACurrentMediaTime()
    // An open reply field keeps the island up (you're typing to Echo from another app).
    let want = life.wants(now: now, echoInFront: echoInFront(), replying: ReplyField.shared.expanded)
    // Time alone can change the answer: look again then (a timer, not the frame clock).
    checkTimer?.invalidate()
    checkTimer = nil
    if let wait = life.nextCheck(now: now) {
      let t = Timer(timeInterval: wait + 0.05, repeats: false) { [weak self] _ in
        self?.recompose() // a forgotten drive takes its Stop button with it
        self?.refresh()
      }
      RunLoop.main.add(t, forMode: .common)
      checkTimer = t
    }
    if want {
      hideWork?.cancel()
      hideWork = nil
      show()
    } else if showing && hideWork == nil {
      // Linger so the last line can be read, then fade (at once when it was closed or ran out).
      let wait = life.lingers(now: now)
      guard wait > 0 else { return hide() }
      let work = DispatchWorkItem { [weak self] in
        self?.hideWork = nil
        self?.hide()
      }
      hideWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
    }
  }

  /// The app's driver started acting on the Mac: the island and Stop show for as long as it
  /// does, whether or not the page is there to say so (it may be reloading).
  func driveBegan() {
    life.driveBegan()
    recompose()
    refresh()
  }

  /// The driver went quiet between steps (the session may still be on: the page's word stands).
  func driveIdle() {
    life.driveIdle()
    doing = nil
    recompose()
    refresh()
  }

  /// A driving run ended in the app (done, stopped, taken over, idle): Stop, the step counter and
  /// the driving state go, whatever the page last said (it may not be there to say otherwise).
  func driveEnded() {
    life.driveEnded()
    doing = nil
    step = 0
    steps = 0
    hintUntil = 0
    recompose()
    refresh()
  }

  /// Hide and forget everything: the page was replaced or is reconnecting, its process died, the
  /// app's line to the server dropped, or the app is quitting. Whatever is still true, the page
  /// says again when it is back. A drive the app itself is still running keeps the island and
  /// Stop up. `keepDraft`: a reply you are half way through typing stays (the line to the server
  /// dropped; nothing about what you typed is stale).
  func reset(keepDraft: Bool = false) {
    life.reset()
    checkTimer?.invalidate()
    checkTimer = nil
    lastSaidKey = ""
    confirming = false
    mode = ""
    pageStatus = ""
    question = ""
    detail = ""
    action = ""
    cancel = ""
    user = ""
    echo = ""
    lastSaid = .none
    echoTiming = nil
    doing = nil
    step = 0
    steps = 0
    hintUntil = 0
    voice = "idle"
    avoid = nil
    ReplyField.shared.reset(keepDraft: keepDraft)
    recompose()
    if life.wants(now: CACurrentMediaTime(), echoInFront: echoInFront(), replying: ReplyField.shared.expanded) { refresh() } else { hideNow() }
    onChange?()
  }

  /// The close button (x): gone until something new starts.
  func close() {
    life.dismiss()
    ReplyField.shared.reset()
    hideWork?.cancel()
    hideWork = nil
    hide()
    onClose?()
  }

  /// Gone at once, with no fade.
  func hideNow() {
    hideWork?.cancel()
    hideWork = nil
    hide()
    finishHide()
  }

  /// The screens changed (one plugged in, unplugged or rearranged): find the pill's place again.
  func screensChanged() {
    guard showing else { return }
    screenFrame = .null
    place(animated: false)
    recompose(force: true)
  }

  // MARK: what it says

  /// One line. An OK comes first (the card); then what Echo is saying while she speaks and your
  /// words while you talk; then what she is doing on the Mac; then the last thing said; and with
  /// no words at all, the page's status in grey ("Listening…", "Talk mode · just talk").
  private func compose() -> PillContent {
    var c = PillContent()
    if confirming, !question.isEmpty {
      c.card = PillContent.Card(question: question, detail: detail, action: action.isEmpty ? "Yes" : action, cancel: cancel.isEmpty ? "Cancel" : cancel)
      return c
    }
    c.stop = driving
    func says(_ kind: PillContent.Kind) -> Bool {
      let words = kind == .echo ? echo : user
      guard !words.isEmpty else { return false }
      c.kind = kind
      c.main = words
      c.live = kind == .user && (mode == "hearing" || mode == "listening")
      c.thinking = kind == .user && mode == "thinking"
      return true
    }
    if confirming, !pageStatus.isEmpty {
      // Waiting for your yes with no question to show: say so.
      c.kind = .plain
      c.dim = pageStatus
    } else if mode == "speaking", says(.echo) {
    } else if mode == "hearing", says(.user) {
    } else if driving || doing != nil {
      let line = PillMath.working(app: driving ? PillMath.app(fromStatus: pageStatus) : "", step: StepMath.counter(step: step, of: steps), what: doing ?? "")
      c.kind = .plain
      c.main = line.main
      c.dim = line.dim + (driving && CACurrentMediaTime() < hintUntil ? " · esc to stop" : "")
      if c.main.isEmpty && c.dim.isEmpty { c.dim = pageStatus }
    } else if ["listening", "thinking"].contains(mode), says(.user) {
    } else if mode.isEmpty, lastSaid == .echo ? says(.echo) || says(.user) : says(.user) || says(.echo) {
    } else if !pageStatus.isEmpty {
      c.kind = .plain
      c.dim = pageStatus
    }
    return c
  }

  /// `force`: set the size and look even when the words haven't changed. The island's first show
  /// needs it: with nothing to say, its content equals the empty start, so without it the island
  /// kept its starting width instead of closing to just the pearl and the close button.
  private func recompose(force: Bool = false) {
    let next = compose()
    guard force || next != content else { return }
    let now = CACurrentMediaTime()
    if !next.sameShape(content) && showing && !content.isEmpty {
      previous = content
      mixStart = now
    }
    if next.kind == .user && content.kind == .user && next.main.split(separator: " ").count > content.main.split(separator: " ").count {
      newWordAt = now
    }
    content = next
    echoWords = next.kind == .echo ? next.main.split(separator: " ").map(String.init) : []
    let screenW = screenFrame.isNull ? 1512 : screenFrame.width
    if let text = next.card {
      // It grows into a card (from its top edge, downward).
      let layout = art.cardLayout(text, screenWidth: screenW)
      card = (text, layout)
      width.go(layout.size.width, now: now)
      height.go(layout.size.height, now: now)
      grown.go(1, now: now)
      yes?.setAccessibilityLabel(text.action)
      no?.setAccessibilityLabel(text.cancel)
    } else {
      let room = PillMath.textRoom(width: PillMath.widest(screenWidth: screenW), stop: next.stop)
      width.go(PillMath.width(text: art.textWidth(next, room: room), stop: next.stop, screenWidth: screenW), now: now)
      height.go(PillMath.height, now: now)
      grown.go(0, now: now)
    }
    stopShown.go(content.stop ? 1 : 0, now: now)
    root?.setAccessibilityValue(content.card.map { [$0.question, $0.detail].filter { !$0.isEmpty }.joined(separator: ". ") } ?? content.main + content.dim)
    if showing {
      home = PillMath.frame(visible: usableFrame(), width: width.target, height: height.target, avoid: currentAvoid())
      liftGoal = home.maxY
      startTicking()
    }
  }

  // MARK: the panel

  private func ensurePanel() -> NSPanel {
    if let panel { return panel }
    let size = Self.panelSize
    let p = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false // the island draws its own soft shadow
    // Above ordinary windows and the Dock, below menus, system alerts and the screen saver.
    p.level = .statusBar
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.hidesOnDeactivate = false
    p.becomesKeyOnlyIfNeeded = true
    p.isReleasedWhenClosed = false
    p.ignoresMouseEvents = true // click-through, except over its buttons (see tick)
    p.animationBehavior = .none
    p.alphaValue = 0
    p.setAccessibilityLabel("Echo captions")

    let root = NSView(frame: NSRect(origin: .zero, size: size))
    root.wantsLayer = true
    root.setAccessibilityRole(.group)
    root.setAccessibilityLabel("Echo captions")

    // The blur behind the glass, clipped to the island.
    glass.material = .hudWindow
    glass.blendingMode = .behindWindow
    glass.state = .active
    glass.appearance = NSAppearance(named: .vibrantDark)
    glass.wantsLayer = true
    glass.layer?.cornerRadius = PillMath.corner
    glass.layer?.masksToBounds = true
    root.addSubview(glass)

    pillView.bar = self
    pillView.frame = root.bounds
    pillView.wantsLayer = true
    pillView.layerContentsRedrawPolicy = .onSetNeedsDisplay
    root.addSubview(pillView, positioned: .above, relativeTo: glass)
    pearlView.wantsLayer = true
    pearlView.layerContentsRedrawPolicy = .onSetNeedsDisplay
    root.addSubview(pearlView, positioned: .above, relativeTo: pillView)

    // The buttons are drawn by PillArt; these invisible ones take the clicks and speak to VoiceOver.
    func button(_ label: String, _ action: Selector, tip: String? = nil) -> NSButton {
      let b = FirstClickButton(title: "", target: self, action: action)
      b.isBordered = false
      b.isTransparent = true
      b.isHidden = true
      b.setAccessibilityLabel(label)
      b.toolTip = tip
      root.addSubview(b)
      return b
    }
    stop = button("Stop Echo", #selector(stopClicked), tip: "Stop (esc)")
    yes = button("Yes", #selector(yesClicked))
    no = button("Cancel", #selector(noClicked))
    closeButton = button("Hide Echo's caption", #selector(closeClicked), tip: "Hide the caption")

    p.contentView = root
    self.root = root
    panel = p
    return p
  }

  @objc private func stopClicked() {
    onStop?()
  }

  @objc private func closeClicked() { close() }

  @objc private func yesClicked() { onConfirm?(true) }
  @objc private func noClicked() { onConfirm?(false) }

  /// The part of the island's screen it may use: under the menu bar, and clear of a notch.
  private func usableFrame() -> CGRect {
    guard let s = NSScreen.screens.first(where: { $0.frame == screenFrame }) else { return screenFrame }
    return PillMath.usable(visible: s.visibleFrame, screen: s.frame, safeTop: s.safeAreaInsets.top)
  }

  private func currentAvoid() -> CGRect? {
    if Date().timeIntervalSince(avoidAt) > 10 { avoid = nil }
    return avoid
  }

  /// Chooses the screen (where Echo is acting, else the front app's: the one you're working on)
  /// and where on it the island goes.
  private func place(animated: Bool) {
    let a = currentAvoid()
    let screen = a.flatMap { a in NSScreen.screens.first { $0.frame.intersects(a) } } ?? ScreenLook.screen(for: FrontApp.target())
    let moved = screen.frame != screenFrame
    screenFrame = screen.frame
    home = PillMath.frame(visible: usableFrame(), width: width.target, height: height.target, avoid: a)
    liftGoal = home.maxY
    if !animated || moved || Motion.reduced {
      lift = liftGoal
      liftSpeed = 0
    }
    if showing { startTicking() }
  }

  /// The island as it is right now (screen coordinates): animated size and position. It grows
  /// and shrinks from its top edge.
  private func currentPill() -> CGRect {
    let w = width.value, h = height.value, drop = Motion.reduced ? 0 : 8 * (1 - appear.value)
    return CGRect(x: (home.midX - w / 2).rounded(), y: lift + drop - h, width: w, height: h)
  }

  private func show() {
    let panel = ensurePanel()
    let wasShowing = showing
    showing = true
    place(animated: wasShowing)
    guard !wasShowing else { return }
    BodyLink.shared.timeline("overlay.show", ["name": "caption"])
    goneWork?.cancel()
    goneWork = nil
    recompose(force: true)
    width.jump(width.target)
    height.jump(height.target)
    grown.jump(grown.target)
    stopShown.jump(stopShown.target)
    previous = nil
    art.reduced = Motion.reduced
    appear.duration = Motion.reduced ? 0.15 : 0.22
    width.duration = Motion.reduced ? 0.12 : 0.34
    height.duration = width.duration
    grown.duration = Motion.reduced ? 0.12 : 0.3
    appear.go(1, now: CACurrentMediaTime())
    pearl.wake(now: CACurrentMediaTime()) // it arrives awake
    panel.orderFrontRegardless()
    startTicking()
    onShowChange?(true)
  }

  private func hide() {
    guard showing, panel != nil else { return }
    showing = false
    BodyLink.shared.timeline("overlay.hide", ["name": "caption"])
    panel?.ignoresMouseEvents = true
    ReplyField.shared.follow(pill: nil, visible: usableFrame(), driving: driving)
    appear.go(0, now: CACurrentMediaTime())
    startTicking()
    onShowChange?(false)
    // The fade is drawn by the frame clock; this takes the panel away even if that has stopped.
    goneWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.finishHide() }
    goneWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
  }

  /// The island is off screen and everything stops until it's needed again.
  private func finishHide() {
    guard !showing else { return }
    goneWork?.cancel()
    goneWork = nil
    appear.jump(0)
    panel?.alphaValue = 0
    panel?.ignoresMouseEvents = true
    panel?.orderOut(nil)
    stopTicking()
  }

  // MARK: motion

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

  /// The pearl's state: Echo's voice as the page tells it, else what the caption's mode says; it
  /// thinks while she works on the Mac; it tips its head while she waits for an OK; and its eyes
  /// follow your mouse while it is within 300 pt (read on this tick: nothing watches the mouse).
  private func stepPearl(_ now: Double, dt: Double, at center: CGPoint, mouse: CGPoint) {
    let fromMode = ["hearing": "listening", "listening": "listening", "thinking": "thinking", "speaking": "speaking"][mode] ?? "idle"
    pearl.voice = voice != "idle" ? voice : fromMode
    pearl.working = driving || doing != nil
    pearl.asking = content.card != nil || lightNeeds
    pearl.reduced = Motion.reduced
    pearl.lively = Prefs.orbEyes
    // Auto wears Moon when the system's appearance is dark and Glass when it is light (CompanionLook, Pointer.swift).
    let skin = CompanionLook.wear()
    if skin != pearl.skin { needsDraw = true }
    pearl.skin = skin
    pearl.diameter = PillMath.mark
    pearl.pointer = showing && awayGoal == 0 ? PearlMath.gaze(from: center, to: mouse, reach: 300) : nil
    pearl.lightAway = light != nil
    pearl.target = light.flatMap { PearlMath.gaze(from: center, to: lightSeeYou ? mouse : $0) }
    pearl.step(now: now, dt: dt)
  }

  private func tick(_ now: Double) {
    guard let panel, root != nil else { return stopTicking() }
    let dt = min(0.05, max(0, now - lastTick))
    lastTick = now
    let reduced = Motion.reduced
    art.reduced = reduced

    appear.step(now)
    width.step(now)
    height.step(now)
    grown.step(now)
    stopShown.step(now)
    if !grown.moving && grown.value == 0 { card = nil }
    let lighting = stepEcho(now, dt: dt)
    // Moving out of the way and back: a critically damped spring (never overshoots).
    let (p, v) = CompanionMath.spring(CGPoint(x: 0, y: lift), CGVector(dx: 0, dy: liftSpeed), to: CGPoint(x: 0, y: liftGoal), dt: dt, response: 0.3)
    lift = abs(p.y - liftGoal) < 0.05 && abs(v.dy) < 0.5 ? liftGoal : p.y
    liftSpeed = lift == liftGoal ? 0 : v.dy
    away += (awayGoal - away) * CGFloat(1 - exp(-dt / 0.1))
    if abs(away - awayGoal) < 0.005 { away = awayGoal }

    // Place the panel around the island (it doesn't resize; the island moves and grows inside it).
    let pill = currentPill()
    let size = Self.panelSize
    let origin = CGPoint(x: (home.midX - size.width / 2).rounded(), y: (lift + Self.pad.height - size.height).rounded())
    if panel.frame.origin != origin || panel.frame.size != size { panel.setFrame(CGRect(origin: origin, size: size), display: false) }
    let local = pill.offsetBy(dx: -origin.x, dy: -origin.y)
    // The reply field's chip (or the open field) follows the island, on its screen.
    if showing { ReplyField.shared.follow(pill: pill, visible: usableFrame(), driving: driving) }

    // Which button your mouse is over (they take the click then; everywhere else it goes through).
    let mouse = NSEvent.mouseLocation
    stepPearl(now, dt: dt, at: PillMath.slotCenter(pill), mouse: mouse)
    let asking = content.card != nil
    let buttons = asking ? card?.layout : nil
    let cardOrigin = CGPoint(x: pill.minX, y: pill.maxY - (buttons?.size.height ?? 0))
    let overAction = buttons.map { $0.action.offsetBy(dx: cardOrigin.x, dy: cardOrigin.y).insetBy(dx: -2, dy: -2).contains(mouse) } ?? false
    let overCancel = buttons.map { $0.cancel.offsetBy(dx: cardOrigin.x, dy: cardOrigin.y).insetBy(dx: -2, dy: -2).contains(mouse) } ?? false
    let overStop = content.stop && !asking && PillMath.stopRect(pill).insetBy(dx: -4, dy: -4).contains(mouse)
    let overClose = !asking && PillMath.closeRect(pill).insetBy(dx: -3, dy: -3).contains(mouse)
    let overButton = showing && (overStop || overClose || overAction || overCancel)
    // Your mouse over the bar (not a button, not the card): it dims, so you can see what's under it.
    let overPill = showing && !asking && !overButton && pill.contains(mouse)
    peek += ((overPill ? 1 : 0) - peek) * CGFloat(1 - exp(-dt / 0.12))
    if panel.ignoresMouseEvents == overButton { panel.ignoresMouseEvents = !overButton }
    panel.alphaValue = appear.value * (1 - 0.6 * peek)

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    glass.frame = local
    glass.layer?.cornerRadius = min(local.height / 2, PillMath.corner + (PillMath.cardCorner - PillMath.corner) * grown.value)
    stop.frame = PillMath.stopRect(local)
    stop.isHidden = !content.stop || asking
    closeButton.frame = PillMath.closeRect(local)
    closeButton.isHidden = asking
    if let b = buttons {
      let o = CGPoint(x: local.minX, y: local.maxY - b.size.height)
      yes.frame = b.action.offsetBy(dx: o.x, dy: o.y)
      no.frame = b.cancel.offsetBy(dx: o.x, dy: o.y)
    }
    yes.isHidden = !asking
    no.isHidden = !asking
    // The pearl's own view, around its place at the island's left end.
    let slot = PillMath.slotCenter(local), reach = pearl.reach
    let pearlFrame = CGRect(x: (slot.x - reach).rounded(), y: (slot.y - reach).rounded(), width: 2 * reach, height: 2 * reach)
    let pearlMoved = pearlView.frame != pearlFrame
    if pearlMoved { pearlView.frame = pearlFrame }
    CATransaction.commit()
    // It redraws 60 times a second while Echo listens, thinks or speaks or a moment plays, and
    // 30 while it only breathes: nothing else in the island is redrawn for it.
    let fade = PillArt.pearlFade(away: away)
    let calm = ["idle", "sleepy", "needs"].contains(pearl.mood) && !pearl.busy(now: now)
    if pearlMoved || pearl.fade != fade || needsDraw || (pearl.moving && now - pearlDrawnAt >= (calm ? 1.0 / 31 : 1.0 / 61)) {
      pearl.fade = fade
      pearlDrawnAt = now
      pearlView.now = now
      pearlView.needsDisplay = true
    }

    let cardHover = overAction ? "action" : overCancel ? "cancel" : ""
    let cardDown = yes.isHighlighted ? "action" : no.isHighlighted ? "cancel" : ""
    let changed = overStop != art.stopHover || stop.isHighlighted != art.stopDown || overClose != art.closeHover
      || cardHover != art.cardHover || cardDown != art.cardDown || stopShown.value != art.stopShown || away != art.away
    art.stopHover = overStop
    art.stopDown = stop.isHighlighted
    art.closeHover = overClose
    art.cardHover = cardHover
    art.cardDown = cardDown
    art.stopShown = stopShown.value
    art.away = away
    let mixing = now - mixStart < 0.25
    let wordIn = now - newWordAt < 0.3
    let moving = appear.moving || width.moving || height.moving || grown.moving || stopShown.moving || lift != liftGoal || away != awayGoal
    let alive = moving || mixing || wordIn || lighting
    if alive || changed || pillRect != local || needsDraw || peek > 0.001 || pearl.moving { onChange?() }
    if alive || changed || pillRect != local || needsDraw {
      pillRect = local
      needsDraw = false
      pillView.needsDisplay = true
    }

    // Gone: stop everything until it's needed again.
    if !showing && !appear.moving { return finishHide() }
    // Nothing moving and the mouse elsewhere: rest (the hover check needs the clock only near it).
    // The pearl breathes, so that is only with reduced motion (it wakes for each slow blink).
    if showing && !alive && !pearl.moving && peek < 0.01 && !overButton && !home.insetBy(dx: -40, dy: -40).contains(mouse) {
      idleFrames += 1
      if idleFrames > 30 { idleFrames = 0; stopTicking(); scheduleWake() }
    } else {
      idleFrames = 0
    }
  }

  private var pillRect = CGRect.zero
  private var needsDraw = true
  private var idleFrames = 0

  /// While resting, look for the mouse a few times a second (to dim, or to wake a button).
  private func scheduleWake() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
      guard let self, self.showing, !self.ticking else { return }
      let due = CACurrentMediaTime() >= self.pearl.nextBlink
      if due || self.home.insetBy(dx: -40, dy: -40).contains(NSEvent.mouseLocation) { self.startTicking() } else { self.scheduleWake() }
    }
  }

  fileprivate func drawPill(in ctx: CGContext) {
    let now = CACurrentMediaTime()
    let scale = panel?.backingScaleFactor ?? 2
    let mix = previous == nil ? 1 : CGFloat(CompanionMath.easeOut((now - mixStart) / (Motion.reduced ? 0.15 : 0.22)))
    if mix >= 1 { previous = nil }
    let newWord = Motion.reduced ? 1 : CGFloat(min(1, max(0, (now - newWordAt) / 0.25)))
    art.echoLit = content.kind == .echo ? litShown : .infinity
    art.draw(in: ctx, pill: pillRect, content: content, previous: previous, mix: mix, newWord: newWord, pearl: nil,
             card: card, grown: grown.value, now: now, pixelScale: scale)
  }

  /// Echo's answer, one frame on: her words turn white as she says them (from her voice's timing,
  /// or an estimate when there's none), and when she reaches the end of the line showing, the next
  /// one fades in. True while anything is still changing.
  private func stepEcho(_ now: Double, dt: Double) -> Bool {
    guard content.kind == .echo, !echoWords.isEmpty else { litShown = 0; art.echoIn = 1; return false }
    let count = CGFloat(echoWords.count)
    let reduced = Motion.reduced
    if mode == "speaking" {
      let lit: CGFloat
      if let t = echoTiming {
        lit = SpeechMath.lit(starts: SpeechMath.align(t.starts, count: echoWords.count), at: now - t.start, fade: reduced ? 0 : 0.18)
      } else {
        // No timing from the voice (yet): an estimate, starting late enough not to run ahead of it.
        lit = SpeechMath.lit(starts: SpeechMath.estimate(echoWords, lead: 1.2), at: now - echoLineAt, fade: reduced ? 0 : 0.18)
      }
      litShown = min(count, max(litShown, lit))
    } else {
      // She stopped or finished: whatever's left comes up softly.
      litShown = reduced ? count : litShown + (count - litShown) * CGFloat(1 - exp(-dt / 0.12))
      if count - litShown < 0.01 { litShown = count }
    }
    art.echoLit = litShown
    let line = art.echoLineIndex
    if line != echoLine {
      echoLine = line
      echoLineChangedAt = now
    }
    art.echoIn = reduced ? 1 : CGFloat(min(1, max(0, (now - echoLineChangedAt) / 0.18)))
    return litShown < count || art.echoIn < 1
  }
}
