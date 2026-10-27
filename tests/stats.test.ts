import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, query } from "../src/db.js";
import { getStats } from "../src/stats.js";
import { addDays, localDateString } from "../src/time.js";
import { uniquePhone } from "./helpers.js";

const TZ = "America/New_York";
const today = localDateString(new Date(), TZ);

after(async () => closeDb());

async function contactWith(history: string): Promise<number> {
  const [c] = await query<{ id: number }>(
    "INSERT INTO contacts (name, phone, timezone) VALUES ('Test', $1, $2) RETURNING id", [uniquePhone(), TZ],
  );
  // history is oldest to newest, one letter per day ending today: C completed, S skipped, M missed, P pending, . nothing
  const letters = history.split("");
  const names: Record<string, string> = { C: "completed", S: "skipped", M: "missed", P: "pending" };
  for (let i = 0; i < letters.length; i++) {
    const status = names[letters[i]!];
    if (!status) continue;
    await query("INSERT INTO checkins (contact_id, local_date, status) VALUES ($1, $2, $3)", [c!.id, addDays(today, i - (letters.length - 1)), status]);
  }
  return c!.id;
}

describe("streaks", () => {
  const cases: [string, string, { current: number; best: number }][] = [
    ["no history", "", { current: 0, best: 0 }],
    ["three in a row", "CCC", { current: 3, best: 3 }],
    ["a miss resets the current streak but not the best", "CCCCM", { current: 0, best: 4 }],
    ["a streak rebuilds after a miss", "CCMCCC", { current: 3, best: 3 }],
    ["an older streak can be the best", "CCCCMCC", { current: 2, best: 4 }],
    ["a rest day neither adds nor breaks", "CCSC", { current: 3, best: 3 }],
    ["only rest days is zero", "SSS", { current: 0, best: 0 }],
    ["today still pending is ignored", "CCP", { current: 2, best: 2 }],
    ["a miss followed by pending is zero", "CCMP", { current: 0, best: 2 }],
  ];
  for (const [name, history, expected] of cases) {
    test(name, async () => {
      const id = await contactWith(history);
      const s = await getStats(id, TZ);
      assert.equal(s.current, expected.current);
      assert.equal(s.best, expected.best);
    });
  }

  test("last 7 days counts completed workouts in the window only", async () => {
    // 10 days of history: the oldest 3 fall outside the 7-day window
    const id = await contactWith("CCCCCCCCCC");
    assert.equal((await getStats(id, TZ)).last7, 7);
    const id2 = await contactWith("CCCCCCCMMM"); // 7 old completions, 3 recent misses
    assert.equal((await getStats(id2, TZ)).last7, 4);
  });
});
