import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { BackgroundJob } from '@deepseek-ide/shared';
import { useI18n } from '../i18n';

/**
 * 状态栏上的后台任务指示器。
 *
 * 它回答的是两个问题：**现在有没有任务在跑**、**刚才那些任务跑完没有**。
 * 数据全部来自主进程（`backgroundJobs:list` + `backgroundJobs:changed` 推送），
 * 组件自己不保存任何一份「真相」—— 否则窗口重开后与主进程的记录就会不一致。
 *
 * 关于「云端」：这里的任务**不在云端**跑，是本机主进程托管的。名字沿用 Cursor 的
 * 说法只是为了对齐概念，浮层里也写了这一句，免得用户以为关掉应用它会自己跑完。
 */
export function BackgroundJobsIndicator() {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void window.ide
      .listBackgroundJobs()
      .then((list) => {
        if (alive) setJobs(list);
      })
      .catch(() => undefined);
    const off = window.ide.onBackgroundJobsChanged((list) => setJobs(list));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const running = jobs.filter((job) => job.status === 'running').length;
  const hasFinished = jobs.some((job) => job.status !== 'running');

  const relativeTime = (ts: number): string => {
    const diff = Date.now() - ts;
    if (diff < 60_000) return t('status.jobsJustNow');
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return t('status.jobsMinutesAgo', { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('status.jobsHoursAgo', { n: hours });
    return t('status.jobsDaysAgo', { n: Math.floor(hours / 24) });
  };

  const cancel = (e: ReactMouseEvent, id: string) => {
    e.stopPropagation();
    void window.ide.cancelAgent(id);
  };

  return (
    <div className="status-popover-anchor" ref={anchorRef}>
      <button
        type="button"
        className={`status-item status-jobs-btn${running > 0 ? ' is-running' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={t('status.jobs')}
      >
        <span style={{ color: running > 0 ? '#38bdf8' : 'var(--text-muted)' }}>🗂</span>
        <span>{t('status.jobs')}</span>
        {running > 0 && <span className="status-sync-pill ahead">{running}</span>}
      </button>
      {open && (
        <div className="status-popover" style={{ minWidth: 320, maxWidth: 400 }}>
          <div className="status-popover-header">
            <span>{t('status.jobs')}</span>
            {hasFinished && (
              <button
                type="button"
                className="status-jobs-clear"
                onClick={() => void window.ide.clearBackgroundJobs()}
              >
                {t('status.jobsClear')}
              </button>
            )}
          </div>
          <div className="status-jobs-hint">{t('status.jobsHint')}</div>
          {jobs.length === 0 ? (
            <div className="status-jobs-empty">{t('status.jobsEmpty')}</div>
          ) : (
            jobs.slice(0, 12).map((job) => (
              <div key={job.id} className="status-job-row">
                <button
                  type="button"
                  className="status-job-main"
                  onClick={() => void window.ide.openBackgroundJob(job.id)}
                  title={job.summary || job.error || job.title}
                >
                  <span className={`status-job-dot ${job.status}`} />
                  <span className="status-job-title">{job.title}</span>
                  <span className="status-job-time">{relativeTime(job.startedAt)}</span>
                </button>
                {job.status === 'running' ? (
                  <button
                    type="button"
                    className="status-job-action"
                    onClick={(e) => cancel(e, job.id)}
                  >
                    {t('status.jobCancel')}
                  </button>
                ) : (
                  <span className={`status-job-state ${job.status}`}>
                    {t(`status.job.${job.status}`)}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
