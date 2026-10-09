import { format, startOfDay } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";

import type { CashMovementKindTatCa } from "@/lib/cash-movements/cash-movement-kinds";
import { formatVnd } from "@/lib/format";
import { khoaCacPhieu } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { khoaThe } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { HAN_CHO_KHOA_DONG_TIEN_MS, khoaDongTienCoHan } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * Cổng HỒ SƠ NỢ của một dòng `CashMovement` loại nợ phải trả (`CARD_PAY`, `SUPPLIER_PAY`,
 * `SUPPLIER_REFUND`, `ADS_TOPUP`) — dùng chung cho action ghi tay thường (tạo/sửa/xoá) và khôi phục
 * thùng rác, để hai đường không bao giờ lệch luật (spec §5.3, §5.7, §5.8).
 *
 * Khuôn y hệt trục khoản vay (`vi-tu-du-no.ts`): KHOÁ dòng cha `FOR UPDATE` TRƯỚC, rồi mới đọc trạng
 * thái cha (ReadCommitted ⇒ câu đọc sau khi giành khoá thấy bản đã commit mới nhất). Không khoá thì
 * lượt đóng thẻ / huỷ phiếu chạy song song đọc trạng thái cũ: trả thẻ lọt vào thẻ vừa đóng, trả tiền
 * hàng lọt vào phiếu vừa huỷ.
 *
 * THỨ TỰ KHOÁ CỐ ĐỊNH: `TheTinDung` → `PhieuNhapNo` → `ViAdsTraTruoc`, trong mỗi bảng sắp theo id. Một
 * dòng thường chỉ chạm MỘT bảng, nhưng lượt SỬA có thể chuyển dòng từ thẻ sang phiếu (đổi `CARD_PAY` ⇒
 * `SUPPLIER_PAY`) hay `ADS_TOPUP` nạp bằng thẻ chạm cả thẻ lẫn ví — một thứ tự toàn cục là cách duy nhất
 * để hai lượt không giữ chéo nhau. Không bao giờ đi cùng khoá `Loan`/`SoTietKiem`: action thường cấm đổi
 * dòng giữa nhóm loại cũ và nhóm nợ phải trả.
 */

/** Ba khoá hồ sơ nợ của một dòng tiền (null = không gắn). */
export type KhoaHoSoNo = { cardId: string | null; phieuNhapId: string | null; viAdsId: string | null };

/** Một phía (trước/sau) của lượt ghi: kind + khoá hồ sơ + ngày + số tiền. */
export type DongHoSoNo = KhoaHoSoNo & { kind: CashMovementKindTatCa; date: Date; amount: number };

/** Lượt ghi bị từ chối vì hồ sơ nợ — NÉM trong transaction (return = COMMIT). */
export class LoiHoSoNo extends Error {
  constructor(
    message: string,
    public readonly field: "cardId" | "phieuNhapId" | "viAdsId" | "date" | "amount" | "id",
    public readonly code:
      | "THE_DA_DONG"
      | "PHIEU_DA_HUY"
      | "KHONG_TIM_THAY_HO_SO"
      | "TRUOC_NGAY_NEO_VI"
      | "TRUOC_NGAY_NEO_THE"
      | "HOAN_VUOT_DA_TRA"
  ) {
    super(message);
    this.name = "LoiHoSoNo";
  }
}

function sapKhacNull(ids: readonly (string | null)[]): string[] {
  return [...new Set(ids.filter((x): x is string => x !== null))].sort();
}

/** Khoá `FOR UPDATE` các ví ads trả trước theo thứ tự id (khuôn `khoaCacPhieu`). */
async function khoaCacViAds(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await khoaDongTienCoHan(
    tx,
    ids.map((id) => () => tx.$queryRaw`SELECT id FROM "ViAdsTraTruoc" WHERE id = ${id} FOR UPDATE`),
    HAN_CHO_KHOA_DONG_TIEN_MS,
  );
}

/** Khoá mọi hồ sơ nợ mà các phía của lượt ghi chạm tới — gọi TRƯỚC mọi lượt đọc trạng thái hồ sơ. */
export async function khoaHoSoNo(tx: Prisma.TransactionClient, phia: readonly KhoaHoSoNo[]): Promise<void> {
  for (const cardId of sapKhacNull(phia.map((p) => p.cardId))) await khoaThe(tx, cardId);
  await khoaCacPhieu(tx, sapKhacNull(phia.map((p) => p.phieuNhapId)));
  await khoaCacViAds(tx, sapKhacNull(phia.map((p) => p.viAdsId)));
}

/** Thẻ phải còn và CHƯA đóng — thẻ đóng có dư nợ 0, ghi/sửa/xoá dòng của nó là làm dư nợ khác 0. */
async function kiemTheConMo(tx: Prisma.TransactionClient, cardId: string): Promise<void> {
  const the = await tx.theTinDung.findUnique({ where: { id: cardId }, select: { closedAt: true, ten: true } });
  if (!the) throw new LoiHoSoNo("Không tìm thấy thẻ — tải lại trang", "cardId", "KHONG_TIM_THAY_HO_SO");
  if (the.closedAt !== null) {
    throw new LoiHoSoNo(
      `Thẻ ${the.ten} đã đóng — không ghi, sửa hay xoá dòng tiền của thẻ đã đóng`,
      "cardId",
      "THE_DA_DONG",
    );
  }
}

