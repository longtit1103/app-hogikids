import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// TypeScript 7 KHÔNG còn ship JS Compiler API (chỉ export `version`) — file này
// PHẢI dùng AST parser thật (createSourceFile/SyntaxKind...) nên trỏ riêng sang
// gói bí danh `typescript6` (= @typescript/typescript6, compat chính thức của
// đội TypeScript) chỉ cho lượt import này; toàn bộ repo còn lại vẫn build/typecheck
// bằng `typescript` 7 gốc qua tsc CLI.
import ts from "typescript6";
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
  requireUser: vi.fn(async () => "test-user-id"),
  getAuthenticatedUserId: vi.fn(async () => "test-user-id"),
  getSession: vi.fn(async () => ({ userId: "test-user-id" })),
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
  docGhiNhoCuaPhien: vi.fn(async () => false),
  thuHoiMoiPhien: vi.fn(async () => {}),
  docMocPhien: vi.fn(async () => "0"),
}));
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST as backupPost } from "@/app/api/backup/route";
import { importAdsExpenses } from "@/lib/actions/ads-import";
import { createCashMovement, deleteCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
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
import { LOI_DANG_PHUC_HOI, thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { donKhoaPhucHoi } from "./helpers/khoa-bao-tri-reset";
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
  ["expenses.batLaiDinhKy", () => batLaiDinhKy("id-gia")],
  // Khoản tiền khác ghi tay (tab Dòng tiền) — cùng số phận với Expense nhập tay nếu lùi mất giữa lượt phục hồi.
  ["cash-movements.createCashMovement", () => createCashMovement({})],
  ["cash-movements.updateCashMovement", () => updateCashMovement("id-gia", {})],
  ["cash-movements.deleteCashMovement", () => deleteCashMovement("id-gia")],
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
  ["sync.triggerSyncNow", () => triggerSyncNow()],
  // 3 mục dưới đây do PHÉP QUÉT cuối file lôi ra 18/08: chúng gọi `dangPhucHoi()` từ lâu nhưng
  // KHÔNG có trong lưới, tức lời khai "chặn MỌI đường ghi" chưa từng được kiểm cho chúng.
  ["ads-import.importAdsExpenses", () => importAdsExpenses(new FormData())],
  // Guard nằm ngay sau `requireUser()`, TRƯỚC mọi thao tác xoá — gọi trong lúc giữ khoá là an toàn.
  ["data-admin.deleteAllData", () => deleteAllData("ten-shop-sai")],
  ["data-admin.dungLaiTuKhoTho", () => dungLaiTuKhoTho()],
  // Nút "Áp giá vốn Pancake" — đường ghi `costPrice` thứ hai, song song với CLI. Lùi mất giữa
  // lượt phục hồi là hỏng lặng đúng kiểu nguy nhất: giá vốn sai thì COGS sai ở MỌI kỳ.
  ["dong-bo-gia-von-pancake.apGiaVonTheoPancake", () => apGiaVonTheoPancake("theo-pancake", "0:0:0")],
  // Duyệt chi phí nhập hàng từ phiếu Pancake (spec 260917): mỗi dòng là hàng chục triệu trừ thẳng
  // vào quỹ. Lùi mất giữa lượt phục hồi là phiếu quay lại danh sách "chờ duyệt" và bị ghi lần hai.
  ["chi-phi-nhap-hang.ghiChiPhiNhapHang", () => ghiChiPhiNhapHang({})],
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
  "auth.login": "ghi phiên (cookie), không ghi DB — chặn đăng nhập lúc phục hồi không giúp giữ dữ liệu",
  "auth.logout": "xoá phiên (cookie), không ghi DB",
  "cost-price.previewCostImport": "đọc file + đối chiếu, không ghi",
  "data-admin.coDuLieuGiaoDich": "đếm",
  "data-admin.demChiPhiKhongDungLai": "đếm",
  "data-admin.demDonMoCoi": "đếm",
  "data-admin.demAdsMoCoi": "đếm",
  "settings-channels.countRecomputableOrders": "đếm số đơn cho dialog, không ghi",
  "settings-khoa-ket-noi.kiemTraKetNoiNguon": "đọc kho khoá + gọi thử nguồn ngoài, không ghi",
  "n8n-ket-noi.kiemTraKetNoiN8n": "đọc kho khoá + GET danh sách workflow bên n8n, không ghi",
  "shopee-wallet-import.previewShopeeWalletImport": "đọc file ví + checksum, không ghi",
  "sync.getLatestSync": "đọc mốc đồng bộ gần nhất",
};

const here = path.dirname(fileURLToPath(import.meta.url));
const THU_MUC_ACTIONS = path.resolve(here, "../src/lib/actions");

/** Ghi THẲNG bằng Prisma trong chính thân hàm. KHÔNG bắt được ghi UỶ QUYỀN cho module khác. */
const CAU_GHI_PRISMA =
  /\b(?:prisma|tx)\.[A-Za-z_$][\w$]*\.(?:create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b|\$executeRaw(?:Unsafe)?\b/;

type ExportAction = { khoa: string; than: string };

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
      });
    }
  }
  return ra;
}

/**
 * LƯỚI PHỦ PHẢI ĐẦY ĐỦ — chốt bằng máy thay vì bằng trí nhớ.
 *
 * Bảng `DUONG_GHI` trước đây khai tay: 18/08 phép quét này lôi ra 3 action (`importAdsExpenses`,
 * `deleteAllData`, `dungLaiTuKhoTho`) có gọi `dangPhucHoi()` từ lâu mà chưa bao giờ nằm trong lưới —
 * tức lời khai "chặn MỌI đường ghi nhập tay" chưa từng được kiểm cho chúng. Bề mặt vừa tăng từ 1 file
 * `settings.ts` lên 4 file nên xác suất quên chỉ có tăng.
 *
 * ⚠️ GIỚI HẠN ĐÃ BIẾT, đừng đọc test này rộng hơn thực tế: phép quét chỉ đọc THÂN HÀM, nên nó KHÔNG
 * tự nhận ra một action ghi DB bằng cách gọi module khác (`dungLaiTuKhoTho` · `importShopeeWallet` ·
 * `triggerSyncNow` đều thuộc dạng đó). Chúng lọt lưới được là nhờ khai `dangPhucHoi()`. Vì vậy lưới
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
        `(và bảo đảm hàm có \`if (dangPhucHoi()) return …\`). Nếu CHỈ ĐỌC → thêm vào CHI_DOC kèm lý do.`,
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

  it("mọi mục trong DUONG_GHI thật sự CÓ gọi dangPhucHoi() — mục khai suông là lưới rỗng", () => {
    const thieuGuard = daQuet
      .filter((a) => tenTrongLuoi.has(a.khoa) && !a.than.includes("dangPhucHoi()"))
      .map((a) => a.khoa);
    expect(thieuGuard).toEqual([]);
  });

  it("không mục CHI_DOC nào ghi thẳng bằng Prisma — 'chỉ đọc' phải đúng ở mức đọc được bằng máy", () => {
    const thucRaCoGhi = daQuet
      .filter((a) => a.khoa in CHI_DOC && CAU_GHI_PRISMA.test(a.than))
      .map((a) => a.khoa);
    expect(thucRaCoGhi).toEqual([]);
  });
});
