// Tests for VoiceMath.swift (the listening state machine, the native mic's speech gate and barge-in,
// ducking and restoring the volume, taking back control). test/nativemic.test.js compiles this with
// macos/Sources/VoiceMath.swift and runs it; it prints "ok" last when everything passed.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) {
  if !ok {
    failures += 1
    print("FAIL (line \(line)): \(what)")
  }
}

/// Feeds `ms` of frames at `level`; returns the events with the time (ms from the start) they came.
func run(_ g: inout SpeechGate, _ parts: [(level: Float, ms: Double)], echo: Bool = false, ducked: Bool = false) -> [(SpeechGate.Event, Double)] {
  var t = 0.0
  var out: [(SpeechGate.Event, Double)] = []
  for p in parts {
    var left = p.ms
    while left > 0 {
      t += 20
      left -= 20
      if let e = g.feed(level: p.level, frameMs: 20, echo: echo, ducked: ducked) { out.append((e, t)) }
    }
  }
  return out
}

// A quiet room: speech starts an utterance quickly, and a pause ends it.
var g = SpeechGate()
var ev = run(&g, [(0.002, 2000), (0.08, 1500), (0.002, 1600)])
check(ev.count == 2 && ev[0].0 == .onset && ev[1].0 == .end, "onset then end: \(ev)")
check(ev.first.map { $0.1 - 2000 <= 160 } ?? false, "onset within ~150 ms of speech")

// Your own voice is never learned as the background: a long sentence at a steady level isn't cut
// off in the middle (it used to be, once the "background" had risen to meet it).
g = SpeechGate()
ev = run(&g, [(0.002, 1000), (0.08, 200)])
let ambientBefore = g.ambient
ev += run(&g, [(0.08, 20000)])
check(ev.count == 1 && ev[0].0 == .onset, "20 s of talking is one sentence, still going: \(ev)")
check(g.ambient == ambientBefore, "the background estimate is frozen while you talk (\(ambientBefore) -> \(g.ambient))")
ev = run(&g, [(0.002, 1400)])
check(ev.count == 1 && ev[0].0 == .end, "and your pause ends it: \(ev)")

// A video playing steadily in the background: one over-long "sentence" at most, then the threshold
// has followed it, so it never starts anything again...
g = SpeechGate()
ev = run(&g, [(0.002, 500), (0.03, 45000)])
check(ev.count == 2 && ev.last?.0 == .end, "a steady video stops counting as speech: \(ev)")
g = SpeechGate()
_ = run(&g, [(0.03, 32000)])
check(g.threshold(echo: false) > 0.03, "the threshold rose above the video (\(g.threshold(echo: false)))")
ev = run(&g, [(0.03, 3000)])
check(ev.isEmpty, "the video alone doesn't start an utterance")
// ...but you talking over it, louder and close to the mic, does.
ev = run(&g, [(0.25, 400)])
check(ev.first?.0 == .onset, "speech over the video starts one")

// Barge-in: Echo's voice left in the mic after echo cancellation doesn't trigger it...
g = SpeechGate()
_ = run(&g, [(0.002, 1000)])
ev = run(&g, [(0.02, 200), (0.05, 3000), (0.03, 3000)], echo: true)
check(ev.isEmpty, "Echo's own (cancelled) voice never barges in: \(ev)")
// ...you talking over her does, within ~200 ms.
ev = run(&g, [(0.3, 400)], echo: true)
check(ev.first?.0 == .onset && (ev.first?.1 ?? 999) <= 200, "you barge in within 200 ms: \(ev)")
g.echoEnded()
check(g.echoFloor == 0, "her level is forgotten when she stops")

// A short click doesn't start anything.
g = SpeechGate()
ev = run(&g, [(0.002, 1000), (0.4, 60), (0.002, 1000)])
check(ev.isEmpty, "a click is not speech")

// After the volume comes back up, onsets wait while the background is relearned.
g = SpeechGate()
_ = run(&g, [(0.002, 1000)])
g.holdOff(ms: 600)
ev = run(&g, [(0.05, 500)])
check(ev.isEmpty, "no onset during the hold-off")

// ---------- The listening machine ----------
typealias LM = ListenMachine
/// Feeds `ms` of frames at `level`; returns everything the machine said to do.
func hear(_ m: inout LM, _ parts: [(level: Float, ms: Double)], echo: Bool = false) -> [LM.Effect] {
  var out: [LM.Effect] = []
  for p in parts {
    var left = p.ms
    while left > 0 {
      left -= 20
      out += m.frame(level: p.level, frameMs: 20, echo: echo)
    }
  }
  return out
}
func delivered(_ e: [LM.Effect]) -> [LM.Sentence] { e.compactMap { if case .delivered(let s) = $0 { return s } else { return nil } } }
func dropped(_ e: [LM.Effect]) -> [(LM.Drop, LM.Sentence)] { e.compactMap { if case .dropped(let w, let s) = $0 { return (w, s) } else { return nil } } }
func began(_ e: [LM.Effect]) -> [LM.Reason] { e.compactMap { if case .began(let r, _) = $0 { return r } else { return nil } } }
let quiet: Float = 0.002, voice: Float = 0.08

// Idle: nothing listens, whatever is said.
var m = LM()
var fx = hear(&m, [(quiet, 500), (voice, 1500), (quiet, 1500)])
check(fx.isEmpty && m.state == .idle, "idle hears nothing: \(fx)")

