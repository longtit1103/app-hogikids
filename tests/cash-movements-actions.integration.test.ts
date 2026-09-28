import { addDays, format } from "date-fns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createCashMovement, deleteCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test (`hogikids_test`) cho 3 server action "khoản tiền khác". Mock `requireUser` (gọi
 * cookies() — không có request scope) + `revalidatePath` (cùng lý do), giống expenses-amount-guard.
 * Khoá các CỬA PHẢI TỪ CHỐI: ngày trống/không hợp lệ · ngày tương lai · amount 0/âm/vượt 2 tỷ · kind
 * lạ · id lạ — và message tiếng Việt đúng field để form tô đỏ đúng ô.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Fixture mặc định dùng loại KHÔNG đòi khoản vay; nhóm LOAN_* có describe riêng ở cuối file.
const hopLe = (ghiDe: Record<string, unknown> = {}) => ({
  date: "2026-07-10",
  kind: "CAPITAL_IN",
  amount: 100_000_000,
  description: "Góp vốn tháng 7",
  ...ghiDe,
});

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("createCashMovement", () => {
  it("hợp lệ → ghi đúng kind/amount/description, date parse như Expense", async () => {
    const res = await createCashMovement(hopLe());
    expect(res.ok).toBe(true);
    const row = await prisma.cashMovement.findFirstOrThrow();
    expect(row).toMatchObject({ kind: "CAPITAL_IN", amount: 100_000_000, description: "Góp vốn tháng 7" });
    expect(format(row.date, "yyyy-MM-dd")).toBe("2026-07-10");
  });

  it("description bỏ trống → ''", async () => {
    const res = await createCashMovement(hopLe({ description: undefined }));
    expect(res.ok).toBe(true);
    expect((await prisma.cashMovement.findFirstOrThrow()).description).toBe("");
  });

  it("ngày mai → từ chối field 'date'", async () => {
    const res = await createCashMovement(hopLe({ date: format(addDays(new Date(), 1), "yyyy-MM-dd") }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("date");
      expect(res.error).toBe("Không cho ngày tương lai");
    }
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  // Ô Ngày xoá trống ⇒ client gửi Invalid Date ⇒ React serialize thành null ⇒ coerce ra 01/01/1970.
  // `null`/`0` ra Date năm 1970 (hợp lệ với zod, chỉ refine bắt được); `undefined`/`""` ra Invalid Date
  // nên chết ngay ở bước coerce với message tiếng Anh của zod. Cả bốn đều PHẢI từ chối ở ô "date".
  it.each([
    [null, "Ngày không hợp lệ"],
    [0, "Ngày không hợp lệ"],
    [undefined, undefined],
    ["", undefined],
  ])("date %s → từ chối field 'date', không ghi dòng nào", async (date, thongBao) => {
    const res = await createCashMovement(hopLe({ date }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("date");
      if (thongBao) expect(res.error).toBe(thongBao);
    }
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it.each([
    [0, "Số tiền phải lớn hơn 0"],
    [-5_000_000, "Số tiền phải lớn hơn 0"],
    [2_500_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"],
    [1234.5, "Số tiền phải là số nguyên"],
  ])("amount %s → từ chối field 'amount': %s", async (amount, thongBao) => {
    const res = await createCashMovement(hopLe({ amount }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("amount");
      expect(res.error).toBe(thongBao);
    }
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("amount đúng trần 2.000.000.000 → ok", async () => {
    const res = await createCashMovement(hopLe({ amount: 2_000_000_000 }));
    expect(res.ok).toBe(true);
  });

  it.each(["", "loan_in", "PURCHASE", 7, undefined])("kind lạ %s → từ chối field 'kind' bằng tiếng Việt", async (kind) => {
    const res = await createCashMovement(hopLe({ kind }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("kind");
      expect(res.error).toBe("Chọn loại khoản");
    }
  });

  it("description 201 ký tự → từ chối field 'description'", async () => {
    const res = await createCashMovement(hopLe({ description: "x".repeat(201) }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("description");
      expect(res.error).toBe("Tối đa 200 ký tự");
    }
  });
});

describe("updateCashMovement", () => {
  it("đổi loại VÀO → RA và số tiền; validate y hệt create", async () => {
    await createCashMovement(hopLe());
    const row = await prisma.cashMovement.findFirstOrThrow();

    const res = await updateCashMovement(row.id, hopLe({ kind: "CAPITAL_OUT", amount: 20_000_000, description: "Rút vốn" }));
    expect(res.ok).toBe(true);
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      kind: "CAPITAL_OUT",
      amount: 20_000_000,
      description: "Rút vốn",
    });

    const xau = await updateCashMovement(row.id, hopLe({ amount: 0 }));
    expect(xau.ok).toBe(false);
    if (!xau.ok) expect(xau.field).toBe("amount");
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: row.id } })).amount).toBe(20_000_000);
  });

  it("date null (ô Ngày bị xoá trống) → từ chối, ngày của dòng thật KHÔNG bị dời về 1970", async () => {
    await createCashMovement(hopLe());
    const row = await prisma.cashMovement.findFirstOrThrow();

    const res = await updateCashMovement(row.id, hopLe({ date: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("date");
      expect(res.error).toBe("Ngày không hợp lệ");
    }
    const sau = await prisma.cashMovement.findUniqueOrThrow({ where: { id: row.id } });
    expect(format(sau.date, "yyyy-MM-dd")).toBe("2026-07-10");
  });

  it("id lạ → ok:false 'Không tìm thấy khoản tiền'", async () => {
    const res = await updateCashMovement("id-khong-co", hopLe());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không tìm thấy khoản tiền");
  });
});

describe("deleteCashMovement", () => {
  it("xoá cứng đúng dòng; id lạ → lỗi", async () => {
    await createCashMovement(hopLe());
    await createCashMovement(hopLe({ kind: "CAPITAL_OUT", amount: 1_000, description: "giữ lại" }));
    const xoa = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "CAPITAL_IN" } });

    expect((await deleteCashMovement(xoa.id)).ok).toBe(true);
    expect(await prisma.cashMovement.count()).toBe(1);
    expect((await prisma.cashMovement.findFirstOrThrow()).description).toBe("giữ lại");

    const res = await deleteCashMovement(xoa.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không tìm thấy khoản tiền");
  });
});

/**
 * Nhóm GỐC VAY — hai loại `LOAN_IN`/`LOAN_REPAY` buộc trỏ về một khoản vay cụ thể (spec §5.3 +
 * phán quyết review phase 1). Đây là chỗ dư nợ có thể âm nếu thiếu một cổng, nên khoá đủ CẢ BA
 * đường ghi: tạo, sửa, xoá.
 */
describe("dòng gắn khoản vay", () => {
  const NGAY_VAY = "2026-07-10";
  const GIAI_NGAN = 200_000_000;

  let loanId = "";

  async function taoLoan(ghiDe: Record<string, unknown> = {}): Promise<string> {
    const loan = await prisma.loan.create({
      data: {
        name: "Vay VPBank",
        startDate: new Date(`${NGAY_VAY}T00:00:00+07:00`),
        annualRateBp: 1050,
        termMonths: 12,
        firstDueDate: new Date("2026-08-10T00:00:00+07:00"),
        ...ghiDe,
      },
    });
    return loan.id;
  }

  const dongVay = (ghiDe: Record<string, unknown> = {}) =>
    hopLe({ kind: "LOAN_IN", amount: GIAI_NGAN, description: "Giải ngân", loanId, ...ghiDe });

  beforeEach(async () => {
    loanId = await taoLoan();
  });

  it("LOAN_REPAY thiếu loanId → từ chối field 'loanId' bằng tiếng Việt", async () => {
    const res = await createCashMovement(hopLe({ kind: "LOAN_REPAY", amount: 1_000_000 }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("loanId");
      expect(res.error).toBe("Chọn khoản vay");
    }
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("giải ngân đúng ngày bắt đầu → ok; dòng trả gốc trừ đúng dư nợ", async () => {
    expect((await createCashMovement(dongVay())).ok).toBe(true);
    const traGoc = await createCashMovement(
      hopLe({ kind: "LOAN_REPAY", amount: 50_000_000, description: "Trả gốc", loanId })
    );
    expect(traGoc.ok).toBe(true);
    expect(await prisma.cashMovement.count({ where: { loanId } })).toBe(2);
  });

  it("LOAN_IN thứ HAI cùng khoản → từ chối (1 khoản vay = 1 lần giải ngân)", async () => {
    expect((await createCashMovement(dongVay())).ok).toBe(true);

    const res = await createCashMovement(dongVay({ amount: 30_000_000 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("đã giải ngân");
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_IN" } })).toBe(1);
  });

  it("LOAN_IN vào khoản MANG SANG (đã có dư nợ mở sổ) → từ chối, quỹ không bị thổi phồng", async () => {
    const mangSang = await taoLoan({
      name: "Vay cũ",
      duNoMoSo: 200_000_000,
      startDate: new Date(`${NGAY_VAY}T00:00:00+07:00`),
    });

    const res = await createCashMovement(dongVay({ loanId: mangSang }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("loanId");
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("LOAN_IN ngày KHÁC ngày bắt đầu khoản vay → từ chối (dư nợ đếm theo ngày dòng tiền)", async () => {
    const res = await createCashMovement(dongVay({ date: "2026-07-11" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("date");
      expect(res.error).toContain("10/07/2026");
    }
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("trả gốc vượt dư nợ → 'Vượt dư nợ', KHÔNG ghi dòng nào", async () => {
    expect((await createCashMovement(dongVay())).ok).toBe(true);

    const res = await createCashMovement(
      hopLe({ kind: "LOAN_REPAY", amount: 250_000_000, description: "Trả quá", loanId })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Vượt dư nợ");
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
  });

  it("khoản vay đã tất toán → không nhận thêm dòng nào", async () => {
    await prisma.loan.update({ where: { id: loanId }, data: { closedAt: new Date() } });

    const res = await createCashMovement(dongVay());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Khoản vay đã tất toán");
  });

  it("sửa LOAN_IN xuống DƯỚI tổng gốc đã trả → từ chối, dòng cũ giữ nguyên", async () => {
    expect((await createCashMovement(dongVay())).ok).toBe(true);
    expect(
      (await createCashMovement(hopLe({ kind: "LOAN_REPAY", amount: 150_000_000, description: "Trả", loanId })))
        .ok
    ).toBe(true);
    const giaiNgan = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });

    const res = await updateCashMovement(giaiNgan.id, dongVay({ amount: 100_000_000 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Vượt dư nợ");
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: giaiNgan.id } })).amount).toBe(
      GIAI_NGAN
    );
  });

  it("đổi loại sang khoản KHÔNG phải gốc vay → cắt liên kết khoản vay", async () => {
    expect((await createCashMovement(dongVay())).ok).toBe(true);
    const giaiNgan = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });

    const res = await updateCashMovement(
      giaiNgan.id,
      hopLe({ kind: "CAPITAL_IN", amount: GIAI_NGAN, description: "Thật ra là góp vốn", loanId })
    );
    expect(res.ok).toBe(true);
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: giaiNgan.id } })).toMatchObject({
      kind: "CAPITAL_IN",
      loanId: null,
    });
  });

  it("xoá dòng giải ngân khi ĐÃ trả bớt gốc → từ chối, dòng còn nguyên", async () => {
    expect((await createCashMovement(dongVay())).ok).toBe(true);
    expect(
      (await createCashMovement(hopLe({ kind: "LOAN_REPAY", amount: 50_000_000, description: "Trả", loanId })))
        .ok
    ).toBe(true);
    const giaiNgan = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });

    const res = await deleteCashMovement(giaiNgan.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("đã có lần trả gốc");
    expect(await prisma.cashMovement.count({ where: { id: giaiNgan.id } })).toBe(1);

    // Xoá dòng TRẢ GỐC thì được — dư nợ chỉ tăng lại, không bao giờ âm.
    const traGoc = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_REPAY" } });
    expect((await deleteCashMovement(traGoc.id)).ok).toBe(true);
  });

  it("HAI dòng trả gốc 150tr ghi CÙNG LÚC trên khoản dư nợ 200tr → đúng 1 ok, dư nợ 50tr", async () => {
    // Ca này từng lọt CẢ HAI: vị từ dư nợ cộng lại từ bảng dòng tiền, mà transaction ở isolation
    // mặc định không thấy dòng chưa commit của lượt song song ⇒ cả hai đều thấy "còn đủ 200tr".
    // Cái đỡ là khoá dòng `Loan` (`FOR UPDATE`) ở đầu mỗi transaction chạm gốc vay.
    expect((await createCashMovement(dongVay())).ok).toBe(true);

    const ket = await Promise.all([
      createCashMovement(hopLe({ kind: "LOAN_REPAY", amount: 150_000_000, description: "Trả A", loanId })),
      createCashMovement(hopLe({ kind: "LOAN_REPAY", amount: 150_000_000, description: "Trả B", loanId })),
    ]);

    expect(ket.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);

    const tong = await prisma.cashMovement.groupBy({
      by: ["kind"],
      where: { loanId },
      _sum: { amount: true },
    });
    const lay = (k: string) => tong.find((x) => x.kind === k)?._sum.amount ?? 0;
    expect(lay("LOAN_IN") - lay("LOAN_REPAY")).toBe(50_000_000);
  });

  it("khoản đã tất toán → không xoá, cũng không gỡ được dòng cũ ra khỏi nó", async () => {
    expect((await createCashMovement(dongVay())).ok).toBe(true);
    const giaiNgan = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });
    await prisma.loan.update({ where: { id: loanId }, data: { closedAt: new Date() } });

    const xoa = await deleteCashMovement(giaiNgan.id);
    expect(xoa.ok).toBe(false);
    if (!xoa.ok) expect(xoa.error).toBe("Khoản vay đã tất toán");
    expect(await prisma.cashMovement.count({ where: { id: giaiNgan.id } })).toBe(1);

    // Gỡ liên kết (đổi sang loại không phải gốc vay) cũng đổi dư nợ khoản đã chốt ⇒ chặn luôn.
    const go = await updateCashMovement(
      giaiNgan.id,
      hopLe({ kind: "CAPITAL_IN", amount: GIAI_NGAN, description: "Gỡ ra" })
    );
    expect(go.ok).toBe(false);
    if (!go.ok) expect(go.error).toBe("Khoản vay đã tất toán");
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: giaiNgan.id } })).loanId).toBe(
      loanId
    );
  });

  it("đi vòng qua action, ghi thẳng Prisma LOAN_IN thiếu loanId → CHECK ở DB chặn", async () => {
    await expect(
      prisma.cashMovement.create({
        data: {
          date: new Date(`${NGAY_VAY}T00:00:00+07:00`),
          kind: "LOAN_IN",
          amount: 1_000_000,
          loanId: null,
          description: "Lách zod",
        },
      })
    ).rejects.toThrow();
  });
});

/**
 * SỔ TIẾT KIỆM BẮT BUỘC (`DEPOSIT_OUT`/`DEPOSIT_IN`) — trục thứ HAI của một khoản vay, tách hẳn dư
 * nợ gốc. Hai luật phải khoá trên CẢ BA đường ghi:
 *
 *  1. chỉ khoản `BULLET` mới có sổ này (đường tất toán của loại khác KHÔNG hoàn tiền gửi, tiền của
 *     chủ shop mất dấu khỏi quỹ);
 *  2. số ngân hàng đang giữ (Σ DEPOSIT_OUT − Σ DEPOSIT_IN) KHÔNG BAO GIỜ được âm — `chanDuNoAm` chỉ
 *     đếm dòng GỐC nên nó mù trục này, và mọi chỗ hiển thị đều canh `> 0` nên số âm còn bị GIẤU.
 */
describe("dòng tiền gửi tiết kiệm bắt buộc", () => {
  const NGAY = "2026-07-10";
  const GUI = 300_000;

  let bulletId = "";
  let termId = "";

  async function taoKhoan(ghiDe: Record<string, unknown>): Promise<string> {
    const loan = await prisma.loan.create({
      data: {
        name: "Khoản kiểm tiền gửi",
        startDate: new Date(`${NGAY}T00:00:00+07:00`),
        annualRateBp: 1050,
        firstDueDate: new Date("2026-08-10T00:00:00+07:00"),
        ...ghiDe,
      },
    });
    return loan.id;
  }

  const dongGui = (ghiDe: Record<string, unknown> = {}) =>
    hopLe({ kind: "DEPOSIT_OUT", amount: GUI, description: "Gửi tiết kiệm", loanId: bulletId, ...ghiDe });

  beforeEach(async () => {
    bulletId = await taoKhoan({ kind: "BULLET", termMonths: 36, tienGuiBatBuocMoiKy: GUI });
    termId = await taoKhoan({ kind: "TERM", termMonths: 12, name: "Vay kỳ hạn" });
  });

  it.each([["DEPOSIT_OUT"], ["DEPOSIT_IN"]])(
    "%s gắn khoản KHÔNG phải BULLET → từ chối ở ô 'loanId', không ghi dòng nào",
    async (kind) => {
      const res = await createCashMovement(dongGui({ kind, loanId: termId }));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.field).toBe("loanId");
        expect(res.error).toBe("Chỉ khoản vay trả gốc cuối kỳ mới có sổ tiết kiệm bắt buộc");
      }
      expect(await prisma.cashMovement.count()).toBe(0);
    }
  );

  it("nhận lại VƯỢT số ngân hàng đang giữ → từ chối, dòng không được ghi", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);
    expect((await createCashMovement(dongGui())).ok).toBe(true); // đang giữ 600.000

    const res = await createCashMovement(
      dongGui({ kind: "DEPOSIT_IN", amount: 900_000, description: "Nhận lại quá tay" })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("amount");
      expect(res.error).toContain("Vượt tiền gửi ngân hàng đang giữ");
    }
    expect(await prisma.cashMovement.count({ where: { kind: "DEPOSIT_IN" } })).toBe(0);
  });

  it("SỬA dòng nhận lại thành số vượt → từ chối, số cũ còn nguyên", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);
    expect(
      (await createCashMovement(dongGui({ kind: "DEPOSIT_IN", amount: GUI, description: "Nhận lại" })))
        .ok
    ).toBe(true);
    const nhanLai = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "DEPOSIT_IN" } });

    const res = await updateCashMovement(
      nhanLai.id,
      dongGui({ kind: "DEPOSIT_IN", amount: 900_000, description: "Nhận lại" })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Vượt tiền gửi ngân hàng đang giữ");
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: nhanLai.id } })).amount).toBe(
      GUI
    );
  });

  it("XOÁ dòng gửi sau khi đã nhận lại hết → từ chối bằng câu nói đúng chuyện", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "DEPOSIT_OUT" } });
    expect(
      (await createCashMovement(dongGui({ kind: "DEPOSIT_IN", amount: GUI, description: "Nhận lại" })))
        .ok
    ).toBe(true);

    const res = await deleteCashMovement(dong.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(
        "Khoản vay này đã nhận lại tiền gửi — xoá dòng gửi sẽ làm số ngân hàng giữ âm"
      );
    }
    expect(await prisma.cashMovement.count({ where: { id: dong.id } })).toBe(1);
  });

  /**
   * Hai tab bấm "Nhận lại tiền gửi" cùng lúc trên 300.000 đang giữ. Vị từ kiểm SAU câu ghi không tự
   * đủ (hai lượt cùng đọc một cái tổng cũ) — cái đỡ là khoá dòng `Loan` FOR UPDATE ở đầu transaction,
   * đúng khuôn đã dùng cho dư nợ gốc.
   */
  it("hai lượt nhận lại song song → CHỈ một lượt qua, số đang giữ không âm", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);

    const ket = await Promise.all([
      createCashMovement(dongGui({ kind: "DEPOSIT_IN", amount: GUI, description: "Nhận lại A" })),
      createCashMovement(dongGui({ kind: "DEPOSIT_IN", amount: GUI, description: "Nhận lại B" })),
    ]);
    expect(ket.filter((r) => r.ok)).toHaveLength(1);

    const tong = await prisma.cashMovement.groupBy({
      by: ["kind"],
      where: { loanId: bulletId },
      _sum: { amount: true },
    });
    const lay = (k: string) => tong.find((x) => x.kind === k)?._sum.amount ?? 0;
    expect(lay("DEPOSIT_OUT") - lay("DEPOSIT_IN")).toBe(0);
  });
});

