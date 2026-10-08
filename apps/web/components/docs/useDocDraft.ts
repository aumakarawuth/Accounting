'use client';

import { useMemo, useEffect, useRef, useState } from 'react';
import { deleteDocDraft, loadDocDraft, saveDocDraft } from '@/lib/drafts';
import { clearDraft, setDraft, type Draft } from '@/lib/presence';

// ร่างเอกสารในเครื่อง + ส่งร่างให้ครูดูสด สำหรับฟอร์มเอกสารขาย/ซื้อ (กติกาเดียวกับร่างสมุดรายวัน assumptions ข้อ 23)
// - เปิดฟอร์ม: กู้ร่างที่ค้าง (ครั้งเดียว) · แก้: เก็บหลังหยุดพิมพ์ 150ms · ออกจากหน้า/ปิดแท็บ: เก็บทันที · ฟอร์มว่าง: ลบร่าง
// - finish(): เรียกเมื่อบันทึกสำเร็จ ลบร่างและหยุดเก็บ (ไม่ให้การเก็บตอนออกจากหน้าเขียนร่างเก่ากลับมา)
export function useDocDraft<T>(scope: string | null, companyId: string, state: T, opts: {
  /** restore คืน false = ไม่ใช้ร่างนี้ (ไม่แสดงแถบกู้ร่าง) */
  isEmpty: (s: T) => boolean; restore: (s: T) => void | boolean; live?: Draft | null;
}) {
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const loaded = useRef(false);
  const done = useRef(false);
  const pending = useRef<(() => void) | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; });
  const json = JSON.stringify(state);

  useEffect(() => {
    if (!scope) { loaded.current = true; return; }
    let alive = true;
    void loadDocDraft<T>(scope, companyId).then((d) => {
      if (!alive) return;
      if (d && !optsRef.current.isEmpty(d.state) && optsRef.current.restore(d.state) !== false) setRestoredAt(d.savedAt);
      loaded.current = true;
    });
    return () => { alive = false; };
  }, [scope, companyId]);

  useEffect(() => {
    if (!scope || !loaded.current || done.current) return;
    const s = JSON.parse(json) as T;
    const write = () => {
      pending.current = null;
      void (optsRef.current.isEmpty(s) ? deleteDocDraft(scope, companyId) : saveDocDraft(scope, companyId, s));
    };
    pending.current = write;
    const t = setTimeout(write, 150);
    return () => clearTimeout(t);
  }, [scope, companyId, json]);

  useEffect(() => {
    const flush = () => pending.current?.();
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      flush();
      setDraft(null); // ออกจากฟอร์ม: หยุดส่งร่าง (ร่างล่าสุดยังแสดงที่ครูจนบันทึกหรือทิ้ง)
    };
  }, []);

  // ครูดูสด: รายการบัญชีที่ร่างนี้จะสร้าง (หน่วงใน lib/presence)
  const liveJson = JSON.stringify(opts.live ?? null);
  useEffect(() => {
    if (done.current) return;
    const l = JSON.parse(liveJson) as Draft | null;
    if (l) setDraft(l);
  }, [liveJson]);

  const actions = useMemo(() => ({
    discard() {
      setRestoredAt(null);
      if (scope) void deleteDocDraft(scope, companyId);
      void clearDraft();
    },
    finish() {
      done.current = true;
      pending.current = null;
      if (scope) void deleteDocDraft(scope, companyId);
      void clearDraft();
    },
  }), [scope, companyId]);
  return useMemo(() => ({ restoredAt, ...actions }), [restoredAt, actions]);
}
