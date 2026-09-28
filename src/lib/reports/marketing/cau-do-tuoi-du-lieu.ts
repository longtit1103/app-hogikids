import { format, subDays } from "date-fns";

/**
 * Câu chú thích ĐỘ TƯƠI dữ liệu — hàm THUẦN (không `new Date()`, không Prisma, không React) để
 * test được thẳng mà không cần DB/JSDOM. Dùng chung cho mọi khối/bảng đọc từ
 * `src/lib/reports/marketing/*` qua `canh-bao-do-tuoi-du-lieu.tsx`.
 *
 * Ruling P2-R35 (review Task 8 vòng A): "app chưa kéo được dữ liệu mới" phải suy từ BẰNG CHỨNG
 * THẬT — lượt `SyncLog` OK gần nhất của kind `TIKTOK_SHOP_ANALYTICS` (đọc ở `suc-khoe-dong-bo-
 * analytics.ts`) — TUYỆT ĐỐI KHÔNG suy từ `mocSanSang` (ngày dữ liệu mới nhất đã land). Lý do: các
 * stream trễ KHÁC NHAU ngay cả khi hệ thống hoàn toàn khoẻ — đo 25/08 (`moc-du-lieu-san-sang.ts`)
 * `shop` có số tới 24/08 trong khi `products` mới tới 22/08 — một ngưỡng phẳng kiểu "mốc cũ hơn N
 * ngày" sẽ bắn nhầm cảnh báo "app hỏng" đúng lúc app hoàn toàn khoẻ, chỉ đổi chiều đổ lỗi so với
 * bug cũ (từng đổ lỗi cho SÀN) mà không sửa đúng lớp lỗi.
 *
 * Ruling P2-R38 (review vòng B): quyết định câu chữ ĐÒI `bayGio`/`lanChayOkGanNhat` — nếu để
 * component "use client" (`pheu-tiktok-section.tsx`, có chart recharts) tự gọi hàm ở đây lúc
 * hydrate thì `format(subDays(...), "yyyy-MM-dd")` của date-fns đọc lịch LOCAL của TRÌNH DUYỆT
 * (không nhận `timeZone`), khác giờ VN server ⇒ câu chữ lật ngược giữa server/client (hydration
 * mismatch, vi phạm bất biến #3). SỬA: `quyetDinhCauDoTuoi`/`cauThieuDuLieu` (và `tinhChuThichDoTuoi`
 * bọc cả hai) CHỈ được gọi Ở SERVER (`page.tsx`) — mọi component (kể cả "use client") chỉ nhận
 * CHUỖI/`null` đã tính sẵn qua `ChuThichDoTuoi`, không bao giờ tự gọi lại hàm này.
 *
 * Bản cũ (`cauChuaSanSang` ở `canh-bao-do-tuoi-du-lieu.tsx`, nay đã bỏ) nhận `homNay: Date =
 * new Date()` làm mặc định — file đó bị `pheu-tiktok-section.tsx` ("use client") import, nên
 * `new Date()` chạy trên ĐỒNG HỒ TRÌNH DUYỆT (vi phạm bất biến #3: toàn app neo Asia/Ho_Chi_Minh)
 * và gây hydration mismatch (server render câu A theo giờ VN, client render câu B theo giờ máy
 * người dùng). `bayGio` ở đây LUÔN là tham số bắt buộc, chốt Ở SERVER (`page.tsx`) rồi truyền
 * xuống — kể cả khi hàm này được gọi từ nhánh client.
 */

/** Workflow đêm chạy 02:30 giờ VN ⇒ khoảng cách bình thường giữa hai lượt OK tối đa ~24h; 36h cho
 *  dư biên mà vẫn bắt được lượt trượt (một đêm workflow chết hẳn). */
const NGUONG_GIO_SYNC_TRUOT = 36;

/** Backstop ca "sync OK nhưng không ra dữ liệu": dù lượt OK gần nhất còn mới, nếu MỐC của chính
 *  stream đang xét đã cũ hơn ngần này so với hôm nay thì vẫn phải nghi APP — sync "thành công"
 *  không tự nó chứng minh Bronze có dòng mới. */
const NGUONG_NGAY_BACKSTOP = 7;

