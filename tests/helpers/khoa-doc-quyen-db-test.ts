import { PrismaClient } from "@prisma/client";

/**
 * KHOÁ ĐỘC QUYỀN cho một lượt chạy test trên MỘT database test.
 *
 * Vì sao cần: `vitest.config.ts` đặt `fileParallelism: false` vì nhiều file test gọi `deleteMany()`
 * KHÔNG phạm vi trên bảng dùng chung (`Variant`/`Product`/`Expense`…) — lượt dọn của file này xoá
 * fixture của file kia. Nhưng cờ đó chỉ điều phối được TRONG MỘT tiến trình. Hai lượt `npm test`
 * cùng lúc là hai tiến trình, không có gì điều phối, và chúng giẫm lên nhau trên cùng database.
 *
 * ĐO THẬT 2026-08-18 trên `hogikids_test` (3 cặp chạy chồng toàn phần, 6/6 tiến trình ĐỎ, mỗi lượt
 * 96–115 test hỏng, trong khi 4 lượt chạy đơn cùng ngày đều xanh). Chữ ký lỗi đúng kiểu giẫm dữ
 * liệu: "depends on records required but not found" ×103 · foreign key ×32 · unique ×19 · và cả
 * SỐ TIỀN sai (`expected 110000 to be 80000`) vì tổng P&L cộng nhầm dòng của tiến trình kia.
 *
 * Khoá tư vấn Postgres là chốt ĐÚNG TẦNG: nó sống trong chính database bị tranh, nên bắt được cả
 * hai tiến trình ở hai terminal, hai máy, hay một tiến trình quên tắt từ lượt trước.
 *
 * TỰ NHẢ KHI MẤT KẾT NỐI — không có đường để lại khoá kẹt: tiến trình test bị `Ctrl-C`/`kill -9`
 * thì Postgres đóng session và nhả khoá luôn, lượt sau chạy được ngay.
 *
 * MẶT TRÁI của "tự nhả khi mất kết nối" — KHOÁ TUỘT KHI POOL THAY KẾT NỐI. Đo 2026-08-30 (soi `pg_locks`
 * từ kết nối riêng, mỗi phút, 8 phút, xem `plans/reports/don-viec-treo-260830-*`): pool của Prisma
 * (quaint/mobc) mặc định giới hạn TUỔI kết nối 300 giây và kiểm lúc CHECKOUT — kết nối để yên thì
 * còn nguyên pid suốt 8 phút, nhưng câu lệnh ĐẦU TIÊN sau mốc 300s (kể cả `pg_advisory_unlock` cuối
 * lượt) nhận kết nối MỚI ⇒ session cũ đóng ⇒ Postgres nhả khoá ⇒ unlock trả false. Tệ hơn: "ping
 * giữ sống" mỗi 60s (bản vá đầu 30/08) làm khoá mất ĐÚNG phút 5 vì chính cú ping là checkout.
 * Vá: kéo `max_connection_lifetime` + `max_idle_connection_lifetime` (tham số URL quaint đọc, Prisma
 * không ghi trong docs — engine 6.19 có chuỗi này, đã đo có tác dụng) lên 24 giờ cho RIÊNG kết nối
 * giữ khoá; nhịp 60s bên dưới chỉ còn là phép KIỂM "session này còn giữ khoá không".
 */

/** Số khoá tuỳ chọn, phải DUY NHẤT trong toàn hệ (khác `khoa-ghi-chi-tieu-ads.ts`, `khoa-land-don.ts`). */
export const KHOA_VITEST = 260_818_001;
/** e2e dùng database RIÊNG (`hogikids_e2e_test`) nhưng vẫn tự tranh với chính nó khi chạy 2 lượt. */
export const KHOA_PLAYWRIGHT = 260_818_002;

/**
 * Nhịp TỰ KIỂM: mỗi 60s hỏi `pg_locks` xem session này còn giữ khoá không — tuột lúc nào là kêu ngay
 * lúc đó, không đợi cuối lượt. Nhịp này KHÔNG phải để "giữ sống": chỉ với tuổi kết nối mặc định 300s,
 * chính nó là thứ làm mất khoá (đo 30/08) — nó vô hại chỉ vì `motKetNoi()` đã kéo tuổi lên 24 giờ.
 */
export const NHIP_TU_KIEM_MS = 60_000;

export type KhoaDaGiu = {
  nha: () => Promise<void>;
  /**
   * Session ĐANG nối có còn giữ khoá không — đọc thẳng `pg_locks` theo `pg_backend_pid()`, KHÔNG suy
   * từ bộ nhớ app (app "nhớ" là đã giành được, nhưng khoá sống hay chết là chuyện của Postgres).
   */
  conGiu: () => Promise<boolean>;
};

/** Tuổi kết nối giữ khoá — dư cho mọi lượt test (full suite 6–7,5 phút), vẫn hữu hạn để không rò rỉ vĩnh viễn. */
export const TUOI_KET_NOI_GIAY = 24 * 60 * 60;

/**
 * Ép Prisma dùng ĐÚNG MỘT kết nối, sống ĐỦ LÂU. Khoá `pg_advisory_lock` (không phải bản `_xact_`)
 * gắn vào SESSION, mà pool nhiều kết nối thì câu lệnh sau có thể rơi vào session khác và không thấy
 * khoá — tệ hơn là nhả nhầm. Một kết nối ⇒ một session ⇒ khoá sống đúng vòng đời lượt chạy — VỚI
 * ĐIỀU KIỆN pool không tự thay kết nối giữa chừng (tuổi mặc định 300s, xem docblock đầu file).
 */
