// Renders the pearl and the island (Companion.swift, PillArt.swift, PointMath.swift) to PNGs, the
// way the Mac app draws them: the same code, frame for frame, over a made-up desktop (a dark one
// and a white page), with no window on screen. For looking at the result against the design
// (echo-companion-design.html: the moods, the looks and "the desk").
//
//   scripts/render-companion.sh OUT_DIR
//
// It writes moods-*.png (every mood at each size, on dark and on white, each look), island-*.png
// (the island in each of its states), firefly-*.png (frames of the pearl's light going out to
// show something: leaving, flying, circling, the click's burst, coming home; and its newer
// behaviours: waiting on a lesson step, its three colours, searching, being picked up, a route
// through menus, its light at rest and the Auto look, with firefly-sheet.png of those; and the
// caption beside it: firefly-bubble-*.png, bubble-sheet.png), pointing-*.png
// (the other way, "reach": the crouch, mid-hop, the landing wobble, reaching, the tap) and
// sheet.png with all of them. The edge line and the status chip are drawn here with the numbers in EdgeMath and
// ChipMath (the app draws those with Core Animation layers in Overlays.swift).
import AppKit
import CoreImage

let args = CommandLine.arguments
guard args.count >= 2 else {
  print("usage: render OUT_DIR")
  exit(2)
}
let outDir = URL(fileURLWithPath: args[1])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let px: CGFloat = 2
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ci = CIContext()

func canvas(_ size: CGSize) -> CGContext {
  let ctx = CGContext(data: nil, width: Int(size.width * px), height: Int(size.height * px), bitsPerComponent: 8, bytesPerRow: 0,
                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.scaleBy(x: px, y: px)
  return ctx
}

func save(_ image: CGImage, _ name: String) {
  try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!.write(to: outDir.appendingPathComponent(name))
  print(name)
}

/// A desktop `size` big with a 24 pt menu bar and a window under it: dark (the design's), or a
/// white page with dark text (the hard case for white bars and white words).
func desktop(_ ctx: CGContext, _ size: CGSize, light: Bool) {
  let all = CGRect(origin: .zero, size: size)
  if light {
    ctx.setFillColor(RGB(r: 250, g: 250, b: 252).cg())
    ctx.fill(all)
    for i in 0..<9 {
      ctx.setFillColor(RGB(r: 40, g: 42, b: 54).cg(i % 4 == 0 ? 0.75 : 0.28))
      ctx.fill(CGRect(x: 60, y: size.height - 70 - CGFloat(i) * 22, width: CGFloat(260 + (i * 97) % 320), height: 8))
    }
    ctx.setFillColor(RGB(r: 232, g: 232, b: 237).cg())
  } else {
    ctx.setFillColor(RGB(r: 12, g: 12, b: 18).cg())
    ctx.fill(all)
    for (c, at, r) in [(RGB(r: 27, g: 36, b: 64), CGPoint(x: size.width * 0.2, y: size.height), size.width * 0.7),
                       (RGB(r: 51, g: 32, b: 63), CGPoint(x: size.width, y: 0), size.width * 0.7)] {
      if let g = CGGradient(colorsSpace: space, colors: [c.cg(), c.cg(0)] as CFArray, locations: [0, 1]) {
        ctx.drawRadialGradient(g, startCenter: at, startRadius: 0, endCenter: at, endRadius: r, options: [])
      }
    }
    // A window under the island.
    let win = CGRect(x: size.width * 0.09, y: -10, width: size.width * 0.82, height: size.height - 108)
    ctx.addPath(CGPath(roundedRect: win, cornerWidth: 10, cornerHeight: 10, transform: nil))
    ctx.setFillColor(RGB.white.cg(0.05))
    ctx.fillPath()
    ctx.setFillColor(RGB(r: 0, g: 0, b: 0).cg(0.35))
  }
  ctx.fill(CGRect(x: 0, y: size.height - 24, width: size.width, height: 24))
}

/// What's under the glass, blurred (the app's NSVisualEffectView does this on screen).
func blurred(_ image: CGImage) -> CGImage {
  let src = CIImage(cgImage: image)
  let out = src.clampedToExtent()
    .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 24 * px])
    .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 1.4])
    .cropped(to: src.extent)
  return ci.createCGImage(out, from: src.extent)!
}

/// The moods, and what puts the pearl in each.
let moods = ["idle", "listening", "thinking", "speaking", "happy", "surprised", "needs", "sorry", "sleepy"]

/// A pearl that has been in `mood` long enough to show it, as it is at `t` (a telling moment:
/// mid-hop for happy and surprised, mid-shake for sorry). It is stepped frame by frame, as the app does.
func pearl(_ mood: String, diameter: CGFloat = 32, skin: String = "glass", out: Bool = false, reduced: Bool = false, lively: Bool = true,
           level: Double = 0.8, working: Bool = false, pointer: CGPoint? = nil, until t: Double = 10) -> PearlArt {
  let p = PearlArt()
  p.diameter = diameter
  p.skin = skin
  p.out = out
  p.reduced = reduced
  p.lively = lively
  p.working = working
  p.pointer = pointer
  if ["listening", "thinking", "speaking"].contains(mood) { p.voice = mood }
  p.asking = mood == "needs"
  // Asleep: three quiet minutes first.
  let lead = mood == "sleepy" ? PearlMath.sleepAfter + 6 : 1.6
  var now = t - lead
  let frames = Int(lead * 60)
  for i in 0..<frames {
    let left = t - now
    if mood == "happy", i == frames - 21 { p.celebrate(now: now) }
    if mood == "surprised", i == frames - 16 { p.surprised(now: now) }
    if mood == "sorry", i == frames - 14 { p.miss(now: now) }
    if mood == "listening" || mood == "speaking" { p.setLevel(level, now: now) }
    _ = left
    p.step(now: now, dt: 1.0 / 60)
    now += 1.0 / 60
  }
  return p
}

func label(_ ctx: CGContext, _ text: String, at p: CGPoint, color: RGB = MarkArt.dim, size: CGFloat = 10.5) {
  let s = NSAttributedString(string: text, attributes: [.font: PillArt.font(size, .regular), NSAttributedString.Key(kCTForegroundColorAttributeName as String): color.cg()])
  let line = CTLineCreateWithAttributedString(s)
  ctx.textMatrix = .identity
  ctx.textPosition = CGPoint(x: p.x - CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) / 2, y: p.y)
  CTLineDraw(line, ctx)
}

var sheet: [(String, CGImage)] = []

