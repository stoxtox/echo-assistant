// The loading and "couldn't start" screen, drawn in Echo's own look: graphite, the sunset mark.
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
        :root { color-scheme: dark light; --bg: #0E0D10; --ink: #F5F1EC; --muted: #A39E99; }
        @media (prefers-color-scheme: light) { :root { --bg: #FAF7F2; --ink: #1E1B21; --muted: #6E6873; } }
        html, body { height: 100%; margin: 0; background: var(--bg); color: var(--ink);
          font: 15px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; -webkit-user-select: none; cursor: default; }
        body { display: grid; place-items: center; }
        main { text-align: center; max-width: 440px; padding: 24px; animation: in .5s ease both; }
        svg { width: 96px; height: 96px; filter: drop-shadow(0 0 18px rgba(255,122,89,.35)); }
        .busy path { animation: pulse 1.6s ease-in-out infinite; }
        .busy path:nth-child(2) { animation-delay: .2s; }
        .busy path:nth-child(3) { animation-delay: .4s; }
        h1 { font-size: 20px; font-weight: 600; letter-spacing: -.01em; margin: 22px 0 6px; }
        p { color: var(--muted); margin: 0; white-space: pre-line; }
        .actions { margin-top: 22px; display: flex; gap: 10px; justify-content: center; }
        button { font: inherit; font-weight: 600; border: 0; border-radius: 999px; padding: 8px 18px; cursor: pointer;
          color: #0E0D10; background: linear-gradient(135deg, #FF6A5B, #FF9F43); }
        button.soft { background: transparent; color: var(--muted); box-shadow: inset 0 0 0 1px rgba(163,158,153,.35); }
        @keyframes pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
        @keyframes in { from { opacity: 0; transform: translateY(4px); } }
      </style></head><body><main>
        <svg viewBox="0 0 64 64" fill="none" stroke="url(#g)" stroke-width="4.5" stroke-linecap="round" class="\(busy ? "busy" : "")">
          <defs><linearGradient id="g" x1="10" y1="52" x2="54" y2="12" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#FF6A5B"/><stop offset="1" stop-color="#FF9F43"/></linearGradient></defs>
          <path d="M27 32H43A8 8 0 1 0 41.13 37.14"/>
          <path d="M46.89 21.29A16 16 0 1 0 46.89 42.71" opacity=".72"/>
          <path d="M53.39 16.57A24 24 0 1 0 53.39 47.43" opacity=".44"/>
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
