"use server";

import { Prisma } from "@prisma/client";
import { startOfDay } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong, OPT_TX } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { loiSoTietKiem, soTietKiemSchema } from "@/lib/actions/so-tiet-kiem-chung";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { lyDoKhongXoaSoTietKiem } from "@/lib/tiet-kiem/ly-do-khong-xoa-so-tiet-kiem";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";
import { chanSoDuTietKiemAm, khoaSoTietKiem } from "@/lib/tiet-kiem/vi-tu-so-tiet-kiem";

/**
 * 5 server action quản lý SỔ TIẾT KIỆM SINH LÃI (spec §7) — khối "Sổ tiết kiệm" trong tab Dòng tiền.
 *
 * BẤT BIẾN CỦA CẢ FILE — gốc và lãi đi HAI ĐƯỜNG, không bao giờ trộn:
 *   GỐC → `CashMovement` (`SAVINGS_OUT` lúc gửi, `SAVINGS_IN` lúc nhận lại), gắn `savingsId`.
 *   LÃI → `ThuNhap` loại `LAI_TIET_KIEM`, gắn `savingsId` + `refId = TIETKIEM:{id}`.
 * Đối xứng 1-1 với khoản vay (gốc qua `CashMovement`, lãi qua `Expense` danh mục `interest`) đã chạy
 * prod 3 đợt. `SAVINGS_IN` mang ĐÚNG PHẦN GỐC, TUYỆT ĐỐI không bao giờ gồm lãi — cộng lãi vào đó là
 * đếm 2 lần (quỹ cộng một lần qua dòng tiền, P&L cộng thêm một lần qua `ThuNhap`).
 *
 * SỐ TIỀN ĐANG GỬI KHÔNG CÓ CỘT: luôn suy lại từ chính dòng tiền (`soDuDangGui`,
 * `vi-tu-so-tiet-kiem.ts`). Lưu hai chỗ là lệch hai chỗ.
 *
 * SỔ TIẾT KIỆM SINH LÃI (`SAVINGS_*`, gắn `savingsId`) KHÁC HẲN tiền gửi tiết kiệm BẮT BUỘC theo
 * hợp đồng vay (`DEPOSIT_*`, gắn `loanId`) — hai cơ chế sống song song, không đụng nhau, và CHECK
 * `CashMovement_loan_savings_loai_tru` dưới DB cấm một dòng mang cả hai khoá.
 *
 * Mọi action ở đây PHẢI nằm trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts` — phép quét
 * AST chỉ đọc THÂN HÀM export nên `dangPhucHoi()` phải gọi trực tiếp ở đây, KHÔNG uỷ quyền.
 *
 * Isolation để MẶC ĐỊNH (ReadCommitted). TUYỆT ĐỐI KHÔNG Serializable — đo thật 08/09 ở đường khoản
 * vay: Serializable đóng băng snapshot tại câu đầu nên sau khi giành được khoá dòng, vị từ số dư VẪN
 * đọc theo ảnh cũ và thành ra mù. Chỗ dựa đúng là khoá dòng `SoTietKiem` + điều kiện nằm TRONG câu
 * UPDATE — cả hai không phụ thuộc isolation.
 */

/**
 * P2034 = write conflict / deadlock → retry ĐÚNG 1 lần (khuôn `chayGhiKyCoRetry`). Cần vì mọi
 * transaction ở đây đều giành khoá dòng `SoTietKiem`, mà khoá dòng vẫn deadlock được khi chạy chồng
 * một lượt ghi tay cũng chạm sổ đó.
 *
 * An toàn khi chạy lại: P2034 nghĩa là transaction ĐÃ rollback trọn — không có dòng nào sót lại để
 * lượt thứ hai ghi đè lên.
 */
async function chayCoRetry<T>(chay: () => Promise<T>): Promise<T> {
  try {
    return await chay();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") {
      return await chay();
    }
    throw e;
  }
}

/** Chỉ nhận một id — dùng cho sửa / xoá. */
const idSchema = z.object({ id: z.string().min(1, "Chọn sổ tiết kiệm") });

/**
 * Tạo sổ = hồ sơ + ĐÚNG MỘT dòng `SAVINGS_OUT`, trong MỘT transaction (spec §7.1). Không có gửi thêm
 * vào sổ đang có (spec §2) nên dòng gửi là duy nhất và bằng đúng `principal`.
 *
 * KHÔNG gọi `khoaSoTietKiem` ở đây, khác 4 action còn lại: dòng `SoTietKiem` chưa tồn tại lúc vào
 * transaction nên không có gì để khoá, và `create` tự giữ khoá dòng nó vừa sinh tới lúc commit.
 */
