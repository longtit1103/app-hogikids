import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionResult } from "@/lib/actions/action-result";

/**
 * LƯỚI PHỦ đường ghi: khoá bảo trì tự khai là "chặn MỌI đường ghi trong lúc schema đích bị xoá +
 * nạp lại" (`src/lib/backup/khoa-bao-tri.ts`). Suite này chốt lời khai đó cho nhóm writer NHẬP TAY
 * (server action + nút Sao lưu) — thiếu một điểm là dữ liệu ghi trong cửa sổ phục hồi bị bản backup
 * lùi mất mà không ai biết.
 *
 * Chỉ giữ khoá TRỰC TIẾP thay vì chạy pg_dump/pg_restore thật: kết quả tất định, không đụng file.
 */
vi.mock("@/lib/session", () => ({
  getSession: vi.fn(async () => ({ userId: "test-user-id" })),
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
  docGhiNhoCuaPhien: vi.fn(async () => false),
  sinhMocPhien: vi.fn(() => "0".repeat(32)),
  thuHoiPhienCuaNguoi: vi.fn(async () => "0".repeat(32)),
  thuHoiMoiPhienMoiNguoi: vi.fn(async () => {}),
}));
// Action đã chuyển sang cổng mới (`congAction`…) đọc ngữ cảnh người dùng ở đây — OWNER giả để lưới
// chỉ đo khoá bảo trì, không đo quyền. Giữ bản thật của các hàm thuần (`coQuyen`, `laChuShop`…).
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  const chuShopGia = {
    id: "test-user-id",
    email: "test-user@hogikids.test",
    tenHienThi: "",
    role: "OWNER" as const,
    quyen: new Set<never>(),
    phaiDoiMatKhau: false,
    mocPhien: "0",
  };
  return { ...that, docNguoiDungPhien: vi.fn(async () => chuShopGia), kiemPhien: vi.fn(async () => chuShopGia) };
});
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST as backupPost } from "@/app/api/backup/route";
import { importAdsExpenses } from "@/lib/actions/ads-import";
import {
  createCashMovement,
  deleteCashMovement,
  suaDieuChinhChuyenDoi,
  updateCashMovement,
} from "@/lib/actions/cash-movements";
import { updateVariantCost, updateVariantThreshold, updateProductCost, updateProductThreshold, importCostPrices } from "@/lib/actions/cost-price";
import { deleteAllData, dungLaiTuKhoTho } from "@/lib/actions/data-admin";
import { ghiChiPhiNhapHang } from "@/lib/actions/chi-phi-nhap-hang";
import { apGiaVonTheoPancake } from "@/lib/actions/dong-bo-gia-von-pancake";
import { createExpense, updateExpense, deleteExpense, stopRecurring, batLaiDinhKy } from "@/lib/actions/expenses";
import {
  ghiKyTraNo,
  suaKhoanVay,
  taoKhoanVay,
  tatToanKhoanVay,
  xoaKhoanVay,
} from "@/lib/actions/khoan-vay";
import { changePassword } from "@/lib/actions/security";
import { doiMatKhauLanDau } from "@/lib/actions/doi-mat-khau-lan-dau";
import {
  datLaiMatKhau,
  khoaTaiKhoan,
  moKhoaTaiKhoan,
  suaQuyenTaiKhoan,
  taoTaiKhoan,
  xoaTaiKhoan,
} from "@/lib/actions/tai-khoan";
import { recomputeFeesInRange, updateChannels } from "@/lib/actions/settings-channels";
import {
  createExpenseCategory,
  deleteExpenseCategory,
  renameExpenseCategory,
  toggleExpenseCategoryHidden,
} from "@/lib/actions/settings-expense-categories";
import { caiWorkflowsN8n, luuKetNoiN8n } from "@/lib/actions/n8n-ket-noi";
import { doiVaLuuTokenMeta, luuKhoaKetNoi } from "@/lib/actions/settings-khoa-ket-noi";
import { updateDefaultLowStockThreshold } from "@/lib/actions/settings-low-stock";
import { updateShopInfo } from "@/lib/actions/settings-shop-info";
import { importShopeeWallet } from "@/lib/actions/shopee-wallet-import";
import {
  suaSoTietKiem,
  taoSoTietKiem,
  xoaSoTietKiem,
} from "@/lib/actions/so-tiet-kiem";
import { triggerSyncNow } from "@/lib/actions/sync";
import { khoiPhucBanGhi, xoaVinhVienBanGhi } from "@/lib/actions/thung-rac";
import { luuSoDuChotThang, xoaSoDuChotThang } from "@/lib/actions/so-du-chot-thang";
import { datQuyToiThieu } from "@/lib/actions/so-quy-quy-toi-thieu";
import { moLaiSoTietKiem, tatToanSoTietKiem } from "@/lib/actions/tat-toan-so-tiet-kiem";
import { tatToanThauChi } from "@/lib/actions/tat-toan-thau-chi";
import {
  boQuaLechDaGiaiThich,
  capNhatDaTraTruoc,
  capNhatTongPhieu,
  danhDauHuyPhieu,
  ghiNhanPhieuVaoSoNo,
  xoaPhieu,
} from "@/lib/actions/phieu-nhap-no";
import { traTienHangGop } from "@/lib/actions/tra-tien-hang";
import { chotSaoKe } from "@/lib/actions/chot-sao-ke";
import { chotSaoKeTuPdf } from "@/lib/actions/sao-ke-the";
import { dongThe, ganNenTang, suaThe, taoThe, xoaGanNenTang, xoaThe } from "@/lib/actions/the-tin-dung";
import { suaViAds, taoViAds, xoaViAds } from "@/lib/actions/vi-ads";
import { boDanhDauBcTiktokKhongDung, danhDauBcTiktokKhongDung } from "@/lib/actions/bc-tiktok-hoa-don";
import { xacNhanBatNoPhaiTra } from "@/lib/actions/bat-no-phai-tra";
import { suaSoTienTruocMoc } from "@/lib/actions/sua-tien-truoc-moc";
import { LOI_DANG_PHUC_HOI, thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { donKhoaPhucHoi } from "./helpers/khoa-bao-tri-reset";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

const RANGE = { from: new Date("2026-07-01T00:00:00+07:00"), to: new Date("2026-07-31T00:00:00+07:00") };

/**
 * Tham số giả: guard chạy TRƯỚC mọi validate nên input không cần hợp lệ.
 *
 * Khoá phải theo đúng `<tên-file>.<tên-hàm>` trong `src/lib/actions/` — phép quét cuối file đối
 * chiếu bảng này với thư mục đó bằng máy, nên nhãn tự bịa sẽ làm đỏ.
 */
const DUONG_GHI: [string, () => Promise<ActionResult<unknown>>][] = [
  ["expenses.createExpense", () => createExpense({})],
  ["expenses.updateExpense", () => updateExpense("id-gia", {})],
  ["expenses.deleteExpense", () => deleteExpense("id-gia", "only")],
  ["expenses.stopRecurring", () => stopRecurring("id-gia")],
  ["expenses.batLaiDinhKy", () => batLaiDinhKy("id-gia", { thangBatDau: "2026-09" })],
  // Khoản tiền khác ghi tay (tab Dòng tiền) — cùng số phận với Expense nhập tay nếu lùi mất giữa lượt phục hồi.
  ["cash-movements.createCashMovement", () => createCashMovement({})],
  ["cash-movements.updateCashMovement", () => updateCashMovement("id-gia", {})],
  ["cash-movements.deleteCashMovement", () => deleteCashMovement("id-gia")],
  ["cash-movements.suaDieuChinhChuyenDoi", () => suaDieuChinhChuyenDoi("id-gia", {})],
  // Khoản vay (tab Dòng tiền, spec 260907): hồ sơ + con dấu kỳ trả — lùi mất giữa lượt phục hồi là ghi trùng lãi/gốc.
  ["khoan-vay.taoKhoanVay", () => taoKhoanVay({})],
  ["khoan-vay.suaKhoanVay", () => suaKhoanVay("id-gia", {})],
  ["khoan-vay.xoaKhoanVay", () => xoaKhoanVay("id-gia")],
  ["khoan-vay.tatToanKhoanVay", () => tatToanKhoanVay("id-gia")],
  ["khoan-vay.ghiKyTraNo", () => ghiKyTraNo({})],
  // Tất toán thấu chi (spec 260908): ghi lãi + TRỌN gốc còn lại rồi đóng khoản — đúng loại lượt ghi
  // mà một bản backup lùi mất sẽ để lại khoản đã đóng ở nơi này, còn dư nợ ở nơi kia.
  ["tat-toan-thau-chi.tatToanThauChi", () => tatToanThauChi({})],
  // Sổ tiết kiệm sinh lãi (spec 260910): GỐC đi `CashMovement` (`SAVINGS_*`), LÃI đi bảng `ThuNhap`
  // — cả hai đường đều ghi tiền thật, và `tatToanSoTietKiem` còn đóng sổ nên một bản backup lùi mất
  // sẽ để lại sổ đã đóng ở nơi này còn gốc chưa về quỹ ở nơi kia.
  ["so-tiet-kiem.taoSoTietKiem", () => taoSoTietKiem({})],
  ["so-tiet-kiem.suaSoTietKiem", () => suaSoTietKiem({})],
  ["so-tiet-kiem.xoaSoTietKiem", () => xoaSoTietKiem({})],
  ["tat-toan-so-tiet-kiem.tatToanSoTietKiem", () => tatToanSoTietKiem({})],
  ["tat-toan-so-tiet-kiem.moLaiSoTietKiem", () => moLaiSoTietKiem({})],
  // Bản chốt số dư cuối tháng (S6 #1): không phải nguồn tiền nhưng vẫn là lượt GHI — một bản backup
  // lùi mất sẽ để chủ shop thấy "đã chốt" ở màn hình trong khi DB không còn dòng đó.
  ["so-du-chot-thang.luuSoDuChotThang", () => luuSoDuChotThang({})],
  ["so-du-chot-thang.xoaSoDuChotThang", () => xoaSoDuChotThang({})],
  // Quỹ tối thiểu (bảng Setting) — ghi lúc đang phục hồi là giá trị mới bị bản dump đè mất, im lặng.
  ["so-quy-quy-toi-thieu.datQuyToiThieu", () => datQuyToiThieu({})],
  // Thùng rác khôi phục (spec 260917): khôi phục DỰNG LẠI bản ghi tiền với đúng id cũ, xoá vĩnh
  // viễn thì đốt luôn đường lấy lại — cả hai đều là lượt ghi mà một bản backup lùi mất sẽ để lại
  // dòng tiền ở nơi này và dòng thùng rác nói ngược lại ở nơi kia.
  ["thung-rac.khoiPhucBanGhi", () => khoiPhucBanGhi("id-gia")],
  ["thung-rac.xoaVinhVienBanGhi", () => xoaVinhVienBanGhi("id-gia")],
  ["cost-price.updateVariantCost", () => updateVariantCost("id-gia", 1000)],
  ["cost-price.updateVariantThreshold", () => updateVariantThreshold("id-gia", 5)],
  ["cost-price.updateProductCost", () => updateProductCost("id-gia", 1000)],
  ["cost-price.updateProductThreshold", () => updateProductThreshold("id-gia", 5)],
  ["cost-price.importCostPrices", () => importCostPrices([{ sku: "SKU1", costPrice: 1000, lowStockThreshold: null }])],
  ["shopee-wallet-import.importShopeeWallet", () => importShopeeWallet(new FormData())],
  ["settings-shop-info.updateShopInfo", () => updateShopInfo(new FormData())],
  ["settings-channels.updateChannels", () => updateChannels([])],
  ["settings-channels.recomputeFeesInRange", () => recomputeFeesInRange(RANGE)],
  ["settings-expense-categories.createExpenseCategory", () => createExpenseCategory("Danh mục thử")],
  ["settings-expense-categories.renameExpenseCategory", () => renameExpenseCategory("id-gia", "Tên mới")],
  ["settings-expense-categories.toggleExpenseCategoryHidden", () => toggleExpenseCategoryHidden("id-gia", true)],
  ["settings-expense-categories.deleteExpenseCategory", () => deleteExpenseCategory("id-gia")],
  ["settings-low-stock.updateDefaultLowStockThreshold", () => updateDefaultLowStockThreshold(5)],
  // Khóa kết nối ghi bảng `Setting` — đúng bảng mà lượt phục hồi nạp lại, lùi mất là hỏng lặng.
  ["settings-khoa-ket-noi.luuKhoaKetNoi", () => luuKhoaKetNoi("pancake", { pancakeApiKeyKho: "khoa-gia" })],
  ["settings-khoa-ket-noi.doiVaLuuTokenMeta", () => doiVaLuuTokenMeta("token-gia")],
  // Khối Kết nối n8n: ghi Setting + ghi/kích hoạt workflow bên n8n — lùi giữa lượt phục hồi là hỏng lặng.
  ["n8n-ket-noi.luuKetNoiN8n", () => luuKetNoiN8n({ n8nBaseUrl: "http://n8n-gia:5678" })],
  ["n8n-ket-noi.caiWorkflowsN8n", () => caiWorkflowsN8n()],
  ["security.changePassword", () => changePassword(new FormData())],
  // Quản lý tài khoản nhân sự: lượt phục hồi lùi cả bảng User — tài khoản vừa tạo/khoá/đặt lại mật
  // khẩu trong cửa sổ đó biến mất hoặc sống lại, còn mật khẩu tạm đã đưa ra thì không còn giá trị.
  ["tai-khoan.taoTaiKhoan", () => taoTaiKhoan(new FormData())],
  ["tai-khoan.suaQuyenTaiKhoan", () => suaQuyenTaiKhoan("id-gia", [])],
  ["tai-khoan.khoaTaiKhoan", () => khoaTaiKhoan("id-gia")],
  ["tai-khoan.moKhoaTaiKhoan", () => moKhoaTaiKhoan("id-gia")],
  ["tai-khoan.xoaTaiKhoan", () => xoaTaiKhoan("id-gia")],
  ["tai-khoan.datLaiMatKhau", () => datLaiMatKhau("id-gia")],
  // Đổi mật khẩu lần đầu chỉ mở cho người đang `phaiDoiMatKhau` — giả đúng trạng thái đó để lưới đo
  // khoá bảo trì chứ không đo nhánh "không cần đổi".
  [
    "doi-mat-khau-lan-dau.doiMatKhauLanDau",
    () => {
      vi.mocked(docNguoiDungPhien).mockResolvedValueOnce(nguoiDungGia({ id: "test-user-id", phaiDoiMatKhau: true }));
      return doiMatKhauLanDau(new FormData());
    },
  ],
  ["sync.triggerSyncNow", () => triggerSyncNow()],
  // 3 mục dưới đây do PHÉP QUÉT cuối file lôi ra 18/08: chúng gọi cổng khoá phục hồi từ lâu nhưng
  // KHÔNG có trong lưới, tức lời khai "chặn MỌI đường ghi" chưa từng được kiểm cho chúng.
  ["ads-import.importAdsExpenses", () => importAdsExpenses(new FormData())],
  // Guard nằm ngay sau cổng chủ shop, TRƯỚC mọi thao tác xoá — gọi trong lúc giữ khoá là an toàn.
  ["data-admin.deleteAllData", () => deleteAllData("ten-shop-sai")],
  ["data-admin.dungLaiTuKhoTho", () => dungLaiTuKhoTho()],
  // Nút "Áp giá vốn Pancake" — đường ghi `costPrice` thứ hai, song song với CLI. Lùi mất giữa
  // lượt phục hồi là hỏng lặng đúng kiểu nguy nhất: giá vốn sai thì COGS sai ở MỌI kỳ.
  ["dong-bo-gia-von-pancake.apGiaVonTheoPancake", () => apGiaVonTheoPancake("theo-pancake", "0:0:0")],
  // Duyệt chi phí nhập hàng từ phiếu Pancake (spec 260917): mỗi dòng là hàng chục triệu trừ thẳng
  // vào quỹ. Lùi mất giữa lượt phục hồi là phiếu quay lại danh sách "chờ duyệt" và bị ghi lần hai.
  ["chi-phi-nhap-hang.ghiChiPhiNhapHang", () => ghiChiPhiNhapHang({})],
  // Nợ phải trả — phiếu nhập (P3): hồ sơ nghĩa vụ + dòng SUPPLIER_PAY. Lùi mất giữa lượt phục hồi là
  // phiếu quay về "chưa ghi nhận" trong khi tiền đã trả nằm đâu đó, hoặc đợt trả gộp bị ghi lần hai.
  ["phieu-nhap-no.ghiNhanPhieuVaoSoNo", () => ghiNhanPhieuVaoSoNo({})],
  ["phieu-nhap-no.capNhatTongPhieu", () => capNhatTongPhieu({})],
  ["phieu-nhap-no.capNhatDaTraTruoc", () => capNhatDaTraTruoc({})],
  ["phieu-nhap-no.danhDauHuyPhieu", () => danhDauHuyPhieu({})],
  ["phieu-nhap-no.xoaPhieu", () => xoaPhieu({})],
  ["phieu-nhap-no.boQuaLechDaGiaiThich", () => boQuaLechDaGiaiThich({})],
  ["tra-tien-hang.traTienHangGop", () => traTienHangGop({})],
  // Nợ phải trả — thẻ tín dụng (P4): hồ sơ thẻ + mốc gắn nền tảng + kỳ sao kê là điểm tựa của dư nợ;
  // lùi mất giữa lượt phục hồi là dư nợ mất neo, hoặc chốt sao kê ghi lại lần hai với mã yêu cầu mới.
  ["the-tin-dung.taoThe", () => taoThe({})],
  ["the-tin-dung.suaThe", () => suaThe("id-gia", {})],
  ["the-tin-dung.dongThe", () => dongThe("id-gia")],
  ["the-tin-dung.xoaThe", () => xoaThe("id-gia")],
  ["the-tin-dung.ganNenTang", () => ganNenTang({})],
  ["the-tin-dung.xoaGanNenTang", () => xoaGanNenTang("id-gia")],
  ["chot-sao-ke.chotSaoKe", () => chotSaoKe({})],
  // Chốt sao kê từ file PDF: cùng diện chốt gõ tay (kỳ sao kê + dòng sao kê là neo dư nợ).
  ["sao-ke-the.chotSaoKeTuPdf", () => chotSaoKeTuPdf(new FormData())],
  // Nợ phải trả — hồ sơ ví ads trả trước + bước xác nhận bật: bước bật ghi Setting M + neo + điều chỉnh
  // quỹ một lần; lùi mất giữa lượt phục hồi là quỹ quay về công thức cũ trong khi hồ sơ đã ghi đè.
  ["vi-ads.taoViAds", () => taoViAds({})],
  ["vi-ads.suaViAds", () => suaViAds("id-gia", {})],
  ["vi-ads.xoaViAds", () => xoaViAds("id-gia")],
  ["bc-tiktok-hoa-don.danhDauBcTiktokKhongDung", () => danhDauBcTiktokKhongDung({ bcId: "7129545797879726081" })],
  ["bc-tiktok-hoa-don.boDanhDauBcTiktokKhongDung", () => boDanhDauBcTiktokKhongDung("7129545797879726081")],
  ["bat-no-phai-tra.xacNhanBatNoPhaiTra", () => xacNhanBatNoPhaiTra({})],
  // Sửa số tiền chi phí trước ngày bật: đổi Expense + thêm dòng điều chỉnh mở sổ cùng transaction — lùi mất giữa
  // lượt phục hồi là Lãi/Lỗ và quỹ từ M lệch nhau đúng phần bù.
  ["sua-tien-truoc-moc.suaSoTienTruocMoc", () => suaSoTienTruocMoc("id-gia", {})],
];

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(() => {
  donKhoaPhucHoi();
});

afterAll(async () => {
  // BẮT BUỘC: khoá là biến module dùng chung — để sót thì mọi file test sau đều nhận 503.
  donKhoaPhucHoi();
  await prisma.$disconnect();
});

describe("đang phục hồi → mọi đường ghi nhập tay bị từ chối", () => {
  it.each(DUONG_GHI)("%s trả đúng câu báo đang phục hồi", async (_ten, goi) => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    const res = await goi();

    expect(res.ok).toBe(false);
    // So khớp CHÍNH XÁC hằng: sai chính tả câu báo cũng phải đỏ.
    if (!res.ok) expect(res.error).toBe(LOI_DANG_PHUC_HOI);
  });

  it("KHÔNG giữ khoá → action vẫn lỗi nhưng vì lý do KHÁC (bảng trên không xanh nhờ lỗi sẵn có)", async () => {
    const res = await createExpense({});

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toBe(LOI_DANG_PHUC_HOI);
  });

  it("từ chối TRƯỚC khi ghi — DB không có dòng nào mới", async () => {
    await truncateBusinessTables();
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    const res = await createExpense({
      date: "2026-07-10",
      categoryId: "other",
      amount: 500_000,
      channelId: null,
      description: "khoản chi trong lúc phục hồi",
      recurringMonthly: false,
    });

    expect(res.ok).toBe(false);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("POST /api/backup → 503 kèm Retry-After, KHÔNG chạy pg_dump", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    // Cố ý KHÔNG mock `runPgDump`: guard nằm TRƯỚC lời gọi đó, nên ai đảo thứ tự sẽ thấy test đỏ
    // ngay bằng lỗi thiếu binary thay vì lặng lẽ trả một file dump thiếu dữ liệu.
    // Request rỗng, KHÔNG có `Origin`: cổng `chanRequestKhacOrigin` fail-open khi vắng header
    // đó, nên ca này vẫn đo đúng cổng khoá bảo trì chứ không vô tình đo cổng CSRF.
    const res = await backupPost(new Request("http://localhost/api/backup", { method: "POST" }));

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect((await res.json()).error).toBe(LOI_DANG_PHUC_HOI);
  });
});

/**
 * Export CHỈ ĐỌC của `src/lib/actions/` — CỐ Ý không nằm trong lưới khoá phục hồi. Liệt kê TƯỜNG
 * MINH (cùng tinh thần `LAND_ONLY` ở transform): export mới nào không được xếp vào một trong hai
 * nhóm sẽ làm đỏ, thay vì lặng lẽ nằm ngoài lưới.
 */
const CHI_DOC: Record<string, string> = {
  "ads-import.previewAdsImport": "đọc file người dùng tải lên + tra trùng, không ghi",
  "auth.login":
    "ghi phiên (cookie); lastLoginAt + nhật ký là best-effort, TỰ BỎ QUA khi dangPhucHoi() — chặn đăng nhập lúc phục hồi không giúp giữ dữ liệu",
  "auth.logout": "xoá phiên (cookie); nhật ký đăng xuất best-effort, TỰ BỎ QUA khi dangPhucHoi()",
  "cost-price.previewCostImport": "đọc file + đối chiếu, không ghi",
  "uoc-tinh-sao-ke.docUocTinhSaoKe": "chỉ đọc dư nợ ước tính của thẻ tại một ngày (form chốt sao kê), không ghi",
  "sao-ke-the.xemTruocSaoKeThe": "chỉ tách file sao kê PDF + đối chiếu với hoá đơn TikTok (bước xem trước), không ghi",
  "bat-no-phai-tra.docChenhLechTaiM": "chỉ đọc chênh lệch quỹ ↔ tiền thật tại ngày bật nợ phải trả, không ghi",
  "cong-gia-von.kiemQuyenXemGiaVon":
    "KHÔNG phải Server Action (file không \"use server\") — bước hai của cổng giá vốn, chỉ ghi dòng TU_CHOI_QUYEN qua ghiNhatKyLoi (tự bỏ qua lúc phục hồi)",
  "data-admin.coDuLieuGiaoDich": "đếm",
  "khoang-ngay.luuLuaChonKhoangNgay": "ghi cookie lựa chọn khoảng ngày của bộ chọn, không ghi DB",
  "data-admin.demChiPhiKhongDungLai": "đếm",
  "data-admin.demDonMoCoi": "đếm",
  "data-admin.demAdsMoCoi": "đếm",
  "settings-channels.countRecomputableOrders": "đếm số đơn cho dialog, không ghi",
  "settings-khoa-ket-noi.kiemTraKetNoiNguon": "đọc kho khoá + gọi thử nguồn ngoài, không ghi",
  "n8n-ket-noi.kiemTraKetNoiN8n": "đọc kho khoá + GET danh sách workflow bên n8n, không ghi",
  "shopee-wallet-import.previewShopeeWalletImport": "đọc file ví + checksum, không ghi",
  "sync.getLatestSync": "đọc mốc đồng bộ gần nhất",
  "sync.getTienDoDongBoNgay": "đọc SyncLog tiến độ lượt Đồng bộ ngay",
};

const here = path.dirname(fileURLToPath(import.meta.url));
const THU_MUC_ACTIONS = path.resolve(here, "../src/lib/actions");

/** Ghi THẲNG bằng Prisma trong chính thân hàm. KHÔNG bắt được ghi UỶ QUYỀN cho module khác. */
const CAU_GHI_PRISMA =
  /\b(?:prisma|tx)\.[A-Za-z_$][\w$]*\.(?:create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b|\$executeRaw(?:Unsafe)?\b/;

type ExportAction = { khoa: string; than: string; body: ts.Block | undefined; sf: ts.SourceFile };

const chuanHoaKhoangTrang = (n: ts.Node, sf: ts.SourceFile) => n.getText(sf).replace(/\s+/g, " ").trim();

/**
 * Khuôn cửa ghi của một action (rỗng = đạt), mọi ý đều đo trên CÂY cú pháp của thân hàm:
 *  - có đúng một `const cua = vaoCuaGhi();` ở mức cao nhất của thân;
 *  - ngay sau nó là `if (!cua.ok) return cua.loi;`, rồi MỘT `try` là câu CUỐI CÙNG của thân — không câu
 *    nào nằm ngoài `try` (return/ghi lọt khỏi `finally` ⇒ bộ đếm không bao giờ trả);
 *  - `finally` của `try` gọi `cua.ra()`;
 *  - trước cửa (cổng quyền, tra cứu) không có câu ghi Prisma trực tiếp — ghi lọt khỏi cửa là ghi giữa lúc phục hồi;
 *  - trong `try`/`catch` của cửa, `return` một lời gọi PHẢI có `await` (`returnThieuAwait`).
 */
function viPhamCuaGhi(body: ts.Block | undefined, sf: ts.SourceFile): string[] {
  if (!body) return ["không có thân hàm"];
  const ds = [...body.statements];
  const laVaoCua = (st: ts.Statement) =>
    ts.isVariableStatement(st) &&
    st.declarationList.declarations.some(
      (d) =>
        ts.isIdentifier(d.name) &&
        d.name.text === "cua" &&
        d.initializer !== undefined &&
        ts.isCallExpression(d.initializer) &&
        ts.isIdentifier(d.initializer.expression) &&
        d.initializer.expression.text === "vaoCuaGhi" &&
        d.initializer.arguments.length === 0,
    );
  const viTri = ds.map((st, i) => (laVaoCua(st) ? i : -1)).filter((i) => i >= 0);
  if (viTri.length !== 1) return [`cần đúng một \`const cua = vaoCuaGhi();\` ở mức cao nhất thân hàm (thấy ${viTri.length})`];
  const loi: string[] = [];
  const truoc = ds.slice(0, viTri[0]);
  if (truoc.some((st) => CAU_GHI_PRISMA.test(st.getText(sf)))) loi.push("có câu ghi Prisma TRƯỚC cửa ghi");
  const sau = ds.slice(viTri[0] + 1);
  if (sau.length !== 2) loi.push(`sau cửa phải là đúng 2 câu (if từ chối + try), thấy ${sau.length}`);
  const [tuChoi, thanTry] = sau;
  if (!tuChoi || !ts.isIfStatement(tuChoi) || chuanHoaKhoangTrang(tuChoi, sf) !== "if (!cua.ok) return cua.loi;") {
    loi.push("câu ngay sau cửa phải là `if (!cua.ok) return cua.loi;`");
  }
  if (!thanTry || !ts.isTryStatement(thanTry) || !thanTry.finallyBlock) {
    loi.push("phần còn lại của thân phải nằm trong try { … } finally { cua.ra(); }");
  } else if (!thanTry.finallyBlock.statements.some((st) => chuanHoaKhoangTrang(st, sf) === "cua.ra();")) {
    loi.push("finally không gọi cua.ra()");
  }
  if (thanTry && ts.isTryStatement(thanTry)) {
    for (const k of returnThieuAwait(thanTry, sf)) loi.push(`\`return ${k}(…)\` trong cửa thiếu \`await\``);
  }
  return loi;
}

/**
 * `return f(...)` (không `await`) trong `try { … } finally { cua.ra(); }`: `finally` chạy NGAY khi `f`
 * chạm `await` đầu tiên — cửa đóng + bộ đếm trả trong khi transaction của `f` còn chạy, drain báo sạch
 * và bản lùi chụp TRƯỚC lúc nó COMMIT. Trả tên các lời gọi vi phạm trong khối `try` và `catch` của cửa
 * (bỏ qua hàm lồng — callback có ngữ cảnh riêng).
 *
 * Miễn DUY NHẤT: hàm khai ở CÙNG file, không `async`, không khai kiểu trả về chứa `Promise` (helper
 * dựng câu lỗi đồng bộ như `thatBai`). Hàm nhập từ file khác ⇒ không biết đồng bộ hay không ⇒ phải
 * `await` (fail-closed: `await` một giá trị thường vô hại).
 */
function returnThieuAwait(thanTry: ts.TryStatement, sf: ts.SourceFile): string[] {
  const dongBo = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name) continue;
    const laAsync = (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const traPromise = st.type !== undefined && /\bPromise\b|PromiseLike/.test(st.type.getText(sf));
    if (!laAsync && !traPromise) dongBo.add(st.name.text);
  }
  const ra: string[] = [];
  const xetBieuThuc = (e: ts.Expression): void => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    }
    if (ts.isConditionalExpression(e)) {
      xetBieuThuc(e.whenTrue);
      xetBieuThuc(e.whenFalse);
      return;
    }
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      const ten = e.expression.getText(sf);
      if (!(ts.isCallExpression(e) && ts.isIdentifier(e.expression) && dongBo.has(ten))) ra.push(ten);
    }
  };
  const di = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) xetBieuThuc(n.expression);
    ts.forEachChild(n, di);
  };
  di(thanTry.tryBlock);
  if (thanTry.catchClause) di(thanTry.catchClause.block);
  return ra;
}

