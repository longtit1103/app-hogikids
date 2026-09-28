import { describe, it, expect } from "vitest";

import { pgDumpArgsFromUrl } from "@/lib/backup/run-pg-dump";

describe("pgDumpArgsFromUrl schema scoping", () => {
  it("dump chỉ schema từ URL", () => {
    const { args } = pgDumpArgsFromUrl("postgresql://u:p@h:5432/postgres?schema=app");
    expect(args).toContain("-n");
    expect(args[args.indexOf("-n") + 1]).toBe("app");
    expect(args).toContain("-Fc");
  });
  it("mặc định public khi không có schema", () => {
    const { args } = pgDumpArgsFromUrl("postgresql://u:p@h:5432/hogikids");
    expect(args[args.indexOf("-n") + 1]).toBe("public");
  });
});
