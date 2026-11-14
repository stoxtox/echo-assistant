// Apple's on-device speech to text (SpeechAnalyzer, macOS 26 and later) for the app's own mic
// (Stage 4, ECHO_FINISH_PLAN.md 0032). Each sentence is transcribed while you say it, so its text
// is ready a moment after you stop: no clip to send to Whisper and wait for. Your contacts,
// projects and app names go in as context, so names come out right. Nothing leaves the Mac.
//
// One AppleSpeech per sentence: started at the speech onset (with the moments before it), fed the
// same 16 kHz audio the clip gets, and finished when the sentence ends. Live words come out as it
// goes (for the caption), the final text and its word confidences at the end. When this can't run
// (an older macOS, the English model not installed yet) the sentence goes to Whisper as before.
import AVFoundation
import Foundation
import Speech

@available(macOS 26, *)
final class AppleSpeech: @unchecked Sendable {
  /// The final text, each word with its confidence (0…1), and how long finishing took after the sentence ended.
  struct Final {
    let text: String
    let words: [(word: String, p: Double)]
    let ms: Double
  }

  // MARK: shared set-up (the model and the names), done once and kept

  private static let lock = NSLock()
  nonisolated(unsafe) private static var locale = Locale(identifier: "en-US")
  nonisolated(unsafe) private static var names: [String] = []
  nonisolated(unsafe) private static var ready = false
  nonisolated(unsafe) private static var preparing = false
  /// The accent and model the current preparation is for ("en-IN/dictation").
  nonisolated(unsafe) private static var preparedFor = ""

  /// Is the model for this language on the Mac, so a sentence can start right away?
  static var isReady: Bool { lock.withLock { ready } }

