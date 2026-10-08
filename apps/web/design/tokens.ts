// Design tokens: แหล่งความจริงเดียวของหน้าตา (อนุมัติจาก mockup 2569-10-07)
// tokens.css ต้องตรงกับไฟล์นี้ (มีเทสต์ตรวจ) ดูเหตุผลใน docs/design.md

export const color = {
  ground: '#EEF1EA', // พื้นแอป: กระดาษบัญชีโทนเขียวเทา (ไม่ใช่ครีม)
  paper: '#FAFBF7', // แผ่นเอกสาร/แถบบน/ช่องกรอก
  band: '#E4EAE2', // หัวตาราง แถบข้าง แถบปุ่มลัด
  ink: '#1B2A4A', // ตัวหนังสือหลัก ปุ่มหลัก เส้นรวมยอด
  ink2: '#4B5874', // ข้อความรอง (ผ่าน AA บน paper/ground/band)
  rule: '#B9CBBE', // เส้นตาราง 1px
  ruleStrong: '#9DB5A3', // เส้นขอบแผง/แถบ
  ruleInput: '#789480', // เส้นใต้ช่องกรอก ขอบเอกสาร (≥ 3:1 บน paper)
  ruleFaint: '#D5E0D6', // เส้นบรรทัดสมุดบนพื้นหลังหน้าล็อกอิน
  red: '#B3261E', // เฉพาะ ยอดติดลบ/กลับรายการ/ไม่ดุล/ปากกาครู
  disabled: '#C9D3C8', // พื้นปุ่มที่กดไม่ได้
} as const;

export const font = {
  body: "'IBM Plex Sans Thai Looped', sans-serif",
  doc: "'Noto Serif Thai', serif",
  num: "'IBM Plex Mono', monospace",
} as const;

// น้ำหนักที่ใช้จริง (ฝังเฉพาะเท่านี้)
export const fontWeights = {
  body: [400, 500, 600],
  doc: [600, 700],
  num: [400, 500],
} as const;

export const size = {
  base: 16, // ห้ามต่ำกว่า 16 ในช่องกรอก (กัน iOS ซูม)
  small: 14,
  caption: 13,
  touch: 44, // เป้าสัมผัสขั้นต่ำ
  touchPhone: 52, // ปุ่มหลักบนมือถือ
  radius: 2, // มุมสูงสุด
  rule: 1,
} as const;

export const breakpoint = {
  tablet: 640, // มือถือ < 640
  desktop: 1024, // iPad 640–1024, คอม > 1024
} as const;

export const layout = {
  sidebar: 232,
  sidebarTablet: 220,
  topbar: 52,
  topbarTouch: 56,
} as const;
