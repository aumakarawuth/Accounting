import Link from 'next/link';
import { ExerciseEditor } from '@/components/exercises/ExerciseEditor';
import { serverApi } from '@/lib/server-api';
import type { Account } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function NewExercisePage() {
  const accounts = await serverApi<Account[]>('/teacher/coa-template');
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="border-b-2 border-ink pb-2.5">
        <Link href="/teacher/exercises" className="flex min-h-11 items-center text-sm underline">‹ {th.exercises.back}</Link>
        <h1 className="font-doc text-[22px] font-bold sm:text-2xl">{th.exercises.newSet}</h1>
      </div>
      <ExerciseEditor set={null} accounts={accounts} />
    </div>
  );
}
