// Does a reply of Echo's open with a plain yes or no? Its light, when it is out, nods or shakes with
// it (the Mac app, Pointer.moment). Only the first word or two count: "No worries" and "Right, so the
// file is open" are neither, and are left alone by asking for a break after the word.

/** @param {unknown} text @returns {'yes' | 'no' | ''} */
export function yesOrNo(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[’‘]/g, "'");
  if (/^(?:yes|yep|yeah|yup|of course|exactly|correct|absolutely)(?:[,.!]|$|\s)/.test(t)) return 'yes';
  if (/^(?:no|nope)(?:[,.!]|$)|^(?:not quite|not yet|i'm afraid not|unfortunately not)\b/.test(t)) return 'no';
  return '';
}
