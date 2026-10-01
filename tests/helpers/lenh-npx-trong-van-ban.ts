/**
 * Đọc lệnh `npx` trong VĂN BẢN (runbook, docs, comment, YAML CI) cho các test hợp đồng #261.
 *
 * Hai bẫy mà quét theo từng dòng hay regex "chữ ngay sau npx" để lọt:
 *  - Lệnh shell nhiều dòng: `docker compose run --rm app \` + xuống dòng + `npx prisma …` — `app` và `npx`
 *    nằm ở hai dòng. `noiLenhNhieuDong` nối dòng tiếp nối (`\` cuối dòng) thành một lệnh logic, kể cả khi
 *    dòng sau mang tiền tố comment (`#`, ` * `, `//`) vì lệnh mẫu hay nằm trong comment/khối bash có `#`.
 *  - Cờ xen giữa: `npx --yes prisma`, `npx -y tsx`, `npx --package=x y` — chính các cờ cho npx TỰ TẢI.
 *    `goiNpx` trả về đủ cờ đứng trước tên bin để test đòi đúng `["--no-install"]`.
 */

/** Nối dòng tiếp nối shell (`\` cuối dòng) thành một dòng logic. */
export const noiLenhNhieuDong = (text: string): string =>
  text.replace(/\\\r?\n[ \t]*(?:(?:#|\*|\/\/)[ \t]*)?/g, " ");

/** Mọi lần gọi `npx` (sau khi nối dòng): cờ đứng trước tên bin + tên bin. */
export function goiNpx(text: string): { co: string[]; bin: string }[] {
  return [...noiLenhNhieuDong(text).matchAll(/\bnpx((?:[ \t]+-\S+)*)[ \t]+([^\s-][^\s`'"]*)/g)].map((m) => ({
    co: m[1].trim().split(/\s+/).filter(Boolean),
    bin: m[2],
  }));
}

/**
 * Lệnh `npx` chạy TRONG container app (sau khi nối dòng): `docker compose|docker-compose [-f …] run|exec … app npx …` hoặc
 * `docker exec … hogikids-app npx …`. Không đi qua xuống dòng thật (một lệnh logic = một dòng sau khi nối).
 */
export function goiNpxTrongContainer(text: string): { co: string[]; bin: string }[] {
  const lenh = /(?:docker[ -]compose\b[^`\n]*?\b(?:run|exec)\b[^`\n]*?\bapp|docker exec\b[^`\n]*?\bhogikids-app)[ \t]+(npx\b[^`\n]*)/g;
  return [...noiLenhNhieuDong(text).matchAll(lenh)].flatMap((m) => goiNpx(m[1]).slice(0, 1));
}
