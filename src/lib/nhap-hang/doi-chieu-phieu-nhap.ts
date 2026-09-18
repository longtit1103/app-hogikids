import { format, startOfDay } from "date-fns";

import { formatVnd } from "@/lib/format";
import { parseVnDate } from "@/lib/ingest/pancake-mapping";

/**
 * Logic THUẦN: đối chiếu "phiếu nhập hàng bên Pancake" ↔ "dòng Sổ chi phí app đã ghi".
 *
 * Vì sao tách khỏi phần đọc DB: đây là chỗ quyết định MỘT khoản tiền hàng chục triệu có được đề
 * xuất ghi vào Sổ chi phí hay không. Đo trên prod 17/09 chỉ có 184 phiếu, nên mọi luật lọc ở đây
 * đều kiểm được bằng payload thật (`tests/fixtures/pancake/phieu-nhap-sample.json`) mà không cần DB.
 *
 * Không có Silver cho phiếu nhập: app đọc thẳng Bronze rồi so bằng `Expense.refId`. Khoản nhập hàng
 * là DÒNG TIỀN (danh mục `purchase`) — KHÔNG vào P&L (bất biến #1), nên module này không đụng gì tới
 * doanh thu/COGS.
 */

/** Tiền đề: mọi `refId` app sinh cho phiếu nhập Pancake đều mang tiền tố này. */
export const TIEN_TO_REF_ID = "PANCAKE_PURCHASE:";

export function refIdChoPhieu(uuid: string): string {
  return `${TIEN_TO_REF_ID}${uuid}`;
}

/**
 * Phiếu nhập đã rút gọn từ payload Bronze.
 *
 * `status` giữ nguyên số Pancake (đo 17/09: chỉ có 1 và 2) vì luật hiệu lực đọc trực tiếp từ nó:
 * **2 = phiếu ĐÃ HUỶ**. Chứng minh: phiếu #173/#179 mang status=1 ở 5 bản fetch đầu rồi đổi sang 2,
 * và tồn thật của SKU thuộc phiếu #179 = 0 dù phiếu vẫn khai `remain_quantity` 30. Hệ quả:
 * `remain_quantity`/`total_remain_price` KHÔNG được Pancake cập nhật lúc huỷ ⇒ tuyệt đối không suy
 * hiệu lực từ chúng. `is_lock` null 184/184 ⇒ vô dụng.
 */
export type PhieuNhapPancake = {
  uuid: string;
  /** Số hiển thị Pancake. Dùng CHUNG dãy đếm với phiếu điều chỉnh kho ⇒ chỉ để hiện, KHÔNG làm khoá. */
  displayId: number | null;
  /** Đầu ngày VN của `inserted_at` (naive = giờ UTC — bất biến #3). */
  ngay: Date;
  /** `total_price` — lấy THẲNG, xem ghi chú `tongTuDongHang`. */
  soTien: number;
  /** Σ `quantity × imported_price` các dòng hàng — chỉ dùng làm LƯỚI KIỂM, không thay `soTien`. */
  tongTuDongHang: number;
  soLuong: number;
  soDongHang: number;
  nhaCungCap: string | null;
  ghiChu: string | null;
  status: number;
};

export type PhieuNhapDeXuat = {
  uuid: string;
  displayId: number | null;
  ngay: Date;
  soTien: number;
  soLuong: number;
  soDongHang: number;
  nhaCungCap: string | null;
  ghiChu: string | null;
  refId: string;
  /** `total_price` lệch Σ dòng hàng ⇒ màn duyệt phải kêu trước khi chủ shop bấm ghi. */
  lechLuoiKiem: boolean;
};

