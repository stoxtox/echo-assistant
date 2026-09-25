// Images you attach in the chat (paste, drag and drop, or the paperclip).
//
// The page shrinks each image (about 1600px on the long edge, under 1.5MB) and uploads it on its
// own; the message then names the uploads by id. They're saved in the research folder under
// attachments/<date>/, so the dispatcher can see them (as image content blocks) and hand their
// paths to workers, who may read them without asking.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

/** Hard limit per image on the server; the page aims for 1.5MB. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** At most this many images per message. */
export const MAX_IMAGES_PER_MESSAGE = 6;

const TYPES = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/gif': { ext: 'gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(TYPES).map(([mime, t]) => [t.ext, mime]));
// <date>/<time>-<random>.<ext>: nothing a caller sends can point outside the folder.
const ID = /^(\d{4}-\d{2}-\d{2})\/(\d{6}-[0-9a-f]{8})\.(jpg|png|gif|webp)$/;

export const attachmentsDir = () => config.attachmentsDir;

/**
 * Save one uploaded image.
 * @param {Buffer} data
 * @param {string} mime the Content-Type it was sent with
 * @returns {{ id: string, path: string, url: string, mime: string, bytes: number }}
 */
export function saveAttachment(data, mime) {
  const type = TYPES[String(mime || '').split(';')[0].trim().toLowerCase()];
  if (!type) throw new Error('Only JPEG, PNG, GIF or WebP images can be attached.');
  if (!data?.length) throw new Error('The image is empty.');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('The image is too large.');
  if (!type.magic(data)) throw new Error("That file isn't the image type it claims to be.");
  const d = new Date();
  const day = d.toLocaleDateString('en-CA', { timeZone: config.timezone });
  const time = d.toLocaleTimeString('en-GB', { timeZone: config.timezone, hour12: false }).replace(/:/g, '');
  const id = `${day}/${time}-${randomBytes(4).toString('hex')}.${type.ext}`;
  const file = path.join(attachmentsDir(), id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return { id, path: file, url: attachmentUrl(id), mime: MIME_BY_EXT[type.ext], bytes: data.length };
}

export const attachmentUrl = (id) => `/api/attachments/${id}`;

/**
 * A saved image by id, or null if the id is malformed or the file is gone.
 * @param {unknown} id
 * @returns {{ id: string, path: string, url: string, mime: string } | null}
 */
export function findAttachment(id) {
  const m = typeof id === 'string' && id.match(ID);
  if (!m) return null;
  const file = path.join(attachmentsDir(), id);
  if (!fs.existsSync(file)) return null;
  return { id, path: file, url: attachmentUrl(id), mime: MIME_BY_EXT[m[3]] };
}

/**
 * The attachments a message names, in order: unknown ids are dropped, repeats and extras too.
 * @param {unknown} ids
 */
export function resolveAttachments(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id) || out.length >= MAX_IMAGES_PER_MESSAGE) continue;
    seen.add(id);
    const a = findAttachment(id);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Image content blocks for the model (base64), one per attachment.
 * @param {Array<{ path: string, mime: string }>} images
 */
export function imageBlocks(images) {
  return images.map((img) => ({
    type: /** @type {const} */ ('image'),
    source: { type: /** @type {const} */ ('base64'), media_type: img.mime, data: fs.readFileSync(img.path).toString('base64') },
  }));
}
