// The arithmetic behind the pointer, kept free of AppKit so it can be tested on its own
// (macos/Tests/main.swift, run by test/pointmath.test.js).
//
// Coordinate systems:
// - Accessibility (AX): global points, top-left origin at the top-left of the PRIMARY screen, y down.
// - AppKit (NSScreen, NSWindow): global points, bottom-left origin at the bottom-left of the
//   primary screen, y up. Other displays sit around it, so x and y can be negative.
// - A capture: pixels of one display (points × backing scale), top-left origin, y down.
import CoreGraphics
import Foundation

enum PointMath {
  /// A rectangle that can be pointed at: finite, not empty, not absurdly large.
  static func usable(_ r: CGRect) -> Bool {
    let v = [r.origin.x, r.origin.y, r.size.width, r.size.height]
    guard v.allSatisfy({ $0.isFinite }), !r.isNull, !r.isInfinite else { return false }
    return r.width >= 2 && r.height >= 2 && r.width < 100_000 && r.height < 100_000
  }

  /// Accessibility's top-left rectangle as AppKit's bottom-left one. The flip is always against
  /// the primary screen's height, whichever display the rectangle is on.
  static func axToAppKit(_ r: CGRect, primaryHeight: CGFloat) -> CGRect {
    CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
  }

  /// Pixels in a capture of `display` (AppKit points, top-left pixel origin) as AppKit screen points.
  static func imageToScreen(_ r: CGRect, display: CGRect, imageSize: CGSize) -> CGRect {
    let sx = display.width / imageSize.width, sy = display.height / imageSize.height
    return CGRect(x: display.minX + r.minX * sx, y: display.maxY - r.maxY * sy, width: r.width * sx, height: r.height * sy)
  }

  /// AppKit screen points as pixels in a capture of `display`.
  static func screenToImage(_ r: CGRect, display: CGRect, imageSize: CGSize) -> CGRect {
    let sx = imageSize.width / display.width, sy = imageSize.height / display.height
    return CGRect(x: (r.minX - display.minX) * sx, y: (display.maxY - r.maxY) * sy, width: r.width * sx, height: r.height * sy)
  }

  /// The part of the display to look at when only the window you're in matters: the window with a
  /// small margin, on the display. Nil (look at all of it) when the window is tiny, off the display,
  /// or nearly fills it anyway.
  static func windowArea(_ window: CGRect, display: CGRect, margin: CGFloat = 24) -> CGRect? {
    let area = window.insetBy(dx: -margin, dy: -margin).intersection(display)
    guard !area.isNull, area.width >= 200, area.height >= 150 else { return nil }
    guard area.width * area.height < display.width * display.height * 0.85 else { return nil }
    return area.integral
  }

  /// `area` (AppKit points on `display`) as a pixel rectangle in a capture of the display at `scale`.
  static func cropPixels(_ area: CGRect, display: CGRect, scale: CGFloat) -> CGRect {
    screenToImage(area, display: display, imageSize: CGSize(width: display.width * scale, height: display.height * scale)).integral
  }

  /// The screen showing most of `r` (its index in `screens`), or nil if it's on none of them.
  static func screenIndex(for r: CGRect, in screens: [CGRect]) -> Int? {
    var best: (Int, CGFloat)?
    for (i, s) in screens.enumerated() {
      let part = s.intersection(r)
      guard !part.isNull, part.width > 0, part.height > 0 else { continue }
      let area = part.width * part.height
      if best == nil || area > best!.1 { best = (i, area) }
    }
    return best?.0
  }

  /// The part of `target` you can actually see: inside every clipping area (the window, the
  /// scroll views it sits in) and on a screen. Nil unless its middle shows or at least half of it does.
  static func visiblePart(_ target: CGRect, clips: [CGRect], screens: [CGRect]) -> CGRect? {
    guard usable(target) else { return nil }
    var r = target
    for c in clips where usable(c) {
      r = r.intersection(c)
      if r.isNull || r.width < 1 || r.height < 1 { return nil }
    }
    guard let i = screenIndex(for: r, in: screens) else { return nil }
    r = r.intersection(screens[i])
    guard usable(r) else { return nil }
    let middle = CGPoint(x: target.midX, y: target.midY)
    guard r.contains(middle) || r.width * r.height >= target.width * target.height * 0.5 else { return nil }
    return r
  }

  /// One on-screen window, front to back as the window server lists them (global top-left points).
  struct Win {
    let pid: Int32
    let number: Int
    let bounds: CGRect
    let layer: Int
    let alpha: Double
  }

  /// Whose window really is at `point` (global top-left points): the front-most one there, skipping
  /// see-through windows and `skipping` (Echo's own click-through overlays: the border, the pointer,
  /// the caption bar). Echo's main window sitting *behind* another app's window doesn't count.
  static func topWindowOwner(at point: CGPoint, windows: [Win], skipping: Set<Int> = []) -> Int32? {
    for w in windows where !skipping.contains(w.number) && w.alpha > 0.01 && w.bounds.contains(point) {
      return w.pid
    }
    return nil
  }

  /// Which way to scroll `clip` (AppKit coordinates) to bring `target` into view, or nil.
  static func scrollDirection(_ target: CGRect, clip: CGRect) -> String? {
    if target.midY > clip.maxY { return "up" }
    if target.midY < clip.minY { return "down" }
    if target.midX < clip.minX { return "left" }
    if target.midX > clip.maxX { return "right" }
    return nil
  }
}

enum LabelMatch {
  /// Lower case, dashes of every kind (System Settings writes "Wi‑Fi" with U+2011) and other
  /// punctuation as spaces, runs of spaces collapsed.
  static func normalize(_ s: String) -> String {
    let folded = s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil).lowercased()
    let kept = folded.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
    return String(kept).split(separator: " ").joined(separator: " ")
  }

  /// Without the spaces: "wifi", "Wi-Fi" and "Wi‑Fi" are all "wifi".
  static func compact(_ s: String) -> String {
    normalize(s).replacingOccurrences(of: " ", with: "")
  }

  /// How well a label on screen matches what was asked for (0 = not at all).
  static func score(_ candidate: String, _ query: String) -> Int {
    let c = normalize(candidate), q = normalize(query)
    guard !c.isEmpty, !q.isEmpty, c.count <= 200 else { return 0 }
    if c == q { return 100 }
    let cc = c.replacingOccurrences(of: " ", with: ""), qc = q.replacingOccurrences(of: " ", with: "")
    if cc == qc && qc.count >= 3 { return 95 }
    if c.hasPrefix(q + " ") || (q.count >= 3 && q.hasPrefix(c + " ")) { return 75 }
    // The word somewhere in a long line (an inbox row, a tab title, a paragraph) is not the
    // label of the thing: "Compose" must not match "Re: compose the draft by Friday…".
    if " \(c) ".contains(" \(q) ") {
      let cw = c.split(separator: " ").count, qw = q.split(separator: " ").count
      return cw <= max(4, qw * 3) ? 60 : 40
    }
    let words = Set(q.split(separator: " ")), have = Set(c.split(separator: " "))
    if words.count > 1 && words.isSubset(of: have) { return 45 }
    return 0
  }

  /// Is this label the one a lesson's check asked for? Stricter than `score`, which is for finding
  /// something to point at and lets "Rectangle 1" land on "Rectangle" (on Oct 3 that passed the
  /// "Rectangle 1" and "Text" checks on the toolbar's tools and skipped a lesson from step 1 to 5).
  /// Exact: the whole label, case, accents, spacing and punctuation aside. Contains: the label holds
  /// those words, whole; never a label shorter than what was asked for. Keep in step with labelFits
  /// in lib/teach.js.
  static func fits(_ candidate: String, _ query: String, contains: Bool = false) -> Bool {
    let c = normalize(candidate), q = normalize(query)
    guard !c.isEmpty, !q.isEmpty else { return false }
    if c == q { return true }
    let qc = q.replacingOccurrences(of: " ", with: "")
    if qc.count >= 3 && c.replacingOccurrences(of: " ", with: "") == qc { return true }
    return contains && " \(c) ".contains(" \(q) ")
  }

  /// "search", "search field", "the search bar"…: the query names a search field rather than a label.
  static func asksForSearchField(_ query: String) -> Bool {
    let words = normalize(query).split(separator: " ").filter { !["the", "a", "field", "box", "bar"].contains($0) }
    return words == ["search"]
  }
}


// MARK: the island (Caption.swift draws it; this is where it goes and how big it is, kept testable)

/// The island: one small bar of near-black glass just under the menu bar, centred. Left to right:
/// the mark, one line of words, Stop while Echo works on the Mac, and the close button. It hugs
/// its words, and grows downward into a card when Echo needs an OK. (It was the caption pill at
/// the bottom of the screen: the name stays, the place and the look are new.)
enum PillMath {
  static let height: CGFloat = 46
  /// Corner radius: the bar's, and the card's.
  static let corner: CGFloat = 22, cardCorner: CGFloat = 24
  static let padLeft: CGFloat = 7, padRight: CGFloat = 12, gap: CGFloat = 14
  /// The pearl's width in the island: 7 pt of glass all round it, so it sits snug in the round end.
  static let mark: CGFloat = 32
  /// The close button (a small circle at the right end, always there) and the Stop capsule.
  static let close: CGFloat = 24
  static let stop: CGFloat = 52, buttonHeight: CGFloat = 28, buttonGap: CGFloat = 8
  /// Never wider than this, nor closer than 14 pt to either edge of the screen.
  static let maxWidth: CGFloat = 620
  /// The gap under the menu bar.
  static let top: CGFloat = 8

  private static func ends(_ hasStop: Bool) -> CGFloat {
    padLeft + mark + gap + (hasStop ? stop + buttonGap : 0) + close + padRight
  }

  /// The widest the island may be on a screen `screenWidth` wide.
  static func widest(screenWidth: CGFloat) -> CGFloat { max(ends(true), min(maxWidth, screenWidth - 28)) }

  /// How wide the island is for words `textWidth` wide. With no words: the mark and its buttons.
  static func width(text textWidth: CGFloat, stop hasStop: Bool, screenWidth: CGFloat) -> CGFloat {
    let w = ends(hasStop) + (textWidth > 0 ? textWidth.rounded(.up) + gap : 0)
    return min(w, widest(screenWidth: screenWidth))
  }

  /// The widest the words can be in an island of `width`.
  static func textRoom(width: CGFloat, stop hasStop: Bool) -> CGFloat { max(0, width - ends(hasStop) - gap) }

  /// Text from the page, on one line and trimmed. Blank (spaces, newlines) is "": no text, so it
  /// never holds the island open as an empty bar.
  static func clean(_ s: String?) -> String {
    (s ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  }

  /// The part of the screen the island may use: the visible frame, and never the strip beside a
  /// notch (`safeTop`, the screen's top safe-area inset), where a full-screen app leaves it bare.
  static func usable(visible: CGRect, screen: CGRect, safeTop: CGFloat) -> CGRect {
    let maxY = min(visible.maxY, screen.maxY - max(0, safeTop))
    return CGRect(x: visible.minX, y: visible.minY, width: visible.width, height: max(0, maxY - visible.minY))
  }

  /// Where the island goes (AppKit screen coordinates): top centre of the visible frame, just
  /// under the menu bar (never over it). When that would cover `avoid` (what Echo is working on)
  /// or 24 pt around it, it sits just under that instead, if there is room.
  static func frame(visible: CGRect, width: CGFloat, height h: CGFloat = height, avoid: CGRect? = nil) -> CGRect {
    let w = min(width, visible.width - 28)
    var r = CGRect(x: (visible.midX - w / 2).rounded(), y: visible.maxY - top - h, width: w, height: h)
    guard let a = avoid, PointMath.usable(a), r.insetBy(dx: -24, dy: -24).intersects(a) else { return r }
    let under = a.minY - 16 - h
    if under >= visible.minY + 12 { r.origin.y = under }
    return r
  }

  /// The top row of an island at `r` (the whole of it, unless it has grown into a card).
  private static func rowMidY(_ r: CGRect) -> CGFloat { r.maxY - height / 2 }

  /// The middle of the mark in an island at `r`. The mark that flies out to point leaves from
  /// here and lands back here.
  static func slotCenter(_ r: CGRect) -> CGPoint { CGPoint(x: r.minX + padLeft + mark / 2, y: rowMidY(r)) }

  /// Where the words start in an island at `r`.
  static func textX(_ r: CGRect) -> CGFloat { r.minX + padLeft + mark + gap }

  /// The close button in an island at `r`.
  static func closeRect(_ r: CGRect) -> CGRect {
    CGRect(x: r.maxX - padRight - close, y: rowMidY(r) - close / 2, width: close, height: close)
  }

  /// The Stop capsule, just left of the close button.
  static func stopRect(_ r: CGRect) -> CGRect {
    CGRect(x: closeRect(r).minX - buttonGap - stop, y: rowMidY(r) - buttonHeight / 2, width: stop, height: buttonHeight)
  }

  // The card: the island grown to ask for an OK. The mark, the question, its detail in grey
  // under it, and Cancel and the action button at the bottom right.

  static let cardWidth: CGFloat = 430, cardPadX: CGFloat = 16, cardPadY: CGFloat = 14
  /// One line of the card's text, the gap between the question and its detail, and above the buttons.
  static let cardLine: CGFloat = 20, cardDetailGap: CGFloat = 2, cardButtonsGap: CGFloat = 12
  /// A button is its label and this much either side.
  static let buttonPad: CGFloat = 13

  struct Card: Equatable {
    var size: CGSize
    /// Where each part goes inside the card (origin at its bottom-left corner, y up).
    var question: CGRect, detail: CGRect, cancel: CGRect, action: CGRect
  }

  static func cardWidth(screenWidth: CGFloat) -> CGFloat { min(cardWidth, screenWidth - 28) }

  /// How wide the card's text column is: the question and the detail are wrapped to this.
  static func cardTextWidth(screenWidth: CGFloat) -> CGFloat {
    cardWidth(screenWidth: screenWidth) - padLeft - mark - gap - cardPadX
  }

  /// The grown card for a question `questionLines` lines long with `detailLines` of detail (0:
  /// none) and buttons whose labels are this wide.
  static func card(questionLines: Int, detailLines: Int, cancelLabel: CGFloat, actionLabel: CGFloat, screenWidth: CGFloat) -> Card {
    let w = cardWidth(screenWidth: screenWidth), tw = cardTextWidth(screenWidth: screenWidth)
    let qh = CGFloat(max(1, questionLines)) * cardLine, dh = CGFloat(max(0, detailLines)) * cardLine
    // The first line sits where the bar's one line does, so the mark and the words don't jump.
    let topPad = (height - cardLine) / 2
    let text = qh + (dh > 0 ? cardDetailGap + dh : 0)
    let h = topPad + text + cardButtonsGap + buttonHeight + cardPadY
    let x = padLeft + mark + gap
    let action = CGRect(x: w - cardPadX - (actionLabel.rounded(.up) + 2 * buttonPad), y: cardPadY, width: actionLabel.rounded(.up) + 2 * buttonPad, height: buttonHeight)
    let cancelW = cancelLabel.rounded(.up) + 2 * buttonPad
    return Card(size: CGSize(width: w, height: h),
                question: CGRect(x: x, y: h - topPad - qh, width: tw, height: qh),
                detail: CGRect(x: x, y: h - topPad - text, width: tw, height: dh),
                cancel: CGRect(x: action.minX - buttonGap - cancelW, y: cardPadY, width: cancelW, height: buttonHeight),
                action: action)
  }

  /// The tallest a card gets (three lines of question, three of detail): the panel is this roomy.
  static var cardMaxHeight: CGFloat {
    card(questionLines: 3, detailLines: 3, cancelLabel: 0, actionLabel: 0, screenWidth: 2000).size.height
  }

  // What the bar says while Echo works on the Mac.

  /// The app Echo is driving, from the page's status line ("Driving: Excel"), or "".
  static func app(fromStatus status: String) -> String {
    let lead = "Driving: "
    return status.hasPrefix(lead) ? String(status.dropFirst(lead.count)) : ""
  }

  /// "Excel · step 2 of 4" in white and " · typing in A1" in grey: the app, the step, what she is
  /// doing. Whatever is missing is left out; with only the doing, that is the white part.
  static func working(app: String, step: String, what: String) -> (main: String, dim: String) {
    let lead = [app, step].filter { !$0.isEmpty }.joined(separator: " · ")
    if lead.isEmpty { return (what, "") }
    guard let first = what.first else { return (lead, "") }
    return (lead, " · " + first.lowercased() + what.dropFirst())
  }

  /// The reply field (ReplyField.swift): a small keyboard chip just right of the island, and the
  /// field it opens into, just under the island and centred on it, kept on the island's screen.
  static let chip: CGFloat = 30, fieldHeight: CGFloat = 38, fieldWidth: CGFloat = 380, fieldGap: CGFloat = 10

  /// The keyboard chip beside an island at `pill` (screen coordinates), inside `visible`.
  static func replyChip(pill: CGRect, visible: CGRect) -> CGRect {
    var x = pill.maxX + 8
    // No room on the right (an island near the screen's edge): on its left instead.
    if x + chip > visible.maxX - 4 { x = pill.minX - 8 - chip }
    return CGRect(x: x.rounded(), y: (rowMidY(pill) - chip / 2).rounded(), width: chip, height: chip)
  }

  /// The open reply field for an island at `pill`: under it (never over it), centred, on screen.
  static func replyField(pill: CGRect, visible: CGRect) -> CGRect {
    let w = min(fieldWidth, visible.width - 24)
    let x = min(max(pill.midX - w / 2, visible.minX + 12), visible.maxX - 12 - w)
    var y = pill.minY - fieldGap - fieldHeight
    // An island that moved down out of Echo's way, with no room under it: the field goes above.
    if y < visible.minY + 8 { y = pill.maxY + fieldGap }
    return CGRect(x: x.rounded(), y: y.rounded(), width: w, height: fieldHeight)
  }

  static let answerHeight: CGFloat = 26, answerGap: CGFloat = 6

  /// The row of quick answers ("Yes", "No") for an open reply field at `field`: centred under it,
  /// or above it when there is no room below, and never off the screen. `widths`: each button's width.
  static func replyAnswers(field: CGRect, widths: [CGFloat], visible: CGRect) -> CGRect {
    let w = widths.reduce(0, +) + answerGap * CGFloat(max(0, widths.count - 1))
    let x = min(max(field.midX - w / 2, visible.minX + 12), max(visible.minX + 12, visible.maxX - 12 - w))
    var y = field.minY - 8 - answerHeight
    if y < visible.minY + 8 { y = field.maxY + 8 }
    return CGRect(x: x.rounded(), y: y.rounded(), width: w.rounded(), height: answerHeight)
  }
}

// MARK: the pearl (Companion.swift draws it; these are its moods and its motion, kept testable)

/// Echo's companion: a black glass pearl with two white eyes and a rim of coloured light. It is
/// the living presence at the left of the island and the pointer that flies out to show things.
/// (The three bars are the logo: the app icon and the menu bar.) Everything here is y up, and
/// every size is a share of the pearl's radius, so it draws the same at 26 pt and at 300.
enum PearlMath {
  /// What it can feel. The first four follow Echo's voice; the rest are moments and waits.
  static let moods = ["idle", "listening", "thinking", "speaking", "happy", "surprised", "needs", "sorry", "sleepy"]

