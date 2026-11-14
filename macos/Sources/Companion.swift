// Echo's companion, drawn: a glass pearl with two eyes and a rim of coloured light. It breathes,
// blinks and looks around; it leans in while you talk, a comet of light circles it while Echo
// thinks, the rim pulses as she speaks; it hops and smiles when something goes right, looks down
// when something fails, tips its head when it needs your OK, and falls asleep after three quiet
// minutes. At work on the Mac it stays in the island and sends its light (FireflyArt, below) to
// show what it means, watching it go; the other way, it hops over itself and reaches out a finger.
// PearlMath (PointMath.swift) has the moods, the timing and the shapes. The island shows one at
// its left end (PillArt.swift, Caption.swift); Pointer.swift flies one out to point at things.
// The three bars are Echo's logo (the app icon, the menu bar), not drawn here.
// The caption beside the light (BubbleArt, at the end) is drawn here too.
// Only CoreGraphics, CoreText and Foundation, so a harness can render it to a PNG.
import CoreGraphics
import CoreText
import Foundation

struct RGB {
  var r: CGFloat, g: CGFloat, b: CGFloat
  static let white = RGB(r: 255, g: 255, b: 255)

  init(r: CGFloat, g: CGFloat, b: CGFloat) { self.r = r; self.g = g; self.b = b }
  /// 0xRRGGBB.
  init(hex: UInt32) { self.init(r: CGFloat((hex >> 16) & 0xFF), g: CGFloat((hex >> 8) & 0xFF), b: CGFloat(hex & 0xFF)) }

  func mix(_ o: RGB, _ t: CGFloat) -> RGB { RGB(r: r + (o.r - r) * t, g: g + (o.g - g) * t, b: b + (o.b - b) * t) }
  func cg(_ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: min(max(a, 0), 1))
  }
}

/// Everything Echo draws on screen is one of these: black glass, white, two greys. The only
/// colour is the answer gradient: the logo's third bar, and the pearl's rim of light.
enum MarkArt {
  static let ink = RGB(r: 245, g: 245, b: 247)
  static let dim = RGB(r: 154, g: 154, b: 162)
  static let grey = RGB(r: 110, g: 110, b: 118)
  static let lightGrey = RGB(r: 201, g: 201, b: 209)
  static let glass = RGB(r: 8, g: 8, b: 10)
  /// The hairline round every piece of glass: white at 16%.
  static let hairline: CGFloat = 0.16
  /// The answer: blue, violet, pink, amber.
  static let answer = [RGB(r: 71, g: 128, b: 255), RGB(r: 168, g: 102, b: 255), RGB(r: 255, g: 102, b: 158), RGB(r: 255, g: 184, b: 102)]
  static let answerStops: [CGFloat] = [0, 0.38, 0.7, 1]
}

final class PearlArt {
  /// Echo's voice: idle | listening | thinking | speaking.
  var voice = "idle"
  /// Echo is working on the Mac: with her voice idle, it thinks.
  var working = false
  /// A question is waiting for your OK: it tips its head and raises a brow.
  var asking = false
  /// Reduce Motion: a still pearl that only blinks, slowly. Moods still show.
  var reduced = false
  /// Lively (the default) or calm: calm keeps the moods, the breath and the blink, and drops the
  /// hops, the bounce, the sparkles, the rings and the wandering eyes.
  var lively = true
  /// Its look: "glass" (smoky glass, a lit edge) or "moon" (a white pearl, dark eyes).
  var skin = "glass"
  /// Its width in points.
  var diameter: CGFloat = 32
  /// Faded as a whole (0…1).
  var fade: CGFloat = 1
  /// Out pointing, over whatever is on screen: a soft shadow under it, and room for its halo and
  /// its echo rings (in the island they would spill over the island's edge).
  var out = false
  /// Where the mouse is from here (-1…1, y up) when it is near: the eyes follow it in the calm moods.
  var pointer: CGPoint?
  /// Something it is showing you, from here (-1…1, y up): the eyes turn to it.
  var target: CGPoint?
  /// How far its finger should be reached out (0 none, 1 all the way) and where to (radians, y up).
  var pointGoal: CGFloat = 0
  var aimGoal: CGFloat = -.pi / 2
  /// Leaning into a hop or a carry (radians, clockwise), from whoever is moving it.
  var sway: CGFloat = 0
  /// Its light is away on an errand (the firefly): the rim is barely lit until it is back.
  var lightAway = false

  /// Its light is home: the rim brightens with a soft pulse, and it gives a pleased blink.
  func lightHome(now: Double) {
    pose.energy = 1.25
    kick(-1.2)
    landed(now: now)
  }

  private(set) var mood = "idle"
  private var moodAt = 0.0
  private var moment: (mood: String, until: Double)?
  private var pose = PearlMath.Pose(energy: 0.25)
  private var squash: CGFloat = 0, squashSpeed: CGFloat = 0, lift: CGFloat = 0, shake: CGFloat = 0
  private var blink: CGFloat = 0, blinkAt = 0.0
  private var glance = CGPoint.zero, glanceAt = 0.0
  private var rings: [PearlMath.Ring] = []
  private var sparks: [PearlMath.Spark] = []
  private var levelIn: Double = 0, levelAt: Double = -10
  private(set) var level: Double = 0
  private var started = false
  private var activeAt = 0.0
  private var lastPointer: CGPoint?
  private(set) var point: CGFloat = 0
  private(set) var aim: CGFloat = -.pi / 2
  private var tapAt = -10.0, nodAt = -10.0
  private var pushed = false
  /// Asleep with its light home: the light rests inside it (0…1), a faint glow at its centre.
  private var rest: CGFloat = 0

  /// Half the side of the square it needs around its centre.
  var reach: CGFloat { PearlMath.reach(diameter: diameter) }

  // MARK: moments

