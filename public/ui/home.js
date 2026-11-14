// The Home screen's greeting: "Good evening, <name>." by the time of day.

/**
 * @param {unknown} name the user's name from Settings (may be empty)
 * @param {number} [hour] 0-23, the local hour
 */
export function greeting(name, hour = new Date().getHours()) {
  const part = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening';
  const who = String(name || '').replace(/\s+/g, ' ').trim();
  return who ? `${part}, ${who}.` : `${part}.`;
}