  /// It falls asleep after this long with nothing going on.
  static let sleepAfter = 180.0

  /// How long a moment lasts before the pearl goes back to what Echo is doing.
  static func lasts(_ mood: String) -> Double {
    switch mood {
    case "surprised": return 1.6
    case "happy": return 2.6
    case "sorry": return 3
    default: return 0
    }
  }

  /// The mood to show: a moment playing wins, then a question waiting for your OK, then Echo's
  /// voice, then work on the Mac (it thinks), then sleep after three quiet minutes.
  static func mood(voice: String, working: Bool, asking: Bool, moment: String?, idleFor: Double) -> String {
    if let m = moment, lasts(m) > 0 { return m }
    if asking { return "needs" }
    if ["listening", "thinking", "speaking"].contains(voice) { return voice }
    if working { return "thinking" }
    return idleFor >= sleepAfter ? "sleepy" : "idle"
  }

  /// Where a mood wants everything to be. The drawing eases towards it, so moods blend.
  struct Pose: Equatable {
    /// The eyes: 1 is open, 0 shut, more is wide.
    var open: CGFloat = 1
    /// 0…1: smiling eyes (little arches past 0.55).
    var happy: CGFloat = 0
    /// 0…1: how bright and wide the rim's light is.
    var energy: CGFloat = 0.3
    /// 0…1: the light turned down (sorry, asleep).
    var dim: CGFloat = 0
    /// Radians it tips its head, clockwise.
    var tilt: CGFloat = 0
    /// 0…1: one raised brow.
    var brow: CGFloat = 0
    /// 0…1: leaning in to hear.
    var lean: CGFloat = 0
    /// Where the eyes look, -1…1 each way (x right, y up).
    var look = CGPoint.zero
  }

  /// The pose for `mood`, `age` seconds into it, at time `t`, with a voice `level` 0…1.
  /// `glance` is where its eyes have wandered by themselves; `pointer` is the mouse when it is
  /// near (it wins the eyes in the calm moods); `target` is something it is showing you (it wins
  /// in every mood but sleep). Reduced motion: nothing here moves with time or the voice.
  static func pose(_ mood: String, level: Double = 0, age: Double = 1, t: Double = 0, glance: CGPoint = .zero,
                   pointer: CGPoint? = nil, target: CGPoint? = nil, reduced: Bool = false) -> Pose {
    let v = reduced ? 0 : CGFloat(min(max(level.isFinite ? level : 0, 0), 1))
    var p = Pose(look: reduced ? .zero : glance)
    switch mood {
    case "listening": p.open = 1.22; p.energy = 0.55 + v * 0.5; p.lean = 1; p.look = CGPoint(x: 0, y: -0.1)
    case "thinking": p.open = 0.8; p.energy = 0.8; p.look = CGPoint(x: 0.55, y: 0.6)
    case "speaking": p.open = 0.92 - v * 0.2; p.happy = 0.35; p.energy = 0.6 + v * 0.6; p.look = .zero
    case "happy": p.happy = 1; p.energy = 1
    case "surprised": p.open = age < 0.7 ? 1.5 : 1.2; p.energy = 0.9; p.look = CGPoint(x: 0, y: 0.1)
    case "needs": p.tilt = 0.2; p.brow = 1; p.energy = 0.7 + (reduced ? 0 : 0.3 * CGFloat(sin(t * 4))); p.look = .zero
    case "sorry": p.open = 0.6; p.dim = 0.6; p.energy = 0.12; p.look = CGPoint(x: 0, y: -0.75)
    case "sleepy": p.open = 0.04; p.dim = 0.75; p.energy = 0.08; p.look = CGPoint(x: 0, y: -0.3)
    default: break
    }
    if let m = pointer, ["idle", "listening", "speaking", "needs"].contains(mood) { p.look = m }
    if let m = target, mood != "sleepy" { p.look = m }
    return p
  }

  /// One frame of easing: `value` towards `target` at `rate` per second (the same at 60 or 120 Hz).
  static func ease(_ value: CGFloat, toward target: CGFloat, rate: Double, dt: Double) -> CGFloat {
    value + (target - value) * CGFloat(1 - exp(-rate * max(dt, 0)))
  }

  /// A made-up voice, for when Echo speaks and nothing says how loud: the rim still moves with her.
  static func babble(_ t: Double) -> Double {
    let v = max(0, sin(t * 7.3) * 0.5 + sin(t * 12.1 + 1) * 0.3 + sin(t * 3.1) * 0.35) * (0.6 + 0.4 * sin(t * 1.7))
    return min(1, v)
  }

  // MARK: eyes

  /// Which way to look at `to` from `from` (same coordinates, y up), -1…1 each way: all the way
  /// round by `full` points off, straight ahead when it is on top of you. Nil past `reach`.
  static func gaze(from: CGPoint, to: CGPoint, reach: CGFloat = .infinity, full: CGFloat = 60) -> CGPoint? {
    let dx = to.x - from.x, dy = to.y - from.y, d = hypot(dx, dy)
    guard d.isFinite, d <= reach else { return nil }
    guard d > 0.5 else { return .zero }
    let k = min(1, d / max(full, 1)) / d
    return CGPoint(x: dx * k, y: dy * k)
  }

  /// When the next blink comes after one at `t` (`roll` 0…1): every 2.2 to 5.7 s. Reduced motion:
  /// further apart.
  static func nextBlink(after t: Double, roll: Double, reduced: Bool = false) -> Double {
    t + (reduced ? 5 + roll * 4 : 2.2 + roll * 3.5)
  }
  /// How fast a blink opens again (per second): about a seventh of a second, or a slow one.
  static func blinkRate(reduced: Bool) -> Double { reduced ? 2.5 : 7 }

  /// Somewhere to glance by itself (rolls 0…1): mostly sideways, a little up or down.
  static func glance(_ rollX: Double, _ rollY: Double) -> CGPoint { CGPoint(x: (rollX - 0.5) * 1.1, y: (rollY - 0.5) * 0.6) }
  static func nextGlance(after t: Double, roll: Double) -> Double { t + 1.5 + roll * 3 }

  /// Small pearls (under 48 pt) get bolder eyes; under 32 pt there is no brow and no "z".
  static func bold(diameter: CGFloat) -> Bool { diameter < 48 }
  static func detailed(diameter: CGFloat) -> Bool { diameter >= 32 }

  /// The two eyes, around the pearl's centre.
  struct Eyes: Equatable {
    enum Shape: Equatable { case open, shut, smile }
    var shape = Shape.open
    /// The middle of the left and the right eye.
    var left = CGPoint.zero, right = CGPoint.zero
    var width: CGFloat = 0, height: CGFloat = 0
  }

  static func eyes(radius R: CGFloat, open: CGFloat, blink: CGFloat, happy: CGFloat, look: CGPoint) -> Eyes {
    let bold = bold(diameter: R * 2)
    let w = R * (bold ? 0.185 : 0.135)
    let full = R * (bold ? 0.27 : 0.215)
    var h = full * max(0.05, open * (1 - min(max(blink, 0), 1)))
    let x = R * 0.27, ox = min(max(look.x, -1), 1) * R * 0.26
    let y = R * 0.06 + min(max(look.y, -1), 1) * R * 0.2
    var shape = Eyes.Shape.open
    if happy > 0.55 { shape = .smile } else if h < R * 0.04 { shape = .shut } else { h *= 1 - happy * 0.35 }
    return Eyes(shape: shape, left: CGPoint(x: ox - x, y: y), right: CGPoint(x: ox + x, y: y), width: w, height: max(h, shape == .open ? w * 0.5 : 0))
  }

  // MARK: the rim of light

  /// The rim's arc: it runs anticlockwise from `from` for `span` radians. A full ring when it
  /// listens, speaks or is happy; a comet circling clockwise while it thinks (`comet`: its head
  /// is at `from`); else a crescent at the lower right that sways a little and widens with energy.
  static func rim(_ mood: String, energy: CGFloat, t: Double, reduced: Bool = false) -> (from: CGFloat, span: CGFloat, comet: Bool) {
    switch mood {
    case "listening", "speaking", "happy":
      return (0, 2 * .pi, false)
    case "thinking":
      // Reduced motion: the comet rests at the upper right, where the eyes look.
      let head = reduced ? .pi / 4 - 0.95 : -CGFloat((t * 3.2).truncatingRemainder(dividingBy: 2 * .pi)) - 1.9
      return (head, 1.9, true)
    default:
      let span = 1.25 + min(max(energy, 0), 1.2) * 0.9
      let mid = -(0.9 + (reduced ? 0 : 0.25 * CGFloat(sin(t * 0.5))))
      return (mid - span / 2, span, false)
    }
  }

  /// How far round the colours have turned: slowly, faster while it thinks.
  static func rimTurn(_ mood: String, t: Double, reduced: Bool = false) -> CGFloat {
    reduced ? 0 : -CGFloat((t * (mood == "thinking" ? 2.4 : 0.25)).truncatingRemainder(dividingBy: 2 * .pi))
  }

  /// The rim's line width for a pearl of radius `R`: thicker with energy and with each word.
  static func rimWidth(radius R: CGFloat, energy: CGFloat, level: CGFloat, speaking: Bool) -> CGFloat {
    max(1.5, R * (0.035 + 0.05 * energy + (speaking ? level * 0.05 : 0)))
  }
  static func rimAlpha(energy: CGFloat, dim: CGFloat) -> CGFloat { min(1, 0.35 + energy * 0.8) * (1 - dim * 0.7) }

  // MARK: rings and sparkles

  /// An echo ring: its radius (in pearl radii) and how strong it is.
  struct Ring: Equatable { var r: CGFloat = 1.02, a: CGFloat = 0.8 }

  /// A new ring each time your voice rises while it listens, once the last one is clear.
  static func ringDue(mood: String, level: Double, last: Ring?) -> Bool {
    mood == "listening" && level > 0.5 && (last.map { $0.r > 1.35 } ?? true)
  }
  /// A ring one frame on, or nil when it has faded.
  static func step(_ ring: Ring, dt: Double) -> Ring? {
    let next = Ring(r: ring.r + CGFloat(dt) * 0.85, a: ring.a - CGFloat(dt) * 0.75)
    return next.a > 0 ? next : nil
  }

  /// A sparkle: where (an angle, and pearl radii out), how fast, how much life, its spin and size.
  struct Spark: Equatable { var angle: CGFloat, r: CGFloat = 1.05, v: CGFloat, life: CGFloat = 1, spin: CGFloat, size: CGFloat }

  /// A burst of twelve, from rolls 0…1 (four per sparkle).
  static func sparks(_ roll: () -> Double) -> [Spark] {
    (0..<12).map { _ in Spark(angle: CGFloat(roll()) * 2 * .pi, v: 0.9 + CGFloat(roll()) * 0.9, spin: CGFloat(roll()) * 2 * .pi, size: 0.05 + CGFloat(roll()) * 0.06) }
  }
  static func step(_ s: Spark, dt: Double) -> Spark? {
    var n = s
    let d = CGFloat(dt)
    n.r += n.v * d
    n.v *= max(0, 1 - d * 1.6)
    n.life -= d * 0.9
    n.spin += d * 3
    return n.life > 0 ? n : nil
  }

  // MARK: its body

  /// The start of a moment: how high it hops (pearl radii) and how it stretches (negative: tall).
  static func kick(_ mood: String) -> (lift: CGFloat, squash: CGFloat) {
    switch mood {
    case "surprised": return (0.31, -0.34)
    case "happy": return (0.4, -0.2)
    default: return (0, 0)
    }
  }

  /// Squash and stretch: `squash` above zero is flatter and wider, below is taller and thinner.
  static func scale(squash: CGFloat) -> (x: CGFloat, y: CGFloat) { (1 + squash * 0.6, 1 - squash) }

  /// Half the side of the square it draws in: room for its hop, its halo, its rings and sparkles.
  static func reach(diameter: CGFloat) -> CGFloat { (diameter * 1.4 + 6).rounded(.up) }

  // MARK: jelly

  /// Its squash is a spring, so every landing, tap and hop wobbles and settles like jelly:
  /// `squash` and how fast it is changing, one frame on.
  static func jelly(_ squash: CGFloat, speed: CGFloat, dt: Double) -> (squash: CGFloat, speed: CGFloat) {
    var s = squash, v = speed, left = min(max(dt, 0), 0.1)
    // Small steps, so a slow frame can't make it blow up.
    while left > 1e-6 {
      let h = CGFloat(min(left, 1.0 / 120))
      v += (-170 * s - 13 * v) * h
      s += v * h
      left -= Double(h)
    }
    return (s, v)
  }

  // MARK: at work: the firefly

  /// Its light: a small core (6.6 pt across) with a soft glow, so it never hides what it shows.
  static let lightRadius: CGFloat = 3.3

  /// Where on the pearl's rim its light leaves from and comes home to: the side facing `p`.
  static func rim(of center: CGPoint, radius: CGFloat, toward p: CGPoint) -> CGPoint {
    let dx = p.x - center.x, dy = p.y - center.y, d = hypot(dx, dy)
    guard d > 0.5 else { return CGPoint(x: center.x + radius, y: center.y) }
    return CGPoint(x: center.x + dx / d * radius, y: center.y + dy / d * radius)
  }

  /// The light's trail lasts this long behind it, fading and thinning to nothing.
  static let trailLife = 0.3
  /// (`life`: searching, it lingers longer, so the figure of eight it is drawing can be seen.)
  static let searchTrailLife = 1.3
  static func trail(age: Double, life: Double = trailLife) -> (alpha: CGFloat, width: CGFloat) {
    let u = CGFloat(min(max(age / max(life, 0.01), 0), 1))
    return (0.7 * (1 - u) * (1 - u), 2 * lightRadius * (0.72 - 0.6 * u))
  }

  /// One flight of the light: a gentle curve (never a straight line), slow away, fast in the
  /// middle, slow in. Further takes a little longer. `quick`: the short straight dive of a click.
  struct Flight {
    var from: CGPoint
    /// Where it lands. It may move while the flight is on (the island it is going home to slides).
    var to: CGPoint
    let start: Double, duration: Double
    /// How far the curve bows off the straight line, as a share of its length (to the left of
    /// the way it is going; upward when it flies level).
    let bow: CGFloat

    init(from: CGPoint, to: CGPoint, at start: Double, quick: Bool = false) {
      self.from = from
      self.to = to
      self.start = start
      let d = hypot(to.x - from.x, to.y - from.y)
      duration = quick ? 0.13 : min(0.62, 0.3 + Double(d) * 0.0003)
      // Bowed towards the top of the screen whichever way it flies.
      bow = quick ? 0 : (to.x >= from.x ? 0.16 : -0.16)
    }

    var lands: Double { start + duration }
    func done(at now: Double) -> Bool { now >= lands }
    func progress(at now: Double) -> CGFloat { CGFloat(min(max((now - start) / duration, 0), 1)) }

    func position(at now: Double) -> CGPoint {
      let k = progress(at: now), e = k * k * (3 - 2 * k), m = 1 - e
      let dx = to.x - from.x, dy = to.y - from.y
      // The curve's handle: off the middle of the line, to its left.
      let c = CGPoint(x: (from.x + to.x) / 2 - dy * bow, y: (from.y + to.y) / 2 + dx * bow)
      return CGPoint(x: m * m * from.x + 2 * m * e * c.x + e * e * to.x, y: m * m * from.y + 2 * m * e * c.y + e * e * to.y)
    }
  }

  /// The path the light circles to show `r`: round its edge, `gap` outside it (so it never
  /// covers the thing), with soft corners. `laps` 0 is the right end of the top edge; it goes
  /// clockwise, at an even pace, once round for each whole number.
  static func orbit(_ r: CGRect, laps: Double, gap: CGFloat = 7) -> CGPoint {
    let b = r.insetBy(dx: -gap, dy: -gap), c = min(gap + 5, b.width / 2, b.height / 2)
    let w = b.width - 2 * c, h = b.height - 2 * c, q = CGFloat.pi / 2 * c
    var u = laps.truncatingRemainder(dividingBy: 1)
    if u < 0 { u += 1 }
    var d = CGFloat(u) * (2 * w + 2 * h + 4 * q)
    func corner(_ cx: CGFloat, _ cy: CGFloat, from a: CGFloat) -> CGPoint {
      let angle = a - (q > 0 ? d / c : 0)
      return CGPoint(x: cx + cos(angle) * c, y: cy + sin(angle) * c)
    }
    if d < q { return corner(b.maxX - c, b.maxY - c, from: .pi / 2) }
    d -= q
    if d < h { return CGPoint(x: b.maxX, y: b.maxY - c - d) }
    d -= h
    if d < q { return corner(b.maxX - c, b.minY + c, from: 0) }
    d -= q
    if d < w { return CGPoint(x: b.maxX - c - d, y: b.minY) }
    d -= w
    if d < q { return corner(b.minX + c, b.minY + c, from: -.pi / 2) }
    d -= q
    if d < h { return CGPoint(x: b.minX, y: b.minY + c + d) }
    d -= h
    if d < q { return corner(b.minX + c, b.maxY - c, from: .pi) }
    d -= q
    return CGPoint(x: b.minX + c + min(d, w), y: b.maxY)
  }

  /// How long once round takes: a small button in about a second, a whole window in under
  /// three (it never crawls, and never races).
  static func lap(_ r: CGRect, gap: CGFloat = 7) -> Double {
    min(2.6, max(1.1, Double(2 * (r.width + r.height) + 8 * gap) / 380))
  }
  /// It shows a thing by going round it this many times, then rests at its top-right corner.
  static let laps = 2.0

  // MARK: how long to show a thing, and whether the point landed

  /// A thing under this many points on its short side is small: easy to miss, so it is shown longer.
  static let smallSide: CGFloat = 28

