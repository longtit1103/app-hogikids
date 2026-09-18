"use server";

import { Prisma } from "@prisma/client";
import { format, startOfDay } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong, OPT_TX, soTienKySchema } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { ngayGhiTaySchema } from "@/lib/actions/ngay-ghi-tay-schema";
import { loiSoTietKiem, REF_LAI_PREFIX } from "@/lib/actions/so-tiet-kiem-chung";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { formatVnd } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import {
  chanSoDuTietKiemAm,
  khoaSoTietKiem,
  soDuDangGui,
} from "@/lib/tiet-kiem/vi-tu-so-tiet-kiem";

/**
 * KẾT THÚC VÒNG ĐỜI một sổ tiết kiệm: `tatToanSoTietKiem` (đáo hạn / rút trước hạn) và
 * `moLaiSoTietKiem` (gỡ lượt tất toán ghi nhầm).
 *
 * Tách khỏi `so-tiet-kiem.ts` theo ĐÚNG khuôn `tat-toan-thau-chi.ts` tách khỏi `khoan-vay.ts` đang
 * chạy prod: hai action này nặng gấp mấy lần ba action hồ sơ (6 bước có thứ tự bắt buộc, fencing,
 * ba cận ngày, hai vị từ số dư), gộp chung là một file không ai giữ nổi trong đầu.
 *
 * Hai action ở đây là ĐƯỜNG DUY NHẤT `closedAt` được đặt hoặc gỡ.
 *
 * Mọi action PHẢI nằm trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts` — phép quét AST
 * chỉ đọc THÂN HÀM export nên `dangPhucHoi()` gọi trực tiếp tại đây, KHÔNG uỷ quyền.
 */

/** Chỉ nhận một id — dùng cho mở lại. */
const idSchema = z.object({ id: z.string().min(1, "Chọn sổ tiết kiệm") });

/**
 * P2034 = write conflict / deadlock → retry ĐÚNG 1 lần (khuôn `chayGhiKyCoRetry`). Bản sao cục bộ
 * chứ không import chung: `so-tiet-kiem-chung.ts` CỐ Ý không có `export async function` nào (lưới
 * bảo trì quét `src/lib/actions/` fail-closed, mọi export async đều phải khai vào bảng đường ghi) —
 * cùng lý do khiến `khoan-vay.ts` và `tat-toan-thau-chi.ts` mỗi file giữ một bản retry riêng.
 *
 * An toàn khi chạy lại: P2034 nghĩa là transaction ĐÃ rollback trọn — không có dòng nào sót lại.
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

const tatToanSchema = z.object({
  id: z.string().min(1, "Chọn sổ tiết kiệm"),
  /** Tiền đã về tài khoản rồi mới bấm ⇒ schema ghi tay (chặn ngày tương lai) — cận trên của §7.2.1. */
  ngayTatToan: ngayGhiTaySchema,
  /**
   * Chỉ ĐỀ XUẤT ở client (`laiDuKien`); chủ shop sửa theo giấy báo ngân hàng — 0 là HỢP LỆ (rút
   * trước hạn có ngân hàng trả 0đ lãi). Dùng `soTienKySchema` chứ không schema dương.
   */
  lai: soTienKySchema,
});

