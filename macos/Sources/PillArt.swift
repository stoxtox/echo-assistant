// The island, drawn: near-black glass with a hairline white border, a soft shadow, the pearl at its
// left end and one line of white words (secondary words in grey). Caption.swift decides what it
// says, where it goes and how it moves; this only draws one frame of it with Core Graphics and
// Core Text, so a harness can render it to a PNG as well.
//
// Left to right: the pearl (Companion.swift), the words, Stop while Echo works on the Mac, and the
// close button. When Echo needs an OK it is drawn as a card: the question, its detail in grey,
// and Cancel and the action button (a white pill with black text) at the bottom right.
import AppKit
import CoreText

/// What the island says.
struct PillContent: Equatable {
  /// Whose words the line is: yours (live), Echo's answer, or a plain line (a status, what she is
  /// doing on the Mac).
  enum Kind: Equatable { case none, user, echo, plain }
  var kind = Kind.none
  /// The words, in white.
  var main = ""
  /// Secondary words after them, in grey ("· typing in A1").
  var dim = ""
  /// Your words are still coming in: the newest one is grey until the next arrives.
  var live = false
  /// Echo is thinking about what you said: your words wait in grey.
  var thinking = false
  /// The Stop button shows (Echo is working on the Mac).
  var stop = false
  /// Echo needs an OK: the island is a card.
  var card: Card?

  struct Card: Equatable {
    var question = ""
    var detail = ""
    var action = "Yes"
    var cancel = "Cancel"
  }

  var isEmpty: Bool { main.isEmpty && dim.isEmpty && card == nil }
  /// The same kind of line (a new partial of the same words doesn't cross-fade).
  func sameShape(_ o: PillContent) -> Bool {
    kind == o.kind && dim == o.dim && thinking == o.thinking && card == o.card && main.isEmpty == o.main.isEmpty
      && (kind != .plain || main == o.main)
  }
}

final class PillArt {
  static func font(_ size: CGFloat, _ weight: NSFont.Weight) -> NSFont { NSFont.systemFont(ofSize: size, weight: weight) }

  /// The island's words, and its buttons' labels.
  static let text = font(14.5, .regular)
  static let button = font(13, .regular)
  static let buttonBold = font(13, .semibold)

  var reduced = false
  /// How faint the island's pearl is while the one out pointing is `away` (0…1) from here.
  static func pearlFade(away: CGFloat) -> CGFloat { 1 - 0.75 * away }
  /// Stop: the mouse is over it, or pressing it (it gives a little).
  var stopHover = false
  var stopDown = false
  /// 0…1: how far the Stop button has faded in.
  var stopShown: CGFloat = 0
  /// The close button: the mouse is over it.
  var closeHover = false
  /// The card's buttons: which one the mouse is over or pressing ("action", "cancel" or "").
  var cardHover = ""
  var cardDown = ""
  /// 0…1: the pearl has flown out to point at something, so the one here waits faintly.
  var away: CGFloat = 0
  /// How many of Echo's words she has said (SpeechMath.lit): those are white, the rest wait in
  /// grey. Infinity: all of it.
  var echoLit: CGFloat = .infinity
  /// Echo's answer split into lines that fit (layoutEcho): one shows at a time.
  private(set) var echoLines: [Range<Int>] = []
  /// Which of those lines is showing, and how far it has faded in (0…1) since it took over.
  var echoLineIndex: Int { SpeechMath.line(echoLines, lit: echoLit) }
  var echoIn: CGFloat = 1

  // MARK: text

  private func attrs(_ font: NSFont, _ color: RGB, _ alpha: CGFloat = 1) -> [NSAttributedString.Key: Any] {
    [.font: font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color.cg(alpha)]
  }

