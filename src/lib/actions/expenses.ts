"use server";

import { Prisma } from "@/generated/prisma/client";
import { format, getDate, isSameMonth, startOfDay, startOfMonth } from "date-fns";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { maLoiNhatKy } from "@/lib/actions/khoan-vay-chung";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { ngayGhiTaySchema } from "@/lib/actions/ngay-ghi-tay-schema";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { mauDinhKySinhChoThang } from "@/lib/expenses/ensure-recurring-expenses";
import { khoaThangDinhKy, laLoiTrungDongDinhKyThang } from "@/lib/expenses/khoa-thang-dinh-ky";
import { thangChoBatLai } from "@/lib/expenses/thang-cho-bat-lai";
import { formatVnd } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { congAction } from "@/lib/quyen/cong-action";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";

/**
 * CRUD cho khoản chi sổ tay ("/chi-phi" modal, phase 5 tái dùng). Task 5 sẽ
 * NỐI THÊM action import ads vào cuối file này — giữ 4 action dưới đây độc
 * lập, không đổi chữ ký.
 */

const ADS_API_LOCKED_ERROR = "Dòng ads tự động từ API — xem log ở Cài đặt › Kết nối";

/**
 * `refId` dạng `LOAN:{loanId}:{yyyy-MM-dd}` — dòng lãi do duyệt kỳ trả nợ hoặc tất toán thấu chi
 * sinh ra (`khoan-vay.ts`, `tat-toan-thau-chi.ts`). Mốc ngày trong khoá CHÍNH LÀ kỳ của nó.
 */
const TIEN_TO_REF_KY_VAY = "LOAN:";

/**
 * Danh mục Lãi vay. Chuỗi trần như mọi nơi khác trong repo (`khoan-vay.ts`, `tat-toan-thau-chi.ts`,
 * `pnl.ts`) — id danh mục hệ thống là hợp đồng seed, không đổi. Hằng CỤC BỘ vì file `"use server"`
 * chỉ được export hàm async.
 */
const DANH_MUC_LAI_VAY = "interest";

const baseExpenseFields = {
  date: ngayGhiTaySchema, // chặn cả ô Ngày trống (null ⇒ 1970) lẫn ngày tương lai — xem module
  categoryId: z.string().min(1, "Chọn danh mục"),
  adsSource: z.enum(["META", "TIKTOK_ADS", "SHOPEE_ADS"]).optional(), // nhập tay/import; ADS_API chỉ do ingest ghi
  // Trần 2 tỷ: Prisma Int (int32) chết ở 2.147.483.647 — vượt trần thì Postgres
  // out-of-range và user chỉ thấy lỗi generic. Chặn tại biên với message rõ.
  amount: z.coerce
    .number()
    .int()
    .positive("Số tiền phải lớn hơn 0")
    .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"),
  channelId: z.string().nullable().default(null),
  description: z.string().max(200, "Tối đa 200 ký tự").default(""),
};

/** Danh mục "ads" bắt buộc chọn nguồn ads — dùng chung cho create/update. */
function requireAdsSource(d: { categoryId: string; adsSource?: string }): boolean {
  return d.categoryId !== "ads" || !!d.adsSource;
}

/** Danh mục "ads" không cho lặp hàng tháng — số ads tự về mỗi đêm qua ingest/import CSV. */
function blockRecurringAds(d: { categoryId: string; recurringMonthly: boolean }): boolean {
  return !(d.categoryId === "ads" && d.recurringMonthly);
}

const createExpenseSchema = z
  .object({ ...baseExpenseFields, recurringMonthly: z.boolean().default(false) })
  .refine(requireAdsSource, { message: "Chọn nguồn ads", path: ["adsSource"] })
  .refine(blockRecurringAds, {
    message:
      "Chi phí quảng cáo không hỗ trợ lặp hàng tháng — số ads tự về mỗi đêm hoặc nhập qua Import CSV",
    path: ["recurringMonthly"],
  });

const updateExpenseSchema = z
  .object(baseExpenseFields)
  .refine(requireAdsSource, { message: "Chọn nguồn ads", path: ["adsSource"] });