// Armed: speech starts a sentence, a pause ends it, and it is delivered with what it carries.
fx = m.arm(.handsfree)
check(fx == [.state] && m.state == .armed(.handsfree), "armed for hands-free")
check(m.arm(.handsfree).isEmpty, "arming for the same thing again changes nothing")
fx = hear(&m, [(quiet, 500), (voice, 1500)])
check(fx == [.began(.handsfree, overEcho: false), .state] && m.state == .hearing(.handsfree), "speech starts a sentence: \(fx)")
fx = hear(&m, [(quiet, 1300)])
var got1 = delivered(fx)
check(got1.count == 1 && m.state == .finishing, "a pause ends it: \(fx)")
check(got1.first?.reason == .handsfree, "it carries how it came in")
check(abs((got1.first?.lengthMs ?? 0) - 2800) <= 60, "its length, from its first sound (\(got1.first?.lengthMs ?? 0))")
check(abs((got1.first?.voicedMs ?? 0) - 1500) <= 60, "how much of it was voice (\(got1.first?.voicedMs ?? 0))")
check((got1.first?.level ?? 0) > 0.03, "and how loud it was (\(got1.first?.level ?? 0))")
check(m.settled() == [.state] && m.state == .armed(.handsfree), "sent: back to waiting")
check(m.settled().isEmpty, "settling twice does nothing")

// A click or a cough is dropped as too short, never sent.
fx = hear(&m, [(voice, 140), (quiet, 1400)])
check(dropped(fx).first?.0 == .tooShort && delivered(fx).isEmpty && m.state == .armed(.handsfree), "a cough is too short: \(fx)")

// A new sentence may begin while the last one's text is still being fetched.
_ = hear(&m, [(voice, 1000), (quiet, 1300)])
check(m.state == .finishing, "finishing")
fx = hear(&m, [(voice, 600)])
check(began(fx) == [.handsfree] && m.state == .hearing(.handsfree), "the next sentence starts while finishing")
check(m.settled().isEmpty && m.state == .hearing(.handsfree), "and the earlier one settling doesn't end it")
_ = hear(&m, [(quiet, 1300)])
_ = m.settled()

// The words so far set the pause: a finished sentence ends sooner, a hanging one waits.
_ = hear(&m, [(voice, 1000)])
m.words("Open my calendar for today.")
fx = hear(&m, [(quiet, 760)])
check(delivered(fx).count == 1, "finished-sounding: delivered after about 0.7 s of quiet")
_ = m.settled()
_ = hear(&m, [(voice, 1000)])
m.words("Send it to Mira and")
fx = hear(&m, [(quiet, 1400)])
check(delivered(fx).isEmpty && m.state == .hearing(.handsfree), "left hanging: the usual pause doesn't end it")
fx = hear(&m, [(quiet, 800)])
check(delivered(fx).count == 1, "a longer one does")
_ = m.settled()
_ = hear(&m, [(voice, 600), (quiet, 1000)])
check(m.state == .hearing(.handsfree), "the next sentence is back to the usual pause")
_ = hear(&m, [(quiet, 400)])
_ = m.settled()

// Push-to-talk starts at once from every state.
m = LM()
fx = m.pttDown()
check(fx == [.began(.ptt, overEcho: false), .state] && m.state == .hearing(.ptt), "from idle")
_ = m.pttCancel()
_ = m.arm(.wake)
check(began(m.pttDown()) == [.ptt] && m.state == .hearing(.ptt), "from armed")
// Never ends on a pause: only on letting go, plus a short tail.
fx = hear(&m, [(voice, 1000), (quiet, 5000), (voice, 1000), (quiet, 3000)])
check(fx.isEmpty && m.state == .hearing(.ptt), "held: no pause ends it: \(fx)")
check(m.pttUp().isEmpty, "let go: the tail is still recorded")
fx = hear(&m, [(quiet, 340)])
check(fx.isEmpty, "not before the tail is over")
fx = hear(&m, [(quiet, 20)])
check(delivered(fx).first?.reason == .ptt && m.state == .finishing, "then it's delivered, as push-to-talk: \(fx)")
check(m.settled() == [.state] && m.state == .armed(.wake), "and what was armed before is armed again")

// It takes over a sentence already under way: one sentence, recorded once, as push-to-talk.
m = LM()
_ = m.arm(.handsfree)
fx = hear(&m, [(voice, 1000)])
check(began(fx) == [.handsfree], "hands-free hears you first")
fx = m.pttDown()
check(fx == [.state] && m.state == .hearing(.ptt), "the key takes the sentence over, without starting a second one: \(fx)")
fx = hear(&m, [(voice, 1000), (quiet, 2000)])
check(fx.isEmpty, "now only letting go ends it")
_ = m.pttUp()
fx = hear(&m, [(quiet, 400)])
got1 = delivered(fx)
check(got1.count == 1 && dropped(fx).isEmpty, "exactly one sentence comes out")
check(got1.first?.reason == .ptt && (got1.first?.lengthMs ?? 0) > 4000, "with the words from before the key in it (\(got1.first?.lengthMs ?? 0) ms)")
// From finishing too.
fx = m.pttDown()
check(began(fx) == [.ptt] && m.state == .hearing(.ptt), "from finishing")
// Pressed again during the tail: the same sentence goes on.
_ = hear(&m, [(voice, 800)])
_ = m.pttUp()
_ = hear(&m, [(quiet, 200)])
check(m.pttDown().isEmpty && m.state == .hearing(.ptt), "pressed again in the tail: no new sentence")
fx = hear(&m, [(voice, 600), (quiet, 1000)])
check(fx.isEmpty, "and it's held again")
_ = m.pttUp()
check(delivered(hear(&m, [(quiet, 360)])).count == 1, "one sentence in the end")

// A tap: too short, and said so (never a silent loss).
m = LM()
_ = m.pttDown()
_ = hear(&m, [(voice, 200)])
fx = m.pttUp()
check(dropped(fx).first?.0 == .tooShort && m.state == .idle, "under 0.4 s: too short: \(fx)")
check(dropped(fx).first?.1.reason == .ptt, "the drop says how it came in")

