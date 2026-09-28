import * as XLSX from "xlsx";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user"),
  getAuthenticatedUserId: vi.fn(async () => "test-user"),
}));

// Bọc passthrough để MỘT case mô phỏng lớp bug "transform tưởng xong mà không ghi" (nuốt im lặng:
// không upsert, không đếm skipped) — kịch bản duy nhất ép cổng đủ-dòng phải TỰ đứng ra bắt, vì mọi
// đường lỗi thật khác đều đã bị cổng skipped>0 chặn trước (review đối kháng chỉ ra gap này).
vi.mock("@/lib/ingest/shopee-settlement-upsert", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/ingest/shopee-settlement-upsert");
  return { ...real, upsertOneShopeeSettlement: vi.fn(real.upsertOneShopeeSettlement) };
});

import { importShopeeWallet } from "@/lib/actions/shopee-wallet-import";
import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { upsertOneShopeeSettlement } from "@/lib/ingest/shopee-settlement-upsert";
import { prisma } from "@/lib/prisma";

/**
 * Import LẠI file ví sau một lượt hỏng dở phải TỰ CHỮA — không được trả toast xanh giả.
 *
 * Đường hỏng đã xác minh trên code: land Bronze commit RIÊNG, transform chỉ nhận `landedIds`;
 * lượt 1 có dòng upsert Silver lỗi (đứt kết nối thoáng qua) → báo đỏ PARTIAL_PERSIST, Bronze CÓ
 * dòng mà Silver THIẾU. Chủ shop nhập lại đúng file đó — payload y hệt nên `ON CONFLICT DO
 * NOTHING` cho `landedIds` RỖNG → transform không làm gì → `ok:true` "0 dòng mới" trong khi dòng
 * thiếu vẫn nằm kẹt — đường cứu còn lại là "Dựng lại từ kho thô" (nút UI hoặc script), tức một
 * lượt dựng lại TOÀN BỘ chỉ để vá vài dòng ví, kèm việc phải vá tồn kho sau đó. Cùng lớp lỗi
 * luồng orders đã vá bằng `seenIds`; suite này khoá khuôn đó cho ví Shopee. Chạy trên DB test
 * (vitest ép TEST_DATABASE_URL).
 */

const HEADER = [
  "Ngày",
  "Loại giao dịch",
  "Chi tiết",
  "Mã đơn hàng",
  "Dòng tiền",
  "Số tiền",
  "Trạng thái",
  "Số dư Ví sau giao dịch",
];

