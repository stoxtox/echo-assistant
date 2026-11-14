// Tests for PointMath.swift (coordinates, visibility, label matching). test/pointmath.test.js
// compiles this with macos/Sources/PointMath.swift and runs it; it exits 1 on the first failure.
import CoreGraphics
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) {
  if !ok {
    failures += 1
    print("FAIL (line \(line)): \(what)")
  }
}
func near(_ a: CGRect?, _ b: CGRect) -> Bool {
  guard let a else { return false }
  return abs(a.minX - b.minX) < 0.01 && abs(a.minY - b.minY) < 0.01 && abs(a.width - b.width) < 0.01 && abs(a.height - b.height) < 0.01
}

// Screens as AppKit frames: a 1512×982 laptop (primary) and a 1920×1080 display to its right,
// its bottom 200 points lower. And one above the laptop.
let laptop = CGRect(x: 0, y: 0, width: 1512, height: 982)
let right = CGRect(x: 1512, y: -200, width: 1920, height: 1080)
let above = CGRect(x: 0, y: 982, width: 1512, height: 982)

// Accessibility → AppKit: flip against the PRIMARY screen's height, on any display.
check(near(PointMath.axToAppKit(CGRect(x: 773, y: 78, width: 59, height: 24), primaryHeight: 982), CGRect(x: 773, y: 880, width: 59, height: 24)), "flip on the primary screen")
check(near(PointMath.axToAppKit(CGRect(x: 2000, y: 1000, width: 100, height: 20), primaryHeight: 982), CGRect(x: 2000, y: -38, width: 100, height: 20)), "flip on a lower secondary screen")
check(near(PointMath.axToAppKit(CGRect(x: 100, y: -500, width: 50, height: 20), primaryHeight: 982), CGRect(x: 100, y: 1462, width: 50, height: 20)), "flip on a screen above (negative AX y)")
check(PointMath.screenIndex(for: PointMath.axToAppKit(CGRect(x: 2000, y: 1000, width: 100, height: 20), primaryHeight: 982), in: [laptop, right]) == 1, "lands on the right-hand screen")
check(PointMath.screenIndex(for: PointMath.axToAppKit(CGRect(x: 100, y: -500, width: 50, height: 20), primaryHeight: 982), in: [laptop, right, above]) == 2, "lands on the screen above")

// Capture pixels (Retina: 2× the points) ↔ screen points, round trip, on a secondary display.
let img = CGSize(width: 3840, height: 2160)
let box = CGRect(x: 200, y: 100, width: 120, height: 40) // pixels, top-left origin
let pts = PointMath.imageToScreen(box, display: right, imageSize: img)
check(near(pts, CGRect(x: 1612, y: 810, width: 60, height: 20)), "pixels to points on a Retina secondary screen: \(pts)")
check(near(PointMath.screenToImage(pts, display: right, imageSize: img), box), "and back again")
// A 1600-pixel-wide downscaled picture of the laptop screen.
let small = PointMath.imageToScreen(CGRect(x: 800, y: 0, width: 16, height: 16), display: laptop, imageSize: CGSize(width: 1600, height: 1039.2))
check(abs(small.minX - 756) < 0.01 && abs(small.maxY - 982) < 0.01, "downscaled picture: top-middle pixel is the top-middle point")

// No usable frame: nothing to point at (never a fall-back to the middle of the screen).
check(!PointMath.usable(.zero), "zero frame")
check(!PointMath.usable(CGRect(x: 10, y: 10, width: 0, height: 20)), "zero width")
check(!PointMath.usable(CGRect(x: CGFloat.nan, y: 10, width: 20, height: 20)), "NaN position")
check(!PointMath.usable(CGRect(x: 10, y: 10, width: CGFloat.infinity, height: 20)), "infinite size")
check(!PointMath.usable(.null), "null rect")
check(PointMath.usable(CGRect(x: -300, y: 5, width: 20, height: 20)), "negative coordinates are fine")
check(PointMath.screenIndex(for: CGRect(x: 5000, y: 5000, width: 20, height: 20), in: [laptop, right]) == nil, "off every screen")
check(PointMath.visiblePart(CGRect(x: 5000, y: 5000, width: 20, height: 20), clips: [], screens: [laptop]) == nil, "off-screen is not visible")
check(PointMath.visiblePart(.zero, clips: [], screens: [laptop]) == nil, "zero frame is not visible")

// The System Settings case: the sidebar scroll area (AX 759,131 215×765) and a Wi-Fi row
// scrolled above it (AX 773,78 59×24), sitting under the search field.
let window = PointMath.axToAppKit(CGRect(x: 751, y: 33, width: 723, height: 871), primaryHeight: 982)
let sidebar = PointMath.axToAppKit(CGRect(x: 759, y: 131, width: 215, height: 765), primaryHeight: 982)
let wifi = PointMath.axToAppKit(CGRect(x: 773, y: 78, width: 59, height: 24), primaryHeight: 982)
check(PointMath.visiblePart(wifi, clips: [window, sidebar], screens: [laptop]) == nil, "a row scrolled out of the sidebar is not visible")
check(PointMath.scrollDirection(wifi, clip: sidebar) == "up", "and you scroll up to see it")
let below = PointMath.axToAppKit(CGRect(x: 773, y: 950, width: 59, height: 24), primaryHeight: 982)
check(PointMath.scrollDirection(below, clip: sidebar) == "down", "a row below the sidebar: scroll down")
let appearance = PointMath.axToAppKit(CGRect(x: 773, y: 134, width: 100, height: 24), primaryHeight: 982)
check(near(PointMath.visiblePart(appearance, clips: [window, sidebar], screens: [laptop]), appearance), "a row inside the sidebar is visible")
let peeking = PointMath.axToAppKit(CGRect(x: 773, y: 125, width: 100, height: 24), primaryHeight: 982)
check(near(PointMath.visiblePart(peeking, clips: [window, sidebar], screens: [laptop]), peeking.intersection(sidebar)), "mostly visible: point at the part that shows")
let sliver = PointMath.axToAppKit(CGRect(x: 773, y: 110, width: 100, height: 24), primaryHeight: 982)
check(PointMath.visiblePart(sliver, clips: [window, sidebar], screens: [laptop]) == nil, "only a sliver shows: not visible")

// Label matching.
check(LabelMatch.score("Wi\u{2011}Fi", "Wi-Fi") == 100, "non-breaking hyphen (U+2011) matches a hyphen")
check(LabelMatch.score("Wi\u{2011}Fi", "wifi") >= 95, "wifi matches Wi‑Fi")
check(LabelMatch.score("Wi-Fi", "WIFI") >= 95, "case-insensitive")
check(LabelMatch.score("Wi\u{2011}Fi", "wi fi") == 100, "wi fi")
check(LabelMatch.score("Save…", "save") == 100, "punctuation ignored")
check(LabelMatch.score("Général", "general") == 100, "accents ignored")
check(LabelMatch.score("Network", "Wi-Fi") == 0, "no false match")
check(LabelMatch.score("Search", "search") == 100, "search")
check(LabelMatch.asksForSearchField("Search"), "\"Search\" asks for the search field")
check(LabelMatch.asksForSearchField("the search bar"), "\"the search bar\" too")
check(!LabelMatch.asksForSearchField("Search Engine"), "\"Search Engine\" is a label")

// Is Echo's window really where Echo would act? Only if it's in front there (live bug, Sept 28:
// Chrome's address bar sat over Echo's window behind it, and typing was refused).
let echoPid: Int32 = 500, chromePid: Int32 = 600
let frontToBack = [
  PointMath.Win(pid: echoPid, number: 90, bounds: CGRect(x: 0, y: 0, width: 1512, height: 982), layer: 1000, alpha: 1), // the driving border
  PointMath.Win(pid: chromePid, number: 20, bounds: CGRect(x: 100, y: 40, width: 1200, height: 800), layer: 0, alpha: 1),
  PointMath.Win(pid: echoPid, number: 10, bounds: CGRect(x: 200, y: 60, width: 1180, height: 800), layer: 0, alpha: 1),
]
check(PointMath.topWindowOwner(at: CGPoint(x: 400, y: 80), windows: frontToBack, skipping: [90]) == chromePid, "Chrome's address bar is Chrome's, though Echo's window is behind it")
check(PointMath.topWindowOwner(at: CGPoint(x: 1350, y: 500), windows: frontToBack, skipping: [90]) == echoPid, "where only Echo's window is, it's Echo's")
check(PointMath.topWindowOwner(at: CGPoint(x: 1350, y: 500), windows: frontToBack) == echoPid, "an overlay not skipped is still Echo's")
check(PointMath.topWindowOwner(at: CGPoint(x: 5, y: 900), windows: frontToBack, skipping: [90]) == nil, "nothing there")
let ghost = [PointMath.Win(pid: 7, number: 1, bounds: CGRect(x: 0, y: 0, width: 100, height: 100), layer: 0, alpha: 0)] + frontToBack
check(PointMath.topWindowOwner(at: CGPoint(x: 400, y: 80), windows: ghost, skipping: [90]) == chromePid, "see-through windows don't count")

// The island: top centre, just under the menu bar, hugging its words, out of the way of the target.
let screenRect = CGRect(x: 0, y: 0, width: 1512, height: 982)
let visible = CGRect(x: 0, y: 80, width: 1512, height: 870) // the Dock takes the bottom 80, the menu bar the top 32
let pill = PillMath.frame(visible: visible, width: 300)
check(abs(pill.midX - 756) < 1 && abs(pill.maxY - (visible.maxY - 8)) < 0.01 && pill.height == 46, "8 pt under the menu bar, centred, 46 pt tall: \(pill)")
check(pill.maxY <= visible.maxY, "never over the menu bar")
check(PillMath.corner == 22, "22 pt corners")
// A notch, in a full-screen app with the menu bar hidden: the island stays under it.
let notched = PillMath.usable(visible: screenRect, screen: screenRect, safeTop: 32)
check(notched.maxY == 950 && PillMath.frame(visible: notched, width: 300).maxY <= 950, "clear of the notch: \(notched)")
check(PillMath.usable(visible: visible, screen: screenRect, safeTop: 0) == visible, "no notch: the visible frame as it is")
let highTarget = CGRect(x: 700, y: 900, width: 120, height: 30)
let moved = PillMath.frame(visible: visible, width: 300, avoid: highTarget)
check(moved.maxY <= highTarget.minY && !moved.intersects(highTarget), "moves under a target near the top: \(moved)")
check(PillMath.frame(visible: visible, width: 300, avoid: CGRect(x: 700, y: 300, width: 50, height: 20)) == pill, "stays put when the target is elsewhere")
let tall = CGRect(x: 100, y: 90, width: 1300, height: 850)
check(PillMath.frame(visible: visible, width: 300, avoid: tall) == pill, "nowhere better to go: it stays under the menu bar")
check(PillMath.width(text: 2000, stop: true, screenWidth: 1512) == PillMath.maxWidth, "never wider than \(PillMath.maxWidth)")
check(PillMath.width(text: 2000, stop: true, screenWidth: 500) == 472, "nor closer than 14 pt to a small screen's edges")
let fitted = PillMath.width(text: 200, stop: true, screenWidth: 1512)
check(abs(PillMath.textRoom(width: fitted, stop: true) - 200) < 1, "the words fit the width they asked for: \(fitted)")
check(PillMath.width(text: 200, stop: true, screenWidth: 1512) - PillMath.width(text: 200, stop: false, screenWidth: 1512) == PillMath.stop + PillMath.buttonGap, "Stop adds its own room")
// Left to right: the mark, the words, Stop, the close button; none of them touch.
let slot = PillMath.slotCenter(pill)
check(PillMath.mark == 32 && slot.x - PillMath.mark / 2 == pill.minX + 7 && slot.y == pill.midY, "the pearl (32 pt) sits 7 pt in from the left, on the middle line")
check(pill.maxY - (slot.y + PillMath.mark / 2) == 7 && (slot.y - PillMath.mark / 2) - pill.minY == 7, "with the same 7 pt of glass above and below: snug in the island's round end")
check(PillMath.textX(pill) == slot.x + PillMath.mark / 2 + 14, "the words start 14 pt after the pearl")
let closeR = PillMath.closeRect(pill), stopR = PillMath.stopRect(pill)
check(closeR.maxX == pill.maxX - 12 && closeR.midY == pill.midY && closeR.width == 24, "the close button: a 24 pt circle at the right end")
check(stopR.maxX < closeR.minX && stopR.midY == pill.midY && stopR.minX > PillMath.textX(pill), "Stop sits just left of it")
// With no words it is just the pearl and the close button, never an empty bar.
let bare = PillMath.width(text: 0, stop: false, screenWidth: 1512)
check(bare == 7 + 32 + 14 + 24 + 12, "no words: the pearl and the close button: \(bare)")
check(PillMath.width(text: 0, stop: true, screenWidth: 1512) == bare + PillMath.stop + PillMath.buttonGap, "no words while working: the mark, Stop and close")

// The card it grows into when Echo needs an OK.
do {
  let one = PillMath.card(questionLines: 1, detailLines: 0, cancelLabel: 44, actionLabel: 30, screenWidth: 1512)
  let full = PillMath.card(questionLines: 2, detailLines: 2, cancelLabel: 44, actionLabel: 30, screenWidth: 1512)
  check(one.size.width == 430 && full.size.width == 430, "430 pt wide")
  check(PillMath.card(questionLines: 1, detailLines: 0, cancelLabel: 44, actionLabel: 30, screenWidth: 400).size.width == 372, "narrower on a small screen")
  check(one.size.height > PillMath.height && full.size.height == one.size.height + 3 * PillMath.cardLine + PillMath.cardDetailGap, "it grows by a line at a time: \(one.size.height) → \(full.size.height)")
  let bounds = CGRect(origin: .zero, size: full.size)
  for (name, r) in [("question", full.question), ("detail", full.detail), ("cancel", full.cancel), ("action", full.action)] {
    check(bounds.insetBy(dx: 11, dy: 11).contains(r), "\(name) is inside the card with room around it: \(r)")
  }
  check(full.question.minY >= full.detail.maxY && full.detail.minY >= full.action.maxY + PillMath.cardButtonsGap, "the question, the detail under it, the buttons under that")
  check(full.action.maxX == 430 - PillMath.cardPadX && full.cancel.maxX == full.action.minX - PillMath.buttonGap, "Cancel then the action, at the bottom right")
  check(full.action.width == 30 + 2 * PillMath.buttonPad && full.action.height == PillMath.buttonHeight, "a button is its label and its padding")
  // The first line of the question sits where the bar's one line does, so nothing jumps as it grows.
  let top = CGRect(x: 0, y: 0, width: full.size.width, height: full.size.height)
  check(abs((full.question.maxY - PillMath.cardLine / 2) - PillMath.slotCenter(top).y) < 0.01, "the question's first line is level with the mark")
  check(full.question.minX == PillMath.textX(top) && full.question.width == PillMath.cardTextWidth(screenWidth: 1512), "and starts where the bar's words do")
  check(one.detail.height == 0, "no detail: no room kept for it")
  check(PillMath.cardMaxHeight >= full.size.height && PillMath.cardMaxHeight < 220, "the tallest card: \(PillMath.cardMaxHeight)")
}

// What the bar says while Echo works on the Mac.
check(PillMath.app(fromStatus: "Driving: Excel") == "Excel" && PillMath.app(fromStatus: "Listening…") == "", "the app comes from the page's status")
check(PillMath.working(app: "Excel", step: "step 2 of 4", what: "Typing in A1") == ("Excel · step 2 of 4", " · typing in A1"), "the app and the step in white, what she is doing in grey")
check(PillMath.working(app: "", step: "", what: "Clicking “Send”") == ("Clicking “Send”", ""), "only what she is doing: that is the line")
check(PillMath.working(app: "Excel", step: "", what: "") == ("Excel", ""), "only the app")

