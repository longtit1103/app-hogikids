import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * LƯỚI CÁCH LY (spec §4.7 + §5.7 Sổ quỹ). Bảng `CashMovement` (vay/góp vốn/bán trực tiếp/thu
 * khác/trả nợ/rút vốn) là DÒNG TIỀN thuần — chủ shop chốt 02/09: KHÔNG vào Lãi/Lỗ. Một `import` từ `cash-movements` lọt vào
 * `pnl.ts` (hay các file dựng dòng P&L, Dashboard, /kenh) là đủ để tiền vay thành "doanh thu", và
 * không test số nào khác đỏ vì tổng vẫn "hợp lý". Đọc MÃ NGUỒN thay vì import: ta kiểm CÁI CHỮ.
 *
 * Bảng `Loan` + module `src/lib/so-quy/**` nằm CÙNG trục đó: dư nợ gốc và số dư quỹ không bao giờ
 * được chạm vào Lãi/Lỗ. Riêng LÃI vay thì có — nhưng đi đường `Expense` danh mục `interest`, không
 * qua hai module trên, nên chữ "Lãi vay" (có dấu) ở `pnl-line-items.ts` cố ý KHÔNG bị bắt.
 *
 * CỐ Ý KHÔNG cấm `src/lib/reports/cash-flow.ts` (đúng chỗ dùng — trục dòng tiền) và
 * `src/app/(app)/tai-chinh/page.tsx` (render tab Dòng tiền).
 */
const GOC = path.resolve(__dirname, "../../..");

// Bắt cả đường dẫn module (`cash-movements/…` · `so-quy/…` · `khoan-vay-…`) lẫn delegate Prisma
// (`prisma.cashMovement` · `prisma.loan`), không phân biệt hoa/thường. KHÔNG dùng token trần `quy`:
// nó có sẵn trong `pnl.ts` và `daily-series.ts` (chữ tiếng Việt), lưới sẽ đỏ oan.
//
// `DEPOSIT_OUT|DEPOSIT_IN`: hai giá trị `CashMovementKind` của tiền gửi tiết kiệm bắt buộc — thêm
// THẲNG literal (không chỉ bắt qua đường import module) vì đây là đúng bẫy CLAUDE.md bất biến #1 cảnh
// báo — một dòng `if (kind === "DEPOSIT_OUT") tongChi += amount` copy sang file P&L vẫn đọc được biến
// `kind`/`amount` có sẵn trong scope (không cần tự gõ `cashMovement`/`so-quy` ở CHÍNH file đó) nên
// bốn token gốc không chắc bắt được — phải khoá riêng hai literal này.
//
// `SAVINGS_OUT|SAVINGS_IN|lib/tiet-kiem`: y hệt luật trên cho sổ tiết kiệm SINH LÃI (09/2026). Token
// thứ ba CÓ tiền tố thư mục là CỐ Ý — `tiet-kiem` trần sẽ khớp cả href hợp lệ
// `/tai-chinh?tab=dong-tien#tiet-kiem` mà `pnl-line-items.ts` BẮT BUỘC phải mang, làm lưới đỏ do
// chính thiết kế. `thuNhap` KHÔNG bị cấm: đường hợp lệ duy nhất đưa thu nhập vào P&L.
//
// `prisma.soTietKiem` (token THỨ TƯ) — spec §13 chỉ khai ba token, ĐO THẬT cho thấy thiếu: đọc sổ
// thẳng bằng delegate Prisma không lộ chữ nào của ba token trên, mà đó lại là đường rò rỉ NGẮN NHẤT.
// Khuôn `prisma\.loan\b` đang chạy sẵn cho trục khoản vay.
const CAM =
  // `paidAtShop` (23/09): tiền khách trả tại shop của đơn bán trực tiếp — nguồn Sổ quỹ, KHÔNG phải doanh
  // thu (P&L đã đọc itemsTotal/discount của chính đơn đó). Đọc thêm cột này ở P&L là đếm 2 lần.
  // `soDuChot|prisma\.soDuChotThang` (23/09, S6 #1): bản chốt số dư THẬT cuối tháng là thước đo của trục
  // dòng tiền — cùng luật với `CashMovement`, không bao giờ vào Lãi/Lỗ. Token có tiền tố `soDu` cố ý:
  // `chot` trần khớp chữ "chốt" tiếng Việt có sẵn khắp comment P&L, lưới sẽ đỏ oan.
  /cash-movements|cashMovement|so-quy|khoan-vay|prisma\.loan\b|DEPOSIT_OUT|DEPOSIT_IN|SAVINGS_OUT|SAVINGS_IN|lib\/tiet-kiem|prisma\.soTietKiem\b|soDuChot|prisma\.soDuChotThang\b|paidAtShop/i;

