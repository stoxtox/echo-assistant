// Renders Echo's app icon: the sunset drop from public/voiceviz.js (a glass drop holding a sunset
// over water, glowing) floating above dusk water that reflects it, on a macOS-style rounded square.
// Pure CoreGraphics/ImageIO, so it runs on any Mac with Apple's Command Line Tools; no Homebrew.
//
//   xcrun swiftc -O scripts/render-icon.swift -o /tmp/render-icon
//   /tmp/render-icon --iconset DIR [--web DIR] [--preview FILE]
//
//   --iconset DIR   the 10 PNGs iconutil wants (icon_16x16.png ... icon_512x512@2x.png)
//   --web DIR       echo-512.png, echo-192.png (macOS grid, transparent margin) and
//                   apple-touch-icon.png (180px, full bleed: iOS rounds it itself)
//   --preview FILE  a contact sheet of every size on light and dark, for eyeballing
//
// Layout follows Apple's macOS icon grid: a 1024 canvas, an 824x824 body centred, with continuous
// ("squircle") corners (a superellipse, n = 5, matches the ~185px corner radius) and a drop shadow
// in the margin. Sizes of 32px and below are drawn from a simpler variant: a bigger drop, no fine
// liquid detail, stronger glow and contrast, so it still reads in the menu bar and Finder lists.
// The drop's shading is a CPU port of voiceviz.js's fragment shader, frozen at one pleasing frame.

import CoreGraphics
import Dispatch
import Foundation
import ImageIO
import UniformTypeIdentifiers

typealias V2 = SIMD2<Double>
typealias V3 = SIMD3<Double>

// MARK: - GLSL-style helpers

@inline(__always) func fract(_ x: Double) -> Double { x - x.rounded(.down) }
@inline(__always) func clamp(_ x: Double, _ a: Double, _ b: Double) -> Double { min(max(x, a), b) }
@inline(__always) func mix(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
@inline(__always) func mix(_ a: V3, _ b: V3, _ t: Double) -> V3 { a + (b - a) * t }
@inline(__always) func mix(_ a: V2, _ b: V2, _ t: Double) -> V2 { a + (b - a) * t }
@inline(__always) func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
  let t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}
@inline(__always) func length(_ v: V2) -> Double { (v.x * v.x + v.y * v.y).squareRoot() }
let white = V3(1, 1, 1)

func hash(_ p0: V2) -> Double {
  var p = V2(fract(p0.x * 123.34), fract(p0.y * 456.21))
  let d = p.x * (p.x + 45.32) + p.y * (p.y + 45.32)
  p += V2(d, d)
  return fract(p.x * p.y)
}
func noise(_ p: V2) -> Double {
  let i = V2(p.x.rounded(.down), p.y.rounded(.down)), f = p - i
  let u = f * f * (V2(3, 3) - 2 * f)
  return mix(mix(hash(i), hash(i + V2(1, 0)), u.x), mix(hash(i + V2(0, 1)), hash(i + V2(1, 1)), u.x), u.y)
}
func fbm(_ p0: V2) -> Double {
  var v = 0.0, a = 0.5, p = p0
  for _ in 0..<3 {
    v += a * noise(p)
    p = V2(1.6 * p.x - 1.2 * p.y, 1.2 * p.x + 1.6 * p.y)
    a *= 0.5
  }
  return v / 0.875
}

// The voice's warm palette (voiceviz.js WARM): deep rose, coral #FF6A5B, tangerine #FF9F43, gold #FFD166.
let WARM: [V3] = [V3(0.69, 0.19, 0.36), V3(1, 0.416, 0.357), V3(1, 0.624, 0.263), V3(1, 0.82, 0.4)]
func ramp(_ s: [V3], _ t0: Double) -> V3 {
  let x = clamp(t0, 0, 1) * Double(s.count - 1)
  let i = min(s.count - 2, Int(x))
  return mix(s[i], s[i + 1], smoothstep(0, 1, x - Double(i)))
}
@inline(__always) func palette(_ t: Double) -> V3 { ramp(WARM, t) }

func caustic(_ p: V2, _ t: Double) -> Double {
  var i = p, c = 1.0
  for n in 0..<3 {
    let tt = t * (1 - 3.5 / Double(n + 1))
    i = p + V2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x))
    c += 1 / length(V2(p.x / (sin(i.x + tt) / 0.006), p.y / (cos(i.y + tt) / 0.006)))
  }
  c /= 3
  c = 1.17 - pow(c, 1.4)
  return clamp(pow(abs(c), 8), 0, 1)
}