// The pearl: which mood it shows, what each mood looks like, and how it moves.
do {
  func mood(_ voice: String = "idle", working: Bool = false, asking: Bool = false, moment: String? = nil, idle: Double = 0) -> String {
    PearlMath.mood(voice: voice, working: working, asking: asking, moment: moment, idleFor: idle)
  }
  check(mood() == "idle" && mood("listening") == "listening" && mood("thinking") == "thinking" && mood("speaking") == "speaking", "it follows Echo's voice")
  check(mood(working: true) == "thinking" && mood("speaking", working: true) == "speaking", "working on the Mac: it thinks, unless she is talking")
  check(mood("speaking", asking: true) == "needs" && mood(asking: true, idle: 999) == "needs", "a card waiting for your OK wins over her voice")
  check(mood(working: true, idle: 999) == "thinking" && mood(working: true, moment: "happy") == "happy" && mood(working: true, moment: nil) == "thinking", "a working step keeps the thinking pearl: it never dozes off mid-step, and is back to thinking after a step's pleased blink")
  check(mood(working: true, asking: true) == "needs", "its light asking for your OK, or still searching, shows over the thinking (the puzzled brow)")
  check(mood("listening", asking: true, moment: "surprised") == "surprised" && mood(moment: "happy") == "happy" && mood("thinking", moment: "sorry") == "sorry", "a moment playing wins over everything")
  check(mood(moment: "nonsense") == "idle", "an unknown moment is nothing")
  check(mood(idle: 179) == "idle" && mood(idle: 180) == "sleepy" && mood("listening", idle: 999) == "listening", "asleep after three quiet minutes, never while something is going on")
  check(PearlMath.lasts("surprised") == 1.6 && PearlMath.lasts("happy") == 2.6 && PearlMath.lasts("sorry") == 3 && PearlMath.lasts("idle") == 0, "moments end by themselves")
  check(PearlMath.moods.count == 9, "nine moods")

  // What each mood looks like (y up: looking up is above zero).
  let idle = PearlMath.pose("idle", glance: CGPoint(x: 0.3, y: -0.1))
  check(idle.open == 1 && idle.happy == 0 && idle.look == CGPoint(x: 0.3, y: -0.1), "idle: open eyes that wander")
  let quiet = PearlMath.pose("listening", level: 0), loud = PearlMath.pose("listening", level: 1)
  check(quiet.open > 1 && quiet.lean == 1 && loud.energy > quiet.energy && PearlMath.pose("listening", level: 9).energy == loud.energy, "listening: wide eyes, leaning in, brighter with your voice (never past full)")
  check(PearlMath.pose("thinking").look.x > 0 && PearlMath.pose("thinking").look.y > 0, "thinking: it looks up and to the side")
  check(PearlMath.pose("speaking", level: 1).energy > PearlMath.pose("speaking", level: 0).energy && PearlMath.pose("speaking").happy > 0, "speaking: the rim pulses with each word")
  check(PearlMath.pose("happy").happy == 1 && PearlMath.pose("happy").energy == 1, "happy: smiling eyes, all lit")
  check(PearlMath.pose("surprised", age: 0.2).open == 1.5 && PearlMath.pose("surprised", age: 1).open == 1.2, "surprised: very wide, then all ears")
  check(PearlMath.pose("needs").tilt > 0 && PearlMath.pose("needs").brow == 1, "needs your OK: a tilt and a raised brow")
  check(PearlMath.pose("sorry").look.y < 0 && PearlMath.pose("sorry").dim > 0.5 && PearlMath.pose("sorry").open < 1, "sorry: eyes down, the light dims")
  check(PearlMath.pose("sleepy").open < 0.1 && PearlMath.pose("sleepy").dim > PearlMath.pose("sorry").dim, "asleep: eyes shut, the light barely on")
  // The mouse wins the eyes in the calm moods; something it is showing wins in all but sleep.
  let mouse = CGPoint(x: -1, y: 0.5), thing = CGPoint(x: 0.2, y: -1)
  check(["idle", "listening", "speaking", "needs"].allSatisfy { PearlMath.pose($0, pointer: mouse).look == mouse }, "the eyes follow the mouse in the calm moods")
  check(["thinking", "sorry", "sleepy", "happy"].allSatisfy { PearlMath.pose($0, pointer: mouse).look != mouse }, "but not while it thinks, is sorry or sleeps")
  check(PearlMath.pose("thinking", pointer: mouse, target: thing).look == thing && PearlMath.pose("sleepy", target: thing).look != thing, "it looks at what it is showing, unless asleep")
  // Reduced motion: nothing moves with time or the voice, but the moods still differ.
  for m in PearlMath.moods {
    check(PearlMath.pose(m, level: 0.9, t: 1.3, glance: mouse, reduced: true) == PearlMath.pose(m, level: 0.1, t: 7.7, reduced: true), "reduced motion, \(m): still")
  }
  check(PearlMath.pose("listening", reduced: true) != PearlMath.pose("thinking", reduced: true), "but the moods still differ")

  // Easing is the same at any frame rate.
  var a: CGFloat = 0, b: CGFloat = 0
  for _ in 0..<60 { a = PearlMath.ease(a, toward: 1, rate: 9, dt: 1.0 / 60) }
  for _ in 0..<120 { b = PearlMath.ease(b, toward: 1, rate: 9, dt: 1.0 / 120) }
  check(abs(a - b) < 1e-6 && a > 0.99 && a < 1, "easing gets there the same at 60 and 120 Hz: \(a) \(b)")
  check((0...300).allSatisfy { let v = PearlMath.babble(Double($0) / 30); return v >= 0 && v <= 1 }, "the made-up voice stays 0…1")

  // Eyes: where they look, when they blink.
  let from = CGPoint(x: 100, y: 100)
  check(PearlMath.gaze(from: from, to: CGPoint(x: 100, y: 500), reach: 300) == nil, "a mouse more than 300 pt away is not followed")
  let near = PearlMath.gaze(from: from, to: CGPoint(x: 400, y: 100), reach: 300)!, close = PearlMath.gaze(from: from, to: CGPoint(x: 100, y: 70), reach: 300)!
  check(abs(near.x - 1) < 1e-9 && near.y == 0 && close.x == 0 && abs(close.y + 0.5) < 1e-9, "it looks all the way towards a far mouse, part of the way to a near one: \(near) \(close)")
  check(PearlMath.gaze(from: from, to: from) == .zero, "on top of it: straight ahead")
  check(PearlMath.nextBlink(after: 10, roll: 0) == 12.2 && PearlMath.nextBlink(after: 10, roll: 1) == 15.7, "a blink every 2.2 to 5.7 s")
  check(PearlMath.nextBlink(after: 10, roll: 0, reduced: true) >= 15 && PearlMath.blinkRate(reduced: true) < PearlMath.blinkRate(reduced: false), "reduced motion: fewer, slower blinks")
  let g = PearlMath.glance(1, 0)
  check(abs(g.x - 0.55) < 1e-9 && abs(g.y + 0.3) < 1e-9 && PearlMath.nextGlance(after: 4, roll: 0.5) == 7, "glances: mostly sideways, every 1.5 to 4.5 s")
  let open = PearlMath.eyes(radius: 16, open: 1, blink: 0, happy: 0, look: .zero)
  check(open.shape == .open && open.left.x == -open.right.x && open.left.y == open.right.y && open.height > open.width, "two eyes, side by side, taller than wide")
  check(PearlMath.eyes(radius: 16, open: 1, blink: 1, happy: 0, look: .zero).shape == .shut && PearlMath.eyes(radius: 16, open: 0.04, blink: 0, happy: 0, look: .zero).shape == .shut, "shut for a blink, and asleep")
  check(PearlMath.eyes(radius: 16, open: 1, blink: 0, happy: 1, look: .zero).shape == .smile, "happy: little arches")
  let right = PearlMath.eyes(radius: 16, open: 1, blink: 0, happy: 0, look: CGPoint(x: 1, y: 1)), wild = PearlMath.eyes(radius: 16, open: 1, blink: 0, happy: 0, look: CGPoint(x: 50, y: -50))
  check(right.left.x > open.left.x && right.left.y > open.left.y, "the eyes move towards where they look (up is up)")
  check(hypot(wild.right.x, wild.right.y) + wild.height / 2 < 16 * 0.85, "and never leave the pearl, whatever they are told")
  check(PearlMath.eyes(radius: 13, open: 1, blink: 0, happy: 0, look: .zero).width / 13 > PearlMath.eyes(radius: 60, open: 1, blink: 0, happy: 0, look: .zero).width / 60, "bolder eyes on a small pearl")
  check(!PearlMath.detailed(diameter: 26) && PearlMath.detailed(diameter: 32) && PearlMath.bold(diameter: 40) && !PearlMath.bold(diameter: 110), "no brow or z under 32 pt")

  // The rim of light.
  for m in ["listening", "speaking", "happy"] { check(PearlMath.rim(m, energy: 0.6, t: 3).span == 2 * .pi, "\(m): a full ring") }
  let comet = PearlMath.rim("thinking", energy: 0.8, t: 1), later = PearlMath.rim("thinking", energy: 0.8, t: 1.1)
  check(comet.comet && abs(comet.span - 1.9) < 1e-9 && later.from < comet.from, "thinking: a comet, circling clockwise")
  check(PearlMath.rim("thinking", energy: 0.8, t: 1, reduced: true).from == PearlMath.rim("thinking", energy: 0.8, t: 9, reduced: true).from, "reduced motion: the comet rests")
  let rest = PearlMath.rim("idle", energy: 0.3, t: 0), bright = PearlMath.rim("idle", energy: 0.9, t: 0)
  check(!rest.comet && rest.span < .pi && bright.span > rest.span, "at rest: a crescent, wider with energy")
  check(rest.from + rest.span / 2 < 0 && rest.from + rest.span / 2 > -.pi / 2, "at the lower right")
  check(PearlMath.rimWidth(radius: 16, energy: 0.3, level: 0, speaking: false) >= 1.5 && PearlMath.rimWidth(radius: 16, energy: 1, level: 1, speaking: true) > PearlMath.rimWidth(radius: 16, energy: 1, level: 0, speaking: true), "never a hairline on a small pearl; thicker with each word")
  check(PearlMath.rimAlpha(energy: 0.08, dim: 0.75) < PearlMath.rimAlpha(energy: 0.3, dim: 0) && PearlMath.rimAlpha(energy: 2, dim: 0) == 1, "dimmer asleep")
  check(PearlMath.rimTurn("thinking", t: 1) < PearlMath.rimTurn("idle", t: 1) && PearlMath.rimTurn("idle", t: 5, reduced: true) == 0, "the colours turn, faster while it thinks; not with reduced motion")

  // Echo rings and sparkles.
  check(PearlMath.ringDue(mood: "listening", level: 0.7, last: nil) && !PearlMath.ringDue(mood: "listening", level: 0.3, last: nil) && !PearlMath.ringDue(mood: "speaking", level: 0.9, last: nil), "a ring when your voice rises while it listens")
  check(!PearlMath.ringDue(mood: "listening", level: 0.9, last: PearlMath.Ring(r: 1.2, a: 0.6)) && PearlMath.ringDue(mood: "listening", level: 0.9, last: PearlMath.Ring(r: 1.4, a: 0.4)), "one at a time: the last must be clear first")
  var ring: PearlMath.Ring? = PearlMath.Ring(), frames = 0
  while let r = ring, frames < 600 { ring = PearlMath.step(r, dt: 1.0 / 60); frames += 1; if let n = ring, n.r <= r.r { frames = 9999 } }
  check(frames > 50 && frames < 80, "a ring spreads and is gone in about a second: \(frames) frames")
  var n = 0.0
  let burst = PearlMath.sparks { n += 0.07; return n.truncatingRemainder(dividingBy: 1) }
  check(burst.count == 12 && burst.allSatisfy { $0.size >= 0.05 && $0.size <= 0.11 && $0.v >= 0.9 }, "twelve sparkles")
  var spark: PearlMath.Spark? = burst[0], far: CGFloat = 0
  frames = 0
  while let sp = spark, frames < 600 { far = sp.r; spark = PearlMath.step(sp, dt: 1.0 / 60); frames += 1 }
  check(frames > 60 && frames < 75 && far > 1.3 && far < 2.4, "they fly out, slow down and fade in about a second, inside its square: \(frames) \(far)")
  check(far * 16 < PearlMath.reach(diameter: 32) && 32 * PearlMath.fingerReach / 2 < PearlMath.reach(diameter: 32), "the square it draws in has room for them and for its finger")

  // Its body: hops, and jelly.
  check(PearlMath.kick("happy").lift > 0 && PearlMath.kick("happy").squash < 0 && PearlMath.kick("surprised").lift > 0 && PearlMath.kick("idle") == (0, 0), "a hop for happy and surprised")
  let flat = PearlMath.scale(squash: 0.2), tall = PearlMath.scale(squash: -0.2)
  check(flat.x > 1 && flat.y < 1 && tall.x < 1 && tall.y > 1 && PearlMath.scale(squash: 0) == (1, 1), "squashed is flatter and wider, stretched is taller and thinner")
  var sq: CGFloat = 0.2, sv: CGFloat = 0, crossed = 0, peak: CGFloat = 0, lastSign = true
  for _ in 0..<120 {
    (sq, sv) = PearlMath.jelly(sq, speed: sv, dt: 1.0 / 60)
    if (sq > 0) != lastSign { crossed += 1; lastSign = sq > 0 }
    peak = max(peak, abs(sq))
  }
  check(crossed >= 2 && abs(sq) < 0.002 && peak <= 0.2, "a landing wobbles (there and back) and settles within two seconds: \(crossed) \(sq)")
  var slow: CGFloat = 0.2, slowV: CGFloat = 4
  for _ in 0..<40 { (slow, slowV) = PearlMath.jelly(slow, speed: slowV, dt: 0.05) }
  check(slow.isFinite && abs(slow) < 0.01, "and stays stable on slow frames: \(slow)")
}

// Blank captions are no text: spaces or newlines never hold the island open as an empty bar.
check(PillMath.clean("  \n\t ") == "" && PillMath.clean(nil) == "", "blank text is none")
check(PillMath.clean("  hi \n there ") == "hi there", "text on one line, trimmed")

// The edge glow: a thin line on the outermost pixels. The status chip: one state at a time.
check(EdgeMath.line >= 1 && EdgeMath.line <= 2, "a 1–2 pt line")
let full = CGRect(x: 0, y: 0, width: 1512, height: 982)
let outer = EdgeMath.lineRect(full).insetBy(dx: -EdgeMath.line / 2, dy: -EdgeMath.line / 2)
check(full.contains(outer) && outer.minX - full.minX <= 1.5 && outer.minX > full.minX, "all of it on screen, just inside the edge")
// Rounded like a MacBook's display, square on an external monitor, and clear of the notch.
check(EdgeMath.corner(builtIn: true, notched: true) >= 10 && EdgeMath.corner(builtIn: true, notched: true) <= 12, "MacBook corners: 10–12 pt")
check(EdgeMath.corner(builtIn: false, notched: false) == 0, "external monitor: square")
let notch = EdgeMath.notch(size: full.size, left: CGRect(x: 0, y: 950, width: 663.5, height: 32), right: CGRect(x: 848.5, y: 950, width: 663.5, height: 32))
check(notch == CGRect(x: 663.5, y: 950, width: 185, height: 32), "the notch, from the areas either side: \(String(describing: notch))")
check(EdgeMath.notch(size: full.size, left: nil, right: nil) == nil, "no notch")
let rounded = EdgeMath.path(full, corner: 11, notch: notch)
let lr = EdgeMath.lineRect(full)
check(!rounded.contains(CGPoint(x: lr.minX + 0.3, y: lr.minY + 0.3)) && rounded.boundingBox.insetBy(dx: -0.01, dy: -0.01).contains(lr), "the corners are rounded")
let hitsNotch = (0..<20).contains { i in
  let x = notch!.minX + notch!.width * CGFloat(i) / 19
  return rounded.copy(strokingWithWidth: EdgeMath.line + 2, lineCap: .round, lineJoin: .round, miterLimit: 1).contains(CGPoint(x: x, y: lr.maxY))
}
check(!hitsNotch, "the top line stops short of the notch")
check(rounded.copy(strokingWithWidth: EdgeMath.line, lineCap: .round, lineJoin: .round, miterLimit: 1).contains(CGPoint(x: 300, y: lr.maxY)), "and runs along the top either side of it")
let square = EdgeMath.path(full, corner: 0)
check(square.boundingBox == lr, "square on an external monitor")
// The caption pill's life (CaptionLife): the page's word counts only while it keeps saying it.
do {
  var life = CaptionLife()
  check(!life.wants(now: 0, echoInFront: false, replying: false), "nothing said: no pill")
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: true, now: 100)
  check(life.wants(now: 100, echoInFront: false, replying: false), "something going on, Echo behind: the pill")
  check(!life.wants(now: 100, echoInFront: true, replying: false), "Echo's window in front: no pill")
  check(life.wants(now: 109, echoInFront: false, replying: false), "still fresh at 9 s")
  check(!life.wants(now: 110.1, echoInFront: false, replying: false), "the page went silent for 10 s: forgotten")
  check(life.lingers(now: 110.1) == 0, "an expired pill goes at once")
  check(abs((life.nextCheck(now: 104) ?? 0) - 6) < 0.001, "look again when it would expire")
  // Refreshed by the page's heartbeat, it stays (and a beat is not news).
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: false, now: 104)
  check(life.wants(now: 113, echoInFront: false, replying: false), "a heartbeat keeps it")
  // A drive shows even with Echo in front, and a stuck "driving" expires too.
  life.heard(enabled: true, driving: true, active: true, quiet: false, new: true, now: 200)
  check(life.wants(now: 201, echoInFront: true, replying: false), "driving: the pill even with Echo in front")
  check(life.drivingNow(205) && !life.drivingNow(211), "driving is forgotten with the page")
  check(!life.wants(now: 211, echoInFront: true, replying: false), "a dead page's drive doesn't pin the pill")
  life.heard(enabled: true, driving: true, active: true, quiet: false, new: false, now: 212)
  life.driveEnded()
  check(!life.wants(now: 212.5, echoInFront: true, replying: false), "the run ended here: driving is cleared whatever the page said")
  check(life.lingers(now: 212.5) == CaptionLife.linger, "an ordinary end lingers so the last line can be read")
  // Talk mode alone (quiet): it leaves after 6 s with nothing new, heartbeats or not.
  life.reset()
  life.heard(enabled: true, driving: false, active: true, quiet: true, new: true, now: 300)
  life.heard(enabled: true, driving: false, active: true, quiet: true, new: false, now: 304)
  check(life.wants(now: 305, echoInFront: false, replying: false), "talk mode: up while it's new")
  check(abs((life.nextCheck(now: 305) ?? 0) - 1) < 0.001, "look again when the quiet runs out")
  check(!life.wants(now: 306.1, echoInFront: false, replying: false), "talk mode no longer pins it: gone after 6 s")
  check(life.lingers(now: 306.1) == 0, "and it doesn't hang about after that")
  life.heard(enabled: true, driving: false, active: true, quiet: true, new: true, now: 320)
  check(life.wants(now: 321, echoInFront: false, replying: false), "something new brings it back")
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: false, now: 330)
  check(life.wants(now: 338, echoInFront: false, replying: false), "Echo talking or thinking is never cut short at 6 s")
  // The close button: gone until something new starts; refreshes and more of the same don't count.
  life.dismiss()
  check(!life.wants(now: 331, echoInFront: false, replying: true), "closed: gone, reply field or not")
  check(life.lingers(now: 331) == 0, "closed means now")
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: false, now: 334)
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: true, now: 335)
  check(!life.wants(now: 335, echoInFront: false, replying: false), "more of what you closed stays closed")
  life.heard(enabled: true, driving: false, active: false, quiet: false, new: true, now: 336)
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: true, now: 340)
  check(life.wants(now: 340, echoInFront: false, replying: false), "the next thing she does shows again")
  // In talk mode the page is "active" all along: the next thing after its quiet still shows.
  life.dismiss()
  life.heard(enabled: true, driving: false, active: true, quiet: true, new: true, now: 340.5)
  check(!life.wants(now: 340.5, echoInFront: false, replying: false), "closed, then only talk mode's quiet: still closed")
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: true, now: 340.8)
  check(life.wants(now: 340.8, echoInFront: false, replying: false), "you speak again in talk mode: it shows")
  // The setting off, and reset.
  life.heard(enabled: false, driving: true, active: true, quiet: false, new: true, now: 341)
  check(!life.wants(now: 341, echoInFront: false, replying: false), "switched off in Settings: never")
  life.heard(enabled: true, driving: true, active: true, quiet: false, new: true, now: 342)
  life.reset()
  check(life == CaptionLife() && !life.wants(now: 342, echoInFront: false, replying: false) && life.nextCheck(now: 342) == nil, "reset clears every state")
  // An open reply field keeps the pill while you type, even after the page has gone quiet.
  check(life.wants(now: 400, echoInFront: false, replying: true), "typing a reply keeps it")
}

// Closing the pill mid-drive must not hide the Yes / No that comes later, nor the next drive.
do {
  var life = CaptionLife()
  life.heard(enabled: true, driving: true, active: true, quiet: false, new: true, now: 10)
  life.dismiss()
  life.heard(enabled: true, driving: true, active: true, quiet: false, new: true, now: 12)
  check(!life.wants(now: 12, echoInFront: false, replying: false), "closed mid-drive: the next step of the same drive stays closed")
  life.heard(enabled: true, driving: true, active: true, quiet: false, confirming: true, new: true, now: 14)
  check(life.wants(now: 14, echoInFront: true, replying: false), "Echo asks for an OK: the card shows though the pill was closed")
  life.dismiss()
  life.heard(enabled: true, driving: true, active: true, quiet: false, confirming: true, new: false, now: 16)
  check(!life.wants(now: 16, echoInFront: false, replying: false), "you closed the card itself: the same question doesn't reopen it")
  life.heard(enabled: true, driving: true, active: true, quiet: false, confirming: false, new: true, now: 18)
  life.heard(enabled: true, driving: true, active: true, quiet: false, confirming: true, new: true, now: 20)
  check(life.wants(now: 20, echoInFront: false, replying: false), "but the next question does")
  // A drive that starts while Echo was already talking (the page was "on" all along).
  life.reset()
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: true, now: 30)
  life.dismiss()
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: true, now: 31)
  check(!life.wants(now: 31, echoInFront: false, replying: false), "closed while she talks: still closed")
  life.heard(enabled: true, driving: true, active: true, quiet: false, new: false, now: 32)
  check(!life.wants(now: 32, echoInFront: false, replying: false), "a heartbeat is never a start")
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: true, now: 33)
  life.heard(enabled: true, driving: true, active: true, quiet: false, new: true, now: 34)
  check(life.wants(now: 34, echoInFront: true, replying: false), "a drive starting brings a closed pill back")
}

// The app's own driver keeps the pill and Stop through a page that reloads or goes silent.
do {
  var life = CaptionLife()
  life.heard(enabled: true, driving: true, active: true, quiet: false, new: true, now: 10)
  life.driveBegan()
  life.reset() // the page reloaded
  check(life.drivingNow(10.1) && life.wants(now: 10.1, echoInFront: true, replying: false), "the page reloaded mid-drive: the pill and Stop stay")
  check(life.drivingNow(500) && life.wants(now: 500, echoInFront: true, replying: false), "and the page's 10 s expiry doesn't take them")
  life.dismiss()
  life.driveBegan()
  check(!life.wants(now: 501, echoInFront: false, replying: false), "the next step of a drive you closed stays closed")
  life.driveIdle()
  check(!life.drivingNow(502), "quiet between steps: the page's word stands again")
  life.driveBegan()
  check(life.wants(now: 503, echoInFront: true, replying: false), "the driver starting again shows it")
  life.heard(enabled: true, driving: true, active: true, quiet: false, new: true, now: 504)
  life.driveEnded()
  check(!life.drivingNow(504.5) && !life.wants(now: 504.5, echoInFront: true, replying: false), "the run ended: both the app's and the page's driving are cleared")
  life.reset()
  check(life == CaptionLife(), "with no drive on, reset still clears every state")
}

// Waiting for an exact label (WaitMath, with LabelMatch.fits as the lesson's test): near misses keep waiting.
do {
  let fits = { (label: String?) in label.map { LabelMatch.fits($0, "Rectangle 1") } ?? false }
  check(!WaitMath.done(fits: fits("Rectangle"), mode: "present", wasThere: false, changed: false), "the Rectangle tool is on screen: the wait for the Rectangle 1 layer goes on")
  check(!WaitMath.done(fits: fits(nil), mode: "present", wasThere: false, changed: false), "nothing found: it goes on")
  check(WaitMath.done(fits: fits("Rectangle 1"), mode: "present", wasThere: false, changed: false), "the layer shows up: done")
  check(!WaitMath.done(fits: true, mode: "appear", wasThere: true, changed: false), "appear: there from the start and nothing changed is not an appearance")
  check(WaitMath.done(fits: true, mode: "appear", wasThere: false, changed: false) && WaitMath.done(fits: true, mode: "appear", wasThere: true, changed: true), "appear: new, or the screen changed")
  check(!WaitMath.done(fits: false, mode: "appear", wasThere: false, changed: true), "appear: a changed screen alone is not a find")
}

// Pointing into an open menu (MenuMath.inOpenMenu): window bounds are measured from the top.
do {
  let menu = (layer: MenuMath.layer, bounds: CGRect(x: 100, y: 24, width: 220, height: 300)) // under the menu bar
  let window = (layer: 0, bounds: CGRect(x: 0, y: 24, width: 1512, height: 958))
  let item = CGRect(x: 110, y: 982 - 24 - 60, width: 200, height: 22) // AppKit: 38…60 pt below the bar
  check(MenuMath.inOpenMenu(item, windows: [window, menu], primaryHeight: 982), "an item inside the open menu")
  check(!MenuMath.inOpenMenu(item, windows: [window], primaryHeight: 982), "no menu open: an ordinary target")
  check(!MenuMath.inOpenMenu(CGRect(x: 600, y: 500, width: 80, height: 24), windows: [window, menu], primaryHeight: 982), "a button beside an open menu")
  check(!MenuMath.inOpenMenu(item, windows: [(layer: 25, bounds: menu.bounds), (layer: 102, bounds: menu.bounds)], primaryHeight: 982), "Echo's own overlays there are not a menu")
}