  /// How many other things could be mistaken for the one found: the finder's runners-up whose
  /// label matched nearly as well (within `margin` of its score) and that sit within `reach`
  /// points of it. What lies on the thing itself (the text inside the button) is not a rival.
  static func rivals(of best: CGRect, score: Int, among others: [(score: Int, frame: CGRect)], reach: CGFloat = 220, margin: Int = 15) -> Int {
    others.filter { o in
      o.score >= score - margin && !o.frame.intersects(best)
        && hypot(o.frame.midX - best.midX, o.frame.midY - best.midY) <= reach
    }.count
  }

  /// How the light shows a thing it is only pointing at (people hold a point longer on a small
  /// or crowded target): how many times round, and how long it stays before it may leave. A
  /// large thing on its own: about 2 seconds. A small one, or one with two or more look-alikes
  /// beside it: once more round, and 3 to 4 seconds.
  static func show(_ r: CGRect, rivals: Int = 0) -> (laps: Double, seconds: Double) {
    let once = lap(r), easy = max(1, (2 / once).rounded())
    guard min(r.width, r.height) < smallSide || rivals >= 2 else { return (easy, max(2, easy * once)) }
    return (easy + 1, min(4, max(3, (easy + 1) * once)))
  }

  /// Does the caption beside the light stay when its time is up? While the light waits for you
  /// (on a lesson step: "Your turn"; for your OK: "Is this OK?") it does, until the light is let
  /// go. Every other caption fades by itself.
  static func captionStays(waiting: Bool, intent: String) -> Bool { waiting || intent == "ask" }

  /// Did the point land? After showing a thing the pearl glances at your pointer; from then this
  /// watches where your mouse goes. If it moves and comes to rest far from the thing, and not on
  /// its way to it, you are looking somewhere else: the light goes round once more, slowly, and
  /// its caption comes back. Once, within a few seconds of the point; while the light waits on a
  /// lesson step, again each time your mouse wanders off, but never more often than `every`.
  struct Landed: Equatable {
    /// Further than this from the thing is somewhere else; this long still is settled; the
    /// mouse has to have gone at least `moved` to count as having gone anywhere.
    static let far: CGFloat = 250, still = 0.4, moved: CGFloat = 40
    /// A plain point is checked for this long; a waiting light nudges at most this often.
    static let window = 4.0, every = 12.0
    /// The slow lap takes this many times a showing lap.
    static let slow = 1.6

    private var from: CGPoint?
    private var last = CGPoint.zero
    private var began = 0.0, movedAt = 0.0
    private var nudgedAt: Double?

    /// The watch starts (the glance is over): where your mouse is now.
    mutating func begin(mouse: CGPoint, now: Double) {
      self = Landed()
      from = mouse
      last = mouse
      began = now
      movedAt = now
    }

    var watching: Bool { from != nil }

    /// One look at your mouse. True: point again. `held`: the light is waiting on a lesson step.
    mutating func look(mouse: CGPoint, target: CGRect, now: Double, held: Bool) -> Bool {
      guard let from else { return false }
      if hypot(mouse.x - last.x, mouse.y - last.y) > 2 {
        last = mouse
        movedAt = now
        return false
      }
      // Already pointed again: once is all for a plain point; a waiting light, not too often.
      if let n = nudgedAt, !held || now - n < Landed.every { return false }
      if !held, now - began > Landed.window { return false }
      let c = CGPoint(x: target.midX, y: target.midY)
      let went = CGVector(dx: mouse.x - from.x, dy: mouse.y - from.y), toIt = CGVector(dx: c.x - from.x, dy: c.y - from.y)
      let d = hypot(went.dx, went.dy), t = hypot(toIt.dx, toIt.dy)
      guard now - movedAt >= Landed.still, d > Landed.moved, hypot(mouse.x - c.x, mouse.y - c.y) > Landed.far else { return false }
      // On its way to the thing (within 45 degrees of the straight line there): it landed.
      if t > 0, (went.dx * toIt.dx + went.dy * toIt.dy) / (d * t) > 0.7 { return false }
      nudgedAt = now
      self.from = mouse
      return true
    }
  }

  /// A click's burst: how far its ripple and its sparks have spread (points) and how strong
  /// they are, `t` seconds after the light touched down. Over in 450 ms.
  static func burst(elapsed t: Double) -> (spread: CGFloat, alpha: CGFloat)? {
    let u = t / 0.45
    guard u >= 0, u < 1 else { return nil }
    let e = 1 - pow(1 - u, 3)
    return (4 + 18 * CGFloat(e), CGFloat(1 - u))
  }

  /// Typing: the light hops as each character goes in (points up, over 130 ms).
  static func typeHop(elapsed t: Double) -> CGFloat {
    let u = t / 0.13
    guard u >= 0, u < 1 else { return 0 }
    return 5 * CGFloat(sin(u * .pi))
  }

  /// A scroll: the light rides up and down beside the list, twice over 1.2 s, never more than
  /// 60 pt either way. Points above its resting place.
  static func ride(elapsed t: Double, height: CGFloat) -> CGFloat {
    let u = t / 1.2
    guard u >= 0, u < 1 else { return 0 }
    return -min(60, height / 3) * CGFloat(sin(u * .pi * 4) * sin(u * .pi))
  }

  // MARK: at work: the firefly's colour, its waits, its searches, and being picked up

  /// Why the light is out: Echo is only showing something ("show"), is about to act there
  /// ("act"), or is waiting for your OK before a risky step ("ask"). Anything else is "show".
  static let intents = ["show", "act", "ask"]
  static func intent(_ id: String?) -> String { intents.contains(id ?? "") ? id! : intents[0] }

  /// The answer's colours (blue, violet, pink, amber), as 0xRRGGBB.
  static let answerHex: [UInt32] = [0x4780FF, 0xA866FF, 0xFF669E, 0xFFB866]

  /// The light's colours for an intent: white while it shows, the answer's gradient while it
  /// acts, amber while it asks.
  static func lightColours(_ intent: String?) -> [UInt32] {
    switch PearlMath.intent(intent) {
    case "act": return answerHex
    case "ask": return [answerHex[3]]
    default: return [0xFFFFFF]
    }
  }

  /// Waiting on a lesson step: the light breathes, 0…1 and back every 2.6 s (a slow breath, not a blink).
  static func breath(_ t: Double) -> CGFloat { CGFloat(0.5 - 0.5 * cos(t * 2 * .pi / 2.6)) }

  /// Asking: where the light hovers, beside the thing and never touching it: off its right edge
  /// at mid-height, or off its left when there is no room on the right.
  static func hover(beside r: CGRect, in bounds: CGRect, gap: CGFloat = 14) -> CGPoint {
    let right = r.maxX + gap, y = min(max(r.midY, bounds.minY + gap), bounds.maxY - gap)
    return CGPoint(x: right <= bounds.maxX - 6 ? right : max(bounds.minX + 6, r.minX - gap), y: y)
  }

  /// A find that takes longer than this shows the light searching.
  static let searchAfter = 0.4
  /// One figure of eight takes this long: slow, so it reads as looking, not as busy.
  static let searchLoop = 3.2

  /// The searching loop: a small figure of eight around `c`, 28 pt to each side and 11 up and
  /// down, starting (and passing twice a loop) at `c` itself.
  static func search(around c: CGPoint, elapsed t: Double) -> CGPoint {
    let a = t * 2 * .pi / searchLoop
    return CGPoint(x: c.x + 28 * CGFloat(sin(a)), y: c.y + 11 * CGFloat(sin(2 * a)))
  }

  /// The box that loop stays in.
  static func searchBox(around c: CGPoint) -> CGRect { CGRect(x: c.x - 28, y: c.y - 11, width: 56, height: 22) }

  /// Where it searches: near the middle of the app's window (the part of it on this screen), a
  /// little above the middle of the screen when there is no window to go by.
  static func searchCentre(window: CGRect?, screen: CGRect) -> CGPoint {
    if let w = window, PointMath.usable(w) {
      let seen = w.intersection(screen)
      if !seen.isNull, seen.width >= 80, seen.height >= 60 { return CGPoint(x: seen.midX, y: seen.midY) }
    }
    return CGPoint(x: screen.midX, y: screen.minY + screen.height * 0.58)
  }
  /// What the light is waiting on, and which finds are still running. A lesson step's light
  /// stays until the lesson lets it go; a risky step's light stays until its card is answered.
  /// A wait never ends by itself: only a release that names it, or `drop`, ends it.
  ///
  /// The release can beat the find: the lesson is stopped, moves on or gets new steps while the
  /// app is still looking for the step's target. A step let go that early is remembered until
  /// every find for it is over, and is not taken when one of them comes back: nobody would ever
  /// release it again, and the light would wait there for good.
  struct Hold: Equatable {
    /// The lesson step or the confirmation the light is waiting on ("" when none), and which.
    private(set) var id = ""
    private(set) var asking = false
    /// The requests whose find is still running, and the ones the server stopped waiting for
    /// (nothing is answered for those, and nothing is shown for them).
    private(set) var working: [String] = []
    private(set) var calledOff: [String] = []
    /// The lesson step each running find is for (request: step), and the steps that were let
    /// go while a find for them was still running.
    private var steps: [String: String] = [:]
    private(set) var letGo: [String] = []

    var waiting: Bool { !id.isEmpty }

    /// What a release means for the light.
    enum Let: Equatable {
      /// Not ours (an old wait, or one this app never had): nothing happens.
      case ignore
      /// The step passed: a small burst and a pleased blink, then on to the next or home.
      case burst
      /// You allowed the risky step: the light stays for the click that follows, no longer asking.
      case proceed
      /// Skipped or stopped: it just leaves, quietly.
      case leave
      /// Not found: it goes home, and the pearl is sorry.
      case lost
      /// A step let go while its target was still being looked for: the light never got there,
      /// and now never will. What is found for it is not shown; a light out searching goes home.
      case early
    }

    private static func short(_ step: String?) -> String { String((step ?? "").prefix(40)) }

    /// Was this step let go while a find for it was still running? Then a point for it shows nothing.
    func refuses(step: String?) -> Bool {
      let s = Hold.short(step)
      return !s.isEmpty && letGo.contains(s)
    }

    /// A point holds the light on a lesson step (nil or "": this point waits on nothing, which
    /// also ends any wait before it). The same step again is the same wait. False, and nothing
    /// changes, for a step that was let go before its find came back.
    @discardableResult
    mutating func take(step: String?) -> Bool {
      guard !refuses(step: step) else { return false }
      id = Hold.short(step)
      asking = false
      return true
    }

    /// A risky step holds the light until its card is answered.
    mutating func take(ask: String) {
      guard !ask.isEmpty else { return }
      id = String(ask.prefix(40))
      asking = true
    }

    /// The app starts its own find for a request; `step`: the lesson step it will hold the light
    /// for, if any.
    mutating func began(_ request: String, step: String? = nil) {
      guard !request.isEmpty else { return }
      if !working.contains(request) { working.append(request) }
      while working.count > 8 { forget(working[0]) }
      let s = Hold.short(step)
      if !s.isEmpty { steps[request] = s }
    }

    /// The lesson step a running find is for (nil: none, or the find is over).
    func step(of request: String?) -> String? { request.flatMap { steps[$0] } }

    /// A find is over, one way or another. A step let go early is forgotten with its last find.
    private mutating func forget(_ request: String) {
      working.removeAll { $0 == request }
      guard let s = steps.removeValue(forKey: request), !steps.values.contains(s) else { return }
      letGo.removeAll { $0 == s }
    }

    /// The app's find for a request is over. False when the server had stopped waiting for it:
    /// then there is nothing to answer.
    mutating func ended(_ request: String) -> Bool {
      forget(request)
      return !calledOff.contains(request)
    }

    func isCalledOff(_ request: String) -> Bool { calledOff.contains(request) }

    /// A release from the server: a lesson step, a confirmation, or a request it gave up on.
    mutating func release(_ name: String, outcome: String) -> Let {
      guard !name.isEmpty else { return .ignore }
      if working.contains(name) {
        forget(name)
        calledOff.append(name)
        if calledOff.count > 8 { calledOff.removeFirst(calledOff.count - 8) }
        return .lost
      }
      // A find for this step is still running (its first point, or a hint's): what it finds
      // must not take the light again.
      let early = steps.values.contains(name)
      if early, !letGo.contains(name) { letGo.append(name) }
      guard name == id else { return early ? .early : .ignore }
      let wasAsking = asking
      id = ""
      asking = false
      switch outcome {
      case "done": return wasAsking ? .proceed : .burst
      case "not_found": return .lost
      default: return .leave
      }
    }

    /// The line to the server dropped, the run ended, or Echo is quitting: nothing waits any
    /// more. `asksOnly`: only a risky step's wait ends (the run it belonged to is over; a lesson
    /// goes on). True when something was let go.
    mutating func drop(asksOnly: Bool = false) -> Bool {
      guard waiting, !asksOnly || asking else { return false }
      id = ""
      asking = false
      return true
    }
  }

  /// A find that is slow shows the light searching, and whatever the light was doing before is
  /// over: a route being walked for another request stops there. The walk's own search (its
  /// first label is slow to find) must not stop the walk it belongs to: that walk would never
  /// answer, and the request would wait out its whole time.
  static func searchStops(walk: String?, for search: String) -> Bool { walk != nil && walk != search }

  /// How often the light is drawn. Every frame while it moves (it flies, circles, searches, is
  /// in your hand, rides a scroll, hops as Echo types) and for a moment after, so a trail fades
  /// and a burst plays out. At rest (waiting on a lesson step, hovering by a card, sitting at
  /// its corner) it only breathes and bobs: about 20 pictures a second, however long it waits.
  struct Pace: Equatable {
    /// The gap between pictures at rest, and how long after the last movement it stays lively.
    static let rest = 1.0 / 20
    static let settle = 0.6
    private var livelyUntil = -Double.infinity

    /// Is a picture due at `now`? `last`: when the one before was drawn.
    mutating func due(now: Double, last: Double, moving: Bool) -> Bool {
      if moving { livelyUntil = now + Pace.settle }
      // A display's frames never land exactly on the gap: within 2 ms of it counts.
      return now < livelyUntil || now - last >= Pace.rest - 0.002
    }
  }

  /// The light at rest is never quite still: it wanders a few points round its place, slowly and
  /// never the same way twice in a row, and every few seconds it flits (a quick small loop, like
  /// a firefly changing its mind). `elapsed`: seconds since it came to rest (the wander eases in
  /// over the first 0.6 s, so it lands cleanly first). Asking, it hovers slower and wider and does
  /// not flit (it is waiting for you; it should not look distracted).
  static func restDrift(elapsed: Double, asking: Bool = false) -> CGPoint {
    guard elapsed > 0 else { return .zero }
    let t = elapsed, ease = CGFloat(min(1, t / 0.6))
    if asking {
      return CGPoint(x: ease * 2.0 * CGFloat(sin(t * 0.8)), y: ease * 2.6 * CGFloat(sin(t * 1.7)))
    }
    var x = 3.0 * sin(t * 0.9) + 1.3 * sin(t * 2.3 + 1.0), y = 2.2 * sin(t * 1.3 + 0.5) + 1.1 * sin(t * 3.1)
    // The flit: for 0.55 s in every restFlitEvery, one quick loop 5 pt across, in and out smoothly.
    let u = t.truncatingRemainder(dividingBy: restFlitEvery) - (restFlitEvery - 0.55)
    if u > 0 {
      let k = u / 0.55, swell = sin(k * .pi)
      x += 4 * swell * cos(k * 2 * .pi)
      y += 4 * swell * sin(k * 2 * .pi)
    }
    return CGPoint(x: ease * CGFloat(x), y: ease * CGFloat(y))
  }
  static let restFlitEvery = 4.6

  // MARK: the light's small gestures (echo-talk-design.html, "Firefly moves")

  /// A gesture of the light, as an offset from where it is (y up), or nil once it is over.
  /// "nod": yes, a step worked: two quick dips. "shake": no, or sorry: three small swings.
  /// "spiral": the job is done: it winds upward and ends in a burst of sparks.
  static func gesture(_ kind: String, elapsed t: Double) -> CGPoint? {
    guard t >= 0 else { return .zero }
    switch kind {
    case "nod":
      guard t < gestureLasts("nod") else { return nil }
      let k = t / gestureLasts("nod")
      return CGPoint(x: 0, y: -5 * CGFloat(sin(k * 4 * .pi) * (1 - 0.3 * k)))
    case "shake":
      guard t < gestureLasts("shake") else { return nil }
      let k = t / gestureLasts("shake")
      return CGPoint(x: 4.5 * CGFloat(sin(k * 6 * .pi) * (1 - 0.5 * k)), y: 0)
    case "spiral":
      guard t < gestureLasts("spiral") else { return nil }
      let k = t / gestureLasts("spiral"), r = 10 * (1 - k), rise = 26 * k * k * (3 - 2 * k)
      return CGPoint(x: CGFloat(r * cos(k * 5 * .pi)), y: CGFloat(rise + 0.5 * r * sin(k * 5 * .pi)))
    case "peek":
      // Curious: one small loop where it is, when your pointer has come near and stopped.
      guard t < gestureLasts("peek") else { return nil }
      let k = t / gestureLasts("peek"), swell = sin(k * .pi)
      return CGPoint(x: CGFloat(5 * swell * cos(k * 2 * .pi)), y: CGFloat(5 * swell * sin(k * 2 * .pi)))
    default:
      return nil
    }
  }
  static func gestureLasts(_ kind: String) -> Double { kind == "nod" ? 0.7 : kind == "shake" ? 0.8 : kind == "spiral" ? 1.1 : kind == "peek" ? 0.7 : 0 }
  /// A nod after a step that worked is not repeated more often than this (a long job would bob all the way through).
  static let nodEvery = 6.0
  /// Curious: your pointer must rest this long near the light before it peeks, and it peeks once per visit.
  static let peekAfter = 0.5

  /// While Echo thinks, the resting light traces a slow figure of eight (easing in over 0.6 s).
  static func thinkingEight(elapsed t: Double) -> CGPoint {
    guard t > 0 else { return .zero }
    let ease = CGFloat(min(1, t / 0.6))
    return CGPoint(x: ease * 7 * CGFloat(sin(t * 1.5)), y: ease * 4.5 * CGFloat(sin(t * 3)))
  }

  /// Curious: when your pointer comes near the resting light (but not onto it), it leans a little
  /// toward it: most at 52 pt away, nothing from 170 pt.
  static func lean(toward mouse: CGPoint, from p: CGPoint) -> CGPoint {
    let dx = mouse.x - p.x, dy = mouse.y - p.y, d = hypot(dx, dy)
    guard d > 52, d < 170 else { return .zero }
    let amount = 5 * (1 - (d - 52) / 118)
    return CGPoint(x: dx / d * amount, y: dy / d * amount)
  }

