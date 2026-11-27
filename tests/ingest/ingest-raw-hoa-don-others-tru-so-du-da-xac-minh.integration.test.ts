import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

/**
 * Tập dấu băm GIẢ, đổi được theo từng ca: module tập bị thay bằng bản giữ nguyên mọi hàm, chỉ hằng tập trỏ tới Set này.
 * Transform truyền hằng TƯỜNG MINH cho hàm phân loại ⇒ nhận đúng tập giả.
 */
const tapGia = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/ingest/tiktok-hoa-don-others-tru-so-du-da-xac-minh", async (importOriginal) => {
  const goc = await importOriginal<typeof import("@/lib/ingest/tiktok-hoa-don-others-tru-so-du-da-xac-minh")>();
  return { ...goc, DAU_BAM_OTHERS_TRU_SO_DU_DA_XAC_MINH: tapGia };
});

import { POST } from "@/app/api/ingest/raw/route";
import { clearBronzeBacklog } from "@/lib/bronze/bronze-only";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docGiaoDichThe, docKyNeoThe } from "@/lib/no-phai-tra/du-no-the";
import { duNo } from "@/lib/no-phai-tra/ky-sao-ke";
import { prisma } from "@/lib/prisma";

import {
  BC,
  DONG_NAP,
  DONG_OTHERS,
  DONG_P8,
  ID_NAP,
  ID_OTHERS,
  ID_P8,
  INVOICE_TACH_DOI,
  NAP,
  P8,
  STREAM_HOA_DON,
  tapGiaTuOthers,
  trangHoaDon,
} from "../helpers/hoa-don-tiktok-others-fixture";
import { truncateBusinessTables } from "../helpers/test-db";

/**
 * Hoá đơn TikTok OTHERS trừ số dư ĐÃ XÁC MINH qua route THẬT `/api/ingest/raw` (land + transform + SyncLog), id GIẢ.
 * Trong tập ⇒ bỏ CÓ CHỦ ĐÍCH (không Silver, không `skipped`, không ERROR, không backlog, đếm `boQuaTruSoDuDaXacMinh`);
 * ngoài tập ⇒ y như ghim ở `ingest-raw-hoa-don-others-giu-error-backlog.integration.test.ts`. Nợ thẻ không đổi một đồng.
 * Fixture mang subtotal/tax là SỐ JSON + amount JSON null (đúng hình dạng hồ sơ gốc) còn tập giả tính trên bản đồ chuỗi
 * ⇒ ca "trong tập" cũng khẳng định đường rút `#>> '{}'` của Postgres cho cùng chuỗi với cách tính băm.
 */

const post = (payload: string, luotId: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream: STREAM_HOA_DON, shopId: BC, payload, luotId }),
    }),
  );

const dongMoiNhat = () =>
  prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });

const coBacklog = async () =>
  (await prisma.setting.findUnique({ where: { key: "bronzeBacklogPending" } }))?.value;

const datTap = (viTri: readonly number[]) => {
  tapGia.clear();
  for (const h of tapGiaTuOthers(viTri)) tapGia.add(h);
};

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);

/** M = 01/09, thẻ gánh TIKTOK_ADS từ 01/09, neo mở sổ 0 cuối 31/08 — cùng khuôn test ghim nợ thẻ. */
async function dungThe(): Promise<string> {
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-09-01" } });
  const { id } = await prisma.theTinDung.create({ data: { ten: "Thẻ TikTok", ngayChotSaoKe: 20, ngayHanTra: 5 } });
  await prisma.ganNenTangThe.create({ data: { cardId: id, nenTang: "TIKTOK_ADS", tuNgay: vn("2026-09-01") } });
  await prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn("2026-08-31"), soDu: 0, laNeoMoSo: true } });
  return id;
}

async function duNoCuoi30(cardId: string): Promise<number | null> {
  const t = vn("2026-09-30", "12:00:00");
  return duNo(await docKyNeoThe(cardId), await docGiaoDichThe(cardId, t), t);
}

