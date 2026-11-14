// Looking at the screen and pointing (lib/screen.js, macos/Sources/Screen.swift and Pointer.swift).
// Moved out of the dispatcher unchanged.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { text, fail } from './result.js';
import { getSettings } from '../settings.js';
import { lookContent, cleanRoute, cleanPlace, ROUTE_MAX, ROUTE_LABEL_MAX } from '../screen.js';
import { flagOn } from '../flags.ts';
import { explainerFor, cleanChunks, CHUNKS_MIN, CHUNKS_MAX } from '../explain.js';


/** @param {any} d the dispatcher (lib/dispatcher.js) */
export function screenTools(d) {
  const screen = d.screen;
  // (Made with the tools, so the user's "next" and "stop" reach an explanation from its first chunk.)
  if (screen) explainerFor(d);
  const off = (what) => fail(`${what} is off in Settings. Tell the user they can switch it on in Settings, under Companion.`);
  const needsPermission = (r) => fail(`Permission needed. Tell the user: ${r.message || 'allow Echo in System Settings, Privacy and Security.'}`);
  return [
    tool(
      'look_at_screen',
      "Look at the user's screen, only when they ask about it (\"what's this error?\", \"what am I looking at?\"). Returns the text on screen, read on their Mac with secrets blacked out, and the screenshot itself when include_image is true.",
      {
        include_image: z.boolean().optional().describe('Also return the (redacted) screenshot. Only when the text is not enough: layout, pictures, charts, where something is.'),
        reason: z.string().optional().describe('A few words on why, e.g. "read the error"'),
        marks: z.boolean().optional().describe('Set-of-Marks: number every control in the picture (badge N is ref nN for act). Use when a thing has no clear label.'),
        grid: z.number().int().min(4).max(16).optional().describe('A numbered grid with this many columns, when nothing has a name (a canvas, a game): then click with cell'),
        whole_screen: z.boolean().optional().describe('The whole display, not just the window the user is in: for the menu bar, the Dock or another window'),
      },
      async ({ include_image, reason, marks, grid, whole_screen }) => {
        if (!screen) return fail('Looking at the screen is not available here.');
        if (!getSettings().screenAware) return off('Screen awareness');
        try {
          // Marks: read the controls first, so each badge is a ref act can use.
          const seen = marks && screen.native ? await d.executor.observe({ source: 'native' }) : null;
          // Just the window they're in (the windowCrop flag): a smaller, sharper picture.
          const r = await screen.request('look', { reason: String(reason || '').slice(0, 80), marks: Boolean(marks), grid: grid || 0, ...(flagOn('windowCrop') && !whole_screen ? { window: true } : {}) });
          if (!r.ok) return r.error === 'permission' ? needsPermission(r) : fail(r.message || `Couldn't look at the screen (${r.error}).`);
          if (grid) d.computer.lastGrid = { cols: grid, width: Number(r.look?.width) || 0, height: Number(r.look?.height) || 0 };
          const content = lookContent(r.look, { includeImage: Boolean(include_image || marks || grid) });
          if (seen?.page) content.content.push({ type: 'text', text: `Marks (badge N = ref nN; act on it with act):\n${seen.page}` });
          if (grid) content.content.push({ type: 'text', text: `The grid has ${grid} columns, numbered left to right, top to bottom from 1. Click a cell with click { cell: N }.` });
          return content;
        } catch (e) {
          return fail(e.message);
        }
      }
    ),
    tool(
      'point_at',
      'Point at something on the user\'s screen with Echo\'s pointer (a glowing cursor flies there). It never clicks. Finds the target by its label (button text, menu item, link, field name) in the front app, or at x/y in the last screenshot. For anything inside a menu (the menu bar\'s menus and their submenus, a pop-up or context menu), give route: every label to open in order, ending with the item itself; the pointer then shows the way through the menus instead of a spot that isn\'t on screen yet.',
      {
        target: z.string().optional().describe('The label as it appears on screen, e.g. "Save", "Share", "Wi-Fi". Not needed with route (its last label is the target)'),
        route: z.array(z.string().min(1).max(ROUTE_LABEL_MAX)).min(1).max(ROUTE_MAX).optional().describe('For something inside menus: the labels to open in order, the last one being the target, e.g. ["File", "Export", "PDF…"]. At most 6 short labels, exactly as they appear'),
        app: z.string().optional().describe('The app it is in, if not the front one'),
        x: z.number().optional().describe('Pixel x in the last look_at_screen image, when you found it by eye'),
        y: z.number().optional().describe('Pixel y in the last look_at_screen image'),
        menu_bar: z.boolean().optional().describe('True for menu bar items and status icons: Control Center, Wi-Fi, Bluetooth, Sound, Battery, Focus'),
        also: z.string().optional().describe('A second label in the same app to show at the same time ("this and this"): a second, smaller light goes to it. Only when the user needs to see two things together'),
      },
      async ({ target: named, route: asked, app, x, y, menu_bar, also }) => {
        if (!screen) return fail('Pointing is not available here.');
        const s = getSettings();
        if (!s.pointer) return off('The pointer');
        const { route, error } = cleanRoute(asked);
        if (error) return fail(error);
        // With a route, its last label is the target.
        const target = route ? route[route.length - 1] : named;
        if (!String(target || '').trim()) return fail('Give a target label, or a route.');
        try {
          // intent show: point_at only ever points something out (the light's colour, docs/firefly-protocol.md).
          const r = await screen.request('point', { target: String(target).slice(0, 120), app: app ? String(app).slice(0, 60) : undefined, x, y, menuBar: Boolean(menu_bar), useScreen: s.screenAware, intent: 'show', ...(route ? { route } : {}), ...(also && !route ? { also: String(also).slice(0, 120) } : {}) });
          if (r.ok === false && r.error === 'permission') return needsPermission(r);
          if (r.error === 'no_app' || r.ok === false) return fail(r.message || "Couldn't point.");
          if (!r.found) {
            const note = r.reason === 'scrolled_out_of_view'
              ? `${r.message} Tell the user which way to scroll, then you can point again.`
              : r.message || `Couldn't find "${target}" on screen. Describe where it is instead.`;
            return text({ pointed: false, reason: r.reason || 'not_found', note, debug: r.debug });
          }
          // What Echo pointed at is what "it" means in the user's next words ("delete it").
          // (On a route the light may be resting on an earlier label; the target is still what "it" is.)
          d.computer.noteReferent?.(String(route ? target : r.label || target), String(r.app || app || ''));
          // A route not yet open: the light is on the label to open next and moves on as the user opens each one.
          const onTheWay = route && r.routeIndex !== undefined && r.routeIndex < route.length - 1;
          const note = onTheWay
            ? `The pointer is on "${route[r.routeIndex]}", step ${r.routeIndex + 1} of the route, and moves along it as the user opens each menu. Tell the user the route in a few words (${route.join(', then ')}); you never click yourself.`
            : 'The pointer is on it now. Tell the user to click there; you never click yourself.';
          // (place, container, kind: where it is, so the words can say where first.)
          return text({ pointed: true, found: r.label || target, ...cleanPlace(r), ...(route ? { route, on: route[r.routeIndex ?? route.length - 1] } : {}), via: r.via, app: r.app, note, debug: r.debug });
        } catch (e) {
          return fail(e.message);
        }
      }
    ),
    tool(
      'explain_on_screen',
      'Explain something that is on the user\'s screen by showing it, one small piece at a time (a document, a page, a settings pane, results you just produced). For each chunk in turn Echo brings its part into view, points the light at it, says the one sentence as the light lands, and shows a card in the chat with the outline and this chunk\'s key words large. It never clicks or types. The user can say "next", "back", "again" or "stop" as it goes. It returns when the last chunk has been said or the user ended it, and says which targets it could not find. You say nothing while it runs and do not repeat it afterwards.',
      {
        chunks: z.array(z.object({
          say: z.string().min(1).max(240).describe('ONE spoken sentence about this part, about 20 words at most, in plain words'),
          key: z.string().min(1).max(48).describe('2 to 5 words shown large in the chat as this chunk\'s title, e.g. "Three phases"'),
          target: z.string().max(120).optional().describe('The heading or words exactly as they appear on screen that this chunk is about; the light points there, scrolling it into view first. Leave out when there is nothing to point at'),
        })).min(CHUNKS_MIN).max(CHUNKS_MAX).describe('The pieces in the order to explain them: what the user asked about first'),
        app: z.string().optional().describe('The app it is in, if not the front one'),
        one_by_one: z.boolean().optional().describe('True when the user asked to go "one by one", "point by point" or "step by step", or wants to read along: after each piece Echo waits for their "next" instead of moving on by itself'),
        start_at: z.number().int().min(1).optional().describe('The piece to begin with (1 is the first). Use it to go on from where the user cut in, never from the top again'),
      },
      async ({ chunks: asked, app, one_by_one, start_at }) => {
        if (!screen) return fail('Pointing is not available here.');
        if (d.computer.lesson?.active) return fail('A lesson is running: it explains its own steps. Wait until it ends, or stop it first.');
        const { chunks, error } = cleanChunks(asked);
        if (!chunks) return fail(error);
        try {
          // The walk-through is the thread: its pieces are the list, and it keeps its own place in it.
          d.thread.keep({ doing: 'walking through what is on screen', items: chunks.map((c) => c.key), where: app || '' });
          const r = await explainerFor(d).run(chunks, { app, paced: one_by_one === true, startAt: (start_at || 1) - 1, onMove: (i) => d.thread.keep({ at: i }) });
          if (r.ended === 'finished') d.thread.keep({ done: chunks.map((_, i) => i), at: -1 });
          const missed = r.notFound.length ? ` Not found on screen, so said without pointing: ${r.notFound.map((t) => `"${t}"`).join(', ')}.` : '';
          const note = r.ended === 'stopped'
            ? 'The user stopped it. Say nothing more about it unless they ask.'
            : r.ended === 'interrupted'
              ? `The user said something else during piece ${r.at} of ${r.total}, so the walk-through is paused there (the thread has the place). Their words come as the next message: end this turn now without saying anything. If they then want to go on, call explain_on_screen again with the same pieces and start_at ${Math.min(r.total, r.at + 1)}${one_by_one ? ', one_by_one true' : ''}: never from the top, and never by listing the pieces again.`
              : r.ended === 'waiting'
                ? `Piece ${r.at} of ${r.total} was shown and the user has not said "next" for a few minutes. Say nothing now. When they come back to it, go on with start_at ${Math.min(r.total, r.at + 1)}.`
              : `All said and shown. Do not repeat or sum it up. In a few words, offer the next part if there is more ("Want the next part?").`;
          return text({ explained: r.shown, of: r.total, ended: r.ended, ...(r.notFound.length ? { not_found: r.notFound } : {}), note: `${note}${missed}` });
        } catch (e) {
          return fail(e.message);
        }
      }
    ),
  ];
}