/**
 * SỔ TIẾT KIỆM SINH LÃI (`SAVINGS_OUT`/`SAVINGS_IN`) — cửa 6 của spec §8.1: đường ghi TAY, song song
 * với đường app tự sinh ở `so-tiet-kiem.ts`. Khác hẳn cặp `DEPOSIT_*` (tiền gửi BẮT BUỘC theo hợp
 * đồng vay, gắn `loanId`): cặp này gắn `savingsId` và CHECK dưới DB cấm một dòng mang cả hai.
 *
 * Bốn luật phải khoá trên CẢ BA đường ghi:
 *  1. `SAVINGS_*` bắt buộc `savingsId` — thiếu thì CHECK `CashMovement_savings_bat_buoc` ném lỗi
 *     Postgres THÔ lên mặt chủ shop;
 *  2. sổ đã tất toán KHÔNG nhận dòng mới, cũng không cho gỡ dòng cũ ra;
 *  3. một sổ = ĐÚNG MỘT dòng gửi (`SAVINGS_OUT`) — gửi thêm thì tạo sổ mới (spec §2);
 *  4. số đang gửi (Σ SAVINGS_OUT − Σ SAVINGS_IN) KHÔNG BAO GIỜ âm.
 */
describe("dòng tiền sổ tiết kiệm sinh lãi", () => {
  const NGAY_GUI = "2026-07-05";
  const GOC = 200_000_000;

  let soId = "";
  let soDaDongId = "";
  let loanId = "";

  async function taoSo(ghiDe: Record<string, unknown> = {}): Promise<string> {
    const so = await prisma.soTietKiem.create({
      data: {
        name: "Sổ 6 tháng VCB",
        bank: "Vietcombank",
        principal: GOC,
        startDate: new Date(`${NGAY_GUI}T00:00:00+07:00`),
        termMonths: 6,
        maturityDate: new Date("2027-01-05T00:00:00+07:00"),
        annualRateBp: 520,
        ...ghiDe,
      },
    });
    return so.id;
  }

  const dongGui = (ghiDe: Record<string, unknown> = {}) =>
    hopLe({ kind: "SAVINGS_OUT", amount: GOC, description: "Gửi tiết kiệm", savingsId: soId, ...ghiDe });

  beforeEach(async () => {
    soId = await taoSo();
    soDaDongId = await taoSo({
      name: "Sổ đã tất toán",
      closedAt: new Date("2026-08-01T00:00:00+07:00"),
    });
    const loan = await prisma.loan.create({
      data: {
        name: "Vay kiểm loại trừ",
        startDate: new Date(`${NGAY_GUI}T00:00:00+07:00`),
        annualRateBp: 1050,
        termMonths: 12,
        firstDueDate: new Date("2026-08-05T00:00:00+07:00"),
      },
    });
    loanId = loan.id;
  });

  it.each([["SAVINGS_OUT"], ["SAVINGS_IN"]])(
    "%s thiếu savingsId → từ chối ở ô 'savingsId' bằng tiếng Việt, không ghi dòng nào",
    async (kind) => {
      const res = await createCashMovement(dongGui({ kind, savingsId: undefined }));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.field).toBe("savingsId");
        expect(res.error).toBe("Chọn sổ tiết kiệm");
      }
      expect(await prisma.cashMovement.count()).toBe(0);
    }
  );

  it("savingsId rỗng chuỗi → vẫn là 'chưa chọn', KHÔNG để lọt xuống CHECK dưới DB", async () => {
    const res = await createCashMovement(dongGui({ savingsId: "" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("savingsId");
      expect(res.error).toBe("Chọn sổ tiết kiệm");
    }
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("loại KHÁC mà lỡ mang savingsId (đổi loại trên form) → cắt về null, không vướng CHECK", async () => {
    const res = await createCashMovement(
      hopLe({ kind: "CAPITAL_IN", amount: 1_000_000, description: "Góp vốn", savingsId: soId })
    );
    expect(res.ok).toBe(true);
    expect((await prisma.cashMovement.findFirstOrThrow()).savingsId).toBeNull();
  });

  it("đi vòng qua action, ghi thẳng Prisma SAVINGS_OUT thiếu savingsId → CHECK ở DB chặn", async () => {
    await expect(
      prisma.cashMovement.create({
        data: {
          date: new Date(`${NGAY_GUI}T00:00:00+07:00`),
          kind: "SAVINGS_OUT",
          amount: 1_000_000,
          savingsId: null,
          description: "Lách zod",
        },
      })
    ).rejects.toThrow();
  });

  it("SAVINGS_OUT hợp lệ → ghi đúng sổ, số đang gửi = gốc", async () => {
    const res = await createCashMovement(dongGui());
    expect(res.ok).toBe(true);

    const row = await prisma.cashMovement.findFirstOrThrow();
    expect(row).toMatchObject({ kind: "SAVINGS_OUT", amount: GOC, savingsId: soId, loanId: null });
  });

  it("trỏ sổ ĐÃ tất toán → từ chối, không ghi dòng nào", async () => {
    const res = await createCashMovement(dongGui({ savingsId: soDaDongId }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Câu do vị từ DÙNG CHUNG `kiemSoTietKiemConHieuLuc` ném (phase 02) — cố ý giữ nguyên câu của
      // vị từ thay vì để mỗi đường ghi tự đặt một câu: nó chỉ luôn đường thoát ("mở lại sổ trước"),
      // và hai đường ghi nói cùng một câu thì chủ shop không phải học hai cách diễn đạt.
      expect(res.error).toContain("đã tất toán");
      expect(res.error).toContain("mở lại sổ");
      expect(res.field).toBe("savingsId");
    }
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("sổ đã có dòng gửi → từ chối gửi thêm (1 sổ = ĐÚNG 1 dòng gửi)", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);

    const res = await createCashMovement(dongGui({ amount: 10_000_000, description: "Gửi thêm" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("savingsId");
      expect(res.error).toBe("Sổ này đã có dòng gửi — gửi thêm thì tạo sổ tiết kiệm mới");
    }
    expect(await prisma.cashMovement.count({ where: { kind: "SAVINGS_OUT" } })).toBe(1);
  });

  it("nhận lại VƯỢT số đang gửi → từ chối ở ô 'amount', dòng không được ghi", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);

    const res = await createCashMovement(
      dongGui({ kind: "SAVINGS_IN", amount: GOC + 1, description: "Nhận lại quá tay" })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("amount");
    expect(await prisma.cashMovement.count({ where: { kind: "SAVINGS_IN" } })).toBe(0);
  });

  /**
   * Hai tab bấm "Nhận lại gốc tiết kiệm" cùng lúc trên 200tr đang gửi. Vị từ kiểm SAU câu ghi không
   * tự đủ (hai lượt cùng đọc một cái tổng cũ) — cái đỡ là khoá dòng `SoTietKiem` FOR UPDATE ở đầu
   * transaction, đúng khuôn đã dùng cho dư nợ gốc vay.
   */
  it("hai lượt nhận lại song song → CHỈ một lượt qua, số đang gửi không âm", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);

    const ket = await Promise.all([
      createCashMovement(dongGui({ kind: "SAVINGS_IN", amount: GOC, description: "Nhận lại A" })),
      createCashMovement(dongGui({ kind: "SAVINGS_IN", amount: GOC, description: "Nhận lại B" })),
    ]);
    expect(ket.filter((r) => r.ok)).toHaveLength(1);

    const tong = await prisma.cashMovement.groupBy({
      by: ["kind"],
      where: { savingsId: soId },
      _sum: { amount: true },
    });
    const lay = (k: string) => tong.find((x) => x.kind === k)?._sum.amount ?? 0;
    expect(lay("SAVINGS_OUT") - lay("SAVINGS_IN")).toBe(0);
  });

  it("SỬA dòng nhận lại thành số vượt → từ chối, số cũ còn nguyên", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);
    expect(
      (await createCashMovement(
        dongGui({ kind: "SAVINGS_IN", amount: GOC, description: "Nhận lại" })
      )).ok
    ).toBe(true);
    const nhanLai = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SAVINGS_IN" } });

    const res = await updateCashMovement(
      nhanLai.id,
      dongGui({ kind: "SAVINGS_IN", amount: GOC + 50_000_000, description: "Nhận lại" })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("amount");
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: nhanLai.id } })).amount).toBe(
      GOC
    );
  });

  /**
   * Chuyển một dòng TỪ trục khoản vay SANG trục sổ tiết kiệm: cả hai bảng cha phải bị khoá và kiểm
   * lại trong CÙNG transaction. Thiếu một vế là dư nợ khoản vay cũ hoặc số đang gửi của sổ mới sai
   * mà không có test số nào khác đỏ.
   */
  it("chuyển dòng từ khoản vay sang sổ tiết kiệm → cắt liên kết cũ, gắn liên kết mới, hai trục đều đúng", async () => {
    const giaiNgan = await createCashMovement(
      hopLe({ date: NGAY_GUI, kind: "LOAN_IN", amount: 50_000_000, description: "Giải ngân", loanId })
    );
    expect(giaiNgan.ok).toBe(true);
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });

    const res = await updateCashMovement(dong.id, dongGui({ amount: 50_000_000 }));
    expect(res.ok).toBe(true);

    const sau = await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau).toMatchObject({ kind: "SAVINGS_OUT", loanId: null, savingsId: soId });
    expect(await prisma.cashMovement.count({ where: { loanId } })).toBe(0);
  });

  it("sổ đã tất toán → không gỡ được dòng cũ ra khỏi nó", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SAVINGS_OUT" } });
    await prisma.soTietKiem.update({ where: { id: soId }, data: { closedAt: new Date() } });

    const res = await updateCashMovement(
      dong.id,
      hopLe({ kind: "CAPITAL_OUT", amount: GOC, description: "Gỡ ra" })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("đã tất toán");
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).savingsId).toBe(
      soId
    );
  });

  it("XOÁ dòng gửi sau khi đã nhận lại gốc → từ chối bằng câu nói đúng chuyện", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SAVINGS_OUT" } });
    expect(
      (await createCashMovement(
        dongGui({ kind: "SAVINGS_IN", amount: GOC, description: "Nhận lại" })
      )).ok
    ).toBe(true);

    const res = await deleteCashMovement(dong.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(
        "Sổ tiết kiệm này đã nhận lại gốc — xoá dòng gửi sẽ làm số đang gửi âm"
      );
    }
    expect(await prisma.cashMovement.count({ where: { id: dong.id } })).toBe(1);
  });

  it("XOÁ dòng nhận lại → ok, số đang gửi trở về đúng gốc", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);
    expect(
      (await createCashMovement(
        dongGui({ kind: "SAVINGS_IN", amount: GOC, description: "Nhận lại" })
      )).ok
    ).toBe(true);
    const nhanLai = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SAVINGS_IN" } });

    expect((await deleteCashMovement(nhanLai.id)).ok).toBe(true);

    const tong = await prisma.cashMovement.groupBy({
      by: ["kind"],
      where: { savingsId: soId },
      _sum: { amount: true },
    });
    const lay = (k: string) => tong.find((x) => x.kind === k)?._sum.amount ?? 0;
    expect(lay("SAVINGS_OUT") - lay("SAVINGS_IN")).toBe(GOC);
  });

  it("sổ đã tất toán → không xoá được dòng của nó", async () => {
    expect((await createCashMovement(dongGui())).ok).toBe(true);
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SAVINGS_OUT" } });
    await prisma.soTietKiem.update({ where: { id: soId }, data: { closedAt: new Date() } });

    const res = await deleteCashMovement(dong.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("đã tất toán");
    expect(await prisma.cashMovement.count({ where: { id: dong.id } })).toBe(1);
  });

  it("ghi thẳng Prisma một dòng mang CẢ loanId lẫn savingsId → CHECK loại trừ chặn", async () => {
    await expect(
      prisma.cashMovement.create({
        data: {
          date: new Date(`${NGAY_GUI}T00:00:00+07:00`),
          kind: "SAVINGS_OUT",
          amount: 1_000_000,
          loanId,
          savingsId: soId,
          description: "Hai trục cùng lúc",
        },
      })
    ).rejects.toThrow();
    expect(await prisma.cashMovement.count()).toBe(0);
  });
});

