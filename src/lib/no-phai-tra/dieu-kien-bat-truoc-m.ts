import { format } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";
import type { LoiDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { formatVnd } from "@/lib/format";
import { dsLaiKyChuaCapNhapGocTruocM } from "@/lib/so-quy/cap-lai-nhap-goc";
import { dsKyChoTruocM, dsTienGuiChuaTatToanTruocM } from "@/lib/so-quy/khoan-vay-queries";
import { docDinhKyChuaGhiTruocM } from "@/lib/so-quy/so-quy-queries";

/**
 * Điều kiện bật nợ phải trả về TIỀN TRƯỚC NGÀY BẬT (tách khỏi `dieu-kien-bat-no-phai-tra.ts` cho file đó gọn).
 * Sau khi bật, mọi lượt ghi tiền ngày < M bị khoá (quỹ cuối M − 1 đã chốt bằng điều chỉnh ngày bật) ⇒ những khoản
 * tiền trước M mà app BIẾT là còn treo phải dọn TRƯỚC bật, không thì sau bật hoặc không ghi được nữa, hoặc (nguồn
 * máy) ghi vào trước M làm quỹ trôi khỏi tiền thật:
 *  - `CON_KY_VAY_TRUOC_M`: kỳ khoản vay (kỳ hạn / gốc cuối kỳ / lãi tháng thấu chi) đến hạn trong [ngày mở sổ, M)
 *    chưa duyệt hoặc chưa đóng dấu "không thu" — duyệt kỳ ghi tiền đúng NGÀY ĐẾN HẠN. Kỳ trước ngày mở sổ KHÔNG
 *    chặn (ngoài quỹ, tiền đã nằm trong số dư mở sổ — `dsKyChoTruocM`).
 *  - `CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M`: khoản vay đã trả hết gốc, kỳ cuối < M, ngân hàng còn giữ tiền gửi bắt
 *    buộc mà chưa tất toán — sau bật tất toán ngày < M bị khoá, ngày ≥ M là đếm tiền gửi hai lần
 *    (`dsTienGuiChuaTatToanTruocM`).
 *  - `CON_DINH_KY_CHUA_GHI_TRUOC_M`: lần đến hạn của mẫu chi định kỳ đang chạy trong [ngày mở sổ, M − 1] chưa có
 *    dòng — bộ sinh chạy lười (khi mở tháng), sau bật nó bỏ qua lần đến hạn < M.
 *  - `CON_SO_TIET_KIEM_DAO_HAN_TRUOC_M`: sổ tiết kiệm đáo hạn < M chưa tất toán — tất toán ghi gốc + lãi đúng ngày
 *    nhận tiền.
 *  - `CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M`: khoản thấu chi đang "lãi nhập gốc" còn dòng lãi kỳ trong [ngày mở sổ, M)
 *    duyệt kiểu cũ (trừ tài khoản, không có dòng `LAI_NHAP_GOC` đi cặp — `dsLaiKyChuaCapNhapGocTruocM`). Sau bật,
 *    dòng `LAI_NHAP_GOC` ngày < M bị khoá, thấu chi rút trước M khoá hẳn, `LOAN_IN` tối đa một ⇒ không còn đường
 *    nào cộng số lãi đó vào dư nợ: dư nợ thấu chi thiếu đúng số lãi vĩnh viễn, và quỹ app thấp hơn ngân hàng đúng
 *    số đó bị điều chỉnh ngày bật nuốt như chênh "chưa giải thích".
 * Ví Shopee (nhập tay từ file) KHÔNG phải điều kiện chặn: chủ shop import file ví lúc nào cũng được. Dữ liệu ví chưa
 * phủ tới M chỉ thành NHẮC (`docNhacTruocBat`, không nằm trong danh sách lỗi của `kiemDieuKienTruocM`): lần rút ví
 * trước M import muộn làm quỹ trước M đổi ⇒ mục "Trôi quỹ trước ngày bật" hiện chênh, khi đó sửa dòng điều chỉnh
 * mở sổ cho khớp.
 * Không gọi bộ sinh định kỳ ở đây: hàm này chạy cả trong transaction bước bật (giữ khoá EXCLUSIVE) còn bộ sinh lấy
 * khoá SHARED ⇒ tự chặn mình tới hết hạn.
 */

export type NhacTruocBat = { code: "VI_SHOPEE_CHUA_PHU_TOI_M"; message: string };

export type DbDieuKienTruocM = Pick<
  Prisma.TransactionClient,
  "loan" | "cashMovement" | "recurringExpense" | "expense" | "soTietKiem"
>;

export type DbNhacTruocBat = Pick<Prisma.TransactionClient, "shopeeSettlement" | "order">;

const nhanNgay = (d: Date) => format(d, "dd/MM/yyyy");
const nhanKhoa = (khoa: string) => khoa.split("-").reverse().join("/");

export async function kiemDieuKienTruocM(
  p: { mocM: Date; d0: Date | null },
  db: DbDieuKienTruocM
): Promise<LoiDieuKienBat[]> {
  const khoaM = khoaNgayVn(p.mocM);
  const dauNgayM = new Date(`${khoaM}T00:00:00+07:00`);
  const nhanM = nhanKhoa(khoaM);
  const nhanD0 = p.d0 === null ? "" : nhanNgay(p.d0);

  const [kyVay, tienGuiTreo, dinhKy, soTietKiem, laiChuaCap] = await Promise.all([
    dsKyChoTruocM(p.mocM, p.d0, db),
    dsTienGuiChuaTatToanTruocM(p.mocM, db),
    docDinhKyChuaGhiTruocM(p.mocM, p.d0, db),
    db.soTietKiem.findMany({
      where: { closedAt: null, maturityDate: { lt: dauNgayM } },
      select: { id: true, name: true, bank: true, maturityDate: true },
      orderBy: [{ maturityDate: "asc" }, { id: "asc" }],
    }),
    dsLaiKyChuaCapNhapGocTruocM(p, db),
  ]);

  const loi: LoiDieuKienBat[] = [];
  if (kyVay.length > 0) {
    loi.push({
      code: "CON_KY_VAY_TRUOC_M",
      message:
        `${kyVay.map((k) => `Khoản "${k.ten}" còn kỳ ${nhanKhoa(k.khoaNgayKy)} chưa duyệt`).join("; ")} (đến hạn ` +
        `từ ngày mở sổ ${nhanD0} tới trước ngày bật ${nhanM}) — ở Sổ quỹ, khối Khoản vay: duyệt kỳ (ghi ĐÚNG số ` +
        `tiền đã trả) hoặc "Ngân hàng không thu kỳ này" nếu ngân hàng thật sự không thu, trước khi bật: sau khi ` +
        "bật, kỳ trước ngày bật không ghi tiền được nữa. Bảng còn hiện kỳ TRƯỚC ngày mở sổ thì chọn \"Ngân hàng " +
        "không thu kỳ này\" cho kỳ đó — tiền kỳ đó đã nằm trong số dư mở sổ, duyệt có tiền là kéo lùi ngày mở sổ",
      kyVayTruocM: kyVay,
    });
  }

  if (tienGuiTreo.length > 0) {
    const ds = tienGuiTreo.map(
      (k) => `"${k.ten}" (kỳ cuối ${nhanKhoa(k.khoaNgayKyCuoi)}, tiền gửi ${formatVnd(k.tienGui)})`
    );
    loi.push({
      code: "CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M",
      message:
        `Khoản vay đã trả hết gốc, kỳ cuối trước ngày bật ${nhanM}, nhưng còn tiền gửi bắt buộc chưa tất toán: ` +
        `${ds.join("; ")} — tất toán ở Sổ quỹ, khối Khoản vay (ngày tất toán = ngày ngân hàng hoàn / cấn trừ ` +
        "tiền gửi) TRƯỚC khi bật: sau khi bật, tất toán đề ngày trước ngày bật không ghi được nữa, còn đề ngày " +
        "từ ngày bật trở đi là đếm tiền gửi hai lần (tiền ngân hàng hoàn trước ngày bật đã nằm trong số dư mở sổ)",
    });
  }

  if (dinhKy.soKhoan > 0 && dinhKy.khoang !== null) {
    loi.push({
      code: "CON_DINH_KY_CHUA_GHI_TRUOC_M",
      message:
        `${dinhKy.soKhoan} lần chi định kỳ đến hạn trước ngày bật ${nhanM} chưa ghi vào Sổ chi phí (tháng ` +
        `${dinhKy.thang.join(", ")}) — mở Sổ chi phí đúng các tháng đó để app tự ghi bù rồi mới bật: sau khi bật, ` +
        "lần đến hạn trước ngày bật không được ghi bù nữa. Tháng nào CỐ Ý không chi khoản đó (vd đã xoá dòng) thì " +
        "ĐỪNG mở tháng — mở là app sinh lại đúng dòng đã xoá: dừng mẫu định kỳ đó (hoặc bật lại với tháng bắt đầu " +
        "sau tháng bỏ chi) rồi mới bật",
      dinhKyTruocM: {
        soKhoan: dinhKy.soKhoan,
        thang: dinhKy.thang,
        khoaTu: khoaNgayVn(dinhKy.khoang.from),
        khoaDen: khoaNgayVn(dinhKy.khoang.to),
      },
    });
  }

  if (soTietKiem.length > 0) {
    const ds = soTietKiem.map(
      (s) => `"${s.name}"${s.bank === "" ? "" : ` (${s.bank})`} đáo hạn ${nhanNgay(s.maturityDate)}`
    );
    loi.push({
      code: "CON_SO_TIET_KIEM_DAO_HAN_TRUOC_M",
      message:
        `Sổ tiết kiệm đáo hạn trước ngày bật ${nhanM} chưa tất toán: ${ds.join("; ")} — tất toán đúng ngày nhận ` +
        "tiền, hoặc sửa ngày đáo hạn nếu ngân hàng THẬT SỰ tự gia hạn, rồi mới bật: sau khi bật, tiền gốc và lãi " +
        "trước ngày bật không ghi được nữa",
    });
  }

  if (laiChuaCap.length > 0) {
    const ds = laiChuaCap.map((k) => `khoản "${k.ten}" kỳ ${nhanKhoa(k.khoaNgayKy)} lãi ${formatVnd(k.amount)}`);
    loi.push({
      code: "CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M",
      message:
        `Khoản thấu chi đang để "lãi nhập gốc" còn kỳ lãi trước ngày bật ${nhanM} ghi kiểu trừ tài khoản (chưa ` +
        `cộng vào dư nợ): ${ds.join("; ")} — chuyển kỳ đó sang lãi nhập gốc trước khi bật: sau khi bật, dòng tiền ` +
        "trước ngày bật khoá, dư nợ thấu chi thiếu đúng số lãi đó mãi mãi. Nếu kỳ đó ngân hàng THẬT SỰ trừ tài " +
        'khoản (chỉ đổi sang nhập gốc từ kỳ sau) thì tạm bỏ ô "lãi nhập gốc" của khoản, bật, rồi tích lại ô',
    });
  }

  return loi;
}

/**
 * NHẮC (không chặn bật) khi dữ liệu ví Shopee chưa phủ tới M. Giữ đúng phép phát hiện cũ: đã có ví mà giao dịch
 * mới nhất (ngày VN) < M; hoặc CHƯA từng import ví mà shop có đơn Shopee trước M (shop bán Shopee thì có rút ví);
 * không đơn Shopee nào trước M ⇒ không có ví để phủ, không nhắc. Chỉ đọc, không đổi gì.
 */
export async function docNhacTruocBat(mocM: Date, db: DbNhacTruocBat): Promise<NhacTruocBat[]> {
  const khoaM = khoaNgayVn(mocM);
  const dauNgayM = new Date(`${khoaM}T00:00:00+07:00`);
  const [viShopee, soDonShopeeTruocM] = await Promise.all([
    db.shopeeSettlement.aggregate({ _count: { _all: true }, _max: { txnTime: true } }),
    db.order.count({ where: { channelId: "shopee", orderedAt: { lt: dauNgayM } } }),
  ]);
  const cachXuLy =
    "không chặn bật. Nếu sau này import ví có lần rút tiền trước ngày bật, mục 'Trôi quỹ trước ngày bật' sẽ hiện " +
    "chênh; khi đó sửa dòng điều chỉnh mở sổ cho khớp.";
  const viToiNgay = viShopee._max.txnTime;
  if (viToiNgay !== null && khoaNgayVn(viToiNgay) < khoaM) {
    return [
      {
        code: "VI_SHOPEE_CHUA_PHU_TOI_M",
        message: `Dữ liệu ví Shopee mới tới ${format(viToiNgay, "dd/MM")} — ${cachXuLy}`,
      },
    ];
  }
  if (viShopee._count._all === 0 && soDonShopeeTruocM > 0) {
    return [
      {
        code: "VI_SHOPEE_CHUA_PHU_TOI_M",
        message: `Chưa import dữ liệu ví Shopee nào (shop có đơn Shopee trước ngày bật) — ${cachXuLy}`,
      },
    ];
  }
  return [];
}
