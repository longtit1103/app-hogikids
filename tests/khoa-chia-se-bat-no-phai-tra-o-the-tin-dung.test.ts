import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * LƯỚI AST — action thẻ tín dụng đọc/ghi quanh mốc M mở transaction bằng `await khoaChiaSeBatNoPhaiTra(tx)`
 * LÀ CÂU ĐẦU TIÊN (trước `khoaThe` và `docMocM`).
 *
 * Thứ tự quan trọng cả hai chiều: bước bật giữ EXCLUSIVE rồi khoá dòng thẻ theo id. Action giữ `khoaThe(X)`
 * rồi mới chờ khoá chung là chu trình chờ với bước bật (deadlock); đọc M trước khoá thì thấy M = null giữa lúc
 * bước bật chưa commit. Hành vi chờ thật khoá bằng ca đua ở `tests/unit/no-phai-tra/the-tin-dung.integration.test.ts`
 * — lưới này khoá thứ tự câu lệnh mà ca đua không thấy (bước bật giả không khoá dòng thẻ).
 */
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/actions/the-tin-dung.ts");
const ACTION_PHAI_KHOA = ["taoThe", "ganNenTang", "xoaGanNenTang"] as const;

function laGoi(n: ts.Node, ten: string): boolean {
  return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === ten;
}

/** Câu đầu của mọi callback `$transaction` bên trong hàm `ten` — mỗi callback một mô tả câu đầu (chuỗi). */
export function cauDauCacTransaction(src: string, ten: string): string[] {
  const goc = ts.createSourceFile("the-tin-dung.ts", src, ts.ScriptTarget.Latest, true);
  const hamTim: ts.FunctionDeclaration[] = [];
  goc.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === ten) hamTim.push(n);
  });
  if (hamTim.length !== 1) throw new Error(`Không thấy đúng một hàm ${ten}`);
  const ra: string[] = [];
  const di = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "$transaction") {
      const cb = n.arguments[0];
      if (cb !== undefined && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && ts.isBlock(cb.body)) {
        const dau = cb.body.statements[0];
        const thamSoTx = cb.parameters[0]?.name;
        // Khoá phải giữ tới hết transaction ⇒ đối số đầu là CHÍNH tham số client của callback (`tx`), không phải
        // `prisma` gốc (khoá giành ở kết nối khác rồi nhả ngay, không loại trừ được bước bật).
        const laKhoa =
          dau !== undefined &&
          ts.isExpressionStatement(dau) &&
          ts.isAwaitExpression(dau.expression) &&
          laGoi(dau.expression.expression, "khoaChiaSeBatNoPhaiTra") &&
          thamSoTx !== undefined &&
          ts.isIdentifier(thamSoTx) &&
          (() => {
            const doiSo = (dau.expression.expression as ts.CallExpression).arguments[0];
            return doiSo !== undefined && ts.isIdentifier(doiSo) && doiSo.text === thamSoTx.text;
          })();
        ra.push(laKhoa ? "khoaChiaSeBatNoPhaiTra" : (dau?.getText() ?? "(rỗng)"));
      } else ra.push("(callback không phải hàm có thân khối)");
    }
    ts.forEachChild(n, di);
  };
  di(hamTim[0]);
  return ra;
}

describe("action thẻ tín dụng: khoá chung với bước bật là câu đầu transaction", () => {
  const src = readFileSync(FILE, "utf8");

  it.each(ACTION_PHAI_KHOA)("%s: có $transaction và câu đầu mọi callback là await khoaChiaSeBatNoPhaiTra(", (ten) => {
    const cau = cauDauCacTransaction(src, ten);
    expect(cau.length).toBeGreaterThan(0);
    expect(cau.every((c) => c === "khoaChiaSeBatNoPhaiTra"), `${ten}: ${cau.join(" | ")}`).toBe(true);
  });

  it("lưới bắt được thứ tự đảo (khoaThe đứng trước khoá chung) và khoá bị bỏ", () => {
    const dao = src.replace(
      /(export async function xoaGanNenTang[\s\S]*?)await khoaChiaSeBatNoPhaiTra\(tx\);\n(\s*)(const truoc)/,
      "$1await khoaThe(tx, id);\n$2await khoaChiaSeBatNoPhaiTra(tx);\n$2$3"
    );
    expect(dao).not.toBe(src);
    expect(cauDauCacTransaction(dao, "xoaGanNenTang")).toEqual(["await khoaThe(tx, id);"]);
    const bo = src.replace(/(export async function ganNenTang[\s\S]*?)await khoaChiaSeBatNoPhaiTra\(tx\);\n/, "$1");
    expect(cauDauCacTransaction(bo, "ganNenTang")).not.toEqual(["khoaChiaSeBatNoPhaiTra"]);
    // Đúng tên hàm nhưng sai client: khoá bằng `prisma` gốc không giữ tới hết transaction.
    const sai = src.replace(/(export async function xoaGanNenTang[\s\S]*?)khoaChiaSeBatNoPhaiTra\(tx\)/, "$1khoaChiaSeBatNoPhaiTra(prisma)");
    expect(sai).not.toBe(src);
    expect(cauDauCacTransaction(sai, "xoaGanNenTang")).toEqual(["await khoaChiaSeBatNoPhaiTra(prisma);"]);
  });
});
