import { cn } from '@/lib/utils';

/**
 * CDC 7.2 : une dérogation (document bloquant manquant ou expiré, permis non conforme) est un mécanisme
 * administratif interne. Elle ne constitue pas une autorisation juridique de circuler et ne modifie ni
 * l'expiration du document ni la règle paramétrée. Mention unique affichée partout où la dérogation est
 * saisie ou restituée (remise, réservation, fiche d'utilisation).
 */
export const OVERRIDE_LEGAL_NOTICE =
  'La dérogation est un mécanisme administratif interne au parc : elle ne constitue pas une autorisation juridique de circuler et ne modifie ni l’expiration du document ni la règle paramétrée.';

export function OverrideLegalNotice({ id, className }: { id?: string; className?: string }) {
  return (
    <p id={id} role="note" className={cn('text-xs font-medium text-warning-foreground', className)}>
      {OVERRIDE_LEGAL_NOTICE}
    </p>
  );
}
