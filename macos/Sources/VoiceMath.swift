// The decisions behind the native mic and taking back control, with no audio or events in them,
// so macos/Tests/Voice/main.swift can check them (test/nativemic.test.js compiles and runs it):
// - ListenMachine: the one listening engine. Idle, Armed(reason), Hearing(reason), Finishing; what
//   starts a sentence, what ends it, and that every sentence ends as delivered or dropped(reason);
// - SpeechGate: when you start and stop talking, with a threshold that follows the background
//   noise (a video or the TV playing) and a stricter one while Echo herself is speaking (barge-in);
// - MicOpen: when the mic is open at all (only while something listens, plus a short while after
//   a push-to-talk); FrameWatch: noticing a mic that has stopped delivering sound;
// - MicEvent: the events the app's mic sends the page, each with its fields, in one place (the
//   same table is test/fixtures/nativemic-events.json, which both sides are checked against);
// - DuckPlan: turning the Mac's volume down while you talk, and back up only if you haven't
//   changed it yourself in the meantime;
// - TakeBackPolicy: which of your own mouse and key input stops the current action, ends the
//   whole driving session, or is ignored; InputTarget: whether that input went to Echo's own
//   windows (then it's never taking over);
// - Resample: the mic's audio to 16 kHz mono for Whisper.
import CoreGraphics
import Foundation

/// Voice activity from loudness frames (RMS of ~20-30 ms of 16 kHz audio).
struct SpeechGate {
  enum Event: Equatable { case onset, end }

  /// The quietest level that can count as speech.
  var minThreshold: Float = 0.01
  /// Speech must be this many times louder than the background.
  var ratio: Float = 3.5
  /// While Echo speaks: this many times louder than what her own voice leaves in the mic.
  var echoRatio: Float = 3
  /// Speech this long starts an utterance (ms), and while Echo speaks (a barge-in).
  var onsetMs: Double = 120
  var bargeOnsetMs: Double = 140
  /// A pause this long ends it.
  var endSilenceMs: Double = 1300
  /// The longest utterance.
  var maxMs: Double = 30000

  /// While Echo starts speaking, this long is spent learning her level (no barge-in yet).
  var echoWarmMs: Double = 300

  private(set) var noiseFloor: Float = 0.004
  /// The average background (a video, music, the TV): speech has to stand out from it too.
  private(set) var ambient: Float = 0.004
  var ambientRatio: Float = 1.6
  /// What's left of Echo's own voice in the mic after echo cancellation, learned while she speaks.
  private(set) var echoFloor: Float = 0
  private(set) var hearing = false
  private var voicedMs: Double = 0
  private var silentMs: Double = 0
  private var lengthMs: Double = 0
  private var echoMs: Double = 0
  /// Onsets are ignored (and the background relearned fast) until this much time has passed.
  private var holdMs: Double = 0

  /// The level speech has to beat right now.
  func threshold(echo: Bool) -> Float {
    let base = max(minThreshold, noiseFloor * ratio, ambient * ambientRatio)
    return echo ? max(base, echoFloor * echoRatio) : base
  }

  /// Don't start anything for a moment and relearn the background (after the volume comes back up).
  mutating func holdOff(ms: Double) {
    holdMs = max(holdMs, ms)
  }

  /// Echo stopped speaking: her echo level fades out of the picture.
  mutating func echoEnded() {
    echoFloor = 0
    echoMs = 0
  }

  /// Drop what's in progress (the mode changed, push-to-talk took over).
  mutating func reset() {
    hearing = false
    voicedMs = 0
    silentMs = 0
    lengthMs = 0
  }

  /// A sentence is under way again (push-to-talk gave it back): it ends on your next pause.
  mutating func resume() {
    hearing = true
    silentMs = 0
  }

  /// One frame. `echo`: Echo's voice is playing now. `ducked`: the volume is turned down for you,
  /// so the background is quieter than usual and isn't learned.
  mutating func feed(level: Float, frameMs: Double, echo: Bool = false, ducked: Bool = false) -> Event? {
    if !echo && echoMs > 0 { echoEnded() }
    if echo {
      echoMs += frameMs
      // Her first moments: learn how loud she is in the mic before anything can cut in.
      if echoMs <= echoWarmMs && !hearing {
        echoFloor = max(echoFloor, level)
        voicedMs = 0
        return nil
      }
    }
    if holdMs > 0 {
      holdMs -= frameMs
      if !hearing {
        noiseFloor = noiseFloor * 0.8 + level * 0.2
        ambient = ambient * 0.8 + level * 0.2
        voicedMs = 0
        return nil
      }
    }
    let t = threshold(echo: echo)
    if echo {
      if !hearing && level <= t { echoFloor = max(echoFloor * 0.998, level) }
    } else if !ducked {
      // The quiet floor follows the gaps; the average follows steady sound. Neither moves while a
      // sentence is under way: your own voice isn't the background, and learning it as such used
      // to raise the threshold until a long sentence was cut off in the middle.
      if !hearing && level < t { noiseFloor = noiseFloor * 0.995 + level * 0.005 }
      if !hearing { ambient += (level - ambient) * 0.01 }
    }
    if level > t {
      voicedMs += frameMs
      silentMs = 0
    } else {
      voicedMs = max(0, voicedMs - frameMs)
      if hearing { silentMs += frameMs }
    }
    if !hearing {
      if voicedMs > (echo ? bargeOnsetMs : onsetMs) {
        hearing = true
        lengthMs = voicedMs
        silentMs = 0
        return .onset
      }
      return nil
    }
    lengthMs += frameMs
    if silentMs >= endSilenceMs || lengthMs >= maxMs {
      // Sound that never paused (a video that started mid-silence, not a sentence): the background
      // is relearned from it now, so it doesn't start the next "sentence" straight away.
      if silentMs < endSilenceMs { holdOff(ms: 1000) }
      reset()
      return .end
    }
    return nil
  }