/**
 * TẤT TOÁN (đáo hạn hoặc rút trước hạn) — MỘT transaction, SÁU bước theo ĐÚNG thứ tự spec §7.2.
 *
 * ⚠️ VÌ SAO ĐÓNG SỔ PHẢI Ở BƯỚC CUỐI CÙNG — đây là chỗ dễ hỏng nhất của cả tính năng.
 * Cổng `kiemSoTietKiemConHieuLuc` (cửa 6, `cash-movements.ts`) TỪ CHỐI mọi dòng tiền trỏ về một sổ
 * đã có `closedAt`. Nếu đóng sổ trước rồi mới ghi `SAVINGS_IN`/`ThuNhap` thì:
 *   - hoặc chính cổng đó chặn câu ghi ⇒ 200 triệu gốc KHÔNG BAO GIỜ về quỹ, và sổ đã đóng nên chủ
 *     shop cũng không ghi tay bù được — TIỀN MẤT DẤU VĨNH VIỄN;
 *   - hoặc câu ghi lọt qua vì đi đường tx thẳng ⇒ app tự cho mình một ngoại lệ ngầm của chính luật
 *     nó bắt chủ shop tuân theo, và lần sau ai đó sửa cổng là hỏng im lặng.
 * Đúng bài học `tatToanKhoanVay` (dòng `DEPOSIT_IN` phải ghi TRƯỚC câu set `closedAt`).
 *
 * Và vì sao câu đóng sổ là `updateMany` kèm `closedAt: null` chứ không phải `update`: đó là FENCING —
 * điều kiện nằm NGAY TRONG câu UPDATE, không phải check-then-act. Hai tab bấm cùng lúc thì chỉ MỘT
 * câu đổi được dòng; câu thua đếm 0 dòng, ném, và Prisma rollback TRỌN transaction của nó ⇒ dòng
 * `SAVINGS_IN` + bản ghi `ThuNhap` mà nó vừa ghi ở bước 3-4 biến mất sạch, không để lại rác.
 */