// The close button is always there, inside the right end, clear of the mark and of Stop.
do {
  let r = CGRect(x: 400, y: 40, width: 300, height: PillMath.height)
  let c = PillMath.closeRect(r)
  check(c.width == PillMath.close && !c.contains(PillMath.slotCenter(r)) && !c.intersects(PillMath.stopRect(r)), "the close button: \(c)")
  check(r.contains(c), "inside the island")
}

// Which process is Echo's (ProcessMath): only this folder's supervisor.js or server.js, run by node.
do {
  let dir = "/Users/sam/Applications/Echo"
  check(ProcessMath.isOurs(command: "/opt/homebrew/bin/node supervisor.js", cwd: dir, echoDir: dir), "the launcher's supervisor")
  check(ProcessMath.isOurs(command: "/Users/sam/.echo/node/bin/node --env-file-if-exists=.env server.js", cwd: dir + "/", echoDir: dir), "the supervisor's server")
  check(ProcessMath.isOurs(command: "node \(dir)/server.js", cwd: "/tmp", echoDir: dir + "/"), "started by full path from elsewhere")
  check(ProcessMath.isOurs(command: "node --watch ./server.js", cwd: dir, echoDir: dir), "npm run dev")
  check(!ProcessMath.isOurs(command: "node server.js", cwd: "/Users/sam/other-project", echoDir: dir), "another project's server.js is not ours")
  check(!ProcessMath.isOurs(command: "node server.js", cwd: nil, echoDir: dir), "unknown folder: not ours")
  check(!ProcessMath.isOurs(command: "node /Users/sam/Applications/Echo-old/server.js", cwd: dir, echoDir: dir), "another Echo folder is not ours")
  check(!ProcessMath.isOurs(command: "python3 -m http.server 4777", cwd: dir, echoDir: dir), "not node: not ours")
  check(!ProcessMath.isOurs(command: "node scripts/eval.js server.js", cwd: dir, echoDir: dir), "only the script itself counts, not its arguments")
  check(!ProcessMath.isOurs(command: "/bin/bash scripts/launcher.sh supervisor.js", cwd: dir, echoDir: dir), "a shell is not ours")
  check(!ProcessMath.isOurs(command: "", cwd: dir, echoDir: dir) && !ProcessMath.isOurs(command: "node server.js", cwd: "", echoDir: ""), "nothing known: not ours")
  let server: (pid: Int32, command: String, cwd: String?) = (812, "node --env-file-if-exists=.env server.js", dir)
  let sup: (pid: Int32, command: String, cwd: String?) = (800, "node supervisor.js", dir)
  let shell: (pid: Int32, command: String, cwd: String?) = (700, "-zsh", dir)
  check(ProcessMath.target(holder: server, parent: sup, echoDir: dir) == 800, "under the supervisor: stop the supervisor, or it restarts the server")
  check(ProcessMath.target(holder: server, parent: shell, echoDir: dir) == 812, "started from Terminal: the server itself, never the shell")
  check(ProcessMath.target(holder: server, parent: nil, echoDir: dir) == 812, "no parent known: the server")
  check(ProcessMath.target(holder: (900, "ruby app.rb", dir), parent: sup, echoDir: dir) == nil, "someone else on the port: nobody is signalled")
  check(ProcessMath.target(holder: (1, "node server.js", dir), parent: nil, echoDir: dir) == nil, "never process 1")
  // Spaces in the node path or the Echo folder, and options with a value of their own.
  let spaced = "/Users/sam/My Apps/Echo Two"
  check(ProcessMath.script(command: "\(spaced)/node/bin/node supervisor.js", cwd: spaced, echoDir: spaced) == "supervisor.js", "node inside a folder with spaces")
  check(ProcessMath.script(command: "/opt/homebrew/bin/node \(spaced)/server.js", cwd: "/", echoDir: spaced) == "server.js", "the Echo folder has spaces, started by full path")
  check(ProcessMath.isOurs(command: "\(spaced)/node/bin/node --env-file-if-exists=.env server.js", cwd: spaced, echoDir: spaced), "spaces and an option")
  check(ProcessMath.isOurs(command: "node --max-http-header-size 16384 server.js", cwd: dir, echoDir: dir), "an option with a separate value")
  check(ProcessMath.isOurs(command: "node --import tsx --watch ./server.js --port 4777", cwd: dir, echoDir: dir), "options before, the script's own arguments after")
  check(ProcessMath.isOurs(command: "/Users/sam/tools -old/node server.js", cwd: dir, echoDir: dir), "a node path with \" -\" in it")
  check(!ProcessMath.isOurs(command: "node \(spaced)-old/server.js", cwd: spaced, echoDir: spaced), "a sibling folder whose name starts the same is not ours")
  check(!ProcessMath.isOurs(command: "node server.js.bak", cwd: dir, echoDir: dir) && !ProcessMath.isOurs(command: "node myserver.js", cwd: dir, echoDir: dir), "only the whole name")
  check(!ProcessMath.isOurs(command: "node --watch scripts/eval.js server.js", cwd: dir, echoDir: dir), "an option, then another script: ours is only its argument")
  check(!ProcessMath.isOurs(command: "/usr/bin/python3 tools/run.py \(dir)/server.js", cwd: dir, echoDir: dir), "another program given our path is not ours")
  check(!ProcessMath.isOurs(command: "node server.js", cwd: spaced + "/sub", echoDir: spaced), "a subfolder's server.js is not ours")
  // What the server's answer to "stop if idle" means.
  check(ProcessMath.answer(status: 200, ok: true, working: 0) == .stopping, "it is stopping")
  check(ProcessMath.answer(status: 200, ok: false, working: 2) == .working(2), "two tasks running: ask first")
  check(ProcessMath.answer(status: 403, ok: nil, working: nil) == .refused, "403: it is there but refused, which is not the same as nothing running")
  check(ProcessMath.answer(status: 0, ok: nil, working: nil) == .unreachable && ProcessMath.answer(status: 404, ok: nil, working: nil) == .unreachable, "no answer, or an older Echo without the request")
  check(ProcessMath.refusedQuestion.contains("didn't accept") && ProcessMath.refusedDetail.contains("can't tell whether tasks are still running"), "the refusal is said plainly")
  check(ProcessMath.quitQuestion(tasks: 1) == "Echo is still working on 1 task." && ProcessMath.quitQuestion(tasks: 3) == "Echo is still working on 3 tasks.", "the quit question")
}

check(ChipMath.state(looking: false, driving: false, doing: nil) == nil, "nothing going on: no chip")
check(ChipMath.state(looking: true, driving: false, doing: nil) == "Looking", "looking")
check(ChipMath.state(looking: true, driving: true, doing: nil) == "Looking", "looking while driving: one state, not two chips")
check(ChipMath.state(looking: false, driving: true, doing: nil) == "Driving", "driving")
check(ChipMath.state(looking: true, driving: true, doing: "click") == "Clicking", "what Echo is doing comes first")
check(ChipMath.state(looking: false, driving: true, doing: "type_text") == "Typing", "typing")
check(ChipMath.state(looking: false, driving: false, doing: "click") == nil, "no action without a drive")
let chipVisible = CGRect(x: 0, y: 80, width: 1512, height: 870)
let chip = ChipMath.frame(visible: chipVisible)
check(chip.maxX <= chipVisible.maxX && chip.maxY <= chipVisible.maxY && chip.minX > chipVisible.midX, "the chip sits in the top-right corner, under the menu bar: \(chip)")
check(ChipMath.panelSize.height <= 40 && ChipMath.width(textWidth: 1000) == ChipMath.maxWidth, "and stays small")

// The pearl out pointing: sizes, looks, the ways it points, and motion that never jumps.
check(CompanionMath.diameter("small") == 26 && CompanionMath.diameter("medium") == 32 && CompanionMath.diameter("large") == 40, "three sizes")
check(CompanionMath.diameter(nil) == 32 && CompanionMath.diameter(nil) == PillMath.mark && CompanionMath.size("huge") == "medium", "medium (32 pt, as in the island) by default")
check(CompanionMath.look("moon") == "moon" && CompanionMath.look("glass") == "glass" && CompanionMath.look("auto") == "auto", "the look setting: auto, glass or moon")
check(CompanionMath.look("sunset") == "auto" && CompanionMath.look("aurora") == "auto" && CompanionMath.look(nil) == "auto", "any older setting (and none) is auto: nothing maps to a look that is gone")

// The look it wears: the setting when it names one; on auto, the system's dark or light
// appearance decides, and nothing else: the screen is never read for it.
check(CompanionMath.wear("glass", systemDark: true) == "glass" && CompanionMath.wear("moon", systemDark: false) == "moon", "glass and moon are worn whatever the appearance")
check(CompanionMath.wear("auto", systemDark: true) == "moon" && CompanionMath.wear("auto", systemDark: false) == "glass", "auto: Moon in dark mode, Glass in light")
check(CompanionMath.wear("sunset", systemDark: true) == "moon" && CompanionMath.wear(nil, systemDark: false) == "glass", "an old setting behaves as auto")
check(PearlMath.way(nil) == "firefly" && PearlMath.way("reach") == "reach" && PearlMath.way("perch") == "firefly", "it points with its light unless told to reach")
let screenBounds = CGRect(x: 0, y: 0, width: 1512, height: 982)
let button = CGRect(x: 700, y: 400, width: 80, height: 24)

// The firefly: its light leaves the pearl's rim, flies in a gentle curve, and circles the thing.
do {
  let slot = CGPoint(x: 500, y: 950)
  let rim = PearlMath.rim(of: slot, radius: 16, toward: CGPoint(x: button.midX, y: button.midY))
  check(abs(hypot(rim.x - slot.x, rim.y - slot.y) - 16) < 1e-9 && rim.x > slot.x && rim.y < slot.y, "the light leaves from the rim, on the side facing where it is going: \(rim)")
  check(PearlMath.rim(of: slot, radius: 16, toward: slot) == CGPoint(x: 516, y: 950), "nowhere to go: the right of the rim")
  check(PearlMath.lightRadius * 2 >= 6 && PearlMath.lightRadius * 2 <= 7, "a small light: 6 to 7 pt across")

  // The orbit: round the target's edge, 7 pt outside it, clockwise at an even pace.
  let box = button.insetBy(dx: -7, dy: -7)
  var onEdge = true, steps: [CGFloat] = [], last = PearlMath.orbit(button, laps: 0), turned: CGFloat = 0
  for i in 1...400 {
    let p = PearlMath.orbit(button, laps: Double(i) / 400)
    if box.insetBy(dx: -0.01, dy: -0.01).contains(p) == false || box.insetBy(dx: 0.01, dy: 0.01).contains(p) && !box.insetBy(dx: 5, dy: 5).contains(p) == false { onEdge = false }
    if button.insetBy(dx: -1.5, dy: -1.5).contains(p) { onEdge = false }
    steps.append(hypot(p.x - last.x, p.y - last.y))
    turned += (last.x - button.midX) * (p.y - button.midY) - (last.y - button.midY) * (p.x - button.midX)
    last = p
  }
  check(onEdge, "it circles outside the thing, never on it")
  check(steps.max()! - steps.min()! < 0.05, "at an even pace: \(steps.min()!)…\(steps.max()!)")
  check(turned < 0, "clockwise")
  let start = PearlMath.orbit(button, laps: 0)
  check(start.y == box.maxY && start.x > button.midX && start.x < box.maxX, "it starts (and rests) at the top-right corner: \(start)")
  check(PearlMath.orbit(button, laps: 1) == start && PearlMath.orbit(button, laps: 2.25) == PearlMath.orbit(button, laps: 0.25), "round and round")
  let dot = PearlMath.orbit(CGRect(x: 10, y: 10, width: 0, height: 0), laps: 0.3)
  check(abs(hypot(dot.x - 10, dot.y - 10) - 7) < 1e-6, "a bare point: a small circle round it")
  check(PearlMath.lap(button) >= 1.1 && PearlMath.lap(CGRect(x: 0, y: 0, width: 1400, height: 900)) == 2.6, "a button in about a second, a whole window in under three")

  // The flight: a gentle curve, soft at both ends, never a leap.
  let out = PearlMath.Flight(from: rim, to: start, at: 10)
  check(out.duration >= 0.3 && out.duration <= 0.62 && out.position(at: 9) == rim && out.position(at: 10) == rim && out.position(at: 11) == start && out.done(at: out.lands), "it leaves from the rim and lands on the edge in 300–620 ms: \(out.duration)")
  var hops: [CGFloat] = [], lastP = rim, off: CGFloat = 0
  let dx = start.x - rim.x, dy = start.y - rim.y, len = hypot(dx, dy)
  for i in 1...Int(out.duration * 120) {
    let p = out.position(at: 10 + Double(i) / 120)
    hops.append(hypot(p.x - lastP.x, p.y - lastP.y))
    off = max(off, abs((p.x - rim.x) * dy - (p.y - rim.y) * dx) / len)
    lastP = p
  }
  check(hops[0] < hops[hops.count / 2] && hops[hops.count - 1] < hops[hops.count / 2] && hops.max()! < 30, "slow away, fast in the middle, slow in, never a leap: \(hops[0]) \(hops.max()!)")
  check(off > len * 0.05 && off < len * 0.12, "a gentle curve, not a straight line: \(off) off a \(len) pt line")
  let across = PearlMath.Flight(from: CGPoint(x: 100, y: 500), to: CGPoint(x: 900, y: 500), at: 0), backAcross = PearlMath.Flight(from: CGPoint(x: 900, y: 500), to: CGPoint(x: 100, y: 500), at: 0)
  check(across.position(at: across.duration / 2).y > 500 && backAcross.position(at: backAcross.duration / 2).y > 500, "bowed upward whichever way it flies")
  var homing = PearlMath.Flight(from: start, to: rim, at: 20)
  let before = homing.position(at: 20.2)
  homing.to = CGPoint(x: rim.x - 10, y: rim.y + 4)
  check(hypot(homing.position(at: 20.2).x - before.x, homing.position(at: 20.2).y - before.y) < 11 && homing.position(at: 21) == homing.to, "coming home follows the island as it moves")
  let dive = PearlMath.Flight(from: start, to: CGPoint(x: button.midX, y: button.midY), at: 0, quick: true)
  let midDive = dive.position(at: dive.duration / 2)
  check(dive.duration < 0.15 && abs((midDive.x - start.x) * (dive.to.y - start.y) - (midDive.y - start.y) * (dive.to.x - start.x)) < 1e-6, "a click: a quick straight dive to the exact spot")

  // The trail, the burst, typing and scrolling.
  check(PearlMath.trail(age: 0).alpha > PearlMath.trail(age: 0.15).alpha && PearlMath.trail(age: 0.15).alpha > 0 && PearlMath.trail(age: PearlMath.trailLife).alpha == 0 && PearlMath.trail(age: 9).alpha == 0, "the trail fades to nothing in 300 ms")
  check(PearlMath.trail(age: 0).width < PearlMath.lightRadius * 2 && PearlMath.trail(age: 0.25).width < PearlMath.trail(age: 0).width && PearlMath.trail(age: 0.3).width > 0, "thinner than the light, and thinning")
  check(PearlMath.burst(elapsed: -0.1) == nil && PearlMath.burst(elapsed: 0.5) == nil && PearlMath.burst(elapsed: 0.1)!.spread < PearlMath.burst(elapsed: 0.4)!.spread && PearlMath.burst(elapsed: 0.44)!.spread <= 22 && PearlMath.burst(elapsed: 0.4)!.alpha < PearlMath.burst(elapsed: 0.1)!.alpha, "a click's burst: a small ripple, spreading and gone in 450 ms")
  check(PearlMath.typeHop(elapsed: 0.065) == 5 && PearlMath.typeHop(elapsed: 0.2) == 0 && PearlMath.typeHop(elapsed: -1) == 0, "typing: a 5 pt hop for each character")
  var most: CGFloat = 0
  for i in 0...120 { most = max(most, abs(PearlMath.ride(elapsed: Double(i) / 100, height: 600))) }
  check(most > 40 && most <= 60 && PearlMath.ride(elapsed: 1.3, height: 600) == 0 && abs(PearlMath.ride(elapsed: 0.15, height: 60)) <= 20, "a scroll: it rides up and down beside the list, never past it: \(most)")
}

