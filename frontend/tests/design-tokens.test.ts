// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Design tokens", () => {
  it("spot-checks design tokens in globals.css", () => {
    const globalsCss = readFileSync(`${process.cwd()}/app/globals.css`, "utf8");
    expect(globalsCss).toContain("--color-primary");
    expect(globalsCss).toContain("--font-sans");
  });
});
