// tests/unit/branding/app-icon.test.tsx
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  docLogoChuShop,
  dungIconPng,
  laKichThuocIcon,
  type LogoChuShop,
} from "@/lib/branding/app-icon";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const laPng = (buf: ArrayBuffer) => PNG_SIG.every((b, i) => new Uint8Array(buf)[i] === b);
/** Rộng × cao đọc từ chunk IHDR (byte 16–23, big-endian) — chứng minh đúng kích thước, không chỉ đúng chữ ký. */
const kichThuocPng = (buf: ArrayBuffer) => {
  const v = new DataView(buf);
  return [v.getUint32(16), v.getUint32(20)];
};
const LOGO_JPG_MAU = path.join(process.cwd(), "tests/fixtures/branding/logo-mau.jpg");

describe("laKichThuocIcon", () => {
  it("chỉ 180/192/512", () => {
    expect([180, 192, 512].every(laKichThuocIcon)).toBe(true);
    expect([0, 100, 193, 1024, Number.NaN].some(laKichThuocIcon)).toBe(false);
  });
});

describe("docLogoChuShop — mọi lỗi ⇒ null, không ném", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hogikids-logo-"));
    await writeFile(path.join(dir, "logo-1.png"), await readFile(path.join(process.cwd(), "tests/fixtures/branding/logo-hong-idat.png")));
    await writeFile(path.join(dir, "logo-2.jpg"), await readFile(LOGO_JPG_MAU));
    await writeFile(path.join(dir, "logo-3.png"), Buffer.from("khong phai anh"));
    // Header PNG khai 12000×12000 — đủ để OOM container nếu đem render (đo review 26/09: RSS ~3GB).
    const khong = Buffer.alloc(33);
    Buffer.from(PNG_SIG).copy(khong, 0);
    khong.writeUInt32BE(13, 8);
    khong.write("IHDR", 12, "ascii");
    khong.writeUInt32BE(12000, 16);
    khong.writeUInt32BE(12000, 20);
    await writeFile(path.join(dir, "logo-4.png"), khong);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const voi = (p: string | null) => ({ timLogoPath: async () => p, thuMucUploads: dir });

  it("PNG hợp lệ ⇒ image/png", async () => {
    const logo = await docLogoChuShop(voi("/api/uploads/logo-1.png"));
    expect(logo?.mime).toBe("image/png");
  });
  it("JPG hợp lệ ⇒ image/jpeg (không rơi dự phòng oan)", async () => {
    const logo = await docLogoChuShop(voi("/uploads/logo-2.jpg"));
    expect(logo?.mime).toBe("image/jpeg");
  });
  it("sai magic bytes ⇒ null", async () => {
    expect(await docLogoChuShop(voi("/api/uploads/logo-3.png"))).toBeNull();
  });
  it("logo quá nhiều điểm ảnh (> CANH_LOGO_TOI_DA) ⇒ null, KHÔNG đem render", async () => {
    expect(await docLogoChuShop(voi("/api/uploads/logo-4.png"))).toBeNull();
  });
  it("file mất ⇒ null", async () => {
    expect(await docLogoChuShop(voi("/api/uploads/logo-999.png"))).toBeNull();
  });
  it("path ngoài allowlist ⇒ null", async () => {
    expect(await docLogoChuShop(voi("/api/uploads/../../etc/passwd"))).toBeNull();
  });
  it("chưa có logo ⇒ null", async () => {
    expect(await docLogoChuShop(voi(null))).toBeNull();
  });
  it("DB ném ⇒ null", async () => {
    const logo = await docLogoChuShop({
      timLogoPath: async () => {
        throw new Error("DB sập");
      },
      thuMucUploads: dir,
    });
    expect(logo).toBeNull();
  });
});

