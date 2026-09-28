import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireTokenVaultSecret } from "@/lib/ingest/token-vault-auth";

/**
 * Lưới cho bearer riêng của kho token OAuth (mục M-02).
 *
 * Điều phải khoá chặt nhất KHÔNG phải "secret đúng thì qua" mà là chiều ngược: **`INGEST_SECRET`
 * không còn mở được hai route này** khi cầu tương thích đã gỡ. Mất điều đó thì bản vá thành
 * trang trí — secret cũ vẫn rút được token 4 nền tảng.
 */

const VAULT = "vault-secret-dai-32-ky-tu-abcdef";
const INGEST = "ingest-secret-khac-hoan-toan-xyz";

function req(bearer?: string): Request {
  return new Request("https://app.invalid/api/ingest/meta-token", {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

beforeEach(() => {
  process.env.TOKEN_VAULT_SECRET = VAULT;
  process.env.INGEST_SECRET = INGEST;
  delete process.env.TOKEN_VAULT_FALLBACK_INGEST;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bearer kho token — tách khỏi INGEST_SECRET", () => {
  it("secret kho token đúng ⇒ cho qua", () => {
    expect(requireTokenVaultSecret(req(VAULT))).toBeNull();
  });

  it("INGEST_SECRET ⇒ 401 khi cầu tương thích ĐÃ GỠ (đây là toàn bộ điểm của M-02)", async () => {
    const res = requireTokenVaultSecret(req(INGEST));
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("INGEST_SECRET ⇒ qua khi cầu tương thích đang mở, và CÓ cảnh báo để biết mà gỡ", () => {
    process.env.TOKEN_VAULT_FALLBACK_INGEST = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(requireTokenVaultSecret(req(INGEST))).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("cầu mở nhưng bearer là chuỗi lạ ⇒ vẫn 401 (cầu không phải cửa mở toang)", () => {
    process.env.TOKEN_VAULT_FALLBACK_INGEST = "1";
    expect(requireTokenVaultSecret(req("khong-phai-secret-nao-ca"))?.status).toBe(401);
  });

  it("thiếu TOKEN_VAULT_SECRET + cầu đã gỡ ⇒ từ chối TẤT, kể cả INGEST_SECRET (fail-closed)", () => {
    delete process.env.TOKEN_VAULT_SECRET;
    expect(requireTokenVaultSecret(req(INGEST))?.status).toBe(401);
    expect(requireTokenVaultSecret(req(VAULT))?.status).toBe(401);
  });

  it("không có header Authorization ⇒ 401, không ném", () => {
    expect(requireTokenVaultSecret(req())?.status).toBe(401);
  });

  it("chỉ giá trị ĐÚNG mới qua — tiền tố khớp hay độ dài khác đều bị chặn", () => {
    // `timingSafeEqual` ném khi độ dài lệch; nhánh so độ dài phải chặn TRƯỚC, không được để lọt lỗi.
    expect(requireTokenVaultSecret(req(VAULT.slice(0, 10)))?.status).toBe(401);
    expect(requireTokenVaultSecret(req(`${VAULT}-them-duoi`))?.status).toBe(401);
  });

  it("cờ cầu chỉ nhận đúng \"1\" — đặt \"true\"/\"yes\" không được ngầm hiểu là mở", () => {
    process.env.TOKEN_VAULT_FALLBACK_INGEST = "true";
    expect(requireTokenVaultSecret(req(INGEST))?.status).toBe(401);
  });
});
