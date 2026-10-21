// @vitest-environment jsdom
/**
 * DeltaLine so kỳ trước theo % TƯƠNG ĐỐI. Kỳ trước ÂM (lỗ) mà chia thẳng cho số âm sẽ đảo dấu:
 * từ lỗ 1tr lên lãi 0,5tr phải hiện ▲ 150%, không phải ▼.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DeltaLine } from "@/components/kenh/channel-card-metric";

afterEach(cleanup);

function chu(current: number | null, previous: number | null, direction?: "higher-better" | "lower-better") {
  const { container } = render(<DeltaLine current={current} previous={previous} direction={direction} dark={false} />);
  return container.textContent;
}

describe("DeltaLine", () => {
  it("kỳ trước lỗ -1tr, kỳ này lãi +0,5tr → ▲ 150%", () => {
    expect(chu(500_000, -1_000_000)).toBe("▲ 150%");
  });

  it("kỳ trước lỗ -1tr, kỳ này lỗ sâu hơn -2tr → ▼ 100%", () => {
    expect(chu(-2_000_000, -1_000_000)).toBe("▼ 100%");
  });

  it("kỳ trước dương: tăng/giảm đúng chiều", () => {
    expect(chu(1_500_000, 1_000_000)).toBe("▲ 50%");
    expect(chu(500_000, 1_000_000)).toBe("▼ 50%");
  });

  it("kỳ trước 0 hoặc null → Mới; kỳ này null → không hiện gì", () => {
    expect(chu(1, 0)).toBe("Mới");
    expect(chu(1, null)).toBe("Mới");
    expect(chu(null, 5)).toBe("");
  });

  it("chi phí (lower-better) tăng → vẫn ▲ nhưng tô lỗi", () => {
    const { container } = render(<DeltaLine current={200} previous={100} direction="lower-better" dark={false} />);
    expect(container.textContent).toBe("▲ 100%");
    expect(container.querySelector("span")?.className).toContain("text-error");
  });
});
