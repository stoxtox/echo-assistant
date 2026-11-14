// The Mac app's side of Echo's "firefly" (docs/firefly-protocol.md): the app takes the server's
// `firefly` messages, the light waits in lessons, walks routes through menus, searches, takes
// its colour from the request's intent, can be picked up and dropped on something ("this one"),
// and the pearl wears Auto, Glass or Moon. The decisions are pure Swift with their own checks
// (macos/Tests/main.swift, compiled and run by test/macapp.test.js); this pins how the app is
// wired to them, and checks what the app posts against what the server takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

sandbox('fireflymac');
const { cleanPointed, pointedLine } = await import('../lib/computer.js');
const { cleanPoint, cleanRoute, INTENTS, OUTCOMES, ROUTE_MAX } = await import('../lib/screen.js');
const swift = (f) => fs.readFileSync(new URL(`../macos/Sources/${f}`, import.meta.url), 'utf8');
const checks = fs.readFileSync(new URL('../macos/Tests/main.swift', import.meta.url), 'utf8');
/** The body of a Swift function, from its signature to the next one at the same depth. */
const body = (src, signature) => {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `missing: ${signature}`);
  const end = src.slice(at + signature.length).search(/\n  (\/\/\/|\/\/ MARK|@discardableResult|(private |fileprivate |static )*(func|var|let) )/);
  return src.slice(at, end < 0 ? undefined : at + signature.length + end);
};

