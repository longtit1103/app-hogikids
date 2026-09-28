import { endOfMonth, format } from "date-fns";
import Link from "next/link";

import { serializeDateRange } from "@/lib/date-range";
import { formatVnd } from "@/lib/format";
import { cauChenhLech, type DoiChieuSoDuChot } from "@/lib/so-quy/doi-chieu-so-du-chot";

import { SoDuChotThangButton } from "./so-du-chot-thang-button";

/**
 * Thẻ "Chốt số dư cuối tháng" — ngay dưới thẻ Quỹ ở tab Dòng tiền. Server component thuần hiển thị;
 * nút Chốt/Sửa/Xoá + modal nằm ở `so-du-chot-thang-button.tsx` (client).
 *
 * Đây là HÀNG RÀO, không phải số liệu: sổ quỹ chỉ CỘNG DỒN 6 nguồn, không có phép so nào với tiền
 * thật — chủ shop gõ số dư app ngân hàng + tiền mặt đếm được, thẻ trừ với "Cuối kỳ" của sổ.
 * Chênh lệch in bằng CHỮ chỉ đúng hướng đi tìm (`cauChenhLech`), đã CỘNG dư nợ thấu chi và đã loại
 * trừ ca cộng nhầm tiền đang gửi — hai khoản cấu trúc làm tiền thật lệch sổ mà không phải sai sổ.
 *
 * Nhãn tháng tính ở ĐÂY (server, TZ VN) rồi truyền chuỗi xuống client — client parse lại ISO là in
 * sai tháng khi trình duyệt ở múi giờ tây hơn UTC+7 (quy ước repo: mọi chỗ khác neo tay `+07:00`).
 */

const MAU_TONE = { khop: "text-ink", duong: "text-warning", am: "text-error" } as const;

function ONho({ nhan, tien, testId }: { nhan: string; tien: number; testId?: string }) {
  return (
    <div className="rounded-xl bg-surface-card p-3">
      <p className="text-xs text-muted-foreground">{nhan}</p>
      <p className="mt-1 font-serif text-lg text-ink" data-testid={testId}>
        {formatVnd(tien)}
      </p>
    </div>
  );
}

/** Link tới tab Dòng tiền của một tháng — để nhắc "tháng trước chưa chốt" bấm là tới nơi. */
function hrefThang(thang: Date): string {
  const { tu, den } = serializeDateRange({ from: thang, to: endOfMonth(thang) });
  return `/tai-chinh?tab=dong-tien&tu=${tu}&den=${den}`;
}

function NhacThangTruoc({ thang }: { thang: Date | null }) {
  if (thang === null) return null;
  return (
    <p className="text-xs text-warning" data-testid="so-du-chot-nhac-thang-truoc">
      Tháng {format(thang, "MM/yyyy")} chưa chốt số dư —{" "}
      <Link href={hrefThang(thang)} className="underline">
        chốt ngay
      </Link>{" "}
      để bắt kịp khoản ghi thiếu/thừa trước khi nó trôi sang tháng sau.
    </p>
  );
}

