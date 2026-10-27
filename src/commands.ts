// What the client texted back, as a small closed set of commands.

export type Command = "done" | "skip" | "no" | "streak" | "stop" | "start" | "help" | "yes" | "unknown";

// Carrier keywords. The first group is honoured anywhere in a message; the second only when it is the whole
// message, because "end of leg day, done" and "cancel my session" shouldn't unsubscribe anyone.
const STOP_ANYWHERE = new Set(["stop", "stopall", "unsubscribe", "quit"]);
const STOP_AT_START = new Set(["cancel", "end"]);
const START = new Set(["start", "unstop", "subscribe"]);
const DONE = new Set(["done", "finished", "completed", "complete", "didit", "worked"]);
const SKIP = new Set(["skip", "rest", "restday", "off"]);
const STREAK = new Set(["streak", "stats", "status", "score"]);
const HELP = new Set(["help", "info", "commands", "menu"]);
const YES = new Set(["yes", "y", "yep", "yeah", "yup"]);
const NO = new Set(["no", "n", "nope", "nah"]);

/** Lowercase, drop emoji and punctuation, collapse spaces: "  DONE!! 💪 " becomes "done". */
export function normalize(body: string): string {
  return body
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCommand(body: string): Command {
  const text = normalize(body);
  if (!text) return "unknown";
  const words = text.split(" ");
  const first = words[0]!;
  const joined = words.join("");

  // Opting out is honoured even inside a sentence ("please stop texting me"). Wrongly unsubscribing someone is
  // a small, fixable annoyance; ignoring a real STOP is a compliance problem.
  if (words.some((w) => STOP_ANYWHERE.has(w)) || (words.length === 1 && STOP_AT_START.has(first)) || joined === "stopall") return "stop";

  // Single letters and yes/no only count when they are the whole message: "no problem" must not log a miss.
  if (words.length === 1) {
    if (YES.has(first)) return "yes";
    if (NO.has(first)) return "no";
  }
  if (START.has(first)) return "start";
  if (DONE.has(first) || DONE.has(joined) || text === "did it") return "done";
  if (SKIP.has(first) || SKIP.has(joined)) return "skip";
  if (STREAK.has(first)) return "streak";
  if (HELP.has(first)) return "help";
  return "unknown";
}
