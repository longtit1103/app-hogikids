import { startOfDay } from "date-fns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  suaSoTietKiem,
  taoSoTietKiem,
  xoaSoTietKiem,
} from "@/lib/actions/so-tiet-kiem";
// Tất toán + mở lại sống ở file riêng, khuôn `tat-toan-thau-chi.ts` tách khỏi `khoan-vay.ts`.
import {
  moLaiSoTietKiem,
  tatToanSoTietKiem,
} from "@/lib/actions/tat-toan-so-tiet-kiem";
import { prisma } from "@/lib/prisma";
import { lyDoKhongXoaSoTietKiem } from "@/lib/tiet-kiem/ly-do-khong-xoa-so-tiet-kiem";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test (`hogikids_test`) cho 5 server action sổ tiết kiệm. Mock `requireUser` (gọi
 * `cookies()` — không có request scope trong vitest) + `revalidatePath` (cùng lý do), giống
 * `khoan-vay-actions.integration.test.ts`.
 *
 * Đây là logic TIỀN: mọi con số dưới đây là số LITERAL tính TAY theo spec §6.1, KHÔNG suy lại bằng
 * chính công thức đang kiểm. Trọng tâm:
 *  - gốc về quỹ qua `SAVINGS_IN`, lãi đi đường `ThuNhap` — hai đường không bao giờ trộn;
 *  - đóng `closedAt` là bước CUỐI CÙNG của transaction tất toán (spec §7.2);
 *  - lỗi nào cũng ROLLBACK TRỌN: không có ca "ghi gốc rồi chết ở lãi".
 *
 * `vi.useFakeTimers({ toFake: ["Date"] })` — CHỈ Date: fake luôn timer thì Prisma/pool treo.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

/** "Hôm nay" giả cho cả suite: SAU ngày đáo hạn 05/03/2027 nên tất toán đúng hạn là hợp lệ. */
const HOM_NAY = new Date(2027, 2, 10, 9, 0, 0);

const ngayVn = (ngay: string) => startOfDay(new Date(`${ngay}T00:00:00+07:00`));

/** Ca chuẩn spec: 200tr gửi 05/09/2026, kỳ hạn 6 tháng, đáo hạn 05/03/2027, 5,2%/năm. */
const SO_CHUAN = {
  name: "Sổ 6 tháng VCB",
  bank: "Vietcombank",
  principal: 200_000_000,
  startDate: "2026-09-05",
  termMonths: 6,
  maturityDate: "2027-03-05",
  annualRateBp: 520,
  note: "",
};

/**
 * Lãi đáo hạn tính TAY theo §6.1 — KHÔNG gọi `laiDuKien()` (suy lại bằng chính công thức đang kiểm).
 *   05/09/2026 → 05/03/2027 = 30+31+30+31+31+28 = 181 ngày (2027 KHÔNG nhuận)
 *   200.000.000 × 520 × 181 / (10.000 × 365) = 18.824.000.000.000 / 3.650.000 = 5.157.260,274
 *   round → 5.157.260
 */
const LAI_DAO_HAN = 5_157_260;