/**
 * Hàng rào cha cho bản đọc NGOÀI transaction — phủ CẢ đường SỬA (thiếu, nay vá) lẫn đường XOÁ
 * (`docLaiTrongTx` có sẵn nhưng chưa test nào khoá).
 *
 * Cả hai action đọc `loanId`/`savingsId` một lượt NGOÀI transaction rồi mới giành khoá `FOR UPDATE`
 * THEO ĐÚNG bản đọc đó. Nếu giữa hai mốc có lượt khác chuyển dòng sang cha KHÁC thì ta khoá nhầm
 * cha: cha thật không bị khoá, không cổng `chanDuNoAm`/`chanSoDuTietKiemAm` nào chạm tới nó, dư nợ
 * lệch IM LẶNG.
 *
 * Đua thật không tái hiện ổn định được (cửa sổ = 1 round-trip Prisma), nên dựng ĐÚNG trạng thái đó
 * một cách tất định: ép riêng lượt `findUnique` ĐẦU TIÊN trả bản CŨ, còn DB giữ bản thật. Gỡ hàng
 * rào ⇒ câu ghi/xoá đi tiếp và test đỏ.
 */
describe("hàng rào cha khi bản đọc ngoài transaction đã cũ", () => {
  let loanId = "";

  beforeEach(async () => {
    const loan = await prisma.loan.create({
      data: {
        name: "Vay kiểm hàng rào",
        startDate: new Date("2026-07-10T00:00:00+07:00"),
        annualRateBp: 1050,
        termMonths: 12,
        firstDueDate: new Date("2026-08-10T00:00:00+07:00"),
      },
    });
    loanId = loan.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Ép đúng lượt đọc `truoc` trả về bản cũ; các lượt findUnique sau đó chạy thật. */
  const epDocCu = (cu: { loanId: string | null; savingsId: string | null }) =>
    vi
      .spyOn(prisma.cashMovement, "findUnique")
      .mockImplementationOnce((async () => cu) as never);

  it("SỬA — dòng vừa bị lượt khác GẮN vào khoản vay ⇒ từ chối, không gỡ lén khỏi khoản đó", async () => {
    // DB: dòng đang thuộc khoản vay. Bản đọc của ta: còn thấy dòng trơn ⇒ nhánh "không cha",
    // KHÔNG giành khoá nào. Ghi đè thẳng sẽ cắt dòng khỏi khoản vay mà không ai hay.
    expect(
      (await createCashMovement(
        hopLe({ kind: "LOAN_IN", amount: 200_000_000, description: "Giải ngân", loanId })
      )).ok
    ).toBe(true);
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });

    epDocCu({ loanId: null, savingsId: null });
    const res = await updateCashMovement(
      dong.id,
      hopLe({ kind: "CAPITAL_IN", amount: 1_000_000, description: "Ghi đè lén" })
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("vừa được sửa sang mục khác");
      // KHÔNG kèm `field`: "id" không phải ô nhập nào, modal chỉ render 6 khoá — kèm field là câu
      // báo rơi vào khoá không ai đọc, chủ shop bấm Lưu mà tuyệt đối im lặng.
      expect(res.field).toBeUndefined();
    }
    const sau = await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau).toMatchObject({ kind: "LOAN_IN", loanId, amount: 200_000_000 });
  });

  it("SỬA — bản đọc cũ trỏ NHẦM sang khoản vay ⇒ từ chối trước khi hậu kiểm cộng nhầm sổ", async () => {
    expect(
      (await createCashMovement(
        hopLe({ kind: "LOAN_IN", amount: 200_000_000, description: "Giải ngân", loanId })
      )).ok
    ).toBe(true);
    // Dòng TRƠN, không dính khoản vay nào.
    expect((await createCashMovement(hopLe({ description: "Góp vốn" }))).ok).toBe(true);
    const tron = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "CAPITAL_IN" } });

    epDocCu({ loanId, savingsId: null });
    const res = await updateCashMovement(
      tron.id,
      hopLe({ kind: "LOAN_REPAY", amount: 1_000_000, description: "Trả gốc", loanId })
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("vừa được sửa sang mục khác");
      // KHÔNG kèm `field`: "id" không phải ô nhập nào, modal chỉ render 6 khoá — kèm field là câu
      // báo rơi vào khoá không ai đọc, chủ shop bấm Lưu mà tuyệt đối im lặng.
      expect(res.field).toBeUndefined();
    }
    const sau = await prisma.cashMovement.findUniqueOrThrow({ where: { id: tron.id } });
    expect(sau).toMatchObject({ kind: "CAPITAL_IN", loanId: null });
  });

  it("XOÁ — bản đọc cũ thấy dòng trơn trong khi dòng đã thuộc khoản vay ⇒ từ chối, dòng còn nguyên", async () => {
    expect(
      (await createCashMovement(
        hopLe({ kind: "LOAN_IN", amount: 200_000_000, description: "Giải ngân", loanId })
      )).ok
    ).toBe(true);
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });

    epDocCu({ loanId: null, savingsId: null });
    const res = await deleteCashMovement(dong.id);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("vừa được sửa sang mục khác");
      // KHÔNG kèm `field`: "id" không phải ô nhập nào, modal chỉ render 6 khoá — kèm field là câu
      // báo rơi vào khoá không ai đọc, chủ shop bấm Lưu mà tuyệt đối im lặng.
      expect(res.field).toBeUndefined();
    }
    expect(await prisma.cashMovement.count({ where: { id: dong.id } })).toBe(1);
  });
});