  func setLevel(_ v: Double, now: Double) {
    guard v.isFinite else { return }
    levelIn = min(max(v, 0), 1)
    levelAt = now
  }

  private func play(_ mood: String, now: Double, lasts: Double? = nil, hop: CGFloat = 1) {
    moment = (mood, now + (lasts ?? PearlMath.lasts(mood)))
    activeAt = now
    guard lively, !reduced else { return }
    let k = PearlMath.kick(mood)
    if k.lift != 0 { lift = k.lift * hop; squash = k.squash * hop }
    if mood == "sorry" { shake = 1 }
  }

  /// A push on its jelly: below zero it springs up tall, above it squashes down; then it wobbles
  /// and settles.
  func kick(_ v: CGFloat) { if !reduced { squashSpeed += v } }

  /// Down, ready to hop.
  func crouch() { if !reduced { squash = 0.22 } }

  /// It has landed: a squash, a wobble and a blink.
  func land() {
    blink = 1
    if !reduced { squash = 0.2; kick(1.5) }
  }

  /// A tap on what it is showing (a click): the finger draws back, then pushes.
  func pulse(now: Double) {
    guard !reduced else { return }
    tapAt = now
    pushed = false
  }

  /// A step worked: a pleased blink, smiling eyes for a moment.
  func done(now: Double) {
    blink = 1
    // Already smiling for longer (a lesson step's "proud"): the blink joins it, and never cuts it short.
    if let m = moment, m.mood == "happy", m.until > now + 0.7 { return }
    play("happy", now: now, lasts: 0.7, hop: 0)
  }

  /// A lesson step passed: smiling eyes and a hop.
  func proud(now: Double) { play("happy", now: now, lasts: 2) }

  /// Something finished: smiling eyes, a hop, and sparkles.
  func celebrate(now: Double) {
    play("happy", now: now)
    burst()
  }

  /// Back in the island after showing you something: a happy blink.
  func landed(now: Double) {
    play("happy", now: now, lasts: 0.9, hop: 0)
    blink = 1
  }

  /// Sparkles, flying out.
  func burst() {
    if lively, !reduced { sparks += PearlMath.sparks { Double.random(in: 0...1) } }
  }

  /// You cut in: a jump and wide eyes.
  func surprised(now: Double) { play("surprised", now: now) }

  /// It didn't work: eyes down, the light dims, a small shake of the head. No red.
  func miss(now: Double, lasts: Double? = nil) { play("sorry", now: now, lasts: lasts) }

  /// A character went in: it taps along.
  func tap() { if squashSpeed < 1.5 { kick(0.9) } }

  /// A scroll: it nods the page along.
  func nod(now: Double) { if !reduced { nodAt = now } }

  /// Something happened: it is not time to sleep.
  func wake(now: Double) { activeAt = now }

  /// True while something one-off is still playing (so a hide can wait for it).
  func busy(now: Double) -> Bool { moment != nil || now - tapAt < 0.3 || now - nodAt < 1.1 }

  /// True while it needs a new frame: always, unless motion is reduced and it has come to rest.
  private(set) var moving = true

  /// Reduced motion, at rest: when the next slow blink is due (the clock can sleep until then).
  var nextBlink: Double { blinkAt }

  // MARK: a frame

