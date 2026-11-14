// Looking at the screen, only when asked (lib/screen.js has the whole privacy story).
//
// One frame of the display you're working on (ScreenCaptureKit, Echo's own windows left out),
// read on this Mac with Apple's Vision text recognition. Secrets are blacked out in the picture
// and the text before it goes to Echo's server: password fields (found with the Accessibility
// API), and API keys, tokens, passwords and card numbers found in the text. Nothing is written to
// disk here; the picture only lives in memory until it's posted to Echo on this Mac.
import AppKit
import ScreenCaptureKit
import Vision

/// A line of text read off the screen, in the capture's pixels (top-left origin).
struct TextBox {
  let text: String
  let rect: CGRect
}

/// What a look saw, already redacted.
struct ScreenShot {
  let jpeg: Data
  let size: CGSize // of the JPEG
  let boxes: [TextBox] // in capture pixels
  let captureSize: CGSize
  let displayFrame: CGRect // the display, in AppKit screen coordinates
  let text: String
  let redactions: Int
  let app: String
  let window: String
}

enum LookError: Error {
  case permission
  case unsupported
  case slow
  case failed(String)

  var code: String {
    switch self {
    case .permission: return "permission"
    case .unsupported: return "unsupported"
    case .slow: return "slow"
    case .failed: return "failed"
    }
  }

  var message: String {
    switch self {
    case .permission:
      return "Echo needs the Screen Recording permission to look when you ask. Open System Settings, Privacy & Security, Screen Recording, and switch Echo on. Echo only looks when you ask."
    case .unsupported:
      return "Looking at the screen needs macOS 14 (Sonoma) or newer."
    case .slow:
      return "Reading the screen took too long (over \(Int(ScreenLook.deadline)) seconds), so nothing was read: no text and no picture. (The picture is never sent without its text, because the text is how keys and card numbers get blacked out.) Try once more; if it fails again, tell the user plainly that you couldn't see the screen, and don't guess what is on it."
    case .failed(let why):
      return "Couldn't capture the screen (\(why))."
    }
  }
}

enum ScreenLook {
  /// Where the last picture sent to Echo came from, so point_at can use x/y in it.
  static var last: (frame: CGRect, size: CGSize)?

  static var supported: Bool {
    if #available(macOS 14.0, *) { return true }
    return false
  }

  static var hasPermission: Bool { CGPreflightScreenCaptureAccess() }

  /// A look answers within this many seconds or fails as "slow" (Echo's server waits 6 s:
  /// lib/screen.js). On Oct 3 the first look after launch hung past the server's 20 s; the next
  /// six took about half a second each.
  static let deadline: TimeInterval = 4

