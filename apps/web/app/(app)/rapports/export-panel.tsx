'use client';

import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileText, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import { fetchFile } from '@/lib/report-export';
import { formatDecimalText } from '@/lib/report-format';
import { EXPORT_FORMAT_LABELS, EXPORT_JOB_FINAL_STATUSES, EXPORT_JOB_STATUS_LABELS, type ExportFormat, type ExportJobStatus, type ExportJobView } from '@/lib/reports-types';

interface TrackedJob {
  jobId: string;
  format: ExportFormat;
  rowCount: number;
  reportLabel: string;
}

const FORMATS: readonly ExportFormat[] = ['csv', 'xlsx'];

function errorMessage(error: unknown): string {
  return isApiError(error) ? error.message : 'L’export a échoué.';
}

/**
 * Exports CSV et XLSX du rapport affiché (CDC 11.2 ; D-270, D-272, D-273) : mêmes filtres que l'écran,
 * envoyés à GET /reports/:code/export. Réponse 200 : fichier enregistré tel que l'API le produit ;
 * réponse 202 : export différé suivi par GET /reports/exports/:jobId (progression), puis téléchargement
 * par GET /reports/exports/:jobId/download (droits revérifiés par l'API).
 */
export function ExportPanel({
  code,
  reportLabel,
  params,
  syncMaxRows,
  maxRows,
  timezone,
}: {
  code: string;
  reportLabel: string;
  params: Record<string, string>;
  syncMaxRows: number;
  maxRows: number;
  timezone: string;
}) {
  const [pending, setPending] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<TrackedJob[]>([]);

  async function start(format: ExportFormat) {
    setPending(format);
    setError(null);
    try {
      const outcome = await fetchFile(`/api/v1/reports/${encodeURIComponent(code)}/export${toQuery({ ...params, format })}`, `rapport-${code}.${format}`);
      if (outcome.kind === 'file') {
        toast.success(`Export téléchargé : ${outcome.fileName}`);
      } else {
        setJobs((list) => [{ jobId: outcome.jobId, format, rowCount: outcome.rowCount, reportLabel }, ...list.filter((j) => j.jobId !== outcome.jobId)]);
        toast.info(`Export de ${formatDecimalText(outcome.rowCount)} lignes mis en préparation.`);
      }
    } catch (e) {
      setError(e);
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="rapport-export" className="no-print space-y-3 rounded-md border p-4 text-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 id="rapport-export" className="text-base font-semibold">
            Export
          </h2>
          <p className="max-w-2xl text-muted-foreground">
            Mêmes lignes et mêmes filtres que l’écran, limités aux sociétés où vous détenez la permission d’export ; le fichier reprend les filtres, les unités, le fuseau et la date de génération.
            Au-delà de {formatDecimalText(syncMaxRows)} lignes, l’export est préparé en différé (plafond : {formatDecimalText(maxRows)} lignes).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FORMATS.map((format) => (
            <Button key={format} type="button" variant="outline" disabled={pending !== null} onClick={() => void start(format)}>
              {format === 'csv' ? <FileText className="size-4" aria-hidden="true" /> : <FileSpreadsheet className="size-4" aria-hidden="true" />}
              {pending === format ? 'Préparation…' : `Exporter ${EXPORT_FORMAT_LABELS[format]}`}
            </Button>
          ))}
        </div>
      </div>
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
          {errorMessage(error)}
          {isApiError(error) && error.requestId ? <span className="block text-xs text-muted-foreground">Référence : {error.requestId}</span> : null}
        </p>
      ) : null}
      {jobs.length > 0 ? (
        <ul className="space-y-2" aria-label="Exports différés">
          {jobs.map((job) => (
            <ExportJobItem key={job.jobId} job={job} timezone={timezone} onDismiss={() => setJobs((list) => list.filter((j) => j.jobId !== job.jobId))} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function toneFor(status: ExportJobStatus): 'neutral' | 'success' | 'danger' | 'info' {
  switch (status) {
    case 'TERMINE':
      return 'success';
    case 'ECHEC':
    case 'ABANDONNE':
      return 'danger';
    case 'EN_COURS':
      return 'info';
    default:
      return 'neutral';
  }
}

/** Suivi d'un export différé : statut et progression relus toutes les deux secondes jusqu'à un statut final. */
function ExportJobItem({ job, timezone, onDismiss }: { job: TrackedJob; timezone: string; onDismiss: () => void }) {
  const status = useQuery({
    queryKey: ['report-export', job.jobId],
    queryFn: () => api<ExportJobView>(`/reports/exports/${job.jobId}`),
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;
      const current = query.state.data?.status;
      return current && EXPORT_JOB_FINAL_STATUSES.includes(current) ? false : 2000;
    },
  });
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const data = status.data;

  async function download(path: string, fileName: string) {
    setDownloading(true);
    setDownloadError(null);
    try {
      await fetchFile(path, fileName);
      toast.success(`Export téléchargé : ${fileName}`);
    } catch (e) {
      setDownloadError(e);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-medium">{job.reportLabel}</span> · {EXPORT_FORMAT_LABELS[job.format]} · {formatDecimalText(data?.rowCount ?? job.rowCount)} lignes
        </p>
        <div className="flex items-center gap-2">
          {data ? <StatusBadge label={EXPORT_JOB_STATUS_LABELS[data.status] ?? data.status} tone={toneFor(data.status)} /> : null}
          <Button type="button" variant="ghost" size="icon" onClick={onDismiss} aria-label="Retirer ce suivi de la liste" title="Retirer ce suivi de la liste">
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {status.isError ? (
        <p role="alert" className="text-destructive">
          {errorMessage(status.error)}
        </p>
      ) : !data ? (
        <p role="status" className="text-muted-foreground">
          Lecture du statut…
        </p>
      ) : data.status === 'TERMINE' && data.downloadPath ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" disabled={downloading} onClick={() => void download(data.downloadPath as string, data.fileName ?? `rapport-${data.reportCode}.${data.format}`)}>
            <Download className="size-4" aria-hidden="true" />
            {downloading ? 'Téléchargement…' : `Télécharger ${data.fileName ?? 'le fichier'}`}
          </Button>
          {data.expiresAt ? <span className="text-muted-foreground">Disponible jusqu’au {formatDateTime(data.expiresAt, timezone)}.</span> : null}
        </div>
      ) : data.status === 'ECHEC' || data.status === 'ABANDONNE' ? (
        <p role="alert" className="text-destructive">
          {data.error ?? 'L’export n’a pas pu être généré.'} Relancez l’export si besoin.
        </p>
      ) : (
        <div className="space-y-1" role="status" aria-live="polite">
          <Progress value={data.progress} aria-label="Progression de l’export" />
          <p className="text-muted-foreground">
            {EXPORT_JOB_STATUS_LABELS[data.status]} · {data.progress} %
          </p>
        </div>
      )}
      {downloadError ? (
        <p role="alert" className="text-destructive">
          {errorMessage(downloadError)}
        </p>
      ) : null}
    </li>
  );
}
