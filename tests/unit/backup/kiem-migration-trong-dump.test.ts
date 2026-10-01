import { describe, expect, it } from "vitest";

import {
  assertDumpCoM1HoanTat,
  docDongPrismaMigrationsTuCopy,
  LoiBackupTruocPhanQuyen,
  m1HoanTat,
  TEN_MIGRATION_PHAN_QUYEN,
} from "@/lib/backup/kiem-migration-trong-dump";

/**
 * Cổng "dump đời trước phân quyền" đọc bảng `_prisma_migrations` từ khối `COPY … FROM stdin;` của
 * dump — đúng bảng, đúng schema, cột theo TÊN trong header. Nhận nhầm khối (bảng gần tên, schema
 * khác, chuỗi tên M1 nằm trong bảng khác) là cho một dump cũ đi qua cổng rồi phá DB đời mới.
 */

const M1 = TEN_MIGRATION_PHAN_QUYEN;
const COT_CHUAN =
  "id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count";
const T = "2026-09-30 17:00:00.123+07";

/** Một dòng COPY theo đúng thứ tự `COT_CHUAN`. */
function dong(p: { id: string; ten: string; finished: string | null; rolledBack: string | null }): string {
  return [p.id, "abc123", p.finished ?? "\\N", p.ten, "\\N", p.rolledBack ?? "\\N", T, "1"].join("\t");
}

function khoi(dauKhoi: string, than: string[]): string {
  return [dauKhoi, ...than, "\\."].join("\n");
}

const DAU_APP = `COPY app._prisma_migrations (${COT_CHUAN}) FROM stdin;`;