/**
 * Lãi vay KHÔNG phân bổ kênh (bất biến #1, cùng luật `fixed`) — cổng DÙNG CHUNG cho tạo mới lẫn sửa,
 * áp MỌI dòng danh mục `interest` (nhập tay lẫn dòng do duyệt kỳ/tất toán sinh ra), không riêng
 * dòng `LOAN:`. `pnl.ts` đã loại `interest` khỏi lăng kính kênh nên gắn kênh không lệch tiền, nhưng
 * làm mọc kênh rỗng ở `/kenh` và dashboard — khoá riêng dòng `LOAN:` thì dòng "Lãi vay" chủ shop
 * nhập tay vẫn đẻ ra đúng triệu chứng đó.
 * Chặn MỌI kênh khác null (không so với kênh đang có): dòng nào lỡ mang kênh từ trước thì lượt sửa
 * kế tiếp tự gỡ, thay vì bị đóng băng ở chỗ sai. Ở `createExpense` cổng phải đứng TRƯỚC nhánh
 * `recurringMonthly`: mẫu `RecurringExpense` mang kênh sẽ sinh lại dòng sai mỗi tháng.
 */
function chanKenhChoLaiVay(d: { categoryId: string; channelId: string | null }): ActionResult | null {
  if (d.categoryId !== DANH_MUC_LAI_VAY || d.channelId === null) return null;
  return {
    ok: false,
    field: "channelId",
    code: "LAI_VAY_KHONG_GAN_KENH",
    error: "Lãi vay không phân bổ theo kênh bán — để trống ô Kênh.",
  };
}

/** Danh mục phải tồn tại + chưa bị ẩn. */
async function validateCategory(categoryId: string): Promise<string | null> {
  const category = await prisma.expenseCategory.findUnique({ where: { id: categoryId } });
  if (!category || category.isHidden) return "Danh mục không hợp lệ";
  return null;
}

/** Kênh (nếu có chọn) phải tồn tại. */
async function validateChannel(channelId: string | null): Promise<string | null> {
  if (!channelId) return null;
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return "Kênh không hợp lệ";
  return null;
}

/**
 * Tạo khoản chi. `recurringMonthly=true` → tạo `RecurringExpense` + 1
 * `Expense{source:"RECURRING"}` ngay cho ngày đã chọn (trong 1 transaction)
 * để `ensureRecurringExpenses` không sinh trùng tháng này.
 *
 * Mốc `activeFrom` của mẫu = đầu THÁNG CỦA DÒNG ĐẦU TIÊN (giờ VN), không phải "tháng hiện tại": ngày
 * ghi tay không cho tương lai nên mốc luôn ≤ tháng này (thường chính là tháng này). Chọn ngày ở tháng
 * cũ = khai khoản đã chạy từ tháng đó ⇒ các tháng từ đó tới nay là chi phí thật, bộ sinh vẫn ghi đủ;
 * còn đặt mốc = tháng hiện tại thì các tháng xen giữa mất trắng khỏi Lãi/Lỗ mà không ai hay. Tháng
 * TRƯỚC dòng đầu thì không bao giờ sinh lùi nữa.
 */
