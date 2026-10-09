import type { LoiDieuKienBat, MaDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";

import { NhapHangSauMHuongDan } from "./nhap-hang-sau-m-huong-dan";

type Muc = { nhan: string; ma?: readonly MaDieuKienBat[]; tuKiem?: string };

/**
 * Danh sách điều kiện máy KIỂM ĐƯỢC (cùng hàm `kiemDieuKienBat` bước bật chạy lại trong transaction) +
 * các mục chủ shop TỰ KIỂM (app không biết thẻ / phiếu ngoài hồ sơ). Mục máy: đạt ⇒ ✓, chưa ⇒ câu lý do.
 */
const MUC: Muc[] = [
  { nhan: "Đã tới ngày bật, và ngày bật không trước đầu tháng trước", ma: ["CHUA_TOI_NGAY_M", "M_LUI_QUA_XA"] },
  { nhan: "Sổ quỹ đã mở, ngày bật không trước ngày mở sổ", ma: ["CHUA_MO_SO", "M_TRUOC_MO_SO"] },
  { nhan: "Ngày bật thuộc tháng sau tháng đã chốt số dư gần nhất", ma: ["M_KHONG_SAU_THANG_DA_CHOT"] },
  {
    nhan: "Quảng cáo trả trước (Shopee Ads) đang chạy đã có hồ sơ ví — hoặc xác nhận ở bước bật là ví chưa theo dõi",
    ma: ["THIEU_HO_SO_VI"],
  },
  { nhan: "Không còn mẫu chi định kỳ Nhập hàng đang chạy", ma: ["CON_MAU_DINH_KY_NHAP_HANG"] },
  { nhan: "Không còn chi phí Nhập hàng ghi từ ngày bật trở đi", ma: ["CON_NHAP_HANG_SAU_M"] },
  {
    nhan: "Mọi thẻ tín dụng đang có nợ đã có hồ sơ và gắn nền tảng quảng cáo (nếu thẻ trả quảng cáo)",
    tuKiem: "App không biết thẻ ngoài hồ sơ — thẻ thêm sau khi bật chỉ được khai dư nợ 0.",
  },
  {
    nhan: "Phiếu nhập còn nợ nhà cung cấp đã ghi nhận vào sổ nợ",
    tuKiem: "Phiếu đã duyệt chi phí mà thật chưa trả đủ: sửa Sổ chi phí xuống số đã trả, hoặc ghi nhận kèm lý do lệch (phần lệch vào điều chỉnh ngày bật).",
  },
  {
    nhan: "Đã xem báo cáo khảo sát chênh nguồn ads ↔ ví TikTok (tham khảo)",
    tuKiem:
      "Chạy chỉ-đọc khi được phép: npx tsx scripts/khao-sat-chenh-nguon-ads-vi.ts --prod --tu <từ ngày> --den <đến ngày>",
  },
];

export function BatChecklist({ loi }: { loi: readonly LoiDieuKienBat[] }) {
  return (
    <ul className="flex flex-col gap-2 rounded-xl border border-hairline p-4 text-sm" data-testid="bat-checklist">
      {MUC.map((m) => {
        const loiMuc = m.ma ? loi.filter((l) => m.ma?.includes(l.code)) : [];
        const dat = m.ma !== undefined && loiMuc.length === 0;
        return (
          <li key={m.nhan} className="flex gap-2">
            <span
              aria-hidden
              className={m.ma === undefined ? "text-muted-foreground" : dat ? "text-success" : "text-error"}
            >
              {m.ma === undefined ? "○" : dat ? "✓" : "✗"}
            </span>
            <div className="flex flex-col gap-0.5">
              <span className="text-ink">
                {m.nhan}
                {m.ma === undefined && <span className="text-xs text-muted-foreground"> (tự kiểm)</span>}
              </span>
              {loiMuc.map((l) =>
                l.nhapHangSauM ? (
                  <NhapHangSauMHuongDan key={l.code} duLieu={l.nhapHangSauM} />
                ) : (
                  <span key={l.code} className="text-xs text-error">
                    {l.message}
                  </span>
                )
              )}
              {m.tuKiem && <span className="text-xs text-muted-foreground">{m.tuKiem}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
