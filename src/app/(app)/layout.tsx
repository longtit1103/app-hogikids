import { ShellChrome } from "@/components/shell/shell-chrome";
import { hrefDuocPhep } from "@/components/shell/nav-config";
import { DateRangeProvider } from "@/components/shell/date-range-provider";
import { docDauLuiBan } from "@/lib/backup/dau-lui-ban";
import { docTrangThaiSaoLuu } from "@/lib/backup/doc-trang-thai-sao-luu";
import { saoLuuCanBaoDong } from "@/lib/backup/trang-thai-sao-luu";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { chuanHoaLuaChonDaLuu } from "@/lib/date-range-cookie";
import { docLuaChonDaLuu } from "@/lib/date-range-cookie-server";
import {
  KEY_MOC_KIEM_GIA_VON,
  KEY_SO_LECH_GIA_VON,
  trangThaiLechGiaVon,
  type TrangThaiLechGiaVon,
} from "@/lib/gia-von/trang-thai-lech-gia-von";
import {
  KEY_MOC_KIEM_PHIEU_NHAP,
  KEY_SO_PHIEU_NHAP_CHUA_GHI,
  KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP,
  trangThaiPhieuNhapChuaGhi,
  type TrangThaiPhieuNhap,
} from "@/lib/nhap-hang/trang-thai-phieu-nhap";
import { countMissingCostVariants, hasLowStockVariants } from "@/lib/queries/variants";
import { getRecentDataErrorKinds } from "@/lib/queries/sync-health";
import { prisma } from "@/lib/prisma";
import { coQuyen, laChuShop } from "@/lib/quyen/nguoi-dung-phien";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { docShopProfile } from "@/lib/shop-profile/doc-shop-profile";
import { docCanhBaoSapCan } from "@/lib/so-quy/du-bao-quy-queries";
import { demKhoanVayCoKyChoDuyet } from "@/lib/so-quy/khoan-vay-queries";