async function taoSo(ghiDe: Record<string, unknown> = {}): Promise<string> {
  const res = await taoSoTietKiem({ ...SO_CHUAN, ...ghiDe });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.data.id;
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HOM_NAY);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("taoSoTietKiem", () => {
  it("tạo 1 sổ + ĐÚNG 1 dòng SAVINGS_OUT bằng principal, ngày = ngày gửi", async () => {
    const id = await taoSo();

    const so = await prisma.soTietKiem.findUniqueOrThrow({ where: { id } });
    expect(so).toMatchObject({
      name: "Sổ 6 tháng VCB",
      bank: "Vietcombank",
      principal: 200_000_000,
      termMonths: 6,
      annualRateBp: 520,
      loanId: null,
      closedAt: null,
    });
    expect(so.startDate).toEqual(ngayVn("2026-09-05"));
    expect(so.maturityDate).toEqual(ngayVn("2027-03-05"));

    const dong = await prisma.cashMovement.findFirstOrThrow();
    expect(dong).toMatchObject({
      kind: "SAVINGS_OUT",
      amount: 200_000_000,
      savingsId: id,
      loanId: null,
    });
    expect(dong.date).toEqual(ngayVn("2026-09-05"));
    // "Một sổ = ĐÚNG MỘT dòng gửi" (spec §7.1) — dòng thứ hai là quỹ tụt hai lần.
    expect(await prisma.cashMovement.count()).toBe(1);
    // Tạo sổ KHÔNG bao giờ đẻ thu nhập — lãi chỉ sinh lúc tất toán.
    expect(await prisma.thuNhap.count()).toBe(0);
  });

  it.each([
    [{ name: "" }, "name"],
    [{ name: "x".repeat(61) }, "name"],
    [{ principal: 0 }, "principal"],
    [{ principal: 2_500_000_000 }, "principal"],
    [{ termMonths: 0 }, "termMonths"],
    [{ termMonths: 601 }, "termMonths"],
    [{ annualRateBp: -1 }, "annualRateBp"],
    [{ annualRateBp: 10_001 }, "annualRateBp"],
    [{ maturityDate: "2026-09-05" }, "maturityDate"],
    [{ maturityDate: "2026-09-01" }, "maturityDate"],
    [{ startDate: "2027-04-01" }, "startDate"],
    [{ note: "x".repeat(501) }, "note"],
  ])("input xấu %o → từ chối đúng ô, KHÔNG ghi gì", async (ghiDe, field) => {
    const res = await taoSoTietKiem({ ...SO_CHUAN, ...ghiDe });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe(field);
    expect(await prisma.soTietKiem.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("khoản vay nguồn không tồn tại → câu tiếng Việt, KHÔNG ghi sổ lẫn dòng tiền", async () => {
    const res = await taoSoTietKiem({ ...SO_CHUAN, loanId: "clzzzzzzzzzzzzzzzzzzzzzzz" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không tìm thấy khoản vay nguồn — chọn lại");
    expect(await prisma.soTietKiem.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
  });
});

describe("tatToanSoTietKiem — đúng hạn", () => {
  it("gốc 200.000.000 về quỹ qua SAVINGS_IN, lãi 5.157.260 vào ThuNhap, sổ đóng đúng ngày", async () => {
    const id = await taoSo();

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN });
    expect(res.ok).toBe(true);

    // GỐC — đúng phần gốc, KHÔNG một đồng lãi nào lẫn vào.
    const nhan = await prisma.cashMovement.findFirstOrThrow({
      where: { savingsId: id, kind: "SAVINGS_IN" },
    });
    expect(nhan.amount).toBe(200_000_000);
    expect(nhan.date).toEqual(ngayVn("2027-03-05"));
    expect(nhan.loanId).toBeNull();
    expect(await prisma.cashMovement.count({ where: { savingsId: id } })).toBe(2);

    // LÃI — đường riêng, số LITERAL tính tay ở đầu file.
    const thu = await prisma.thuNhap.findFirstOrThrow({ where: { savingsId: id } });
    expect(thu.amount).toBe(5_157_260);
    expect(thu.kind).toBe("LAI_TIET_KIEM");
    expect(thu.date).toEqual(ngayVn("2027-03-05"));
    expect(thu.refId).toBe(`TIETKIEM:${id}`);
    expect(await prisma.thuNhap.count()).toBe(1);

    // Số đang gửi về ĐÚNG 0: Σ SAVINGS_OUT − Σ SAVINGS_IN = 200tr − 200tr.
    const nhomTien = await prisma.cashMovement.groupBy({
      by: ["kind"],
      where: { savingsId: id },
      _sum: { amount: true },
    });
    const tong = (k: string) => nhomTien.find((x) => x.kind === k)?._sum.amount ?? 0;
    expect(tong("SAVINGS_OUT") - tong("SAVINGS_IN")).toBe(0);

    // `closedAt` = NGÀY TẤT TOÁN chủ shop khai, KHÔNG phải thời điểm bấm nút: badge "rút trước hạn"
    // suy bằng `closedAt < maturityDate` (§6.2) nên lấy `new Date()` là badge sai.
    const so = await prisma.soTietKiem.findUniqueOrThrow({ where: { id } });
    expect(so.closedAt).toEqual(ngayVn("2027-03-05"));
    expect(so.closedAt!.getTime()).toBe(so.maturityDate.getTime()); // đúng hạn ⇒ KHÔNG rút trước hạn
  });

  it("rút TRƯỚC HẠN: lãi nhập tay 1.200.000, closedAt < maturityDate", async () => {
    const id = await taoSo();

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2026-12-05", lai: 1_200_000 });
    expect(res.ok).toBe(true);

    // App KHÔNG đoán lãi rút trước hạn (§6.2) — ghi ĐÚNG con số chủ shop gõ, không tính lại.
    expect((await prisma.thuNhap.findFirstOrThrow({ where: { savingsId: id } })).amount).toBe(
      1_200_000
    );
    // Gốc vẫn TRỌN — rút trước hạn chỉ mất lãi, không mất gốc.
    expect(
      (await prisma.cashMovement.findFirstOrThrow({ where: { savingsId: id, kind: "SAVINGS_IN" } }))
        .amount
    ).toBe(200_000_000);

    const so = await prisma.soTietKiem.findUniqueOrThrow({ where: { id } });
    expect(so.closedAt).toEqual(ngayVn("2026-12-05"));
    expect(so.closedAt!.getTime()).toBeLessThan(so.maturityDate.getTime());
  });

  it("lãi = 0 → KHÔNG đẻ bản ghi ThuNhap nào, gốc vẫn về đủ", async () => {
    const id = await taoSo();

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2026-10-05", lai: 0 });
    expect(res.ok).toBe(true);

    // "Không có thu nhập 0đ trong sổ" (§7.2) — một dòng 0đ là rác vào thẳng bảng P&L.
    expect(await prisma.thuNhap.count()).toBe(0);
    expect(
      (await prisma.cashMovement.findFirstOrThrow({ where: { savingsId: id, kind: "SAVINGS_IN" } }))
        .amount
    ).toBe(200_000_000);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
  });

  it("tất toán lần hai → 'Sổ này đã tất toán', KHÔNG đẻ thêm dòng nào", async () => {
    const id = await taoSo();
    expect((await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN })).ok).toBe(
      true
    );

    const lai2 = await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-06", lai: 999_999 });
    expect(lai2.ok).toBe(false);
    if (!lai2.ok) expect(lai2.error).toBe("Sổ này đã tất toán");

    expect(await prisma.cashMovement.count({ where: { savingsId: id, kind: "SAVINGS_IN" } })).toBe(1);
    expect(await prisma.thuNhap.count()).toBe(1);
    expect((await prisma.thuNhap.findFirstOrThrow()).amount).toBe(5_157_260);
  });
});

describe("tatToanSoTietKiem — ba cận ngày (§7.2.1)", () => {
  it("CẬN 1: ngày tất toán TRƯỚC ngày gửi → từ chối tại ô ngày, rollback trọn", async () => {
    const id = await taoSo();

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2026-09-01", lai: LAI_DAO_HAN });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("Ngày tất toán phải từ ngày gửi (05/09/2026) trở đi");
      expect(res.field).toBe("ngayTatToan");
    }
    expect(await prisma.cashMovement.count({ where: { kind: "SAVINGS_IN" } })).toBe(0);
    expect(await prisma.thuNhap.count()).toBe(0);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
  });

  it("CẬN 2: ngày tất toán TRƯỚC dòng gửi muộn nhất → từ chối, rollback trọn", async () => {
    const id = await taoSo();
    // Dòng gửi ghi tay đề ngày 20/10 (cửa 6 chặn ca này từ phase 04; đây mô phỏng dữ liệu đã có).
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2026-10-20"),
        kind: "SAVINGS_OUT",
        amount: 50_000_000,
        savingsId: id,
        description: "Gửi thêm ghi tay",
      },
    });

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2026-10-10", lai: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("Ngày tất toán phải từ dòng gửi gần nhất (20/10/2026) trở đi");
      expect(res.field).toBe("ngayTatToan");
    }
    expect(await prisma.cashMovement.count({ where: { kind: "SAVINGS_IN" } })).toBe(0);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
  });

  it("CẬN 3: ngày tất toán ở TƯƠNG LAI → từ chối ở tầng zod, không chạm DB", async () => {
    const id = await taoSo();

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2027-04-01", lai: LAI_DAO_HAN });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("Không cho ngày tương lai");
      expect(res.field).toBe("ngayTatToan");
    }
    expect(await prisma.cashMovement.count({ where: { kind: "SAVINGS_IN" } })).toBe(0);
    expect(await prisma.thuNhap.count()).toBe(0);
  });

  it("sổ có dòng gửi ghi tay thêm → nhận lại ĐỦ cả phần đó, số đang gửi về 0", async () => {
    const id = await taoSo();
    // Sổ 200tr + một dòng gửi ghi tay 100tr ⇒ tiền THẬT đã ra khỏi quỹ là 300tr.
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2026-10-01"),
        kind: "SAVINGS_OUT",
        amount: 100_000_000,
        savingsId: id,
        description: "Gửi thêm ghi tay",
      },
    });

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2026-11-01", lai: 500_000 });
    expect(res.ok).toBe(true);

    // Nhận lại ĐÚNG 300tr chứ không phải `principal` 200tr — bằng đúng số đã rời quỹ.
    const nhan = await prisma.cashMovement.findFirstOrThrow({
      where: { savingsId: id, kind: "SAVINGS_IN" },
    });
    expect(nhan.amount).toBe(300_000_000);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
  });

  /**
   * Ca review đối kháng bắt được (17/09): cửa 6 CHO PHÉP ghi tay `SAVINGS_IN` (ngân hàng trả gốc
   * làm nhiều đợt là chuyện thật), nên `principal` không còn là số đúng để đưa về quỹ. Bản cũ ghi
   * cứng `principal` ⇒ số dư âm ⇒ chặn ⇒ sổ KẸT VĨNH VIỄN: không tất toán được, không xoá được (đã
   * có dòng ghi tay), nên bản ghi lãi KHÔNG BAO GIỜ sinh và P&L thiếu trọn khoản lãi.
   */
  it("ngân hàng trả gốc TRƯỚC bằng dòng ghi tay → vẫn tất toán được, lãi vào sổ thu nhập", async () => {
    const id = await taoSo();
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2027-03-01"),
        kind: "SAVINGS_IN",
        amount: 200_000_000,
        savingsId: id,
        description: "Ngân hàng trả gốc, ghi tay",
      },
    });

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN });
    expect(res.ok).toBe(true);

    // Gốc đã về quỹ bằng dòng ghi tay rồi ⇒ KHÔNG đẻ dòng 0đ thứ hai.
    expect(await prisma.cashMovement.count({ where: { savingsId: id, kind: "SAVINGS_IN" } })).toBe(1);
    // Nhưng LÃI vẫn phải vào — đây chính là thứ bản cũ đánh mất.
    expect((await prisma.thuNhap.findFirstOrThrow({ where: { savingsId: id } })).amount).toBe(
      5_157_260
    );
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
  });

  it("đã nhận lại hết gốc bằng dòng ghi tay VÀ không có lãi → từ chối, nói rõ không còn gì để ghi", async () => {
    const id = await taoSo();
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2027-03-01"),
        kind: "SAVINGS_IN",
        amount: 200_000_000,
        savingsId: id,
        description: "Ngân hàng trả gốc, ghi tay",
      },
    });

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("không còn gì để ghi");
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
  });

  it("dòng ghi tay làm số đang gửi ÂM → từ chối, không đóng sổ dở", async () => {
    const id = await taoSo();
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2027-03-01"),
        kind: "SAVINGS_IN",
        amount: 250_000_000, // nhiều hơn 200tr đã gửi
        savingsId: id,
        description: "Ghi tay sai số",
      },
    });

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("nhiều hơn số đã gửi");
    expect(await prisma.thuNhap.count()).toBe(0);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
  });

  it("refId chặn ghi lãi lần 2 → rollback trọn, sổ VẪN mở, không dòng gốc rác", async () => {
    const id = await taoSo();
    // Bản ghi lãi còn sót (mô phỏng lượt mở lại hỏng nửa chừng / dữ liệu nạp tay).
    await prisma.thuNhap.create({
      data: {
        date: ngayVn("2027-01-01"),
        kind: "LAI_TIET_KIEM",
        amount: 111_111,
        savingsId: id,
        refId: `TIETKIEM:${id}`,
        description: "Lãi còn sót",
      },
    });

    const res = await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Sổ này đã ghi lãi rồi");

    // Dòng GỐC ghi ở bước 3 phải BIẾN MẤT — nếu còn, quỹ cộng 200tr mà sổ vẫn báo đang gửi.
    expect(await prisma.cashMovement.count({ where: { kind: "SAVINGS_IN" } })).toBe(0);
    expect(await prisma.thuNhap.count()).toBe(1);
    expect((await prisma.thuNhap.findFirstOrThrow()).amount).toBe(111_111);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
  });
});

