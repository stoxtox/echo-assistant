// The native mic: the app itself listens (AVAudioEngine), not the web view, so Echo hears you
// whichever app is in front. When Echo runs in this app and the mic is allowed, this is the only
// microphone: Space, the mic button, Control + Option, "Hey Echo", the conversation window, a
// driving session and hands-free all record here, under one state machine (ListenMachine in
// VoiceMath.swift). This file carries out what the machine says; it decides nothing itself.
//
// - Apple's voice processing is on (echo cancellation, noise suppression), so Echo's own voice and
//   what the speakers play are taken out of the mic as far as macOS can.
// - The page says what to listen for (public/nativemic.js nativeMicPlan): nothing, "Hey Echo", the
//   conversation window, a driving session or hands-free. The app answers with its state, and the
//   page draws that and nothing else.
// - The mic is open only while something listens (hands-free, "Hey Echo", a conversation window, a
//   run, a sentence under way), plus about 30 s after a push-to-talk so a second press is instant
//   (MicOpen). Never just because the app runs: an open mic lights the orange dot and holds
//   Bluetooth headsets in call mode. While open, the last ~350 ms is always at hand, so the first
//   word of a sentence isn't clipped.
// - A mic that stops delivering sound (AirPods connect, the input changes, the Mac sleeps) is
//   restarted; when that doesn't help, the sentence is dropped with a reason and the page told
//   (FrameWatch). When the page goes away (a reload, a crash, the status page) the mic is disarmed.
// - While waiting for "Hey Echo", the first moments of each burst of speech are checked by this
//   Mac's Whisper (POST /api/wake) and nothing else is kept.
// - While you talk in a driving session the Mac's volume is turned down (DuckPlan) and put back
//   when you stop, unless you changed it yourself.
// - Each sentence is transcribed while you say it by Apple's on-device model (AppleSpeech.swift,
//   macOS 26+); it goes to the page as a 16 kHz WAV with that text, and on through the usual
//   pipeline (POST /api/utterance), where Whisper transcribes it when Apple couldn't. Nothing is
//   saved here, and nothing goes to Apple's servers.
// - Every sentence ends as exactly one "utterance" (delivered) or "dropped" (with why) event, to
//   the page and to the timeline.
// The web view's mic is the fallback when this can't run (no permission, a plain browser tab).
import AppKit
import AVFoundation
import AudioToolbox
import CoreAudio
import Speech

final class NativeMic {
  static let shared = NativeMic()

  /// Events for the page (state, onset, partial, wake, warn, utterance, dropped, error), each built by MicEvent (VoiceMath.swift).
  var onEvent: (([String: Any]) -> Void)?
  /// Your voice level (0…1) while you're talking, about 12 times a second, on the main thread (the companion orb).
  var onLevel: ((Double) -> Void)?
  private var levelFrames = 0
  weak var server: EchoServer?

  // Configuration from the page (set on the main thread, read on `queue`).
  private(set) var enabled = false
  /// The mic may stay open a while after a push-to-talk (not with the mic-off switch on: then it
  /// opens for a held key and closes again).
  private var linger = false
  /// When the mic is open (main thread).
  private var micOpen = MicOpen()
  /// The mic gave no sound even after a restart: it stays closed until something may have changed
  /// (a key press, the audio devices, the Mac waking, Echo coming to the front).
  private var stalled = false
  private var watch = FrameWatch()
  private var seenFrames = 0
  private var ticks = 0
  private var timer: Timer?
  /// The rate the tap was installed at, and when the engine last started (its own start-up also
  /// announces a "configuration change").
  private var tapRate = 0.0
  private var startTried = Date.distantPast
  private var pttDownAt = Date()
  private var lingerCheck: DispatchWorkItem?
  private var lastAsked = ""
  private var label = "" // what the page calls a window sentence: answer | follow
  private var echoOn = false
  private var duckOn = true
  private var liveWords = true
  private var language = "en-US"
  /// The sentence's AppleSpeech, while one is under way.
  private var apple: Any?
  private var namesAt = Date.distantPast

