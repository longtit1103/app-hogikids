import { afterAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { clearBronzeBacklog, hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { docChupLuc, landRaw } from "@/lib/bronze/land-raw";
import { latestPayloads } from "@/lib/bronze/transform-raw-helpers";
import { prisma } from "@/lib/prisma";

/**
 * Trang của lượt kéo chụp TRƯỚC về TRỄ (thứ tự nguồn) — bảng có cột lần thấy (`BANG_LAN_THAY`).
 *
 * Kịch bản: "Đồng bộ ngay" (hoặc chạy tay) chồng lên lượt đêm. Lượt 1 chụp báo cáo ads ở bản B lúc T1 nhưng trang
 * POST chậm; lượt 2 chụp bản C lúc T2 > T1 và POST trước ⇒ C đứng đầu. Trang trễ của lượt 1 tới sau:
 *  - mang B — bản ĐÃ CÓ trong kho thô (land từ đêm trước), không đứng đầu: so mốc LAND thì B được ghi lần thấy và đứng
 *    lại lên đầu dù nguồn đã ở C;
 *  - mang D — bản CHƯA có: so mốc LAND thì D chèn với `fetchedAt` mới nhất và đứng đầu.
 * Lượt dựng lại ads / Silver sản phẩm / đề xuất giá vốn lùi về bản cũ tới lượt kéo sau.
 *
 * Mốc chụp = trường `chupLuc` (ISO 8601 có múi giờ) trong thân `/api/ingest/raw`, lúc n8n BẮT ĐẦU GET trang đó; `landRaw`
 * ghi vào `mocChup` và mốc phiên bản chung là `COALESCE("mocChup","lanThayCuoi","fetchedAt")`.
 *
 * Đột biến phải làm đỏ: bỏ điều kiện "chupLuc ≥ mốc bản đầu" ở câu ghi lần thấy ⇒ test trang trễ mang B đỏ; chèn
 * `mocChup` bằng giờ land thay vì `chupLuc` ⇒ test trang trễ mang D đỏ; bỏ `mocChup` khỏi mốc phiên bản chung ⇒ cả hai
 * đỏ; bỏ ghi mốc cho bản ĐANG đứng đầu ⇒ hai test C→B→C đỏ; cho trang thiếu `chupLuc` đi luật cũ trên khoá đã có mốc
 * chụp ⇒ ba test "thiếu chupLuc" trên khoá có mốc đỏ; chặn trang thiếu `chupLuc` cả trên khoá thuần di sản ⇒ test
 * A→B→A di sản đỏ.
 */

const ADV = "7129548444015902722";
const CAMPAIGN = "1864314018521233";
const NGAY = "2026-10-20";
const KHOA = `${CAMPAIGN}:${NGAY}`;

const rpt = (cost: number) =>
  `{"code":0,"message":"OK","data":{"list":[{"dimensions":{"campaign_id":"${CAMPAIGN}",` +
  `"stat_time_day":"${NGAY} 00:00:00"},"metrics":{"campaign_name":"GMV Max - Ao vay","cost":${cost}}}],` +
  `"page_info":{"total_page":1}}}`;

const postTho = (than: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream: "tiktokbusiness/report", shopId: ADV, ...than }),
    }),
  );

/** POST một trang; `chupLuc` bỏ trống = người gọi chưa cập nhật (script, n8n cũ). */
const post = (cost: number, chupLuc?: Date) =>
  postTho({ payload: rpt(cost), ...(chupLuc ? { chupLuc: chupLuc.toISOString() } : {}) });

const chiPhiDauBang = async (): Promise<number> => {
  const [dau] = await latestPayloads("RawTiktokBusinessReport", { shopId: ADV, externalIds: [KHOA] });
  return (dau.payload as { metrics: { cost: number } }).metrics.cost;
};

/** Dòng kho thô của khoá theo chi phí trong payload. */
const dongTheoChiPhi = async (cost: number) => {
  const rows = await prisma.rawTiktokBusinessReport.findMany({ where: { shopId: ADV, externalId: KHOA } });
  const dong = rows.find((r) => (r.payload as { metrics: { cost: number } }).metrics.cost === cost);
  if (!dong) throw new Error(`không có dòng cost=${cost}`);
  return dong;
};

