// แป้นเกษมณี: ตัวที่ได้เมื่อกดปุ่มเดียวกันบนแป้นอังกฤษ (US) ตามลำดับ ทั้งไม่กดและกด Shift
const EN = '`1234567890-=qwertyuiop[]\\asdfghjkl;\'zxcvbnm,./' + '~!@#$%^&*()_+QWERTYUIOP{}|ASDFGHJKL:"ZXCVBNM<>?';
const TH = '_ๅ/-ภถุึคตจขชๆไำพะัีรนยบลฃฟหกดเ้่าสวงผปแอิืทมใฝ' + '%+๑๒๓๔ู฿๕๖๗๘๙๐"ฎฑธํ๊ณฯญฐ,ฅฤฆฏโฌ็๋ษศซ.()ฉฮฺ์?ฒฬฦ';
const enChars = [...EN], thChars = [...TH];
const toThai = new Map(enChars.map((c, i) => [c, thChars[i]!]));
const toEnglish = new Map(thChars.map((c, i) => [c, enChars[i]!]));

/**
 * รหัสเดียวกันที่พิมพ์ตอนแป้นอยู่ผิดภาษา (ไทย ↔ อังกฤษ แป้นเกษมณี) เช่นตั้งไว้ "abc123" แต่แป้นเป็นไทยได้ "ฟิแๅ/-"
 * ใช้ตอนเข้าระบบเท่านั้น: ตรวจกับรหัสเดิมตัวเดิม จึงไม่ได้ทำให้เดารหัสง่ายขึ้น (ทุกตัวแปลงกลับได้ตรงตัว)
 */
export function keyboardLayoutVariants(pw: string): string[] {
  const conv = (m: Map<string, string>) => [...pw].map((c) => m.get(c) ?? c).join('');
  // มีอักษรไทย = แป้นเป็นไทยอยู่ → แปลงเป็นอังกฤษ · ไม่มี = แป้นเป็นอังกฤษ → แปลงเป็นไทย (ตรวจเพิ่มแค่ครั้งเดียว)
  const v = /[\u0e00-\u0e7f]/.test(pw) ? conv(toEnglish) : conv(toThai);
  return v === pw ? [] : [v];
}