export async function createExpense(input: unknown): Promise<ActionResult> {
  const c = await congAction("chi-phi:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = createExpenseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const data = parsed.data;

  const categoryError = await validateCategory(data.categoryId);
  if (categoryError) return { ok: false, error: categoryError, field: "categoryId" };
  const channelError = await validateChannel(data.channelId);
  if (channelError) return { ok: false, error: channelError, field: "channelId" };
  const kenhLaiVay = chanKenhChoLaiVay(data);
  if (kenhLaiVay) return kenhLaiVay;

  try {
    if (data.recurringMonthly) {
      await prisma.$transaction(async (tx) => {
        const recurring = await tx.recurringExpense.create({
          data: {
            categoryId: data.categoryId,
            amount: data.amount,
            dayOfMonth: getDate(data.date),
            description: data.description,
            channelId: data.channelId,
            active: true,
            activeFrom: startOfMonth(data.date),
          },
        });
        const row = await tx.expense.create({
          data: {
            date: data.date,
            categoryId: data.categoryId,
            adsSource: data.adsSource,
            description: data.description,
            channelId: data.channelId,
            amount: data.amount,
            source: "RECURRING",
            recurringId: recurring.id,
            recurringMonth: khoaThangDinhKy(data.date),
          },
        });
        await ghiNhatKy(tx, {
          actor: nguoiDung,
          hanhDong: "CHI_PHI_TAO",
          doiTuong: { loai: "Expense", id: row.id },
          ghiChu: { thang: format(data.date, "yyyy-MM") },
        });
      });
    } else {
      // Bọc transaction chỉ để dòng nhật ký đi CÙNG câu ghi: nhật ký ném ⇒ khoản chi không lưu.
      await prisma.$transaction(async (tx) => {
        const row = await tx.expense.create({
          data: {
            date: data.date,
            categoryId: data.categoryId,
            adsSource: data.adsSource,
            description: data.description,
            channelId: data.channelId,
            amount: data.amount,
            source: "MANUAL",
          },
        });
        await ghiNhatKy(tx, {
          actor: nguoiDung,
          hanhDong: "CHI_PHI_TAO",
          doiTuong: { loai: "Expense", id: row.id },
          ghiChu: { thang: format(data.date, "yyyy-MM") },
        });
      });
    }
  } catch {
    return { ok: false, error: "Lỗi khi tạo khoản chi" };
  }

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}

/**
 * Sửa khoản chi hiện có: chỉ đổi date/categoryId/adsSource/amount/channelId/
 * description — KHÔNG đụng `source`/`recurringId`/`refId`. Khoá dòng
 * `source==="ADS_API"` (ghi tự động từ ingest, không cho sửa tay).
 */
export async function updateExpense(id: string, input: unknown): Promise<ActionResult> {
  const c = await congAction("chi-phi:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) return { ok: false, error: "Không tìm thấy khoản chi" };
  if (existing.source === "ADS_API") {
    return { ok: false, error: ADS_API_LOCKED_ERROR, code: "ADS_API_LOCKED" };
  }

  const parsed = updateExpenseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const data = parsed.data;

  const categoryError = await validateCategory(data.categoryId);
  if (categoryError) return { ok: false, error: categoryError, field: "categoryId" };
  const channelError = await validateChannel(data.channelId);
  if (channelError) return { ok: false, error: channelError, field: "channelId" };

  // Dòng lãi vay theo kỳ: KHOÁ ngày + danh mục, để MỞ số tiền/mô tả. Kênh (luôn trống) do cổng
  // chung `chanKenhChoLaiVay` ngay dưới đảm nhận — danh mục đã khoá = `interest` nên cổng đó bao trùm.
  // Con dấu `Loan.lastDueHandled` không lùi ở bất kỳ đâu, nên dời ngày là tách kỳ lãi khỏi tháng
  // P&L của nó mà không còn đường duyệt lại; đổi danh mục là mất dòng "Lãi vay" riêng trong bảng
  // Lãi/Lỗ (bất biến #1). Ngược lại, số tiền PHẢI mở: đó là đường duy nhất chủ shop tự chữa được
  // số lãi khai sai sau khi con dấu đã đóng. Đường XOÁ cũng CỐ Ý không chặn — nó là lối thoát duy
  // nhất cho ca khai nhầm khoản vay (`ly-do-khong-xoa-khoan-vay.ts`), và dòng xoá vào thùng rác,
  // khôi phục lại được nguyên `refId`.
  if (existing.refId?.startsWith(TIEN_TO_REF_KY_VAY)) {
    if (startOfDay(existing.date).getTime() !== startOfDay(data.date).getTime()) {
      return {
        ok: false,
        field: "date",
        code: "KY_VAY_KHOA_NGAY",
        error:
          "Dòng lãi vay do duyệt kỳ sinh ra — ngày khoá theo kỳ (con dấu kỳ không lùi được). " +
          "Sửa được số tiền/mô tả; muốn bỏ thì xoá dòng.",
      };
    }
    if (data.categoryId !== existing.categoryId) {
      return {
        ok: false,
        field: "categoryId",
        code: "KY_VAY_KHOA_DANH_MUC",
        error:
          "Dòng lãi vay phải giữ nguyên danh mục — đổi danh mục là mất dòng Lãi vay trong bảng Lãi/Lỗ.",
      };
    }
  }
  const kenhLaiVay = chanKenhChoLaiVay(data);
  if (kenhLaiVay) return kenhLaiVay;

  let chanDoiThang: ActionResult | null;
  try {
    chanDoiThang = await prisma.$transaction(async (tx) => {
      if (existing.recurringId !== null && !isSameMonth(existing.date, data.date)) {
        // KHOÁ dòng mẫu tới hết transaction: "Bật lại" (`batLaiDinhKy`) cũng UPDATE đúng dòng này nên
        // phải CHỜ — không chen được vào giữa lúc cổng đọc "mẫu đã dừng" và lúc dòng bị dời (chen vào
        // là tháng nguồn vừa trống bị sinh bù ⇒ tính 2 lần). Đọc SAU khi giữ khoá (ReadCommitted) nên
        // thấy bản đã commit của lượt bật lại nào vừa xong.
        await tx.$queryRaw`SELECT id FROM "RecurringExpense" WHERE id = ${existing.recurringId} FOR UPDATE`;
        const mau = await tx.recurringExpense.findUnique({
          where: { id: existing.recurringId },
          select: { active: true, activeFrom: true },
        });
        const chan = chanDoiThangDinhKy(mau, existing.date, data.date);
        if (chan) return chan;
      }
      await tx.expense.update({
        where: { id },
        data: {
          date: data.date,
          categoryId: data.categoryId,
          adsSource: data.adsSource ?? null, // đổi danh mục ra khỏi "ads" phải xoá adsSource cũ
          amount: data.amount,
          channelId: data.channelId,
          description: data.description,
          // Khoá tháng đi THEO ngày (CHECK `Expense_recurringMonth_khop_ngay`): lượt dời tháng mà cổng
          // trên cho qua vẫn phải chiếm đúng ô "1 dòng/mẫu/tháng" của tháng mới.
          ...(existing.recurringId !== null ? { recurringMonth: khoaThangDinhKy(data.date) } : {}),
        },
      });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "CHI_PHI_SUA",
        doiTuong: { loai: "Expense", id },
        ghiChu: { thang: format(data.date, "yyyy-MM") },
      });
      return null;
    });
  } catch (e) {
    // Tháng đích đã có dòng của CHÍNH mẫu này (UNIQUE `(recurringId, recurringMonth)`) — trước khi có
    // ràng buộc, lượt dời này lọt thành 2 dòng cùng khoản chi trong một tháng (chi phí tính 2 lần).
    if (laLoiTrungDongDinhKyThang(e)) {
      return {
        ok: false,
        field: "date",
        code: "DINH_KY_TRUNG_THANG",
        error:
          `Tháng ${format(data.date, "MM/yyyy")} đã có dòng của khoản định kỳ này — dời vào là tính 2 lần. ` +
          "Sửa hoặc xoá dòng sẵn có của tháng đó trước.",
      };
    }
    return { ok: false, error: "Lỗi khi cập nhật khoản chi" };
  }
  if (chanDoiThang) return chanDoiThang;

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}

