import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { docTrangThaiSaoLuu } from "@/lib/backup/doc-trang-thai-sao-luu";
import {
  ALL_SYNC_KINDS,
  DATA_SYNC_KINDS,
  ERROR_WINDOW_HOURS,
  NON_DATA_SYNC_KINDS,
  getRecentDataErrorKinds,
} from "@/lib/queries/sync-health";
import { prisma } from "@/lib/prisma";

/**
 * Khoá RANH GIỚI giữa hai cảnh báo sống trên cùng màn Cài đặt:
 *  · banner đỏ toàn app ("số liệu có thể thiếu") — nguồn `getRecentDataErrorKinds()`;
 *  · thẻ "Sao lưu" ở Cài đặt › Dữ liệu — nguồn `docTrangThaiSaoLuu()`.
 *
 * Bug đang vá: kind BACKUP nằm trong danh sách bật banner ⇒ một lượt sao lưu hỏng khẳng định SAI
 * rằng doanh thu/"Tiền đã về" có thể thiếu, và giữ đỏ suốt `ERROR_WINDOW_HOURS` giờ KỂ CẢ khi lượt
 * sau đã chạy lại thành công — trong khi thẻ "Sao lưu" (đọc dòng BACKUP mới nhất) nói "ok". Hai
 * chỗ trên cùng một trang nói ngược nhau.
 *
 * Test đi qua CẢ HAI đầu đọc thật, không chỉ hằng danh sách: đổi hằng mà quên đổi câu truy vấn
 * (hoặc ngược lại) vẫn phải đỏ.
 */

/**
 * Dọn SẠCH bảng SyncLog: banner soi TOÀN BẢNG trong cửa sổ 48h, nên log sót của suite khác sẽ làm
 * `toEqual([])` chập chờn. An toàn vì `vitest.config.ts` đặt `fileParallelism: false` — không file
 * nào đang chạy song song để bị xoá mất fixture.
 */
async function donNhatKySync(): Promise<void> {
  await prisma.syncLog.deleteMany({});
}

/** Mốc TƯƠNG ĐỐI với lúc chạy: ngày cứng sẽ tự trôi ra ngoài cửa sổ 48h khi lịch đổi. */
function gioTruoc(soGio: number): Date {
  return new Date(Date.now() - soGio * 3_600_000);
}

beforeEach(async () => {
  await donNhatKySync();
});

afterAll(async () => {
  await donNhatKySync();
  await prisma.$disconnect();
});

describe("danh sách kind bật banner số liệu", () => {
  it("BACKUP đứng NGOÀI `DATA_SYNC_KINDS`, mọi kind còn lại vẫn ở trong", () => {
    expect(NON_DATA_SYNC_KINDS).toContain("BACKUP");
    expect(DATA_SYNC_KINDS).not.toContain("BACKUP");
    // Loại đúng MỘT kind, không nhân tiện làm câm cả banner.
    expect(DATA_SYNC_KINDS).toEqual(ALL_SYNC_KINDS.filter((k) => k !== "BACKUP"));
  });
});

describe("sao lưu lỗi KHÔNG bật banner 'số liệu có thể thiếu'", () => {
  it("BACKUP ERROR rồi lượt sau BACKUP OK → banner tắt, thẻ Sao lưu nói đúng trạng thái MỚI NHẤT", async () => {
    const luotLoi = gioTruoc(26);
    const luotOk = gioTruoc(2);
    await prisma.syncLog.createMany({
      data: [
        { kind: "BACKUP", status: "ERROR", startedAt: luotLoi, finishedAt: luotLoi, error: "disk full" },
        {
          kind: "BACKUP",
          status: "OK",
          startedAt: luotOk,
          finishedAt: luotOk,
          stats: { file: "hogikids-dem-nay.dump", sizeBytes: 22_958_125 },
        },
      ],
    });

    // Banner: `layout.tsx` bật khi mảng này không rỗng.
    expect(await getRecentDataErrorKinds()).toEqual([]);

    // Thẻ Sao lưu: bám lượt mới nhất (OK) — KHÔNG kẹt ở lượt lỗi hôm trước.
    const trangThai = await docTrangThaiSaoLuu();
    expect(trangThai.muc).toBe("ok");
    expect(trangThai.fileSizeBytes).toBe(22_958_125);
  });

  it("chỉ có MỘT lượt BACKUP ERROR → banner vẫn tắt, nhưng thẻ Sao lưu kêu đỏ kèm nguyên văn lỗi", async () => {
    const luotLoi = gioTruoc(1);
    await prisma.syncLog.create({
      data: {
        kind: "BACKUP",
        status: "ERROR",
        startedAt: luotLoi,
        finishedAt: luotLoi,
        error: "pg_dump: connection to server failed",
      },
    });

    expect(await getRecentDataErrorKinds()).toEqual([]);

    // Tín hiệu KHÔNG bị nuốt — chỉ đổi chỗ sở hữu, từ banner sang thẻ Sao lưu.
    const trangThai = await docTrangThaiSaoLuu();
    expect(trangThai.muc).toBe("loi");
    expect(trangThai.error).toBe("pg_dump: connection to server failed");
  });

  it("BACKUP lỗi ĐI KÈM một kind số liệu lỗi → banner vẫn phải đỏ, và chỉ kể kind số liệu", async () => {
    const luc = gioTruoc(3);
    await prisma.syncLog.createMany({
      data: [
        { kind: "BACKUP", status: "ERROR", startedAt: luc, finishedAt: luc, error: "disk full" },
        { kind: "PANCAKE", status: "ERROR", startedAt: luc, finishedAt: luc, error: "token hết hạn" },
      ],
    });

    // Loại BACKUP không được làm câm luôn cảnh báo thật.
    expect(await getRecentDataErrorKinds()).toEqual(["PANCAKE"]);
  });

  it("lỗi kind số liệu CŨ hơn cửa sổ soi → không tính (cửa sổ vẫn còn hiệu lực sau khi tách danh sách)", async () => {
    const quaCu = gioTruoc(ERROR_WINDOW_HOURS + 5);
    await prisma.syncLog.create({
      data: { kind: "TIKTOK_SHOP", status: "ERROR", startedAt: quaCu, finishedAt: quaCu, error: "429" },
    });

    expect(await getRecentDataErrorKinds()).toEqual([]);
  });
});
