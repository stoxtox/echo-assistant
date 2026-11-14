// The app's own line to Echo's server (Stage 3, "the body talks to the mind directly"). Requests
// to act, look, point or check the screen used to reach the app only through the web page (server
// → page → app), so a page that was reloading, busy or closed left Echo without hands: steps timed
// out and a guide's pill stayed on screen. Now the app keeps a WebSocket to /ws/body and gets those
// requests itself; answers still go back with POST /api/screen/result. While this line is up, the
// server sends requests only here, never through the page as well, so nothing runs twice.
// The same line carries `firefly` messages (docs/firefly-protocol.md): the server letting the
// pointer's light go (a lesson step passed, a card was answered, a search was given up), or
// holding it beside a risky step until its card is answered.
//
// The server writes a random token to <Echo>/data/self/body-token (readable by this user only);
// the app presents it, so no other program on the Mac can pose as Echo's hands.
import Foundation

final class BodyLink: NSObject {
  static let shared = BodyLink()

  /// A request from the server: ["type": "screen", "id", "kind", "params"], as the page used to send.
  var onRequest: (([String: Any]) -> Void)?
  /// A message for the pointer's light: ["type": "firefly", "release": id, "outcome": …] or
  /// ["type": "firefly", "hold": id, "intent": "ask"], as the server sent it.
  var onFirefly: (([String: Any]) -> Void)?
  /// The line dropped (the server stopped or is restarting): what it was showing may be stale.
  /// Only when it had been up: a try that never connected (every retry while the server is down)
  /// has nothing to drop.
  var onDrop: (() -> Void)?

  private var port = 0
  private var echoDir: URL?
  private var task: URLSessionWebSocketTask?
  private var pingTimer: Timer?
  private var retryDelay = 1.0
  /// Is the line up (its first ping came back)? Timeline notes go straight out; otherwise they wait.
  private var up = false
  /// Notes for the timeline made while the line was down: the newest 500, sent when it's back.
  private var notes: [[String: Any]] = []
  private var noteCount = 0
  static let ring = 500
  private lazy var session = URLSession(configuration: .ephemeral)

  /// Start (or restart) the line; it reconnects by itself whenever it drops.
  func start(port: Int, echoDir: URL?) {
    self.port = port
    self.echoDir = echoDir
    stop()
    connect()
  }

  /// Note something on Echo's timeline (lib/timeline.ts): a type and a few numbers or names, never
  /// what was said or what's on the screen, and never an audio level per frame. From any thread.
  func timeline(_ type: String, _ f: [String: Any] = [:]) {
    let cts = Int(Date().timeIntervalSince1970 * 1000)
    DispatchQueue.main.async {
      self.noteCount += 1
      self.notes.append(["type": type, "f": f, "cts": cts, "cseq": self.noteCount])
      if self.notes.count > BodyLink.ring { self.notes.removeFirst(self.notes.count - BodyLink.ring) }
      self.flush()
    }
  }

  /// Send what's waiting, 200 at a time (the most the server takes in one message).
  private func flush() {
    guard up, let t = task else { return }
    while !notes.isEmpty {
      let batch = Array(notes.prefix(200))
      guard let data = try? JSONSerialization.data(withJSONObject: ["type": "tl", "events": batch]), let s = String(data: data, encoding: .utf8) else { notes.removeFirst(batch.count); continue }
      notes.removeFirst(batch.count)
      t.send(.string(s)) { _ in }
    }
  }

  func stop() {
    up = false
    pingTimer?.invalidate()
    pingTimer = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
  }

  private func token() -> String? {
    guard let dir = echoDir else { return nil }
    let file = dir.appendingPathComponent("data/self/body-token")
    guard let s = try? String(contentsOf: file, encoding: .utf8) else { return nil }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.range(of: "^[0-9a-f]{32,128}$", options: .regularExpression) == nil ? nil : t
  }

  private func connect() {
    guard port > 0, let token = token(), let url = URL(string: "ws://127.0.0.1:\(port)/ws/body?token=\(token)") else { return retry() }
    let t = session.webSocketTask(with: url)
    task = t
    t.resume()
    receive(t)
    // Connected (the first ping comes back): the next drop retries quickly again. Waiting for a
    // message to reset it left an idle line on the longest wait after a restart or two.
    t.sendPing { [weak self, weak t] error in
      DispatchQueue.main.async {
        guard error == nil, let self, let t, self.task === t else { return }
        self.retryDelay = 1
        self.up = true
        self.flush()
      }
    }
    // A dead line shows up within half a minute: then it reconnects.
    pingTimer?.invalidate()
    pingTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self, weak t] _ in
      t?.sendPing { error in
        if error != nil { DispatchQueue.main.async { self?.dropped(t) } }
      }
    }
  }

  private func receive(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] result in
      DispatchQueue.main.async {
        guard let self, self.task === t else { return }
        switch result {
        case .failure:
          self.dropped(t)
        case .success(let message):
          self.retryDelay = 1
          if case .string(let s) = message, let data = s.data(using: .utf8),
             let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if msg["type"] as? String == "screen_request", let id = msg["id"] as? String, let kind = msg["kind"] as? String {
              self.onRequest?(["type": "screen", "id": id, "kind": kind, "params": msg["params"] as? [String: Any] ?? [:]])
            } else if msg["type"] as? String == "firefly", msg["release"] is String || msg["hold"] is String {
              self.onFirefly?(msg)
            }
          }
          self.receive(t)
        }
      }
    }
  }

  private func dropped(_ t: URLSessionWebSocketTask?) {
    guard let t, task === t else { return }
    let wasUp = up
    stop()
    if wasUp { onDrop?() }
    retry()
  }

  private func retry() {
    let delay = retryDelay
    timeline("body.retry", ["delay": delay])
    retryDelay = min(retryDelay * 2, 15)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, self.task == nil else { return }
      self.connect()
    }
  }
}