/**
 * Cổng dời một dòng ĐỊNH KỲ sang tháng khác. Cổng chống trùng của `ensureRecurringExpenses` chỉ hỏi
 * "tháng này đã có dòng nào mang `recurringId` chưa" (khoá `(recurringId, recurringMonth)` — UNIQUE dưới
 * DB, khoá tháng = tháng VN của `date`), nên
 * lượt dời hỏng tiền theo HAI chiều, mỗi chiều chỉ xảy ra ở tháng bộ sinh CÒN sinh (mẫu `active` và
 * tháng không nằm trước mốc — `mauDinhKySinhChoThang`):
 *  - tháng NGUỒN vừa trống ⇒ bị sinh bù trong khi dòng dời vẫn nằm ở tháng mới ⇒ tính 2 lần;
 *  - tháng ĐÍCH: dòng dời mang `recurringId` chiếm đúng khoá "1 dòng/mẫu/tháng" — tháng đó đã sinh
 *    thì thành 2 dòng, chưa sinh thì tới hạn bộ sinh KHÔNG sinh khoản của chính tháng đó (mất trọn).
 * Cả hai tháng đều trước mốc (mẫu vừa bật lại) ⇒ không ai sinh ⇒ dời vô hại, chặn là chặn oan. Mẫu đã
 * dừng, hoặc đang chạy với mốc ở tháng sau: chặn thêm chiều ĐÍCH vào tháng hiện tại trở đi (tháng mà
 * một lượt "Bật lại" có thể sinh — xem nhánh đầu hàm). Đổi ngày TRONG CÙNG tháng luôn vô hại (caller
 * không gọi cổng này).
 * Không gỡ `recurringId` để "hợp thức hoá" lượt dời: dòng mất liên kết với mẫu trong danh sách, còn
 * tháng nguồn vẫn bị sinh bù nếu còn trong vùng sinh.
 * Câu lỗi phải nói ĐỦ thứ tự an toàn: thêm tay ở tháng đích mà KHÔNG bật "lặp lại hàng tháng" — mẫu mới
 * mang mốc = tháng của dòng đầu, nên bật lặp ở tháng đích là thêm MỘT khoản định kỳ chạy song song.
 */