export async function taoSoTietKiem(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = soTietKiemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const d = parsed.data;

  try {
    const id = await chayCoRetry(() =>
      prisma.$transaction(async (tx) => {
        const so = await tx.soTietKiem.create({
          data: {
            name: d.name,
            bank: d.bank,
            principal: d.principal,
            startDate: d.startDate,
            termMonths: d.termMonths,
            maturityDate: d.maturityDate,
            annualRateBp: d.annualRateBp,
            loanId: d.loanId,
            note: d.note,
          },
        });
        // Ngày dòng gửi = ĐÚNG `startDate` của sổ: số dư quỹ đếm theo NGÀY DÒNG TIỀN, lệch một ngày
        // là tháng đó hụt/phồng đúng 200tr mà không chỗ nào giải thích.
        await tx.cashMovement.create({
          data: {
            date: d.startDate,
            kind: "SAVINGS_OUT",
            amount: d.principal,
            savingsId: so.id,
            description: `Gửi tiết kiệm ${d.name}`,
          },
        });
        return so.id;
      }, OPT_TX)
    );

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    return { ok: false, ...loiSoTietKiem(e, "Lỗi khi ghi sổ tiết kiệm") };
  }
}

/**
 * Sửa sổ — CHỈ khi `closedAt IS NULL` (§7.3). Sổ đã tất toán thì đường duy nhất là Mở lại rồi sửa:
 * cho sửa thẳng một sổ đã đóng là viết lại một tháng đã vào Lãi/Lỗ mà không dòng tiền nào đổi theo.
 *
 * Đổi `principal` hoặc `startDate` ⇒ sửa LUÔN dòng `SAVINGS_OUT` trong cùng transaction (khuôn
 * `suaKhoanVay` sửa `LOAN_IN`). Quên là quỹ vẫn tụt số cũ trong khi sổ khai số mới, và không chỗ nào
 * trên màn hình nói ra chênh lệch đó. UI có hộp xác nhận cảnh báo "số dư quỹ các tháng đã qua đổi
 * theo" (§7.3) — hộp đó KHÔNG thay cổng này, nó chỉ báo trước.
 *
 * Chỉ chạm dòng tiền khi THẬT SỰ đổi: ghi đè `date` bằng giá trị "cùng ngày khác giờ" sẽ lệch ngầm.
 */
export async function suaSoTietKiem(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  // Hai lượt parse riêng: `soTietKiemSchema` kết thúc bằng `.transform` (ZodEffects) nên không
  // `.extend({ id })` được. Object schema của zod bỏ qua field thừa, nên `id` đi kèm vẫn parse sạch.
  const parsedId = idSchema.safeParse(input);
  if (!parsedId.success) return { ok: false, ...mapZodError(parsedId.error) };
  const parsed = soTietKiemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { id } = parsedId.data;
  const d = parsed.data;

  try {
    await chayCoRetry(() =>
      prisma.$transaction(async (tx) => {
        await khoaSoTietKiem(tx, id);
        const so = await tx.soTietKiem.findUnique({
          where: { id },
          select: { closedAt: true, principal: true, startDate: true },
        });
        if (!so) throw new LoiHopDong("Không tìm thấy sổ tiết kiệm");
        if (so.closedAt !== null) {
          throw new LoiHopDong("Sổ đã tất toán — mở lại trước khi sửa");
        }

        await tx.soTietKiem.update({
          where: { id },
          data: {
            name: d.name,
            bank: d.bank,
            principal: d.principal,
            startDate: d.startDate,
            termMonths: d.termMonths,
            maturityDate: d.maturityDate,
            annualRateBp: d.annualRateBp,
            loanId: d.loanId,
            note: d.note,
          },
        });

        const doiNenTang =
          d.principal !== so.principal ||
          d.startDate.getTime() !== startOfDay(so.startDate).getTime();

        if (doiNenTang) {
          const dongGui = await tx.cashMovement.findMany({
            where: { savingsId: id, kind: "SAVINGS_OUT" },
            select: { id: true },
            orderBy: { date: "asc" },
          });
          // Bất biến "1 sổ = 1 dòng gửi" (§7.1). Sổ lỡ có nhiều dòng thì app KHÔNG đoán sửa dòng
          // nào — ném ⇒ rollback trọn, kể cả câu update hồ sơ ở trên.
          if (dongGui.length > 1) {
            throw new LoiHopDong(
              "Sổ này có nhiều hơn một dòng gửi — xoá dòng ghi tay ở bảng Khoản tiền khác " +
                "(tab Dòng tiền) trước, rồi sửa số tiền / ngày gửi"
            );
          }
          const data = { amount: d.principal, date: d.startDate };
          if (dongGui.length === 1) {
            await tx.cashMovement.update({ where: { id: dongGui[0].id }, data });
          } else {
            // Hàng rào cuối cho sổ lỡ mất dòng gửi (xoá tay ở bảng Khoản tiền khác): dựng lại thay
            // vì để sổ khai 200tr mà quỹ không trừ đồng nào.
            await tx.cashMovement.create({
              data: {
                ...data,
                kind: "SAVINGS_OUT",
                savingsId: id,
                description: `Gửi tiết kiệm ${d.name}`,
              },
            });
          }
        }

        await chanSoDuTietKiemAm(tx, id);
      }, OPT_TX)
    );

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    return { ok: false, ...loiSoTietKiem(e, "Lỗi khi sửa sổ tiết kiệm") };
  }
}

