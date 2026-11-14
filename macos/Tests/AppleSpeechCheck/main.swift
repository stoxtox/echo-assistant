// Feeds a 16 kHz mono WAV through AppleSpeech (macos/Sources/AppleSpeech.swift) the way the app's
// mic does, 20 ms at a time, and prints what it heard as JSON. test/applespeech.test.js runs it on
// a sentence made with `say`. Exit 2: this Mac can't run Apple's model (older macOS, no model).
import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: check <file.wav> [en-US|en-IN] [names,comma,separated] [dictation|speech]"); exit(64) }
guard #available(macOS 26, *) else { print("{\"skip\":\"macOS 26 or later needed\"}"); exit(2) }

let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[1]))
let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
try file.read(into: src)
var samples: [Float]
if file.processingFormat.sampleRate == 16000, file.processingFormat.channelCount == 1, let ch = src.floatChannelData {
  samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(src.frameLength)))
} else {
  let conv = AVAudioConverter(from: file.processingFormat, to: fmt)!
  let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(Double(src.frameLength) * 16000 / file.processingFormat.sampleRate) + 64)!
  var given = false
  conv.convert(to: out, error: nil) { _, status in
    if given { status.pointee = .endOfStream; return nil }
    given = true; status.pointee = .haveData; return src
  }
  samples = Array(UnsafeBufferPointer(start: out.floatChannelData![0], count: Int(out.frameLength)))
}

if args.count >= 4 { AppleSpeech.setNames(args[3].split(separator: ",").map(String.init)) }
if args.count >= 5, let m = AppleSpeech.Model(rawValue: args[4]) { AppleSpeech.model = m }
let ready = DispatchSemaphore(value: 0)
AppleSpeech.prepare(language: args.count >= 3 ? args[2] : "en-US") { ready.signal() }
// prepare's done hops to the main queue: keep it running while waiting.
while ready.wait(timeout: .now() + 0.05) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
guard AppleSpeech.isReady else { print("{\"skip\":\"the speech model isn't installed\"}"); exit(2) }

var partials = 0
guard let session = AppleSpeech.begin(onPartial: { _ in partials += 1 }) else { print("{\"skip\":\"not ready\"}"); exit(2) }
var i = 0
while i < samples.count {
  session.append(Array(samples[i..<min(i + 320, samples.count)]))
  i += 320
  Thread.sleep(forTimeInterval: 0.02) // as fast as it's said: live words come while talking (none once it's finishing)
}
let done = DispatchSemaphore(value: 0)
var result: AppleSpeech.Final?
Task {
  result = await session.finish()
  done.signal()
}
while done.wait(timeout: .now() + 0.05) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
let r = result!
let json: [String: Any] = ["text": r.text, "ms": r.ms, "partials": partials, "words": r.words.map { ["word": $0.word, "p": $0.p] }]
print(String(data: try JSONSerialization.data(withJSONObject: json), encoding: .utf8)!)
