import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * LƯỚI NGƯỢC (spec §5.7). Quỹ là tiền THẬT đã vào/ra tài khoản. Kéo vào đây tiền DỰ KIẾN (thu theo
 * đơn đã giao) hay net sàn chốt còn nằm trong ví là đếm 2 lần với `TiktokPayment`/rút ví Shopee —
 * số quỹ phồng lên mà không test số nào khác đỏ vì mọi tổng vẫn "hợp lý".
 *
 * Đọc MÃ NGUỒN thay vì import: ta kiểm CÁI CHỮ, kể cả trong comment hay chuỗi.
 * ĐƯỢC PHÉP dùng: `tiktokPayment` (tiền về bank), `tiktokAdsSettlement`, `shopeeSettlement` lọc
 * type WITHDRAWAL.
 */
const THU_MUC = path.resolve(__dirname, "../../../src/lib/so-quy");

const CAM = /calcPnl|pnlOrderSelect|prisma\.order\b|expectedIn|prisma\.tiktokSettlement\b|"REVENUE"/;

/** Đệ quy (khuôn `khong-ro-ri-vao-pnl.test.ts`): spec canh `src/lib/so-quy/**`, thư mục con cũng phải soi. */
function docTatCa(thuMuc: string, tienTo = ""): { file: string; noiDung: string }[] {
  const ra: { file: string; noiDung: string }[] = [];
  for (const ten of readdirSync(thuMuc)) {
    const duongDan = path.join(thuMuc, ten);
    const nhan = tienTo === "" ? ten : `${tienTo}/${ten}`;
    if (statSync(duongDan).isDirectory()) ra.push(...docTatCa(duongDan, nhan));
    else if (ten.endsWith(".ts")) ra.push({ file: nhan, noiDung: readFileSync(duongDan, "utf8") });
  }
  return ra;
}

const moiFile = docTatCa(THU_MUC);

describe("src/lib/so-quy không dùng tiền dự kiến / net sàn chốt", () => {
  it("liệt kê được đủ file cần canh (lưới không bao giờ được rỗng)", () => {
    // cong-thuc-so-quy · lich-tra-no · so-quy-queries · khoan-vay-queries.
    expect(moiFile.length).toBeGreaterThanOrEqual(4);
  });

  it.each(moiFile.map((f) => [f.file, f.noiDung] as const))(
    "%s không nhắc tới P&L / đơn hàng / tiền dự kiến",
    (_file, noiDung) => {
      expect(noiDung).not.toMatch(CAM);
    }
  );

  it("regex CAM bắt được các khuôn rò rỉ (tự kiểm lưới)", () => {
    expect('import { calcPnl } from "@/lib/reports/pnl";').toMatch(CAM);
    expect("await prisma.order.aggregate({})").toMatch(CAM);
    expect("const x = cf.expectedIn;").toMatch(CAM);
    expect("await prisma.tiktokSettlement.aggregate({})").toMatch(CAM);
    expect('where: { type: "REVENUE" }').toMatch(CAM);
    expect('where: { type: "WITHDRAWAL" }').not.toMatch(CAM);
    expect("await prisma.tiktokPayment.aggregate({})").not.toMatch(CAM);
  });
});
