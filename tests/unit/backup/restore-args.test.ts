import { describe, it, expect } from "vitest";

import { restoreArgsFromUrl } from "@/lib/backup/run-restore";

describe("restoreArgsFromUrl schema scoping", () => {
  it("custom restore scope -n <schema> theo URL", () => {
    const { cmd, args } = restoreArgsFromUrl("postgresql://u:p@h:5432/postgres?schema=app", "custom");
    expect(cmd).toBe("pg_restore");
    expect(args).toContain("-n");
    expect(args[args.indexOf("-n") + 1]).toBe("app");
    expect(args).not.toContain("REASSIGN"); // không bao giờ có
  });
});