const PHUT_MS = 60_000;

async function cleanup(): Promise<void> {
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("landRaw — trang cũ đến muộn không được đẩy bản cũ lên đầu", () => {
  it("trang trễ của lượt chụp trước mang bản B đã có ⇒ đầu bảng vẫn là C (bản chụp sau)", async () => {
    const bayGio = Date.now();
    // Đêm trước: B vào kho thô, đứng đầu.
    expect((await post(200, new Date(bayGio - 24 * 60 * PHUT_MS))).status).toBe(200);
    // Lượt 2 chụp C lúc T2 = −5' và POST TRƯỚC.
    expect((await post(300, new Date(bayGio - 5 * PHUT_MS))).status).toBe(200);
    expect(await chiPhiDauBang()).toBe(300);
    const bTruoc = await dongTheoChiPhi(200);

    // Trang trễ của lượt 1 (chụp B lúc T1 = −10' < T2) về SAU.
    expect((await post(200, new Date(bayGio - 10 * PHUT_MS))).status).toBe(200);

    // Nguồn đang ở C (lần chụp mới nhất) ⇒ bản đầu phải là C; dòng B không bị ghi lần thấy.
    expect(await chiPhiDauBang()).toBe(300);
    const bSau = await dongTheoChiPhi(200);
    expect(bSau.lanThayCuoi).toBeNull();
    expect(bSau.mocChup).toEqual(bTruoc.mocChup);
  });

  it("trang trễ mang bản MỚI (chưa có) chụp cũ hơn bản đầu ⇒ vẫn chèn (landedIds giữ nghĩa) nhưng không đứng đầu", async () => {
    const bayGio = Date.now();
    expect((await post(300, new Date(bayGio - 5 * PHUT_MS))).status).toBe(200);
    // Trang trễ chụp lúc −10' mang D = 400, nội dung chưa từng land.
    expect((await post(400, new Date(bayGio - 10 * PHUT_MS))).status).toBe(200);

    const rows = await prisma.rawTiktokBusinessReport.findMany({ where: { shopId: ADV, externalId: KHOA } });
    expect(rows).toHaveLength(2);
    expect(await chiPhiDauBang()).toBe(300);
    const c = await dongTheoChiPhi(300);
    const d = await dongTheoChiPhi(400);
    expect(d.mocChup!.getTime()).toBeLessThan(c.mocChup!.getTime());
  });

  it("đối chứng: nguồn quay về B THẬT (lần chụp mới nhất là B) ⇒ B lên đầu (A→B→A vẫn chạy)", async () => {
    const bayGio = Date.now();
    await post(200, new Date(bayGio - 24 * 60 * PHUT_MS));
    await post(300, new Date(bayGio - 10 * PHUT_MS));
    await post(200, new Date(bayGio - 5 * PHUT_MS));

    expect(await chiPhiDauBang()).toBe(200);
  });

  it("C→B→C chồng lượt, B đã có: bản đầu C thấy lại ở T3 được ghi mốc ⇒ trang trễ mang B (T2) không lên đầu", async () => {
    const bayGio = Date.now();
    // Đêm trước: B vào kho thô. Lượt 1 chụp C lúc T1 = −20' ⇒ C đứng đầu.
    await post(200, new Date(bayGio - 24 * 60 * PHUT_MS));
    await post(300, new Date(bayGio - 20 * PHUT_MS));
    expect(await chiPhiDauBang()).toBe(300);
    // Nguồn đổi sang B, lượt X chụp B lúc T2 = −10' nhưng POST chậm. Nguồn quay về C, lượt 2 chụp C lúc T3 = −5', POST.
    const t3 = new Date(bayGio - 5 * PHUT_MS);
    expect((await post(300, t3)).status).toBe(200);
    // Mốc bản đầu phải tiến tới lần chụp mới nhất của nó.
    expect((await dongTheoChiPhi(300)).mocChup).toEqual(t3);

    // Trang trễ của lượt X mang B (T2 < T3) về sau cùng ⇒ nguồn đang ở C, C giữ đầu.
    expect((await post(200, new Date(bayGio - 10 * PHUT_MS))).status).toBe(200);
    expect(await chiPhiDauBang()).toBe(300);
    expect((await dongTheoChiPhi(200)).lanThayCuoi).toBeNull();
  });

  it("C→B→C chồng lượt, B chưa có: trang trễ chèn B (landedIds giữ nghĩa) nhưng B không lên đầu", async () => {
    const bayGio = Date.now();
    await post(300, new Date(bayGio - 20 * PHUT_MS));
    await post(300, new Date(bayGio - 5 * PHUT_MS));

    const res = await post(200, new Date(bayGio - 10 * PHUT_MS));
    expect(((await res.json()) as { stats: { landed: number } }).stats.landed).toBe(1);
    expect(await chiPhiDauBang()).toBe(300);
  });

  it("ghi mốc cho bản ĐANG đứng đầu: chỉ khi chupLuc mới hơn hẳn, và khoá không vào reseenIds (thứ tự không đổi)", async () => {
    const bayGio = Date.now();
    const t1 = new Date(bayGio - 20 * PHUT_MS);
    await post(300, t1);
    const landCo = (chupLuc: Date) =>
      landRaw("tiktokbusiness/report", ADV, rpt(300), undefined, undefined, undefined, undefined, chupLuc);
    const lanDau = await landCo(new Date(bayGio - 5 * PHUT_MS));
    expect(lanDau).toMatchObject({ landed: 0, landedIds: [], reseenIds: [] });
    const c = await dongTheoChiPhi(300);
    expect(c.mocChup).toEqual(new Date(bayGio - 5 * PHUT_MS));
    expect(c.lanThayCuoi).not.toBeNull();

    // Lần chụp CŨ hơn mốc bản đầu (trang trễ mang đúng bản đầu) ⇒ không ghi gì, mốc không lùi.
    const tre = await landCo(t1);
    expect(tre.reseenIds).toEqual([]);
    const cSau = await dongTheoChiPhi(300);
    expect(cSau.mocChup).toEqual(c.mocChup);
    expect(cSau.lanThayCuoi).toEqual(c.lanThayCuoi);
  });

  it("khoá đã có mốc chụp + trang thiếu chupLuc mang bản cũ đã có ⇒ không ghi lần thấy, không lên đầu", async () => {
    const bayGio = Date.now();
    await post(200, new Date(bayGio - 24 * 60 * PHUT_MS));
    await post(300, new Date(bayGio - 5 * PHUT_MS));
    expect(await chiPhiDauBang()).toBe(300);
    const bTruoc = await dongTheoChiPhi(200);

    // Người gọi không gửi mốc chụp (script, workflow chưa cài lại): lúc land luôn muộn hơn lúc GET thật ⇒ không được
    // vượt bản chụp đã chứng minh mốc.
    expect((await post(200)).status).toBe(200);
    expect(await chiPhiDauBang()).toBe(300);
    const bSau = await dongTheoChiPhi(200);
    expect(bSau.lanThayCuoi).toBeNull();
    expect(bSau.mocChup).toEqual(bTruoc.mocChup);
  });

  it("khoá đã có mốc chụp + trang thiếu chupLuc mang bản MỚI ⇒ chèn nhưng ngay dưới bản đầu; lượt có chupLuc kế sau đưa lên", async () => {
    const bayGio = Date.now();
    await post(300, new Date(bayGio - 5 * PHUT_MS));

    const res = await post(400);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stats: { landed: number } }).stats.landed).toBe(1);
    expect(await prisma.rawTiktokBusinessReport.count({ where: { shopId: ADV, externalId: KHOA } })).toBe(2);
    expect(await chiPhiDauBang()).toBe(300);
    // Xếp tất định: mốc bản mới nhỏ hơn hẳn mốc bản đầu (không trông vào id).
    const c = await dongTheoChiPhi(300);
    const d = await dongTheoChiPhi(400);
    expect(d.mocChup!.getTime()).toBe(c.mocChup!.getTime() - 1);

    // Lượt có chupLuc kế sau chụp được D ⇒ D lên đầu (dữ liệu mới thật chỉ trễ một lượt).
    expect((await post(400, new Date(bayGio - 1 * PHUT_MS))).status).toBe(200);
    expect(await chiPhiDauBang()).toBe(400);
  });

  it("khoá đã có mốc chụp nhưng bản đầu là dòng di sản land sau ⇒ bản mới thiếu chupLuc vẫn nằm dưới bản đầu đó", async () => {
    const bayGio = Date.now();
    // Lượt có mốc chụp land C (chụp −30'); dòng di sản B (không mốc chụp — land từ trước khi cài workflow mới, giả bằng
    // tay) có fetchedAt sau đó ⇒ B đứng đầu theo fetchedAt dù khoá đã có dòng mang mocChup.
    await post(300, new Date(bayGio - 30 * PHUT_MS));
    await post(200);
    await prisma.$executeRawUnsafe(
      `UPDATE "RawTiktokBusinessReport" SET "mocChup" = NULL, "fetchedAt" = clock_timestamp() - interval '1 minute'
       WHERE "payload"->'metrics'->>'cost' = '200'`,
    );
    expect(await chiPhiDauBang()).toBe(200);

    await post(400);
    expect(await chiPhiDauBang()).toBe(200);
  });

  it("khoá thuần di sản (không dòng nào có mocChup) + trang thiếu chupLuc ⇒ luật cũ y nguyên: A→B→A→B", async () => {
    await post(200);
    await post(300);
    expect(await chiPhiDauBang()).toBe(300);
    await post(200);
    expect(await chiPhiDauBang()).toBe(200);
    await post(300);
    expect(await chiPhiDauBang()).toBe(300);
    // Lần thấy lại thiếu mốc chụp chỉ ghi `lanThayCuoi`: khoá vẫn thuần di sản (không tự biến thành khoá "đã có mốc").
    const rows = await prisma.rawTiktokBusinessReport.findMany({ where: { shopId: ADV, externalId: KHOA } });
    expect(rows.every((r) => r.mocChup === null)).toBe(true);
    expect(rows.every((r) => r.lanThayCuoi !== null)).toBe(true);
  });

  it("chèn không kèm chupLuc ⇒ mocChup NULL, mốc phiên bản rơi về fetchedAt (thứ tự y cũ)", async () => {
    expect((await post(300)).status).toBe(200);
    const c = await dongTheoChiPhi(300);
    expect(c.mocChup).toBeNull();
    const [dau] = await latestPayloads("RawTiktokBusinessReport", { shopId: ADV, externalIds: [KHOA] });
    expect(dau.mocPhienBan.getTime()).toBe(c.fetchedAt.getTime());
  });

  it("dòng di sản (mocChup NULL, land từ hôm qua) trộn dòng có mốc chụp ⇒ bản chụp mới nhất đứng đầu", async () => {
    const bayGio = Date.now();
    await post(200);
    // Giả dòng có trước cột: không mốc chụp, land từ hôm qua. Đặt bằng đồng hồ DB — cùng đồng hồ ghi `fetchedAt`.
    await prisma.$executeRawUnsafe(
      `UPDATE "RawTiktokBusinessReport" SET "mocChup" = NULL, "fetchedAt" = clock_timestamp() - interval '1 day'`,
    );
    await post(300, new Date(bayGio - 5 * PHUT_MS));
    expect(await chiPhiDauBang()).toBe(300);

    // Trang trễ chụp trước C mang lại B di sản ⇒ C giữ đầu.
    await post(200, new Date(bayGio - 10 * PHUT_MS));
    expect(await chiPhiDauBang()).toBe(300);
    // Chụp lại B SAU C ⇒ B lên đầu.
    await post(200, new Date(bayGio - 1 * PHUT_MS));
    expect(await chiPhiDauBang()).toBe(200);
  });
});