  /// Waiting for your yes, the light's halo beats twice and rests, every 1.6 s (0…1).
  static func heartbeat(elapsed t: Double) -> CGFloat {
    let c = t.truncatingRemainder(dividingBy: 1.6)
    return CGFloat(min(1, exp(-pow(c - 0.15, 2) / 0.004) + 0.8 * exp(-pow(c - 0.42, 2) / 0.004)))
  }

  /// A long flight leaves a comet's tail: its trail lives this long, and sheds a little dust.
  static let cometTrailLife = 0.95, cometFrom: CGFloat = 420, dustLife = 0.8
  /// The furthest the resting light ever is from its place (the wander and the flit together).
  static let restReach: CGFloat = 12

  /// The light can be picked up within this far of it: a spot 22 pt across.
  static let grabReach: CGFloat = 11

  /// May the mouse at `mouse` pick the light up? Only while it is out and resting on or circling
  /// something (`holdable`), within reach of it, and never on the thing itself: a click on what
  /// Echo is showing always goes to that thing.
  static func grabbable(_ mouse: CGPoint, light: CGPoint, target: CGRect, holdable: Bool) -> Bool {
    guard holdable, hypot(mouse.x - light.x, mouse.y - light.y) <= grabReach else { return false }
    return target.isNull || !target.contains(mouse)
  }

  /// Picking the light up and dropping it on something to say "this one".
  /// idle → held (pressed on it) → dragging (moved more than a few points) → dropped (let go) or
  /// cancelled (Escape); a press let go without moving is nothing at all. `settle` ends it.
  struct Grab: Equatable {
    enum State: Equatable { case idle, held, dragging, dropped, cancelled }
    private(set) var state = State.idle
    /// Where the light was resting (it glides back here when dropped on nothing), and where it is.
    private(set) var from = CGPoint.zero
    private(set) var at = CGPoint.zero
    private var pressed = CGPoint.zero
    /// A press only becomes a drag past this far: a click on the light moves nothing.
    static let slop: CGFloat = 3

    /// The mouse has hold of it (pressed, or being dragged).
    var active: Bool { state == .held || state == .dragging }

    /// The mouse went down. True when that picked the light up.
    mutating func press(_ mouse: CGPoint, light: CGPoint, target: CGRect, holdable: Bool) -> Bool {
      guard state == .idle, PearlMath.grabbable(mouse, light: light, target: target, holdable: holdable) else { return false }
      state = .held
      from = light
      at = light
      pressed = mouse
      return true
    }

    /// The mouse moved with the button down: the light follows it.
    mutating func move(_ mouse: CGPoint) {
      if state == .held, hypot(mouse.x - pressed.x, mouse.y - pressed.y) > Grab.slop { state = .dragging }
      if state == .dragging { at = mouse }
    }

    /// The mouse came up: a drag is a drop; a press that never moved is over.
    mutating func release(_ mouse: CGPoint) {
      switch state {
      case .dragging: at = mouse; state = .dropped
      case .held: state = .idle
      default: break
      }
    }

    /// Escape: it goes back where it was.
    mutating func escape() {
      if active { state = .cancelled; at = from }
    }

    /// The drop or the cancel has been dealt with.
    mutating func settle() {
      if state == .dropped || state == .cancelled { state = .idle }
    }
  }

  /// Where a dropped light goes: it settles on the thing under it, or glides back where it was
  /// when there is nothing there (no element, or one of Echo's own windows).
  enum Drop: Equatable { case settle, back }
  static func drop(element: Bool, onEcho: Bool) -> Drop { element && !onEcho ? .settle : .back }

  /// A route through menus: the light visits each label in order, resting on each for a moment,
  /// and waits at one until the next can be found (the user opens the menu). It answers once:
  /// when it reaches the target, or when it has waited `patience` without finding the next.
  struct Route: Equatable {
    /// How many stops (1 to 6), and the one the light is resting on (-1: none yet).
    let count: Int
    private(set) var reached = -1
    private(set) var arrivedAt: Double
    private(set) var answered = false
    let patience: Double
    /// It rests this long on each stop before moving on.
    static let rest = 0.35
    /// At most this many stops.
    static let most = 6

    init(count: Int, at now: Double, patience: Double = 1.5) {
      self.count = min(max(count, 1), Route.most)
      arrivedAt = now
      self.patience = min(max(patience, 0.3), 15)
    }

    /// The stop to look for now; nil once it is on the target.
    var next: Int? { reached + 1 < count ? reached + 1 : nil }
    var onTarget: Bool { reached == count - 1 }

    /// The next stop was found: may the light move on to it now? Not before it has rested here.
    func ready(at now: Double) -> Bool { !onTarget && (reached < 0 || now - arrivedAt >= Route.rest) }

    /// The light is on the next stop.
    mutating func arrive(at now: Double) {
      guard !onTarget else { return }
      reached += 1
      arrivedAt = now
    }

    /// The answer, once: on the target, or after waiting `patience` here for a stop that never
    /// showed (it stays on the last one it reached; found is false when it reached none).
    mutating func answer(at now: Double) -> (found: Bool, index: Int)? {
      guard !answered, onTarget || now - arrivedAt >= patience else { return nil }
      answered = true
      return (reached >= 0, max(reached, 0))
    }

    /// Stopped before it answered (another errand took the light, the step was let go, the
    /// light went home): the answer now, with how far it got, so the request is never left to
    /// wait out its time. Nil when it has already answered.
    mutating func stop() -> (found: Bool, index: Int)? {
      guard !answered else { return nil }
      answered = true
      return (reached >= 0, max(reached, 0))
    }

    /// Nothing more to do: on the target and answered, or it never found the first stop.
    var over: Bool { answered && (onTarget || reached < 0) }
  }

  /// A route as the request gives it: 1 to 6 short labels, trimmed. Nil when it isn't one.
  static func route(_ v: Any?) -> [String]? {
    guard let list = v as? [Any], !list.isEmpty, list.count <= Route.most else { return nil }
    let labels = list.map { ($0 as? String ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") }
    return labels.contains { $0.isEmpty || $0.count > 60 } ? nil : labels
  }

  // MARK: at work: the finger (the other way: "reach")

  /// The ways it can show you something: it stays in the island and sends its light ("firefly",
  /// the way Echo points and works), or it hops over itself, stands beside the thing and reaches
  /// out a soft finger ("reach").
  static let ways = ["firefly", "reach"]
  static func way(_ id: String?) -> String { ways.contains(id ?? "") ? id! : ways[0] }

  /// How far the end of a fully reached finger is from the pearl's middle, in radii.
  static let fingerReach: CGFloat = 1.85

  /// The body's outline around (0, 0): a circle that reaches out a soft, round finger towards
  /// `aim` (radians, y up): a small round nub on a smooth neck. `point` 0 is round, 1 fully
  /// reached (a little more for the push of a tap).
  static func body(radius R: CGFloat, point: CGFloat, aim a: CGFloat) -> CGPath {
    let p = min(max(point, 0), 1.25)
    let path = CGMutablePath()
    guard p >= 0.02 else {
      path.addEllipse(in: CGRect(x: -R, y: -R, width: 2 * R, height: 2 * R))
      return path
    }
    let d = R * (1 + 0.62 * p), nub = R * (0.33 - 0.1 * p), w: CGFloat = 0.62, h = CGFloat.pi / 2
    let c = CGPoint(x: cos(a) * d, y: sin(a) * d)
    func at(_ angle: CGFloat, _ r: CGFloat) -> CGPoint { CGPoint(x: cos(angle) * r, y: sin(angle) * r) }
    path.move(to: at(a + w, R))
    // The round of it, the long way about (away from the finger), then out along the neck,
    // round the nub and back.
    path.addArc(center: .zero, radius: R, startAngle: a + w, endAngle: a - w + 2 * .pi, clockwise: false)
    path.addQuadCurve(to: CGPoint(x: c.x + cos(a - h) * nub, y: c.y + sin(a - h) * nub), control: at(a - 0.27, R * 1.1))
    path.addArc(center: c, radius: nub, startAngle: a - h, endAngle: a + h, clockwise: false)
    path.addQuadCurve(to: at(a + w, R), control: at(a + 0.27, R * 1.1))
    path.closeSubpath()
    return path
  }

  /// The spot on `r` its finger goes to: the nearest point of the rectangle to `p` (its middle,
  /// when `p` is inside it).
  static func touch(_ r: CGRect, from p: CGPoint) -> CGPoint {
    if r.contains(p) { return CGPoint(x: r.midX, y: r.midY) }
    return CGPoint(x: min(max(p.x, r.minX), r.maxX), y: min(max(p.y, r.minY), r.maxY))
  }

  /// The angle (y up) its finger reaches at, from a pearl at `p` to what it is showing you.
  static func aim(from p: CGPoint, at r: CGRect) -> CGFloat {
    let q = touch(r, from: p)
    return atan2(q.y - p.y, q.x - p.x)
  }

  /// Where it stands to show you `r` (y up): off one of its corners, a finger's length and `gap`
  /// away (the white ring round the target is 4 pt out), so the fingertip just touches the ring
  /// at the corner and the body covers none of it. Inside
  /// `bounds` and clear of `avoiding` (the island). The first that fits of: top right, top left,
  /// bottom right, bottom left, then beside the middle; a huge target (a whole window) gets it
  /// just inside its top-right corner.
  static func stand(beside r: CGRect, diameter: CGFloat, in bounds: CGRect, avoiding: [CGRect] = [], gap: CGFloat = 7) -> CGPoint {
    let R = diameter / 2, d = R * fingerReach + gap, k = d / 2.squareRoot()
    let spots = [CGPoint(x: r.maxX + k, y: r.maxY + k), CGPoint(x: r.minX - k, y: r.maxY + k),
                 CGPoint(x: r.maxX + k, y: r.minY - k), CGPoint(x: r.minX - k, y: r.minY - k),
                 CGPoint(x: r.maxX + d, y: r.midY), CGPoint(x: r.minX - d, y: r.midY)]
    let inner = bounds.insetBy(dx: R + 8, dy: R + 8)
    let huge = r.width * r.height > bounds.width * bounds.height * 0.6
    let clear = { (p: CGPoint) in !avoiding.contains { $0.insetBy(dx: -R - 3, dy: -R - 3).contains(p) } }
    return (huge ? nil : spots.first { inner.contains($0) && clear($0) })
      ?? CGPoint(x: min(max(r.maxX - R - 6, inner.minX), inner.maxX), y: min(max(r.maxY - R - 6, inner.minY), inner.maxY))
  }

  /// One frame of turning from angle `a` towards `b`, the short way round.
  static func turn(_ a: CGFloat, toward b: CGFloat, rate: Double, dt: Double) -> CGFloat {
    let d = atan2(sin(b - a), cos(b - a))
    return a + d * CGFloat(1 - exp(-rate * max(dt, 0)))
  }

  /// A tap on what it is showing: the finger draws back for 110 ms, pushes a little past its
  /// reach for 90 ms, and rests. How far reached it wants to be, `t` seconds into the tap.
  static let tapPush = 0.11
  static func tap(elapsed t: Double) -> CGFloat {
    guard t >= 0 else { return 1 }
    return t < tapPush ? 0.55 : t < 0.2 ? 1.15 : 1
  }

  /// A scroll: it nods the page along, three small nods that die away over 1.1 s (-1…1).
  static func nod(elapsed t: Double) -> CGFloat {
    let u = t / 1.1
    guard u >= 0, u < 1 else { return 0 }
    return CGFloat(sin(u * .pi * 6) * (1 - u))
  }

  /// A hop, the way a living thing moves: its eyes go to where it is going first, it crouches,
  /// then it leaves, travels in an arc (never a straight line), and lands. Further is a little
  /// longer and higher.
  struct Hop {
    var from: CGPoint
    /// Where it lands. It may move while the hop is on (the island it is going home to slides).
    var to: CGPoint
    /// When it was asked to go.
    let start: Double
    /// How long it looks, then crouches, before it leaves the ground: 140 ms and 110 ms. None
    /// when it was already in the air.
    let look: Double, crouch: Double
    /// How long it is in the air, and how high the arc rises above the straight line.
    let duration: Double
    let arc: CGFloat

    init(from: CGPoint, to: CGPoint, at start: Double, radius R: CGFloat, airborne: Bool = false) {
      self.from = from
      self.to = to
      self.start = start
      look = airborne ? 0 : 0.14
      crouch = airborne ? 0 : 0.11
      let d = hypot(to.x - from.x, to.y - from.y)
      duration = min(0.56, 0.36 + Double(d) * 0.00025)
      arc = min(R * 3.4, max(R * 1.2, d * 0.16))
    }

    /// When it leaves the ground, and when it lands.
    var leaves: Double { start + look + crouch }
    var lands: Double { leaves + duration }
    /// It is down in its crouch (after the look, before the leap).
    func crouching(at now: Double) -> Bool { now >= start + look && now < leaves }
    func done(at now: Double) -> Bool { now >= lands }
    /// 0…1 through the air.
    func progress(at now: Double) -> CGFloat { CGFloat(min(max((now - leaves) / duration, 0), 1)) }

    /// Where it is (y up): still until it leaves, then along the arc, eased at both ends.
    func position(at now: Double) -> CGPoint {
      let k = progress(at: now), e = k * k * (3 - 2 * k)
      return CGPoint(x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e + sin(k * .pi) * arc)
    }

    /// It leans into the way it is going (radians, clockwise), most at the top of the arc.
    func tilt(at now: Double) -> CGFloat {
      min(max((to.x - from.x) / 900, -0.3), 0.3) * sin(progress(at: now) * .pi)
    }
  }
}

// MARK: the edge glow and the status chip (Overlays.swift draws them)

enum EdgeMath {
  /// A thin line just inside the screen's edge, following its rounded corners, with a soft glow
  /// that breathes.
  static let line: CGFloat = 1.5
  /// How far the line sits in from the very edge (so it isn't lost under the display's rounded mask).
  static let inset: CGFloat = 1
  /// Room left either side of the notch, where the top line stops.
  static let notchGap: CGFloat = 6
  static let fade = 0.35
  /// Seconds for one slow breath (in and out).
  static let breath = 3.6
  static let glowRadius = (low: 4.0, high: 9.0)
  static let glowOpacity = (low: 0.35, high: 0.7)

  /// How round the display's corners are: a MacBook's built-in screen with a notch ~11 pt, an older
  /// built-in one a little (the menu bar's rounded corners), an external monitor square.
  static func corner(builtIn: Bool, notched: Bool) -> CGFloat { builtIn ? (notched ? 11 : 6) : 0 }

  /// Where the line's centre runs: `inset` in from the edge, so all of it stays on screen.
  static func lineRect(_ bounds: CGRect) -> CGRect { bounds.insetBy(dx: inset + line / 2, dy: inset + line / 2) }

  /// The notch in a screen `size` big (y up, origin at its bottom left), from the unobscured
  /// areas either side of it (NSScreen.auxiliaryTopLeftArea / TopRightArea), or nil.
  static func notch(size: CGSize, left: CGRect?, right: CGRect?) -> CGRect? {
    guard let l = left, let r = right, l.width > 0, r.width > 0 else { return nil }
    let w = size.width - l.width - r.width
    guard w > 1, l.height > 0 else { return nil }
    return CGRect(x: l.width, y: size.height - l.height, width: w, height: l.height)
  }

  /// The line: a rounded rectangle concentric with the display's corners (`corner`, measured at
  /// the very edge). With a notch, the top edge stops `notchGap` short of it on both sides.
  static func path(_ bounds: CGRect, corner: CGFloat, notch: CGRect? = nil) -> CGPath {
    let r = lineRect(bounds)
    let c = min(max(0, corner - inset - line / 2), r.width / 2, r.height / 2)
    guard let n = notch, n.minX - notchGap > r.minX + c, n.maxX + notchGap < r.maxX - c else {
      return CGPath(roundedRect: r, cornerWidth: c, cornerHeight: c, transform: nil)
    }
    let p = CGMutablePath()
    p.move(to: CGPoint(x: n.maxX + notchGap, y: r.maxY))
    p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.maxX, y: r.minY), radius: c)
    p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.minX, y: r.minY), radius: c)
    p.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.minX, y: r.maxY), radius: c)
    p.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: n.minX, y: r.maxY), radius: c)
    p.addLine(to: CGPoint(x: n.minX - notchGap, y: r.maxY))
    return p
  }
}

enum ChipMath {
  static let height: CGFloat = 24, dot: CGFloat = 7, textX: CGFloat = 22, padRight: CGFloat = 11
  static var dotInset: CGFloat { (height - dot) / 2 }
  /// Collapsed: a round chip around the dot.
  static var dotWidth: CGFloat { height }
  static let maxWidth: CGFloat = 150
  /// Room around the chip in its panel (for its shadow), and its distance from the corner.
  static let margin: CGFloat = 6, right: CGFloat = 10, top: CGFloat = 8
  static var panelSize: CGSize { CGSize(width: maxWidth + 2 * margin, height: height + 2 * margin) }
  /// Seconds after the last change until only the dot stays.
  static let collapseAfter = 3.5
  static let looking = "Looking"

  /// The one state the chip shows: what Echo is doing, else looking, else driving (or nothing).
  static func state(looking: Bool, driving: Bool, doing: String?) -> String? {
    if driving, let d = doing {
      switch d {
      case "click": return "Clicking"
      case "type_text": return "Typing"
      case "scroll": return "Scrolling"
      case "press_keys": return "Pressing keys"
      default: break
      }
    }
    if looking { return Self.looking }
    return driving ? "Driving" : nil
  }

  static func width(textWidth: CGFloat) -> CGFloat {
    min(maxWidth, (textX + textWidth + padRight).rounded(.up))
  }

  /// The chip's panel: the top-right corner of the visible frame, under the menu bar.
  static func frame(visible: CGRect) -> CGRect {
    let s = panelSize
    return CGRect(x: visible.maxX - right - s.width + margin, y: visible.maxY - top - s.height + margin, width: s.width, height: s.height)
  }
}

// MARK: the pearl out pointing (Pointer.swift moves it; this is its motion, kept testable)

enum CompanionMath {
  /// The look setting: "auto" (the default, and what any older setting becomes), or always
  /// "glass" (smoky glass with a lit edge) or "moon" (a white pearl with dark eyes).
  static let looks = ["auto", "glass", "moon"]
  static func look(_ id: String?) -> String { looks.contains(id ?? "") ? id! : looks[0] }

  /// The body it wears: the setting when that names one; on "auto", Moon when the system's
  /// appearance is dark and Glass when it is light. Nothing on the screen is looked at for this.
  static func wear(_ setting: String?, systemDark: Bool) -> String {
    let s = look(setting)
    return s == "auto" ? (systemDark ? "moon" : "glass") : s
  }