// Held, but the mic gives nothing: a warning after about 1.5 s (once), and it's dropped as silent.
_ = m.pttDown()
fx = hear(&m, [(0.001, 1480)])
check(fx.isEmpty, "not before 1.5 s")
fx = hear(&m, [(0.001, 2520)])
check(fx == [.cantHear], "\"I can't hear you\", once: \(fx)")
_ = m.pttUp()
fx = hear(&m, [(0.001, 360)])
check(dropped(fx).first?.0 == .silent && delivered(fx).isEmpty, "a silent hold is dropped as silent: \(fx)")
// No warning once you've spoken, however long you then think.
_ = m.pttDown()
fx = hear(&m, [(voice, 600), (quiet, 4000)])
check(fx.isEmpty, "no warning after speech")
// The shortcut turned out to be a shortcut (a key was pressed): dropped as spoiled.
fx = m.pttCancel(.spoiled)
check(dropped(fx).first?.0 == .spoiled && m.state == .idle, "spoiled: \(fx)")
check(m.pttCancel().isEmpty && m.pttUp().isEmpty, "nothing to cancel or end twice")

// A mic that was closed takes a moment to open: the sound is shorter than the hold. The hold is
// timed by the clock, so a real one isn't taken for a tap.
_ = m.pttDown()
_ = hear(&m, [(voice, 200)])
fx = m.pttUp(heldMs: 650)
check(fx.isEmpty && m.state == .hearing(.ptt), "0.2 s of sound from a 0.65 s hold: not too short: \(fx)")
check(delivered(hear(&m, [(voice, 360)])).count == 1, "and it's delivered after the tail")
_ = m.settled()
_ = m.pttDown()
_ = hear(&m, [(voice, 200)])
check(dropped(m.pttUp(heldMs: 250)).first?.0 == .tooShort, "a real tap is still too short")

// A shortcut pressed in the middle of a hands-free sentence spoils only the key: the sentence that
// was already under way goes on, and is delivered at your pause as hands-free.
m = LM()
_ = m.arm(.handsfree)
_ = hear(&m, [(quiet, 300), (voice, 1500)])
check(m.pttDown() == [.state] && m.state == .hearing(.ptt), "the chord takes the sentence over")
_ = hear(&m, [(voice, 300)])
fx = m.pttCancel(.spoiled)
check(fx == [.state] && m.state == .hearing(.handsfree), "spoiled: the sentence is given back, not dropped: \(fx)")
fx = hear(&m, [(voice, 600), (quiet, 1300)])
got1 = delivered(fx)
check(got1.count == 1 && got1.first?.reason == .handsfree && (got1.first?.lengthMs ?? 0) > 3500, "and delivered whole at your pause, as hands-free: \(fx)")
_ = m.settled()
// Taken back on purpose (not a shortcut): that still drops it.
_ = hear(&m, [(voice, 1000)])
_ = m.pttDown()
check(dropped(m.pttCancel()).first?.0 == .cancelled, "cancelled on purpose: dropped")
// A sentence that began with the key has nothing to go back to.
_ = m.pttDown()
_ = hear(&m, [(voice, 600)])
check(dropped(m.pttCancel(.spoiled)).first?.0 == .spoiled && m.state == .armed(.handsfree), "a push-to-talk clip is spoiled as before")
// A wake sentence taken over while its check was out is checked again when it's given back.
m = LM()
_ = m.arm(.wake)
fx = hear(&m, [(quiet, 300), (voice, 2000)])
check(fx.contains(.checkWake), "checked")
_ = m.pttDown()
check(m.wakeResult(ok: true).isEmpty, "the answer that came while the key was down is not used")
check(m.pttCancel(.spoiled) == [.state] && m.state == .hearing(.wake), "given back")
check(hear(&m, [(voice, 20)]) == [.checkWake], "and asked again")
_ = m.wakeResult(ok: false)

// The mic closes (the permission went, or it stopped working): a sentence under way is dropped
// with a reason, nothing is heard while it's closed, and what was armed is armed again when it opens.
m = LM()
_ = m.arm(.handsfree)
_ = hear(&m, [(quiet, 300), (voice, 1000)])
check(m.wantsMic, "a sentence under way needs the mic")
fx = m.stop()
check(dropped(fx).first?.0 == .mode && dropped(fx).first?.1.reason == .handsfree && m.state == .idle, "closing drops the sentence, and says why: \(fx)")
check(m.stop().isEmpty, "closing twice says nothing more")
check(hear(&m, [(voice, 2000), (quiet, 1500)]).isEmpty && m.state == .idle, "nothing is heard through a closed mic")
check(m.wantsMic, "hands-free is still wanted: the mic may open again")
check(m.start() == [.state] && m.state == .armed(.handsfree), "opened: armed for hands-free again")
check(m.start().isEmpty, "opening twice says nothing more")
check(began(hear(&m, [(quiet, 300), (voice, 600)])) == [.handsfree], "and it hears again")
// A held key is dropped too (its clip and speech session must not be held on to).
_ = m.pttDown()
fx = m.stop()
check(dropped(fx).first?.0 == .mode && dropped(fx).first?.1.reason == .ptt, "a held key when the mic closes: dropped, with a reason")
// Arming while closed waits for the mic; disarming means it isn't needed.
check(m.arm(.wake).isEmpty && m.state == .idle && m.wantsMic, "armed while closed: idle until it opens")
check(m.arm(nil).isEmpty && !m.wantsMic, "nothing armed: the mic isn't needed")
check(m.start().isEmpty && m.state == .idle, "open with nothing armed: idle")
// Closed while a sentence's text is being fetched: that sentence still goes; then idle.
_ = m.arm(.handsfree)
_ = hear(&m, [(voice, 1000), (quiet, 1300)])
check(m.state == .finishing && m.stop().isEmpty, "finishing is left to finish")
check(m.settled() == [.state] && m.state == .idle, "then idle, the mic being closed")
m = LM()