const FILE_CAM = [
  "src/lib/reports/pnl.ts",
  "src/lib/reports/pnl-line-items.ts",
  "src/lib/reports/pnl-line-tree.ts",
  "src/lib/reports/pnl-percent-base.ts",
  // Thêm 09/2026 (Phase 06): dựng CHỮ cho dòng/chú thích P&L nên cùng nhóm bị canh — nó chỉ được
  // biết một con số `financialIncome`, không được biết số đó đến từ sổ tiết kiệm nào.
  "src/lib/reports/chu-thich-thu-nhap-tai-chinh.ts",
  "src/lib/reports/platform-fee-breakdown.ts",
  "src/lib/reports/monthly-trend.ts",
  "src/lib/reports/daily-series.ts",
  "src/lib/reports/product-report.ts",
  "src/app/(app)/page.tsx",
  "src/components/bao-cao/pnl-tab.tsx",
  // Thêm 17/09 sau review đối kháng: ba file này HIỂN THỊ số P&L (thẻ KPI, bảng Xu hướng, sheet
  // Excel) mà vẫn nằm ngoài vòng canh suốt Phase 06 — đúng lỗ hổng mà ca dẫn xuất dưới đây sinh ra
  // để không bao giờ lặp lại.
  "src/components/bao-cao/report-export-buttons.tsx",
  "src/components/bao-cao/trend-chart.tsx",
  "src/components/bao-cao/trend-tab.tsx",
  "src/components/dashboard/kpi-cards.tsx",
  "src/components/dashboard/revenue-profit-chart.tsx",
  "src/lib/reports/voucher-breakdown.ts",
];

/**
 * Thư mục nơi MỌI file chạm số P&L phải sống — dùng cho ca DẪN XUẤT ở cuối file. Không gồm
 * `src/lib/so-quy`/`src/components/finance` (trục dòng tiền, đọc `cash-movements` là đúng việc).
 */
const THU_MUC_PNL = ["src/lib/reports", "src/components/bao-cao", "src/components/dashboard"];

/** Dấu hiệu "file này chạm số P&L" — bốn tên có thật trong `PnlBreakdown`/API dựng dòng. */
const DAU_HIEU_PNL = /PnlBreakdown|netProfit|financialIncome|buildPnlLineItems/;
const THU_MUC_CAM = ["src/app/(app)/kenh"];

function docTatCa(duongDan: string): { file: string; noiDung: string }[] {
  const tuyetDoi = path.join(GOC, duongDan);
  if (statSync(tuyetDoi).isFile()) return [{ file: duongDan, noiDung: readFileSync(tuyetDoi, "utf8") }];
  const ra: { file: string; noiDung: string }[] = [];
  for (const ten of readdirSync(tuyetDoi)) ra.push(...docTatCa(path.join(duongDan, ten)));
  return ra;
}