  static func rms(_ samples: [Float]) -> Float {
    guard !samples.isEmpty else { return 0 }
    var sum: Float = 0
    for s in samples { sum += s * s }
    return (sum / Float(samples.count)).squareRoot()
  }
}

/// When a pause ends your turn (Stage 4, end of turn). From the words heard so far: a sentence that
/// really looks finished (four words or more, ending on a full stop or on a word that leaves
/// nothing hanging) ends after a short pause, so Echo answers sooner. Anything else waits: one
/// that stops on "and", "the", "to", "um" or a comma, and the start of a thought ("I just",
/// "I just think", "so"), wait longer, so a pause to think isn't taken as the end. (People pause
/// mid-thought: the short pause used to end "I just think" 0.7 s in, a dozen times in one
/// session.) With no words yet, the usual pause.
enum TurnEnd {
  /// Last words that leave a sentence hanging, among them the everyday starts of a thought.
  static let hanging: Set<String> = [
    "and", "or", "but", "so", "because", "cause", "if", "when", "then", "than", "while", "until", "unless", "although",
    "the", "a", "an", "this", "that", "these", "those", "my", "your", "his", "her", "its", "our", "their", "some", "any", "every",
    "to", "of", "for", "with", "in", "on", "at", "by", "from", "into", "about", "like", "as", "onto", "over", "under", "between", "through",
    "is", "are", "was", "were", "be", "been", "am", "will", "would", "can", "could", "should", "shall", "might", "must", "do", "does", "did", "have", "has", "had",
    "i", "we", "you", "he", "she", "they", "it's", "let's", "i'm", "we're", "you're", "there's",
    "um", "uh", "er", "hmm", "and…", "which", "who", "whose", "where", "what", "how", "also", "just", "very", "really", "more", "most",
    "think", "need", "want", "mean", "guess", "feel", "know", "kind", "sort", "trying", "going", "gonna", "wanna",
    "maybe", "actually", "basically", "well",
  ]
  /// Two last words that do the same ("okay so").
  static let hangingPairs: Set<String> = ["okay so", "ok so"]
  /// First words of a thought that is only starting: with under five words said, it waits the long pause.
  static let starters: Set<String> = ["i", "i'm", "so", "well", "um"]

  /// The words, lower-cased, without the recogniser's punctuation ("I'm" keeps its apostrophe, typed either way).
  private static func plainWords(_ text: String) -> [String] {
    text.lowercased().replacingOccurrences(of: "’", with: "'").split(whereSeparator: { $0.isWhitespace })
      .map { String($0).trimmingCharacters(in: .punctuationCharacters) }.filter { !$0.isEmpty }
  }

  /// Does it sound unfinished?
  static func unfinished(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { return false }
    if t.hasSuffix(",") || t.hasSuffix("…") || t.hasSuffix("...") || t.hasSuffix("-") { return true }
    if t.hasSuffix(".") || t.hasSuffix("?") || t.hasSuffix("!") { return false }
    let w = plainWords(t)
    guard let last = w.last else { return false }
    return hanging.contains(last) || (w.count >= 2 && hangingPairs.contains(w[w.count - 2] + " " + last))
  }

  /// The pause (ms) that ends the turn after these words, given the usual one (`base`).
  /// `working`: the `run` arm (Echo is teaching or working and your hands are busy): never the short pause.
  static func endMs(after text: String, base: Double, working: Bool = false) -> Double {
    let w = plainWords(text)
    guard !w.isEmpty else { return base }
    // Longer, never shorter than the usual pause (with a long pause set, 3 s would cut it).
    let long = max(base, min(base + 800, 3000))
    if unfinished(text) { return long }
    // "I just." / "So": the start of a thought, whatever full stop the recogniser put after it.
    if w.count < 5, starters.contains(w[0]) { return long }
    // One to three words: a command ("stop", which the server acts on at once anyway) or the
    // start of a thought. The usual pause and a little more.
    if w.count < 4 { return max(base, min(base + 200, 3000)) }
    if working { return base }
    // It really looks finished. Shorter, never longer than the usual pause.
    return min(base, max(600, base * 0.55))
  }
}

