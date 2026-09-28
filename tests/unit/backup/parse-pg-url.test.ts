import { describe, it, expect } from "vitest";

import { parsePgUrl } from "@/lib/backup/run-pg-dump";

describe("parsePgUrl schema", () => {
  it("mặc định public khi URL không có ?schema", () => {
    expect(parsePgUrl("postgresql://u:p@h:5432/hogikids").schema).toBe("public");
  });
  it("đọc ?schema=app", () => {
    expect(parsePgUrl("postgresql://u:p@h:5432/postgres?schema=app").schema).toBe("app");
  });
});
