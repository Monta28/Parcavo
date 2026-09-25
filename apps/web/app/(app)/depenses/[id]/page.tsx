import type { Metadata } from 'next';
import { ExpenseDetail } from './expense-detail';

export const metadata: Metadata = { title: 'Dépense' };

export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExpenseDetail id={id} />;
}
