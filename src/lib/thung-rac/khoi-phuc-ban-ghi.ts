import type { Prisma } from "@/generated/prisma/client";

import { laLoiTrungDongDinhKyThang } from "@/lib/expenses/khoa-thang-dinh-ky";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import {
  laLoiDongTienBan,
  OPT_TX_DONG_TIEN,
  THONG_BAO_KHOA_DONG_TIEN_BAN,
} from "@/lib/so-quy/khoa-dong-tien-co-han";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import {
  chanDuNoAm,
  chanTienGuiAm,
  khoaCacKhoanVay,
  LoiDuNoAm,
  LoiTienGuiAm,
} from "@/lib/so-quy/vi-tu-du-no";
import {
  chanSoDuTietKiemAm,
  khoaCacSoTietKiem,
  LoiSoDuTietKiemAm,
} from "@/lib/tiet-kiem/vi-tu-so-tiet-kiem";
import type { AnhBanGhi, BangThungRac } from "@/lib/thung-rac/chup-anh-ban-ghi";
import {
  chaCanKhoa,
  doTinhTrang,
  tachAnh,
  type BanGhiCanDung,
} from "@/lib/thung-rac/do-tinh-trang-khoi-phuc";
import {
  CAU_SO_DU_AM,
  CAU_THANG_DA_CO_DINH_KY,
  lyDoKhongKhoiPhuc,
} from "@/lib/thung-rac/ly-do-khong-khoi-phuc";
import { kiemQuyenBang } from "@/lib/thung-rac/quyen-thung-rac";

/**
 * Khôi phục một mục trong thùng rác: dựng lại bản ghi (và cả CỤM con của nó) với ĐÚNG id cũ.
 *
 * Giữ id cũ chứ không sinh id mới vì đây là "hoàn tác một lượt xoá nhầm", không phải "tạo bản ghi
 * giống hệt": `Expense.refId`/`ThuNhap.refId` và mọi liên kết `loanId`/`savingsId` của cụm đều neo
 * theo id đó — sinh id mới là dựng lại một cụm gãy.
 *
 * ĐÂY LÀ MỘT ĐƯỜNG GHI TIỀN, nên nó chạy ĐÚNG khuôn của 5 đường ghi `CashMovement` còn lại
 * (`cash-movements.ts` · `ghiKyTraNo` · tất toán): khoá `Loan` rồi `SoTietKiem` (`FOR UPDATE`, THỨ
 * TỰ CỐ ĐỊNH TOÀN APP — đảo là hai lượt giữ chéo nhau rồi Postgres huỷ một bên) → kiểm cổng TRƯỚC
 * câu ghi → ghi → `chanDuNoAm`/`chanTienGuiAm`/`chanSoDuTietKiemAm` SAU câu ghi. Bỏ một khâu là
 * khôi phục thành cái cửa DUY NHẤT đẩy được dư nợ xuống âm hoặc nhét tiền vào khoản đã tất toán.
 *
 * MỌI phép kiểm chạy TRƯỚC câu ghi đầu tiên và nằm TRONG cùng transaction: ghi nửa cụm rồi mới phát
 * hiện khoá ngoại hỏng là để lại một khoản vay không dòng tiền, tệ hơn hẳn việc không khôi phục.
 *
 * THỨ TỰ GHI: CHA trước, CON sau — `CashMovement.loanId`/`savingsId` và `ThuNhap.savingsId` đều là
 * FK `Restrict`, ghi con trước là Postgres từ chối cả transaction.
 *
 * QUYỀN + NHẬT KÝ nằm TRONG CÙNG transaction này (spec phân quyền §1.4, §5): quyền kiểm theo `bang`
 * đọc từ DB (không tin client) TRƯỚC con dấu CAS; dòng nhật ký là câu CUỐI — nhật ký ném ⇒ cụm dựng
 * lại + con dấu rollback trọn. Người gọi KHÔNG được bọc thêm transaction ngoài: transaction trong sẽ
 * chờ khoá dòng mà transaction ngoài đang giữ ⇒ treo tới timeout.
 */

export type KetQuaKhoiPhuc =
  /** `canhBao` = việc app CỐ Ý không làm trong lượt khôi phục và chủ shop cần biết (null = không có). */
  | { ok: true; canhBao: string | null }
  | { ok: false; lyDo: string };

/**
 * Mọi lượt TỪ CHỐI ném lớp này chứ không `return` từ trong callback transaction: `return` là COMMIT
 * — nên một lượt từ chối xảy ra SAU câu ghi đầu tiên (con dấu nguyên tử ở cuối) sẽ commit đúng cái
 * mớ dở dang mà nó vừa từ chối. Ném ⇒ Prisma rollback trọn, và tầng ngoài dịch lại thành `lyDo`.
 */
