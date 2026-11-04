// โครงรายงานกลาง: สร้างครั้งเดียว แล้วเขียนเป็น PDF (pdf.ts) หรือ .xlsx (xlsx.ts) ตัวเลขชุดเดียวกัน
// เงินในเซลล์เป็นสตริงทศนิยมจาก API ("-1250.00") ไม่แปลงเป็น number ตลอดทาง

export type Align = 'left' | 'right' | 'center';

export type Column = {
  label: string;
  /** ความกว้างเป็นจำนวนตัวอักษรโดยประมาณ (xlsx ใช้ตรง ๆ PDF ใช้เป็นสัดส่วน) */
  width: number;
  align?: Align;
  kind?: 'text' | 'money' | 'number' | 'mono';
};

export type CellValue = string | null;

export type Row = {
  cells: CellValue[];
  /** total = เส้นบน + เส้นคู่ใต้ยอด · subtotal = ตัวหนา เส้นบนบาง · heading = หัวข้อในตาราง */
  style?: 'total' | 'subtotal' | 'heading';
  /** เยื้องคอลัมน์ข้อความแรก (เช่น บรรทัดเครดิต) เป็นระดับ */
  indent?: number;
};

export type Section = {
  heading?: string;
  /** หัวตารางชั้นบน (เช่น กระดาษทำการ: งบทดลอง | ปรับปรุง ...) span = จำนวนคอลัมน์ */
  groups?: { label: string; span: number }[];
  columns: Column[];
  rows: Row[];
  note?: string;
};

export type Report = {
  /** ชื่อไฟล์ไม่รวมนามสกุล (ไทยได้) */
  fileName: string;
  sheetName: string;
  company: string;
  title: string;
  subtitle: string;
  orientation: 'portrait' | 'landscape';
  sections: Section[];
  notes: string[];
  printedAt: string;
};
