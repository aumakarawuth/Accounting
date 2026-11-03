import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser } from '../guard.js';
import { HttpError } from '../errors.js';
import { CompanyParams, WorksheetQuery } from '../schemas.js';

// กระดาษทำการ ณ สิ้นเดือน (ยอดสะสมเหมือนงบทดลอง) แบบ 6 / 8 / 10 ช่องตามที่โรงเรียนเปิดใช้
// 10 ช่อง: งบทดลอง · ปรับปรุง · งบทดลองหลังปรับปรุง · กำไรขาดทุน · ฐานะการเงิน
// 8 ช่อง: ไม่มีงบทดลองหลังปรับปรุง · 6 ช่อง: ไม่มีปรับปรุง งบทดลองใช้ยอดหลังปรับปรุง
// เงินคิดเป็นสตางค์ (BigInt) ไม่ใช้ทศนิยมของ JS

type Pair = { debit: string; credit: string };
const money = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};
const side = (net: bigint): Pair => ({ debit: money(net > 0n ? net : 0n), credit: money(net < 0n ? -net : 0n) });
const ZERO = { d: 0n, c: 0n };

export function worksheetRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);

  app.get('/companies/:companyId/worksheet', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const q = WorksheetQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const fr = await c.query(
        `select s.worksheet_formats::int[] as formats from acc.companies co join acc.schools s on s.id = co.school_id where co.id = $1`, [companyId]);
      const formats: number[] = fr.rows[0]?.formats ?? [];
      if (formats.length === 0) return { month: q.month, formats, format: null };
      const format = q.format ? Number(q.format) : formats[formats.length - 1]!;
      if (!formats.includes(format)) throw new HttpError(403, 'disabled', `โรงเรียนยังไม่เปิดใช้กระดาษทำการแบบ ${format} ช่อง`);

      const r = await c.query(
        `select code, name, type, (unadjusted * 100)::bigint::text as u, (adj_debit * 100)::bigint::text as ad, (adj_credit * 100)::bigint::text as ac
           from acc.worksheet($1, $2)`, [companyId, `${q.month}-01`]);
      const sum = { tb: { ...ZERO }, adj: { ...ZERO }, atb: { ...ZERO }, is: { ...ZERO }, bs: { ...ZERO } };
      const add = (k: keyof typeof sum, net: bigint) => { if (net > 0n) sum[k].d += net; else sum[k].c -= net; };
      const rows = r.rows.flatMap((x) => {
        const u = BigInt(x.u), ad = BigInt(x.ad), ac = BigInt(x.ac);
        const adjusted = u + ad - ac;
        const tbNet = format === 6 ? adjusted : u;
        if (tbNet === 0n && ad === 0n && ac === 0n && adjusted === 0n) return [];
        const pl = x.type === 'revenue' || x.type === 'expense';
        add('tb', tbNet);
        sum.adj.d += ad; sum.adj.c += ac;
        add('atb', adjusted);
        add(pl ? 'is' : 'bs', adjusted);
        return [{
          code: x.code as string, name: x.name as string, type: x.type as string,
          tb: side(tbNet), adj: { debit: money(ad), credit: money(ac) }, atb: side(adjusted),
          is: pl ? side(adjusted) : null, bs: pl ? null : side(adjusted),
        }];
      });
      // กำไรสุทธิ = เครดิตงบกำไรขาดทุน − เดบิต (ใส่ฝั่งที่น้อยกว่าของงบกำไรขาดทุน และฝั่งตรงข้ามของงบฐานะการเงิน)
      const net = sum.is.c - sum.is.d;
      const pair = (k: keyof typeof sum) => ({ debit: money(sum[k].d), credit: money(sum[k].c) });
      return {
        month: q.month, formats, format, rows,
        totals: { tb: pair('tb'), adj: pair('adj'), atb: pair('atb'), is: pair('is'), bs: pair('bs') },
        netIncome: money(net),
        result: {
          is: { debit: money(net > 0n ? net : 0n), credit: money(net < 0n ? -net : 0n) },
          bs: { debit: money(net < 0n ? -net : 0n), credit: money(net > 0n ? net : 0n) },
        },
        grand: {
          is: { debit: money(sum.is.d + (net > 0n ? net : 0n)), credit: money(sum.is.c + (net < 0n ? -net : 0n)) },
          bs: { debit: money(sum.bs.d + (net < 0n ? -net : 0n)), credit: money(sum.bs.c + (net > 0n ? net : 0n)) },
        },
      };
    });
  });
}
