// Talking, once there is a conversation: nothing takes the window over. Your words appear as the
// next bubble in the thread while you say them (a gradient outline, the newest words grey until
// they settle), the companion stays small beside "Listening", and the message box says what the
// key does. On the empty Home screen your words are still shown large (style.css, Home).
//
// It follows what is already on the page: the live caption's words (public/livecaption.js) and
// the mic button's `listening` class. Nothing in app.js tells it what to do.

/** The newest words, still being worked out by the recognizer, are shown grey. */
export const UNSETTLED_WORDS = 2;

/**
 * The live bubble's words: settled ones, then the last few as unsettled.
 * @param {string} text
 * @returns {{ settled: string, unsettled: string }}
 */
export function bubbleParts(text) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= UNSETTLED_WORDS) return { settled: '', unsettled: words.join(' ') };
  return { settled: words.slice(0, -UNSETTLED_WORDS).join(' '), unsettled: words.slice(-UNSETTLED_WORDS).join(' ') };
}

/**
 * What the message box says while Echo is listening ('' when it isn't, or on Home).
 * @param {{ listening: boolean, inConversation: boolean, handsFree: boolean }} s
 */
export function listeningHint({ listening, inConversation, handsFree }) {
  if (!listening || !inConversation) return '';
  return handsFree ? 'Listening…' : 'Release Space to send · Esc to cancel';
}

/**
 * @param {{ transcript: HTMLElement, live: HTMLElement, mic: HTMLElement, input: HTMLTextAreaElement, chatEmpty: HTMLElement, handsFree: HTMLInputElement, scrollDown?: () => void }} els
 */
export function createTalkView({ transcript, live, mic, input, chatEmpty, handsFree, scrollDown = () => {} }) {
  const words = /** @type {HTMLElement} */ (live.querySelector('.live-words'));
  const idle = input.placeholder;
  /** @type {HTMLElement | null} */
  let bubble = null;

  function sync() {
    const inConversation = Boolean(chatEmpty.hidden);
    const text = live.dataset.mode === 'caption' ? String(words.textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (inConversation && text) {
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.className = 'msg you live-bubble';
        bubble.setAttribute('aria-hidden', 'true'); // the words are announced once, when they are sent
      }
      // Always the last thing in the thread, whatever was added meanwhile.
      if (transcript.lastElementChild !== bubble) transcript.append(bubble);
      const { settled, unsettled } = bubbleParts(text);
      const now = `${settled}\u0000${unsettled}`;
      if (bubble.dataset.now !== now) {
        bubble.dataset.now = now;
        const em = document.createElement('em');
        em.textContent = unsettled;
        bubble.replaceChildren(settled ? `${settled} ` : '', em);
        scrollDown();
      }
    } else if (bubble) {
      bubble.remove();
      bubble = null;
    }
    const listening = mic.classList.contains('listening') || Boolean(text);
    const hint = listeningHint({ listening, inConversation, handsFree: handsFree.checked });
    const want = hint || idle;
    if (input.placeholder !== want) input.placeholder = want;
  }

  const watch = new MutationObserver(sync);
  watch.observe(live, { attributes: true, attributeFilter: ['data-mode'], childList: true, subtree: true, characterData: true });
  watch.observe(mic, { attributes: true, attributeFilter: ['class'] });
  watch.observe(chatEmpty, { attributes: true, attributeFilter: ['hidden'] });
  // A real message arrived under the live bubble: the bubble goes back to the end (or away).
  new MutationObserver(() => { if (bubble && transcript.lastElementChild !== bubble) sync(); }).observe(transcript, { childList: true });
  sync();
  return { sync };
}