/**
 * Shared shell for every authenticated screen: guards the route with `yeuCauQuyenTrang("/")` (chỉ
 * đòi đăng nhập — KHÔNG đòi quyền module, vì `/khong-co-quyen` cũng nằm trong shell này và đòi quyền
 * ở đây sẽ thành vòng lặp chuyển hướng), rồi dựng sidebar + top bar. Mọi nguồn cảnh báo chỉ tải khi
 * người dùng CÓ quyền xem khối đó: không tải thì cũng không lộ số (giá vốn, quỹ, sao lưu) qua banner.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const nd = await yeuCauQuyenTrang("/");
  const coGiaVon = coQuyen(nd, "san-pham:xem") && coQuyen(nd, "gia-von-loi-nhuan:xem");
  const coCaiDat = coQuyen(nd, "cai-dat:xem");
  const coSoQuy = coQuyen(nd, "tai-chinh-so-quy:xem");
  // Lựa chọn khoảng ngày đã lưu (cookie, đã kiểm hình) — cùng nguồn 6 trang dùng để dựng số liệu,
  // truyền xuống bộ chọn để nhãn không lệch số (#254).
  const luaChonDaLuu = await docLuaChonDaLuu();
  const [
    shop,
    missingCostCount,
    lowStockWarning,
    dataErrorKinds,
    bronzeBacklog,
    trangThaiSaoLuu,
    mocGiaVon,
    soKhoanVayCoKyCho,
    mocPhieuNhap,
    canhBaoSapCanQuy,
    dangLuiBanTu,
  ] = await Promise.all([
    docShopProfile(),
    coGiaVon ? countMissingCostVariants() : Promise.resolve(0),
    coQuyen(nd, "ton-kho:xem") ? hasLowStockVariants() : Promise.resolve(false),
    // CHỈ kind ảnh hưởng số liệu — BACKUP cố ý đứng ngoài nhánh này (nó có nhánh banner RIÊNG
    // ngay dưới, vì backup hỏng không làm thiếu số liệu), xem `NON_DATA_SYNC_KINDS`.
    coCaiDat ? getRecentDataErrorKinds() : Promise.resolve([]),
    coCaiDat ? hasBronzeBacklog() : Promise.resolve(false),
    // Sao lưu có nhánh banner riêng: bỏ BACKUP khỏi cảnh báo số liệu mà không đặt gì thay thế
    // thì một lượt backup hỏng chỉ còn dấu vết ở /cai-dat — chủ shop không vào đó mỗi ngày, mà
    // đây đúng là tín hiệu phải biết TRƯỚC khi cần tới bản phục hồi.
    // Sao lưu/phục hồi là việc riêng của chủ shop ⇒ chỉ OWNER nạp trạng thái.
    laChuShop(nd) ? docTrangThaiSaoLuu() : Promise.resolve(null),
    // Giá vốn: layout CHỈ đọc 2 ô `Setting` mà lượt đêm đã chốt. Việc đếm phải quét trọn Bronze
    // products nên TUYỆT ĐỐI không được chạy ở đây — mỗi lần mở bất kỳ trang nào là một lần quét.
    coGiaVon
      ? prisma.setting.findMany({
          where: { key: { in: [KEY_SO_LECH_GIA_VON, KEY_MOC_KIEM_GIA_VON] } },
          select: { key: true, value: true },
        })
      : Promise.resolve([]),
    // KHÁC giá vốn ở trên: phép đếm này BOUNDED theo số khoản vay (vài dòng) và không khoản nào
    // có lịch thì trả 0 ngay, khỏi đọc bảng dòng tiền — nên chạy thẳng ở layout được.
    coSoQuy ? demKhoanVayCoKyChoDuyet() : Promise.resolve(0),
    // Phiếu nhập: CÙNG luật với giá vốn — layout CHỈ đọc 3 ô `Setting` mà lượt đêm đã chốt. Phép
    // đếm phải quét trọn Bronze `RawPancakePurchase` (luật lọc nằm trong payload) nên chạy ở đây là
    // mỗi lần mở bất kỳ trang nào một lần quét.
    coQuyen(nd, "chi-phi:xem")
      ? prisma.setting.findMany({
          where: {
            key: {
              in: [
                KEY_SO_PHIEU_NHAP_CHUA_GHI,
                KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP,
                KEY_MOC_KIEM_PHIEU_NHAP,
              ],
            },
          },
          select: { key: true, value: true },
        })
      : Promise.resolve([]),
    // Dự báo quỹ sắp cạn: layout đọc ở MỌI trang nên `docCanhBaoSapCan` tự bắt lỗi bên trong và trả
    // null khi hỏng (xem doc-comment của hàm) — layout không cần bọc thêm, chỉ cần biết nó KHÔNG BAO
    // GIỜ reject để không kéo sập `Promise.all` chung với các nguồn khác.
    coSoQuy ? docCanhBaoSapCan() : Promise.resolve(null),
    // Dấu lùi bản phân quyền: việc của người vận hành máy chủ (chủ shop) ⇒ chỉ OWNER đọc — 1 dòng
    // `Setting` theo khoá chính.
    laChuShop(nd) ? docDauLuiBan() : Promise.resolve(null),
  ]);

  // Không có quyền ⇒ không tải ô Setting ⇒ KHÔNG được suy trạng thái từ dữ liệu rỗng (rỗng = mức
  // "chua-kiem" và sẽ in banner "chưa đối chiếu" cho người không được thấy khối này).
  const lechGiaVon: TrangThaiLechGiaVon = coGiaVon
    ? trangThaiLechGiaVon(
        mocGiaVon.find((s) => s.key === KEY_SO_LECH_GIA_VON)?.value,
        mocGiaVon.find((s) => s.key === KEY_MOC_KIEM_GIA_VON)?.value,
      )
    : { soLech: 0, mocLuc: null, gioTruoc: null, muc: "khop" };
  const phieuNhapChuaGhi: TrangThaiPhieuNhap = coQuyen(nd, "chi-phi:xem")
    ? trangThaiPhieuNhapChuaGhi(
        mocPhieuNhap.find((s) => s.key === KEY_SO_PHIEU_NHAP_CHUA_GHI)?.value,
        mocPhieuNhap.find((s) => s.key === KEY_SO_VIEC_HAU_KIEM_PHIEU_NHAP)?.value,
        mocPhieuNhap.find((s) => s.key === KEY_MOC_KIEM_PHIEU_NHAP)?.value,
      )
    : { soChoDuyet: 0, soViecHauKiem: 0, mocLuc: null, muc: "khop" };

  return (
    <DateRangeProvider luaChonDaLuu={luaChonDaLuu ? chuanHoaLuaChonDaLuu(luaChonDaLuu) : null}>
      <ShellChrome
        shopName={shop.shopName}
        missingCostCount={missingCostCount}
        lowStockWarning={lowStockWarning}
        dataSyncHasError={dataErrorKinds.length > 0}
        syncHasBacklog={bronzeBacklog}
        saoLuuCoVanDe={trangThaiSaoLuu ? saoLuuCanBaoDong(trangThaiSaoLuu.muc) : false}
        lechGiaVon={lechGiaVon}
        soKhoanVayCoKyCho={soKhoanVayCoKyCho}
        phieuNhapChuaGhi={phieuNhapChuaGhi}
        canhBaoSapCanQuy={canhBaoSapCanQuy}
        hrefDuocPhep={hrefDuocPhep(nd)}
        nguoiDung={{ email: nd.email, tenHienThi: nd.tenHienThi }}
        choPhepDongBo={coQuyen(nd, "cai-dat:sua")}
        choPhepDuyetGiaVon={coQuyen(nd, "san-pham:sua") && coGiaVon}
        dangLuiBanTu={dangLuiBanTu}
      >
        {children}
      </ShellChrome>
    </DateRangeProvider>
  );
}