  private let queue = DispatchQueue(label: "echo.nativemic")
  private let engine = AVAudioEngine()
  private var running = false
  private var voiceProcessing = false
  /// Every decision (on `queue`).
  private var machine = ListenMachine()
  private var stateSince = Date()
  private var duck = DuckPlan()
  private var preRoll: [[Float]] = []
  private var clip: [[Float]]? = nil
  private var clipLabel = ""
  /// Counts sentences, so a late answer (the wake check) never lands on the next one.
  private var sentence = 0
  private var frames = 0
  private var pending: [Float] = []
  private var recognizer: SFSpeechRecognizer?
  private var liveRequest: SFSpeechAudioBufferRecognitionRequest?
  private var liveTask: SFSpeechRecognitionTask?

  static let frame = 320 // 20 ms at 16 kHz
  static let frameMs = 20.0
  static let preRollFrames = 18 // ~350 ms before the onset, so first syllables aren't clipped
  static let tickMs = 500.0

  private init() {
    // The audio devices changed under the engine (AirPods connected, another input picked): macOS
    // has stopped it. Several of these come in a burst, and one follows the engine's own start.
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self?.devicesChanged() }
    }
    // After sleep the engine is often stopped, or running and silent.
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.restart("wake") }
    }
  }

  static var permission: String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "allowed"
    case .denied, .restricted: return "denied"
    default: return "ask"
    }
  }

  /// Can the page hand listening over to this (it's on, and the mic is allowed)?
  var usable: Bool { enabled && NativeMic.permission == "allowed" }

  // MARK: configuration

  /// What the page wants now (see public/nativemic.js nativeMicPlan).
  func configure(_ b: [String: Any]) {
    enabled = b["enabled"] as? Bool ?? false
    linger = enabled && (b["linger"] as? Bool ?? false)
    if !linger { micOpen.clear() }
    if enabled && timer == nil {
      timer = Timer.scheduledTimer(withTimeInterval: Self.tickMs / 1000, repeats: true) { [weak self] _ in self?.tick() }
    }
    let arm = enabled ? (b["arm"] as? String).flatMap { ListenMachine.Reason(rawValue: $0) } : nil
    let then = (b["then"] as? String).flatMap { ListenMachine.Reason(rawValue: $0) }
    // When the conversation window runs out (the page's clock and this one are the same Mac's).
    let until = (b["windowUntil"] as? NSNumber)?.doubleValue ?? 0
    let newLabel = b["label"] as? String ?? ""
    // Something else is asked for (hands-free switched off and on again): a mic that had stopped
    // working gets another try.
    let asked = b["arm"] as? String ?? ""
    if asked != lastAsked { stalled = false }
    lastAsked = asked
    let echo = b["echo"] as? Bool ?? false
    let bargeIn = b["bargeIn"] as? Bool ?? true
    let handsBusy = b["handsBusy"] as? Bool ?? true
    duckOn = b["duck"] as? Bool ?? true
    liveWords = b["liveWords"] as? Bool ?? true
    language = b["language"] as? String ?? "en-US"
    if b["prepare"] as? Bool ?? enabled { prepareApple() }
    let endMs = (b["endSilenceMs"] as? NSNumber)?.doubleValue ?? 1300
    if enabled && NativeMic.permission == "ask" { AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { self.sync() } } }
    queue.async {
      let base = max(600, min(4000, endMs))
      if base != self.machine.baseEndMs { self.machine.baseEndMs = base }
      self.machine.bargeIn = bargeIn
      self.machine.handsBusy = handsBusy
      if self.echoOn && !echo { self.machine.gate.echoEnded() }
      self.echoOn = echo
      self.label = newLabel
      let left = until > 0 ? max(1, until - Date().timeIntervalSince1970 * 1000) : 0
      self.run(self.machine.arm(arm, windowMs: left, then: then))
      DispatchQueue.main.async { self.sync() }
    }
  }

  /// The page is gone (it is reloading, its process died, or the status page took its place):
  /// nothing is armed and a sentence under way is dropped, since nobody is there to take it. The
  /// next page says what to listen for when it has loaded.
  func pageGone() {
    guard enabled else { return }
    configure(["enabled": false, "prepare": false])
  }

  /// The mic's permission may have changed in System Settings (Echo came to the front, or the
  /// 5 s check while the mic is open), and a mic that had stopped working may work again.
  func recheck() {
    stalled = false
    sync()
  }

  /// Open or close the mic to match (MicOpen): open while something listens or a sentence is
  /// under way, and a while after a push-to-talk. On the main thread. It reads the machine as it
  /// is this instant (after everything already queued for it, a key press included), so a press
  /// that has just opened the mic is never closed again by an older look at the machine.
  private func sync() {
    let wanted = queue.sync { machine.wantsMic }
    let now = Date().timeIntervalSince1970 * 1000
    let want = !stalled && micOpen.open(usable: usable, wanted: wanted, now: now)
    if want && !running { start() } else if !want { stop() }
    // Open only for the linger: look again when it has run out.
    lingerCheck?.cancel()
    lingerCheck = nil
    if want && !wanted {
      let work = DispatchWorkItem { [weak self] in self?.sync() }
      lingerCheck = work
      DispatchQueue.main.asyncAfter(deadline: .now() + (micOpen.lingerUntil - now) / 1000 + 0.1, execute: work)
    }
    report()
  }

  /// Tell the page where the machine is (it draws this and nothing else).
  func report() {
    var appleReady = false
    if #available(macOS 26, *) { appleReady = AppleSpeech.isReady }
    let running = self.running, aec = voiceProcessing
    queue.async {
      self.send(MicEvent.state(self.machine.state, since: Int(self.stateSince.timeIntervalSince1970 * 1000), windowLeftMs: Int(self.machine.windowLeftMs),
                               running: running, permission: NativeMic.permission, voiceProcessing: aec, appleReady: appleReady))
    }
  }

  // MARK: watching over the open mic (main thread, twice a second)

  private func tick() {
    guard enabled || running else { return }
    ticks += 1
    // The permission was taken away in System Settings while the mic was open.
    if running, ticks % 10 == 0, NativeMic.permission != "allowed" { sync() }
    let expected = usable && !stalled
    queue.async {
      let got = self.frames != self.seenFrames
      self.seenFrames = self.frames
      switch self.watch.tick(ms: Self.tickMs, gotFrames: got, listening: expected && self.machine.wantsMic) {
      case .none:
        break
      case .restart:
        DispatchQueue.main.async { self.restart("stall") }
      case .giveUp:
        DispatchQueue.main.async {
          // Closing drops the sentence under way (reason: mode), so the loss is never silent.
          self.stalled = true
          self.stop()
          self.fail("no_sound", "The microphone isn't delivering any sound")
          self.report()
        }
      }
    }
  }

  /// The engine says its devices changed. Only a real change stops it or changes its format; the
  /// notice that follows its own start does neither, and is let go.
  private func devicesChanged() {
    guard running else {
      // A mic that couldn't open may be able to now. Not on the notice its own attempt caused,
      // which would have it trying again and again.
      if Date().timeIntervalSince(startTried) > 1 { recheck() }
      return
    }
    if !engine.isRunning || engine.inputNode.outputFormat(forBus: 0).sampleRate != tapRate { restart("devices") }
  }

  /// Close the engine and open it again on whatever the input is now. The machine isn't told: a
  /// sentence under way goes on across the gap.
  private func restart(_ why: String) {
    stalled = false
    guard running else { return sync() }
    BodyLink.shared.timeline("mic.restart", ["why": why])
    closeEngine()
    start()
    report()
  }

  /// The mic can't be used: on the timeline, and said on the page (never a silent loss). It goes
  /// by way of the queue, so it lands after the news of a sentence that was dropped for it.
  private func fail(_ reason: String, _ message: String, _ more: [String: Any] = [:]) {
    var f: [String: Any] = ["reason": reason]
    f.merge(more) { a, _ in a }
    BodyLink.shared.timeline("mic.error", f)
    queue.async { self.send(MicEvent.error(message)) }
  }

  // MARK: push-to-talk (Space or the mic button in the window, Control + Option from anywhere)

  /// The key went down (`held`), or the mic button was clicked (it then ends on your pause).
  func beginPtt(held: Bool = true) {
    guard usable else { return }
    // The key is a reason to try a mic that had stopped working once more.
    stalled = false
    let downAt = Date()
    // A closed mic opens for the key (and has said why if it couldn't).
    if !running { start() }
    guard running else { return }
    queue.async {
      // Pressed again during the tail: the same sentence, timed from its first press.
      if self.machine.state != .hearing(.ptt) { self.pttDownAt = downAt }
      self.run(self.machine.pttDown(held: held))
    }
  }

  /// How long the key was down goes by the clock: a mic that was closed takes a moment to open,
  /// and a real hold mustn't be taken for a tap because its sound is that much shorter.
  func endPtt() {
    queue.async { self.run(self.machine.pttUp(heldMs: Date().timeIntervalSince(self.pttDownAt) * 1000)) }
  }

  /// `why`: "spoiled" (a key was pressed during the shortcut: it was a shortcut, not talking) or "cancelled".
  func cancelPtt(_ why: String = "cancelled") {
    queue.async { self.run(self.machine.pttCancel(ListenMachine.Drop(rawValue: why) ?? .cancelled)) }
  }

  // MARK: the engine

  private func start() {
    guard !running else { return }
    startTried = Date()
    let input = engine.inputNode
    // Voice processing needs the output side of the graph too.
    _ = engine.mainMixerNode
    do {
      try input.setVoiceProcessingEnabled(true)
      voiceProcessing = true
      if #available(macOS 14.0, *) {
        // Voice processing ducks every other app by itself; Echo only ducks while you talk.
        input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
      }
    } catch {
      voiceProcessing = false
    }
    let format = input.outputFormat(forBus: 0)
    // No input device at all: said, not silent.
    guard format.sampleRate > 0, format.channelCount > 0 else { return fail("no_input", "No microphone was found") }
    let rate = format.sampleRate
    tapRate = rate
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
      guard let self, let ch = buffer.floatChannelData else { return }
      let samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(buffer.frameLength)))
      self.queue.async { self.take(Resample.to16k(samples, rate: rate)) }
    }
    engine.prepare()
    do {
      try engine.start()
      running = true
      BodyLink.shared.timeline("mic.open", ["aec": voiceProcessing, "rate": Int(rate)])
      // The mic is open: what was armed is armed again.
      queue.async { self.run(self.machine.start()) }
    } catch {
      input.removeTap(onBus: 0)
      running = false
      fail("start", error.localizedDescription, ["code": (error as NSError).code, "domain": (error as NSError).domain])
    }
  }

  private func closeEngine() {
    guard running else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    running = false
    BodyLink.shared.timeline("mic.close")
  }

  /// Close the mic and tell the machine, which drops a sentence under way with a reason (so the
  /// clip and Apple's speech session are let go) and remembers what was armed for when it opens.
  private func stop() {
    closeEngine()
    queue.async {
      self.preRoll = []
      self.pending = []
      self.run(self.machine.stop())
    }
  }

  // MARK: audio (on `queue`)

  private func take(_ samples: [Float]) {
    pending.append(contentsOf: samples)
    while pending.count >= Self.frame {
      let f = Array(pending[0..<Self.frame])
      pending.removeFirst(Self.frame)
      process(f)
    }
  }

  private func process(_ f: [Float]) {
    frames += 1
    let level = SpeechGate.rms(f)
    if clip != nil {
      clip?.append(f)
      appendLive(f)
      appendApple(f)
      if let onLevel {
        levelFrames += 1
        if levelFrames % 4 == 0 {
          let v = min(1, Double(level).squareRoot() * 2.2)
          DispatchQueue.main.async { onLevel(v) }
        }
      }
    }
    // The moments just before a sentence, always at hand (this frame included).
    preRoll.append(f)
    if preRoll.count > Self.preRollFrames { preRoll.removeFirst() }
    run(machine.frame(level: level, frameMs: Self.frameMs, echo: echoOn, ducked: duck.active))
  }

  /// Carry out what the machine said.
  private func run(_ effects: [ListenMachine.Effect]) {
    for effect in effects {
      switch effect {
      case .state:
        stateSince = Date()
        // A sentence that is listened to as it is (not one still waiting on "Hey Echo") is
        // transcribed while it's said.
        if case .hearing(let r) = machine.state, r != .wake, clip != nil { transcribe() }
        DispatchQueue.main.async { self.sync() }
      case .began(let reason, let overEcho):
        sentence += 1
        clip = preRoll
        clipLabel = label
        if duckOn && reason == .run { duckNow() }
        BodyLink.shared.timeline("gate.onset", ["label": reason.rawValue, "manual": reason == .ptt, "echo": overEcho])
        send(MicEvent.onset(reason, overEcho: overEcho))
      case .checkWake:
        checkWake((clip ?? []).flatMap { $0 })
      case .woke:
        transcribe()
        send(MicEvent.wake())
      case .cantHear:
        send(MicEvent.warn("cant_hear"))
      case .delivered(let s):
        pttOver(s)
        deliver(s)
      case .dropped(let why, let s):
        pttOver(s)
        clip = nil
        restoreVolume()
        _ = stopLiveWords()
        cancelApple()
        BodyLink.shared.timeline("mic.cancel", ["reason": why.rawValue, "arm": s.reason.rawValue])
        send(MicEvent.dropped(why, s))
      }
    }
  }

  /// A push-to-talk sentence is over: the mic stays open a while for the next press (MicOpen).
  private func pttOver(_ s: ListenMachine.Sentence) {
    guard s.reason == .ptt else { return }
    DispatchQueue.main.async {
      self.micOpen.pttEnded(at: Date().timeIntervalSince1970 * 1000, linger: self.linger)
      self.sync()
    }
  }

  /// The sentence is over and counts: send it with Apple's text for it, which is ready a moment
  /// after it ended, or without (then Whisper transcribes the clip).
  private func deliver(_ s: ListenMachine.Sentence) {
    restoreVolume()
    let samples = (clip ?? []).flatMap { $0 }
    clip = nil
    let live = stopLiveWords()
    let ended = Date()
    let label = clipLabel
    let sendOnce: ([String: Any]?, Bool) -> Void = { final, timedOut in
      self.utterance(samples, s, label: label, live: live, ended: ended, final: final, timedOut: timedOut)
      self.run(self.machine.settled())
    }
    guard #available(macOS 26, *), let session = apple as? AppleSpeech else { return sendOnce(nil, false) }
    apple = nil
    // Sent once: with Apple's text, or after 2 s without any and marked as timed out. An empty
    // text would read as "Apple heard nothing"; no text at all lets the server transcribe the clip.
    var sent = false
    let once = { (final: [String: Any]?) in
      guard !sent else { return }
      sent = true
      sendOnce(final, final == nil)
    }
    queue.asyncAfter(deadline: .now() + 2) { once(nil) }
    Task {
      let final = await session.finish()
      self.queue.async { once(MicEvent.final(text: final.text, ms: final.ms, locale: self.language, words: final.words)) }
    }
  }

  private func utterance(_ samples: [Float], _ s: ListenMachine.Sentence, label: String, live: String, ended: Date, final: [String: Any]?, timedOut: Bool) {
    var peak: Float = 0
    for x in samples { peak = max(peak, abs(x)) }
    let seconds = (Double(samples.count) / 16000 * 100).rounded() / 100
    let loudest = (Double(peak) * 10000).rounded() / 10000
    BodyLink.shared.timeline("gate.end", ["seconds": seconds, "peak": loudest, "arm": s.reason.rawValue, "voicedMs": Int(s.voicedMs), "appleTimedOut": timedOut])
    send(MicEvent.utterance(s, label: label, wav: Resample.wav(samples).base64EncodedString(), live: live, seconds: seconds, peak: loudest,
                            endAt: ended.timeIntervalSince1970 * 1000, aec: voiceProcessing, final: final, timedOut: timedOut))
  }

  /// Did the clip so far start with "Hey Echo"? (Local Whisper only; only its first moments go.)
  private func checkWake(_ samples: [Float]) {
    let id = sentence
    guard let server else { return run(machine.wakeResult(ok: false)) }
    let head = Array(samples.prefix(Int(ListenMachine.wakeCheckMs / 1000 * 16000) + Self.preRollFrames * Self.frame))
    server.postData("/api/wake", Resample.wav(head), type: "audio/wav") { data in
      let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      let ok = json?["wake"] as? Bool ?? false
      let rest = !((json?["rest"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      self.queue.async {
        guard id == self.sentence else { return }
        self.run(self.machine.wakeResult(ok: ok, rest: rest))
      }
    }
  }

  private func send(_ e: [String: Any]) {
    DispatchQueue.main.async { self.onEvent?(e) }
  }

  // MARK: ducking the Mac's volume while you talk

  private func duckNow() {
    guard let v = SystemVolume.get(), let target = duck.duck(current: v) else { return }
    SystemVolume.set(target)
  }

  private func restoreVolume() {
    guard duck.active else { return }
    if let back = duck.restore(current: SystemVolume.get() ?? -1) {
      SystemVolume.set(back)
      // The background is louder again: relearn it before listening for the next onset.
      machine.gate.holdOff(ms: 600)
    }
  }

  // MARK: turning the sentence into text while it's said

  /// Apple's model when it's on this Mac (its text goes with the clip); otherwise the older
  /// on-device recognizer, for the live words only. Once per sentence, fed the clip so far.
  private func transcribe() {
    guard apple == nil, liveTask == nil else { return }
    if !startApple() { startLiveWords() }
  }

  /// Get the model ready and the names to listen for (refreshed every 20 s: the list follows the
  /// conversation now, and it is one small request to Echo's own server).
  private func prepareApple() {
    guard #available(macOS 26, *) else { return }
    AppleSpeech.prepare(language: language) { [weak self] in self?.report() }
    guard Date().timeIntervalSince(namesAt) > 20, let server else { return }
    namesAt = Date()
    server.get("/api/vocabulary") { data in
      guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
      if #available(macOS 26, *) { AppleSpeech.setNames(json["terms"] as? [String] ?? []) }
    }
  }

  /// Start transcribing this sentence with Apple's model, with what the clip holds already. False when it can't.
  private func startApple() -> Bool {
    guard #available(macOS 26, *) else { return false }
    guard let session = AppleSpeech.begin(onPartial: { [weak self] text in
      guard let self else { return }
      self.queue.async { self.heardSoFar(text) }
    }) else { return false }
    for f in clip ?? [] { session.append(f) }
    apple = session
    return true
  }

  private func appendApple(_ f: [Float]) {
    guard #available(macOS 26, *), let session = apple as? AppleSpeech else { return }
    session.append(f)
  }

  /// Not a sentence after all: its transcription mustn't carry over into the next one.
  private func cancelApple() {
    if #available(macOS 26, *), let session = apple as? AppleSpeech { session.cancel() }
    apple = nil
  }

  // MARK: live words for the caption bar (on-device only)

  private func startLiveWords() {
    guard liveWords, liveTask == nil, SFSpeechRecognizer.authorizationStatus() == .authorized else {
      if liveWords && SFSpeechRecognizer.authorizationStatus() == .notDetermined {
        SFSpeechRecognizer.requestAuthorization { _ in }
      }
      return
    }
    if recognizer == nil { recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) }
    guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { return }
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.requiresOnDeviceRecognition = true
    req.shouldReportPartialResults = true
    liveRequest = req
    for f in clip ?? [] { appendLive(f) }
    liveTask = recognizer.recognitionTask(with: req) { [weak self] result, _ in
      guard let self, let text = result?.bestTranscription.formattedString, !text.isEmpty else { return }
      self.queue.async {
        guard self.liveRequest === req else { return }
        self.heardSoFar(text)
      }
    }
  }

  private var lastLive = ""

  /// Words heard so far in the sentence (live): shown in the caption, and they set how long a pause ends it.
  private func heardSoFar(_ text: String) {
    guard clip != nil else { return }
    lastLive = text
    machine.words(text)
    if liveWords { send(MicEvent.partial(text)) }
  }
  private static let liveFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

  private func appendLive(_ f: [Float]) {
    guard let req = liveRequest, let buf = AVAudioPCMBuffer(pcmFormat: Self.liveFormat, frameCapacity: AVAudioFrameCount(f.count)) else { return }
    buf.frameLength = AVAudioFrameCount(f.count)
    f.withUnsafeBufferPointer { src in buf.floatChannelData![0].update(from: src.baseAddress!, count: f.count) }
    req.append(buf)
  }

  private func stopLiveWords() -> String {
    let text = lastLive
    liveRequest?.endAudio()
    liveTask?.cancel()
    liveRequest = nil
    liveTask = nil
    lastLive = ""
    return text
  }
}

/// The default output device's volume (0…1), for ducking.
enum SystemVolume {
  private static func device() -> AudioDeviceID? {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
    return id
  }

  private static var address = AudioObjectPropertyAddress(mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)

  static func get() -> Float? {
    guard let d = device() else { return nil }
    var v = Float32(0)
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectHasProperty(d, &address), AudioObjectGetPropertyData(d, &address, 0, nil, &size, &v) == noErr else { return nil }
    return v
  }

  static func set(_ value: Float) {
    guard let d = device() else { return }
    var v = Float32(max(0, min(1, value)))
    AudioObjectSetPropertyData(d, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &v)
  }
}

// MARK: page ↔ app

extension AppDelegate {
  func setUpNativeMic() {
    let mic = NativeMic.shared
    mic.server = server
    mic.onEvent = { [weak self] e in self?.callPage("nativeMic", e) }
    // The companion orb and the window's orb (public/app.js onNativeMic 'level') both swell with it.
    mic.onLevel = { [weak self] v in
      self?.pointer.setLevel(v)
      self?.callPage("nativeMic", MicEvent.level(v))
    }
  }

  /// "nativeMic" messages from the page (what to listen for), and "nativePtt" (push-to-talk in the
  /// window: Space held, or the mic button clicked, recorded here like Control + Option). Returns
  /// false for anything else.
  func handleNativeMicMessage(_ type: String, _ body: [String: Any]) -> Bool {
    if type == "nativePtt" {
      switch body["action"] as? String {
      case "begin": NativeMic.shared.beginPtt(held: body["held"] as? Bool ?? true)
      case "end": NativeMic.shared.endPtt()
      case "cancel": NativeMic.shared.cancelPtt()
      default: break
      }
      return true
    }
    guard type == "nativeMic" else { return false }
    NativeMic.shared.configure(body)
    return true
  }
}
