import { describe, expect, it } from "vitest";

import {
  GIO_QUA_HAN_SAO_LUU,
  saoLuuCanBaoDong,
  tinhTrangSaoLuu,
  type LogSaoLuuGanNhat,
} from "@/lib/backup/trang-thai-sao-luu";

const BAY_GIO = new Date("2026-08-01T04:00:00+07:00");

function gioTruoc(gio: number): Date {
  return new Date(BAY_GIO.getTime() - gio * 3_600_000);
}

describe("tinhTrangSaoLuu", () => {
  it("chưa có dòng SyncLog nào → chua-co, mọi mốc null", () => {
    const kq = tinhTrangSaoLuu(null, BAY_GIO);
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
    const kq = tinhTrangSaoLuu(log, BAY_GIO);
    expect(kq.muc).toBe("ok");
    expect(kq.finishedAt).toEqual(finishedAt);
    expect(kq.gioTruoc).toBeCloseTo(1, 5);
    expect(kq.fileSizeBytes).toBe(22_958_125);
    expect(kq.error).toBeNull();
  });

  it(`OK đúng biên ${GIO_QUA_HAN_SAO_LUU} giờ (KHÔNG vượt ngưỡng) → vẫn ok`, () => {
    const log: LogSaoLuuGanNhat = { status: "OK", finishedAt: gioTruoc(GIO_QUA_HAN_SAO_LUU), stats: null, error: null };
    expect(tinhTrangSaoLuu(log, BAY_GIO).muc).toBe("ok");
  });

  it(`OK vừa vượt ${GIO_QUA_HAN_SAO_LUU} giờ → qua-han`, () => {
    const log: LogSaoLuuGanNhat = { status: "OK", finishedAt: gioTruoc(GIO_QUA_HAN_SAO_LUU + 0.01), stats: null, error: null };
    const kq = tinhTrangSaoLuu(log, BAY_GIO);
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
    const kq = tinhTrangSaoLuu(log, BAY_GIO);
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
    expect(tinhTrangSaoLuu(log, BAY_GIO).muc).toBe("loi");
  });

  it("status OK nhưng thiếu finishedAt (bất thường) → qua-han, không tự nhận ok", () => {
    const log: LogSaoLuuGanNhat = { status: "OK", finishedAt: null, stats: null, error: null };
    const kq = tinhTrangSaoLuu(log, BAY_GIO);
    expect(kq.muc).toBe("qua-han");
    expect(kq.gioTruoc).toBeNull();
  });

  it("stats không phải object hoặc sizeBytes sai kiểu → fileSizeBytes null, không throw", () => {
    const log1: LogSaoLuuGanNhat = { status: "OK", finishedAt: gioTruoc(1), stats: "chuoi-la", error: null };
    const log2: LogSaoLuuGanNhat = { status: "OK", finishedAt: gioTruoc(1), stats: { sizeBytes: "12345" }, error: null };
    expect(tinhTrangSaoLuu(log1, BAY_GIO).fileSizeBytes).toBeNull();
    expect(tinhTrangSaoLuu(log2, BAY_GIO).fileSizeBytes).toBeNull();
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
    expect(saoLuuCanBaoDong(tinhTrangSaoLuu(loi, BAY_GIO).muc)).toBe(true);

    // Lượt sau chạy lại thành công: trạng thái đọc dòng MỚI NHẤT nên tín hiệu tắt tức thì. Luật cũ
    // ("có bất kỳ ERROR nào trong 48h") giữ banner đỏ thêm gần 2 ngày, đá nhau với thẻ nói "ok".
    const lai: LogSaoLuuGanNhat = {
      status: "OK",
      finishedAt: gioTruoc(1),
      stats: { sizeBytes: 22_958_125 },
      error: null,
    };
    expect(saoLuuCanBaoDong(tinhTrangSaoLuu(lai, BAY_GIO).muc)).toBe(false);
  });
});
