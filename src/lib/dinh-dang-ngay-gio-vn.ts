/**
 * Định dạng ngày/giờ TUYỆT ĐỐI theo giờ Việt Nam, độc lập múi giờ của máy/trình duyệt.
 *
 * Vì sao có file này: `format()` của date-fns chạy theo múi giờ MÁY. Ở server container đã ép
 * `TZ=Asia/Ho_Chi_Minh` nên đúng, nhưng component client chạy trên trình duyệt — máy lệch múi giờ
 * (laptop mở khi đi nước ngoài, điện thoại đặt sai TZ) sẽ hiện lệch ngày/giờ so với số liệu server
 * (bất biến: toàn app neo `Asia/Ho_Chi_Minh`). `Intl.DateTimeFormat` với `timeZone` tường minh thì
 * cho cùng kết quả ở mọi máy, cả khi hydrate lẫn khi render server.
 *
 * Thuần (không `node:*`, không dependency) nên import được từ cả client lẫn server.
 * CHỈ dùng cho `Date` là một thời điểm tuyệt đối (cột DB, mốc đồng bộ). Chuỗi ngày `yyyy-MM-dd`
 * của `<input type="date">` không có múi giờ — đừng đi qua đây.
 */

/** Các mẫu đang dùng trong app; thêm mẫu mới ở đây thay vì tự ghép chuỗi ở component. */
export type MauNgayVn =
  | "dd/MM/yyyy"
  | "dd/MM"
  | "dd"
  | "MM/yyyy"
  | "yyyy-MM"
  | "yyyy-MM-dd"
  | "HH:mm"
  | "dd/MM HH:mm"
  | "HH:mm dd/MM"
  | "dd/MM/yyyy HH:mm"
  | "HH:mm dd/MM/yyyy";

const MUI_GIO_VN = "Asia/Ho_Chi_Minh";

// Dựng một lần: `Intl.DateTimeFormat` khá đắt, và bảng/danh sách gọi hàng trăm lần mỗi lần render.
const boDinhDang = new Intl.DateTimeFormat("en-GB", {
  timeZone: MUI_GIO_VN,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  // h23: nửa đêm là "00", không phải "24" như `hour12: false` ở một số engine.
  hourCycle: "h23",
});

type CacManhVn = { yyyy: string; MM: string; dd: string; HH: string; mm: string };

function tachGioVn(d: Date | number): CacManhVn {
  const ms = typeof d === "number" ? d : d.getTime();
  // Cùng hợp đồng với `format()` của date-fns: Date không hợp lệ thì ném RangeError chứ không in "NaN".
  if (!Number.isFinite(ms)) throw new RangeError("Invalid time value");
  const parts = boDinhDang.formatToParts(ms);
  const lay = (loai: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === loai)?.value ?? "";
  return { yyyy: lay("year"), MM: lay("month"), dd: lay("day"), HH: lay("hour"), mm: lay("minute") };
}

/** Định dạng một thời điểm tuyệt đối theo giờ VN, ví dụ `formatNgayVn(d, "dd/MM/yyyy HH:mm")`. */
export function formatNgayVn(d: Date | number, mau: MauNgayVn): string {
  const m = tachGioVn(d);
  switch (mau) {
    case "dd/MM/yyyy":
      return `${m.dd}/${m.MM}/${m.yyyy}`;
    case "dd/MM":
      return `${m.dd}/${m.MM}`;
    case "dd":
      return m.dd;
    case "MM/yyyy":
      return `${m.MM}/${m.yyyy}`;
    case "yyyy-MM":
      return `${m.yyyy}-${m.MM}`;
    case "yyyy-MM-dd":
      return `${m.yyyy}-${m.MM}-${m.dd}`;
    case "HH:mm":
      return `${m.HH}:${m.mm}`;
    case "dd/MM HH:mm":
      return `${m.dd}/${m.MM} ${m.HH}:${m.mm}`;
    case "HH:mm dd/MM":
      return `${m.HH}:${m.mm} ${m.dd}/${m.MM}`;
    case "dd/MM/yyyy HH:mm":
      return `${m.dd}/${m.MM}/${m.yyyy} ${m.HH}:${m.mm}`;
    case "HH:mm dd/MM/yyyy":
      return `${m.HH}:${m.mm} ${m.dd}/${m.MM}/${m.yyyy}`;
  }
}
