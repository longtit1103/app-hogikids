import { describe, expect, it } from "vitest";

import {
  GIO_QUA_HAN_SAO_LUU,
  chonLogTheoArtifact,
  phanLoaiArtifact,
  saoLuuCanBaoDong,
  tinhTrangMotArtifact,
  tinhTrangSaoLuu,
  type LogSaoLuuGanNhat,
} from "@/lib/backup/trang-thai-sao-luu";

const BAY_GIO = new Date("2026-08-01T04:00:00+07:00");

function gioTruoc(gio: number): Date {
  return new Date(BAY_GIO.getTime() - gio * 3_600_000);
}

describe("tinhTrangMotArtifact", () => {
  it("chưa có dòng SyncLog nào → chua-co, mọi mốc null", () => {
    const kq = tinhTrangMotArtifact(null, BAY_GIO);
    expect(kq).toEqual({ muc: "chua-co", finishedAt: null, gioTruoc: null, fileSizeBytes: null, error: null });
  });

  it("OK, xong 1 giờ trước (tươi) → ok, đọc được sizeBytes từ stats", () => {
    const finishedAt = gioTruoc(1);
    const log: LogSaoLuuGanNhat = {
      status: "OK",
      finishedAt,
      stats: { file: "hogikids-20260801-0400.dump", sizeBytes: 22_958_125, drivePath: "cloud:backups/" },
      error: null,
    };
    const kq = tinhTrangMotArtifact(log, BAY_GIO);
    expect(kq.muc).toBe("ok");
    expect(kq.finishedAt).toEqual(finishedAt);
    expect(kq.gioTruoc).toBeCloseTo(1, 5);
    expect(kq.fileSizeBytes).toBe(22_958_125);
    expect(kq.error).toBeNull();
  });

  it(`OK đúng biên ${GIO_QUA_HAN_SAO_LUU} giờ (KHÔNG vượt ngưỡng) → vẫn ok`, () => {
    const log: LogSaoLuuGanNhat = { status: "OK", finishedAt: gioTruoc(GIO_QUA_HAN_SAO_LUU), stats: null, error: null };
    expect(tinhTrangMotArtifact(log, BAY_GIO).muc).toBe("ok");
  });

  it(`OK vừa vượt ${GIO_QUA_HAN_SAO_LUU} giờ → qua-han`, () => {
    const log: LogSaoLuuGanNhat = { status: "OK", finishedAt: gioTruoc(GIO_QUA_HAN_SAO_LUU + 0.01), stats: null, error: null };
    const kq = tinhTrangMotArtifact(log, BAY_GIO);
    expect(kq.muc).toBe("qua-han");
    expect(kq.error).toBeNull();
  });

  it("ERROR → loi NGAY, kể cả khi vừa lỗi 1 giờ trước (chưa tới ngưỡng quá hạn)", () => {
    const log: LogSaoLuuGanNhat = {
      status: "ERROR",
      finishedAt: gioTruoc(1),
      stats: null,
      error: "pg_dump: connection to server failed",
    };
    const kq = tinhTrangMotArtifact(log, BAY_GIO);
    expect(kq.muc).toBe("loi");
    expect(kq.error).toBe("pg_dump: connection to server failed");
  });

  it("ERROR lâu rồi vẫn là loi, không lật thành qua-han", () => {
    const log: LogSaoLuuGanNhat = {
      status: "ERROR",
      finishedAt: gioTruoc(GIO_QUA_HAN_SAO_LUU + 10),
      stats: null,
      error: "disk full",
    };
    expect(tinhTrangMotArtifact(log, BAY_GIO).muc).toBe("loi");
  });

  it("status OK nhưng thiếu finishedAt (bất thường) → qua-han, không tự nhận ok", () => {
    const log: LogSaoLuuGanNhat = { status: "OK", finishedAt: null, stats: null, error: null };
    const kq = tinhTrangMotArtifact(log, BAY_GIO);
    expect(kq.muc).toBe("qua-han");
    expect(kq.gioTruoc).toBeNull();
  });

  it("stats không phải object hoặc sizeBytes sai kiểu → fileSizeBytes null, không throw", () => {
    const log1: LogSaoLuuGanNhat = { status: "OK", finishedAt: gioTruoc(1), stats: "chuoi-la", error: null };
    const log2: LogSaoLuuGanNhat = { status: "OK", finishedAt: gioTruoc(1), stats: { sizeBytes: "12345" }, error: null };
    expect(tinhTrangMotArtifact(log1, BAY_GIO).fileSizeBytes).toBeNull();
    expect(tinhTrangMotArtifact(log2, BAY_GIO).fileSizeBytes).toBeNull();
  });
});

