import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  daBatNoPhaiTra,
  docMocM,
  KEY_NO_PHAI_TRA_TU_NGAY,
  LoiChuaBat,
} from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";

/**
 * Cổng bật "Nợ phải trả": mốc M nằm ở `Setting.noPhaiTraTuNgay` (`yyyy-MM-dd` giờ VN). Không có dòng,
 * hoặc giá trị rỗng / toàn khoảng trắng = TẮT — công thức Sổ quỹ y như cũ và MỌI đường ghi tiền mới phải
 * bị từ chối (`daBatNoPhaiTra` ném). Giá trị CÓ CHỮ mà hỏng KHÔNG được hiểu là "tắt": im lặng tắt là
 * quỹ đổi cách tính mà không ai biết.
 */
const xoaMoc = () => prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
const datMoc = (value: string) =>
  prisma.setting.upsert({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY }, create: { key: KEY_NO_PHAI_TRA_TU_NGAY, value }, update: { value } });

beforeEach(xoaMoc);
afterAll(async () => {
  await xoaMoc();
  await prisma.$disconnect();
});

describe("cổng bật nợ phải trả", () => {
  it("khoá Setting đúng hợp đồng", () => {
    expect(KEY_NO_PHAI_TRA_TU_NGAY).toBe("noPhaiTraTuNgay");
  });

  it("không có dòng Setting ⇒ docMocM null, daBatNoPhaiTra ném CHUA_BAT_NO_PHAI_TRA", async () => {
    expect(await docMocM()).toBeNull();
    const loi = await daBatNoPhaiTra().catch((e: unknown) => e);
    expect(loi).toBeInstanceOf(LoiChuaBat);
    expect((loi as LoiChuaBat).code).toBe("CHUA_BAT_NO_PHAI_TRA");
  });

  it('"2026-11-01" ⇒ Date 00:00 giờ VN (= 31/10 17:00 UTC), daBatNoPhaiTra trả đúng mốc', async () => {
    await datMoc("2026-11-01");
    const m = await docMocM();
    expect(m?.toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect((await daBatNoPhaiTra()).toISOString()).toBe("2026-10-31T17:00:00.000Z");
  });

  it("đọc được trong transaction (cổng chạy TRONG tx của action)", async () => {
    await datMoc("2026-11-01");
    const m = await prisma.$transaction((tx) => daBatNoPhaiTra(tx));
    expect(m.toISOString()).toBe("2026-10-31T17:00:00.000Z");
  });

  it.each(["", " ", "   ", "\t\n"])("giá trị rỗng / toàn khoảng trắng %j ⇒ TẮT (null), không ném", async (v) => {
    await datMoc(v);
    expect(await docMocM()).toBeNull();
    await expect(daBatNoPhaiTra()).rejects.toBeInstanceOf(LoiChuaBat);
  });

  it.each(["2026-13-01", "2026-02-30", "01/11/2026", " 2026-11-01", "2026-11-01T00:00", "x"])(
    "giá trị hỏng %j ⇒ ném (KHÔNG coi là tắt)",
    async (v) => {
      await datMoc(v);
      await expect(docMocM()).rejects.toThrow(/noPhaiTraTuNgay/);
      await expect(daBatNoPhaiTra()).rejects.toThrow(/noPhaiTraTuNgay/);
    },
  );
});
