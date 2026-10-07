import { beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});

import { POST as demNhacViec } from "@/app/api/ingest/dem-gia-von/route";
import { getTienDoDongBoNgay } from "@/lib/actions/sync";
import { withSyncLog } from "@/lib/ingest/sync-log";
import {
  ketLuanTienDo,
  MA_MOC_NGOAI_DAI,
  MODE_BUOC_CUOI_DONG_BO_NGAY,
  thongDiepKetLuan,
} from "@/lib/ingest/tien-do-dong-bo-ngay";
import { prisma } from "@/lib/prisma";

/**
 * `getTienDoDongBoNgay` trên DB test thật: đúng dòng nào là BƯỚC CUỐI, đúng phạm vi "sau mốc bấm".
 *
 * Phần dễ sai nhất là nhận diện bước cuối qua cột JSON `stats` (nullable): dòng trang kéo có
 * `stats` không chứa `mode`, dòng RUNNING trước đây có `stats` NULL, dòng ERROR trước đây chỉ có
 * `warnings`. Test đi qua route THẬT + `withSyncLog` THẬT để chứng minh dấu `mode` có mặt ở cả ba
 * kết cục mà nút bấm phải nhận ra.
 */

const goiRouteDem = () =>
  demNhacViec(
    new Request("http://localhost/api/ingest/dem-gia-von", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );

async function tienDo(mocBam: Date) {
  const r = await getTienDoDongBoNgay(mocBam.toISOString());
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

beforeEach(async () => {
  await prisma.syncLog.deleteMany({ where: { kind: "PANCAKE" } });
});

describe("getTienDoDongBoNgay", () => {
  it("mốc không hợp lệ ⇒ từ chối, không ném", async () => {
    expect(await getTienDoDongBoNgay("khong-phai-ngay")).toMatchObject({ ok: false });
  });

  it("mốc ngoài dải (quá cũ ⇒ quét cả bảng; tương lai) ⇒ từ chối mã MOC_NGOAI_DAI, không quét", async () => {
    expect(await getTienDoDongBoNgay("1970-01-01T00:00:00.000Z")).toMatchObject({ ok: false, code: MA_MOC_NGOAI_DAI });
    expect(await getTienDoDongBoNgay(new Date(Date.now() - 21 * 60_000).toISOString())).toMatchObject({
      ok: false,
      code: MA_MOC_NGOAI_DAI,
    });
    expect(await getTienDoDongBoNgay(new Date(Date.now() + 5 * 60_000).toISOString())).toMatchObject({
      ok: false,
      code: MA_MOC_NGOAI_DAI,
    });
    expect((await getTienDoDongBoNgay(new Date(Date.now() - 19 * 60_000).toISOString())).ok).toBe(true);
  });

  it("route nhận LỖI KÉO purchases ⇒ tiến độ kết luận LỖI, câu báo nêu purchases/kho", async () => {
    const moc = new Date(Date.now() - 1_000);
    const res = await demNhacViec(
      new Request("http://localhost/api/ingest/dem-gia-von", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({
          soLoiKeo: 1,
          loiKeo: [{ scope: "CA_STREAM_BI_BO", stream: "purchases", shop: "kho", lyDo: "status code 429" }],
        }),
      }),
    );
    expect(res.status).toBe(200);

    const kl = ketLuanTienDo(await tienDo(moc));

    expect(kl.loai).toBe("loi-buoc-cuoi");
    expect(thongDiepKetLuan(kl)?.noiDung).toContain("purchases/kho");
  });

  it("chỉ có dòng trang kéo (kể cả trang lỗi) ⇒ CHƯA tới bước cuối, đếm đúng lượt/lỗi", async () => {
    const moc = new Date();
    await prisma.syncLog.createMany({
      data: [
        // Dòng TRƯỚC mốc bấm — không được tính.
        { kind: "PANCAKE", status: "OK", startedAt: new Date(moc.getTime() - 60_000), stats: { mode: MODE_BUOC_CUOI_DONG_BO_NGAY } },
        { kind: "PANCAKE", status: "OK", startedAt: new Date(moc.getTime() + 1_000), finishedAt: new Date(moc.getTime() + 2_000), stats: { stream: "purchases", mode: "land+transform" } },
        { kind: "PANCAKE", status: "ERROR", startedAt: new Date(moc.getTime() + 3_000), finishedAt: new Date(moc.getTime() + 4_000), error: "trang hỏng" },
      ],
    });

    const s = await tienDo(moc);

    expect(s.buocCuoi).toBeNull();
    expect(s.soLuot).toBe(2);
    expect(s.soLuotLoi).toBe(1);
    expect(s.coLuotDangChay).toBe(false);
    expect(s.hoatDongCuoi).toBe(new Date(moc.getTime() + 4_000).toISOString());
  });

  it("bước cuối OK qua route thật ⇒ nhận ra, kết luận XONG", async () => {
    const moc = new Date(Date.now() - 1_000);
    expect((await goiRouteDem()).status).toBe(200);

    const s = await tienDo(moc);

    expect(s.buocCuoi).toEqual({ status: "OK", error: null });
    expect(ketLuanTienDo(s)).toEqual({ loai: "xong", soLuotLoi: 0 });
  });

  it("bước cuối ERROR (withSyncLog nhánh ném) VẪN mang dấu mode ⇒ báo lỗi, không bị coi là trang lẻ", async () => {
    const moc = new Date(Date.now() - 1_000);
    const res = await withSyncLog(
      "PANCAKE",
      async () => {
        throw new Error("Đếm phiếu nhập chưa ghi hỏng: giả lập");
      },
      { dauNhanDien: { mode: MODE_BUOC_CUOI_DONG_BO_NGAY } },
    );
    expect(res.status).toBe(500);

    const s = await tienDo(moc);

    expect(s.buocCuoi).toEqual({ status: "ERROR", error: "Đếm phiếu nhập chưa ghi hỏng: giả lập" });
    // Lỗi của CHÍNH bước cuối không bị đếm thêm vào "lượt kéo lỗi".
    expect(s.soLuotLoi).toBe(0);
    expect(ketLuanTienDo(s)).toMatchObject({ loai: "loi-buoc-cuoi" });
  });

  it("bước cuối ERROR CÓ cảnh báo (nhánh ném ghi đè `stats`) vẫn giữ dấu mode", async () => {
    const moc = new Date(Date.now() - 1_000);
    await withSyncLog(
      "PANCAKE",
      async (warnings) => {
        warnings.push("cảnh báo trước khi hỏng");
        throw new Error("hỏng sau cảnh báo");
      },
      { dauNhanDien: { mode: MODE_BUOC_CUOI_DONG_BO_NGAY } },
    );

    const s = await tienDo(moc);

    expect(s.buocCuoi).toEqual({ status: "ERROR", error: "hỏng sau cảnh báo" });
    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "PANCAKE" }, orderBy: { startedAt: "desc" } });
    expect(log.stats).toEqual({ mode: MODE_BUOC_CUOI_DONG_BO_NGAY, warnings: ["cảnh báo trước khi hỏng"] });
  });

  it("bước cuối đang RUNNING đã mang dấu mode ⇒ còn chạy, chưa kết luận", async () => {
    const moc = new Date(Date.now() - 1_000);
    let tienDoGiuaChung: Awaited<ReturnType<typeof tienDo>> | null = null;
    await withSyncLog(
      "PANCAKE",
      async () => {
        tienDoGiuaChung = await tienDo(moc);
        return {};
      },
      { dauNhanDien: { mode: MODE_BUOC_CUOI_DONG_BO_NGAY } },
    );

    expect(tienDoGiuaChung).toMatchObject({ buocCuoi: { status: "RUNNING" }, coLuotDangChay: true });
    expect(ketLuanTienDo(tienDoGiuaChung!)).toEqual({ loai: "dang-chay" });
  });
});