describe("/api/ingest/raw — bảng lần thấy thiếu chupLuc ⇒ SyncLog cảnh báo", () => {
  const canhBao = async (): Promise<string[]> => {
    const [log] = await prisma.syncLog.findMany({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" }, take: 1 });
    return ((log?.stats as { warnings?: string[] } | null)?.warnings ?? []).filter((w) => w.includes("chupLuc"));
  };

  it("thiếu chupLuc ⇒ SyncLog cảnh báo (mốc = lúc land, có thể đảo thứ tự khi chạy chồng)", async () => {
    expect((await post(100)).status).toBe(200);
    expect(await canhBao()).toHaveLength(1);
  });

  it("có chupLuc ⇒ không cảnh báo", async () => {
    expect((await post(100, new Date(Date.now() - PHUT_MS))).status).toBe(200);
    expect(await canhBao()).toEqual([]);
  });
});

/**
 * Dữ liệu "đóng băng dưới bản đầu" phải ĐỎ: trang thiếu `chupLuc` trên khoá đã có mốc chụp mà nguồn báo nội dung khác bản
 * đầu ⇒ bản mới chỉ lên đầu ở lượt CÓ `chupLuc` kế tiếp. Workflow bị lùi / cài dở thì lượt đó không tới (biến thể mới
 * thiếu giá vốn, ads ngày cũ ra khỏi cửa sổ 7 ngày là kẹt hẳn) ⇒ SyncLog ERROR để bật banner, HTTP 200, kho thô vẫn land.
 * Khoá thuần di sản (trước khi nhập workflow mới) hoặc nội dung trùng bản đầu thì không chặn gì ⇒ chỉ cảnh báo.
 */
describe("/api/ingest/raw — trang thiếu chupLuc bị chặn vượt bản đầu ⇒ SyncLog ERROR", () => {
  const demLoi = () => prisma.syncLog.count({ where: { kind: "TIKTOK_ADS", status: "ERROR" } });
  const loiMoiNhat = async () =>
    (await prisma.syncLog.findFirst({ where: { kind: "TIKTOK_ADS", status: "ERROR" }, orderBy: { startedAt: "desc" } }))
      ?.error ?? null;

  beforeEach(() => clearBronzeBacklog());

  it("khoá có mốc chụp + bản MỚI thiếu chupLuc ⇒ chèn dưới bản đầu, ERROR, HTTP 200, không bật backlog", async () => {
    expect((await post(300, new Date(Date.now() - 5 * PHUT_MS))).status).toBe(200);
    expect(await demLoi()).toBe(0);

    const res = await post(400);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; loiSauKhiGhi?: string; stats: { landed: number } };
    expect(j.ok).toBe(true);
    expect(j.stats.landed).toBe(1);
    expect(j.loiSauKhiGhi).toMatch(/1 khoá .*chupLuc/);

    expect(await demLoi()).toBe(1);
    expect(await loiMoiNhat()).toMatch(/còn workflow chưa gửi chupLuc/);
    // Dữ liệu vẫn vào kho thô (chỉ nằm dưới bản đầu); dựng lại từ kho thô không cứu được nên KHÔNG bật backlog.
    expect((await dongTheoChiPhi(400)).id).toBeTruthy();
    expect(await chiPhiDauBang()).toBe(300);
    expect(await hasBronzeBacklog()).toBe(false);
  });

  it("khoá có mốc chụp + trang thiếu chupLuc mang lại bản cũ không đứng đầu (thấy lại bị bỏ) ⇒ ERROR", async () => {
    const bayGio = Date.now();
    await post(200, new Date(bayGio - 24 * 60 * PHUT_MS));
    await post(300, new Date(bayGio - 5 * PHUT_MS));
    expect(await demLoi()).toBe(0);

    const res = await post(200);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stats: { landed: number } }).stats.landed).toBe(0);
    expect(await demLoi()).toBe(1);
    expect(await chiPhiDauBang()).toBe(300);
  });

  it("khoá có mốc chụp + trang thiếu chupLuc mang ĐÚNG bản đầu ⇒ không chặn gì ⇒ OK + cảnh báo, không ERROR", async () => {
    await post(300, new Date(Date.now() - 5 * PHUT_MS));
    const res = await post(300);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { loiSauKhiGhi?: string }).loiSauKhiGhi).toBeUndefined();
    expect(await demLoi()).toBe(0);
  });

  it("khoá thuần di sản + trang thiếu chupLuc đổi nội dung ⇒ OK + cảnh báo, không ERROR (không đỏ mỗi đêm trước khi nhập workflow)", async () => {
    await post(200);
    const res = await post(300);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { loiSauKhiGhi?: string }).loiSauKhiGhi).toBeUndefined();
    expect(await chiPhiDauBang()).toBe(300);
    expect(await demLoi()).toBe(0);
    const [log] = await prisma.syncLog.findMany({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" }, take: 1 });
    expect(log.status).toBe("OK");
    expect(((log.stats as { warnings?: string[] }).warnings ?? []).some((w) => w.includes("chupLuc"))).toBe(true);
  });
});