  /// Moves every live value one frame (`dt` seconds) toward the mood it's in.
  func step(now: Double, dt: Double) {
    if !started {
      started = true
      activeAt = now
      blinkAt = PearlMath.nextBlink(after: now, roll: 0.3, reduced: reduced)
      glanceAt = now + 1.2
    }
    if let m = moment, now >= m.until { moment = nil }
    // The mouse moving nearby keeps it awake (and wakes it); a mouse left lying there doesn't.
    if pointer != lastPointer { lastPointer = pointer; if pointer != nil { activeAt = now } }
    if voice != "idle" || working || asking || moment != nil || target != nil { activeAt = now }
    let next = PearlMath.mood(voice: voice, working: working, asking: asking, moment: moment?.mood, idleFor: now - activeAt)
    if next != mood {
      // Waking: a blink and a small stretch.
      if mood == "sleepy" { blink = 1; if lively, !reduced { squash = -0.12 } }
      mood = next
      moodAt = now
    }

    // The voice level: from the page or the microphone, a dozen times a second; with no news it
    // dies away. While Echo speaks with nothing saying how loud, a made-up voice moves the rim.
    if now - levelAt > 0.25 { levelIn *= pow(0.05, dt) }
    var heard = mood == "listening" || mood == "speaking" ? levelIn : 0
    if mood == "speaking", now - levelAt > 0.5 { heard = PearlMath.babble(now) }
    level = CompanionMath.smoothLevel(level, toward: reduced ? 0 : heard, dt: dt)

    let want = PearlMath.pose(mood, level: level, age: now - moodAt, t: now, glance: lively ? glance : .zero,
                              pointer: lively ? pointer : nil, target: target, reduced: reduced)
    let before = pose
    pose.open = PearlMath.ease(pose.open, toward: want.open, rate: 12, dt: dt)
    pose.happy = PearlMath.ease(pose.happy, toward: want.happy, rate: 10, dt: dt)
    pose.energy = PearlMath.ease(pose.energy, toward: want.energy, rate: 6, dt: dt)
    pose.dim = PearlMath.ease(pose.dim, toward: want.dim, rate: 4, dt: dt)
    pose.tilt = PearlMath.ease(pose.tilt, toward: want.tilt, rate: 6, dt: dt)
    pose.brow = PearlMath.ease(pose.brow, toward: want.brow, rate: 8, dt: dt)
    pose.lean = PearlMath.ease(pose.lean, toward: want.lean, rate: 6, dt: dt)
    pose.look.x = PearlMath.ease(pose.look.x, toward: want.look.x, rate: 9, dt: dt)
    pose.look.y = PearlMath.ease(pose.look.y, toward: want.look.y, rate: 9, dt: dt)
    if lightAway { pose.energy = PearlMath.ease(before.energy, toward: 0.08, rate: 5, dt: dt) }
    rest = PearlMath.ease(rest, toward: mood == "sleepy" && !lightAway ? 1 : 0, rate: 2, dt: dt)
    // Jelly: the squash is a spring, so every hop, landing and tap wobbles and settles.
    // The push of a tap gives it a little spring too.
    let tapping = now - tapAt < 0.2
    if tapping, !pushed, now - tapAt >= PearlMath.tapPush { pushed = true; kick(-1.6) }
    (squash, squashSpeed) = PearlMath.jelly(squash, speed: squashSpeed, dt: dt)
    lift = PearlMath.ease(lift, toward: 0, rate: 5, dt: dt)
    shake = PearlMath.ease(shake, toward: 0, rate: 3, dt: dt)
    // The finger: out and back quickly, a tap pulls it back and pushes it a little past.
    let reachTo = pointGoal > 0.5 ? pointGoal * PearlMath.tap(elapsed: now - tapAt) : pointGoal
    point = PearlMath.ease(point, toward: reachTo, rate: tapping ? 26 : 11, dt: dt)
    // With no finger out there is nothing to turn: it comes out where it is wanted.
    aim = point < 0.03 ? aimGoal : PearlMath.turn(aim, toward: aimGoal, rate: 12, dt: dt)

    // Blinking and glancing happen by themselves.
    if now >= blinkAt {
      blink = 1
      blinkAt = PearlMath.nextBlink(after: now, roll: Double.random(in: 0...1), reduced: reduced)
    }
    blink = max(0, blink - CGFloat(dt * PearlMath.blinkRate(reduced: reduced)))
    if now >= glanceAt {
      glance = PearlMath.glance(Double.random(in: 0...1), Double.random(in: 0...1))
      glanceAt = PearlMath.nextGlance(after: now, roll: Double.random(in: 0...1))
    }
    // Echo rings: one each time your voice rises while it listens.
    if out, lively, !reduced, PearlMath.ringDue(mood: mood, level: level, last: rings.last) { rings.append(PearlMath.Ring()) }
    rings = rings.compactMap { PearlMath.step($0, dt: dt) }
    sparks = sparks.compactMap { PearlMath.step($0, dt: dt) }
    if reduced { squash = 0; squashSpeed = 0; lift = 0; shake = 0; rings = []; sparks = [] }

    func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 0.003 }
    let settled = near(pose.open, before.open) && near(pose.happy, before.happy) && near(pose.energy, before.energy) && near(pose.dim, before.dim)
      && near(pose.tilt, before.tilt) && near(pose.brow, before.brow) && near(pose.look.x, before.look.x) && near(pose.look.y, before.look.y)
      && near(point, reachTo) && abs(atan2(sin(aimGoal - aim), cos(aimGoal - aim))) < 0.01
    moving = !reduced || !settled || blink > 0 || moment != nil
  }

  /// Draws it centred on `c` (y up). `pixelScale` is the backing scale, for glows and shadows
  /// (Core Graphics blurs in device pixels).
  func draw(in ctx: CGContext, at c: CGPoint, now t: Double, pixelScale px: CGFloat) {
    guard fade > 0.01, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return }
    let R = diameter / 2, m = mood, alive = !reduced, bouncy = alive && lively
    let moon = skin == "moon", violet = MarkArt.answer[1]
    ctx.saveGState()
    defer { ctx.restoreGState() }
    let faded = fade < 0.99
    if faded {
      ctx.setAlpha(fade)
      ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    }
    defer { if faded { ctx.endTransparencyLayer() } }

    // Where it is this frame: a breath, a bounce with each word, a nudge when it needs you, a
    // shake of the head, a nod.
    let breath = alive ? CGFloat(sin(t * (m == "sleepy" ? 0.9 : 1.6))) * 0.018 : 0
    let bounce = m == "speaking" && bouncy ? CGFloat(abs(sin(t * 5.2))) * R * 0.05 * (0.4 + CGFloat(level)) : 0
    let nudge = m == "needs" && alive && sin(t * 1.4) > 0.6 ? CGFloat(sin(t * 9)) * max(0.5, R * 0.03) : 0
    let shakeX = CGFloat(sin(t * 34)) * max(1.2, R * 0.05) * shake
    let nod = PearlMath.nod(elapsed: t - nodAt) * R * 0.22
    ctx.translateBy(x: c.x + nudge + shakeX, y: c.y + lift * R + bounce + pose.lean * R * 0.05 + nod)
    let stretch = PearlMath.scale(squash: min(max(squash, -0.5), 0.5) + breath)
    let turn = PearlMath.rimTurn(m, t: t, reduced: reduced)

    ctx.saveGState()
    ctx.rotate(by: -(pose.tilt + sway))

    // Echo rings, and a soft violet halo behind.
    for ring in rings {
      arc(ctx, radius: R * ring.r, from: 0, span: 2 * .pi, width: max(1, R * 0.03), taper: false, turn: turn, alpha: ring.a * 0.8, glow: 0, px: px)
    }
    let haloTo = R * (out ? 1.7 : 1.36), haloAlpha = 0.34 * pose.energy * (1 - pose.dim)
    if haloAlpha > 0.004, let g = CGGradient(colorsSpace: space, colors: [violet.cg(haloAlpha), violet.cg(0)] as CFArray, locations: [0, 1]) {
      ctx.drawRadialGradient(g, startCenter: .zero, startRadius: R * 0.8, endCenter: .zero, endRadius: haloTo, options: [])
    }

    ctx.scaleBy(x: stretch.x, y: stretch.y)
    let shape = PearlMath.body(radius: R, point: point, aim: aim)

    // Under it: a soft shadow out on the screen (so it lifts off a white page), and a soft white
    // light behind dark glass (so it never disappears into a dark one).
    if out {
      ctx.saveGState()
      ctx.setShadow(offset: CGSize(width: 0, height: -2 * px), blur: 9 * px, color: CGColor(gray: 0, alpha: 0.38))
      ctx.addPath(shape)
      ctx.setFillColor(CGColor(gray: 0, alpha: 1))
      ctx.fillPath()
      ctx.restoreGState()
    }
    if !moon {
      ctx.saveGState()
      ctx.setShadow(offset: .zero, blur: R * 0.3 * px, color: RGB.white.cg(0.5 * (1 - pose.dim * 0.5)))
      ctx.addPath(PearlMath.body(radius: R * 0.98, point: point, aim: aim))
      ctx.setFillColor(CGColor(gray: 0, alpha: 1))
      ctx.fillPath()
      ctx.restoreGState()
    }

    // The body.
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    let past: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]
    func radial(_ colors: [CGColor], _ stops: [CGFloat], from a: CGPoint, _ r0: CGFloat, to r1: CGFloat) {
      guard let g = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: stops) else { return }
      ctx.drawRadialGradient(g, startCenter: a, startRadius: r0, endCenter: .zero, endRadius: r1, options: past)
    }
    switch skin {
    case "moon":
      radial([RGB.white.cg(), RGB(r: 220, g: 220, b: 230).cg(), RGB(r: 154, g: 154, b: 171).cg()], [0, 0.6, 1],
             from: CGPoint(x: -R * 0.3, y: R * 0.4), R * 0.05, to: R * 1.05)
    default:
      radial([RGB(r: 90, g: 90, b: 102).cg(), RGB(r: 37, g: 37, b: 43).cg(), RGB(r: 13, g: 13, b: 16).cg()], [0, 0.5, 1],
             from: CGPoint(x: -R * 0.35, y: R * 0.45), R * 0.1, to: R * 1.05)
    }
    // Asleep: its light rests inside it, a faint glow at the centre that slowly comes and goes
    // (the same as the page's pearl).
    if rest > 0.02 {
      let pulse: CGFloat = alive ? 0.5 + 0.5 * CGFloat(sin(t * 1.1)) : 0.5, a = rest * (0.3 + 0.3 * pulse) * (moon ? 1.2 : 1)
      let at = CGPoint(x: 0, y: -R * 0.12)
      if let g = CGGradient(colorsSpace: space, colors: [RGB(r: 255, g: 150, b: 190).cg(a), violet.cg(a * 0.6), violet.cg(0)] as CFArray, locations: [0, 0.45, 1]) {
        ctx.drawRadialGradient(g, startCenter: at, startRadius: 0, endCenter: at, endRadius: R * (0.5 + 0.12 * pulse), options: [])
      }
    }
    ctx.restoreGState()

    // The rim of light: a crescent at rest, a comet while it thinks, a full ring when it listens,
    // speaks or is happy.
    let rim = PearlMath.rim(m, energy: pose.energy, t: t, reduced: reduced)
    arc(ctx, radius: R * 0.965, from: rim.from, span: rim.span,
        width: PearlMath.rimWidth(radius: R, energy: pose.energy, level: CGFloat(level), speaking: m == "speaking"), taper: rim.comet, turn: turn,
        alpha: PearlMath.rimAlpha(energy: pose.energy, dim: pose.dim), glow: R * 0.22 * pose.energy, px: px)

    // Glass: a soft light at the top, and a fine bright edge.
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    let shineAt = CGPoint(x: -R * 0.3, y: R * 0.62)
    if let g = CGGradient(colorsSpace: space, colors: [RGB.white.cg(0.2), RGB.white.cg(0)] as CFArray, locations: [0, 1]) {
      ctx.drawRadialGradient(g, startCenter: shineAt, startRadius: 0, endCenter: shineAt, endRadius: R * 0.7, options: [])
    }
    ctx.restoreGState()
    let edge = max(1, R * 0.014)
    ctx.addPath(PearlMath.body(radius: R - edge / 2, point: point, aim: aim))
    ctx.setStrokeColor(RGB.white.cg(moon ? 0.9 : 0.42))
    ctx.setLineWidth(edge)
    ctx.strokePath()

    // The eyes.
    let eyes = PearlMath.eyes(radius: R, open: pose.open, blink: blink, happy: pose.happy, look: pose.look)
    let ink = moon ? RGB(r: 11, g: 11, b: 15) : RGB.white
    let w = eyes.width, h = eyes.height
    ctx.saveGState()
    ctx.setFillColor(ink.cg())
    ctx.setStrokeColor(ink.cg())
    ctx.setLineCap(.round)
    if !moon { ctx.setShadow(offset: .zero, blur: R * 0.07 * px, color: RGB.white.cg(0.6)) }
    for e in [eyes.left, eyes.right] {
      switch eyes.shape {
      case .smile: // little arches
        ctx.setLineWidth(w * 0.75)
        ctx.addArc(center: CGPoint(x: e.x, y: e.y - w * 0.5), radius: w * 0.95, startAngle: .pi * 0.88, endAngle: .pi * 0.12, clockwise: true)
        ctx.strokePath()
      case .shut: // a soft line, sagging a little: at peace, not blank
        ctx.setLineWidth(max(1, w * 0.5))
        ctx.move(to: CGPoint(x: e.x - w * 0.8, y: e.y))
        ctx.addQuadCurve(to: CGPoint(x: e.x + w * 0.8, y: e.y), control: CGPoint(x: e.x, y: e.y - w * 0.45))
        ctx.strokePath()
      case .open:
        let r = min(w, h) / 2
        ctx.addPath(CGPath(roundedRect: CGRect(x: e.x - w / 2, y: e.y - h / 2, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil))
        ctx.fillPath()
      }
    }
    ctx.restoreGState()
    // A tiny glint at larger sizes, so the eyes look wet and alive.
    if eyes.shape == .open, !PearlMath.bold(diameter: diameter), h > w {
      ctx.setFillColor(moon ? RGB.white.cg(0.85) : RGB(r: 20, g: 20, b: 30).cg(0.35))
      for e in [eyes.left, eyes.right] {
        ctx.fillEllipse(in: CGRect(x: e.x + w * 0.16 - w * 0.16, y: e.y + h * 0.22 - w * 0.16, width: w * 0.32, height: w * 0.32))
      }
    }
    let detailed = PearlMath.detailed(diameter: diameter)
    // One raised brow when it needs you.
    if pose.brow > 0.05, detailed {
      let e = eyes.right, up = (eyes.shape == .open ? h / 2 : w / 2)
      ctx.setStrokeColor(ink.cg(pose.brow))
      ctx.setLineCap(.round)
      ctx.setLineWidth(max(1.1, w * 0.38))
      ctx.move(to: CGPoint(x: e.x - w, y: e.y + up + R * 0.13))
      ctx.addLine(to: CGPoint(x: e.x + w, y: e.y + up + R * 0.27))
      ctx.strokePath()
    }
    // Asleep: a small z drifts up and away.
    if m == "sleepy", detailed, pose.dim > 0.4 {
      let k = alive ? CGFloat((t * 0.35).truncatingRemainder(dividingBy: 1)) : 0.35
      let s = R * (0.16 + k * 0.1), at = CGPoint(x: R * (0.72 + k * 0.3), y: R * (0.72 + k * 0.5))
      ctx.setStrokeColor((moon ? MarkArt.dim : RGB.white).cg((1 - k) * 0.75))
      ctx.setLineWidth(max(1, s * 0.22))
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.move(to: CGPoint(x: at.x - s / 2, y: at.y + s / 2))
      ctx.addLine(to: CGPoint(x: at.x + s / 2, y: at.y + s / 2))
      ctx.addLine(to: CGPoint(x: at.x - s / 2, y: at.y - s / 2))
      ctx.addLine(to: CGPoint(x: at.x + s / 2, y: at.y - s / 2))
      ctx.strokePath()
    }
    ctx.restoreGState()

    // Sparkles fly out when something goes right.
    for p in sparks {
      let color = MarkArt.answer[abs(Int(p.spin)) % 4]
      ctx.setFillColor(color.cg(max(0, p.life)))
      let at = CGPoint(x: cos(p.angle) * R * p.r, y: sin(p.angle) * R * p.r), r = max(1.6, R * p.size * 1.6)
      for i in 0..<8 {
        let a = p.spin + CGFloat(i) * .pi / 4, q = i % 2 == 1 ? r * 0.28 : r
        let v = CGPoint(x: at.x + cos(a) * q, y: at.y + sin(a) * q)
        if i == 0 { ctx.move(to: v) } else { ctx.addLine(to: v) }
      }
      ctx.closePath()
      ctx.fillPath()
    }
  }

  /// An arc of the answer's colours going round (there is no conic gradient in Core Graphics, so
  /// it is drawn as short pieces): anticlockwise from `from` for `span`, the colours turned by
  /// `turn`. `taper`: a comet, thick at `from` and thinning to its tail.
  private func arc(_ ctx: CGContext, radius: CGFloat, from: CGFloat, span: CGFloat, width: CGFloat, taper: Bool, turn: CGFloat,
                   alpha: CGFloat, glow: CGFloat, px: CGFloat) {
    guard alpha > 0.01, span > 0.01 else { return }
    ctx.saveGState()
    defer { ctx.restoreGState() }
    ctx.setAlpha(alpha)
    if glow > 0.05 { ctx.setShadow(offset: .zero, blur: glow * px, color: MarkArt.answer[1].cg()) }
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    defer { ctx.endTransparencyLayer() }
    ctx.setLineCap(.round)
    let n = max(10, Int((span / (2 * .pi) * 72).rounded(.up)))
    let colors = MarkArt.answer
    for i in 0..<n {
      let u = (CGFloat(i) + 0.5) / CGFloat(n)
      let a0 = from + span * CGFloat(i) / CGFloat(n), a1 = from + span * CGFloat(i + 1) / CGFloat(n)
      var turnPart = ((from + span * u - turn) / (2 * .pi)).truncatingRemainder(dividingBy: 1)
      if turnPart < 0 { turnPart += 1 }
      let f = turnPart * 4, k = Int(f) % 4
      ctx.setStrokeColor(colors[k].mix(colors[(k + 1) % 4], f - floor(f)).cg())
      ctx.setLineWidth(taper ? width * (1.25 - 1.0 * u) : width)
      ctx.addArc(center: .zero, radius: radius, startAngle: a0, endAngle: a1, clockwise: false)
      ctx.strokePath()
    }
  }
}

