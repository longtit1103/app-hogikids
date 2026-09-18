import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * LƯỚI CÁCH LY (spec §4.7). Mục Marketing bày số DO SÀN BÁO. Bất biến #2 nói doanh thu chỉ đến từ đơn
 * gốc Pancake — nên một dòng `import` từ `reports/marketing` lọt vào `pnl.ts` (hay Dashboard, hay
 * `/kenh`) là đủ để số sàn chảy vào tiền thật, và sẽ không có test nào khác đỏ vì tổng vẫn "hợp lý".
 *
 * Đọc MÃ NGUỒN thay vì import: import kéo theo Prisma + toàn bộ đồ thị phụ thuộc, và quan trọng hơn —
 * ta đang kiểm chính CÁI CHỮ trong file, không phải hành vi runtime.
 *
 * `CAM` phải bắt ĐỦ BA khuôn import:
 *   1. `reports/marketing` — alias `@/lib/reports/marketing/...`.
 *   2. `from "./marketing/…"` hoặc `from "../marketing/…"` — file NẰM TRONG `src/lib/reports/` viết
 *      relative tới thư mục con `marketing/` (không có chữ `reports/` nào trong CHÍNH câu import).
 *   3. `lib/marketing/` — thư mục MỚI `src/lib/marketing/` (P2, giữ `doc-so-san.ts` — luật đọc
 *      tiền/tỉ lệ/đếm của SÀN). Bắt cả alias `@/lib/marketing/...` LẪN relative nhiều cấp
 *      (`../../../lib/marketing/...`) vì cả hai đều chứa literal `lib/marketing/`.
 */
const GOC = path.resolve(__dirname, "../../..");

