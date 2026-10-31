"use server";

import { startOfDay } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong, maLoiNhatKy } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { cauGuiTruocM, loiSoTietKiem, soTietKiemSchema } from "@/lib/actions/so-tiet-kiem-chung";
import { vaoCuaGhi } from "@/lib/backup/cong-ghi-toan-cuc";
import { prisma } from "@/lib/prisma";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { chanDongTienTruocM } from "@/lib/no-phai-tra/chan-dong-tien-truoc-m";
import { khoaChiaSeBatNoPhaiTra } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { congAction } from "@/lib/quyen/cong-action";
import { laXungDotGhi } from "@/lib/prisma-loi-adapter";
import { OPT_TX_DONG_TIEN } from "@/lib/so-quy/khoa-dong-tien-co-han";
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
 * AST chỉ đọc THÂN HÀM export nên `vaoCuaGhi()` phải gọi trực tiếp ở đây, KHÔNG uỷ quyền.
 *
 * ĐÃ BẬT NỢ PHẢI TRẢ (mốc M): dòng gửi/nhận ngày < M đã chốt vào điều chỉnh mở sổ ⇒ tạo / dời / đổi số tiền /
 * xoá dòng tiền ngày < M bị từ chối qua MỘT cổng `chanDongTienTruocM`. Thứ tự khoá mọi transaction:
 * `khoaChiaSeBatNoPhaiTra(tx)` câu ĐẦU → `khoaSoTietKiem` → đọc M + bản ghi cũ. Bước bật không khoá dòng
 * `SoTietKiem` nên không có chu trình chờ.
 *
 * Isolation để MẶC ĐỊNH (ReadCommitted). TUYỆT ĐỐI KHÔNG Serializable — đo thật 08/09 ở đường khoản
 * vay: Serializable đóng băng snapshot tại câu đầu nên sau khi giành được khoá dòng, vị từ số dư VẪN
 * đọc theo ảnh cũ và thành ra mù. Chỗ dựa đúng là khoá dòng `SoTietKiem` + điều kiện nằm TRONG câu
 * UPDATE — cả hai không phụ thuộc isolation.
 */

/**
 * Xung đột ghi (`laXungDotGhi`: P2034, 40001/40P01 cả lúc COMMIT) → retry ĐÚNG 1 lần
 * (khuôn `chayGhiKyCoRetry`). Cần vì mọi
 * transaction ở đây đều giành khoá dòng `SoTietKiem`, mà khoá dòng vẫn deadlock được khi chạy chồng
 * một lượt ghi tay cũng chạm sổ đó.
 *
 * An toàn khi chạy lại: xung đột ghi nghĩa là transaction ĐÃ rollback trọn — không có dòng nào sót lại để
 * lượt thứ hai ghi đè lên.
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

/** Chỉ nhận một id — dùng cho sửa / xoá. */
const idSchema = z.object({ id: z.string().min(1, "Chọn sổ tiết kiệm") });

/**
 * Tạo sổ = hồ sơ + ĐÚNG MỘT dòng `SAVINGS_OUT`, trong MỘT transaction (spec §7.1). Không có gửi thêm
 * vào sổ đang có (spec §2) nên dòng gửi là duy nhất và bằng đúng `principal`.
 *
 * KHÔNG gọi `khoaSoTietKiem` ở đây, khác 4 action còn lại: dòng `SoTietKiem` chưa tồn tại lúc vào
 * transaction nên không có gì để khoá, và `create` tự giữ khoá dòng nó vừa sinh tới lúc commit. Khoá chung
 * với bước bật thì VẪN phải có: không có nó, lượt tạo đọc M = null giữa lúc bước bật chưa commit rồi ghi dòng
 * gửi < M sau lưng nó.
 */