/**
 * Xoá sổ — CHỈ khi chưa tất toán VÀ sổ chỉ có ĐÚNG MỘT dòng `SAVINGS_OUT` do app sinh, không dòng
 * nào khác (§7.4). Xoá = xoá dòng đó + xoá hồ sơ, cùng transaction.
 *
 * Lý do KHÔNG xoá được đi qua vị từ thuần `lyDoKhongXoaSoTietKiem` — DÙNG CHUNG với menu ⋯ ở client
 * (khuôn `lyDoKhongXoaKhoanVay`). Tách ra là hộp ở menu hứa "xoá được" rồi server mới ném toast đỏ
 * cho đúng sổ đó, và hai nơi lệch nhau âm thầm khi thêm trạng thái mới.
 *
 * `coDongGhiTay` gộp HAI ca vì cùng một cách gỡ: có dòng khác `SAVINGS_OUT`, hoặc có nhiều hơn một
 * dòng `SAVINGS_OUT`. Đếm DÒNG chứ không cộng tiền: sổ đã gửi rồi nhận lại hết có Σ = 0 mà dòng vẫn
 * còn, và `deleteMany` bên dưới xoá luôn chúng ⇒ quỹ nhảy lên im lặng.
 */
export async function xoaSoTietKiem(input: unknown): Promise<ActionResult<null>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { id } = parsed.data;

  try {
    await chayCoRetry(() =>
      prisma.$transaction(async (tx) => {
        await khoaSoTietKiem(tx, id);
        const so = await tx.soTietKiem.findUnique({ where: { id }, select: { closedAt: true } });
        if (!so) throw new LoiHopDong("Không tìm thấy sổ tiết kiệm");

        const [soThuNhap, soDongGui, soDongKhac] = await Promise.all([
          tx.thuNhap.count({ where: { savingsId: id } }),
          tx.cashMovement.count({ where: { savingsId: id, kind: "SAVINGS_OUT" } }),
          tx.cashMovement.count({ where: { savingsId: id, kind: { not: "SAVINGS_OUT" } } }),
        ]);

        const lyDo = lyDoKhongXoaSoTietKiem({
          daTatToan: so.closedAt !== null,
          coThuNhap: soThuNhap > 0,
          coDongGhiTay: soDongKhac > 0 || soDongGui > 1,
        });
        if (lyDo !== null) throw new LoiHopDong(lyDo);

        // THÙNG RÁC — chụp cả cụm sau khi mọi cổng đã qua, trước câu xoá đầu tiên. Cổng trên chỉ cho
        // xoá sổ chưa có dòng lãi nào, nhưng vẫn chụp `ThuNhap` (danh sách rỗng) để ảnh chụp không
        // phụ thuộc vào cổng: nới cổng sau này mà quên chỗ này là lãi mất không dấu vết.
        const banGhi = await tx.soTietKiem.findUniqueOrThrow({ where: { id } });
        const dongTien = await tx.cashMovement.findMany({ where: { savingsId: id } });
        const dongLai = await tx.thuNhap.findMany({ where: { savingsId: id } });
        await chupVaoThungRac(tx, {
          bang: "SoTietKiem",
          banGhi,
          cashMovements: dongTien,
          thuNhap: dongLai,
        });

        // FK `onDelete: Restrict` là hàng rào cuối: dọn dòng gửi TRƯỚC rồi mới xoá hồ sơ.
        await tx.cashMovement.deleteMany({ where: { savingsId: id } });
        await tx.soTietKiem.delete({ where: { id } });
      }, OPT_TX)
    );

    lamMoiTrang();
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, ...loiSoTietKiem(e, "Lỗi khi xoá sổ tiết kiệm") };
  }
}
