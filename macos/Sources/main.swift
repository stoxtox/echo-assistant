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
  var serverUp = false
  var starting = false
  var pageLoaded = false // Echo's own page (not the loading screen) is showing
  var listening = false
  var handsFree = false
  var healthTimer: Timer?
  var snapshotTaken = false

  // MARK: launch

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMainMenu()
    buildWindow()
    buildStatusItem()
    hotKey = HotKey { [weak self] in self?.summon() }
    applyHotKey(Prefs.hotKey, warn: false)
    showWindow()
    connect()
    healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refreshHealth() }
  }

  func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
    showWindow()
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

  func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
    guard !Prefs.keepServerRunning, server.startedByLauncher else { return .terminateNow }
    server.stop { _ in app.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
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

  /// Closing the window keeps Echo in the menu bar; Quit ends the app.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }

  // MARK: loading screen

  func showStatusPage(title: String, detail: String, retry: Bool = false) {
    pageLoaded = false
    webView.loadHTMLString(StatusPage.html(title: title, detail: detail, retry: retry, busy: !retry), baseURL: nil)
  }

  // MARK: page ↔ app messages

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    switch body["type"] as? String {
    case "state":
      listening = body["listening"] as? Bool ?? false
      handsFree = body["handsFree"] as? Bool ?? false
    case "retry":
      connect()
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
    appMenu.addItem(item("Check for Updates…", #selector(checkForUpdates), ""))
    appMenu.addItem(.separator())
    appMenu.addItem(item("Keep Echo Running After Quit", #selector(toggleKeepRunning)))
    appMenu.addItem(item("Open at Login", #selector(toggleOpenAtLogin)))
    let shortcut = NSMenuItem(title: "Summon Shortcut", action: nil, keyEquivalent: "")
    shortcut.submenu = hotKeyMenu()
    appMenu.addItem(shortcut)
    appMenu.addItem(.separator())
    appMenu.addItem(item("Hide Echo", #selector(NSApplication.hide(_:)), "h", target: NSApp))
    appMenu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], target: NSApp))
    appMenu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:)), target: NSApp))
    appMenu.addItem(.separator())
    appMenu.addItem(item("Quit Echo", #selector(NSApplication.terminate(_:)), "q", target: NSApp))
    appMenu.delegate = self
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

  func hotKeyMenu() -> NSMenu {
    let m = NSMenu()
    let off = item("Off", #selector(chooseHotKey(_:)))
    off.representedObject = "off"
    m.addItem(off)
    for p in HotKey.presets {
      let i = item(p.title, #selector(chooseHotKey(_:)))
      i.representedObject = p.id
      m.addItem(i)
    }
    m.delegate = self
    return m
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
    statusItem?.button?.image = EchoMark.menuBarImage(dimmed: !serverUp)
    statusItem?.button?.toolTip = serverUp ? "Echo is running" : starting ? "Echo is starting…" : "Echo isn't running"
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    if menu === statusItem.menu { return fillStatusMenu(menu) }
    for i in menu.items {
      switch i.action {
      case #selector(toggleKeepRunning): i.state = Prefs.keepServerRunning ? .on : .off
      case #selector(toggleOpenAtLogin): i.state = Prefs.openAtLogin ? .on : .off
      case #selector(chooseHotKey(_:)): i.state = (i.representedObject as? String) == Prefs.hotKey ? .on : .off
      default: break
      }
    }
  }

  func fillStatusMenu(_ menu: NSMenu) {
    menu.removeAllItems()
    let status = NSMenuItem(
      title: serverUp ? "Echo is running" : starting ? "Echo is starting…" : "Echo isn't running",
      action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    menu.addItem(item("Show Echo", #selector(showEcho), ""))
    let updates = item("Check for Updates…", #selector(checkForUpdates), "")
    updates.isEnabled = pageLoaded
    menu.addItem(updates)
    menu.addItem(.separator())
    let listen = item(listening ? "Stop Listening" : "Start Listening", #selector(toggleListening), "")
    listen.isEnabled = pageLoaded
    menu.addItem(listen)
    let hf = item("Hands-free", #selector(toggleHandsFree), "")
    hf.state = handsFree ? .on : .off
    hf.isEnabled = pageLoaded
    menu.addItem(hf)
    menu.addItem(.separator())
    if serverUp {
      if server.startedByLauncher { menu.addItem(item("Stop Echo Server", #selector(stopServer), "")) }
    } else if !starting {
      menu.addItem(item("Start Echo Server", #selector(startServer), ""))
    }
    let keep = item("Keep Echo Running After Quit", #selector(toggleKeepRunning), "")
    keep.state = Prefs.keepServerRunning ? .on : .off
    menu.addItem(keep)
    let login = item("Open at Login", #selector(toggleOpenAtLogin), "")
    login.state = Prefs.openAtLogin ? .on : .off
    menu.addItem(login)
    let shortcut = NSMenuItem(title: "Summon Shortcut", action: nil, keyEquivalent: "")
    shortcut.submenu = hotKeyMenu()
    menu.addItem(shortcut)
    menu.addItem(.separator())
    menu.addItem(item("Quit Echo", #selector(NSApplication.terminate(_:)), "q", target: NSApp))
  }

  // MARK: actions

  @objc func showEcho() { showWindow() }
  // Opens Settings → Updates in the page and checks GitHub for a newer release.
  @objc func checkForUpdates() {
    showWindow()
    js("window.echoNative?.checkForUpdates()")
  }
  @objc func reload() { if pageLoaded { webView.reload() } else { connect() } }
  @objc func zoomReset() { webView.pageZoom = 1 }
  @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 2) }
  @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
  @objc func openInBrowser() { openOutside(AppConfig.baseURL) }

  @objc func toggleListening() {
    showWindow() // the microphone needs the page in front
    js("window.echoNative?.toggleListening()")
  }

  @objc func toggleHandsFree() {
    js("window.echoNative?.setHandsFree(\(!handsFree))")
  }

  @objc func toggleKeepRunning() { Prefs.keepServerRunning.toggle() }

  @objc func toggleOpenAtLogin() {
    do {
      try Prefs.setOpenAtLogin(!Prefs.openAtLogin)
    } catch {
      alert("Couldn't change Open at Login", error.localizedDescription
        + "\n\nYou can also add Echo in System Settings → General → Login Items.")
    }
  }

  @objc func chooseHotKey(_ sender: NSMenuItem) {
    applyHotKey(sender.representedObject as? String ?? "off", warn: true)
  }

  func applyHotKey(_ id: String, warn: Bool) {
    Prefs.hotKey = id
    if !hotKey.apply(id) && warn {
      alert("That shortcut is taken", "Another app already uses it. Pick a different one from the Summon Shortcut menu.")
    }
  }

  @objc func startServer() { connect() }

  @objc func stopServer() {
    server.stop { [weak self] message in
      guard let self else { return }
      self.refreshHealth()
      self.showStatusPage(title: "Echo is stopped", detail: message.isEmpty ? "" : message, retry: true)
    }
  }

  func alert(_ title: String, _ text: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.runModal()
  }

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
