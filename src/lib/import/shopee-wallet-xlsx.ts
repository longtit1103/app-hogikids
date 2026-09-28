import { normHeader, parseVnInt, readSheetRows } from "./xlsx-shared";

/**
 * Parser file ví Shopee "Transaction Report" (`my_balance_transaction`) tải TAY.
 * Shopee KHÔNG có API — chủ shop xuất file mỗi kỳ. Cấu trúc: ~13 dòng preamble +
 * block "Tóm tắt" (Tổng tiền vào/ra = checksum) + header ở dòng ~17 + data.
 *
 * KHÔNG dedupe, KHÔNG chạm DB — chỉ chuẩn hoá từng dòng. Land + transform +
 * cổng checksum nằm ở server action `shopee-wallet-import.ts`.
 *
 * Bất biến:
 *  - [F2] `amount` ép dấu theo cột "Dòng tiền" (Tiền ra→âm, Tiền vào→dương),
 *    KHÔNG tin dấu sẵn ở "Số tiền" (file thật có dòng Doanh Thu Đơn nhưng "Tiền ra").
 *  - `txnTime` neo giờ VN (`+07:00`) — file ghi wall-clock có giây, không offset.
 *  - Doanh thu vẫn CHỈ từ Pancake; file này CHỈ nuôi "Tiền đã về" (dòng tiền).
 */

export type ShopeeWalletType = "REVENUE" | "ADJUSTMENT" | "WITHDRAWAL" | "OTHER";

export type ParsedWalletRow = {
  /** ISO neo `+07:00`, vd "2026-06-26T10:26:33+07:00". Đi thẳng vào khoá idExpr + Silver txnTime. */
  txnTime: string;
  type: ShopeeWalletType;
  orderCode: string | null;
  /** CÓ DẤU — ép theo cột "Dòng tiền". */
  amount: number;
  status: string;
  runningBalance: number;
};

export type WalletSummary = { totalIn: number; totalOut: number; countIn: number; countOut: number };

export type ParseWalletResult = {
  rows: ParsedWalletRow[];
  /** Dòng bị loại (thiếu/sai) — số dòng trong file (1-based). Có lỗi ⇒ checksum lệch ⇒ action chặn. */
  errors: { line: number; reason: string }[];
  /** Cảnh báo không chặn (vd loại giao dịch lạ → OTHER). */
  warnings: string[];
  /** Đọc từ block "Tóm tắt" — null nếu không tìm thấy. */
  summary: WalletSummary | null;
  /** Tự tính từ `rows`, bucket theo Dòng tiền — action so với `summary` làm cổng chặn. */
  computed: WalletSummary;
  /**
   * Các khoá tổng hợp `txnTime|type|orderCode|amount` xuất hiện >1 lần trong file. Bronze/Silver
   * gộp các dòng cùng khoá thành 1 (khoá cố ý loại runningBalance) ⇒ checksum vẫn "khớp" nhưng
   * Silver THIẾU dòng. Action TỪ CHỐI import khi có phần tử ở đây (giữ checksum trung thực).
   */
  duplicateKeys: string[];
  /**
   * File có cột "Số dư Ví sau giao dịch" không — điều kiện chạy của cổng liên-tục-số-dư
   * (`timGaySoDuVi`). Thiếu cột thì `runningBalance` toàn 0 GIẢ, kiểm trên đó là chặn oan
   * mọi file; guard phải biết để tự rút lui kèm cảnh báo.
   */
  coCotSoDu: boolean;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Ngày/giờ có TỒN TẠI thật trên lịch không.
 *
 * Chốt chặn cũ (`Number.isNaN(new Date(iso).getTime())`) VÔ DỤNG với ngày tràn: V8 CUỘN
 * lịch chứ không báo lỗi — `new Date("2026-02-31T10:00:00+07:00")` ra 03/03/2026 hợp lệ.
 * Dòng ví khi đó bị đẩy sang THÁNG KHÁC mà tổng tiền không đổi ⇒ cổng checksum vẫn khớp,
 * chỉ có phân bổ theo tháng của card "Tiền đã về" là sai câm. Kiểm lịch thật trước khi
 * dựng ISO — cùng cách `parseVnDate` (`src/lib/ingest/pancake-mapping.ts`) đang chặn.
 */
function laNgayGioCoThat(y: number, mon: number, day: number, hh: number, mi: number, ss: number): boolean {
  // Ngày 0 của tháng kế = ngày cuối tháng này ⇒ tự đúng cả năm nhuận.
  const soNgayTrongThang = new Date(Date.UTC(y, mon, 0)).getUTCDate();
  return (
    mon >= 1 && mon <= 12 && day >= 1 && day <= soNgayTrongThang && hh <= 23 && mi <= 59 && ss <= 59
  );
}

/** Ô ngày (chuỗi "yyyy-mm-dd hh:mm:ss" hoặc Date) → ISO neo +07:00. null nếu không parse được. */
function toVnIso(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Container TZ=Asia/Ho_Chi_Minh (bất biến #3) → dùng thành phần LOCAL rồi neo +07.
    // xlsx `cellDates` dựng Date từ serial SỐ THỰC → giây có thể bị cắt (23:59:59 →
    // …58.999). Làm tròn về GIÂY gần nhất trước khi lấy thành phần, nếu không cùng một
    // giao dịch xuất .xlsx vs .csv sẽ lệch 1 giây ⇒ khoá khác ⇒ Silver đếm 2 lần.
    const d = new Date(Math.round(value.getTime() / 1000) * 1000);
    return (
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
      `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}+07:00`
    );
  }
  const s = String(value).trim();
  // Đuôi sau giây PHẢI được soi, không được bỏ lửng: file ví Shopee ghi wall-clock KHÔNG offset
  // (xem ghi chú đầu file), nên regex không neo đuôi sẽ nuốt im lặng mọi hậu tố lạ — "…T02:00:00Z"
  // bị neo thành +07:00, tức lệch 7 giờ và có thể rơi sang tháng khác. Đó đúng là lớp lỗi "dời
  // tháng câm" mà hàm này đang chặn: tổng tiền không đổi nên cổng checksum vẫn khớp, không dòng
  // nào vào `errors`, import báo thành công. Chỉ tha phần thập phân của giây (".000" — công cụ
  // bảng tính hay thêm khi lưu lại file), phần đó bỏ đi không đổi mốc thời gian.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/);
  if (m) {
    const [, y, mon, day, hh, mi, ss] = m;
    if (!laNgayGioCoThat(Number(y), Number(mon), Number(day), Number(hh), Number(mi), Number(ss))) {
      return null; // dòng rơi vào `errors` ⇒ action chặn import, không âm thầm dời tháng
    }
    return `${y}-${mon}-${day}T${hh}:${mi}:${ss}+07:00`;
  }
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) {
    const [, y, mon, day] = d;
    if (!laNgayGioCoThat(Number(y), Number(mon), Number(day), 0, 0, 0)) return null;
    return `${y}-${mon}-${day}T00:00:00+07:00`;
  }
  return null;
}

