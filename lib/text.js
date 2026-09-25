import path from 'node:path';
import { config } from './config.js';

/** Current local date/time, e.g. "Thursday, September 24, 2026, 10:04 PM EDT". */
export function nowString(date = new Date(), timeZone = config.timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/** Replace things that sound bad aloud: markdown, URLs, file paths. */
export function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/g, '$1') // markdown links -> label
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/(?:~|\.{1,2})?\/(?:[\w.@-]+\/)+([\w.@-]+)/g, (_, base) => base) // /a/b/file.md -> file.md
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_#>|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shorten to at most maxChars without ever cutting a sentence in half. */
export function trimToSentences(text, maxChars = 420) {
  const clean = String(text || '').trim();
  if (clean.length <= maxChars) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]?(\s+|$)|[^.!?]+$/g) || [clean];
  let out = '';
  for (const s of sentences) {
    if ((out + s).trim().length > maxChars) break;
    out += s;
  }
  if (out.trim()) return out.trim();
  // A single giant sentence: cut at a word boundary and close it cleanly.
  return clean.slice(0, maxChars).replace(/[,;:\s]+\S*$/, '') + '…';
}

/** A worker's final message turned into something short and pleasant to read aloud. */
export function spokenSummary(text, maxChars = 420) {
  return trimToSentences(speakable(text), maxChars);
}

export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'research';

export const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Boilerplate the dispatcher puts at the start of worker instructions.
const BOILERPLATE = /^(tiny|small|quick)( writing| web)?( task| research)?\b|^(this is|it's) (quick web research|a research task|research|not coding)|^research task|^(use|do all searching|search) .*(websearch|webfetch|yourself)|^web search and web fetch|^(plain )?curl|^(don'?t|do not|never|only touch|use this folder|keep (it|your)|save (the|all|everything)|done means|report back)\b|^(a previous attempt|another worker|today is|context:|candidate:)|^read .* for context|^the user (lives|is|has explicitly asked|heard)/i;

/** A short, readable title from a worker instruction, e.g. "Convert the jobs list into an Excel spreadsheet". */
export function shortTitle(instruction, max = 64) {
  const sentences = String(instruction || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?:])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let s = sentences.find((x) => !BOILERPLATE.test(x)) || sentences[0] || 'Task';
  s = speakable(s)
    .replace(/^the user (wants|would like|needs) (you )?(to )?/i, '')
    .replace(/^(please|can you|could you) /i, '')
    .replace(/\b[\w.-]+\/([\w.-]+\.\w{2,5})\b/g, '$1') // job-search/list.md -> list.md
    .replace(/\s+(in|from|to) this folder\b/gi, '')
    .replace(/[.:!?]+$/, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/[,;:\s]+\S*$/, '') + '…';
}

/**
 * Plain words for errors a new user can act on. Claude Code that isn't signed in (or isn't
 * installed) fails in confusing ways, sometimes as "failed to launch".
 */
export function friendlyError(message) {
  const m = String(message || '');
  if (/not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth|401\b|credit balance|failed to launch|does not match this system|ENOENT.*claude|claude.*not found/i.test(m)) {
    return "Echo can't reach Claude yet. Make sure Claude Code is installed and signed in: open Terminal, type claude, press Return, and follow the sign-in steps (you need your own Claude subscription). Then restart Echo.";
  }
  if (/rate limit|usage limit|overloaded|529\b|429\b/i.test(m)) return "Claude is busy or you've hit your plan's usage limit for now. Try again in a little while.";
  return m;
}
