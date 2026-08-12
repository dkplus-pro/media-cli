import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMockProvider } from "@dkplus/ai-core";
import { CliError } from "@dkplus/contracts";
import { fixturePath } from "@dkplus/testing";

import {
  analyzeMusic,
  analyzeMusicEmotion,
  readAudioMetadata,
  summarizeTranscript,
  transcribeAudio,
  translateTranscript
} from "../dist/index.js";
import { translateAudio } from "../dist/speech.js";

const audioPath = fixturePath("short-audio.wav");
const sourceFingerprint = {
  algorithm: "sha256",
  value: "a".repeat(64)
};
const transcript = {
  kind: "transcript",
  schemaVersion: "1.0",
  sourceFingerprint,
  language: "en",
  segments: [{ id: "seg-001", startMs: 0, endMs: 500, text: "Hello world." }]
};

describe("dk-audio public APIs", () => {
  it("transcribes through an explicitly injected raw-audio adapter", async () => {
    const result = await transcribeAudio(audioPath, {
      transcriber: {
        async transcribe(task) {
          assert.equal(task.feature, "audio.speech.transcribe");
          return { ...transcript, sourceFingerprint: task.sourceFingerprint };
        }
      }
    });

    assert.equal(result.kind, "transcript");
    assert.equal(result.segments[0].text, "Hello world.");
  });

  it("returns a typed configuration failure when no raw-audio adapter is available", async () => {
    await assert.rejects(
      () => transcribeAudio(audioPath),
      (error) => error instanceof CliError && error.code === "AUDIO_TRANSCRIBER_UNAVAILABLE"
    );
  });

  it("translates only a validated canonical transcript", async () => {
    const result = await translateTranscript(transcript, {
      targetLanguage: "zh",
      translator: {
        async translate(task) {
          assert.equal(task.targetLanguage, "zh");
          return {
            ...task.transcript,
            language: "zh",
            segments: [{ ...task.transcript.segments[0], text: "你好，世界。" }]
          };
        }
      }
    });

    assert.equal(result.language, "zh");
    assert.equal(result.segments[0].text, "你好，世界。");
    await assert.rejects(
      () =>
        translateTranscript(
          { ...transcript, segments: [{ ...transcript.segments[0], endMs: -1 }] },
          { targetLanguage: "zh" }
        ),
      (error) => error instanceof CliError && error.code === "INVALID_TRANSCRIPT"
    );
  });

  it("translates an audio file by composing injected transcription and translation adapters", async () => {
    const calls = [];
    const result = await translateAudio(audioPath, {
      targetLanguage: "zh",
      transcriber: {
        async transcribe(task) {
          calls.push(task.feature);
          return { ...transcript, sourceFingerprint: task.sourceFingerprint };
        }
      },
      translator: {
        async translate(task) {
          calls.push(task.transcript.sourceFingerprint.value);
          return { ...task.transcript, language: task.targetLanguage };
        }
      }
    });

    assert.deepEqual(calls, ["audio.speech.transcribe", result.sourceFingerprint.value]);
    assert.equal(result.language, "zh");
  });

  it("summarizes a validated transcript through the speech summary feature", async () => {
    const features = [];
    const provider = createMockProvider((task) => {
      features.push(task.feature);
      return {
        summary: "A greeting.",
        topics: ["greeting"],
        keyPoints: ["hello"],
        participants: [],
        decisions: [],
        questions: []
      };
    });

    const result = await summarizeTranscript(transcript, { provider });

    assert.deepEqual(features, ["audio.speech.summarize"]);
    assert.equal(result.summary, "A greeting.");
    await assert.rejects(
      () => summarizeTranscript({ ...transcript, language: "" }, { provider }),
      (error) => error instanceof CliError && error.code === "INVALID_TRANSCRIPT"
    );
  });

  it("reads deterministic local music metadata and nulls unavailable music tags", async () => {
    const result = await readAudioMetadata(audioPath);

    assert.equal(result.kind, "music-metadata");
    assert.equal(result.codec, "pcm_s16le");
    assert.equal(result.sampleRate, 44100);
    assert.equal(result.bpm, null);
    assert.equal(result.key, null);
    assert.equal(result.mode, null);
    assert.equal(result.loudness, null);
  });

  it("analyzes music emotion through the music emotion feature", async () => {
    const features = [];
    const result = await analyzeMusicEmotion(audioPath, {
      provider: createMockProvider((task) => {
        features.push(task.feature);
        return {
          primaryEmotion: "calm",
          secondaryEmotions: ["warm"],
          valence: 0.7,
          arousal: 0.2,
          tension: 0.1
        };
      })
    });

    assert.deepEqual(features, ["audio.music.emotion"]);
    assert.equal(result.primaryEmotion, "calm");
  });

  it("combines exactly metadata and emotion", async () => {
    const result = await analyzeMusic(audioPath, {
      provider: createMockProvider(() => ({
        primaryEmotion: "calm",
        secondaryEmotions: [],
        valence: 0.5,
        arousal: 0.2,
        tension: 0.1
      }))
    });

    assert.deepEqual(Object.keys(result).sort(), ["emotion", "metadata"]);
    assert.equal(result.metadata.kind, "music-metadata");
    assert.equal(result.emotion.kind, "music-emotion");
  });
});
