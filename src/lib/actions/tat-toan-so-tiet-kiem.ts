"use server";

import { format, startOfDay } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong, maLoiNhatKy, soTienKySchema } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { ngayGhiTaySchema } from "@/lib/actions/ngay-ghi-tay-schema";
import { cauTatToanTruocM } from "@/lib/actions/khoan-vay-chung";
import { loiSoTietKiem, REF_LAI_PREFIX } from "@/lib/actions/so-tiet-kiem-chung";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { formatVnd } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { chanDongTienTruocM } from "@/lib/no-phai-tra/chan-dong-tien-truoc-m";
import { khoaChiaSeBatNoPhaiTra } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { congAction } from "@/lib/quyen/cong-action";
import { laXungDotGhi } from "@/lib/prisma-loi-adapter";
import { OPT_TX_DONG_TIEN } from "@/lib/so-quy/khoa-dong-tien-co-han";
import {
  laMoTaMauNhanGocTatToan,
  LOI_SO_TAT_TOAN_TRUOC_BAN_VA,
  moTaNhanGocTatToan,
} from "@/lib/tiet-kiem/dong-nhan-goc-tat-toan";
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
 * ĐÃ BẬT NỢ PHẢI TRẢ (mốc M): tất toán đề ngày < M, hay mở lại sổ có dòng nhận gốc / lãi ngày < M, bị từ chối
 * qua cổng `chanDongTienTruocM` (tiền ngày < M đã chốt vào điều chỉnh mở sổ). Thứ tự khoá:
 * `khoaChiaSeBatNoPhaiTra(tx)` câu ĐẦU → `khoaSoTietKiem` → đọc M + bản ghi cũ.
 *
 * Mọi action PHẢI nằm trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts` — phép quét AST
 * chỉ đọc THÂN HÀM export nên `dangPhucHoi()` gọi trực tiếp tại đây, KHÔNG uỷ quyền.
 */

/** Chỉ nhận một id — dùng cho mở lại. */
const idSchema = z.object({ id: z.string().min(1, "Chọn sổ tiết kiệm") });

/**
 * Xung đột ghi (`laXungDotGhi`: P2034, 40001/40P01 cả lúc COMMIT) → retry ĐÚNG 1 lần
 * (khuôn `chayGhiKyCoRetry`). Bản sao cục bộ
 * chứ không import chung: `so-tiet-kiem-chung.ts` CỐ Ý không có `export async function` nào (lưới
 * bảo trì quét `src/lib/actions/` fail-closed, mọi export async đều phải khai vào bảng đường ghi) —
 * cùng lý do khiến `khoan-vay.ts` và `tat-toan-thau-chi.ts` mỗi file giữ một bản retry riêng.
 *
 * An toàn khi chạy lại: xung đột ghi nghĩa là transaction ĐÃ rollback trọn — không có dòng nào sót lại.
 */
async function chayCoRetry<T>(chay: () => Promise<T>): Promise<T> {
  try {
    return await chay();
  } catch (e) {
    if (laXungDotGhi(e)) {
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
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = tatToanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { id, lai } = parsed.data;
  const ngay = startOfDay(parsed.data.ngayTatToan);

  try {
    await chayCoRetry(() =>
      prisma.$transaction(async (tx) => {
        // BƯỚC 0 — khoá chung với bước bật nợ phải trả (câu ĐẦU): cổng ngày < M bên dưới cần M mới nhất.
        await khoaChiaSeBatNoPhaiTra(tx);
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

        // CẬN DƯỚI 3 — mốc bật nợ phải trả M: `SAVINGS_IN` + `ThuNhap` lãi đều đề `ngay` ⇒ `ngay` < M bị từ chối.
        await chanDongTienTruocM(
          tx,
          { loai: "TAO", ngay: [ngay] },
          { cau: cauTatToanTruocM, field: "ngayTatToan" }
        );

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

        // `conGui === 0` (đã nhận lại hết bằng dòng ghi tay) ⇒ KHÔNG đẻ dòng 0đ, chỉ ghi phần lãi — sổ
        // không trỏ dòng nào (`dongNhanGoc` NULL) nên Mở lại sau này không đụng dòng tay.
        // Id dòng vừa sinh được ghi lên sổ ở BƯỚC 6, cùng câu đóng sổ: đó là dấu DUY NHẤT Mở lại dùng để xoá.
        let dongNhanGoc: string | null = null;
        if (conGui > 0) {
          const nhan = await tx.cashMovement.create({
            data: {
              date: ngay,
              kind: "SAVINGS_IN",
              amount: conGui,
              savingsId: id,
              description: moTaNhanGocTatToan(so.name, ngay),
            },
            select: { id: true },
          });
          dongNhanGoc = nhan.id;
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

        // Nhật ký OK đứng NGAY TRƯỚC câu đóng sổ, KHÔNG sau: `closedAt` phải là câu CUỐI CÙNG của
        // transaction tất toán (bất biến CLAUDE.md). Nhật ký ném ⇒ gốc, lãi rollback, sổ vẫn mở;
        // câu đóng thua fencing ⇒ dòng nhật ký rollback theo.
        await ghiNhatKy(tx, {
          actor: nguoiDung,
          hanhDong: "TIET_KIEM_TAT_TOAN",
          doiTuong: { loai: "SoTietKiem", id },
          ghiChu: { ky: format(ngay, "yyyy-MM-dd") },
        });

        // BƯỚC 6 — ĐÓNG SỔ, BƯỚC CUỐI CÙNG (lý do ở khối chú thích trên hàm). Fencing: điều kiện
        // `closedAt: null` nằm TRONG câu UPDATE. Id dòng nhận gốc ghi CÙNG câu để `closedAt` vẫn là câu cuối.
        const dong = await tx.soTietKiem.updateMany({
          where: { id, closedAt: null },
          data: { closedAt: ngay, dongNhanGocTatToanId: dongNhanGoc },
        });
        if (dong.count === 0) throw new LoiHopDong("Sổ này đã tất toán");
      }, OPT_TX_DONG_TIEN)
    );

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    await ghiNhatKyLoi({
      actor: nguoiDung,
      hanhDong: "TIET_KIEM_TAT_TOAN",
      doiTuong: { loai: "SoTietKiem", id },
      ghiChu: { lyDo: maLoiNhatKy(e) },
    });
    return { ok: false, ...loiSoTietKiem(e, "Lỗi khi tất toán sổ tiết kiệm") };
  }
}

/**
 * MỞ LẠI sổ đã tất toán — đường DUY NHẤT xoá `closedAt`. Tất toán nhầm mà không mở lại được thì chủ
 * shop phải tạo sổ mới, lịch sử tách đôi và quỹ đếm hai lần số gốc.
 *
 * Chỉ gỡ ĐÚNG các dòng DO APP SINH, nhận diện bằng hai dấu app tự đóng, chủ shop không gõ được:
 *   - `ThuNhap` theo `refId = TIETKIEM:{id}`;
 *   - dòng `CashMovement` có id = `SoTietKiem.dongNhanGocTatToanId` (lượt tất toán ghi; NULL khi lượt đó chỉ
 *     ghi lãi vì gốc đã nhận hết bằng dòng tay).
 * Dòng `SAVINGS_IN` ghi tay giữ NGUYÊN, bao nhiêu dòng cũng được. KHÔNG nhận diện bằng số lượng hay mô tả:
 * đếm "đúng một dòng nhận" từng xoá mất dòng tay 100tr của sổ tất toán chỉ-lãi. Sổ tất toán trước khi có
 * cột mà còn dòng mang mẫu mô tả app sinh ⇒ TỪ CHỐI (`LOI_SO_TAT_TOAN_TRUOC_BAN_VA`) tới khi gán dấu.
 *
 * ⚠️ THỨ TỰ NGƯỢC với tất toán, và đó là CỐ Ý: ở đây MỞ SỔ TRƯỚC rồi mới xoá. Cùng một lý do —
 * cổng `kiemSoTietKiemConHieuLuc` chặn mọi thao tác dòng tiền trên sổ đã đóng, nên mở trước thì mọi
 * câu xoá phía sau đều nằm trên một sổ hợp lệ. Cả cụm trong MỘT transaction nên câu nào ném cũng
 * rollback trọn: không có ca "sổ mở lại rồi mà lãi vẫn nằm trong P&L".
 */
export async function moLaiSoTietKiem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { id } = parsed.data;

  try {
    await chayCoRetry(() =>
      prisma.$transaction(async (tx) => {
        await khoaChiaSeBatNoPhaiTra(tx);
        await khoaSoTietKiem(tx, id);
        const so = await tx.soTietKiem.findUnique({
          where: { id },
          select: { closedAt: true, dongNhanGocTatToanId: true },
        });
        if (!so) throw new LoiHopDong("Không tìm thấy sổ tiết kiệm");
        if (so.closedAt === null) throw new LoiHopDong("Sổ này đang gửi — không cần mở lại");

        // Dòng nhận gốc SẼ XOÁ = đúng dòng sổ đang trỏ (do lượt tất toán ghi), và chỉ khi nó còn là dòng
        // SAVINGS_IN của chính sổ này. Không trỏ dòng nào ⇒ không xoá dòng tiền nào: mọi dòng nhận còn lại
        // là dòng GHI TAY (ngân hàng đã trả gốc), xoá là quỹ mất dấu tiền thật.
        let dongNhanXoa: { id: string; date: Date } | null = null;
        if (so.dongNhanGocTatToanId !== null) {
          dongNhanXoa = await tx.cashMovement.findFirst({
            where: { id: so.dongNhanGocTatToanId, savingsId: id, kind: "SAVINGS_IN" },
            select: { id: true, date: true },
          });
        } else {
          // Sổ tất toán TRƯỚC khi có cột trỏ dòng: còn dòng mang mẫu mô tả app sinh thì KHÔNG đoán (đoán sai
          // là xoá dòng tay) — từ chối tới khi chủ shop duyệt và gán dấu bằng script. Mô tả ở đây chỉ dùng để
          // TỪ CHỐI, không bao giờ để chọn dòng xoá.
          const cacDongNhan = await tx.cashMovement.findMany({
            where: { savingsId: id, kind: "SAVINGS_IN" },
            select: { description: true },
          });
          if (cacDongNhan.some((d) => laMoTaMauNhanGocTatToan(d.description))) {
            throw new LoiHopDong(LOI_SO_TAT_TOAN_TRUOC_BAN_VA);
          }
        }

        // Đã bật nợ phải trả: mở lại = xoá dòng nhận gốc + lãi của lượt tất toán ⇒ dòng nào ngày < M thì từ chối.
        // Đọc ĐÚNG các dòng sắp xoá (cùng điều kiện hai câu xoá bên dưới), sau khoá.
        const dongLai = await tx.thuNhap.findMany({
          where: { refId: `${REF_LAI_PREFIX}${id}` },
          select: { date: true },
        });
        await chanDongTienTruocM(tx, {
          loai: "XOA",
          ngay: [...(dongNhanXoa ? [dongNhanXoa.date] : []), ...dongLai.map((t) => t.date)],
        });

        // FENCING: điều kiện `closedAt` khác null nằm TRONG câu UPDATE. Hai tab cùng bấm Mở lại thì
        // chỉ MỘT câu đổi được dòng; câu thua ném và rollback trước khi kịp xoá gì. Gỡ dấu cùng câu:
        // sổ đang gửi không bao giờ trỏ dòng nhận.
        const dong = await tx.soTietKiem.updateMany({
          where: { id, closedAt: { not: null } },
          data: { closedAt: null, dongNhanGocTatToanId: null },
        });
        if (dong.count === 0) throw new LoiHopDong("Sổ này đang gửi — không cần mở lại");

        await tx.thuNhap.deleteMany({ where: { refId: `${REF_LAI_PREFIX}${id}` } });
        if (dongNhanXoa) {
          await tx.cashMovement.deleteMany({
            where: { id: dongNhanXoa.id, savingsId: id, kind: "SAVINGS_IN" },
          });
        }

        // Sau khi gỡ dòng nhận lại, số đang gửi quay về đúng Σ đã gửi — vẫn kiểm cho nhất quán luật
        // "vị từ chạy SAU MỌI lượt ghi" (§8): sổ có dòng ghi tay lệch phải chặn ngay tại đây.
        await chanSoDuTietKiemAm(tx, id);
        await ghiNhatKy(tx, { actor: nguoiDung, hanhDong: "TIET_KIEM_MO_LAI", doiTuong: { loai: "SoTietKiem", id } });
      }, OPT_TX_DONG_TIEN)
    );

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    await ghiNhatKyLoi({
      actor: nguoiDung,
      hanhDong: "TIET_KIEM_MO_LAI",
      doiTuong: { loai: "SoTietKiem", id },
      ghiChu: { lyDo: maLoiNhatKy(e) },
    });
    return { ok: false, ...loiSoTietKiem(e, "Lỗi khi mở lại sổ tiết kiệm") };
  }
}