/** Thân hàm của đoạn mã mẫu — cho phép đột biến tự kiểm của chính bộ kiểm khuôn. */
function thanCuaMau(ma: string): { body: ts.Block; sf: ts.SourceFile } {
  const sf = ts.createSourceFile("mau.ts", `async function f() {${ma}}`, ts.ScriptTarget.Latest, true);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  return { body: fn.body as ts.Block, sf };
}

/**
 * Liệt kê MỌI `export async function` trong `src/lib/actions/` bằng AST TypeScript (không regex:
 * thân hàm phải cắt đúng, nếu không một helper nằm giữa hai export sẽ bị gán nhầm chủ).
 */
function quetExportActions(): ExportAction[] {
  const ra: ExportAction[] = [];
  for (const ten of readdirSync(THU_MUC_ACTIONS).filter((f) => f.endsWith(".ts")).sort()) {
    const ma = readFileSync(path.join(THU_MUC_ACTIONS, ten), "utf8");
    const sf = ts.createSourceFile(ten, ma, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.name) continue;
      const co = (k: ts.SyntaxKind) => (ts.getModifiers(st) ?? []).some((m) => m.kind === k);
      if (!co(ts.SyntaxKind.ExportKeyword) || !co(ts.SyntaxKind.AsyncKeyword)) continue;
      ra.push({
        khoa: `${ten.replace(/\.ts$/, "")}.${st.name.text}`,
        than: st.body ? st.body.getText(sf) : "",
        body: st.body,
        sf,
      });
    }
  }
  return ra;
}