/** Nhãn loại giao dịch → enum. Lạ → OTHER (caller cảnh báo). */
function mapType(raw: string): ShopeeWalletType {
  const n = normHeader(raw);
  if (n.includes("doanh thu")) return "REVENUE";
  if (n.includes("dieu chinh")) return "ADJUSTMENT";
  if (n.includes("rut tien")) return "WITHDRAWAL";
  return "OTHER";
}

/** Dấu theo cột "Dòng tiền": Tiền vào→+1, Tiền ra→−1, lạ→0 (dòng lỗi). */
function flowSign(raw: string): 1 | -1 | 0 {
  const n = normHeader(raw);
  if (n.includes("tien vao")) return 1;
  if (n.includes("tien ra")) return -1;
  return 0;
}

/** Tìm cột theo header đã chuẩn hoá: khớp CHÍNH XÁC trước, rồi `includes`. -1 nếu không có. */
function findCol(header: string[], exact: string[], contains: string[] = []): number {
  for (let i = 0; i < header.length; i++) if (exact.includes(header[i])) return i;
  for (let i = 0; i < header.length; i++) if (contains.some((c) => header[i].includes(c))) return i;
  return -1;
}

/** Đọc block "Tóm tắt": dòng "Tổng tiền vào"/"Tổng tiền ra" → [amount, count] (2 số đầu tiên của dòng). */
function readSummary(aoa: (string | number | Date)[][]): WalletSummary | null {
  let totalIn: number | null = null;
  let countIn: number | null = null;
  let totalOut: number | null = null;
  let countOut: number | null = null;

  for (const row of aoa) {
    const label = normHeader(String(row[0] ?? ""));
    if (label !== "tong tien vao" && label !== "tong tien ra") continue;
    const ints: number[] = [];
    for (let c = 1; c < row.length; c++) {
      const v = parseVnInt(row[c]);
      if (v !== null) ints.push(v);
    }
    if (ints.length < 2) continue; // dòng thiếu số → bỏ (summary sẽ null)
    if (label === "tong tien vao") {
      totalIn = ints[0];
      countIn = ints[1];
    } else {
      totalOut = ints[0];
      countOut = ints[1];
    }
  }

  if (totalIn === null || countIn === null || totalOut === null || countOut === null) return null;
  return { totalIn, totalOut, countIn, countOut };
}

