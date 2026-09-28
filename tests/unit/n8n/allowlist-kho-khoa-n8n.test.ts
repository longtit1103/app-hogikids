import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  KEY_N8N_DUOC_DOC,
  MIGRATION_VIEW_N8N_ALLOWLIST,
  N8N_SETTING_VIEW,
} from "@/lib/n8n/role-doc-kho-khoa";

/**
 * Lưới cho view kho khoá `SettingN8n` sau khi đảo sang ALLOWLIST (fail-closed, 21/09/2026).
 *
 * Fail-closed đổi lớp lỗi: trước đây quên một key nghĩa là key đó LỘ (im lặng, nguy hiểm), nay
 * quên một key nghĩa là workflow n8n đọc thiếu dòng và CHẾT CÂM lúc 2h sáng — node lấy khoá vẫn
 * chạy, chỉ là thiếu giá trị, không có lỗi nào đỏ. Chính vì vậy quyết định 21/08 đã CỐ Ý chọn
 * exclude-list. Đảo chiều chỉ chấp nhận được khi có cổng chặn thật cho lớp lỗi mới — file này.
 *
 * Nguồn sự thật để so: chính câu SQL nằm trong `n8n/*.json` (bản repo của các workflow). Đo
 * 21/09 qua Public API: 11 workflow đang chạy trên prod dùng đúng tập key này.
 */

/** Mọi key xuất hiện trong mệnh đề `where key in (...)` đọc view, gom từ toàn bộ workflow repo. */
function keyWorkflowDoc(): Map<string, string[]> {
  const theoKey = new Map<string, string[]>();
  for (const ten of readdirSync("n8n").filter((f) => f.endsWith(".json"))) {
    const wf = JSON.parse(readFileSync(`n8n/${ten}`, "utf8")) as {
      nodes?: Array<{ parameters?: { query?: string } }>;
    };
    for (const node of wf.nodes ?? []) {
      const query = node.parameters?.query;
      if (!query?.includes(N8N_SETTING_VIEW)) continue;
      // Lấy đúng phần trong `in (...)` — không quét cả câu, để chuỗi trong comment/alias không lọt vào.
      const menhDe = query.match(/\bkey\s+in\s*\(([^)]*)\)/i);
      if (!menhDe) throw new Error(`${ten}: đọc ${N8N_SETTING_VIEW} mà không có mệnh đề \`key in (...)\``);
      for (const [, key] of menhDe[1].matchAll(/'([^']+)'/g)) {
        theoKey.set(key, [...(theoKey.get(key) ?? []), ten]);
      }
    }
  }
  return theoKey;
}

/**
 * Câu tạo view trong migration, ĐÃ BỎ comment `--`.
 * Bỏ comment không phải cho đẹp: comment trong chính câu SQL có chứa dấu `)` (vd
 * "qua /api/ingest/meta-token, KHÔNG qua view") và nó cắt mất mệnh đề `IN (...)` khi so — lần
 * viết đầu của test này đỏ đúng vì vậy, và nếu regex lỏng hơn thì nó đã so NHẦM một tập con
 * rồi báo xanh.
 */
function cauTaoView(): string {
  const sql = readFileSync(MIGRATION_VIEW_N8N_ALLOWLIST, "utf8");
  return sql
    .slice(sql.indexOf("CREATE OR REPLACE VIEW"))
    .replace(/--[^\n]*/g, "");
}

/** Mọi node có `jsCode`, kèm tên file + tên node để câu báo lỗi chỉ thẳng chỗ sửa. */
function nodeCode(): Array<{ file: string; node: string; code: string; query: string }> {
  const ra: Array<{ file: string; node: string; code: string; query: string }> = [];
  for (const ten of readdirSync("n8n").filter((f) => f.endsWith(".json"))) {
    const wf = JSON.parse(readFileSync(`n8n/${ten}`, "utf8")) as {
      nodes?: Array<{ name?: string; parameters?: { jsCode?: string; query?: string } }>;
    };
    const query = (wf.nodes ?? []).map((n) => n.parameters?.query ?? "").join("\n");
    for (const node of wf.nodes ?? []) {
      const code = node.parameters?.jsCode;
      if (code) ra.push({ file: ten, node: node.name ?? "?", code, query });
    }
  }
  return ra;
}

