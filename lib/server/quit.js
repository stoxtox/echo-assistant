// Quit Echo for good (the Mac app's Quit: POST /api/shutdown in ./routes.js).
//
// Under the supervisor a plain exit would be taken for a crash and Echo started again, so the
// supervisor is told to stop first: SIGTERM, which it has always taken as "stop, don't restart"
// (supervisor.js), so this also works with a supervisor from before an update.

/**
 * Stop this process, and the supervisor that would restart it.
 * @param {{ supervised?: boolean, exit?: (code: number) => void }} [o] supervised: started by
 *   supervisor.js (it sets ECHO_SUPERVISED and opens an IPC channel, so the parent is known to be it)
 */
export function stopForGood({ supervised = Boolean(process.env.ECHO_SUPERVISED && process.send), exit = (code) => process.exit(code) } = {}) {
  if (supervised) {
    try {
      process.kill(process.ppid, 'SIGTERM');
    } catch {}
  }
  // A moment for the supervisor to take the signal in before it sees this exit.
  setTimeout(() => exit(0), supervised ? 300 : 0);
}

/**
 * Quit: do what must be done first (pause the running tasks), then stop for good WHATEVER
 * happened: if that threw, Echo used to stay up and refuse every later quit.
 * @param {() => Promise<unknown>} before @param {() => void} [stop]
 */
export async function quitAfter(before, stop = stopForGood) {
  try {
    await before();
  } catch (e) {
    console.error('[echo] quit: could not pause the running tasks:', /** @type {Error} */ (e).message);
  } finally {
    stop();
  }
}
