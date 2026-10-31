/**
 * API cửa cho SERVER ACTION `vaoCuaGhi()` (không bọc thân hàm): từ chối đúng hình cũ khi cờ bật, đếm
 * suốt thân hàm, gắn ngữ cảnh bằng `enterWith` cho mọi `await` phía sau — và KHÔNG rò ngữ cảnh sang
 * request song song (mỗi request là một gốc async riêng), ngữ cảnh rò ra người gọi thành vô hiệu sau
 * `ra()`, gọi lồng không đếm hai lần / không cắt dở lượt ngoài.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { choDrain, docBoDem, laLoiCongGhiDangKhoa, vaoCuaGhi } from "@/lib/backup/cong-ghi-toan-cuc";
import { LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";

import { anhDuLieu, batCo, chayGocRieng, daSettle, datLaiCongGhi, doiChieu, donDuLieu, k, taoBarrier } from "./cong-ghi-helpers";

beforeEach(() => donDuLieu());
afterEach(() => datLaiCongGhi());
afterAll(async () => {
  await donDuLieu();
  await doiChieu.$disconnect();
});

type KetQua = { ok: true } | { ok: false; error: string };

/** Hình dạng chuẩn một action sau khi chuyển: cổng quyền (bỏ qua ở đây) → cửa → try/finally. */
async function actionMau(ten: string, truocKhiGhiLan2?: () => Promise<void>): Promise<KetQua> {
  const cua = vaoCuaGhi();
  if (!cua.ok) return cua.loi;
  try {
    await prisma.setting.create({ data: { key: k(`${ten}:1`), value: "x" } });
    await truocKhiGhiLan2?.();
    await prisma.$transaction(async (tx) => {
      await tx.setting.create({ data: { key: k(`${ten}:2`), value: "x" } });
    });
    return { ok: true };
  } finally {
    cua.ra();
  }
}

describe("vaoCuaGhi — API cửa cho server action", () => {
  it("cờ bật ⇒ trả đúng { ok: false, error: LOI_DANG_PHUC_HOI }, không đếm, không ghi", async () => {
    batCo();
    expect(await chayGocRieng(() => actionMau("tu-choi"))).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });
    expect(docBoDem().soRequest).toBe(0);
    expect(await anhDuLieu()).toEqual([]);
  });

  it("action vào TRƯỚC cờ: ghi sau cờ vẫn qua (ngữ cảnh sống qua các `await`), drain chờ tới khi xong", async () => {
    const b = taoBarrier();
    const a = chayGocRieng(() => actionMau("truoc-co", () => b.cho()));
    await b.daToi;
    expect(docBoDem().soRequest).toBe(1);
    batCo();
    const drain = choDrain(30_000).then(async (ok) => ({ ok, anh: await anhDuLieu() }));
    expect(await daSettle(drain)).toBe(false);
    b.mo();
    expect(await a).toEqual({ ok: true });
    expect(await drain).toEqual({ ok: true, anh: [`${k("truoc-co:1")}=x`, `${k("truoc-co:2")}=x`] });
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0 });
  });

  it("KHÔNG rò ngữ cảnh sang request song song: A đang trong cửa, op lẻ ở gốc khác vẫn bị chặn khi cờ bật", async () => {
    const b = taoBarrier();
    const a = chayGocRieng(() => actionMau("a", () => b.cho()));
    await b.daToi;
    batCo();
    // Request B tới SAU cờ ở một gốc async khác, KHÔNG qua cửa (đường sót cửa) ⇒ lưới phụ phải chặn.
    await expect(
      chayGocRieng(() => prisma.setting.create({ data: { key: k("b-le"), value: "x" } })),
    ).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    // Và B qua cửa ⇒ bị từ chối ngay, không xếp hàng.
    expect(await chayGocRieng(() => actionMau("b"))).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });
    b.mo();
    expect(await a).toEqual({ ok: true });
    expect(await anhDuLieu()).toEqual([`${k("a:1")}=x`, `${k("a:2")}=x`]);
  });

  it("20 action song song (nửa ném) ⇒ bộ đếm về 0, không ngữ cảnh nào lẫn sang nhau", async () => {
    const viec = Array.from({ length: 20 }, (_, i) =>
      chayGocRieng(async () => {
        const cua = vaoCuaGhi();
        if (!cua.ok) return cua.loi;
        try {
          await prisma.setting.create({ data: { key: k(`ss${i}`), value: "x" } });
          if (i % 2) throw new Error("hỏng");
          return { ok: true as const };
        } finally {
          cua.ra();
        }
      }).catch(() => null),
    );
    await Promise.all(viec);
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0 });
    expect(await choDrain(1)).toBe(true);
    expect(await anhDuLieu()).toHaveLength(20);
  });

  it("ngữ cảnh rò ra người gọi (enterWith) thành VÔ HIỆU sau `ra()`", async () => {
    await chayGocRieng(async () => {
      // Gọi thẳng trong cùng gốc: `enterWith` của action rò ra đoạn mã này.
      expect(await actionMau("ro")).toEqual({ ok: true });
      batCo();
      // Phần rò đã bị `ra()` đóng ⇒ op ghi ở đây bị đối xử như op lẻ ⇒ bị chặn.
      await expect(prisma.setting.create({ data: { key: k("sau-ra"), value: "x" } })).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    });
    expect(await anhDuLieu()).toEqual([`${k("ro:1")}=x`, `${k("ro:2")}=x`]);
  });

  it("gọi lồng: action trong action không đếm hai lần, không bị từ chối khi cờ bật giữa chừng", async () => {
    const b = taoBarrier();
    const ngoai = chayGocRieng(async () => {
      const cua = vaoCuaGhi();
      if (!cua.ok) return cua.loi;
      try {
        await b.cho();
        expect(docBoDem().soRequest).toBe(1);
        return await actionMau("long"); // cờ đã bật — lượt ngoài đã vào nên lượt trong phải chạy trọn
      } finally {
        cua.ra();
      }
    });
    await b.daToi;
    batCo();
    b.mo();
    expect(await ngoai).toEqual({ ok: true });
    expect(docBoDem().soRequest).toBe(0);
    expect(await anhDuLieu()).toEqual([`${k("long:1")}=x`, `${k("long:2")}=x`]);
  });

  it("`ra()` idempotent — gọi hai lần không làm bộ đếm âm", async () => {
    await chayGocRieng(async () => {
      const cua = vaoCuaGhi();
      expect(cua.ok).toBe(true);
      if (!cua.ok) return;
      expect(docBoDem().soRequest).toBe(1);
      cua.ra();
      cua.ra();
    });
    expect(docBoDem().soRequest).toBe(0);
  });
});
