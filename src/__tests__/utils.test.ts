import { timeAgo } from "../utils";

describe("timeAgo", () => {
  it('returns "just now" for recent timestamps', () => {
    expect(timeAgo(Date.now() - 5000)).toBe("just now");
  });
});