/// The one listening engine: who may talk to Echo right now, when a sentence starts and ends, and
/// what becomes of it. The app's mic (NativeMic.swift) feeds it loudness frames and key presses and
/// carries out what it says; the page only draws its state.
///
/// Idle (nothing listens), Armed(reason) (waiting for speech), Hearing(reason) (a sentence is under
/// way), Finishing (it has ended and its text is being fetched). The reasons differ only in how a
/// sentence ends and how far it is trusted:
/// - ptt (Space, Control + Option, the mic button): starts at once from any state, taking over a
///   sentence already under way (so nothing is recorded twice); ends when the key is let go, plus
///   a short tail; never waits for a pause. A clicked mic button has no key to let go, so it ends
///   on your pause instead.
/// - wake: only "Hey Echo" starts a turn; said by itself, the request has 6 s to follow.
/// - window, run, handsfree: every sentence goes on to be judged; a pause ends it (TurnEnd).
/// Every sentence ends exactly once, as `delivered` or `dropped(why)`.
struct ListenMachine {
  enum Reason: String, CaseIterable { case ptt, wake, window, run, handsfree }

  enum State: Equatable {
    case idle, armed(Reason), hearing(Reason), finishing

    var name: String {
      switch self {
      case .idle: return "idle"
      case .armed: return "armed"
      case .hearing: return "hearing"
      case .finishing: return "finishing"
      }
    }

    var reason: Reason? {
      switch self {
      case .armed(let r), .hearing(let r): return r
      default: return nil
      }
    }
  }

  /// Why a sentence went nowhere. Each one is shown to the user in plain words (public/nativemic.js).
  enum Drop: String, CaseIterable {
    case tooShort = "too_short" // the key was let go before a word fits, or a click or a cough
    case silent // the mic gave nothing while the key was held, or no request followed "Hey Echo"
    case spoiled // a key was pressed during the shortcut: it was a shortcut, not talking
    case mode // listening was switched off under it (the mic-off switch, a dialog, the mic closed or stopped working)
    case notWake = "not_wake" // talk that didn't start with "Hey Echo"
    case cancelled
  }

  /// What every sentence carries: how it came in, how long it is from its first sound, how much
  /// of that was voice, how loud it was, and whether it began over Echo's own voice.
  struct Sentence: Equatable {
    var reason: Reason
    var lengthMs: Double = 0
    var voicedMs: Double = 0
    var level: Float = 0
    var overEcho = false
  }

  enum Effect: Equatable {
    /// The state changed: tell the page.
    case state
    /// A sentence began: its clip starts with the moments just before (the pre-roll).
    case began(Reason, overEcho: Bool)
    /// Ask whether the clip so far opens with "Hey Echo" (answer with `wakeResult`).
    case checkWake
    /// It did.
    case woke
    /// The key is held and nothing is coming from the mic.
    case cantHear
    case delivered(Sentence)
    case dropped(Drop, Sentence)
  }

  /// A sentence must outlast this to count: shorter is a tapped key (ptt).
  static let pttMinMs = 400.0
  /// Kept after the key is let go, so the last word isn't clipped.
  static let pttTailMs = 350.0
  static let pttMaxMs = 120_000.0
  /// Held this long with no voice: say so.
  static let cantHearMs = 1500.0
  /// A clicked mic button with nothing said closes by itself.
  static let clickWaitMs = 8000.0
  /// How much of a burst is checked for "Hey Echo", and how long its request may take to start.
  static let wakeCheckMs = 1800.0
  static let wakeWaitMs = 6000.0
  /// This much voice after "Hey Echo" (or while it was being checked) is the request.
  static let requestMs = 250.0
  /// Less voice than this is a click or a cough, not a sentence.
  static let minVoicedMs = 160.0
  /// A held key whose loudest moment stays under this heard nothing at all (a mic that isn't delivering).
  static let silentLevel: Float = 0.004

  var gate = SpeechGate()
  /// The usual pause that ends a sentence (Settings), before the words so far adjust it.
  var baseEndMs = 1300.0 { didSet { gate.endSilenceMs = baseEndMs } }
  /// Speech over Echo's own voice may start a sentence (Settings: barge-in).
  var bargeIn = true
  /// While Echo drives (the `run` arm): is it mid-step, or a lesson on, so your hands are busy and
  /// a sentence keeps its full pause? Idle between requests, a finished sentence ends sooner.
  var handsBusy = true