// When the mic is open at all: only while something listens, plus 30 s after a push-to-talk.
var open = MicOpen()
check(!open.open(usable: true, wanted: false, now: 1000), "nothing armed, no key: the mic is closed (no orange dot)")
check(open.open(usable: true, wanted: true, now: 1000), "armed: open")
check(!open.open(usable: false, wanted: true, now: 1000), "not allowed: closed whatever is armed")
open.pttEnded(at: 1000, linger: true)
check(open.open(usable: true, wanted: false, now: 30_000), "after a push-to-talk it stays open for the next press")
check(!open.open(usable: true, wanted: false, now: 31_001), "for about 30 s")
open.pttEnded(at: 40_000, linger: false)
check(!open.open(usable: true, wanted: false, now: 40_001), "the mic-off switch: it closes as soon as the key's sentence is over")
open.pttEnded(at: 50_000, linger: true)
open.clear()
check(!open.open(usable: true, wanted: false, now: 50_001), "the switch going on ends the wait at once")

// A mic that stops delivering sound: restarted once after 1.5 s, given up on after another 1.5 s.
var fw = FrameWatch()
var acts: [FrameWatch.Action] = []
for _ in 0..<10 { acts.append(fw.tick(ms: 500, gotFrames: true, listening: true)) }
check(acts.allSatisfy { $0 == .none }, "sound is coming: nothing to do")
acts = (0..<3).map { _ in fw.tick(ms: 500, gotFrames: false, listening: true) }
check(acts == [.none, .none, .restart], "1.5 s without sound: restart it: \(acts)")
acts = (0..<3).map { _ in fw.tick(ms: 500, gotFrames: false, listening: true) }
check(acts == [.none, .none, .giveUp], "still nothing 1.5 s later: give up (the sentence is dropped, and said so): \(acts)")
acts = (0..<3).map { _ in fw.tick(ms: 500, gotFrames: false, listening: true) }
check(acts.last == .restart, "and the next stall starts over")
check(fw.tick(ms: 500, gotFrames: true, listening: true) == .none, "the restart brought the sound back")
acts = (0..<3).map { _ in fw.tick(ms: 500, gotFrames: false, listening: true) }
check(acts.last == .restart, "a later stall gets its own restart, not a give-up")
fw = FrameWatch()
acts = (0..<20).map { _ in fw.tick(ms: 500, gotFrames: false, listening: false) }
check(acts.allSatisfy { $0 == .none }, "a mic that is meant to be closed is never a stall")

// Held for ever: it ends at 120 s.
_ = m.pttDown()
fx = hear(&m, [(voice, 119_000)])
check(fx.isEmpty, "not before 120 s")
fx = hear(&m, [(voice, 1100)])
check(delivered(fx).count == 1, "at most 120 s")
_ = m.settled()

// The mic button (clicked, not held): your pause ends it; nothing said closes it by itself.
fx = m.pttDown(held: false)
fx = hear(&m, [(quiet, 600), (voice, 1200), (quiet, 1300)])
check(delivered(fx).first?.reason == .ptt, "clicked: ends on your pause: \(fx)")
_ = m.settled()
_ = m.pttDown(held: false)
fx = hear(&m, [(0.006, 7900)])
check(dropped(fx).isEmpty && m.state == .hearing(.ptt), "clicked, nothing said yet: still open")
fx = hear(&m, [(0.006, 200)])
check(dropped(fx).first?.0 == .silent && m.state == .idle, "after 8 s it closes, and says it heard nothing: \(fx)")

// Barge-in, in every armed state: Echo's own voice starts nothing, you talking over her starts a
// sentence that is kept, marked as begun over her voice.
for r in [LM.Reason.run, .window, .handsfree, .wake] {
  m = LM()
  _ = m.arm(r)
  _ = hear(&m, [(quiet, 600)])
  fx = hear(&m, [(0.02, 200), (0.05, 2500), (0.03, 2500)], echo: true)
  check(fx.isEmpty, "\(r): her own voice in the mic starts nothing: \(fx)")
  fx = hear(&m, [(0.3, 300)], echo: true)
  check(fx.first == .began(r, overEcho: true), "\(r): you talking over her does: \(fx)")
}
fx = hear(&m, [(0.3, 1500)], echo: true) // (armed for the wake word: it's checked as usual)
check(fx == [.checkWake], "over her voice too, \"Hey Echo\" is checked: \(fx)")
m = LM()
_ = m.arm(.run)
_ = hear(&m, [(quiet, 600), (0.05, 1000)], echo: true)
_ = hear(&m, [(0.3, 1200)], echo: true)
fx = hear(&m, [(quiet, 1300)])
check(delivered(fx).first?.overEcho == true && dropped(fx).isEmpty, "the sentence said over her is delivered, never thrown away: \(fx)")
m = LM()
m.bargeIn = false
_ = m.arm(.run)
fx = hear(&m, [(quiet, 600), (0.3, 1000)], echo: true)
check(fx.isEmpty, "barge-in switched off: nothing starts while she speaks")
fx = m.pttDown()
check(began(fx) == [.ptt], "but the key always does")

// The background estimate is frozen while hearing, in the machine too.
m = LM()
_ = m.arm(.handsfree)
_ = hear(&m, [(quiet, 1000), (voice, 200)])
let before = m.gate.ambient
fx = hear(&m, [(voice, 20_000)])
check(m.gate.ambient == before && m.state == .hearing(.handsfree), "a long sentence leaves the background as it was, and isn't cut off")
_ = m.pttDown()
_ = hear(&m, [(voice, 5000)])
check(m.gate.ambient == before, "held push-to-talk doesn't teach it either")

// "Hey Echo, check the build" in one breath: checked after its first moments, then it runs to your pause.
m = LM()
_ = m.arm(.wake)
fx = hear(&m, [(quiet, 500), (voice, 1700)])
check(fx == [.began(.wake, overEcho: false), .state], "a burst of speech: \(fx)")
fx = hear(&m, [(voice, 600)])
check(fx == [.checkWake], "its first 1.8 s is checked, once: \(fx)")
fx = hear(&m, [(voice, 400)])
check(fx.isEmpty, "the sentence goes on while the check is out")
check(m.wakeResult(ok: true) == [.woke], "it was \"Hey Echo\"")
check(m.wakeResult(ok: true).isEmpty, "a second answer is ignored")
fx = hear(&m, [(voice, 800), (quiet, 1300)])
check(delivered(fx).first?.reason == .wake, "the request is delivered at your pause, as wake: \(fx)")
_ = m.settled()