  /// The size setting: how wide the pearl is when it leaves the island to point (26, 32 or 40 pt).
  static let sizes = ["small", "medium", "large"]
  static func size(_ id: String?) -> String { sizes.contains(id ?? "") ? id! : "medium" }
  static func diameter(_ id: String?) -> CGFloat {
    switch size(id) {
    case "small": return 26
    case "large": return 40
    default: return 32
    }
  }

  /// ease-glide, cubic-bezier(.22,1,.36,1): a quick start and a long, soft landing.
  static func easeOut(_ t: Double) -> Double { 1 - pow(1 - min(max(t, 0), 1), 4) }

  /// A critically damped spring one step of `dt` toward `target`: it follows a moving spot (the
  /// pill sliding in, stepping aside for the mouse) smoothly, never overshooting or jittering, at
  /// any frame rate. `response` is about how long it takes to settle, in seconds.
  static func spring(_ p: CGPoint, _ v: CGVector, to target: CGPoint, dt: Double, response: Double) -> (CGPoint, CGVector) {
    let w = CGFloat(2 * Double.pi / max(response, 0.01)), e = CGFloat(exp(-Double(w) * max(dt, 0))), t = CGFloat(max(dt, 0))
    let x = p.x - target.x, y = p.y - target.y
    let kx = v.dx + w * x, ky = v.dy + w * y
    return (CGPoint(x: target.x + (x + kx * t) * e, y: target.y + (y + ky * t) * e),
            CGVector(dx: (v.dx - w * kx * t) * e, dy: (v.dy - w * ky * t) * e))
  }

  /// When the mark, out beside a target, should glide back to its place in the island. Echo
  /// listening or speaking calls it home, but never mid-click, never the moment it's arrived, and
  /// a "look here" point (`pinned`) stays while Echo talks about it. In the middle of a job Echo
  /// is doing (`working`: a driving session, and Echo still thinking or speaking) it waits where
  /// it last was, however long the next step takes to come, so that step takes it straight on
  /// from there. It goes home when you talk, or once Echo has been idle a moment (the job is
  /// over: `idleFor`, seconds since its voice state went idle).
  static func shouldReturnHome(pinned: Bool, voice: String, actionPending: Bool, sincePoint: Double,
                               sinceFinished: Double?, pillShowing: Bool, working: Bool = false, idleFor: Double = .infinity) -> Bool {
    guard pillShowing, !actionPending else { return false }
    if working, !pinned, voice != "listening" {
      // (A blink of "idle" between a step's words and the next thought is not the end of the job.)
      if voice != "idle" || idleFor < idleEndsJob { return (sinceFinished ?? sincePoint) >= waitsForNextStep }
    }
    if let f = sinceFinished { return f >= 1.8 }
    if pinned { return voice == "listening" ? sincePoint >= 1.5 : sincePoint >= (voice == "idle" ? 8 : 30) }
    return voice == "idle" ? sincePoint >= 4 : sincePoint >= 0.8
  }

  /// The longest the light waits at the last thing it touched for a job's next step (a safety
  /// net: a job that is still going keeps it out).
  static let waitsForNextStep: Double = 120
  /// Echo idle for this long in a driving session: the job is over, and the light may go home.
  static let idleEndsJob: Double = 2.5

  /// Why the light went home, for the timeline: the step it was on is over (`step`), or it waited
  /// and nothing more came (`wait`).
  static func homeReason(sinceFinished: Double?) -> String { sinceFinished != nil ? "step" : "wait" }

  /// The voice level with a 60 ms attack and a 180 ms release, so it swells fast and settles softly.
  static func smoothLevel(_ shown: Double, toward target: Double, dt: Double) -> Double {
    let tau = target > shown ? 0.06 : 0.18
    return shown + (target - shown) * (1 - exp(-max(dt, 0) / tau))
  }
}

// MARK: the caption beside the light (Pointer.swift shows it; BubbleArt in Companion.swift draws it)

/// A small caption beside Echo's light that says, in a few words, what this step is: "Clicking
/// Send", "Typing in Subject", "Your turn". It appears when the light gets there, stays long
/// enough to read, and fades. It says where Echo types, never what, and a password field is
/// only ever "a password field".
enum BubbleMath {
  /// One line of at most this many characters.
  static let maxChars = 40
  /// Its glass: this tall, with this corner; its words start `padLeft` in (past the coloured
  /// edge) and end `padRight` short of its right side.
  static let height: CGFloat = 26, corner: CGFloat = 10
  static let padLeft: CGFloat = 16, padRight: CGFloat = 12
  /// How far it stays from the light, from the thing (the light circles 7 pt outside that, so
  /// the caption is clear of its path too) and from the screen's edges.
  static let gap: CGFloat = 10, clear: CGFloat = 13, margin: CGFloat = 8

  /// It fades in quickly and out over 250 ms (reduced motion: it is simply there, then gone).
  static let fadeIn = 0.12, fadeOut = 0.25
  /// How long it stays once it is there: 2.2 s, longer for more words (60 ms a character), 5 s at most.
  static func hold(_ text: String) -> Double { min(5, max(2.2, 0.06 * Double(text.count))) }

  static func size(textWidth: CGFloat) -> CGSize { CGSize(width: ceil(padLeft + textWidth + padRight), height: height) }

  /// A sentence of Echo's beside the thing it is about (the bubble of an explanation): it wraps at
  /// this width, to at most this many lines, each this tall, and holds at most this many characters.
  static let wrapWidth: CGFloat = 244, lineHeight: CGFloat = 17, maxLines = 4, longChars = 200
  /// The glass for words on `lines` lines, the widest `textWidth` wide.
  static func size(textWidth: CGFloat, lines: Int) -> CGSize {
    lines <= 1 ? size(textWidth: textWidth) : CGSize(width: ceil(padLeft + textWidth + padRight), height: 14 + lineHeight * CGFloat(lines))
  }
  /// The sentence as the bubble shows it: on one run of spaces, cut with "…" when it is too long.
  static func sentence(_ s: String) -> String { line(s, max: longChars) }
  /// How long the bubble's rim stays lit: about as long as Echo takes to say the words.
  static func speaks(_ text: String) -> Double { min(14, max(2.2, 0.065 * Double(text.count))) }

  /// What the light is doing when the caption is made: on a step, waiting for you on a lesson's
  /// step, still looking for the thing, or waiting for your OK.
  enum Moment { case step, waiting, searching, asking }

  /// One line: runs of spaces and line breaks become one space.
  private static func oneLine(_ s: String) -> String {
    s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
  }

  /// `s` on one line of at most `max` characters, cut at the end with "…".
  static func line(_ s: String, max: Int = maxChars) -> String {
    let t = oneLine(s)
    guard t.count > max else { return t }
    return t.prefix(Swift.max(0, max - 1)).trimmingCharacters(in: .whitespaces) + "…"
  }

  /// A long name cut in the middle, so both its start and its end can be read:
  /// "Quarterly report fi…al version 3.xlsx".
  static func middle(_ s: String, max: Int) -> String {
    let t = oneLine(s)
    guard t.count > max else { return t }
    guard max >= 5 else { return String(t.prefix(Swift.max(0, max - 1))) + "…" }
    let keep = max - 1, head = (keep + 1) / 2, tail = keep / 2
    return t.prefix(head).trimmingCharacters(in: .whitespaces) + "…" + t.suffix(tail).trimmingCharacters(in: .whitespaces)
  }

  /// `lead` + the thing's name + `end`, the name cut in the middle when the line would be too long.
  private static func naming(_ lead: String, _ name: String, _ end: String = "") -> String {
    lead + middle(name, max: maxChars - lead.count - end.count) + end
  }

  /// The words. In this order: asking is "Is this OK?"; a lesson's waiting light says "Your
  /// turn"; a search says what it is looking for; then the step's own short narration
  /// (`caption`, from the server: already without secrets) if it has one; else a plain phrase
  /// from the action and the thing's name. `target` is the thing's own name (never what is in
  /// it, and never what is being typed); `to` is where a drag ends; `secure`: it is a password
  /// field, which is all that is ever said of it.
  static func phrase(caption: String = "", action: String = "", target: String = "", to: String = "", direction: String = "",
                     secure: Bool = false, moment: Moment = .step) -> String {
    // The thing's name, without quote marks round it or a menu item's own "…" after it.
    let name = secure ? "a password field" : oneLine(target).trimmingCharacters(in: CharacterSet(charactersIn: "\"“”‘’'…. "))
    switch moment {
    case .asking: return "Is this OK?"
    case .waiting: return "Your turn"
    case .searching: return name.isEmpty ? "Looking…" : naming("Looking for ", name, "…")
    case .step: break
    }
    let said = line(caption)
    if !said.isEmpty, !secure { return said }
    switch action {
    case "click": return name.isEmpty ? "Clicking here" : naming("Clicking ", name)
    case "type_text": return name.isEmpty ? "Typing here" : naming("Typing in ", name)
    case "clear_field": return name.isEmpty ? "Clearing the field" : naming("Clearing ", name)
    case "hover": return name.isEmpty ? "Hovering here" : naming("Hovering over ", name)
    case "scroll": return ["up", "down", "left", "right"].contains(direction) ? "Scrolling \(direction)" : "Scrolling"
    case "drag":
      let end = oneLine(to)
      if !end.isEmpty { return naming("Dragging to ", end) }
      return name.isEmpty ? "Dragging" : naming("Dragging ", name)
    default: return "This one"
    }
  }

  /// Where the caption goes (its bottom-left corner, y up): beside the `light`, on the side of
  /// it away from the `target` it is showing, so it never covers the thing or the light's path
  /// round it. Kept inside `bounds` (the screen without its menu bar and Dock) and off `avoiding`
  /// (the island): when the first side has no room it goes to the opposite side of the thing,
  /// then to the other two. Only a thing that fills the screen ends up under it.
  static func origin(target: CGRect, light: CGPoint, size: CGSize, bounds: CGRect, avoiding: [CGRect] = []) -> CGPoint {
    let safe = bounds.insetBy(dx: margin, dy: margin), keep = target.insetBy(dx: -clear, dy: -clear)
    let slideX = { (x: CGFloat) in min(max(x, safe.minX), max(safe.minX, safe.maxX - size.width)) }
    let slideY = { (y: CGFloat) in min(max(y, safe.minY), max(safe.minY, safe.maxY - size.height)) }
    // Above and below start a little left of the light and run right; beside it they are centred on it.
    let above = CGPoint(x: slideX(light.x - 14), y: max(light.y + gap, keep.maxY))
    let below = CGPoint(x: slideX(light.x - 14), y: min(light.y - gap, keep.minY) - size.height)
    let right = CGPoint(x: max(light.x + gap, keep.maxX), y: slideY(light.y - size.height / 2))
    let left = CGPoint(x: min(light.x - gap, keep.minX) - size.width, y: slideY(light.y - size.height / 2))
    // Which side of the thing the light is on: measured in the thing's own half-sizes, so a
    // light at the corner of a wide button counts as above it, not beside it.
    let dx = (light.x - target.midX) / max(target.width / 2, 1), dy = (light.y - target.midY) / max(target.height / 2, 1)
    let order = abs(dx) > abs(dy) ? (dx >= 0 ? [right, left, above, below] : [left, right, above, below])
                                  : (dy >= 0 ? [above, below, right, left] : [below, above, right, left])
    let fits = { (o: CGPoint) -> Bool in
      let r = CGRect(origin: o, size: size)
      return safe.insetBy(dx: -0.5, dy: -0.5).contains(r) && !r.intersects(keep.insetBy(dx: 0.5, dy: 0.5)) && !avoiding.contains { $0.intersects(r) }
    }
    let o = order.first(where: fits) ?? CGPoint(x: slideX(order[0].x), y: slideY(order[0].y))
    return CGPoint(x: o.x.rounded(), y: o.y.rounded())
  }
}

// MARK: the step counter (Caption.swift shows it while Echo works on the Mac)

enum StepMath {
  /// Which step this is, for the island: "step 3 of 5" when Echo said how many steps the request
  /// takes, "step 3" from the second step on when she didn't, else nothing.
  static func counter(step: Int, of total: Int) -> String {
    guard step > 0 else { return "" }
    if total > 0 { return "step \(step) of \(max(step, total))" }
    return step >= 2 ? "step \(step)" : ""
  }
}

// MARK: when the caption pill shows (Caption.swift owns it; these are its rules, kept testable)

/// Whether the pill should be on screen. What the page says counts only while it keeps saying it,
/// so a page that reloaded, crashed or lost its server can never leave the pill stuck.
struct CaptionLife: Equatable {
  /// The page's state is forgotten after this long without hearing from it (it refreshes every
  /// 4 s while it wants the pill: public/caption.js CAPTION_BEAT_MS).
  static let expiry = 10.0
  /// In talk mode with nothing else going on, the pill leaves after this long with nothing new.
  static let quietFor = 6.0
  /// The last line stays this long once things stop, so it can be read.
  static let linger = 3.5

  private(set) var enabled = true
  private(set) var driving = false
  private(set) var active = false
  private(set) var quiet = false
  private(set) var confirming = false
  /// The app's own driver is acting on the Mac (Driver.swift). It needs no page to say so, so the
  /// pill and Stop stay through a page that is reloading; the driver clears it when its run ends.
  private(set) var appDriving = false
  /// You closed it (the x): it stays away until something new starts.
  private(set) var dismissed = false
  private var heardAt = -Double.infinity
  private var newAt = -Double.infinity

  /// The page said so (now, in seconds). `new`: there is something new to show (new words, a new
  /// state), not just a refresh of the same thing. `confirming`: Echo is asking for your OK.
  mutating func heard(enabled: Bool, driving: Bool, active: Bool, quiet: Bool, confirming: Bool = false, new: Bool, now: Double) {
    // Something starting (after nothing, after talk mode's quiet, or after the page went silent)
    // brings a closed pill back; more of what was already going on doesn't. A drive starting
    // counts even while Echo was already talking, and a question that needs your OK always does:
    // closing the pill mid-drive must not hide the Yes / No that comes later.
    let wasOn = live(now) && (self.driving || (self.active && !self.quiet))
    let wasDriving = live(now) && self.driving
    let wasConfirming = live(now) && self.confirming
    let starting = (driving && !wasDriving) || (active && !quiet && !wasOn)
    if (starting && new) || (confirming && !wasConfirming) { dismissed = false }
    self.enabled = enabled
    self.driving = driving
    self.active = active
    self.quiet = quiet
    self.confirming = confirming
    heardAt = now
    if new { newAt = now }
  }

  /// The app's driver started acting (a new run, or the next step after a quiet spell).
  mutating func driveBegan() {
    if !appDriving { dismissed = false }
    appDriving = true
  }

  /// The driver went quiet between steps: the session may still be on, so the page's word stands.
  mutating func driveIdle() { appDriving = false }

  /// A driving run ended here (done, stopped, taken over), whatever the page last said.
  mutating func driveEnded() { driving = false; appDriving = false }

  /// The close button: gone until something new starts.
  mutating func dismiss() { dismissed = true }

  /// "Show Caption" in the menu bar menu: on or off at once, ahead of the page's next word (it
  /// says the same once the setting is saved).
  mutating func allow(_ on: Bool) { enabled = on }

  /// Forget everything the page said (it was replaced, the server went away, the app is
  /// quitting). A drive the app itself is still running is not the page's to forget.
  mutating func reset() {
    let still = appDriving
    self = CaptionLife()
    appDriving = still
  }

  private func live(_ now: Double) -> Bool { now - heardAt < Self.expiry }
  private func lapsed(_ now: Double) -> Bool { quiet && now - newAt >= Self.quietFor }

  /// Is Echo driving: the app's own driver says so, or the page's (still fresh) word does.
  func drivingNow(_ now: Double) -> Bool { appDriving || (live(now) && driving) }

  /// Should the pill be up? `echoInFront`: her own window is in front (then only a drive needs
  /// it). `replying`: the reply field is open (you may be typing to her from another app).
  func wants(now: Double, echoInFront: Bool, replying: Bool) -> Bool {
    guard enabled, !dismissed else { return false }
    if drivingNow(now) { return true }
    let going = live(now) && active && !lapsed(now)
    return (going || replying) && !echoInFront
  }

  /// How long a pill that is no longer wanted stays before it fades: a moment to read the last
  /// line, or not at all when it was closed, switched off, or simply ran out.
  func lingers(now: Double) -> Double {
    enabled && !dismissed && live(now) && !lapsed(now) ? Self.linger : 0
  }

  /// When to look again (seconds from now) because time alone may change the answer, or nil.
  func nextCheck(now: Double) -> Double? {
    guard live(now), driving || active else { return nil }
    var at = heardAt + Self.expiry
    if quiet, !driving, !lapsed(now) { at = min(at, newAt + Self.quietFor) }
    return max(0.05, at - now)
  }
}

// MARK: asking at the thing (AskBubble.swift)

enum AskMath {
  static let pad: CGFloat = 14, buttonHeight: CGFloat = 26, gap: CGFloat = 10
  /// The glass for a question `text` big with two buttons of these widths under it: wide enough
  /// for whichever is wider, the buttons on their own row.
  static func size(text: CGSize, buttons: [CGFloat]) -> CGSize {
    let row = buttons.reduce(0, +) + 8 * CGFloat(max(0, buttons.count - 1))
    return CGSize(width: ceil(max(text.width, row) + pad * 2), height: ceil(pad + text.height + gap + buttonHeight + pad - 2))
  }
}

// MARK: drawing with the light, and pinned notes (TalkLayer.swift)

enum DrawMath {
  /// The pointer must travel this far with the key held before it counts as drawing (a finger's width).
  static let startAfter: CGFloat = 14
  /// How long the box (and the bright outline) waits untouched, and how long "this" is remembered.
  static let boxFades = 4.0, thisLasts = 120.0
  /// The outline itself never outstays the work: it goes when Echo has answered (it was busy and
  /// is idle again), when the page under it scrolls, or after this long at most. What was circled
  /// is still "this" for `thisLasts`; only the square leaves the screen.
  static let outlineMost = 20.0
  static func workDone(was: String, now: String, shownFor: Double) -> Bool { (was == "speaking" || was == "thinking") && now == "idle" && shownFor >= 1 }
  static let fieldHeight: CGFloat = 38, boxWidth: CGFloat = 300, boxHeight: CGFloat = 38 + 8 + 26