  private func width(_ s: NSAttributedString) -> CGFloat {
    CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(s), nil, nil, nil))
  }
  private func width(_ s: String, _ font: NSFont) -> CGFloat { width(NSAttributedString(string: s, attributes: [.font: font])) }

  /// Splits Echo's answer into lines that fit `room`, and returns the widest one's width.
  @discardableResult
  func layoutEcho(_ c: PillContent, room: CGFloat) -> CGFloat {
    guard c.kind == .echo, !c.main.isEmpty else { echoLines = []; return 0 }
    let words = c.main.split(separator: " ").map(String.init)
    let widths = words.map { width($0, PillArt.text) }, space = width(" ", PillArt.text)
    echoLines = SpeechMath.lines(widths: widths, space: space, room: room)
    return echoLines.map { r in widths[r].reduce(0, +) + space * CGFloat(r.count - 1) }.max() ?? 0
  }

  /// Echo's answer, the line she is on: said words white, the one she is saying on its way there,
  /// the rest grey.
  private func echoLine(_ c: PillContent) -> NSAttributedString {
    let words = c.main.split(separator: " ").map(String.init)
    let lines = echoLines.isEmpty || echoLines.last?.upperBound != words.count ? [0..<words.count] : echoLines
    let range = lines[SpeechMath.line(lines, lit: echoLit)]
    let s = NSMutableAttributedString()
    for i in range {
      let color = MarkArt.dim.mix(MarkArt.ink, SpeechMath.said(word: i, lit: echoLit))
      s.append(NSAttributedString(string: (i > range.lowerBound ? " " : "") + words[i], attributes: attrs(PillArt.text, color)))
    }
    return s
  }

  /// Your words: white, the newest one grey while more are coming (it fades in as it arrives),
  /// all of them grey while Echo thinks. Only as many of the latest as fit `room`.
  private func userLine(_ c: PillContent, room: CGFloat, newWord: CGFloat) -> NSAttributedString {
    var words = c.main.split(separator: " ").map(String.init)
    var dropped = false
    while true {
      let s = NSMutableAttributedString()
      if dropped { s.append(NSAttributedString(string: "… ", attributes: attrs(PillArt.text, MarkArt.dim))) }
      for (i, w) in words.enumerated() {
        let last = i == words.count - 1
        let a = c.thinking ? attrs(PillArt.text, MarkArt.dim) : last && c.live ? attrs(PillArt.text, MarkArt.dim, newWord) : attrs(PillArt.text, MarkArt.ink)
        s.append(NSAttributedString(string: (i > 0 ? " " : "") + w, attributes: a))
      }
      if words.count <= 1 || width(s) <= room { return s }
      words.removeFirst()
      dropped = true
    }
  }

  /// A plain line: white words, then the grey ones.
  private func plainLine(_ c: PillContent) -> NSAttributedString {
    let s = NSMutableAttributedString(string: c.main, attributes: attrs(PillArt.text, MarkArt.ink))
    s.append(NSAttributedString(string: c.dim, attributes: attrs(PillArt.text, MarkArt.dim)))
    return s
  }

  private func line(_ c: PillContent, room: CGFloat, newWord: CGFloat) -> NSAttributedString {
    switch c.kind {
    case .echo: return echoLine(c)
    case .user: return userLine(c, room: room, newWord: newWord)
    default: return plainLine(c)
    }
  }

  /// How wide the words would like to be, given at most `room`. (Echo's answer: its widest line,
  /// so the island keeps one width from her first line to her last.)
  func textWidth(_ c: PillContent, room: CGFloat) -> CGFloat {
    guard !c.isEmpty, c.card == nil else { return 0 }
    if c.kind == .echo { return ceil(layoutEcho(c, room: room)) }
    return ceil(min(room, width(line(c, room: .greatestFiniteMagnitude, newWord: 1))))
  }

  /// `text` wrapped to `width`, at most `maxLines` lines (the last one cut short with "…").
  private func wrap(_ text: NSAttributedString, width: CGFloat, maxLines: Int) -> [CTLine] {
    guard text.length > 0, width > 0 else { return [] }
    let setter = CTTypesetterCreateWithAttributedString(text)
    var lines: [CTLine] = [], at = 0
    while at < text.length {
      if lines.count == maxLines - 1 {
        // The last line allowed: all that's left, cut short if it doesn't fit.
        let rest = CTLineCreateWithAttributedString(text.attributedSubstring(from: NSRange(location: at, length: text.length - at)))
        let dots = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: text.attributes(at: text.length - 1, effectiveRange: nil)))
        lines.append(CTLineCreateTruncatedLine(rest, Double(width), .end, dots) ?? rest)
        break
      }
      let n = max(1, CTTypesetterSuggestLineBreak(setter, at, Double(width)))
      lines.append(CTTypesetterCreateLine(setter, CFRange(location: at, length: n)))
      at += n
    }
    return lines
  }

  private func cardText(_ card: PillContent.Card, width: CGFloat) -> (question: [CTLine], detail: [CTLine]) {
    (wrap(NSAttributedString(string: card.question, attributes: attrs(PillArt.text, MarkArt.ink)), width: width, maxLines: 3),
     wrap(NSAttributedString(string: card.detail, attributes: attrs(PillArt.text, MarkArt.dim)), width: width, maxLines: 3))
  }

  /// Where everything goes in the card for `card` on a screen `screenWidth` wide.
  func cardLayout(_ card: PillContent.Card, screenWidth: CGFloat) -> PillMath.Card {
    let t = cardText(card, width: PillMath.cardTextWidth(screenWidth: screenWidth))
    return PillMath.card(questionLines: t.question.count, detailLines: t.detail.count, cancelLabel: width(card.cancel, PillArt.button),
                         actionLabel: width(card.action, PillArt.buttonBold), screenWidth: screenWidth)
  }

  // MARK: a frame

  /// Draws the island at `r` (y up). `previous` is the line being replaced and `mix` (0…1) how far
  /// the new one has come in; `newWord` (0…1) fades in your latest word; `grown` (0…1) is how far
  /// it has grown into `card` (the bar's words and buttons fade out as the card's fade in).
  /// `pearl`: drawn here at the island's left end; nil when the app draws it in its own small
  /// view on top (Caption.swift), so the pearl can breathe without the whole island redrawing.
  func draw(in ctx: CGContext, pill r: CGRect, content c: PillContent, previous: PillContent?, mix: CGFloat, newWord: CGFloat,
            pearl: PearlArt?, card: (text: PillContent.Card, layout: PillMath.Card)? = nil, grown: CGFloat = 0, now: Double, pixelScale px: CGFloat) {
    let corner = min(r.height / 2, PillMath.corner + (PillMath.cardCorner - PillMath.corner) * grown)
    let path = CGPath(roundedRect: r, cornerWidth: corner, cornerHeight: corner, transform: nil)

    // The shadow (0 18 50 at 55%), only outside the glass so the glass itself stays clear.
    ctx.saveGState()
    ctx.addRect(r.insetBy(dx: -90, dy: -90))
    ctx.addPath(path)
    ctx.clip(using: .evenOdd)
    ctx.setShadow(offset: CGSize(width: 0, height: -18 * px), blur: 50 * px, color: CGColor(gray: 0, alpha: 0.55))
    ctx.addPath(path)
    ctx.setFillColor(CGColor(gray: 0, alpha: 1))
    ctx.fillPath()
    ctx.restoreGState()

    // The glass: near-black at 86% (the blur is underneath, in Caption.swift), and its hairline.
    ctx.addPath(path)
    ctx.setFillColor(MarkArt.glass.cg(0.86))
    ctx.fillPath()
    ctx.addPath(CGPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerWidth: corner - 0.5, cornerHeight: corner - 0.5, transform: nil))
    ctx.setStrokeColor(RGB.white.cg(MarkArt.hairline))
    ctx.setLineWidth(1)
    ctx.strokePath()

    // The pearl (faint while the one out pointing is away from here).
    if let pearl {
      pearl.fade = PillArt.pearlFade(away: away)
      pearl.draw(in: ctx, at: PillMath.slotCenter(r), now: now, pixelScale: px)
    }

    // Everything else stays inside the glass while it grows and shrinks.
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let bar = 1 - grown
    if bar > 0.01 {
      // The words, clipped to their room (a line never runs under Stop or the close button).
      let x = PillMath.textX(r), midY = r.maxY - PillMath.height / 2
      let room = PillMath.textRoom(width: r.width, stop: c.stop || stopShown > 0.01)
      ctx.saveGState()
      ctx.clip(to: CGRect(x: x, y: r.maxY - PillMath.height, width: max(0, room + 2), height: PillMath.height))
      if let p = previous, mix < 1, p.card == nil {
        drawLine(ctx, p, x: x, midY: midY, room: room, alpha: bar * pow(1 - mix, 2), rise: 0, newWord: 1)
      }
      if c.card == nil {
        drawLine(ctx, c, x: x, midY: midY, room: room, alpha: bar * (previous == nil ? 1 : mix), rise: reduced ? 0 : 4 * (1 - mix), newWord: newWord)
      }
      ctx.restoreGState()
      if stopShown > 0.01 {
        ghost(ctx, PillMath.stopRect(r), "Stop", hover: stopHover, down: stopDown, alpha: bar * stopShown)
      }
      // Close: a small circle with a cross.
      let x0 = PillMath.closeRect(r)
      ctx.setFillColor(RGB.white.cg((closeHover ? 0.16 : 0.08) * bar))
      ctx.fillEllipse(in: x0)
      ctx.setStrokeColor((closeHover ? MarkArt.ink : MarkArt.dim).cg(bar))
      ctx.setLineWidth(1.3)
      ctx.setLineCap(.round)
      ctx.move(to: CGPoint(x: x0.midX - 3.5, y: x0.midY - 3.5))
      ctx.addLine(to: CGPoint(x: x0.midX + 3.5, y: x0.midY + 3.5))
      ctx.move(to: CGPoint(x: x0.midX - 3.5, y: x0.midY + 3.5))
      ctx.addLine(to: CGPoint(x: x0.midX + 3.5, y: x0.midY - 3.5))
      ctx.strokePath()
    }
    if grown > 0.01, let card { drawCard(ctx, r, card.text, card.layout, alpha: grown) }
    ctx.restoreGState()
  }

  /// The card: laid out from the island's top-left corner, so nothing moves while it grows.
  private func drawCard(_ ctx: CGContext, _ r: CGRect, _ text: PillContent.Card, _ card: PillMath.Card, alpha: CGFloat) {
    let origin = CGPoint(x: r.minX, y: r.maxY - card.size.height)
    func place(_ b: CGRect) -> CGRect { b.offsetBy(dx: origin.x, dy: origin.y) }
    let lines = cardText(text, width: card.question.width)
    ctx.saveGState()
    ctx.setAlpha(alpha)
    ctx.textMatrix = .identity
    for (block, rows) in [(place(card.question), lines.question), (place(card.detail), lines.detail)] {
      for (i, row) in rows.enumerated() {
        let mid = block.maxY - (CGFloat(i) + 0.5) * PillMath.cardLine
        ctx.textPosition = CGPoint(x: block.minX, y: baseline(mid, PillArt.text))
        CTLineDraw(row, ctx)
      }
    }
    ctx.restoreGState()
    ghost(ctx, place(card.cancel), text.cancel, hover: cardHover == "cancel", down: cardDown == "cancel", alpha: alpha)
    // The action: a white pill, black words.
    let b = place(card.action)
    ctx.saveGState()
    ctx.setAlpha(alpha)
    press(ctx, b, cardDown == "action")
    ctx.addPath(CGPath(roundedRect: b, cornerWidth: b.height / 2, cornerHeight: b.height / 2, transform: nil))
    ctx.setFillColor((cardHover == "action" ? RGB.white : MarkArt.ink).cg())
    ctx.fillPath()
    label(ctx, text.action, PillArt.buttonBold, CGColor(gray: 0, alpha: 1), in: b)
    ctx.restoreGState()
  }

  /// A quiet button: a hairline capsule with white words (Stop, Cancel).
  private func ghost(_ ctx: CGContext, _ b: CGRect, _ title: String, hover: Bool, down: Bool, alpha: CGFloat) {
    ctx.saveGState()
    ctx.setAlpha(alpha)
    press(ctx, b, down)
    if hover {
      ctx.addPath(CGPath(roundedRect: b, cornerWidth: b.height / 2, cornerHeight: b.height / 2, transform: nil))
      ctx.setFillColor(RGB.white.cg(0.08))
      ctx.fillPath()
    }
    ctx.addPath(CGPath(roundedRect: b.insetBy(dx: 0.5, dy: 0.5), cornerWidth: b.height / 2 - 0.5, cornerHeight: b.height / 2 - 0.5, transform: nil))
    ctx.setStrokeColor(RGB.white.cg(hover ? 0.3 : MarkArt.hairline))
    ctx.setLineWidth(1)
    ctx.strokePath()
    label(ctx, title, PillArt.button, MarkArt.ink.cg(), in: b)
    ctx.restoreGState()
  }

  private func press(_ ctx: CGContext, _ b: CGRect, _ down: Bool) {
    guard down else { return }
    ctx.translateBy(x: b.midX, y: b.midY)
    ctx.scaleBy(x: 0.96, y: 0.96)
    ctx.translateBy(x: -b.midX, y: -b.midY)
  }

  private func label(_ ctx: CGContext, _ s: String, _ font: NSFont, _ color: CGColor, in b: CGRect) {
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: [.font: font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color]))
    ctx.textMatrix = .identity
    ctx.textPosition = CGPoint(x: b.midX - CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) / 2, y: baseline(b.midY, font))
    CTLineDraw(line, ctx)
  }

  private func drawLine(_ ctx: CGContext, _ c: PillContent, x: CGFloat, midY: CGFloat, room: CGFloat, alpha: CGFloat, rise: CGFloat, newWord: CGFloat) {
    guard alpha > 0.01, !c.isEmpty else { return }
    var line = CTLineCreateWithAttributedString(self.line(c, room: room, newWord: newWord))
    // A plain line too long for its room is cut short with "…".
    if c.kind != .user, CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) > room + 1 {
      let dots = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: attrs(PillArt.text, MarkArt.dim)))
      line = CTLineCreateTruncatedLine(line, Double(room), .end, dots) ?? line
    }
    ctx.saveGState()
    ctx.setAlpha(alpha * (c.kind == .echo ? echoIn : 1))
    ctx.textMatrix = .identity
    ctx.textPosition = CGPoint(x: x, y: baseline(midY, PillArt.text) - rise)
    CTLineDraw(line, ctx)
    ctx.restoreGState()
  }

  /// The baseline that centres a line of `font` on `midY`.
  private func baseline(_ midY: CGFloat, _ font: NSFont) -> CGFloat {
    (midY - (font.ascender + font.descender) / 2).rounded(.toNearestOrAwayFromZero)
  }
}
