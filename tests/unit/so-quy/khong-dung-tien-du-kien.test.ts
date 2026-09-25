import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * LƯỚI NGƯỢC. Quỹ là tiền THẬT đã vào/ra tài khoản. Kéo vào đây tiền DỰ KIẾN (thu theo
 * đơn đã giao) hay net sàn chốt còn nằm trong ví là đếm 2 lần với `TiktokPayment`/rút ví Shopee —
 * số quỹ phồng lên mà không test số nào khác đỏ vì mọi tổng vẫn "hợp lý".
 *
 * Đọc MÃ NGUỒN thay vì import: ta kiểm CÁI CHỮ, kể cả trong comment hay chuỗi.
 * ĐƯỢC PHÉP dùng: `tiktokPayment` (tiền về bank), `tiktokAdsSettlement`, `shopeeSettlement` lọc
 * type WITHDRAWAL.
 *
 * NGOẠI LỆ DUY NHẤT: `tien-ban-truc-tiep.ts` được đọc `prisma.order` — khách bán tại shop trả NGAY nên
 * cột `paidAtShop` là tiền THẬT. Lưới riêng bên dưới khoá HÌNH DẠNG của ngoại lệ: đúng HAI lượt đọc —
 * một `aggregate` (tổng cho thẻ Quỹ, chỉ `_sum` cột `paidAtShop`) và một `findMany` (từng đơn cho Sổ quỹ
 * dòng chạy, `select` chỉ id/mã đơn/`orderedAt`/`paidAtShop`) — cả hai đi CHUNG một hàm bộ lọc kênh
 * bán trực tiếp + COMPLETED. Nới thêm (đọc `itemsTotal`, thêm cột vào `select`, bỏ lọc kênh, lượt đọc
 * thứ ba, bộ lọc viết riêng…) là đỏ.
 */
const THU_MUC = path.resolve(__dirname, "../../../src/lib/so-quy");

/**
 * `vi-san/` + `ViTiktokConLai`: ô "Còn ở ví TikTok" (`src/lib/vi-san/`) đọc net sàn chốt ĐỂ HIỂN
 * THỊ riêng — một `import` ngược vào đây (alias hay relative, hàm hay kiểu) là con số ví, chưa phải
 * tiền quỹ, lọt vào số dư / dự báo / Excel Sổ quỹ.
 */
const CAM =
  /calcPnl|pnlOrderSelect|prisma\.order\b|expectedIn|prisma\.tiktokSettlement\b|"REVENUE"|vi-san\/|ViTiktokConLai/;

/** Đệ quy (khuôn `khong-ro-ri-vao-pnl.test.ts`): lưới canh cả `src/lib/so-quy/**`, thư mục con cũng phải soi. */
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

const NGOAI_LE_DON_HANG = "tien-ban-truc-tiep.ts";
const moiFile = docTatCa(THU_MUC);
/**
 * Ngoại lệ vẫn bị soi mọi token cấm KHÁC — chỉ riêng hai khuôn gọi `prisma.order` được gỡ (số lần gọi
 * mỗi khuôn do lưới hình dạng bên dưới đếm, gỡ hết ở đây không làm lọt lượt gọi thừa).
 */
