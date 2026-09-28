import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Cửa sổ ngày của 4 workflow nightly phải có MỘT nguồn duy nhất: một key trong bảng
 * `app."Setting"` ép số ngày cho MỌI lượt; không có key thì rơi về `nightlyDays` (hẹp).
 *
 * Vì sao phải khoá bằng test. Bản cũ chọn cửa sổ theo `$execution.mode` so với `"trigger"`.
 * Đo thật (26/07/2026, đo lại 01/08/2026): trong Code node biến đó CHỈ nhận `"production"`
 * (lịch cron) hoặc `"test"` (bấm tay) — KHÔNG BAO GIỜ `"trigger"`; `"trigger"` là nhãn ở REST
 * `/executions`, thứ khác hẳn. Nên nhánh `=== "trigger"` sai với cả hai chế độ: Meta rơi vào
 * backfill 730 ngày MỖI ĐÊM, ghi lại toàn bộ dòng `Expense` từ 09/08/2024. Vì app tính
 * `amount = spendExVat × (1 + vatRate)`, ngày nào đổi thuế suất là đêm đó 2 năm chi phí lịch sử
 * bị viết lại ⇒ lợi nhuận mọi kỳ quá khứ nhảy số.
 *
 * Bẫy thứ hai, âm thầm hơn: node "Lấy khoá từ bảng Setting" lọc theo danh sách key CỐ ĐỊNH
 * (`where key in (...)`), không `select *`. Thêm key vào bảng mà quên thêm vào câu SQL thì cơ
 * chế chết câm — workflow im lặng dùng mặc định, không ai biết.
 *
 * Bẫy thứ ba (vá 03/08/2026): giá trị của key KHÔNG được kiểm biên. `Number(x) > 0` nhận cả
 * `"7.5"` (mốc `since` lệch nửa ngày), `"Infinity"` (ra `Invalid Date` giữa đêm), `"100000"`
 * (hàng nghìn request, chạm rate-limit + trần 3600s của runner), và nuốt LẶNG `"abc"`/số âm —
 * người vận hành đặt key xong tưởng đã backfill mà thực ra không. Nay chỉ nhận SỐ NGUYÊN trong
 * trần của từng workflow, sai thì THROW. Nhóm test cuối file chạy THẬT hàm quyết định lấy từ
 * jsCode để chứng minh hành vi biên, chứ không chỉ dò chuỗi.
 */

type NodeN8n = {
  name: string;
  type: string;
  parameters?: { jsCode?: string; query?: string };
};

function docWorkflow(ten: string): NodeN8n[] {
  const raw = readFileSync(path.join(process.cwd(), "n8n", ten), "utf8");
  return (JSON.parse(raw) as { nodes: NodeN8n[] }).nodes;
}

/** Node Code duy nhất của workflow — nơi chứa toàn bộ logic cửa sổ ngày. */
function nodeCode(nodes: NodeN8n[]): string {
  const codes = nodes.filter((n) => n.type === "n8n-nodes-base.code");
  expect(codes, "workflow phải có đúng 1 node Code").toHaveLength(1);
  return codes[0].parameters?.jsCode ?? "";
}

/** Câu SQL của node Postgres đọc bảng Setting. */
function sqlLayKhoa(nodes: NodeN8n[]): string {
  const pg = nodes.filter((n) => n.type === "n8n-nodes-base.postgres");
  expect(pg, "workflow phải có đúng 1 node Postgres lấy khoá").toHaveLength(1);
  return pg[0].parameters?.query ?? "";
}

/**
 * Bỏ chú thích để chỉ soi CODE CHẠY THẬT. Ghi chú lịch sử trong các file này CÓ nhắc chuỗi
 * `"trigger"` một cách chủ đích (để người sau không khôi phục lại lỗi) — soi cả comment thì
 * test đỏ oan và người ta sẽ xoá mất chính lời cảnh báo đó.
 */
function boChuThich(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((dong) => !dong.trim().startsWith("//"))
    .join("\n");
}

const WORKFLOWS = [
  // `tran` = trần cửa sổ ép tay của từng workflow. Căn cứ ghi trong node Code, tóm tắt:
  // Meta 730 (chi tiêu xa nhất 08/08/2024) · TikTok Business 60 (VAT đo theo kỳ, rộng là trộn
  // thuế nhiều kỳ) · TikTok Shop 180 (~980 statement ≈ 50 phút, sát trần 3600s của runner) ·
  // TikTok Shop Analytics 90 (~190 request ≈ 4 phút; rộng hơn chỉ chạm rate-limit vì sàn chỉ
  // chỉnh số hồi tố vài ngày).
  { file: "meta-ads-nightly.json", key: "metaAdsManualDays", tran: 730 },
  { file: "tiktok-business-nightly.json", key: "tiktokBusinessManualDays", tran: 60 },
  { file: "tiktokshop-nightly.json", key: "tiktokShopManualDays", tran: 180 },
  { file: "tiktokshop-analytics-nightly.json", key: "tiktokShopAnalyticsManualDays", tran: 90 },
] as const;

