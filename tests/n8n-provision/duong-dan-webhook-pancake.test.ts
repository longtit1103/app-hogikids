import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cheDuongDan,
  docDuongDanWebhookBatBuoc,
  docDuongDanWebhookPancake,
  KHOA_SETTING_DUONG_DAN_WEBHOOK,
  laDuongDanWebhookHopLe,
  lyDoTuChoiSinhPathNgauNhien,
  napDuongDanNeuThieu,
  PLACEHOLDER_DUONG_DAN_WEBHOOK,
  rutDuongDanWebhookTuNodes,
  sinhDuongDanWebhookMoi,
  ThieuDuongDanWebhook,
  type TrangThaiWebhookTrenN8n,
  VAI_WEBHOOK_PANCAKE,
  vaiTheoPlaceholder,
  vanTayDuongDan,
  xoayDuongDanWebhookPancake,
} from "@/lib/n8n/provision/duong-dan-webhook-pancake";
import { prisma } from "@/lib/prisma";

/**
 * Path 3 webhook Pancake là dữ liệu của instance trong `Setting`. Khoá các hợp đồng sống còn:
 * nạp KHÔNG BAO GIỜ ghi đè path đang chạy (đè = lượt Cài kế tiếp đăng ký path khác, Pancake bắn vào
 * 404), xoay thì ghi đè có chủ đích bằng path ngẫu nhiên phân biệt, và placeholder không bao giờ được
 * coi là path hợp lệ. Phần đụng DB chạy trên DB test thật; trạng thái 3 khoá được trả lại sau file.
 */

const KHOA = VAI_WEBHOOK_PANCAKE.map((v) => KHOA_SETTING_DUONG_DAN_WEBHOOK[v]);
const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";
const C = "00112233445566778899aabbccddeeff";

let truocFile: Array<{ key: string; value: string }> = [];
beforeAll(async () => {
  truocFile = await prisma.setting.findMany({ where: { key: { in: KHOA } }, select: { key: true, value: true } });
});
beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: KHOA } } });
});
afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: KHOA } } });
  for (const r of truocFile) await prisma.setting.create({ data: r });
});