/// One row of pearls, every mood, on a dark desktop or a white page. `zoom` magnifies the row
/// (drawn with the same code at a higher backing scale), for looking closely at small sizes.
func moodRow(_ name: String, diameter: CGFloat, skin: String = "glass", out: Bool, light: Bool, island: Bool = false, reduced: Bool = false,
             lively: Bool = true, zoom: CGFloat = 1, cols: Int = 9, title: String) {
  let cell = max(80, diameter * 2.9), rowH = max(86, diameter * 2.9 + 22), rows = (moods.count + cols - 1) / cols
  let size = CGSize(width: cell * CGFloat(cols), height: rowH * CGFloat(rows) + 8)
  let scale = px * zoom
  let ctx = CGContext(data: nil, width: Int(size.width * scale), height: Int(size.height * scale), bitsPerComponent: 8, bytesPerRow: 0,
                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.scaleBy(x: scale, y: scale)
  ctx.setFillColor((light ? RGB(r: 250, g: 250, b: 252) : RGB(r: 16, g: 16, b: 22)).cg())
  ctx.fill(CGRect(origin: .zero, size: size))
  for (i, mood) in moods.enumerated() {
    let base = rowH * CGFloat(rows - 1 - i / cols)
    let c = CGPoint(x: cell * (CGFloat(i % cols) + 0.5), y: base + rowH / 2 + 6)
    if island {
      // A piece of the island's glass under it.
      let glass = CGRect(x: c.x - 30, y: c.y - 23, width: 60, height: 46)
      ctx.addPath(CGPath(roundedRect: glass, cornerWidth: 22, cornerHeight: 22, transform: nil))
      ctx.setFillColor(MarkArt.glass.cg(0.92))
      ctx.fillPath()
      ctx.addPath(CGPath(roundedRect: glass.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 21.5, cornerHeight: 21.5, transform: nil))
      ctx.setStrokeColor(RGB.white.cg(MarkArt.hairline))
      ctx.setLineWidth(1)
      ctx.strokePath()
    }
    let t = mood == "thinking" ? 10.3 : 10.0
    pearl(mood, diameter: diameter, skin: skin, out: out, reduced: reduced, lively: lively, until: t).draw(in: ctx, at: c, now: t, pixelScale: scale)
    label(ctx, mood, at: CGPoint(x: c.x, y: base + 5), color: light ? MarkArt.grey : MarkArt.dim, size: max(9, min(11, diameter / 3)))
  }
  label(ctx, title, at: CGPoint(x: size.width / 2, y: size.height - 12), color: light ? MarkArt.grey : MarkArt.dim, size: 9.5)
  let image = ctx.makeImage()!
  save(image, "moods-\(name).png")
  if zoom == 1 { sheet.append(("moods-" + name, image)) }
}

// Every mood: in the island (32 pt), out pointing at each size on a dark desktop and on a white
// page, large (to check the drawing against the design), the other two looks, calm, and reduced motion.
moodRow("large", diameter: 110, out: true, light: false, cols: 3, title: "110 pt · glass · the design's drawing")
moodRow("island", diameter: PillMath.mark, out: false, light: false, island: true, title: "in the island · 32 pt")
moodRow("island-zoom", diameter: PillMath.mark, out: false, light: false, island: true, zoom: 2, cols: 5, title: "in the island · 32 pt (×2)")
moodRow("pointer-dark", diameter: CompanionMath.diameter("medium"), out: true, light: false, title: "out pointing · 32 pt · dark")
moodRow("pointer-white", diameter: CompanionMath.diameter("medium"), out: true, light: true, title: "out pointing · 32 pt · white page")
moodRow("pointer-white-zoom", diameter: CompanionMath.diameter("medium"), out: true, light: true, zoom: 2, cols: 5, title: "out pointing · 32 pt · white page (×2)")
moodRow("small-dark", diameter: CompanionMath.diameter("small"), out: true, light: false, title: "small · 26 pt · dark")
moodRow("small-zoom", diameter: CompanionMath.diameter("small"), out: true, light: false, zoom: 2, cols: 5, title: "small · 26 pt (×2)")
moodRow("small-white", diameter: CompanionMath.diameter("small"), out: true, light: true, title: "small · 26 pt · white page")
moodRow("large-dark", diameter: CompanionMath.diameter("large"), out: true, light: false, title: "large · 40 pt · dark")
moodRow("large-white", diameter: CompanionMath.diameter("large"), out: true, light: true, title: "large · 40 pt · white page")
moodRow("moon-dark", diameter: CompanionMath.diameter("large"), skin: "moon", out: true, light: false, title: "moon · 40 pt · dark")
moodRow("moon-white", diameter: CompanionMath.diameter("large"), skin: "moon", out: true, light: true, title: "moon · 40 pt · white page")
moodRow("skins-zoom", diameter: 32, skin: "moon", out: true, light: false, zoom: 2, cols: 5, title: "moon · 32 pt (×2)")
moodRow("calm", diameter: PillMath.mark, out: false, light: false, island: true, lively: false, title: "calm (not lively) · 32 pt")
moodRow("reduced", diameter: PillMath.mark, out: false, light: false, island: true, reduced: true, title: "reduce motion · 32 pt · still, a slow blink only")

// The island, under the menu bar, in each of its states.
struct Scene {
  let name: String
  var content: PillContent
  var mood = "idle"
  var level = 0.0
  var working = false
  var lit: CGFloat = .infinity
  var away: CGFloat = 0
  var light = false
  var reduced = false
  var at = 10.0
}

let card = PillContent.Card(question: "Send this email to Mira?", detail: "“Running ten minutes late, start without me.”", action: "Send", cancel: "Cancel")
let longCard = PillContent.Card(question: "Delete the 14 selected files from the Projects folder on your Desktop?",
                                detail: "They go to the Trash. You can put them back from there until it is emptied.", action: "Delete", cancel: "Cancel")
let answer = "Click the Rectangle tool, second from the top. Then drag on the canvas to draw one, and let go when it is the size you want."
let scenes = [
  Scene(name: "ready", content: PillContent()),
  Scene(name: "status", content: PillContent(kind: .plain, dim: "Talk mode · just talk")),
  Scene(name: "listening", content: PillContent(kind: .user, main: "Show me how to use Adobe XD", live: true), mood: "listening", level: 0.8),
  Scene(name: "thinking", content: PillContent(kind: .user, main: "Show me how to use Adobe XD", thinking: true), mood: "thinking", at: 10.3),
  Scene(name: "answering", content: PillContent(kind: .echo, main: "Click the Rectangle tool, second from the top."), mood: "speaking", lit: 4, at: 10.48),
  Scene(name: "answering-long-line-1", content: PillContent(kind: .echo, main: answer), mood: "speaking", lit: 6.4, at: 10.48),
  Scene(name: "answering-long-line-2", content: PillContent(kind: .echo, main: answer), mood: "speaking", lit: 16.5, at: 10.9),
  Scene(name: "working", content: PillContent(kind: .plain, main: "Excel · step 2 of 4", dim: " · typing in A1", stop: true), working: true, at: 10.3),
  Scene(name: "working-mark-away", content: PillContent(kind: .plain, main: "Mail · step 3 of 3", dim: " · clicking “Send” · esc to stop", stop: true), working: true, away: 1),
  Scene(name: "card", content: PillContent(card: card), mood: "needs"),
  Scene(name: "card-long", content: PillContent(card: longCard), mood: "needs"),
  Scene(name: "done", content: PillContent(kind: .plain, main: "All steps shown"), mood: "happy"),
  Scene(name: "failed", content: PillContent(kind: .plain, main: "Couldn’t find “Export”", dim: " · trying another way"), mood: "sorry"),
  Scene(name: "asleep", content: PillContent(kind: .plain, dim: "Talk mode · just talk"), mood: "sleepy"),
  Scene(name: "listening-on-white", content: PillContent(kind: .user, main: "Show me how to use Adobe XD", live: true), mood: "listening", level: 0.5, light: true),
  Scene(name: "card-on-white", content: PillContent(card: card), mood: "needs", light: true),
  Scene(name: "thinking-reduced", content: PillContent(kind: .user, main: "Show me how to use Adobe XD", thinking: true), mood: "thinking", reduced: true),
]

for scene in scenes {
  let size = CGSize(width: 720, height: 230)
  let visible = CGRect(x: 0, y: 0, width: size.width, height: size.height - 24)
  let bg = canvas(size)
  desktop(bg, size, light: scene.light)
  let under = bg.makeImage()!
  let ctx = canvas(size)
  ctx.draw(under, in: CGRect(origin: .zero, size: size))

  let art = PillArt()
  art.reduced = scene.reduced
  art.stopShown = scene.content.stop ? 1 : 0
  art.away = scene.away
  art.echoLit = scene.lit
  var layout: (text: PillContent.Card, layout: PillMath.Card)?
  let pill: CGRect
  if let text = scene.content.card {
    let l = art.cardLayout(text, screenWidth: size.width)
    layout = (text, l)
    pill = PillMath.frame(visible: visible, width: l.size.width, height: l.size.height)
  } else {
    let room = PillMath.textRoom(width: PillMath.widest(screenWidth: size.width), stop: scene.content.stop)
    let width = PillMath.width(text: art.textWidth(scene.content, room: room), stop: scene.content.stop, screenWidth: size.width)
    pill = PillMath.frame(visible: visible, width: width)
  }
  // The blurred desktop under the glass.
  let corner = layout == nil ? PillMath.corner : PillMath.cardCorner
  ctx.saveGState()
  ctx.addPath(CGPath(roundedRect: pill, cornerWidth: corner, cornerHeight: corner, transform: nil))
  ctx.clip()
  ctx.draw(blurred(under), in: CGRect(origin: .zero, size: size))
  ctx.restoreGState()
  // The mouse is somewhere down and to the right of the island: the calm moods look at it.
  let m = pearl(scene.mood, diameter: PillMath.mark, reduced: scene.reduced, level: scene.level, working: scene.working,
                pointer: scene.mood == "idle" && !scene.working ? CGPoint(x: 0.7, y: -0.5) : nil, until: scene.at)
  art.draw(in: ctx, pill: pill, content: scene.content, previous: nil, mix: 1, newWord: 1, pearl: m, card: layout, grown: layout == nil ? 0 : 1, now: scene.at, pixelScale: px)
  let image = ctx.makeImage()!
  save(image, "island-\(scene.name).png")
  sheet.append(("island-" + scene.name, image))
  print("  \(Int(pill.width)) × \(Int(pill.height)) pt")
}

func target(_ ctx: CGContext, _ r: CGRect, light: Bool, pressed: Bool = false) {
  ctx.addPath(CGPath(roundedRect: r, cornerWidth: 7, cornerHeight: 7, transform: nil))
  ctx.setFillColor((light ? RGB(r: 0, g: 110, b: 240) : RGB(r: 60, g: 62, b: 76)).mix(RGB.white, pressed ? 0.25 : 0).cg())
  ctx.fillPath()
  label(ctx, "Send", at: CGPoint(x: r.midX, y: r.midY - 4), color: RGB.white, size: 12)
  // The ring (Pointer.swift outlineTarget): white with a soft dark edge.
  let box = r.insetBy(dx: -4, dy: -4)
  ctx.saveGState()
  ctx.setShadow(offset: .zero, blur: 4 * px, color: CGColor(gray: 0, alpha: 0.55))
  ctx.addPath(CGPath(roundedRect: box, cornerWidth: 11, cornerHeight: 11, transform: nil))
  ctx.setStrokeColor(RGB.white.cg(0.95))
  ctx.setLineWidth(1.5)
  ctx.strokePath()
  ctx.restoreGState()
}

// The firefly: the pearl stays in the island and its light goes to a ringed target, the way the
// app sends it (Pointer.swift): it leaves from the rim, flies in a gentle curve with a short
// trail, circles the target's edge, dives for a click with a small burst, and comes home.
for light in [false, true] {
  let size = CGSize(width: 720, height: 230)
  let island = CGRect(x: 30, y: 152, width: 150, height: 46), slot = PillMath.slotCenter(island)
  let button = CGRect(x: 118, y: 52, width: 84, height: 28), R = PillMath.mark / 2
  let moments = ["leaving", "flying", "circling", "a click: the burst", "coming home", "home"]
  for row in 0..<2 {
    let ctx = canvas(size)
    desktop(ctx, size, light: light)
    for col in 0..<3 {
      let name = moments[row * 3 + col], dx = CGFloat(col) * 240
      ctx.saveGState()
      ctx.clip(to: CGRect(x: dx, y: 0, width: 240, height: size.height))
      ctx.translateBy(x: dx, y: 0)
      ctx.addPath(CGPath(roundedRect: island, cornerWidth: 22, cornerHeight: 22, transform: nil))
      ctx.setFillColor(MarkArt.glass.cg(0.92))
      ctx.fillPath()
      ctx.addPath(CGPath(roundedRect: island.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 21.5, cornerHeight: 21.5, transform: nil))
      ctx.setStrokeColor(RGB.white.cg(MarkArt.hairline))
      ctx.setLineWidth(1)
      ctx.strokePath()
      label(ctx, name == "a click: the burst" ? "Clicking “Send”" : name == "home" ? "Ready" : "Pointing at “Send”", at: CGPoint(x: island.minX + 96, y: island.midY - 4), color: MarkArt.ink, size: 11)
      target(ctx, button, light: light, pressed: name == "a click: the burst")

      // Stepped as Pointer.swift and Caption.swift step them.
      let p = PearlArt(), f = FireflyArt()
      p.diameter = PillMath.mark
      let start = 10.0, first = PearlMath.orbit(button, laps: 0), centre = CGPoint(x: button.midX, y: button.midY)
      let out = PearlMath.Flight(from: PearlMath.rim(of: slot, radius: R, toward: centre), to: first, at: start + 0.14)
      let lap = PearlMath.lap(button)
      let dive = PearlMath.Flight(from: PearlMath.orbit(button, laps: 0.35 / lap), to: centre, at: out.lands + 0.35, quick: true)
      let back = PearlMath.Flight(from: first, to: PearlMath.rim(of: slot, radius: R, toward: first), at: out.lands + 1)
      let until: Double
      switch name {
      case "leaving": until = out.start + out.duration * 0.26
      case "flying": until = out.start + out.duration * 0.62
      case "circling": until = out.lands + lap * 0.8
      case "a click: the burst": until = dive.lands + 0.1
      case "coming home": until = back.start + back.duration * 0.55
      default: until = back.lands + 0.22
      }
      f.intent = name == "a click: the burst" ? "act" : "show"
      f.move(to: out.from, now: start, jump: true)
      var now = start - 0.6, burst = false, home = false
      while now <= until {
        var at = out.position(at: now)
        if now >= out.lands { at = PearlMath.orbit(button, laps: min(PearlMath.laps, (now - out.lands) / lap)) }
        if name == "a click: the burst", now >= dive.start {
          at = dive.position(at: now)
          if dive.done(at: now), !burst { burst = true; f.move(to: at, now: now); f.burst(now: now) }
        }
        if ["coming home", "home"].contains(name), now >= back.start { at = back.position(at: now) }
        let away = now >= start && !(name == "home" && now >= back.lands)
        if name == "home", now >= back.lands, !home { home = true; p.lightHome(now: now) }
        p.lightAway = away
        p.target = away ? PearlMath.gaze(from: slot, to: now < out.start ? first : at) : nil
        if now >= start { f.move(to: at, now: now) }
        f.step(now: now, dt: 1.0 / 120)
        p.step(now: now, dt: 1.0 / 120)
        now += 1.0 / 120
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      if !home { f.draw(in: ctx, now: until, pixelScale: px) }
      label(ctx, name, at: CGPoint(x: 120, y: 12), color: light ? MarkArt.grey : MarkArt.dim, size: 11)
      ctx.restoreGState()
    }
    let image = ctx.makeImage()!
    save(image, "firefly-\(light ? "white" : "dark")-\(row + 1).png")
    sheet.append(("firefly", image))
  }
}

// The firefly's newer behaviours (docs/firefly-protocol.md), each as three moments, on a dark
// window and on a white page: waiting on a lesson step (the slow breath, then the burst when the
// step passes), its three colours (show, act, ask: hovering beside the thing), searching (the
// figure of eight, found, not found), being picked up (under the mouse, dragged with a soft ring
// on what is under it, dropped), and a route through menus (File, Export, PDF…). Stepped the way
// Pointer.swift and Caption.swift step them. The rings, the menu and the arrow are drawn here
// with the app's numbers (the app draws its rings with Core Animation layers).
var fireflySheet: [CGImage] = []

enum RingKind { case none, full, light, soft }

/// A button with a name, and the ring the pointer puts round it: a target's (full), a stop's on
/// the way through menus (light), or the soft one under a dragged light.
func thing(_ ctx: CGContext, _ r: CGRect, _ title: String, light: Bool, ring: RingKind = .none, primary: Bool = true, corner: CGFloat = 7) {
  ctx.addPath(CGPath(roundedRect: r, cornerWidth: corner, cornerHeight: corner, transform: nil))
  ctx.setFillColor((primary ? (light ? RGB(r: 0, g: 110, b: 240) : RGB(r: 60, g: 62, b: 76)) : (light ? RGB(r: 226, g: 227, b: 233) : RGB(r: 40, g: 41, b: 52))).cg())
  ctx.fillPath()
  label(ctx, title, at: CGPoint(x: r.midX, y: r.midY - 4), color: primary || !light ? RGB.white : RGB(r: 40, g: 42, b: 54), size: 12)
  guard ring != .none else { return }
  let out: CGFloat = ring == .soft ? 3 : 4, box = r.insetBy(dx: -out, dy: -out)
  ctx.saveGState()
  ctx.setShadow(offset: .zero, blur: (ring == .soft ? 5 : 4) * px, color: CGColor(gray: 0, alpha: ring == .soft ? 0.4 : 0.55))
  ctx.addPath(CGPath(roundedRect: box, cornerWidth: corner + out, cornerHeight: corner + out, transform: nil))
  ctx.setStrokeColor(RGB.white.cg(ring == .full ? 0.95 : ring == .light ? 0.7 : 0.62))
  ctx.setLineWidth(ring == .full ? 1.5 : 1)
  ctx.strokePath()
  ctx.restoreGState()
}

/// The mouse's arrow, its tip at `p`.
func arrow(_ ctx: CGContext, at p: CGPoint) {
  let pts = [(0.0, 0.0), (0.0, -16.0), (3.8, -12.4), (6.6, -18.6), (9.2, -17.4), (6.4, -11.4), (11.4, -11.4)].map { CGPoint(x: p.x + $0.0, y: p.y + $0.1) }
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -1 * px), blur: 2 * px, color: CGColor(gray: 0, alpha: 0.35))
  ctx.addLines(between: pts)
  ctx.closePath()
  ctx.setFillColor(CGColor(gray: 0, alpha: 1))
  ctx.fillPath()
  ctx.restoreGState()
  ctx.addLines(between: pts)
  ctx.closePath()
  ctx.setStrokeColor(RGB.white.cg())
  ctx.setLineWidth(1)
  ctx.strokePath()
}

