import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Nối dây ĐƯỜNG THẬT của nút "Sao lưu ngay": `POST /api/backup` → dòng `SyncLog` kind BACKUP →
 * `docTrangThaiSaoLuu()` → dòng trạng thái ở màn Cài đặt.
 *
 * Vì sao phải có suite này dù `tinhTrangSaoLuu` đã có test riêng: hàm đó THUẦN, nhận sẵn một dòng
 * log. Nó không biết route có ghi dòng log ấy hay không, cũng không biết màn Cài đặt có đọc đúng
 * dòng ấy hay không — gỡ một trong hai đầu đi thì mọi test cũ vẫn xanh trong khi màn hình quay lại
 * kêu "Chưa sao lưu lần nào" y như bug gốc (prod có 21 lượt backup đêm OK mà màn hình vẫn báo chưa
 * sao lưu, đo 01/08).
 *
 * `runPgDump` bị mock: chạy pg_dump thật ở test là chậm, phụ thuộc binary + mạng Tailscale, và
 * không kiểm thêm điều gì — cái cần chốt là ĐƯỜNG GHI/ĐỌC LOG quanh nó.
 */
vi.mock("@/lib/session", () => ({
  getAuthenticatedUserId: vi.fn(async () => "test-user-id"),
}));
vi.mock("@/lib/backup/run-pg-dump", () => ({
  runPgDump: vi.fn(async () => Buffer.from("PGDMP giả")),
}));
/**
 * Chỉ thay ĐÚNG `dangPhucHoi`, giữ nguyên phần còn lại của khoá bảo trì.
 *
 * Không giành khoá thật vì cần tái hiện một cửa sổ THEO THỜI GIAN: guard đầu route (gọi
 * `chanRouteKhiDangPhucHoi`, dùng bản `dangPhucHoi` NỘI BỘ module nên không bị mock) phải ĐI QUA,
 * rồi lượt phục hồi mới bắt đầu trong lúc `runPgDump` đang chạy. Giành khoá trước khi gọi route
 * chỉ kiểm được guard đầu route — thứ đã có test riêng ở `khoa-bao-tri-duong-ghi.test.ts`.
 *
 * Cách này cũng không đụng tới cờ thật, nên không có đường nào rò khoá sang file test khác.
 */
vi.mock("@/lib/backup/khoa-bao-tri", async (importOriginal) => {
  const thuc = await importOriginal<typeof import("@/lib/backup/khoa-bao-tri")>();
  return { ...thuc, dangPhucHoi: vi.fn(thuc.dangPhucHoi) };
});