  private(set) var state: State = .idle
  /// What is armed whenever no sentence is under way.
  private(set) var background: Reason?
  /// How long the conversation window still has (0: no limit), and what is armed when it runs out.
  private(set) var windowLeftMs = 0.0
  private var after: Reason?
  /// The mic is closed (`stop`): nothing is heard until it opens again (`start`). What was armed is
  /// remembered, and armed again then.
  private var closed = false

  /// Does anything need the mic open: something is armed, or a sentence is under way?
  var wantsMic: Bool {
    if case .hearing = state { return true }
    return background != nil
  }

  // The sentence under way.
  private var s = Sentence(reason: .ptt)
  private var sumSq = 0.0
  private var peak: Float = 0
  // Push-to-talk.
  private var held = true
  private var released = false
  private var heldMs = 0.0
  private var tailMs = 0.0
  private var quietMs = 0.0
  private var warned = false
  /// The sentence the key took over (and where its "Hey Echo" check stood), so a shortcut that
  /// turns out not to be talking gives it back instead of dropping it.
  private var tookOver: Reason?
  private var tookWake = Wake.none
  // The wake word.
  private enum Wake { case none, unchecked, checking, awake }
  private var wake = Wake.none
  private var requestHeard = false
  private var requestMs = 0.0
  private var waitMs = 0.0

  // MARK: what the page asks for

  /// What to listen for when no key is held (nil: nothing). A window has `windowMs` left (0: no
  /// limit) and gives way to `then` when it runs out, so it closes even if the page is asleep.
  mutating func arm(_ reason: Reason?, windowMs: Double = 0, then: Reason? = nil) -> [Effect] {
    background = reason == .ptt ? nil : reason
    windowLeftMs = background == .window ? max(0, windowMs) : 0
    after = then == .ptt || then == .window ? nil : then
    switch state {
    case .idle, .armed:
      return settle()
    case .hearing(.ptt), .finishing:
      return []
    case .hearing(let cur):
      // Listening was switched off under the sentence: it's dropped, and said so.
      guard let next = background else { return drop(.mode) }
      // Waiting on "Hey Echo" when everything began to be listened to: the sentence counts as is.
      if cur == .wake, wake != .awake, next != .wake {
        let over = wake == .checking && !gate.hearing
        wake = .none
        s.reason = next
        state = .hearing(next)
        return over ? end() : [.state]
      }
      // Otherwise a sentence keeps the reason it began with.
      return []
    }
  }

  /// The mic closed (nothing needs it, the permission went, or it stopped working): a sentence
  /// under way is dropped, and said so. What was armed stays in mind for `start`.
  mutating func stop() -> [Effect] {
    closed = true
    if case .hearing = state { return drop(.mode) }
    if case .finishing = state { return [] }
    return settle()
  }

  /// The mic is open (again): what was armed is armed again.
  mutating func start() -> [Effect] {
    guard closed else { return [] }
    closed = false
    if case .finishing = state { return [] }
    return settle()
  }

  // MARK: push-to-talk

  /// The key went down (`held`), or the mic button was clicked (not held). From any state, at once.
  mutating func pttDown(held: Bool = true) -> [Effect] {
    self.held = held
    switch state {
    case .hearing(.ptt):
      // Pressed again during the tail: the same sentence goes on.
      released = false
      tailMs = 0
      return []
    case .hearing(let cur):
      // A sentence was under way: the key takes it over, so its first words aren't lost and
      // nothing is recorded twice.
      tookOver = cur
      tookWake = wake
      s.reason = .ptt
      wake = .none
      startPtt()
      return [.state]
    default:
      tookOver = nil
      s = Sentence(reason: .ptt)
      sumSq = 0
      peak = 0
      startPtt()
      return [.began(.ptt, overEcho: false), .state]
    }
  }

  private mutating func startPtt() {
    heldMs = 0
    quietMs = 0
    tailMs = 0
    released = false
    warned = false
    gate.reset()
    gate.endSilenceMs = baseEndMs
    state = .hearing(.ptt)
  }

  /// The key was let go (or the mic button clicked again). `heldMs`: how long it was down by the
  /// clock. A mic that was closed takes a moment to open, and the sound it then delivers is
  /// shorter than the hold: a real hold must not be taken for a tap because of that.
  mutating func pttUp(heldMs: Double = 0) -> [Effect] {
    guard case .hearing(.ptt) = state, !released else { return [] }
    if max(s.lengthMs, heldMs) < Self.pttMinMs { return drop(.tooShort) }
    released = true
    tailMs = 0
    return []
  }

  /// Not talking after all: a key pressed during the shortcut (`.spoiled`), or it was taken back.
  /// A shortcut pressed in the middle of a sentence that was already under way (hands-free, a
  /// window, a run) spoils only the key: the sentence goes on as it was, and ends on your pause.
  mutating func pttCancel(_ why: Drop = .cancelled) -> [Effect] {
    guard case .hearing(.ptt) = state else { return [] }
    guard why == .spoiled, let back = tookOver, background != nil else { return drop(why) }
    tookOver = nil
    s.reason = back
    // A "Hey Echo" check that was out when the key came down is asked again.
    wake = back == .wake ? (tookWake == .checking ? .unchecked : tookWake) : .none
    gate.resume()
    state = .hearing(back)
    return [.state]
  }