export async function tatToanSoTietKiem(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = tatToanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { id, lai } = parsed.data;
  const ngay = startOfDay(parsed.data.ngayTatToan);

  try {
    await chayCoRetry(() =>
      prisma.$transaction(async (tx) => {
        // BƯỚC 1 — khoá dòng `SoTietKiem` TRƯỚC KHI ĐỌC. Không có nó, một dòng ghi tay commit ngay
        // sau phép kiểm sẽ để lại sổ "đã tất toán" mà số đang gửi khác 0.
        await khoaSoTietKiem(tx, id);

        // BƯỚC 2 — đọc SAU khi đã giành khoá, rồi kiểm trạng thái + ba cận ngày (§7.2.1).
        const so = await tx.soTietKiem.findUnique({
          where: { id },
          select: { name: true, principal: true, startDate: true, closedAt: true },
        });
        if (!so) throw new LoiHopDong("Không tìm thấy sổ tiết kiệm");
        if (so.closedAt !== null) throw new LoiHopDong("Sổ này đã tất toán");

        // CẬN DƯỚI 1 — ngày gửi. Lùi trước đó là nói tiền về TRƯỚC ngày nó đi ra; ngày quá cũ còn
        // kéo lùi mốc D0 của Sổ quỹ (`ngayMoSo()` = min(date) TOÀN BẢNG `CashMovement`), đổi số mọi
        // tháng chủ shop đã xem. Ô ngày ở client đã khai `min`; đây mới là cổng thật.
        if (ngay < startOfDay(so.startDate)) {
          throw new LoiHopDong(
            `Ngày tất toán phải từ ngày gửi (${format(so.startDate, "dd/MM/yyyy")}) trở đi`,
            "ngayTatToan"
          );
        }

        // CẬN DƯỚI 2 — dòng `SAVINGS_OUT` MUỘN NHẤT. Khác cận 1 ở ca sổ có dòng gửi ghi tay đề ngày
        // sau ngày gửi trên hồ sơ: lùi trước dòng đó là tháng này phồng đúng số tiền, tháng kia hụt.
        const mocGui = await tx.cashMovement.aggregate({
          where: { savingsId: id, kind: "SAVINGS_OUT" },
          _max: { date: true },
        });
        const dongCuoi = mocGui._max.date;
        if (dongCuoi !== null && ngay < startOfDay(dongCuoi)) {
          throw new LoiHopDong(
            `Ngày tất toán phải từ dòng gửi gần nhất (${format(dongCuoi, "dd/MM/yyyy")}) trở đi`,
            "ngayTatToan"
          );
        }
        // CẬN TRÊN — hôm nay: `ngayGhiTaySchema` đã chặn ngày tương lai ở tầng zod.

        // BƯỚC 3 — GỐC về quỹ = phần CÒN ĐANG GỬI, không phải `principal` khai trên sổ.
        //
        // Hai số đó chỉ bằng nhau khi sổ chưa có dòng nhận lại nào. Nhưng cửa 6 CHO PHÉP ghi tay
        // `SAVINGS_IN` (ngân hàng trả gốc làm nhiều đợt là chuyện thật, và chính gợi ý trên form
        // mời chủ shop ghi) — lúc đó `principal` lớn hơn phần còn lại, bước 5 thấy số dư ÂM và
        // chặn. Kết cục: sổ KẸT VĨNH VIỄN — không tất toán được, cũng không xoá được (đã có dòng
        // ghi tay), nên bản ghi lãi không bao giờ sinh và P&L thiếu trọn khoản lãi đó.
        //
        // Ghi `conGui` là số ĐÚNG với thực tế: phần gốc app cần đưa về quỹ là phần ngân hàng chưa
        // trả. Bước 5 vẫn giữ nguyên vai trò — nó bắt ca dòng ghi tay làm số dư ÂM từ trước.
        const conGui = await soDuDangGui(tx, id);
        if (conGui < 0) {
          throw new LoiHopDong(
            `Sổ này đã nhận lại ${formatVnd(-conGui)} nhiều hơn số đã gửi — sửa các dòng ở bảng Khoản tiền khác rồi tất toán lại`
          );
        }
        if (conGui === 0 && lai === 0) {
          throw new LoiHopDong(
            "Sổ này đã nhận lại hết gốc bằng dòng ghi tay và không có lãi — không còn gì để ghi. " +
              "Nhập số lãi nếu ngân hàng có trả, hoặc xoá dòng ghi tay rồi tất toán lại."
          );
        }

        // `conGui === 0` (đã nhận lại hết bằng dòng ghi tay) ⇒ KHÔNG đẻ dòng 0đ, chỉ ghi phần lãi.
        if (conGui > 0) {
          await tx.cashMovement.create({
          data: {
            date: ngay,
            kind: "SAVINGS_IN",
            amount: conGui,
            savingsId: id,
            description: `Nhận lại gốc tiết kiệm ${so.name} — tất toán ${format(ngay, "dd/MM/yyyy")}`,
          },
          });
        }

        // BƯỚC 4 — LÃI, đường riêng. `lai === 0` ⇒ KHÔNG tạo bản ghi nào: không có thu nhập 0đ trong
        // sổ, và một dòng 0đ sẽ trồi lên bảng P&L làm bẩn dòng "Thu nhập tài chính".
        // `refId @unique` là cổng chống ghi lãi 2 lần — P2002 dịch thành "Sổ này đã ghi lãi rồi"
        // (`loiSoTietKiem`), và ném ⇒ rollback trọn cả dòng gốc vừa ghi ở bước 3.
        if (lai > 0) {
          await tx.thuNhap.create({
            data: {
              date: ngay,
              kind: "LAI_TIET_KIEM",
              amount: lai,
              savingsId: id,
              refId: `${REF_LAI_PREFIX}${id}`,
              description: `Lãi sổ tiết kiệm ${so.name} — tất toán ${format(ngay, "dd/MM/yyyy")}`,
            },
          });
        }

        // BƯỚC 5 — vị từ số dư, chạy SAU câu ghi (kiểm trước là check-then-act). Giờ đây bước 3 ghi
        // đúng `conGui` nên số này phải về 0; giữ phép kiểm làm chốt chặn cuối cho ca một lượt ghi
        // tay commit XEN GIỮA (khoá dòng ở bước 1 chặn ca đó, đây là lớp thứ hai).
        await chanSoDuTietKiemAm(tx, id);
        const conLai = await soDuDangGui(tx, id);
        if (conLai !== 0) {
          throw new LoiHopDong(
            `Sổ còn ${formatVnd(conLai)} chưa nhận lại — kiểm các dòng gửi/nhận ở bảng Khoản tiền khác rồi tất toán lại`
          );
        }

        // BƯỚC 6 — ĐÓNG SỔ, BƯỚC CUỐI CÙNG (lý do ở khối chú thích trên hàm). Fencing: điều kiện
        // `closedAt: null` nằm TRONG câu UPDATE.
        const dong = await tx.soTietKiem.updateMany({
          where: { id, closedAt: null },
          data: { closedAt: ngay },
        });
        if (dong.count === 0) throw new LoiHopDong("Sổ này đã tất toán");
      }, OPT_TX)
    );

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    return { ok: false, ...loiSoTietKiem(e, "Lỗi khi tất toán sổ tiết kiệm") };
  }
}