/**
 * Quy tắc quyết định banner sticky toàn app có kêu về sao lưu hay không. Bỏ BACKUP khỏi cảnh báo
 * "số liệu có thể thiếu" là đúng (backup hỏng không mất một đồng doanh thu), nhưng nếu không đặt
 * nhánh riêng thay thế thì lượt backup hỏng chỉ còn dấu vết ở /cai-dat — chủ shop không vào đó
 * mỗi ngày. Bộ ca dưới đây khoá đúng chỗ đó.
 */
describe("saoLuuCanBaoDong", () => {
  it("lượt gần nhất LỖI → banner kêu", () => {
    expect(saoLuuCanBaoDong("loi")).toBe(true);
  });

  it("quá hạn (cron chết câm, không có bản mới) → banner kêu", () => {
    expect(saoLuuCanBaoDong("qua-han")).toBe(true);
  });

  it("lượt gần nhất OK → banner im", () => {
    expect(saoLuuCanBaoDong("ok")).toBe(false);
  });

  it("chưa từng sao lưu → banner im, để thẻ Sao lưu ở Cài đặt lo", () => {
    expect(saoLuuCanBaoDong("chua-co")).toBe(false);
  });

  it("BACKUP ERROR rồi lượt sau OK → banner tắt ngay, không kẹt như cửa sổ 48h cũ", () => {
    const loi: LogSaoLuuGanNhat = {
      status: "ERROR",
      finishedAt: gioTruoc(2),
      stats: null,
      error: "pg_dump: disk full",
    };
    expect(saoLuuCanBaoDong(tinhTrangMotArtifact(loi, BAY_GIO).muc)).toBe(true);

    // Lượt sau chạy lại thành công: trạng thái đọc dòng MỚI NHẤT nên tín hiệu tắt tức thì. Luật cũ
    // ("có bất kỳ ERROR nào trong 48h") giữ banner đỏ thêm gần 2 ngày, đá nhau với thẻ nói "ok".
    const lai: LogSaoLuuGanNhat = {
      status: "OK",
      finishedAt: gioTruoc(1),
      stats: { sizeBytes: 22_958_125 },
      error: null,
    };
    expect(saoLuuCanBaoDong(tinhTrangMotArtifact(lai, BAY_GIO).muc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Trạng thái THEO TỪNG artifact bắt buộc (dump app · tarball toàn server) + bản tải tay.
// ---------------------------------------------------------------------------------------------

const logOk = (gio: number, stats: unknown): LogSaoLuuGanNhat => ({
  status: "OK",
  finishedAt: gioTruoc(gio),
  stats,
  error: null,
});
const logLoi = (gio: number, error: string, stats: unknown = null): LogSaoLuuGanNhat => ({
  status: "ERROR",
  finishedAt: gioTruoc(gio),
  stats,
  error,
});

const APP_OK = (gio: number) =>
  logOk(gio, {
    artifact: "APP_DUMP_REMOTE",
    file: "hogikids-20260731-1300.dump.age",
    sizeBytes: 1000,
    drivePath: "cloud:backups/hogikids-20260731-1300.dump.age",
  });
const FULL_OK = (gio: number) =>
  logOk(gio, {
    artifact: "FULL_SERVER_REMOTE",
    file: "hogikids-full-20260731-0400.tar.gz.age",
    sizeBytes: 5000,
    drivePath: "cloud:full-backups/hogikids-full-20260731-0400.tar.gz.age",
  });
const FULL_LOI = (gio: number) =>
  logLoi(gio, "full-backup.sh: buoc tarball/ma hoa/upload that bai", { artifact: "FULL_SERVER_REMOTE" });
const MANUAL_OK = (gio: number) =>
  logOk(gio, { artifact: "MANUAL_DOWNLOAD", file: "hogikids-20260801-0330.dump", sizeBytes: 777 });

describe("tinhTrangSaoLuu — hai artifact bắt buộc, mức XẤU NHẤT", () => {
  it("full ERROR 04:05 rồi dump app OK 13:00 → ĐỎ (dump app không che lỗi tarball)", () => {
    // Giờ trước hiện tại: full lỗi 9 giờ trước (04:05 ↔ 13:00 ⇒ 13:00 là mới nhất).
    const kq = tinhTrangSaoLuu({ appDump: APP_OK(1), fullServer: FULL_LOI(9), manual: null }, BAY_GIO);
    expect(kq.muc).toBe("loi");
    expect(kq.fullServer.muc).toBe("loi");
    expect(kq.fullServer.error).toContain("full-backup.sh:");
    expect(kq.appDump.muc).toBe("ok");
    // Năm trường đầu phản ánh artifact XẤU NHẤT (banner/mock cũ chỉ đọc `muc`).
    expect(kq.error).toContain("full-backup.sh:");
  });

  it("dump app OK liên tục, tarball không có log mới 40 giờ → qua-han", () => {
    const kq = tinhTrangSaoLuu({ appDump: APP_OK(1), fullServer: FULL_OK(40), manual: null }, BAY_GIO);
    expect(kq.muc).toBe("qua-han");
    expect(kq.fullServer.muc).toBe("qua-han");
    expect(kq.appDump.muc).toBe("ok");
    expect(saoLuuCanBaoDong(kq.muc)).toBe(true);
  });

  it("hạn 36 giờ áp cho CẢ HAI artifact (dump app 37 giờ cũng quá hạn)", () => {
    const kq = tinhTrangSaoLuu({ appDump: APP_OK(GIO_QUA_HAN_SAO_LUU + 1), fullServer: FULL_OK(2), manual: null }, BAY_GIO);
    expect(kq.appDump.muc).toBe("qua-han");
    expect(kq.fullServer.muc).toBe("ok");
    expect(kq.muc).toBe("qua-han");
  });

  it("bản tải tay OK mới nhất KHÔNG xoá lỗi tarball", () => {
    const kq = tinhTrangSaoLuu({ appDump: APP_OK(5), fullServer: FULL_LOI(9), manual: MANUAL_OK(0.1) }, BAY_GIO);
    expect(kq.muc).toBe("loi");
    expect(kq.thuCong.muc).toBe("ok");
    expect(kq.thuCong.fileSizeBytes).toBe(777);
  });

  it("bản tải tay LỖI không làm đỏ trạng thái tổng khi hai artifact bắt buộc đều OK", () => {
    const kq = tinhTrangSaoLuu(
      {
        appDump: APP_OK(5),
        fullServer: FULL_OK(10),
        manual: logLoi(1, "pg_dump that bai", { artifact: "MANUAL_DOWNLOAD" }),
      },
      BAY_GIO,
    );
    expect(kq.muc).toBe("ok");
    expect(kq.thuCong.muc).toBe("loi");
  });

  it("cả hai artifact OK và còn tươi → ok", () => {
    const kq = tinhTrangSaoLuu({ appDump: APP_OK(2), fullServer: FULL_OK(10), manual: null }, BAY_GIO);
    expect(kq.muc).toBe("ok");
    expect(kq.thuCong.muc).toBe("chua-co");
  });

  it("chưa log nào → chua-co ở cả ba, banner im", () => {
    const kq = tinhTrangSaoLuu({ appDump: null, fullServer: null, manual: null }, BAY_GIO);
    expect(kq.muc).toBe("chua-co");
    expect(kq.appDump.muc).toBe("chua-co");
    expect(kq.fullServer.muc).toBe("chua-co");
    expect(saoLuuCanBaoDong(kq.muc)).toBe(false);
  });
});

describe("phanLoaiArtifact — log mới và log cũ", () => {
  it("đọc artifact ghi thẳng trong stats (kể cả ERROR không có file/drivePath)", () => {
    expect(phanLoaiArtifact(FULL_LOI(1))).toBe("FULL_SERVER_REMOTE");
    expect(phanLoaiArtifact(APP_OK(1))).toBe("APP_DUMP_REMOTE");
    expect(phanLoaiArtifact(MANUAL_OK(1))).toBe("MANUAL_DOWNLOAD");
  });

  it("artifact lạ/sai kiểu trong stats bị bỏ qua, rơi về suy luận", () => {
    const log = logOk(1, { artifact: "KHONG_CO", file: "x.dump", sizeBytes: 1 });
    expect(phanLoaiArtifact(log)).toBe("MANUAL_DOWNLOAD");
  });

  it("log cũ OK có drivePath `.dump.age` → APP_DUMP_REMOTE", () => {
    const log = logOk(1, {
      file: "hogikids-20260730-1300.dump.age",
      sizeBytes: 10,
      drivePath: "cloud:backups/hogikids-20260730-1300.dump.age",
    });
    expect(phanLoaiArtifact(log)).toBe("APP_DUMP_REMOTE");
  });

  it("log cũ ERROR có tiền tố `full-backup.sh:` → FULL, `backup-app-dump.sh:` → APP", () => {
    expect(phanLoaiArtifact(logLoi(1, "full-backup.sh: thieu khoa cong khai"))).toBe("FULL_SERVER_REMOTE");
    expect(phanLoaiArtifact(logLoi(1, "backup-app-dump.sh: thieu age"))).toBe("APP_DUMP_REMOTE");
  });

  it("log cũ có `file` mà không có drivePath (bản tải tay) → MANUAL_DOWNLOAD", () => {
    expect(phanLoaiArtifact(logOk(1, { file: "hogikids-20260801-0400.dump", sizeBytes: 5 }))).toBe("MANUAL_DOWNLOAD");
  });

  it("ERROR không stats, không tiền tố → null (KHÔNG rơi vào MANUAL)", () => {
    expect(phanLoaiArtifact(logLoi(1, "disk full"))).toBeNull();
    expect(phanLoaiArtifact(logLoi(1, "disk full", {}))).toBeNull();
  });

  it("OK không dấu hiệu nào → null", () => {
    expect(phanLoaiArtifact(logOk(1, null))).toBeNull();
  });
});

describe("chonLogTheoArtifact — log MỚI NHẤT của từng artifact (danh sách mới nhất trước)", () => {
  it("dump app 13:00 OK nằm TRÊN tarball ERROR 04:05 nhưng chỉ che đúng bucket của nó", () => {
    const appMoi = APP_OK(1);
    const fullLoi = FULL_LOI(9);
    const chon = chonLogTheoArtifact([appMoi, fullLoi, APP_OK(21)]);
    expect(chon.appDump).toBe(appMoi);
    expect(chon.fullServer).toBe(fullLoi);
    expect(chon.manual).toBeNull();
  });

  it("ERROR cũ KHÔNG rõ nguồn áp cho CẢ HAI bucket (fail-closed) → tổng đỏ", () => {
    const loiCu = logLoi(3, "disk full");
    const chon = chonLogTheoArtifact([loiCu]);
    expect(chon.appDump).toBe(loiCu);
    expect(chon.fullServer).toBe(loiCu);
    expect(chon.manual).toBeNull();
    const kq = tinhTrangSaoLuu(chon, BAY_GIO);
    expect(kq.appDump.muc).toBe("loi");
    expect(kq.fullServer.muc).toBe("loi");
    expect(kq.muc).toBe("loi");
  });

  it("ERROR không rõ nguồn nhưng bucket đã có OK MỚI HƠN → bucket đó xanh, bucket còn lại vẫn đỏ", () => {
    const appOkMoi = APP_OK(1);
    const loiCu = logLoi(5, "disk full");
    const chon = chonLogTheoArtifact([appOkMoi, loiCu]);
    expect(chon.appDump).toBe(appOkMoi);
    expect(chon.fullServer).toBe(loiCu);
  });

  it("OK không rõ nguồn không được gán cho bucket nào", () => {
    const chon = chonLogTheoArtifact([logOk(1, null)]);
    expect(chon).toEqual({ appDump: null, fullServer: null, manual: null });
  });

  it("log MANUAL ERROR (đúng nhãn) không rơi sang hai bucket bắt buộc", () => {
    const manualLoi = logLoi(1, "pg_dump that bai", { artifact: "MANUAL_DOWNLOAD" });
    const chon = chonLogTheoArtifact([manualLoi]);
    expect(chon.manual).toBe(manualLoi);
    expect(chon.appDump).toBeNull();
    expect(chon.fullServer).toBeNull();
  });
});