// Talk that isn't for Echo: dropped, and the rest of that burst goes by unchecked.
fx = hear(&m, [(voice, 2000)])
check(fx.contains(.checkWake), "checked")
fx = m.wakeResult(ok: false)
check(dropped(fx).first?.0 == .notWake && m.state == .armed(.wake), "not the wake word: \(fx)")
fx = hear(&m, [(voice, 4000), (quiet, 1400)])
check(fx.isEmpty, "the rest of that burst isn't checked again: \(fx)")
fx = hear(&m, [(voice, 2000)])
check(fx.contains(.checkWake), "the next burst is")
_ = m.wakeResult(ok: false)
_ = hear(&m, [(quiet, 1400)])

// "Hey Echo", a pause, then the request: one sentence. The request has 6 s to start.
fx = hear(&m, [(voice, 700), (quiet, 1300)])
check(fx.contains(.checkWake) && m.state == .hearing(.wake), "a short burst is checked at its pause: \(fx)")
check(m.wakeResult(ok: true) == [.woke], "\"Hey Echo\" by itself: awake, nothing sent yet")
fx = hear(&m, [(quiet, 4000)])
check(fx.isEmpty && m.state == .hearing(.wake), "it waits for the request")
fx = hear(&m, [(voice, 1200), (quiet, 1300)])
got1 = delivered(fx)
check(got1.count == 1 && got1.first?.reason == .wake && (got1.first?.lengthMs ?? 0) > 7000, "the request is delivered with it, as one sentence: \(fx)")
_ = m.settled()
// The whole request said while the check was still out ("Hey Echo" ... "stop the music", and the
// answer came back late): it was heard, so it's delivered when the wake word is confirmed.
_ = hear(&m, [(voice, 700), (quiet, 1300)])
check(m.state == .hearing(.wake), "the check is out")
fx = hear(&m, [(quiet, 200), (voice, 900), (quiet, 1400)])
check(fx.isEmpty, "nothing is decided until the answer comes: \(fx)")
fx = m.wakeResult(ok: true)
check(fx.first == .woke && delivered(fx).count == 1 && dropped(fx).isEmpty, "the request said during the check is delivered, not waited for and dropped: \(fx)")
_ = m.settled()
// A cough during the check is not a request.
_ = hear(&m, [(voice, 700), (quiet, 1300)])
_ = hear(&m, [(voice, 100), (quiet, 300)])
check(m.wakeResult(ok: true) == [.woke] && m.state == .hearing(.wake), "under a quarter second of sound: still waiting for the request")
fx = hear(&m, [(quiet, 6100)])
check(dropped(fx).first?.0 == .silent, "and none came")
// ...and when none comes in 6 s, it's dropped (and said so), not sent as a bare "Hey Echo".
_ = hear(&m, [(voice, 700), (quiet, 1300)])
_ = m.wakeResult(ok: true)
fx = hear(&m, [(quiet, 5900)])
check(fx.isEmpty, "not before 6 s")
fx = hear(&m, [(quiet, 200)])
check(dropped(fx).first?.0 == .silent && dropped(fx).first?.1.reason == .wake && m.state == .armed(.wake), "no request in 6 s: \(fx)")
// "Hey Echo stop", over before the check came back: delivered as soon as it's confirmed.
_ = hear(&m, [(voice, 900), (quiet, 1300)])
fx = m.wakeResult(ok: true, rest: true)
check(fx.first == .woke && delivered(fx).count == 1, "wake word and request in one short burst: \(fx)")
_ = m.settled()

// The mode changes under a sentence.
m = LM()
_ = m.arm(.window)
_ = hear(&m, [(quiet, 300), (voice, 1000)])
check(m.arm(.wake).isEmpty && m.state == .hearing(.window), "the window closing doesn't cut off a sentence begun inside it")
fx = m.arm(nil)
check(dropped(fx).first?.0 == .mode && m.state == .idle, "listening switched off under it: dropped, and said so: \(fx)")
_ = m.arm(.wake)
_ = hear(&m, [(quiet, 300), (voice, 1000)])
fx = m.arm(.handsfree)
check(fx == [.state] && m.state == .hearing(.handsfree), "everything is listened to now: the sentence under way counts as is")
check(delivered(hear(&m, [(quiet, 1300)])).first?.reason == .handsfree, "and is delivered")
_ = m.pttDown()
check(m.arm(nil).isEmpty && m.state == .hearing(.ptt), "push-to-talk is never dropped by a mode change")
_ = m.pttCancel()
check(m.state == .idle, "then nothing is armed")

// The conversation window runs out by itself (the page may be asleep), but never under a sentence.
m = LM()
check(m.arm(.window, windowMs: 1000, then: .wake) == [.state] && m.windowLeftMs == 1000, "a window with 1 s left")
fx = hear(&m, [(quiet, 980)])
check(fx.isEmpty && m.state == .armed(.window), "open")
fx = hear(&m, [(quiet, 40)])
check(fx == [.state] && m.state == .armed(.wake), "it ran out: back to the wake word: \(fx)")
_ = m.arm(.window, windowMs: 1000)
_ = hear(&m, [(quiet, 500), (voice, 3000)])
check(m.state == .hearing(.window), "you began inside it: it stays open until you finish")
_ = m.arm(.window, windowMs: 1000, then: nil)
_ = m.stop()
check(m.state == .idle, "the mic closed")

