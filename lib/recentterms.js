// Words the recognizers should expect right now, taken from the conversation itself: the names
// Echo has just been saying ("Lumora Studio", "Cali Trip", "Adobe Stock") and the vocabulary of
// the app in use ("pivot table" in Excel). On Oct 4, 2026 a folder Echo had named five times was
// heard as "lemon X" and "luminous", and "pivot tables" as "pi tables", because neither
// recognizer had ever been told those words (lib/vocab.js only knew projects, contacts and apps).
//
// Kept in memory only (nothing is written), newest last, and small: a long list dilutes the bias.
import { isEnglishWord } from './vocab.js';

/** The most names kept from the conversation. */
export const RECENT_MAX = 40;
/** A name falls out after this long without being said again. */
export const RECENT_TTL_MS = 60 * 60 * 1000;

/** What people say when they work in an app, which a recognizer splits or mishears when it isn't expecting it. */
export const APP_TERMS = {
  'Microsoft Excel': ['pivot table', 'PivotTable', 'worksheet', 'workbook', 'formula', 'cell', 'column', 'row', 'AutoSum', 'VLOOKUP', 'conditional formatting', 'freeze panes', 'filter', 'chart'],
  Numbers: ['pivot table', 'spreadsheet', 'formula', 'cell', 'column', 'row', 'chart'],
  'Adobe XD': ['artboard', 'rectangle', 'ellipse', 'repeat grid', 'prototype', 'component', 'layer', 'padding'],
  Figma: ['frame', 'auto layout', 'component', 'variant', 'layer', 'prototype', 'constraints'],
  Preview: ['zoom in', 'zoom out', 'contact sheet', 'thumbnail', 'markup'],
  Messages: ['iMessage', 'text message', 'SMS', 'not delivered', 'try again'],
  Finder: ['folder', 'Desktop', 'Downloads', 'Documents', 'AirDrop', 'Quick Look'],
  'Google Chrome': ['tab', 'bookmark', 'address bar', 'upload', 'submit'],
  Safari: ['tab', 'bookmark', 'address bar', 'upload', 'submit'],
};

/** Words that start a sentence or a reply and are capitalized for that reason only. */
const NOT_A_NAME = /^(?:I|I'm|I'll|I've|I'd|The|A|An|It|It's|That|That's|This|These|Those|There|Here|You|Your|We|He|She|They|Yes|No|Okay|Ok|Sorry|Want|Should|Do|Did|Done|Now|Then|And|But|So|If|When|What|Which|Who|Where|Why|How|Say|Tell|Let|Still|Once|Next|First|Last|Also|Just|Both|All|Each|One|Two|Three|Sent|Found|Checking|Looking|Opening|Adding|Sending|Clicking|Zooming|Scrolling|Putting|Finding|Closing|Retrying|Resending|Bringing|Too|Can|Could|Would|Will|My|Is|Are|Was|On|In|At|For|To|Of|With|Go|Got|Hit|Pick|Try|Click|Open|Sign|Scroll|Should|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;

/**
 * The names in a piece of Echo's reply: runs of capitalized words that aren't just the start of a
 * sentence ("Stock Ready", "Golden Gate"), and single words no dictionary has ("Luminex",
 * "Shutterstock"). Latin script only; nothing with digits, paths or addresses in it.
 * @param {string} text
 * @returns {string[]}
 */
export function namesIn(text) {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    const k = t.toLowerCase();
    if (t.length < 3 || t.length > 40 || seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (const sentence of String(text || '').split(/(?<=[.!?:…])\s+|\n+/)) {
    const words = sentence.replace(/[“”"()[\]{}*_`—–]/g, ' ').split(/\s+/).filter(Boolean);
    let run = [];
    const flush = () => {
      // A run of one ordinary word is only the way sentences are written; a run of two or more is a name.
      if (run.length >= 2 || (run.length === 1 && !isEnglishWord(run[0].w) && !run[0].first)) add(run.map((r) => r.w).join(' '));
      else if (run.length === 1 && !isEnglishWord(run[0].w)) add(run[0].w);
      run = [];
    };
    words.forEach((raw, i) => {
      const w = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/'s$/, '');
      const ended = /[,;:.!?…]$/.test(raw);
      const ok = /^\p{Lu}[\p{L}'-]*$/u.test(w) && !/[^\p{Script=Latin}'-]/u.test(w) && !NOT_A_NAME.test(w);
      if (ok) run.push({ w, first: i === 0 });
      else flush();
      if (ended) flush();
    });
    flush();
  }
  return out;
}

export class RecentTerms {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    /** @type {Map<string, { term: string, at: number }>} lower-cased term → as written, and when last said */
    this.terms = new Map();
    this.app = '';
  }

  /** Echo said this (a reply, a step's line): its names are expected next. @param {string} text */
  noteReply(text) {
    const at = this.now();
    for (const t of namesIn(text)) {
      this.terms.delete(t.toLowerCase());
      this.terms.set(t.toLowerCase(), { term: t, at });
    }
    while (this.terms.size > RECENT_MAX) this.terms.delete(this.terms.keys().next().value);
  }

  /** The app Echo is working in ('' when none). @param {string} name */
  setApp(name) {
    this.app = String(name || '');
  }

  /** The conversation's names, oldest first (the newest matter most), without the ones that have gone stale. @returns {string[]} */
  names() {
    const cut = this.now() - RECENT_TTL_MS;
    for (const [k, v] of this.terms) if (v.at < cut) this.terms.delete(k);
    return [...this.terms.values()].map((v) => v.term);
  }

  /** Everything to expect right now: the app's own words, then the conversation's names. @returns {string[]} */
  all() {
    return [...(APP_TERMS[this.app] || []), ...this.names()];
  }
}

/** The one list the server keeps (lib/vocab.js reads it for both recognizers). */
export const recentTerms = new RecentTerms();