class LoiKhongKhoiPhuc extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoiKhongKhoiPhuc";
  }
}

async function taoLai(tx: Prisma.TransactionClient, { bang, data }: BanGhiCanDung): Promise<void> {
  switch (bang) {
    case "Expense":
      await tx.expense.create({ data: data as unknown as Prisma.ExpenseUncheckedCreateInput });
      return;
    case "CashMovement":
      await tx.cashMovement.create({
        data: data as unknown as Prisma.CashMovementUncheckedCreateInput,
      });
      return;
    case "ThuNhap":
      await tx.thuNhap.create({ data: data as unknown as Prisma.ThuNhapUncheckedCreateInput });
      return;
    case "Loan":
      await tx.loan.create({ data: data as unknown as Prisma.LoanUncheckedCreateInput });
      return;
    case "SoTietKiem":
      await tx.soTietKiem.create({ data: data as unknown as Prisma.SoTietKiemUncheckedCreateInput });
      return;
  }
}

/**
 * Nối lại liên kết sổ tiết kiệm ↔ khoản vay mà FK `SetNull` đã xoá trắng lúc xoá `Loan`.
 *
 * `where` CÓ ĐIỀU KIỆN `loanId: null`: trong lúc khoản vay nằm thùng rác, chủ shop hoàn toàn có thể
 * đã trỏ sổ đó sang một khoản vay KHÁC (form ở `so-tiet-kiem.ts` cho phép). Ghi đè vô điều kiện là
 * nuốt IM LẶNG lựa chọn mới đó — liên kết này chỉ để SO lãi suất, không mang đồng nào, không đáng
 * đổi lấy một lượt sửa bị xoá.
 *
 * Sổ bị bỏ qua thì NÓI RA: im lặng bỏ qua cũng là một kiểu nói sai, chỉ nhẹ hơn ghi đè. Sổ đã bị xoá
 * hẳn trong lúc chờ thì không còn dòng nào để đếm — đúng ý, không có gì để báo.
 */
