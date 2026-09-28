import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  boEscapeCopy,
  chuanHoaMocGioPostgres,
  docKhoiCopyBangCu,
  docThuMucFileMau,
  mocGioTuTenFile,
} from "../scripts/lib/doc-mau-webhook-pancake";

/**
 * Unit test THUẦN cho bộ đọc kho mẫu webhook — không đụng DB.
 *
 * Ba bẫy trọng tâm (đều làm hỏng dữ liệu một cách âm thầm):
 *  1) id int64 phải giữ nguyên từng chữ số — payload đi qua đây dưới dạng TEXT, không được parse.
 *  2) Khối COPY escape backslash: không bỏ escape thì `\"` thành `\\"` → JSON không đọc được.
 *  3) Mốc giờ: tên file n8n là GIỜ VN, `timestamptz` Postgres là UTC dạng `+00` mà Date của JS
 *     không hiểu — sai chỗ này thì lệch 7 tiếng hoặc thành Invalid Date.
 */
describe("đọc kho mẫu webhook Pancake", () => {
  describe("mocGioTuTenFile", () => {
    it("neo tên file n8n vào giờ VN (+07:00)", () => {
      expect(mocGioTuTenFile("20260726-161637-104574.json")?.toISOString()).toBe("2026-07-26T09:16:37.000Z");
    });

    it("trả null khi tên file không theo khuôn", () => {
      expect(mocGioTuTenFile("linh-tinh.json")).toBeNull();
    });
  });

  describe("chuanHoaMocGioPostgres", () => {
    it("đổi timestamptz Postgres về ISO đọc được", () => {
      const iso = chuanHoaMocGioPostgres("2026-06-13 07:30:08.051101+00");
      expect(new Date(iso).toISOString()).toBe("2026-06-13T07:30:08.051Z");
    });

    it("bù :00 cho offset 2 ký tự khác UTC", () => {
      expect(new Date(chuanHoaMocGioPostgres("2026-06-13 14:30:08.051101+07")).toISOString()).toBe(
        "2026-06-13T07:30:08.051Z"
      );
    });
  });

  describe("boEscapeCopy", () => {
    it("trả lại JSON nguyên vẹn từ dòng COPY", () => {
      const goc = '{"note":"Áo \\"Bà Ba\\"","id":"585211321905940019"}';
      const trongCopy = goc.replace(/\\/g, "\\\\");
      expect(boEscapeCopy(trongCopy)).toBe(goc);
      expect(JSON.parse(boEscapeCopy(trongCopy)).id).toBe("585211321905940019");
    });

    it("khôi phục ký tự điều khiển đã escape", () => {
      expect(boEscapeCopy("a\\tb\\nc")).toBe("a\tb\nc");
    });
  });

  describe("đọc 2 nguồn", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "kho-mau-webhook-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("đọc thư mục file mẫu theo shop, giữ payload nguyên xi", () => {
      mkdirSync(path.join(dir, "kho"));
      const payload = '{"type":"orders","id":"AF100975192O581"}';
      writeFileSync(path.join(dir, "kho", "20260726-102022-104551.json"), payload);
      writeFileSync(path.join(dir, "kho", "bo-qua.json"), "{}"); // tên sai khuôn → không đoán mốc giờ

      const doc = docThuMucFileMau(dir);
      expect(doc).toHaveLength(1);
      expect(doc[0].shopSlug).toBe("kho");
      expect(doc[0].payload).toBe(payload);
      expect(doc[0].receivedAt.toISOString()).toBe("2026-07-26T03:20:22.000Z");
    });

    it("đọc khối COPY, suy shop từ URL webhook hệ cũ", () => {
      const file = path.join(dir, "cu.copy");
      writeFileSync(
        file,
        [
          "COPY public.webhook_raw_events (id, source_type, body, received_at, webhook_name) FROM stdin;",
          `3158\torders\t{"id": "585140898791786238"}\t2026-06-13 07:30:08.051101+00\thttps://n8n.example.com/webhook/pancake-pos-hogikids2`,
          `3159\torders\t{"id": "260516HYR5495D"}\t2026-06-14 03:17:32.168378+00\thttps://n8n.example.com/webhook/pancake-pos-hogikids1`,
          `3160\torders\t{"id": "x"}\t2026-06-14 03:17:32.168378+00\thttps://n8n.example.com/webhook/khong-biet`,
          "\\.",
        ].join("\n")
      );

      const { suKien, boQua } = docKhoiCopyBangCu(file);
      expect(suKien.map((s) => s.shopSlug)).toEqual(["tiktok", "shopee"]);
      expect(JSON.parse(suKien[0].payload).id).toBe("585140898791786238");
      expect(suKien[0].receivedAt.toISOString()).toBe("2026-06-13T07:30:08.051Z");
      expect(boQua).toHaveLength(1); // URL lạ: KHÔNG đoán shop, báo ra để người kiểm
    });
  });
});