test('the app takes firefly messages on its own line, and from the page when that line is down', () => {
  const link = swift('BodyLink.swift'), driver = swift('Driver.swift'), bridge = swift('ScreenBridge.swift'), pointer = swift('Pointer.swift');
  assert.match(link, /var onFirefly: \(\(\[String: Any\]\) -> Void\)\?/);
  assert.match(link, /else if msg\["type"\] as\? String == "firefly", msg\["release"\] is String \|\| msg\["hold"\] is String \{\n\s+self\.onFirefly\?\(msg\)/, 'a release or a hold; with neither it is ignored');
  assert.match(link, /msg\["type"\] as\? String == "screen_request", let id = msg\["id"\] as\? String, let kind = msg\["kind"\] as\? String/, 'requests still arrive');
  assert.match(driver, /BodyLink\.shared\.onFirefly = \{ \[weak self\] msg in self\?\.pointer\.firefly\(msg\) \}/, 'handed to the pointer');
  assert.match(bridge, /case "firefly":\n\s+\/\/[^\n]*\n\s+pointer\.firefly\(body\)/, 'and by way of the page');
  const firefly = body(pointer, '  func firefly(_ msg: [String: Any]) {');
  assert.match(firefly, /if let name = msg\["release"\] as\? String \{\n\s+released\(name, outcome: msg\["outcome"\] as\? String \?\? ""\)/);
  assert.match(firefly, /else if let id = msg\["hold"\] as\? String \{\n\s+ask\(id\)/);
  // A hold with no light out is ignored.
  assert.match(body(pointer, '  private func ask(_ id: String) {'), /guard firefly, mode == \.out, panel != nil, !showing\.isNull, !id\.isEmpty else \{ return \}/);
});

test('a request\'s intent, hold and route reach the pointer, and the answer says how far a route got', () => {
  const bridge = swift('ScreenBridge.swift'), driver = swift('Driver.swift');
  assert.match(bridge, /let intent = PearlMath\.intent\(p\["intent"\] as\? String\)/);
  assert.match(bridge, /let stepId = p\["hold"\] as\? Bool == true \? \(p\["stepId"\] as\? String\)\.flatMap \{ \$0\.isEmpty \? nil : \$0 \} : nil/, 'a step id only counts with hold');
  assert.match(bridge, /let screen = self\.pointer\.point\(at: frame, label: label, caption: caption, role: role, intent: intent, stepId: stepId, request: id, words: words\)/);
  assert.match(bridge, /if AXFinder\.trusted, let route = PearlMath\.route\(p\["route"\]\), route\.count > 1 \{/, 'a route of one label is just its target');
  assert.match(bridge, /"routeIndex": index,/);
  assert.match(bridge, /guard found, let hit else \{\n\s+return self\.answer\(id, \["found": false, "reason": "not_found"/, 'not even the first label: not found, as for any target');
  // An act's resolve carries its colour too; the step itself is always "act".
  assert.match(driver, /intent: PearlMath\.intent\(p\["intent"\] as\? String \?\? "act"\), request: id\)/);
  assert.match(body(swift('Pointer.swift'), '  func aboutToAct(at target: CGRect) -> TimeInterval {'), /intent = "act"\n\s+fly\?\.art\.intent = intent/);
  // The server reads the answer the app sends for a route.
  const answer = cleanPoint({ found: true, via: 'accessibility', label: 'File', role: 'AXMenuBarItem', app: 'Preview', routeIndex: 0, debug: { frame: { x: 1, y: 2, width: 30, height: 20 }, screen: { x: 0, y: 0, width: 1440, height: 900 } } });
  assert.equal(answer.routeIndex, 0);
  assert.equal(answer.found, true);
});

test('the app and the server agree on intents, outcomes, routes and colours', () => {
  const math = swift('PointMath.swift');
  assert.deepEqual(JSON.parse(math.match(/static let intents = (\[[^\]]*\])/)[1]), INTENTS);
  for (const o of OUTCOMES) assert.ok(checks.includes(`outcome: "${o}"`), `the Swift checks cover the outcome ${o}`);
  assert.equal(Number(math.match(/static let most = (\d+)/)[1]), ROUTE_MAX);
  assert.deepEqual(cleanRoute(['File', ' Export ', 'PDF…']).route, ['File', 'Export', 'PDF…']);
  assert.match(checks, /PearlMath\.route\(\["File", " Export ", "PDF…"\]\) \?\? \[\] == \["File", "Export", "PDF…"\]/, 'the same trimming, checked in Swift');
  // show: white; act: the gradient; ask: amber.
  assert.match(math, /static let answerHex: \[UInt32\] = \[0x4780FF, 0xA866FF, 0xFF669E, 0xFFB866\]/);
  assert.match(math, /case "act": return answerHex\n\s+case "ask": return \[answerHex\[3\]\]\n\s+default: return \[0xFFFFFF\]/);
  assert.match(swift('Companion.swift'), /static let answer = \[RGB\(r: 71, g: 128, b: 255\), RGB\(r: 168, g: 102, b: 255\), RGB\(r: 255, g: 102, b: 158\), RGB\(r: 255, g: 184, b: 102\)\]/, 'the same four colours the pearl\'s rim has');
  const art = swift('Companion.swift');
  assert.match(art, /private var wants: \(tint: CGFloat, amber: CGFloat, swollen: CGFloat\) \{ \(intent == "act" \? 1 : 0, intent == "ask" \? 1 : 0, hot \? 1 : 0\) \}/);
  assert.match(art, /ask = RGB\(hex: PearlMath\.lightColours\("ask"\)\[0\]\)/);
});

test('a held light never times out: only a release, the line dropping, or quitting lets it go', () => {
  const pointer = swift('Pointer.swift'), main = swift('main.swift');
  assert.match(pointer, /hold\.take\(step: stepId\)/);
  // A release that beats the find: the find's step is recorded when the search begins, and a
  // point for a step already let go shows nothing and holds nothing (PearlMath.Hold decides).
  assert.match(pointer, /hold\.began\(id, step: stepId\)/);
  assert.match(body(pointer, '  func point(at target: CGRect, label: String, caption: String = "", pinned: Bool = true'), /if hold\.refuses\(step: stepId\) \{ return screen \}/);
  assert.ok(pointer.indexOf('if hold.refuses(step: stepId) { return screen }') < pointer.indexOf('let fresh = ensurePanel(on: screen) || wasHidden'), 'before anything is shown');
  for (const said of ['the find comes back: the step is refused, and nothing waits', 'a release for an unknown id is ignored', "the hint's find comes back: it does not take the light again"]) assert.ok(checks.includes(said), `checked in Swift: ${said}`);
  // At rest it is drawn a few times a second, not every frame, however long the lesson holds it.
  assert.match(pointer, /if firefly, !pace\.due\(now: now, last: lastTick, moving: lightMoving\(now\)\) \{ return \}/);
  assert.match(checks, /a light held by a lesson for 10 s on a/);
  assert.match(pointer, /\} else if hold\.waiting \|\| grab\.active \|\| search\?\.shown == true \|\| leaveAt != nil \{\n\s+\/\/ Waiting for you, in your hand or still searching: it stays, however long that takes\.\n\s+\} else if hop == nil, flight == nil,/, 'the going-home rules are not even asked while it waits');
  assert.match(pointer, /fly\.art\.breath = waits \? \(reduce \? 0\.4 : PearlMath\.breath\(now - arrivedAt\)\) : asksNow && !reduce \? 0\.85 \* PearlMath\.heartbeat\(elapsed: now - arrivedAt\) : 0/, 'a slow breath while it waits (still, with reduced motion)');
  // The release: a burst and a pleased blink for done; quietly for the rest; sorry when not found.
  const released = body(pointer, '  private func released(_ name: String, outcome: String) {');
  assert.match(released, /case \.burst:[\s\S]*fly\?\.art\.burst\(now: now\)[\s\S]*CaptionBar\.shared\.moment\("done"\)[\s\S]*leaveAt = now \+ 0\.9/);
  assert.match(released, /case \.leave:[\s\S]*leaveAt = now \+ \(outcome == "skipped" \? 0\.3 : 0\)/);
  assert.match(released, /case \.lost:[\s\S]*lost\(\)/);
  assert.match(body(pointer, '  private func lost() {'), /CaptionBar\.shared\.moment\("sorry"\)/);
  // The line dropped (the existing onDrop) and quitting: no release can come, so it is let go.
  assert.match(main, /BodyLink\.shared\.onDrop = \{\n\s+\/\/[^\n]*\n\s+ComputerDriver\.shared\.pointer\?\.letGo\(\)/);
  assert.match(body(main, '  func applicationWillTerminate(_ note: Notification) {'), /pointer\.letGo\(\)\n\s+pointer\.hide\(animated: false\)/);
  assert.match(body(pointer, '  func letGo() {'), /_ = hold\.drop\(\)/);
  // A run ending ends a risky step's wait, never a lesson's (the page ends "runs" all through a lesson).
  const release = body(pointer, '  func release() {');
  assert.match(release, /if hold\.drop\(asksOnly: true\) \{/);
  assert.match(release, /guard !hold\.waiting else \{ return \}/);
});

test('searching: shown only when the app\'s own find is slow, and called off when the server gives up', () => {
  const pointer = swift('Pointer.swift'), bridge = swift('ScreenBridge.swift'), driver = swift('Driver.swift');
  assert.match(bridge, /pointer\.searching\(id, in: app, intent: intent, stepId: stepId, target: target\)/, 'with the lesson step the find is for, so a release that beats the find is not lost');
  assert.match(driver, /pointer\?\.searching\(id, in: app, intent: p\["intent"\] as\? String \?\? "act", target: target\)/);
  assert.match(pointer, /DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ PearlMath\.searchAfter\) \{ \[weak self\] in self\?\.showSearch\(id\) \}/);
  assert.match(pointer, /position = reduce \? s\.centre : PearlMath\.search\(around: s\.centre, elapsed: now - s\.since\)/, 'a figure of eight (still, with reduced motion)');
  assert.match(body(pointer, '  private func showSearch(_ id: String) {'), /CaptionBar\.shared\.setLightNeeds\(true\)/, 'the pearl looks puzzled');
  assert.match(swift('Caption.swift'), /pearl\.asking = content\.card != nil \|\| lightNeeds/);
  // Every answer goes by the pointer first: one the server stopped waiting for is not sent.
  assert.match(bridge, /guard pointer\.answered\(id, found: body\["found"\] as\? Bool \?\? \(body\["ok"\] as\? Bool \?\? true\)\) else \{ return \}/);
  assert.match(driver, /guard let self, self\.pointer\.answered\(id, found: b\["found"\] as\? Bool \?\? \(b\["ok"\] as\? Bool \?\? true\)\) else \{ return \}/);
  assert.match(bridge, /guard let self, !self\.pointer\.calledOff\(id\) else \{ return nil \}/, 'and what it found is not shown');
  assert.match(driver, /self\.pointer\?\.calledOff\(id\) != true \{/);
});

test('only the light takes the mouse, only while it can be picked up; Escape is the only key watched', () => {
  const pointer = swift('Pointer.swift');
  // The overlay itself stays click-through, always.
  const overlay = body(pointer, '  private func makePanel(_ frame: CGRect) -> NSPanel {');
  assert.match(overlay, /p\.ignoresMouseEvents = true/);
  assert.equal(pointer.match(/ignoresMouseEvents = /g).length, 4, 'the overlay (always true), and the light\'s own spot: made, put away, and switched');
  const grab = body(pointer, '  private func placeGrab(at p: CGPoint, takes: Bool) {');
  assert.match(grab, /guard holdable \|\| grab\.active else \{/);
  assert.match(grab, /g\.ignoresMouseEvents = !takes/);
  assert.match(pointer, /let takes = grab\.active \|\| \(holdable && PearlMath\.grabbable\(mouse, light: shown, target: showing, holdable: true\)\)/);
  assert.match(pointer, /let side = 2 \* PearlMath\.grabReach\n\s+let p = NSPanel\(contentRect: NSRect\(x: 0, y: 0, width: side, height: side\), styleMask: \[\.borderless, \.nonactivatingPanel\]/, '22 pt across, and it never takes focus');
  assert.match(swift('PointMath.swift'), /static let grabReach: CGFloat = 11/);
  assert.match(body(pointer, '  private var holdable: Bool {'), /firefly && mode == \.out && canFind && flight == nil && typing == nil && !actionPending && search == nil && leaveAt == nil/);
  // Escape: watched only from the press to the drop, and nothing else about the keyboard.
  const watch = body(pointer, '  private func watchEscape(_ on: Bool) {');
  assert.match(watch, /escapeWatch\.forEach \{ NSEvent\.removeMonitor\(\$0\) \}\n\s+escapeWatch = \[\]\n\s+guard on else \{ return \}/);
  assert.equal(pointer.match(/addGlobalMonitorForEvents/g).length, 1);
  assert.match(watch, /addGlobalMonitorForEvents\(matching: \.keyDown, handler: \{ \[weak self\] e in if e\.keyCode == escape \{ self\?\.cancelGrab\(\) \} \}\)/);
  assert.match(body(pointer, '  fileprivate func grabDown() {'), /watchEscape\(true\)/);
  assert.match(body(pointer, '  fileprivate func grabUp() {'), /watchEscape\(false\)/);
  assert.match(body(pointer, '  private func endGrab() {'), /watchEscape\(false\)/);
  // Carrying Echo's light is not taking over from her.
  assert.match(swift('Driver.swift'), /inEcho = self\.pointer\?\.inHand == true \|\| self\.isEchoInput\(/);
});

test('a drop tells the server what is there by name only, with the token, and the server takes it', () => {
  const pointer = swift('Pointer.swift'), server = swift('Server.swift');
  // What is read: the thing's own name (its title, description, placeholder or help), a role, the
  // app, the window's title, five neighbours' names. Never a value and never the text inside it
  // (for a label, a link, a cell or a row that is the page's or the message's own words); with
  // no name, the role and an empty label. A password field: its role only.
  const name = body(pointer, '  private static func name(_ el: AXUIElement) -> String {');
  assert.match(name, /\[kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXHelpAttribute\]/);
  assert.doesNotMatch(name, /kAXValueAttribute|kAXChildrenAttribute|AXStaticText/, 'no value, no child text, for any role');
  const under = body(pointer, '  static func under(_ point: CGPoint, displays: Displays, overlays: Set<Int>) -> Under? {');
  assert.doesNotMatch(under, /kAXValueAttribute/, 'nor read anywhere else on the way');
  assert.match(under, /let n = String\(name\(k\)\.prefix\(60\)\)/, 'the neighbours are named the same way');
  assert.match(under, /\/\/ A password field: its role and nothing else\.\n\s+if isSecure\(el, role: role\) \{ return out \}\n\s+out\.label = name\(el\)/);
  assert.match(under, /if owner == me \{ return Under\(echo: true\) \}/, 'Echo\'s own windows are nothing to point at');
  assert.match(under, /if let app, MenuBar\.offLimits\(app\) \{ return nil \}/, 'the Passwords app is never read');
  assert.match(under, /\.prefix\(5\)\.map\(\\\.name\)/, 'five neighbours at most');
  // On nothing, or on Echo: back where it was, and nothing is sent.
  const dropped = body(pointer, '  private func dropped(at: CGPoint, on found: AXFinder.Under?) {');
  assert.match(dropped, /guard let found, PearlMath\.drop\(element: named, onEcho: found\.echo\) == \.settle else \{\n\s+return glideBack\(to: from, now: now\)/);
  assert.ok(dropped.indexOf('glideBack') < dropped.indexOf('onPointed?(body)'));
  assert.match(body(pointer, '  fileprivate func grabUp() {'), /guard grab\.state == \.dropped else \{ return stepAside\(\) \}/, 'a click on the light with no drag sends nothing: it steps out of your way');
  assert.match(dropped, /fly\?\.art\.burst\(now: now\)/, 'it settles with a small burst');
  assert.match(body(pointer, '  private func look(under at: CGPoint, _ done: @escaping (AXFinder.Under?) -> Void) {'), /if let island = CaptionBar\.shared\.frameOnScreen, island\.contains\(at\) \{ return done\(AXFinder\.Under\(echo: true\)\) \}/);
  // Exactly the keys the protocol names.
  const keys = [...dropped.matchAll(/body\["(\w+)"\] = /g)].map((m) => m[1]).concat([...dropped.matchAll(/var body: \[String: Any\] = \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"(\w+)":/g)].map((k) => k[1])));
  assert.deepEqual(keys.sort(), ['app', 'label', 'near', 'role', 'window', 'x', 'y']);
  // The POST: the app's token, JSON, no Origin, once.
  const post = body(server, '  func pointed(_ body: [String: Any]) {') + body(server, '  private func send(_ path: String, _ body: [String: Any]) {');
  assert.match(post, /guard let token, let data = try\? JSONSerialization\.data\(withJSONObject: body\), data\.count <= 16 \* 1024 else \{ return \}/, 'no token, nothing sent');
  assert.match(post, /\/api\/computer\/pointed/);
  assert.match(post, /req\.setValue\(token, forHTTPHeaderField: "X-Echo-Token"\)/);
  assert.match(post, /req\.setValue\("application\/json", forHTTPHeaderField: "Content-Type"\)/);
  assert.doesNotMatch(post, /Origin|retry/i);
  assert.match(swift('Driver.swift'), /pointer\.onPointed = \{ \[weak self\] body in self\?\.server\.pointed\(body\) \}/);
  // What the app sends is what the server reads (the same shape, built here as the app builds it).
  const sent = { x: 412, y: 96, label: 'Export…', role: 'AXMenuItem', app: 'Preview', window: 'Holiday plan', near: ['Print…', 'Share'] };
  const got = cleanPointed(sent);
  assert.deepEqual(got, { label: 'Export…', role: 'AXMenuItem', kind: 'menu item', app: 'Preview', window: 'Holiday plan', near: ['Print…', 'Share'] });
  assert.match(pointedLine(got), /^The user pointed at "Export…" \(menu item\) in "Preview", window "Holiday plan": they mean this one\./);
  // A password field: the app sends its role and nothing else, and that is enough to go on.
  assert.equal(cleanPointed({ x: 1, y: 2, role: 'AXSecureTextField', app: 'Safari' })?.label, '');
});

test('a route is walked stop by stop, each found inside what the one before it opens, and never opened by Echo', () => {
  const bar = swift('MenuBar.swift'), pointer = swift('Pointer.swift');
  const stop = body(bar, '  static func stop(_ label: String, after before: AXFinder.Hit?, in app: NSRunningApplication?, menuBar: Bool, displays: AXFinder.Displays) -> AXFinder.Hit? {');
  assert.match(stop, /guard let before else \{ return locate\(label, in: app, menuBar: menuBar, displays: displays\) \}/, 'the first label is looked up like any target');
  assert.match(stop, /if let opener = before\.element \{ return AXFinder\.find\(label, under: opener, app: before\.app, displays: displays\) \}/);
  assert.match(pointer, /if role == "AXMenuItem", !MenuMath\.inOpenMenu\(seen, windows: menus, primaryHeight: top\) \{ continue \}/, 'an item of a closed menu is not there yet');
  const walker = bar.slice(bar.indexOf('final class RouteWalker {'));
  assert.match(walker, /route = PearlMath\.Route\(count: labels\.count, at: CACurrentMediaTime\(\), patience: patience\)/);
  assert.match(walker, /if let hit, self\.route\?\.ready\(at: now\) == true, arrive\(next, hit\), self\.token == mine \{\n\s+self\.route\?\.arrive\(at: now\)/, 'it rests on a stop before moving on');
  assert.match(walker, /if let a = self\.route\?\.answer\(at: CACurrentMediaTime\(\)\) \{ self\.answer\?\(a\.found \? a\.index : nil, self\.last\) \}/, 'one answer');
  // A walk stopped before its answer still answers (PearlMath.Route.stop: once), so no request hangs.
  const stopWalk = walker.slice(walker.indexOf('  func stop() {'));
  assert.match(stopWalk, /let left = route\?\.stop\(\), answer = self\.answer, last = self\.last/);
  assert.match(stopWalk, /if let left \{ answer\?\(left\.found \? left\.index : nil, last\) \}/);
  // The walk's own search (its first label is slow to find) never stops the walk it belongs to:
  // PearlMath.searchStops decides, and showSearch asks it. (A 20 s hang, before.)
  const showSearch = body(pointer, '  private func showSearch(_ id: String) {');
  assert.match(showSearch, /if PearlMath\.searchStops\(walk: walker\.id, for: id\) \{ walker\.stop\(\) \}/);
  assert.equal(showSearch.match(/walker\.stop\(\)/g).length, 1, 'and in no other way');
  assert.match(pointer, /walker\.walk\(id, route: route, app: app, menuBar: menuBar, patience: patience, arrive:/, 'the walker knows whose walk it is');
  for (const said of ["the walk's own search does not stop the walk", 'first stop never found: one answer, found false, at its patience', 'a search for another request, arriving mid-walk, does', 'stopped on File before its answer: it says so now']) assert.ok(checks.includes(said), `checked in Swift: ${said}`);
  assert.doesNotMatch(walker + stop, /AXPress|AXUIElementPerformAction|CGEvent/, 'looking only: nothing is pressed');
  assert.match(pointer, /walking: true, passing: i < route\.count - 1\)/, 'the stops on the way rest with a lighter ring; the target is circled');
});

test('the look: auto, glass or moon; auto goes by the system\'s appearance, and the screen is never captured for it', () => {
  const math = swift('PointMath.swift'), pointer = swift('Pointer.swift'), config = swift('Config.swift'), bridge = swift('ScreenBridge.swift');
  assert.match(math, /static let looks = \["auto", "glass", "moon"\]/);
  assert.match(config, /get \{ d\.string\(forKey: "CompanionLook"\) \?\? "auto" \}/);
  for (const f of ['Config.swift', 'Pointer.swift', 'Caption.swift', 'ScreenBridge.swift', 'PointMath.swift']) assert.doesNotMatch(swift(f), /"sunset"/, `${f}: nothing maps to the old look`);
  assert.match(bridge, /if let v = body\["companionLook"\] as\? String \{ Prefs\.companionLook = v \}/);
  // No screen capture for decoration: the file that draws the companion's light cannot capture
  // at all (it used to read a strip behind the island every 2 s, even with screen awareness off).
  assert.doesNotMatch(pointer, /ScreenCaptureKit|SCScreenshotManager|SCShareableContent|SCContentFilter|SCStream|CGWindowListCreateImage|CGDisplayCreateImage|ScreenLook\.capture/);
  for (const f of ['Caption.swift', 'Companion.swift', 'PillArt.swift']) assert.doesNotMatch(swift(f), /ScreenCaptureKit|SCScreenshotManager|CGWindowListCreateImage|ScreenLook\.capture/, `${f}: nor does anything else that draws it`);
  const look = pointer.slice(pointer.indexOf('enum CompanionLook {'), pointer.indexOf('// MARK: the overlay'));
  assert.match(look, /static func wear\(\) -> String \{\n\s+let dark = NSApp\.effectiveAppearance\.bestMatch\(from: \[\.darkAqua, \.aqua\]\) == \.darkAqua\n\s+worn = CompanionMath\.wear\(Prefs\.companionLook, systemDark: dark\)/);
  assert.doesNotMatch(look, /sample|behind|brightness|Task\.detached|hasPermission/, 'no sampling of any kind');
  assert.doesNotMatch(math, /func brightness|darkBelow|lightAbove/, 'and nothing left to decide from a picture');
  assert.match(swift('Caption.swift'), /let skin = CompanionLook\.wear\(\)/);
  assert.match(checks, /auto: Moon in dark mode, Glass in light/);
});

test('asleep with its light home the pearl glows faintly at its centre, and a working step keeps the thinking pearl', () => {
  const pearl = swift('Companion.swift'), bar = swift('Caption.swift'), page = fs.readFileSync(new URL('../public/ui/companion.js', import.meta.url), 'utf8');
  assert.match(pearl, /rest = PearlMath\.ease\(rest, toward: mood == "sleepy" && !lightAway \? 1 : 0, rate: 2, dt: dt\)/);
  assert.match(pearl, /a = rest \* \(0\.3 \+ 0\.3 \* pulse\) \* \(moon \? 1\.2 : 1\)/);
  assert.match(page, /a = S\.rest \* \(0\.3 \+ 0\.3 \* pulse\) \* \(skin === 'moon' \? 1\.2 : 1\)/, 'the same glow as the page\'s pearl');
  assert.match(bar, /pearl\.working = driving \|\| doing != nil/, 'working on the Mac: the pearl thinks');
  assert.match(checks, /mood\(working: true, idle: 999\) == "thinking"/, 'checked in Swift');
});

test('the app tells the server when its light leaves the pearl and when it lands, and the answer says a light is coming', () => {
  const pointer = swift('Pointer.swift'), driver = swift('Driver.swift'), bridge = swift('ScreenBridge.swift'), server = swift('Server.swift');
  // A point made for a request: `departed` when the light leaves the pearl, `arrived` when its flight ends (at once if it is already there).
  const point = body(pointer, '  func point(at target: CGRect, label: String');
  // Every take-off is told (from the pearl, on from the last thing, or turning round), with how long the flight will take.
  assert.match(point, /if let f = flight, !reduce \{\n\s+let from = fresh \? "pearl" : turning \? "turned" : "target"\n\s+onLight\?\(\["type": "departed", "id": request, "ms": Int\(\(\(f\.lands - now\) \* 1000\)\.rounded\(\)\), "from": from\]\)/);
  assert.match(point, /if flight != nil \{ landing\.append\(request\) \} else \{ lightArrived\(\[request\], ms: 0\) \}/);
  const land = body(pointer, '  private func flyOn(_ now: CFTimeInterval) -> Bool {');
  assert.match(land, /if mode == \.out, !landing\.isEmpty \{\n\s+lightArrived\(landing, ms: Int\(\(f\.duration \* 1000\)\.rounded\(\)\)\)/, 'the end of the flight, before its laps; never the flight home');
  const arrived = body(pointer, '  private func lightArrived(_ requests: [String], ms: Int) {');
  assert.match(arrived, /for id in requests where !told\.contains\(id\)/, 'once per request');
  assert.match(arrived, /var body: \[String: Any\] = \["type": "arrived", "id": id, "ms": ms\]\n\s+if Motion\.reduced \{ body\["still"\] = true \}/, 'only the request and the flight: no name of anything');
  // Both ways an answer leaves the app say `light` when the light went out for the request.
  assert.match(driver, /if self\.pointer\.lit\(id\) \{ out\["light"\] = true \}/);
  assert.match(bridge, /if pointer\.lit\(id\) \{ b\["light"\] = true \}/);
  assert.match(driver, /pointer\.onLight = \{ \[weak self\] body in self\?\.server\.light\(body\) \}/);
  // Posted like a drop of the light: the app's token, no Origin.
  assert.match(server, /func light\(_ body: \[String: Any\]\) \{ send\("\/api\/computer\/event", body\) \}/);
  assert.equal(/** @type {any} */ (cleanPoint({ found: true, light: true, id: 'abcdef0123456789', debug: { frame: { x: 1, y: 1, width: 9, height: 9 }, screen: { x: 0, y: 0, width: 100, height: 100 } } })).light, true, 'and the server keeps it on a point answer');
  assert.equal(/** @type {any} */ (cleanPoint({ found: true, debug: { frame: { x: 1, y: 1, width: 9, height: 9 }, screen: { x: 0, y: 0, width: 100, height: 100 } } })).light, undefined);
});

test('the light shows a hard target longer, comes round again when the mouse goes elsewhere, and a waiting caption stays', () => {
  const pointer = swift('Pointer.swift');
  assert.match(pointer, /let how = PearlMath\.show\(local, rivals: AXFinder\.rivals\(beside: target\)\)\n\s+showLaps = how\.laps\n\s+showFor = pinned \? how\.seconds : 0\.7/);
  assert.match(pointer, /note\(rivals: PearlMath\.rivals\(of: b\.hit\.frame, score: b\.score, among: matched\), beside: b\.hit\.frame\)/, 'the finder counts its close runners-up');
  assert.match(pointer, /\} else if landed\.look\(mouse: mouse, target: showing, now: now, held: hold\.waiting\) \{\n\s+nudge\(now\)/);
  assert.match(pointer, /let watchable = mode == \.out && \(pinned \|\| hold\.waiting\) && !hold\.asking/, 'only while it points something out or waits for you, never mid-step');
  assert.match(body(pointer, '  private func nudge(_ now: CFTimeInterval) {'), /say\(c\.words, light: c\.light, around: c\.around, after: 0, on: screen, avoiding: c\.avoiding\)/, 'the caption comes back');
  assert.match(pointer, /!PearlMath\.captionStays\(waiting: self\.hold\.waiting, intent: self\.intent\) else \{ return \}\n[^\n]*\n[^\n]*\n\s+self\.hush\(\)/, '"Your turn" and "Is this OK?" do not fade while the light waits');
  for (const said of ['a small one: once more round, 3 to 4 seconds', 'the mouse went and rested somewhere else: point again', 'not again within 12 seconds', "a waiting light's caption stays; a step's fades"]) assert.ok(checks.includes(said), `checked in Swift: ${said}`);
});
