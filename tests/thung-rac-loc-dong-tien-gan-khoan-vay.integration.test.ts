import type { CashMovement, Prisma } from "@/generated/prisma/client";
import { Prisma as P } from "@/generated/prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { dungAnhBanGhi } from "@/lib/thung-rac/chup-anh-ban-ghi";
import { anhDongTienGanSoQuy } from "@/lib/thung-rac/quyen-thung-rac";
import { listThungRac, phamViThungRac, THUNG_RAC_PAGE_SIZE } from "@/lib/thung-rac/thung-rac-queries";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Thùng rác — người thiếu `tai-chinh-so-quy:sua` KHÔNG THẤY dòng `CashMovement` gắn khoản vay / sổ
 * tiết kiệm (đọc từ ảnh chụp). Lọc ở TẦNG QUERY nên `total` và từng trang cùng một tập: lọc sau khi
 * cắt trang sẽ để lại trang thiếu dòng và tổng "N mục" lộ số dòng bị giấu.
 *
 * Luật đọc ảnh phải TRÙNG luật `kiemQuyenBang` (`anhDongTienGanSoQuy`): ca cuối đối chiếu SQL với
 * hàm JS trên cùng một bộ ảnh, kể cả ảnh hỏng (fail-closed ⇒ loại).
 */

const nhanVien = (...quyen: Quyen[]) => nguoiDungGia({ id: "staff-1", role: "STAFF", quyen: new Set(quyen) });
const CHI_DONG_TIEN = nhanVien("tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua");
const DONG_TIEN_VA_SO_QUY = nhanVien(
  "tai-chinh-dong-tien:xem",
  "tai-chinh-dong-tien:sua",
  "tai-chinh-so-quy:xem",
  "tai-chinh-so-quy:sua",
);
const chuShop = () => nguoiDungGia();

let dem = 0;

/** Dòng tiền đã xoá — ảnh dựng bằng CHÍNH `dungAnhBanGhi` mà đường xoá thật dùng. */
async function dongTienDaXoa(
  lienKet: { loanId?: string | null; savingsId?: string | null },
  xoaLuc: Date,
): Promise<string> {
  dem += 1;
  const kind = lienKet.loanId ? "LOAN_REPAY" : lienKet.savingsId ? "SAVINGS_OUT" : "CAPITAL_IN";
  const banGhi: CashMovement = {
    id: `cm-${dem}`,
    date: new Date(2026, 8, 1),
    kind,
    amount: 1_000_000 + dem,
    description: `dòng ${dem}`,
    loanId: lienKet.loanId ?? null,
    savingsId: lienKet.savingsId ?? null,
    createdAt: new Date(2026, 8, 1),
  };
  const { nhan, soTien, ngay, anh } = dungAnhBanGhi({ bang: "CashMovement", banGhi });
  const dong = await prisma.banGhiDaXoa.create({
    data: { bang: "CashMovement", banGhiId: banGhi.id, nhan, soTien, ngay, anh: anh as unknown as Prisma.InputJsonValue, xoaLuc },
  });
  return dong.id;
}

/** Dòng thùng rác với ảnh tuỳ ý (kể cả hỏng) — mô phỏng dữ liệu bản cũ / lệch shape. */
async function dongTienAnhTho(anh: Prisma.InputJsonValue | typeof P.JsonNull, xoaLuc: Date): Promise<string> {
  dem += 1;
  const dong = await prisma.banGhiDaXoa.create({
    data: { bang: "CashMovement", banGhiId: `tho-${dem}`, nhan: `thô ${dem}`, soTien: 1, ngay: new Date(2026, 8, 1), anh, xoaLuc },
  });
  return dong.id;
}

const phut = (n: number) => new Date(2026, 9, 1, 8, n, 0);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  dem = 0;
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("phamViThungRac", () => {
  it("chỉ dòng tiền ⇒ không xem dòng gắn sổ quỹ; có so-quy:sua hoặc chủ shop ⇒ xem", () => {
    expect(phamViThungRac(CHI_DONG_TIEN)).toEqual({ bang: ["CashMovement"], xemDongTienGanSoQuy: false });
    expect(phamViThungRac(DONG_TIEN_VA_SO_QUY).xemDongTienGanSoQuy).toBe(true);
    expect(phamViThungRac(chuShop()).xemDongTienGanSoQuy).toBe(true);
  });
});