/// The firefly: Echo's own light, out on an errand. A small core with a soft glow and a short
/// fading trail. Its colour says why it is out (PearlMath.lightColours): white while Echo only
/// shows you something, the answer's colours while she acts, amber while she waits for your OK.
/// A click is a small burst where it touched down: a ripple and a few sparks. Waiting on a lesson
/// step it breathes slowly; under your mouse it swells a little, to say it can be picked up.
/// Pointer.swift moves it; PearlMath has its flight, its orbit and its trail's fade.
final class FireflyArt {
  /// Where it is (the coordinates it is drawn in).
  private(set) var position = CGPoint.zero
  /// Why it is out: "show", "act" or "ask" (PearlMath.intents).
  var intent = "show"
  /// Waiting for you (a lesson step): 0…1, a slow breath (PearlMath.breath). 0: not waiting.
  var breath: CGFloat = 0
  /// Your mouse is on it (it can be picked up), or has hold of it.
  var hot = false
  /// It is looking for something: its trail lingers, so the figure of eight it flies can be seen.
  var searching = false
  /// On a long flight: the trail lingers like a comet's tail and sheds a little dust.
  var comet = false
  var reduced = false
  var fade: CGFloat = 1
  private var dust: [(p: CGPoint, v: CGVector, at: Double)] = []

