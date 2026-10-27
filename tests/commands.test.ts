import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/commands.js";

const cases: [string, string][] = [
  ["DONE", "done"], ["done!", "done"], ["  Done  ", "done"], ["Done 💪", "done"], ["done with legs today", "done"], ["finished", "done"], ["did it", "done"],
  ["skip", "skip"], ["Rest day", "skip"], ["REST", "skip"],
  ["no", "no"], ["Nope.", "no"], ["N", "no"],
  ["yes", "yes"], ["Y", "yes"], ["yeah!", "yes"],
  ["streak", "streak"], ["STATS", "streak"],
  ["help", "help"], ["Help me", "help"],
  ["please stop texting me", "stop"], ["I want to unsubscribe", "stop"], ["cancel", "stop"], ["end", "stop"],
  ["end of leg day, done", "unknown"], ["cancel my session", "unknown"], ["stop", "stop"], ["STOP", "stop"], ["Stop texting me please", "stop"], ["unsubscribe", "stop"], ["QUIT", "stop"], ["stop all", "stop"],
  ["start", "start"], ["unstop", "start"],
  // Things that must NOT be misread:
  ["no problem, I trained", "unknown"], // "no" only counts as the whole message
  ["yesterday was rough", "unknown"],
  ["what time is it", "unknown"],
  ["", "unknown"], ["   ", "unknown"], ["👍", "unknown"],
];

for (const [input, expected] of cases) {
  test(`${JSON.stringify(input)} is ${expected}`, () => {
    assert.equal(parseCommand(input), expected);
  });
}
