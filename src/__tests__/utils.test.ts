import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { timeAgo } from "../utils";

describe("timeAgo", () => {
  it('returns "just now" for recent timestamps', () => {
    assert.strictEqual(timeAgo(Date.now() - 5000), "just now");
  });
});
