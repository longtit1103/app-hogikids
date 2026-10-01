import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getIronSession, sealData, type SessionOptions } from "iron-session";

import { prisma } from "@/lib/prisma";

export type SessionData = {
  userId?: string;
  /**
   * Epoch phiên của lượt xác thực đã cấp cookie — lệch `User.sessionEpoch` HIỆN TẠI của đúng người đó
   * ⇒ cookie đã bị thu hồi (xem `kiemPhien` ở `@/lib/quyen/nguoi-dung-phien`).
   */
  mocPhien?: string;
  /** Người dùng có tick "Ghi nhớ đăng nhập" không — để cấp lại cookie đúng loại sau khi đổi mật khẩu. */
  ghiNho?: boolean;
};

const SESSION_COOKIE_NAME = "hogikids_session";
const REMEMBER_ME_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 ngày
/** TTL phía server cho phiên "không ghi nhớ" — xem ghi chú dài ở nhánh `remember === false` của `createSession`. */
const NOT_REMEMBERED_TTL_SECONDS = 60 * 60 * 24; // 24 giờ

/** Client Prisma thường HOẶC client trong `$transaction` — thu hồi phiên đi cùng lượt ghi của người gọi. */
export type ClientPhien = PrismaClient | Prisma.TransactionClient;

/**
 * CHỈ client bên trong `$transaction`. `PrismaClient` gốc gán được sang `Prisma.TransactionClient` (thừa
 * thuộc tính vẫn khớp kiểu cấu trúc), nên phải chặn thêm `$transaction`: client gốc có, client tx không.
 */
export type ClientTrongTransaction = Prisma.TransactionClient & { $transaction?: never };

/**
 * Epoch phiên mới: 16 byte ngẫu nhiên MẬT MÃ, 32 hex. KHÔNG dùng mốc thời gian — epoch đoán được thì
 * ai có cookie cũ ký bằng secret thật (vd lấy từ bản backup) chỉ cần đoán đúng mốc là hồi sinh phiên.
 */
