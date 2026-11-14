// The loading and "couldn't start" screen, drawn in Echo's own look: black, the three bars.
import Foundation

enum StatusPage {
  static func escape(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
  }

  static func html(title: String, detail: String, retry: Bool, busy: Bool) -> String {
    let buttons = retry
      ? """
        <div class="actions">
          <button onclick="post('retry')">Try again</button>
          <button class="soft" onclick="post('openLog')">Show log</button>
        </div>
        """
      : ""
    return """
      <!doctype html><html><head><meta charset="utf-8"><style>
        :root { color-scheme: dark; --bg: #000000; --ink: #F5F5F5; --muted: #8E8E96; }
        html, body { height: 100%; margin: 0; background: var(--bg); color: var(--ink);
          font: 15px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; -webkit-user-select: none; cursor: default; }
        body { display: grid; place-items: center; }
        main { text-align: center; max-width: 440px; padding: 24px; animation: in .5s ease both; }
        svg { width: 96px; height: 96px; filter: drop-shadow(0 0 18px rgba(168,102,255,.35)); }
        .busy rect { animation: pulse 1.6s ease-in-out infinite; }
        .busy rect:nth-of-type(2) { animation-delay: .2s; }
        .busy rect:nth-of-type(3) { animation-delay: .4s; }
        h1 { font-size: 20px; font-weight: 600; letter-spacing: -.01em; margin: 22px 0 6px; }
        p { color: var(--muted); margin: 0; white-space: pre-line; }
        .actions { margin-top: 22px; display: flex; gap: 10px; justify-content: center; }
        button { font: inherit; font-weight: 600; border: 0; border-radius: 999px; padding: 8px 18px; cursor: pointer;
          color: #000000; background: #F5F5F5; }
        button.soft { background: transparent; color: var(--muted); box-shadow: inset 0 0 0 1px rgba(142,142,150,.35); }
        @keyframes pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
        @keyframes in { from { opacity: 0; transform: translateY(4px); } }
      </style></head><body><main>
        <svg viewBox="0 0 64 64" class="\(busy ? "busy" : "")">
          <defs><linearGradient id="g" x1="12" y1="0" x2="30" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#4780FF"/><stop offset=".33" stop-color="#A866FF"/><stop offset=".67" stop-color="#FF669E"/><stop offset="1" stop-color="#FFB866"/></linearGradient></defs>
          <rect x="12" y="12" width="40" height="10" rx="5" fill="currentColor"/>
          <rect x="12" y="27" width="28" height="10" rx="5" fill="currentColor" opacity=".45"/>
          <rect x="12" y="42" width="18" height="10" rx="5" fill="url(#g)"/>
        </svg>
        <h1>\(escape(title))</h1>
        <p>\(escape(detail))</p>
        \(buttons)
      </main><script>
        function post(type) { window.webkit.messageHandlers.echoApp.postMessage({ type }); }
      </script></body></html>
      """
  }
}