/// Brightness-only tone map, as in the shader: colours stay saturated instead of washing out.
func toneMap(_ c: V3) -> V3 {
  let m = max(c.x, c.y, c.z)
  return m > 1e-4 ? c * ((1 - exp(-m * 1.5)) / m) : c
}
/// A soft shoulder for the background: leaves most values alone, rolls highlights off below 1.
func shoulder(_ c: V3) -> V3 {
  let m = max(c.x, c.y, c.z), k = 0.72
  guard m > k else { return c }
  return c * ((k + (1 - k) * (1 - exp(-(m - k) / (1 - k)))) / m)
}

// MARK: - The drop (port of voiceviz.js FRAG, one frozen frame)

struct Look {
  var simple: Bool
  var flow = 2.6, time = 7.3, level = 0.14
  var bands = V3(0.22, 0.16, 0.08)
  var warp = 0.8, ripple = 0.12, bright = 0.9, caustic = 0.55
}

/// Colour inside the drop. q: position / radius, y up. px: one output pixel in q units.
func drop(_ q: V2, _ px: Double, _ L: Look) -> V3 {
  let f = L.flow, T = L.time
  let qr = min(length(q), 1)
  let z = max(0, 1 - qr * qr).squareRoot()
  let lq = q / (0.55 + 0.45 * z)
  let hz = -0.2 + 0.025 * sin(q.x * 2.3 + f * 0.8) + L.level * 0.035 * sin(q.x * 9 - T * 4)
  let below = smoothstep(hz + px * 2, hz - px * 2, q.y)
  let depth = max(hz - q.y, 0)
  let ringW = sin(depth * 38 / (0.25 + depth) - T * 4 - q.x * 2) * (L.ripple * 0.6 + 0.08)
  let wob = L.simple ? 0 : (noise(V2(q.x * 3 + f * 0.4, depth * 26 - T * 1.2)) - 0.5) * (0.05 + 0.12 * depth + L.ripple * 0.1)
  let sp = mix(q, V2(q.x + wob, 2 * hz - q.y + ringW * 0.03), below)
  let slq = sp / (0.55 + 0.45 * z)

  let w1 = L.simple ? V2(0.5, 0.5) : V2(fbm(slq * 1.1 + V2(0, f * 0.22)), fbm(slq * 1.1 + V2(5.2, -f * 0.18)))
  let wq = slq + (w1 - V2(0.5, 0.5)) * L.warp * 1.3
  let liquid = L.simple ? 0.55 : fbm(wq * 1.3 + V2(f * 0.12, f * 0.07))
  let ring = sin(qr * 13 - T * 5 - liquid * 3) * exp(-qr * 1.3) * L.ripple

  // Sky: gold at the horizon deepening to rose, then night-plum at the top.
  let hgt = clamp((sp.y - hz) / (1.1 - hz), 0, 1)
  // (Capped short of pure gold: shaded gold reads khaki on an icon; the sun keeps the gold.)
  let t = min(0.98 - hgt * 1.05 + (liquid - 0.5) * 0.7, 0.72)
  let night = V3(0.13, 0.035, 0.09)
  var col = mix(night, palette(t), clamp(0.28 + 0.72 * (1 - hgt) * (0.55 + 0.6 * liquid), 0, 1) * (0.6 + 0.4 * L.bright))

  // The sun on the waterline.
  let sun = V2(L.simple ? 0 : 0.12 * sin(f * 0.23), hz + 0.2 + 0.04 * sin(f * 0.4))
  let sd = length((sp - sun) * V2(1, 1.08))
  let sr = (L.simple ? 0.24 : 0.17) + L.level * 0.06 + L.bands.x * 0.03
  let disc = smoothstep(sr, sr - max(0.025, px * 1.5), sd) * smoothstep(hz - 0.01, hz + 0.02, sp.y)
  let sunCol = mix(palette(1), V3(1, 0.96, 0.86), 0.35)
  col = mix(col, sunCol, disc * 0.9)
  col += palette(0.9) * exp(-sd * 4) * (0.35 + 0.5 * L.bright)

  // Waves of light across the sky (too fine for the small variant).
  if !L.simple {
    for i in 0..<3 {
      let fi = Double(i)
      let b = i == 0 ? L.bands.x : i == 1 ? L.bands.y : L.bands.z
      let amp = 0.06 + 0.04 * fi + L.level * 0.12 + b * 0.16
      let y = hz + 0.3 + fi * 0.22 + amp * sin(wq.x * (1.7 + fi * 0.6) + f * (0.9 + fi * 0.35) + fi * 2.1) + (liquid - 0.5) * 0.3 + ring * 0.05
      let d = sp.y - y
      let wdt = 0.045 + 0.05 * L.level + 0.03 * b
      let g = exp(-d * d / (wdt * wdt)) * 0.75 + exp(-abs(d) * 7) * 0.25
      col += palette(0.35 + fi * 0.28) * g * (0.3 + 0.55 * L.bright) * (0.55 + 0.45 * z)
    }
  }

  // The water: darker, streaked, a path of sunlight and a bright waterline.
  let streak = L.simple ? 0.6 : noise(V2(q.x * 5 + f * 0.3, depth * 60 - T * 2))
  let sunPath = palette(0.95) * pow(streak, 3) * exp(-abs(q.x - sun.x) * 5) * 0.45 * (0.5 + L.bright)
  // (Tinted towards rose: darkened gold alone turns olive on an icon's small, bright canvas.)
  let waterCol = col * (0.3 + 0.45 * streak) * V3(1, 0.72, 0.86)
  col = mix(col, waterCol + sunPath, below)
  let lineK: Double = exp(-abs(q.y - hz) / (px * 3 + 0.006)) * (0.25 + 0.5 * L.bright) * smoothstep(0.95, 0.4, qr)
  col += palette(1) * lineK

  if !L.simple {
    let c = caustic(lq * 2.6 + w1 * 1.2, f * 0.9 + 23)
    col += mix(palette(0.95), white, 0.5) * c * L.caustic * z * 0.3 * below
  }

  // Depth: shade low in the dome, and a darker band just inside the rim.
  col *= mix(0.6, 1, smoothstep(-1, 0.5, q.y * 0.5 + z * 0.8))
  col *= 1 - 0.35 * smoothstep(0.72, 0.93, qr) * (1 - smoothstep(0.93, 1, qr))

  // Glass: fresnel rim, a soft window highlight top-left, a thin reflection bottom-right.
  let fres = pow(1 - z, 3)
  let fresK: Double = fres * (0.45 + 0.35 * L.bright) * (0.45 + 0.55 * smoothstep(-0.8, 0.8, q.y)) * (L.simple ? 1.3 : 1)
  col += mix(palette(0.8), white, 0.35) * fresK
  var hq = q - V2(-0.3, 0.46)
  hq = V2(0.87 * hq.x + 0.5 * hq.y, -0.5 * hq.x + 0.87 * hq.y)
  col += exp(-(hq.x * hq.x * 10 + hq.y * hq.y * 40)) * (L.simple ? 0.45 : 0.6) * V3(1, 0.96, 0.92)
  let cres = smoothstep(0.84, 0.97, qr) * smoothstep(0.2, 0.9, (q.x * 0.6 - q.y * 0.8) / max(qr, 1e-3))
  col += cres * 0.18 * mix(palette(0.9), white, 0.5)

  return toneMap(col)
}