/** Dựng file .xlsx khớp shape thật (preamble + block "Tóm tắt" + header) — như test parser. */
function buildWallet(
  dataRows: (string | number)[][],
  summary: { totalIn: number; totalOut: number; countIn: number; countOut: number },
): File {
  const aoa: (string | number)[][] = [
    ["Báo cáo"],
    [],
    ["Tóm tắt", "", "", "", "$", "Đơn vị", "Số giao dịch"],
    ["Tổng tiền vào", "", "", "", summary.totalIn, "VND", summary.countIn],
    ["Tổng tiền ra", "", "", "", summary.totalOut, "VND", summary.countOut],
    [],
    HEADER,
    ...dataRows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Transaction Report");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([buf], "vi-shopee.xlsx");
}

// Hai dòng REVENUE khác khoá rõ ràng (khác giây + khác mã đơn + khác tiền).
const FILE_2_DONG = () =>
  buildWallet(
    [
      ["2026-07-01 10:00:00", "Doanh Thu Đơn Hàng", "Đơn A", "260701AAAA", "Tiền vào", "100000", "Giao dịch thành công", "100000"],
      ["2026-07-02 11:30:45", "Doanh Thu Đơn Hàng", "Đơn B", "260702BBBB", "Tiền vào", "250000", "Giao dịch thành công", "350000"],
    ],
    { totalIn: 350000, totalOut: 0, countIn: 2, countOut: 0 },
  );

// File LỌC — số THẬT từ file xuất-có-lọc 13/08 (kỳ tháng 5, chỉ giữ "Doanh Thu Đơn Hàng"):
// qua được CẢ checksum (Shopee tính lại "Tóm tắt" theo bộ lọc) lẫn khoá trùng, chỉ chuỗi
// số dư là lộ vết đứt tại chỗ WITHDRAWAL + ADJUSTMENT biến mất.
const FILE_LOC_THIEU_DONG = () =>
  buildWallet(
    [
      ["2026-05-18 15:11:20", "Doanh Thu Đơn Hàng", "Đơn", "260513AE3NS1HU", "Tiền vào", "160055", "Giao dịch thành công", "142018"],
      ["2026-05-17 17:39:33", "Doanh Thu Đơn Hàng", "Đơn", "2605139PMM6M8Y", "Tiền vào", "153970", "Giao dịch thành công", "153970"],
      ["2026-05-05 19:22:51", "Doanh Thu Đơn Hàng", "Đơn", "260501AAAA0001", "Tiền vào", "763889", "Giao dịch thành công", "2097069"],
    ],
    { totalIn: 1077914, totalOut: 0, countIn: 3, countOut: 0 },
  );

function formCoFile(file: File): FormData {
  const fd = new FormData();
  fd.set("file", file);
  return fd;
}

async function donDb(): Promise<void> {
  await prisma.shopeeSettlement.deleteMany();
  await prisma.rawShopeeWalletTxn.deleteMany({ where: { shopId: SHOP_SHOPEE } });
}

describe("importShopeeWallet — import lại sau lượt hỏng dở phải tự chữa", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await donDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("file xuất CÓ LỌC loại giao dịch → chặn BALANCE_GAP TRƯỚC khi land, Bronze không nhận dòng nào", async () => {
    const res = await importShopeeWallet(formCoFile(FILE_LOC_THIEU_DONG()));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("BALANCE_GAP");
      expect(res.error).toContain("Loại giao dịch = TẤT CẢ");
    }
    // Cổng đứng TRƯỚC landRaw — file thiếu dòng không được để lại một vết nào trong Bronze,
    // kẻo lượt nhập lại file ĐỦ sau đó bị dedupe hash từng phần và tự chữa nhầm cảnh.
    expect(await prisma.rawShopeeWalletTxn.count({ where: { shopId: SHOP_SHOPEE } })).toBe(0);
  });

  it("lượt 1 có dòng upsert lỗi → báo ĐỎ, Bronze đủ mà Silver thiếu (dựng cảnh cho ca tự chữa)", async () => {
    // Đứt kết nối thoáng qua ở ĐÚNG MỘT dòng — upsertOneShopeeSettlement bắt thành skipped++.
    vi.spyOn(prisma.shopeeSettlement, "upsert").mockRejectedValueOnce(new Error("đứt kết nối giả lập"));

    const res = await importShopeeWallet(formCoFile(FILE_2_DONG()));

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("PARTIAL_PERSIST");
    expect(await prisma.rawShopeeWalletTxn.count({ where: { shopId: SHOP_SHOPEE } })).toBe(2);
    expect(await prisma.shopeeSettlement.count()).toBe(1); // thiếu đúng 1 dòng
  });

  it("NHẬP LẠI y hệt sau lượt hỏng → dòng thiếu được DỰNG LẠI, Silver đủ, không đếm 2 lần", async () => {
    vi.spyOn(prisma.shopeeSettlement, "upsert").mockRejectedValueOnce(new Error("đứt kết nối giả lập"));
    const luot1 = await importShopeeWallet(formCoFile(FILE_2_DONG()));
    expect(luot1.ok).toBe(false);
    vi.restoreAllMocks();

    // Hành vi tự nhiên nhất của chủ shop sau toast đỏ: nhập lại đúng file đó.
    const luot2 = await importShopeeWallet(formCoFile(FILE_2_DONG()));

    expect(luot2.ok).toBe(true);
    expect(await prisma.shopeeSettlement.count()).toBe(2); // ĐỎ trước khi vá: còn 1, mà vẫn ok:true
    const tong = await prisma.shopeeSettlement.aggregate({ _sum: { amount: true } });
    expect(tong._sum.amount).toBe(350000); // bất biến (A): không đếm 2 lần
    if (luot2.ok) expect(luot2.data.recovered).toBe(1); // nói THẬT là đã bù 1 dòng kẹt
  });

  it("nhập lại khi Silver ĐÃ ĐỦ → ok, không ghi thêm, recovered=0 (đường re-import bình thường)", async () => {
    const luot1 = await importShopeeWallet(formCoFile(FILE_2_DONG()));
    expect(luot1.ok).toBe(true);

    const luot2 = await importShopeeWallet(formCoFile(FILE_2_DONG()));

    expect(luot2.ok).toBe(true);
    if (luot2.ok) {
      expect(luot2.data.landed).toBe(0);
      expect(luot2.data.recovered).toBe(0);
    }
    expect(await prisma.shopeeSettlement.count()).toBe(2);
    const tong = await prisma.shopeeSettlement.aggregate({ _sum: { amount: true } });
    expect(tong._sum.amount).toBe(350000);
  });

  it("cổng đủ-dòng TỰ ĐỨNG: transform 'tưởng xong' mà không ghi (skipped=0) → vẫn không được ok:true", async () => {
    // Nuốt im lặng đúng MỘT dòng — không ghi Silver, không tăng skipped. Cổng skipped>0 mù với ca
    // này; chỉ cổng đủ-dòng (so seenIds với Silver) bắt được. Gỡ cổng đó là test này đỏ.
    vi.mocked(upsertOneShopeeSettlement).mockImplementationOnce(async () => undefined);

    const res = await importShopeeWallet(formCoFile(FILE_2_DONG()));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("PARTIAL_PERSIST");
      expect(res.error).toMatch(/CHƯA vào được Silver/);
    }
    expect(await prisma.shopeeSettlement.count()).toBe(1); // đúng thực trạng: thiếu 1 dòng
  });

  it("dòng kẹt mà lượt tự chữa CŨNG lỗi → tuyệt đối KHÔNG trả ok:true (cổng đủ-dòng)", async () => {
    vi.spyOn(prisma.shopeeSettlement, "upsert").mockRejectedValue(new Error("DB hỏng kéo dài giả lập"));
    const luot1 = await importShopeeWallet(formCoFile(FILE_2_DONG()));
    expect(luot1.ok).toBe(false);

    // Nhập lại trong lúc DB vẫn hỏng: lượt tự chữa cũng trượt — phải tiếp tục ĐỎ, không im lặng.
    const luot2 = await importShopeeWallet(formCoFile(FILE_2_DONG()));
    expect(luot2.ok).toBe(false);
    expect(await prisma.shopeeSettlement.count()).toBe(0);
  });
});
