import { describe, expect, it } from "vitest";
import {
  FREEBBUFF_MODEL_IDS,
  freebuffLegacyModelDigest,
  freebuffLegacyModelId,
  resolveFreebuffModel
} from "./freebuff-models";

describe("Freebuff model ids", () => {
  it("recomputes the digest Freebuff stores, for every id it ships", () => {
    for (const [digest, routingId] of Object.entries(FREEBBUFF_MODEL_IDS)) {
      expect(freebuffLegacyModelDigest(`key:${routingId}`).slice(0, 10)).toBe(digest);
      expect(freebuffLegacyModelId(routingId)).toBe(`m-${digest}`);
    }
  });

  it("resolves the id a real project database holds", () => {
    // Read from a Freebuff Desktop 0.0.192 database (`threads.model`).
    expect(resolveFreebuffModel("m-096e75164d")).toEqual({
      id: "deepseek/deepseek-v4-flash",
      vendor: "deepseek",
      model: "deepseek-v4-flash"
    });
    expect(resolveFreebuffModel(" m-7e20df6765 ")).toMatchObject({ model: "glm-5.3-flash", vendor: "z-ai" });
  });

  it("keeps an unknown or already-named model as it is", () => {
    // An id from a newer Freebuff is not guessed at: it still counts, unpriced.
    expect(resolveFreebuffModel("m-ffffffffff")).toEqual({ id: "m-ffffffffff", vendor: null, model: "m-ffffffffff" });
    expect(resolveFreebuffModel("m-abc")).toEqual({ id: "m-abc", vendor: null, model: "m-abc" });
    expect(resolveFreebuffModel("gpt-5.6-sol")).toEqual({ id: "gpt-5.6-sol", vendor: null, model: "gpt-5.6-sol" });
    expect(resolveFreebuffModel("z-ai/glm-5.2")).toEqual({ id: "z-ai/glm-5.2", vendor: "z-ai", model: "glm-5.2" });
    expect(resolveFreebuffModel("freebuff")).toEqual({ id: "freebuff", vendor: null, model: "freebuff" });
    expect(resolveFreebuffModel("/broken")).toEqual({ id: "/broken", vendor: null, model: "/broken" });
  });
});
