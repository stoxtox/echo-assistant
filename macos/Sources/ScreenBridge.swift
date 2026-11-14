// The page ↔ app side of screen awareness, the pointer and push-to-talk.
//
// Echo's server asks the page (lib/screen.js → public/screen.js), the page asks the app over the
// "echoApp" message handler, and the app answers the server directly (POST /api/screen/result),
// so the picture never goes through the page.
import AppKit

extension AppDelegate {
  // MARK: push-to-talk

  func setUpPushToTalk() {
    // The native mic records when it can (it hears you whichever app is in front); otherwise the
    // page does.
    var native = false
    // What was circled goes to the page (it tells Echo what "this" is); what is typed in the box goes as a typed message.
    DrawLight.shared.onDrew = { [weak self] box in
      guard let data = try? JSONSerialization.data(withJSONObject: box), let arg = String(data: data, encoding: .utf8) else { return }
      self?.js("window.echoNative?.drew?.(\(arg))")
    }
    DrawLight.shared.onAsk = { [weak self] text in
      guard let data = try? JSONSerialization.data(withJSONObject: [text]), let arg = String(data: data, encoding: .utf8) else { return }
      self?.js("window.echoNative?.drawAsk?.(\(arg)[0])")
    }
    PinnedNotes.shared.restore()
    // One tap of the key while the island offers its reply field: the cursor goes there.
    ptt.onSingleTap = { ReplyField.shared.focusIfOffered() }
    // Two quick taps of the key: Listening and Resting change places.
    ptt.onDoubleTap = { [weak self] in self?.js("window.echoNative?.toggleListenMode('key')") }
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(screenLocked), name: NSNotification.Name("com.apple.screenIsLocked"), object: nil)
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(screenUnlocked), name: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil)
    ptt.onStart = { [weak self] in
      guard let self else { return }
      native = NativeMic.shared.usable
      // With the key held, moving the mouse draws with the light (TalkLayer.swift).
      DrawLight.shared.begin()
      // The page follows the app's listening state by itself (public/nativemic.js).
      if native { return NativeMic.shared.beginPtt() }
      // The page records. If the window was closed, bring it back on screen without taking focus.
      if !self.window.isVisible && !self.window.isMiniaturized { self.window.orderFrontRegardless() }
      self.js("window.echoNative?.pttStart?.()")
    }
    ptt.onStop = { [weak self] in
      DrawLight.shared.end()
      if native { return NativeMic.shared.endPtt() }
      self?.js("window.echoNative?.pttStop?.()")
    }
    ptt.onCancel = { [weak self] why in
      DrawLight.shared.cancel()
      if native { return NativeMic.shared.cancelPtt(why) }
      self?.js("window.echoNative?.pttCancel?.()")
    }
    ptt.apply(Prefs.pttHotkey)
  }

  /// Input Monitoring may have been allowed while Echo was in the background.
  func retryPushToTalk() {
    if !ptt.isActive && Prefs.pttHotkey != "off" { ptt.apply(Prefs.pttHotkey) }
  }

  // MARK: messages from the page

  /// Handles the screen, pointer and permission messages. Returns false for anything else.
  func handleScreenMessage(_ type: String, _ body: [String: Any]) -> Bool {
    switch type {
    case "prefs":
      if let v = body["screenAware"] as? Bool { Prefs.screenAware = v }
      if let v = body["pointer"] as? Bool {
        Prefs.pointer = v
        if !v { pointer.hide(animated: false) }
      }
      if body["orbSize"] != nil || body["companionLook"] != nil {
        if let v = body["orbSize"] as? String { Prefs.orbSize = v }
        if let v = body["companionLook"] as? String { Prefs.companionLook = v }
        pointer.setStyle(size: Prefs.orbSize, look: Prefs.companionLook)
      }
      if let v = body["reduceMotion"] as? String { Prefs.reduceMotion = v }
      // The few words beside the light that say what each step is (off: one showing goes now).
      if let v = body["stepCaptions"] as? Bool {
        Prefs.stepCaptions = v
        if !v { pointer.hush(fade: false) }
      }
      // Lively (true, the default) or calm (false): calm keeps the pearl's moods, breath and
      // blink, and drops its hops, sparkles, rings and wandering eyes. (The old Eyes setting's key.)
      if let v = body["orbEyes"] as? Bool { Prefs.orbEyes = v }
      // How it shows things: "reach" (it hops over and reaches out a finger) or "firefly" (it
      // stays in the island and sends its light).
      if let v = body["pointingWay"] as? String { PointerOverlay.way = v }
      if let v = body["pttHotkey"] as? String, v != Prefs.pttHotkey || !ptt.isActive {
        Prefs.pttHotkey = v
        ptt.apply(v)
        reportPermissions()
      }
    case "screen":
      guard let id = body["id"] as? String else { return true }
      let params = body["params"] as? [String: Any] ?? [:]
      switch body["kind"] as? String {
      case "look": screenLook(id, params)
      case "point": screenPoint(id, params)
      default: break
      }
    case "permissions":
      reportPermissions()
    case "requestPermission":
      let kind = body["kind"] as? String ?? ""
      Permissions.request(kind)
      // macOS answers in its own time; check back a few times.
      for delay in [1.0, 3.0, 8.0] {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
          if kind == "input" { self?.retryPushToTalk() }
          self?.reportPermissions()
        }
      }
    case "companion":
      // Echo's voice state (and level while listening or speaking), for the companion; or a
      // moment ("proud", "celebrate", "surprised", "sorry") it reacts to.
      if let m = body["moment"] as? String { pointer.moment(m) }
      else { pointer.setVoice(body["voice"] as? String ?? "idle", level: (body["level"] as? NSNumber)?.doubleValue) }
    case "firefly":
      // The server's word for the pointer's light, when it came by way of the page (no body line up).
      pointer.firefly(body)
    case "pointAtPage":
      pointAtPage(body)
    case "demoLook":
      demoLook()
    default:
      return false
    }
    return true
  }

  func reportPermissions() {
    var st = Permissions.status()
    st["ptt"] = ptt.isActive
    st["pttHotkey"] = Prefs.pttHotkey
    st["nativeMic"] = true // this app can listen by itself (NativeMic.swift)
    callPage("permissions", st)
  }

  /// Calls window.echoNative[name](json) in the page.
  func callPage(_ name: String, _ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
    js("window.echoNative?.\(name)?.(\(json))")
  }

  private func answer(_ id: String, _ body: [String: Any]) {
    // The pointer's search for this request (if it had one) is over. When the server has
    // already stopped waiting for it, nothing is sent.
    guard pointer.answered(id, found: body["found"] as? Bool ?? (body["ok"] as? Bool ?? true)) else { return }
    var b = body
    b["id"] = id
    if pointer.lit(id) { b["light"] = true } // the light is on its way: `arrived` follows
    server.post("/api/screen/result", b)
  }

  private func fail(_ id: String, _ code: String, _ message: String) {
    answer(id, ["ok": false, "error": code, "message": message])
  }

  /// A found answer with where the thing is in words (`place`, `container`, `kind`: AXFinder.place),
  /// so Echo can say where before the light lands.
  private func placed(_ body: [String: Any], _ el: AXUIElement?, _ frame: CGRect, in app: NSRunningApplication?) -> [String: Any] {
    body.merging(AXFinder.place(of: el, frame: frame, in: app, displays: AXFinder.Displays.current())) { mine, _ in mine }
  }

  /// A friendly word before macOS's own Screen Recording prompt (at most every ten minutes).
  func askScreenPermission() {
    // Never pull Echo's window forward while she drives another app.
    if ComputerDriver.shared.driving { return }
    if let t = screenPromptShownAt, Date().timeIntervalSince(t) < 600 { return }
    screenPromptShownAt = Date()
    showWindow()
    let a = NSAlert()
    a.messageText = "Let Echo see your screen when you ask?"
    a.informativeText = "Echo only looks when you ask about your screen, like “what’s this error?”. The text is read on this Mac, passwords, keys and card numbers are blacked out first, and screenshots are never saved.\n\nmacOS will ask you to allow Echo under Screen Recording. You may need to reopen Echo afterwards."
    a.addButton(withTitle: "Continue")
    a.addButton(withTitle: "Not Now")
    a.beginSheetModal(for: window) { r in
      if r == .alertFirstButtonReturn { Permissions.request("screen") }
    }
  }

  // MARK: looking

  func screenLook(_ id: String, _ params: [String: Any] = [:]) {
    guard Prefs.screenAware else { return fail(id, "off", "Screen awareness is off in Echo's Settings.") }
    guard ScreenLook.supported else { return fail(id, LookError.unsupported.code, LookError.unsupported.message) }
    guard ScreenLook.hasPermission else {
      askScreenPermission()
      return fail(id, LookError.permission.code, LookError.permission.message)
    }
    // The display the front app is on (not whichever one the mouse is over).
    let screen = ScreenLook.screen(for: FrontApp.current().app)
    let marks = (params["marks"] as? Bool ?? false) ? ComputerDriver.shared.lastMarks : []
    let grid = (params["grid"] as? NSNumber)?.intValue ?? 0
    // Just the window you're in, when asked (the windowCrop flag): a smaller, sharper picture.
    var crop: CGRect? = nil
    if params["window"] as? Bool ?? false, let app = FrontApp.current().app, let w = AXFinder.focusedWindowFrame(of: app) {
      crop = PointMath.windowArea(w, display: screen.frame)
    }
    pointer.showLooking(on: screen)
    ScreenLook.capture(screen: screen, marks: marks, grid: grid, crop: crop) { [weak self] result in
      guard let self else { return }
      self.pointer.hideLooking(after: 1.2)
      switch result {
      case .success(let shot):
        self.answer(id, [
          "ok": true, "source": "native", "text": shot.text,
          "image": shot.jpeg.base64EncodedString(), "mime": "image/jpeg",
          "width": Int(shot.size.width), "height": Int(shot.size.height),
          "app": shot.app, "window": shot.window, "redactions": shot.redactions, "cropped": crop != nil,
          "captureMs": ScreenLook.lastTiming.capture, "readMs": ScreenLook.lastTiming.read,
        ])
      case .failure(let e):
        if case .permission = e { self.askScreenPermission() }
        self.fail(id, e.code, e.message)
      }
    }
  }

  // MARK: pointing

  private func number(_ v: Any?) -> CGFloat? {
    (v as? NSNumber).map { CGFloat(truncating: $0) }
  }

  /// Where the pointer went, for the point_at result's debug field (AppKit points, bottom-left origin).
  func debugInfo(_ method: String, _ frame: CGRect?, _ screen: NSScreen?, _ extra: [String: Any] = [:]) -> [String: Any] {
    let rect = { (r: CGRect) -> [String: Any] in
      ["x": Double(r.minX.rounded()), "y": Double(r.minY.rounded()), "width": Double(r.width.rounded()), "height": Double(r.height.rounded())]
    }
    var d: [String: Any] = ["method": method, "coords": "appkit-points"]
    if let frame, PointMath.usable(frame) { d["frame"] = rect(frame) }
    if let screen {
      var sc = rect(screen.frame)
      sc["index"] = NSScreen.screens.firstIndex(of: screen) ?? -1
      sc["scale"] = Double(screen.backingScaleFactor)
      d["screen"] = sc
    }
    for (k, v) in extra { d[k] = v }
    return d
  }

  /// A point request (docs/firefly-protocol.md): `intent` is the light's colour; `hold` with a
  /// `stepId` keeps the light on the target until the lesson lets it go; `route` shows the way
  /// through menus, label by label. While the find runs the light searches (Pointer.swift).
  func screenPoint(_ id: String, _ p: [String: Any]) {
    guard Prefs.pointer else { return fail(id, "off", "The pointer is off in Echo's Settings.") }
    let target = (p["target"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let intent = PearlMath.intent(p["intent"] as? String)
    let stepId = p["hold"] as? Bool == true ? (p["stepId"] as? String).flatMap { $0.isEmpty ? nil : $0 } : nil
    // What the caption beside the light says, when the request brings its own words.
    let caption = p["caption"] as? String ?? ""
    // The sentence Echo says about the thing (an explanation's part): it goes in the bubble beside it.
    let words = p["words"] as? String ?? ""
    // "This and this": a second thing to show with it. It is looked for once the first is shown, and
    // a second, smaller light goes to it (not found: only the first is shown).
    let also = (p["also"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let twin = { [weak self] in
      guard let self, !also.isEmpty, let app = FrontApp.target(named: p["app"] as? String) else { return }
      let displays = AXFinder.Displays.current()
      DispatchQueue.global(qos: .userInitiated).async {
        guard case .hit(let hit) = AXFinder.find(also, in: app, displays: displays) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
          guard let self, !self.pointer.calledOff(id) else { return }
          self.pointer.twin(at: hit.frame)
        }
      }
    }
    // Shows what was found, unless the server has stopped waiting for this request.
    let show = { [weak self] (frame: CGRect, label: String, role: String) -> NSScreen? in
      guard let self, !self.pointer.calledOff(id) else { return nil }
      let screen = self.pointer.point(at: frame, label: label, caption: caption, role: role, intent: intent, stepId: stepId, request: id, words: words)
      if screen != nil { twin() }
      return screen
    }
    // A spot the assistant found by eye in the last look's picture.
    if let x = number(p["x"]), let y = number(p["y"]), let last = ScreenLook.last {
      guard x.isFinite, y.isFinite, x >= 0, y >= 0, x <= last.size.width, y <= last.size.height else {
        return answer(id, ["found": false, "reason": "outside_picture", "message": "That spot is outside the last screenshot.",
                           "debug": debugInfo("screenshot", nil, nil)])
      }
      let r = ScreenLook.toScreen(CGRect(x: x - 14, y: y - 10, width: 28, height: 20), frame: last.frame, size: last.size)
      guard let screen = show(r, target, "") else {
        return answer(id, ["found": false, "reason": "off_screen", "message": "That spot isn't on any screen now.", "debug": debugInfo("screenshot", r, nil)])
      }
      return answer(id, ["found": true, "via": "screenshot", "label": target, "debug": debugInfo("screenshot", r, screen)])
    }
    guard !target.isEmpty else { return fail(id, "no_target", "Say what to point at.") }
    let app = FrontApp.target(named: p["app"] as? String)
    let useScreen = (p["useScreen"] as? Bool ?? true) && Prefs.screenAware
    // A route through menus: the light goes label by label, as far as the menus are open.
    if AXFinder.trusted, let route = PearlMath.route(p["route"]), route.count > 1 {
      let patience = (p["timeoutMs"] as? NSNumber).map { $0.doubleValue / 1000 } ?? 1.5
      pointer.walk(id, route: route, app: app, menuBar: p["menuBar"] as? Bool ?? false, intent: intent, stepId: stepId, patience: patience) { [weak self] found, index, hit, screen in
        guard let self else { return }
        guard found, let hit else {
          return self.answer(id, ["found": false, "reason": "not_found", "message": "Couldn't find \"\(route[0])\" in \(app?.localizedName ?? "the front app").",
                                  "debug": self.debugInfo("none", nil, nil)])
        }
        self.answer(id, self.placed(["found": true, "via": "accessibility", "label": hit.label, "role": hit.role, "app": hit.app, "routeIndex": index,
                                     "debug": self.debugInfo("accessibility", hit.frame, screen)], hit.element, hit.frame, in: app))
      }
      return
    }
    // From here the app looks for it by name: the light searches meanwhile if that takes a while.
    pointer.searching(id, in: app, intent: intent, stepId: stepId, target: target)
    // Reading the screen, when Accessibility can't see it (or only found it scrolled away).
    let byText = { [weak self] (hidden: AXFinder.Hidden?) in
      guard let self else { return }
      let notFound = { (why: String) -> [String: Any] in
        if let hidden {
          return ["found": false, "reason": "scrolled_out_of_view", "label": hidden.label, "role": hidden.role, "app": app?.localizedName ?? "",
                  "message": hidden.hint, "debug": self.debugInfo("accessibility", hidden.frame, nil, ["visible": false])]
        }
        return ["found": false, "reason": "not_found", "message": why, "debug": self.debugInfo("none", nil, nil)]
      }
      guard useScreen, ScreenLook.supported, ScreenLook.hasPermission, !self.pointer.calledOff(id) else {
        if !AXFinder.trusted {
          AXFinder.prompt()
          return self.fail(id, "permission", "To find buttons and menus by name, allow Echo under Accessibility in System Settings, Privacy & Security.")
        }
        return self.answer(id, notFound("Couldn't find \"\(target)\" in \(app?.localizedName ?? "the front app"). It may be scrolled out of view."))
      }
      let screen = ScreenLook.screen(for: app)
      self.pointer.showLooking(on: screen)
      ScreenLook.capture(screen: screen) { result in
        self.pointer.hideLooking(after: 0.6)
        if case .success(let shot) = result, let hit = AXFinder.find(target, in: shot) {
          if let shown = show(hit.frame, target, "") {
            return self.answer(id, self.placed(["found": true, "via": "text", "label": hit.label, "app": shot.app,
                                                "debug": self.debugInfo("ocr", hit.frame, shown, ["image": ["width": Double(shot.captureSize.width), "height": Double(shot.captureSize.height)]])], nil, hit.frame, in: app))
          }
        }
        self.answer(id, notFound("Couldn't find \"\(target)\" on screen. It may be scrolled out of view."))
      }
    }
    // Menu bar items and status icons (Control Center, Wi-Fi, Sound…): guide mode's first steps.
    if AXFinder.trusted, (p["menuBar"] as? Bool ?? false) || MenuBar.isExtraName(target) {
      DispatchQueue.global(qos: .userInitiated).async {
        let hit = MenuBar.find(target)
        DispatchQueue.main.async { [weak self] in
          guard let self else { return }
          guard let hit, let shown = show(hit.frame, target, hit.role) else { return byText(nil) }
          self.answer(id, self.placed(["found": true, "via": "menubar", "label": hit.label, "role": hit.role, "app": hit.app,
                                       "debug": self.debugInfo("menubar", hit.frame, shown)], hit.element, hit.frame, in: app))
        }
      }
      return
    }
    guard AXFinder.trusted, let app else { return byText(nil) }
    let displays = AXFinder.Displays.current()
    DispatchQueue.global(qos: .userInitiated).async {
      let result = AXFinder.find(target, in: app, displays: displays)
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        switch result {
        case .hit(let hit):
          guard let shown = show(hit.frame, target, hit.role) else { return byText(nil) }
          self.answer(id, self.placed(["found": true, "via": "accessibility", "label": hit.label, "role": hit.role, "app": hit.app,
                                       "debug": self.debugInfo("accessibility", hit.frame, shown)], hit.element, hit.frame, in: app))
        case .hidden(let h): byText(h)
        case .none: byText(nil)
        }
      }
    }
  }

  /// Points at something in Echo's own page (the first-run demo): a rect in CSS pixels.
  func pointAtPage(_ body: [String: Any]) {
    guard Prefs.pointer, let r = body["rect"] as? [String: Any],
          let x = number(r["x"]), let y = number(r["y"]), let w = number(r["width"]), let h = number(r["height"]) else { return }
    let z = webView.pageZoom * webView.magnification
    let vy = webView.isFlipped ? y * z : webView.bounds.height - (y + h) * z
    let inWindow = webView.convert(NSRect(x: x * z, y: vy, width: w * z, height: h * z), to: nil)
    pointer.point(at: window.convertToScreen(inWindow), label: body["label"] as? String ?? "")
  }

  /// The first-run demo's look: read the screen and tell the page what was seen. Stays on this Mac.
  func demoLook() {
    guard ScreenLook.supported else { return callPage("demoLook", ["ok": false, "error": "unsupported", "message": LookError.unsupported.message]) }
    guard ScreenLook.hasPermission else {
      Permissions.request("screen")
      return callPage("demoLook", ["ok": false, "error": "permission", "message": LookError.permission.message])
    }
    pointer.showLooking(on: ScreenLook.activeScreen())
    ScreenLook.capture { [weak self] result in
      guard let self else { return }
      self.pointer.hideLooking(after: 1)
      switch result {
      case .success(let shot):
        let words = shot.text.split(whereSeparator: { $0.isWhitespace }).count
        let sample = shot.boxes.map(\.text).first { t in
          t.split(separator: " ").count >= 3 && !t.contains("[redacted]")
        } ?? ""
        self.callPage("demoLook", ["ok": true, "words": words, "lines": shot.boxes.count, "redactions": shot.redactions,
                                   "app": shot.app, "sample": String(sample.prefix(70))])
      case .failure(let e):
        self.callPage("demoLook", ["ok": false, "error": e.code, "message": e.message])
      }
    }
  }
}