  private var tint: CGFloat = 0, amber: CGFloat = 0, swollen: CGFloat = 0
  private var trail: [(p: CGPoint, at: Double)] = []
  private var burstAt = -10.0, burstPoint = CGPoint.zero

  /// It is here now. `jump`: with no trail from where it was.
  func move(to p: CGPoint, now: Double, jump: Bool = false) {
    position = p
    if jump || reduced { trail = [] } else { trail.append((p, now)) }
    // The comet's dust: a grain every third picture or so, drifting down and away.
    if comet, !reduced, !jump, trail.count % 3 == 0 {
      let n = Double(trail.count) + now * 37
      dust.append((p, CGVector(dx: CGFloat(sin(n * 12.9898)) * 9, dy: -10 - CGFloat(abs(sin(n * 78.233))) * 16), now))
    }
  }

  /// It touched down on what Echo is clicking (or a step passed, or you dropped it on something).
  func burst(now: Double) {
    burstAt = now
    burstPoint = position
  }

  private var trailLife: Double { searching ? PearlMath.searchTrailLife : comet ? PearlMath.cometTrailLife : PearlMath.trailLife }
  private var wants: (tint: CGFloat, amber: CGFloat, swollen: CGFloat) { (intent == "act" ? 1 : 0, intent == "ask" ? 1 : 0, hot ? 1 : 0) }

