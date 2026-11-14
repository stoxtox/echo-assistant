# 0001. Swift body, TypeScript mind, web view; no rewrite

*Accepted, October 2026.*

## Context

Echo is about 18,000 lines of JavaScript (the mind: turns, model calls, tools, computer use,
memory), a Swift Mac app (the body: mic, Accessibility, screen, pointer) and a web page (the view).
The core is being rebuilt so it listens properly, talks back well and makes very few mistakes for
many users. The question: is the language and architecture right, or should it move?

## Decision

- **Swift stays the body, and gets more of it.** Only Swift has first-class access to
  AVAudioEngine echo cancellation, SpeechAnalyzer, CoreML/MLX, Accessibility and ScreenCaptureKit.
  All audio input and output moves there.
- **The mind moves from JavaScript to TypeScript, gradually and strictly.** New modules are `.ts`
  (`tsconfig.json`: strict, erasable syntax only). Node 22.18+ runs them directly, with no build
  step, so self-improve, tests and the updater keep working unchanged. Old `.js` files convert as
  they are split.
- **The web page stays the view, and only the view.** It stops capturing and playing audio and
  stops relaying commands between the server and the Mac app.
- **Node 22.18 is the minimum** (`lib/nodeversion.js`), checked by the launcher, the installers,
  `package.json` engines and the updater (an update that needs a newer Node is refused with a
  clear message instead of failing to start).

## Considered

- *Rewrite in Swift*: one language and process, but months of rewriting working logic, a thin
  agent ecosystem, compile-and-rebuild for every change, and self-improve would break.
- *Rust or Tauri*: fast and safe, slow to build in; the mind isn't CPU-bound.
- *Python*: the ML Echo needs runs on-device in Swift; packaging Python for thousands of Macs is
  painful.
- *A speech-to-speech model as the core*: weaker tool use and control, $0.06–0.10 a minute.

## Consequences

- Echo needs Node 22.18 or newer; older installs are told how to update.
- Only erasable TypeScript: no `enum`, `namespace` or constructor parameter properties.
- Imports of TypeScript modules name the `.ts` file (`import { flagOn } from './flags.ts'`).
- Follow-ups in the core plan: the Mac app talks to the mind directly over a typed channel
  (not through the page), a typed event spine with trace ids, SQLite for state, and a provider
  interface that splits real-time roles from coding workers.
