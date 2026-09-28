import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { docTrangThaiKhoaKetNoi } from "@/lib/ket-noi/doc-trang-thai-khoa-ket-noi";
import { prisma } from "@/lib/prisma";

/**
 * Khóa bất biến "secret không bao giờ rời server": `docTrangThaiKhoaKetNoi()` là dữ liệu
 * DUY NHẤT trang Cài đặt đưa xuống client về khóa kết nối — stringify toàn bộ kết quả rồi
 * soi từng giá trị secret đã seed, lộ một ký tự chuỗi đầy đủ nào là test đỏ.
 *
 * DB thật (`hogikids_test`). Key seed trùng key thật nhưng giá trị bịa — dọn ở afterAll.
 */

const SECRET_DAI = "GIATRI-BI-MAT-DAI-abcd1234"; // ≥8 ký tự → được hiện đuôi 4
const SECRET_NGAN = "ngan12"; // <8 ký tự → KHÔNG hiện đuôi (đuôi 4 là nửa khóa)
const APP_ID_CONG_KHAI = "424242424242";

const SEED: Array<[string, string]> = [
  ["pancakeApiKeyKho", SECRET_DAI],
  ["tiktokShopCipher", SECRET_NGAN],
  ["metaAdsAppId", APP_ID_CONG_KHAI],
];

beforeAll(async () => {
  for (const [key, value] of SEED) {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
});

afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: SEED.map(([k]) => k) } } });
});

describe("docTrangThaiKhoaKetNoi — tầng che secret", () => {
  it("không một giá trị secret đầy đủ nào lọt ra kết quả", async () => {
    const ketQua = await docTrangThaiKhoaKetNoi();
    const json = JSON.stringify(ketQua);
    expect(json).not.toContain(SECRET_DAI);
    expect(json).not.toContain(SECRET_NGAN);
  });

  it("secret đủ dài: daLuu + đuôi 4 ký tự + ngày cập nhật, giaTri luôn null", async () => {
    const ketQua = await docTrangThaiKhoaKetNoi();
    const truong = ketQua.pancake.find((t) => t.key === "pancakeApiKeyKho");
    expect(truong).toMatchObject({ daLuu: true, giaTri: null, duoi: SECRET_DAI.slice(-4) });
    expect(truong?.capNhat).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it("secret quá ngắn: vẫn báo đã lưu nhưng KHÔNG hiện đuôi", async () => {
    const ketQua = await docTrangThaiKhoaKetNoi();
    const truong = ketQua["tiktok-shop"].find((t) => t.key === "tiktokShopCipher");
    expect(truong).toMatchObject({ daLuu: true, giaTri: null, duoi: null });
  });

  it("trường công khai trả nguyên giá trị (App ID không phải secret)", async () => {
    const ketQua = await docTrangThaiKhoaKetNoi();
    const truong = ketQua.meta.find((t) => t.key === "metaAdsAppId");
    expect(truong).toMatchObject({ daLuu: true, giaTri: APP_ID_CONG_KHAI, duoi: null });
  });

  it("trường chưa lưu: daLuu=false, không đuôi, không ngày", async () => {
    // tiktokBusinessToken không nằm trong SEED — nếu DB test có sẵn thì test này vô nghĩa, nên xóa trước.
    await prisma.setting.deleteMany({ where: { key: "tiktokBusinessToken" } });
    const ketQua = await docTrangThaiKhoaKetNoi();
    const truong = ketQua["tiktok-business"].find((t) => t.key === "tiktokBusinessToken");
    expect(truong).toMatchObject({ daLuu: false, giaTri: null, duoi: null, capNhat: null });
  });
});