  /// Wakes ScreenCaptureKit and Vision shortly after launch, so the first real look isn't the slow
  /// one: a 16 by 16 pixel capture that is thrown away, then text recognition on a blank image.
  /// Nothing is read, kept or sent. Skipped unless looking is switched on and already allowed
  /// (this never brings up the permission prompt).
  /// `capture` false wakes only the text reader: nothing of the screen is taken at all.
  static func warmUp(capture: Bool = true) {
    guard #available(macOS 14.0, *), Prefs.screenAware, hasPermission else { return }
    lastUse = Date()
    Task.detached(priority: .utility) {
      if capture, let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true), let display = content.displays.first {
        let config = SCStreamConfiguration()
        config.width = 16
        config.height = 16
        config.showsCursor = false
        _ = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []), configuration: config)
      }
      if let ctx = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        if let blank = ctx.makeImage() { _ = recognize(blank) }
      }
    }
  }

  /// When the screen reader was last used or woken, and the looks being read now (by LookMath.key).
  private static var lastUse = Date.distantPast
  private static var running: [String: (started: Date, waiting: [(Result<ScreenShot, LookError>) -> Void])] = [:]
  private static var warmTimer: Timer?
  /// How long the last look's two halves took (taking the picture, reading it), in milliseconds.
  static var lastTiming: (capture: Int, read: Int) = (0, 0)

  /// Keeps the first look from being the slow one, all day and not only after launch: a full
  /// warm-up once things settle and whenever the Mac wakes, and the text reader alone (no picture
  /// of the screen is taken for that) whenever it has sat unused for a few minutes.
  static func keepWarm() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { warmUp() }
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { warmUp() }
    }
    warmTimer?.invalidate()
    warmTimer = Timer.scheduledTimer(withTimeInterval: LookMath.warmEvery, repeats: true) { _ in
      if LookMath.cold(sinceUse: Date().timeIntervalSince(lastUse)) { warmUp(capture: false) }
    }
  }

  /// The screen you're working on: the one under the mouse.
  static func activeScreen() -> NSScreen {
    let p = NSEvent.mouseLocation
    return NSScreen.screens.first { NSMouseInRect(p, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
  }

  /// The screen showing most of `app`'s focused window (where its buttons are), else the active one.
  static func screen(for app: NSRunningApplication?) -> NSScreen {
    let screens = NSScreen.screens
    if let app, let w = AXFinder.focusedWindowFrame(of: app), let i = PointMath.screenIndex(for: w, in: screens.map(\.frame)) {
      return screens[i]
    }
    return activeScreen()
  }

  /// Captures, reads and redacts one frame of `screen` (the active one by default). Calls back on the main thread.
  /// marks: numbered badges on controls (Set-of-Marks, AppKit frames); grid: a numbered grid of
  /// this many columns, the fall-back when nothing has a name.
  /// crop: only this part of the screen (AppKit points), e.g. the window you're in (PointMath.windowArea):
  /// a smaller, sharper picture; marks, the grid and clicks by x/y follow it.
  static func capture(screen chosen: NSScreen? = nil, maxEdge: CGFloat = 1600, marks: [(label: String, frame: CGRect)] = [], grid: Int = 0,
                      crop: CGRect? = nil, _ answer: @escaping (Result<ScreenShot, LookError>) -> Void) {
    guard #available(macOS 14.0, *) else { return answer(.failure(.unsupported)) }
    guard hasPermission else { return answer(.failure(.permission)) }
    // One answer, on the main thread: the capture's, or "slow" at the deadline (whatever the
    // capture brings after that is dropped: nothing of it is kept or sent).
    var answered = false
    let done = { (r: Result<ScreenShot, LookError>) in
      guard !answered else { return }
      answered = true
      if case .success(let shot) = r { last = (shot.displayFrame, shot.size) }
      answer(r)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + deadline) { done(.failure(.slow)) }
    let screen = chosen ?? activeScreen()
    let frame = screen.frame
    let scale = screen.backingScaleFactor
    let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID ?? CGMainDisplayID()
    // The same look is still being read (the one before this gave up at its deadline and this is
    // the retry): wait for that one. Starting a second would only make both slower.
    let key = LookMath.key(display: displayID, crop: crop, marks: marks.map(\.label), grid: grid, maxEdge: maxEdge)
    if let now = running[key], LookMath.joins(startedAgo: Date().timeIntervalSince(now.started)) {
      running[key]?.waiting.append(done)
      return
    }
    let began = Date()
    running[key] = (began, [done])
    let finish = { (r: Result<ScreenShot, LookError>, took: (capture: Int, read: Int)) in
      lastUse = Date()
      lastTiming = took
      let late = Date().timeIntervalSince(began) > deadline
      // Only numbers: how long each half took, so a slow look can be told apart next time.
      if late { BodyLink.shared.timeline("look.late", ["captureMs": took.capture, "readMs": took.read]) }
      guard running[key]?.started == began, let waiting = running.removeValue(forKey: key)?.waiting else { return }
      waiting.forEach { $0(r) }
    }
    let front = FrontApp.current()
    let secureFields = AXFinder.secureFieldFrames(in: front.app) // AppKit coordinates
    Task.detached {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else {
          throw LookError.failed("no display")
        }
        let me = ProcessInfo.processInfo.processIdentifier
        let filter = SCContentFilter(display: display, excludingApplications: content.applications.filter { $0.processID == me }, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = Int(CGFloat(display.width) * scale)
        config.height = Int(CGFloat(display.height) * scale)
        config.showsCursor = false
        var image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let captured = Date()
        var area = frame
        if let crop, let cut = image.cropping(to: PointMath.cropPixels(crop, display: frame, scale: scale)) {
          image = cut
          area = crop
        }
        let shot = try process(image, frame: area, secureFields: secureFields, front: front, maxEdge: maxEdge, marks: marks, grid: grid)
        let took = (Int(captured.timeIntervalSince(began) * 1000), Int(Date().timeIntervalSince(captured) * 1000))
        DispatchQueue.main.async { finish(.success(shot), took) }
      } catch let e as LookError {
        DispatchQueue.main.async { finish(.failure(e), (0, 0)) }
      } catch {
        let denied = !CGPreflightScreenCaptureAccess()
        DispatchQueue.main.async { finish(.failure(denied ? .permission : .failed(error.localizedDescription)), (0, 0)) }
      }
    }
  }

  /// Read, redact, shrink and encode a captured frame.
  static func process(_ image: CGImage, frame: CGRect, secureFields: [CGRect], front: FrontApp.Info, maxEdge: CGFloat,
                      marks: [(label: String, frame: CGRect)] = [], grid: Int = 0) throws -> ScreenShot {
    let size = CGSize(width: image.width, height: image.height)
    let boxes = recognize(image)
    var blackout: [CGRect] = secureFields.map { toImage($0, frame: frame, size: size).insetBy(dx: -4, dy: -4) }
    var kept: [TextBox] = []
    var count = blackout.count
    for b in boxes {
      let r = Redactor.redact(b.text)
      if r.count > 0 {
        count += r.count
        blackout.append(b.rect.insetBy(dx: -6, dy: -4))
      }
      kept.append(TextBox(text: r.text, rect: b.rect))
    }
    guard let blacked = blackOut(image, blackout) else { throw LookError.failed("couldn't draw") }
    let badges = marks.map { (label: $0.label, rect: toImage($0.frame, frame: frame, size: size)) }.filter { $0.rect.intersects(CGRect(origin: .zero, size: size)) }
    let redacted = badges.isEmpty && grid <= 0 ? blacked : (annotate(blacked, marks: badges, grid: grid) ?? blacked)
    let longEdge = max(size.width, size.height)
    let factor = longEdge > maxEdge ? maxEdge / longEdge : 1
    let outSize = CGSize(width: (size.width * factor).rounded(), height: (size.height * factor).rounded())
    guard let small = resize(redacted, to: outSize),
          let jpeg = NSBitmapImageRep(cgImage: small).representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else {
      throw LookError.failed("couldn't encode")
    }
    let window = Redactor.redact(front.window).text
    return ScreenShot(jpeg: jpeg, size: outSize, boxes: kept, captureSize: size, displayFrame: frame,
                      text: lines(kept, height: size.height), redactions: count, app: front.name, window: window)
  }

  /// Vision's on-device text recognition: one box per line of text.
  static func recognize(_ image: CGImage) -> [TextBox] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let w = CGFloat(image.width), h = CGFloat(image.height)
    return (request.results ?? []).compactMap { obs in
      guard let text = obs.topCandidates(1).first?.string, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
      let b = obs.boundingBox // normalized, bottom-left origin
      return TextBox(text: text, rect: CGRect(x: b.minX * w, y: (1 - b.maxY) * h, width: b.width * w, height: b.height * h))
    }
  }

  /// The boxes as reading order: top to bottom, and left to right along a row.
  static func lines(_ boxes: [TextBox], height: CGFloat) -> String {
    let row = max(height / 120, 6)
    let sorted = boxes.sorted {
      let a = ($0.rect.midY / row).rounded(), b = ($1.rect.midY / row).rounded()
      return a == b ? $0.rect.minX < $1.rect.minX : a < b
    }
    var out: [String] = []
    var current: [String] = []
    var currentRow: CGFloat? = nil
    for b in sorted {
      let r = (b.rect.midY / row).rounded()
      if let c = currentRow, c != r {
        out.append(current.joined(separator: "   "))
        current = []
      }
      currentRow = r
      current.append(b.text)
    }
    if !current.isEmpty { out.append(current.joined(separator: "   ")) }
    return out.joined(separator: "\n")
  }

  /// A rectangle in AppKit screen coordinates, as pixels in a capture of `frame`.
  static func toImage(_ r: CGRect, frame: CGRect, size: CGSize) -> CGRect {
    PointMath.screenToImage(r, display: frame, imageSize: size)
  }

  /// Pixels in a capture of `frame` (top-left origin), as AppKit screen coordinates.
  static func toScreen(_ r: CGRect, frame: CGRect, size: CGSize) -> CGRect {
    PointMath.imageToScreen(r, display: frame, imageSize: size)
  }

  /// Set-of-Marks: a warm outline and a numbered badge on each control (like Voice Control's
  /// "show numbers"), or a numbered grid (its "show grid"). Drawn on the copy sent to the model.
  static func annotate(_ image: CGImage, marks: [(label: String, rect: CGRect)], grid: Int) -> CGImage? {
    let w = image.width, h = image.height
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    // Image pixels have a top-left origin; the context's is bottom-left.
    let flip = { (r: CGRect) in CGRect(x: r.minX, y: CGFloat(h) - r.maxY, width: r.width, height: r.height) }
    let scale = max(1, CGFloat(w) / 1600)
    let badge = { (label: String, at: CGPoint) in
      let font = NSFont.systemFont(ofSize: 13 * scale, weight: .bold)
      let text = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: NSColor.white])
      let size = text.size()
      let box = CGRect(x: at.x, y: at.y - size.height - 4 * scale, width: size.width + 8 * scale, height: size.height + 4 * scale)
      ctx.setFillColor(Sunset.coral.withAlphaComponent(0.92).cgColor)
      ctx.addPath(CGPath(roundedRect: box, cornerWidth: 5 * scale, cornerHeight: 5 * scale, transform: nil))
      ctx.fillPath()
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
      text.draw(at: CGPoint(x: box.minX + 4 * scale, y: box.minY + 2 * scale))
      NSGraphicsContext.restoreGraphicsState()
    }
    if grid > 0 {
      let cols = min(max(grid, 2), 16)
      let rows = max(2, Int((CGFloat(cols) * CGFloat(h) / CGFloat(w)).rounded()))
      let cw = CGFloat(w) / CGFloat(cols), ch = CGFloat(h) / CGFloat(rows)
      ctx.setStrokeColor(Sunset.amber.withAlphaComponent(0.55).cgColor)
      ctx.setLineWidth(1.5 * scale)
      for c in 1..<cols { ctx.move(to: CGPoint(x: CGFloat(c) * cw, y: 0)); ctx.addLine(to: CGPoint(x: CGFloat(c) * cw, y: CGFloat(h))) }
      for r in 1..<rows { ctx.move(to: CGPoint(x: 0, y: CGFloat(r) * ch)); ctx.addLine(to: CGPoint(x: CGFloat(w), y: CGFloat(r) * ch)) }
      ctx.strokePath()
      for r in 0..<rows {
        for c in 0..<cols { badge(String(r * cols + c + 1), CGPoint(x: CGFloat(c) * cw + 3 * scale, y: CGFloat(h) - CGFloat(r) * ch - 3 * scale)) }
      }
    }
    ctx.setStrokeColor(Sunset.coral.withAlphaComponent(0.9).cgColor)
    ctx.setLineWidth(2 * scale)
    for m in marks {
      let r = flip(m.rect)
      ctx.addPath(CGPath(roundedRect: r, cornerWidth: 4 * scale, cornerHeight: 4 * scale, transform: nil))
      ctx.strokePath()
      badge(m.label, CGPoint(x: r.minX, y: r.maxY + 2 * scale))
    }
    return ctx.makeImage()
  }

  static func blackOut(_ image: CGImage, _ rects: [CGRect]) -> CGImage? {
    let w = image.width, h = image.height
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    ctx.setFillColor(CGColor(gray: 0.08, alpha: 1))
    for r in rects {
      // CGContext is bottom-left; the rects are top-left.
      let flipped = CGRect(x: r.minX, y: CGFloat(h) - r.maxY, width: r.width, height: r.height)
      ctx.addPath(CGPath(roundedRect: flipped, cornerWidth: 4, cornerHeight: 4, transform: nil))
    }
    ctx.fillPath()
    return ctx.makeImage()
  }

  static func resize(_ image: CGImage, to size: CGSize) -> CGImage? {
    if Int(size.width) == image.width && Int(size.height) == image.height { return image }
    guard let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(origin: .zero, size: size))
    return ctx.makeImage()
  }
}