export function sinhMocPhien(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Thu hồi mọi phiên của MỘT người (đổi mật khẩu, khoá, đặt lại mật khẩu): ghi epoch mới vào đúng dòng
 * `User` đó, trả epoch ra để người gọi cấp lại cookie cho thiết bị đang thao tác.
 *
 * CHỈ nhận client TRANSACTION (kiểu chặn client gốc lúc biên dịch): đổi epoch phải cùng transaction
 * với lượt ghi hash/khoá của người gọi. Tách ra hai lượt commit là mở khe: hash mới đã COMMIT mà
 * epoch chưa đổi thì cookie "ghi nhớ 30 ngày" trên máy khác vẫn vào được; epoch đổi TRƯỚC mà hash
 * đổi SAU thì một lượt `login` chen giữa đọc được "epoch mới + hash cũ" ⇒ cookie hợp lệ bằng mật
 * khẩu CŨ. Người khác KHÔNG bị ảnh hưởng (không còn epoch toàn cục).
 */
export async function thuHoiPhienCuaNguoi(db: ClientTrongTransaction, userId: string): Promise<string> {
  const moc = sinhMocPhien();
  await db.user.update({ where: { id: userId }, data: { sessionEpoch: moc } });
  return moc;
}

/**
 * Thu hồi phiên của MỌI người — dùng sau phục hồi DB (bản backup mang epoch cũ, cookie cũ có thể khớp
 * lại). Mỗi dòng một epoch ngẫu nhiên riêng, sinh TRONG SQL: `gen_random_uuid()` là hàm LÕI Postgres
 * ≥ 13 (nguồn `pg_strong_random`, 122 bit) — cố ý KHÔNG dùng `gen_random_bytes()` (thuộc extension
 * `pgcrypto`, role app không tạo được extension và `search_path` không có schema `extensions`). Bỏ dấu
 * `-` còn đúng 32 hex, cùng dạng với `sinhMocPhien()`. Không có đường dự phòng: thiếu hàm là lỗi hạ
 * tầng phải thấy ngay (test preflight `tests/phien/sinh-moc-phien.test.ts`), không lặng lẽ hạ cấp.
 */
export async function thuHoiMoiPhienMoiNguoi(db: ClientPhien = prisma): Promise<void> {
  await db.$executeRaw`UPDATE "User" SET "sessionEpoch" = replace(gen_random_uuid()::text, '-', '')`;
}

/**
 * Bộ mật khẩu (nhiều-khoá) để seal/unseal cookie iron-session — cho phép XOAY `SESSION_SECRET` mà
 * không đá chủ shop ra khỏi phiên đang sống trên prod.
 *
 * VÌ SAO map `{"1": ..., "2": ...}` chứ không phải chuỗi đơn: iron-session tự quy chuỗi đơn thành
 * `{"1": chuỗi}` (`normalizeStringPasswordToMap`, xem `node_modules/iron-session/dist/index.js`),
 * và seal MỚI luôn dùng khoá có id LỚN NHẤT trong map (`mostRecentPasswordId`). Mọi cookie đang
 * sống trên prod TRƯỚC bản vá này đều được seal bằng CHUỖI ĐƠN — tức id "1" — nên:
 *  - Chưa đặt `SESSION_SECRET_PREVIOUS`: trả `{"1": SESSION_SECRET}` — Y HỆT hành vi chuỗi đơn cũ
 *    (cùng id "1", cùng secret): cookie chuỗi-đơn cực cũ (từ trước bản vá này) mở bình thường, seal
 *    mới cũng dùng lại id "1". Đây LUÔN là trạng thái "nghỉ" — trước lúc xoay lần đầu, và sau khi
 *    đã xoay xong + xoá `SESSION_SECRET_PREVIOUS`.
 *  - Có `SESSION_SECRET_PREVIOUS`: trả `{"1": SESSION_SECRET_PREVIOUS, "2": SESSION_SECRET}` — id
 *    "1" giữ NGUYÊN secret cũ (mở được cookie sống từ trước lượt xoay), id "2" (lớn nhất) là secret
 *    HIỆN HÀNH nên seal mới dùng nó.
 *
 * LƯU Ý VẬN HÀNH khi xoá `SESSION_SECRET_PREVIOUS`: bản đồ quay lại còn đúng 1 khoá (id "1"), nên
 * NHỮNG COOKIE ĐÃ PHÁT TRONG LÚC ĐANG XOAY (seal dưới id "2") cũng mất khả năng mở theo, không
 * riêng gì cookie sống từ TRƯỚC lượt xoay (id "1"/secret cũ). Vì vậy đợi đủ TTL "ghi nhớ đăng
 * nhập" (30 ngày, `REMEMBER_ME_TTL_SECONDS`) tính TỪ LÚC XOAY XONG (đổi `SESSION_SECRET`), không
 * phải từ lúc bắt đầu xoay, rồi mới xoá `SESSION_SECRET_PREVIOUS` — ai còn phiên cũ lúc đó phải
 * đăng nhập lại (app 1 người dùng, chấp nhận được).
 */
function getSessionPassword(): Record<string, string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET phải được set (>= 32 ký tự) trong .env trước khi dùng session."
    );
  }
  const previous = process.env.SESSION_SECRET_PREVIOUS;
  if (!previous) {
    return { "1": secret };
  }
  if (previous.length < 32) {
    throw new Error(
      "SESSION_SECRET_PREVIOUS phải >= 32 ký tự nếu được đặt (xoá biến này nếu không xoay khoá)."
    );
  }
  return { "1": previous, "2": secret };
}

/**
 * Cookie flags chốt (Task 4 brief): httpOnly luôn bật, sameSite=lax, secure
 * CHỈ bật ở production. Trên `http://localhost` (dev), `secure: true` khiến
 * trình duyệt âm thầm không set được cookie — đăng nhập sẽ không hoạt động.
 */
const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

function buildReadSessionOptions(): SessionOptions {
  return {
    password: getSessionPassword(),
    cookieName: SESSION_COOKIE_NAME,
    cookieOptions: BASE_COOKIE_OPTIONS,
  };
}

/**
 * Reads the current request's iron-session (an empty object when no valid
 * cookie is present). Safe to call from Server Components — it only reads.
 */
export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, buildReadSessionOptions());
}