describe("listThungRac lọc dòng tiền gắn khoản vay / sổ tiết kiệm", () => {
  it("chỉ dòng tiền ⇒ thấy dòng trơn, KHÔNG thấy dòng gắn khoản vay/sổ; total khớp", async () => {
    const tron = await dongTienDaXoa({}, phut(1));
    await dongTienDaXoa({ loanId: "loan-1" }, phut(2));
    await dongTienDaXoa({ savingsId: "so-1" }, phut(3));

    const { rows, total } = await listThungRac({ ...phamViThungRac(CHI_DONG_TIEN), page: 1 });

    expect(rows.map((r) => r.id)).toEqual([tron]);
    expect(total).toBe(1);
  });

  it("chủ shop và người có so-quy:sua ⇒ thấy đủ", async () => {
    await dongTienDaXoa({}, phut(1));
    await dongTienDaXoa({ loanId: "loan-1" }, phut(2));
    await dongTienDaXoa({ savingsId: "so-1" }, phut(3));

    for (const nd of [chuShop(), DONG_TIEN_VA_SO_QUY]) {
      const { rows, total } = await listThungRac({ ...phamViThungRac(nd), page: 1 });
      expect(total).toBe(3);
      expect(rows).toHaveLength(3);
    }
  });

  it("phân trang: dòng gắn khoản vay xen giữa KHÔNG chiếm chỗ trang; total = số dòng thấy được", async () => {
    const tron: string[] = [];
    // 21 dòng trơn + 5 dòng gắn khoản vay mới hơn (xoá sau) — không lọc ở query thì trang 1 bị 5 dòng
    // khoản vay chiếm chỗ.
    for (let i = 0; i < THUNG_RAC_PAGE_SIZE + 1; i++) tron.push(await dongTienDaXoa({}, phut(i)));
    for (let i = 0; i < 5; i++) await dongTienDaXoa({ loanId: `loan-${i}` }, phut(40 + i));

    const pham = phamViThungRac(CHI_DONG_TIEN);
    const t1 = await listThungRac({ ...pham, page: 1 });
    const t2 = await listThungRac({ ...pham, page: 2 });

    expect(t1.total).toBe(THUNG_RAC_PAGE_SIZE + 1);
    expect(t2.total).toBe(THUNG_RAC_PAGE_SIZE + 1);
    expect(t1.rows).toHaveLength(THUNG_RAC_PAGE_SIZE);
    expect(t2.rows).toHaveLength(1);
    expect([...t1.rows, ...t2.rows].map((r) => r.id)).toEqual([...tron].reverse());

    expect((await listThungRac({ ...phamViThungRac(chuShop()), page: 1 })).total).toBe(THUNG_RAC_PAGE_SIZE + 6);
  });

  it("loại khác (chi phí) không bị luật dòng tiền đụng tới", async () => {
    await dongTienDaXoa({ loanId: "loan-1" }, phut(1));
    const nd = nhanVien("chi-phi:sua", "tai-chinh-dong-tien:sua");
    const chi = await prisma.banGhiDaXoa.create({
      data: {
        bang: "Expense",
        banGhiId: "exp-1",
        nhan: "Cước",
        soTien: 1,
        ngay: new Date(2026, 8, 1),
        xoaLuc: phut(2),
        anh: { ban: 1, chinh: { id: "exp-1", date: "2026-09-01T00:00:00.000Z", categoryId: "shipping", amount: 1, source: "MANUAL", createdAt: "2026-09-01T00:00:00.000Z" }, cashMovements: [], thuNhap: [], ghiChu: {} },
      },
    });
    const { rows, total } = await listThungRac({ ...phamViThungRac(nd), page: 1 });
    expect(rows.map((r) => r.id)).toEqual([chi.id]);
    expect(total).toBe(1);
  });

  it("SQL đọc ảnh TRÙNG luật `kiemQuyenBang`; ảnh hỏng ⇒ loại (fail-closed)", async () => {
    const khung = { ban: 1, cashMovements: [], thuNhap: [], ghiChu: {} };
    const cmTron = { id: "x", date: "2026-09-01T00:00:00.000Z", kind: "CAPITAL_IN", amount: 1, description: "", createdAt: "2026-09-01T00:00:00.000Z" };
    const cacAnh: (Prisma.InputJsonValue | typeof P.JsonNull)[] = [
      { ...khung, chinh: { ...cmTron, loanId: null, savingsId: null } },
      { ...khung, chinh: { ...cmTron } }, // thiếu khoá liên kết = không gắn (khôi phục ra dòng trơn)
      { ...khung, chinh: { ...cmTron, loanId: "l", savingsId: null } },
      { ...khung, chinh: { ...cmTron, loanId: null, savingsId: "s" } },
      { ...khung, chinh: { ...cmTron, loanId: 0, savingsId: null } },
      { ...khung, chinh: { ...cmTron, loanId: false, savingsId: null } },
      { ...khung, chinh: { ...cmTron, loanId: {}, savingsId: null } },
      { ...khung, chinh: null },
      { ...khung, chinh: [] },
      { ...khung, chinh: "x" },
      { ...khung },
      "hỏng",
      42,
      [],
      P.JsonNull,
    ];
    const ketQuaJs = new Map<string, boolean>();
    for (const [i, a] of cacAnh.entries()) {
      const id = await dongTienAnhTho(a, phut(i));
      ketQuaJs.set(id, !anhDongTienGanSoQuy(a === P.JsonNull ? null : a));
    }
    const mongDoi = [...ketQuaJs].filter(([, thay]) => thay).map(([id]) => id).sort();
    // Đối chứng: bộ ảnh phải có cả hai phía, kẻo ca này xanh vì cùng loại hết.
    expect(mongDoi).toHaveLength(2);

    const { rows, total } = await listThungRac({ ...phamViThungRac(CHI_DONG_TIEN), page: 1 });

    expect(rows.map((r) => r.id).sort()).toEqual(mongDoi);
    expect(total).toBe(mongDoi.length);
  });
});