describe("tatToanSoTietKiem — fencing hai tab", () => {
  it("hai tab bấm CÙNG LÚC (có lãi) → đúng 1 lượt ok, đúng 1 bộ dòng, KHÔNG dòng rác", async () => {
    const id = await taoSo();

    const ket = await Promise.all([
      tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN }),
      tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN }),
    ]);

    expect(ket.filter((r) => r.ok)).toHaveLength(1);
    // Lượt thua phải rollback TRỌN: đếm dòng là phép chứng minh duy nhất — nó ghi gốc ở bước 3
    // TRƯỚC khi thua ở bước 6, nên còn sót là quỹ cộng 400tr cho một sổ 200tr.
    expect(await prisma.cashMovement.count({ where: { savingsId: id, kind: "SAVINGS_IN" } })).toBe(1);
    expect(await prisma.thuNhap.count()).toBe(1);
    expect((await prisma.thuNhap.findFirstOrThrow()).amount).toBe(5_157_260);

    const so = await prisma.soTietKiem.findUniqueOrThrow({ where: { id } });
    expect(so.closedAt).toEqual(ngayVn("2027-03-05"));
  });

  it("hai tab bấm CÙNG LÚC, lãi = 0 → vẫn đúng 1 lượt ok (CHỈ fencing đỡ)", async () => {
    // Ca trên có `lai > 0` nên `refId @unique` CÓ THỂ là thứ chặn thật. `lai: 0` không sinh ThuNhap
    // ⇒ nếu điều kiện `closedAt: null` trong câu UPDATE hỏng, ca này ghi ĐÔI dòng nhận lại gốc.
    const id = await taoSo();

    const ket = await Promise.all([
      tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: 0 }),
      tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: 0 }),
    ]);

    expect(ket.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.cashMovement.count({ where: { savingsId: id, kind: "SAVINGS_IN" } })).toBe(1);
    expect(await prisma.thuNhap.count()).toBe(0);
    // Σ SAVINGS_OUT − Σ SAVINGS_IN = 0, không âm: ghi đôi sẽ ra −200.000.000.
    const nhom = await prisma.cashMovement.groupBy({
      by: ["kind"],
      where: { savingsId: id },
      _sum: { amount: true },
    });
    const tong = (k: string) => nhom.find((x) => x.kind === k)?._sum.amount ?? 0;
    expect(tong("SAVINGS_OUT") - tong("SAVINGS_IN")).toBe(0);
  });
});

