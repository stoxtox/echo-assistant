// Whose voice is it? The owner sits at the Mac; a phone on the desk, a call in the next room or a
// TV is much quieter at the mic. In one 7-minute session on Oct 2, 6 of 20 clips were a phone:
// whole-clip loudness (rms) 0.005-0.009 against the owner's 0.047-0.076, 160-1,140 ms of voiced
// sound, and every one was delivered because it fell inside the follow-up window.
//
// The level compared and learned is that of the clip's VOICED frames (lib/heard.js wavStats
// voicedRms), not the whole clip: a hands-free clip ends with about a second of quiet and a
// push-to-talk clip doesn't, so the same voice read several dB lower hands-free and the owner was
// taken for the room.
//
// So Echo keeps a running estimate of how loud its owner usually is, learned only from clips that
// were certainly theirs (push-to-talk, "Hey Echo", or a sentence with Echo's name in it), and a
// hands-free clip far below that level is not taken as said to Echo. Push-to-talk is never judged
// by this. Until a few certain clips have been heard there's no estimate, and nothing changes.
//
// Only numbers are kept (data/voice-level.json): never audio, never words.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic.js';

/**
 * A clip this far (dB) below the owner's usual level is someone or something else. The phone
 * clips were 14 dB or more below the owner's quietest sentence; 12 leaves room for the owner
 * leaning back or turning away (halving the level is 6 dB).
 */
export const OWNER_MARGIN_DB = 12;
/**
 * Less voiced sound than this (ms) with no name, no answer and no command in it is a blip from the
 * room, not a sentence to Echo: four of the six phone clips were under it.
 */
export const BRIEF_VOICED_MS = 600;
/** The estimate counts once this many certain clips have been heard: one clip is not a habit. */
export const OWNER_MIN_CLIPS = 3;
/** The estimate is the middle of the newest this-many certain clips, so it follows a moved mic within a day's use. */
export const OWNER_KEEP = 15;
/** A certain clip teaches the level only with at least this much voiced sound: a tapped key says nothing about a voice. */
export const LEARN_MIN_VOICED_MS = 400;
/** Within this (dB) of the owner's usual level is "at the owner's level": leaning back halves it (6 dB). */
export const OWNER_NEAR_DB = 6;

const FILE = 'voice-level.json';
/** Levels saved before this were whole-clip loudness, which can't be compared with voiced-frame loudness: they are learned again. */
const VERSION = 2;

/** Loudness (rms, 0..1) in dB. */
export const levelDb = (rms) => 20 * Math.log10(Math.max(Number(rms) || 0, 1e-5));

/**
 * The owner's usual level (dB): the median of the certain clips kept, or null with too few.
 * The median, so one shout or one whisper doesn't move it.
 * @param {number[]} levels dB values, oldest first
 * @returns {number | null}
 */
export function ownerLevelDb(levels) {
  const l = (levels || []).filter((x) => Number.isFinite(x));
  if (l.length < OWNER_MIN_CLIPS) return null;
  const s = [...l].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return +(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(1);
}

/**
 * What a clip's sound says against it being the owner: 'faint' (far below the owner's level),
 * 'brief' (too little voiced sound to be a sentence), or null. Null too with no estimate yet or
 * nothing measured, so Echo behaves as it did before.
 * @param {{ level?: number, voicedMs?: number } | null | undefined} clip level: rms of its voiced frames (lib/heard.js wavStats voicedRms)
 * @param {number | null | undefined} ownerDb
 * @returns {'faint' | 'brief' | null}
 */
export function notTheOwner(clip, ownerDb) {
  if (!clip || typeof ownerDb !== 'number' || !Number.isFinite(ownerDb)) return null;
  if (typeof clip.level === 'number' && clip.level > 0 && levelDb(clip.level) < ownerDb - OWNER_MARGIN_DB) return 'faint';
  if (typeof clip.voicedMs === 'number' && clip.voicedMs < BRIEF_VOICED_MS) return 'brief';
  return null;
}

/**
 * Is the clip about as loud as the owner usually is (not just "not faint")? False with no
 * estimate or nothing measured: then nothing is known either way.
 * @param {{ level?: number } | null | undefined} clip @param {number | null | undefined} ownerDb
 */
export function atOwnerLevel(clip, ownerDb) {
  if (!clip || typeof ownerDb !== 'number' || !Number.isFinite(ownerDb)) return false;
  return typeof clip.level === 'number' && clip.level > 0 && levelDb(clip.level) >= ownerDb - OWNER_NEAR_DB;
}

/**
 * Too soft or too short to stand, on its own, as a yes to something that can't be undone: a clip
 * below the owner's usual level by more than OWNER_NEAR_DB, or a blip under BRIEF_VOICED_MS that
 * isn't at their level either. Never a held key (their own say-so), and never when nothing is
 * known about how loud the owner is.
 * @param {{ level?: number, voicedMs?: number } | null | undefined} clip @param {number | null | undefined} ownerDb @param {string} [mode]
 */
export function softSpoken(clip, ownerDb, mode = '') {
  if (mode === 'push-to-talk' || !clip || typeof ownerDb !== 'number' || !Number.isFinite(ownerDb)) return false;
  if (typeof clip.level !== 'number' || !(clip.level > 0)) return false;
  return !atOwnerLevel(clip, ownerDb);
}

/**
 * The estimate, kept in the data folder. One per mic (the window's and the Mac app's own are
 * different microphones with different gain, so a level learned on one says nothing about the other).
 * @param {string} dataDir
 */
export function voiceLevels(dataDir) {
  const file = path.join(dataDir, FILE);
  /** @type {Record<string, number[]>} */
  let mics = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.v === VERSION) for (const [k, v] of Object.entries(saved.mics || {})) if (Array.isArray(v)) mics[k] = v.filter((x) => Number.isFinite(x)).slice(-OWNER_KEEP);
  } catch {}
  return {
    /** The owner's usual level on this mic (dB), or null with no estimate yet. @param {string} mic */
    ownerDb: (mic) => ownerLevelDb(mics[mic] || []),
    /**
     * A clip that was certainly the owner's. Returns whether it was counted.
     * @param {string} mic @param {{ voicedRms?: number, voicedMs?: number }} stats lib/heard.js wavStats
     */
    learn(mic, stats) {
      if (!stats || !(stats.voicedRms > 0) || !(stats.voicedMs >= LEARN_MIN_VOICED_MS)) return false;
      mics[mic] = [...(mics[mic] || []), +levelDb(stats.voicedRms).toFixed(1)].slice(-OWNER_KEEP);
      try {
        writeFileAtomic(file, JSON.stringify({ v: VERSION, mics }), { backup: false });
      } catch {}
      return true;
    },
  };
}