export type PhieuNhapDaGhi = {
  uuid: string;
  displayId: number | null;
  ngay: Date;
  /** Số tiền Pancake ĐANG khai (có thể đã đổi sau lúc app ghi sổ). */
  soTien: number;
  refId: string;
  expenseId: string;
  /** Số tiền dòng Sổ chi phí đang giữ. */
  soTienDaGhi: number;
  /** Trạng thái Pancake ĐANG khai — để màn hình nói được mã lạ là mã mấy. */
  status: number;
  /** Pancake đã huỷ phiếu (`status=2` — mã ĐÃ ĐO) nhưng sổ vẫn còn dòng chi ⇒ tiền khống. */
  daHuyBenPancake: boolean;
  /**
   * Status không phải 1 cũng không phải 2 ⇒ app KHÔNG biết phiếu còn hiệu lực hay không.
   * KHÁC hẳn `daHuyBenPancake`: ca này tuyệt đối không được khuyên xoá dòng chi (xem `STATUS_DA_HUY`).
   */
  trangThaiLa: boolean;
  lechTien: boolean;
  lechLuoiKiem: boolean;
};

/** Dòng Sổ chi phí đã sinh từ phiếu nhập Pancake — đủ để hậu kiểm huỷ/đổi tiền. */
export type ExpenseDaGhi = {
  id: string;
  refId: string;
  amount: number;
};

export type KetQuaDoiChieuPhieuNhap = {
  deXuat: PhieuNhapDeXuat[];
  daGhi: PhieuNhapDaGhi[];
  /** Phiếu hợp lệ nhưng có TRƯỚC ngày mở sổ ⇒ tiền đó đã nằm trong số dư mở sổ, không đề xuất lại. */
  boQuaTruocD0: { soPhieu: number; tongTien: number };
  /**
   * Số VIỆC PHẢI XỬ LÝ ngoài việc duyệt phiếu mới: phiếu đã ghi nay bị huỷ / đổi số tiền / mang
   * trạng thái lạ, cộng phiếu chưa ghi mang trạng thái lạ.
   *
   * VÌ SAO phải đếm riêng và phải đẩy lên dải nhắc việc: `canhBao` chỉ hiện trên màn
   * `/tai-chinh/chi-phi-nhap-hang`. Duyệt hết phiếu chờ là `deXuat.length` về 0, banner tắt, và
   * cảnh báo "phiếu đã ghi nay bị huỷ" chỉ còn ai TỰ NHỚ mở màn đó mới thấy — đúng cái bẫy
   * "quy trình dựa vào trí nhớ" mà `trang-thai-phieu-nhap.ts` sinh ra để chống. Ca này đã xảy ra
   * thật 2 lần trên prod (phiếu #173, #179 bị huỷ sau nhiều tháng).
   */
  soViecHauKiem: number;
  canhBao: string[];
};

/** Chỉ phiếu nhập hàng THẬT mới là chi phí; `adjust_warehouse` là điều chỉnh tồn (175/184 phiếu). */
const LOAI_PHIEU_NHAP_THAT = "actual_purchase";

