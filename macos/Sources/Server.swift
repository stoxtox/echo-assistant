// Echo's server: health checks, and starting or stopping it through scripts/launcher.sh.
// The launcher is the one place that decides whether to start a server, and it never starts a
// second one: it does nothing if Echo already answers or something else holds the port.
import Foundation

final class EchoServer {
  let port: Int
  let echoDir: URL?

  init(port: Int, echoDir: URL?) {
    self.port = port
    self.echoDir = echoDir
  }

  private lazy var session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 2
    c.timeoutIntervalForResource = 3
    return URLSession(configuration: c)
  }()

  /// Whether Echo answers `/api/health` with ok: true.
  func checkHealth(_ done: @escaping (Bool) -> Void) {
    let url = URL(string: "http://127.0.0.1:\(port)/api/health")!
    session.dataTask(with: url) { data, response, _ in
      var ok = false
      if (response as? HTTPURLResponse)?.statusCode == 200, let data,
         let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        ok = json["ok"] as? Bool ?? false
      }
      DispatchQueue.main.async { done(ok) }
    }.resume()
  }

  /// Waits until Echo is healthy, checking every half second, for up to `seconds`.
  func waitUntilHealthy(seconds: Double, _ done: @escaping (Bool) -> Void) {
    let deadline = Date().addingTimeInterval(seconds)
    func attempt() {
      checkHealth { ok in
        if ok || Date() > deadline { return done(ok) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: attempt)
      }
    }
    attempt()
  }

  /// Runs the launcher, which starts Echo in the background (unless it's already running or
  /// starting) and waits until it's healthy. Calls back with nil on success, or the problem.
  func start(_ done: @escaping (String?) -> Void) {
    run([]) { status, output in
      done(status == 0 ? nil : Self.problem(from: output) ?? "Echo didn't start.")
    }
  }

  /// Stops the copy of Echo the launcher started. A server started some other way (by hand, or
  /// from Terminal) is left alone; the message says so.
  func stop(_ done: @escaping (String) -> Void) {
    run(["--stop"]) { _, output in
      done(output.trimmingCharacters(in: .whitespacesAndNewlines))
    }
  }

  /// Whether the launcher started the server that's running now (it can then be stopped).
  var startedByLauncher: Bool {
    guard let dir = echoDir,
          let s = try? String(contentsOf: dir.appendingPathComponent("logs/echo-launcher.pid"), encoding: .utf8),
          let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
    return kill(pid, 0) == 0
  }

  private func run(_ args: [String], _ done: @escaping (Int32, String) -> Void) {
    guard let dir = echoDir else {
      return done(1, "Echo: Couldn't find Echo's folder. Run install.command again to set up the app.")
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = [dir.appendingPathComponent("scripts/launcher.sh").path] + args + [dir.path]
    p.currentDirectoryURL = dir
    var env = ProcessInfo.processInfo.environment
    env["VOICEOPS_PORT"] = String(port)
    env["ECHO_NO_BROWSER"] = "1"
    p.environment = env
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    p.standardInput = FileHandle.nullDevice
    let lock = NSLock()
    var output = Data()
    pipe.fileHandleForReading.readabilityHandler = { h in
      let chunk = h.availableData
      lock.lock(); output.append(chunk); lock.unlock()
    }
    p.terminationHandler = { proc in
      pipe.fileHandleForReading.readabilityHandler = nil
      lock.lock(); let text = String(decoding: output, as: UTF8.self); lock.unlock()
      DispatchQueue.main.async { done(proc.terminationStatus, text) }
    }
    do {
      try p.run()
    } catch {
      done(1, "Echo: Couldn't run Echo's launcher (\(error.localizedDescription)).")
    }
  }

  /// The launcher's "Echo: …" error line, if there is one.
  private static func problem(from output: String) -> String? {
    output.split(separator: "\n").last { $0.hasPrefix("Echo: ") }.map { String($0.dropFirst(6)) }
  }
}