describe("moLaiSoTietKiem", () => {
  it("mở lại xoá ĐÚNG lãi theo refId + dòng nhận lại, sổ về trạng thái đang gửi 200.000.000", async () => {
    const id = await taoSo();
    expect((await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN })).ok).toBe(
      true
    );

    const res = await moLaiSoTietKiem({ id });
    expect(res.ok).toBe(true);

    // Bỏ sót `ThuNhap` là lãi ở lại P&L trong khi sổ báo đang gửi (§7.3).
    expect(await prisma.thuNhap.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { savingsId: id, kind: "SAVINGS_IN" } })).toBe(0);
    // Dòng GỬI phải còn nguyên — mở lại không đụng vào nó.
    const gui = await prisma.cashMovement.findFirstOrThrow({
      where: { savingsId: id, kind: "SAVINGS_OUT" },
    });
    expect(gui.amount).toBe(200_000_000);
    expect(await prisma.cashMovement.count({ where: { savingsId: id } })).toBe(1);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
  });

  it("mở lại rồi tất toán lại được (refId đã dọn) — lãi ghi lại ĐÚNG số mới", async () => {
    const id = await taoSo();
    expect((await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN })).ok).toBe(
      true
    );
    expect((await moLaiSoTietKiem({ id })).ok).toBe(true);

    const lai2 = await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: 4_000_000 });
    expect(lai2.ok).toBe(true);
    expect(await prisma.thuNhap.count()).toBe(1);
    expect((await prisma.thuNhap.findFirstOrThrow()).amount).toBe(4_000_000);
    expect(await prisma.cashMovement.count({ where: { savingsId: id, kind: "SAVINGS_IN" } })).toBe(1);
  });

  it("sổ có HAI dòng SAVINGS_IN → TỪ CHỐI mở lại, không xoá gì (app không đoán xoá dòng nào)", async () => {
    const id = await taoSo();
    expect((await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN })).ok).toBe(
      true
    );
    // Dòng nhận lại ghi tay thêm của chủ shop.
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2027-03-06"),
        kind: "SAVINGS_IN",
        amount: 10_000_000,
        savingsId: id,
        description: "Nhận thêm ghi tay",
      },
    });

    const res = await moLaiSoTietKiem({ id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("nhiều hơn một dòng nhận lại gốc");

    // KHÔNG xoá gì: cả hai dòng nhận lại và bản ghi lãi còn nguyên, sổ vẫn đóng.
    expect(await prisma.cashMovement.count({ where: { savingsId: id, kind: "SAVINGS_IN" } })).toBe(2);
    expect(await prisma.thuNhap.count()).toBe(1);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
  });

  it("sổ đang gửi → 'Sổ này đang gửi — không cần mở lại', dòng gửi còn nguyên", async () => {
    const id = await taoSo();

    const res = await moLaiSoTietKiem({ id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Sổ này đang gửi — không cần mở lại");
    expect(await prisma.cashMovement.count({ where: { savingsId: id } })).toBe(1);
  });
});

