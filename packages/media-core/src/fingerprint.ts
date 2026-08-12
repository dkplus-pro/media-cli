import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

import { CliError, type SourceFingerprint } from "@dkplus/contracts";

export async function fingerprintFile(path: string): Promise<SourceFingerprint> {
  const hash = createHash("sha256");

  try {
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
  } catch {
    throw new CliError({
      code: "MEDIA_PROCESS_FAILED",
      message: "Media processing failed.",
      details: { operation: "fingerprint" }
    });
  }

  return { algorithm: "sha256", value: hash.digest("hex") };
}
