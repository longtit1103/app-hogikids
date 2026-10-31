/**
 * Khoá ghi chung CLI nhớ lời hứa THEO DB ĐÍCH và đếm client dùng nó:
 *  - hai client cùng DB dùng chung MỘT kết nối khoá; `$disconnect` (nhả) của một client KHÔNG nhả khoá
 *    khi client kia còn dùng — client phụ ngắt sớm không được tuột khoá giữa transaction của client chính;
 *  - hai DB đích ⇒ hai kết nối khoá, mỗi cái giữ shared trên ĐÚNG DB của nó (khoá tư vấn có phạm vi
 *    database — một lời hứa cho cả tiến trình là ghi ở DB thứ hai mà không có khoá).
 *
 * Chạy thẳng hàm khoá trong tiến trình Vitest (không cần chế độ CLI); chỉ chạm DB test, chỉ giữ/nhả khoá
 * tư vấn, không ghi dữ liệu nào.
 */
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { clientKhoaCliNeuCo, dichKhoaCli, giuKhoaChungCli, nhaKhoaChungCli, SO_KHOA_GHI_CHUNG } from "@/lib/backup/khoa-chung-cli";
import { cauHinhClientKhoa } from "@/lib/tao-prisma-client";

const URL_TEST = process.env.TEST_DATABASE_URL!;
const URL_E2E = process.env.TEST_DATABASE_URL_E2E;
const coDbThuHai = !!URL_E2E && /test/.test(new URL(URL_E2E).pathname) && new URL(URL_E2E).pathname !== new URL(URL_TEST).pathname;

const cauHinh = (url: string) => cauHinhClientKhoa(url, "cong-ghi-test-khoa-theo-dich");

/** Kết nối khoá có đang giữ shared K trên DB của chính nó không; trả kèm tên DB. */
async function trangThaiKhoa(c: pg.Client): Promise<{ db: string; giu: boolean }> {
  const r = await c.query<{ db: string; n: number }>(
    `SELECT current_database() AS db, count(*)::int AS n FROM pg_locks
      WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1
        AND mode = 'ShareLock' AND granted`,
    [SO_KHOA_GHI_CHUNG],
  );
  return { db: r.rows[0].db, giu: r.rows[0].n === 1 };
}

const donDep: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of donDep.splice(0)) await f();
});

describe("khoá ghi chung CLI theo DB đích", () => {
  it("hai client cùng DB: chung một kết nối khoá; nhả một client KHÔNG nhả khoá, nhả client cuối mới nhả", async () => {
    const ch = cauHinh(URL_TEST);
    const chuA = {};
    const chuB = {};
    donDep.push(() => nhaKhoaChungCli(ch, chuA), () => nhaKhoaChungCli(ch, chuB));

    const kA = await giuKhoaChungCli(ch, chuA);
    const kB = await giuKhoaChungCli(ch, chuB);
    expect(kB).toBe(kA);
    expect((await trangThaiKhoa(kA)).giu).toBe(true);

    await nhaKhoaChungCli(ch, chuA); // client phụ $disconnect sớm
    expect((await trangThaiKhoa(kA)).giu).toBe(true);
    expect(await clientKhoaCliNeuCo(ch)).toBe(kA);

    await nhaKhoaChungCli(ch, chuB);
    expect(await clientKhoaCliNeuCo(ch)).toBeNull();
    await expect(kA.query("SELECT 1")).rejects.toThrow();
  });

  it.skipIf(!coDbThuHai)("hai DB đích: hai kết nối khoá, mỗi cái giữ shared trên đúng DB của nó", async () => {
    const chTest = cauHinh(URL_TEST);
    const chE2e = cauHinh(URL_E2E!);
    expect(dichKhoaCli(chE2e)).not.toBe(dichKhoaCli(chTest));
    const chuA = {};
    const chuB = {};
    donDep.push(() => nhaKhoaChungCli(chTest, chuA), () => nhaKhoaChungCli(chE2e, chuB));

    const kTest = await giuKhoaChungCli(chTest, chuA);
    const kE2e = await giuKhoaChungCli(chE2e, chuB);
    expect(kE2e).not.toBe(kTest);
    const [tTest, tE2e] = [await trangThaiKhoa(kTest), await trangThaiKhoa(kE2e)];
    expect(tTest).toEqual({ db: new URL(URL_TEST).pathname.slice(1), giu: true });
    expect(tE2e).toEqual({ db: new URL(URL_E2E!).pathname.slice(1), giu: true });

    // Nhả ở DB test không đụng khoá ở DB kia.
    await nhaKhoaChungCli(chTest, chuA);
    expect((await trangThaiKhoa(kE2e)).giu).toBe(true);
  });

  it("dichKhoaCli: cùng host/port/DB ⇒ cùng đích dù khác application_name; khác DB ⇒ khác đích", () => {
    const a = cauHinhClientKhoa("postgresql://u:p@db.local:5432/mot?schema=app", "x");
    const b = cauHinhClientKhoa("postgresql://u2:p@db.local/mot?schema=app", "y");
    const c = cauHinhClientKhoa("postgresql://u:p@db.local:5432/hai?schema=app", "x");
    expect(dichKhoaCli(a)).toBe("db.local:5432/mot");
    expect(dichKhoaCli(b)).toBe(dichKhoaCli(a));
    expect(dichKhoaCli(c)).not.toBe(dichKhoaCli(a));
  });
});
