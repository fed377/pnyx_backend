import { describe, expect, it, vi } from "vitest";
import type { GoogleGenAI } from "@google/genai";
import { GRID_IDS } from "../src/core/grids";
import { GeminiScorer } from "../src/scoring/geminiScorer";

/** A well-formed, "ok"-verdict response, so tests only override what they care about. */
function fullScore(
  overrides: Partial<Record<string, { x: number; y: number; confidence: number }>> = {},
  moderation: { verdict: string; reason: string } = { verdict: "ok", reason: "n/a" },
) {
  const base = Object.fromEntries(GRID_IDS.map((id) => [id, { x: 0, y: 0, confidence: 0.1 }]));
  return { moderation, ...base, ...overrides };
}

/** Fakes just the SDK surface the scorer calls: generateContent, and files.upload/get for video. */
function fakeClient(opts: {
  scores?: unknown;
  moderation?: { verdict: string; reason: string };
  text?: string;
  upload?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
}): GoogleGenAI {
  const text = opts.text ?? JSON.stringify(fullScore(opts.scores as never, opts.moderation));
  const generateContent = vi.fn().mockResolvedValue({ text });
  return {
    models: { generateContent },
    files: {
      upload: opts.upload ?? vi.fn(),
      get: opts.get ?? vi.fn(),
    },
  } as unknown as GoogleGenAI;
}

describe("GeminiScorer", () => {
  it("returns a score for every grid, forcing the JSON schema", async () => {
    const client = fakeClient({ scores: { values: { x: 0.5, y: -0.5, confidence: 0.8 } } });
    const scorer = new GeminiScorer({ apiKey: "test", client });

    const outcome = await scorer.score({ type: "image", body: "a real opinion about something", categories: ["values"] });

    if (outcome.verdict !== "ok") throw new Error("expected an ok verdict");
    expect(outcome.scores.values).toEqual({ x: 0.5, y: -0.5, confidence: 0.8 });
    for (const id of GRID_IDS) expect(outcome.scores[id]).toBeDefined();

    const call = (client.models.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.config.responseMimeType).toBe("application/json");
    expect(call.config.responseSchema.required).toEqual(["moderation", ...GRID_IDS]);
    expect(call.contents[0].text).toContain("a real opinion about something");
  });

  it("clamps out-of-range model output instead of trusting it", async () => {
    const client = fakeClient({ scores: { mind: { x: 3, y: -7, confidence: 1.4 } } });
    const scorer = new GeminiScorer({ apiKey: "test", client });

    const outcome = await scorer.score({ type: "video", body: "no media here" });

    if (outcome.verdict !== "ok") throw new Error("expected an ok verdict");
    expect(outcome.scores.mind).toEqual({ x: 1, y: -1, confidence: 1 });
  });

  it("flags policy-violating content instead of scoring it", async () => {
    const client = fakeClient({
      moderation: { verdict: "policy_violation", reason: "detailed instructions for building a weapon" },
    });
    const scorer = new GeminiScorer({ apiKey: "test", client });

    const outcome = await scorer.score({ type: "image", body: "how to build one at home, step by step" });

    expect(outcome).toEqual({
      verdict: "policy_violation",
      reason: "detailed instructions for building a weapon",
    });
  });

  it("rejects meaningless content as low-effort without treating it as a violation", async () => {
    const client = fakeClient({
      moderation: { verdict: "low_effort", reason: "This doesn't say what you actually think about anything." },
    });
    const scorer = new GeminiScorer({ apiKey: "test", client });

    const outcome = await scorer.score({ type: "image", body: "asdkjfh asdkjfh" });

    expect(outcome).toEqual({
      verdict: "low_effort",
      reason: "This doesn't say what you actually think about anything.",
    });
  });

  it("rejects a response with an unrecognised verdict", async () => {
    const client = fakeClient({ moderation: { verdict: "sort of fine i guess", reason: "n/a" } });
    const scorer = new GeminiScorer({ apiKey: "test", client });

    await expect(scorer.score({ type: "image", body: "whatever" })).rejects.toThrow();
  });

  it("sends the image inline when it can be fetched", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response);
    const client = fakeClient({});
    const scorer = new GeminiScorer({ apiKey: "test", client });

    await scorer.score({ type: "image", body: "a photo take", mediaUrl: "https://cdn.test/pic.png" });

    const call = (client.models.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.contents).toHaveLength(2);
    expect(call.contents[1]).toMatchObject({ inlineData: { mimeType: "image/png" } });
    expect(client.files.upload).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("uploads video through the Files API and waits for it to become active", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "video/mp4" }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response);
    const upload = vi.fn().mockResolvedValue({ name: "files/abc", state: "PROCESSING" });
    const get = vi.fn().mockResolvedValue({
      name: "files/abc",
      state: "ACTIVE",
      uri: "https://generativelanguage.googleapis.com/files/abc",
      mimeType: "video/mp4",
    });
    const client = fakeClient({ upload, get });
    const scorer = new GeminiScorer({ apiKey: "test", client });

    const pending = scorer.score({ type: "video", body: "a reel take", mediaUrl: "https://cdn.test/reel.mp4" });
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(upload).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({ name: "files/abc" });
    const call = (client.models.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.contents[1]).toMatchObject({
      fileData: { fileUri: "https://generativelanguage.googleapis.com/files/abc", mimeType: "video/mp4" },
    });
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("falls back to text-only scoring when video processing fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "video/mp4" }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response);
    const upload = vi.fn().mockResolvedValue({ name: "files/bad", state: "FAILED" });
    const client = fakeClient({ upload });
    const scorer = new GeminiScorer({ apiKey: "test", client });

    const scores = await scorer.score({ type: "video", body: "a reel take", mediaUrl: "https://cdn.test/reel.mp4" });

    expect(scores).toBeDefined();
    const call = (client.models.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.contents).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("falls back to text-only scoring when the media can't be fetched", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const client = fakeClient({});
    const scorer = new GeminiScorer({ apiKey: "test", client });

    const scores = await scorer.score({ type: "image", body: "a photo take", mediaUrl: "https://cdn.test/pic.png" });

    expect(scores).toBeDefined();
    const call = (client.models.generateContent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.contents).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("throws when the model returns no text", async () => {
    const client = fakeClient({ text: "" });
    const scorer = new GeminiScorer({ apiKey: "test", client });

    await expect(scorer.score({ type: "video", body: "whatever" })).rejects.toThrow(/no output/);
  });

  it("throws when the response doesn't match the score shape", async () => {
    const client = fakeClient({ text: JSON.stringify({ values: { x: 0 } }) });
    const scorer = new GeminiScorer({ apiKey: "test", client });

    await expect(scorer.score({ type: "video", body: "whatever" })).rejects.toThrow();
  });
});
