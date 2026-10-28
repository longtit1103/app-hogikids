import { ghiNhatKy, type ActorNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { OPT_TX_DONG_TIEN } from "@/lib/so-quy/khoa-dong-tien-co-han";
import {
  chonDongNhanGocDiSan,
  laMoTaMauNhanGocTatToan,
} from "@/lib/tiet-kiem/dong-nhan-goc-tat-toan";
import { khoaCacSoTietKiem } from "@/lib/tiet-kiem/vi-tu-so-tiet-kiem";

/**
 * Lõi của `scripts/danh-dau-dong-nhan-goc-tat-toan.ts` — gán `SoTietKiem.dongNhanGocTatToanId` cho sổ tất toán
 * TRƯỚC khi có cột (cột NULL), để "Mở lại" xoá được đúng dòng nhận gốc app đã sinh thay vì từ chối.
 *
 * Chỉ ghi CỘT TRỎ DÒNG + nhật ký: không tạo/sửa/xoá dòng tiền nào ⇒ quỹ, P&L, số đang gửi không đổi một đồng.
 * Hai bước tách hẳn: `khaoSatSoCanGanDau` CHỈ ĐỌC (lượt thử, mặc định của script); `ganDauDongNhanGoc` nhận
 * ĐÚNG danh sách id chủ shop đã duyệt và kiểm lại từng id SAU khi khoá sổ — không tin kết quả lượt thử cũ.
 */

const SELECT_DONG = { id: true, kind: true, amount: true, date: true, description: true } as const;

export type SoCanGanDau = {
  soId: string;
  tenSo: string;
  /** Ngày tất toán (khoá ngày VN `YYYY-MM-DD`). */
  ngayTatToan: string;
  /** Dòng đề xuất gán — NULL khi không chọn được (xem `lyDo`). */
  dongId: string | null;
  soTien: number | null;
  lyDo: string | null;
  /** Số dòng `SAVINGS_IN` của sổ — để người duyệt thấy sổ có dòng tay đi kèm. */
  soDongNhan: number;
};

/**
 * Sổ mà "Mở lại" đang từ chối: đã đóng, cột trỏ dòng NULL, còn ít nhất một dòng `SAVINGS_IN` mang mẫu mô tả
 * app sinh (cùng vị từ `moLaiSoTietKiem` dùng). Sổ chỉ có dòng nhận ghi tay KHÔNG nằm đây — mở lại được ngay.
 */
export async function khaoSatSoCanGanDau(): Promise<SoCanGanDau[]> {
  const cacSo = await prisma.soTietKiem.findMany({
    where: { closedAt: { not: null }, dongNhanGocTatToanId: null, movements: { some: { kind: "SAVINGS_IN" } } },
    select: {
      id: true,
      name: true,
      closedAt: true,
      movements: { select: SELECT_DONG, orderBy: [{ date: "asc" }, { id: "asc" }] },
    },
    orderBy: [{ closedAt: "asc" }, { id: "asc" }],
  });

  const ra: SoCanGanDau[] = [];
  for (const so of cacSo) {
    if (so.closedAt === null) continue; // đã lọc ở where — thu hẹp kiểu cho TS
    const nhan = so.movements.filter((d) => d.kind === "SAVINGS_IN");
    if (!nhan.some((d) => laMoTaMauNhanGocTatToan(d.description))) continue;
    const kq = chonDongNhanGocDiSan({ name: so.name, closedAt: so.closedAt }, so.movements);
    const dong = kq.ok ? nhan.find((d) => d.id === kq.id) : undefined;
    ra.push({
      soId: so.id,
      tenSo: so.name,
      ngayTatToan: khoaNgayVn(so.closedAt),
      dongId: dong?.id ?? null,
      soTien: dong?.amount ?? null,
      lyDo: kq.ok ? null : kq.lyDo,
      soDongNhan: nhan.length,
    });
  }
  return ra;
}

/** Lỗi khiến cả lượt gán bị từ chối — transaction lùi trọn, không sổ nào được gán. */
export class LoiGanDauDongNhanGoc extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoiGanDauDongNhanGoc";
  }
}