describe("cửa sổ ngày của workflow nightly", () => {
  // Tiêu đề tránh viết thẳng `$execution` — vitest coi `$<tên>` là chỗ nội suy tham số.
  it.each(WORKFLOWS)("$file: không chọn cửa sổ theo chế độ chạy của n8n", ({ file }) => {
    const chay = boChuThich(nodeCode(docWorkflow(file)));
    expect(
      chay,
      "$execution.mode không phân biệt được lịch/tay — dùng nó để chọn cửa sổ là quay lại lỗi cũ",
    ).not.toMatch(/\$execution\.mode\s*[=!]==/);
  });

  it.each(WORKFLOWS)("$file: cửa sổ lấy từ key $key, mặc định là nightlyDays", ({ file, key }) => {
    const chay = boChuThich(nodeCode(docWorkflow(file)));
    expect(chay, `phải đọc KHOA.${key}`).toContain(`KHOA.${key}`);
    expect(chay, "phải có mặc định hẹp nightlyDays").toContain("nightlyDays");
    // `lookbackDays`/`backfillDays` là cặp biến của cơ chế cũ — còn sót là còn nhánh cũ.
    expect(chay).not.toContain("lookbackDays");
    expect(chay).not.toContain("backfillDays");
  });

  it.each(WORKFLOWS)("$file: câu SQL lấy khoá CÓ liệt kê $key", ({ file, key }) => {
    expect(
      sqlLayKhoa(docWorkflow(file)),
      `query lọc theo danh sách key cố định — thiếu ${key} là cơ chế chết câm`,
    ).toContain(key);
  });

  it.each(WORKFLOWS)("$file: output in execMode để lần sau khỏi suy đoán", ({ file }) => {
    expect(boChuThich(nodeCode(docWorkflow(file)))).toMatch(/execMode:\s*\$execution\.mode/);
  });
});

// ---------------------------------------------------------------------------------------------
// Hành vi biên của giá trị key — chạy THẬT hàm lấy ra từ jsCode
// ---------------------------------------------------------------------------------------------

/**
 * Cắt nguyên văn một khai báo `function <ten>(...) { ... }` ra khỏi jsCode bằng cách đếm ngoặc.
 *
 * ĐÁNH ĐỔI (nói rõ để người sau khỏi tưởng nó chắc hơn thực tế): bộ đếm này KHÔNG hiểu chuỗi hay
 * chú thích, nên một dấu `{`/`}` lẻ nằm trong chuỗi của hàm sẽ cắt sai. Đổi lại, cắt sai KHÔNG
 * bao giờ cho test xanh oan: đoạn cắt được đem `new Function` biên dịch ngay — cắt thiếu ⇒
 * SyntaxError, cắt thừa ⇒ lôi theo `const soNgayEp = soNgayCuaSo(...)` phía dưới và nổ
 * ReferenceError vì không có `KHOA`. Cả hai đều đỏ.
 *
 * Vì sao không eval CẢ node: jsCode là script async dùng `$input`, `this.helpers.httpRequest`,
 * `$execution` — dựng đủ sân khấu cho nó là viết lại n8n. Còn tái hiện hàm thuần trong test thì
 * test sẽ xanh cả khi jsCode thật đã hỏng, tức là test giả. Cắt ra chạy thật là mức ít giả nhất
 * trong tầm với.
 */
function catHam(js: string, ten: string): string {
  const dau = js.indexOf(`function ${ten}(`);
  expect(dau, `jsCode phải khai báo function ${ten}`).toBeGreaterThanOrEqual(0);
  const moNgoac = js.indexOf("{", dau);
  expect(moNgoac, `không tìm thấy thân hàm ${ten}`).toBeGreaterThan(dau);
  let sau = 0;
  for (let i = moNgoac; i < js.length; i++) {
    if (js[i] === "{") sau++;
    else if (js[i] === "}") {
      sau--;
      if (sau === 0) return js.slice(dau, i + 1);
    }
  }
  throw new Error(`function ${ten} thiếu ngoặc đóng trong jsCode`);
}

type HamCuaSo = (key: string, giaTri: unknown, tran: number) => number;