export async function taoSoTietKiem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  const cua = vaoCuaGhi();
  if (!cua.ok) return cua.loi;
  try {
    const parsed = soTietKiemSchema.safeParse(input);
    if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
    const d = parsed.data;

    try {
      const id = await chayCoRetry(() =>
        prisma.$transaction(async (tx) => {
          await khoaChiaSeBatNoPhaiTra(tx);
          await chanDongTienTruocM(
            tx,
            { loai: "TAO", ngay: [d.startDate] },
            { cau: cauGuiTruocM, field: "startDate" }
          );
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
          await ghiNhatKy(tx, { actor: nguoiDung, hanhDong: "TIET_KIEM_TAO", doiTuong: { loai: "SoTietKiem", id: so.id } });
          return so.id;
        }, OPT_TX_DONG_TIEN)
      );

      lamMoiTrang();
      return { ok: true, data: { id } };
    } catch (e) {
      return { ok: false, ...loiSoTietKiem(e, "Lỗi khi ghi sổ tiết kiệm") };
    }
  } finally {
    cua.ra();
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
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  const cua = vaoCuaGhi();
  if (!cua.ok) return cua.loi;
  try {
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
          await khoaChiaSeBatNoPhaiTra(tx);
          await khoaSoTietKiem(tx, id);
          const so = await tx.soTietKiem.findUnique({
            where: { id },
            select: { closedAt: true, principal: true, startDate: true },
          });
          if (!so) throw new LoiHopDong("Không tìm thấy sổ tiết kiệm");
          if (so.closedAt !== null) {
            throw new LoiHopDong("Sổ đã tất toán — mở lại trước khi sửa");
          }

          const doiNenTang =
            d.principal !== so.principal ||
            d.startDate.getTime() !== startOfDay(so.startDate).getTime();

          // Dòng gửi đọc SAU khoá (cả phần tiền lẫn khoá cha) — cổng trước mốc xét đúng bản sắp bị sửa.
          const dongGui = doiNenTang
            ? await tx.cashMovement.findMany({
                where: { savingsId: id, kind: "SAVINGS_OUT" },
                select: {
                  id: true,
                  date: true,
                  amount: true,
                  kind: true,
                  loanId: true,
                  savingsId: true,
                  cardId: true,
                  phieuNhapId: true,
                  viAdsId: true,
                },
                orderBy: { date: "asc" },
              })
            : [];
          // Bất biến "1 sổ = 1 dòng gửi" (§7.1). Sổ lỡ có nhiều dòng thì app KHÔNG đoán sửa dòng
          // nào — ném ⇒ rollback trọn.
          if (dongGui.length > 1) {
            throw new LoiHopDong(
              "Sổ này có nhiều hơn một dòng gửi — xoá dòng ghi tay ở bảng Khoản tiền khác " +
                "(tab Dòng tiền) trước, rồi sửa số tiền / ngày gửi"
            );
          }
          const moiGui = { amount: d.principal, date: d.startDate };
          if (doiNenTang) {
            // Đã bật nợ phải trả: không đổi số tiền / ngày của dòng gửi < M, không dời dòng gửi về trước M. Sửa
            // dòng có sẵn dùng câu chung (nói rõ "chỉ sửa được mô tả"); dựng lại dòng đã mất dùng câu của lượt tạo.
            if (dongGui.length === 1) {
              await chanDongTienTruocM(
                tx,
                { loai: "SUA", cu: dongGui[0], moi: { ...dongGui[0], ...moiGui } },
                { field: "startDate" }
              );
            } else {
              await chanDongTienTruocM(
                tx,
                { loai: "TAO", ngay: [moiGui.date] },
                { cau: cauGuiTruocM, field: "startDate" }
              );
            }
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

          if (doiNenTang) {
            const data = moiGui;
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
          // Câu CUỐI, cùng transaction giữ khoá dòng `SoTietKiem`: nhật ký ném ⇒ bản sửa rollback.
          await ghiNhatKy(tx, { actor: nguoiDung, hanhDong: "TIET_KIEM_SUA", doiTuong: { loai: "SoTietKiem", id } });
        }, OPT_TX_DONG_TIEN)
      );

      lamMoiTrang();
      return { ok: true, data: { id } };
    } catch (e) {
      return { ok: false, ...loiSoTietKiem(e, "Lỗi khi sửa sổ tiết kiệm") };
    }
  } finally {
    cua.ra();
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
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  const cua = vaoCuaGhi();
  if (!cua.ok) return cua.loi;
  try {
    const parsed = idSchema.safeParse(input);
    if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
    const { id } = parsed.data;

    try {
      await chayCoRetry(() =>
        prisma.$transaction(async (tx) => {
          await khoaChiaSeBatNoPhaiTra(tx);
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
          // Đã bật nợ phải trả: không xoá dòng tiền nào ngày < M. Kiểm TRƯỚC câu chụp thùng rác.
          await chanDongTienTruocM(tx, {
            loai: "XOA",
            ngay: [...dongTien.map((m) => m.date), ...dongLai.map((t) => t.date)],
          });
          await chupVaoThungRac(tx, {
            bang: "SoTietKiem",
            banGhi,
            cashMovements: dongTien,
            thuNhap: dongLai,
          });

          // FK `onDelete: Restrict` là hàng rào cuối: dọn dòng gửi TRƯỚC rồi mới xoá hồ sơ.
          await tx.cashMovement.deleteMany({ where: { savingsId: id } });
          await tx.soTietKiem.delete({ where: { id } });
          await ghiNhatKy(tx, { actor: nguoiDung, hanhDong: "TIET_KIEM_XOA", doiTuong: { loai: "SoTietKiem", id } });
        }, OPT_TX_DONG_TIEN)
      );

      lamMoiTrang();
      return { ok: true, data: null };
    } catch (e) {
      await ghiNhatKyLoi({
        actor: nguoiDung,
        hanhDong: "TIET_KIEM_XOA",
        doiTuong: { loai: "SoTietKiem", id },
        ghiChu: { lyDo: maLoiNhatKy(e) },
      });
      return { ok: false, ...loiSoTietKiem(e, "Lỗi khi xoá sổ tiết kiệm") };
    }
  } finally {
    cua.ra();
  }
}