describe("docDongPrismaMigrationsTuCopy", () => {
  it("TEN_MIGRATION_PHAN_QUYEN trùng tên thư mục migration M1", () => {
    expect(M1).toBe("20260930170000_tai_khoan_phu_phan_quyen");
  });

  it("(a) 3 dòng: hoàn tất / finished_at \\N / rolled_back_at có giá trị ⇒ 3 object, null đúng chỗ", () => {
    const sql = [
      "SET statement_timeout = 0;",
      "",
      khoi(DAU_APP, [
        dong({ id: "a", ten: "20260101000000_dau", finished: T, rolledBack: null }),
        dong({ id: "b", ten: "20260102000000_do_dang", finished: null, rolledBack: null }),
        dong({ id: "c", ten: "20260103000000_da_huy", finished: T, rolledBack: T }),
      ]),
      "",
    ].join("\n");
    const rows = docDongPrismaMigrationsTuCopy(sql, "app");
    expect(rows).toEqual([
      { migration_name: "20260101000000_dau", finished_at: T, rolled_back_at: null },
      { migration_name: "20260102000000_do_dang", finished_at: null, rolled_back_at: null },
      { migration_name: "20260103000000_da_huy", finished_at: T, rolled_back_at: T },
    ]);
    expect(m1HoanTat(rows)).toBe(false); // không có dòng M1

    const coM1 = docDongPrismaMigrationsTuCopy(
      khoi(DAU_APP, [dong({ id: "m", ten: M1, finished: T, rolledBack: null })]),
      "app",
    );
    expect(m1HoanTat(coM1)).toBe(true);
    expect(() => assertDumpCoM1HoanTat(coM1)).not.toThrow();
  });

  it("M1 có mặt nhưng finished_at \\N (migration hỏng giữa chừng) ⇒ chưa hoàn tất", () => {
    const rows = docDongPrismaMigrationsTuCopy(
      khoi(DAU_APP, [dong({ id: "m", ten: M1, finished: null, rolledBack: null })]),
      "app",
    );
    expect(rows).toHaveLength(1);
    expect(m1HoanTat(rows)).toBe(false);
    expect(() => assertDumpCoM1HoanTat(rows)).toThrow(LoiBackupTruocPhanQuyen);
  });

  it("(b) không có khối ⇒ [] và assert ném LoiBackupTruocPhanQuyen (đúng thông báo 422)", () => {
    const rows = docDongPrismaMigrationsTuCopy("SET client_encoding = 'UTF8';\n", "app");
    expect(rows).toEqual([]);
    expect(() => assertDumpCoM1HoanTat(rows)).toThrow(LoiBackupTruocPhanQuyen);
    try {
      assertDumpCoM1HoanTat(rows);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("LoiBackupTruocPhanQuyen");
      expect((e as Error).message).toBe(
        "Bản backup chụp trước bản phân quyền (hoặc migration chưa hoàn tất) — phục hồi qua quy trình " +
          "trên host, mục 'Phục hồi dump đời trước phân quyền' của runbook",
      );
    }
  });

  it("(c) bảng tên gần giống `_prisma_migrations_old` ⇒ bỏ qua", () => {
    const sql = khoi(`COPY app."_prisma_migrations_old" (${COT_CHUAN}) FROM stdin;`, [
      dong({ id: "m", ten: M1, finished: T, rolledBack: null }),
    ]);
    expect(docDongPrismaMigrationsTuCopy(sql, "app")).toEqual([]);
  });

  it("(d) chuỗi tên M1 nằm trong khối COPY của bảng khác ⇒ không nhận", () => {
    const sql = khoi('COPY app."Setting" (key, value) FROM stdin;', [`ghiChu\t${M1}`]);
    expect(docDongPrismaMigrationsTuCopy(sql, "app")).toEqual([]);
  });

  it("(d') dòng DỮ LIỆU của bảng khác giả header khối migration ⇒ vẫn chỉ là dữ liệu của bảng đó", () => {
    // Bảng 1 cột: dòng dữ liệu trông y hệt một header COPY hợp lệ. Đang ở trong khối khác thì mọi
    // dòng tới `\.` là dữ liệu của khối đó, không được mở khối mới.
    const sql = khoi('COPY app."GhiChu" (noiDung) FROM stdin;', [
      DAU_APP,
      dong({ id: "m", ten: M1, finished: T, rolledBack: null }),
    ]);
    expect(docDongPrismaMigrationsTuCopy(sql, "app")).toEqual([]);
  });

  it("(e) khối ở schema khác (`public`) khi đích là `app` ⇒ []", () => {
    const sql = khoi(`COPY public."_prisma_migrations" (${COT_CHUAN}) FROM stdin;`, [
      dong({ id: "m", ten: M1, finished: T, rolledBack: null }),
    ]);
    expect(docDongPrismaMigrationsTuCopy(sql, "app")).toEqual([]);
    expect(docDongPrismaMigrationsTuCopy(sql, "public")).toHaveLength(1);
  });

  it("header có nháy kép quanh schema/bảng và không qualify schema vẫn nhận", () => {
    const dongM1 = dong({ id: "m", ten: M1, finished: T, rolledBack: null });
    expect(
      docDongPrismaMigrationsTuCopy(khoi(`COPY "app"."_prisma_migrations" (${COT_CHUAN}) FROM stdin;`, [dongM1]), "app"),
    ).toHaveLength(1);
    expect(
      docDongPrismaMigrationsTuCopy(khoi(`COPY _prisma_migrations (${COT_CHUAN}) FROM stdin;`, [dongM1]), "app"),
    ).toHaveLength(1);
  });

  it("(f) dòng M1 có rolled_back_at ⇒ m1HoanTat false", () => {
    const rows = docDongPrismaMigrationsTuCopy(
      khoi(DAU_APP, [dong({ id: "m", ten: M1, finished: T, rolledBack: T })]),
      "app",
    );
    expect(m1HoanTat(rows)).toBe(false);
    expect(() => assertDumpCoM1HoanTat(rows)).toThrow(LoiBackupTruocPhanQuyen);
  });

  it("M1 bị đánh rolled-back rồi áp lại thành công (2 dòng cùng tên) ⇒ hoàn tất", () => {
    const rows = docDongPrismaMigrationsTuCopy(
      khoi(DAU_APP, [
        dong({ id: "m1", ten: M1, finished: null, rolledBack: T }),
        dong({ id: "m2", ten: M1, finished: T, rolledBack: null }),
      ]),
      "app",
    );
    expect(m1HoanTat(rows)).toBe(true);
  });

  it("(g) khối xuất hiện 2 lần ⇒ hợp cả hai; vẫn đòi ít nhất một dòng M1 hoàn tất", () => {
    const hong = khoi(DAU_APP, [dong({ id: "x", ten: M1, finished: null, rolledBack: null })]);
    const tot = khoi(DAU_APP, [dong({ id: "y", ten: M1, finished: T, rolledBack: null })]);
    const haiKhoiHong = docDongPrismaMigrationsTuCopy(`${hong}\n${hong}\n`, "app");
    expect(haiKhoiHong).toHaveLength(2);
    expect(m1HoanTat(haiKhoiHong)).toBe(false);

    const hongRoiTot = docDongPrismaMigrationsTuCopy(`${hong}\n${tot}\n`, "app");
    expect(hongRoiTot).toHaveLength(2);
    expect(m1HoanTat(hongRoiTot)).toBe(true);
  });

  it("cột theo TÊN trong header — thứ tự bất kỳ", () => {
    const sql = khoi(
      "COPY app._prisma_migrations (rolled_back_at, migration_name, id, finished_at) FROM stdin;",
      [["\\N", M1, "z", T].join("\t")],
    );
    expect(docDongPrismaMigrationsTuCopy(sql, "app")).toEqual([
      { migration_name: M1, finished_at: T, rolled_back_at: null },
    ]);
  });

  it("unescape định dạng COPY text: \\t \\n \\\\ trong giá trị", () => {
    const sql = khoi("COPY app._prisma_migrations (migration_name, finished_at, rolled_back_at) FROM stdin;", [
      ["ten\\tco\\ntab\\\\x", T, "\\N"].join("\t"),
    ]);
    expect(docDongPrismaMigrationsTuCopy(sql, "app")).toEqual([
      { migration_name: "ten\tco\ntab\\x", finished_at: T, rolled_back_at: null },
    ]);
  });

  it("`\\\\N` (backslash + N thật) KHÔNG phải null", () => {
    const sql = khoi("COPY app._prisma_migrations (migration_name, finished_at, rolled_back_at) FROM stdin;", [
      [M1, T, "\\\\N"].join("\t"),
    ]);
    const rows = docDongPrismaMigrationsTuCopy(sql, "app");
    expect(rows[0].rolled_back_at).toBe("\\N");
    expect(m1HoanTat(rows)).toBe(false);
  });

  it("header thiếu cột bắt buộc ⇒ không nhận khối (không đoán)", () => {
    const sql = khoi("COPY app._prisma_migrations (id, migration_name) FROM stdin;", [["m", M1].join("\t")]);
    expect(docDongPrismaMigrationsTuCopy(sql, "app")).toEqual([]);
  });

  it("dòng sai số cột bị bỏ; khối không có `\\.` kết (file cụt) bị bỏ trọn", () => {
    const saiCot = khoi(DAU_APP, [
      ["m", M1, T].join("\t"),
      dong({ id: "ok", ten: "20260101000000_dau", finished: T, rolledBack: null }),
    ]);
    expect(docDongPrismaMigrationsTuCopy(saiCot, "app")).toEqual([
      { migration_name: "20260101000000_dau", finished_at: T, rolled_back_at: null },
    ]);

    const cut = [DAU_APP, dong({ id: "m", ten: M1, finished: T, rolledBack: null })].join("\n");
    expect(docDongPrismaMigrationsTuCopy(cut, "app")).toEqual([]);
  });

  it("chịu được xuống dòng CRLF", () => {
    const sql = khoi(DAU_APP, [dong({ id: "m", ten: M1, finished: T, rolledBack: null })]).replace(/\n/g, "\r\n");
    expect(m1HoanTat(docDongPrismaMigrationsTuCopy(sql, "app"))).toBe(true);
  });
});