/// Secrets in text read off the screen. Keep in step with redactText() in lib/screen.js.
enum Redactor {
  private static func re(_ p: String, _ opts: NSRegularExpression.Options = []) -> NSRegularExpression {
    try! NSRegularExpression(pattern: p, options: opts)
  }

  private static let tokens: [NSRegularExpression] = [
    re("-----BEGIN [A-Z ]*PRIVATE KEY-----.*"),
    re("\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b"),
    re("\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}"),
    re("\\bgh[pousr]_[A-Za-z0-9]{30,}\\b"),
    re("\\bgithub_pat_[A-Za-z0-9_]{30,}"),
    re("\\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    re("\\bAIza[0-9A-Za-z_-]{35}\\b"),
    re("\\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\\b"),
    re("\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"),
    re("\\b(?:Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]{16,}", .caseInsensitive),
    re("\\b[a-z][a-z0-9+.-]*://[^\\s:/@]+:[^\\s@/]+@", .caseInsensitive),
    re("\\b(?:pass(?:word|wd|code)?|pwd|secret|client[_ -]?secret|token|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|access[_ -]?key|private[_ -]?key|auth(?:orization)?|pin|cvv|cvc|otp)\\s*[:=]\\s*[\"']?[^\\s\"',;]{3,}", .caseInsensitive),
    re("\\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9_-]{32,}\\b"),
  ]
  private static let card = re("\\b\\d(?:[ -]?\\d){12,18}\\b")

  static func luhn(_ s: String) -> Bool {
    let digits = s.compactMap { $0.wholeNumberValue }
    guard (13...19).contains(digits.count) else { return false }
    var sum = 0
    for (i, d) in digits.reversed().enumerated() {
      var n = d
      if i % 2 == 1 { n *= 2; if n > 9 { n -= 9 } }
      sum += n
    }
    return sum % 10 == 0
  }

  /// The text with secrets replaced by [redacted], and how many there were.
  static func redact(_ text: String) -> (text: String, count: Int) {
    var out = text
    var count = 0
    for r in tokens {
      let range = NSRange(out.startIndex..., in: out)
      let n = r.numberOfMatches(in: out, range: range)
      if n > 0 {
        count += n
        out = r.stringByReplacingMatches(in: out, range: range, withTemplate: "[redacted]")
      }
    }
    let ns = out as NSString
    for m in card.matches(in: out, range: NSRange(location: 0, length: ns.length)).reversed() where luhn(ns.substring(with: m.range)) {
      count += 1
      out = (out as NSString).replacingCharacters(in: m.range, with: "[redacted]")
    }
    return (out, count)
  }
}

/// The app you're working in: the front app, or the one you used last if Echo is in front.
enum FrontApp {
  struct Info {
    let app: NSRunningApplication?
    let name: String
    let window: String
  }

