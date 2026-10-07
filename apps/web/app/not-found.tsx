import { th } from '@/i18n/th';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="font-doc text-[22px] font-bold">404</h1>
      <p>{th.error.notFound}</p>
    </main>
  );
}