/**
 * Cửa sổ ngày theo NEO ĐẦU TIÊN của thẻ (spec §5.8): giao dịch gắn thẻ (`CARD_PAY`, `ADS_TOPUP` nạp bằng
 * thẻ, `Expense.cardId`) phải có ngày SAU `ngayChot` nhỏ nhất của thẻ. Dư nợ (`duNo`, `ky-sao-ke.ts`) chỉ
 * đếm giao dịch `> neo.ngayChot`; thẻ thêm SAU bật có neo `soDu = 0` tại ngày X (mặc định hôm qua) nên
 * neo đó KHÔNG gồm giao dịch nào trước nó. Cho ghi một khoản ngày ≤ X là tiền rơi khỏi CẢ HAI trục: quỹ đã
 * loại khoản chi trừ thẻ / nạp ví bằng thẻ, còn nợ thẻ không đếm nó (hay `CARD_PAY` trừ quỹ mà không giảm
 * nợ). Thẻ của bước bật có neo M−1 nên mọi ngày ≥ M đều qua. Đối xứng `TRUOC_NGAY_NEO_VI` của ví ads.
 * Thẻ không có neo nào ⇒ từ chối: không có điểm tựa thì dư nợ là null, giao dịch không vào đâu cả.
 */
export async function kiemNgaySauNeoThe(tx: Prisma.TransactionClient, cardId: string, ngay: Date): Promise<void> {
  const the = await tx.theTinDung.findUnique({ where: { id: cardId }, select: { ten: true } });
  const neoDau = await tx.kySaoKeThe.findFirst({
    where: { cardId },
    orderBy: { ngayChot: "asc" },
    select: { ngayChot: true },
  });
  if (!the) throw new LoiHoSoNo("Không tìm thấy thẻ — tải lại trang", "cardId", "KHONG_TIM_THAY_HO_SO");
  if (!neoDau) {
    throw new LoiHoSoNo(
      `Thẻ ${the.ten} chưa có neo dư nợ — giao dịch gắn thẻ chưa ghi được`,
      "cardId",
      "TRUOC_NGAY_NEO_THE",
    );
  }
  if (khoaNgayVn(ngay) <= khoaNgayVn(neoDau.ngayChot)) {
    throw new LoiHoSoNo(
      `Thẻ ${the.ten} chỉ theo dõi từ sau ${format(neoDau.ngayChot, "dd/MM/yyyy")} (ngày neo)`,
      "date",
      "TRUOC_NGAY_NEO_THE",
    );
  }
}

/**
 * Khoá rồi kiểm "còn mở" cho một tập thẻ — đường ghi `Expense.cardId` (chi phí trừ vào thẻ, spec §5.6):
 * gắn, gỡ hay sửa khoản chi của thẻ đều đổi dư nợ thẻ đó. Cùng thứ tự khoá với `khoaHoSoNo`.
 * `sau` = thẻ + ngày mà khoản chi SẼ mang sau lượt ghi (null khi xoá): thẻ đó còn phải qua cửa sổ neo
 * (`kiemNgaySauNeoThe`). Thẻ cũ bị gỡ chỉ cần còn mở.
 */
export async function khoaVaKiemCacTheConMo(
  tx: Prisma.TransactionClient,
  cardIds: readonly (string | null)[],
  sau: { cardId: string | null; date: Date } | null,
): Promise<void> {
  const ids = sapKhacNull([...cardIds, sau?.cardId ?? null]);
  for (const id of ids) await khoaThe(tx, id);
  for (const id of ids) await kiemTheConMo(tx, id);
  if (sau?.cardId) await kiemNgaySauNeoThe(tx, sau.cardId, sau.date);
}

/**
 * Cổng sau khoá, chạy TRƯỚC câu ghi. `truoc` = dòng đang có (null khi tạo/khôi phục), `sau` = dòng sẽ có
 * (null khi xoá).
 *  - Thẻ: MỌI thẻ dính tới (trước lẫn sau) phải còn mở; thẻ của phía SAU còn phải qua cửa sổ neo đầu
 *    tiên (`kiemNgaySauNeoThe`).
 *  - Phiếu: phải còn. `SUPPLIER_PAY` vào phiếu đã HUỶ bị chặn — trừ khi chính dòng đó vốn đã là trả cho
 *    đúng phiếu này VÀ không tăng số (sửa ngày/mô tả, hoặc GIẢM số vì gõ nhầm thì được; tăng là trả thêm
 *    vào phiếu huỷ — đúng điều §5.3 cấm). `SUPPLIER_REFUND` vào phiếu huỷ được (trần ở `chanHoanVuotDaTra`) —
 *    đó là cách thu hồi tiền đã trả (spec §5.3). `choPhepTraVaoPhieuHuy` = đường khôi phục thùng rác
 *    (spec §5.3: "vẫn cho khôi phục" — dòng đó là tiền đã thật rời quỹ; nợ âm hiện "cần thu hồi").
 *  - Ví: phải còn, và ngày nạp phải SAU ngày neo số dư ví (nạp trước neo đã nằm trong `soDuNeo`).
 */
