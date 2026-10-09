import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateIdempotencyKey } from "@/lib/idempotency";

describe("generateIdempotencyKey", () => {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates valid RFC4122 v4 UUID in secure context (crypto.randomUUID)", () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(uuidV4Regex);
  });

  it("generates valid RFC4122 v4 UUID when randomUUID is unavailable (non-secure LAN HTTP context)", () => {
    // Emulate non-secure LAN HTTP where crypto exists but crypto.randomUUID is undefined
    const mockGetRandomValues = (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    };
    vi.stubGlobal("crypto", {
      getRandomValues: mockGetRandomValues,
    });

    const key = generateIdempotencyKey();
    expect(key).toMatch(uuidV4Regex);
  });

  it("generates valid UUID in pure fallback environment when crypto is completely absent", () => {
    vi.stubGlobal("crypto", undefined);

    const key = generateIdempotencyKey();
    expect(key).toMatch(uuidV4Regex);
  });
});