export function motKetNoi(url: string): string {
  const u = new URL(url);
  u.searchParams.set("connection_limit", "1");
  u.searchParams.set("max_connection_lifetime", String(TUOI_KET_NOI_GIAY));
  u.searchParams.set("max_idle_connection_lifetime", String(TUOI_KET_NOI_GIAY));
  return u.toString();
}

/**
 * Giành khoá độc quyền cho lượt chạy này. Ném NGAY với thông báo đọc được nếu có lượt khác đang
 * chạy — cố ý KHÔNG xếp hàng chờ: người chạy test cần biết mình vừa bấm nhầm terminal thứ hai,
 * chứ không phải ngồi nhìn màn hình đứng im vài phút rồi tưởng máy treo.
 */
export async function giuKhoaDocQuyenDbTest(
  url: string,
  khoa: number,
  ten: string,
): Promise<KhoaDaGiu> {
  const db = new PrismaClient({ datasources: { db: { url: motKetNoi(url) } } });

  // `$queryRaw` chứ KHÔNG `$executeRaw` ở đây — và đây KHÔNG phải phá lệ của
  // `khoa-ghi-chi-tieu-ads.ts`. Lệ đó có vì `pg_advisory_xact_lock` trả kiểu `void`, mà `$queryRaw`
  // cố giải mã cột kết quả nên ném "Failed to deserialize column of type 'void'".
  // `pg_try_advisory_lock` trả BOOLEAN, và ta BẮT BUỘC phải đọc giá trị đó để biết có giành được
  // hay không — `$executeRaw` chỉ trả số dòng nên sẽ nuốt mất câu trả lời.
  const [{ giuDuoc }] = await db.$queryRaw<{ giuDuoc: boolean }[]>`
    SELECT pg_try_advisory_lock(${khoa}::bigint) AS "giuDuoc"
  `;

  if (!giuDuoc) {
    await db.$disconnect();
    throw new Error(
      `Có lượt ${ten} KHÁC đang chạy trên cùng database test — TỪ CHỐI chạy chồng.\n` +
        `Hai lượt dùng chung database sẽ xoá fixture của nhau giữa chừng và đẻ ra hàng loạt test đỏ ` +
        `KHÔNG tái hiện được (đo 18/08: 96–115 test hỏng mỗi lượt, kể cả sai số TIỀN).\n` +
        `Chờ lượt kia xong rồi chạy lại. Nếu chắc chắn không còn lượt nào (tiến trình đã chết), khoá ` +
        `tự nhả khi kết nối đóng — thử lại sau vài giây.`,
    );
  }

  // Khoá 64-bit của `pg_advisory_lock(bigint)` nằm trong `pg_locks` dưới dạng (classid = 32 bit cao,
  // objid = 32 bit thấp, objsubid = 1) — tách ngay trong SQL từ chính số khoá, khỏi tự bit-shift ở JS.
  // Lọc `pid = pg_backend_pid()`: chỉ khoá do CHÍNH session này giữ mới tính; khoá cùng số nhưng
  // của session khác (kết nối cũ đã bị pool thay) là bằng chứng tuột, không phải bằng chứng còn.
  const conGiu = async (): Promise<boolean> => {
    const [{ conGiu }] = await db.$queryRaw<{ conGiu: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND classid = ((${khoa}::bigint >> 32) & 4294967295)::oid
          AND objid = (${khoa}::bigint & 4294967295)::oid
          AND objsubid = 1
          AND pid = pg_backend_pid()
      ) AS "conGiu"
    `;
    return conGiu;
  };

  // Nhịp tự kiểm: chạy trong tiến trình runner suốt lượt. `unref()` để nhịp KHÔNG tự giữ tiến trình
  // sống — lượt test xong là thoát như cũ. Báo tuột đúng MỘT lần (đủ để người đọc log nghi giẫm dữ
  // liệu), `nha()` cuối lượt vẫn kêu lần nữa qua `pg_advisory_unlock` trả false.
  let daBaoTuot = false;
  const baoTuot = (lyDo: string) => {
    if (daBaoTuot) return;
    daBaoTuot = true;
    console.warn(
      `[khoá test] Khoá ${ten} ĐÃ TUỘT giữa lượt chạy (${lyDo}) — phần còn lại của lượt này KHÔNG được ` +
        `bảo vệ chống chạy chồng. Nếu thấy test đỏ lạ, nghi ngay giẫm dữ liệu.`,
    );
  };
  const nhip = setInterval(() => {
    conGiu().then(
      (con) => {
        if (!con) baoTuot("session hiện tại không còn giữ khoá trong pg_locks");
      },
      (e: unknown) => baoTuot(`ping kết nối lỗi: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`),
    );
  }, NHIP_TU_KIEM_MS);
  nhip.unref();

  return {
    conGiu,
    nha: async () => {
      clearInterval(nhip);
      // `pg_advisory_unlock` trả false khi session KHÔNG giữ khoá — nghĩa là khoá đã tuột giữa chừng
      // (kết nối bị pool thu hồi chẳng hạn) và lượt chạy vừa rồi thực ra KHÔNG được bảo vệ. Phải kêu
      // to: một chốt an toàn chết âm thầm còn tệ hơn không có chốt, vì nó tạo cảm giác đã an toàn.
      try {
        const [{ daNha }] = await db.$queryRaw<{ daNha: boolean }[]>`
          SELECT pg_advisory_unlock(${khoa}::bigint) AS "daNha"
        `;
        if (!daNha) {
          console.warn(
            `[khoá test] Nhả khoá ${ten} trả FALSE — khoá đã tuột giữa lượt chạy, lượt này KHÔNG ` +
              `được bảo vệ chống chạy chồng. Nếu thấy test đỏ lạ, nghi ngay giẫm dữ liệu.`,
          );
        }
      } finally {
        await db.$disconnect();
      }
    },
  };
}