describe("suaSoTietKiem", () => {
  it("đổi principal + startDate → dòng SAVINGS_OUT đổi theo ĐÚNG số và ĐÚNG ngày", async () => {
    const id = await taoSo();

    const res = await suaSoTietKiem({
      ...SO_CHUAN,
      id,
      principal: 150_000_000,
      startDate: "2026-09-10",
      name: "Sổ 6 tháng VCB (sửa)",
      annualRateBp: 600,
    });
    expect(res.ok).toBe(true);

    const so = await prisma.soTietKiem.findUniqueOrThrow({ where: { id } });
    expect(so).toMatchObject({
      name: "Sổ 6 tháng VCB (sửa)",
      principal: 150_000_000,
      annualRateBp: 600,
    });
    expect(so.startDate).toEqual(ngayVn("2026-09-10"));

    // Sửa hồ sơ mà quên dòng tiền = quỹ vẫn tụt 200tr trong khi sổ khai 150tr.
    const gui = await prisma.cashMovement.findFirstOrThrow({
      where: { savingsId: id, kind: "SAVINGS_OUT" },
    });
    expect(gui.amount).toBe(150_000_000);
    expect(gui.date).toEqual(ngayVn("2026-09-10"));
    expect(await prisma.cashMovement.count({ where: { savingsId: id } })).toBe(1);
  });

  it("chỉ đổi tên/ghi chú → dòng SAVINGS_OUT KHÔNG bị chạm (giữ nguyên id, số, ngày)", async () => {
    const id = await taoSo();
    const truoc = await prisma.cashMovement.findFirstOrThrow({ where: { savingsId: id } });

    const res = await suaSoTietKiem({ ...SO_CHUAN, id, name: "Đổi tên", note: "ghi chú mới" });
    expect(res.ok).toBe(true);

    const sau = await prisma.cashMovement.findFirstOrThrow({ where: { savingsId: id } });
    expect(sau.id).toBe(truoc.id);
    expect(sau.amount).toBe(200_000_000);
    expect(sau.date).toEqual(ngayVn("2026-09-05"));
  });

  it("sổ ĐÃ tất toán → từ chối sửa, hồ sơ và dòng tiền không đổi", async () => {
    const id = await taoSo();
    expect((await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN })).ok).toBe(
      true
    );

    const res = await suaSoTietKiem({ ...SO_CHUAN, id, principal: 1_000_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Sổ đã tất toán — mở lại trước khi sửa");

    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).principal).toBe(
      200_000_000
    );
    expect(
      (await prisma.cashMovement.findFirstOrThrow({ where: { savingsId: id, kind: "SAVINGS_OUT" } }))
        .amount
    ).toBe(200_000_000);
  });

  it("input xấu → từ chối đúng ô, hồ sơ không đổi", async () => {
    const id = await taoSo();

    const res = await suaSoTietKiem({ ...SO_CHUAN, id, maturityDate: "2026-09-01" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("maturityDate");
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).maturityDate).toEqual(
      ngayVn("2027-03-05")
    );
  });

  it("sổ có HAI dòng gửi mà đổi principal → từ chối, không sửa dòng nào", async () => {
    const id = await taoSo();
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2026-10-01"),
        kind: "SAVINGS_OUT",
        amount: 50_000_000,
        savingsId: id,
        description: "Gửi thêm ghi tay",
      },
    });

    const res = await suaSoTietKiem({ ...SO_CHUAN, id, principal: 150_000_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("nhiều hơn một dòng gửi");

    // Rollback TRỌN: hồ sơ cũng không được đổi (câu update sổ chạy TRƯỚC cổng này).
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).principal).toBe(
      200_000_000
    );
    const tong = await prisma.cashMovement.aggregate({
      where: { savingsId: id, kind: "SAVINGS_OUT" },
      _sum: { amount: true },
    });
    expect(tong._sum.amount).toBe(250_000_000);
  });
});