describe("phần thuần", () => {
  it("sinh path mới = 32 hex thường, hợp lệ, mỗi lần một giá trị", () => {
    const p1 = sinhDuongDanWebhookMoi();
    const p2 = sinhDuongDanWebhookMoi();
    expect(p1).toMatch(/^[0-9a-f]{32}$/);
    expect(laDuongDanWebhookHopLe(p1)).toBe(true);
    expect(p1).not.toBe(p2);
  });

  it("placeholder, rỗng, có `/`, quá ngắn đều KHÔNG hợp lệ", () => {
    for (const vai of VAI_WEBHOOK_PANCAKE) expect(laDuongDanWebhookHopLe(PLACEHOLDER_DUONG_DAN_WEBHOOK[vai])).toBe(false);
    for (const hong of ["", "ngan", "abc/defghijklmnopqrstu", "co khoang trang 1234567", null, undefined]) {
      expect(laDuongDanWebhookHopLe(hong), String(hong)).toBe(false);
    }
  });

  it("placeholder → đúng vai; path thường → null", () => {
    expect(vaiTheoPlaceholder("__DUONG_DAN_WEBHOOK_KHO__")).toBe("kho");
    expect(vaiTheoPlaceholder("__DUONG_DAN_WEBHOOK_SHOPEE__")).toBe("shopee");
    expect(vaiTheoPlaceholder("__DUONG_DAN_WEBHOOK_TIKTOK__")).toBe("tiktok");
    expect(vaiTheoPlaceholder("hogikids-sync-now")).toBeNull();
  });

  it("che path chỉ để lộ đuôi 4 ký tự", () => {
    const che = cheDuongDan(A);
    expect(che).not.toContain(A.slice(0, 28));
    expect(che).toContain(A.slice(-4));
  });

  it("rút path từ node webhook của workflow n8n; không có node webhook ⇒ null", () => {
    expect(rutDuongDanWebhookTuNodes([{ type: "n8n-nodes-base.code" }, { type: "n8n-nodes-base.webhook", parameters: { path: A } }])).toBe(A);
    expect(rutDuongDanWebhookTuNodes([{ type: "n8n-nodes-base.code" }])).toBeNull();
    expect(rutDuongDanWebhookTuNodes("rác")).toBeNull();
  });

  it("vân tay = sha256 hex của đúng chuỗi path (cùng dạng VAN_TAY_PATH_WEBHOOK của cổng publish), không chứa path", () => {
    // sha256("abc") — vector chuẩn FIPS 180-2.
    expect(vanTayDuongDan("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const vt = vanTayDuongDan(A);
    expect(vt).toMatch(/^[0-9a-f]{64}$/);
    expect(vt).not.toContain(A);
    expect(vanTayDuongDan(B)).not.toBe(vt);
  });

  it("thông điệp thiếu path (hiện ở UI bản ĐANG CHẠY) KHÔNG gợi ý sinh path ngẫu nhiên", () => {
    const loi = new ThieuDuongDanWebhook(["kho"]);
    expect(loi.message).toContain("n8nWebhookPath.kho");
    expect(loi.message).toContain("nap-duong-dan-webhook-n8n");
    expect(loi.message).not.toMatch(/ngau-nhien/);
  });
});

describe("cổng sinh path ngẫu nhiên (chỉ cho bản clone mới)", () => {
  const ca = (tt: TrangThaiWebhookTrenN8n) => ({ kho: tt, shopee: tt, tiktok: tt });

  it("Setting trống + n8n đọc được, không có workflow webhook nào (hoặc chỉ workflow TẮT) ⇒ cho phép", () => {
    expect(lyDoTuChoiSinhPathNgauNhien({ settingDaCo: [], n8n: { docDuoc: true, trangThai: ca("khong-co") } })).toEqual([]);
    expect(
      lyDoTuChoiSinhPathNgauNhien({ settingDaCo: [], n8n: { docDuoc: true, trangThai: { kho: "tat", shopee: "khong-co", tiktok: "tat" } } })
    ).toEqual([]);
  });

  it("n8n có workflow webhook ĐANG BẬT với path hợp lệ ⇒ từ chối, nêu đúng vai", () => {
    const lyDo = lyDoTuChoiSinhPathNgauNhien({
      settingDaCo: [],
      n8n: { docDuoc: true, trangThai: { kho: "khong-co", shopee: "dang-chay", tiktok: "khong-co" } },
    });
    expect(lyDo).toHaveLength(1);
    expect(lyDo[0]).toMatch(/pancake-webhook-shopee.*ĐANG BẬT/);
  });

  it("trùng tên / path hỏng trên n8n (không xác định được) ⇒ từ chối", () => {
    expect(lyDoTuChoiSinhPathNgauNhien({ settingDaCo: [], n8n: { docDuoc: true, trangThai: { ...ca("khong-co"), tiktok: "khong-ro" } } })).toHaveLength(1);
  });

  it("KHÔNG đọc được n8n (thiếu cấu hình / API key hết hạn) ⇒ từ chối (fail-closed), nêu lỗi", () => {
    const lyDo = lyDoTuChoiSinhPathNgauNhien({ settingDaCo: [], n8n: { docDuoc: false, loi: "HTTP 401" } });
    expect(lyDo).toHaveLength(1);
    expect(lyDo[0]).toMatch(/HTTP 401/);
  });

  it("Setting đã có path (dù n8n trống) ⇒ từ chối: không phải bản clone mới", () => {
    const lyDo = lyDoTuChoiSinhPathNgauNhien({ settingDaCo: ["kho"], n8n: { docDuoc: true, trangThai: ca("khong-co") } });
    expect(lyDo).toHaveLength(1);
    expect(lyDo[0]).toMatch(/Setting đã có path cho kho/);
  });
});

describe("đọc / nạp / xoay trên Setting", () => {
  it("Setting trống ⇒ đọc báo thiếu đủ 3 vai; bản bắt buộc ném ThieuDuongDanWebhook", async () => {
    const kq = await docDuongDanWebhookPancake(prisma);
    expect(kq.ok).toBe(false);
    if (!kq.ok) expect(kq.thieu).toEqual(["kho", "shopee", "tiktok"]);
    await expect(docDuongDanWebhookBatBuoc(prisma)).rejects.toBeInstanceOf(ThieuDuongDanWebhook);
  });

  it("giá trị Setting là placeholder ⇒ tính là THIẾU, không hiện/đẩy placeholder", async () => {
    await prisma.setting.createMany({
      data: [
        { key: KHOA_SETTING_DUONG_DAN_WEBHOOK.kho, value: A },
        { key: KHOA_SETTING_DUONG_DAN_WEBHOOK.shopee, value: PLACEHOLDER_DUONG_DAN_WEBHOOK.shopee },
        { key: KHOA_SETTING_DUONG_DAN_WEBHOOK.tiktok, value: C },
      ],
    });
    const kq = await docDuongDanWebhookPancake(prisma);
    expect(kq.ok).toBe(false);
    if (!kq.ok) {
      expect(kq.thieu).toEqual(["shopee"]);
      expect(kq.duongDan.kho).toBe(A);
    }
  });

  it("nạp: chỉ ghi vai còn trống, chạy lại là `khop`, giá trị KHÁC đã có ⇒ `lech` và KHÔNG ghi đè", async () => {
    await prisma.setting.create({ data: { key: KHOA_SETTING_DUONG_DAN_WEBHOOK.tiktok, value: C } });

    const lan1 = await napDuongDanNeuThieu(prisma, { kho: A, shopee: B, tiktok: "99999999999999999999999999999999" });
    expect(lan1).toEqual([
      { vai: "kho", ketQua: "da-ghi" },
      { vai: "shopee", ketQua: "da-ghi" },
      { vai: "tiktok", ketQua: "lech" },
    ]);
    // Path đang chạy của tiktok giữ nguyên — nạp không bao giờ đè.
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: KHOA_SETTING_DUONG_DAN_WEBHOOK.tiktok } })).value).toBe(C);

    const lan2 = await napDuongDanNeuThieu(prisma, { kho: A, shopee: B });
    expect(lan2).toEqual([
      { vai: "kho", ketQua: "khop" },
      { vai: "shopee", ketQua: "khop" },
    ]);
    expect(await docDuongDanWebhookBatBuoc(prisma)).toEqual({ kho: A, shopee: B, tiktok: C });
  });

  it("nạp từ chối path không hợp lệ (vd placeholder đọc nhầm từ workflow chưa đóng gói)", async () => {
    await expect(napDuongDanNeuThieu(prisma, { kho: PLACEHOLDER_DUONG_DAN_WEBHOOK.kho })).rejects.toThrow(/không hợp lệ/);
    expect(await prisma.setting.findUnique({ where: { key: KHOA_SETTING_DUONG_DAN_WEBHOOK.kho } })).toBeNull();
  });

  it("xoay: ghi ĐÈ path mới ngẫu nhiên cho đúng vai chỉ định, 3 vai 3 path khác nhau, vai khác giữ nguyên", async () => {
    await napDuongDanNeuThieu(prisma, { kho: A, shopee: B, tiktok: C });

    const moiShopee = await xoayDuongDanWebhookPancake(prisma, ["shopee"]);
    expect(Object.keys(moiShopee)).toEqual(["shopee"]);
    expect(moiShopee.shopee).toMatch(/^[0-9a-f]{32}$/);
    expect(moiShopee.shopee).not.toBe(B);
    expect(await docDuongDanWebhookBatBuoc(prisma)).toEqual({ kho: A, shopee: moiShopee.shopee, tiktok: C });

    const moiCa3 = await xoayDuongDanWebhookPancake(prisma);
    expect(new Set(Object.values(moiCa3)).size).toBe(3);
    expect(await docDuongDanWebhookBatBuoc(prisma)).toEqual(moiCa3);
  });
});
