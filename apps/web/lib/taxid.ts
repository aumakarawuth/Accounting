/** หลักตรวจสอบเลขประจำตัวผู้เสียภาษี 13 หลัก (สูตรเดียวกับ app.valid_tax_id และ API) ใช้บอกผู้เรียนก่อนส่ง */
export function validTaxId(s: string) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}

/** รหัสลูกค้า/สินค้า (ตรงกับ check ใน DB) */
export const MASTER_CODE = /^[A-Z0-9][A-Z0-9-]{0,19}$/;
export const MONEY = /^\d{1,16}(\.\d{1,2})?$/;