  /// Get the model for this accent ("en-IN" | "en-US" | "en") onto the Mac if it isn't, in the
  /// background. Sentences go to Whisper until it's there. `done` runs on the main thread when it's settled.
  static func prepare(language: String, done: @escaping @Sendable () -> Void = {}) {
    let want = Locale(identifier: language == "en-IN" ? "en-IN" : "en-US")
    let key = "\(want.identifier)/\(model.rawValue)"
    let start: Bool = lock.withLock {
      if preparing || preparedFor == key { return false }
      preparing = true
      preparedFor = key
      return true
    }
    guard start else { return }
    Task.detached(priority: .utility) {
      var ok = false
      let supported = model == .dictation ? await DictationTranscriber.supportedLocale(equivalentTo: want) : await SpeechTranscriber.supportedLocale(equivalentTo: want)
      if let supported {
        let probe = makeModule(model, locale: supported)
        do {
          if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
            try await request.downloadAndInstall()
          }
          ok = true
          lock.withLock { locale = supported }
        } catch {
          NSLog("[apple speech] model not installed: \(error.localizedDescription)")
        }
      }
      lock.withLock {
        ready = ok
        preparing = false
        // Not installed (no network, say): tried again on a later configure.
        if !ok { preparedFor = "" }
      }
      DispatchQueue.main.async(execute: done)
    }
  }

  /// The names to listen for (contacts, projects, apps, the user's own words), from the server.
  static func setNames(_ list: [String]) {
    let clean = Array(Set(list.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && $0.count <= 60 })).sorted().prefix(400)
    lock.withLock { names = Array(clean) }
  }

  // MARK: one sentence

  /// Which of Apple's models: dictation listens for the names it's given (so "Mira" comes out as
  /// Mira, not Myra); speech is the newer general model, which doesn't take names.
  enum Model: String { case dictation, speech }
  nonisolated(unsafe) static var model = Model.dictation

  private let module: any SpeechModule
  private let analyzer: SpeechAnalyzer
  private let stream: AsyncStream<AnalyzerInput>
  private let input: AsyncStream<AnalyzerInput>.Continuation
  private let onPartial: (String) -> Void
  private let state = NSLock()
  private var format: AVAudioFormat?
  private var converter: AVAudioConverter?
  private var waiting: [[Float]] = []
  private var finals: [AttributedString] = []
  private var volatile = AttributedString("")
  private var started: Task<Void, Error>?
  private var reading: Task<Void, Never>?
  private var cancelled = false
  /// The sentence is being finished: what comes after is the finishing pass, not live words.
  private var finishing = false

  private static let micFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

  /// Start transcribing a sentence, or nil when the model isn't ready (then Whisper does it).
  static func begin(onPartial: @escaping (String) -> Void) -> AppleSpeech? {
    guard isReady else { return nil }
    let (loc, list) = lock.withLock { (locale, names) }
    return AppleSpeech(locale: loc, names: list, model: model, onPartial: onPartial)
  }

  /// The module for a model and locale, set up for one spoken sentence with live words.
  static func makeModule(_ model: Model, locale: Locale) -> any SpeechModule {
    switch model {
    case .dictation:
      return DictationTranscriber(locale: locale, contentHints: [.shortForm], transcriptionOptions: [.punctuation], reportingOptions: [.volatileResults, .frequentFinalization], attributeOptions: [.transcriptionConfidence])
    case .speech:
      return SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [.transcriptionConfidence])
    }
  }

  private init(locale: Locale, names: [String], model: Model, onPartial: @escaping (String) -> Void) {
    module = Self.makeModule(model, locale: locale)
    analyzer = SpeechAnalyzer(modules: [module], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
    (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    self.onPartial = onPartial
    reading = Task { [weak self] in await self?.read() }
    started = Task { [weak self] in
      guard let self else { return }
      let best = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [self.module])
      try await self.analyzer.prepareToAnalyze(in: best)
      if !names.isEmpty {
        let context = AnalysisContext()
        context.contextualStrings[.general] = names
        try await self.analyzer.setContext(context)
      }
      try await self.analyzer.start(inputSequence: self.stream)
      // Audio that came while it was getting ready goes in first, in order; only then do new
      // frames go straight in.
      let fmt = best ?? Self.micFormat
      let conv = fmt == Self.micFormat ? nil : AVAudioConverter(from: Self.micFormat, to: fmt)
      while true {
        let batch: [[Float]] = self.state.withLock {
          let b = self.waiting
          self.waiting = []
          if b.isEmpty {
            self.format = fmt
            self.converter = conv
          }
          return b
        }
        if batch.isEmpty { break }
        for f in batch { self.feed(f, fmt, conv) }
      }
    }
  }

  /// Another 20 ms of the sentence (16 kHz mono), from the mic's queue.
  func append(_ samples: [Float]) {
    let ready: (AVAudioFormat, AVAudioConverter?)? = state.withLock {
      guard let format else {
        waiting.append(samples)
        return nil
      }
      return (format, converter)
    }
    if let ready { feed(samples, ready.0, ready.1) }
  }

  private func feed(_ samples: [Float], _ fmt: AVAudioFormat, _ conv: AVAudioConverter?) {
    guard let buf = AVAudioPCMBuffer(pcmFormat: Self.micFormat, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
    buf.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { buf.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
    if let conv {
      let ratio = fmt.sampleRate / Self.micFormat.sampleRate
      guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(Double(samples.count) * ratio) + 32) else { return }
      var given = false
      var error: NSError?
      conv.convert(to: out, error: &error) { _, status in
        if given {
          status.pointee = .noDataNow
          return nil
        }
        given = true
        status.pointee = .haveData
        return buf
      }
      if error == nil, out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
    } else {
      input.yield(AnalyzerInput(buffer: buf))
    }
  }

  private func read() async {
    do {
      if let m = module as? DictationTranscriber {
        for try await r in m.results { take(r.text, final: r.isFinal) }
      } else if let m = module as? SpeechTranscriber {
        for try await r in m.results { take(r.text, final: r.isFinal) }
      }
    } catch {
      NSLog("[apple speech] \(error.localizedDescription)")
    }
  }

  private func take(_ text: AttributedString, final: Bool) {
    let shown: String = state.withLock {
      if final {
        finals.append(text)
        volatile = AttributedString("")
      } else {
        volatile = text
      }
      return Self.plain(finals + [volatile])
    }
    if !shown.isEmpty, !state.withLock({ cancelled || finishing }) { onPartial(shown) }
  }

  /// The sentence ended: the final text (empty if nothing was understood).
  func finish() async -> Final {
    let t0 = Date()
    state.withLock { finishing = true }
    do {
      // Audio that came while the model was getting ready goes in first: finishing the input
      // before that would drop it (a short sentence right after launch would come back empty).
      try await started?.value
      input.finish()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    } catch {
      NSLog("[apple speech] finishing: \(error.localizedDescription)")
      input.finish()
      await analyzer.cancelAndFinishNow()
    }
    await reading?.value
    let parts: [AttributedString] = state.withLock { finals + [volatile] }
    return Final(text: Self.plain(parts), words: Self.words(parts), ms: Date().timeIntervalSince(t0) * 1000)
  }

  /// Not a sentence after all (too short, set aside, the mic stopped).
  func cancel() {
    state.withLock { cancelled = true }
    input.finish()
    reading?.cancel()
    Task { [analyzer] in await analyzer.cancelAndFinishNow() }
  }

  // MARK: text

  private static func plain(_ parts: [AttributedString]) -> String {
    parts.map { String($0.characters) }.joined().replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Each word with its confidence, from the runs of the results.
  private static func words(_ parts: [AttributedString]) -> [(word: String, p: Double)] {
    var out: [(word: String, p: Double)] = []
    for part in parts {
      for run in part.runs {
        let text = String(part[run.range].characters)
        let p = run.transcriptionConfidence ?? 1
        for w in text.split(whereSeparator: { $0.isWhitespace }) { out.append((String(w), p)) }
      }
    }
    return out
  }
}