import { POST } from "@/app/api/backup/route";
import { docTrangThaiSaoLuu } from "@/lib/backup/doc-trang-thai-sao-luu";
import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { giuKhoaViecNang, traKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { prisma } from "@/lib/prisma";

const DUMP = Buffer.from("PGDMP dữ liệu giả cho test");

/** Chỉ dọn kind BACKUP: suite khác dùng chung DB test có log kind khác, đừng xoá oan của họ. */
async function donLogBackup(): Promise<void> {
  await prisma.syncLog.deleteMany({ where: { kind: "BACKUP" } });
}

async function docLogBackup() {
  return prisma.syncLog.findMany({ where: { kind: "BACKUP" }, orderBy: { startedAt: "desc" } });
}

beforeEach(async () => {
  await donLogBackup();
  vi.mocked(runPgDump).mockReset();
  vi.mocked(runPgDump).mockResolvedValue(DUMP);
  vi.mocked(dangPhucHoi).mockReturnValue(false);
});

afterAll(async () => {
  await donLogBackup();
  await prisma.$disconnect();
});

/**
 * Request rỗng cho route. Từ `POST(request)` (thêm 2026-09-20 cùng cổng `chanRequestKhacOrigin`)
 * thì route ĐỌC header, gọi `POST()` không đối số sẽ ném TypeError trước cả nhánh nghiệp vụ.
 * CỐ Ý không đặt `Origin`: cổng fail-open khi vắng header đó (curl/cron), nên các khẳng định dưới
 * đây vẫn đo đúng nghiệp vụ chứ không vô tình đo cổng CSRF. Cổng đó có suite riêng
 * (`tests/chan-request-khac-origin.test.ts`).
 */
function req(): Request {
  return new Request("http://localhost/api/backup", { method: "POST" });
}

describe("POST /api/backup — ghi nhật ký sao lưu", () => {
  it("dump OK → 200 kèm file, và sinh ĐÚNG 1 dòng SyncLog BACKUP status OK có sizeBytes", async () => {
    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="hogikids-.*\.dump"/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(DUMP);

    const logs = await docLogBackup();
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("OK");
    expect(logs[0].finishedAt).toBeInstanceOf(Date);
    expect(logs[0].error).toBeNull();
    // `sizeBytes` là thứ màn Cài đặt in ra ("21,89 MB") — thiếu nó thì dòng trạng thái cụt.
    expect(logs[0].stats).toMatchObject({ sizeBytes: DUMP.length });
  });

  it("dump LỖI → 500, và vẫn sinh dòng SyncLog BACKUP status ERROR kèm nội dung lỗi", async () => {
    vi.mocked(runPgDump).mockRejectedValue(new Error("pg_dump: connection to server failed"));

    const res = await POST(req());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("pg_dump: connection to server failed");

    const logs = await docLogBackup();
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("ERROR");
    expect(logs[0].error).toBe("pg_dump: connection to server failed");
  });

  /**
   * Cửa sổ có thật: guard đầu route chạy TRƯỚC `runPgDump()` (hàng chục giây), còn `/api/restore`
   * giành khoá rồi mới chụp bản lùi. Nên lượt phục hồi hoàn toàn có thể bắt đầu GIỮA lượt dump tay,
   * và dòng log ghi lúc đó là INSERT vào schema sắp bị drop + nạp lại.
   */
  describe("lượt phục hồi bắt đầu GIỮA lúc đang dump", () => {
    it("nhánh OK → KHÔNG ghi dòng nào (không INSERT vào schema sắp bị thay sạch)", async () => {
      vi.mocked(runPgDump).mockImplementation(async () => {
        vi.mocked(dangPhucHoi).mockReturnValue(true);
        return DUMP;
      });

      const res = await POST(req());

      // File vẫn trả về cho người bấm nút — chỉ dòng log bị bỏ, đó là đánh đổi cố ý.
      expect(res.status).toBe(200);
      expect(await docLogBackup()).toHaveLength(0);
    });

    it("nhánh LỖI → cũng KHÔNG ghi dòng nào", async () => {
      vi.mocked(runPgDump).mockImplementation(async () => {
        vi.mocked(dangPhucHoi).mockReturnValue(true);
        throw new Error("pg_dump chết giữa lượt phục hồi");
      });

      const res = await POST(req());

      expect(res.status).toBe(500);
      expect(await docLogBackup()).toHaveLength(0);
    });
  });
});

/**
 * `/api/backup` phải giành khoá việc nặng TRƯỚC `runPgDump()` — bấm liên tiếp (hoặc một script
 * dựng lại/khoản vay đang giữ khoá) trước đây xếp chồng nhiều `pg_dump` cùng lúc. Dùng CHUNG khoá
 * với `/api/restore`/`rebuild-from-raw`, không phải khoá riêng.
 */
describe("POST /api/backup — khoá việc nặng", () => {
  it("việc nặng khác đang giữ khoá → 409 kèm TÊN việc đó, KHÔNG gọi pg_dump, KHÔNG ghi SyncLog", async () => {
    const khoa = await giuKhoaViecNang("lượt phục hồi giả");
    try {
      vi.mocked(runPgDump).mockClear();
      const res = await POST(req());

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("lượt phục hồi giả");
      // Cùng giọng với câu 409 của `/api/restore`: khoá có thể là khoá CŨ còn sót (app vừa khởi
      // động lại / vừa nạp backup), tự hết hạn tối đa 5' — không cần xử lý tay.
      expect(body.error).toContain("khoá cũ còn sót");
      expect(body.error).toContain("tối đa 5 phút");
      expect(runPgDump).not.toHaveBeenCalled();
      expect(await docLogBackup()).toHaveLength(0);
    } finally {
      if (khoa.the) await traKhoaViecNang(khoa.the);
    }
  });

  it("dump xong (OK hoặc LỖI) → khoá được TRẢ, lượt sao lưu kế tiếp vào được ngay", async () => {
    const res1 = await POST(req());
    expect(res1.status).toBe(200);

    // Khoá đã trả sạch ⇒ giành lại được ngay (không phải chờ TTL 5').
    const khoa = await giuKhoaViecNang("kiểm khoá đã nhả");
    expect(khoa.the).not.toBeNull();
    if (khoa.the) await traKhoaViecNang(khoa.the);
  });
});

/**
 * Đầu ĐỌC của cùng nguồn sự thật — thứ màn Cài đặt gọi (`cai-dat/page.tsx` → `docTrangThaiSaoLuu`).
 * Không có suite này thì gỡ câu đọc đi mọi test vẫn xanh, y như lúc `Setting.lastBackupAt` và
 * `SyncLog` trôi nhau.
 */
describe("docTrangThaiSaoLuu", () => {
  it("chưa có dòng BACKUP nào → chua-co", async () => {
    expect((await docTrangThaiSaoLuu()).muc).toBe("chua-co");
  });

  it("bấm Sao lưu ngay xong → màn Cài đặt thấy 'ok' kèm dung lượng file (vòng ghi→đọc khép kín)", async () => {
    expect((await POST(req())).status).toBe(200);

    const trangThai = await docTrangThaiSaoLuu();
    expect(trangThai.muc).toBe("ok");
    expect(trangThai.fileSizeBytes).toBe(DUMP.length);
    expect(trangThai.finishedAt).toBeInstanceOf(Date);
  });

  it("lấy dòng BACKUP mới nhất, KHÔNG bị log kind khác (chạy dày hơn) che mất", async () => {
    // Mốc TƯƠNG ĐỐI với lúc chạy test: ngày cứng sẽ tự vượt ngưỡng 36h khi lịch trôi.
    const demTruoc = new Date(Date.now() - 26 * 3_600_000);
    const demQua = new Date(Date.now() - 2 * 3_600_000);
    await prisma.syncLog.createMany({
      data: [
        { kind: "BACKUP", status: "ERROR", startedAt: demTruoc, finishedAt: demTruoc, error: "disk full" },
        {
          kind: "BACKUP",
          status: "OK",
          startedAt: demQua,
          finishedAt: demQua,
          stats: { file: "hogikids-dem-qua.dump", sizeBytes: 22_958_125 },
        },
      ],
    });
    // Log kind khác chạy SAU (mới hơn) — đọc nhầm cả bảng thì trạng thái sao lưu bám vào nó, mà nó
    // không có `stats.sizeBytes` nên dòng trạng thái mất luôn phần dung lượng.
    const logKhac = await prisma.syncLog.create({
      data: { kind: "PANCAKE", status: "OK", finishedAt: new Date() },
    });

    try {
      const trangThai = await docTrangThaiSaoLuu();
      expect(trangThai.muc).toBe("ok"); // KHÔNG phải "loi" của dòng ERROR đêm trước
      expect(trangThai.fileSizeBytes).toBe(22_958_125);
      expect(trangThai.finishedAt).toEqual(demQua);
      expect(trangThai.error).toBeNull();
    } finally {
      await prisma.syncLog.delete({ where: { id: logKhac.id } });
    }
  });
});