describe("khoản tiền khác (CashMovement) không rò rỉ vào P&L", () => {
  const moiFile = [...FILE_CAM, ...THU_MUC_CAM].flatMap(docTatCa);

  it("liệt kê được đủ file cần canh (lưới không bao giờ được rỗng)", () => {
    // /kenh hiện có 2 file thật (page.tsx + [id]/page.tsx) — không giả định số lớn hơn.
    expect(moiFile.length).toBeGreaterThanOrEqual(FILE_CAM.length + 2);
  });

  it.each(moiFile.map((f) => [f.file, f.noiDung] as const))("%s không nhắc tới cash-movements / so-quy / Loan", (_file, noiDung) => {
    expect(noiDung).not.toMatch(CAM);
  });

  it("regex CAM bắt được mọi khuôn rò rỉ (tự kiểm lưới)", () => {
    expect('import { x } from "@/lib/cash-movements/cash-movement-queries";').toMatch(CAM);
    expect("await prisma.cashMovement.aggregate({})").toMatch(CAM);
    expect('from "../cash-movements/cash-movement-kinds"').toMatch(CAM);
    expect('import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";').toMatch(CAM);
    expect("await prisma.loan.findMany({})").toMatch(CAM);
    expect('from "@/lib/so-quy/khoan-vay-queries"').toMatch(CAM);
    // Bản chốt số dư cuối tháng — cả delegate Prisma lẫn tên hàm/kiểu đều phải bị bắt.
    expect("await prisma.soDuChotThang.findUnique({})").toMatch(CAM);
    expect("const dc = await doiChieuSoDuChot(range, soQuy);").toMatch(CAM);
    expect("// chốt số ở đây rồi in ra").not.toMatch(CAM);
    expect("const cashOut = 1; // tiền chi thật").not.toMatch(CAM);
    expect("// quy tắc lọc đơn hợp lệ").not.toMatch(CAM);
  });

  // Tiền gửi tiết kiệm bắt buộc (bất biến #1): dòng nào NHẮC TỚI hai kind này trong file cấm cũng
  // phải bị bắt, kể cả khi câu đó không tự gõ lại "cashMovement"/"so-quy" (biến `kind`/`amount` có
  // thể đến từ một tham số hàm, không nhất thiết lộ ra tên module ngay tại chỗ đọc).
  it("regex CAM bắt riêng 2 kind tiền gửi bắt buộc DEPOSIT_OUT / DEPOSIT_IN", () => {
    expect('if (kind === "DEPOSIT_OUT") tongChi += amount;').toMatch(CAM);
    expect('const daNhanLai = row.kind === "DEPOSIT_IN";').toMatch(CAM);
    expect("const cashOut = 1; // tiền chi thật").not.toMatch(CAM);
  });

  // Sổ tiết kiệm SINH LÃI (thêm 09/2026) nằm cùng trục cấm: P&L chỉ được biết bảng `ThuNhap`, không
  // bao giờ biết sổ tiết kiệm là gì (thiet-ke §4). Ba đường rò rỉ THẬT phải bắt được:
  //   1. hai literal kind mới — `if (kind === "SAVINGS_OUT") tongChi += amount` copy sang file P&L
  //      vẫn đọc được `kind`/`amount` có sẵn trong scope, không tự gõ lại tên module nào;
  //   2. import module `src/lib/tiet-kiem/` (alias `@/lib/tiet-kiem/...` LẪN relative nhiều cấp);
  //   3. đọc THẲNG sổ qua delegate Prisma `prisma.soTietKiem` — đường ngắn nhất và cũng là đường
  //      không lộ ra chữ nào của hai token trên.
  //
  // Hai ca ÂM ở cuối quan trọng ngang ca dương:
  //   - `#tiet-kiem` là href drill-down mà Phase 06 BẮT `pnl-line-items.ts` phải mang. Cấm token
  //     trần `tiet-kiem` là lưới tự đỏ do CHÍNH thiết kế, và lối thoát nhanh lúc đó là nới lưới —
  //     đúng cái phải tránh. Vì vậy token là `lib/tiet-kiem`, có tiền tố thư mục (khuôn
  //     `lib/marketing/` đang chạy ở lưới Marketing).
  //   - `thuNhap` CỐ Ý KHÔNG bị cấm: đó là đường HỢP LỆ DUY NHẤT đưa thu nhập ngoài bán hàng vào
  //     P&L, đối xứng với lãi vay đi qua `Expense` danh mục `interest`.
  it("regex CAM bắt riêng đường rò rỉ sổ tiết kiệm (SAVINGS_*, lib/tiet-kiem, delegate soTietKiem)", () => {
    expect('if (kind === "SAVINGS_OUT") tongChi += amount;').toMatch(CAM);
    expect('const nhanLaiGoc = row.kind === "SAVINGS_IN";').toMatch(CAM);
    expect('import { laiDuKien } from "@/lib/tiet-kiem/cong-thuc-lai-tiet-kiem";').toMatch(CAM);
    expect('import { soDuDangGui } from "../../../lib/tiet-kiem/so-tiet-kiem-queries";').toMatch(CAM);
    expect("await prisma.soTietKiem.findMany({})").toMatch(CAM);

    // ĐƯỜNG HỢP LỆ — lưới không được đỏ:
    expect('href: "/tai-chinh?tab=dong-tien#tiet-kiem",').not.toMatch(CAM);
    expect("const incomes = await prisma.thuNhap.findMany({ where: { date: khoang } });").not.toMatch(CAM);
    expect("financialIncome: incomes.reduce((s, i) => s + i.amount, 0),").not.toMatch(CAM);
  });

  // Lưới đọc theo DANH SÁCH CỐ ĐỊNH `FILE_CAM` — file mới KHÔNG tự động bị canh. Không có ca này
  // thì Phase sau tách `pnl.ts` thành hai file, quên khai, và lưới im lặng bỏ trống đúng chỗ nhạy
  // nhất (khuôn "lỗ #3" ở tests/unit/marketing/khong-ro-ri-vao-pnl.test.ts).
  //
  // CỐ Ý VẮNG `src/app/(app)/tai-chinh/page.tsx` và `src/lib/reports/cash-flow.ts`: hai file đó là
  // trục DÒNG TIỀN, đọc `so-quy`/`cash-movements` là đúng việc. Thêm vào = lưới đỏ do thiết kế.
  /**
   * Ca DẪN XUẤT — thay cho ca cũ liệt kê tay (review đối kháng 17/09 chỉ ra nó là khẳng định ĐỒNG
   * NGHĨA: `phaiCo` là bản sao của `FILE_CAM` nên chỉ bắt được việc XOÁ một entry, còn THÊM một file
   * P&L mới mà quên khai thì vẫn xanh — đúng lỗ hổng mà chú thích của chính ca đó viện dẫn).
   *
   * Ở đây tập file bị canh được SUY RA từ nội dung thật của repo: quét ba thư mục P&L, lọc file có
   * nhắc `PnlBreakdown|netProfit|financialIncome|buildPnlLineItems`, rồi đòi tập đó ⊆ `FILE_CAM`.
   * Tách `pnl.ts` thành hai file, hoặc thêm một loader P&L mới, mà quên khai ⇒ ca này ĐỎ ngay.
   */
  it("mọi file chạm số P&L trong 3 thư mục báo cáo đều nằm trong FILE_CAM (lưới tự mở rộng)", () => {
    const chamPnl = THU_MUC_PNL.flatMap(docTatCa)
      .filter((f) => DAU_HIEU_PNL.test(f.noiDung))
      .map((f) => f.file);

    // Non-vacuity: phải quét ra một tập ĐÁNG KỂ, không phải mảng rỗng vì đường dẫn sai.
    expect(chamPnl.length).toBeGreaterThanOrEqual(10);

    const chuaKhai = chamPnl.filter((f) => !FILE_CAM.includes(f));
    expect(chuaKhai).toEqual([]);
  });
});