export function SoDuChotThangCard({ doiChieu, isCurrentMonth }: { doiChieu: DoiChieuSoDuChot; isCurrentMonth: boolean }) {
  const thangNhan = format(doiChieu.thang, "MM/yyyy");
  const { cauTruc } = doiChieu;

  if (doiChieu.khaDung !== "ok") {
    return (
      <div className="rounded-xl border border-hairline p-4" data-testid="so-du-chot-card">
        <p className="text-sm text-muted-foreground">Chốt số dư cuối tháng</p>
        <p className="mt-2 text-sm text-ink">
          {doiChieu.khaDung === "chua_mo_so"
            ? "Chưa mở sổ quỹ — có sổ rồi mới có gì để đối chiếu."
            : `Tháng ${thangNhan} nằm trước ngày mở sổ — chưa có sổ để đối chiếu.`}
        </p>
      </div>
    );
  }

  const { chot, cuoiKy, quyHomNay, soChot, chenhLech, chenhLechTho } = doiChieu;
  const thangIso = doiChieu.thang.toISOString();
  // Cùng vị từ với thẻ Quỹ: chỉ nhắc "dự kiến" khi hai số THẬT SỰ khác nhau — nhắc trên mọi lượt xem
  // tháng hiện tại là nhiễu, chủ shop học cách phớt lờ đúng lúc câu đó có nghĩa.
  const cuoiKyDuKien = isCurrentMonth && cuoiKy !== quyHomNay;
  // Dặn dò dùng chung cho cả trạng thái chưa chốt lẫn đã chốt.
  const dongCauTruc = [
    cauTruc.duNoThauChi > 0 &&
      `đang thấu chi ${formatVnd(cauTruc.duNoThauChi)} — gõ số dư ngân hàng đúng như app (âm cũng gõ âm), thẻ tự cộng dư nợ thấu chi vào khi so`,
    cauTruc.tienDangGui > 0 &&
      `đang gửi tiết kiệm / tiền gửi bắt buộc ${formatVnd(cauTruc.tienDangGui)} — KHÔNG cộng vào số dư ngân hàng, số đó đã trừ khỏi quỹ rồi`,
  ].filter((x): x is string => typeof x === "string");

  if (chot === null || soChot === null || chenhLech === null || chenhLechTho === null) {
    return (
      <div className="rounded-xl border border-hairline p-4" data-testid="so-du-chot-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm text-muted-foreground">Chốt số dư cuối tháng</p>
            <p className="mt-1 text-sm text-ink">
              Chưa chốt tháng {thangNhan}. Cuối tháng, gõ số dư app ngân hàng + tiền mặt đếm được để so
              với sổ — cách duy nhất bắt được khoản ghi thiếu/ghi thừa.
            </p>
          </div>
          <SoDuChotThangButton thangIso={thangIso} thangNhan={thangNhan} chot={null} cauTruc={cauTruc} />
        </div>
        <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          {isCurrentMonth && <p>Tháng này chưa hết — chốt vào ngày cuối tháng mới so đúng.</p>}
          {dongCauTruc.map((d) => (
            <p key={d}>{d}</p>
          ))}
          <NhacThangTruoc thang={doiChieu.thangTruocChuaChot} />
        </div>
      </div>
    );
  }

  const cau = cauChenhLech(chenhLech, cauTruc);

  return (
    <div className="rounded-xl border border-hairline p-4" data-testid="so-du-chot-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Chốt số dư cuối tháng {thangNhan}</p>
          <p className={`mt-1 font-serif text-2xl ${MAU_TONE[cau.tone]}`} data-testid="so-du-chot-chenh-lech">
            {cau.nhan}
          </p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="so-du-chot-giai-thich">
            {cau.giaiThich}
          </p>
        </div>
        <SoDuChotThangButton thangIso={thangIso} thangNhan={thangNhan} chot={chot} cauTruc={cauTruc} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ONho nhan="Số dư ngân hàng" tien={chot.soDuBank} />
        <ONho nhan="Tiền mặt" tien={chot.tienMat} />
        <ONho nhan="Σ tiền thật" tien={soChot} />
        <ONho nhan="Cuối kỳ (sổ quỹ)" tien={cuoiKy} testId="so-du-chot-cuoi-ky" />
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-hairline pt-2 text-xs text-muted-foreground">
        <p>
          {cauTruc.duNoThauChi > 0
            ? `chênh lệch = Σ tiền thật + dư nợ thấu chi ${formatVnd(cauTruc.duNoThauChi)} − cuối kỳ sổ (chưa cộng thấu chi: ${formatVnd(chenhLechTho)})`
            : "chênh lệch = Σ tiền thật − cuối kỳ sổ"}{" "}
          · chốt lúc {format(chot.updatedAt, "HH:mm dd/MM/yyyy")}
          {chot.note ? ` · ${chot.note}` : ""}
        </p>
        {dongCauTruc.map((d) => (
          <p key={d}>{d}</p>
        ))}
        {cuoiKyDuKien && (
          <p>
            tháng này chưa hết — cuối kỳ {formatVnd(cuoiKy)} là số dự kiến, quỹ tới hôm nay {formatVnd(quyHomNay)};
            so lại vào ngày cuối tháng.
          </p>
        )}
        <NhacThangTruoc thang={doiChieu.thangTruocChuaChot} />
      </div>
    </div>
  );
}