describe("/api/ingest/raw — chupLuc hỏng ⇒ 400, không land, không mở SyncLog", () => {
  const bayGio = Date.now();
  const hong: [string, unknown][] = [
    ["thiếu chữ T + múi giờ", "2026-10-29 09:00:00"],
    ["không múi giờ (giờ máy — lệch 7h)", "2026-10-29T09:00:00"],
    ["ngày không có thật (V8 cuộn sang tháng 3)", "2026-02-31T00:00:00Z"],
    ["giờ 24", "2026-10-29T24:00:00Z"],
    ["kiểu số", 1793239200000],
    ["null", null],
    ["tương lai 1 giờ", new Date(bayGio + 60 * PHUT_MS).toISOString()],
    ["cũ 8 ngày", new Date(bayGio - 8 * 24 * 60 * PHUT_MS).toISOString()],
  ];

  for (const [moTa, chupLuc] of hong) {
    it(moTa, async () => {
      const res = await postTho({ payload: rpt(300), chupLuc });
      expect(res.status).toBe(400);
      const j = (await res.json()) as { ok: boolean; error: string };
      expect(j.ok).toBe(false);
      expect(j.error).toMatch(/chupLuc/);
      expect(await prisma.rawTiktokBusinessReport.count()).toBe(0);
      expect(await prisma.syncLog.count({ where: { kind: "TIKTOK_ADS" } })).toBe(0);
    });
  }
});