  /// The box round the points drawn (screen coordinates), a little outside them; nil with fewer than three.
  static func box(_ points: [CGPoint]) -> CGRect? {
    guard points.count >= 3 else { return nil }
    let xs = points.map(\.x), ys = points.map(\.y)
    return CGRect(x: xs.min()! - 6, y: ys.min()! - 6, width: xs.max()! - xs.min()! + 12, height: ys.max()! - ys.min()! + 12)
  }

  /// Was something really circled? Not a dot or a twitch: the box is at least 28 pt one way and
  /// 16 the other, and the pointer went a fair way round it.
  static func meant(_ box: CGRect, travelled: CGFloat) -> Bool {
    max(box.width, box.height) >= 28 && min(box.width, box.height) >= 16 && travelled >= 60
  }

  /// The box as shares of its screen, from the top-left corner (what the page tells Echo), with its size in points.
  static func shares(of box: CGRect, in screen: CGRect) -> [String: Any] {
    let b = box.intersection(screen)
    func r(_ v: CGFloat) -> Double { (Double(min(1, max(0, v))) * 1000).rounded() / 1000 }
    return ["x0": r((b.minX - screen.minX) / screen.width), "y0": r((screen.maxY - b.maxY) / screen.height),
            "x1": r((b.maxX - screen.minX) / screen.width), "y1": r((screen.maxY - b.minY) / screen.height),
            "w": Int(b.width.rounded()), "h": Int(b.height.rounded())]
  }

  /// Where the "What about this?" box goes: under what was circled, left edges together; above it
  /// when there is no room below; always on the screen.
  static func boxFrame(region: CGRect, visible: CGRect) -> CGRect {
    let x = min(max(region.minX, visible.minX + 8), visible.maxX - 8 - boxWidth)
    var y = region.minY - 10 - boxHeight
    if y < visible.minY + 8 { y = min(region.maxY + 10, visible.maxY - 8 - boxHeight) }
    return CGRect(x: x.rounded(), y: y.rounded(), width: boxWidth, height: boxHeight)
  }
}

enum PinMath {
  /// At most this many notes; the oldest goes when another is pinned.
  static let most = 5
  static let maxText: CGFloat = 240, maxChars = 160
  /// The note's text: one run of spaces, cut with "…" when it is too long.
  static func clean(_ s: String) -> String {
    let t = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    return t.count <= maxChars ? t : String(t.prefix(maxChars - 1)) + "…"
  }
  static func size(text: CGSize) -> CGSize { CGSize(width: ceil(min(maxText, max(60, text.width)) + 14 + 30), height: ceil(max(18, text.height) + 20)) }
  /// Where a new note appears: down the right side of the screen, each under the last.
  static func place(index: Int, visible: CGRect) -> CGPoint {
    CGPoint(x: visible.maxX - 300, y: visible.maxY - 90 - CGFloat(index % most) * 64)
  }
}

// MARK: scrolling to a place (Driver.scrollSmart)

enum ScrollMath {
  /// A thing brought into view sits this far down its scroll area: room above it for what came before.
  static let restAt: CGFloat = 0.22
  /// A "page" moves this much of the area's height, so a strip of what you had seen stays.
  static let pageShare: CGFloat = 0.86
  /// From this many pages on, the line that marks your eye's place is drawn; and how long it stays.
  static let seamFrom = 0.6, seamLasts = 2.6
  /// Read-along: points a second, by name.
  static func pace(_ name: String?) -> CGFloat { name == "slow" ? 26 : name == "fast" ? 70 : 42 }
  static let glideMost = 5 * 60.0

  /// How many points to scroll down (negative: up) so a thing whose top edge is at `top` (screen
  /// coordinates, y up) comes to rest `restAt` down an area from `areaTop` and `height` tall.
  static func toRest(top: CGFloat, areaTop: CGFloat, height: CGFloat) -> CGFloat {
    ((areaTop - restAt * height) - top).rounded()
  }
  /// Points for a number of pages (a fraction for "a little" or "half a page"), never less than 24.
  static func points(pages: Double, height: CGFloat) -> CGFloat { max(24, (CGFloat(pages) * height * pageShare).rounded()) }
  /// Where your eye's place is after scrolling down by `points` in an area from `areaBottom` and
  /// `height` tall: the old bottom edge, now that much higher (nil when all of it scrolled away).
  static func seamY(points: CGFloat, areaBottom: CGFloat, height: CGFloat, down: Bool) -> CGFloat? {
    guard points > 0, points < height - 16 else { return nil }
    return down ? areaBottom + points : areaBottom + height - points
  }
  /// The next step toward a scroll bar value: from how far the bar moved for the last push, how
  /// many points to push now (guessing six pages of content when nothing has been measured).
  static func step(toward target: Double, from current: Double, lastPoints: CGFloat, lastMoved: Double, height: CGFloat) -> CGFloat {
    let gap = target - current
    let perPoint = lastPoints != 0 && abs(lastMoved) > 0.0005 ? lastMoved / Double(lastPoints) : 1 / Double(max(1, height) * 6)
    return CGFloat(max(-20000, min(20000, gap / perPoint))).rounded()
  }
  /// What a scroll bar's value says, in words the assistant can pass on.
  static func place(_ v: Double) -> String { v <= 0.02 ? "at the top" : v >= 0.98 ? "at the bottom" : "\(Int((v * 100).rounded()))% down" }
}

// MARK: looking at the screen without the slow first look (Screen.swift)

enum LookMath {
  /// A look asked for while the same look is still being read joins it, when that one began no
  /// longer ago than this (seconds): the retry after a slow look gets its answer, not a second race.
  static let joinWithin = 7.0
  /// The text reader is woken again when nothing has used it for this long (it is unloaded when idle).
  static let coldAfter = 180.0, warmEvery = 60.0
  static func joins(startedAgo: Double) -> Bool { startedAgo >= 0 && startedAgo <= joinWithin }
  static func cold(sinceUse: Double) -> Bool { sinceUse >= coldAfter }
  /// What makes two looks the same look: the display, the part of it, and what is drawn on it.
  static func key(display: UInt32, crop: CGRect?, marks: [String], grid: Int, maxEdge: CGFloat) -> String {
    let c = crop.map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width)),\(Int($0.height))" } ?? "all"
    return "\(display)|\(c)|\(marks.joined(separator: ","))|\(grid)|\(Int(maxEdge))"
  }
}

// MARK: keeping an eye on a window (Driver.windowText, TalkLayer.swift WatchLights)

enum WatchMath {
  /// The kinds of element whose words count as what a window says.
  static let textRoles: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField", "AXHeading", "AXLink", "AXButton", "AXCell", "AXWebArea"]
  /// The most characters of a window's text that are sent: its end.
  static let textMost = 6000
  /// The pieces joined, one a line, and only the end kept (what is new is at the bottom).
  static func tail(_ parts: [String]) -> String {
    let all = parts.joined(separator: "\n")
    return all.count <= textMost ? all : String(all.suffix(textMost))
  }
  /// Where the watching light sits for a window whose frame is `cg` (the window server's
  /// coordinates: y from the top of the main screen): just inside its top-right corner, in
  /// AppKit's coordinates (y from the bottom), `primaryHeight` being the main screen's height.
  static func spot(window cg: CGRect, primaryHeight: CGFloat) -> CGPoint {
    CGPoint(x: (cg.maxX - 26).rounded(), y: (primaryHeight - cg.minY - 26).rounded())
  }
  /// Is `owner` (a window's app, as the window server names it) the app that was asked for?
  static func same(_ owner: String, _ asked: String) -> Bool {
    let a = owner.lowercased().trimmingCharacters(in: .whitespaces), b = asked.lowercased().trimmingCharacters(in: .whitespaces)
    return !a.isEmpty && !b.isEmpty && (a == b || a.contains(b) || b.contains(a))
  }
}

// MARK: the talk key's double-tap (PushToTalk.swift)

enum PushToTalkMath {
  /// Is this short tap the second of a double-tap? `sinceFirstTap`: seconds from the first tap's
  /// end to this one's start (nil: there was no first tap waiting).
  static func isDoubleTap(sinceFirstTap: Double?, gap: Double) -> Bool {
    guard let s = sinceFirstTap else { return false }
    return s >= 0 && s <= gap
  }
}

// MARK: the menu bar menu (main.swift): its status line and its key hints

enum StatusMenuMath {
  /// The line under "Echo" at the top of the menu: the one thing most worth knowing right now.
  /// `missing`: the name of a required permission that isn't allowed ("Microphone"), or nil.
  /// `app`: the app Echo is working in ("" when the app wasn't told). `step` of `steps`: which
  /// step of the request she is on (0: she didn't say how many).
  static func statusLine(missing: String?, serverUp: Bool, starting: Bool, working: Bool, app: String, step: Int, steps: Int,
                         speaking: Bool, listening: Bool, handsFree: Bool, mode: String = "") -> String {
    if let missing, !missing.isEmpty { return "\(missing) not allowed" }
    if !serverUp { return starting ? "Echo is starting…" : "Echo isn't running" }
    if working {
      let name = app.trimmingCharacters(in: .whitespacesAndNewlines)
      let count = step > 0 && steps > 0 && step <= steps ? " · \(step) of \(steps)" : ""
      return (name.isEmpty ? "Working on your Mac" : "Working in \(name)") + count
    }
    if speaking { return "Speaking" }
    if listening { return "Listening" }
    // The one listening state, when the page has said it (lib/listenmode.js).
    switch mode {
    case "listening": return "Listening · just talk"
    case "resting": return "Resting · say “Echo”"
    case "off": return "Mic off"
    default: return handsFree ? "Ready · hands-free is on" : "Ready"
    }
  }

  /// The push-to-talk chord (PushToTalk.chords) as the menu shows it beside Start Listening
  /// ("" for off or an unknown one: no hint).
  static func pttHint(_ chord: String) -> String {
    ["ctrl-opt": "⌃⌥", "ctrl-cmd": "⌃⌘", "opt-cmd": "⌥⌘", "right-opt": "right ⌥", "fn": "fn"][chord] ?? ""
  }

  /// The summon shortcut (HotKey.presets' ids: "opt-space", "cmd-shift-e"…) as a menu key hint:
  /// the key and its modifiers ("ctrl", "opt", "shift", "cmd"), or nil for off or an unknown id.
  static func summonKey(_ id: String) -> (key: String, mods: [String])? {
    let parts = id.split(separator: "-").map(String.init)
    guard let last = parts.last, parts.count >= 2 else { return nil }
    let mods = Array(parts.dropLast())
    guard mods.allSatisfy({ ["ctrl", "opt", "shift", "cmd"].contains($0) }) else { return nil }
    if last == "space" { return (" ", mods) }
    return last.count == 1 ? (last, mods) : nil
  }
}

// MARK: quitting (Server.swift): which process is Echo's, and what to ask

enum ProcessMath {
  /// Is this process Echo's server for the Echo folder `echoDir`? Its command line must run
  /// `supervisor.js` or `server.js` with node, either by this folder's full path or by the bare
  /// name from inside this folder (`cwd`). Anything else on the port is somebody else's: never ours.
  static func isOurs(command: String, cwd: String?, echoDir: String) -> Bool {
    script(command: command, cwd: cwd, echoDir: echoDir) != nil
  }

  /// "supervisor.js" or "server.js" when the process is Echo's for this folder, else nil.
  /// `command` is the whole command line as `ps` prints it: its words joined by spaces, so a
  /// path with spaces in it can't be split back into words. Instead the script is looked for as
  /// a whole (this folder's full path to it, or its bare name when the process runs in this
  /// folder), and what comes before it must be node and its options, nothing else.
  static func script(command: String, cwd: String?, echoDir: String) -> String? {
    let dir = trimSlash(echoDir)
    guard !dir.isEmpty else { return nil }
    let inFolder = cwd.map { trimSlash($0) == dir } ?? false
    for name in ["supervisor.js", "server.js"] {
      for form in [dir + "/" + name] + (inFolder ? [name, "./" + name] : []) {
        var from = command.startIndex
        while let r = command.range(of: " " + form, range: from..<command.endIndex) {
          from = r.upperBound
          // The whole word, not the start of a longer one ("server.js.bak").
          guard r.upperBound == command.endIndex || command[r.upperBound] == " " else { continue }
          if runsNode(String(command[..<r.lowerBound])) { return name }
        }
      }
    }
    return nil
  }

  /// Is `head` (the command line before the script) node and nothing but its options? Node may be
  /// a path with spaces in it. An option may be followed by one value ("--max-http-header-size
  /// 16384"), but never by another script: then ours is only that script's argument.
  private static func runsNode(_ head: String) -> Bool {
    // Where the options start: at some " -", or nowhere.
    var cuts = [head.endIndex]
    var from = head.startIndex
    while let r = head.range(of: " -", range: from..<head.endIndex) {
      cuts.append(r.lowerBound)
      from = r.upperBound
    }
    for cut in cuts {
      let program = head[..<cut].trimmingCharacters(in: .whitespaces)
      guard (program as NSString).lastPathComponent == "node" else { continue }
      var valueAllowed = false
      var ok = true
      for word in head[cut...].split(separator: " ") {
        if word.hasPrefix("-") { valueAllowed = !word.contains("="); continue }
        if !valueAllowed || [".js", ".mjs", ".cjs", ".ts"].contains(where: { word.hasSuffix($0) }) { ok = false; break }
        valueAllowed = false
      }
      if ok { return true }
    }
    return false
  }

  private static func trimSlash(_ s: String) -> String {
    var t = s
    while t.count > 1, t.hasSuffix("/") { t.removeLast() }
    return t
  }

  /// Which process to signal to stop Echo: the supervisor when the server on the port is its
  /// child (signalling only the server would have the supervisor start it again), else the
  /// process on the port itself. Nil when the process on the port isn't Echo's for this folder.
  static func target(holder: (pid: Int32, command: String, cwd: String?), parent: (pid: Int32, command: String, cwd: String?)?, echoDir: String) -> Int32? {
    guard holder.pid > 1, isOurs(command: holder.command, cwd: holder.cwd, echoDir: echoDir) else { return nil }
    if let parent, parent.pid > 1, script(command: parent.command, cwd: parent.cwd, echoDir: echoDir) == "supervisor.js" { return parent.pid }
    return holder.pid
  }

  /// What Quit asks while workers are running.
  static func quitQuestion(tasks n: Int) -> String {
    "Echo is still working on \(n) task\(n == 1 ? "" : "s")."
  }

  /// What the server's answer to "stop if nothing is running" means (its HTTP status, 0 when
  /// nothing answered, and the body's `ok` and `working`).
  enum Answer: Equatable { case stopping, working(Int), refused, unreachable }
  static func answer(status: Int, ok: Bool?, working: Int?) -> Answer {
    if status == 200, ok == true { return .stopping }
    if status == 200, let working, working > 0 { return .working(working) }
    // It is there but wouldn't take the request (the app's token is missing or isn't the one it
    // expects): not the same as nothing running, so Quit says so instead of guessing.
    if status == 401 || status == 403 { return .refused }
    return .unreachable
  }

  /// What Quit says when the server is there but refused the app's request.
  static let refusedQuestion = "Echo's server didn't accept the app's request to stop."
  static let refusedDetail = "So the app can't tell whether tasks are still running. If you quit and stop it, running tasks pause and pick up where they left off the next time you open Echo."
}

// MARK: waiting for something to show up (MenuBar.swift Watcher)

enum WaitMath {
  /// Is the wait over on this look? `fits`: something was found and it is what was asked for (the
  /// caller's own test, such as a lesson's whole-label match; a near miss like the "Rectangle"
  /// tool for the "Rectangle 1" layer is not a find, and the wait goes on to its deadline).
  /// mode "appear" also needs it to be new: not there at the first look, or the screen changed.
  static func done(fits: Bool, mode: String, wasThere: Bool?, changed: Bool) -> Bool {
    fits && (mode != "appear" || wasThere == false || changed)
  }
}

// MARK: pointing into an open menu (Pointer.swift)

extension MenuMath {
  /// The window layer macOS puts open menus on (pop-up menu level).
  static let layer = 101

  /// Is `target` (AppKit screen coordinates) inside an open menu? `windows`: the layer and bounds
  /// of what's on screen, as the window list reports them (measured from the top of the main
  /// screen, `primaryHeight` tall).
  static func inOpenMenu(_ target: CGRect, windows: [(layer: Int, bounds: CGRect)], primaryHeight: CGFloat) -> Bool {
    let c = CGPoint(x: target.midX, y: primaryHeight - target.midY)
    return windows.contains { $0.layer == layer && $0.bounds.contains(c) }
  }
}

// MARK: Echo's answer, a line at a time, lighting up as she says it (Caption.swift, PillArt.swift)

enum SpeechMath {
  /// When each word starts (seconds) if there's no timing from the voice: about 14 characters a
  /// second, a little longer after punctuation, after `lead` seconds for the voice to start.
  static func estimate(_ words: [String], lead: Double = 0.35) -> [Double] {
    var t = lead
    return words.map { w in
      let s = t
      t += Double(w.count + 1) / 14
      if let last = w.last, ".!?".contains(last) { t += 0.28 } else if let last = w.last, ",;:".contains(last) { t += 0.14 }
      return s
    }
  }

  /// Timings for a line whose start was cut short ("… the newest words"): the last `count`.
  static func align(_ starts: [Double], count: Int) -> [Double] {
    starts.count > count ? Array(starts.suffix(count)) : starts
  }

  /// How many words are lit `t` seconds into the line, each fading in over `fade` seconds as it's
  /// said: 2.4 is two words lit and the third 40% of the way in. Never goes backwards as t grows.
  static func lit(starts: [Double], at t: Double, fade: Double = 0.18) -> CGFloat {
    var n: Double = 0
    for s in starts {
      let u = fade > 0 ? (t - s) / fade : (t >= s ? 1 : 0)
      if u <= 0 { break }
      n += min(1, u)
    }
    return CGFloat(n)
  }

  /// Echo's answer, one line at a time: the words (each `widths[i]` wide, `space` between them)
  /// split into lines that fit `room`, as ranges of word indexes. A word wider than the room gets
  /// a line to itself.
  static func lines(widths: [CGFloat], space: CGFloat, room: CGFloat) -> [Range<Int>] {
    var out: [Range<Int>] = [], start = 0, used: CGFloat = 0
    for (i, w) in widths.enumerated() {
      let more = i == start ? w : used + space + w
      if i > start && more > room {
        out.append(start..<i)
        start = i
        used = w
      } else {
        used = more
      }
    }
    if start < widths.count { out.append(start..<widths.count) }
    return out
  }