function chanDoiThangDinhKy(
  mau: { active: boolean; activeFrom: Date | null } | null,
  ngayCu: Date,
  ngayMoi: Date
): ActionResult | null {
  if (mau === null) return null;
  const huongDan =
    "Đổi ngày trong cùng tháng thì được. Muốn dời hẳn: thêm khoản chi tay ở tháng đích " +
    "(ĐỪNG bật “Lặp lại hàng tháng”) rồi xoá dòng này.";
  const dauThangNay = startOfMonth(new Date());
  // Mẫu DỪNG, hoặc mẫu chạy mà mốc còn ở tương lai (bật lại "từ tháng sau"): hôm nay chưa ai sinh cho
  // tháng này, nhưng một lượt "Bật lại" (với mẫu đang chạy: sau khi dừng) đặt mốc SỚM NHẤT = tháng hiện
  // tại. Dòng dời vào tháng hiện tại trở đi sẽ chiếm khoá "1 dòng/mẫu/tháng" nếu mẫu được bật lại từ
  // tháng đó — bộ sinh không ghi khoản của chính tháng ấy (cùng kết cục với chiều đích bên dưới). Tháng
  // đã qua thì an toàn vĩnh viễn: không lượt bật lại nào sinh cho tháng trước tháng bấm. Tháng NGUỒN
  // không cần cổng thêm: dời dòng tháng này đi rồi bật lại thì tháng này sinh lại — đúng ý người dời.
  // Mẫu chạy mốc NULL hoặc ≤ tháng này: cổng chiều đích bên dưới đã bao tháng hiện tại, không siết thêm.
  const conCoTheBatLaiTuThangNay =
    !mau.active || (mau.activeFrom !== null && startOfMonth(mau.activeFrom) > dauThangNay);
  if (conCoTheBatLaiTuThangNay && mauDinhKySinhChoThang(dauThangNay, ngayMoi)) {
    return {
      ok: false,
      field: "date",
      error:
        `Khoản định kỳ không dời được vào tháng ${format(ngayMoi, "MM/yyyy")} — nếu khoản này được bật lại ` +
        `từ tháng đó, dòng dời vào sẽ lấp mất khoản app tự ghi của chính tháng đó. ${huongDan}`,
    };
  }
  if (!mau.active) return null;
  if (mauDinhKySinhChoThang(mau.activeFrom, ngayCu)) {
    return {
      ok: false,
      field: "date",
      error:
        "Khoản định kỳ không dời được sang tháng khác — app sẽ tự sinh lại dòng của tháng cũ " +
        `(chi phí tính 2 lần). ${huongDan}`,
    };
  }
  if (mauDinhKySinhChoThang(mau.activeFrom, ngayMoi)) {
    return {
      ok: false,
      field: "date",
      error:
        `Khoản định kỳ không dời được vào tháng ${format(ngayMoi, "MM/yyyy")} — tháng đó app tự ghi ` +
        `khoản này (dời vào là tính 2 lần hoặc lấp mất khoản của chính tháng đó). ${huongDan}`,
    };
  }
  return null;
}

/**
 * Xoá 1 khoản chi. `mode="stop_recurring"` (chỉ hợp lệ khi bản ghi có
 * `recurringId`) xoá dòng NÀY + tắt `RecurringExpense.active` trong 1
 * transaction — các khoản đã sinh tháng trước giữ nguyên.
 *
 * Xoá vẫn là xoá CỨNG, nhưng chụp ảnh vào THÙNG RÁC trước trong CÙNG transaction: chủ shop xoá nhầm
 * một dòng chi phí thì kho thô không có bản gốc nào dựng lại được (đúng sự cố đã đẻ ra tính năng
 * này). Cả hai nhánh đều phải chụp — nhánh `stop_recurring` từng dùng `$transaction([...])` dạng
 * MẢNG, đổi sang callback chỉ vì cần `tx` cho lượt chụp.
 */
