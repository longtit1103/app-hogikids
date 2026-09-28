import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BIEN_NGOAI_LENH_MS,
  giay,
  HAN_CAU_LENH_NHANH_MS,
  HAN_CHO_KHOA_MS,
  HAN_LENH_NHANH_MS,
  HAN_NAP_PHUC_HOI_MS,
  HAN_PG_DUMP_MS,
  laLoiQuaHan,
  pgOptionsPhanh,
  TONG_HAN_LENH_TOI_DA_MS,
  TTL_KHOA_PHUC_HOI_MS,
} from "@/lib/backup/han-chay-lenh-pg";

/**
 * Ba lớp phanh của đường sao lưu/phục hồi chỉ đúng khi giữ đúng THỨ TỰ với nhau. Suite này khoá
 * thứ tự đó lại: sửa lẻ một con số mà phá quan hệ là đỏ ngay, chứ không phải chờ tới lượt phục hồi
 * thật giữa sự cố mới biết.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const doc = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");

/** Bỏ comment để chỉ soi MÃ THỰC THI (comment ở các file này có nhắc chính mấy từ khoá cần đếm). */
function chiMaThucThi(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(\/\/|\*).*$/gm, "");
}

describe("thứ tự ba lớp phanh", () => {
  it("lock_timeout < statement_timeout < hạn lệnh — lớp trong báo trước, thông điệp rõ nhất thắng", () => {
    expect(HAN_CHO_KHOA_MS).toBeLessThan(HAN_CAU_LENH_NHANH_MS);
    expect(HAN_CAU_LENH_NHANH_MS).toBeLessThan(HAN_LENH_NHANH_MS);
  });

  it("hạn lệnh nạp và dump đều rộng hơn nhóm câu ngắn", () => {
    expect(HAN_LENH_NHANH_MS).toBeLessThan(HAN_PG_DUMP_MS);
    expect(HAN_PG_DUMP_MS).toBeLessThan(HAN_NAP_PHUC_HOI_MS);
  });

  it("mọi hạn đều HỮU HẠN và khác 0 — `timeout: 0` của execFile nghĩa là KHÔNG hạn", () => {
    for (const ms of [
      HAN_CHO_KHOA_MS,
      HAN_CAU_LENH_NHANH_MS,
      HAN_LENH_NHANH_MS,
      HAN_PG_DUMP_MS,
      HAN_NAP_PHUC_HOI_MS,
    ]) {
      expect(ms).toBeGreaterThan(0);
      expect(Number.isFinite(ms)).toBe(true);
    }
  });

  it("tổng hạn tính theo nhánh DÀI NHẤT (plain-gzip): dump + nạp + 3 câu ngắn", () => {
    expect(TONG_HAN_LENH_TOI_DA_MS).toBe(
      HAN_PG_DUMP_MS + HAN_NAP_PHUC_HOI_MS + 3 * HAN_LENH_NHANH_MS,
    );
  });

  it("TTL cờ khoá = tổng hạn lệnh + biên cho việc ngoài lệnh (bung nén, ghi file tạm, đẩy mốc phiên)", () => {
    expect(TTL_KHOA_PHUC_HOI_MS).toBe(TONG_HAN_LENH_TOI_DA_MS + BIEN_NGOAI_LENH_MS);
    expect(BIEN_NGOAI_LENH_MS).toBeGreaterThan(0);
  });
});

describe("pgOptionsPhanh — phanh ở tầng DB (CHỈ ăn với `psql -c` câu ngắn)", () => {
  it("luôn đặt lock_timeout: prod đo được lock_timeout = 0, không tự đặt là không có phanh nào", () => {
    expect(pgOptionsPhanh()).toContain(`-c lock_timeout=${HAN_CHO_KHOA_MS}`);
  });

  it("bỏ trống hạn câu lệnh = KHÔNG đặt statement_timeout — nếu không sẽ tự giết lượt nạp hợp lệ", () => {
    expect(pgOptionsPhanh()).not.toContain("statement_timeout");
  });

  it("truyền hạn câu lệnh thì đặt cả hai, đúng cú pháp `-c ten=gia_tri` của PGOPTIONS", () => {
    expect(pgOptionsPhanh(HAN_CAU_LENH_NHANH_MS)).toBe(
      `-c lock_timeout=${HAN_CHO_KHOA_MS} -c statement_timeout=${HAN_CAU_LENH_NHANH_MS}`,
    );
  });
});

describe("laLoiQuaHan — nhận diện lỗi do execFile tự giết vì quá hạn", () => {
  it("bị giết vì quá hạn (killed = true, code = null) → đúng", () => {
    expect(laLoiQuaHan(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }))).toBe(true);
  });

  it("thiếu binary (ENOENT) → KHÔNG phải quá hạn", () => {
    expect(laLoiQuaHan(Object.assign(new Error("spawn"), { code: "ENOENT" }))).toBe(false);
  });

  it("vượt maxBuffer cũng bị giết nhưng KHÔNG phải quá hạn — báo nhầm là chỉ sai hướng điều tra", () => {
    expect(
      laLoiQuaHan(
        Object.assign(new Error("stdout maxBuffer"), {
          killed: true,
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        }),
      ),
    ).toBe(false);
  });

  it("lỗi SQL thường (exit code khác 0) → KHÔNG phải quá hạn", () => {
    expect(laLoiQuaHan(Object.assign(new Error("psql failed"), { code: 1, killed: false }))).toBe(false);
    expect(laLoiQuaHan(undefined)).toBe(false);
  });
});

describe("giay", () => {
  it("đổi ms sang giây cho câu báo người đọc hiểu", () => {
    expect(giay(120_000)).toBe("120s");
  });
});

describe("không còn đường chạy lệnh pg không hạn", () => {
  const FILE_CHAY_LENH = ["src/lib/backup/run-pg-dump.ts", "src/lib/backup/run-restore.ts"];

  it.each(FILE_CHAY_LENH)("%s — mỗi lời gọi execFileAsync đều kèm `timeout`", (f) => {
    const ma = chiMaThucThi(doc(f));
    const soGoi = ma.match(/execFileAsync\(/g)?.length ?? 0;
    expect(soGoi).toBeGreaterThan(0);
    expect(ma.match(/\btimeout:/g)?.length ?? 0).toBe(soGoi);
  });

  // PGOPTIONS chỉ THẬT SỰ phanh được `psql -c` câu ngắn (`pg_dump`/`pg_restore`/`psql -f` tự chạy
  // `SET statement_timeout = 0; SET lock_timeout = 0;` — đo prod 01/08/2026). Vẫn chốt "mọi lời gọi
  // đều đặt" vì đặt có điều kiện chỉ thêm nhánh chứ không thêm phanh, và một lời gọi thiếu PGOPTIONS
  // là dấu hiệu ai đó dựng đường chạy lệnh pg mới đi vòng qua `runPgClient`.
  it.each(FILE_CHAY_LENH)("%s — mỗi lời gọi execFileAsync đều đặt PGOPTIONS", (f) => {
    const ma = chiMaThucThi(doc(f));
    const soGoi = ma.match(/execFileAsync\(/g)?.length ?? 0;
    expect(ma.match(/PGOPTIONS:/g)?.length ?? 0).toBe(soGoi);
  });

  it("run-restore chỉ còn MỘT chỗ gọi execFileAsync — mọi lệnh pg phải đi qua runPgClient", () => {
    const ma = chiMaThucThi(doc("src/lib/backup/run-restore.ts"));
    expect(ma.match(/execFileAsync\(/g)?.length).toBe(1);
  });
});