export async function kiemHoSoNo(
  tx: Prisma.TransactionClient,
  p: { truoc: DongHoSoNo | null; sau: DongHoSoNo | null; choPhepTraVaoPhieuHuy?: boolean },
): Promise<void> {
  for (const cardId of sapKhacNull([p.truoc?.cardId ?? null, p.sau?.cardId ?? null])) {
    await kiemTheConMo(tx, cardId);
  }
  if (p.sau?.cardId) await kiemNgaySauNeoThe(tx, p.sau.cardId, p.sau.date);

  const sau = p.sau;
  if (sau?.phieuNhapId) {
    const phieu = await tx.phieuNhapNo.findUnique({
      where: { id: sau.phieuNhapId },
      select: { daHuy: true, maPhieu: true },
    });
    if (!phieu) {
      throw new LoiHoSoNo("Không tìm thấy phiếu trong sổ nợ — tải lại trang", "phieuNhapId", "KHONG_TIM_THAY_HO_SO");
    }
    const vonLaTraPhieuNay =
      p.truoc?.kind === "SUPPLIER_PAY" && p.truoc.phieuNhapId === sau.phieuNhapId && sau.amount <= p.truoc.amount;
    if (sau.kind === "SUPPLIER_PAY" && phieu.daHuy && !vonLaTraPhieuNay && !p.choPhepTraVaoPhieuHuy) {
      throw new LoiHoSoNo(
        `Phiếu ${phieu.maPhieu} đã huỷ — không trả thêm. Nhà cung cấp hoàn lại tiền thì ghi "NCC hoàn tiền".`,
        "phieuNhapId",
        "PHIEU_DA_HUY",
      );
    }
  }

  if (sau?.viAdsId) {
    const vi = await tx.viAdsTraTruoc.findUnique({ where: { id: sau.viAdsId }, select: { ngayNeo: true } });
    if (!vi) throw new LoiHoSoNo("Không tìm thấy ví quảng cáo — tải lại trang", "viAdsId", "KHONG_TIM_THAY_HO_SO");
    if (startOfDay(sau.date) <= startOfDay(vi.ngayNeo)) {
      throw new LoiHoSoNo(
        `Ngày nạp phải sau ngày neo số dư ví (${format(vi.ngayNeo, "dd/MM/yyyy")}) — tiền nạp trước đó đã nằm trong số dư neo`,
        "date",
        "TRUOC_NGAY_NEO_VI",
      );
    }
  }
}

/**
 * TRẦN HOÀN TIỀN của phiếu: Σ `SUPPLIER_REFUND` ≤ `daTraTruoc` + Σ `SUPPLIER_PAY`. Nhà cung cấp không hoàn
 * quá số đã nhận — để lọt là phiếu huỷ hiện "còn nợ" DƯƠNG giả (nghĩa vụ 0 + hoàn vượt), khoản nợ đó không
 * bao giờ trả được (trả gộp lọc phiếu huỷ) mà vẫn bị trừ khỏi "Sau khi trả hết nợ".
 *
 * Vị từ SAU câu ghi, trong transaction ĐÃ khoá phiếu (`khoaHoSoNo` / `khoaCacPhieu`) — khuôn `chanDuNoAm`:
 * kiểm trước là check-then-act. Gọi cho MỌI phiếu mà lượt ghi chạm (trước lẫn sau): xoá / giảm một dòng
 * trả, hay bớt "đã trả trước", cũng hạ trần dưới số đã hoàn.
 */
export async function chanHoanVuotDaTra(
  tx: Prisma.TransactionClient,
  phieuNhapIds: readonly (string | null)[],
): Promise<void> {
  for (const id of sapKhacNull(phieuNhapIds)) {
    const phieu = await tx.phieuNhapNo.findUnique({ where: { id }, select: { maPhieu: true, daTraTruoc: true } });
    if (!phieu) continue; // phiếu đã mất: FK Restrict đã chặn mọi dòng gắn nó
    const nhom = await tx.cashMovement.groupBy({
      by: ["kind"],
      where: { phieuNhapId: id, kind: { in: ["SUPPLIER_PAY", "SUPPLIER_REFUND"] } },
      _sum: { amount: true },
    });
    const tong = (k: string) => nhom.find((g) => g.kind === k)?._sum.amount ?? 0;
    const daTra = phieu.daTraTruoc + tong("SUPPLIER_PAY");
    const daHoan = tong("SUPPLIER_REFUND");
    if (daHoan > daTra) {
      throw new LoiHoSoNo(
        `Phiếu ${phieu.maPhieu}: tổng nhà cung cấp hoàn (${formatVnd(daHoan)}) vượt số đã trả (${formatVnd(daTra)}) — kiểm lại số tiền`,
        "amount",
        "HOAN_VUOT_DA_TRA",
      );
    }
  }
}
