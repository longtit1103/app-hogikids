"use client";

/** Ba nút gọi server action chỉ-test cho `tests/e2e/cong-ghi-prod.spec.ts` (chỉ có trong bản build e2e). */
import { useState } from "react";

import { ghiGiuBarrierE2e, ghiNgayE2e, ghiNgoaiCuaE2e, type KetQuaGhiE2e } from "./actions.e2e";

const baoLoi = (e: unknown): KetQuaGhiE2e => ({ ok: false, error: `ném: ${e instanceof Error ? e.message : String(e)}` });

export function NutE2eCongGhi() {
  const [giu, setGiu] = useState<KetQuaGhiE2e | null>(null);
  const [ngay, setNgay] = useState<KetQuaGhiE2e | null>(null);
  const [ngoaiCua, setNgoaiCua] = useState<KetQuaGhiE2e | null>(null);
  return (
    <div>
      <button data-testid="ghi-giu" onClick={() => void ghiGiuBarrierE2e().then(setGiu, (e) => setGiu(baoLoi(e)))}>
        ghi giữ barrier
      </button>
      <pre data-testid="kq-giu">{giu ? JSON.stringify(giu) : ""}</pre>
      <button data-testid="ghi-ngay" onClick={() => void ghiNgayE2e().then(setNgay, (e) => setNgay(baoLoi(e)))}>
        ghi ngay
      </button>
      <pre data-testid="kq-ngay">{ngay ? JSON.stringify(ngay) : ""}</pre>
      <button
        data-testid="ghi-ngoai-cua"
        onClick={() => void ghiNgoaiCuaE2e().then(setNgoaiCua, (e) => setNgoaiCua(baoLoi(e)))}
      >
        ghi ngoài cửa
      </button>
      <pre data-testid="kq-ngoai-cua">{ngoaiCua ? JSON.stringify(ngoaiCua) : ""}</pre>
    </div>
  );
}