// Every sentence ends exactly once.
m = LM()
var all: [LM.Effect] = m.arm(.handsfree)
all += hear(&m, [(quiet, 500), (voice, 1000), (quiet, 1400)]); all += m.settled()
all += hear(&m, [(voice, 140), (quiet, 1400)])
all += m.pttDown(); all += hear(&m, [(voice, 100)]); all += m.pttUp()
all += m.pttDown(); all += hear(&m, [(voice, 900)]); all += m.pttUp(); all += hear(&m, [(quiet, 400)]); all += m.settled()
all += hear(&m, [(voice, 900)]); all += m.arm(nil)
all += m.arm(.wake); all += hear(&m, [(quiet, 300), (voice, 2000)]); all += m.wakeResult(ok: false); all += hear(&m, [(quiet, 1400)])
check(began(all).count == 6 && delivered(all).count + dropped(all).count == 6, "six sentences began, six ended: \(began(all).count) / \(delivered(all).count) + \(dropped(all).count)")
check(Set(dropped(all).map { $0.0.rawValue }) == ["too_short", "mode", "not_wake"], "each drop has its reason: \(dropped(all).map { $0.0.rawValue })")

// Ducking: down while you talk, back afterwards; never over a change you made yourself.
var d = DuckPlan()
check(d.duck(current: 0.8) == 0.2, "ducked to a quarter")
check(d.duck(current: 0.2) == nil, "ducking twice does nothing")
check(d.restore(current: 0.2) == 0.8, "restored to where it was")
check(!d.active, "and it's over")
check(d.restore(current: 0.2) == nil, "nothing to restore twice")
_ = d.duck(current: 0.6)
check(d.restore(current: 0.5) == nil, "you turned it up yourself while ducked: yours stays")
check(d.duck(current: 0.03) == nil, "already (nearly) silent: left alone")

// Taking back control.
var p = TakeBackPolicy()
check(p.decide(.move(dx: 3, dy: 5), at: 0, actionInFlight: true, sinceEchoPosted: 5) == .ignore, "a nudge of the mouse is ignored")
check(p.decide(.move(dx: 40, dy: 0), at: 0.1, actionInFlight: false, sinceEchoPosted: 5) == .ignore, "moving the mouse between steps is ignored")
p = TakeBackPolicy()
var got: TakeBackPolicy.Decision = .ignore
for i in 0..<10 { got = p.decide(.move(dx: 15, dy: 0), at: Double(i) * 0.03, actionInFlight: true, sinceEchoPosted: 5); if got != .ignore { break } }
check(got == .pauseAction, "grabbing the mouse mid-step stops the step, not the session")
check(p.decide(.move(dx: 300, dy: 0), at: 1, actionInFlight: true, sinceEchoPosted: 0.1) == .ignore, "Echo's own pointer move is ignored")
check(p.decide(.click, at: 2, actionInFlight: false, sinceEchoPosted: 5) == .pauseAction, "a click stops the current action")
check(p.decide(.key(code: 0), at: 2, actionInFlight: true, sinceEchoPosted: 5) == .pauseAction, "a key stops the current action")
check(p.decide(.click, at: 2, actionInFlight: true, sinceEchoPosted: 5, inEcho: true) == .ignore, "a click on Echo's own card isn't taking over")
check(p.decide(.scroll, at: 2, actionInFlight: false, sinceEchoPosted: 5) == .ignore, "scrolling between steps is ignored")
check(p.decide(.key(code: TakeBackPolicy.escape), at: 2, actionInFlight: false, sinceEchoPosted: 5) == .endSession, "Escape ends the session")
check(p.decide(.move(dx: 400, dy: 0), at: 2.5, actionInFlight: true, sinceEchoPosted: 5, inEcho: true) == .ignore, "moving over Echo's card isn't grabbing the mouse")
// Just after Allow on a card (Sept 30, 9:53 PM: a scroll right after the click stopped "Create account").
check(p.decide(.scroll, at: 2.6, actionInFlight: true, sinceEchoPosted: 5, afterAllow: true) == .ignore, "a scroll right after Allow doesn't stop the allowed step")
check(p.decide(.move(dx: 400, dy: 0), at: 2.6, actionInFlight: true, sinceEchoPosted: 5, afterAllow: true) == .ignore, "nor does the hand leaving the card")
check(p.decide(.click, at: 2.6, actionInFlight: true, sinceEchoPosted: 5, afterAllow: true) == .pauseAction, "a click in another app still takes over")
check(p.decide(.scroll, at: 2.6, actionInFlight: true, sinceEchoPosted: 5) == .pauseAction, "and later, scrolling mid-step does too")
p.mode = .end
check(p.decide(.click, at: 3, actionInFlight: true, sinceEchoPosted: 5, inEcho: true) == .ignore, "the old way too: Allow on Echo's card doesn't end the session")
check(p.decide(.click, at: 3, actionInFlight: false, sinceEchoPosted: 5) == .endSession, "the old way: any click ends it")
check(p.decide(.move(dx: 10, dy: 0), at: 3, actionInFlight: false, sinceEchoPosted: 5) == .endSession, "the old way: moving the mouse ends it")

// Whose window your input went to (InputTarget): Echo's own never counts as taking over.
let echo: Int32 = 500, chrome: Int32 = 700
let glow = InputTarget.Win(pid: echo, number: 1, bounds: CGRect(x: 0, y: 0, width: 1512, height: 982), alpha: 1)
let card = InputTarget.Win(pid: echo, number: 2, bounds: CGRect(x: 900, y: 100, width: 500, height: 700), alpha: 1)
let pill = InputTarget.Win(pid: echo, number: 3, bounds: CGRect(x: 600, y: 900, width: 300, height: 44), alpha: 1)
let gmail = InputTarget.Win(pid: chrome, number: 9, bounds: CGRect(x: 0, y: 0, width: 1512, height: 982), alpha: 1)
let stack = [glow, pill, card, gmail] // front to back; the edge glow is click-through
let mine: Set<Int> = [1, 2, 3]
func hit(_ x: CGFloat, _ y: CGFloat, window: Int = 0, pid: Int32 = 0, clickThrough: Set<Int> = [1]) -> Bool {
  InputTarget.isEcho(own: [echo], echoWindows: mine, clickThrough: clickThrough, eventWindow: window, targetPid: pid, point: CGPoint(x: x, y: y), windows: stack)
}
check(hit(1000, 400), "Allow on the card in Echo's window is Echo's, through the edge glow")
check(hit(1000, 400, window: 2), "and the event says so too")
check(hit(700, 920, clickThrough: [1]), "Yes in the caption pill (taking clicks) is Echo's")
check(!hit(200, 400), "a click in Chrome is taking over, even under the click-through glow")
check(!hit(200, 400, window: 9, pid: echo), "the window it's under is Chrome's: that wins over a stale target process")
check(!hit(700, 920, clickThrough: [1, 3]), "the pill while it's click-through: the click lands in Chrome")
check(InputTarget.isEcho(own: [echo], echoWindows: mine, clickThrough: [1], eventWindow: 0, targetPid: echo, point: nil, windows: []), "keys aimed at Echo")
check(!InputTarget.isEcho(own: [echo], echoWindows: mine, clickThrough: [1], eventWindow: 0, targetPid: chrome, point: nil, windows: [], echoActive: true), "keys aimed at Chrome")
check(InputTarget.isEcho(own: [echo], echoWindows: mine, clickThrough: [], eventWindow: 0, targetPid: 0, point: nil, windows: [], echoActive: true), "keys while Echo has the keyboard")
check(!InputTarget.isEcho(own: [echo], echoWindows: mine, clickThrough: [], eventWindow: 0, targetPid: 0, point: nil, windows: []), "keys while another app has it")