// The firefly's colour, its waits, its searches, routes through menus, and being picked up.
do {
  // Intent → colour.
  check(PearlMath.intent("show") == "show" && PearlMath.intent("act") == "act" && PearlMath.intent("ask") == "ask", "three intents")
  check(PearlMath.intent(nil) == "show" && PearlMath.intent("explode") == "show" && PearlMath.intent("") == "show", "an intent the app doesn't know is drawn as show")
  check(PearlMath.lightColours("show") == [0xFFFFFF] && PearlMath.lightColours(nil) == [0xFFFFFF] && PearlMath.lightColours("nonsense") == [0xFFFFFF], "show: the light is white")
  check(PearlMath.lightColours("act") == [0x4780FF, 0xA866FF, 0xFF669E, 0xFFB866], "act: the answer's gradient")
  check(PearlMath.lightColours("ask") == [0xFFB866], "ask: amber")

  // Waiting: a slow breath, never a blink.
  check(PearlMath.breath(0) == 0 && abs(PearlMath.breath(1.3) - 1) < 1e-9 && abs(PearlMath.breath(2.6)) < 1e-9, "one breath every 2.6 s")
  var steepest: CGFloat = 0
  for i in 0..<260 { steepest = max(steepest, abs(PearlMath.breath(Double(i + 1) / 100) - PearlMath.breath(Double(i) / 100))) }
  check(steepest < 0.02 && (0..<300).allSatisfy { PearlMath.breath(Double($0) / 37) >= 0 && PearlMath.breath(Double($0) / 37) <= 1 }, "smooth, and between 0 and 1: \(steepest)")

  // Asking: it hovers beside the thing and never touches it.
  let screen = CGRect(x: 0, y: 0, width: 1512, height: 982), send = CGRect(x: 700, y: 400, width: 80, height: 24)
  let beside = PearlMath.hover(beside: send, in: screen)
  check(beside.x == send.maxX + 14 && beside.y == send.midY && !send.insetBy(dx: -8, dy: -8).contains(beside), "off its right edge at mid-height, clear of it: \(beside)")
  let edge = CGRect(x: 1440, y: 400, width: 66, height: 24), left = PearlMath.hover(beside: edge, in: screen)
  check(left.x == edge.minX - 14 && !edge.insetBy(dx: -8, dy: -8).contains(left) && screen.contains(left), "no room on the right: off its left: \(left)")
  check(screen.contains(PearlMath.hover(beside: CGRect(x: 0, y: 975, width: 1512, height: 7), in: screen)), "kept on the screen")

  // Searching: a small slow figure of eight near the middle of the app's window.
  let centre = CGPoint(x: 600, y: 500)
  check(PearlMath.search(around: centre, elapsed: 0) == centre, "the loop starts at its middle")
  var minX = CGFloat.infinity, maxX = -CGFloat.infinity, minY = CGFloat.infinity, maxY = -CGFloat.infinity, fastest: CGFloat = 0
  var before = PearlMath.search(around: centre, elapsed: 0)
  for i in 1...320 {
    let p = PearlMath.search(around: centre, elapsed: Double(i) / 100)
    minX = min(minX, p.x); maxX = max(maxX, p.x); minY = min(minY, p.y); maxY = max(maxY, p.y)
    fastest = max(fastest, hypot(p.x - before.x, p.y - before.y) * 100)
    before = p
  }
  check(maxX - minX > 50 && maxX - minX <= 56 && maxY - minY > 20 && maxY - minY <= 22, "small: about 56 by 22 pt (\(maxX - minX) × \(maxY - minY))")
  // One loop to the right (up, then down), one to the left (up, then down), through the middle.
  let quarters = [0.4, 1.2, 2.0, 2.8].map { PearlMath.search(around: centre, elapsed: $0) }
  check(quarters[0].x > centre.x && quarters[1].x > centre.x && quarters[2].x < centre.x && quarters[3].x < centre.x, "a loop to each side")
  check(quarters[0].y > centre.y && quarters[1].y < centre.y && quarters[2].y > centre.y && quarters[3].y < centre.y, "crossing over in the middle: a figure of eight")
  let half = PearlMath.search(around: centre, elapsed: PearlMath.searchLoop / 2)
  check(hypot(half.x - centre.x, half.y - centre.y) < 1e-6, "through its middle twice a loop")
  check(fastest < 80 && PearlMath.searchLoop >= 3, "slow: never faster than 80 pt a second (\(fastest))")
  let again = PearlMath.search(around: centre, elapsed: PearlMath.searchLoop)
  check(hypot(again.x - centre.x, again.y - centre.y) < 1e-6, "and round again")
  check(PearlMath.searchAfter == 0.4, "a find shows as searching after 400 ms")
  let win = CGRect(x: 200, y: 150, width: 800, height: 600)
  check(PearlMath.searchCentre(window: win, screen: screen) == CGPoint(x: 600, y: 450), "the middle of the app's window")
  check(PearlMath.searchCentre(window: CGRect(x: 1200, y: 150, width: 800, height: 600), screen: screen) == CGPoint(x: 1356, y: 450), "of the part of it on this screen")
  let none = PearlMath.searchCentre(window: nil, screen: screen)
  check(none.x == screen.midX && none.y > screen.midY && screen.contains(none), "no window to go by: a little above the middle of the screen")
  check(PearlMath.searchCentre(window: CGRect(x: 5000, y: 0, width: 400, height: 300), screen: screen) == none && PearlMath.searchCentre(window: .zero, screen: screen) == none, "a window somewhere else, or no real one: the same")

  // Hold and release: a lesson's light waits until the lesson lets it go.
  var hold = PearlMath.Hold()
  check(!hold.waiting && hold.release("l1.1", outcome: "done") == .ignore, "nothing held: a release is ignored")
  hold.take(step: "l1.1")
  check(hold.waiting && !hold.asking && hold.id == "l1.1", "a point with hold waits on its step")
  check(hold.release("l1.0", outcome: "done") == .ignore && hold.waiting, "a release that names another wait is ignored (normal, not an error)")
  check(hold.release("", outcome: "done") == .ignore && hold.waiting, "and one that names nothing")
  hold.take(step: "l1.1")
  check(hold.id == "l1.1", "the same step again is the same wait")
  check(hold.release("l1.1", outcome: "done") == .burst && !hold.waiting, "done: a burst, and the wait is over")
  check(hold.release("l1.1", outcome: "done") == .ignore, "exactly once")
  hold.take(step: "l1.2")
  check(hold.release("l1.2", outcome: "skipped") == .leave && !hold.waiting, "skipped: it just leaves")
  hold.take(step: "l1.3")
  check(hold.release("l1.3", outcome: "stopped") == .leave, "stopped: it leaves quietly")
  hold.take(step: "l1.4")
  check(hold.release("l1.4", outcome: "not_found") == .lost && !hold.waiting, "not found: home, and sorry")
  hold.take(step: "l1.5")
  check(hold.release("l1.5", outcome: "exploded") == .leave, "an outcome the app doesn't know: it leaves quietly")
  hold.take(step: "l1.6")
  hold.take(step: "l1.7")
  check(hold.release("l1.6", outcome: "done") == .ignore && hold.id == "l1.7", "a new step replaces the wait; the old one's release names nothing held")
  hold.take(step: nil)
  check(!hold.waiting, "a point with no hold ends the wait before it")
  hold.take(step: String(repeating: "x", count: 90))
  check(hold.id.count == 40, "ids are at most 40 characters")
  // A risky step's light waits for the card.
  hold.take(ask: "a1b2c3d4")
  check(hold.waiting && hold.asking, "a hold to ask")
  check(hold.release("a1b2c3d4", outcome: "done") == .proceed && !hold.waiting && !hold.asking, "allowed: it stays for the click, no longer asking")
  hold.take(ask: "e5f6a7b8")
  check(hold.release("e5f6a7b8", outcome: "stopped") == .leave, "said no, expired, stopped: it leaves")
  hold.take(ask: "")
  check(!hold.waiting, "a hold with no id holds nothing")
  // It never times out by itself: only a release or a drop ends it.
  hold.take(step: "l2.1")
  check(!hold.drop(asksOnly: true) && hold.waiting, "a run ending leaves a lesson's light waiting")
  check(hold.drop() && !hold.waiting && !hold.drop(), "the line dropping or quitting lets everything go")
  hold.take(ask: "c0ffee00")
  check(hold.drop(asksOnly: true) && !hold.waiting, "a run ending lets its risky step's light go")
  // Searches: the server may stop waiting for one.
  hold.began("req1")
  check(hold.working == ["req1"] && !hold.isCalledOff("req1"), "a find is running")
  hold.began("req1")
  check(hold.working.count == 1, "once")
  check(hold.ended("req1") && hold.working.isEmpty, "found (or not) by the app itself: there is an answer to send")
  hold.began("req2")
  hold.take(step: "l3.1")
  check(hold.release("req2", outcome: "not_found") == .lost && hold.isCalledOff("req2") && hold.working.isEmpty, "the server gave up on it: the search ends")
  check(hold.waiting, "(a release for a search is not a release for the step being waited on)")
  check(!hold.ended("req2"), "and nothing is answered for it")
  check(hold.release("req2", outcome: "not_found") == .ignore, "once")
  check(hold.release("req9", outcome: "not_found") == .ignore, "a request the app isn't working on: ignored")
  for i in 0..<30 { hold.began("r\(i)"); _ = hold.release("r\(i)", outcome: "not_found") }
  check(hold.calledOff.count <= 8 && hold.working.isEmpty, "nothing piles up")

  // The release can beat the find (the lesson was stopped, moved on or got new steps while the
  // app was still looking): the step is not taken when the find comes back.
  var early = PearlMath.Hold()
  early.began("p1", step: "l4.1")
  check(early.step(of: "p1") == "l4.1" && early.step(of: "p9") == nil && early.step(of: nil) == nil, "a find knows which step it is for")
  check(!early.refuses(step: "l4.1"), "still wanted")
  check(early.release("l4.1", outcome: "stopped") == .early && !early.waiting, "let go before the light got there: nothing was held, and it is remembered")
  check(early.refuses(step: "l4.1") && !early.take(step: "l4.1") && !early.waiting, "the find comes back: the step is refused, and nothing waits (it used to wait for good)")
  check(early.release("l4.1", outcome: "stopped") == .early && early.letGo == ["l4.1"], "told twice: remembered once")
  check(early.ended("p1"), "the find still has its answer to send")
  check(early.letGo.isEmpty && !early.refuses(step: "l4.1") && early.step(of: "p1") == nil, "and with its last find over the step is forgotten: nothing piles up")
  // "Next" during the find: the old step is refused, the new one is taken as always.
  early.began("p2", step: "l4.2")
  check(early.release("l4.2", outcome: "skipped") == .early, "skipped before it was found")
  early.began("p3", step: "l4.3")
  check(early.take(step: "l4.3") && early.id == "l4.3" && early.ended("p3"), "the next step's find holds the light")
  check(!early.take(step: "l4.2") && early.id == "l4.3", "the old step's find comes back late: refused, and the wait on the new step is untouched")
  check(early.ended("p2") && early.release("l4.3", outcome: "done") == .burst, "which is let go as usual")
  // A hint re-points while the step is held, and the release beats that find.
  early.began("p4", step: "l4.4")
  check(early.take(step: "l4.4") && early.ended("p4"), "held")
  early.began("p5", step: "l4.4")
  check(early.release("l4.4", outcome: "done") == .burst && !early.waiting, "the step passes while a hint is still being looked for: the usual burst")
  check(!early.take(step: "l4.4") && !early.waiting, "the hint's find comes back: it does not take the light again")
  check(early.ended("p5") && early.letGo.isEmpty, "over")
  // Two finds for one step: it stays refused until both are over.
  early.began("p6", step: "l4.5")
  early.began("p7", step: "l4.5")
  check(early.release("l4.5", outcome: "stopped") == .early && early.ended("p6") && early.refuses(step: "l4.5"), "one find over, the other still out: still refused")
  check(early.ended("p7") && !early.refuses(step: "l4.5"), "both over: forgotten")
  // A release for an id nobody knows changes nothing, now or later.
  var unknown = PearlMath.Hold()
  unknown.began("p8", step: "l5.1")
  check(unknown.release("l9.9", outcome: "stopped") == .ignore && unknown.letGo.isEmpty, "a release for an unknown id is ignored")
  check(unknown.take(step: "l9.9") && unknown.id == "l9.9", "and refuses nothing later")
  check(unknown.take(step: "l5.1") && unknown.release("l5.1", outcome: "done") == .burst, "the step being looked for is taken and let go as usual")
  check(unknown.take(step: nil) && unknown.take(step: ""), "a point with no step is never refused")
  // A find the server gave up on takes its step's memory with it.
  var gone = PearlMath.Hold()
  gone.began("p9", step: "l6.1")
  check(gone.release("l6.1", outcome: "stopped") == .early && gone.release("p9", outcome: "not_found") == .lost, "let go, then called off")
  check(gone.letGo.isEmpty && gone.step(of: "p9") == nil, "nothing is left behind")
  for i in 0..<30 { gone.began("q\(i)", step: "s\(i)"); _ = gone.release("s\(i)", outcome: "stopped") }
  check(gone.working.count == 8 && gone.letGo.count == 8, "finds that never end are capped, and so is what is remembered for them (\(gone.letGo.count))")

  // How often the light is drawn: every frame while it moves, about 20 a second at rest.
  func pictures(hz: Double, seconds: Double, moving: (Double) -> Bool) -> Int {
    var pace = PearlMath.Pace(), last = 0.0, n = 0
    for i in 1...Int(hz * seconds) {
      let now = Double(i) / hz
      if pace.due(now: now, last: last, moving: moving(now)) { last = now; n += 1 }
    }
    return n
  }
  for hz in [60.0, 120.0] {
    let resting = pictures(hz: hz, seconds: 10) { _ in false }
    check(resting >= 150 && resting <= 200, "a light held by a lesson for 10 s on a \(Int(hz)) Hz display: 15 to 20 pictures a second (\(resting) in all)")
    check(pictures(hz: hz, seconds: 2) { _ in true } == Int(hz * 2), "flying or in your hand: every frame")
    // It flies for the first second, then rests: full rate through the flight and a moment after.
    let landed = pictures(hz: hz, seconds: 3) { $0 <= 1 }
    let most = Int(hz * (1 + PearlMath.Pace.settle)) + Int(20 * (2 - PearlMath.Pace.settle)) + 2
    check(landed >= Int(hz) + 20 && landed <= most, "then it settles (the trail fades, a burst plays out) and slows down (\(landed))")
  }
  check(PearlMath.Pace.rest >= 1.0 / 20 && PearlMath.Pace.rest <= 1.0 / 15 && PearlMath.Pace.settle >= 0.45, "15 to 20 Hz at rest; lively long enough for a burst (450 ms)")

  // The hit area: 22 pt round the light, only while it can be held, never on the thing itself.
  let light = PearlMath.orbit(send, laps: 0)
  check(PearlMath.grabReach == 11, "22 pt across")
  check(PearlMath.grabbable(light, light: light, target: send, holdable: true), "on the light")
  check(PearlMath.grabbable(CGPoint(x: light.x + 7, y: light.y + 7), light: light, target: send, holdable: true), "within reach of it")
  check(!PearlMath.grabbable(CGPoint(x: light.x + 12, y: light.y), light: light, target: send, holdable: true), "past 11 pt: the click goes through")
  check(!PearlMath.grabbable(light, light: light, target: send, holdable: false), "not while it can't be held (flying, mid-step, home)")
  let onButton = CGPoint(x: light.x, y: send.maxY - 1)
  check(hypot(onButton.x - light.x, onButton.y - light.y) < 11 && !PearlMath.grabbable(onButton, light: light, target: send, holdable: true), "a click on the thing itself always goes to the thing")
  check(PearlMath.grabbable(CGPoint(x: 5, y: 5), light: CGPoint(x: 8, y: 8), target: .null, holdable: true), "resting on no thing in particular: just the reach")
  // A click on it (no drag) and it steps to the far corner of the thing, out of your way.
  let aside = PearlMath.orbit(send, laps: 0.5)
  check(aside.y == send.minY - 7 && aside.x < send.midX && hypot(aside.x - light.x, aside.y - light.y) > 2 * PearlMath.grabReach, "the far corner is nowhere near where it was: \(aside)")

  // The drag: idle → held → dragging → dropped or cancelled.
  var grab = PearlMath.Grab()
  check(grab.state == .idle && !grab.active, "idle")
  check(!grab.press(CGPoint(x: light.x + 40, y: light.y), light: light, target: send, holdable: true) && grab.state == .idle, "a press off the light is not a grab")
  check(!grab.press(light, light: light, target: send, holdable: false) && grab.state == .idle, "nor one while it can't be held")
  let press = CGPoint(x: light.x + 2, y: light.y + 1)
  check(grab.press(press, light: light, target: send, holdable: true) && grab.state == .held && grab.active && grab.from == light && grab.at == light, "pressed on it: held, and it hasn't moved")
  check(!grab.press(press, light: light, target: send, holdable: true), "already in hand")
  grab.move(CGPoint(x: press.x + 2, y: press.y - 1))
  check(grab.state == .held && grab.at == light, "a wobble of the hand is not a drag")
  grab.move(CGPoint(x: press.x + 30, y: press.y - 12))
  check(grab.state == .dragging && grab.at == CGPoint(x: press.x + 30, y: press.y - 12), "past a few points: dragging, and the light follows the mouse")
  grab.move(CGPoint(x: 300, y: 300))
  check(grab.at == CGPoint(x: 300, y: 300) && grab.from == light, "wherever it goes (it remembers where it was)")
  grab.release(CGPoint(x: 310, y: 305))
  check(grab.state == .dropped && !grab.active && grab.at == CGPoint(x: 310, y: 305), "let go: dropped there")
  grab.move(CGPoint(x: 900, y: 900))
  grab.escape()
  check(grab.state == .dropped && grab.at == CGPoint(x: 310, y: 305), "a drop is a drop: later moves and Escape change nothing")
  grab.settle()
  check(grab.state == .idle, "dealt with")
  // A click that never moved is nothing at all.
  _ = grab.press(press, light: light, target: send, holdable: true)
  grab.release(press)
  check(grab.state == .idle, "pressed and let go without moving: nothing")
  // Escape cancels.
  _ = grab.press(press, light: light, target: send, holdable: true)
  grab.move(CGPoint(x: 500, y: 500))
  grab.escape()
  check(grab.state == .cancelled && grab.at == light && !grab.active, "Escape: cancelled, back where it was")
  grab.move(CGPoint(x: 600, y: 600))
  grab.release(CGPoint(x: 600, y: 600))
  check(grab.state == .cancelled && grab.at == light, "the mouse coming up afterwards drops nothing")
  grab.settle()
  _ = grab.press(press, light: light, target: send, holdable: true)
  grab.escape()
  check(grab.state == .cancelled, "Escape while only pressed cancels too")
  grab.settle()
  grab.escape()
  grab.release(press)
  grab.move(press)
  check(grab.state == .idle, "idle stays idle")
  // Where a drop goes.
  check(PearlMath.drop(element: true, onEcho: false) == .settle, "on something: it settles there")
  check(PearlMath.drop(element: false, onEcho: false) == .back && PearlMath.drop(element: true, onEcho: true) == .back && PearlMath.drop(element: false, onEcho: true) == .back, "on nothing, or on Echo's own windows: back where it was")

  // A route through menus: File › Export › PDF….
  var route = PearlMath.Route(count: 3, at: 100)
  check(route.next == 0 && route.reached == -1 && !route.onTarget && route.ready(at: 100), "it looks for the first label first")
  check(route.answer(at: 100.5) == nil, "no answer while it may still show up")
  route.arrive(at: 100.2)
  check(route.reached == 0 && route.next == 1, "on File: Export is next")
  check(!route.ready(at: 100.4) && route.ready(at: 100.56), "it rests about 350 ms on each stop before moving on")
  check(PearlMath.Route.rest >= 0.3 && PearlMath.Route.rest <= 0.4, "about 350 ms")
  check(route.answer(at: 101.6) == nil, "it waits at a stop for the next to show, up to its patience")
  let stalled = route.answer(at: 101.71)
  check(stalled?.found == true && stalled?.index == 0, "the menu was never opened: it stays on File and says so (routeIndex 0)")
  check(route.answer(at: 200) == nil && !route.over, "it answers once, and keeps walking (a held light goes on as you open the menus)")
  route.arrive(at: 110)
  route.arrive(at: 110.5)
  check(route.onTarget && route.next == nil && route.reached == 2 && route.over, "to the target, where the route is over")
  route.arrive(at: 111)
  check(route.reached == 2 && !route.ready(at: 120), "never past the target")
  var open = PearlMath.Route(count: 3, at: 0)
  open.arrive(at: 0.1); open.arrive(at: 0.5)
  check(open.answer(at: 0.6) == nil, "menus already open: no answer until it is on the target")
  open.arrive(at: 0.9)
  let whole = open.answer(at: 0.9)
  check(whole?.found == true && whole?.index == 2 && open.over, "then at once: routeIndex is the target's")
  var lostRoute = PearlMath.Route(count: 2, at: 0)
  check(lostRoute.answer(at: 1.4) == nil, "not even the first label, yet")
  let never = lostRoute.answer(at: 1.5)
  check(never?.found == false && lostRoute.over, "not even the first label after its patience: not found, and it gives up")
  var patient = PearlMath.Route(count: 2, at: 0, patience: 6)
  check(patient.answer(at: 5.9) == nil && patient.answer(at: 6)?.found == false, "the request's own timeout is its patience")
  check(PearlMath.Route(count: 2, at: 0, patience: 900).patience == 15 && PearlMath.Route(count: 2, at: 0, patience: -1).patience == 0.3, "within reason")
  check(PearlMath.Route(count: 40, at: 0).count == 6 && PearlMath.Route(count: 0, at: 0).count == 1, "1 to 6 stops")
  // A walk whose first stop is missing: its own search shows at 400 ms and must not stop it,
  // so it goes on looking and answers "not found" when its patience runs out (it used to be
  // stopped by its own search and never answer: the request hung for 20 s).
  check(!PearlMath.searchStops(walk: "w1", for: "w1"), "the walk's own search does not stop the walk")
  check(PearlMath.searchStops(walk: "w1", for: "r2"), "a search for another request, arriving mid-walk, does: the light is looking for that now")
  check(!PearlMath.searchStops(walk: nil, for: "r2"), "no walk under way: nothing to stop")
  var missing = PearlMath.Route(count: 3, at: 0, patience: 1.5)
  var walking: String? = "w1", answers: [Bool] = []
  for i in 0...8 {
    let now = Double(i) * 0.25
    // The walk's own search shows 400 ms in.
    if i == 2, PearlMath.searchStops(walk: walking, for: "w1") { walking = nil }
    guard walking != nil else { break }
    if let a = missing.answer(at: now) { answers.append(a.found) }
    if missing.over { walking = nil }
  }
  check(answers == [false] && walking == nil && missing.over, "first stop never found: one answer, found false, at its patience (\(answers))")
  // A search for another request arrives mid-walk: the walk stops, and answers with how far it got.
  var cut = PearlMath.Route(count: 3, at: 0, patience: 6)
  cut.arrive(at: 0.1)
  check(PearlMath.searchStops(walk: "w2", for: "r3"), "another request's search takes the light")
  let cutAnswer = cut.stop()
  check(cutAnswer?.found == true && cutAnswer?.index == 0, "stopped on File before its answer: it says so now (routeIndex 0)")
  check(cut.stop() == nil && cut.answer(at: 99) == nil, "once")
  var cutEarly = PearlMath.Route(count: 2, at: 0, patience: 6)
  check(cutEarly.stop()?.found == false && cutEarly.over, "stopped before even the first label: not found")
  var told = PearlMath.Route(count: 2, at: 0)
  told.arrive(at: 0.1)
  _ = told.answer(at: 2)
  check(told.stop() == nil, "a walk that has answered (a held light still walking) answers nothing more when stopped")
  var single = PearlMath.Route(count: 1, at: 0)
  single.arrive(at: 0.3)
  check(single.onTarget && single.answer(at: 0.3)?.index == 0, "a route of one is just its target")
  // The route as the request gives it.
  check(PearlMath.route(["File", " Export ", "PDF…"]) ?? [] == ["File", "Export", "PDF…"], "labels, trimmed")
  check(PearlMath.route(["Open  \n Recent"]) ?? [] == ["Open Recent"], "white space squeezed")
  check(PearlMath.route(nil) == nil && PearlMath.route([]) == nil && PearlMath.route("File") == nil, "no route")
  check(PearlMath.route(["File", ""]) == nil && PearlMath.route(["File", 3]) == nil && PearlMath.route([String(repeating: "x", count: 61)]) == nil, "an empty, wrong or over-long label: not a route")
  check(PearlMath.route(Array(repeating: "A", count: 7)) == nil && PearlMath.route(Array(repeating: "A", count: 6))?.count == 6, "at most six")
}