/**
 * LƯỚI PHỦ PHẢI ĐẦY ĐỦ — chốt bằng máy thay vì bằng trí nhớ.
 *
 * Bảng `DUONG_GHI` trước đây khai tay: 18/08 phép quét này lôi ra 3 action (`importAdsExpenses`,
 * `deleteAllData`, `dungLaiTuKhoTho`) có gọi cổng khoá phục hồi từ lâu mà chưa bao giờ nằm trong lưới —
 * tức lời khai "chặn MỌI đường ghi nhập tay" chưa từng được kiểm cho chúng. Bề mặt vừa tăng từ 1 file
 * `settings.ts` lên 4 file nên xác suất quên chỉ có tăng.
 *
 * ⚠️ GIỚI HẠN ĐÃ BIẾT, đừng đọc test này rộng hơn thực tế: phép quét chỉ đọc THÂN HÀM, nên nó KHÔNG
 * tự nhận ra một action ghi DB bằng cách gọi module khác (`dungLaiTuKhoTho` · `importShopeeWallet` ·
 * `triggerSyncNow` đều thuộc dạng đó). Chúng lọt lưới được là nhờ mở `vaoCuaGhi()`. Vì vậy lưới
 * chốt theo hướng FAIL-CLOSED: mọi export phải nằm ở `DUONG_GHI` hoặc `CHI_DOC`, không có nhóm thứ ba.
 */