/**
 * MỞ LẠI sổ đã tất toán — đường DUY NHẤT xoá `closedAt`. Tất toán nhầm mà không mở lại được thì chủ
 * shop phải tạo sổ mới, lịch sử tách đôi và quỹ đếm hai lần số gốc.
 *
 * Chỉ gỡ ĐÚNG các dòng DO APP SINH, nhận diện bằng hai dấu (§7.3):
 *   - `ThuNhap` theo `refId = TIETKIEM:{id}` — dấu này app tự đóng, chủ shop không gõ được;
 *   - dòng `SAVINGS_IN` DUY NHẤT của sổ.
 * Sổ có nhiều hơn một dòng `SAVINGS_IN` (chủ shop ghi tay thêm) ⇒ TỪ CHỐI, chỉ đường xoá tay trước.
 * App KHÔNG đoán xoá dòng nào: đoán sai là xoá một dòng tiền THẬT.
 *
 * ⚠️ THỨ TỰ NGƯỢC với tất toán, và đó là CỐ Ý: ở đây MỞ SỔ TRƯỚC rồi mới xoá. Cùng một lý do —
 * cổng `kiemSoTietKiemConHieuLuc` chặn mọi thao tác dòng tiền trên sổ đã đóng, nên mở trước thì mọi
 * câu xoá phía sau đều nằm trên một sổ hợp lệ. Cả cụm trong MỘT transaction nên câu nào ném cũng
 * rollback trọn: không có ca "sổ mở lại rồi mà lãi vẫn nằm trong P&L".
 */
export async function moLaiSoTietKiem(input: unknown): Promise<ActionResult<{ id: string }>> {
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
        if (so.closedAt === null) throw new LoiHopDong("Sổ này đang gửi — không cần mở lại");

        const soDongNhan = await tx.cashMovement.count({
          where: { savingsId: id, kind: "SAVINGS_IN" },
        });
        if (soDongNhan > 1) {
          throw new LoiHopDong(
            "Sổ này có nhiều hơn một dòng nhận lại gốc — xoá dòng ghi tay ở bảng Khoản tiền khác " +
              "(tab Dòng tiền) trước, rồi mở lại sổ"
          );
        }

        // FENCING: điều kiện `closedAt` khác null nằm TRONG câu UPDATE. Hai tab cùng bấm Mở lại thì
        // chỉ MỘT câu đổi được dòng; câu thua ném và rollback trước khi kịp xoá gì.
        const dong = await tx.soTietKiem.updateMany({
          where: { id, closedAt: { not: null } },
          data: { closedAt: null },
        });
        if (dong.count === 0) throw new LoiHopDong("Sổ này đang gửi — không cần mở lại");

        await tx.thuNhap.deleteMany({ where: { refId: `${REF_LAI_PREFIX}${id}` } });
        await tx.cashMovement.deleteMany({ where: { savingsId: id, kind: "SAVINGS_IN" } });

        // Sau khi gỡ dòng nhận lại, số đang gửi quay về đúng Σ đã gửi — vẫn kiểm cho nhất quán luật
        // "vị từ chạy SAU MỌI lượt ghi" (§8): sổ có dòng ghi tay lệch phải chặn ngay tại đây.
        await chanSoDuTietKiemAm(tx, id);
      }, OPT_TX)
    );

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    return { ok: false, ...loiSoTietKiem(e, "Lỗi khi mở lại sổ tiết kiệm") };
  }
}