describe("allowlist kho khoá n8n — fail-closed", () => {
  it("mọi key workflow n8n ĐỌC đều nằm trong allowlist (thiếu = workflow chết câm)", () => {
    const duocPhep = new Set<string>(KEY_N8N_DUOC_DOC);
    const thieu = [...keyWorkflowDoc()]
      .filter(([key]) => !duocPhep.has(key))
      .map(([key, files]) => `${key} (dùng ở ${files.join(", ")})`);
    expect(thieu).toEqual([]);
  });

  it("allowlist khớp TUYỆT ĐỐI với SQL migration tạo view — hai phía không được trôi khỏi nhau", () => {
    const menhDe = cauTaoView().match(/key IN \(([^)]*)\)/);
    expect(menhDe).not.toBeNull();
    const trongSql = [...(menhDe as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map(([, k]) => k).sort();
    expect(trongSql).toEqual([...KEY_N8N_DUOC_DOC].sort());
  });

  it("view phải là allowlist, KHÔNG còn `NOT IN` (đảo chiều nửa vời là quay lại fail-open)", () => {
    expect(cauTaoView()).not.toMatch(/key\s+NOT\s+IN/i);
    expect(cauTaoView()).toMatch(/key\s+IN\s*\(/i);
  });

  it("giữ security_barrier — thiếu nó thì allowlist vẫn bị moi qua thông báo lỗi", () => {
    const sql = readFileSync(MIGRATION_VIEW_N8N_ALLOWLIST, "utf8");
    expect(sql).toMatch(/ALTER VIEW "SettingN8n" SET \(security_barrier = true\)/);
  });

  it("mọi `CONFIG.x` dùng trong jsCode đều được ĐỊNH NGHĨA trong khối CONFIG", () => {
    // Lỗ này có thật, không phải giả định: 21/09 một node của `tiktokshop-nightly` dùng
    // `CONFIG.tokenVaultSecret` ở 2 chỗ trong khi khối CONFIG không khai trường đó — câu SQL,
    // allowlist và migration ĐỀU xanh, vì cả ba chỉ so với nhau và mù tầng JS tiêu thụ khoá.
    // Hậu quả nếu lọt: node gửi `Bearer undefined` → 401 mỗi đêm, app không đỏ chỗ nào.
    const hong: string[] = [];
    for (const { file, node, code } of nodeCode()) {
      const khoiConfig = code.match(/const CONFIG = \{[\s\S]*?\n\};/)?.[0] ?? "";
      const dung = new Set([...code.matchAll(/\bCONFIG\.([A-Za-z_$][\w$]*)/g)].map(([, k]) => k));
      for (const truong of dung) {
        if (!new RegExp(`\\b${truong}\\s*:`).test(khoiConfig)) hong.push(`${file} › ${node} › CONFIG.${truong}`);
      }
    }
    expect(hong).toEqual([]);
  });

  it("mọi `KHOA.x` dùng trong jsCode đều được câu SQL của chính workflow đó LẤY VỀ", () => {
    // Chiều ngược lại: đọc một key mà `where key in (...)` không lấy thì `KHOA.x` là undefined —
    // cũng câm y hệt. Cổng này bắt cả hai đầu của sợi dây SQL → CONFIG → header.
    const hong: string[] = [];
    for (const { file, node, code, query } of nodeCode()) {
      if (!query.includes(N8N_SETTING_VIEW)) continue;
      const layVe = new Set([...query.matchAll(/'([^']+)'/g)].map(([, k]) => k));
      for (const [, key] of code.matchAll(/\bKHOA\.([A-Za-z_$][\w$]*)/g)) {
        if (!layVe.has(key)) hong.push(`${file} › ${node} › KHOA.${key}`);
      }
    }
    expect(hong).toEqual([]);
  });

  it("KHÔNG một khoá bí mật nào ngoài phạm vi n8n lọt vào allowlist", () => {
    // Bốn thứ nặng nhất trong `Setting`: khoá quản trị n8n, mật khẩu role đọc view, và kho token
    // OAuth. n8n lấy token qua route `/api/ingest/*-token` (có bearer riêng), KHÔNG qua view.
    const camTuyetDoi = [
      "n8nApiKey",
      "n8nDbRoPassword",
      "metaAdsAccessToken",
      "metaAdsAppSecret",
      "tiktokShopAccessToken",
      "tiktokShopRefreshToken",
      "n8nSyncNowSecret",
    ];
    const lot = camTuyetDoi.filter((k) => ([...KEY_N8N_DUOC_DOC] as string[]).includes(k));
    expect(lot).toEqual([]);
  });
});