describe("lưới đường ghi phải phủ hết export của src/lib/actions", () => {
  const daQuet = quetExportActions();
  const tenTrongLuoi = new Set(DUONG_GHI.map(([ten]) => ten));

  it("mọi export async được phân loại — không có mục nào nằm ngoài cả hai nhóm", () => {
    const chuaPhanLoai = daQuet
      .map((a) => a.khoa)
      .filter((k) => !tenTrongLuoi.has(k) && !(k in CHI_DOC));

    // Thông báo phải nói được PHẢI LÀM GÌ: người gặp đỏ này thường là người vừa thêm action mới.
    expect(
      chuaPhanLoai,
      `Action mới chưa phân loại: ${chuaPhanLoai.join(", ")}. Nếu nó GHI dữ liệu → thêm vào DUONG_GHI ` +
        `(và bảo đảm hàm mở cửa bằng \`vaoCuaGhi()\`, bọc phần còn lại trong try/finally { cua.ra() }). Nếu CHỈ ĐỌC → thêm vào CHI_DOC kèm lý do.`,
    ).toEqual([]);
  });

  it("không mục nào trong lưới đã chết (đổi tên / xoá / chuyển file)", () => {
    const coThat = new Set(daQuet.map((a) => a.khoa));
    expect([...tenTrongLuoi].filter((k) => !coThat.has(k))).toEqual([]);
    expect(Object.keys(CHI_DOC).filter((k) => !coThat.has(k))).toEqual([]);
  });

  it("một hàm không thể vừa ghi vừa chỉ-đọc", () => {
    expect(Object.keys(CHI_DOC).filter((k) => tenTrongLuoi.has(k))).toEqual([]);
  });

  it("mọi mục trong DUONG_GHI đi qua cửa ghi đúng khuôn — mục khai suông là lưới rỗng", () => {
    const sai = daQuet
      .filter((a) => tenTrongLuoi.has(a.khoa))
      .flatMap((a) => viPhamCuaGhi(a.body, a.sf).map((v) => `${a.khoa}: ${v}`));
    expect(sai).toEqual([]);
  });

  it("không action ghi nào còn tự kiểm cờ phục hồi ở cửa (`dangPhucHoi()`) — cổng duy nhất là vaoCuaGhi()", () => {
    const conKiemTay = daQuet
      .filter((a) => tenTrongLuoi.has(a.khoa) && a.than.includes("dangPhucHoi()"))
      .map((a) => a.khoa);
    expect(conKiemTay).toEqual([]);
  });

  it("không mục CHI_DOC nào ghi thẳng bằng Prisma — 'chỉ đọc' phải đúng ở mức đọc được bằng máy", () => {
    const thucRaCoGhi = daQuet
      .filter((a) => a.khoa in CHI_DOC && CAU_GHI_PRISMA.test(a.than))
      .map((a) => a.khoa);
    expect(thucRaCoGhi).toEqual([]);
  });
});