  // MARK: audio

  /// One frame of the mic. `echo`: Echo's voice is playing; `ducked`: the Mac's volume is down.
  mutating func frame(level: Float, frameMs: Double, echo: Bool = false, ducked: Bool = false) -> [Effect] {
    // A frame still on its way when the mic closed.
    if closed { return [] }
    switch state {
    case .hearing(.ptt):
      // The gate isn't fed: its picture of the background stays as it was before you spoke.
      let voiced = level > gate.threshold(echo: false)
      account(level, frameMs, voiced: voiced)
      heldMs += frameMs
      quietMs = voiced ? 0 : quietMs + frameMs
      if released {
        tailMs += frameMs
        return tailMs >= Self.pttTailMs ? end() : []
      }
      if s.lengthMs >= Self.pttMaxMs { return end() }
      var out: [Effect] = []
      if !warned, s.voicedMs < 100, heldMs >= Self.cantHearMs {
        warned = true
        out.append(.cantHear)
      }
      if !held {
        let spoke = s.voicedMs >= 200
        if spoke ? quietMs >= gate.endSilenceMs : heldMs >= Self.clickWaitMs { return out + end() }
      }
      return out

    case .hearing(let r):
      let voiced = level > gate.threshold(echo: echo)
      let event = gate.feed(level: level, frameMs: frameMs, echo: echo, ducked: ducked)
      account(level, frameMs, voiced: voiced)
      if r == .wake { return wakeFrame(event, voiced: voiced, frameMs: frameMs) }
      return event == .end ? end() : []

    case .idle, .armed, .finishing:
      var out: [Effect] = []
      if case .armed(.window) = state, windowLeftMs > 0 {
        windowLeftMs -= frameMs
        if windowLeftMs <= 0 {
          windowLeftMs = 0
          background = after
          after = nil
          out = settle()
        }
      }
      // Nothing listens: the gate still learns the room, so it knows it when something does.
      guard let r = background else {
        if gate.feed(level: level, frameMs: frameMs, echo: echo, ducked: ducked) != nil { gate.reset() }
        return out
      }
      if echo && !bargeIn { return out }
      guard gate.feed(level: level, frameMs: frameMs, echo: echo, ducked: ducked) == .onset else { return out }
      // The gate has heard this much of it already.
      let lead = (echo ? gate.bargeOnsetMs : gate.onsetMs) + frameMs
      s = Sentence(reason: r, lengthMs: lead, voicedMs: lead, overEcho: echo)
      sumSq = Double(level * level) * lead
      peak = level
      wake = r == .wake ? .unchecked : .none
      state = .hearing(r)
      return out + [.began(r, overEcho: echo), .state]
    }
  }

  /// The words heard so far in the sentence set how long a pause ends it (TurnEnd).
  mutating func words(_ text: String) {
    guard case .hearing(let r) = state else { return }
    gate.endSilenceMs = TurnEnd.endMs(after: text, base: baseEndMs, working: r == .run && handsBusy)
  }

  /// The answer to `checkWake`. `rest`: something was said after "Hey Echo" already.
  mutating func wakeResult(ok: Bool, rest: Bool = false) -> [Effect] {
    guard case .hearing(.wake) = state, wake == .checking else { return [] }
    guard ok else { return drop(.notWake) }
    wake = .awake
    waitMs = 0
    // "Hey Echo, check the build" in one breath: the request is under way already. Or it was
    // said, start to finish, while the check was out (`requestMs`: voice since the check began).
    requestHeard = rest || requestMs > Self.requestMs || (gate.hearing && s.lengthMs - Self.wakeCheckMs > 300)
    if requestHeard && !gate.hearing { return [.woke] + end() }
    return [.woke]
  }

  /// The delivered sentence is on its way: back to waiting.
  mutating func settled() -> [Effect] {
    guard case .finishing = state else { return [] }
    return settle()
  }

  // MARK: inside

  private mutating func wakeFrame(_ event: SpeechGate.Event?, voiced: Bool, frameMs: Double) -> [Effect] {
    switch wake {
    case .unchecked:
      if event == .end {
        if s.voicedMs < Self.minVoicedMs { return drop(.tooShort) }
        wake = .checking
        requestMs = 0
        return [.checkWake]
      }
      if s.lengthMs >= Self.wakeCheckMs {
        wake = .checking
        requestMs = 0
        return [.checkWake]
      }
    case .checking:
      // What is said while the check is out counts towards the request.
      if voiced { requestMs += frameMs }
      if s.lengthMs >= gate.maxMs { return drop(.notWake) }
    case .awake:
      if requestHeard {
        if event == .end || s.lengthMs >= gate.maxMs + Self.wakeWaitMs { return end() }
      } else if gate.hearing {
        if voiced { requestMs += frameMs }
        if requestMs > Self.requestMs { requestHeard = true }
      } else {
        // "Hey Echo", then quiet: the request has a while to start.
        waitMs += frameMs
        if waitMs >= Self.wakeWaitMs { return drop(.silent) }
      }
    case .none:
      break
    }
    return []
  }