// MARK: - The scene on the icon's body (1024 grid, y down)

struct Scene {
  var look: Look
  var orbC: V2, orbR: Double, horizon: Double
  var glow: Double
  static let full = Scene(look: Look(simple: false), orbC: V2(512, 468), orbR: 246, horizon: 738, glow: 1)
  static let small = Scene(look: Look(simple: true, bright: 1.05), orbC: V2(512, 478), orbR: 296, horizon: 800, glow: 1.35)
}

/// Sky, glow and drop at a point above the water. px: one output pixel in grid units.
func above(_ p: V2, _ s: Scene, _ px: Double, orb: Double = 1) -> V3 {
  // Dusk sky: night plum at the top warming to rose and a coral-gold haze at the horizon.
  let t = clamp((p.y - 100) / (s.horizon - 100), 0, 1)
  let stops: [V3] = [V3(0.05, 0.022, 0.06), V3(0.13, 0.04, 0.115), V3(0.34, 0.085, 0.18), V3(0.78, 0.3, 0.26)]
  var col = ramp(stops, pow(t, 1.25))
  let dx = (p.x - s.orbC.x) / 330
  col += palette(0.55) * exp(-dx * dx) * pow(t, 4) * 0.35
  if !s.look.simple {
    // Faint drifting cloud wisps catching the light.
    let w = fbm(V2(p.x / 230 + 3.1, p.y / 46 + 0.7))
    col += palette(0.25 + t * 0.6) * smoothstep(0.58, 0.9, w) * 0.16 * smoothstep(0.15, 0.7, t)
  }
  // The drop's glow (the shader's exp falloff, in drop radii).
  let rel = (p - s.orbC) / s.orbR
  let r = length(rel)
  let e = max(r - 1, 0)
  let haloK: Double = exp(-e * 3.2) * 0.5 * s.glow, coreK: Double = exp(-e * 10) * 0.35 * s.glow
  col += palette(0.55) * haloK
  col += palette(0.82) * coreK
  col = shoulder(col)
  // The drop itself, antialiased at its edge.
  let aa = px / s.orbR
  let inside = smoothstep(1 + aa * 0.5, 1 - aa * 0.5, r) * orb
  if inside > 0 {
    col = mix(col, drop(V2(rel.x, -rel.y), aa, s.look), inside)
  }
  return col
}