export async function deleteExpense(
  id: string,
  mode: "only" | "stop_recurring"
): Promise<ActionResult> {
  const c = await congAction("chi-phi:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  // `include: { category: true }` chỉ để lấy TÊN danh mục cho nhãn thùng rác — nhãn phải đọc được
  // cả khi chính danh mục đó bị xoá sau này, nên tên được LƯU chứ không tra lại lúc hiển thị.
  const existing = await prisma.expense.findUnique({ where: { id }, include: { category: true } });
  if (!existing) return { ok: false, error: "Không tìm thấy khoản chi" };
  if (existing.source === "ADS_API") {
    return { ok: false, error: ADS_API_LOCKED_ERROR, code: "ADS_API_LOCKED" };
  }
  if (mode === "stop_recurring" && !existing.recurringId) {
    return { ok: false, error: "Khoản chi này không phải khoản định kỳ" };
  }

  const tatDinhKy = mode === "stop_recurring" ? existing.recurringId : null;

  try {
    await prisma.$transaction(async (tx) => {
      // Khoá mẫu TRƯỚC khi chạm dòng `Expense` — cùng thứ tự với `updateExpense` (mẫu → Expense). Ngược
      // thứ tự (xoá Expense rồi mới UPDATE mẫu) thì hai tab sửa + "Xoá và dừng" cùng một dòng khoá chéo
      // nhau; Postgres huỷ một lượt (không lệch tiền nhưng người dùng gặp lỗi chung vô cớ).
      if (tatDinhKy !== null) {
        await tx.$queryRaw`SELECT id FROM "RecurringExpense" WHERE id = ${tatDinhKy} FOR UPDATE`;
      }
      // Đọc LẠI trong transaction — bản `existing` ở trên chỉ dùng để gác cửa (ADS_API / đúng mode)
      // và chọn nhánh. Giữa hai lượt đọc, một lượt sửa khác có thể đã commit: chụp bản CŨ rồi xoá
      // bản MỚI là khôi phục dựng về một số tiền chưa bao giờ đúng, không dấu vết nào cho thấy lệch.
      const banGhi = await tx.expense.findUnique({ where: { id }, include: { category: true } });
      if (!banGhi) throw new Error("Không tìm thấy khoản chi");
      // Cổng ADS_API kiểm lại trên bản vừa đọc: lượt sửa xen giữa có thể đã biến nó thành dòng khoá.
      if (banGhi.source === "ADS_API") throw new Error(ADS_API_LOCKED_ERROR);

      await chupVaoThungRac(tx, {
        bang: "Expense",
        banGhi,
        tenDanhMuc: banGhi.category.name,
        // Ghi lại mẫu định kỳ vừa bị tắt để người đọc thùng rác biết lượt xoá đã kéo theo cái gì.
        // Khôi phục CỐ Ý không bật lại `active`: chủ shop đã chọn dừng khoản lặp, bật lại là tháng
        // sau lại sinh thêm một khoản chi họ không muốn.
        ...(tatDinhKy === null ? {} : { ghiChu: { recurringDaTat: tatDinhKy } }),
      });
      await tx.expense.delete({ where: { id } });
      if (tatDinhKy !== null) {
        await tx.recurringExpense.update({ where: { id: tatDinhKy }, data: { active: false } });
      }
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "CHI_PHI_XOA",
        doiTuong: { loai: "Expense", id },
        ghiChu: { thang: format(banGhi.date, "yyyy-MM") },
      });
    });
  } catch (e) {
    await ghiNhatKyLoi({
      actor: nguoiDung,
      hanhDong: "CHI_PHI_XOA",
      doiTuong: { loai: "Expense", id },
      ghiChu: { lyDo: maLoiNhatKy(e) },
    });
    return { ok: false, error: "Lỗi khi xoá khoản chi" };
  }

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}

/**
 * Câu lỗi khi tháng bắt đầu không còn hợp lệ. Dùng luôn cho payload sai hình dạng: UI hiện tại luôn gửi
 * đúng, nên sai hình dạng chỉ đến từ bundle cũ còn mở sau deploy — cũng chữa bằng tải lại trang.
 */
const LOI_TRANG_CU = "Trang đã cũ — tải lại trang rồi bật lại";

const batLaiSchema = z.object({
  id: z.string().trim().min(1, "Thiếu khoản định kỳ"),
  tuyChon: z.strictObject(
    {
      /**
       * Tháng bắt đầu `yyyy-MM` — ĐÚNG tháng có nhãn mà chủ shop đã chọn trong hộp xác nhận (server
       * render nhãn + khoá giờ VN). Gửi tháng tuyệt đối chứ không gửi "tháng sau" tương đối: đồng hồ
       * qua nửa đêm cuối tháng giữa lúc hiện hộp và lúc ghi thì "tháng sau" đã trỏ sang tháng khác.
       */
      thangBatDau: z.string({ error: LOI_TRANG_CU }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, LOI_TRANG_CU),
      /** Chủ shop đã thấy cảnh báo trùng mẫu đang chạy và vẫn muốn bật. */
      xacNhanTrung: z.boolean({ error: LOI_TRANG_CU }).optional(),
    },
    { error: LOI_TRANG_CU }
  ),
});

