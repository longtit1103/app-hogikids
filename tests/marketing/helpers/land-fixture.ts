import { readFileSync } from "node:fs";
import path from "node:path";

import { landRaw } from "@/lib/bronze/land-raw";
import type { BronzeStream } from "@/lib/bronze/streams";

import { SHOP_TIKTOK_SHOP } from "../../helpers/shop-ids-fixture";

/**
 * Đưa fixture THẬT vào TEST DB qua ĐÚNG đường ghi của prod (`landRaw`), không INSERT tay.
 * Lý do: khoá (`idExpr`) và hash là thứ reader phụ thuộc; seed tay là tự dựng một sự thật thứ hai,
 * và bộ test sẽ xanh kể cả khi registry khai sai `arrayPath`/`idExpr`.
 */
export function docFixture(ten: string): string {
  const thuMuc = ten.endsWith("gmvmax-item.json")
    ? "tests/fixtures/tiktokbusiness"
    : "tests/fixtures/tiktokshop/analytics";
  return readFileSync(path.join(process.cwd(), thuMuc, ten), "utf8");
}

/** Fixture đã parse — để test sửa MỘT giá trị rồi land lại (ca "bản mới thắng"). */
export function docFixtureJson<T = Record<string, unknown>>(ten: string): T {
  return JSON.parse(docFixture(ten)) as T;
}

export async function landFixture(
  stream: BronzeStream,
  ten: string,
  ngay?: string,
  shopId = SHOP_TIKTOK_SHOP,
) {
  return landRaw(stream, shopId, docFixture(ten), undefined, undefined, undefined, ngay);
}

/**
 * Land một envelope dựng trong test (fixture thật đã sửa một giá trị). Đi qua CHÍNH `landRaw`
 * như mọi đường khác — sửa payload rồi INSERT tay là bỏ qua đúng phần khoá/hash cần kiểm.
 */
export async function landJson(
  stream: BronzeStream,
  envelope: unknown,
  ngay?: string,
  shopId = SHOP_TIKTOK_SHOP,
) {
  return landRaw(stream, shopId, JSON.stringify(envelope), undefined, undefined, undefined, ngay);
}

/** Land cùng payload cho NHIỀU ngày — dựng chuỗi ngày mà không phải đẻ thêm fixture. */
export async function landFixtureNhieuNgay(stream: BronzeStream, ten: string, ngays: string[]) {
  for (const d of ngays) await landFixture(stream, ten, d);
}
