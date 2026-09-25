// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const adminCssPath = `${process.cwd()}/app/admin/admin.css`;
const adminLayoutPath = `${process.cwd()}/app/admin/layout.tsx`;

describe("Admin responsive stylesheet", () => {
  it("is imported by the admin layout", () => {
    const layout = readFileSync(adminLayoutPath, "utf8");
    expect(layout).toContain('import "./admin.css"');
  });

  it("collapses the sidebar and grid at tablet and phone widths", () => {
    const css = readFileSync(adminCssPath, "utf8");
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("flex-wrap: wrap");
  });

  it("guards panels and form controls against horizontal overflow", () => {
    const css = readFileSync(adminCssPath, "utf8");
    expect(css).toContain("min-width: 0");
    expect(css).toContain("overflow-wrap: anywhere");
  });
});
