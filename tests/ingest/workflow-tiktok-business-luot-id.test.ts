import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * `tiktok-business-nightly` gửi MÃ LƯỢT kéo (`luotId` = id execution n8n) kèm MỌI trang `/api/ingest/raw`. Cổng chốt
 * sao kê thẻ gom trang hoá đơn theo mã này (`stats.luotId` route ghi); thiếu mã thì cổng đoán theo khoảng cách 30' —
 * gộp nhầm lượt chạy tay sát lượt lỗi và tách nhầm lượt có quãng nghỉ dài.
 *
 * CHẠY THẬT hàm `landRaw` cắt nguyên văn từ jsCode với `http` giả, và dòng khai báo `LUOT_ID` với `$execution` giả.
 */

type NodeN8n = { type: string; parameters?: { jsCode?: string } };
const WF = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "n8n/tiktok-business-nightly.json"), "utf8"),
) as { nodes: NodeN8n[] };
const JS = WF.nodes.find((n) => n.type === "n8n-nodes-base.code")?.parameters?.jsCode ?? "";

/** Cắt nguyên văn một khai báo hàm (kể cả `async function`) bằng cách đếm ngoặc — cùng cách các suite workflow khác. */
function catHam(ten: string): string {
  const viTri = JS.indexOf(`function ${ten}(`);
  expect(viTri, `jsCode phải khai báo function ${ten}`).toBeGreaterThanOrEqual(0);
  const dau = JS.slice(0, viTri).endsWith("async ") ? viTri - "async ".length : viTri;
  const moNgoac = JS.indexOf("{", viTri);
  let sau = 0;
  for (let i = moNgoac; i < JS.length; i++) {
    if (JS[i] === "{") sau++;
    else if (JS[i] === "}") {
      sau--;
      if (sau === 0) return JS.slice(dau, i + 1);
    }
  }
  throw new Error(`function ${ten} thiếu ngoặc đóng`);
}

/** Hằng top-level một dòng (`const TEN = …;`). */
function catHang(ten: string): string {
  const m = new RegExp(`^const ${ten} = [^\\n]+;$`, "m").exec(JS);
  expect(m, `jsCode phải khai báo hằng ${ten}`).not.toBeNull();
  return (m as RegExpExecArray)[0];
}

/** Khuôn route `/api/ingest/raw` nhận cho `luotId` — giữ khớp `LUOT_ID_HOP_LE` trong route. */
const KHUON_ROUTE = /^[A-Za-z0-9_-]{1,64}$/;

/** Dựng `LUOT_ID` + `landRaw` từ jsCode thật; `executionId` = giá trị `$execution.id` n8n trao cho Code node. */
function dung(executionId: unknown) {
  const http = vi.fn(async (_req: { body: Record<string, unknown> }) => ({ stats: { landed: 1 } }));
  const nguon = [catHang("LUOT_ID"), catHam("landRaw")].join("\n\n");
  const landRaw = new Function(
    "$execution",
    "http",
    "CONFIG",
    "log",
    `"use strict";\n${nguon}\nreturn landRaw;`,
  )({ id: executionId }, http, { appUrl: "https://app.test", ingestSecret: "s" }, () => {}) as (
    stream: string,
    shopId: string,
    text: string,
    ngay?: string,
  ) => Promise<number>;
  return { http, landRaw };
}

describe("tiktok-business-nightly — luotId theo execution", () => {
  it("landRaw hoá đơn gửi luotId = String($execution.id), đúng khuôn route", async () => {
    const { http, landRaw } = dung(104563);
    expect(await landRaw("tiktokbusiness/invoice", "7129545797879726081", "{}")).toBe(1);

    const body = http.mock.calls[0][0].body;
    expect(body).toEqual({ stream: "tiktokbusiness/invoice", shopId: "7129545797879726081", payload: "{}", luotId: "104563" });
    expect(body.luotId).toMatch(KHUON_ROUTE);
  });

  it("mọi stream cùng hàm land (report, gmvmax_item, cost kèm ngay) đều mang CÙNG luotId của execution", async () => {
    const { http, landRaw } = dung("98765");
    await landRaw("tiktokbusiness/report", "adv", "{}");
    await landRaw("tiktokbusiness/gmvmax_item", "adv", "{}");
    await landRaw("tiktokbusiness/cost", "bc", "{}", "2026-10-28");

    const bodies = http.mock.calls.map((c) => c[0].body);
    expect(bodies.map((b) => b.luotId)).toEqual(["98765", "98765", "98765"]);
    expect(bodies[2]).toMatchObject({ ngay: "2026-10-28" });
    expect(bodies[0]).not.toHaveProperty("ngay");
  });

  it("không có id execution ⇒ KHÔNG gửi khoá luotId (không gửi chữ \"undefined\" qua được khuôn)", async () => {
    for (const id of [undefined, null]) {
      const { http, landRaw } = dung(id);
      await landRaw("tiktokbusiness/invoice", "bc", "{}");
      expect(http.mock.calls[0][0].body).not.toHaveProperty("luotId");
    }
  });

  it("node chỉ POST /api/ingest/raw qua đúng hai hàm — landRaw (mọi stream) + landTrangHoaDon (khối dấu lượt hoá đơn) — cả hai gắn luotId", () => {
    // Đếm CHUỖI LITERAL (có ngoặc kép) — chú thích nhắc tên route không tính.
    expect(JS.split('"/api/ingest/raw"').length - 1).toBe(2);
    expect(catHam("landRaw")).toContain('"/api/ingest/raw"');
    expect(catHam("landRaw")).toContain("body.luotId = LUOT_ID;");
    expect(catHam("landTrangHoaDon")).toContain('"/api/ingest/raw"');
    expect(catHam("landTrangHoaDon")).toContain("body.luotId = LUOT_ID_HOA_DON;");
    // Hai hằng cùng một nguồn — lệch là trang hoá đơn và trang stream khác mang hai mã lượt.
    expect(catHang("LUOT_ID_HOA_DON").replace("LUOT_ID_HOA_DON", "LUOT_ID")).toBe(catHang("LUOT_ID"));
  });

  it("LUOT_ID khai báo trước mọi lời gọi landRaw, LUOT_ID_HOA_DON trước mọi lời gọi keoHoaDon (tránh vùng chết của const)", () => {
    expect(JS.search(/await landRaw\(/)).toBeGreaterThan(JS.indexOf(catHang("LUOT_ID")));
    expect(JS.search(/await keoHoaDon\(/)).toBeGreaterThan(JS.indexOf(catHang("LUOT_ID_HOA_DON")));
  });
});
