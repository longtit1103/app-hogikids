import { format, startOfDay } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";

import {
  isCashMovementKindTatCa,
  isKindNoPhaiTraGhiTay,
  KIND_CUTOVER,
} from "@/lib/cash-movements/cash-movement-kinds";
import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { kiemHoSoNo, kiemNgaySauNeoThe, LoiHoSoNo } from "@/lib/no-phai-tra/ho-so-dong-tien-no";
import { ngayTienMoiSchema } from "@/lib/no-phai-tra/ngay-tien-moi-schema";
import type { BanGhiCanDung } from "@/lib/thung-rac/do-tinh-trang-khoi-phuc";

/**
 * Khôi phục thùng rác là một ĐƯỜNG GHI TIỀN nợ phải trả — nó đi qua ĐÚNG các cổng của đường ghi tay
 * (spec §5.7, §5.8; review P1 (e)), chứ không có luật riêng:
 *  - 4 loại nợ (`CARD_PAY`, `SUPPLIER_*`, `ADS_TOPUP`): đã bật + ngày ∈ [M, hôm nay] (`ngayTienMoiSchema`)
 *    + cổng hồ sơ `kiemHoSoNo` (thẻ đóng, ví neo…). Trả tiền vào phiếu ĐÃ HUỶ vẫn khôi phục được (spec §5.3:
 *    tiền đó đã thật rời quỹ — nợ âm hiện "cần thu hồi").
 *  - `CUTOVER_*`: đã bật + ngày ĐÚNG bằng M (điều chỉnh một lần tại mốc).
 *  - `Expense.cardId`: đã bật + ngày ≥ M (trước M khoản chi đã trừ quỹ lúc chi) + ngày SAU neo đầu tiên
 *    của thẻ (`kiemNgaySauNeoThe` — cùng cửa sổ với `CARD_PAY`/`ADS_TOPUP` qua `kiemHoSoNo`).
 *  - `TheTinDung`: sau khi bật, thẻ BẮT BUỘC có neo dư nợ — thẻ xoá lúc chưa bật (không neo) không dựng lại.
 *
 * CHỈ ĐỌC (gọi được cả từ màn liệt kê bằng `prisma` thường). Đường ghi đã giành khoá hồ sơ trước khi gọi.
 * Trả câu từ chối hoặc null. Thẻ đã đóng / hồ sơ đã mất do `chaDaMat`/`chaDaTatToan` nói trước (thứ tự
 * `lyDoKhongKhoiPhuc`), nên câu ở đây chỉ hiện khi những thứ đó đã ổn.
 */

const CAU_CHUA_BAT =
  "Chưa bật theo dõi nợ phải trả — dòng tiền nợ (trả thẻ, trả/hoàn tiền hàng, nạp ví, điều chỉnh mở sổ) chỉ khôi phục được sau khi bật";

const ngayVn = (d: Date) => format(d, "dd/MM/yyyy");

export async function viPhamNoPhaiTraKhiKhoiPhuc(
  tx: Prisma.TransactionClient,
  canDung: readonly BanGhiCanDung[],
): Promise<string | null> {
  let daDoc = false;
  let mocM: Date | null = null;
  const M = async (): Promise<Date | null> => {
    if (!daDoc) {
      mocM = await docMocM(tx);
      daDoc = true;
    }
    return mocM;
  };

  for (const { bang, data } of canDung) {
    const ngay = data.date instanceof Date ? data.date : null;

    if (bang === "CashMovement" && isCashMovementKindTatCa(data.kind) && ngay !== null) {
      const kind = data.kind;
      if ((KIND_CUTOVER as readonly string[]).includes(kind)) {
        const m = await M();
        if (m === null) return CAU_CHUA_BAT;
        if (startOfDay(ngay).getTime() !== m.getTime()) {
          return `Điều chỉnh mở sổ nợ phải đúng ngày bật theo dõi nợ (${ngayVn(m)}) — dòng này ngày ${ngayVn(ngay)}`;
        }
        continue;
      }
      if (!isKindNoPhaiTraGhiTay(kind)) continue;
      const m = await M();
      if (m === null) return CAU_CHUA_BAT;
      const kq = ngayTienMoiSchema(m).safeParse(ngay);
      if (!kq.success) {
        return `Ngày ${ngayVn(ngay)} của dòng nằm ngoài cửa sổ ghi tiền nợ phải trả (từ ${ngayVn(m)} tới hôm nay) — ${
          kq.error.issues[0]?.message ?? "ngày không hợp lệ"
        }`;
      }
      const khoa = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : null);
      try {
        await kiemHoSoNo(tx, {
          truoc: null,
          sau: {
            kind,
            date: ngay,
            amount: typeof data.amount === "number" ? data.amount : 0,
            cardId: khoa("cardId"),
            phieuNhapId: khoa("phieuNhapId"),
            viAdsId: khoa("viAdsId"),
          },
          choPhepTraVaoPhieuHuy: true,
        });
      } catch (e) {
        if (e instanceof LoiHoSoNo) return e.message;
        throw e;
      }
      continue;
    }

    if (bang === "Expense" && typeof data.cardId === "string" && ngay !== null) {
      const m = await M();
      if (m === null) return CAU_CHUA_BAT;
      if (startOfDay(ngay) < m) {
        return `Khoản chi trừ vào thẻ ngày ${ngayVn(ngay)} trước ngày bật theo dõi nợ (${ngayVn(m)}) — không khôi phục được`;
      }
      // Cùng cửa sổ neo đầu tiên của thẻ với đường ghi tay (`khoaVaKiemCacTheConMo` ở `expenses.ts`).
      try {
        await kiemNgaySauNeoThe(tx, data.cardId, ngay);
      } catch (e) {
        if (e instanceof LoiHoSoNo) return e.message;
        throw e;
      }
      continue;
    }

    if (bang === "TheTinDung" && (await M()) !== null && !canDung.some((b) => b.bang === "KySaoKeThe")) {
      return "Thẻ này xoá lúc chưa bật theo dõi nợ (không có neo dư nợ) — sau khi bật, tạo thẻ mới với neo 0 thay vì khôi phục";
    }
  }
  return null;
}
