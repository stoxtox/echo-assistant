// Renders Echo's app icon, "Fade": three round-ended bars from a shared left edge on a near-black
// macOS-style rounded square. They read as an E and as an echo: what you said (white), it fading
// (grey), and the answer coming back (a bar of colour, glowing).
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
// in the margin. Sizes of 32px and below are drawn from a bolder variant: thicker bars and a
// stronger glow, so it still reads in the menu bar and Finder lists.

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

/// A steady random number for a point (the dither in cgImage).
func hash(_ p0: V2) -> Double {
  var p = V2(fract(p0.x * 123.34), fract(p0.y * 456.21))
  let d = p.x * (p.x + 45.32) + p.y * (p.y + 45.32)
  p += V2(d, d)
  return fract(p.x * p.y)
}

// MARK: - The mark: Fade

/// The answer's colours, left to right: blue, violet, pink, amber.
let GRADIENT: [V3] = [V3(0.28, 0.5, 1), V3(0.66, 0.4, 1), V3(1, 0.4, 0.62), V3(1, 0.72, 0.4)]
func gradient(_ t0: Double) -> V3 {
  let u = clamp(t0, 0, 0.9999) * Double(GRADIENT.count - 1)
  let n = Int(u)
  return mix(GRADIENT[n], GRADIENT[n + 1], u - Double(n))
}

/// Three bars from a shared left edge (1024 grid, y down): where each ends, its height, and how
/// white it is (1: what you said; 0.42: it fading; 0: the answer, in colour).
struct Scene {
  var radius: Double, gap: Double, glow: Double
  static let full = Scene(radius: 52, gap: 159, glow: 1)
  /// 16 and 32 px: thicker bars, closer together, a stronger glow.
  static let small = Scene(radius: 66, gap: 168, glow: 1.3)
  static let left = 317.0
  var bars: [(end: Double, y: Double, white: Double)] {
    [(707, 512 - gap, 1), (574, 512, 0.42), (450, 512 + gap, 0)]
  }
}

/// Distance to a bar with round ends (from x0 to x1 at height cy, r thick); < 0 inside.
@inline(__always) func barDistance(_ p: V2, _ x0: Double, _ x1: Double, _ cy: Double, _ r: Double) -> Double {
  length(V2(p.x - clamp(p.x, x0, x1), p.y - cy)) - r
}

/// The whole scene: a near-black body, the white bar, the grey bar, and the bar of colour, glowing.
func scene(_ p: V2, _ s: Scene, _ px: Double) -> V3 {
  let base = mix(0.065, 0.01, clamp((p.y - 100) / 824, 0, 1))
  var col = V3(base, base, base)
  for bar in s.bars {
    let d = barDistance(p, Scene.left, bar.end, bar.y, s.radius)
    let v = (p.y - bar.y) / s.radius
    let g = gradient((p.x - Scene.left) / 177 * 0.9 + 0.05)
    let out = max(d, 0)
    let fill: V3
    if bar.white > 0 {
      col += white * (0.06 * bar.white * exp(-out / 44))
      fill = white * (bar.white * (0.96 - 0.07 * v))
    } else {
      // The answer is alive: its colour spills into the dark around it.
      col += g * (0.42 * s.glow * exp(-out / 68))
      fill = mix(g, white, 0.16 * smoothstep(0.3, -0.9, v))
    }
    col = mix(col, fill, smoothstep(px * 0.5, -px * 0.5, d))
  }
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
      col += white * exp(-inset / rimW) * 0.3 * topness
      col += white * exp(-inset / 10) * 0.04 * topness
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
let smallMaster = render(size: 1024, .small)      // thicker bars, for 16 and 32 px
/// The icon at n px: the full render down to 64 px, the bolder one (sharpened) below that.
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