const bo = (noiDung: string, file: string) =>
  file === NGOAI_LE_DON_HANG
    ? noiDung.replace(/prisma\.order\.(aggregate|findMany)\(/g, "")
    : noiDung;

/** Các cột DUY NHẤT lượt liệt kê đơn được lấy: khoá dòng, mã hiển thị, mốc quỹ, tiền khách đã trả. */
const COT_DON_CHO_PHEP = ["code", "id", "orderedAt", "paidAtShop"];
/** Tên hàm bộ lọc dùng chung — cả hai lượt đọc PHẢI đi qua nó, không lượt nào tự viết `where`. */
const BO_LOC_CHUNG = "dieuKienDonBanTrucTiep";

describe("src/lib/so-quy không dùng tiền dự kiến / net sàn chốt", () => {
  it("liệt kê được đủ file cần canh (lưới không bao giờ được rỗng)", () => {
    // cong-thuc-so-quy · lich-tra-no · so-quy-queries · khoan-vay-queries · tien-ban-truc-tiep ·
    // dong-chay-so-quy(-queries) — Sổ quỹ dạng dòng chạy cũng đọc tiền nên cũng phải bị soi.
    expect(moiFile.length).toBeGreaterThanOrEqual(4);
  });

  it.each(moiFile.map((f) => [f.file, f.noiDung] as const))(
    "%s không nhắc tới P&L / đơn hàng / tiền dự kiến",
    (file, noiDung) => {
      expect(bo(noiDung, file)).not.toMatch(CAM);
    }
  );

  it("ngoại lệ bán trực tiếp giữ ĐÚNG hình dạng: 1 tổng + 1 liệt kê, chung bộ lọc direct + COMPLETED", () => {
    const f = moiFile.find((x) => x.file === NGOAI_LE_DON_HANG);
    expect(f, "file ngoại lệ phải tồn tại — đổi tên thì sửa lưới").toBeDefined();
    const src = f!.noiDung;
    expect(src.match(/prisma\.\w+/g)).toEqual(["prisma.order", "prisma.order"]);
    expect(src.match(/prisma\.order\.aggregate\(/g)).toHaveLength(1);
    expect(src.match(/prisma\.order\.findMany\(/g)).toHaveLength(1);

    // Lượt tổng: chỉ `_sum` cột tiền khách đã trả.
    expect(src).toMatch(/_sum:\s*\{\s*paidAtShop:\s*true\s*\}/);

    // Lượt liệt kê: đúng MỘT `select`, phẳng (không lồng quan hệ), chỉ các cột cho phép; cấm `include`.
    const selects = [...src.matchAll(/select:\s*\{([^{}]*)\}/g)].map((m) => m[1]);
    expect(selects).toHaveLength(1);
    expect(src.match(/select:/g)).toHaveLength(1);
    const cot = [...selects[0].matchAll(/(\w+):\s*true/g)].map((m) => m[1]).sort();
    expect(cot).toEqual(COT_DON_CHO_PHEP);
    expect(selects[0].replace(/\w+:\s*true/g, "")).toMatch(/^[\s,]*$/);
    expect(src).not.toMatch(/include:/);

    // Cả hai lượt đi qua CHUNG một bộ lọc, và bộ lọc đó khoá kênh direct + COMPLETED + mốc `orderedAt`.
    expect(src.match(/where:/g)).toHaveLength(2);
    expect(src.match(new RegExp(`where:\\s*${BO_LOC_CHUNG}\\(khoang\\)`, "g"))).toHaveLength(2);
    const thanBoLoc = src.match(new RegExp(`function ${BO_LOC_CHUNG}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
    expect(thanBoLoc, "hàm bộ lọc chung phải tồn tại").not.toBeNull();
    expect(thanBoLoc![1]).toMatch(/channelId:\s*KENH_BAN_TRUC_TIEP/);
    expect(thanBoLoc![1]).toMatch(/status:\s*"COMPLETED"/);
    expect(thanBoLoc![1]).toMatch(/orderedAt:\s*khoang/);

    expect(src).not.toMatch(/itemsTotal|discount|platformFeeEst|netRevenue/);
  });

  it("regex CAM bắt được các khuôn rò rỉ (tự kiểm lưới)", () => {
    expect('import { calcPnl } from "@/lib/reports/pnl";').toMatch(CAM);
    expect("await prisma.order.aggregate({})").toMatch(CAM);
    expect("await prisma.order.findMany({})").toMatch(CAM);
    expect("const x = cf.expectedIn;").toMatch(CAM);
    expect("await prisma.tiktokSettlement.aggregate({})").toMatch(CAM);
    expect('import { docViTiktokConLaiToiThieu } from "@/lib/vi-san/vi-tiktok-con-lai-toi-thieu-queries";').toMatch(CAM);
    expect('import { x } from "../vi-san/vi-tiktok-con-lai-toi-thieu";').toMatch(CAM);
    expect("const v: ViTiktokConLaiToiThieu | null = null;").toMatch(CAM);
    expect("// tiền còn trong ví Shopee chưa rút").not.toMatch(CAM);
    expect('where: { type: "REVENUE" }').toMatch(CAM);
    expect('where: { type: "WITHDRAWAL" }').not.toMatch(CAM);
    expect("await prisma.tiktokPayment.aggregate({})").not.toMatch(CAM);
  });
});
