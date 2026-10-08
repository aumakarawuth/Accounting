// รายงานหน้าที่เปิดและร่างสมุดรายวันให้ครูดูสด (ร่างจริงยังอยู่ในเครื่องนักเรียน การลงบัญชีต้องออนไลน์เสมอ)
export type Page = 'home' | 'journal' | 'ledger' | 'trial-balance' | 'statements' | 'accounts' | 'closing' | 'menu' | 'other';
/** title: ร่างเอกสารขาย/ซื้อ (เช่น "ใบกำกับภาษี / ใบแจ้งหนี้ (ร่าง)") ส่งรายการบัญชีที่เอกสารจะสร้าง · ไม่มี = ร่างสมุดรายวัน */
export type Draft = { title?: string; date: string; description: string; lines: { account_code: string; debit: string; credit: string }[] };

let company: string | null = null;
let page: Page = 'other';
let draft: Draft | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastSent = '';

async function send(force = false) {
  if (!company || (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !force)) return;
  // ร่างสมุดรายวันส่งเฉพาะตอนอยู่หน้าสมุดรายวัน ร่างเอกสาร (มี title) ส่งจากหน้าฟอร์มเอกสาร
  const body = JSON.stringify({ page, ...(page === 'journal' || draft?.title ? { draft } : {}) });
  if (!force && body === lastSent) return;
  lastSent = body;
  await fetch(`/api/companies/${company}/presence`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'same-origin', keepalive: true,
  }).catch(() => {});
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void send(), ms);
}

export function setPage(companyId: string, p: Page) {
  company = companyId;
  if (p !== page) { page = p; schedule(200); }
}

/** เรียกจากฟอร์มสมุดรายวันทุกครั้งที่ร่างเปลี่ยน (หน่วง 1.5 วินาที ไม่ส่งทุกตัวอักษร) */
export function setDraft(d: Draft | null) {
  draft = d;
  schedule(1500);
}

/** สัญญาณมีชีวิตทุก 20 วินาที (ส่งซ้ำแม้ไม่เปลี่ยน) */
export function heartbeat() {
  lastSent = '';
  void send();
}

export async function clearDraft() {
  draft = null;
  lastSent = '';
  if (company) {
    await fetch(`/api/companies/${company}/presence/clear-draft`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  }
}
