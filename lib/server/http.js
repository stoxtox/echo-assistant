// The small HTTP pieces the server's routes share (split out of server.js): reading a request,
// answering with JSON, the origin check, and the page's own files.
import fs from 'node:fs';
import path from 'node:path';
import { config, APP_DIR } from '../config.js';

const PUBLIC = path.join(APP_DIR, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const ALLOWED_ORIGINS = new Set([`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);
// Blocks other websites open in your browser from driving Echo.
/** @param {import('node:http').IncomingMessage} req */
export const originOk = (req) => !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin);

/** @param {import('node:http').IncomingMessage} req @returns {Promise<any>} */
export const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
/** @param {import('node:http').IncomingMessage} req @returns {Promise<Buffer>} */
export const readBody = (req, limit = 15 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) reject(new Error('Upload too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
/** @param {import('node:http').ServerResponse} res @param {unknown} data */
export const sendJson = (res, data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

/** A URI-encoded JSON request header, or undefined. @param {import('node:http').IncomingMessage} req @param {string} name */
export function headerJson(req, name) {
  try {
    const v = req.headers[name];
    return typeof v === 'string' && v ? JSON.parse(decodeURIComponent(v)) : undefined;
  } catch {
    return undefined;
  }
}

/** One of the page's own files (public/), or 404. @param {import('node:http').ServerResponse} res @param {URL} url */
export function serveStatic(res, url) {
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  // A folder (/ui/) isn't a file: reading it as one threw with nothing to catch it, and the server went down.
  let isFile = false;
  try {
    isFile = file.startsWith(PUBLIC) && fs.statSync(file).isFile();
  } catch {}
  if (!isFile) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file))] || 'application/octet-stream' });
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}
