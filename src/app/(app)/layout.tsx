import { ShellChrome } from "@/components/shell/shell-chrome";
import { DateRangeProvider } from "@/components/shell/date-range-provider";
import { docTrangThaiSaoLuu } from "@/lib/backup/doc-trang-thai-sao-luu";
import { saoLuuCanBaoDong } from "@/lib/backup/trang-thai-sao-luu";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import {
  KEY_MOC_KIEM_GIA_VON,
  KEY_SO_LECH_GIA_VON,
  trangThaiLechGiaVon,
} from "@/lib/gia-von/trang-thai-lech-gia-von";
import {
  KEY_MOC_KIEM_PHIEU_NHAP,
  KEY_SO_PHIEU_NHAP_CHUA_GHI,
  KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP,
  trangThaiPhieuNhapChuaGhi,
} from "@/lib/nhap-hang/trang-thai-phieu-nhap";
import { countMissingCostVariants, hasLowStockVariants } from "@/lib/queries/variants";
import { getRecentDataErrorKinds } from "@/lib/queries/sync-health";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { docCanhBaoSapCan } from "@/lib/so-quy/du-bao-quy-queries";
import { demKhoanVayCoKyChoDuyet } from "@/lib/so-quy/khoan-vay-queries";

/**
 * Shared shell for every authenticated screen: guards the route with
 * `requireUser()` (redirects to /dang-nhap otherwise), then renders the
 * sidebar (240px) + top bar chrome around a max-width-1200px content area.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await requireUser("/");
  const [
    user,
    missingCostCount,
    lowStockWarning,
    dataErrorKinds,
    bronzeBacklog,
    trangThaiSaoLuu,
    mocGiaVon,
    soKhoanVayCoKyCho,
    mocPhieuNhap,
    canhBaoSapCanQuy,
  ] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { shopName: true } }),
    countMissingCostVariants(),
    hasLowStockVariants(),
    // CHỈ kind ảnh hưởng số liệu — BACKUP cố ý đứng ngoài nhánh này (nó có nhánh banner RIÊNG
    // ngay dưới, vì backup hỏng không làm thiếu số liệu), xem `NON_DATA_SYNC_KINDS`.
    getRecentDataErrorKinds(),
    hasBronzeBacklog(),
    // Sao lưu có nhánh banner riêng: bỏ BACKUP khỏi cảnh báo số liệu mà không đặt gì thay thế
    // thì một lượt backup hỏng chỉ còn dấu vết ở /cai-dat — chủ shop không vào đó mỗi ngày, mà
    // đây đúng là tín hiệu phải biết TRƯỚC khi cần tới bản phục hồi.
    docTrangThaiSaoLuu(),
    // Giá vốn: layout CHỈ đọc 2 ô `Setting` mà lượt đêm đã chốt. Việc đếm phải quét trọn Bronze
    // products nên TUYỆT ĐỐI không được chạy ở đây — mỗi lần mở bất kỳ trang nào là một lần quét.
    prisma.setting.findMany({
      where: { key: { in: [KEY_SO_LECH_GIA_VON, KEY_MOC_KIEM_GIA_VON] } },
      select: { key: true, value: true },
    }),
    // KHÁC giá vốn ở trên: phép đếm này BOUNDED theo số khoản vay (vài dòng) và không khoản nào
    // có lịch thì trả 0 ngay, khỏi đọc bảng dòng tiền — nên chạy thẳng ở layout được.
    demKhoanVayCoKyChoDuyet(),
    // Phiếu nhập: CÙNG luật với giá vốn — layout CHỈ đọc 3 ô `Setting` mà lượt đêm đã chốt. Phép
    // đếm phải quét trọn Bronze `RawPancakePurchase` (luật lọc nằm trong payload) nên chạy ở đây là
    // mỗi lần mở bất kỳ trang nào một lần quét.
    prisma.setting.findMany({
      where: {
        key: {
          in: [KEY_SO_PHIEU_NHAP_CHUA_GHI, KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP, KEY_MOC_KIEM_PHIEU_NHAP],
        },
      },
      select: { key: true, value: true },
    }),
    // Dự báo quỹ sắp cạn: layout đọc ở MỌI trang nên `docCanhBaoSapCan` tự bắt lỗi bên trong và trả
    // null khi hỏng (xem doc-comment của hàm) — layout không cần bọc thêm, chỉ cần biết nó KHÔNG BAO
    // GIỜ reject để không kéo sập `Promise.all` chung với các nguồn khác.
    docCanhBaoSapCan(),
  ]);

  const lechGiaVon = trangThaiLechGiaVon(
    mocGiaVon.find((s) => s.key === KEY_SO_LECH_GIA_VON)?.value,
    mocGiaVon.find((s) => s.key === KEY_MOC_KIEM_GIA_VON)?.value,
  );
  const phieuNhapChuaGhi = trangThaiPhieuNhapChuaGhi(
    mocPhieuNhap.find((s) => s.key === KEY_SO_PHIEU_NHAP_CHUA_GHI)?.value,
    mocPhieuNhap.find((s) => s.key === KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP)?.value,
    mocPhieuNhap.find((s) => s.key === KEY_MOC_KIEM_PHIEU_NHAP)?.value,
  );

  return (
    <DateRangeProvider>
      <ShellChrome
        shopName={user?.shopName ?? "HogiKids"}
        missingCostCount={missingCostCount}
        lowStockWarning={lowStockWarning}
        dataSyncHasError={dataErrorKinds.length > 0}
        syncHasBacklog={bronzeBacklog}
        saoLuuCoVanDe={saoLuuCanBaoDong(trangThaiSaoLuu.muc)}
        lechGiaVon={lechGiaVon}
        soKhoanVayCoKyCho={soKhoanVayCoKyCho}
        phieuNhapChuaGhi={phieuNhapChuaGhi}
        canhBaoSapCanQuy={canhBaoSapCanQuy}
      >
        {children}
      </ShellChrome>
    </DateRangeProvider>
  );
}