  /// Which of `lines` shows when `lit` words are lit (2.4: two said, the third 40% in): the one
  /// with the word being said, so a line stays until its last word is over.
  static func line(_ lines: [Range<Int>], lit: CGFloat) -> Int {
    guard !lines.isEmpty, lit.isFinite else { return max(0, lines.count - 1) }
    let word = max(0, Int(lit.rounded(.up)) - 1)
    return lines.firstIndex { $0.contains(word) } ?? lines.count - 1
  }

  /// How far word `i` has been said when `lit` words are lit: 1 said (white), 0 still to come
  /// (grey), in between while she is saying it.
  static func said(word i: Int, lit: CGFloat) -> CGFloat { min(1, max(0, lit - CGFloat(i))) }
}

// MARK: typing (Driver.swift types this way; kept testable)

enum TypingMath {
  /// However long the text, typing takes at most this long (seconds).
  static let cap: Double = 3.0
  /// Faster than this between key presses and you couldn't see the letters come; they go in
  /// small bursts instead.
  static let minBeat: Double = 0.016

  /// Where the finishing shimmer runs once the text is in: along the caret's line, from the
  /// field's left edge (or up to 420 pt back) to the caret. With no caret, across a one-line
  /// field; a tall field with no caret (a message body) gets none, rather than a flash over it.
  static func shimmerSpan(caret: CGRect?, field: CGRect?) -> CGRect? {
    if let c = caret, c.height > 0 {
      let h = min(28, max(12, c.height))
      var left = c.maxX - 420
      if let f = field, f.minX < c.maxX { left = max(left, f.minX + 2) }
      let w = c.maxX - left
      guard w >= 8 else { return nil }
      return CGRect(x: left, y: c.midY - h / 2, width: w, height: h)
    }
    if let f = field, f.height > 0, f.height <= 44, f.width >= 8 {
      return f.insetBy(dx: 2, dy: 2)
    }
    return nil
  }

  /// The finishing shimmer's pass: a little longer for a longer line, never slow.
  static func shimmerDuration(width: CGFloat) -> Double {
    min(0.85, max(0.45, 0.4 + Double(width) / 900))
  }

  /// One key press (a character, or a few when typing fast) and the wait before it (seconds).
  struct Beat: Equatable {
    var text: String
    var delay: Double
  }

  /// A natural typing rhythm for `text`: about 55 ms a character with a little variation, a
  /// breath after a space and a longer one after punctuation. Long texts speed up evenly so the
  /// whole thing never takes more than `cap`; when that gets too fast to see, characters go in
  /// small bursts. A line break never goes on its own (it rides with the character before it, as
  /// text, never as a Return key press). `seed` makes the variation repeatable.
  static func plan(_ text: String, seed: UInt64 = 0x9E37_79B9) -> [Beat] {
    let chars = Array(text)
    guard !chars.isEmpty else { return [] }
    var rng = seed | 1
    func jitter() -> Double {
      // xorshift: repeatable, no Foundation randomness.
      rng ^= rng << 13
      rng ^= rng >> 7
      rng ^= rng << 17
      return 0.78 + 0.5 * Double(rng % 10_000) / 10_000
    }
    var beats: [Beat] = []
    var prev: Character?
    for c in chars {
      var d = prev == nil ? 0 : 0.055 * jitter()
      if let p = prev {
        if p == " " { d += 0.025 }
        if ",;:".contains(p) { d += 0.09 }
        if ".!?".contains(p) { d += 0.14 }
      }
      if c.isNewline || c == "\t", !beats.isEmpty {
        beats[beats.count - 1].text.append(c)
      } else {
        beats.append(Beat(text: String(c), delay: d))
      }
      prev = c
    }
    // A text that starts with line breaks: they ride with the first character after them.
    if let first = beats.first, first.text.allSatisfy({ $0.isNewline || $0 == "\t" }), beats.count > 1 {
      beats[1].text = first.text + beats[1].text
      beats[1].delay = 0
      beats.removeFirst()
    }
    let total = beats.reduce(0) { $0 + $1.delay }
    guard total > cap else { return beats }
    let k = cap / total
    var out: [Beat] = []
    var pending = ""
    var wait = 0.0
    for (i, b) in beats.enumerated() {
      wait += b.delay * k
      pending += b.text
      if i == 0 || wait >= minBeat || i == beats.count - 1 {
        out.append(Beat(text: pending, delay: i == 0 ? 0 : wait))
        pending = ""
        wait = 0
      }
    }
    return out
  }

  /// How long a plan takes.
  static func duration(_ beats: [Beat]) -> Double { beats.reduce(0) { $0 + $1.delay } }
}


// MARK: acting precisely (Driver.swift and AXFinder use these; kept testable)

enum ActMath {
  /// Controls a click switches: never clicked a second time to "make sure".
  static let toggleRoles: Set<String> = ["AXCheckBox", "AXSwitch", "AXRadioButton", "AXDisclosureTriangle"]
  /// Roles you can act on: what a click or a type should land on, never the text inside it.
  static let interactive: Set<String> = [
    "AXButton", "AXMenuItem", "AXMenuBarItem", "AXLink", "AXTab", "AXRadioButton", "AXCheckBox",
    "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
    "AXDisclosureTriangle", "AXSlider", "AXSwitch", "AXToolbarButton", "AXCell", "AXRow", "AXIncrementor",
    "AXColorWell", "AXDockItem", "AXSegmentedControl", "AXStepper", "AXToggle",
  ]
  /// Fields text goes into.
  static let editable: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"]
  /// What a label search lands on that isn't itself the control (the text in a button, its icon,
  /// the group around it): Echo climbs from these to the control that holds them.
  static let passive: Set<String> = ["AXStaticText", "AXImage", "AXGroup", "AXHeading", "AXGenericElement", "AXUnknown", ""]

  /// Browsers: their windows hold a web page plus the browser's own tabs, toolbar and profile
  /// button. A label search looks in the page unless you ask for the browser's controls.
  static let browsers: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.google.Chrome.dev",
    "com.apple.Safari", "com.apple.SafariTechnologyPreview", "company.thebrowser.Browser", "com.microsoft.edgemac",
    "com.brave.Browser", "org.chromium.Chromium", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "org.mozilla.firefox",
  ]
  static func isBrowser(_ bundle: String?) -> Bool { browsers.contains(bundle ?? "") }

  /// Where a label search looks.
  /// - page: only the web page of the front window (a browser's default)
  /// - app: the app's windows (everything else's default); never other apps' status icons
  /// - browser: the browser's own controls too (tabs, toolbar, address bar, profile)
  /// - menu_bar: status icons and Control Center first
  /// Asking for "page" keeps it "page" unless the app is known not to be a browser (an unknown
  /// app, nil, stays "page": it once fell to "app" and the screen search found a tab's title).
  static func scope(_ asked: String?, bundle: String?) -> String {
    let a = (asked ?? "").lowercased()
    if ["page", "app", "browser", "menu_bar"].contains(a) { return a == "page" && bundle != nil && !isBrowser(bundle) ? "app" : a }
    return isBrowser(bundle) ? "page" : "app"
  }

  /// A browser's own furniture: the tab strip, its tabs, the toolbar and address bar. With scope
  /// "page" a search never looks in these (a tab titled "Compose Mail" is not Gmail's Compose).
  static func isBrowserChrome(role: String, subrole: String) -> Bool {
    ["AXTabGroup", "AXToolbar"].contains(role) || subrole == "AXTabButton"
  }

  /// With scope "page", is a text box read off the screen inside the web page (`page`, the page's
  /// frame in screen coordinates)? Its middle must be; with no known page, nothing is.
  static func onPage(_ box: CGRect, page: CGRect?) -> Bool {
    guard let page, PointMath.usable(page) else { return false }
    return page.contains(CGPoint(x: box.midX, y: box.midY))
  }

  /// A match's score, adjusted for what it is. Controls beat the text inside them; when typing,
  /// a field beats its label (the "To" label vs the "To recipients" box); disabled things lose.
  static func adjust(_ base: Int, role: String, subrole: String = "", enabled: Bool = true, wantsField: Bool = false) -> Int {
    var s = base
    if !enabled { s -= 10 }
    let field = editable.contains(role) || subrole == "AXSearchField"
    if interactive.contains(role) || field { s += 15 } else if role == "AXStaticText" { s += 5 } else if role == "AXGroup" { s -= 10 }
    if wantsField { s += field ? 30 : -20 }
    return s
  }

  /// Should Echo climb from this element to the control around it?
  static func shouldClimb(_ role: String) -> Bool { passive.contains(role) }

  /// A control found by climbing is only the one you meant if it's not much bigger than what
  /// matched (a whole row or panel around a word isn't "the button").
  static func plausibleContainer(_ inner: CGRect, _ outer: CGRect) -> Bool {
    guard outer.insetBy(dx: -2, dy: -2).contains(inner) else { return false }
    let a = max(1, inner.width * inner.height), b = outer.width * outer.height
    return b <= max(a * 40, 160 * 60) && outer.height <= max(inner.height * 4, 90)
  }

  /// "cmd, shift" / "cmd+shift" → modifier names in a fixed order; unknown words are dropped.
  static func modifiers(_ s: String?) -> [String] {
    let names = ["ctrl": "ctrl", "control": "ctrl", "opt": "opt", "option": "opt", "alt": "opt", "shift": "shift", "cmd": "cmd", "command": "cmd"]
    let parts = (s ?? "").lowercased().split(whereSeparator: { $0 == "," || $0 == "+" || $0 == " " }).compactMap { names[String($0)] }
    return ["ctrl", "opt", "shift", "cmd"].filter { parts.contains($0) }
  }
}

// MARK: clean key events

enum KeyMath {
  /// US-layout virtual key codes for the characters typing sends, so a page sees the real key
  /// (KeyM for "m" or "M"), never every letter as "A". Characters not here go on no key at all.
  static let codes: [Character: UInt16] = {
    var m: [Character: UInt16] = [:]
    let base: [(String, UInt16)] = [
      ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9), ("b", 11),
      ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("1", 18), ("2", 19), ("3", 20), ("4", 21),
      ("6", 22), ("5", 23), ("=", 24), ("9", 25), ("7", 26), ("-", 27), ("8", 28), ("0", 29), ("]", 30), ("o", 31),
      ("u", 32), ("[", 33), ("i", 34), ("p", 35), ("l", 37), ("j", 38), ("'", 39), ("k", 40), (";", 41), ("\\", 42),
      (",", 43), ("/", 44), ("n", 45), ("m", 46), (".", 47), (" ", 49), ("`", 50),
    ]
    for (k, v) in base {
      let c = Character(k)
      m[c] = v
      if let up = k.uppercased().first, up != c { m[up] = v }
    }
    for (c, v) in [("!", 18), ("@", 19), ("#", 20), ("$", 21), ("%", 23), ("^", 22), ("&", 26), ("*", 28), ("(", 25), (")", 29),
                   ("_", 27), ("+", 24), ("{", 33), ("}", 30), ("|", 42), (":", 41), ("\"", 39), ("<", 43), (">", 47), ("?", 44), ("~", 50)] as [(String, UInt16)] {
      m[Character(c)] = v
    }
    return m
  }()

  /// The key a one-character text rides on (0 with no better choice). Never a modifier: text
  /// events always go out with NO modifier flags, so a ⌘ held over from ⌘A can't turn "M" into
  /// ⌘⇧M (Chrome's profile menu: the Sept 29 Gmail "Subject" bug).
  static func code(for text: String) -> UInt16 {
    guard text.count == 1, let c = text.first else { return 0 }
    return codes[c] ?? 0
  }

  /// Apps where a typed line break means Return, not Shift+Return: terminals (run the command) and
  /// spreadsheets (the next row down; there Shift+Return goes up a row).
  static let returnApps: Set<String> = ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "net.kovidgoyal.kitty", "io.alacritty", "com.mitchellh.ghostty",
                                        "com.apple.iWork.Numbers", "com.microsoft.Excel"]

  /// A beat of typing split into text runs and line breaks: line breaks go as real key presses
  /// (web editors ignore a "\n" character), tabs as Tab. A line break is Shift+Return (`softBreak`):
  /// a new line in chat boxes (Claude, Slack, Messages), where Return alone sends what's typed so
  /// far, and in ordinary editors alike. In a terminal (`returnApps`) it's Return.
  enum Piece: Equatable { case text(String), key(UInt16), softBreak }
  static func pieces(_ s: String, returnBreaks: Bool = false) -> [Piece] {
    var out: [Piece] = []
    var run = ""
    for c in s {
      if c.isNewline || c == "\t" {
        if !run.isEmpty { out.append(.text(run)); run = "" }
        out.append(c == "\t" ? .key(48) : returnBreaks ? .key(36) : .softBreak)
      } else {
        run.append(c)
      }
    }
    if !run.isEmpty { out.append(.text(run)) }
    return out
  }
}

// MARK: the shortcuts an app's menus list

enum MenuMath {
  /// Keys as Echo writes them, in one order: "cmd+shift+N" → "shift+cmd+n" (ctrl, opt, shift, cmd, then the key).
  static func normal(_ keys: String) -> String {
    let parts = keys.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    let mods = ["ctrl", "opt", "shift", "cmd"].filter { parts.contains($0) || ($0 == "opt" && parts.contains("alt")) || ($0 == "cmd" && parts.contains("command")) }
    let key = parts.filter { !["ctrl", "control", "opt", "alt", "option", "shift", "cmd", "command"].contains($0) }
    return (mods + key).joined(separator: "+")
  }

  /// A menu item's shortcut (its AXMenuItemCmdChar and AXMenuItemCmdModifiers) as Echo writes keys.
  /// Modifier bits: shift 1, option 2, control 4, and 8 means no Command.
  static func combo(char: String, mods: Int) -> String? {
    let c = char.lowercased()
    guard c.count == 1, let ch = c.first, !ch.isWhitespace else { return nil }
    var parts: [String] = []
    if mods & 4 != 0 { parts.append("ctrl") }
    if mods & 2 != 0 { parts.append("opt") }
    if mods & 1 != 0 { parts.append("shift") }
    if mods & 8 == 0 { parts.append("cmd") }
    parts.append(c)
    return parts.joined(separator: "+")
  }
}

// MARK: did it work? (the observe → act → verify check)

enum VerifyMath {
  /// What Echo can see of the app before and after an action, to tell whether anything happened.
  struct Snapshot: Equatable {
    var focusRole = ""
    var focusLabel = ""
    var focusValue = ""
    var window = ""
    var windows = 0
    var url = ""
    var menuOpen = false
    var targetState = ""
    var signature = 0
    var front = ""
  }

  /// What changed between two snapshots (empty: nothing Echo can see).
  static func changes(_ a: Snapshot, _ b: Snapshot) -> [String] {
    var out: [String] = []
    if a.front != b.front { out.append("front_app") }
    if a.focusRole != b.focusRole || a.focusLabel != b.focusLabel { out.append("focus") }
    if a.focusValue != b.focusValue { out.append("value") }
    if a.window != b.window { out.append("window_title") }
    if a.windows != b.windows { out.append("windows") }
    if a.url != b.url { out.append("url") }
    if a.menuOpen != b.menuOpen { out.append(b.menuOpen ? "menu_opened" : "menu_closed") }
    if a.targetState != b.targetState { out.append("target_state") }
    if a.signature != b.signature { out.append("content") }
    return out
  }

  /// Squeezed spaces and no zero-width characters: how typed text is compared with what a field holds.
  static func squeeze(_ s: String) -> String {
    let cleaned = s.unicodeScalars.filter { !["\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}"].contains($0) }
    return String(String.UnicodeScalarView(cleaned)).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  }

  /// Is the typed text in the field, exactly? Always checked this way (Oct 3: a formula bar that
  /// ended up holding "HellohelloHello" counted as "Hello" typed, because the text was in there
  /// somewhere). Replacing: the field holds exactly that. Adding: it holds the text and grew by it
  /// (`before`: what the field held just before typing, when known), so text that was already there
  /// doesn't count. Spaces are squeezed and zero-width characters ignored; nothing else is forgiven
  /// (autocorrect, a lost word, a cut-off end).
  /// `suggested`: the field's selected text, where an address bar or a search box puts the rest of
  /// what it guesses you mean ("github" shows "github.com/", with ".com/" selected): not typed, not wrong.
  static func typed(_ text: String, into value: String, replaced: Bool = false, before: String? = nil, suggested: String = "") -> Bool {
    let want = squeeze(text), have = squeeze(value)
    if want.isEmpty { return replaced ? have.isEmpty : true }
    if replaced { return have == want || (!suggested.isEmpty && value.hasSuffix(suggested) && have == squeeze(text + suggested)) }
    guard have.contains(want) else { return false }
    guard let before else { return true }
    let was = squeeze(before)
    // Typed at the end, the start or the cursor: the field holds what it held, plus the text.
    return have.count >= was.count + want.count - 1 || was.isEmpty
  }

  /// Does the field already hold what Echo was asked to type?
  enum Holds: Equatable { case no, same, otherCase }

  /// Checked before any typing, so nothing is typed a second time (Oct 3: "Hello" added to a cell
  /// that said "hello" made "helloHello"). `.same`: it says exactly that, nothing to do.
  /// `.otherCase`: the same words in other capitals; the assistant is told and decides. `.no`: type.
  /// Only an asked-for replace (`replace`) types over the same words in other capitals.
  static func already(_ text: String, in value: String, replace: Bool) -> Holds {
    let want = squeeze(text), have = squeeze(value)
    guard !want.isEmpty else { return .no }
    if have == want { return .same }
    if !replace && have.lowercased() == want.lowercased() { return .otherCase }
    return .no
  }
}

// MARK: emptying a field before typing over it (replace mode, clear_field)

enum ClearMath {
  /// The ways Echo empties a field, tried in order until the field reads back empty:
  /// - range: select all of its text through Accessibility, then Delete
  /// - selectAll: ⌘A, then Delete
  /// - setEmpty: set its value to nothing through Accessibility
  /// - ends: ⌘↑ then ⇧⌘↓ (start of the text to its end), then Delete
  enum Way: Equatable { case range, selectAll, setEmpty, ends }

  /// In a spreadsheet ⌘A is never pressed: there it selects every cell, not the formula bar's
  /// text (Oct 3: "replace" in Excel's formula bar left the old text in place). Web pages don't
  /// notice a selection or a value set through Accessibility, so they get keys only.
  static func plan(sheet: Bool, web: Bool, rangeSettable: Bool, valueSettable: Bool) -> [Way] {
    var ways: [Way] = []
    if rangeSettable && !web { ways.append(.range) }
    if !sheet { ways.append(.selectAll) }
    if valueSettable && !web { ways.append(.setEmpty) }
    ways.append(.ends)
    return ways
  }