  func step(now: Double, dt: Double) {
    let w = wants
    tint = PearlMath.ease(tint, toward: w.tint, rate: 8, dt: dt)
    amber = PearlMath.ease(amber, toward: w.amber, rate: 8, dt: dt)
    swollen = PearlMath.ease(swollen, toward: w.swollen, rate: 14, dt: dt)
    trail.removeAll { now - $0.at > trailLife }
    dust.removeAll { now - $0.at > PearlMath.dustLife }
  }

  /// True while something is still changing (the trail fading, a burst playing, a colour turning).
  func moving(now: Double) -> Bool {
    let w = wants
    return trail.count > 1 || !dust.isEmpty || PearlMath.burst(elapsed: now - burstAt) != nil || abs(tint - w.tint) > 0.01 || abs(amber - w.amber) > 0.01
      || abs(swollen - w.swollen) > 0.01 || breath > 0
  }

  /// The box everything it draws fits in.
  var bounds: CGRect {
    var box = CGRect(x: position.x, y: position.y, width: 0, height: 0)
    for t in trail { box = box.union(CGRect(x: t.p.x, y: t.p.y, width: 0, height: 0)) }
    for d in dust { box = box.union(CGRect(x: d.p.x, y: d.p.y, width: 0, height: 0).insetBy(dx: -12, dy: -24)) }
    box = box.union(CGRect(x: burstPoint.x, y: burstPoint.y, width: 0, height: 0).insetBy(dx: -14, dy: -14))
    return box.insetBy(dx: -22, dy: -22).integral
  }