function soNguyen(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Rút phiếu từ 1 payload Bronze; `null` = không phải phiếu nhập hàng thật hoặc payload hỏng.
 *
 * AN TOÀN int64 khi đọc payload qua Prisma (JSON.parse): phiếu nhập dùng uuid CHUỖI cho `id`, số
 * lớn nhất đo được là `supplier.id` 9 chữ số — không có số ≥16 chữ số để mất độ chính xác.
 */
export function rutPhieuTuPayload(payload: unknown): PhieuNhapPancake | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.created_type !== LOAI_PHIEU_NHAP_THAT) return null;

  const uuid = typeof p.id === "string" ? p.id : null;
  if (!uuid) return null;

  const ngayTho = typeof p.inserted_at === "string" ? parseVnDate(p.inserted_at) : new Date(NaN);
  if (Number.isNaN(ngayTho.getTime())) return null;

  const items = Array.isArray(p.items) ? p.items : [];
  let tongTuDongHang = 0;
  for (const it of items) {
    if (it === null || typeof it !== "object") continue;
    const dong = it as Record<string, unknown>;
    tongTuDongHang += soNguyen(dong.quantity) * soNguyen(dong.imported_price);
  }

  // `supplier` VẮNG HẲN khoá ở 181/184 payload (Pancake bỏ khoá chứ không để null) ⇒ optional chaining.
  const supplier = p.supplier;
  const tenNcc =
    supplier !== null && typeof supplier === "object" && typeof (supplier as Record<string, unknown>).name === "string"
      ? ((supplier as Record<string, unknown>).name as string)
      : null;

  return {
    uuid,
    displayId: typeof p.display_id === "number" ? p.display_id : null,
    ngay: startOfDay(ngayTho),
    // Tiền lấy THẲNG `total_price`. TUYỆT ĐỐI KHÔNG cộng `transport_fee`: Pancake đã phân bổ phí vận
    // chuyển vào `imported_price` từng dòng (đẳng thức dưới khớp 9/9 phiếu TỪNG ĐỒNG trong khi 6/9
    // phiếu có transport_fee > 0) — cộng thêm là đếm 2 lần. `discount`/`prepaid_debt` null 184/184;
    // `costs_incurred` là CHUỖI "0.0" 184/184 nên cũng không có gì để cộng.
    soTien: soNguyen(p.total_price),
    tongTuDongHang,
    soLuong: soNguyen(p.total_quantity),
    soDongHang: items.length,
    nhaCungCap: tenNcc,
    ghiChu: typeof p.note === "string" && p.note.trim() !== "" ? p.note : null,
    status: soNguyen(p.status),
  };
}

/**
 * HAI hằng số cho HAI nghĩa NGƯỢC NHAU — cố ý không dùng chung một mã.
 *
 * `status === 1` là điều kiện ĐỦ để coi phiếu còn hiệu lực (fail-closed cho tiền: mã lạ thì KHÔNG
 * đề xuất ghi). Nhưng suy ngược `status !== 1 ⇒ đã huỷ` là SAI và nguy: nếu Pancake thêm mã 3, phiếu
 * 59 triệu đã ghi đúng sẽ bị app khuyên "nên xoá dòng đó" ⇒ quỹ phồng 59 triệu. Nghĩa "đã huỷ" chỉ
 * được khẳng định với mã ĐO ĐƯỢC: #173/#179 đổi 1→2 và tồn thật của SKU thuộc #179 về 0.
 */
const STATUS_CON_HIEU_LUC = 1;
const STATUS_DA_HUY = 2;

function nhan(p: PhieuNhapPancake): string {
  return `#${p.displayId ?? p.uuid.slice(0, 8)} ngày ${format(p.ngay, "dd/MM/yyyy")}`;
}

/**
 * Ghép phiếu Pancake với dòng Sổ chi phí đã ghi.
 *
 * Luật lọc chốt với chủ shop: `created_type='actual_purchase'` AND `status=1` AND ngày VN ≥ D0.
 * `d0 = null` (chưa mở sổ quỹ) ⇒ KHÔNG chặn theo ngày: chưa có mốc thì không có "đã nằm trong số dư
 * mở sổ" để mà trừ bớt.
 *
 * Phiếu ĐÃ ghi sổ luôn được hậu kiểm bất kể ngày/trạng thái — hai ca dưới đã xảy ra thật trên prod
 * và cả hai đều để lại tiền SAI trong sổ nếu không ai soi lại.
 */
