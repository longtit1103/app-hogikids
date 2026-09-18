import { afterEach, describe, expect, it, vi } from "vitest";

import { doiTokenMetaDaiHan } from "@/lib/tokens/meta-doi-token-dai-han";

/**
 * Luồng đổi token Meta trên web (port từ scripts/meta-ads-lay-token.ts): exchange → debug_token.
 * Bất biến kèm theo: message lỗi ném ra hiện NGUYÊN VĂN trên UI ⇒ không được chứa token/secret.
 */

const ARGS = { tokenTuoi: "TOKEN-TUOI-XYZ", appId: "111", appSecret: "SECRET-APP-999" };

function stubFetch(impl: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => ({ json: async () => impl(String(url)) })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("doiTokenMetaDaiHan", () => {
  it("đổi thành công: trả token dài hạn + hạn thật từ debug_token", async () => {
    const hetHan = Math.floor(Date.now() / 1000) + 60 * 86400;
    const dataHan = Math.floor(Date.now() / 1000) + 90 * 86400;
    stubFetch((url) =>
      url.includes("/oauth/access_token")
        ? { access_token: "TOKEN-DAI-HAN-MOI" }
        : { data: { expires_at: hetHan, data_access_expires_at: dataHan, is_valid: true, scopes: ["ads_read"] } },
    );

    const r = await doiTokenMetaDaiHan(ARGS);
    expect(r).toEqual({
      tokenMoi: "TOKEN-DAI-HAN-MOI",
      hetHanEpoch: hetHan,
      dataAccessHetHanEpoch: dataHan,
      conSong: true,
      quyen: ["ads_read"],
    });
  });

  it("gửi đúng token tươi + app id/secret vào bước exchange", async () => {
    stubFetch((url) =>
      url.includes("/oauth/access_token")
        ? { access_token: "T" }
        : { data: { is_valid: true } },
    );
    await doiTokenMetaDaiHan(ARGS);
    const goiDau = vi.mocked(fetch).mock.calls[0]?.[0];
    expect(String(goiDau)).toContain(`fb_exchange_token=${ARGS.tokenTuoi}`);
    expect(String(goiDau)).toContain(`client_id=${ARGS.appId}`);
  });

  it("Meta từ chối → lỗi nêu nguyên nhân của Meta, KHÔNG chứa token/secret", async () => {
    stubFetch(() => ({ error: { message: "Invalid OAuth access token", code: 190 } }));
    const loi = await doiTokenMetaDaiHan(ARGS).catch((e: Error) => e);
    expect(loi).toBeInstanceOf(Error);
    const msg = (loi as Error).message;
    expect(msg).toContain("Facebook từ chối");
    expect(msg).not.toContain(ARGS.tokenTuoi);
    expect(msg).not.toContain(ARGS.appSecret);
  });

  it("mạng đứt ở bước exchange → lỗi dễ hiểu, không lộ gì", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error(`boom ${ARGS.tokenTuoi}`))));
    const loi = await doiTokenMetaDaiHan(ARGS).catch((e: Error) => e);
    expect((loi as Error).message).toContain("Không gọi được Facebook");
    expect((loi as Error).message).not.toContain(ARGS.tokenTuoi);
  });

  it("debug_token đứt sau khi đổi → báo token CHƯA được lưu (phải thử lại)", async () => {
    let lanGoi = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        lanGoi += 1;
        if (lanGoi === 1) return { json: async () => ({ access_token: "T2" }) };
        throw new Error("timeout");
      }),
    );
    const loi = await doiTokenMetaDaiHan(ARGS).catch((e: Error) => e);
    expect((loi as Error).message).toContain("chưa được lưu");
  });
});
