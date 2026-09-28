import type { ParsedWalletRow } from "@/lib/import/shopee-wallet-xlsx";

/**
 * CỔNG CHẶN file ví Shopee bị XUẤT THIẾU dòng (thường do lọc "Loại giao dịch" ở màn xuất).
 *
 * Vì sao cần: đo trên file thật 2026-08-13 (kỳ 01–31/05, xuất 2 lần — một lần "Tất cả",
 * một lần lọc chỉ "Doanh Thu Đơn Hàng") cho thấy Shopee TÍNH LẠI block "Tóm tắt" theo bộ
 * lọc, nên cổng checksum (so Σ dòng với Tóm tắt của CHÍNH file đó) khớp hoàn hảo trên file
 * thiếu — "Tiền đã về" hụt trong im lặng. Preamble hai file giống hệt nhau, không một dòng
 * nào ghi bộ lọc ⇒ không có metadata để đọc.
 *
 * Tín hiệu THẬT còn lại nằm ở cột "Số dư Ví sau giao dịch": Shopee KHÔNG tính lại số dư
 * theo bộ lọc (số dư là thuộc tính lịch sử của từng giao dịch — file lọc giữ nguyên số dư
 * của file đủ, đo được trên cùng cặp file). Trong file ĐỦ, đi theo thời gian thì
 *   soDu(sau nhóm t) = soDu(sau nhóm t−1) + Σ tiền(nhóm t)
 * đúng ở mọi nhóm (file "Tất cả" tháng 5: 8/8 nhóm khớp). File bị lọc ĐỨT GÃY tại đúng chỗ
 * giao dịch bị loại (file lọc: gãy 2/6 — đúng vị trí WITHDRAWAL + ADJUSTMENT biến mất).
 *
 * Nhóm theo TỪNG mốc giây (txnTime) và chỉ so ở BIÊN nhóm: hai dòng cùng giây không có thứ
 * tự tin được, nhưng tổng tiền của cả nhóm với số dư hai đầu thì bất biến với mọi hoán vị.
 *
 * GIỚI HẠN (chấp nhận, ghi để khỏi ngộ nhận):
 *  - Dòng CŨ NHẤT của file không kiểm được (không biết số dư trước kỳ) ⇒ bộ lọc cắt đúng
 *    một đoạn LIỀN ở biên kỳ (đầu hoặc cuối) mà không tạo lỗ ở giữa thì không bắt được.
 *    Lọc theo LOẠI giao dịch — ca thật — rải rác giữa kỳ nên tạo lỗ giữa chuỗi.
 *  - Guard TỰ RÚT LUI (trả `boQuaViSao`, không chặn) khi thiếu dữ liệu để kiểm chắc chắn:
 *    file không có cột số dư, có trạng thái giao dịch lạ (không rõ có đổi số dư không),
 *    hoặc thứ tự dòng không đơn điệu theo thời gian. Rút lui phải KÊU (caller đẩy vào
 *    warnings) — mất lưới an toàn trong im lặng là đúng lớp lỗi mà guard này sinh ra để bắt.
 */
export type KetQuaKiemSoDu = {
  /** Mỗi phần tử = một chỗ đứt gãy, mô tả đủ để chủ shop đối chiếu với file. */
  gay: string[];
  /** Khác null = không đủ dữ liệu để kiểm ⇒ KHÔNG chặn, nhưng caller phải cảnh báo. */
  boQuaViSao: string | null;
};

/** Trạng thái duy nhất đã thấy trên file thật — dòng trạng thái khác có thể chưa đổi số dư. */
const TRANG_THAI_DA_BIET = "giao dich thanh cong";

const boDau = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .trim()
    .toLowerCase();

export function timGaySoDuVi(rows: ParsedWalletRow[], coCotSoDu: boolean): KetQuaKiemSoDu {
  if (!coCotSoDu) {
    return { gay: [], boQuaViSao: "file không có cột 'Số dư Ví sau giao dịch'" };
  }
  const trangThaiLa = rows.find((r) => boDau(r.status) !== TRANG_THAI_DA_BIET);
  if (trangThaiLa) {
    return {
      gay: [],
      boQuaViSao: `có giao dịch trạng thái "${trangThaiLa.status}" — chưa rõ có đổi số dư ví không`,
    };
  }

  // Nhóm các dòng CÙNG mốc giây, GIỮ nguyên thứ tự xuất hiện trong file.
  type Nhom = { txnTime: string; tong: number; soDuDongDau: number; soDuDongCuoi: number };
  const nhom: Nhom[] = [];
  for (const r of rows) {
    const cuoi = nhom[nhom.length - 1];
    if (cuoi && cuoi.txnTime === r.txnTime) {
      cuoi.tong += r.amount;
      cuoi.soDuDongCuoi = r.runningBalance;
    } else {
      nhom.push({ txnTime: r.txnTime, tong: r.amount, soDuDongDau: r.runningBalance, soDuDongCuoi: r.runningBalance });
    }
  }
  if (nhom.length < 2) return { gay: [], boQuaViSao: null }; // 0–1 nhóm: không có biên nào để so

  // Xác định chiều file bằng mốc thời gian (ISO cùng offset +07 ⇒ so chuỗi là so thời gian).
  // Shopee xuất MỚI→CŨ; vẫn nhận chiều ngược để không phụ thuộc chi tiết trình bày.
  const moiTruoc = nhom[0].txnTime > nhom[nhom.length - 1].txnTime;
  const theoThoiGian = moiTruoc ? [...nhom].reverse() : nhom;
  for (let i = 1; i < theoThoiGian.length; i++) {
    if (theoThoiGian[i].txnTime <= theoThoiGian[i - 1].txnTime) {
      // Hai nhóm kề nhau sai thứ tự ⇒ file không sắp theo thời gian ⇒ phép "nhóm liền kề"
      // không còn mô tả ledger, kiểm tiếp là kết luận trên nền sai.
      return { gay: [], boQuaViSao: "thứ tự dòng trong file không theo thời gian" };
    }
  }

  // Số dư SAU CẢ NHÓM = số dư của giao dịch cuối cùng theo ledger trong nhóm.
  // File mới→cũ: dòng thuộc nhóm xuất hiện ĐẦU TIÊN trong file là giao dịch muộn nhất.
  const soDuSau = (n: Nhom) => (moiTruoc ? n.soDuDongDau : n.soDuDongCuoi);

  const gay: string[] = [];
  for (let i = 1; i < theoThoiGian.length; i++) {
    const truoc = theoThoiGian[i - 1];
    const nay = theoThoiGian[i];
    const kyVong = soDuSau(truoc) + nay.tong;
    if (kyVong !== soDuSau(nay)) {
      gay.push(
        `giữa ${truoc.txnTime} và ${nay.txnTime}: số dư kỳ vọng ${kyVong.toLocaleString("vi-VN")} ` +
          `nhưng file ghi ${soDuSau(nay).toLocaleString("vi-VN")}`,
      );
    }
  }
  return { gay, boQuaViSao: null };
}

/** Thông điệp chặn — dùng chung cho preview lẫn import để hai nơi không nói hai kiểu. */
export function thongDiepGaySoDu(gay: string[]): string {
  return (
    `File thiếu giao dịch ở giữa — chuỗi "Số dư Ví sau giao dịch" đứt ${gay.length} chỗ, ` +
    `thường do lúc xuất có lọc "Loại giao dịch". Xuất lại với Loại giao dịch = TẤT CẢ rồi nhập ` +
    `file đó. Chỗ đứt đầu tiên: ${gay[0]}`
  );
}