/// The whole scene: sky and drop above the horizon, their reflection in dark water below it.
func scene(_ p: V2, _ s: Scene, _ px: Double) -> V3 {
  var col: V3
  if p.y < s.horizon {
    col = above(p, s, px)
  } else {
    let dy = p.y - s.horizon, d = clamp(dy / (924 - s.horizon), 0, 1)
    let wob = s.look.simple ? 0 : (noise(V2(p.x / 38, dy / (3 + 10 * d))) - 0.5) * (4 + 34 * d)
    // The drop's reflection, half-transparent so its dark water doesn't sit there like a hill.
    let refl = above(V2(p.x + wob, s.horizon - dy * 1.15 - 2), s, px, orb: 0.55)
    let streak = s.look.simple ? 0.55 : noise(V2(p.x / 60, dy / (2.2 + 7 * d)))
    let reflK: Double = (0.4 + 0.32 * streak) * (1 - 0.5 * d)
    col = refl * V3(1, 0.74, 0.88) * reflK + V3(0.03, 0.012, 0.03)
    col += palette(0.95) * pow(streak, 3) * exp(-abs(p.x - s.orbC.x) / 120) * 0.45 * (1 - d)
  }
  // The bright waterline, strongest under the drop.
  let lineW = max(1.6, px * 0.9)
  let lineK: Double = exp(-abs(p.y - s.horizon) / lineW) * (0.25 + 0.75 * exp(-abs(p.x - s.orbC.x) / 240)) * 0.85
  col += palette(1) * lineK
  return col
}

// MARK: - The icon body: squircle, shadow, glass rim

/// Signed distance-ish to the macOS body (superellipse, n = 5, 824 wide), in grid px; < 0 inside.
@inline(__always) func bodyDistance(_ p: V2) -> Double {
  let v = (p - V2(512, 512)) / 412
  let se = pow(pow(abs(v.x), 5) + pow(abs(v.y), 5), 0.2)
  return (se - 1) * 412
}

