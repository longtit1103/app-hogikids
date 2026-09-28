import { describe, expect, it } from "vitest";

import { giuKhoaLandDon } from "@/lib/bronze/khoa-land-don";
import { giuKhoaGhiChiTieuAds } from "@/lib/ingest/khoa-ghi-chi-tieu-ads";
import { prisma } from "@/lib/prisma";

/**
 * Hai khoá tư vấn Postgres phải THẬT SỰ loại trừ hai transaction chạy song song — nền tảng của cả
 * guard thứ tự webhook (Silver không thụt lùi) lẫn cổng ghi chi tiêu quảng cáo (không đếm 2 lần).
 *
 * Test chạy trên DB test thật vì đây là hành vi của Postgres, không phải của code JS: mock đi thì
 * test chỉ còn chứng minh chính nó. Bẫy đã gặp khi làm: `pg_advisory_xact_lock` trả kiểu `void` nên
 * gọi qua `$queryRaw` sẽ ném "Failed to deserialize column of type 'void'" — phải là `$executeRaw`.
 */
async function chayCoKhoa(
  giuKhoa: (tx: Parameters<typeof giuKhoaLandDon>[0]) => Promise<void>,
  ten: string,
  giuTrongMs: number,
  nhatKy: string[],
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await giuKhoa(tx);
      nhatKy.push(`${ten}:vào`);
      await new Promise((r) => setTimeout(r, giuTrongMs));
      nhatKy.push(`${ten}:ra`);
    },
    { timeout: 30_000 },
  );
}

/** Có transaction nào chen vào giữa "vào" và "ra" của transaction khác không. */
function coXenKe(nhatKy: string[]): boolean {
  return !/^(A:vào A:ra B:vào B:ra|B:vào B:ra A:vào A:ra)$/.test(nhatKy.join(" "));
}

describe("khoá tư vấn Postgres", () => {
  it("khoá land đơn: 2 transaction song song KHÔNG xen kẽ nhau", async () => {
    const nhatKy: string[] = [];
    await Promise.all([
      chayCoKhoa(giuKhoaLandDon, "A", 300, nhatKy),
      chayCoKhoa(giuKhoaLandDon, "B", 50, nhatKy),
    ]);

    expect(nhatKy).toHaveLength(4);
    expect(coXenKe(nhatKy)).toBe(false);
  });

  it("khoá ghi chi tiêu ads: 2 transaction song song KHÔNG xen kẽ nhau", async () => {
    const nhatKy: string[] = [];
    await Promise.all([
      chayCoKhoa(giuKhoaGhiChiTieuAds, "A", 300, nhatKy),
      chayCoKhoa(giuKhoaGhiChiTieuAds, "B", 50, nhatKy),
    ]);

    expect(nhatKy).toHaveLength(4);
    expect(coXenKe(nhatKy)).toBe(false);
  });

  it("hai khoá KHÁC nhau thì KHÔNG chặn nhau — ingest ads không được đứng chờ lượt land đơn", async () => {
    const nhatKy: string[] = [];
    await Promise.all([
      chayCoKhoa(giuKhoaLandDon, "A", 300, nhatKy),
      chayCoKhoa(giuKhoaGhiChiTieuAds, "B", 50, nhatKy),
    ]);

    // B giữ khoá khác nên phải chạy xong TRƯỚC khi A nhả (nếu bị chặn thì B:ra sẽ nằm sau A:ra).
    expect(coXenKe(nhatKy)).toBe(true);
  });
});