// The other way ("reach"): where the pearl stands, its finger, and its hop.
do {
  let d: CGFloat = 32, R = d / 2
  let stand = PearlMath.stand(beside: button, diameter: d, in: screenBounds)
  func body(_ p: CGPoint) -> CGRect { CGRect(x: p.x - R, y: p.y - R, width: d, height: d) }
  check(!body(stand).intersects(button) && stand.x > button.maxX && stand.y > button.maxY, "it stands off the target's top-right corner, covering none of it: \(stand)")
  let corner = CGPoint(x: button.maxX, y: button.maxY), reach = hypot(stand.x - corner.x, stand.y - corner.y)
  check(abs(reach - (R * PearlMath.fingerReach + 7)) < 1e-6, "a finger's length away: the fingertip just touches the ring round it")
  check(PearlMath.touch(button, from: stand) == corner && abs(PearlMath.aim(from: stand, at: button) + .pi * 0.75) < 1e-6, "the finger aims at the nearest corner: down and to the left")
  check(PearlMath.touch(button, from: CGPoint(x: button.midX, y: 900)) == CGPoint(x: button.midX, y: button.maxY) && PearlMath.touch(button, from: CGPoint(x: button.midX + 1, y: button.midY)) == CGPoint(x: button.midX, y: button.midY), "or the nearest edge; from inside, its middle")
  let cornerStand = PearlMath.stand(beside: CGRect(x: 1480, y: 950, width: 30, height: 30), diameter: d, in: screenBounds)
  check(screenBounds.insetBy(dx: R + 8, dy: R + 8).contains(cornerStand) && cornerStand.x < 1480, "stays on screen in a corner: \(cornerStand)")
  let pillZone = CGRect(x: 780, y: 420, width: 300, height: 46)
  let clear = PearlMath.stand(beside: button, diameter: d, in: screenBounds, avoiding: [pillZone])
  check(!body(clear).intersects(pillZone) && !body(clear).intersects(button), "stands clear of the island: \(clear)")
  let bigWindow = CGRect(x: 0, y: 0, width: 1400, height: 900)
  let huge = PearlMath.stand(beside: bigWindow, diameter: d, in: screenBounds)
  check(bigWindow.contains(body(huge)) && huge.x > 1300 && huge.y > 800, "a whole window: just inside its top-right corner")

  // The finger: a round nub on a smooth neck, out of a round body.
  let round = PearlMath.body(radius: R, point: 0, aim: 1).boundingBoxOfPath
  check(abs(round.width - d) < 0.01 && abs(round.height - d) < 0.01, "no finger: a circle")
  let right = PearlMath.body(radius: R, point: 1, aim: 0)
  let box = right.boundingBoxOfPath
  check(abs(box.maxX - R * PearlMath.fingerReach) < 0.2 && abs(box.minX + R) < 0.2 && abs(box.height - d) < 0.2, "reached out: the fingertip is 1.85 radii from its middle, the rest still round: \(box)")
  check(right.contains(CGPoint(x: R * 1.7, y: 0)) && !right.contains(CGPoint(x: R * 1.7, y: R * 0.35)) && right.contains(CGPoint(x: R * 1.25, y: 0)) && !right.contains(CGPoint(x: R * 1.25, y: R * 0.75)), "a slim finger, not a wedge")
  let tipWidth = (0..<40).filter { right.contains(CGPoint(x: R * 1.62, y: -R + CGFloat($0) * R / 20)) }.count
  check(tipWidth >= 8, "with a soft round end, not a spike: \(tipWidth)")
  let up = PearlMath.body(radius: R, point: 1, aim: .pi / 2).boundingBoxOfPath
  check(abs(up.maxY - R * PearlMath.fingerReach) < 0.2 && abs(up.width - d) < 0.2, "it reaches wherever it aims (up is up)")
  check(PearlMath.body(radius: R, point: 9, aim: 0).boundingBoxOfPath.maxX < R * 2.1, "never an arm, whatever it is told")
  check(abs(PearlMath.turn(3, toward: -3, rate: 12, dt: 1.0 / 60) - 3) < 0.1 && PearlMath.turn(3, toward: -3, rate: 12, dt: 1.0 / 60) > 3, "it turns the short way round")
  check(PearlMath.tap(elapsed: 0.05) < 1 && PearlMath.tap(elapsed: 0.15) > 1 && PearlMath.tap(elapsed: 0.3) == 1 && PearlMath.tap(elapsed: -1) == 1, "a tap: the finger draws back, pushes a little past, and rests")
  check(PearlMath.nod(elapsed: 0.05) != 0 && abs(PearlMath.nod(elapsed: 0.05)) <= 1 && PearlMath.nod(elapsed: 1.2) == 0, "a scroll: a few small nods that die away")

  // The hop: eyes first, a crouch, an arc, a landing on the spot.
  let from = CGPoint(x: 100, y: 900), to = CGPoint(x: 900, y: 500)
  let hop = PearlMath.Hop(from: from, to: to, at: 10, radius: R)
  check(hop.position(at: 10.2) == from && !hop.crouching(at: 10.1) && hop.crouching(at: 10.2) && abs(hop.leaves - 10.25) < 1e-9, "its eyes go first (140 ms), then it crouches (110 ms), still on the spot")
  check(hop.duration >= 0.36 && hop.duration <= 0.56 && hop.position(at: hop.lands) == to && hop.done(at: hop.lands) && !hop.done(at: hop.lands - 0.01), "then 360–560 ms in the air, landing on the spot: \(hop.duration)")
  let top = hop.position(at: hop.leaves + hop.duration / 2)
  check(top.y > (from.y + to.y) / 2 + R && abs(top.x - (from.x + to.x) / 2) < 0.01, "in an arc, not a straight line: \(top)")
  var hopSteps: [CGFloat] = [], lastHop = from
  for i in 1...Int(hop.duration * 120) {
    let p = hop.position(at: hop.leaves + Double(i) / 120)
    hopSteps.append(hypot(p.x - lastHop.x, p.y - lastHop.y))
    lastHop = p
  }
  check(hopSteps.max()! < 40 && hopSteps[0] < hopSteps[hopSteps.count / 2], "never a leap, and a soft start: \(hopSteps.max()!)")
  check(hop.tilt(at: 10.1) == 0 && hop.tilt(at: hop.leaves + hop.duration / 2) > 0 && hop.tilt(at: hop.lands) < 1e-9 && PearlMath.Hop(from: to, to: from, at: 0, radius: R).tilt(at: 0.5) < 0, "it leans into the way it is going")
  let again = PearlMath.Hop(from: top, to: from, at: 20, radius: R, airborne: true)
  check(again.leaves == 20 && !again.crouching(at: 20), "a new target in mid-air: no second crouch")
  var home = PearlMath.Hop(from: to, to: CGPoint(x: 700, y: 950), at: 30, radius: R)
  let before = home.position(at: home.leaves + 0.2)
  home.to = CGPoint(x: 690, y: 954)
  check(hypot(home.position(at: home.leaves + 0.2).x - before.x, home.position(at: home.leaves + 0.2).y - before.y) < 11 && home.position(at: 32) == CGPoint(x: 690, y: 954), "hopping home follows the island as it moves")
}
// The spring that follows the pill: gets there without overshoot, at any frame rate.
var sp = CGPoint(x: 0, y: 0), sv = CGVector.zero, over = false
for _ in 0..<60 {
  (sp, sv) = CompanionMath.spring(sp, sv, to: CGPoint(x: 100, y: 0), dt: 1.0 / 60, response: 0.2)
  if sp.x > 100.01 { over = true }
}
check(!over && abs(sp.x - 100) < 0.5, "the dock spring settles without overshoot: \(sp.x)")
var big = CGPoint(x: 0, y: 0), bv = CGVector.zero
(big, bv) = CompanionMath.spring(big, bv, to: CGPoint(x: 100, y: 0), dt: 0.05, response: 0.2)
check(big.x > 0 && big.x < 100, "and stays stable on a slow frame: \(big.x)")

// When it comes home to the pill.
check(!CompanionMath.shouldReturnHome(pinned: false, voice: "speaking", actionPending: true, sincePoint: 5, sinceFinished: nil, pillShowing: true), "never mid-click")
check(!CompanionMath.shouldReturnHome(pinned: false, voice: "speaking", actionPending: false, sincePoint: 0.3, sinceFinished: nil, pillShowing: true), "not the moment it arrived")
check(CompanionMath.shouldReturnHome(pinned: false, voice: "speaking", actionPending: false, sincePoint: 1, sinceFinished: nil, pillShowing: true), "home when Echo speaks (asking before a click)")
check(!CompanionMath.shouldReturnHome(pinned: true, voice: "speaking", actionPending: false, sincePoint: 3, sinceFinished: nil, pillShowing: true), "a \"look here\" stays while Echo talks about it")
check(CompanionMath.shouldReturnHome(pinned: true, voice: "listening", actionPending: false, sincePoint: 2, sinceFinished: nil, pillShowing: true), "and comes home when you talk")
check(CompanionMath.shouldReturnHome(pinned: false, voice: "idle", actionPending: false, sincePoint: 3, sinceFinished: 1.9, pillShowing: true), "home after a finished step's sparkle")
check(!CompanionMath.shouldReturnHome(pinned: false, voice: "idle", actionPending: false, sincePoint: 3, sinceFinished: 0.5, pillShowing: true), "but not before the sparkle")
check(!CompanionMath.shouldReturnHome(pinned: false, voice: "speaking", actionPending: false, sincePoint: 9, sinceFinished: 5, pillShowing: false), "no pill, no home")
// In the middle of a job it waits where it last was for the next step, however long that takes.
check(!CompanionMath.shouldReturnHome(pinned: false, voice: "thinking", actionPending: false, sincePoint: 30, sinceFinished: 25, pillShowing: true, working: true, idleFor: 0), "mid-job, a finished step's light waits while Echo thinks about the next one")
check(!CompanionMath.shouldReturnHome(pinned: false, voice: "speaking", actionPending: false, sincePoint: 3, sinceFinished: nil, pillShowing: true, working: true, idleFor: 0), "and stays while Echo says what it is doing")
check(!CompanionMath.shouldReturnHome(pinned: false, voice: "idle", actionPending: false, sincePoint: 6, sinceFinished: 4, pillShowing: true, working: true, idleFor: 0.4), "a blink of idle between steps is not the end of the job")
check(CompanionMath.shouldReturnHome(pinned: false, voice: "idle", actionPending: false, sincePoint: 6, sinceFinished: 4, pillShowing: true, working: true, idleFor: 3), "Echo idle for a moment: the job is over, home")
check(CompanionMath.shouldReturnHome(pinned: false, voice: "thinking", actionPending: false, sincePoint: 130, sinceFinished: 125, pillShowing: true, working: true, idleFor: 0), "but not for ever")
check(CompanionMath.shouldReturnHome(pinned: false, voice: "listening", actionPending: false, sincePoint: 3, sinceFinished: 2, pillShowing: true, working: true, idleFor: 0), "and home when you talk")
check(CompanionMath.shouldReturnHome(pinned: false, voice: "idle", actionPending: false, sincePoint: 3, sinceFinished: 1.9, pillShowing: true, working: false), "the job over, it goes home as before")
check(!CompanionMath.shouldReturnHome(pinned: false, voice: "thinking", actionPending: true, sincePoint: 30, sinceFinished: nil, pillShowing: true, working: true, idleFor: 0), "still never mid-click")
check(CompanionMath.homeReason(sinceFinished: 2) == "step" && CompanionMath.homeReason(sinceFinished: nil) == "wait", "why it went home")

let up = CompanionMath.smoothLevel(0, toward: 1, dt: 0.06), down = 1 - CompanionMath.smoothLevel(1, toward: 0, dt: 0.06)
check(up > down && up > 0.5, "the voice level swells fast and settles softly: \(up) vs \(down)")
// The step counter while Echo works on the Mac ("Excel · step 2 of 4 · typing in A1").
check(StepMath.counter(step: 3, of: 3) == "step 3 of 3", "step 3 of 3")
check(StepMath.counter(step: 4, of: 3) == "step 4 of 4", "a guess that ran short grows, never \"4 of 3\"")
check(StepMath.counter(step: 1, of: 0) == "" && StepMath.counter(step: 2, of: 0) == "step 2", "no total: nothing on the first step, then \"step 2\"")
check(StepMath.counter(step: 0, of: 3) == "", "no step, no counter")

// Echo's line lights up word by word as she says it.
let starts = [0.0, 0.3, 0.6, 0.9]
check(SpeechMath.lit(starts: starts, at: -0.1) == 0, "nothing lit before she starts")
check(abs(SpeechMath.lit(starts: starts, at: 0.09) - 0.5) < 0.01, "the first word fades in as it's said")
check(abs(SpeechMath.lit(starts: starts, at: 0.4) - 1.556) < 0.01, "then the next")
check(SpeechMath.lit(starts: starts, at: 5) == 4, "all lit at the end")
var lastLit: CGFloat = -1, monotonic = true
for i in 0..<200 {
  let l = SpeechMath.lit(starts: starts, at: Double(i) * 0.01)
  if l < lastLit { monotonic = false }
  lastLit = l
}
check(monotonic, "it never goes backwards")
check(SpeechMath.said(word: 3, lit: 1) == 0 && SpeechMath.said(word: 0, lit: 1) == 1, "upcoming words wait in grey, said ones are white")
check(abs(SpeechMath.said(word: 1, lit: 1.5) - 0.5) < 0.001, "the word being said is on its way")
// Her answer shows one line at a time.
do {
  let widths: [CGFloat] = [40, 40, 40, 40, 40, 40, 40]
  let lines = SpeechMath.lines(widths: widths, space: 5, room: 130)
  check(lines == [0..<3, 3..<6, 6..<7], "as many words as fit, then the next line: \(lines)")
  check(SpeechMath.lines(widths: [40, 300, 40], space: 5, room: 130) == [0..<1, 1..<2, 2..<3], "a word too long for the room gets a line to itself")
  check(SpeechMath.lines(widths: [], space: 5, room: 130).isEmpty && SpeechMath.lines(widths: widths, space: 5, room: 1000) == [0..<7], "nothing, and everything on one line")
  check(SpeechMath.line(lines, lit: 0) == 0 && SpeechMath.line(lines, lit: 2.4) == 0, "the first line while she says its words")
  check(SpeechMath.line(lines, lit: 3) == 0, "it stays until its last word is over")
  check(SpeechMath.line(lines, lit: 3.2) == 1 && SpeechMath.line(lines, lit: 6.5) == 2, "then the next")
  check(SpeechMath.line(lines, lit: 7) == 2 && SpeechMath.line(lines, lit: .infinity) == 2 && SpeechMath.line([], lit: 3) == 0, "the last line once she's done")
}
let est = SpeechMath.estimate(["Sure.", "I'll", "write", "to", "Priya."])
check(est.count == 5 && est[0] == 0.35 && zip(est, est.dropFirst()).allSatisfy { $0 < $1 }, "the estimate rises word by word: \(est)")
check(est[1] - est[0] > est[4] - est[3], "and pauses after a full stop")
check(SpeechMath.align([0, 1, 2, 3, 4], count: 3) == [2, 3, 4], "a line cut short keeps the timings of its last words")

// Typing: a character at a time, natural, capped, never a lone line break.
let short = TypingMath.plan("Hi there, Priya.")
check(short.count == 16 && short.map(\.text).joined() == "Hi there, Priya.", "short text: one character at a time, nothing lost")
check(short[0].delay == 0 && short.dropFirst().allSatisfy { $0.delay > 0.03 && $0.delay < 0.3 }, "at a natural pace")
check(Set(short.dropFirst().map(\.delay)).count > 5, "that varies a little")
check(short[10].delay > short[2].delay, "a breath after the comma")
check(TypingMath.plan("Hi there, Priya.") == short, "the same rhythm every time for the same text (repeatable)")
let long = String(repeating: "Are we still on for dinner Thursday at 7? ", count: 20)
let lp = TypingMath.plan(long)
check(lp.map(\.text).joined() == long, "long text: nothing lost")
check(TypingMath.duration(lp) <= TypingMath.cap + 0.001, "long text is capped at a few seconds: \(TypingMath.duration(lp))")
check(lp.count < long.count && lp.dropFirst().allSatisfy { $0.delay >= TypingMath.minBeat - 0.0001 || $0 == lp.last }, "and goes in small bursts rather than invisibly fast key presses")
let medium = TypingMath.plan(String(repeating: "word ", count: 20))
check(TypingMath.duration(medium) <= TypingMath.cap + 0.001 && TypingMath.duration(medium) > 2.5, "medium text speeds up to fit: \(TypingMath.duration(medium))")
let lines = TypingMath.plan("Hi\nthere")
check(lines.map(\.text).joined() == "Hi\nthere" && !lines.contains { $0.text.allSatisfy(\.isNewline) }, "a line break never goes on its own")
check(TypingMath.plan("\nHi").first?.text == "\nH", "not even at the start")
check(TypingMath.plan("👋🏽 hi").first?.text == "👋🏽", "an emoji is one character")
check(TypingMath.plan("").isEmpty, "nothing to type")
// The finishing shimmer runs along the typed line, from the field's edge to the caret.
let typedBox = CGRect(x: 100, y: 500, width: 600, height: 30)
let span = TypingMath.shimmerSpan(caret: CGRect(x: 300, y: 505, width: 1, height: 20), field: typedBox)
check(span.map { abs($0.minX - 102) < 0.01 && abs($0.maxX - 301) < 0.01 && abs($0.midY - 515) < 0.01 } == true, "from the field's edge to the caret: \(String(describing: span))")
let farSpan = TypingMath.shimmerSpan(caret: CGRect(x: 1600, y: 505, width: 1, height: 20), field: CGRect(x: 0, y: 0, width: 1800, height: 900))
check(farSpan.map { abs($0.width - 420) < 0.01 } == true, "at most 420 pt back on a long line")
check(TypingMath.shimmerSpan(caret: nil, field: typedBox) != nil, "a one-line field without a caret: across the field")
check(TypingMath.shimmerSpan(caret: nil, field: CGRect(x: 0, y: 0, width: 600, height: 400)) == nil, "a message body without a caret: none")
check(TypingMath.shimmerSpan(caret: nil, field: nil) == nil, "nowhere to show it: none")
check(TypingMath.shimmerDuration(width: 10) >= 0.45 && TypingMath.shimmerDuration(width: 5000) <= 0.85, "a quick pass")

// Label matching is strict about long lines: a word inside an inbox row or tab title isn't a label.
check(LabelMatch.score("Compose", "compose") == 100, "Compose is Compose")
check(LabelMatch.score("Re: compose the quarterly draft by Friday please", "Compose") < 45, "a long row that mentions compose is not the Compose button")
check(LabelMatch.score("New Tab", "tab") == 60, "a short label with the word still matches")
check(LabelMatch.score("To recipients", "To") == 75, "the To box starts with To")
// A lesson's label check is the whole label (Oct 3: "Rectangle 1" passed on the Rectangle tool).
check(LabelMatch.score("Rectangle", "Rectangle 1") == 75, "pointing still finds the tool for a longer name")
check(!LabelMatch.fits("Rectangle", "Rectangle 1"), "but the Rectangle tool is not the Rectangle 1 layer")
check(!LabelMatch.fits("Text", "Text tool"), "nor is Text the Text tool")
check(!LabelMatch.fits("Rectangle 1 copy", "Rectangle 1"), "a longer label is not the label")
check(LabelMatch.fits("  rectangle  1", "Rectangle 1"), "case and spacing are folded")
check(LabelMatch.fits("Wi\u{2011}Fi", "wifi") && LabelMatch.fits("Save…", "save") && LabelMatch.fits("Général", "general"), "dashes, punctuation and accents are folded")
check(!LabelMatch.fits("", "") && !LabelMatch.fits("Save", ""), "nothing asked for fits nothing")
check(LabelMatch.fits("Rectangle 1 copy", "Rectangle 1", contains: true), "contains: a label holding the words")
check(!LabelMatch.fits("Rectangle", "Rectangle 1", contains: true), "contains: never a label shorter than what was asked")
check(!LabelMatch.fits("Rectangles", "Rectangle", contains: true), "contains: whole words only")