export function doiChieuPhieuNhap(args: {
  phieu: PhieuNhapPancake[];
  expense: ExpenseDaGhi[];
  d0: Date | null;
}): KetQuaDoiChieuPhieuNhap {
  const { phieu, expense, d0 } = args;
  const theoRefId = new Map(expense.map((e) => [e.refId, e]));
  const moSo = d0 === null ? null : startOfDay(d0);

  const deXuat: PhieuNhapDeXuat[] = [];
  const daGhi: PhieuNhapDaGhi[] = [];
  const canhBao: string[] = [];
  let boQuaSo = 0;
  let boQuaTien = 0;
  let soViecHauKiem = 0;
  // Phiếu CHƯA ghi sổ mang trạng thái app không hiểu — gom lại để nói MỘT câu mỗi mã lạ thay vì
  // rải mỗi phiếu một dòng (Pancake đổi bảng mã là đổi cả loạt phiếu cùng lúc).
  const laTheoMa = new Map<number, { soPhieu: number; tongTien: number }>();

  // Cũ → mới: màn duyệt đọc theo thứ tự thời gian, và cảnh báo cũng xếp cùng thứ tự đó.
  const sapXep = [...phieu].sort((a, b) => a.ngay.getTime() - b.ngay.getTime() || a.uuid.localeCompare(b.uuid));

  for (const p of sapXep) {
    const refId = refIdChoPhieu(p.uuid);
    const da = theoRefId.get(refId);
    // Lưới kiểm tiền: lệch thì CẢNH BÁO nhưng VẪN dùng `total_price` — luật repo là không đoán lại
    // số khi dữ liệu nguồn tự mâu thuẫn.
    const lechLuoiKiem = p.soTien !== p.tongTuDongHang;
    if (lechLuoiKiem) {
      canhBao.push(
        `Phiếu ${nhan(p)}: Pancake khai tổng ${formatVnd(p.soTien)} nhưng cộng các dòng hàng ra ` +
          `${formatVnd(p.tongTuDongHang)} (lệch ${formatVnd(p.soTien - p.tongTuDongHang)}) — kiểm lại bên Pancake trước khi ghi sổ.`,
      );
    }

    if (da) {
      const daHuyBenPancake = p.status === STATUS_DA_HUY;
      const trangThaiLa = p.status !== STATUS_CON_HIEU_LUC && p.status !== STATUS_DA_HUY;
      const lechTien = p.soTien !== da.amount;
      if (daHuyBenPancake) {
        canhBao.push(
          `Phiếu ${nhan(p)} đã bị huỷ bên Pancake nhưng Sổ chi phí vẫn còn dòng ${formatVnd(da.amount)} — nên xoá dòng đó.`,
        );
      }
      if (trangThaiLa) {
        // KHÔNG khuyên xoá: app không biết mã này nghĩa gì, mà dòng chi có thể đang ĐÚNG. Khuyên
        // sai ở đây là chủ shop xoá một khoản chi thật ⇒ quỹ phồng đúng bằng số tiền đó.
        canhBao.push(
          `Phiếu ${nhan(p)} mang trạng thái app chưa biết (mã ${p.status}) — Sổ chi phí đang giữ dòng ` +
            `${formatVnd(da.amount)}. Kiểm tra bên Pancake xem phiếu còn hiệu lực không; app không tự đoán nên giữ nguyên dòng chi.`,
        );
      }
      if (lechTien) {
        canhBao.push(
          `Phiếu ${nhan(p)} đã đổi số tiền bên Pancake: sổ đang ghi ${formatVnd(da.amount)}, ` +
            `Pancake hiện khai ${formatVnd(p.soTien)} — sửa lại dòng chi phí cho khớp.`,
        );
      }
      if (daHuyBenPancake || trangThaiLa || lechTien) soViecHauKiem += 1;
      daGhi.push({
        uuid: p.uuid,
        displayId: p.displayId,
        ngay: p.ngay,
        soTien: p.soTien,
        refId,
        expenseId: da.id,
        soTienDaGhi: da.amount,
        status: p.status,
        daHuyBenPancake,
        trangThaiLa,
        lechTien,
        lechLuoiKiem,
      });
      continue;
    }

    // Phiếu huỷ mà chưa ai ghi sổ: không có tiền sai ở đâu cả ⇒ bỏ lặng, đừng làm ồn màn duyệt.
    if (p.status === STATUS_DA_HUY) continue;

    if (p.status !== STATUS_CON_HIEU_LUC) {
      // Mã lạ ⇒ KHÔNG đề xuất ghi (fail-closed cho tiền) nhưng cũng KHÔNG im: trước đây `continue`
      // trần làm một phiếu 80 triệu biến mất khỏi cả đề xuất lẫn cảnh báo, trong khi màn hình vẫn in
      // "mọi phiếu nhập bên Pancake đều đã có trong Sổ chi phí".
      //
      // Trước D0 thì bỏ qua thật: tiền đó đã nằm trong số dư mở sổ nên không có việc gì để làm.
      if (moSo === null || p.ngay >= moSo) {
        const cu = laTheoMa.get(p.status) ?? { soPhieu: 0, tongTien: 0 };
        laTheoMa.set(p.status, { soPhieu: cu.soPhieu + 1, tongTien: cu.tongTien + p.soTien });
        soViecHauKiem += 1;
      }
      continue;
    }

    if (moSo !== null && p.ngay < moSo) {
      boQuaSo += 1;
      boQuaTien += p.soTien;
      continue;
    }

    deXuat.push({
      uuid: p.uuid,
      displayId: p.displayId,
      ngay: p.ngay,
      soTien: p.soTien,
      soLuong: p.soLuong,
      soDongHang: p.soDongHang,
      nhaCungCap: p.nhaCungCap,
      ghiChu: p.ghiChu,
      refId,
      lechLuoiKiem,
    });
  }

  // Câu gộp xếp CUỐI: mỗi mã lạ một dòng, kèm tổng tiền để chủ shop biết đang treo bao nhiêu.
  for (const [ma, gop] of [...laTheoMa.entries()].sort((a, b) => a[0] - b[0])) {
    canhBao.push(
      `Có ${gop.soPhieu} phiếu nhập mang trạng thái app chưa biết (mã ${ma}), tổng ${formatVnd(gop.tongTien)} — ` +
        `chưa ghi vào Sổ chi phí. Kiểm tra bên Pancake rồi ghi tay nếu đó là khoản đã chi.`,
    );
  }

  return {
    deXuat,
    daGhi,
    boQuaTruocD0: { soPhieu: boQuaSo, tongTien: boQuaTien },
    soViecHauKiem,
    canhBao,
  };
}