  private mutating func account(_ level: Float, _ frameMs: Double, voiced: Bool) {
    s.lengthMs += frameMs
    if voiced { s.voicedMs += frameMs }
    sumSq += Double(level * level) * frameMs
    peak = max(peak, level)
  }

  /// Where the machine rests between sentences: armed as `background` says, idle with the mic closed.
  private var resting: State { closed ? .idle : background.map { .armed($0) } ?? .idle }

  /// Idle or armed, as `background` says.
  private mutating func settle() -> [Effect] {
    let next = resting
    guard next != state else { return [] }
    // What the gate was in the middle of belonged to the old way of listening.
    gate.reset()
    gate.endSilenceMs = baseEndMs
    state = next
    return [.state]
  }

  /// The sentence is over: delivered, unless there was nothing in it.
  private mutating func end() -> [Effect] {
    if s.reason == .ptt {
      // Held but silent (a mic that isn't delivering), or a clicked mic with nothing said.
      if peak < Self.silentLevel || (!held && s.voicedMs < 200) { return drop(.silent) }
    } else if s.voicedMs < Self.minVoicedMs {
      return drop(.tooShort)
    }
    s.level = s.lengthMs > 0 ? Float((sumSq / s.lengthMs).squareRoot()) : 0
    wake = .none
    gate.endSilenceMs = baseEndMs
    state = .finishing
    return [.delivered(s), .state]
  }

  private mutating func drop(_ why: Drop) -> [Effect] {
    s.level = s.lengthMs > 0 ? Float((sumSq / s.lengthMs).squareRoot()) : 0
    let sentence = s
    wake = .none
    // Talk that wasn't "Hey Echo" goes by to its next pause without being checked again.
    if why != .notWake { gate.reset() }
    gate.endSilenceMs = baseEndMs
    state = resting
    return [.dropped(why, sentence), .state]
  }
}

/// When the mic is open at all. Only while something listens (hands-free, "Hey Echo", a
/// conversation window, a run, a sentence under way), plus a short while after a push-to-talk so
/// a second press is instant. Never just because the app is running: an open mic lights the
/// orange dot in the menu bar and holds Bluetooth headsets in call mode.
struct MicOpen {
  /// How long the mic stays open after a push-to-talk.
  static let lingerMs = 30_000.0
  /// Wall clock (ms) until which it stays open with nothing listening.
  private(set) var lingerUntil = 0.0

  /// A push-to-talk sentence ended at `now` (ms). `linger`: staying open is allowed (not with the
  /// mic-off switch on: then it opens for the key and closes again).
  mutating func pttEnded(at now: Double, linger: Bool) {
    lingerUntil = linger ? now + Self.lingerMs : 0
  }

  /// The mic-off switch went on, or the page went away.
  mutating func clear() {
    lingerUntil = 0
  }

  /// `usable`: the mic is on and allowed; `wanted`: something is armed or being heard.
  func open(usable: Bool, wanted: Bool, now: Double) -> Bool {
    usable && (wanted || now < lingerUntil)
  }
}

/// A mic that should be delivering sound and isn't (AirPods connected, the input changed, the Mac
/// slept): restart it once; if that doesn't bring the sound back, give up and say so.
struct FrameWatch {
  enum Action: Equatable { case none, restart, giveUp }
  /// This long with no sound from an open mic is a stall.
  static let stallMs = 1500.0

  private var quietMs = 0.0
  private var restarted = false

  /// Called every `ms`. `gotFrames`: sound arrived since the last call; `listening`: the mic is
  /// meant to be open and heard right now.
  mutating func tick(ms: Double, gotFrames: Bool, listening: Bool) -> Action {
    guard listening, !gotFrames else {
      quietMs = 0
      restarted = false
      return .none
    }
    quietMs += ms
    guard quietMs >= Self.stallMs else { return .none }
    quietMs = 0
    if restarted {
      restarted = false
      return .giveUp
    }
    restarted = true
    return .restart
  }
}

/// The events the app's mic sends the page (public/nativemic.js AppMic.on), each built here and
/// nowhere else, so their names and fields can be checked against the one table both sides share
/// (test/fixtures/nativemic-events.json).
enum MicEvent {
  static func state(_ st: ListenMachine.State, since: Int, windowLeftMs: Int, running: Bool, permission: String, voiceProcessing: Bool, appleReady: Bool) -> [String: Any] {
    [
      "event": "state", "engine": 1, "state": st.name, "reason": st.reason?.rawValue ?? "", "since": since, "windowLeftMs": windowLeftMs,
      "running": running, "permission": permission, "voiceProcessing": voiceProcessing, "appleReady": appleReady,
    ]
  }