  private static var lastOther: NSRunningApplication?
  private static var observer: NSObjectProtocol?

  static func startTracking() {
    guard observer == nil else { return }
    let me = ProcessInfo.processInfo.processIdentifier
    if let f = NSWorkspace.shared.frontmostApplication, f.processIdentifier != me { lastOther = f }
    observer = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
      if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.processIdentifier != me {
        lastOther = app
      }
    }
  }

  /// The app to look in: one named like `name` if given (Echo itself is "Echo"), else the front one.
  static func target(named name: String? = nil) -> NSRunningApplication? {
    if let name = name?.trimmingCharacters(in: .whitespaces).lowercased(), !name.isEmpty {
      if name == "echo" { return NSRunningApplication.current }
      let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
      if let hit = apps.first(where: { ($0.localizedName ?? "").lowercased() == name })
        ?? apps.first(where: { ($0.localizedName ?? "").lowercased().contains(name) }) {
        return hit
      }
    }
    let me = ProcessInfo.processInfo.processIdentifier
    if let f = NSWorkspace.shared.frontmostApplication, f.processIdentifier != me { return f }
    return lastOther
  }

  static func current() -> Info {
    let app = target()
    return Info(app: app, name: app?.localizedName ?? "", window: app.map { AXFinder.focusedWindowTitle(of: $0) } ?? "")
  }
}
