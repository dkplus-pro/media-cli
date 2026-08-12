export type FingerprintAlgorithm = "sha256";

export interface SourceFingerprint {
  algorithm: FingerprintAlgorithm;
  value: string;
}

export interface Artifact<T = unknown> {
  kind: string;
  schemaVersion: string;
  sourceFingerprint: SourceFingerprint;
  data: T;
}