async function noiLaiSoTietKiem(
  tx: Prisma.TransactionClient,
  bang: BangThungRac,
  loanId: string,
  soTietKiemIds: string[]
): Promise<string | null> {
  if (bang !== "Loan" || soTietKiemIds.length === 0) return null;

  await tx.soTietKiem.updateMany({
    where: { id: { in: soTietKiemIds }, loanId: null },
    data: { loanId },
  });

  const boQua = await tx.soTietKiem.findMany({
    where: { id: { in: soTietKiemIds }, loanId: { not: loanId } },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  if (boQua.length === 0) return null;

  const ten = boQua.map((s) => s.name).join(", ");
  return `Không nối lại được ${boQua.length} sổ tiết kiệm (${ten}) — sổ đó nay đang trỏ sang khoản vay khác`;
}

/**
 * Thiếu quyền của loại bản ghi ⇒ NÉM `LoiThieuQuyenThungRac` ra ngoài (không dịch thành `lyDo`):
 * tầng action cần phân biệt để ghi nhật ký `TU_CHOI_QUYEN` + trả `code: "KHONG_CO_QUYEN"`.
 */
export async function khoiPhucBanGhiDaXoa(id: string, actor: NguoiDung): Promise<KetQuaKhoiPhuc> {
  try {
    const canhBao = await prisma.$transaction(async (tx) => {
      const dong = await tx.banGhiDaXoa.findUnique({ where: { id } });
      if (!dong) throw new LoiKhongKhoiPhuc("Không tìm thấy mục trong thùng rác");

      // Quyền theo LOẠI bản ghi vừa đọc — TRƯỚC con dấu CAS và mọi câu ghi.
      kiemQuyenBang(actor, dong.bang, dong.anh);

      // CON DẤU "đã khôi phục", đóng NGAY và bằng CHÍNH câu UPDATE có điều kiện (`khoiPhucLuc:
      // null`) rồi xét `count` — không đọc trước rồi mới ghi. Check-then-act không đóng được race;
      // điểm nguyên tử duy nhất là chính câu CAS (khuôn con dấu `lastDueHandled` của đường kỳ trả
      // nợ). Hai tab bấm cùng lúc: tab hai CHỜ khoá dòng này tới khi tab một commit, đọc lại thấy
      // `count = 0`, và nhận ĐÚNG câu "Mục này đã được khôi phục" thay vì một lỗi trùng khoá chính.
      //
      // Đóng dấu TRƯỚC khi ghi là an toàn vì mọi lượt từ chối bên dưới đều NÉM (rollback trọn, con
      // dấu tan theo) chứ không `return`. Giữ dòng lại làm nhật ký thay vì xoá: chủ shop cần đọc
      // được mục này từng bị xoá lúc nào và đã lấy về lúc nào.
      const dau = await tx.banGhiDaXoa.updateMany({
        where: { id, khoiPhucLuc: null },
        data: { khoiPhucLuc: new Date() },
      });
      if (dau.count === 0) throw new LoiKhongKhoiPhuc("Mục này đã được khôi phục");

      const anh = dong.anh as unknown as AnhBanGhi;
      const bang = dong.bang as BangThungRac;
      const canDung = tachAnh(bang, anh);
      const { loanIds, savingsIds } = chaCanKhoa(canDung);

      // KHOÁ TRƯỚC MỌI THỨ, `Loan` rồi `SoTietKiem`: vị từ dư nợ / tiền gửi / số đang gửi đều cộng
      // lại từ bảng dòng tiền, mà ReadCommitted không thấy dòng chưa commit của lượt song song. Không
      // khoá thì hai lượt cùng đọc một cái tổng cũ rồi cùng ghi (xem `vi-tu-du-no.ts`).
      await khoaCacKhoanVay(tx, loanIds);
      await khoaCacSoTietKiem(tx, savingsIds);

      // `daKhoiPhuc = false`: câu CAS ở trên vừa CHỨNG MINH cột đó đang null, không phải đoán.
      const tinhTrang = await doTinhTrang(tx, false, canDung);
      const lyDo = lyDoKhongKhoiPhuc(tinhTrang);
      if (lyDo !== null) throw new LoiKhongKhoiPhuc(lyDo);

      for (const banGhi of canDung) await taoLai(tx, banGhi);

      const canhBao = await noiLaiSoTietKiem(tx, bang, dong.banGhiId, anh.ghiChu.soTietKiemIds ?? []);

      // HẬU KIỂM SAU CÂU GHI — phép dò trước ở `doTinhTrang` là để cột "Trạng thái" nói thật, còn
      // đây mới là cổng: nó đọc số dư THẬT sau khi cả cụm đã nằm trong DB, nên bắt được cả ca dò
      // trước bỏ sót (loại `kind` mới chưa khai dấu) lẫn ca hai tab bấm cùng lúc.
      for (const loanId of loanIds) {
        await chanDuNoAm(tx, loanId);
        await chanTienGuiAm(tx, loanId);
      }
      for (const savingsId of savingsIds) await chanSoDuTietKiemAm(tx, savingsId);

      // Câu CUỐI của transaction: mọi cổng đã qua ⇒ chỉ lượt khôi phục thật có dấu vết.
      await ghiNhatKy(tx, {
        actor,
        hanhDong: "THUNG_RAC_KHOI_PHUC",
        doiTuong: { loai: dong.bang, id: dong.banGhiId },
        ghiChu: { loaiBanGhi: dong.bang },
      });

      return canhBao;
    }, OPT_TX_DONG_TIEN);

    return { ok: true, canhBao };
  } catch (e) {
    if (e instanceof LoiKhongKhoiPhuc) return { ok: false, lyDo: e.message };
    // Chờ khoá khoản vay / sổ tiết kiệm quá hạn, hoặc transaction quá hạn (P2028) — đã lùi (con dấu "đã
    // khôi phục" tan theo).
    if (laLoiDongTienBan(e)) return { ok: false, lyDo: THONG_BAO_KHOA_DONG_TIEN_BAN };
    // Ba vị từ hậu kiểm ném câu gốc kiểu "kiểm lại số tiền hoặc khoản vay" — đúng cho form nhập tay,
    // sai ở đây (chủ shop có nhập số nào đâu, họ bấm Khôi phục). Dịch sang ĐÚNG ba câu mà cột "Trạng
    // thái" đang dùng, để một sự cố không được kể thành hai chuyện khác nhau.
    if (e instanceof LoiDuNoAm) return { ok: false, lyDo: CAU_SO_DU_AM.duNo };
    if (e instanceof LoiTienGuiAm) return { ok: false, lyDo: CAU_SO_DU_AM.tienGui };
    if (e instanceof LoiSoDuTietKiemAm) return { ok: false, lyDo: CAU_SO_DU_AM.soDuTietKiem };
    // Phép dò `thangDaCoDinhKy` chạy TRƯỚC câu ghi (ReadCommitted): bộ sinh định kỳ của một lượt
    // render song song vẫn chen được dòng thay thế vào giữa. UNIQUE `(recurringId, recurringMonth)`
    // là cổng cuối — cả transaction rollback (con dấu "đã khôi phục" tan theo), trả đúng câu dò trước.
    if (laLoiTrungDongDinhKyThang(e)) return { ok: false, lyDo: CAU_THANG_DA_CO_DINH_KY };
    throw e;
  }
}