  /// May Delete be pressed after selecting? In a spreadsheet only when the whole text is seen to
  /// be selected (`selected`: the length of the selection, nil when the app doesn't say): Delete
  /// with the keyboard somewhere else would empty cells. Elsewhere yes, as ever: the read-back
  /// after it decides whether the field really emptied.
  static func mayDelete(sheet: Bool, selected: Int?, count: Int) -> Bool {
    guard sheet else { return true }
    return (selected ?? -1) >= count
  }

  /// Is the field empty now? Nothing in it, or only its own placeholder (some web fields say so).
  static func isEmpty(_ value: String, placeholder: String = "") -> Bool {
    let v = VerifyMath.squeeze(value)
    return v.isEmpty || (!placeholder.isEmpty && v == VerifyMath.squeeze(placeholder))
  }
}

// MARK: spreadsheets (Excel, Numbers): cells, the grid, and the keys that work in it

enum SheetMath {
  static let excel = "com.microsoft.Excel", numbers = "com.apple.iWork.Numbers"
  static func isSheet(_ bundle: String?) -> Bool { bundle == excel || bundle == numbers }

  /// A cell reference as the assistant or the user says it: "A1", "b12", "AA3", "cell A1", "$C$4".
  /// Comes back tidy ("B12"), or nil for anything else (a label like "Save", "Q4 results", "A0").
  /// Columns up to XFD and rows up to 1048576, the most a sheet has.
  static func cellRef(_ s: String) -> String? {
    var t = s.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    if t.hasPrefix("CELL ") { t = String(t.dropFirst(5)).trimmingCharacters(in: .whitespaces) }
    t = t.replacingOccurrences(of: "$", with: "")
    let letters = t.prefix { $0 >= "A" && $0 <= "Z" }
    let digits = t.dropFirst(letters.count)
    guard (1...3).contains(letters.count), (1...7).contains(digits.count), digits.allSatisfy({ $0 >= "0" && $0 <= "9" }),
          digits.first != "0", let row = Int(digits), row <= 1_048_576 else { return nil }
    let column = letters.unicodeScalars.reduce(0) { $0 * 26 + Int($1.value) - 64 }
    return column <= 16_384 ? String(letters) + String(digits) : nil
  }

  /// The parts of a spreadsheet window Echo works with.
  enum Part: Equatable { case nameBox, formulaBar, grid }

  /// Which part an element is, by its role and its name (title or description). Excel: the "Name
  /// Box" (a combo box showing the selected cell), the "Formula Bar" (a text area showing what the
  /// cell holds) and the grid, a layout area titled "Content Area". Numbers: the table.
  static func part(role: String, label: String) -> Part? {
    let name = label.lowercased()
    if ActMath.editable.contains(role) {
      if name.contains("name box") { return .nameBox }
      if name.contains("formula bar") || name == "formula" { return .formulaBar }
      return nil
    }
    return isGrid(role: role, label: label) ? .grid : nil
  }

  /// The grid and its cells: not text fields, but they take typing all the same.
  static let gridRoles: Set<String> = ["AXLayoutArea", "AXTable", "AXCell", "AXLayoutItem"]
  static func isGrid(role: String, label: String) -> Bool {
    gridRoles.contains(role) || label.lowercased() == "content area"
  }

  /// Can typing go here? In a spreadsheet the grid takes it: keys typed with a cell selected
  /// replace what the cell holds, as when a person types there. Nowhere else (in other apps a
  /// table or a layout area ignores keys, or takes them as shortcuts).
  static func typable(role: String, label: String, bundle: String?) -> Bool {
    isSheet(bundle) && isGrid(role: role, label: label)
  }

  /// Keys that open the selected cell for editing with the cursor at the end of what it holds
  /// (adding to a cell): Control+U in Excel on the Mac, Option+Return in Numbers.
  static func editKeys(_ bundle: String?) -> String? {
    bundle == excel ? "ctrl+u" : bundle == numbers ? "opt+return" : nil
  }

  /// Keys that enter what was typed and keep the same cell selected (plain Return moves a row
  /// down, so "now make it bold" would hit the cell below): Control+Return in Excel,
  /// Command+Return in Numbers.
  static func commitKeys(_ bundle: String?) -> String? {
    bundle == excel ? "ctrl+return" : bundle == numbers ? "cmd+return" : nil
  }

  /// Excel's Go To (Control+G): type a reference, Return. The way to a cell when the Name Box is hidden.
  static func goToKeys(_ bundle: String?) -> String? { bundle == excel ? "ctrl+g" : nil }

  /// What ends up in the selected cell when `text` is typed in the grid: the part after the last
  /// Tab or line break (each of those enters a cell and moves on). `many`: it filled several cells.
  static func lastEntry(_ text: String) -> (entry: String, many: Bool) {
    let parts = text.split(omittingEmptySubsequences: false, whereSeparator: { $0.isNewline || $0 == "\t" })
    return (String(parts.last ?? ""), parts.count > 1)
  }

  /// A formatting shortcut and the ribbon or sidebar control that shows its state, so "make it
  /// bold" can be confirmed by reading that control before and after.
  static func formatControl(_ keys: String) -> String? {
    ["cmd+b": "Bold", "cmd+i": "Italic", "cmd+u": "Underline"][MenuMath.normal(keys)]
  }
}

// MARK: the pointer's finishing touches (Pointer.swift draws them)

enum TouchMath {
  /// A focus ring that matches the control's real shape: a search field or a pill button is round-
  /// ended, a text field or a button has gently rounded corners, a link or a row is nearly square, a
  /// radio button is a circle.
  static func corner(role: String, frame r: CGRect) -> CGFloat {
    let h = r.height, half = min(r.width, r.height) / 2
    switch role {
    case "AXRadioButton": return half
    case "AXSearchField": return min(half, h / 2)
    case "AXTextField", "AXComboBox", "AXTextArea", "AXPopUpButton": return min(7, half)
    case "AXButton", "AXMenuButton", "AXToolbarButton": return h <= 30 && r.width <= 160 ? min(half, 8) : min(8, half)
    case "AXLink", "AXStaticText", "AXCell", "AXRow", "AXMenuItem": return min(4, half)
    case "AXCheckBox": return min(5, half)
    default: return min(10, h / 2)
    }
  }

  /// A shortcut as key caps: "cmd+shift+t" → ["⌘", "⇧", "T"], "return" → ["↩"].
  static func glyphs(_ combo: String) -> [String] {
    let names: [String: String] = [
      "cmd": "⌘", "shift": "⇧", "opt": "⌥", "ctrl": "⌃", "return": "↩", "tab": "⇥", "escape": "esc", "delete": "⌫",
      "forwarddelete": "⌦", "space": "space", "left": "←", "right": "→", "up": "↑", "down": "↓", "home": "↖", "end": "↘",
      "pageup": "⇞", "pagedown": "⇟",
    ]
    return combo.lowercased().split(separator: "+", omittingEmptySubsequences: false).map { part in
      let p = String(part)
      if p.isEmpty { return "+" }
      return names[p] ?? p.uppercased()
    }
  }
}

/// Lessons (lib/teach.js) ask about controls by the label a step names. Which control is it?
enum StateMath {
  private static func norm(_ s: String) -> String {
    s.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
  }

  /// The index of the control named `label`: an exact name first, then one starting with it
  /// ("Wi-Fi" → "Wi-Fi, Connected"), then one containing it as a whole word. The shortest name wins
  /// a tie, so "Bold" picks "Bold", not "Bold Italic". Nil when nothing fits.
  static func match(_ label: String, names: [String]) -> Int? {
    let want = norm(label)
    guard !want.isEmpty else { return nil }
    let normed = names.map(norm)
    if let i = normed.firstIndex(of: want) { return i }
    func shortest(_ ok: (String) -> Bool) -> Int? {
      normed.indices.filter { ok(normed[$0]) }.min { normed[$0].count < normed[$1].count }
    }
    if let i = shortest({ $0.hasPrefix(want + " ") || $0.hasPrefix(want + ",") }) { return i }
    return shortest { (" " + $0 + " ").contains(" " + want + " ") }
  }
}

/// Where a found thing is, in the words people use before they point ("top left, the square
/// icon": RESEARCH.md 2.3). Only fixed words ever come out of here: never a label or a title.
enum PlaceMath {
  /// Which ninth of its window a thing is in, by its centre (AppKit coordinates, y going up):
  /// "top left", "top", "top right", "left", "middle", "right", "bottom left", "bottom" or
  /// "bottom right". A thing as wide as its window is neither left nor right (its centre is in
  /// the middle third). A window with no real size has no regions: everything is in the "middle".
  static func region(_ frame: CGRect, in window: CGRect) -> String {
    let nums = [frame.minX, frame.minY, frame.width, frame.height, window.minX, window.minY, window.width, window.height]
    guard nums.allSatisfy({ $0.isFinite }), window.width >= 1, window.height >= 1 else { return "middle" }
    // A centre outside the window (a thing half off its edge) counts as at that edge.
    let x = (min(max(frame.midX, window.minX), window.maxX) - window.minX) / window.width
    let y = (min(max(frame.midY, window.minY), window.maxY) - window.minY) / window.height
    let third: CGFloat = 1.0 / 3.0
    let across = x < third ? "left" : x > 2 * third ? "right" : ""
    let up = y > 2 * third ? "top" : y < third ? "bottom" : ""
    let words = [up, across].filter { !$0.isEmpty }
    return words.isEmpty ? "middle" : words.joined(separator: " ")
  }

  /// What kind of thing it is, in a plain word: "button", "menu", "field", "tab", "checkbox", or
  /// "icon" for a picture or a button with no title of its own. "" for anything else (a link, a
  /// row, a switch): saying nothing is better than the wrong word.
  static func kind(role: String, subrole: String = "", titled: Bool = true) -> String {
    if subrole == "AXTabButton" || role == "AXTab" { return "tab" }
    if subrole == "AXSwitch" || subrole == "AXToggle" { return "" }
    switch role {
    case "AXButton": return titled ? "button" : "icon"
    case "AXImage": return "icon"
    case "AXMenuButton", "AXPopUpButton", "AXMenuBarItem": return "menu"
    case "AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField", "AXComboBox": return "field"
    case "AXCheckBox": return "checkbox"
    default: return ""
    }
  }

  /// The named part of a window an ancestor stands for: "toolbar", "sidebar", "menu bar",
  /// "tab bar" or "dialog"; nil when it is none of them. `name` is the ancestor's own title or
  /// description (only looked at for the word "sidebar"); `kind` is what was found (a tab group
  /// is the tab bar for its tabs, but not for a button on one of its pages).
  static func container(role: String, subrole: String = "", name: String = "", kind: String = "") -> String? {
    switch role {
    case "AXToolbar": return "toolbar"
    case "AXMenuBar": return "menu bar"
    case "AXSheet": return "dialog"
    case "AXWindow": return subrole == "AXDialog" || subrole == "AXSystemDialog" ? "dialog" : nil
    case "AXTabGroup": return kind == "tab" ? "tab bar" : nil
    default: break
    }
    if subrole == "AXSourceList" { return "sidebar" }
    let sidebarRoles: Set<String> = ["AXOutline", "AXList", "AXTable", "AXScrollArea", "AXGroup", "AXSplitGroup"]
    return sidebarRoles.contains(role) && name.lowercased().contains("sidebar") ? "sidebar" : nil
  }

  /// Does the walk up the parents end here? A window, an app or a menu is as far as "inside" goes.
  static func ends(role: String) -> Bool { ["AXWindow", "AXSheet", "AXApplication", "AXMenu", "AXMenuBar"].contains(role) }
}

/// The permissions checklist (Permissions.swift): which rows it has, their words, which are
/// required, what the window says overall, and where things sit in it. The app reads the real
/// states (PushToTalk.swift's Permissions); nothing here asks macOS anything.
enum PermMath {
  /// What macOS says about one permission. "Not yet" is nobody having answered; "denied" is only
  /// said where macOS tells the two apart (the microphone, speech, Input Monitoring).
  enum State: String {
    case allowed, notYet = "notyet", denied
    var label: String {
      switch self {
      case .allowed: return "Allowed"
      case .notYet: return "Not yet"
      case .denied: return "Denied"
      }
    }
  }

  struct Row: Equatable {
    let id: String
    let name: String
    /// What Echo uses it for, in one sentence.
    let use: String
    /// What is lost without it (the recommended ones; Echo doesn't work without the required ones).
    let lost: String
    let required: Bool
  }

  /// The rows, in the order they are asked for. Screen Recording is left out where the Mac can't
  /// look at the screen (before macOS 14), Speech Recognition where it isn't used (before macOS 26).
  static func rows(screen: Bool, speech: Bool) -> [Row] {
    var out = [
      Row(id: "microphone", name: "Microphone", use: "So Echo can hear you when you talk to it.",
          lost: "Without it, Echo can't hear you.", required: true),
      Row(id: "accessibility", name: "Accessibility", use: "So Echo can find buttons and menus by name, and click or type when you let it.",
          lost: "Without it, Echo can't find or show you anything in other apps.", required: true),
    ]
    if screen {
      out.append(Row(id: "screen", name: "Screen Recording", use: "So Echo can look at your screen, only when you ask.",
                     lost: "Without it, Echo can't look at your screen, so it can't read an error or see what you mean by \"this\".", required: false))
    }
    out.append(Row(id: "input", name: "Input Monitoring", use: "So holding Control + Option talks to Echo from any app.",
                   lost: "Without it, holding Control + Option won't reach Echo from other apps.", required: false))
    if speech {
      out.append(Row(id: "speech", name: "Speech Recognition", use: "So your words appear as you say them, turned into text on this Mac.",
                     lost: "Without it, your words don't appear while you are still speaking.", required: false))
    }
    return out
  }

  /// What the window shows: the rows, what macOS says about each (one it hasn't said anything
  /// about counts as "not yet"), and the ones Echo has already asked macOS for.
  struct Model: Equatable {
    var rows: [Row]
    var states: [String: State]
    var asked: Set<String> = []

    func state(_ row: Row) -> State { states[row.id] ?? .notYet }
    /// Still to allow: the required ones, or the recommended ones.
    func missing(required: Bool) -> [Row] { rows.filter { $0.required == required && state($0) != .allowed } }
    var overall: Overall {
      if !missing(required: true).isEmpty { return .needs }
      return missing(required: false).isEmpty ? .allSet : .ready
    }
  }

  /// Needs you (a required one is missing), ready (only recommended ones are), or all set.
  enum Overall { case needs, ready, allSet }

  static func tag(_ row: Row) -> String { row.required ? "Required" : "Recommended" }

  /// The one sentence under a row's name: what it is for, or, for a recommended one that isn't
  /// allowed, what you are doing without.
  static func sentence(_ row: Row, _ state: State) -> String {
    state != .allowed && !row.required ? row.lost : row.use
  }

  /// The row's one button. "Allow" brings up macOS's own prompt, which it shows only once: after
  /// that, or once it has been refused, the only way is the page in System Settings.
  static func button(_ row: Row, _ state: State, asked: Bool) -> String? {
    switch state {
    case .allowed: return nil
    case .notYet: return asked ? "Open Settings" : "Allow"
    case .denied: return "Open Settings"
    }
  }

  static func title(_ m: Model) -> String {
    switch m.overall {
    case .needs: return "Echo needs your OK"
    case .ready: return "Echo is ready"
    case .allSet: return "All set"
    }
  }

  static func detail(_ m: Model) -> String {
    switch m.overall {
    case .needs: return "Echo can't work without \(list(m.missing(required: true).map(\.name)))."
    case .ready: return "It works without \(list(m.missing(required: false).map(\.name))), with less: each one says what you lose."
    case .allSet: return "Echo has everything it needs."
    }
  }

  /// The line beside Done (or where Done will be).
  static func footer(_ m: Model) -> String {
    switch m.overall {
    case .needs:
      let n = m.missing(required: true).count
      return n == 1 ? "1 required permission to go." : "\(n) required permissions to go."
    case .ready: return "Everything required is allowed."
    case .allSet: return "Everything is allowed."
    }
  }

  /// "A", "A and B", "A, B and C".
  static func list(_ names: [String]) -> String {
    guard names.count > 1 else { return names.first ?? "" }
    return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
  }

  /// Shown by itself at launch: the first time ever, and whenever a required one is missing.
  static func showAtLaunch(firstRun: Bool, _ m: Model) -> Bool { firstRun || m.overall == .needs }

  /// What changed since the last look, for the timeline: each changed permission and its new
  /// state, nothing else. (Nothing on the first look: the launch line already says where it started.)
  static func changes(from old: [String: State]?, to new: [String: State]) -> [String: String] {
    guard let old else { return [:] }
    var out: [String: String] = [:]
    for (id, s) in new where old[id] != s { out[id] = s.rawValue }
    return out
  }

  // Where things sit (points, y up). The window is as tall as its rows need.
  static let width: CGFloat = 540
  static let pad: CGFloat = 28
  static let header: CGFloat = 156
  static let rowHeight: CGFloat = 78
  static let note: CGFloat = 50
  static let footerHeight: CGFloat = 62
  /// The right-hand column: the state, and the button under it.
  static let side: CGFloat = 116
  static let buttonHeight: CGFloat = 26

  static func size(rows n: Int) -> CGSize { CGSize(width: width, height: header + CGFloat(n) * rowHeight + note + footerHeight) }
  static func rowRect(_ i: Int, of n: Int) -> CGRect {
    CGRect(x: 0, y: footerHeight + note + CGFloat(n - 1 - i) * rowHeight, width: width, height: rowHeight)
  }
  /// A capsule button for a label `labelWidth` wide, right-aligned in the row's side column.
  static func buttonRect(_ i: Int, of n: Int, labelWidth: CGFloat) -> CGRect {
    let w = (labelWidth + 26).rounded(.up), r = rowRect(i, of: n)
    return CGRect(x: width - pad - w, y: r.minY + 15, width: w, height: buttonHeight)
  }
  static func doneRect(labelWidth: CGFloat) -> CGRect {
    let w = max(76, (labelWidth + 34).rounded(.up))
    return CGRect(x: width - pad - w, y: (footerHeight - 30) / 2, width: w, height: 30)
  }
  /// How wide a row's words may run before the side column.
  static var textWidth: CGFloat { width - pad * 2 - side - 22 - 12 }

  /// The logo's three bars from a shared left edge (scripts/render-icon.swift's proportions),
  /// `thick` thick, top to bottom, with (0, 0) at the top bar's left end and y down.
  static func bars(thick: CGFloat) -> [CGRect] {
    let s = thick / 104
    return [(390.0, 0.0), (257, 159), (133, 318)].map { CGRect(x: 0, y: CGFloat($0.1) * s, width: CGFloat($0.0) * s + thick, height: thick) }
  }
}