/// A piece of the island with its line, where the pearl sits.
let fireflyIsland = CGRect(x: 30, y: 152, width: 170, height: 46)
func islandPiece(_ ctx: CGContext, _ text: String) {
  ctx.addPath(CGPath(roundedRect: fireflyIsland, cornerWidth: 22, cornerHeight: 22, transform: nil))
  ctx.setFillColor(MarkArt.glass.cg(0.92))
  ctx.fillPath()
  ctx.addPath(CGPath(roundedRect: fireflyIsland.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 21.5, cornerHeight: 21.5, transform: nil))
  ctx.setStrokeColor(RGB.white.cg(MarkArt.hairline))
  ctx.setLineWidth(1)
  ctx.strokePath()
  if !text.isEmpty { label(ctx, text, at: CGPoint(x: fireflyIsland.minX + 106, y: fireflyIsland.midY - 4), color: MarkArt.ink, size: 11) }
}

/// The pearl in the island and its light, stepped at 120 Hz from `from` to `until` as the app
/// steps them: `each` says where the light is at each moment (nil: it is home) and may set
/// whatever else is going on then (a burst, a mood, the breath).
func stepLight(_ p: PearlArt, _ f: FireflyArt, slot: CGPoint, from: Double, until: Double, each: (Double) -> CGPoint?) {
  var now = from, first = true
  while now <= until + 1e-9 {
    let at = each(now)
    p.lightAway = at != nil
    p.target = at.flatMap { PearlMath.gaze(from: slot, to: $0) }
    if let at { f.move(to: at, now: now, jump: first) ; first = false }
    f.step(now: now, dt: 1.0 / 120)
    p.step(now: now, dt: 1.0 / 120)
    now += 1.0 / 120
  }
}