/// One premultiplied RGBA sample of the icon. bleed: the body fills the square, no mask or shadow.
func iconSample(_ p0: V2, _ s: Scene, _ px: Double, bleed: Bool) -> SIMD4<Double> {
  let p = bleed ? V2(100, 100) + p0 * (824.0 / 1024.0) : p0
  let ppx = bleed ? px * 824.0 / 1024.0 : px
  let d = bleed ? -60 : bodyDistance(p)
  let cov = bleed ? 1 : smoothstep(ppx * 0.5, -ppx * 0.5, d)
  // Apple-style drop shadow in the margin: soft, offset down.
  var shadowA = 0.0
  if !bleed && cov < 1 {
    let ds = bodyDistance(p - V2(0, 12))
    let k = clamp(1 - (ds + 4) / 34, 0, 1)
    shadowA = 0.5 * k * k
  }
  var col = V3(0, 0, 0)
  if cov > 0 {
    col = scene(p, s, ppx)
    let v = (p - V2(512, 512)) / 412
    let inset = max(-d, 0)
    // Depth: a soft vignette and a darker bottom edge; a glassy sheen at the top.
    let se = length(v)
    col *= 1 - 0.28 * smoothstep(0.7, 1.35, se)
    col *= 1 - exp(-inset / 14) * 0.3 * smoothstep(-0.2, 1, v.y)
    col += white * 0.045 * smoothstep(-0.1, -1, v.y)
    if !bleed {
      // The thin glass rim: bright along the top, fading down the sides.
      let rimW = max(1.4, ppx * 0.8)
      let topness = 0.25 + 0.75 * smoothstep(0.4, -1, v.y)
      col += V3(1, 0.9, 0.84) * exp(-inset / rimW) * 0.42 * topness
      col += V3(1, 0.85, 0.75) * exp(-inset / 10) * 0.06 * topness
    }
  }
  let a = cov + shadowA * (1 - cov)
  return SIMD4(col.x * cov, col.y * cov, col.z * cov, a)
}

// MARK: - Rasterising and resampling

struct Image {
  var w: Int, h: Int
  var px: [SIMD4<Double>]  // premultiplied, 0..1
}

func render(size: Int, _ s: Scene, bleed: Bool = false) -> Image {
  var out = [SIMD4<Double>](repeating: .zero, count: size * size)
  let step = 1024.0 / Double(size)
  out.withUnsafeMutableBufferPointer { buf in
    let base = buf.baseAddress!
    DispatchQueue.concurrentPerform(iterations: size) { y in
      for x in 0..<size {
        let p = V2((Double(x) + 0.5) * step, (Double(y) + 0.5) * step)
        base[y * size + x] = iconSample(p, s, step, bleed: bleed)
      }
    }
  }
  return Image(w: size, h: size, px: out)
}

/// Area-average downsample (exact box coverage, works for any ratio).
func downsample(_ src: Image, to n: Int) -> Image {
  func axis(_ from: Int, _ to: Int) -> [[(Int, Double)]] {
    let r = Double(from) / Double(to)
    return (0..<to).map { i in
      let a = Double(i) * r, b = Double(i + 1) * r
      var w: [(Int, Double)] = []
      var j = Int(a)
      while Double(j) < b && j < from {
        let lo = max(a, Double(j)), hi = min(b, Double(j + 1))
        if hi > lo { w.append((j, (hi - lo) / r)) }
        j += 1
      }
      return w
    }
  }
  let wx = axis(src.w, n), wy = axis(src.h, n)
  var tmp = [SIMD4<Double>](repeating: .zero, count: n * src.h)
  for y in 0..<src.h {
    for x in 0..<n {
      var acc = SIMD4<Double>.zero
      for (j, w) in wx[x] { acc += src.px[y * src.w + j] * w }
      tmp[y * n + x] = acc
    }
  }
  var out = [SIMD4<Double>](repeating: .zero, count: n * n)
  for y in 0..<n {
    for x in 0..<n {
      var acc = SIMD4<Double>.zero
      for (j, w) in wy[y] { acc += tmp[j * n + x] * w }
      out[y * n + x] = acc
    }
  }
  return Image(w: n, h: n, px: out)
}

/// A light unsharp mask on colour, for the tiny sizes (area averaging softens them).
func sharpen(_ img: Image, _ amount: Double) -> Image {
  var out = img.px
  let w = img.w, h = img.h
  for y in 0..<h {
    for x in 0..<w {
      var blur = SIMD4<Double>.zero, n = 0.0, opaque = true
      for dy in -1...1 { for dx in -1...1 {
        let xx = min(max(x + dx, 0), w - 1), yy = min(max(y + dy, 0), h - 1)
        blur += img.px[yy * w + xx]; n += 1
        opaque = opaque && img.px[yy * w + xx].w > 0.98
      } }
      guard opaque else { continue }  // leave the silhouette's edge and shadow alone: no halo
      blur /= n
      let c = img.px[y * w + x]
      var s = c + (c - blur) * amount
      s.w = c.w  // keep the silhouette's alpha as rendered
      s = SIMD4(min(max(s.x, 0), s.w), min(max(s.y, 0), s.w), min(max(s.z, 0), s.w), s.w)
      out[y * w + x] = s
    }
  }
  return Image(w: w, h: h, px: out)
}

