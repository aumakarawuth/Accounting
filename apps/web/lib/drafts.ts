// ร่างสมุดรายวันเก็บในเครื่อง (IndexedDB) ให้ปิดแท็บ/แบตหมด/เน็ตหลุดแล้วกลับมาทำต่อได้ (PLAN.md ข้อ 8)
// การลงบัญชียังต้องออนไลน์เสมอ: ร่างไม่ถูกส่งเข้าบัญชีเอง นักเรียนต้องกด "ผ่านรายการ"
// key = companyId (บริษัทหนึ่งมีเจ้าของคนเดียว) · ออกจากระบบ = ล้างร่างทั้งหมด (เครื่องห้องคอมใช้ร่วมกัน)

export type JournalDraft = {
  date: string;
  description: string;
  lines: { code: string; debit: string; credit: string; memo: string }[];
  /** คีย์ idempotency ของร่างนี้: ส่งไปแล้วแต่เน็ตหลุดก่อนได้คำตอบ เปิดมาส่งใหม่ก็ไม่เกิดรายการซ้ำ */
  idemKey: string;
  savedAt: number;
};

const DB = 'accounting';
const STORE = 'drafts';

// เปิดครั้งเดียวแล้วใช้ต่อ: เขียนเร็วขึ้น และทันก่อนปิดหน้ามากกว่าเปิดใหม่ทุกครั้ง
let conn: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  conn ??= new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = db.onversionchange = () => { db.close(); conn = null; };
      resolve(db);
    };
    req.onerror = () => { conn = null; resolve(null); }; // โหมดส่วนตัวบางเบราว์เซอร์ปิด IndexedDB: ทำงานต่อได้แต่ไม่มีร่าง
    req.onblocked = () => { conn = null; resolve(null); };
  });
  return conn;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch {
      conn = null; // การเชื่อมต่อถูกปิดไปแล้ว ครั้งหน้าเปิดใหม่
      resolve(undefined);
    }
  });
}

const key = (companyId: string) => `journal:${companyId}`;

// แจ้งแถบบน (สถานะบันทึก) ว่าร่างเพิ่งเก็บ/ถูกล้าง
type Listener = (savedAt: number | null) => void;
const listeners = new Set<Listener>();
export function onDraftSaved(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (savedAt: number | null) => listeners.forEach((fn) => fn(savedAt));

export async function loadDraft(companyId: string): Promise<JournalDraft | null> {
  return ((await run('readonly', (s) => s.get(key(companyId)))) as JournalDraft | undefined) ?? null;
}

export async function saveDraft(companyId: string, d: Omit<JournalDraft, 'savedAt'>): Promise<void> {
  const value: JournalDraft = { ...d, savedAt: Date.now() };
  await run('readwrite', (s) => s.put(value, key(companyId)));
  emit(value.savedAt);
}

export async function deleteDraft(companyId: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key(companyId)));
  emit(null);
}

export async function clearAllDrafts(): Promise<void> {
  await run('readwrite', (s) => s.clear());
  emit(null);
}

/** ร่างที่มีเนื้อหาจริง (ไม่ใช่ฟอร์มว่าง) */
export const hasContent = (d: Pick<JournalDraft, 'description' | 'lines'>) =>
  d.description.trim() !== '' || d.lines.some((l) => l.code || l.debit || l.credit || l.memo);

// ---- ร่างเอกสารขาย/ซื้อ (เฟส 2.3) ร้านเดียวกับสมุดรายวัน แยกคีย์ตามฟอร์ม เช่น doc:sales:invoice:<บริษัท> ----
// เก็บ state ของฟอร์มทั้งก้อน (รวมคีย์ idempotency) ออกจากระบบแล้วถูกล้างด้วย clearAllDrafts เหมือนกัน
export type DocDraft<T> = { state: T; savedAt: number };
const docKey = (scope: string, companyId: string) => `doc:${scope}:${companyId}`;

export async function loadDocDraft<T>(scope: string, companyId: string): Promise<DocDraft<T> | null> {
  return ((await run('readonly', (s) => s.get(docKey(scope, companyId)))) as DocDraft<T> | undefined) ?? null;
}
export async function saveDocDraft<T>(scope: string, companyId: string, state: T): Promise<void> {
  const value: DocDraft<T> = { state, savedAt: Date.now() };
  await run('readwrite', (s) => s.put(value, docKey(scope, companyId)));
  emit(value.savedAt);
}
export async function deleteDocDraft(scope: string, companyId: string): Promise<void> {
  await run('readwrite', (s) => s.delete(docKey(scope, companyId)));
  emit(null);
}