describe("dungIconPng — luôn 200 image/png + no-store", () => {
  const png1x1 = new Uint8Array([...PNG_SIG]).buffer;

  it("có logo ⇒ render logo, header đúng", async () => {
    let lan = 0;
    const render = vi.fn(async (_n: unknown, _s: number) => new Uint8Array([...PNG_SIG, lan++]).buffer);
    const logo: LogoChuShop = { bytes: Buffer.from(PNG_SIG), mime: "image/png" };
    const res = await dungIconPng(192, { docLogo: async () => logo, render });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // lượt 1 = logo, lượt 2 = nền trống để so; khác nhau ⇒ giữ bản logo
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[0][1]).toBe(192);
    expect(new Uint8Array(await res.arrayBuffer())[8]).toBe(0);
  });

  it("render logo NÉM (ảnh không decode được) ⇒ render lại bằng dự phòng", async () => {
    const render = vi
      .fn<(n: unknown, s: number) => Promise<ArrayBuffer>>()
      .mockRejectedValueOnce(new Error("decode hỏng"))
      .mockResolvedValueOnce(png1x1);
    const logo: LogoChuShop = { bytes: Buffer.from(PNG_SIG), mime: "image/png" };
    const res = await dungIconPng(180, { docLogo: async () => logo, render });
    expect(res.status).toBe(200);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("docLogo NÉM ⇒ dự phòng", async () => {
    const render = vi.fn(async (_n: unknown, _s: number) => png1x1);
    const res = await dungIconPng(512, {
      docLogo: async () => {
        throw new Error("bất ngờ");
      },
      render,
    });
    expect(res.status).toBe(200);
    expect(render).toHaveBeenCalledTimes(1);
  });

  // Render THẬT bằng next/og — bắt đúng ca "ImageResponse render lười": lỗi decode nổ lúc đọc
  // stream chứ không phải lúc khởi tạo. Không có deps render ⇒ dùng renderer mặc định.
  it.each([180, 192, 512] as const)("render thật: không logo ⇒ PNG dự phòng %i×%i đúng IHDR", async (size) => {
    const res = await dungIconPng(size, { docLogo: async () => null });
    expect(res.status).toBe(200);
    const png = await res.arrayBuffer();
    expect(laPng(png)).toBe(true);
    expect(kichThuocPng(png)).toEqual([size, size]);
  }, 30_000);

  it("render thật: chữ ký PNG đúng nhưng thân rác ⇒ vẫn 200 PNG hợp lệ", async () => {
    const rac: LogoChuShop = { bytes: Buffer.from([...PNG_SIG, 0xde, 0xad, 0xbe, 0xef]), mime: "image/png" };
    const res = await dungIconPng(192, { docLogo: async () => rac });
    expect(res.status).toBe(200);
    const png = await res.arrayBuffer();
    expect(laPng(png)).toBe(true);
    expect(kichThuocPng(png)).toEqual([192, 192]);
  }, 30_000);

  // Header HỢP LỆ nhưng thân hỏng: next/og KHÔNG ném — nó vẽ ô nền trống (review 26/09 đo md5
  // trùng bản không ảnh). iOS chụp icon một lần ⇒ phải ra chữ "H", không phải ô trắng.
  it("render thật: PNG IHDR đúng nhưng IDAT hỏng ⇒ ra ĐÚNG icon dự phòng", async () => {
    const hong: LogoChuShop = {
      bytes: await readFile(path.join(process.cwd(), "tests/fixtures/branding/logo-hong-idat.png")),
      mime: "image/png",
    };
    const ra = await (await dungIconPng(192, { docLogo: async () => hong })).arrayBuffer();
    const duPhong = await (await dungIconPng(192, { docLogo: async () => null })).arrayBuffer();
    expect(Buffer.from(ra).equals(Buffer.from(duPhong))).toBe(true);
  }, 30_000);

  it("render thật: JPG bị cắt còn 1/3 ⇒ ra ĐÚNG icon dự phòng", async () => {
    const du = await readFile(LOGO_JPG_MAU);
    const cut: LogoChuShop = { bytes: du.subarray(0, Math.floor(du.length / 3)), mime: "image/jpeg" };
    const ra = await (await dungIconPng(192, { docLogo: async () => cut })).arrayBuffer();
    const duPhong = await (await dungIconPng(192, { docLogo: async () => null })).arrayBuffer();
    expect(Buffer.from(ra).equals(Buffer.from(duPhong))).toBe(true);
  }, 30_000);

  // JPG THẬT (fixture 64×32, không vuông): chứng minh ImageResponse dựng được JPG chứ không lặng lẽ
  // rơi về dự phòng — so byte với bản dự phòng cùng kích thước phải KHÁC.
  it("render thật: logo JPG hợp lệ ⇒ PNG dựng từ logo, khác bản dự phòng", async () => {
    const jpg: LogoChuShop = { bytes: await readFile(LOGO_JPG_MAU), mime: "image/jpeg" };
    const tuLogo = await (await dungIconPng(192, { docLogo: async () => jpg })).arrayBuffer();
    const duPhong = await (await dungIconPng(192, { docLogo: async () => null })).arrayBuffer();
    expect(laPng(tuLogo)).toBe(true);
    expect(kichThuocPng(tuLogo)).toEqual([192, 192]);
    expect(Buffer.from(tuLogo).equals(Buffer.from(duPhong))).toBe(false);
  }, 30_000);

  // `logo-mau-exif-xoay-90.jpg` CÙNG màu/kích thước (64×32) với `logo-mau.jpg`, CHỈ khác cờ Exif
  // Orientation=6 — chứng minh `iconTuLogo` THẬT SỰ áp bù xoay (không chỉ đọc được cờ mà quên
  // dùng): logo chữ nhật ngang xoay 90° đổi cách nó lấp khung vuông ⇒ hai bản PNG PHẢI khác byte.
  it("render thật: logo JPG có EXIF Orientation=6 ⇒ bù xoay, khác bản CÙNG NỘI DUNG không cờ", async () => {
    const khongXoay: LogoChuShop = { bytes: await readFile(LOGO_JPG_MAU), mime: "image/jpeg" };
    const coXoay: LogoChuShop = {
      bytes: await readFile(path.join(process.cwd(), "tests/fixtures/branding/logo-mau-exif-xoay-90.jpg")),
      mime: "image/jpeg",
    };
    const raKhongXoay = await (await dungIconPng(192, { docLogo: async () => khongXoay })).arrayBuffer();
    const raCoXoay = await (await dungIconPng(192, { docLogo: async () => coXoay })).arrayBuffer();
    expect(laPng(raCoXoay)).toBe(true);
    expect(kichThuocPng(raCoXoay)).toEqual([192, 192]);
    expect(Buffer.from(raCoXoay).equals(Buffer.from(raKhongXoay))).toBe(false);
  }, 30_000);
});