  /// Draws it (y up). `now` picks the moment; `pixelScale` is the backing scale, for the glow.
  func draw(in ctx: CGContext, now t: Double, pixelScale px: CGFloat) {
    guard fade > 0.01 else { return }
    let r = PearlMath.lightRadius, colors = MarkArt.answer, ask = RGB(hex: PearlMath.lightColours("ask")[0])
    // The trail always carries a little of the answer's colours (white alone is lost on a white
    // page); all of them while Echo acts, and amber while she asks.
    func tinted(_ i: Int, _ alpha: CGFloat) -> CGColor {
      RGB.white.mix(colors[((i % 4) + 4) % 4], 0.5 + 0.5 * tint).mix(ask, amber).cg(alpha * fade)
    }
    ctx.saveGState()
    defer { ctx.restoreGState() }

    // The trail: short pieces from the oldest to the newest, each fainter and thinner with age.
    // Each piece replaces what is under it rather than adding to it, so round ends never bead.
    if trail.count > 1 {
      ctx.saveGState()
      ctx.beginTransparencyLayer(auxiliaryInfo: nil)
      ctx.setBlendMode(.copy)
      ctx.setLineCap(.round)
      for i in 1..<trail.count {
        let a = trail[i - 1], b = trail[i], look = PearlMath.trail(age: t - b.at, life: trailLife)
        guard look.alpha > 0.01 else { continue }
        ctx.setStrokeColor(tinted(Int(b.at * 14), look.alpha))
        ctx.setLineWidth(look.width)
        ctx.move(to: a.p)
        ctx.addLine(to: b.p)
        ctx.strokePath()
      }
      ctx.endTransparencyLayer()
      ctx.restoreGState()
    }

    // The comet's dust: small grains in the answer's colours, falling and fading.
    for (i, d) in dust.enumerated() {
      let age = t - d.at, k = CGFloat(max(0, 1 - age / PearlMath.dustLife))
      guard k > 0.02 else { continue }
      ctx.setFillColor(tinted(i, 0.75 * k))
      ctx.fillEllipse(in: CGRect(x: d.p.x + d.v.dx * CGFloat(age) - 0.8, y: d.p.y + d.v.dy * CGFloat(age) - 0.8, width: 1.6, height: 1.6))
    }

    // A burst: a ripple and six small sparks, spreading and fading.
    if let b = PearlMath.burst(elapsed: t - burstAt) {
      ctx.setStrokeColor(RGB.white.cg(0.9 * b.alpha * fade))
      ctx.setLineWidth(1.5)
      ctx.strokeEllipse(in: CGRect(x: burstPoint.x - b.spread, y: burstPoint.y - b.spread, width: 2 * b.spread, height: 2 * b.spread))
      for i in 0..<6 {
        let a = CGFloat(i) * .pi / 3 + 0.4, at = CGPoint(x: burstPoint.x + cos(a) * b.spread * 0.72, y: burstPoint.y + sin(a) * b.spread * 0.72)
        ctx.setFillColor(colors[i % 4].cg(b.alpha * fade))
        for k in 0..<8 {
          let q = k % 2 == 1 ? 0.8 : 2.8, d = a + CGFloat(k) * .pi / 4
          let v = CGPoint(x: at.x + cos(d) * q, y: at.y + sin(d) * q)
          if k == 0 { ctx.move(to: v) } else { ctx.addLine(to: v) }
        }
        ctx.closePath()
        ctx.fillPath()
      }
    }

    // The light: a soft glow (warm pink while it shows, violet while it acts, amber while it
    // asks), then the core: a little bigger for the moment of a burst, with each slow breath
    // while it waits, and under your mouse.
    let swell = 1 + 0.9 * (PearlMath.burst(elapsed: t - burstAt).map { $0.alpha * $0.alpha } ?? 0) + 0.2 * breath + 0.3 * swollen + 0.2 * amber
    let core = CGRect(x: position.x - r * swell, y: position.y - r * swell, width: 2 * r * swell, height: 2 * r * swell)
    let glow = RGB(r: 255, g: 154, b: 208).mix(colors[1], tint).mix(ask, amber)
    // Waiting: a halo that swells with each breath, never a blink. Asking: a steady amber one.
    if breath > 0.001 || swollen > 0.01 || amber > 0.01, let space = CGColorSpace(name: CGColorSpace.sRGB) {
      let reach = r * (2.4 + 2.6 * breath + 0.8 * swollen + 1.2 * amber), a = min(0.7, 0.2 + 0.3 * breath + 0.22 * swollen + 0.16 * amber) * fade
      if let g = CGGradient(colorsSpace: space, colors: [glow.mix(RGB.white, 0.35).cg(a), glow.cg(a * 0.45), glow.cg(0)] as CFArray, locations: [0, 0.5, 1]) {
        ctx.drawRadialGradient(g, startCenter: position, startRadius: r * 0.6, endCenter: position, endRadius: reach, options: [])
      }
    }
    // Under your mouse: a fine ring round it, the handle you pick it up by.
    if swollen > 0.02 {
      let q = PearlMath.grabReach - 2.5
      ctx.setStrokeColor(RGB.white.cg(0.55 * swollen * fade))
      ctx.setLineWidth(1)
      ctx.strokeEllipse(in: CGRect(x: position.x - q, y: position.y - q, width: 2 * q, height: 2 * q))
    }
    ctx.saveGState()
    ctx.setShadow(offset: .zero, blur: (11 + 4 * breath) * px, color: glow.cg(fade))
    ctx.setFillColor(RGB.white.cg(fade))
    ctx.fillEllipse(in: core)
    ctx.fillEllipse(in: core) // twice: a fuller glow
    ctx.restoreGState()
    // A thin dark edge, so a white light still reads on a white page.
    ctx.setStrokeColor(CGColor(gray: 0, alpha: 0.22 * fade))
    ctx.setLineWidth(0.75)
    ctx.strokeEllipse(in: core.insetBy(dx: -0.4, dy: -0.4))
    let coloured = max(tint, amber)
    if coloured > 0.02, let space = CGColorSpace(name: CGColorSpace.sRGB),
       let g = CGGradient(colorsSpace: space, colors: colors.map { $0.mix(ask, amber).cg(coloured * fade) } as CFArray, locations: [0, 1 / 3, 2 / 3, 1]) {
      // Acting: the core takes the answer's colours, with a white heart. Asking: all amber.
      ctx.saveGState()
      ctx.addEllipse(in: core)
      ctx.clip()
      ctx.drawLinearGradient(g, start: CGPoint(x: core.minX, y: core.minY), end: CGPoint(x: core.maxX, y: core.maxY), options: [])
      ctx.restoreGState()
      ctx.setFillColor(RGB.white.cg(0.85 * fade))
      ctx.fillEllipse(in: core.insetBy(dx: core.width * 0.3, dy: core.height * 0.3))
    }
  }
}

/// The bubble beside the light (the "Aurora" look): a piece of the island's dark glass with white
/// words, one line or a sentence wrapped to a few. Its rim carries the answer's colours, with a
/// soft glow, while Echo is saying the words, and is a quiet hairline once they are said; amber
/// while she asks. A thread of light joins it to the pearl's light. BubbleMath (PointMath.swift)
/// has its words, its size and its place.
enum BubbleArt {
  /// The system font at 12.5 pt, medium.
  static let font: CTFont = {
    let base = CTFontCreateUIFontForLanguage(.system, 12.5, nil) ?? CTFontCreateWithName("Helvetica Neue" as CFString, 12.5, nil)
    let medium = [kCTFontTraitsAttribute: [kCTFontWeightTrait: 0.23]] as CFDictionary
    return CTFontCreateCopyWithAttributes(base, 12.5, nil, CTFontDescriptorCreateWithAttributes(medium))
  }()
  /// The room its shadow needs round the glass (the layer it is drawn in is this much bigger).
  static let room: CGFloat = 18

