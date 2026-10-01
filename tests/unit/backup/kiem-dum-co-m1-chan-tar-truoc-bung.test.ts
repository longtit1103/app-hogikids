import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { kiemDumCoM1 } from "@/lib/backup/run-restore";

/**
 * Cổng sớm `kiemDumCoM1` (route phục hồi gọi TRƯỚC khoá/bản lùi) phải chặn `.tar.gz` backup-toàn-server
 * bằng `assertNotArchive` trên phần ĐẦU đã bung có trần — TRƯỚC khi bung trọn file.
 *
 * Tar toàn-server có đuôi dài toàn byte 0 (nén còn vài chục KB): bỏ bước chặn đầu là hàm đi thẳng tới
 * bung trọn (tới trần 24 MiB trong RAM) rồi mới từ chối bằng câu "vượt trần" — sai lý do, chỉ chủ shop
 * sang `restore.sh` với đúng file không bao giờ phục hồi được. Câu đúng phải nói "tar.gz toàn-server".
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

function tarGzToanServer(duoiByte0: number): Buffer {
  const tar = Buffer.alloc(1024 + duoiByte0, 0);
  tar.write("./docker/supabase/volumes/db/data/PG_VERSION", 0, "ascii");
  tar.write("ustar", 257, "ascii");
  return gzipSync(tar);
}

describe("kiemDumCoM1 — chặn tar.gz toàn-server trước khi bung trọn", () => {
  it("tar.gz nhỏ ⇒ từ chối bằng câu tar.gz toàn-server (không phải câu guard SQL)", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/db?schema=app");
    await expect(kiemDumCoM1(tarGzToanServer(0), "plain-gzip")).rejects.toThrow(/tar\.gz backup-toàn-server/);
  });

  it("tar.gz có đuôi byte 0 bung vượt trần ⇒ vẫn là câu tar.gz (đã chặn ở phần đầu, chưa bung trọn)", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/db?schema=app");
    const file = tarGzToanServer(30 * 1024 * 1024);
    expect(file.length).toBeLessThan(1024 * 1024); // nén rất nhỏ — trần upload không che được
    await expect(kiemDumCoM1(file, "plain-gzip")).rejects.toThrow(/tar\.gz backup-toàn-server/);
  });
});