typealias FireflyCell = (name: String, line: String, draw: (CGContext, Bool, CGPoint) -> Void)

func fireflyPicture(_ name: String, _ cells: [FireflyCell]) {
  for light in [false, true] {
    let size = CGSize(width: 720, height: 230)
    let ctx = canvas(size)
    desktop(ctx, size, light: light)
    // Three cells across (two wider ones, for a picture that needs the room).
    let w = size.width / CGFloat(cells.count == 2 ? 2 : 3)
    for (col, cell) in cells.enumerated() {
      let dx = CGFloat(col) * w
      ctx.saveGState()
      ctx.clip(to: CGRect(x: dx, y: 0, width: w, height: size.height))
      ctx.translateBy(x: dx, y: 0)
      islandPiece(ctx, cell.line)
      cell.draw(ctx, light, PillMath.slotCenter(fireflyIsland))
      label(ctx, cell.name, at: CGPoint(x: w / 2, y: 12), color: light ? MarkArt.grey : MarkArt.dim, size: 11)
      ctx.restoreGState()
    }
    let image = ctx.makeImage()!
    save(image, "firefly-\(name)-\(light ? "white" : "dark").png")
    sheet.append(("firefly-" + name, image))
    fireflySheet.append(image)
  }
}

do {
  let button = CGRect(x: 96, y: 62, width: 84, height: 28), R = PillMath.mark / 2
  let start = 10.0, lap = PearlMath.lap(button)
  func newPearl() -> PearlArt { let p = PearlArt(); p.diameter = PillMath.mark; return p }
  /// Out from the rim to the thing, twice round it, then resting at its corner (with its bob).
  func showing(_ slot: CGPoint, _ r: CGRect = button) -> (out: PearlMath.Flight, at: (Double) -> CGPoint) {
    let centre = CGPoint(x: r.midX, y: r.midY), first = PearlMath.orbit(r, laps: 0), l = PearlMath.lap(r)
    let out = PearlMath.Flight(from: PearlMath.rim(of: slot, radius: R, toward: centre), to: first, at: start + 0.14)
    return (out, { now in
      if now < out.lands { return out.position(at: now) }
      var p = PearlMath.orbit(r, laps: min(PearlMath.laps, (now - out.lands) / l))
      p.y += 1.2 * CGFloat(sin(now * 2.6))
      return p
    })
  }

  // Waiting on a lesson step: the slow breath (out, then in), and the burst when the step passes.
  fireflyPicture("waiting", [
    ("waiting: breath out", "Step 2 of 5", { ctx, light, slot in
      thing(ctx, button, "Send", light: light, ring: .full)
      let p = newPearl(), f = FireflyArt(), s = showing(slot), rest = s.out.lands + PearlMath.laps * lap, until = rest + 2.6 * 2 + 0.25
      stepLight(p, f, slot: slot, from: start, until: until) { now in f.breath = now >= s.out.lands ? PearlMath.breath(now - s.out.lands) : 0; return s.at(now) }
      f.breath = PearlMath.breath(0.25)
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }),
    ("waiting: breath in", "Step 2 of 5", { ctx, light, slot in
      thing(ctx, button, "Send", light: light, ring: .full)
      let p = newPearl(), f = FireflyArt(), s = showing(slot), until = s.out.lands + PearlMath.laps * lap + 2.6 * 2 + 1.3
      stepLight(p, f, slot: slot, from: start, until: until) { now in s.at(now) }
      f.breath = PearlMath.breath(1.3)
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }),
    ("step passed: burst, pleased", "Step 2 of 5", { ctx, light, slot in
      thing(ctx, button, "Send", light: light, ring: .full)
      let p = newPearl(), f = FireflyArt(), s = showing(slot), passed = s.out.lands + PearlMath.laps * lap + 3, until = passed + 0.13
      var burst = false
      stepLight(p, f, slot: slot, from: start, until: until) { now in
        if now >= passed, !burst { burst = true; f.burst(now: now); p.done(now: now) }
        return s.at(now)
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }),
  ])

  // Its colour says why it is out: white to show, the answer's colours to act, amber to ask.
  fireflyPicture("intent", [
    ("show: white", "Pointing at “Send”", { ctx, light, slot in
      thing(ctx, button, "Send", light: light, ring: .full)
      let p = newPearl(), f = FireflyArt(), s = showing(slot), until = s.out.lands + lap * 0.8
      stepLight(p, f, slot: slot, from: start, until: until) { now in s.at(now) }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }),
    ("act: the answer’s colours", "Clicking “Send”", { ctx, light, slot in
      thing(ctx, button, "Send", light: light, ring: .full)
      let p = newPearl(), f = FireflyArt(), s = showing(slot), until = s.out.lands + lap * 0.8
      p.working = true
      f.intent = "act"
      stepLight(p, f, slot: slot, from: start, until: until) { now in s.at(now) }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }),
    ("ask: amber, beside it", "Send this email?", { ctx, light, slot in
      thing(ctx, button, "Send", light: light, ring: .full)
      let p = newPearl(), f = FireflyArt(), s = showing(slot)
      let beside = PearlMath.hover(beside: button, in: CGRect(x: 0, y: 0, width: 240, height: 230))
      // Found, then the server says the step is risky: off the edge to hover beside it.
      let asked = s.out.lands + 0.5, over = PearlMath.Flight(from: s.at(asked), to: beside, at: asked), until = over.lands + 1.2
      stepLight(p, f, slot: slot, from: start, until: until) { now in
        guard now >= asked else { return s.at(now) }
        f.intent = "ask"
        p.asking = true
        var at = over.position(at: now)
        if now >= over.lands { at.y += 2.2 * CGFloat(sin(now * 1.7)) }
        return at
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }),
  ])

  // Searching: a slow figure of eight in the app's window, the pearl puzzled; found; not found.
  let windowMiddle = CGPoint(x: 126, y: 78)
  fireflyPicture("searching", [
    ("searching: a figure of eight", "", { ctx, light, slot in
      let p = newPearl(), f = FireflyArt()
      let out = PearlMath.Flight(from: PearlMath.rim(of: slot, radius: R, toward: windowMiddle), to: windowMiddle, at: start + 0.14), until = out.lands + PearlMath.searchLoop * 0.72
      p.asking = true
      stepLight(p, f, slot: slot, from: start, until: until) { now in
        f.searching = now >= out.lands
        return now < out.lands ? out.position(at: now) : PearlMath.search(around: windowMiddle, elapsed: now - out.lands)
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }),
    ("found: it goes there", "Pointing at “Send”", { ctx, light, slot in
      let far = CGRect(x: 136, y: 28, width: 84, height: 28)
      thing(ctx, far, "Send", light: light, ring: .full)
      let p = newPearl(), f = FireflyArt()
      let found = start + 1.9, from = PearlMath.search(around: windowMiddle, elapsed: found - start)
      let go = PearlMath.Flight(from: from, to: PearlMath.orbit(far, laps: 0), at: found), until = go.start + go.duration * 0.6
      stepLight(p, f, slot: slot, from: start, until: until) { now in
        p.asking = now < found
        f.searching = now < found
        return now < found ? PearlMath.search(around: windowMiddle, elapsed: now - start) : go.position(at: now)
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }),
    ("not found: home, sorry", "Couldn’t find “Send”", { ctx, light, slot in
      let p = newPearl(), f = FireflyArt()
      let gaveUp = start + 2.2, from = PearlMath.search(around: windowMiddle, elapsed: gaveUp - start)
      let back = PearlMath.Flight(from: from, to: PearlMath.rim(of: slot, radius: R, toward: from), at: gaveUp), until = back.start + back.duration * 0.5
      var sorry = false
      stepLight(p, f, slot: slot, from: start, until: until) { now in
        p.asking = now < gaveUp
        f.searching = now < gaveUp
        if now >= gaveUp, !sorry { sorry = true; p.miss(now: now) }
        return now < gaveUp ? PearlMath.search(around: windowMiddle, elapsed: now - start) : back.position(at: now)
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }),
  ])

  // Picking it up: under the mouse it swells (it can be held); dragged, what is under it gets a
  // soft ring and the pearl watches; dropped, it settles there with a small burst.
  let send = CGRect(x: 30, y: 66, width: 78, height: 28), other = CGRect(x: 138, y: 30, width: 84, height: 28)
  fireflyPicture("grab", [
    ("your mouse on it: pick it up", "Pointing at “Send”", { ctx, light, slot in
      thing(ctx, send, "Send", light: light, ring: .full)
      thing(ctx, other, "Save draft", light: light, primary: false)
      let p = newPearl(), f = FireflyArt(), s = showing(slot, send), until = s.out.lands + PearlMath.laps * PearlMath.lap(send) + 1
      stepLight(p, f, slot: slot, from: start, until: until) { now in f.hot = now > until - 0.4; return s.at(now) }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
      arrow(ctx, at: CGPoint(x: f.position.x + 4, y: f.position.y - 3))
    }),
    ("dragged: a soft ring under it", "Pointing at “Send”", { ctx, light, slot in
      thing(ctx, send, "Send", light: light, ring: .full)
      thing(ctx, other, "Save draft", light: light, ring: .soft, primary: false)
      let p = newPearl(), f = FireflyArt(), s = showing(slot, send), took = s.out.lands + PearlMath.laps * PearlMath.lap(send) + 1, until = took + 0.5
      let from = s.at(took), to = CGPoint(x: other.midX - 14, y: other.midY + 2)
      var mouse = from
      stepLight(p, f, slot: slot, from: start, until: until) { now in
        guard now >= took else { return s.at(now) }
        f.hot = true
        let k = CGFloat(CompanionMath.easeOut((now - took) / 0.5))
        mouse = CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k)
        return CGPoint(x: mouse.x - 5, y: mouse.y + 5)
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
      arrow(ctx, at: mouse)
    }),
    ("dropped: this one", "", { ctx, light, slot in
      thing(ctx, send, "Send", light: light)
      thing(ctx, other, "Save draft", light: light, ring: .full, primary: false)
      let p = newPearl(), f = FireflyArt()
      let drop = CGPoint(x: other.midX - 19, y: other.midY + 7), at = start + 0.5
      let settle = PearlMath.Flight(from: drop, to: PearlMath.orbit(other, laps: 0), at: at), until = at + 0.2
      var burst = false
      stepLight(p, f, slot: slot, from: start, until: until) { now in
        if now >= at, !burst { burst = true; f.move(to: drop, now: now); f.burst(now: now) }
        return now < at ? drop : settle.position(at: now)
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
      arrow(ctx, at: CGPoint(x: drop.x + 5, y: drop.y - 5))
    }),
  ])

  // A route through menus: File, then Export once File is open, then PDF… once Export is.
  let file = CGRect(x: 22, y: 112, width: 36, height: 20), export = CGRect(x: 26, y: 62, width: 86, height: 20), pdf = CGRect(x: 126, y: 62, width: 86, height: 20)
  func menus(_ ctx: CGContext, light: Bool, open: Int, on: Int) {
    let ink = light ? RGB(r: 40, g: 42, b: 54) : MarkArt.ink, paper = light ? RGB(r: 246, g: 246, b: 248) : RGB(r: 38, g: 39, b: 48)
    func item(_ r: CGRect, _ title: String, ring: RingKind, lit: Bool) {
      if lit {
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: 5, cornerHeight: 5, transform: nil))
        ctx.setFillColor(RGB(r: 0, g: 110, b: 240).cg(light ? 0.9 : 0.75))
        ctx.fillPath()
      }
      label(ctx, title, at: CGPoint(x: r.midX, y: r.midY - 4), color: lit ? RGB.white : ink, size: 11.5)
      guard ring != .none else { return }
      let box = r.insetBy(dx: -4, dy: -4)
      ctx.saveGState()
      ctx.setShadow(offset: .zero, blur: 4 * px, color: CGColor(gray: 0, alpha: 0.55))
      ctx.addPath(CGPath(roundedRect: box, cornerWidth: 8, cornerHeight: 8, transform: nil))
      ctx.setStrokeColor(RGB.white.cg(ring == .full ? 0.95 : 0.7))
      ctx.setLineWidth(ring == .full ? 1.5 : 1)
      ctx.strokePath()
      ctx.restoreGState()
    }
    func sheetOfMenu(_ r: CGRect) {
      ctx.saveGState()
      ctx.setShadow(offset: CGSize(width: 0, height: -3 * px), blur: 10 * px, color: CGColor(gray: 0, alpha: 0.35))
      ctx.addPath(CGPath(roundedRect: r, cornerWidth: 7, cornerHeight: 7, transform: nil))
      ctx.setFillColor(paper.cg())
      ctx.fillPath()
      ctx.restoreGState()
    }
    // The app's menus, as a strip (the real ones are in the menu bar).
    ctx.setFillColor((light ? RGB(r: 232, g: 232, b: 237) : RGB(r: 26, g: 27, b: 34)).cg())
    ctx.fill(CGRect(x: 12, y: 108, width: 216, height: 28))
    if open >= 1 { sheetOfMenu(CGRect(x: 20, y: 30, width: 98, height: 78)) }
    if open >= 2 { sheetOfMenu(CGRect(x: 120, y: 32, width: 98, height: 56)) }
    item(file, "File", ring: on == 0 ? .light : .none, lit: open >= 1)
    for (i, t) in ["Edit", "View"].enumerated() { label(ctx, t, at: CGPoint(x: 84 + CGFloat(i) * 42, y: 118), color: ink, size: 11.5) }
    if open >= 1 {
      label(ctx, "New", at: CGPoint(x: 44, y: 90), color: ink, size: 11.5)
      item(export, "Export  ›", ring: on == 1 ? .light : .none, lit: open >= 2)
      label(ctx, "Print…", at: CGPoint(x: 49, y: 40), color: ink, size: 11.5)
    }
    if open >= 2 {
      item(pdf, "PDF…", ring: on == 2 ? .full : .none, lit: false)
      label(ctx, "PNG…", at: CGPoint(x: 147, y: 40), color: ink, size: 11.5)
    }
  }
  /// The light at stop `on` of the route, having come by the stops before it.
  func routeCell(_ on: Int) -> (CGContext, Bool, CGPoint) -> Void {
    return { ctx, light, slot in
      menus(ctx, light: light, open: on, on: on)
      let p = newPearl(), f = FireflyArt(), stops = [file, export, pdf]
      var flights = [PearlMath.Flight(from: PearlMath.rim(of: slot, radius: R, toward: CGPoint(x: file.midX, y: file.midY)), to: PearlMath.orbit(file, laps: 0), at: start + 0.14)]
      for i in 1...2 { flights.append(PearlMath.Flight(from: flights[i - 1].to, to: PearlMath.orbit(stops[i], laps: 0), at: flights[i - 1].lands + PearlMath.Route.rest + 0.5)) }
      let until = on == 2 ? flights[2].lands + PearlMath.lap(pdf) * 0.3 : flights[on].lands + 0.3
      stepLight(p, f, slot: slot, from: start, until: until) { now in
        let i = flights.lastIndex { now >= $0.start } ?? 0
        if i == 2, now >= flights[2].lands { return PearlMath.orbit(pdf, laps: (now - flights[2].lands) / PearlMath.lap(pdf)) }
        return flights[min(i, on)].position(at: now)
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
    }
  }
  fireflyPicture("route", [
    ("1: on File, until you open it", "Pointing at “File”", routeCell(0)),
    ("2: File is open: on Export", "Pointing at “Export”", routeCell(1)),
    ("3: the target: PDF…", "Pointing at “PDF…”", routeCell(2)),
  ])
}

// Asleep with its light home, the light rests inside it: a faint slow glow at its centre. And the
// Auto look: Moon over a dark background, Glass over a light one.
do {
  let size = CGSize(width: 720, height: 230)
  let ctx = canvas(size)
  for (col, lightHalf) in [false, false, true].enumerated() {
    let cellRect = CGRect(x: CGFloat(col) * 240, y: 0, width: 240, height: size.height)
    ctx.setFillColor((lightHalf ? RGB(r: 250, g: 250, b: 252) : RGB(r: 16, g: 16, b: 22)).cg())
    ctx.fill(cellRect)
  }
  func glassUnder(_ c: CGPoint, _ d: CGFloat) {
    let glass = CGRect(x: c.x - d * 0.95, y: c.y - d * 0.72, width: d * 1.9, height: d * 1.44)
    ctx.addPath(CGPath(roundedRect: glass, cornerWidth: glass.height / 2, cornerHeight: glass.height / 2, transform: nil))
    ctx.setFillColor(MarkArt.glass.cg(0.92))
    ctx.fillPath()
    ctx.addPath(CGPath(roundedRect: glass.insetBy(dx: 0.5, dy: 0.5), cornerWidth: glass.height / 2, cornerHeight: glass.height / 2, transform: nil))
    ctx.setStrokeColor(RGB.white.cg(MarkArt.hairline))
    ctx.setLineWidth(1)
    ctx.strokePath()
  }
  // Asleep, close up (the glow at its fullest and at its faintest), then at the island's size.
  for (i, (skin, t)) in [("glass", 10.0 + .pi / 2.2), ("moon", 10.0 + .pi / 2.2)].enumerated() {
    let c = CGPoint(x: 70 + CGFloat(i) * 110, y: 140)
    glassUnder(c, 64)
    pearl("sleepy", diameter: 64, skin: skin, until: t).draw(in: ctx, at: c, now: t, pixelScale: px)
    label(ctx, "asleep · \(skin)", at: CGPoint(x: c.x, y: 84), size: 9.5)
  }
  for (i, skin) in ["glass", "moon"].enumerated() {
    let c = CGPoint(x: 70 + CGFloat(i) * 110, y: 48)
    glassUnder(c, 32)
    pearl("sleepy", diameter: PillMath.mark, skin: skin, until: 10.6).draw(in: ctx, at: c, now: 10.6, pixelScale: px)
  }
  label(ctx, "its light at rest · in the island at 32 pt", at: CGPoint(x: 125, y: 12), size: 9.5)
  // Auto: the system's appearance decides (CompanionMath.wear): Moon in dark mode, Glass in light.
  for (i, (dark, title)) in [(true, "auto · dark mode: Moon"), (false, "auto · light mode: Glass")].enumerated() {
    let c = CGPoint(x: 600, y: 160 - CGFloat(i) * 96)
    ctx.setFillColor((dark ? RGB(r: 16, g: 16, b: 22) : RGB(r: 250, g: 250, b: 252)).cg())
    ctx.fill(CGRect(x: 480, y: c.y - 46, width: 240, height: 96))
    glassUnder(c, 40)
    let skin = CompanionMath.wear("auto", systemDark: dark)
    pearl("idle", diameter: 40, skin: skin, pointer: CGPoint(x: -0.5, y: -0.3), until: 10).draw(in: ctx, at: c, now: 10, pixelScale: px)
    label(ctx, title, at: CGPoint(x: c.x, y: c.y - 42), color: dark ? MarkArt.dim : MarkArt.grey, size: 9.5)
  }
  let image = ctx.makeImage()!
  save(image, "firefly-rest-and-look.png")
  sheet.append(("firefly-rest-and-look", image))
  fireflySheet.append(image)
}

// The caption beside the light (BubbleArt, placed by BubbleMath as Pointer.swift places it): what
// this step is, in a few words, once the light is there. Beside a target for each colour (show,
// act, ask), near the screen's right edge (it slides back on), with a long name (cut in the
// middle), in a lesson ("Your turn"), under the menu bar and while it searches; on dark and on
// white, with bubble-sheet.png of those and bubble-zoom.png of two of them at twice the size.
do {
  let R = PillMath.mark / 2, start = 10.0
  /// The light, out to `r` and at rest at its corner (or hovering beside it, asking), and its
  /// caption, in a cell `width` wide (without its menu bar).
  func scene(_ ctx: CGContext, _ light: Bool, _ slot: CGPoint, _ r: CGRect, _ title: String, intent: String, words: String, breath: Bool = false, width: CGFloat = 240) {
    let cellBounds = CGRect(x: 0, y: 0, width: width, height: 206)
    thing(ctx, r, title, light: light, ring: .full)
    let p = PearlArt(), f = FireflyArt()
    p.diameter = PillMath.mark
    p.working = intent == "act"
    p.asking = intent == "ask"
    f.intent = intent
    let rest = intent == "ask" ? PearlMath.hover(beside: r, in: cellBounds) : PearlMath.orbit(r, laps: 0)
    let out = PearlMath.Flight(from: PearlMath.rim(of: slot, radius: R, toward: rest), to: rest, at: start + 0.14), until = out.lands + 3
    stepLight(p, f, slot: slot, from: start, until: until) { now in now < out.lands ? out.position(at: now) : rest }
    if breath { f.breath = PearlMath.breath(1.3) }
    p.draw(in: ctx, at: slot, now: until, pixelScale: px)
    f.draw(in: ctx, now: until, pixelScale: px)
    let size = BubbleArt.size(words)
    let at = BubbleMath.origin(target: r, light: rest, size: size, bounds: cellBounds, avoiding: [fireflyIsland.insetBy(dx: -6, dy: -6)])
    BubbleArt.draw(in: ctx, words, intent: intent, in: CGRect(origin: at, size: size), pixelScale: px)
  }
  let button = CGRect(x: 40, y: 62, width: 84, height: 28)
  let before = fireflySheet.count
  fireflyPicture("bubble-intent", [
    ("show: white edge", "Pointing at “Send”", { ctx, light, slot in
      scene(ctx, light, slot, button, "Send", intent: "show", words: BubbleMath.phrase())
    }),
    ("act: the answer’s colours", "Mail · step 2 of 4", { ctx, light, slot in
      scene(ctx, light, slot, button, "Send", intent: "act", words: BubbleMath.phrase(action: "click", target: "Send"))
    }),
    ("ask: amber", "Send this email?", { ctx, light, slot in
      scene(ctx, light, slot, CGRect(x: 20, y: 62, width: 84, height: 28), "Send", intent: "ask", words: BubbleMath.phrase(moment: .asking))
    }),
  ])
  fireflyPicture("bubble-places", [
    ("at the right edge: it slides back on", "Mail · step 3 of 4", { ctx, light, slot in
      scene(ctx, light, slot, CGRect(x: 150, y: 62, width: 78, height: 28), "Trash", intent: "act",
            words: BubbleMath.phrase(action: "drag", target: "Draft", to: "Trash"))
    }),
    ("a lesson: your turn", "Step 2 of 5", { ctx, light, slot in
      scene(ctx, light, slot, button, "Rectangle", intent: "show", words: BubbleMath.phrase(moment: .waiting), breath: true)
    }),
    ("searching", "", { ctx, light, slot in
      let p = PearlArt(), f = FireflyArt(), c = CGPoint(x: 110, y: 86)
      p.diameter = PillMath.mark
      p.asking = true
      let out = PearlMath.Flight(from: PearlMath.rim(of: slot, radius: R, toward: c), to: c, at: start + 0.14), until = out.lands + PearlMath.searchLoop * 0.72
      stepLight(p, f, slot: slot, from: start, until: until) { now in
        f.searching = now >= out.lands
        return now < out.lands ? out.position(at: now) : PearlMath.search(around: c, elapsed: now - out.lands)
      }
      p.draw(in: ctx, at: slot, now: until, pixelScale: px)
      f.draw(in: ctx, now: until, pixelScale: px)
      let words = BubbleMath.phrase(target: "Export…", moment: .searching), size = BubbleArt.size(words), loop = PearlMath.searchBox(around: c)
      let at = BubbleMath.origin(target: loop, light: CGPoint(x: loop.midX, y: loop.minY), size: size, bounds: CGRect(x: 0, y: 0, width: 240, height: 206))
      BubbleArt.draw(in: ctx, words, intent: "show", in: CGRect(origin: at, size: size), pixelScale: px)
    }),
  ])
  fireflyPicture("bubble-wide", [
    ("a long name: cut in the middle", "Excel · step 2 of 6", { ctx, light, slot in
      scene(ctx, light, slot, CGRect(x: 30, y: 62, width: 150, height: 28), "Quarterly report…", intent: "act",
            words: BubbleMath.phrase(action: "type_text", target: "Quarterly report figures final version 3"), width: 360)
    }),
    ("in the menu bar: under it, with its own narration", "", { ctx, light, slot in
      scene(ctx, light, slot, CGRect(x: 250, y: 208, width: 44, height: 20), "File", intent: "act", words: BubbleMath.phrase(caption: "Opening the File menu", action: "click", target: "File"), width: 360)
    }),
  ])
  // A sentence of Echo's beside the thing it explains: wrapped, lit while it is said, quiet after, with its thread to the light.
  for light in [false, true] {
    let size = CGSize(width: 1000, height: 230), ctx = canvas(size)
    desktop(ctx, size, light: light)
    let words = BubbleMath.sentence("Start with the smile. Look straight at it and it almost goes; look at her eyes, and it comes back.")
    for (i, live) in [true, false].enumerated() {
      let thing = CGRect(x: 40 + CGFloat(i) * 480, y: 70, width: 60, height: 60), lightAt = CGPoint(x: thing.maxX + 8, y: thing.midY)
      ctx.setStrokeColor(RGB.white.cg(0.8)); ctx.setLineWidth(1.5); ctx.strokeEllipse(in: thing)
      ctx.setFillColor(RGB(hex: 0xFFF0D6).cg()); ctx.fillEllipse(in: CGRect(x: lightAt.x - 4, y: lightAt.y - 4, width: 8, height: 8))
      let sz = BubbleArt.size(words)
      let at = BubbleMath.origin(target: thing, light: lightAt, size: sz, bounds: CGRect(origin: .zero, size: size))
      BubbleArt.draw(in: ctx, words, intent: "show", in: CGRect(origin: at, size: sz), pixelScale: px, live: live, toward: lightAt)
      label(ctx, live ? "saying it: the rim is lit" : "said: the rim is quiet", at: CGPoint(x: thing.minX, y: 20))
    }
    if let image = ctx.makeImage() { save(image, "bubble-sentence-\(light ? "white" : "dark").png") }
  }
  let mine = Array(fireflySheet[before...])
  let cell = CGSize(width: 720, height: 230), gap: CGFloat = 12
  // All of them, one under another: dark, then white, for each row.
  do {
    let size = CGSize(width: cell.width + 2 * gap, height: gap + CGFloat(mine.count) * (cell.height + gap))
    let ctx = canvas(size)
    ctx.setFillColor(CGColor(gray: 0.5, alpha: 1))
    ctx.fill(CGRect(origin: .zero, size: size))
    for (i, image) in mine.enumerated() {
      ctx.draw(image, in: CGRect(x: gap, y: size.height - CGFloat(i + 1) * (cell.height + gap), width: cell.width, height: cell.height))
    }
    save(ctx.makeImage()!, "bubble-sheet.png")
  }
  // The first row, dark and white, at twice the size: for looking closely at the glass and the words.
  do {
    let size = CGSize(width: cell.width * 2, height: cell.height * 4)
    let ctx = canvas(size)
    ctx.interpolationQuality = .none
    for (i, image) in mine.prefix(2).enumerated() {
      ctx.draw(image, in: CGRect(x: 0, y: size.height - CGFloat(i + 1) * cell.height * 2, width: size.width, height: cell.height * 2))
    }
    save(ctx.makeImage()!, "bubble-zoom.png")
  }
}

// The newer firefly behaviours on one sheet of their own (two across).
do {
  let cell = CGSize(width: 720, height: 230), gap: CGFloat = 12, cols = 2, rows = (fireflySheet.count + cols - 1) / cols
  let size = CGSize(width: CGFloat(cols) * cell.width + CGFloat(cols + 1) * gap, height: gap + CGFloat(rows) * (cell.height + gap))
  let ctx = canvas(size)
  ctx.setFillColor(CGColor(gray: 0.5, alpha: 1))
  ctx.fill(CGRect(origin: .zero, size: size))
  for (i, image) in fireflySheet.enumerated() {
    ctx.draw(image, in: CGRect(x: gap + CGFloat(i % cols) * (cell.width + gap), y: size.height - CGFloat(i / cols + 1) * (cell.height + gap), width: cell.width, height: cell.height))
  }
  save(ctx.makeImage()!, "firefly-sheet.png")
}

// The other way ("reach"): the pearl goes to a ringed target the way the app sends it (Pointer.swift: its
// eyes first, a crouch, a hop in an arc, a landing with a squash and a wobble, the finger reaching
// out, a tap), on a dark window and on a white page. Each picture is three moments of it.
/// The pearl `at` seconds after it was asked to go from the island to `button`, stepped the way
/// Pointer.swift steps it. `tap`: seconds after the ask that the tap starts (nil: none).
func pointing(at: Double, from: CGPoint, button: CGRect, bounds: CGRect, diameter: CGFloat, skin: String, tap: Double? = nil) -> (PearlArt, CGPoint) {
  let p = PearlArt()
  p.diameter = diameter
  p.skin = skin
  p.out = true
  p.working = true
  let start = 10.0, dest = PearlMath.stand(beside: button, diameter: diameter, in: bounds)
  let hop = PearlMath.Hop(from: from, to: dest, at: start, radius: diameter / 2)
  var now = start - 0.5, crouched = false, leapt = false, landed: Double?, reached = false, tapped = false
  var position = from
  while now <= start + at {
    if now >= start {
      p.target = PearlMath.gaze(from: position, to: PearlMath.touch(button.insetBy(dx: 2, dy: 2), from: position))
      if landed == nil {
        if !crouched, hop.crouching(at: now) { crouched = true; p.crouch() }
        if !leapt, now >= hop.leaves { leapt = true; p.kick(-3.2) }
        position = hop.position(at: now)
        p.sway = hop.tilt(at: now)
        if hop.done(at: now) { landed = now; p.sway = 0; p.land() }
      } else if let l = landed {
        p.aimGoal = PearlMath.aim(from: position, at: button)
        if !reached, now - l >= 0.12 { reached = true; p.kick(-1.4) }
        if reached { p.pointGoal = 1 }
        if let tap, !tapped, now >= start + tap { tapped = true; p.pulse(now: now) }
      }
    }
    p.step(now: now, dt: 1.0 / 120)
    now += 1.0 / 120
  }
  return (p, position)
}

for light in [false, true] {
  let size = CGSize(width: 720, height: 230), bounds = CGRect(origin: .zero, size: size)
  let button = CGRect(x: 96, y: 62, width: 84, height: 28), island = CGPoint(x: 40, y: 190)
  let d = CompanionMath.diameter("medium")
  let lands = PearlMath.Hop(from: island, to: PearlMath.stand(beside: button, diameter: d, in: bounds), at: 0, radius: d / 2).lands
  let tapAt = lands + 0.7
  let moments: [(String, Double, Double?)] = [
    ("eyes first", 0.12, nil), ("the crouch", 0.235, nil), ("mid-hop", lands - 0.2, nil),
    ("landing: squash", lands + 0.02, nil), ("the wobble", lands + 0.1, nil), ("reaching", lands + 0.5, nil),
    ("tap: drawn back", tapAt + 0.085, tapAt), ("tap: the push", tapAt + 0.16, tapAt), ("pleased", tapAt + 0.6, tapAt)]
  for row in 0..<3 {
    let ctx = canvas(size)
    desktop(ctx, size, light: light)
    for col in 0..<3 {
      let m = moments[row * 3 + col], dx = CGFloat(col) * 240
      ctx.saveGState()
      ctx.clip(to: CGRect(x: dx, y: 0, width: 240, height: size.height))
      ctx.translateBy(x: dx, y: 0)
      // The island's corner, where it leaves from.
      ctx.addPath(CGPath(roundedRect: CGRect(x: 17, y: 167, width: 150, height: 46), cornerWidth: 22, cornerHeight: 22, transform: nil))
      ctx.setFillColor(MarkArt.glass.cg(0.9))
      ctx.fillPath()
      target(ctx, button, light: light, pressed: m.0 == "tap: the push")
      let (p, at) = pointing(at: m.1, from: island, button: button, bounds: bounds, diameter: d, skin: "glass", tap: m.2)
      if m.0 == "pleased" { p.done(now: 10 + m.1 - 0.25); for i in 0..<30 { p.step(now: 10 + m.1 - 0.25 + Double(i) / 120, dt: 1.0 / 120) } }
      p.draw(in: ctx, at: at, now: 10 + m.1, pixelScale: px)
      label(ctx, m.0, at: CGPoint(x: 120, y: 12), color: light ? MarkArt.grey : MarkArt.dim, size: 11)
      ctx.restoreGState()
    }
    let image = ctx.makeImage()!
    save(image, "pointing-\(light ? "white" : "dark")-\(row + 1).png")
    sheet.append(("pointing", image))
  }
}

// Reaching, close up: each look and each size, beside the same target, on dark and on white.
for light in [false, true] {
  let size = CGSize(width: 720, height: 230), bounds = CGRect(origin: .zero, size: size)
  let ctx = canvas(size)
  desktop(ctx, size, light: light)
  for (i, (skin, sizeName)) in [("glass", "medium"), ("moon", "medium"), ("moon", "large"), ("glass", "small"), ("glass", "large")].enumerated() {
    let button = CGRect(x: 24 + CGFloat(i) * 140, y: 70, width: 64, height: 28), d = CompanionMath.diameter(sizeName)
    target(ctx, button, light: light)
    let (p, at) = pointing(at: 1.6, from: CGPoint(x: button.midX, y: 200), button: button, bounds: bounds, diameter: d, skin: skin)
    p.draw(in: ctx, at: at, now: 11.6, pixelScale: px)
    label(ctx, "\(skin) · \(Int(d)) pt", at: CGPoint(x: button.midX + 20, y: 30), color: light ? MarkArt.grey : MarkArt.dim, size: 11)
  }
  // The edge line (EdgeGlow): white, on a thin dark one, with a soft dark edge.
  let screen = CGRect(origin: .zero, size: size)
  ctx.addPath(EdgeMath.path(screen, corner: 11))
  ctx.setStrokeColor(CGColor(gray: 0, alpha: 0.4))
  ctx.setLineWidth(EdgeMath.line + 2)
  ctx.strokePath()
  ctx.saveGState()
  ctx.setShadow(offset: .zero, blur: CGFloat(EdgeMath.glowRadius.high) * px, color: CGColor(gray: 0, alpha: CGFloat(EdgeMath.glowOpacity.high)))
  ctx.addPath(EdgeMath.path(screen, corner: 11))
  ctx.setStrokeColor(MarkArt.ink.cg(0.9))
  ctx.setLineWidth(EdgeMath.line)
  ctx.strokePath()
  ctx.restoreGState()
  // The status chip (StatusChip): the island's glass, a white dot, one word.
  let font = PillArt.font(11.5, .medium)
  let word = NSAttributedString(string: "Looking", attributes: [.font: font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): MarkArt.ink.cg()])
  let line = CTLineCreateWithAttributedString(word)
  let w = ChipMath.width(textWidth: CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)))
  let panel = ChipMath.frame(visible: CGRect(x: 0, y: 0, width: size.width, height: size.height - 24))
  let chip = CGRect(x: panel.maxX - ChipMath.margin - w, y: panel.minY + ChipMath.margin, width: w, height: ChipMath.height)
  ctx.addPath(CGPath(roundedRect: chip, cornerWidth: chip.height / 2, cornerHeight: chip.height / 2, transform: nil))
  ctx.setFillColor(MarkArt.glass.cg(0.86))
  ctx.fillPath()
  ctx.addPath(CGPath(roundedRect: chip.insetBy(dx: 0.5, dy: 0.5), cornerWidth: chip.height / 2, cornerHeight: chip.height / 2, transform: nil))
  ctx.setStrokeColor(RGB.white.cg(MarkArt.hairline))
  ctx.setLineWidth(1)
  ctx.strokePath()
  ctx.setFillColor(MarkArt.ink.cg())
  ctx.fillEllipse(in: CGRect(x: chip.minX + ChipMath.dotInset, y: chip.midY - ChipMath.dot / 2, width: ChipMath.dot, height: ChipMath.dot))
  ctx.textMatrix = .identity
  ctx.textPosition = CGPoint(x: chip.minX + ChipMath.textX, y: chip.midY - 4)
  CTLineDraw(line, ctx)
  let image = ctx.makeImage()!
  save(image, "pointing-looks-\(light ? "white" : "dark").png")
  sheet.append(("pointing-looks", image))
}

// All of them on one sheet: the mood rows one under another, then the scenes two across.
do {
  let cell = CGSize(width: 720, height: 230), gap: CGFloat = 12, cols = 2
  let rows = sheet.filter { $0.0.hasPrefix("moods-") }, cells = sheet.filter { !$0.0.hasPrefix("moods-") }
  func pt(_ i: CGImage) -> CGSize { CGSize(width: CGFloat(i.width) / px, height: CGFloat(i.height) / px) }
  let width = max(CGFloat(cols) * cell.width + CGFloat(cols + 1) * gap, (rows.map { pt($0.1).width }.max() ?? 0) + 2 * gap)
  let headH = rows.reduce(CGFloat(0)) { $0 + pt($1.1).height + gap }
  let cellRows = (cells.count + cols - 1) / cols
  let size = CGSize(width: width, height: gap + headH + CGFloat(cellRows) * (cell.height + gap))
  let ctx = canvas(size)
  ctx.setFillColor(CGColor(gray: 0.5, alpha: 1))
  ctx.fill(CGRect(origin: .zero, size: size))
  var y = size.height - gap
  for (_, image) in rows {
    let s = pt(image)
    y -= s.height
    ctx.draw(image, in: CGRect(x: (width - s.width) / 2, y: y, width: s.width, height: s.height))
    y -= gap
  }
  for (i, item) in cells.enumerated() {
    let x = gap + CGFloat(i % cols) * (cell.width + gap)
    ctx.draw(item.1, in: CGRect(x: x, y: y - CGFloat(i / cols + 1) * cell.height - CGFloat(i / cols) * gap, width: cell.width, height: cell.height))
  }
  save(ctx.makeImage()!, "sheet.png")
}

// The permissions checklist (Permissions.swift): the window's own view, drawn off screen with
// made-up states, in the dark and the light appearance: the first run (nothing answered), one
// refused and one already asked for, ready (only recommended ones missing) and all set.
func permissions(_ name: String, _ states: [String: PermMath.State], asked: Set<String> = [], light: Bool, speech: Bool = true) {
  let model = PermMath.Model(rows: PermMath.rows(screen: true, speech: speech), states: states, asked: asked)
  let view = PermissionsView(model: model)
  view.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
  let size = view.frame.size
  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * px), pixelsHigh: Int(size.height * px), bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
  rep.size = size
  view.cacheDisplay(in: view.bounds, to: rep)
  if let image = rep.cgImage { save(image, "permissions-\(name)-\(light ? "light" : "dark").png") }
}
let everyPermission: [String: PermMath.State] = ["microphone": .allowed, "accessibility": .allowed, "screen": .allowed, "input": .allowed, "speech": .allowed]
for light in [false, true] {
  permissions("first", [:], light: light)
  permissions("refused", ["microphone": .denied, "accessibility": .notYet, "screen": .allowed, "input": .denied], asked: ["accessibility"], light: light)
  permissions("ready", ["microphone": .allowed, "accessibility": .allowed, "screen": .notYet, "input": .allowed, "speech": .denied], asked: ["screen"], light: light)
  permissions("allset", everyPermission, light: light)
}
permissions("allset-older-mac", everyPermission, light: false, speech: false)