/**
 * Gán dấu cho ĐÚNG các dòng `dongIds` (id `CashMovement`), MỘT transaction: một id sai là cả lượt lùi.
 * Khoá `SoTietKiem` FOR UPDATE (thứ tự id tăng dần, như mọi đường ghi sổ) TRƯỚC khi đọc lại dòng và kiểm
 * lại ba dấu — không có khoá thì một lượt mở lại/ghi tay chen giữa làm ứng viên đổi sau phép kiểm.
 *
 * IDEMPOTENT: sổ đã trỏ ĐÚNG dòng đó ⇒ bỏ qua, không ghi thêm nhật ký. Sổ đã trỏ dòng KHÁC ⇒ từ chối.
 */
export async function ganDauDongNhanGoc(
  dongIds: readonly string[],
  actor: ActorNhatKy
): Promise<{ daGan: string[]; daCoSan: string[] }> {
  const ids = [...new Set(dongIds)].sort();
  if (ids.length === 0) throw new LoiGanDauDongNhanGoc("Danh sách id dòng rỗng — truyền --ids=a,b,c");

  return prisma.$transaction(async (tx) => {
    const dong = await tx.cashMovement.findMany({
      where: { id: { in: ids } },
      select: { id: true, kind: true, savingsId: true },
    });
    const soCuaDong = new Map<string, string>();
    for (const id of ids) {
      const d = dong.find((x) => x.id === id);
      if (!d) throw new LoiGanDauDongNhanGoc(`Không có dòng tiền id ${id}`);
      if (d.kind !== "SAVINGS_IN" || d.savingsId === null) {
        throw new LoiGanDauDongNhanGoc(`Dòng ${id} không phải dòng nhận gốc tiết kiệm (SAVINGS_IN gắn sổ)`);
      }
      if ([...soCuaDong.values()].includes(d.savingsId)) {
        throw new LoiGanDauDongNhanGoc(`Hai id cùng thuộc sổ ${d.savingsId} — mỗi sổ chỉ gán đúng một dòng`);
      }
      soCuaDong.set(id, d.savingsId);
    }

    await khoaCacSoTietKiem(tx, [...soCuaDong.values()]);

    const daGan: string[] = [];
    const daCoSan: string[] = [];
    for (const id of ids) {
      const soId = soCuaDong.get(id) as string; // đã set cho MỌI id ở vòng trên
      const so = await tx.soTietKiem.findUnique({
        where: { id: soId },
        select: {
          name: true,
          closedAt: true,
          dongNhanGocTatToanId: true,
          movements: { select: SELECT_DONG },
        },
      });
      if (!so) throw new LoiGanDauDongNhanGoc(`Không tìm thấy sổ ${soId}`);
      if (so.dongNhanGocTatToanId === id) {
        daCoSan.push(id);
        continue;
      }
      if (so.dongNhanGocTatToanId !== null) {
        throw new LoiGanDauDongNhanGoc(`Sổ "${so.name}" đã trỏ dòng khác (${so.dongNhanGocTatToanId}) — không ghi đè`);
      }
      if (so.closedAt === null) {
        throw new LoiGanDauDongNhanGoc(`Sổ "${so.name}" đang gửi — chỉ sổ đã tất toán mới cần gán dấu`);
      }
      const kq = chonDongNhanGocDiSan({ name: so.name, closedAt: so.closedAt }, so.movements);
      if (!kq.ok) throw new LoiGanDauDongNhanGoc(`Sổ "${so.name}": ${kq.lyDo}`);
      if (kq.id !== id) {
        throw new LoiGanDauDongNhanGoc(`Sổ "${so.name}": dòng ${id} không phải ứng viên (ứng viên là ${kq.id})`);
      }

      // Fencing: điều kiện cột NULL + sổ đóng nằm TRONG câu UPDATE.
      const n = await tx.soTietKiem.updateMany({
        where: { id: soId, closedAt: { not: null }, dongNhanGocTatToanId: null },
        data: { dongNhanGocTatToanId: id },
      });
      if (n.count !== 1) throw new LoiGanDauDongNhanGoc(`Sổ "${so.name}" vừa đổi trạng thái — chạy lại lượt thử`);

      await ghiNhatKy(tx, {
        actor,
        hanhDong: HANH_DONG.TIET_KIEM_GAN_DAU_DONG_NHAN_GOC,
        doiTuong: { loai: "SoTietKiem", id: soId, moTa: `Dòng nhận gốc ${id}` },
      });
      daGan.push(id);
    }
    return { daGan, daCoSan };
  }, OPT_TX_DONG_TIEN);
}
