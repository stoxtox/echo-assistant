// Echo for Mac: a small native window around Echo's local web UI.
//
// It starts Echo's server through scripts/launcher.sh when it isn't running (never a second copy),
// shows a loading screen until /api/health answers, then loads http://localhost:<port>. A menu bar
// item and a global shortcut summon it. Built by scripts/build-app.sh (`npm run build-app`).
//
//   Echo.app/Contents/MacOS/Echo [--port N] [--echo-dir PATH] [--snapshot out.png]
import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate,
  WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  let server = EchoServer(port: AppConfig.port, echoDir: AppConfig.echoDir)
  var window: NSWindow!
  var webView: WKWebView!
  var statusItem: NSStatusItem!
  var hotKey: HotKey!
  let pointer = PointerOverlay() // ScreenBridge.swift
  let ptt = PushToTalk()
  var screenPromptShownAt: Date?
  /// The permissions checklist (Permissions.swift), over what macOS says (PushToTalk.swift).
  lazy var permissionsWindow = PermissionsWindow(read: { [weak self] in
    self?.permissionsChanged()
    return Permissions.model()
  }, act: { id, allow in Permissions.act(id, allow: allow) })
  var serverUp = false
  var starting = false
  var pageLoaded = false // Echo's own page (not the loading screen) is showing
  var listening = false
  var handsFree = false
  /// The one listening state, as the page reports it: "listening", "resting" or "off" ("" until it has).
  var listenMode = ""
  var healthTimer: Timer?
  /// The top of the menu bar menu, and the timer that keeps its line true while the menu is open.
  let menuHeader = MenuHeaderView()
  var menuTimer: Timer?
  var snapshotTaken = false

  // MARK: launch

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMainMenu()
    buildWindow()
    buildStatusItem()
    setUpLifecycle()
    hotKey = HotKey { [weak self] in self?.summon() }
    applyHotKey(Prefs.hotKey)
    FrontApp.startTracking()
    setUpNativeMic() // NativeMic.swift
    setUpPushToTalk()
    BodyLink.shared.timeline("perm.state", Permissions.status()) // once, for the timeline: which permissions Echo started with
    Permissions.noteChanges() // where it starts: only changes after this are noted
    showWindow()
    // The checklist comes up by itself the first time, and whenever Echo can't work yet.
    if AppConfig.snapshotPath == nil, PermMath.showAtLaunch(firstRun: !Permissions.shown, Permissions.model()) { showPermissions() }
    connect()
    healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refreshHealth() }
    // The first look after launch used to be the slow one: wake the screen reader once things settle.
    // (And it went cold again after hours idle or a sleep: it is kept awake from here on.)
    ScreenLook.keepWarm()
  }

  func applicationDidBecomeActive(_ note: Notification) {
    retryPushToTalk()
    NativeMic.shared.recheck() // the mic's permission may have changed in System Settings meanwhile
    reportPermissions()
    Permissions.noteChanges()
    permissionsWindow.refresh()
    CaptionBar.shared.refresh()
  }

  // Echo's window went behind other apps: the caption bar may be needed (Caption.swift).
  func applicationDidResignActive(_ note: Notification) {
    CaptionBar.shared.refresh()
  }

  func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
    showWindow()
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

  /// Quit means quit: Echo's server stops too (Server.swift), unless you chose "Keep Working in
  /// the Background After I Quit". With tasks running it asks once what to do with them.
  func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
    guard !Prefs.keepWorkingAfterQuit else { return .terminateNow }
    // The launcher may be half way through starting the server: it is stopped first, so nothing
    // starts after the app has gone, and whatever it already started is stopped like any other.
    server.stopStarting { [weak self] in self?.askServerToStop(app) }
    return .terminateLater
  }

  private func askServerToStop(_ app: NSApplication) {
    server.askToStop(ifIdle: true) { [weak self] answer in
      guard let self else { return app.reply(toApplicationShouldTerminate: true) }
      switch answer {
      case .refused:
        // It is running but wouldn't say whether tasks are: ask, rather than stop them unasked.
        switch self.askAboutRefusal() {
        case .alertFirstButtonReturn: self.server.finishStopping { app.reply(toApplicationShouldTerminate: true) }
        case .alertSecondButtonReturn: app.reply(toApplicationShouldTerminate: true) // the server stays
        default: app.reply(toApplicationShouldTerminate: false)
        }
      case .working(let n):
        switch self.askAboutRunningTasks(n) {
        case .alertFirstButtonReturn: self.server.stop { app.reply(toApplicationShouldTerminate: true) }
        case .alertSecondButtonReturn: app.reply(toApplicationShouldTerminate: true) // the server stays
        default: app.reply(toApplicationShouldTerminate: false)
        }
      case .stopping, .unreachable:
        // Stopping; or not answering, or an older Echo without the shutdown request: either way,
        // make sure what's ours has stopped.
        self.server.finishStopping { app.reply(toApplicationShouldTerminate: true) }
      }
    }
  }

  /// The server is there but refused the app's request to stop: quit and stop it anyway (its
  /// tasks pause), leave it running, or don't quit.
  func askAboutRefusal() -> NSApplication.ModalResponse {
    NSApp.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = ProcessMath.refusedQuestion
    a.informativeText = ProcessMath.refusedDetail
    a.addButton(withTitle: "Quit and Stop It")
    a.addButton(withTitle: "Leave It Running")
    a.addButton(withTitle: "Cancel")
    return a.runModal()
  }

  /// "Echo is still working on N tasks": quit and pause them (they resume next time), leave the
  /// server working in the background this once, or don't quit.
  func askAboutRunningTasks(_ n: Int) -> NSApplication.ModalResponse {
    NSApp.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = ProcessMath.quitQuestion(tasks: n)
    a.informativeText = "Paused tasks pick up where they left off the next time you open Echo."
    a.addButton(withTitle: "Quit and Pause Them")
    a.addButton(withTitle: "Keep Working in the Background")
    a.addButton(withTitle: "Cancel")
    return a.runModal()
  }

  /// Nothing of Echo's stays on screen after the app has gone.
  func applicationWillTerminate(_ note: Notification) {
    ComputerDriver.shared.end()
    CaptionBar.shared.reset()
    pointer.letGo()
    pointer.hide(animated: false)
    EdgeGlow.shared.hideAll()
    StatusChip.shared.hideNow()
  }

  /// The caption pill's buttons, and what resets or re-places Echo's overlays: the server going
  /// away, the screens changing, the Mac waking.
  func setUpLifecycle() {
    wireCaption() // Driver.swift
    // The app's line to the server dropped (it stopped or is restarting): a run can't go on, and
    // whatever the pill showed is stale. The page says what's still true once it's back. A reply
    // you were typing is yours, not the server's: it stays.
    BodyLink.shared.onDrop = {
      // No release can reach a waiting light now: it is let go.
      ComputerDriver.shared.pointer?.letGo()
      ComputerDriver.shared.end()
      CaptionBar.shared.reset(keepDraft: true)
    }
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      FrameClock.shared.rebuild()
      CaptionBar.shared.screensChanged()
      EdgeGlow.shared.screensChanged()
      StatusChip.shared.screensChanged()
      self?.pointer.screensChanged()
    }
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
      FrameClock.shared.rebuild()
      CaptionBar.shared.refresh()
    }
  }

  // MARK: connecting to the server

  /// Loads Echo if it's up; otherwise starts it (via the launcher) behind a loading screen.
  func connect() {
    guard !starting else { return }
    pageLoaded = false
    showStatusPage(title: "Connecting to Echo…", detail: "")
    server.checkHealth { [weak self] ok in
      guard let self else { return }
      if ok { return self.loadEcho() }
      self.starting = true
      self.showStatusPage(title: "Starting Echo…", detail: "This takes a few seconds the first time.")
      self.updateStatusIcon()
      self.server.start { [weak self] problem in
        guard let self else { return }
        self.starting = false
        // Healthy is what counts, whoever started it.
        self.server.checkHealth { ok in
          if ok { return self.loadEcho() }
          self.setServerUp(false)
          self.showStatusPage(title: "Echo couldn't start", detail: problem ?? "Echo didn't answer.", retry: true)
        }
      }
    }
  }

  func loadEcho() {
    setServerUp(true)
    // The app's own line to the server (BodyLink.swift): requests reach it even while the page
    // reloads; the same handlers the page used answer them.
    BodyLink.shared.onRequest = { [weak self] body in
      guard let self else { return }
      if !self.handleComputerMessage("screen", body) { _ = self.handleScreenMessage("screen", body) }
    }
    BodyLink.shared.start(port: AppConfig.port, echoDir: server.echoDir)
    webView.load(URLRequest(url: AppConfig.baseURL))
  }

  func refreshHealth() {
    guard !starting else { return }
    server.checkHealth { [weak self] ok in self?.setServerUp(ok) }
  }

  func setServerUp(_ up: Bool) {
    serverUp = up
    updateStatusIcon()
  }

  // MARK: window and web view

  func buildWindow() {
    let config = WKWebViewConfiguration()
    config.mediaTypesRequiringUserActionForPlayback = []
    config.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15 EchoMac/1.0"
    config.preferences.isElementFullscreenEnabled = true
    config.userContentController.add(self, name: "echoApp")
    config.websiteDataStore = .default()
    if AppConfig.debug {
      let catchErrors = "window.__echoErrors = []; addEventListener('error', e => __echoErrors.push(String(e.message)));"
      config.userContentController.addUserScript(WKUserScript(source: catchErrors, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    webView.allowsMagnification = true
    webView.setValue(false, forKey: "drawsBackground")
    webView.underPageBackgroundColor = .echoBackground
    if #available(macOS 13.3, *) { webView.isInspectable = true }
    // Keep the page awake behind other windows, so push-to-talk and "Hey Echo" can still hear you.
    if webView.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
      webView.setValue(false, forKey: "windowOcclusionDetectionEnabled")
    }

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Echo"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.backgroundColor = .echoBackground
    window.minSize = NSSize(width: 640, height: 480)
    window.contentView = webView
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.tabbingMode = .disallowed
    window.center()
    window.setFrameAutosaveName("EchoMainWindow") // remembers size and position
  }

  func showWindow() {
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  /// The global shortcut: brings Echo forward, or tucks it away if it's already in front.
  func summon() {
    if NSApp.isActive && window.isKeyWindow {
      NSApp.hide(nil)
    } else {
      showWindow()
    }
  }

  /// Echo's window hidden, covered or back: the caption bar shows only when it's needed.
  func windowDidChangeOcclusionState(_ note: Notification) {
    CaptionBar.shared.refresh()
  }

  /// Closing the window keeps Echo in the menu bar (its icon there says she's running, with Open
  /// Echo and Quit Echo); Quit ends the app and her server.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }

  // MARK: loading screen

  func showStatusPage(title: String, detail: String, retry: Bool = false) {
    pageLoaded = false
    CaptionBar.shared.reset() // the page that fed the pill is being replaced
    NativeMic.shared.pageGone() // and nobody is there to take a sentence
    webView.loadHTMLString(StatusPage.html(title: title, detail: detail, retry: retry, busy: !retry), baseURL: nil)
  }

  // MARK: page ↔ app messages

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    if let type = body["type"] as? String, handleComputerMessage(type, body) { return } // Driver.swift
    if let type = body["type"] as? String, handleScreenMessage(type, body) { return }
    if let type = body["type"] as? String, handleNativeMicMessage(type, body) { return }
    switch body["type"] as? String {
    case "state":
      listening = body["listening"] as? Bool ?? false
      handsFree = body["handsFree"] as? Bool ?? false
      let mode = body["listenMode"] as? String ?? ""
      if mode != listenMode { listenMode = mode; updateStatusIcon(); pointer.sleepy = mode == "resting" }
    case "retry":
      connect()
    case "showPermissions":
      showPermissions() // the page's own permission buttons open the checklist
    // The app's own options live in the page's Settings: it asks for them, and sets them.
    case "appPrefs":
      reportAppPrefs()
    case "setAppPref":
      setAppPrefs(body)
    // Echo was asked to show something that lives in its own window (the Sky): it comes forward.
    case "showWindow":
      showWindow()
    // Nothing was said while drawing: the box opens at what was circled. Or Echo is done with it.
    case "drawBox":
      DrawLight.shared.offerBox()
    case "drawClear":
      DrawLight.shared.clear()
    // Echo was asked to keep a line on screen.
    case "pinNote":
      if let text = body["text"] as? String { PinnedNotes.shared.add(text) }
    case "clearPins":
      PinnedNotes.shared.clearAll()
    // Echo is keeping an eye on a window, or has stopped: its small light goes there, or leaves.
    case "watchLight":
      let id = body["id"] as? String ?? "", app = body["app"] as? String ?? ""
      if body["on"] as? Bool ?? false { WatchLights.shared.add(id: id, app: app) }
      else { WatchLights.shared.remove(id: id, done: body["done"] as? Bool ?? false) }
    case "openLog":
      if let dir = server.echoDir { NSWorkspace.shared.open(dir.appendingPathComponent("logs/echo-launcher.log")) }
    default:
      break
    }
  }

  func js(_ script: String) {
    guard pageLoaded else { return }
    webView.evaluateJavaScript(script, completionHandler: nil)
  }

  // MARK: navigation: only Echo itself opens inside the app

  func isEcho(_ url: URL?) -> Bool {
    guard let url, url.scheme == "http" || url.scheme == "https" else { return false }
    return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? "") && url.port == AppConfig.port
  }

  func openOutside(_ url: URL) {
    NSWorkspace.shared.open(url)
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    let mainFrame = action.targetFrame?.isMainFrame ?? true
    if isEcho(url) || ["about", "data", "blob"].contains(url.scheme ?? "") || (!mainFrame && url.scheme != nil && url.scheme != "file") {
      return decisionHandler(.allow)
    }
    // Everything else (other websites, mailto:, local project sites) opens in its own app.
    openOutside(url)
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    if !response.canShowMIMEType, response.isForMainFrame, let url = response.response.url {
      openOutside(url) // downloads go through the browser
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  /// target=_blank links and window.open: the default browser.
  func webView(_ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { openOutside(url) }
    return nil
  }

  /// A new page is taking over the web view (Echo's page loading or reloading, or the status
  /// page): whatever the old one told the pill is forgotten; the new one says what's true.
  /// The mic is disarmed too: its sentence would go to a page that isn't there. The new page says
  /// what to listen for once it has loaded (public/app.js syncNativeMic).
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    CaptionBar.shared.reset()
    NativeMic.shared.pageGone()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard isEcho(webView.url) else { return }
    pageLoaded = true
    js("window.echoNative?.report?.()")
    if AppConfig.debug { debugReport() }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    // Echo went away (a restart, or it was stopped): wait for it, or start it again.
    if isEcho(webView.url) || (error as NSError).userInfo[NSURLErrorFailingURLErrorKey].map({ isEcho($0 as? URL) }) == true {
      connect()
    }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    pageLoaded = false
    CaptionBar.shared.reset() // the page died: nobody is left to take the pill down
    NativeMic.shared.pageGone() // or to take a sentence from the mic
    connect()
  }

  // MARK: microphone, dialogs and file pickers

  /// Echo's own page may use the microphone without asking every time. macOS still asks once.
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
               initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
               decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    let local = ["localhost", "127.0.0.1", "::1"].contains(origin.host) && origin.port == AppConfig.port
    decisionHandler(local && type == .microphone ? .grant : .deny)
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  // MARK: menus

  func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command,
            target: AnyObject? = nil) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
    i.keyEquivalentModifierMask = mods
    i.target = target ?? self
    return i
  }

  func buildMainMenu() {
    let main = NSMenu()

    let appMenu = NSMenu()
    appMenu.addItem(item("About Echo", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp))
    appMenu.addItem(.separator())
    appMenu.addItem(item("Settings…", #selector(openSettings), ","))
    appMenu.addItem(.separator())
    appMenu.addItem(item("Hide Echo", #selector(NSApplication.hide(_:)), "h", target: NSApp))
    appMenu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], target: NSApp))
    appMenu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:)), target: NSApp))
    appMenu.addItem(.separator())
    appMenu.addItem(item("Quit Echo", #selector(NSApplication.terminate(_:)), "q", target: NSApp))
    main.addItem(withTitle: "Echo", action: nil, keyEquivalent: "").submenu = appMenu

    // Without an Edit menu, Copy and Paste don't work in the page.
    let edit = NSMenu(title: "Edit")
    edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
    let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(redo)
    edit.addItem(.separator())
    edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
    edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
    edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
    edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
    main.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit

    let view = NSMenu(title: "View")
    view.addItem(item("Reload", #selector(reload), "r"))
    view.addItem(item("Actual Size", #selector(zoomReset), "0"))
    view.addItem(item("Zoom In", #selector(zoomIn), "+"))
    view.addItem(item("Zoom Out", #selector(zoomOut), "-"))
    view.addItem(.separator())
    view.addItem(item("Open in Browser", #selector(openInBrowser)))
    main.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = view

    let win = NSMenu(title: "Window")
    win.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
    win.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
    win.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
    win.addItem(.separator())
    win.addItem(item("Echo", #selector(showEcho), "1"))
    main.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = win
    NSApp.windowsMenu = win

    NSApp.mainMenu = main
  }

  func buildStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem.button?.image = EchoMark.menuBarImage(dimmed: true)
    statusItem.button?.toolTip = "Echo"
    let menu = NSMenu()
    menu.delegate = self
    statusItem.menu = menu
  }

  func updateStatusIcon() {
    statusItem?.button?.image = EchoMark.menuBarImage(dimmed: !serverUp, mode: listenMode)
    statusItem?.button?.toolTip = serverUp ? "Echo is running" : starting ? "Echo is starting…" : "Echo isn't running"
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    if menu === statusItem.menu { fillStatusMenu(menu) }
  }

  /// The header's line is live: it is looked at again twice a second while the menu is open (a
  /// timer in the menu's own run loop mode; nothing runs while it is closed).
  func menuWillOpen(_ menu: NSMenu) {
    guard menu === statusItem.menu else { return }
    menuTimer?.invalidate()
    let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.updateMenuHeader() }
    RunLoop.main.add(t, forMode: .common)
    menuTimer = t
  }

  func menuDidClose(_ menu: NSMenu) {
    guard menu === statusItem.menu else { return }
    menuTimer?.invalidate()
    menuTimer = nil
  }

  /// The name of a required permission that isn't allowed ("Microphone"), or nil.
  var missingPermission: String? { Permissions.model().missing(required: true).first?.name }

  func updateMenuHeader() {
    let missing = missingPermission, work = CaptionBar.shared.progress
    let working = work.working || ComputerDriver.shared.driving
    let voice = pointer.voice
    let line = StatusMenuMath.statusLine(
      missing: missing, serverUp: serverUp, starting: starting, working: working, app: ComputerDriver.shared.appName,
      step: work.step, steps: work.steps, speaking: voice == "speaking", listening: listening || voice == "listening", handsFree: handsFree, mode: listenMode)
    menuHeader.show(line: line, voice: serverUp ? voice : "idle", working: serverUp && working, needsYou: missing != nil)
  }

  func fillStatusMenu(_ menu: NSMenu) {
    menu.removeAllItems()
    updateMenuHeader()
    let header = NSMenuItem()
    header.view = menuHeader
    header.isEnabled = false
    menu.addItem(header)
    // Only while Echo can't work yet: the way to the checklist, right under what's wrong.
    if missingPermission != nil { menu.addItem(item("Fix Permissions…", #selector(showPermissions), "")) }
    menu.addItem(.separator())

    let listen = item(listening ? "Stop Listening" : "Start Listening", #selector(toggleListening), "")
    listen.isEnabled = pageLoaded
    // Push-to-talk is modifier keys only, so it can't be a key equivalent (and must not be one:
    // the menu would take the keys). It is shown as a badge instead, where macOS has them.
    let chord = ptt.isActive ? StatusMenuMath.pttHint(Prefs.pttHotkey) : ""
    if #available(macOS 14, *), !chord.isEmpty { listen.badge = NSMenuItemBadge(string: chord) }
    menu.addItem(listen)
    // The one listening state: three choices, one ticked. (Double-tapping the key switches the first two.)
    for (title, mode) in [("Listening", "listening"), ("Resting: its name only", "resting"), ("Mic Off", "off")] {
      let m = item(title, #selector(pickListenMode(_:)), "")
      m.representedObject = mode
      m.state = listenMode == mode ? .on : .off
      m.isEnabled = pageLoaded
      menu.addItem(m)
    }
    if PinnedNotes.shared.count > 0 {
      menu.addItem(item("Clear Pinned Notes", #selector(clearPinnedNotes), ""))
    }
    // The Caption setting (Settings, in the page): the island at the bottom of the screen.
    let caption = item("Show Caption", #selector(toggleCaption), "")
    caption.state = CaptionBar.shared.allowed ? .on : .off
    caption.isEnabled = pageLoaded
    menu.addItem(caption)
    menu.addItem(.separator())

    // The summon shortcut as a hint. A key equivalent in this menu only counts while the menu is
    // open; the shortcut itself is HotKey's, from anywhere.
    let open = item("Open Echo", #selector(showEcho), "")
    if let k = StatusMenuMath.summonKey(Prefs.hotKey) {
      var mods: NSEvent.ModifierFlags = []
      if k.mods.contains("ctrl") { mods.insert(.control) }
      if k.mods.contains("opt") { mods.insert(.option) }
      if k.mods.contains("shift") { mods.insert(.shift) }
      if k.mods.contains("cmd") { mods.insert(.command) }
      open.keyEquivalent = k.key
      open.keyEquivalentModifierMask = mods
    }
    menu.addItem(open)
    let settings = item("Settings…", #selector(openSettings), ",")
    settings.isEnabled = pageLoaded
    menu.addItem(settings)
    if !serverUp && !starting { menu.addItem(item("Start Echo Server", #selector(startServer), "")) }
    menu.addItem(.separator())
    menu.addItem(item("Quit Echo", #selector(NSApplication.terminate(_:)), "q", target: NSApp))
  }

  // MARK: actions

  @objc func showEcho() { showWindow() }
  /// Show Caption: the island goes or comes back at once, and the page saves the Caption setting
  /// (the server tells every open page, so Settings shows the same).
  @objc func toggleCaption() {
    let on = !CaptionBar.shared.allowed
    CaptionBar.shared.setAllowed(on)
    js("fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captionBar: \(on) }) })")
  }
  /// Settings… (⌘,): Echo's window, on Settings. The page's own bridge call when it has one;
  /// otherwise the ⌘, the page already listens for.
  @objc func openSettings() {
    showWindow()
    js("window.echoNative?.openSettings ? window.echoNative.openSettings() : document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))")
  }
  @objc func showPermissions() {
    Permissions.shown = true
    permissionsWindow.show()
  }
  /// A permission changed while the checklist was open (it looks every 2 seconds): noted once on
  /// the timeline, and whatever was waiting for it (push-to-talk, the mic, the page) hears now.
  func permissionsChanged() {
    guard Permissions.noteChanges() else { return }
    retryPushToTalk()
    NativeMic.shared.recheck()
    reportPermissions()
  }
  @objc func reload() { if pageLoaded { webView.reload() } else { connect() } }
  @objc func zoomReset() { webView.pageZoom = 1 }
  @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 2) }
  @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
  @objc func openInBrowser() { openOutside(AppConfig.baseURL) }

  @objc func toggleListening() {
    // The microphone needs the page in front, except while Echo drives: then it already listens
    // in the background, and the app she's working in keeps the focus.
    if !ComputerDriver.shared.driving { showWindow() }
    js("window.echoNative?.toggleListening()")
  }

  @objc func toggleHandsFree() {
    js("window.echoNative?.setHandsFree(\(!handsFree))")
  }

  @objc func clearPinnedNotes() { PinnedNotes.shared.clearAll() }

  @objc func pickListenMode(_ sender: NSMenuItem) {
    guard let mode = sender.representedObject as? String, ["listening", "resting", "off"].contains(mode) else { return }
    js("window.echoNative?.setListenMode('\(mode)', 'menu')")
  }

  /// The screen locked or unlocked: the mic goes off while it is locked, and comes back resting.
  @objc func screenLocked() { js("window.echoNative?.screenLocked(true)") }
  @objc func screenUnlocked() { js("window.echoNative?.screenLocked(false)") }

  // MARK: the app's own options, set from the page's Settings

  /// Tells the page what they are now: window.echoNative.appPrefs({ keepWorkingAfterQuit,
  /// openAtLogin, hotKey, hotKeys: [{ id, title }] }). `error` is there when a change didn't take.
  func reportAppPrefs(error: String? = nil) {
    var prefs: [String: Any] = [
      "keepWorkingAfterQuit": Prefs.keepWorkingAfterQuit,
      "openAtLogin": Prefs.openAtLogin,
      "hotKey": HotKey.presets.contains { $0.id == Prefs.hotKey } ? Prefs.hotKey : "off",
      "hotKeys": [["id": "off", "title": "Off"]] + HotKey.presets.map { ["id": $0.id, "title": $0.title] },
    ]
    if let error { prefs["error"] = error }
    callPage("appPrefs", prefs)
  }

  /// { type: "setAppPref", keepWorkingAfterQuit?, openAtLogin?, hotKey? }: each one given is set,
  /// then the page is told what is true now (a change macOS refused shows as unchanged, with why).
  func setAppPrefs(_ body: [String: Any]) {
    var problem: String?
    if let v = body["keepWorkingAfterQuit"] as? Bool { Prefs.keepWorkingAfterQuit = v }
    if let v = body["openAtLogin"] as? Bool, v != Prefs.openAtLogin {
      do {
        try Prefs.setOpenAtLogin(v)
      } catch {
        problem = "Couldn't change Open at Login: \(error.localizedDescription) You can also add Echo in System Settings, General, Login Items."
      }
    }
    if let v = body["hotKey"] as? String, v == "off" || HotKey.presets.contains(where: { $0.id == v }) {
      if !applyHotKey(v) { problem = "Another app already uses that shortcut. Pick a different one." }
    }
    reportAppPrefs(error: problem)
  }

  /// Registers the summon shortcut and remembers it. False: another app already owns it.
  @discardableResult
  func applyHotKey(_ id: String) -> Bool {
    Prefs.hotKey = id
    return hotKey.apply(id)
  }

  @objc func startServer() { connect() }

  // MARK: testing aid (--snapshot PATH, or ECHO_APP_DEBUG=1)

  func debugReport() {
    let probe = """
      JSON.stringify({ title: document.title, secure: window.isSecureContext,
        speech: typeof (window.SpeechRecognition || window.webkitSpeechRecognition),
        mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        audio: typeof AudioContext, bridge: typeof window.echoNative, errors: window.__echoErrors })
      """
    // After the page's own start-up code has run.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
      self.webView.evaluateJavaScript(probe) { result, _ in
        print("echo-app: loaded \(AppConfig.baseURL) \(result ?? "")")
        fflush(stdout)
      }
    }
    guard let path = AppConfig.snapshotPath, !snapshotTaken else { return }
    snapshotTaken = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
      self.webView.takeSnapshot(with: nil) { image, _ in
        guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: URL(fileURLWithPath: path))
        print("echo-app: snapshot \(path) window \(self.window.windowNumber)")
        fflush(stdout)
      }
    }
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
