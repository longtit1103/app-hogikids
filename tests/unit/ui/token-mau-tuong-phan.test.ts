import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Khoá tương phản WCAG AA (4,5:1 cho chữ thường) của các token màu dùng làm CHỮ hoặc làm nền nút chữ
 * trắng, đọc THẲNG từ `src/app/globals.css` — ai nâng sáng lại `--warning`/`--success`/… (chữ cảnh báo
 * rớt về ~2:1, đọc không nổi ngoài nắng) sẽ đỏ ở đây thay vì chỉ lộ khi chủ shop phàn nàn.
 *
 * Công thức WCAG 2.x: tương phản = (L1 + 0,05) / (L2 + 0,05), L = độ sáng tương đối của sRGB.
 */
const css = readFileSync(join(__dirname, "..", "..", "..", "src", "app", "globals.css"), "utf8");

function token(ten: string): string {
  const m = css.match(new RegExp(`--${ten}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!m) throw new Error(`Không thấy token --${ten} trong globals.css`);
  return m[1];
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const tuyenTinh = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const doSang = ([r, g, b]: [number, number, number]): number => 0.2126 * tuyenTinh(r) + 0.7152 * tuyenTinh(g) + 0.0722 * tuyenTinh(b);
const tuongPhan = (a: [number, number, number], b: [number, number, number]): number => {
  const [sang, toi] = [doSang(a), doSang(b)].sort((x, y) => y - x);
  return (sang + 0.05) / (toi + 0.05);
};
/** Màu `fg` phủ độ đục `a` lên nền `bg` (đúng như `bg-warning/15` trên canvas). */
const tron = (fg: [number, number, number], bg: [number, number, number], a: number): [number, number, number] =>
  fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a))) as [number, number, number];

const NEN_BE = ["canvas", "surface-soft", "surface-card", "surface-cream-strong"] as const;
const NEN_TOI = ["surface-dark", "surface-dark-elevated"] as const;
const TRANG: [number, number, number] = [255, 255, 255];

describe("token chữ đạt AA 4,5:1 trên các nền be của app", () => {
  it.each(["warning", "success", "error", "muted"])("--%s", (ten) => {
    const chu = rgb(token(ten));
    for (const nen of NEN_BE) {
      expect(tuongPhan(chu, rgb(token(nen))), `${ten} trên ${nen}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Badge/callout `bg-<màu>/10|15` đặt trên canvas, soft và card; trên cream-strong (hàng mốc kết quả) chỉ dùng tint 10%.
  it.each(["warning", "success", "error"])("--%s trên nền tint của chính nó (badge/callout) trên mọi nền be", (ten) => {
    const chu = rgb(token(ten));
    for (const nenBe of NEN_BE) {
      const doDuc = nenBe === "surface-cream-strong" ? [0.1] : [0.1, 0.15];
      for (const a of doDuc) {
        const nen = tron(chu, rgb(token(nenBe)), a);
        expect(tuongPhan(chu, nen), `${ten} trên tint ${a} của ${nenBe}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("--primary-active (chữ link trên card/soft/cream-strong) ≥ 4,5:1", () => {
    for (const nen of NEN_BE) {
      expect(tuongPhan(rgb(token("primary-active")), rgb(token(nen))), `primary-active trên ${nen}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("chữ trên nền tối (surface-dark)", () => {
  it.each(["error", "warning", "success", "muted"])("--%s-on-dark ≥ 4,5:1 trên surface-dark và surface-dark-elevated", (ten) => {
    for (const nen of NEN_TOI) {
      expect(tuongPhan(rgb(token(`${ten}-on-dark`)), rgb(token(nen))), `${ten}-on-dark trên ${nen}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("chữ on-dark/70 (nhãn phụ) ≥ 4,5:1 trên surface-dark", () => {
    const chu = tron(rgb(token("on-dark")), rgb(token("surface-dark")), 0.7);
    expect(tuongPhan(chu, rgb(token("surface-dark")))).toBeGreaterThanOrEqual(4.5);
  });

  it("bốn token chữ nền be KHÔNG đủ trên nền tối — đó là lý do phải có bản on-dark", () => {
    // Ghim lý do tồn tại: nếu một ngày token be tự đạt AA trên nền tối thì bản on-dark thành thừa.
    for (const ten of ["error", "warning", "success", "muted"]) {
      expect(tuongPhan(rgb(token(ten)), rgb(token("surface-dark"))), ten).toBeLessThan(4.5);
    }
  });
});

const GOC_SRC = join(__dirname, "..", "..", "..", "src");
const docSrc = (tep: string): string => readFileSync(join(GOC_SRC, tep), "utf8");
const tatCaTep = readdirSync(GOC_SRC, { recursive: true, encoding: "utf8" }).filter((t) => /\.tsx?$/.test(t));

/** Lớp màu CHỮ/VIỀN của token nền be (không phải bản `-on-dark`). Trả tên token: error | warning | success | muted. */
function tokenBeTrongDong(dong: string): string[] {
  const kq: string[] = [];
  for (const m of dong.matchAll(/(?:text|border)-(error|warning|success)(?![\w-])/g)) kq.push(m[1]);
  if (/text-muted-foreground(?![\w-])/.test(dong)) kq.push("muted");
  return kq;
}

/** Dòng hợp lệ trên nền tối: cùng dòng có bản on-dark của token đó (muted: chấp nhận `text-on-dark/…`). */
function dongTrenNenToiHopLe(dong: string, token_: string): boolean {
  if (dong.includes(`${token_}-on-dark`)) return true;
  return token_ === "muted" && /text-on-dark\//.test(dong);
}

/** Thân hàm từ `function ten` tới dấu `}` đầu dòng kế tiếp. */
function thanHam(noiDung: string, ten: string): string {
  const dau = noiDung.indexOf(`function ${ten}(`);
  if (dau < 0) throw new Error(`Không thấy hàm ${ten}`);
  const cuoi = noiDung.indexOf("\n}\n", dau);
  return noiDung.slice(dau, cuoi < 0 ? undefined : cuoi);
}

describe("quét mã nguồn: chữ trên nền tối dùng token on-dark", () => {
  // Mỗi file có `bg-surface-dark` PHẢI được rà ở đây; file mới thêm nền tối mà chưa khai báo ⇒ test đỏ.
  // `ham: null` = soi cả file; có tên hàm = chỉ soi thân hàm (file còn thẻ nền sáng dùng token be hợp lệ).
  const VUNG_NEN_TOI: Record<string, { ham: string[] | null }> = {
    "app/layout.tsx": { ham: null },
    "components/kenh/channel-card-grid.tsx": { ham: null },
    "components/kenh/channel-card-metric.tsx": { ham: ["DeltaLine", "MetricCell"] },
    "components/products/product-kpi-cards.tsx": { ham: ["KpiCard"] },
    "components/inventory/inventory-kpi-cards.tsx": { ham: ["Card"] },
    "components/orders/order-returned-panel.tsx": { ham: null },
    "components/orders/order-profit-tree.tsx": { ham: ["rowBandClass"] },
    "components/bao-cao/pnl-tab.tsx": { ham: ["DeltaText", "DeltaCell", "rowBandClass"] },
  };

  it("mọi file có bg-surface-dark đã được khai báo vùng rà", () => {
    const coNenToi = tatCaTep.filter((t) => docSrc(t).includes("bg-surface-dark"));
    const chuaKhaiBao = coNenToi.filter((t) => !(t.replaceAll("\\", "/") in VUNG_NEN_TOI));
    expect(chuaKhaiBao).toEqual([]);
  });

  it("dòng có bg-surface-dark không kèm chữ/viền token nền be", () => {
    const viPham: string[] = [];
    for (const tep of tatCaTep) {
      docSrc(tep)
        .split("\n")
        .forEach((dong, i) => {
          if (!dong.includes("bg-surface-dark")) return;
          for (const t of tokenBeTrongDong(dong)) if (!dongTrenNenToiHopLe(dong, t)) viPham.push(`${tep}:${i + 1} ${t}`);
        });
    }
    expect(viPham).toEqual([]);
  });

  it.each(Object.entries(VUNG_NEN_TOI))("%s: chữ màu trong vùng nền tối dùng bản on-dark", (tep, { ham }) => {
    const noiDung = docSrc(tep);
    const vung = ham === null ? noiDung : ham.map((h) => thanHam(noiDung, h)).join("\n");
    const viPham: string[] = [];
    for (const dong of vung.split("\n")) {
      if (dong.trimStart().startsWith("//") || dong.trimStart().startsWith("*")) continue;
      for (const t of tokenBeTrongDong(dong)) {
        // Nhánh sáng của ternary theo prop `dark` (thẻ dùng chung cả hai nền) hợp lệ khi nhánh tối có bản on-dark / on-dark/N.
        const nhanhTheoDark = /\bdark\b|tenNenToi/.test(dong) && (dongTrenNenToiHopLe(dong, t) || /on-dark/.test(dong));
        if (!dongTrenNenToiHopLe(dong, t) && !nhanhTheoDark) viPham.push(`${t}: ${dong.trim()}`);
      }
    }
    expect(viPham).toEqual([]);
  });

  it("link text-primary trên thẻ card/soft dùng text-primary-active", () => {
    const tepTrenCard = [
      "components/shell/dong-nhac-viec.tsx", // chữ 12px trên nền tint warning: text-primary chỉ 3,8–4,1:1
      "components/kenh/channel-card-grid.tsx",
      "components/kenh/channel-inactive-accordion.tsx",
    ];
    const viPham = tepTrenCard.filter((t) => /text-primary(?![\w-])/.test(docSrc(t)));
    expect(viPham).toEqual([]);
  });
});

describe("nút coral chữ trắng", () => {
  it("--primary và --primary-active đều ≥ 4,5:1 với chữ trắng", () => {
    expect(tuongPhan(TRANG, rgb(token("primary")))).toBeGreaterThanOrEqual(4.5);
    expect(tuongPhan(TRANG, rgb(token("primary-active")))).toBeGreaterThanOrEqual(4.5);
  });

  it("hover tối hơn trạng thái thường (không sáng lên làm chữ trắng mờ)", () => {
    expect(doSang(rgb(token("primary-active")))).toBeLessThan(doSang(rgb(token("primary"))));
  });
});

describe("một hệ cảnh báo duy nhất", () => {
  it("không còn màu amber thô trong src (dùng token warning)", () => {
    // Lớp amber thô là hệ thứ hai, lệch token và không theo đợt chỉnh tương phản.
    const goc = join(__dirname, "..", "..", "..", "src");
    const vi_pham: string[] = [];
    for (const tep of readdirSync(goc, { recursive: true, encoding: "utf8" })) {
      if (!/\.(tsx?|css)$/.test(tep)) continue;
      const noiDung = readFileSync(join(goc, tep), "utf8");
      if (/(text|bg|border|ring)-amber-\d+/.test(noiDung)) vi_pham.push(tep);
    }
    expect(vi_pham).toEqual([]);
  });
});
