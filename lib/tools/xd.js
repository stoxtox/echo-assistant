// Adobe XD through the Echo panel plugin (lib/xd.js, integrations/xd-bridge): read the document,
// find out whether XD lets Echo edit it, and edit it. Offered only while the panel is connected
// (lib/dispatcher.js toolList).
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { text, fail } from './result.js';
import { EDIT_OPS, ALIGN_HOW } from '../xd.js';

export const XD_TOOL_NAMES = ['xd_describe', 'xd_probe', 'xd_edit'];

/** What went wrong, as a sentence the assistant can act on. */
function sayWhy(e) {
  if (e.code === 'needs_click') return fail(`XD wants a click from the user first. Ask them to click "Let Echo edit" in the Echo panel in XD, and when they say they have, call xd_edit again. (${e.message})`);
  return fail(e.message);
}

/** @param {any} d the dispatcher (lib/dispatcher.js); d.xd is the bridge */
export function xdTools(d) {
  return [
    tool(
      'xd_describe',
      'Read the document that is open in Adobe XD, straight from XD: what is selected, and the artboards and what is on them (to depth 3). Each node has an id, a type, a name, box [x, y, width, height] on the canvas, its text if it is a text, and its fill colour. In XD ALWAYS use this instead of looking at the canvas. Ids from here are what xd_edit takes as target.',
      {},
      async () => {
        try {
          return text(await d.xd.describe());
        } catch (e) {
          return sayWhy(e);
        }
      }
    ),
    tool(
      'xd_probe',
      'Run the XD probe ("run the XD probe"): finds out whether Adobe XD lets Echo edit the document, by trying a rename that is put straight back (nothing is left changed). The user should have a document open with one object selected. It answers at once when XD allows edits; otherwise it says to ask the user to click "Let Echo edit" in the Echo panel in XD, and the rest of the result arrives as an event after their click. result: true gives the last result again without running anything.',
      { result: z.boolean().optional().describe('Only report the last probe result; run nothing') },
      async ({ result }) => {
        try {
          if (result) return text(d.xd.probeResult() || { outcome: 'none', means: 'No probe has finished since Echo started. Call xd_probe to run it.' });
          return text(await d.xd.probe());
        } catch (e) {
          return sayWhy(e);
        }
      }
    ),
    tool(
      'xd_edit',
      'Change the document in Adobe XD through XD itself, never by clicking on the canvas: move, resize, fill (a colour), text (of a text node), rename, or align the selection. Works on the selection, or on one node by the id xd_describe gave. Returns each node before and after. If it says a click is needed, ask the user to click "Let Echo edit" in the Echo panel in XD, then call it again.',
      {
        op: z.enum(/** @type {[string, ...string[]]} */ (EDIT_OPS)),
        target: z.string().optional().describe('"selection" (the default), or a node id from xd_describe'),
        dx: z.number().optional().describe('move: how far right (negative: left), in pixels'),
        dy: z.number().optional().describe('move: how far down (negative: up)'),
        x: z.number().optional().describe('move: the new left edge, inside its artboard or group (instead of dx and dy)'),
        y: z.number().optional().describe('move: the new top edge'),
        width: z.number().optional().describe('resize'),
        height: z.number().optional().describe('resize'),
        color: z.string().optional().describe('fill: hex, e.g. "#1e90ff"'),
        text: z.string().optional().describe('text: the new text'),
        name: z.string().optional().describe('rename: the new layer name'),
        how: z.enum(/** @type {[string, ...string[]]} */ (ALIGN_HOW)).optional().describe('align: which way (acts on the selection, as XD\'s own Align buttons do)'),
      },
      async (args) => {
        try {
          return text(await d.xd.edit(args));
        } catch (e) {
          return sayWhy(e);
        }
      }
    ),
  ];
}