function napHamCuaSo(file: string): { ham: HamCuaSo; nguon: string } {
  const nguon = catHam(nodeCode(docWorkflow(file)), "soNgayCuaSo");
  const tao = new Function(`"use strict";\n${nguon}\nreturn soNgayCuaSo;`) as () => HamCuaSo;
  return { ham: tao(), nguon };
}

type Ca = { nhan: string; vao: unknown; mong: number | "loi" };

function bangCa(tran: number): Ca[] {
  return [
    { nhan: "không có key trong bảng", vao: undefined, mong: 0 },
    { nhan: "ô để trống", vao: "", mong: 0 },
    { nhan: "ô toàn khoảng trắng", vao: "   ", mong: 0 },
    { nhan: "giá trị null", vao: null, mong: 0 },
    { nhan: "số nguyên hợp lệ", vao: "7", mong: 7 },
    { nhan: "hợp lệ nhưng dính khoảng trắng", vao: " 30 ", mong: 30 },
    { nhan: "đúng trần", vao: String(tran), mong: tran },
    { nhan: "số lẻ (mốc since lệch nửa ngày)", vao: "7.5", mong: "loi" },
    { nhan: "số 0 (phải bảo xoá ô, không im lặng về mặc định)", vao: "0", mong: "loi" },
    { nhan: "số âm", vao: "-1", mong: "loi" },
    { nhan: "chữ", vao: "abc", mong: "loi" },
    { nhan: "Infinity (ra Invalid Date)", vao: "Infinity", mong: "loi" },
    { nhan: "100000 (hàng nghìn request, quá trần runner)", vao: "100000", mong: "loi" },
    { nhan: "vượt trần đúng 1", vao: String(tran + 1), mong: "loi" },
  ];
}

describe("giá trị key cửa sổ ngày phải là số nguyên trong trần", () => {
  it.each(WORKFLOWS)("$file: chạy thật hàm quyết định với bảng giá trị biên", ({ file, key, tran }) => {
    const { ham } = napHamCuaSo(file);

    for (const ca of bangCa(tran)) {
      if (ca.mong !== "loi") {
        expect(ham(key, ca.vao, tran), `${ca.nhan} → phải ra ${ca.mong}`).toBe(ca.mong);
        continue;
      }

      let msg: string | null = null;
      try {
        const ra = ham(key, ca.vao, tran);
        throw new Error(
          `${ca.nhan}: giá trị sai mà KHÔNG kêu — hàm trả ${ra}. Rơi về mặc định trong im lặng ` +
            `chính là lỗi cần chặn (người vận hành tưởng đã backfill mà thực ra không).`,
        );
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
        // Lỗi do chính test ném ở trên (hàm không kêu) thì phải nổi lên, không được nuốt.
        if (msg.includes("giá trị sai mà KHÔNG kêu")) throw err;
      }

      // Kêu thôi chưa đủ — thông báo phải chỉ đúng ô nào sai và khoảng nào hợp lệ, nếu không
      // người đọc log giữa đêm vẫn không biết sửa ở đâu.
      expect(msg, `${ca.nhan}: thông báo lỗi phải nêu tên key`).toContain(key);
      expect(msg, `${ca.nhan}: thông báo lỗi phải nêu trần ${tran}`).toContain(String(tran));
    }
  });

  it.each(WORKFLOWS)("$file: hàm được nối đúng vào key $key với trần $tran", ({ file, key, tran }) => {
    const chay = boChuThich(nodeCode(docWorkflow(file)));
    expect(chay, `trần phải khai báo rõ = ${tran}`).toContain(`const MAX_MANUAL_DAYS = ${tran};`);
    expect(
      chay,
      "hàm có mà không ai gọi thì vô dụng — cửa sổ phải đi qua nó",
    ).toContain(`soNgayCuaSo("${key}", KHOA.${key}, MAX_MANUAL_DAYS)`);
    expect(
      chay,
      "còn đường cũ `Number(KHOA.<key> || 0)` là còn ngả nuốt lặng giá trị rác",
    ).not.toContain(`Number(KHOA.${key}`);
  });

  it("bốn workflow dùng y hệt một hàm (n8n không share code được nên phải soi bản sao)", () => {
    const nguon = WORKFLOWS.map((w) => napHamCuaSo(w.file).nguon);
    for (let i = 1; i < nguon.length; i++) {
      expect(
        nguon[i],
        `${WORKFLOWS[i].file} lệch khỏi ${WORKFLOWS[0].file} — sửa một bản mà quên hai bản kia ` +
          `là kiểu hỏng kinh điển của code chép tay giữa các node`,
      ).toBe(nguon[0]);
    }
  });
});
