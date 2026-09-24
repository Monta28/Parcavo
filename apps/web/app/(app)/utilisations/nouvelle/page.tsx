import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NewCheckout } from './new-checkout';

export const metadata: Metadata = { title: 'Nouvelle remise' };

export default function NewCheckoutPage() {
  return (
    <Suspense fallback={null}>
      <NewCheckout />
    </Suspense>
  );
}
