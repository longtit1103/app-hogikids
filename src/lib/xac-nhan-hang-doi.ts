/**
 * Hàng đợi yêu cầu XÁC NHẬN dùng chung — thay hộp confirm gốc của trình duyệt (bị chặn trong PWA/iOS) mà vẫn gọi được
 * từ nơi KHÔNG có JSX (hook, handler async): `await xacNhan("Bỏ thay đổi?")` trả `true` khi người dùng
 * đồng ý, `false` khi huỷ. Hộp thoại thật do `<XacNhanHost />` (gắn một lần ở layout gốc) vẽ.
 *
 * Thuần (không React/DOM) để kiểm bằng unit test. Hai điểm an toàn:
 *   - Chưa có host nào gắn ⇒ trả `false` NGAY (không treo lời hứa mãi): mọi chỗ gọi đều coi `false` là
 *     "đừng làm việc huỷ/mất dữ liệu", nên thiếu host thì hành vi an toàn là không làm gì.
 *   - Nhiều yêu cầu cùng lúc xếp hàng, hỏi lần lượt — không yêu cầu nào bị nuốt.
 */

export type TuyChonXacNhan = {
  /** Câu hỏi chính. */
  noiDung: string;
  tieuDe?: string;
  nhanDongY?: string;
  nhanHuy?: string;
};

type YeuCau = TuyChonXacNhan & { giaiQuyet: (dongY: boolean) => void };

let hang: YeuCau[] = [];
let soHost = 0;
const nguoiNghe = new Set<() => void>();

function baoThayDoi(): void {
  for (const f of nguoiNghe) f();
}

/** Host gọi khi gắn/gỡ; trả hàm gỡ. Gỡ host cuối cùng thì từ chối (false) mọi yêu cầu còn treo. */
export function dangKyHost(): () => void {
  soHost += 1;
  return () => {
    soHost -= 1;
    if (soHost === 0) {
      const treo = hang;
      hang = [];
      for (const y of treo) y.giaiQuyet(false);
      baoThayDoi();
    }
  };
}

export function xacNhan(tuyChon: string | TuyChonXacNhan): Promise<boolean> {
  const chon: TuyChonXacNhan = typeof tuyChon === "string" ? { noiDung: tuyChon } : tuyChon;
  if (soHost === 0) return Promise.resolve(false);
  return new Promise<boolean>((giaiQuyet) => {
    hang = [...hang, { ...chon, giaiQuyet }];
    baoThayDoi();
  });
}

/** Yêu cầu đang hiển thị (đầu hàng); `null` = không có. Snapshot ổn định theo tham chiếu cho `useSyncExternalStore`. */
export function yeuCauHienTai(): TuyChonXacNhan | null {
  return hang[0] ?? null;
}

/**
 * Trả lời yêu cầu đầu hàng rồi chuyển sang yêu cầu kế (nếu có). `cho` = yêu cầu mà hộp thoại đang
 * hiển thị: nếu đầu hàng đã là yêu cầu KHÁC (nút Đồng ý trả lời xong, rồi sự kiện đóng hộp đến muộn)
 * thì bỏ qua — nếu không, sự kiện đóng của yêu cầu cũ sẽ huỷ nhầm yêu cầu kế tiếp.
 */
export function traLoiXacNhan(dongY: boolean, cho?: TuyChonXacNhan | null): void {
  const dau = hang[0];
  if (!dau) return;
  if (cho !== undefined && cho !== dau) return;
  hang = hang.slice(1);
  dau.giaiQuyet(dongY);
  baoThayDoi();
}

export function dangKyNguoiNghe(f: () => void): () => void {
  nguoiNghe.add(f);
  return () => {
    nguoiNghe.delete(f);
  };
}