/**
 * DẤU VÂN TAY của danh sách đề xuất — để "duyệt cái gì thì ghi đúng cái đó".
 *
 * Cùng lý do với `vanTayDeXuat` bên giá vốn (đo 07/09 lệch 9,25 lần): màn duyệt đọc đề xuất lúc
 * render, lượt ghi đọc LẠI lúc bấm. Giữa hai mốc chỉ cần một ảnh Bronze mới land (lượt đêm 03:00)
 * là hai tập khác nhau — chủ shop xem 4 phiếu rồi bấm, app ghi 5 phiếu, không câu nào báo. Ở đây
 * hậu quả nặng hơn giá vốn: mỗi phiếu là hàng chục triệu ĐỒNG trừ thẳng vào quỹ.
 *
 * Gồm cả BĂM UUID chứ không chỉ số dòng + tổng tiền: hai phiếu khác nhau cùng số tiền (lô nhập lặp
 * lại cùng nhà cung cấp là chuyện thường) sẽ cho cùng tổng — thiếu băm thì tráo phiếu không bị bắt.
 * Băm phụ thuộc THỨ TỰ, và thứ tự ấy tất định vì `doiChieuPhieuNhap` luôn sắp theo (ngày, uuid).
 *
 * Không cần chống giả mạo: danh sách do server tự đọc, client không soạn được — chỉ cần phát hiện
 * "đã đổi" để bắt tải lại trang.
 */
export function vanTayDeXuatPhieuNhap(deXuat: PhieuNhapDeXuat[]): string {
  let tongTien = 0;
  let bam = 0;
  for (const d of deXuat) {
    tongTien += d.soTien;
    for (let i = 0; i < d.uuid.length; i += 1) {
      // Băm chuỗi kiểu Java `hashCode` nhưng kẹp trong int32 dương để kết quả tất định trên mọi
      // máy (số JS vượt 2^53 sẽ mất độ chính xác ⇒ hai lượt chạy có thể ra khác nhau).
      bam = (bam * 31 + d.uuid.charCodeAt(i)) % 2_147_483_647;
    }
  }
  return `${deXuat.length}:${tongTien}:${bam}`;
}