async function cleanup(): Promise<void> {
  await truncateBusinessTables();
  await prisma.tiktokBcHoaDon.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
  await clearBronzeBacklog();
  tapGia.clear();
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const TRANG_DU = () => trangHoaDon([DONG_NAP, ...DONG_OTHERS, DONG_P8]);

describe("/api/ingest/raw — hoá đơn OTHERS trong tập đã xác minh", () => {
  it("N + O1–O8 (cả 8 trong tập) + P8 ⇒ 200, SyncLog OK, skipped 0, bỏ có chủ đích 8, backlog tắt, nợ thẻ N + P8", async () => {
    datTap([0, 1, 2, 3, 4, 5, 6, 7]);
    const the = await dungThe();

    const res = await post(TRANG_DU(), "luot-tap-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loiSauKhiGhi?: string };
    expect(body.loiSauKhiGhi).toBeUndefined();

    const log = await dongMoiNhat();
    expect(log.status).toBe("OK");
    expect(log.error).toBeNull();
    expect(log.stats).toMatchObject({
      stream: STREAM_HOA_DON,
      shopId: BC,
      luotId: "luot-tap-1",
      skipped: 0,
      boQuaTruSoDuDaXacMinh: 8,
      hoaDonAdsUpserted: 2,
    });
    const canhBao = (log.stats as { warnings?: string[] }).warnings ?? [];
    expect(canhBao.filter((w) => w.includes("không biết chiều tiền"))).toEqual([]);

    expect(await coBacklog()).not.toBe("1");

    const bronze = await prisma.rawTiktokBusinessInvoice.findMany({ where: { shopId: BC }, select: { externalId: true } });
    expect(bronze.map((b) => b.externalId).sort()).toEqual([ID_NAP, ...ID_OTHERS, ID_P8].sort());

    const silver = await prisma.tiktokAdsHoaDon.findMany({
      select: { transactionId: true, amount: true, amountType: true, invoiceId: true },
      orderBy: { transactionId: "asc" },
    });
    expect(silver).toEqual([
      { transactionId: ID_NAP, amount: NAP, amountType: "POSITIVE", invoiceId: "7000000000000000200" },
      { transactionId: ID_P8, amount: P8, amountType: "POSITIVE", invoiceId: INVOICE_TACH_DOI },
    ]);

    expect(await duNoCuoi30(the)).toBe(NAP + P8);
  });

  it("trang trộn 5 trong tập + 3 ngoài ⇒ ERROR, skipped 3, bỏ có chủ đích 5, backlog bật, cảnh báo chỉ nêu 3 id ngoài tập", async () => {
    datTap([0, 1, 2, 3, 4]);

    const res = await post(TRANG_DU(), "luot-tap-2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loiSauKhiGhi?: string };
    expect(body.loiSauKhiGhi).toContain("3 record đã vào kho thô nhưng KHÔNG dựng được Silver");

    const log = await dongMoiNhat();
    expect(log.status).toBe("ERROR");
    expect(log.error).toContain("dư nợ thẻ tín dụng đang THIẾU");
    expect(log.stats).toMatchObject({ skipped: 3, boQuaTruSoDuDaXacMinh: 5, hoaDonAdsUpserted: 2 });

    const canhBao = (log.stats as { warnings?: string[] }).warnings ?? [];
    const nhacToi = ID_OTHERS.filter((id) => canhBao.some((w) => w.includes(id)));
    expect(nhacToi).toEqual(ID_OTHERS.slice(5));
    for (const id of ID_OTHERS.slice(5)) {
      expect(canhBao.some((w) => w.includes(id) && w.includes("không biết chiều tiền")), id).toBe(true);
    }

    expect(await coBacklog()).toBe("1");
    expect(await prisma.tiktokAdsHoaDon.count()).toBe(2);
  });

  it("id trong tập nhưng subtotal về dạng số thực 2345675.0 ⇒ băm khác ⇒ ERROR skipped 1, backlog bật", async () => {
    datTap([0, 1, 2, 3, 4, 5, 6, 7]);
    // jsonb giữ nguyên `2345675.0` khi rút text ⇒ chuỗi băm khác lúc xác minh ⇒ không tự coi là cùng giao dịch.
    const o2 = JSON.stringify(DONG_OTHERS[1]).replace('"subtotal":2345675,', '"subtotal":2345675.0,');
    expect(o2).toContain('"subtotal":2345675.0,');
    const payload = trangHoaDon([DONG_NAP, DONG_P8]).replace('"transaction_list":[', `"transaction_list":[${o2},`);

    expect((await post(payload, "luot-tap-3")).status).toBe(200);
    const log = await dongMoiNhat();
    expect(log.status).toBe("ERROR");
    expect(log.stats).toMatchObject({ skipped: 1, boQuaTruSoDuDaXacMinh: 0, hoaDonAdsUpserted: 2 });
    expect(await coBacklog()).toBe("1");
  });
});

describe("/api/ingest/raw — mã thuộc tập nhưng bảng hoá đơn đã có dòng cùng mã", () => {
  it("POSITIVE của O2 vào Silver, rồi TikTok trả lại bản OTHERS trong tập ⇒ ERROR, skipped 1, backlog bật, dòng POSITIVE giữ nguyên", async () => {
    datTap([1]);
    const id = ID_OTHERS[1];
    const positive = { ...DONG_OTHERS[1], amount_type: "POSITIVE", amount: "2580243" };

    expect((await post(trangHoaDon([positive]), "luot-cung-ma-1")).status).toBe(200);
    expect((await dongMoiNhat()).status).toBe("OK");
    expect(await coBacklog()).not.toBe("1");

    const res = await post(trangHoaDon([DONG_OTHERS[1]]), "luot-cung-ma-2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loiSauKhiGhi?: string };
    expect(body.loiSauKhiGhi).toContain("1 record đã vào kho thô nhưng KHÔNG dựng được Silver");

    const log = await dongMoiNhat();
    expect(log.status).toBe("ERROR");
    expect(log.stats).toMatchObject({ luotId: "luot-cung-ma-2", skipped: 1, boQuaTruSoDuDaXacMinh: 0, hoaDonAdsUpserted: 0 });
    const canhBao = (log.stats as { warnings?: string[] }).warnings ?? [];
    expect(
      canhBao.some(
        (w) =>
          w.includes(id) &&
          w.includes("thuộc tập trừ số dư đã xác minh nhưng bảng hoá đơn đang có dòng cùng mã") &&
          w.includes("nợ thẻ có thể đang tính khoản này; kiểm tay"),
      ),
      canhBao.join("\n"),
    ).toBe(true);
    expect(await coBacklog()).toBe("1");

    expect(
      await prisma.tiktokAdsHoaDon.findMany({ select: { transactionId: true, amount: true, amountType: true } }),
    ).toEqual([{ transactionId: id, amount: 2_580_243, amountType: "POSITIVE" }]);
  });

  it("đối chứng: cùng mã thuộc tập, bảng hoá đơn KHÔNG có dòng ⇒ bỏ có chủ đích, SyncLog OK, backlog tắt", async () => {
    datTap([1]);
    expect((await post(trangHoaDon([DONG_OTHERS[1]]), "luot-cung-ma-3")).status).toBe(200);
    const log = await dongMoiNhat();
    expect(log.status).toBe("OK");
    expect(log.stats).toMatchObject({ skipped: 0, boQuaTruSoDuDaXacMinh: 1, hoaDonAdsUpserted: 0 });
    expect(await coBacklog()).not.toBe("1");
    expect(await prisma.tiktokAdsHoaDon.count()).toBe(0);
  });
});

describe("tập đã xác minh không đổi tiền", () => {
  it("cùng dữ liệu N + P8 + O1–O8: dư nợ thẻ khi tập rỗng = khi tập đủ = N + P8", async () => {
    const soDuNo: Array<number | null> = [];
    for (const viTri of [[], [0, 1, 2, 3, 4, 5, 6, 7]] as const) {
      await cleanup();
      datTap(viTri);
      const the = await dungThe();
      expect((await post(TRANG_DU(), `luot-tien-${viTri.length}`)).status).toBe(200);
      expect((await dongMoiNhat()).status).toBe(viTri.length === 0 ? "ERROR" : "OK");
      soDuNo.push(await duNoCuoi30(the));
    }
    expect(soDuNo).toEqual([NAP + P8, NAP + P8]);
  });
});
