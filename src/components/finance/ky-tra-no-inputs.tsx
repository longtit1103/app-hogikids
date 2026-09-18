"use client";

import { Input } from "@/components/ui/input";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";
import { formatVnd } from "@/lib/format";
import { tongChuyenNganHang } from "@/lib/so-quy/tien-ky-tra-no";

/**
 * Ô Lãi/Gốc (+ Tiền gửi khi khoản có sổ tiết kiệm bắt buộc) của `ky-tra-no-card.tsx` — tách riêng để
 * file đó dưới 200 dòng. Thuần hiển thị, state (và mọi luật tiền) vẫn ở component cha.
 *
 * Nhãn BỌC lấy ô nhập (khuôn `O` của form khoản vay): bấm vào chữ là con trỏ vào ô. `aria-label`
 * giữ nguyên tên cũ ("Lãi"/"Gốc") để e2e neo được, không đổi dù thêm ô thứ ba.
 *
 * Ô "Tiền gửi" CHỈ hiện khi khoản thật sự có sổ tiết kiệm (`coTienGui`). Ba ô sát nhau trong một
 * lưới, gõ nhầm ô là ra một dòng tiền thật; và với khoản KHÔNG phải BULLET thì server từ chối mọi
 * `tienGui > 0` — bày ra một ô chỉ để bị từ chối là bẫy.
 *
 * Dòng tổng dưới ba ô là hàng rào chống gõ nhầm: khoản có tiền gửi thì ngân hàng thu MỘT LẦN đủ cả
 * ba khoản (lãi + gốc + tiền gửi) — chủ shop so thẳng số này với giấy báo ngân hàng trước khi bấm
 * "Đã chuyển tiền". Trước đây hint ô Gốc không trừ tiền gửi ⇒ chủ shop cộng thừa 300.000đ mỗi kỳ vào
 * gốc, ghi thẳng vào dư nợ oan.
 *
 * Ở kỳ CUỐI ngân hàng cấn luôn sổ tiết kiệm đang giữ vào số phải nộp, nên dòng tổng trừ
 * `tienGuiSeNhanLai` — và đây là CHỖ DUY NHẤT in con số "phải chuyển bao nhiêu". Bản cũ in thêm một
 * số thứ hai ở thẻ cha ("Tiền thật anh chuyển kỳ này") lệch đúng Σ tiền gửi so với số ở đây.
 */
type Props = {
  lai: number;
  setLai: (n: number) => void;
  goc: number;
  setGoc: (n: number) => void;
  tienGui: number;
  setTienGui: (n: number) => void;
  thauChi: boolean;
  coTienGui: boolean;
  /** Σ sổ tiết kiệm ngân hàng trả lại ngay sau kỳ này — 0 ở mọi kỳ không phải kỳ cuối. */
  tienGuiSeNhanLai: number;
};

export function KyTraNoInputs({
  lai,
  setLai,
  goc,
  setGoc,
  tienGui,
  setTienGui,
  thauChi,
  coTienGui,
  tienGuiSeNhanLai,
}: Props) {
  const tongChuyen = tongChuyenNganHang({ lai, goc, tienGui, tienGuiSeNhanLai });
  return (
    <div
      className={`mt-3 grid grid-cols-1 gap-3 ${coTienGui ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
    >
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Lãi
          <Input
            inputMode="numeric"
            aria-label="Lãi"
            value={formatAmountInput(lai)}
            onChange={(e) => setLai(parseAmountInput(e.target.value))}
            className="text-right"
          />
        </label>
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Gốc
          <Input
            inputMode="numeric"
            aria-label="Gốc"
            value={formatAmountInput(goc)}
            onChange={(e) => setGoc(parseAmountInput(e.target.value))}
            className="text-right"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {thauChi
            ? "Thấu chi: ngân hàng chỉ thu lãi — để Gốc = 0 trừ khi tháng này có trả bớt gốc."
            : tienGui > 0
              ? "Ngân hàng thu tổng cố định mỗi tháng? Điền Gốc = tổng ngân hàng thu − Lãi − Tiền gửi."
              : "Ngân hàng thu tổng cố định mỗi tháng? Điền Gốc = tổng ngân hàng thu − Lãi ở trên."}
        </p>
      </div>
      {coTienGui && (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Tiền gửi
            <Input
              inputMode="numeric"
              aria-label="Tiền gửi"
              value={formatAmountInput(tienGui)}
              onChange={(e) => setTienGui(parseAmountInput(e.target.value))}
              className="text-right"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            tiền của anh, ngân hàng giữ hộ — không tính vào Lãi/Lỗ, hoàn lại thành một dòng thu riêng
            lúc tất toán (không cấn trừ vào Gốc)
          </p>
        </div>
      )}
      {/* Tổng ÂM là trạng thái HỢP LỆ, không phải app hỏng: trả trọn gốc sớm ở một kỳ giữa chừng thì
          các kỳ sau chỉ còn lãi + tiền gửi, mà kỳ cuối lại cấn cả sổ tiết kiệm đang giữ vào số phải
          nộp — ca thật 1.121.096 + 0 + 300.000 − 10.800.000 = −9.378.904. In "Tổng chuyển ngân hàng:
          −9.378.904 ₫" thì chủ shop đọc là lỗi; đảo hẳn câu và in trị tuyệt đối mới nói đúng chuyện
          (kỳ đó ngân hàng trả ròng về cho shop). Phép tính KHÔNG đổi — chỉ đổi cách in. */}
      {coTienGui &&
        (tongChuyen < 0 ? (
          <p className="col-span-full text-xs font-medium text-ink">
            Kỳ này ngân hàng trả ròng về: {formatVnd(-tongChuyen)} — sổ tiết kiệm{" "}
            {formatVnd(tienGuiSeNhanLai)} ngân hàng cấn lại lớn hơn số phải nộp, anh không phải
            chuyển đồng nào.
          </p>
        ) : (
          <p className="col-span-full text-xs font-medium text-ink">
            Tổng chuyển ngân hàng kỳ này: {formatVnd(tongChuyen)}
            {tienGuiSeNhanLai > 0 && (
              <> (đã trừ {formatVnd(tienGuiSeNhanLai)} ngân hàng cấn bằng sổ tiết kiệm)</>
            )}
          </p>
        ))}
    </div>
  );
}