describe("docChupLuc — đọc trường chupLuc (thuần)", () => {
  const bayGio = Date.parse("2026-10-29T02:00:00.000Z");

  it("vắng mặt ⇒ undefined (luật cũ)", () => {
    expect(docChupLuc(undefined, bayGio)).toEqual({ ok: true, chupLuc: undefined });
  });

  it("Z và ±HH:MM cùng một thời điểm ⇒ cùng Date", () => {
    const z = docChupLuc("2026-10-29T01:59:00.123Z", bayGio);
    const vn = docChupLuc("2026-10-29T08:59:00.123+07:00", bayGio);
    expect(z).toEqual({ ok: true, chupLuc: new Date("2026-10-29T01:59:00.123Z") });
    expect(vn).toEqual(z);
  });

  it("biên cửa sổ: đúng +5' nhận, +5'01\" từ chối; đúng 7 ngày nhận, quá 1 giây từ chối", () => {
    expect(docChupLuc(new Date(bayGio + 5 * PHUT_MS).toISOString(), bayGio).ok).toBe(true);
    expect(docChupLuc(new Date(bayGio + 5 * PHUT_MS + 1000).toISOString(), bayGio).ok).toBe(false);
    expect(docChupLuc(new Date(bayGio - 7 * 24 * 60 * PHUT_MS).toISOString(), bayGio).ok).toBe(true);
    expect(docChupLuc(new Date(bayGio - 7 * 24 * 60 * PHUT_MS - 1000).toISOString(), bayGio).ok).toBe(false);
  });
});
