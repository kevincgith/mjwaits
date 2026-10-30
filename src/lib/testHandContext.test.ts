import { describe, expect, it } from "vitest";
import { TEST_HAND_BASE_CONTEXT as generated } from "@mjwaits/shared/engine/testHands";
import { TEST_HAND_BASE_CONTEXT } from "./testHandContext";

describe("TEST_HAND_BASE_CONTEXT", () => {
  it("matches the generated test hands' defaults", () => {
    expect(TEST_HAND_BASE_CONTEXT).toEqual(generated);
  });
});
