// Screen awareness in the page (lib/screen.js has the privacy rules).
//
// In the Mac app, Echo's look and point requests go straight to the app (the "echoApp" message
// handler); it captures, reads the text and blacks out secrets on this Mac, then answers Echo's
// server itself. In a plain browser there's no app, so a look shows a card: you pick what to
// share, see the picture, and only then is it sent (the browser can't read text or black out
// secrets). Pointing needs the Mac app, except inside Echo's own page (the first-run demo).

/** The Mac app's message handler, or null in a plain browser. */
export const nativeApp = () => /** @type {any} */ (window).webkit?.messageHandlers?.echoApp || null;
/** @param {object} msg */
export const toApp = (msg) => nativeApp()?.postMessage(msg);

/** Biggest side of a shared picture, in pixels (about what the model reads well). */
const MAX_EDGE = 1600;

/**
 * @param {{ addNode: (node: HTMLElement) => void, toast: (text: string) => void, send: (msg: object) => void }} deps
 */
export function createScreenClient({ addNode, toast, send }) {
  /** @type {Map<string, { looking?: boolean, card?: HTMLElement, stream?: MediaStream, timer?: any }>} */
  const pending = new Map();
  let pill = null;

  /** A small "Looking" chip at the top of the page while a look is under way (the driving chip
   *  takes its place while Echo drives, so one state shows at a time). */
  function showPill(on) {
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'look-pill';
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-label', 'Echo is looking at your screen');
      pill.innerHTML = '<i aria-hidden="true"></i><span>Looking</span>';
      document.body.append(pill);
    }
    pill.classList.toggle('on', on);
  }
  const syncPill = () => showPill([...pending.values()].some((p) => p.looking));
  /** A look is over within two tries of 6 s (lib/screen.js): a chip still up after this has missed its screen_done. */
  const LOOK_CHIP_MS = 15000;
  /** The chip for one look, with its own end: it never outlives the look. */
  function looking(id) {
    pending.set(id, { looking: true, timer: setTimeout(() => done(id), LOOK_CHIP_MS) });
    syncPill();
  }
  /**
   * A new turn starts (or the line to the server came back): no look from before is still under
   * way, so the chip goes. (On Oct 3 "Looking" stayed up after the look had finished.) A share
   * card waiting for an answer in a plain browser stays.
   */
  function clearLooks() {
    for (const [id, p] of pending) if (p.looking) done(id);
  }

  /** A request from Echo (server message screen_request). */
  function request(r) {
    if (r.notice) {
      // The Mac app got this one straight from Echo: only the chip shows here.
      if (r.kind === 'look') looking(r.id);
      return;
    }
    if (nativeApp()) {
      // The app does the work and answers the server itself.
      if (r.kind === 'look') looking(r.id);
      else pending.set(r.id, { looking: false });
      toApp({ type: 'screen', id: r.id, kind: r.kind, params: r.params || {} });
      return;
    }
    if (r.kind !== 'look') return; // pointing needs the Mac app; the server already said so
    const entry = { looking: false, card: browserCard(r.id) };
    pending.set(r.id, entry);
    addNode(entry.card);
  }

  /** The request was answered (by this page or another one), or gave up. */
  function done(id) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.stream?.getTracks().forEach((t) => t.stop());
    p.card?.classList.add('settled');
    p.card?.querySelectorAll('button').forEach((b) => (b.disabled = true));
    syncPill();
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  /** The browser's "share your screen" card: pick, preview, then send or not. */
  function browserCard(id) {
    const card = el('div', 'msg screen-card');
    const title = el('strong', '', 'Echo wants to look at your screen');
    const text = el('p', '', "Pick the screen or window to share. You'll see the picture before anything is sent, and it isn't saved.");
    const actions = el('div', 'screen-card-actions');
    const share = el('button', 'small', 'Share screen once');
    const no = el('button', 'ghost small', 'No thanks');
    share.type = no.type = 'button';
    actions.append(share, no);
    card.append(title, text, actions);
    no.onclick = () => {
      send({ type: 'screen_cancel', id });
      done(id);
    };
    share.onclick = async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch {
        toast('Screen sharing was cancelled.');
        return;
      }
      const p = pending.get(id);
      if (!p) return stream.getTracks().forEach((t) => t.stop());
      p.stream = stream;
      let shot;
      try {
        shot = await grabFrame(stream);
      } finally {
        stream.getTracks().forEach((t) => t.stop());
      }
      if (!shot || !pending.has(id)) return;
      const img = el('img', 'screen-preview');
      img.alt = 'The picture Echo would see';
      /** @type {HTMLImageElement} */ (img).src = shot.url;
      const send1 = el('button', 'small', 'Send to Echo');
      const keep = el('button', 'ghost small', "Don't send");
      send1.type = keep.type = 'button';
      text.textContent = 'This is what Echo would see. Check nothing private is showing.';
      actions.replaceChildren(send1, keep);
      card.insertBefore(img, actions);
      keep.onclick = () => {
        send({ type: 'screen_cancel', id });
        done(id);
      };
      send1.onclick = async () => {
        send1.disabled = keep.disabled = true;
        try {
          await fetch('/api/screen/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, source: 'browser', image: shot.base64, mime: 'image/jpeg', width: shot.width, height: shot.height }),
          });
        } catch {
          toast("Couldn't send the picture to Echo.");
        }
        img.remove(); // not kept in the page either
        done(id);
      };
    };
    return card;
  }

  return { request, done, clearLooks };
}

/**
 * One frame from a screen-share stream, shrunk to MAX_EDGE, as a JPEG.
 * @param {MediaStream} stream
 */
export async function grabFrame(stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  await new Promise((r) => (video.readyState >= 2 ? r(null) : video.addEventListener('loadeddata', () => r(null), { once: true })));
  const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
  video.pause();
  video.srcObject = null;
  const url = canvas.toDataURL('image/jpeg', 0.75);
  return { url, base64: url.slice(url.indexOf(',') + 1), width, height };
}

/**
 * Point at something in Echo's own page: the Mac app's companion orb when there is one, otherwise
 * the same pearl drawn in the page. Never clicks.
 * @param {Element} target
 * @param {string} [label]
 */
export function pointAtElement(target, label = '') {
  const r = target.getBoundingClientRect();
  if (nativeApp()) {
    toApp({ type: 'pointAtPage', label, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    return;
  }
  document.querySelectorAll('.page-pointer, .page-ring').forEach((n) => n.remove());
  const ring = document.createElement('div');
  ring.className = 'page-ring';
  Object.assign(ring.style, { left: `${r.left - 8}px`, top: `${r.top - 6}px`, width: `${r.width + 16}px`, height: `${r.height + 12}px` });
  const pointer = document.createElement('div');
  pointer.className = 'page-pointer';
  pointer.setAttribute('aria-hidden', 'true');
  pointer.innerHTML = `<i class="page-orb"></i>${label ? `<span></span>` : ''}`;
  if (label) /** @type {HTMLElement} */ (pointer.querySelector('span')).textContent = label;
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  // It drifts over from the corner; with reduced motion it fades in where it's pointing instead.
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  pointer.style.transform = still ? `translate(${x}px, ${y}px)` : `translate(${innerWidth - 60}px, ${innerHeight - 60}px)`;
  document.body.append(ring, pointer);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      pointer.style.transform = `translate(${x}px, ${y}px)`;
      ring.classList.add('on');
    })
  );
  setTimeout(() => {
    pointer.classList.add('out');
    ring.classList.add('out');
    setTimeout(() => { pointer.remove(); ring.remove(); }, 450);
  }, 5000);
}
