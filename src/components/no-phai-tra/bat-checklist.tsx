import Link from "next/link";

import type { LoiDieuKienBat, MaDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";
import type { NhacTruocBat } from "@/lib/no-phai-tra/dieu-kien-bat-truoc-m";
import { hrefSoChiPhiTheoNgay } from "@/lib/no-phai-tra/huong-dan-nhap-hang-sau-m";

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
    nhan: "Không còn kỳ khoản vay / lãi thấu chi đến hạn từ ngày mở sổ tới trước ngày bật mà chưa duyệt",
    ma: ["CON_KY_VAY_TRUOC_M"],
  },
  {
    nhan: "Không còn khoản vay đã trả hết gốc trước ngày bật mà chưa tất toán tiền gửi bắt buộc",
    ma: ["CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M"],
  },
  { nhan: "Chi phí định kỳ đến hạn trước ngày bật đã ghi đủ vào Sổ chi phí", ma: ["CON_DINH_KY_CHUA_GHI_TRUOC_M"] },
  { nhan: "Không còn sổ tiết kiệm đáo hạn trước ngày bật mà chưa tất toán", ma: ["CON_SO_TIET_KIEM_DAO_HAN_TRUOC_M"] },
  {
    nhan: "Thấu chi lãi nhập gốc: kỳ lãi trước ngày bật đã cộng vào dư nợ (không còn kỳ ghi kiểu trừ tài khoản)",
    ma: ["CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M"],
  },
  {
    nhan: "Khoản vay, thấu chi, sổ tiết kiệm đang có từ trước ngày bật đã khai đủ ở Sổ quỹ",
    tuKiem:
      "App không biết khoản ngoài hồ sơ — sau khi bật, thấu chi và sổ tiết kiệm có từ trước ngày bật không khai được " +
      "nữa, khoản vay cũ chỉ còn khai dạng mang sang (không ghi tiền trước ngày bật).",
  },
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

/**
 * `nhac` = cảnh báo KHÔNG chặn bật (vd dữ liệu ví Shopee chưa phủ tới ngày bật): hiện khối vàng riêng dưới danh
 * sách, không là mục ✗ và không nằm trong `loi`.
 */
export function BatChecklist({ loi, nhac = [] }: { loi: readonly LoiDieuKienBat[]; nhac?: readonly NhacTruocBat[] }) {
  return (
    <div className="flex flex-col gap-3">
      <DanhSachMuc loi={loi} />
      {nhac.length > 0 && (
        <div
          className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-ink"
          data-testid="bat-nhac-truoc-bat"
        >
          {nhac.map((n) => (
            <p key={n.code} data-testid={`bat-nhac-${n.code}`}>
              {n.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function DanhSachMuc({ loi }: { loi: readonly LoiDieuKienBat[] }) {
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
                  <LyDo key={l.code} loi={l} />
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

/** Câu lý do + link tới đúng chỗ dọn (khối Khoản vay ở Sổ quỹ; Sổ chi phí đúng khoảng tháng thiếu định kỳ). */
function LyDo({ loi }: { loi: LoiDieuKienBat }) {
  const dk = loi.dinhKyTruocM;
  return (
    <span className="text-xs text-error" data-testid={`bat-ly-do-${loi.code}`}>
      {loi.message}
      {(loi.kyVayTruocM ||
        loi.code === "CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M" ||
        loi.code === "CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M") && (
        <>
          {" "}
          <Link href="/tai-chinh?tab=dong-tien#khoan-vay" className="underline underline-offset-2">
            Mở khối Khoản vay
          </Link>
        </>
      )}
      {dk && (
        <>
          {" "}
          <Link href={hrefSoChiPhiTheoNgay(dk.khoaTu, dk.khoaDen)} className="underline underline-offset-2">
            Mở Sổ chi phí tháng {dk.thang.join(", ")}
          </Link>
        </>
      )}
    </span>
  );
}