describe("xoaSoTietKiem", () => {
  it("sổ sạch (chưa tất toán, đúng 1 dòng gửi) → xoá cả sổ lẫn dòng gửi", async () => {
    const id = await taoSo();

    const res = await xoaSoTietKiem({ id });
    expect(res.ok).toBe(true);

    expect(await prisma.soTietKiem.count()).toBe(0);
    // FK `onDelete: Restrict` là hàng rào cuối — dòng gửi phải được dọn TRƯỚC khi xoá hồ sơ.
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("sổ ĐÃ tất toán → chặn bằng lý do daTatToan, KHÔNG phải lý do coThuNhap", async () => {
    const id = await taoSo();
    expect((await tatToanSoTietKiem({ id, ngayTatToan: "2027-03-05", lai: LAI_DAO_HAN })).ok).toBe(
      true
    );
    // Sổ này đồng thời CÓ `ThuNhap` — nếu server xét sai thứ tự, câu trả về sẽ là câu của coThuNhap.
    expect(await prisma.thuNhap.count()).toBe(1);

    const res = await xoaSoTietKiem({ id });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // So với chính hàm thuần (phase 02) — điều cần chứng minh ở ĐÂY là server chọn ĐÚNG trạng thái
      // và ĐÚNG thứ tự cổng, không phải nội dung câu (nội dung đã có test riêng ở phase 02).
      expect(res.error).toBe(
        lyDoKhongXoaSoTietKiem({ daTatToan: true, coThuNhap: true, coDongGhiTay: false })
      );
      expect(res.error).not.toBe(
        lyDoKhongXoaSoTietKiem({ daTatToan: false, coThuNhap: true, coDongGhiTay: false })
      );
    }
    expect(await prisma.soTietKiem.count()).toBe(1);
    expect(await prisma.thuNhap.count()).toBe(1);
  });

  it("sổ chưa tất toán nhưng CÓ dòng ghi tay → chặn bằng lý do coDongGhiTay, không xoá gì", async () => {
    const id = await taoSo();
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2026-10-01"),
        kind: "SAVINGS_IN",
        amount: 20_000_000,
        savingsId: id,
        description: "Nhận lại một phần ghi tay",
      },
    });

    const res = await xoaSoTietKiem({ id });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(
        lyDoKhongXoaSoTietKiem({ daTatToan: false, coThuNhap: false, coDongGhiTay: true })
      );
    }
    expect(await prisma.soTietKiem.count()).toBe(1);
    expect(await prisma.cashMovement.count({ where: { savingsId: id } })).toBe(2);
  });

  it("dòng gửi THỨ HAI cũng tính là dòng ghi tay → chặn", async () => {
    const id = await taoSo();
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2026-10-01"),
        kind: "SAVINGS_OUT",
        amount: 50_000_000,
        savingsId: id,
        description: "Gửi thêm ghi tay",
      },
    });

    const res = await xoaSoTietKiem({ id });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(
        lyDoKhongXoaSoTietKiem({ daTatToan: false, coThuNhap: false, coDongGhiTay: true })
      );
    }
    expect(await prisma.soTietKiem.count()).toBe(1);
  });

  it("sổ không tồn tại → câu tiếng Việt, không 500", async () => {
    const res = await xoaSoTietKiem({ id: "clzzzzzzzzzzzzzzzzzzzzzzz" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không tìm thấy sổ tiết kiệm");
  });
});
