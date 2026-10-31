/**
 * Ngữ cảnh cổng ghi chỉ sống ĐÚNG vòng đời lượt sinh ra nó — test THUẦN (không chạm DB): `canOpGhi`
 * với hàm chạy giả và `bocTransactionLe` với hàm transaction giả gọi thẳng callback (cùng cách Prisma
 * chạy callback tx tương tác trong ngữ cảnh async của lời gọi `$transaction`).
 *
 * ALS chảy theo MỌI việc async sinh bên trong một lượt — kể cả việc thả trôi (`void f()`, timer). Lối
 * miễn và tx lẻ mà không đóng ngữ cảnh khi lượt kết thúc thì việc thả trôi mang "giấy thông hành" mãi:
 * đi qua cổng khi cờ phục hồi bật mà không được drain đếm.
 *
 * Kèm: tx mở trong ngữ cảnh request được đếm RIÊNG tới khi xong — action trả promise tx mà quên `await`
 * (cửa đóng sớm) thì drain vẫn chờ tx tới COMMIT. Bản chạm DB thật: `cong-ghi-transaction.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  bocTransactionLe,
  canOpGhi,
  chayMienCong,
  choDrain,
  docBoDem,
  laLoiCongGhiDangKhoa,
  vaoCuaGhi,
} from "@/lib/backup/cong-ghi-toan-cuc";

import { batCo, chayGocRieng, daSettle, datLaiCongGhi, taoBarrier } from "./cong-ghi-helpers";

afterEach(() => datLaiCongGhi());

/** `$transaction` giả: chạy callback trong chính ngữ cảnh async của lời gọi, như tx tương tác Prisma. */
const txGia = bocTransactionLe(async (...a: unknown[]) => await (a[0] as () => Promise<unknown>)());

/** Việc thả trôi: chờ barrier rồi mới chạy op ghi — lượt sinh ra nó đã kết thúc từ trước. */
function thaTroi(b: ReturnType<typeof taoBarrier>, chay: () => Promise<string> = async () => "lot"): Promise<string> {
  const p = (async () => {
    await b.cho();
    return canOpGhi("tha-troi", chay);
  })();
  p.catch(() => {}); // test tự `await` sau; chặn cảnh báo "unhandled" trong lúc chờ
  return p;
}

describe("ngữ cảnh đóng khi lượt kết thúc — việc thả trôi không còn qua cổng", () => {
  it("lối miễn: việc thả trôi chạy SAU khi lượt miễn xong bị chặn khi cờ bật", async () => {
    const b = taoBarrier();
    let troi!: Promise<string>;
    await chayGocRieng(() =>
      chayMienCong("backlog", async () => {
        troi = thaTroi(b);
      }),
    );
    await b.daToi;
    batCo();
    b.mo();
    await expect(troi).rejects.toSatisfy(laLoiCongGhiDangKhoa);
  });

  it("lối miễn: cờ tắt ⇒ việc thả trôi sau lượt miễn được đếm như op lẻ (drain chờ nó)", async () => {
    const b = taoBarrier();
    const chayXong = taoBarrier();
    let troi!: Promise<string>;
    await chayGocRieng(() =>
      chayMienCong("backlog", async () => {
        troi = thaTroi(b, async () => {
          await chayXong.cho();
          return "lot";
        });
      }),
    );
    b.mo();
    await chayXong.daToi;
    expect(docBoDem().soOpLe).toBe(1);
    chayXong.mo();
    expect(await troi).toBe("lot");
    expect(docBoDem().soOpLe).toBe(0);
  });

  it("lối miễn: op được `await` TRONG lượt vẫn qua khi cờ bật (miễn trừ còn hiệu lực tới hết lượt)", async () => {
    batCo();
    expect(await chayGocRieng(() => chayMienCong("backlog", () => canOpGhi("trong-luot", async () => "qua")))).toBe("qua");
  });

  it("tx lẻ: việc thả trôi chạy SAU khi tx kết thúc bị chặn khi cờ bật", async () => {
    const b = taoBarrier();
    let troi!: Promise<string>;
    await chayGocRieng(() =>
      txGia(async () => {
        troi = thaTroi(b);
      }),
    );
    expect(docBoDem().soOpLe).toBe(0); // tx đã xong, không còn được đếm
    await b.daToi;
    batCo();
    b.mo();
    await expect(troi).rejects.toSatisfy(laLoiCongGhiDangKhoa);
  });

  it("tx lẻ mở TRƯỚC cờ: op được `await` trong tx sau khi cờ bật vẫn qua, drain đếm tx tới khi xong", async () => {
    const b = taoBarrier();
    const tx = chayGocRieng(() =>
      txGia(async () => {
        await b.cho();
        return canOpGhi("trong-tx", async () => "qua");
      }),
    );
    await b.daToi;
    batCo();
    expect(docBoDem().soOpLe).toBe(1);
    b.mo();
    expect(await tx).toBe("qua");
    expect(docBoDem().soOpLe).toBe(0);
  });
});

describe("tx mở trong ngữ cảnh request — đếm riêng tới khi tx xong", () => {
  it("action trả promise tx KHÔNG `await`: cửa đóng sớm nhưng drain vẫn chờ tx, op trong tx sau cờ vẫn qua", async () => {
    const b = taoBarrier();
    const ghi: string[] = [];
    // Đúng khuôn action (`vaoCuaGhi` + try/finally) nhưng thiếu `await` ở `return`.
    function actionQuenAwait(): Promise<unknown> {
      const cua = vaoCuaGhi();
      if (!cua.ok) return Promise.resolve(cua.loi);
      try {
        return txGia(async () => {
          ghi.push(await canOpGhi("truoc", async () => "1"));
          await b.cho();
          ghi.push(await canOpGhi("sau-co", async () => "2"));
        });
      } finally {
        cua.ra();
      }
    }
    const req = chayGocRieng(() => actionQuenAwait());
    await b.daToi;
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 1 }); // cửa đã đóng, tx vẫn được đếm
    batCo();
    const drain = choDrain(30_000).then((ok) => ({ ok, ghi: [...ghi] }));
    expect(await daSettle(drain)).toBe(false);
    b.mo();
    await req;
    expect(await drain).toEqual({ ok: true, ghi: ["1", "2"] });
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0 });
  });

  it("tx trong request (có `await`): đếm thêm vô hại — request và tx đều về 0 khi xong", async () => {
    const b = taoBarrier();
    const req = chayGocRieng(async () => {
      const cua = vaoCuaGhi();
      if (!cua.ok) return cua.loi;
      try {
        return await txGia(async () => {
          await b.cho();
          return canOpGhi("trong", async () => "qua");
        });
      } finally {
        cua.ra();
      }
    });
    await b.daToi;
    expect(docBoDem()).toMatchObject({ soRequest: 1, soOpLe: 1 });
    batCo();
    b.mo();
    expect(await req).toBe("qua");
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0 });
  });

  it("tx trong lối miễn: đi thẳng, KHÔNG đếm (lượt phục hồi không chờ chính nó)", async () => {
    const b = taoBarrier();
    batCo();
    const p = chayGocRieng(() =>
      chayMienCong("restore", () =>
        txGia(async () => {
          await b.cho();
          return canOpGhi("mien", async () => "qua");
        }),
      ),
    );
    await b.daToi;
    expect(docBoDem().soOpLe).toBe(0);
    b.mo();
    expect(await p).toBe("qua");
  });
});