/**
 * Cấp cookie phiên cho `userId` với epoch CỦA LƯỢT XÁC THỰC (`mocPhien`) — KHÔNG đọc DB. Epoch phải
 * đến từ đúng lượt đọc đã so hash (đăng nhập) hoặc từ transaction vừa thu hồi (đổi mật khẩu): một
 * lượt reset/khoá chen vào giữa lúc xác thực và lúc cấp cookie thì cookie mang epoch cũ ⇒ request kế
 * tiếp bị từ chối. Đọc lại epoch ở đây sẽ "rửa" cookie thành hợp lệ — đúng khe đua cần đóng.
 *
 * MUST be called from a Server Action or Route Handler (it writes a Set-Cookie). `remember` controls
 * lifetime: `true` persists the cookie for 30 days; `false` produces a real browser session cookie
 * (no Max-Age attribute) that clears when the browser closes — matching the "Ghi nhớ đăng nhập"
 * checkbox semantics.
 */
export async function createSession(userId: string, remember: boolean, mocPhien: string): Promise<void> {
  const cookieStore = await cookies();
  const data: SessionData = { userId, mocPhien, ghiNho: remember };

  if (remember) {
    const sessionOptions: SessionOptions = {
      password: getSessionPassword(),
      cookieName: SESSION_COOKIE_NAME,
      ttl: REMEMBER_ME_TTL_SECONDS,
      cookieOptions: BASE_COOKIE_OPTIONS,
    };
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
    session.userId = data.userId;
    session.mocPhien = data.mocPhien;
    session.ghiNho = data.ghiNho;
    await session.save();
    return;
  }

  // remember = false: PHẢI vừa (a) cookie là session cookie THẬT — không Max-Age/Expires, mất khi
  // đóng trình duyệt — vừa (b) seal hết hạn phía server sau NOT_REMEMBERED_TTL_SECONDS. Không dùng
  // `getIronSession(...).save()` được cho ca này: đọc `getSessionConfig` trong
  // `node_modules/iron-session/dist/index.js` thấy hễ `cookieOptions.maxAge` là khoá CÓ MẶT với
  // giá trị `undefined` thì nó ÉP `ttl = 0` — GHI ĐÈ bất kỳ `ttl` nào mình truyền vào, bất kể giá
  // trị. Nhánh còn lại (không có khoá `maxAge`) thì nó lại TỰ TÍNH một `Max-Age` số từ `ttl` gắn
  // vào cookie — mất luôn tính chất "cookie phiên". Hai nhánh công khai của thư viện không nhánh
  // nào cho (a) và (b) cùng lúc.
  //
  // Lối ra: seal/set cookie THỦ CÔNG bằng `sealData` (cùng hàm `getIronSession` gọi bên trong,
  // export riêng) với `ttl` của mình, rồi tự gọi `cookieStore.set` với `cookieOptions` KHÔNG có
  // khoá `maxAge` (không có khoá — khác với có khoá mang giá trị `undefined`) nên Next không phát
  // Max-Age/Expires. Hạn dùng thật nằm NGAY TRONG seal (`iron-webcrypto` nhúng mốc hết hạn vào
  // chuỗi đã mã hoá lúc `seal()`, xem `node_modules/iron-webcrypto/dist/index.js`) — `unsealData`
  // ở nhánh đọc (`getSession`) đọc lại đúng mốc đó bất kể `ttl` truyền vào lúc ĐỌC là bao nhiêu, nên
  // không cần đụng gì tới đường đọc hiện có.
  const seal = await sealData(data, {
    password: getSessionPassword(),
    ttl: NOT_REMEMBERED_TTL_SECONDS,
  });
  const cookieValue = `${SESSION_COOKIE_NAME}=${seal}`;
  if (cookieValue.length > 4096) {
    throw new Error(
      `iron-session: Cookie length is too big (${cookieValue.length} bytes), browsers will refuse it. Try to remove some data.`
    );
  }
  cookieStore.set(SESSION_COOKIE_NAME, seal, BASE_COOKIE_OPTIONS);
}

/** Ends the current session (Server Action / Route Handler only). */
export async function destroySession(): Promise<void> {
  const session = await getSession();
  session.destroy();
}

/** Lựa chọn "Ghi nhớ đăng nhập" của phiên hiện tại (để cấp lại cookie đúng loại sau khi đổi mật khẩu). */
export async function docGhiNhoCuaPhien(): Promise<boolean> {
  const session = await getSession();
  return session.ghiNho === true;
}
