import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

// Phép đếm PHIẾU NHẬP luôn ném — đối xứng với file `...-mot-phep-dem-hong` (giá vốn ném). `vi.mock`
// hoist lên trước mọi import nên `cap-nhat-so-phieu-nhap` nhận bản giả này. File riêng vì mock áp
// cho cả file.
vi.mock("@/lib/nhap-hang/dem-phieu-nhap-chua-ghi", () => ({
  demPhieuNhapChuaGhi: vi.fn().mockRejectedValue(new Error("Bronze phiếu nhập không đọc được")),
}));

import { POST } from "@/app/api/ingest/dem-gia-von/route";
import { KEY_MOC_KIEM_GIA_VON, KEY_SO_LECH_GIA_VON } from "@/lib/gia-von/trang-thai-lech-gia-von";
import { MODE_BUOC_CUOI_DONG_BO_NGAY } from "@/lib/ingest/tien-do-dong-bo-ngay";
import { KEY_MOC_KIEM_PHIEU_NHAP, KEY_SO_PHIEU_NHAP_CHUA_GHI } from "@/lib/nhap-hang/trang-thai-phieu-nhap";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Chiều ngược của lưới "hai phép đếm độc lập": phép đếm phiếu nhập hỏng thì
 *  - route vẫn trả lỗi THẬT (500 + SyncLog ERROR) — nuốt lỗi là trả 200 với `soPhieuNhapChuaGhi:
 *    null`, mốc `purchaseCheckedAt` không nhích mà không ai biết;
 *  - phép đếm giá vốn vẫn chốt số (một cái hỏng không chặn cái kia);
 *  - dòng SyncLog ERROR vẫn mang dấu `stats.mode` ⇒ nút "Đồng bộ ngay" nhận ra bước cuối LỖI.
 */

const post = () =>
  POST(
    new Request("http://localhost/api/ingest/dem-gia-von", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );

const docSetting = (key: string) => prisma.setting.findUnique({ where: { key } });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.syncLog.deleteMany({ where: { kind: "PANCAKE" } });
  await prisma.setting.deleteMany({
    where: {
      key: { in: [KEY_SO_LECH_GIA_VON, KEY_MOC_KIEM_GIA_VON, KEY_SO_PHIEU_NHAP_CHUA_GHI, KEY_MOC_KIEM_PHIEU_NHAP] },
    },
  });
});

describe("POST /api/ingest/dem-gia-von — đếm phiếu nhập HỎNG", () => {
  it("trả 500 nêu đúng phép hỏng, giá vốn VẪN được chốt, phiếu nhập KHÔNG ghi số", async () => {
    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).toContain("Đếm phiếu nhập chưa ghi hỏng");
    expect(JSON.stringify(body)).not.toContain("Đếm lệch giá vốn hỏng");

    // Phép đếm giá vốn chạy trọn (không Bronze products ⇒ 0 lệch, nhưng ô PHẢI có số + mốc).
    expect((await docSetting(KEY_SO_LECH_GIA_VON))?.value).toBe("0");
    expect((await docSetting(KEY_MOC_KIEM_GIA_VON))?.value).toBeTruthy();
    // Phiếu nhập hỏng ⇒ thà trống còn hơn số sai.
    expect(await docSetting(KEY_SO_PHIEU_NHAP_CHUA_GHI)).toBeNull();
    expect(await docSetting(KEY_MOC_KIEM_PHIEU_NHAP)).toBeNull();
  });

  it("dòng SyncLog ERROR giữ dấu stats.mode của bước cuối", async () => {
    await post();

    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "PANCAKE" }, orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("ERROR");
    expect(log.error).toContain("Đếm phiếu nhập chưa ghi hỏng");
    expect(log.stats).toMatchObject({ mode: MODE_BUOC_CUOI_DONG_BO_NGAY });
  });
});
