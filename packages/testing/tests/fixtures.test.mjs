import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { fixturePath, fixturesDirectory } from "../dist/index.js";

describe("fixturePath", () => {
  it("returns only paths contained by the fixture directory", () => {
    assert.equal(fixturePath("sample.png"), join(fixturesDirectory, "sample.png"));
    assert.throws(() => fixturePath(join(fixturesDirectory, "sample.png")));
    assert.throws(() => fixturePath("../media-core/src/video.ts"));
    assert.throws(() => fixturePath("nested/../../media-core/src/video.ts"));
  });
});