/**
 * BẬT LẠI một khoản định kỳ đã dừng: `active=true` + mốc `activeFrom` = đầu ĐÚNG tháng `thangBatDau`
 * (`yyyy-MM`) chủ shop đã chọn trong hộp xác nhận ⇒ bộ sinh chạy tiếp từ mốc, KHÔNG ghi bù các tháng đã
 * dừng (cổng `mauDinhKySinhChoThang`). Hộp cho chọn tháng này hoặc tháng sau; "tháng sau" là lối cho ca
 * tháng này đã trả/đã ghi tay khoản đó (vd vừa "Xoá và dừng lặp lại" dòng tháng này): mốc tháng này sẽ
 * sinh lại đúng khoản vừa xoá. Tháng này đã có dòng của CHÍNH mẫu thì cổng chống trùng của bộ sinh giữ
 * đúng 1 dòng. Nhãn + khoá tháng format ở SERVER (giờ VN) để client không tự format theo múi máy người bấm.
 *
 * Cổng TRANG CŨ: SAU khi giành khoá nhóm, server so `thangBatDau` với tháng này/tháng sau tại CHÍNH lúc
 * đó (giờ VN). Ngoài hai tháng đó (trang mở từ tháng trước, hoặc tháng quá xa) ⇒ từ chối `TRANG_CU`,
 * không đổi gì — không tự suy tháng khác thay chủ shop. Qua nửa đêm cuối tháng (lúc hiện hộp hay lúc
 * chờ khoá) thì tháng đã chọn hoặc vẫn hợp lệ (chọn "tháng sau" ⇒ nay là tháng này, mốc đúng tháng đã
 * chọn), hoặc bị từ chối (chọn "tháng này" ⇒ nay là tháng trước) — không bao giờ nhảy qua hay lùi về
 * một tháng chủ shop không chọn.
 *
 * Cổng TRÙNG: đang có mẫu KHÁC `active` cùng `categoryId` + cùng `channelId` (null chỉ bằng null) ⇒
 * từ chối `DINH_KY_TRUNG_MAU_DANG_CHAY`, không đổi gì, trừ khi `xacNhanTrung`. UI cũ từng dạy "muốn chạy
 * lại thì thêm khoản định kỳ MỚI", nên rất có thể đã có mẫu thay thế đang chạy — bật mẫu cũ là mỗi tháng
 * trừ 2 lần cùng một khoản chi, không giới hạn. Chỉ so danh mục + kênh (không so mô tả/số tiền): mẫu
 * thay thế thường đổi cả hai; bắt thừa thì chủ shop bấm "Vẫn bật lại", bắt thiếu thì mất tiền.
 *
 * Nguyên tử: `updateMany` có điều kiện `active=false` là compare-and-set — hai lượt bấm đua nhau chỉ
 * một lượt đổi được, lượt kia bị từ chối; mẫu ĐANG chạy thì mốc KHÔNG bị kéo lên (kéo lên là giấu mất
 * các tháng quá khứ chưa sinh của mẫu cũ). Dò trùng chạy SAU khi khoá cả nhóm danh mục + kênh
 * (`khoaNhomMauDinhKy`) — hai mẫu trùng đã dừng bấm bật lại cùng lúc thì chỉ một mẫu chạy.
 * Khôi phục từ thùng rác vẫn CỐ Ý không bật lại — bật lại chỉ đi qua đúng action này, có hộp xác nhận.
 */