  private static func line(_ text: String, alpha: CGFloat = 1) -> CTLine {
    CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): MarkArt.ink.cg(alpha),
    ]))
  }

  /// The words as the lines the bubble shows: one line when they fit, else wrapped at
  /// BubbleMath.wrapWidth to at most BubbleMath.maxLines, the last one cut with "…".
  static func lines(_ text: String) -> [CTLine] {
    let whole = line(text)
    if CGFloat(CTLineGetTypographicBounds(whole, nil, nil, nil)) <= BubbleMath.wrapWidth { return [whole] }
    let attr = NSAttributedString(string: text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): MarkArt.ink.cg(1),
    ])
    let setter = CTTypesetterCreateWithAttributedString(attr)
    var out: [CTLine] = [], start = 0
    let n = attr.length
    while start < n && out.count < BubbleMath.maxLines {
      let count = max(1, CTTypesetterSuggestLineBreak(setter, start, Double(BubbleMath.wrapWidth)))
      if out.count == BubbleMath.maxLines - 1 && start + count < n {
        let rest = CTTypesetterCreateLine(setter, CFRange(location: start, length: n - start))
        out.append(CTLineCreateTruncatedLine(rest, Double(BubbleMath.wrapWidth), .end, line("…")) ?? rest)
        break
      }
      out.append(CTTypesetterCreateLine(setter, CFRange(location: start, length: count)))
      start += count
    }
    return out
  }

  /// How big the glass is for these words.
  static func size(_ text: String) -> CGSize {
    let ls = lines(text)
    let widest = ls.map { CGFloat(CTLineGetTypographicBounds($0, nil, nil, nil)) }.max() ?? 0
    return BubbleMath.size(textWidth: widest, lines: ls.count)
  }

  /// Draws it in `r` (y up). `pixelScale` is the backing scale, for the shadow. `live`: Echo is
  /// saying these words now, so the rim carries the answer's colours with a soft glow; once said
  /// it is a quiet hairline (colour means "Echo is saying this now"). Asking, the rim is amber.
  /// `toward`: where the light is (the same coordinates as `r`): a thread of light reaches for it.
  static func draw(in ctx: CGContext, _ text: String, intent: String, in r: CGRect, pixelScale px: CGFloat, live: Bool = true, toward: CGPoint? = nil) {
    let glass = CGPath(roundedRect: r, cornerWidth: BubbleMath.corner, cornerHeight: BubbleMath.corner, transform: nil)
    let asking = PearlMath.intent(intent) == "ask"
    ctx.saveGState()
    defer { ctx.restoreGState() }
    // The thread of light from the glass to the pearl's light.
    if let t = toward {
      let near = CGPoint(x: min(max(t.x, r.minX), r.maxX), y: min(max(t.y, r.minY), r.maxY))
      let dx = t.x - near.x, dy = t.y - near.y, d = hypot(dx, dy)
      if d > 3 {
        let reach = min(d - 2, room - 3)
        ctx.saveGState()
        ctx.setStrokeColor(RGB(hex: 0xFFF0D6).cg(0.75))
        ctx.setLineWidth(1.2)
        ctx.setLineCap(.round)
        ctx.setShadow(offset: .zero, blur: 4 * px, color: RGB(hex: 0xFFF0D6).cg(0.6))
        ctx.move(to: near)
        ctx.addLine(to: CGPoint(x: near.x + dx / d * reach, y: near.y + dy / d * reach))
        ctx.strokePath()
        ctx.restoreGState()
      }
    }
    // The glass and its shadow (a soft glow of the answer's colour while Echo is saying it).
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -3 * px), blur: 10 * px, color: CGColor(gray: 0, alpha: 0.42))
    ctx.addPath(glass)
    ctx.setFillColor(MarkArt.glass.cg(0.92))
    ctx.fillPath()
    ctx.restoreGState()
    if live && !asking {
      ctx.saveGState()
      ctx.setShadow(offset: .zero, blur: 12 * px, color: MarkArt.answer[1].cg(0.3))
      ctx.addPath(glass)
      ctx.setFillColor(MarkArt.glass.cg(0.92))
      ctx.fillPath()
      ctx.restoreGState()
    }
    // The rim.
    let rim = CGPath(roundedRect: r.insetBy(dx: 0.75, dy: 0.75), cornerWidth: BubbleMath.corner - 0.75, cornerHeight: BubbleMath.corner - 0.75, transform: nil)
    ctx.saveGState()
    ctx.addPath(rim)
    if asking {
      ctx.setStrokeColor(RGB(hex: PearlMath.lightColours("ask")[0]).cg())
      ctx.setLineWidth(1.5)
      ctx.strokePath()
    } else if live, let space = CGColorSpace(name: CGColorSpace.sRGB),
              let g = CGGradient(colorsSpace: space, colors: MarkArt.answer.map { $0.cg() } as CFArray, locations: MarkArt.answerStops) {
      ctx.setLineWidth(1.5)
      ctx.replacePathWithStrokedPath()
      ctx.clip()
      ctx.drawLinearGradient(g, start: CGPoint(x: r.minX, y: r.maxY), end: CGPoint(x: r.maxX, y: r.minY), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    } else {
      ctx.setStrokeColor(RGB.white.cg(0.18))
      ctx.setLineWidth(1)
      ctx.strokePath()
    }
    ctx.restoreGState()
    // The words: one line in the middle, or each line under the last (never past the glass).
    let ls = lines(text)
    ctx.clip(to: CGRect(x: r.minX + BubbleMath.padLeft - 4, y: r.minY, width: max(0, r.width - BubbleMath.padLeft + 4 - BubbleMath.padRight / 2), height: r.height))
    ctx.textMatrix = .identity
    let x = r.minX + BubbleMath.padLeft - 4
    if ls.count <= 1 {
      ctx.textPosition = CGPoint(x: x, y: (r.midY - CTFontGetCapHeight(font) / 2).rounded(.toNearestOrAwayFromZero))
      CTLineDraw(ls.first ?? line(text), ctx)
    } else {
      for (i, l) in ls.enumerated() {
        ctx.textPosition = CGPoint(x: x, y: (r.maxY - 7 - CTFontGetAscent(font) - CGFloat(i) * BubbleMath.lineHeight).rounded(.toNearestOrAwayFromZero))
        CTLineDraw(l, ctx)
      }
    }
  }
}