// Acting on the right thing: controls beat the text inside them; typing prefers a field to its label.
let label = ActMath.adjust(100, role: "AXStaticText", wantsField: true)
let field = ActMath.adjust(75, role: "AXComboBox", wantsField: true)
check(field > label, "typing into To: the To recipients box (\(field)) beats the To label (\(label))")
check(ActMath.adjust(100, role: "AXButton") > ActMath.adjust(100, role: "AXStaticText"), "a button beats its text")
check(ActMath.adjust(100, role: "AXButton", enabled: false) < ActMath.adjust(100, role: "AXButton"), "disabled loses")
check(ActMath.shouldClimb("AXStaticText") && ActMath.shouldClimb("AXImage") && !ActMath.shouldClimb("AXButton"), "climb from text and icons, not from buttons")
let word = CGRect(x: 100, y: 100, width: 60, height: 18)
check(ActMath.plausibleContainer(word, CGRect(x: 90, y: 94, width: 120, height: 30)), "a button around its word")
check(!ActMath.plausibleContainer(word, CGRect(x: 0, y: 0, width: 1400, height: 900)), "not the whole page around it")
check(!ActMath.plausibleContainer(word, CGRect(x: 400, y: 400, width: 60, height: 20)), "not something elsewhere")
check(ActMath.scope(nil, bundle: "com.google.Chrome") == "page", "Chrome: the page by default")
check(ActMath.scope("browser", bundle: "com.google.Chrome") == "browser", "the browser's own controls when asked")
// Scope "page" never reaches the tab strip: a tab titled "Compose Mail" is not Gmail's Compose.
check(ActMath.scope("page", bundle: nil) == "page", "page stays page when the app isn't known yet")
check(ActMath.scope("page", bundle: "com.apple.mail") == "app", "page means the app in a known non-browser")
check(ActMath.isBrowserChrome(role: "AXTabGroup", subrole: ""), "the tab strip is the browser's")
check(ActMath.isBrowserChrome(role: "AXRadioButton", subrole: "AXTabButton"), "a tab is the browser's")
check(ActMath.isBrowserChrome(role: "AXToolbar", subrole: ""), "the toolbar is the browser's")
check(!ActMath.isBrowserChrome(role: "AXButton", subrole: ""), "a page's button is not")
let webPage = CGRect(x: 0, y: 0, width: 1512, height: 860) // below Chrome's tabs and toolbar (y 860-950)
check(!ActMath.onPage(CGRect(x: 200, y: 930, width: 120, height: 16), page: webPage), "a tab title read off the screen is not on the page")
check(ActMath.onPage(CGRect(x: 20, y: 780, width: 90, height: 30), page: webPage), "Gmail's Compose button is")
check(!ActMath.onPage(CGRect(x: 20, y: 780, width: 90, height: 30), page: nil), "no known page: nothing read off the screen counts")
check(ActMath.scope(nil, bundle: "com.apple.finder") == "app", "other apps: their windows")
check(ActMath.scope("page", bundle: "com.apple.finder") == "app", "no page outside a browser")
check(ActMath.modifiers("Shift, cmd") == ["shift", "cmd"] && ActMath.modifiers("command+option") == ["opt", "cmd"] && ActMath.modifiers("x").isEmpty, "modifier names")

// Clean key events: real key codes for text, line breaks as Return, never a modifier.
check(KeyMath.code(for: "m") == 46 && KeyMath.code(for: "M") == 46, "M rides on the M key")
check(KeyMath.code(for: "é") == 0 && KeyMath.code(for: "ab") == 0, "no key for other text")
check(KeyMath.pieces("Hi\nthere\tyou") == [.text("Hi"), .softBreak, .text("there"), .key(48), .text("you")], "line breaks (Shift+Return) and tabs are real keys")
check(KeyMath.pieces("\n") == [.softBreak], "a lone line break never sends a chat message")
check(KeyMath.pieces("ls\npwd", returnBreaks: true) == [.text("ls"), .key(36), .text("pwd")], "in a terminal, Return")
check(KeyMath.pieces("Before I do:\n1. Give me") == [.text("Before I do:"), .softBreak, .text("1. Give me")], "the Oct 2 message stays one message")
check(KeyMath.returnApps.contains("com.apple.Terminal") && !KeyMath.returnApps.contains("com.anthropic.claudefordesktop"), "terminals only")

// Verification: what changed, and whether typed text landed.
var snapA = VerifyMath.Snapshot(focusRole: "AXTextField", focusLabel: "Search", window: "Inbox", windows: 1, signature: 7)
var snapB = snapA
check(VerifyMath.changes(snapA, snapB).isEmpty, "nothing changed")
snapB.signature = 9
snapB.windows = 2
check(VerifyMath.changes(snapA, snapB) == ["windows", "content"], "a new window and new content")
snapB = snapA
snapB.menuOpen = true
check(VerifyMath.changes(snapA, snapB) == ["menu_opened"], "a menu opened")
check(VerifyMath.typed("Meet Echo", into: "Meet Echo"), "typed text is there")
check(!VerifyMath.typed("sam@example.com", into: ""), "an empty To field is not success")
check(VerifyMath.typed("hello  world", into: "Well, hello world\u{200B}"), "spaces and zero-width characters don't matter")
check(!VerifyMath.typed("Hi Sam!", into: "TomasaTomasa"), "wrong text")
check(VerifyMath.typed("github", into: "github.com/", replaced: true, suggested: ".com/"), "an address bar's own guess (selected) after the typed text is fine")
check(!VerifyMath.typed("github", into: "github.com/", replaced: true), "without that guess selected, extra text is not what was typed")
check(!VerifyMath.typed("github", into: "githab.com/", replaced: true, suggested: ".com/"), "the typed part must still be exact")
check(KeyMath.returnApps.contains("com.apple.iWork.Numbers") && KeyMath.returnApps.contains("com.microsoft.Excel"), "spreadsheets: a line break is the next row (Return)")
check(VerifyMath.typed("", into: "", replaced: true) && !VerifyMath.typed("", into: "old", replaced: true), "clearing a field: it's empty after")
let longText = String(repeating: "word ", count: 30) + "the end of it"
check(!VerifyMath.typed(longText, into: "(autocorrected start) " + String(longText.suffix(60))), "a long text: all of it must be there, not just its end")
check(VerifyMath.typed(longText, into: longText), "a long text, whole")
check(!VerifyMath.typed("Hello Sam", into: "Hello Sam, hi", replaced: true), "replacing: exactly that, nothing more")
check(VerifyMath.typed("Hello Sam", into: "Hello  Sam", replaced: true), "replacing: spaces squeezed")
check(!VerifyMath.typed("Meet Echo", into: "Meet Echo", before: "Meet Echo"), "adding: text that was already there doesn't count")
check(VerifyMath.typed(" today", into: "Meet Echo today", before: "Meet Echo"), "adding: the field grew by the text")
check(VerifyMath.typed("Hi", into: "Hi", before: ""), "adding to an empty field")

// The finishing touches: shape-true rings, key caps.
let fieldBox = CGRect(x: 0, y: 0, width: 240, height: 28)
check(TouchMath.corner(role: "AXSearchField", frame: fieldBox) == 14, "a search field is round-ended")
check(TouchMath.corner(role: "AXTextField", frame: fieldBox) == 7, "a text field has soft corners")
check(TouchMath.corner(role: "AXLink", frame: fieldBox) == 4, "a link is nearly square")
check(TouchMath.corner(role: "AXRadioButton", frame: CGRect(x: 0, y: 0, width: 16, height: 16)) == 8, "a radio button is a circle")
check(TouchMath.glyphs("cmd+shift+t") == ["⌘", "⇧", "T"], "key caps")
check(TouchMath.glyphs("return") == ["↩"] && TouchMath.glyphs("cmd+[") == ["⌘", "["], "Return and brackets")

// The island's reply field: the chip beside the island, the field under it, on its screen.
do {
  let visible = CGRect(x: 1512, y: -120, width: 1920, height: 975) // the right-hand display, Dock below
  let pill = PillMath.frame(visible: visible, width: 300)
  let chip = PillMath.replyChip(pill: pill, visible: visible)
  check(chip.minX > pill.maxX && abs(chip.midY - pill.midY) < 1, "the chip sits just right of the island")
  check(visible.contains(chip), "on the island's screen")
  let field = PillMath.replyField(pill: pill, visible: visible)
  check(field.maxY <= pill.minY && !field.intersects(pill), "the field opens under the island, never over it")
  check(abs(field.midX - pill.midX) < 1 && visible.contains(field), "centred on the island, on its screen")
  let grown = CGRect(x: pill.minX, y: pill.maxY - 150, width: pill.width, height: 150)
  check(PillMath.replyField(pill: grown, visible: visible).maxY <= grown.minY, "under the card when it has grown")
  check(abs(PillMath.replyChip(pill: grown, visible: visible).midY - (grown.maxY - PillMath.height / 2)) < 1, "the chip stays level with the top row")
  let low = CGRect(x: pill.minX, y: visible.minY + 14, width: pill.width, height: PillMath.height)
  let over = PillMath.replyField(pill: low, visible: visible)
  check(over.minY >= low.maxY && visible.contains(over), "an island at the very bottom: the field goes above it")
  let edge = CGRect(x: visible.maxX - 60, y: pill.minY, width: 50, height: PillMath.height)
  check(PillMath.replyChip(pill: edge, visible: visible).maxX <= edge.minX, "no room on the right: the chip goes left")
}

// Lessons: which control a step's label names.
do {
  let names = ["Bold Italic", "Bold", "Wi-Fi, Connected", "Turn Wi-Fi Off", "Font Size…", "Show Sidebar"]
  check(StateMath.match("Bold", names: names) == 1, "an exact name wins over a longer one")
  check(StateMath.match("wi-fi", names: names) == 2, "a name starting with the label, case-insensitive")
  check(StateMath.match("Font Size", names: names) == 4, "an ellipsis doesn't matter")
  check(StateMath.match("Sidebar", names: names) == 5, "a whole word inside a name")
  check(StateMath.match("Side", names: names) == nil, "part of a word is not a match")
  check(StateMath.match("", names: names) == nil, "no label, no match")
}

// Looking at just the window you're in.
let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
let win = CGRect(x: 200, y: 150, width: 800, height: 600)
check(PointMath.windowArea(win, display: display) == CGRect(x: 176, y: 126, width: 848, height: 648), "the window and a margin")
check(PointMath.windowArea(CGRect(x: 0, y: 0, width: 1512, height: 950), display: display) == nil, "a window filling the screen: the whole screen")
check(PointMath.windowArea(CGRect(x: 10, y: 10, width: 100, height: 80), display: display) == nil, "a tiny window: the whole screen")
check(PointMath.windowArea(CGRect(x: 1100, y: 100, width: 600, height: 500), display: display)?.maxX == 1512, "clamped to the display")
let px = PointMath.cropPixels(CGRect(x: 176, y: 126, width: 848, height: 648), display: display, scale: 2)
check(px == CGRect(x: 352, y: 416, width: 1696, height: 1296), "as pixels, top-left origin: \(px)")
// A point found in the cropped picture maps back onto the screen inside the window.
let back = PointMath.imageToScreen(CGRect(x: 424, y: 324, width: 0, height: 0), display: CGRect(x: 176, y: 126, width: 848, height: 648), imageSize: CGSize(width: 848, height: 648))
check(abs(back.minX - 600) < 0.5 && abs(back.minY - 450) < 0.5, "the middle of the crop is the middle of the window: \(back)")

// The shortcuts an app's menus list (MenuMath).
check(MenuMath.normal("cmd+shift+N") == "shift+cmd+n", "one order: \(MenuMath.normal("cmd+shift+N"))")
check(MenuMath.normal("cmd+t") == "cmd+t", "plain")
check(MenuMath.combo(char: "N", mods: 0) == "cmd+n", "⌘N")
check(MenuMath.combo(char: "N", mods: 1) == "shift+cmd+n", "⇧⌘N")
check(MenuMath.combo(char: "F", mods: 6) == "ctrl+opt+cmd+f", "⌃⌥⌘F")
check(MenuMath.combo(char: "Q", mods: 8) == "q", "no Command")
check(MenuMath.combo(char: "", mods: 0) == nil, "no shortcut")

// Oct 3, Excel: "type Hello into A1 and make it bold" took 18 steps. The causes, as pure rules.
// Typing is always checked exactly: the session's formula bar ended up holding "HellohelloHello"
// and the step said verified.
check(!VerifyMath.typed("Hello", into: "HellohelloHello", replaced: true), "replace mode: old text left in the field is not what was asked for")
check(!VerifyMath.typed("Hello", into: "helloHello", replaced: true), "nor is the text added after the old one")
check(VerifyMath.typed("Hello", into: "helloHello", before: "hello"), "adding: the field grew by the text")
check(!VerifyMath.typed("Hello", into: "Hello", before: "Hello"), "adding: a field that held it already did not take the typing")
// Nothing is typed twice into a field that already says it.
check(VerifyMath.already("Hello", in: "hello", replace: false) == .otherCase, "it already says hello; Hello was asked for: the assistant decides")
check(VerifyMath.already("Hello", in: "Hello", replace: false) == .same, "it already says exactly that")
check(VerifyMath.already("Hello", in: " Hello\u{200B} ", replace: true) == .same, "replacing with what's there: nothing to do")
check(VerifyMath.already("Hello", in: "hello", replace: true) == .no, "an asked-for replace fixes the capitals")
check(VerifyMath.already("Hello", in: "hello there", replace: false) == .no, "more text than that: typing goes ahead")
check(VerifyMath.already("Hello", in: "", replace: false) == .no && VerifyMath.already("", in: "", replace: true) == .no, "an empty field, or nothing to type")
// Emptying a field before typing over it: never ⌘A in a spreadsheet (it selects the cells).
check(ClearMath.plan(sheet: true, web: false, rangeSettable: false, valueSettable: true) == [.setEmpty, .ends], "Excel's formula bar: set to nothing, else ⌘↑ ⇧⌘↓")
check(!ClearMath.plan(sheet: true, web: false, rangeSettable: true, valueSettable: true).contains(.selectAll), "a spreadsheet: no ⌘A, whatever the field allows")
check(ClearMath.plan(sheet: false, web: false, rangeSettable: true, valueSettable: true) == [.range, .selectAll, .setEmpty, .ends], "a native field: its own selection first")
check(ClearMath.plan(sheet: false, web: true, rangeSettable: true, valueSettable: true) == [.selectAll, .ends], "a web page: keys only")
check(!ClearMath.mayDelete(sheet: true, selected: nil, count: 5) && !ClearMath.mayDelete(sheet: true, selected: 0, count: 5), "a spreadsheet: no Delete on a selection Echo can't see")
check(ClearMath.mayDelete(sheet: true, selected: 5, count: 5) && ClearMath.mayDelete(sheet: false, selected: nil, count: 5), "the whole text selected, or an ordinary app")
check(ClearMath.isEmpty("") && ClearMath.isEmpty(" \u{200B}") && ClearMath.isEmpty("Search", placeholder: "Search") && !ClearMath.isEmpty("hello", placeholder: "Search"), "empty: nothing, or only the placeholder")
// Cell references.
check(SheetMath.cellRef("A1") == "A1" && SheetMath.cellRef("b12") == "B12" && SheetMath.cellRef("AA3") == "AA3", "A1, b12, AA3")
check(SheetMath.cellRef("cell A1") == "A1" && SheetMath.cellRef(" Cell  c4 ") == "C4" && SheetMath.cellRef("$C$4") == "C4", "\"cell A1\", $C$4")
check(SheetMath.cellRef("XFD1048576") == "XFD1048576" && SheetMath.cellRef("XFE1") == nil && SheetMath.cellRef("A1048577") == nil, "the last cell of a sheet, and nothing past it")
for no in ["Save", "A", "12", "A0", "A01", "Q4 results", "A1:B2", "ABCD1", "Name Box", "", "cell", "A 1", "Á1"] {
  check(SheetMath.cellRef(no) == nil, "not a cell reference: \"\(no)\"")
}
// The grid takes typing, in spreadsheets only.
check(SheetMath.isSheet("com.microsoft.Excel") && SheetMath.isSheet("com.apple.iWork.Numbers") && !SheetMath.isSheet("com.apple.Notes") && !SheetMath.isSheet(nil), "Excel and Numbers")
check(SheetMath.typable(role: "AXLayoutArea", label: "Content Area", bundle: SheetMath.excel), "Excel's grid (the session's focus_guard)")
check(SheetMath.typable(role: "AXCell", label: "A1", bundle: SheetMath.numbers) && SheetMath.typable(role: "AXTable", label: "Table 1", bundle: SheetMath.numbers), "a table and its cells in Numbers")
check(SheetMath.typable(role: "AXGroup", label: "content area", bundle: SheetMath.excel), "the element titled Content Area, whatever its role")
check(!SheetMath.typable(role: "AXTable", label: "Files", bundle: "com.apple.finder") && !SheetMath.typable(role: "AXButton", label: "Bold", bundle: SheetMath.excel), "not a table elsewhere, not a button in Excel")
check(SheetMath.part(role: "AXComboBox", label: "Name Box") == .nameBox && SheetMath.part(role: "AXTextArea", label: "Formula Bar") == .formulaBar, "the name box and the formula bar")
check(SheetMath.part(role: "AXLayoutArea", label: "Content Area") == .grid && SheetMath.part(role: "AXGroup", label: "Formula Bar") == nil && SheetMath.part(role: "AXTextField", label: "Search") == nil, "the grid; a group around the bar is not the bar")
// Keys in the grid: add to a cell, enter and stay, go to.
check(SheetMath.editKeys(SheetMath.excel) == "ctrl+u" && SheetMath.editKeys(SheetMath.numbers) == "opt+return" && SheetMath.editKeys("com.apple.Notes") == nil, "editing in the cell")
check(SheetMath.commitKeys(SheetMath.excel) == "ctrl+return" && SheetMath.commitKeys(SheetMath.numbers) == "cmd+return", "enter and keep the cell selected")
check(SheetMath.goToKeys(SheetMath.excel) == "ctrl+g" && SheetMath.goToKeys(SheetMath.numbers) == nil, "Go To is Excel's")
check(SheetMath.lastEntry("Hello") == ("Hello", false) && SheetMath.lastEntry("a\tb\tc") == ("c", true) && SheetMath.lastEntry("a\nb\n") == ("", true), "what the selected cell holds after typing")
check(SheetMath.formatControl("cmd+b") == "Bold" && SheetMath.formatControl("Cmd+I") == "Italic" && SheetMath.formatControl("cmd+u") == "Underline" && SheetMath.formatControl("shift+cmd+b") == nil, "the control that shows a formatting shortcut's state")

