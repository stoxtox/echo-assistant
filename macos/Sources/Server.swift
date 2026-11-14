// Echo's server: health checks, starting it through scripts/launcher.sh, and stopping it on Quit.
// The launcher is the one place that decides whether to start a server, and it never starts a
// second one: it does nothing if Echo already answers or something else holds the port.
//
// Quit stops the server for this Echo folder however it was started (the launcher, Terminal, or
// a restart that handed over to a new supervisor): it is asked over its own API first (POST
// /api/shutdown with the app's token, which pauses running tasks so they resume next time), and
// only if it's still there a few seconds later is a process signalled, and then only one whose
// command line is this folder's supervisor.js or server.js (ProcessMath.isOurs).
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

  private lazy var postSession: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 15
    return URLSession(configuration: c)
  }()

  /// Sends a JSON body to Echo on this Mac (a look or point answer: POST /api/screen/result).
  func post(_ path: String, _ body: [String: Any], _ done: ((Bool) -> Void)? = nil) {
    guard let data = try? JSONSerialization.data(withJSONObject: body) else { done?(false); return }
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = data
    postSession.dataTask(with: req) { _, response, _ in
      let ok = (response as? HTTPURLResponse)?.statusCode == 200
      DispatchQueue.main.async { done?(ok) }
    }.resume()
  }

  /// Sends a raw body (a WAV for POST /api/wake) and calls back with the answer's body (nil on failure).
  func postData(_ path: String, _ data: Data, type: String, _ done: @escaping (Data?) -> Void) {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
    req.httpMethod = "POST"
    req.setValue(type, forHTTPHeaderField: "Content-Type")
    req.httpBody = data
    req.timeoutInterval = 5
    postSession.dataTask(with: req) { body, response, _ in
      done((response as? HTTPURLResponse)?.statusCode == 200 ? body : nil)
    }.resume()
  }

  /// GETs a path from Echo on this Mac and calls back with the body (nil on failure), off the main thread.
  func get(_ path: String, _ done: @escaping (Data?) -> Void) {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
    req.timeoutInterval = 5
    postSession.dataTask(with: req) { body, response, _ in
      done((response as? HTTPURLResponse)?.statusCode == 200 ? body : nil)
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

  // MARK: stopping (Quit)

  /// The launcher while it runs (`start`), and who is waiting for it to be over.
  private var launcher: Process?
  private var afterLauncher: [() -> Void] = []

  private func launcherOver() {
    launcher = nil
    let waiting = afterLauncher
    afterLauncher = []
    waiting.forEach { $0() }
  }

  /// Quit while the launcher is still starting the server: the launcher is stopped, so it starts
  /// nothing after the app has gone. A supervisor it had already started is found and stopped by
  /// `finishStopping` like any other. Calls back once the launcher is over (at once when it isn't
  /// running), and after 2 s whatever happens: Quit never hangs.
  func stopStarting(_ done: @escaping () -> Void) {
    guard let p = launcher, p.isRunning else { return done() }
    afterLauncher.append(done)
    p.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.launcherOver() }
  }

  /// What it said: stopping (running tasks are being paused to resume next time); working(n) (it
  /// was asked only if idle, and n tasks are running: nothing was stopped); refused (it is there
  /// but wouldn't take the app's request, so nobody knows whether tasks are running); or
  /// unreachable (nothing answered, or an older Echo without the request).
  typealias StopAnswer = ProcessMath.Answer

  /// The token the server wrote for this app (data/self/body-token, the one BodyLink presents).
  private var token: String? {
    guard let dir = echoDir,
          let s = try? String(contentsOf: dir.appendingPathComponent("data/self/body-token"), encoding: .utf8) else { return nil }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.range(of: "^[0-9a-f]{32,128}$", options: .regularExpression) == nil ? nil : t
  }

  /// You picked up Echo's light and dropped it on something (POST /api/computer/pointed,
  /// docs/firefly-protocol.md): what it is called and what kind of thing it is, with the app's
  /// token and no Origin, so no other program can point for you. Sent once; a refusal is final.
  func pointed(_ body: [String: Any]) { send("/api/computer/pointed", body) }

  /// Echo's light left the pearl or landed on what a request asked for (POST /api/computer/event,
  /// `departed` and `arrived`, docs/firefly-protocol.md): the server starts Echo's words for the
  /// step as the light lands. With the app's token, like a drop of the light; sent once.
  func light(_ body: [String: Any]) { send("/api/computer/event", body) }

  private func send(_ path: String, _ body: [String: Any]) {
    guard let token, let data = try? JSONSerialization.data(withJSONObject: body), data.count <= 16 * 1024 else { return }
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(token, forHTTPHeaderField: "X-Echo-Token")
    req.httpBody = data
    postSession.dataTask(with: req).resume()
  }

  /// Asks the server to shut down. `ifIdle`: only when no task is running (else it says how many).
  /// With no token to present it is asked all the same: a server that is there refuses, which
  /// tells Quit it is running (and can't be asked about its tasks), not that nothing is.
  func askToStop(ifIdle: Bool, _ done: @escaping (StopAnswer) -> Void) {
    guard let data = try? JSONSerialization.data(withJSONObject: ["ifIdle": ifIdle]) else { return done(.unreachable) }
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/shutdown")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token { req.setValue(token, forHTTPHeaderField: "X-Echo-Token") }
    req.httpBody = data
    session.dataTask(with: req) { data, response, _ in
      let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      let answer = ProcessMath.answer(status: (response as? HTTPURLResponse)?.statusCode ?? 0,
                                      ok: json?["ok"] as? Bool, working: (json?["working"] as? NSNumber)?.intValue)
      DispatchQueue.main.async { done(answer) }
    }.resume()
  }

  /// Stops Echo's server for this folder: asks it, then makes sure (see `finishStopping`).
  func stop(_ done: @escaping () -> Void) {
    askToStop(ifIdle: false) { [weak self] _ in
      guard let self else { return done() }
      self.finishStopping(done)
    }
  }

  /// After asking: waits up to 3 s for the server to go, then signals whatever of this folder's
  /// Echo is still there (a server that didn't take the request, or a supervisor between
  /// restarts), and gives that 2 s. Calls back when it's over, gone or not: Quit never hangs.
  func finishStopping(_ done: @escaping () -> Void) {
    waitUntilGone(seconds: 3) { [weak self] _ in
      guard let self else { return done() }
      DispatchQueue.global(qos: .userInitiated).async {
        let signalled = self.signalOurs()
        DispatchQueue.main.async {
          if signalled { self.waitUntilGone(seconds: 2) { _ in done() } } else { done() }
        }
      }
    }
  }

  /// Whether anything answers HTTP on the port at all (healthy or not).
  private func answers(_ done: @escaping (Bool) -> Void) {
    let url = URL(string: "http://127.0.0.1:\(port)/api/health")!
    session.dataTask(with: url) { _, response, _ in
      DispatchQueue.main.async { done(response != nil) }
    }.resume()
  }

  /// Waits until nothing answers on the port, checking four times a second, for up to `seconds`.
  /// (GCD, not a Timer: this runs while the app is quitting, when ordinary timers don't fire.)
  private func waitUntilGone(seconds: Double, _ done: @escaping (Bool) -> Void) {
    let deadline = Date().addingTimeInterval(seconds)
    func attempt() {
      answers { up in
        if !up { return done(true) }
        if Date() > deadline { return done(false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: attempt)
      }
    }
    attempt()
  }

  /// A command's output (trimmed), or "" when it couldn't run.
  private static func output(_ path: String, _ args: [String]) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return "" }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// A process's command line and the folder it runs in, or nil when it's gone.
  private static func process(_ pid: Int32) -> (pid: Int32, command: String, cwd: String?)? {
    let command = output("/bin/ps", ["-p", String(pid), "-o", "command="])
    guard !command.isEmpty else { return nil }
    let cwd = output("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
      .split(separator: "\n").first { $0.hasPrefix("n") }.map { String($0.dropFirst()) }
    return (pid, command, cwd)
  }

  private static func pids(_ text: String) -> [Int32] {
    text.split(whereSeparator: { $0.isWhitespace }).compactMap { Int32($0) }
  }

  /// Sends SIGTERM (stop and pause tasks; never a kill) to this folder's Echo: the process
  /// listening on the port, or its supervisor, and any supervisor of this folder left without a
  /// server. Each one's command line and folder are checked first, so an unrelated program on
  /// the port, or another Echo folder's server, is never touched. True when anything was signalled.
  private func signalOurs() -> Bool {
    // The folder's real path, as lsof reports a process's folder (/private/var, not /var).
    guard let echoDir, let real = realpath(echoDir.path, nil) else { return false }
    defer { free(real) }
    let dir = String(cString: real)
    var targets = Set<Int32>()
    for pid in Self.pids(Self.output("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"])) {
      guard let holder = Self.process(pid) else { continue }
      let parent = Int32(Self.output("/bin/ps", ["-p", String(pid), "-o", "ppid="])).flatMap { Self.process($0) }
      if let t = ProcessMath.target(holder: holder, parent: parent, echoDir: dir) { targets.insert(t) }
    }
    for pid in Self.pids(Self.output("/usr/bin/pgrep", ["-f", "supervisor\\.js"])) {
      guard let p = Self.process(pid) else { continue }
      if ProcessMath.script(command: p.command, cwd: p.cwd, echoDir: dir) == "supervisor.js" { targets.insert(pid) }
    }
    targets.remove(getpid())
    for pid in targets { kill(pid, SIGTERM) }
    return !targets.isEmpty
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
    env["ECHO_PORT"] = String(port)
    env["VOICEOPS_PORT"] = String(port) // an Echo folder from before the rename reads this name
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
    p.terminationHandler = { [weak self] proc in
      pipe.fileHandleForReading.readabilityHandler = nil
      lock.lock(); let text = String(decoding: output, as: UTF8.self); lock.unlock()
      DispatchQueue.main.async {
        done(proc.terminationStatus, text)
        self?.launcherOver()
      }
    }
    do {
      try p.run()
      launcher = p
    } catch {
      done(1, "Echo: Couldn't run Echo's launcher (\(error.localizedDescription)).")
    }
  }

  /// The launcher's "Echo: …" error line, if there is one.
  private static func problem(from output: String) -> String? {
    output.split(separator: "\n").last { $0.hasPrefix("Echo: ") }.map { String($0.dropFirst(6)) }
  }
}