function ngayVn(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Ba trạng thái nghi ngờ (ruling P2-R41 tách "chưa từng chạy" khỏi "đã chạy nhưng trượt"):
 *  - "chua_tung_chay": chưa có lượt SyncLog OK nào — có thể mới cài đặt, có thể vừa "Xoá dữ liệu
 *    giao dịch" (thao tác đó xoá sạch SyncLog nhưng GIỮ NGUYÊN Bronze, xem `data-admin.ts`), cũng
 *    có thể app thật sự hỏng từ đầu. KHÔNG đủ bằng chứng để khẳng định app hỏng ⇒ câu TRUNG TÍNH.
 *  - "app_hong": TỪNG có lượt OK nhưng đã quá 36h, hoặc backstop bắt được sync "OK" mà mốc dữ liệu
 *    vẫn cũ hơn 7 ngày — đủ bằng chứng để khẳng định app đang hỏng.
 *  - "binh_thuong": sync còn mới và mốc dữ liệu chưa cũ — chưa sẵn sàng chỉ vì SÀN chưa chốt số.
 */
type TrangThaiDoTuoi = "chua_tung_chay" | "app_hong" | "binh_thuong";

/** `mocSanSang === null` bỏ qua backstop (không có ngày nào để so "cũ hơn") — nhánh gọi hàm này chỉ
 *  tới nếu bất biến `xepNgayTheoMoc` còn đúng (moc null ⇒ mọi ngày vắng đi vào soNgayThieu, không
 *  phải soNgayChuaSanSang), nên trong vận hành thật `mocSanSang` không null ở đây. */
function trangThaiDoTuoi(mocSanSang: string | null, lanChayOkGanNhat: Date | null, bayGio: Date): TrangThaiDoTuoi {
  if (lanChayOkGanNhat === null) return "chua_tung_chay";
  const gioTuLanChayCuoi = (bayGio.getTime() - lanChayOkGanNhat.getTime()) / 3_600_000;
  if (gioTuLanChayCuoi > NGUONG_GIO_SYNC_TRUOT) return "app_hong";
  if (mocSanSang !== null) {
    const nguongBackstop = format(subDays(bayGio, NGUONG_NGAY_BACKSTOP), "yyyy-MM-dd");
    if (mocSanSang < nguongBackstop) return "app_hong";
  }
  return "binh_thuong";
}

/** Câu chú thích #1 (khi `soNgayChuaSanSang > 0`) — null khi không cần hiện.
 *  CHỈ ĐƯỢC GỌI Ở SERVER — xem docblock đầu file (ruling P2-R38). */
export function quyetDinhCauDoTuoi(args: {
  mocSanSang: string | null;
  soNgayChuaSanSang: number;
  lanChayOkGanNhat: Date | null;
  bayGio: Date;
}): string | null {
  const { mocSanSang, soNgayChuaSanSang, lanChayOkGanNhat, bayGio } = args;
  if (soNgayChuaSanSang <= 0) return null;
  const trangThai = trangThaiDoTuoi(mocSanSang, lanChayOkGanNhat, bayGio);
  if (trangThai === "chua_tung_chay") {
    // Ruling P2-R41: KHÔNG khẳng định app hỏng — "Xoá dữ liệu giao dịch" xoá sạch SyncLog mà giữ
    // nguyên Bronze, nên ngay sau thao tác đó hệ vẫn khoẻ dù chưa có lượt OK nào để chỉ ra.
    return "Chưa ghi nhận lượt đồng bộ nào của TikTok Shop Analytics — có thể do mới cài đặt hoặc vừa xoá dữ liệu giao dịch, chưa chắc app đang hỏng.";
  }
  if (trangThai === "app_hong") {
    // Ruling P2-R39: tên khối THẬT ở /cai-dat là "Kết nối & Đồng bộ" (không phải "Trạng thái đồng bộ").
    return "App chưa kéo được dữ liệu mới — kiểm lượt đồng bộ đêm (Cài đặt → Kết nối & Đồng bộ).";
  }
  if (mocSanSang === null) {
    // Phòng thủ (xem docblock `trangThaiDoTuoi`): giữ để hàm không NÉM nếu bất biến `xepNgayTheoMoc` đứt.
    return `${soNgayChuaSanSang} ngày cuối kỳ sàn chưa chốt số. Không phải bằng 0.`;
  }
  return `Sàn mới có số tới ngày ${ngayVn(mocSanSang)} — ${soNgayChuaSanSang} ngày cuối kỳ chưa được tính.`;
}

/** Câu chú thích #2 (khi `soNgayThieu > 0`) — nguyên văn spec, null khi không cần hiện. Không phụ
 *  thuộc thời gian nên KHÔNG cần `bayGio`. */
export function cauThieuDuLieu(soNgayThieu: number): string | null {
  if (soNgayThieu <= 0) return null;
  return `${soNgayThieu} ngày trong kỳ chưa kéo được số từ sàn nên các ô tổng để trống (—). Không phải bằng 0.`;
}

/** Cặp câu đã tính SẴN — hợp đồng DUY NHẤT mà `ChuThichDoTuoiVaThieu` (component, có thể chạy trên
 *  cả nhánh "use client") được phép nhận. Xem docblock đầu file (ruling P2-R38). */
export type ChuThichDoTuoi = { cau1: string | null; cau2: string | null };

/** Gộp `quyetDinhCauDoTuoi` + `cauThieuDuLieu` — MỘT lời gọi duy nhất Ở SERVER (`page.tsx`) cho mỗi
 *  khối/bảng, tránh rải hai lời gọi rời rạc dễ quên đồng bộ `lanChayOkGanNhat`/`bayGio` giữa chúng. */
export function tinhChuThichDoTuoi(args: {
  mocSanSang: string | null;
  soNgayChuaSanSang: number;
  soNgayThieu: number;
  lanChayOkGanNhat: Date | null;
  bayGio: Date;
}): ChuThichDoTuoi {
  return {
    cau1: quyetDinhCauDoTuoi(args),
    cau2: cauThieuDuLieu(args.soNgayThieu),
  };
}