// The caption beside the light: its words.
check(BubbleMath.phrase() == "This one" && BubbleMath.phrase(action: "click", target: "Send") == "Clicking Send" && BubbleMath.phrase(action: "click") == "Clicking here", "a pure point, a click, a click with no name")
check(BubbleMath.phrase(action: "type_text", target: "Subject") == "Typing in Subject" && BubbleMath.phrase(action: "type_text") == "Typing here", "typing says where, never what")
check(BubbleMath.phrase(action: "scroll", direction: "down") == "Scrolling down" && BubbleMath.phrase(action: "scroll", direction: "sideways") == "Scrolling", "a scroll and its direction")
check(BubbleMath.phrase(action: "drag", target: "Draft", to: "Trash") == "Dragging to Trash" && BubbleMath.phrase(action: "drag", target: "Draft") == "Dragging Draft", "a drag says where it ends")
check(BubbleMath.phrase(action: "click", target: "“Export…”") == "Clicking Export" && BubbleMath.phrase(target: "Export…", moment: .searching) == "Looking for Export…" && BubbleMath.phrase(moment: .searching) == "Looking…", "quote marks and a menu item's own dots are dropped; searching")
check(BubbleMath.phrase(caption: "Opening the  File menu\n", action: "click", target: "File") == "Opening the File menu", "the step's own narration comes first, on one line")
check(BubbleMath.phrase(caption: "Opening Mail", action: "click", target: "Send", moment: .waiting) == "Your turn" && BubbleMath.phrase(caption: "Sending it", action: "click", moment: .asking) == "Is this OK?", "a lesson's wait and an ask say their own thing")
check(BubbleMath.phrase(caption: "Typing hunter2 in Password", action: "type_text", target: "hunter2", secure: true) == "Typing in a password field" && BubbleMath.phrase(action: "click", target: "Bank PIN", secure: true) == "Clicking a password field", "a password field is only ever called that")
let longName = BubbleMath.phrase(action: "type_text", target: "Quarterly report figures final version 3")
check(longName == "Typing in Quarterly repor…inal version 3" && longName.count == BubbleMath.maxChars, "a long name is cut in the middle: \(longName)")
check(BubbleMath.middle("Send", max: 10) == "Send" && BubbleMath.middle("abcdefghij", max: 7) == "abc…hij" && BubbleMath.middle("abcdefghij", max: 3) == "ab…", "the middle cut")
let longSaid = BubbleMath.phrase(caption: String(repeating: "word ", count: 12))
check(longSaid.count <= BubbleMath.maxChars && longSaid.hasSuffix("…") && !longSaid.contains("\n"), "long narration is cut at the end: \(longSaid)")
for a in ["click", "type_text", "clear_field", "hover", "drag", "scroll", ""] {
  let t = BubbleMath.phrase(action: a, target: String(repeating: "Name of a very long thing ", count: 6), to: a == "drag" ? String(repeating: "Somewhere far ", count: 6) : "")
  check(t.count <= BubbleMath.maxChars && !t.isEmpty, "never more than 40 characters (\(a)): \(t.count)")
}
// How long it stays.
check(BubbleMath.hold("Your turn") == 2.2 && abs(BubbleMath.hold(String(repeating: "a", count: 40)) - 2.4) < 1e-9 && BubbleMath.hold(String(repeating: "a", count: 200)) == 5 && BubbleMath.fadeOut == 0.25, "2.2 s, 60 ms a character, 5 s at most; out over 250 ms")
// Where it goes. A 1512×982 screen without its menu bar; a button mid-screen with the light at rest on its top edge.
let capScreen = CGRect(x: 0, y: 0, width: 1512, height: 944), capSize = BubbleMath.size(textWidth: 80)
func capRect(_ target: CGRect, light: CGPoint? = nil, avoiding: [CGRect] = [], size: CGSize = capSize, bounds: CGRect = capScreen) -> CGRect {
  CGRect(origin: BubbleMath.origin(target: target, light: light ?? PearlMath.orbit(target, laps: 0), size: size, bounds: bounds, avoiding: avoiding), size: size)
}
func capClear(_ r: CGRect, of target: CGRect, bounds: CGRect = capScreen) -> Bool {
  bounds.insetBy(dx: BubbleMath.margin - 1, dy: BubbleMath.margin - 1).contains(r) && !r.intersects(target.insetBy(dx: -BubbleMath.clear + 1, dy: -BubbleMath.clear + 1))
}
let capButton = CGRect(x: 600, y: 400, width: 84, height: 28)
let capAbove = capRect(capButton)
check(capSize.height == BubbleMath.height && capSize.width == BubbleMath.padLeft + 80 + BubbleMath.padRight, "its size")
check(capAbove.minY >= capButton.maxY + BubbleMath.clear && capClear(capAbove, of: capButton) && abs(capAbove.minX - (PearlMath.orbit(capButton, laps: 0).x - 14)) <= 1, "the light rests on the top edge: the caption goes above it: \(capAbove)")
// Asking, the light hovers beside the thing: the caption goes on beyond it.
let capHover = PearlMath.hover(beside: capButton, in: capScreen), capBeside = capRect(capButton, light: capHover)
check(capBeside.minX >= capHover.x + BubbleMath.gap - 1 && abs(capBeside.midY - capHover.y) <= 1 && capClear(capBeside, of: capButton), "beside a hovering light, away from the thing: \(capBeside)")
// At the right edge of the screen it slides back on, still above the thing.
let capEdge = CGRect(x: 1420, y: 400, width: 84, height: 28), capSlid = capRect(capEdge)
check(capSlid.maxX <= capScreen.maxX - BubbleMath.margin + 0.5 && capSlid.minY >= capEdge.maxY + BubbleMath.clear && capClear(capSlid, of: capEdge), "at the right edge: \(capSlid)")
// Asking at the right edge: the light hovers on the left of the thing, and the caption goes further left.
let capEdgeHover = PearlMath.hover(beside: capEdge, in: capScreen), capLeft = capRect(capEdge, light: capEdgeHover)
check(capEdgeHover.x < capEdge.minX && capLeft.maxX <= capEdgeHover.x - BubbleMath.gap + 1 && capClear(capLeft, of: capEdge), "flipped to the left: \(capLeft)")
// A menu bar item (above the usable screen): the caption goes under it, never on the menu bar.
let capMenu = CGRect(x: 200, y: 950, width: 44, height: 22), capUnder = capRect(capMenu)
check(capUnder.maxY <= capScreen.maxY - BubbleMath.margin + 0.5 && capUnder.maxY <= capMenu.minY - BubbleMath.clear + 0.5, "under the menu bar: \(capUnder)")
// The island is in the way above: under the thing instead.
let capIsland = CGRect(x: 520, y: 430, width: 400, height: 60), capFlip = capRect(capButton, avoiding: [capIsland])
check(!capFlip.intersects(capIsland) && capFlip.maxY <= capButton.minY - BubbleMath.clear + 0.5 && capClear(capFlip, of: capButton), "off the island: \(capFlip)")
// A thing at the bottom-left corner, and one that fills the screen: always on the screen.
let capCorner = CGRect(x: 4, y: 4, width: 60, height: 24)
check(capClear(capRect(capCorner), of: capCorner), "in the bottom-left corner: \(capRect(capCorner))")
let capHuge = capRect(capScreen.insetBy(dx: 20, dy: 20))
check(capScreen.insetBy(dx: BubbleMath.margin - 1, dy: BubbleMath.margin - 1).contains(capHuge), "a thing that fills the screen: still on it: \(capHuge)")
// Under the searching loop.
let capLoop = PearlMath.searchBox(around: CGPoint(x: 700, y: 500)), capSearch = capRect(capLoop, light: CGPoint(x: capLoop.midX, y: capLoop.minY))
check(capLoop == CGRect(x: 672, y: 489, width: 56, height: 22) && capSearch.maxY <= capLoop.minY - BubbleMath.clear + 0.5, "under the searching loop: \(capSearch)")
// Wherever the thing is on the screen: the caption is on the screen, and never over it.
for x in stride(from: CGFloat(0), through: 1440, by: 90) {
  for y in stride(from: CGFloat(0), through: 930, by: 62) {
    let t = CGRect(x: x, y: y, width: 70, height: 24).intersection(CGRect(x: 0, y: 0, width: 1512, height: 982)), r = capRect(t)
    check(capScreen.insetBy(dx: BubbleMath.margin - 1, dy: BubbleMath.margin - 1).contains(r) && !r.intersects(t), "anywhere on the screen: on it, and never over the thing (\(t) → \(r))")
  }
}

// How long the light shows a thing it is only pointing at: longer when it is small or crowded.
do {
  let big = CGRect(x: 300, y: 300, width: 160, height: 44), small = CGRect(x: 300, y: 300, width: 20, height: 20)
  let window = CGRect(x: 0, y: 0, width: 1400, height: 900)
  let easy = PearlMath.show(big), hard = PearlMath.show(small), crowded = PearlMath.show(big, rivals: 2)
  check(easy.laps == 2 && easy.seconds >= 2 && easy.seconds < 2.6, "a large thing on its own: twice round, about 2 seconds (\(easy))")
  check(hard.laps == easy.laps + 1 && hard.seconds >= 3 && hard.seconds <= 4, "a small one: once more round, 3 to 4 seconds (\(hard))")
  check(crowded.laps == easy.laps + 1 && crowded.seconds >= 3 && crowded.seconds <= 4, "one with look-alikes beside it: the same (\(crowded))")
  check(PearlMath.show(big, rivals: 1).laps == easy.laps, "one runner-up is not a crowd")
  check(PearlMath.show(CGRect(x: 0, y: 0, width: 28, height: 28)).laps == easy.laps && PearlMath.show(CGRect(x: 0, y: 0, width: 200, height: 27)).laps == PearlMath.show(CGRect(x: 0, y: 0, width: 200, height: 28)).laps + 1, "small is under 28 pt on its short side")
  let wide = PearlMath.show(window), wideCrowded = PearlMath.show(window, rivals: 3)
  check(wide.laps == 1 && wide.seconds == 2.6 && wideCrowded.laps == 2 && wideCrowded.seconds == 4, "something huge: once round is enough; never held past 4 seconds (\(wide), \(wideCrowded))")

  // The finder's runners-up: nearly as good a match, close by, and not the thing itself.
  let best = CGRect(x: 400, y: 400, width: 80, height: 24)
  let others: [(score: Int, frame: CGRect)] = [
    (100, best), // itself
    (100, CGRect(x: 410, y: 404, width: 40, height: 14)), // the text inside it
    (95, CGRect(x: 400, y: 360, width: 80, height: 24)), // a look-alike just below
    (88, CGRect(x: 500, y: 400, width: 80, height: 24)), // and one beside it
    (60, CGRect(x: 400, y: 320, width: 80, height: 24)), // a much weaker match
    (100, CGRect(x: 1200, y: 40, width: 80, height: 24)), // as good, but far away
  ]
  check(PearlMath.rivals(of: best, score: 100, among: others) == 2, "two look-alikes beside it count; itself, a weak match and a far one do not")
  check(PearlMath.rivals(of: best, score: 100, among: []) == 0, "nothing else matched: no rivals")
}

// Did the point land? Your mouse going to rest somewhere else brings the light round again.
do {
  let thing = CGRect(x: 1000, y: 600, width: 60, height: 24), start = CGPoint(x: 700, y: 400)
  /// The mouse goes from `start` to `p` over half a second, then rests; looked at 20 times a second.
  func run(_ w: inout PearlMath.Landed, to p: CGPoint, from t0: Double, rest: Double = 1, held: Bool = false, at a: CGPoint = start) -> [Double] {
    var nudges: [Double] = [], t = t0
    while t < t0 + 0.5 + rest {
      let k = min(1, (t - t0) / 0.5)
      if w.look(mouse: CGPoint(x: a.x + (p.x - a.x) * k, y: a.y + (p.y - a.y) * k), target: thing, now: t, held: held) { nudges.append(t) }
      t += 0.05
    }
    return nudges
  }
  var w = PearlMath.Landed()
  check(!w.watching && !w.look(mouse: start, target: thing, now: 0, held: false), "nothing is watched before the glance")
  w.begin(mouse: start, now: 0)
  let away = run(&w, to: CGPoint(x: 200, y: 200), from: 0.2)
  check(away.count == 1 && away[0] >= 0.7 + PearlMath.Landed.still - 0.06 && away[0] < 1.3, "the mouse went and rested somewhere else: point again, once it has been still 400 ms (\(away))")
  check(run(&w, to: CGPoint(x: 100, y: 800), from: 2, at: CGPoint(x: 200, y: 200)).isEmpty, "only once for a plain point")

  w.begin(mouse: start, now: 0)
  check(run(&w, to: CGPoint(x: 880, y: 520), from: 0.2).isEmpty, "on its way to the thing (still far from it): it landed")
  w.begin(mouse: start, now: 0)
  check(run(&w, to: CGPoint(x: 1010, y: 610), from: 0.2).isEmpty, "the mouse went to the thing: it landed")
  w.begin(mouse: start, now: 0)
  check(run(&w, to: CGPoint(x: 720, y: 410), from: 0.2).isEmpty, "the mouse barely moved: nothing to go on")
  w.begin(mouse: start, now: 0)
  check(run(&w, to: start, from: 0.2, rest: 5).isEmpty, "a mouse that never moves says nothing")
  w.begin(mouse: CGPoint(x: 900, y: 500), now: 0)
  check(run(&w, to: CGPoint(x: 1150, y: 500), from: 0.2, at: CGPoint(x: 900, y: 500)).isEmpty, "resting near the thing (within 250 pt) is not somewhere else")
  w.begin(mouse: start, now: 0)
  check(run(&w, to: CGPoint(x: 200, y: 200), from: 4.2).isEmpty, "after 4 seconds a plain point is no longer checked")

  // A light waiting on a lesson step: again each time the mouse wanders off, 12 s apart at most.
  w.begin(mouse: start, now: 0)
  let first = run(&w, to: CGPoint(x: 200, y: 200), from: 6, held: true)
  check(first.count == 1, "waiting on a step: no 4 second limit (\(first))")
  check(run(&w, to: CGPoint(x: 100, y: 800), from: 9, held: true, at: CGPoint(x: 200, y: 200)).isEmpty, "not again within 12 seconds")
  let again = run(&w, to: CGPoint(x: 300, y: 100), from: 17, rest: 3, held: true, at: CGPoint(x: 100, y: 800))
  check(again.count == 1 && again[0] >= first[0] + PearlMath.Landed.every, "but again after that, when the mouse wanders off once more (\(again))")
}

// "Your turn" and "Is this OK?" stay for as long as the light waits; the other captions fade.
check(PearlMath.captionStays(waiting: true, intent: "show") && PearlMath.captionStays(waiting: false, intent: "ask") && PearlMath.captionStays(waiting: true, intent: "ask")
  && !PearlMath.captionStays(waiting: false, intent: "show") && !PearlMath.captionStays(waiting: false, intent: "act"), "a waiting light's caption stays; a step's fades")

// Where a found thing is, in words (PlaceMath): which ninth of its window, by its centre.
do {
  let w = CGRect(x: 100, y: 200, width: 900, height: 600) // AppKit: y goes up, so its top is y 800
  let at = { (x: CGFloat, y: CGFloat) in PlaceMath.region(CGRect(x: x - 10, y: y - 10, width: 20, height: 20), in: w) }
  check(at(150, 780) == "top left" && at(550, 780) == "top" && at(950, 780) == "top right", "the top row: \(at(150, 780)), \(at(550, 780)), \(at(950, 780))")
  check(at(150, 500) == "left" && at(550, 500) == "middle" && at(950, 500) == "right", "the middle row")
  check(at(150, 220) == "bottom left" && at(550, 220) == "bottom" && at(950, 220) == "bottom right", "the bottom row")
  // The thirds: x 400 and 700, y 400 and 600. Just inside each line is still the edge's third.
  check(at(399, 500) == "left" && at(401, 500) == "middle" && at(699, 500) == "middle" && at(701, 500) == "right", "left and right end at the thirds")
  check(at(550, 399) == "bottom" && at(550, 401) == "middle" && at(550, 599) == "middle" && at(550, 601) == "top", "top and bottom end at the thirds")
  // At the window's very edges and corners, and half off them.
  check(PlaceMath.region(CGRect(x: 100, y: 780, width: 20, height: 20), in: w) == "top left", "flush in the top left corner")
  check(PlaceMath.region(CGRect(x: 980, y: 200, width: 20, height: 20), in: w) == "bottom right", "flush in the bottom right corner")
  check(PlaceMath.region(CGRect(x: 60, y: 900, width: 20, height: 20), in: w) == "top left", "outside the window counts as at that edge")
  check(PlaceMath.region(CGRect(x: 1200, y: 100, width: 20, height: 20), in: w) == "bottom right", "outside, the other way")
  // A thing as wide as the window is neither left nor right; as big as the window, the middle.
  check(PlaceMath.region(CGRect(x: 100, y: 760, width: 900, height: 40), in: w) == "top", "a strip along the top is just the top")
  check(PlaceMath.region(w, in: w) == "middle", "the whole window is the middle")
  // A window on a display to the left of the primary one (negative x), and one below it.
  check(PlaceMath.region(CGRect(x: -1900, y: -150, width: 30, height: 30), in: CGRect(x: -1920, y: -200, width: 1000, height: 700)) == "bottom left", "a window at negative coordinates")
  // Tiny windows: a real size still has thirds; none at all has only a middle.
  let tiny = CGRect(x: 0, y: 0, width: 30, height: 30)
  check(PlaceMath.region(CGRect(x: 0, y: 24, width: 6, height: 6), in: tiny) == "top left" && PlaceMath.region(CGRect(x: 12, y: 12, width: 6, height: 6), in: tiny) == "middle", "a 30 point window still has corners")
  check(PlaceMath.region(CGRect(x: 0, y: 0, width: 6, height: 6), in: CGRect(x: 0, y: 0, width: 0.5, height: 0.5)) == "middle", "a window with no size: the middle")
  check(PlaceMath.region(CGRect(x: 0, y: 0, width: 6, height: 6), in: .zero) == "middle" && PlaceMath.region(CGRect(x: 0, y: 0, width: 6, height: 6), in: .null) == "middle", "no window at all: the middle")
  check(PlaceMath.region(CGRect(x: CGFloat.nan, y: 0, width: 6, height: 6), in: w) == "middle" && PlaceMath.region(.null, in: w) == "middle", "a frame that isn't a place: the middle")

  // What kind of thing, in a plain word.
  check(PlaceMath.kind(role: "AXButton") == "button" && PlaceMath.kind(role: "AXButton", titled: false) == "icon" && PlaceMath.kind(role: "AXImage") == "icon", "a button; one with no title is an icon")
  check(PlaceMath.kind(role: "AXMenuBarItem") == "menu" && PlaceMath.kind(role: "AXPopUpButton") == "menu" && PlaceMath.kind(role: "AXMenuButton") == "menu", "menus")
  check(PlaceMath.kind(role: "AXTextField") == "field" && PlaceMath.kind(role: "AXSearchField") == "field" && PlaceMath.kind(role: "AXComboBox") == "field", "fields")
  check(PlaceMath.kind(role: "AXRadioButton", subrole: "AXTabButton") == "tab" && PlaceMath.kind(role: "AXCheckBox") == "checkbox", "a tab, a checkbox")
  check(PlaceMath.kind(role: "AXCheckBox", subrole: "AXSwitch") == "" && PlaceMath.kind(role: "AXLink") == "" && PlaceMath.kind(role: "AXMenuItem") == "" && PlaceMath.kind(role: "") == "", "anything else has no word")

  // The named part of the window it sits in.
  check(PlaceMath.container(role: "AXToolbar") == "toolbar" && PlaceMath.container(role: "AXMenuBar") == "menu bar" && PlaceMath.container(role: "AXSheet") == "dialog", "toolbar, menu bar, dialog")
  check(PlaceMath.container(role: "AXWindow", subrole: "AXDialog") == "dialog" && PlaceMath.container(role: "AXWindow", subrole: "AXStandardWindow") == nil, "a dialog window is one; a plain window isn't")
  check(PlaceMath.container(role: "AXTabGroup", kind: "tab") == "tab bar" && PlaceMath.container(role: "AXTabGroup", kind: "button") == nil, "a tab group is the tab bar only for its tabs")
  check(PlaceMath.container(role: "AXOutline", subrole: "AXSourceList") == "sidebar" && PlaceMath.container(role: "AXOutline", name: "Sidebar") == "sidebar" && PlaceMath.container(role: "AXScrollArea", name: "sidebar") == "sidebar", "a sidebar by its kind or its name")
  check(PlaceMath.container(role: "AXOutline", name: "Messages") == nil && PlaceMath.container(role: "AXGroup") == nil && PlaceMath.container(role: "AXButton", name: "Show Sidebar") == nil, "a list or group by another name is nothing; nor a button named for the sidebar")
  check(PlaceMath.ends(role: "AXWindow") && PlaceMath.ends(role: "AXMenu") && !PlaceMath.ends(role: "AXGroup") && !PlaceMath.ends(role: "AXToolbar"), "the walk up ends at a window or a menu")
}

// The permissions checklist (PermMath): which rows, their words, what is required, the overall
// state, each row's button, what is noted on the timeline, and where things sit.
do {
  let rows = PermMath.rows(screen: true, speech: true)
  check(rows.map(\.id) == ["microphone", "accessibility", "screen", "input", "speech"], "the five rows, in the order they are asked for")
  check(rows.filter(\.required).map(\.id) == ["microphone", "accessibility"], "the microphone and Accessibility are required; the rest are recommended")
  check(PermMath.rows(screen: false, speech: false).map(\.id) == ["microphone", "accessibility", "input"], "no Screen Recording or Speech Recognition row where the Mac doesn't use them")
  check(rows.allSatisfy { $0.use.hasPrefix("So ") && $0.use.hasSuffix(".") && $0.lost.hasPrefix("Without it, ") && !$0.use.contains("\n") }, "each row has one plain sentence for its use and one for what is lost")
  check(Set(rows.map(\.name)).count == 5 && PermMath.tag(rows[0]) == "Required" && PermMath.tag(rows[2]) == "Recommended", "names and tags")

  // The three states, in the words the window uses.
  check(PermMath.State.allowed.label == "Allowed" && PermMath.State.notYet.label == "Not yet" && PermMath.State.denied.label == "Denied", "Allowed / Not yet / Denied")

  // Overall: a required one missing needs you; only recommended ones missing is ready; else all set.
  let none = PermMath.Model(rows: rows, states: [:])
  check(none.overall == .needs && none.state(rows[0]) == .notYet, "nothing answered: it needs you, and every row is 'not yet'")
  check(PermMath.title(none) == "Echo needs your OK" && PermMath.detail(none) == "Echo can't work without Microphone and Accessibility.", "it names the required ones that are missing")
  check(PermMath.footer(none) == "2 required permissions to go.", "how many are left")
  let oneLeft = PermMath.Model(rows: rows, states: ["microphone": .allowed, "screen": .allowed, "input": .allowed, "speech": .allowed])
  check(oneLeft.overall == .needs && PermMath.detail(oneLeft) == "Echo can't work without Accessibility." && PermMath.footer(oneLeft) == "1 required permission to go.", "every recommended one allowed is still not ready without a required one")
  let ready = PermMath.Model(rows: rows, states: ["microphone": .allowed, "accessibility": .allowed, "input": .denied, "speech": .allowed])
  check(ready.overall == .ready && PermMath.title(ready) == "Echo is ready", "the required ones allowed: ready")
  check(PermMath.detail(ready).contains("Screen Recording and Input Monitoring") && !PermMath.detail(ready).contains("Speech"), "ready says which ones it is doing without")
  let all = PermMath.Model(rows: rows, states: Dictionary(uniqueKeysWithValues: rows.map { ($0.id, PermMath.State.allowed) }))
  check(all.overall == .allSet && PermMath.title(all) == "All set" && PermMath.footer(all) == "Everything is allowed.", "everything allowed: all set")
  check(PermMath.list([]) == "" && PermMath.list(["A"]) == "A" && PermMath.list(["A", "B"]) == "A and B" && PermMath.list(["A", "B", "C"]) == "A, B and C", "lists read as a sentence does")

  // The sentence under a name: what it is for; for a recommended one that's missing, what is lost.
  check(PermMath.sentence(rows[2], .allowed) == rows[2].use && PermMath.sentence(rows[2], .notYet) == rows[2].lost && PermMath.sentence(rows[2], .denied) == rows[2].lost, "a missing recommended one says what is lost")
  check(PermMath.sentence(rows[0], .notYet) == rows[0].use && PermMath.sentence(rows[0], .denied) == rows[0].use, "a required one always says what it is for")

  // The button: none once allowed; "Allow" (macOS's prompt) the first time; "Open Settings" after
  // it has been asked for, or refused.
  check(PermMath.button(rows[0], .allowed, asked: false) == nil && PermMath.button(rows[0], .allowed, asked: true) == nil, "allowed: no button")
  check(PermMath.button(rows[0], .notYet, asked: false) == "Allow" && PermMath.button(rows[1], .notYet, asked: true) == "Open Settings", "Allow once, then Open Settings")
  check(PermMath.button(rows[0], .denied, asked: false) == "Open Settings" && PermMath.button(rows[0], .denied, asked: true) == "Open Settings", "denied: only System Settings can change it")

  // Shown by itself at launch: the first time, and whenever a required one is missing.
  check(PermMath.showAtLaunch(firstRun: true, all) && PermMath.showAtLaunch(firstRun: false, none) && PermMath.showAtLaunch(firstRun: false, oneLeft), "the first time, and when Echo can't work yet")
  check(!PermMath.showAtLaunch(firstRun: false, ready) && !PermMath.showAtLaunch(firstRun: false, all), "not again for a missing recommended one")

  // The timeline: nothing on the first look, then only what changed, as names and states.
  check(PermMath.changes(from: nil, to: ["microphone": .allowed]).isEmpty, "the first look notes nothing")
  check(PermMath.changes(from: ["microphone": .notYet, "screen": .allowed], to: ["microphone": .notYet, "screen": .allowed]).isEmpty, "nothing changed: nothing noted")
  check(PermMath.changes(from: ["microphone": .notYet, "screen": .allowed, "input": .notYet], to: ["microphone": .allowed, "screen": .allowed, "input": .denied]) == ["microphone": "allowed", "input": "denied"], "only the changed ones, with their new states")
  check(PermMath.changes(from: ["screen": .allowed], to: ["screen": .notYet]) == ["screen": "notyet"], "one taken away is a change too")

  // Where things sit: rows from the top down, none overlapping, buttons inside their row's side column.
  let n = rows.count, size = PermMath.size(rows: n)
  check(size.width == PermMath.width && size.height == PermMath.header + CGFloat(n) * PermMath.rowHeight + PermMath.note + PermMath.footerHeight, "as tall as its rows need")
  check(PermMath.rowRect(0, of: n).maxY == size.height - PermMath.header && PermMath.rowRect(n - 1, of: n).minY == PermMath.footerHeight + PermMath.note, "the first row under the header, the last above the note")
  check((1..<n).allSatisfy { PermMath.rowRect($0, of: n).maxY == PermMath.rowRect($0 - 1, of: n).minY }, "rows stack with no gap or overlap")
  let b = PermMath.buttonRect(2, of: n, labelWidth: 86)
  check(PermMath.rowRect(2, of: n).contains(b) && b.maxX == PermMath.width - PermMath.pad && b.width <= PermMath.side, "a button sits in its row's side column")
  check(b.minX >= PermMath.pad + 22 + PermMath.textWidth, "and never under the row's words")
  let done = PermMath.doneRect(labelWidth: 34)
  check(done.minY > 0 && done.maxY < PermMath.footerHeight && done.maxX == PermMath.width - PermMath.pad, "Done sits in the footer")
  let bars = PermMath.bars(thick: 7)
  check(bars.count == 3 && bars[0].width > bars[1].width && bars[1].width > bars[2].width && bars.allSatisfy { $0.minX == 0 && $0.height == 7 }, "the logo: three bars from a shared left edge, each shorter")
  check(bars[1].minY > bars[0].maxY && bars[2].minY > bars[1].maxY, "with a gap between them")
}

