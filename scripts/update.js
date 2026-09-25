// Updates from the command line, for when the Echo window isn't handy (or Echo won't start).
//
//   npm run update -- check        is there a newer release?
//   npm run update -- apply        install it (stop Echo first, or use Update now in the window)
//   npm run update -- rollback     go back to the version kept from the last update
import { Updater } from '../lib/updater.js';

const cmd = process.argv[2] || 'check';
const u = new Updater();
try {
  if (cmd === 'check') {
    const st = await u.check();
    console.log(st.developer ? `Echo ${st.current} is a developer copy (a git checkout); it updates with git.` : st.available ? `Echo ${st.latest.version} is available (you have ${st.current}).` : `Echo ${st.current} is up to date.`);
  } else if (cmd === 'apply') {
    u.on('status', (s) => s.phase === 'downloading' && typeof s.progress === 'number' && process.stdout.write(`\rDownloading… ${Math.round(s.progress * 100)}%`));
    const out = await u.apply({ restart: false });
    console.log(out.updated ? `\nInstalled Echo ${out.to} (was ${out.from}). Start Echo again to use it.` : `Echo ${out.current} is already up to date.`);
  } else if (cmd === 'rollback') {
    const out = u.rollback({ restart: false });
    console.log(`Went back from Echo ${out.from} to ${out.to}. Start Echo again.`);
  } else {
    console.error('Say check, apply or rollback.');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
