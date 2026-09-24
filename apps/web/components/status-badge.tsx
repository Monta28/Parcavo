import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-muted text-foreground',
  success: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/20 text-warning-foreground border-warning/40',
  danger: 'bg-destructive/10 text-destructive border-destructive/30',
  info: 'bg-primary/10 text-primary border-primary/30',
};

/** Les statuts portent toujours un libellé texte (jamais uniquement une couleur, CDC 10.1). */
export function StatusBadge({ label, tone = 'neutral', className }: { label: string; tone?: Tone; className?: string }) {
  return (
    <Badge variant="outline" className={cn('font-medium', TONES[tone], className)}>
      {label}
    </Badge>
  );
}

export function toneForOperational(status: string | null): Tone {
  switch (status) {
    case 'DISPONIBLE':
      return 'success';
    case 'EN_UTILISATION':
      return 'info';
    case 'IMMOBILISE':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function toneForFreshness(status: string): Tone {
  return status === 'A_JOUR' ? 'success' : status === 'A_ACTUALISER' ? 'warning' : 'neutral';
}

export function toneForPlan(status: string): Tone {
  switch (status) {
    case 'EN_RETARD':
      return 'danger';
    case 'A_FAIRE':
      return 'warning';
    case 'A_PREVOIR':
      return 'info';
    case 'A_JOUR':
      return 'success';
    default:
      return 'neutral';
  }
}