const CAM = /reports\/marketing|lib\/marketing\/|from\s+["']\.{1,2}\/marketing\//;

const FILE_CAM = [
  "src/lib/reports/pnl.ts",
  "src/lib/reports/monthly-trend.ts",
  "src/lib/reports/daily-series.ts",
  "src/lib/reports/cash-flow.ts",
  "src/lib/reports/product-report.ts",
  "src/app/(app)/page.tsx",
  // Màn tiền thật + nhóm dựng dòng P&L (lỗ #3 đo được ở gate Task 9: hai chỗ này CHƯA từng nằm
  // trong lưới — page.tsx/tai-chinh gọi calcPnl() 2 lần + render PnlTab, còn 4 file dưới dựng
  // CHÍNH các dòng hiển thị trên màn đó. Một import rò rỉ ở đây không bao giờ bị lưới cũ phát hiện.
  "src/app/(app)/tai-chinh/page.tsx",
  "src/lib/reports/pnl-line-items.ts",
  "src/lib/reports/pnl-line-tree.ts",
  "src/lib/reports/pnl-percent-base.ts",
  "src/lib/reports/platform-fee-breakdown.ts",
];
const THU_MUC_CAM = ["src/app/(app)/kenh"];

/**
 * Bảng Bronze CHỈ dành cho số sàn tham khảo. `RawTiktokBusinessGmvMaxItem` vào danh sách từ P2:
 * nó mang `cost`/`gross_revenue` cấp sản phẩm, đúng loại số trông "vừa vặn" để ai đó thay cho
 * chi phí quảng cáo trong P&L — mà chi phí P&L CHỈ được là dòng sổ `Expense` (không thì đếm 2 lần).
 *
 * So KHÔNG PHÂN BIỆT HOA/THƯỜNG (lỗ #1 đo được ở gate Task 9): Prisma sinh delegate với chữ cái
 * đầu THƯỜNG (`prisma.rawTiktokShopAnalyticsProduct`, `prisma.rawTiktokBusinessGmvMaxItem`) — so
 * case-sensitive để lọt đúng đường rò rỉ thật (đọc bảng cấm qua delegate thay vì gõ lại tên model).
 */
// `RawTiktokShopAffiliateOrder` vào danh sách từ P3: nó mang `estimated/actual_paid_commission` +
// `price × quantity` (GMV) cấp creator — đúng loại số "vừa vặn" để ai đó đối chiếu/thay hoa hồng
// THẬT Pancake (`advanced_platform_fee.affiliate_commission`) trong P&L = đếm 2 lần, sai tiền.
const BANG_CAM = ["RawTiktokShopAnalytics", "RawTiktokBusinessGmvMaxItem", "RawTiktokShopAffiliateOrder"];

/** Tên bảng cấm mà `noiDung` chạm tới (không phân biệt hoa/thường) — [] nếu sạch. */
function timBangCam(noiDung: string): string[] {
  return BANG_CAM.filter((bang) => new RegExp(bang, "i").test(noiDung));
}

function docTatCa(duongDan: string): { file: string; noiDung: string }[] {
  const tuyetDoi = path.join(GOC, duongDan);
  if (statSync(tuyetDoi).isFile()) return [{ file: duongDan, noiDung: readFileSync(tuyetDoi, "utf8") }];
  const ra: { file: string; noiDung: string }[] = [];
  for (const ten of readdirSync(tuyetDoi)) {
    ra.push(...docTatCa(path.join(duongDan, ten)));
  }
  return ra;
}

describe("mục Marketing không rò rỉ vào P&L", () => {
  const moiFile = [...FILE_CAM, ...THU_MUC_CAM].flatMap(docTatCa);

  it("liệt kê được đủ file cần canh (lưới không bao giờ được rỗng)", () => {
    // Không có phép kiểm này thì đổi tên/đường dẫn một file sẽ làm lưới im lặng bỏ trống chỗ đó.
    // THU_MUC_CAM (src/app/(app)/kenh) hiện chỉ có 2 file thật (page.tsx + [id]/page.tsx) — không
    // giả định một con số lớn hơn thực tế, kẻo lưới tự đỏ khi thư mục đúng như thiết kế.
    expect(moiFile.length).toBeGreaterThanOrEqual(FILE_CAM.length + 2);
    for (const f of FILE_CAM) expect(moiFile.some((x) => x.file === f)).toBe(true);
    expect(moiFile.some((x) => x.file === "src/app/(app)/kenh/page.tsx")).toBe(true);
    expect(moiFile.some((x) => x.file === "src/app/(app)/kenh/[id]/page.tsx")).toBe(true);
  });

  it("không file nào import reports/marketing", () => {
    const pham = moiFile.filter((f) => CAM.test(f.noiDung)).map((f) => f.file);
    expect(pham).toEqual([]);
  });

  it.each(BANG_CAM)("không file nào chứa chuỗi %s (không phân biệt hoa/thường)", (bang) => {
    const pham = moiFile.filter((f) => timBangCam(f.noiDung).includes(bang)).map((f) => f.file);
    expect(pham).toEqual([]);
  });
});

/**
 * Lưới an toàn phải TỰ ĐỨNG được: mỗi lỗ đo ở gate Task 9 có một phép kiểm dựng ca bẩn nhân tạo
 * rồi khẳng định lưới bắt — không chỉ mở rộng danh sách rồi tuyên bố xong (tiền lệ: guard SQL/TOC
 * ở tests/unit/backup/restore-sh-guard.test.ts dựng fixture bẩn rồi gọi thẳng hàm guard).
 */
describe("lưới tự đứng — chứng minh 3 lỗ cách ly đã vá (Task 9)", () => {
  it("lỗ #1: bắt được Prisma delegate chữ thường đầu (prisma.rawTiktokShopAnalyticsProduct…)", () => {
    // Ca bẩn mô phỏng đúng đường rò rỉ thật: "đối chiếu phí sàn cho khớp TikTok" rồi lấy
    // metrics.cost/gross_revenue qua delegate thay vì gõ lại tên model — so case-sensitive cũ
    // (`.includes("RawTiktokShopAnalytics")`) sẽ KHÔNG bắt được dòng này vì chữ "r" đầu là thường.
    const caBan = `
      const rows = await prisma.rawTiktokShopAnalyticsProduct.findMany({ where: { shopId } });
      revenue -= rows.reduce((s, r) => s + r.gmv, 0); // "đối chiếu phí sàn"
    `;
    expect(timBangCam(caBan)).toContain("RawTiktokShopAnalytics");

    const caBan2 = `const x = await prisma.rawTiktokBusinessGmvMaxItem.findMany();`;
    expect(timBangCam(caBan2)).toContain("RawTiktokBusinessGmvMaxItem");

    // P3: đường rò rỉ tương tự cho bảng affiliate — "đối chiếu hoa hồng affiliate cho khớp TikTok"
    // rồi đọc thẳng delegate chữ thường đầu trong pnl.ts.
    const caBan3 = `const hh = await prisma.rawTiktokShopAffiliateOrder.findMany({ where: { shopId } });`;
    expect(timBangCam(caBan3)).toContain("RawTiktokShopAffiliateOrder");
  });

  it("lỗ #2: CAM bắt được import alias từ thư mục MỚI src/lib/marketing/", () => {
    // Trước vá: CAM chỉ có 2 vế (reports/marketing | from "./marketing/…"). Chuỗi dưới đây
    // không khớp vế nào — "lib/marketing" không chứa "reports/marketing", và import dùng alias
    // "@/..." nên không khớp khuôn `from "./…"` / `from "../…"`.
    const caBan = `import { docTienSan } from "@/lib/marketing/doc-so-san";`;
    expect(CAM.test(caBan)).toBe(true);
  });

  it("lỗ #2b: CAM bắt được import relative nhiều cấp tới lib/marketing/ (không chỉ 1-2 dấu chấm)", () => {
    // File dưới src/app/(app)/kenh/[id]/ import lib/marketing/ sẽ cần 3-4 cấp "../" — vế cũ
    // `\.{1,2}\/marketing\/` đòi marketing/ đứng NGAY sau 1-2 dấu chấm, không khớp khuôn này.
    const caBan = `import { docTienSan } from "../../../lib/marketing/doc-so-san";`;
    expect(CAM.test(caBan)).toBe(true);
  });

  it("CAM KHÔNG false-positive trên câu chữ hợp lệ không liên quan số sàn", () => {
    const sach = `import { formatVnd } from "@/lib/format";\nimport { calcPnl } from "@/lib/reports/pnl";`;
    expect(CAM.test(sach)).toBe(false);
  });

  it("lỗ #3: FILE_CAM giờ phủ màn tiền /tai-chinh và nhóm dựng dòng P&L", () => {
    // Trước vá: 2 file dưới đây gọi calcPnl()/dựng dòng P&L nhưng KHÔNG nằm trong FILE_CAM — một
    // import rò rỉ ở đây không bao giờ bị lưới phát hiện dù /tai-chinh là chính màn hiển thị tiền.
    const phaiCo = [
      "src/app/(app)/tai-chinh/page.tsx",
      "src/lib/reports/pnl-line-items.ts",
      "src/lib/reports/pnl-line-tree.ts",
      "src/lib/reports/pnl-percent-base.ts",
      "src/lib/reports/platform-fee-breakdown.ts",
    ];
    for (const f of phaiCo) expect(FILE_CAM).toContain(f);
  });
});