  /// Talking over Echo lowers her voice at once; "Hey Echo" stops her when it's confirmed.
  static func onset(_ reason: ListenMachine.Reason, overEcho: Bool) -> [String: Any] {
    ["event": "onset", "reason": reason.rawValue, "echo": overEcho, "bargeIn": overEcho && reason != .wake, "manual": reason == .ptt]
  }

  static func wake() -> [String: Any] { ["event": "wake"] }
  static func partial(_ text: String) -> [String: Any] { ["event": "partial", "text": text] }
  static func warn(_ what: String) -> [String: Any] { ["event": "warn", "what": what] }
  static func level(_ v: Double) -> [String: Any] { ["event": "level", "level": v] }
  /// `message` says what went wrong with the mic, never anything that was said.
  static func error(_ message: String) -> [String: Any] { ["event": "error", "message": message] }

  static func dropped(_ why: ListenMachine.Drop, _ s: ListenMachine.Sentence) -> [String: Any] {
    ["event": "dropped", "reason": why.rawValue, "arm": s.reason.rawValue, "seconds": (s.lengthMs / 10).rounded() / 100, "bargeIn": s.overEcho]
  }

  /// Apple's text for a sentence, as it goes with the clip.
  static func final(text: String, ms: Double, locale: String, words: [(word: String, p: Double)]) -> [String: Any] {
    ["text": text, "ms": (ms * 10).rounded() / 10, "locale": locale, "words": words.map { ["word": $0.word, "p": ($0.p * 100).rounded() / 100] }]
  }

  /// A finished sentence. `final`: Apple's text for it, when it came in time. `timedOut`: it
  /// didn't, so there is no `final` and the server transcribes the clip itself.
  static func utterance(_ s: ListenMachine.Sentence, label: String, wav: String, live: String, seconds: Double, peak: Double, endAt: Double, aec: Bool, final: [String: Any]?, timedOut: Bool) -> [String: Any] {
    var e: [String: Any] = [
      "event": "utterance", "reason": s.reason.rawValue, "label": label, "wav": wav, "live": live, "seconds": seconds, "peak": peak,
      // What every sentence carries: when it began and ended, how loud it was, how much was voice.
      "onsetAt": Int(endAt - s.lengthMs), "endAt": Int(endAt), "level": (Double(s.level) * 10000).rounded() / 10000, "voicedMs": Int(s.voicedMs),
      "aec": aec, "bargeIn": s.overEcho,
    ]
    if let final { e["final"] = final }
    if timedOut { e["timedOut"] = true }
    return e
  }
}

/// Turning the output volume down while you talk, and back afterwards.
struct DuckPlan {
  /// Ducked volume, as a share of what it was.
  var factor: Float = 0.25
  private(set) var saved: Float?
  private(set) var ducked: Float?

  var active: Bool { saved != nil }

  /// The volume to set now, or nil to leave it (already ducked, or it's quiet already).
  mutating func duck(current: Float) -> Float? {
    guard saved == nil else { return nil }
    let target = (current * factor * 100).rounded() / 100
    guard current > 0.05, target < current else { return nil }
    saved = current
    ducked = target
    return target
  }

  /// The volume to go back to, or nil: nothing was ducked, or you changed the volume yourself
  /// while it was down (then yours stays).
  mutating func restore(current: Float) -> Float? {
    defer { saved = nil; ducked = nil }
    guard let saved, let ducked else { return nil }
    return abs(current - ducked) <= 0.02 ? saved : nil
  }
}

/// What your own input does while Echo drives.
struct TakeBackPolicy {
  enum Mode: String { case pause, end }
  enum Input: Equatable {
    case move(dx: Double, dy: Double)
    case click
    case key(code: Int64)
    case scroll
  }
  enum Decision: Equatable { case ignore, pauseAction, endSession }

  var mode: Mode = .pause
  /// Mouse travel (points, within `moveWindow`) that counts as grabbing the mouse mid-action.
  var movePx: Double = 120
  var moveWindow: TimeInterval = 0.6

  private var travel: Double = 0
  private var travelStart: TimeInterval = -1

  static let escape: Int64 = 53