export function parseShopeeWalletFile(buf: ArrayBuffer): ParseWalletResult {
  const errors: { line: number; reason: string }[] = [];
  const warnings: string[] = [];
  const rows: ParsedWalletRow[] = [];
  const computed: WalletSummary = { totalIn: 0, totalOut: 0, countIn: 0, countOut: 0 };
  const seenKeys = new Set<string>();
  const dupKeys = new Set<string>();

  const aoa = readSheetRows(buf);
  const summary = readSummary(aoa);

  if (aoa.length === 0) {
    return {
      rows,
      errors: [{ line: 1, reason: "File rỗng hoặc không đọc được" }],
      warnings,
      summary,
      computed,
      duplicateKeys: [],
      coCotSoDu: false,
    };
  }

  // Dò dòng header (ô đầu chuẩn hoá == "ngay") — file có ~13 dòng preamble trước đó.
  const headerRow = aoa.findIndex((r) => normHeader(String(r[0] ?? "")) === "ngay");
  if (headerRow === -1) {
    return {
      rows,
      errors: [{ line: 1, reason: "Không tìm thấy dòng tiêu đề (cột 'Ngày') — cần file ví xuất từ Shopee" }],
      warnings,
      summary,
      computed,
      duplicateKeys: [],
      coCotSoDu: false,
    };
  }

  const header = aoa[headerRow].map((c) => normHeader(String(c)));
  const dateCol = findCol(header, ["ngay"]);
  const typeCol = findCol(header, ["loai giao dich"], ["loai"]);
  const orderCol = findCol(header, ["ma don hang"], ["ma don"]);
  const flowCol = findCol(header, ["dong tien"]);
  const amountCol = findCol(header, ["so tien"]);
  const statusCol = findCol(header, ["trang thai"]);
  const balanceCol = findCol(header, ["so du vi sau giao dich"], ["so du"]);

  if (dateCol === -1 || typeCol === -1 || flowCol === -1 || amountCol === -1) {
    return {
      rows,
      errors: [{ line: headerRow + 1, reason: "Thiếu cột bắt buộc (Ngày / Loại giao dịch / Dòng tiền / Số tiền)" }],
      warnings,
      summary,
      computed,
      duplicateKeys: [],
      coCotSoDu: balanceCol !== -1,
    };
  }

  for (let i = headerRow + 1; i < aoa.length; i++) {
    const raw = aoa[i];
    const line = i + 1;
    if (raw.every((c) => c === "" || c == null)) continue; // dòng trống (hay ở cuối file)

    const sign = flowSign(String(raw[flowCol] ?? ""));
    if (sign === 0) {
      errors.push({ line, reason: `Cột 'Dòng tiền' không hợp lệ: "${raw[flowCol] ?? ""}"` });
      continue;
    }
    const parsedAmount = parseVnInt(raw[amountCol]);
    if (parsedAmount === null) {
      errors.push({ line, reason: `'Số tiền' không hợp lệ: "${raw[amountCol] ?? ""}"` });
      continue;
    }
    const txnTime = toVnIso(raw[dateCol]);
    if (!txnTime) {
      errors.push({ line, reason: `'Ngày' không hợp lệ: "${raw[dateCol] ?? ""}"` });
      continue;
    }

    // [F2] |Số tiền| × dấu(Dòng tiền) — KHÔNG tin dấu sẵn ở Số tiền.
    const amount = Math.abs(parsedAmount) * sign;
    const type = mapType(String(raw[typeCol] ?? ""));
    if (type === "OTHER") {
      warnings.push(`Dòng ${line}: loại giao dịch lạ "${String(raw[typeCol] ?? "").trim()}" → OTHER`);
    }
    const orderRaw = orderCol === -1 ? "" : String(raw[orderCol] ?? "").trim();
    const orderCode = orderRaw === "" || orderRaw === "-" ? null : orderRaw;
    const status = statusCol === -1 ? "" : String(raw[statusCol] ?? "").trim();
    const runningBalance = balanceCol === -1 ? 0 : parseVnInt(raw[balanceCol]) ?? 0;

    rows.push({ txnTime, type, orderCode, amount, status, runningBalance });

    // Khoá tổng hợp = idExpr Bronze (`coalesce(orderCode,'-')`). 2 dòng cùng khoá → Bronze/Silver
    // gộp 1 (khoá loại runningBalance) ⇒ ghi lại để action từ chối (checksum vẫn "khớp" giả).
    const key = `${txnTime}|${type}|${orderCode ?? "-"}|${amount}`;
    if (seenKeys.has(key)) dupKeys.add(key);
    else seenKeys.add(key);

    if (sign > 0) {
      computed.totalIn += amount;
      computed.countIn++;
    } else {
      computed.totalOut += amount;
      computed.countOut++;
    }
  }

  return { rows, errors, warnings, summary, computed, duplicateKeys: [...dupKeys], coCotSoDu: balanceCol !== -1 };
}
