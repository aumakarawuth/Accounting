'use client';

import { Button } from '@/components/Button';

export function RetryButton({ label }: { label: string }) {
  return <Button type="button" onClick={() => window.location.reload()}>{label}</Button>;
}