  /// - actionInFlight: Echo is in the middle of a step (finding, pointing, clicking, typing).
  /// - sinceEchoPosted: seconds since Echo's own last synthetic event (its jitter is ignored).
  /// - inEcho: the input went to Echo's own windows (a card's Allow button, the chat box, the
  ///   caption pill, the companion): never taking over, in either mode. Escape always ends it.
  /// - afterAllow: you just allowed a step on its card (about 1.5 s): your hand leaving the card,
  ///   a scroll or the trackpad's momentum isn't grabbing the mouse. A click or key still is.
  mutating func decide(_ input: Input, at now: TimeInterval, actionInFlight: Bool, sinceEchoPosted: TimeInterval, inEcho: Bool = false, afterAllow: Bool = false) -> Decision {
    if case .key(let code) = input, code == Self.escape { return .endSession }
    if inEcho { return .ignore }
    if afterAllow, input == .scroll { return .ignore }
    if afterAllow, case .move = input { return .ignore }
    switch input {
    case .move(let dx, let dy):
      let d = abs(dx) + abs(dy)
      if d < 4 || sinceEchoPosted < 0.25 { return .ignore }
      if mode == .end { return .endSession }
      if travelStart < 0 || now - travelStart > moveWindow {
        travelStart = now
        travel = 0
      }
      travel += d
      guard actionInFlight, travel >= movePx else { return .ignore }
      travel = 0
      travelStart = -1
      return .pauseAction
    case .scroll:
      if mode == .end { return .endSession }
      return actionInFlight ? .pauseAction : .ignore
    case .click, .key:
      if mode == .end { return .endSession }
      return .pauseAction
    }
  }
}

/// Did a real click, scroll or key press of yours go to one of Echo's own windows (the main window
/// and its cards, the caption pill, the companion orb) rather than another app? In order: the
/// window the event says it's under (Echo's and taking clicks: yes; another app's: no); else the
/// front-most window at that spot that takes clicks; else the process the event is aimed at; for
/// keys, else whether Echo has the keyboard. Echo's click-through overlays (the edge glow, the
/// pointer) never count, so a click through them into Chrome still is taking over.
enum InputTarget {
  struct Win {
    let pid: Int32
    let number: Int
    let bounds: CGRect
    let alpha: Double
  }

  /// - own: Echo's process ids (the app itself; its web view draws in the app's windows).
  /// - echoWindows: all of Echo's window numbers; clickThrough: those that ignore the mouse now.
  /// - eventWindow: the window number the event carries (0 if none); targetPid: the process it's
  ///   aimed at (0 if unknown).
  /// - point: where a mouse event is (global top-left points); nil for keys.
  /// - windows: on-screen windows front to back, as the window server lists them.
  /// - echoActive: Echo is the active app or has a key window (for keys).
  static func isEcho(own: Set<Int32>, echoWindows: Set<Int>, clickThrough: Set<Int>, eventWindow: Int, targetPid: Int32,
                     point: CGPoint?, windows: [Win], echoActive: Bool = false) -> Bool {
    if eventWindow > 0, !clickThrough.contains(eventWindow) {
      if echoWindows.contains(eventWindow) { return true }
      if let w = windows.first(where: { $0.number == eventWindow }) { return own.contains(w.pid) }
    }
    if let point, let w = windows.first(where: { !clickThrough.contains($0.number) && $0.alpha > 0.01 && $0.bounds.contains(point) }) {
      return own.contains(w.pid)
    }
    if targetPid > 0 { return own.contains(targetPid) }
    return point == nil && echoActive
  }
}

enum Resample {
  /// Channel samples at `rate` to 16 kHz: by averaging from a faster mic (the same as the page's
  /// downsample), by filling in between samples from a slower one (a headset in call mode gives
  /// 8 kHz; taken as 16 kHz it played back at double speed and no words came out of it).
  static func to16k(_ x: [Float], rate: Double) -> [Float] {
    if rate > 0, rate < 16000, !x.isEmpty {
      let n = Int((Double(x.count) * 16000 / rate).rounded())
      var out = [Float](repeating: 0, count: n)
      for i in 0..<n {
        let at = Double(i) * rate / 16000
        let a = min(x.count - 1, Int(at)), b = min(x.count - 1, a + 1)
        out[i] = x[a] + (x[b] - x[a]) * Float(at - Double(a))
      }
      return out
    }
    guard rate > 16000 else { return x }
    let ratio = rate / 16000
    let n = Int(Double(x.count) / ratio)
    var out = [Float](repeating: 0, count: n)
    for i in 0..<n {
      let a = Int(Double(i) * ratio), b = min(x.count, Int(Double(i + 1) * ratio))
      var sum: Float = 0
      for j in a..<max(a + 1, b) where j < x.count { sum += x[j] }
      out[i] = sum / Float(max(1, b - a))
    }
    return out
  }

  /// 16-bit mono WAV.
  static func wav(_ samples: [Float], rate: Int = 16000) -> Data {
    var d = Data()
    func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
    func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
    d.append("RIFF".data(using: .ascii)!)
    u32(UInt32(36 + samples.count * 2))
    d.append("WAVEfmt ".data(using: .ascii)!)
    u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
    d.append("data".data(using: .ascii)!)
    u32(UInt32(samples.count * 2))
    for s in samples { u16(UInt16(bitPattern: Int16(max(-1, min(1, s)) * 32767))) }
    return d
  }
}
