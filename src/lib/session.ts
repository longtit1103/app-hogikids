import { cookies } from "next/headers";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getIronSession, sealData, type SessionOptions } from "iron-session";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";

export type SessionData = {
  userId?: string;
  /** Mốc phiên lúc đăng nhập — lệch mốc hiện hành ⇒ cookie đã bị thu hồi (xem `docMocPhien`). */
  mocPhien?: string;
  /** Người dùng có tick "Ghi nhớ đăng nhập" không — để cấp lại cookie đúng loại sau khi đổi mật khẩu. */
  ghiNho?: boolean;
};

const SESSION_COOKIE_NAME = "hogikids_session";
const REMEMBER_ME_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 ngày
/** TTL phía server cho phiên "không ghi nhớ" — xem ghi chú dài ở nhánh `remember === false` của `createSession`. */
const NOT_REMEMBERED_TTL_SECONDS = 60 * 60 * 24; // 24 giờ

/** Khoá `Setting` giữ mốc phiên. "0" = chưa từng thu hồi phiên nào. */
const KHOA_MOC_PHIEN = "sessionEpoch";
const MOC_PHIEN_MAC_DINH = "0";

/**
 * Mốc phiên hiện hành. Cookie mang mốc KHÁC mốc này bị coi như chưa đăng nhập.
 *
 * Vì sao cần: iron-session là cookie KÝ, không có bản ghi phiên phía máy chủ — đổi mật khẩu xong
 * thì cookie "ghi nhớ đăng nhập" 30 ngày trên MỌI thiết bị khác VẪN vào được, đúng lúc chủ shop
 * đổi mật khẩu vì nghi bị lộ. Một dòng `Setting` là đủ làm điểm thu hồi mà KHÔNG phải đổi schema
 * Prisma (hợp đồng) — lượt xoá dữ liệu giao dịch cũng cố ý giữ nguyên bảng `Setting`.
 *
 * Thiếu dòng ⇒ mốc "0", mà cookie đời cũ (chưa có trường `mocPhien`) cũng quy về "0" ⇒ nâng cấp
 * bản này KHÔNG đá ai ra khỏi phiên đang dùng; thu hồi chỉ bắt đầu từ lần đổi mật khẩu đầu tiên.
 */
export async function docMocPhien(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: KHOA_MOC_PHIEN } });
  return row?.value ?? MOC_PHIEN_MAC_DINH;
}

/** Client Prisma thường HOẶC client trong `$transaction` — đổi mật khẩu đẩy mốc phiên cùng lượt ghi hash. */
export type ClientPhien = PrismaClient | Prisma.TransactionClient;

/**
 * Đẩy mốc phiên sang giá trị mới ⇒ mọi cookie đã cấp trước đó hết hiệu lực.
 *
 * Nhận `db` để người gọi ghép được vào transaction của mình. Đổi mật khẩu PHẢI làm vậy: hash mới
 * đã COMMIT mà mốc phiên chưa đẩy thì cookie "ghi nhớ 30 ngày" trên máy khác vẫn vào được — đúng
 * cánh cửa hàm này sinh ra để khoá.
 */
export async function thuHoiMoiPhien(db: ClientPhien = prisma): Promise<void> {
  const moc = Date.now().toString();
  await db.setting.upsert({
    where: { key: KHOA_MOC_PHIEN },
    create: { key: KHOA_MOC_PHIEN, value: moc },
    update: { value: moc },
  });
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
 * Creates a logged-in session for `userId`. MUST be called from a Server
 * Action or Route Handler (it writes a Set-Cookie). `remember` controls
 * lifetime: `true` persists the cookie for 30 days; `false` produces a real
 * browser session cookie (no Max-Age attribute) that clears when the browser
 * closes — matching the "Ghi nhớ đăng nhập" checkbox semantics.
 */
export async function createSession(userId: string, remember: boolean): Promise<void> {
  const mocPhien = await docMocPhien();
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

/**
 * `userId` của phiên ĐANG CÒN HIỆU LỰC, hoặc `null`.
 *
 * Khác `getSession()` (chỉ mở cookie): hàm này còn đối chiếu mốc phiên trong cookie với mốc hiện
 * hành, nên cookie cấp trước lần đổi mật khẩu gần nhất sẽ bị từ chối. MỌI chỗ quyết định "đã đăng
 * nhập chưa" phải đi qua đây — bỏ sót một chỗ là mở lại đúng cánh cửa vừa khoá.
 */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const session = await getSession();
  if (!session.userId) return null;
  const mocHienHanh = await docMocPhien();
  if ((session.mocPhien ?? MOC_PHIEN_MAC_DINH) !== mocHienHanh) return null;
  return session.userId;
}

/** Lựa chọn "Ghi nhớ đăng nhập" của phiên hiện tại (để cấp lại cookie đúng loại sau khi đổi mật khẩu). */
export async function docGhiNhoCuaPhien(): Promise<boolean> {
  const session = await getSession();
  return session.ghiNho === true;
}

/**
 * Guards a page: redirects to `/dang-nhap?redirect=<currentPath>` when there
 * is no authenticated user. Returns the authenticated `userId` otherwise.
 */
export async function requireUser(currentPath = "/"): Promise<string> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect(`/dang-nhap?redirect=${encodeURIComponent(currentPath)}`);
  }
  return userId;
}