// The menu bar menu's status line (StatusMenuMath): one line, the most important thing first.
do {
  func line(missing: String? = nil, up: Bool = true, starting: Bool = false, working: Bool = false, app: String = "", step: Int = 0, steps: Int = 0,
            speaking: Bool = false, listening: Bool = false, handsFree: Bool = false, mode: String = "") -> String {
    StatusMenuMath.statusLine(missing: missing, serverUp: up, starting: starting, working: working, app: app, step: step, steps: steps,
                        speaking: speaking, listening: listening, handsFree: handsFree, mode: mode)
  }
  check(line(mode: "listening") == "Listening · just talk" && line(mode: "resting") == "Resting · say “Echo”" && line(mode: "off") == "Mic off", "the listening state is the idle line")
  check(line(working: true, app: "Chrome", mode: "resting") == "Working in Chrome", "a job under way still comes first")
  do {
    let vis = CGRect(x: 0, y: 0, width: 1440, height: 900), field = CGRect(x: 530, y: 800, width: 380, height: 38)
    let row = PillMath.replyAnswers(field: field, widths: [52, 44], visible: vis)
    check(row.width == 102 && row.midX == field.midX && row.maxY == field.minY - 8, "quick answers sit centred under the reply field")
    let low = PillMath.replyAnswers(field: CGRect(x: 530, y: 20, width: 380, height: 38), widths: [52, 44], visible: vis)
    check(low.minY == 66, "and above it when there is no room below")
    let edge = PillMath.replyAnswers(field: CGRect(x: 1200, y: 800, width: 228, height: 38), widths: [120, 120, 120], visible: vis)
    check(edge.maxX <= vis.maxX - 12, "never off the screen")
  }
  // The bubble beside the thing: one line as before, a wrapped sentence taller; and the question asked at the thing.
  check(BubbleMath.size(textWidth: 100, lines: 1) == BubbleMath.size(textWidth: 100), "one line: the caption's own size")
  check(BubbleMath.size(textWidth: 240, lines: 3).height == 14 + 3 * BubbleMath.lineHeight && BubbleMath.size(textWidth: 240, lines: 3).width == BubbleMath.size(textWidth: 240).width, "a sentence on three lines is three lines tall")
  check(BubbleMath.sentence(String(repeating: "word ", count: 80)).count <= BubbleMath.longChars, "a sentence is cut to what the bubble holds")
  check(BubbleMath.speaks("Hi.") == 2.2 && BubbleMath.speaks(String(repeating: "a", count: 100)) == 6.5 && BubbleMath.speaks(String(repeating: "a", count: 900)) == 14, "the rim stays lit about as long as the words take to say")
  check(AskMath.size(text: CGSize(width: 120, height: 17), buttons: [50, 60]).width == 148 && AskMath.size(text: CGSize(width: 60, height: 17), buttons: [80, 90]).width == 206, "the question's glass is as wide as its words or its two buttons, whichever is wider")
  // The light at rest wanders and flits, within a small reach, and lands cleanly first.
  do {
    check(PearlMath.restDrift(elapsed: 0) == .zero && hypot(PearlMath.restDrift(elapsed: 0.05).x, PearlMath.restDrift(elapsed: 0.05).y) < 0.6, "it lands before it wanders")
    var far: CGFloat = 0, moved = false, flit: CGFloat = 0
    var last = PearlMath.restDrift(elapsed: 1)
    for i in 0..<2000 {
      let t = 1 + Double(i) * 0.01, d = PearlMath.restDrift(elapsed: t)
      far = max(far, hypot(d.x, d.y))
      if hypot(d.x - last.x, d.y - last.y) > 0.01 { moved = true }
      let u = t.truncatingRemainder(dividingBy: PearlMath.restFlitEvery)
      if u > PearlMath.restFlitEvery - 0.4 { flit = max(flit, hypot(d.x - last.x, d.y - last.y)) }
      last = d
    }
    check(moved && far > 3 && far <= PearlMath.restReach, "at rest it keeps moving, never far from its place: \(far)")
    check(flit > 0.25, "and every few seconds it flits: \(flit)")
    let ask = (0..<800).map { PearlMath.restDrift(elapsed: 1 + Double($0) * 0.01, asking: true) }
    check(ask.allSatisfy { hypot($0.x, $0.y) <= 3.4 }, "asking, it only hovers")
  }
  // The light's small gestures.
  do {
    let nod = (0..<70).compactMap { PearlMath.gesture("nod", elapsed: Double($0) * 0.01) }
    check(nod.count == 70 && nod.allSatisfy { $0.x == 0 && abs($0.y) <= 5 } && nod.contains { $0.y < -3.5 } && PearlMath.gesture("nod", elapsed: 0.71) == nil, "a nod: up and down only, two dips, over in 0.7 s")
    let shake = (0..<80).compactMap { PearlMath.gesture("shake", elapsed: Double($0) * 0.01) }
    check(shake.allSatisfy { $0.y == 0 && abs($0.x) <= 4.5 } && shake.contains { $0.x > 3 } && shake.contains { $0.x < -2 } && PearlMath.gesture("shake", elapsed: 0.81) == nil, "a shake: side to side only")
    let top = PearlMath.gesture("spiral", elapsed: 1.09) ?? .zero
    check(top.y > 23 && top.y <= 26.5 && abs(top.x) < 2 && PearlMath.gesture("spiral", elapsed: 1.11) == nil && PearlMath.gesture("wave", elapsed: 0.1) == nil, "the spiral winds upward and ends above where it began")
    check(PearlMath.thinkingEight(elapsed: 0) == .zero && (0..<600).allSatisfy { let p = PearlMath.thinkingEight(elapsed: Double($0) * 0.01); return abs(p.x) <= 7 && abs(p.y) <= 4.5 }, "thinking: a figure of eight within its box")
    let at = CGPoint(x: 100, y: 100)
    check(PearlMath.lean(toward: CGPoint(x: 100, y: 130), from: at) == .zero && PearlMath.lean(toward: CGPoint(x: 400, y: 100), from: at) == .zero, "curious: not when your pointer is on it, nor far away")
    let l = PearlMath.lean(toward: CGPoint(x: 160, y: 100), from: at)
    check(l.x > 3.5 && l.x <= 5 && l.y == 0, "it leans toward a pointer that comes near: \(l)")
    check(PearlMath.heartbeat(elapsed: 0.15) > 0.95 && PearlMath.heartbeat(elapsed: 0.42) > 0.75 && PearlMath.heartbeat(elapsed: 1.0) < 0.01 && PearlMath.heartbeat(elapsed: 1.75) > 0.95, "the heartbeat: two beats, a rest, and again")
    check(PearlMath.cometTrailLife > PearlMath.trailLife * 2, "a comet's tail outlasts the usual trail")
    let peek = (0..<70).compactMap { PearlMath.gesture("peek", elapsed: Double($0) * 0.01) }
    check(peek.count == 70 && peek.allSatisfy { hypot($0.x, $0.y) <= 5.01 } && peek.contains { hypot($0.x, $0.y) > 4 } && hypot(peek[69].x, peek[69].y) < 0.5, "curious: one small loop that ends where it began")
    // Subtle: no gesture ever carries the light more than a finger's width, except the spiral's rise at a job's end.
    for kind in ["nod", "shake", "peek"] {
      check((0..<90).compactMap { PearlMath.gesture(kind, elapsed: Double($0) * 0.01) }.allSatisfy { hypot($0.x, $0.y) <= 5.01 }, "\(kind) stays within 5 pt")
    }
  }
  // Drawing with the light, and pinned notes.
  do {
    let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let ring = (0..<40).map { i -> CGPoint in let a = Double(i) / 40 * 2 * .pi; return CGPoint(x: 600 + 120 * cos(a), y: 500 + 60 * sin(a)) }
    let box = DrawMath.box(ring)!
    check(abs(box.minX - 474) < 1 && abs(box.maxX - 726) < 1 && abs(box.minY - 434) < 1.5 && abs(box.maxY - 566) < 1.5, "the box is round what was drawn, a little outside it: \(box)")
    check(DrawMath.box([CGPoint(x: 1, y: 1)]) == nil, "one point is not a drawing")
    check(DrawMath.meant(box, travelled: 600) && !DrawMath.meant(CGRect(x: 0, y: 0, width: 12, height: 9), travelled: 30) && !DrawMath.meant(CGRect(x: 0, y: 0, width: 200, height: 8), travelled: 200), "a dot, a twitch or a flat line is not meant")
    let sh = DrawMath.shares(of: box, in: screen)
    check((sh["x0"] as? Double ?? 0) < (sh["x1"] as? Double ?? 0) && (sh["y0"] as? Double ?? 0) < (sh["y1"] as? Double ?? 0), "told as shares of the screen")
    check(abs((sh["y0"] as? Double ?? 0) - (900 - 566) / 900) < 0.003, "counted from the top of the screen, as a picture of it is: \(sh)")
    let under = DrawMath.boxFrame(region: box, visible: screen)
    check(under.maxY <= box.minY - 9 && under.minX == box.minX.rounded(), "the box opens under what was circled")
    let low = DrawMath.boxFrame(region: CGRect(x: 1300, y: 20, width: 130, height: 60), visible: screen)
    check(low.minY >= 80 && low.maxX <= screen.maxX - 8, "or above it, and never off the screen: \(low)")
    check(PinMath.clean("  Renewal   date:\n3 March ") == "Renewal date: 3 March" && PinMath.clean(String(repeating: "word ", count: 80)).count == PinMath.maxChars, "a note is one tidy line")
    check(PinMath.place(index: 0, visible: screen).y > PinMath.place(index: 1, visible: screen).y && PinMath.most == 5, "new notes go down the right side, five at most")
  }
  // Keeping an eye on a window.
  check(WatchMath.tail(["a", "b"]) == "a\nb" && WatchMath.tail([String(repeating: "x", count: 9000), "the end"]).count == WatchMath.textMost && WatchMath.tail([String(repeating: "x", count: 9000), "the end"]).hasSuffix("the end"), "a window's words: the end of them, since what is new is at the bottom")
  check(WatchMath.spot(window: CGRect(x: 100, y: 50, width: 800, height: 600), primaryHeight: 900) == CGPoint(x: 874, y: 824), "the watching light sits just inside the window's top-right corner")
  check(WatchMath.same("Terminal", "terminal") && WatchMath.same("Google Chrome", "Chrome") && !WatchMath.same("Finder", "Terminal") && !WatchMath.same("", "Terminal"), "the window's app, however it was named")
  check(PushToTalkMath.isDoubleTap(sinceFirstTap: 0.2, gap: 0.35) && !PushToTalkMath.isDoubleTap(sinceFirstTap: 0.5, gap: 0.35) && !PushToTalkMath.isDoubleTap(sinceFirstTap: nil, gap: 0.35), "two quick taps of the key are a double-tap; a slow second one, or a first one, is not")
  check(line() == "Ready", "nothing going on: Ready")
  check(line(handsFree: true) == "Ready · hands-free is on", "hands-free is said when it is on")
  check(line(listening: true, handsFree: true) == "Listening", "listening")
  check(line(speaking: true, listening: true) == "Speaking", "speaking comes before listening")
  check(line(working: true, app: "Excel", speaking: true) == "Working in Excel", "working on the Mac comes before speaking")
  check(line(working: true, app: "Excel", step: 2, steps: 4) == "Working in Excel · 2 of 4", "the step count when it is known")
  check(line(working: true, app: "Excel", step: 2) == "Working in Excel", "no count when she didn't say how many")
  check(line(working: true, app: "Excel", step: 5, steps: 4) == "Working in Excel", "nor a count past the end")
  check(line(working: true, app: " ") == "Working on your Mac", "no app name: still says she is working")
  check(line(up: false) == "Echo isn't running", "the server is down")
  check(line(up: false, starting: true, listening: true) == "Echo is starting…", "starting comes before anything the page said")
  check(line(missing: "Microphone", up: false, working: true, app: "Excel") == "Microphone not allowed", "a missing required permission comes first")
  check(line(missing: "") == "Ready", "an empty name is no missing permission")

  check(StatusMenuMath.pttHint("ctrl-opt") == "⌃⌥" && StatusMenuMath.pttHint("fn") == "fn", "the push-to-talk hint")
  check(StatusMenuMath.pttHint("off").isEmpty && StatusMenuMath.pttHint("nonsense").isEmpty, "off or unknown: no hint")
  check(StatusMenuMath.summonKey("opt-space")! == (" ", ["opt"]), "Option-Space")
  check(StatusMenuMath.summonKey("ctrl-opt-space")! == (" ", ["ctrl", "opt"]), "Control-Option-Space")
  check(StatusMenuMath.summonKey("cmd-shift-e")! == ("e", ["cmd", "shift"]), "Shift-Command-E")
  check(StatusMenuMath.summonKey("off") == nil && StatusMenuMath.summonKey("") == nil && StatusMenuMath.summonKey("hyper-e") == nil, "off or unknown: no hint")

  // "Show Caption" off hides the pill at once, and on brings it back for what is going on.
  var life = CaptionLife()
  life.heard(enabled: true, driving: false, active: true, quiet: false, new: true, now: 500)
  check(life.wants(now: 501, echoInFront: false, replying: false), "the pill is up")
  life.allow(false)
  check(!life.enabled && !life.wants(now: 501, echoInFront: false, replying: false) && life.lingers(now: 501) == 0, "switched off: gone at once")
  life.allow(true)
  check(life.enabled && life.wants(now: 501, echoInFront: false, replying: false), "switched on: back")
}

// Looking at the screen (Screen.swift): a retry joins the look still being read; the reader is kept awake.
do {
  check(LookMath.joins(startedAgo: 4.2) && LookMath.joins(startedAgo: 0), "the retry after a slow look joins it")
  check(!LookMath.joins(startedAgo: 9) && !LookMath.joins(startedAgo: -1), "an old look is not joined: the screen has moved on")
  check(LookMath.cold(sinceUse: 600) && !LookMath.cold(sinceUse: 30), "unused for minutes: woken again")
  let a = LookMath.key(display: 1, crop: nil, marks: [], grid: 0, maxEdge: 1600)
  check(a == LookMath.key(display: 1, crop: nil, marks: [], grid: 0, maxEdge: 1600), "the same look has the same key")
  check(a != LookMath.key(display: 2, crop: nil, marks: [], grid: 0, maxEdge: 1600) && a != LookMath.key(display: 1, crop: CGRect(x: 0, y: 0, width: 800, height: 600), marks: [], grid: 0, maxEdge: 1600)
    && a != LookMath.key(display: 1, crop: nil, marks: ["1", "2"], grid: 0, maxEdge: 1600) && a != LookMath.key(display: 1, crop: nil, marks: [], grid: 8, maxEdge: 1600), "another display, part, marks or grid is another look")
}

// The square round what was circled leaves when the work is done.
check(DrawMath.workDone(was: "speaking", now: "idle", shownFor: 6) && DrawMath.workDone(was: "thinking", now: "idle", shownFor: 2), "Echo has answered: the square goes")
check(!DrawMath.workDone(was: "idle", now: "idle", shownFor: 6) && !DrawMath.workDone(was: "listening", now: "thinking", shownFor: 6) && !DrawMath.workDone(was: "listening", now: "idle", shownFor: 6) && !DrawMath.workDone(was: "speaking", now: "idle", shownFor: 0.2), "not while it is still at work or only heard you, nor the instant it was drawn")
check(DrawMath.outlineMost < DrawMath.thisLasts, "the square leaves long before \"this\" is forgotten")

// Scrolling to places (Driver.scrollSmart).
do {
  // A heading 300 pt below the top of an 800 pt area (top at y 900) comes up to rest 22% down.
  check(ScrollMath.toRest(top: 100, areaTop: 900, height: 800) == 624, "a thing below its resting line scrolls down to it")
  check(ScrollMath.toRest(top: 880, areaTop: 900, height: 800) == -156, "a thing above its resting line scrolls back up")
  check(ScrollMath.toRest(top: 724, areaTop: 900, height: 800) == 0, "a thing already at rest does not move")
  check(ScrollMath.points(pages: 1, height: 800) == 688, "a page keeps a strip of what was seen")
  check(ScrollMath.points(pages: 0.5, height: 800) == 344 && ScrollMath.points(pages: 0.01, height: 800) == 24, "half a page, and never less than a nudge")
  check(ScrollMath.seamY(points: 688, areaBottom: 100, height: 800, down: true) == 788, "scrolling down: the old bottom edge is that much higher")
  check(ScrollMath.seamY(points: 688, areaBottom: 100, height: 800, down: false) == 212, "scrolling up: the old top edge is that much lower")
  check(ScrollMath.seamY(points: 800, areaBottom: 100, height: 800, down: true) == nil, "all of it scrolled away: no line")
  check(ScrollMath.step(toward: 0.5, from: 0.3, lastPoints: 400, lastMoved: 0.1, height: 800) == 800, "the next push comes from how far the last one moved the bar")
  check(ScrollMath.step(toward: 0.2, from: 0.5, lastPoints: 400, lastMoved: 0.1, height: 800) == -1200, "and goes back up when the place is above")
  check(ScrollMath.step(toward: 1, from: 0, lastPoints: 0, lastMoved: 0, height: 800) == 4800, "nothing measured yet: six pages are guessed")
  check(ScrollMath.place(0) == "at the top" && ScrollMath.place(0.99) == "at the bottom" && ScrollMath.place(0.4) == "40% down", "where the page is, in words")
  check(ScrollMath.pace("slow") < ScrollMath.pace(nil) && ScrollMath.pace(nil) < ScrollMath.pace("fast"), "reading paces")
}

if failures > 0 {
  print("\(failures) failed")
  exit(1)
}
print("ok")
