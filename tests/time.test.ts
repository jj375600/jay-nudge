import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { addDays, avoidQuietHours, endOfLocalDay, isQuietHour, localDateString, nextLocalOccurrence, zonedTimeToUtc } from "../src/time.js";

const NY = "America/New_York";
const quiet = { enabled: true, start: 21, end: 8 };
const iso = (d: Date) => d.toISOString();

describe("time zones", () => {
  test("a wall-clock time becomes the right UTC instant, either side of daylight saving", () => {
    assert.equal(iso(zonedTimeToUtc("2026-10-23", "18:00", NY)), "2026-10-23T22:00:00.000Z"); // EDT, UTC-4
    assert.equal(iso(zonedTimeToUtc("2026-11-02", "18:00", NY)), "2026-11-02T23:00:00.000Z"); // EST, UTC-5 (clocks went back on Nov 1)
    assert.equal(iso(zonedTimeToUtc("2026-03-07", "18:00", NY)), "2026-03-07T23:00:00.000Z"); // before spring forward
    assert.equal(iso(zonedTimeToUtc("2026-03-09", "18:00", NY)), "2026-03-09T22:00:00.000Z"); // after it
    assert.equal(iso(zonedTimeToUtc("2026-10-23", "10:00", "Asia/Kolkata")), "2026-10-23T04:30:00.000Z"); // a half-hour offset
  });

  test("the local date can differ from the UTC date", () => {
    assert.equal(localDateString(new Date("2026-10-24T02:30:00Z"), NY), "2026-10-23");
    assert.equal(localDateString(new Date("2026-10-24T02:30:00Z"), "Asia/Tokyo"), "2026-10-24");
  });

  test("addDays handles month and year ends", () => {
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });

  test("the next occurrence of 18:00 is today if it hasn't passed, tomorrow if it has", () => {
    assert.equal(iso(nextLocalOccurrence(new Date("2026-10-23T20:00:00Z"), NY, 18)), "2026-10-23T22:00:00.000Z"); // 16:00 local
    assert.equal(iso(nextLocalOccurrence(new Date("2026-10-23T23:30:00Z"), NY, 18)), "2026-10-24T22:00:00.000Z"); // 19:30 local
    assert.equal(iso(nextLocalOccurrence(new Date("2026-10-23T22:00:00Z"), NY, 18)), "2026-10-24T22:00:00.000Z"); // exactly 18:00: strictly after
  });

  test("end of the local day is local midnight", () => {
    assert.equal(iso(endOfLocalDay(new Date("2026-10-23T20:00:00Z"), NY)), "2026-10-24T04:00:00.000Z");
  });
});

describe("quiet hours", () => {
  test("they wrap past midnight", () => {
    const at = (utc: string) => isQuietHour(new Date(utc), NY, quiet);
    assert.equal(at("2026-10-24T02:00:00Z"), true); // 22:00 local
    assert.equal(at("2026-10-24T09:00:00Z"), true); // 05:00 local
    assert.equal(at("2026-10-24T11:59:00Z"), true); // 07:59 local
    assert.equal(at("2026-10-24T12:00:00Z"), false); // 08:00 local
    assert.equal(at("2026-10-24T00:59:00Z"), false); // 20:59 local
  });

  test("they can be switched off", () => {
    assert.equal(isQuietHour(new Date("2026-10-24T02:00:00Z"), NY, { ...quiet, enabled: false }), false);
  });

  test("a time inside them moves to the morning, a time outside is untouched", () => {
    assert.equal(iso(avoidQuietHours(new Date("2026-10-24T02:00:00Z"), NY, quiet)), "2026-10-24T12:00:00.000Z"); // 22:00 -> next 08:00
    assert.equal(iso(avoidQuietHours(new Date("2026-10-24T06:00:00Z"), NY, quiet)), "2026-10-24T12:00:00.000Z"); // 02:00 -> same-day 08:00
    const fine = new Date("2026-10-23T22:00:00Z");
    assert.equal(avoidQuietHours(fine, NY, quiet), fine);
  });
});