/**
 * Đột biến tự kiểm: bộ kiểm khuôn cửa ghi phải ĐỎ trên từng cách làm hỏng cửa, và xanh trên khuôn đúng —
 * không thì "mọi action đều đạt" ở trên chỉ chứng minh bộ kiểm dễ tính.
 */
describe("bộ kiểm khuôn cửa ghi bắt được từng kiểu làm hỏng cửa", () => {
  const dung = `
    const cong = await congAction("x");
    if (!cong.ok) return cong;
    const cua = vaoCuaGhi();
    if (!cua.ok) return cua.loi;
    try {
      await prisma.expense.create({ data: {} });
      return { ok: true };
    } finally {
      cua.ra();
    }`;
  const kiem = (ma: string) => {
    const { body, sf } = thanCuaMau(ma);
    return viPhamCuaGhi(body, sf);
  };

  it("khuôn đúng → không vi phạm", () => {
    expect(kiem(dung)).toEqual([]);
  });

  it("thiếu vaoCuaGhi() → đỏ", () => {
    expect(kiem(dung.replace("const cua = vaoCuaGhi();", "const cua = tuNghi();")).length).toBeGreaterThan(0);
  });

  it("quên finally { cua.ra() } → đỏ", () => {
    expect(kiem(dung.replace("cua.ra();", "")).join("|")).toContain("finally không gọi cua.ra()");
  });

  it("cua.ra() rơi ra ngoài finally → đỏ", () => {
    const ma = `
      const cua = vaoCuaGhi();
      if (!cua.ok) return cua.loi;
      try { await prisma.expense.create({ data: {} }); } catch {}
      cua.ra();
      return { ok: true };`;
    expect(kiem(ma).length).toBeGreaterThan(0);
  });

  it("câu ghi nằm sau try (lọt khỏi cửa) → đỏ", () => {
    const ma = `${dung}
    await prisma.expense.create({ data: {} });`;
    expect(kiem(ma).length).toBeGreaterThan(0);
  });

  it("thiếu nhánh từ chối `if (!cua.ok) return cua.loi;` → đỏ", () => {
    expect(kiem(dung.replace("if (!cua.ok) return cua.loi;", "")).length).toBeGreaterThan(0);
  });

  it("ghi Prisma TRƯỚC cửa → đỏ", () => {
    const ma = `
      await prisma.expense.deleteMany({});
      const cua = vaoCuaGhi();
      if (!cua.ok) return cua.loi;
      try { return { ok: true }; } finally { cua.ra(); }`;
    expect(kiem(ma).join("|")).toContain("TRƯỚC cửa ghi");
  });

  it("`return` lời gọi async KHÔNG await trong try của cửa → đỏ; có await / helper đồng bộ cùng file → đạt", () => {
    const voi = (traVe: string) => `
      const cua = vaoCuaGhi();
      if (!cua.ok) return cua.loi;
      try {
        if (x) return thatBai("A");
        ${traVe}
      } catch (e) {
        return thatBai("B");
      } finally {
        cua.ra();
      }`;
    const kiemFile = (ma: string, phu = "") => {
      const sf = ts.createSourceFile("mau.ts", `${phu}\nasync function f() {${ma}}`, ts.ScriptTarget.Latest, true);
      const fn = sf.statements.find((st) => ts.isFunctionDeclaration(st) && st.name?.text === "f") as ts.FunctionDeclaration;
      return viPhamCuaGhi(fn.body, sf);
    };
    const phu = `function thatBai(m: string) { return { ok: false, error: m }; }
      async function suaPhieu() { return 1; }`;
    expect(kiemFile(voi("return await suaPhieu();"), phu)).toEqual([]);
    expect(kiemFile(voi("return suaPhieu();"), phu).join("|")).toContain("return suaPhieu(…)");
    // Hàm nhập từ file khác (không khai ở đây) ⇒ fail-closed.
    expect(kiemFile(voi("return xuLyLoiNhap(e);"), phu).join("|")).toContain("return xuLyLoiNhap(…)");
    // Nhánh điều kiện, ép kiểu, và trong catch đều bị soi.
    expect(kiemFile(voi("return (y ? suaPhieu() : thatBai('C')) as never;"), phu).join("|")).toContain("return suaPhieu(…)");
    expect(
      kiemFile(voi("return await suaPhieu();").replace('return thatBai("B");', "return suaPhieu();"), phu).join("|"),
    ).toContain("return suaPhieu(…)");
    // Callback lồng có ngữ cảnh riêng — không soi.
    expect(kiemFile(voi("return await prisma.$transaction(async (tx) => { return tx.a.create({}); });"), phu)).toEqual([]);
  });

  it("hai cửa trong một hàm → đỏ", () => {
    expect(kiem(`${dung}
    const cua2 = vaoCuaGhi();`).length).toBeGreaterThan(0);
  });
});