// Audio plumbing.
let r = Resample.to16k([Float](repeating: 0.5, count: 4800), rate: 48000)
check(r.count == 1600 && abs(r[10] - 0.5) < 0.001, "48 kHz to 16 kHz")
// A mic slower than 16 kHz (a headset in call mode) is brought up to 16 kHz, not passed on as if it were.
let up = Resample.to16k([0, 1, 0, -1], rate: 8000)
check(up.count == 8, "8 kHz to 16 kHz doubles the samples (\(up.count))")
check(abs(up[0]) < 0.001 && abs(up[1] - 0.5) < 0.001 && abs(up[2] - 1) < 0.001 && abs(up[3] - 0.5) < 0.001, "filling in between them: \(up)")
check(Resample.to16k([Float](repeating: 0.25, count: 441), rate: 44100).count == 160, "44.1 kHz to 16 kHz")
check(Resample.to16k([0.1, 0.2], rate: 16000) == [0.1, 0.2], "16 kHz is left as it is")
let w = Resample.wav([0, 0.5, -0.5])
check(w.count == 44 + 6 && String(data: w.prefix(4), encoding: .ascii) == "RIFF", "a WAV header")

// End of turn: a finished sentence ends sooner, an unfinished one waits longer, no words: as set.
check(TurnEnd.endMs(after: "", base: 1300) == 1300, "no words yet: the usual pause")
// While Echo drives: mid-step (hands busy) a sentence keeps its full pause; idle between requests a finished one ends sooner.
check(TurnEnd.endMs(after: "Open my calendar for today.", base: 1300, working: true) == 1300, "mid-step: the full pause")
check(TurnEnd.endMs(after: "Open my calendar for today.", base: 1300, working: false) <= 750, "idle in a driving session: the short pause")
check(TurnEnd.endMs(after: "Open my calendar for today.", base: 1300) <= 750, "a finished sentence ends after a short pause")
check(TurnEnd.endMs(after: "make the header bigger", base: 1300) <= 750, "no punctuation, but nothing left hanging")
check(TurnEnd.endMs(after: "Send it to Mira and", base: 1300) >= 2000, "ends on 'and': waits")
check(TurnEnd.endMs(after: "change the color to", base: 1300) >= 2000, "ends on 'to': waits")
check(TurnEnd.endMs(after: "I want the, um", base: 1300) >= 2000, "ends on 'um': waits")
check(TurnEnd.endMs(after: "so first,", base: 1300) >= 2000, "ends on a comma: waits")
check(TurnEnd.endMs(after: "yes", base: 1300) == 1500, "one word: the usual pause and a little (a command, or the start of a thought)")
check(TurnEnd.endMs(after: "and then the", base: 2500) == 3000, "waits longer, up to 3 s")
check(TurnEnd.endMs(after: "and then the", base: 4000) == 4000, "a long pause set: never shorter than that")
check(TurnEnd.endMs(after: "make the header bigger", base: 500) == 500, "a short pause set: a finished sentence is never longer than that")
// Oct 3: his sentences were ended 0.7 s into a pause to think. Each of these now waits the long pause.
for cut in ["I just", "I just think", "I think", "I just need", "I just.", "I just think.", "I think.", "I just need.", "I’m just", "So", "Well.", "um", "So I think that"] {
  check(TurnEnd.endMs(after: cut, base: 1300) == 2100, "'\(cut)': the start of a thought waits the long pause (\(TurnEnd.endMs(after: cut, base: 1300)))")
}
check(TurnEnd.endMs(after: "I think that it works", base: 1300) <= 750, "five words from 'I', finished: the short pause")
// The everyday thought-starters leave a sentence hanging wherever they come last.
for last in ["just", "think", "need", "want", "mean", "guess", "feel", "know", "kind", "sort", "trying", "going", "gonna", "wanna", "like", "maybe", "actually", "basically", "okay so", "well"] {
  check(TurnEnd.unfinished("the thing about it is \(last)"), "ends on '\(last)': hanging")
  check(TurnEnd.endMs(after: "the thing about it is \(last)", base: 1300) == 2100, "ends on '\(last)': waits")
}
// One to three words never get the short pause, full stop or not.
for few in ["stop", "Stop.", "open calendar", "Open my calendar.", "make it bigger"] {
  check(TurnEnd.endMs(after: few, base: 1300) == 1500, "'\(few)': one to three words wait the usual pause and a little")
}
check(TurnEnd.endMs(after: "stop", base: 4000) == 4000 && TurnEnd.endMs(after: "stop", base: 2900) == 3000, "the little more is capped as the long pause is")
// Four words or more: short only with a full stop from the recogniser, or a last word that isn't hanging.
check(TurnEnd.endMs(after: "Open my calendar now.", base: 1300) <= 750, "four words and a full stop: short")
check(TurnEnd.endMs(after: "open my calendar now", base: 1300) <= 750, "four words, nothing hanging: short")
check(TurnEnd.endMs(after: "open the calendar and", base: 1300) == 2100, "four words, hanging: long")
// While Echo teaches or works (the `run` arm) the short pause is never used.
check(TurnEnd.endMs(after: "make the header bigger", base: 1300, working: true) == 1300, "run arm: a finished sentence waits the usual pause")
check(TurnEnd.endMs(after: "I just think", base: 1300, working: true) == 2100, "run arm: a thought still waits the long one")
do {
  var m = LM()
  _ = m.arm(.run)
  _ = hear(&m, [(quiet, 500), (voice, 1000)])
  m.words("make the header bigger")
  var fx = hear(&m, [(quiet, 1200)])
  check(delivered(fx).isEmpty, "run arm through the machine: a finished sentence isn't ended by a short pause")
  fx = hear(&m, [(quiet, 160)])
  check(delivered(fx).count == 1, "the usual pause ends it")
  // His fragment, as it happened: 0.6 s of voice, then a pause to think of 1.6 s, then the rest.
  m = LM()
  _ = m.arm(.handsfree)
  _ = hear(&m, [(quiet, 500), (voice, 600)])
  m.words("I just think.")
  fx = hear(&m, [(quiet, 1600), (voice, 1200)])
  check(delivered(fx).isEmpty && m.state == .hearing(.handsfree), "'I just think', a 1.6 s pause, and more: one sentence still under way")
  m.words("I just think the header should be bigger")
  fx = hear(&m, [(quiet, 760)])
  check(delivered(fx).count == 1, "and, whole, it ends after the short pause")
}
check(!TurnEnd.unfinished("What time is it?"), "a question is finished")
check(TurnEnd.unfinished("Can you open the"), "ends on 'the'")