export async function batLaiDinhKy(
  recurringId: string,
  tuyChon: { thangBatDau: string; xacNhanTrung?: boolean }
): Promise<ActionResult<{ tuThang: string }>> {
  const c = await congAction("chi-phi:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = batLaiSchema.safeParse({ id: recurringId, tuyChon });
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { id } = parsed.data;
  const xacNhanTrung = parsed.data.tuyChon.xacNhanTrung === true;
  const { thangBatDau } = parsed.data.tuyChon;

  type KetQua =
    | { loai: "DA_BAT"; tuThang: string }
    | { loai: "DINH_KY_DANG_CHAY" | "KHONG_TIM_THAY" | "TRANG_CU" }
    | { loai: "TRUNG"; description: string; amount: number };
  let ketQua: KetQua;
  try {
    ketQua = await prisma.$transaction(async (tx): Promise<KetQua> => {
      // Danh mục + kênh của mẫu KHÔNG đổi sau khi tạo (không action nào sửa hai cột này) ⇒ đọc trước
      // khi khoá vẫn đúng; `active` thì phải đọc lại SAU khoá.
      const nhom = await tx.recurringExpense.findUnique({
        where: { id },
        select: { categoryId: true, channelId: true },
      });
      if (nhom === null) return { loai: "KHONG_TIM_THAY" };
      await khoaNhomMauDinhKy(tx, nhom);
      const mau = await tx.recurringExpense.findUnique({ where: { id }, select: { active: true } });
      if (mau === null) return { loai: "KHONG_TIM_THAY" };
      if (mau.active) return { loai: "DINH_KY_DANG_CHAY" };
      // "Bây giờ" đọc SAU khi giành khoá — lượt chờ khoá vắt qua nửa đêm cuối tháng phải so với tháng
      // MỚI. Mốc lấy từ đúng tháng chủ shop chọn, chỉ nhận khi nó còn là tháng này hoặc tháng sau.
      const { nay, sau } = thangChoBatLai(new Date());
      const chon = [nay, sau].find((t) => t.khoa === thangBatDau);
      if (chon === undefined) return { loai: "TRANG_CU" };
      if (!xacNhanTrung) {
        const trung = await tx.recurringExpense.findFirst({
          where: { id: { not: id }, active: true, categoryId: nhom.categoryId, channelId: nhom.channelId },
          select: { description: true, amount: true },
          orderBy: { description: "asc" },
        });
        if (trung) return { loai: "TRUNG", ...trung };
      }
      const doi = await tx.recurringExpense.updateMany({
        where: { id, active: false },
        data: { active: true, activeFrom: chon.dauThang },
      });
      if (doi.count !== 1) return { loai: "DINH_KY_DANG_CHAY" };
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "CHI_PHI_BAT_DINH_KY",
        doiTuong: { loai: "RecurringExpense", id },
        ghiChu: { thang: chon.khoa },
      });
      return { loai: "DA_BAT", tuThang: chon.nhan };
    });
  } catch {
    return { ok: false, error: "Lỗi khi bật lại khoản định kỳ" };
  }

  switch (ketQua.loai) {
    case "KHONG_TIM_THAY":
      return { ok: false, code: ketQua.loai, error: "Không tìm thấy khoản định kỳ" };
    case "DINH_KY_DANG_CHAY":
      return { ok: false, code: ketQua.loai, error: "Khoản định kỳ này đang chạy — không cần bật lại" };
    case "TRANG_CU":
      return { ok: false, code: ketQua.loai, error: LOI_TRANG_CU };
    case "TRUNG": {
      const moTa = ketQua.description.trim() === "" ? "(không mô tả)" : ketQua.description;
      return {
        ok: false,
        code: "DINH_KY_TRUNG_MAU_DANG_CHAY",
        error:
          `Đang có khoản định kỳ '${moTa}' ${formatVnd(ketQua.amount)} cùng danh mục đang chạy — ` +
          "bật lại sẽ trừ 2 lần mỗi tháng; nên dừng khoản kia trước.",
      };
    }
    case "DA_BAT":
      revalidatePath("/tai-chinh");
      return { ok: true, data: { tuThang: ketQua.tuThang } };
  }
}

/**
 * Khoá (`FOR UPDATE`, tới hết transaction) MỌI mẫu cùng `categoryId` + cùng `channelId` (null chỉ bằng
 * null — đúng nhóm mà cổng trùng của `batLaiDinhKy` dò). Không khoá thì hai mẫu trùng đã dừng bật lại
 * ĐỒNG THỜI (hai tab) đều thấy mẫu kia "đang dừng" và cùng bật ⇒ mỗi tháng trừ 2 lần. Có khoá thì lượt
 * sau CHỜ lượt trước commit rồi đọc lại (ReadCommitted — cùng khuôn `khoaKhoanVay`) ⇒ thấy mẫu kia đã
 * chạy ⇒ từ chối trùng. Khoá theo thứ tự `id` để hai lượt khoá chung nhóm không bao giờ khoá chéo.
 */
async function khoaNhomMauDinhKy(
  tx: Prisma.TransactionClient,
  nhom: { categoryId: string; channelId: string | null }
): Promise<void> {
  const kenh =
    nhom.channelId === null ? Prisma.sql`"channelId" IS NULL` : Prisma.sql`"channelId" = ${nhom.channelId}`;
  await tx.$queryRaw`SELECT id FROM "RecurringExpense" WHERE "categoryId" = ${nhom.categoryId} AND ${kenh} ORDER BY id FOR UPDATE`;
}

/** Tắt một khoản định kỳ — các Expense đã sinh trước đó không đổi. */
export async function stopRecurring(recurringId: string): Promise<ActionResult> {
  const c = await congAction("chi-phi:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.recurringExpense.update({ where: { id: recurringId }, data: { active: false } });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "CHI_PHI_DUNG_DINH_KY",
        doiTuong: { loai: "RecurringExpense", id: recurringId },
      });
    });
  } catch (e) {
    // Chỉ P2025 mới là "không tìm thấy" — lỗi khác (kể cả nhật ký hỏng) không được đội lốt nó.
    const code = (e as { code?: string })?.code;
    return { ok: false, error: code === "P2025" ? "Không tìm thấy khoản định kỳ" : "Lỗi khi dừng khoản định kỳ" };
  }

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}