func cgImage(_ img: Image) -> CGImage {
  var bytes = [UInt8](repeating: 0, count: img.w * img.h * 4)
  for i in 0..<(img.w * img.h) {
    let c = img.px[i]
    // Ordered-ish dither so the long gradients don't band; it scales with alpha, so empty stays empty.
    let n = (hash(V2(Double(i % img.w) + 0.31, Double(i / img.w) + 0.77)) - 0.5) / 255 * c.w
    let a = clamp(c.w, 0, 1)
    bytes[i * 4 + 0] = UInt8(clamp((c.x + n) * 255, 0, a * 255).rounded())
    bytes[i * 4 + 1] = UInt8(clamp((c.y + n) * 255, 0, a * 255).rounded())
    bytes[i * 4 + 2] = UInt8(clamp((c.z + n) * 255, 0, a * 255).rounded())
    bytes[i * 4 + 3] = UInt8((a * 255).rounded())
  }
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let provider = CGDataProvider(data: Data(bytes) as CFData)!
  return CGImage(width: img.w, height: img.h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: img.w * 4, space: cs,
                 bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider,
                 decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
}

func writePNG(_ image: CGImage, _ path: String) {
  let url = URL(fileURLWithPath: path)
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("can't write \(path)")
  }
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { fatalError("can't write \(path)") }
}

// MARK: - Main

var iconset: String?, web: String?, preview: String?
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
  let a = args.removeFirst()
  guard let v = args.first else { fatalError("\(a) needs a value") }
  args.removeFirst()
  switch a {
  case "--iconset": iconset = v
  case "--web": web = v
  case "--preview": preview = v
  default: fatalError("unknown option \(a)")
  }
}
if iconset == nil && web == nil && preview == nil {
  FileHandle.standardError.write("usage: render-icon --iconset DIR [--web DIR] [--preview FILE]\n".data(using: .utf8)!)
  exit(2)
}

let master = render(size: 2048, .full)            // 2x supersampled 1024
let smallMaster = render(size: 1024, .small)      // the simplified drop, for 16 and 32 px
/// The icon at n px: the detailed render down to 64 px, the simple one (sharpened) below that.
func icon(_ n: Int) -> CGImage {
  if n <= 32 { return cgImage(sharpen(downsample(smallMaster, to: n), n <= 16 ? 0.45 : 0.3)) }
  return cgImage(downsample(master, to: n))
}
var sizes: [Int: CGImage] = [:]
func cached(_ n: Int) -> CGImage { if let i = sizes[n] { return i }; let i = icon(n); sizes[n] = i; return i }

if let dir = iconset {
  try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  for s in [16, 32, 128, 256, 512] {
    writePNG(cached(s), "\(dir)/icon_\(s)x\(s).png")
    writePNG(cached(s * 2), "\(dir)/icon_\(s)x\(s)@2x.png")
  }
}
if let dir = web {
  try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  writePNG(cached(512), "\(dir)/echo-512.png")
  writePNG(cached(192), "\(dir)/echo-192.png")
  writePNG(cgImage(downsample(render(size: 720, .full, bleed: true), to: 180)), "\(dir)/apple-touch-icon.png")
}
if let file = preview {
  // Every size at 1x on light and dark, then 16 and 32 blown up (nearest) to judge the pixels.
  let show = [512, 256, 128, 64, 32, 16]
  let W = 1500, H = 1180
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(CGColor(red: 0.93, green: 0.93, blue: 0.94, alpha: 1)); ctx.fill(CGRect(x: 0, y: H / 2, width: W, height: H / 2))
  ctx.setFillColor(CGColor(red: 0.12, green: 0.12, blue: 0.13, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H / 2))
  for (row, top) in [H - 20, H / 2 - 20].enumerated() {
    _ = row
    var x = 20
    for s in show {
      ctx.draw(cached(s), in: CGRect(x: x, y: top - s, width: s, height: s))
      x += s + 24
    }
    ctx.interpolationQuality = .none
    ctx.draw(cached(32), in: CGRect(x: x, y: top - 32 * 4 - 150, width: 128, height: 128))
    ctx.draw(cached(16), in: CGRect(x: x, y: top - 16 * 8 - 300, width: 128, height: 128))
    ctx.interpolationQuality = .default
  }
  writePNG(ctx.makeImage()!, file)
}