// ---------- The events the app sends the page ----------
// One table says which events there are and the fields each carries (test/fixtures/
// nativemic-events.json). The app builds them only with MicEvent, checked here; the page's side is
// checked against the same file by test/nativemic.test.js.
let tablePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1]
  : URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../test/fixtures/nativemic-events.json").standardized.path
if let data = FileManager.default.contents(atPath: tablePath), let table = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
   let events = table["events"] as? [String: [String: [String]]] {
  let sample = LM.Sentence(reason: .handsfree, lengthMs: 2000, voicedMs: 1500, level: 0.05, overEcho: true)
  let final = MicEvent.final(text: "open the calendar", ms: 81.26, locale: "en-US", words: [(word: "open", p: 0.912)])
  func utter(_ final: [String: Any]?, _ timedOut: Bool) -> [String: Any] {
    MicEvent.utterance(sample, label: "follow", wav: "UklGRg==", live: "open the", seconds: 2, peak: 0.3, endAt: 1_000_000, aec: true, final: final, timedOut: timedOut)
  }
  // Every event the app can send, in each shape it comes in.
  let built: [[String: Any]] = [
    MicEvent.state(.armed(.window), since: 1, windowLeftMs: 8000, running: true, permission: "allowed", voiceProcessing: true, appleReady: true),
    MicEvent.state(.idle, since: 1, windowLeftMs: 0, running: false, permission: "denied", voiceProcessing: false, appleReady: false),
    MicEvent.onset(.ptt, overEcho: false), MicEvent.onset(.run, overEcho: true), MicEvent.wake(), MicEvent.partial("open the"),
    MicEvent.level(0.4), MicEvent.warn("cant_hear"), MicEvent.error("no sound"), MicEvent.dropped(.mode, sample),
    utter(final, false), utter(nil, true), utter(nil, false),
  ]
  var seen = Set<String>()
  for e in built {
    let name = e["event"] as? String ?? ""
    seen.insert(name)
    guard let spec = events[name], let fields = spec["fields"], let optional = spec["optional"] else {
      check(false, "the app sends \"\(name)\", which the table doesn't list")
      continue
    }
    let keys = Set(e.keys).subtracting(["event"])
    check(Set(fields).isSubset(of: keys), "\(name) is missing \(Set(fields).subtracting(keys).sorted())")
    check(keys.isSubset(of: Set(fields + optional)), "\(name) carries \(keys.subtracting(fields + optional).sorted()), which the table doesn't list")
    check(JSONSerialization.isValidJSONObject(e), "\(name) can go to the page as JSON")
  }
  check(seen == Set(events.keys), "every event in the table is one the app sends: \(Set(events.keys).symmetricDifference(seen).sorted())")
  check(Set(final.keys) == Set(table["final"] as? [String] ?? []), "Apple's text carries the fields the table says: \(final.keys.sorted())")
  check(LM.Reason.allCases.map(\.rawValue) == table["reasons"] as? [String] ?? [], "the ways a sentence comes in")
  check(LM.Drop.allCases.map(\.rawValue) == table["drops"] as? [String] ?? [], "the reasons a sentence is dropped")
  let states: [LM.State] = [.idle, .armed(.wake), .hearing(.ptt), .finishing]
  check(states.map(\.name) == table["states"] as? [String] ?? [], "the states")
  // Apple too slow: no `final` at all (an empty one would read as "nothing was said"), and it's marked.
  let late = utter(nil, true)
  check(late["final"] == nil && late["timedOut"] as? Bool == true, "timed out: no text, and said so")
  let onTime = utter(final, false)
  check(onTime["timedOut"] == nil && (onTime["final"] as? [String: Any])?["text"] as? String == "open the calendar", "in time: the text, and no mark")
  check(MicEvent.onset(.wake, overEcho: true)["bargeIn"] as? Bool == false, "talk that may be \"Hey Echo\" never lowers her voice")
} else {
  check(false, "the table of mic events couldn't be read at \(tablePath)")
}

print(failures == 0 ? "ok" : "\(failures) failed")
exit(failures == 0 ? 0 : 1)
