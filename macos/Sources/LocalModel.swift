// Apple's on-device language model (Foundation Models, macOS 26 and later), for quick local
// judgements Echo's server asks for ("local" requests, lib/localmodel.js): is a piece of speech
// meant for Echo? It runs entirely on this Mac. Where the model isn't there (an older macOS, Apple
// Intelligence off, an Intel Mac) it answers "unavailable" and the server's rules decide alone.
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

enum LocalModel {
  /// Answers `prompt` with the on-device model, within `timeout` seconds. Calls back on the main thread.
  static func respond(_ prompt: String, timeout: Double = 0.9, _ done: @escaping ([String: Any]) -> Void) {
    var answered = false
    let finish = { (b: [String: Any]) in
      DispatchQueue.main.async {
        guard !answered else { return }
        answered = true
        done(b)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(["ok": false, "error": "timeout"]) }
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
      guard SystemLanguageModel.default.isAvailable else { return finish(["ok": false, "error": "unavailable"]) }
      Task.detached {
        do {
          let session = LanguageModelSession(instructions: "You answer with one line of JSON and nothing else.")
          let r = try await session.respond(to: String(prompt.prefix(2000)))
          finish(["ok": true, "text": String(r.content.prefix(400)), "via": "apple"])
        } catch {
          finish(["ok": false, "error": "failed", "message": String(error.localizedDescription.prefix(200))])
        }
      }
      return
    }
    #endif
    finish(["ok": false, "error": "unavailable"])
  }
}
