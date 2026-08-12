import assert from "node:assert/strict";
import { it } from "node:test";

import { runSanitizedLive } from "./helpers.mjs";

it("redacts provider failures without retaining a sensitive cause", async () => {
  await assert.rejects(
    () =>
      runSanitizedLive("Azure text summary", async () => {
        const error = new Error("provider returned api-key=secret-value");
        error.code = "AI_PROVIDER_REQUEST_FAILED";
        throw error;
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Azure text summary failed (AI_PROVIDER_REQUEST_FAILED)." &&
      !error.message.includes("secret-value") &&
      error.cause instanceof Error &&
      error.cause.message === "Live provider error redacted."
  );
});
