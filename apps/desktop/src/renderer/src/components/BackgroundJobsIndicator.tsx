import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { BackgroundJob, RemoteRunnerJob } from '@deepseek-ide/shared';
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

  // ── 远端任务 ──────────────────────────────────────────────────────────────
  const [remoteJobs, setRemoteJobs] = useState<RemoteRunnerJob[]>([]);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [unattended, setUnattended] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.ide
      ?.listRemoteAgents?.()
      .then((list) => {
        if (alive) setRemoteJobs(list);
      })
      .catch(() => undefined);
    const off = window.ide?.onRemoteAgentChanged?.((job) =>
      setRemoteJobs((prev) => {
        const index = prev.findIndex((j) => j.jobId === job.jobId);
        if (index < 0) return [job, ...prev];
        const next = prev.slice();
        next[index] = job;
        return next;
      }),
    );
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  /**
   * 轮询刷新未结束的远端任务。
   *
   * 远端状态变不了推给我们（那边没有长连接），所以只能定时去问。
   * 只在**浮层开着**且有未结束任务时问，避免为了一个看不见的列表一直打 SSH。
   */
  useEffect(() => {
    if (!open) return;
    const pending = remoteJobs.filter((j) => j.status === 'starting' || j.status === 'running');
    if (pending.length === 0) return;
    let alive = true;
    const timer = setInterval(() => {
      for (const job of pending) {
        void window.ide
          ?.refreshRemoteAgent?.(job.jobId)
          .then((next) => {
            if (!alive || !next) return;
            setRemoteJobs((prev) => prev.map((j) => (j.jobId === next.jobId ? next : j)));
          })
          .catch(() => undefined);
      }
    }, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, remoteJobs]);

  async function submitRemote(): Promise<void> {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setRemoteError(null);
    try {
      const job = await window.ide.submitRemoteAgent({ prompt: text, unattended });
      setRemoteJobs((prev) => [job, ...prev.filter((j) => j.jobId !== job.jobId)]);
      setPrompt('');
      setRemoteOpen(false);
    } catch (err) {
      // 失败必须留在界面上：远端任务最容易失败的地方（没装 node、没连 SSH、
      // 远端目录不存在）都只在这一刻能知道原因
      setRemoteError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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
          <div className="status-jobs-section">
            <div className="status-jobs-section-head">
              <span>{t('status.remoteJobs')}</span>
              <button
                type="button"
                className="status-jobs-clear"
                onClick={() => {
                  setRemoteOpen((v) => !v);
                  setRemoteError(null);
                }}
              >
                {t('status.remoteNew')}
              </button>
            </div>
            <div className="status-jobs-hint">{t('status.remoteHint')}</div>
            {remoteOpen && (
              <div className="status-remote-form">
                <textarea
                  className="status-remote-input"
                  value={prompt}
                  placeholder={t('status.remotePromptPlaceholder')}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={3}
                />
                <label className="status-remote-check">
                  <input
                    type="checkbox"
                    checked={unattended}
                    onChange={(e) => setUnattended(e.target.checked)}
                  />
                  <span>{t('status.remoteUnattended')}</span>
                </label>
                <div className="status-jobs-hint">{t('status.remoteUnattendedHint')}</div>
                <div className="status-jobs-hint warn">{t('status.remoteCredential')}</div>
                {remoteError && <div className="status-remote-error">{remoteError}</div>}
                <button
                  type="button"
                  className="status-goto-btn"
                  disabled={busy || !prompt.trim()}
                  onClick={() => void submitRemote()}
                >
                  {busy ? t('status.remoteSubmitting') : t('status.remoteSubmit')}
                </button>
              </div>
            )}
            {remoteJobs.length === 0 && !remoteOpen ? (
              <div className="status-jobs-empty">{t('status.remoteEmpty')}</div>
            ) : (
              remoteJobs.slice(0, 8).map((job) => (
                <div key={job.jobId} className="status-job-row">
                  <button
                    type="button"
                    className="status-job-main"
                    title={`${job.workspace}\n${job.summary ?? job.error ?? ''}`}
                    onClick={() => void window.ide.refreshRemoteAgent(job.jobId)}
                  >
                    <span className={`status-job-dot ${job.status}`} />
                    <span className="status-job-title">{job.title}</span>
                    <span className="status-job-time">{relativeTime(job.startedAt)}</span>
                  </button>
                  {job.status === 'starting' || job.status === 'running' ? (
                    <button
                      type="button"
                      className="status-job-action"
                      onClick={() => void window.ide.cancelRemoteAgent(job.jobId)}
                    >
                      {t('status.jobCancel')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="status-job-action"
                      onClick={() => void window.ide.removeRemoteAgent(job.jobId)}
                    >
                      {t('status.remoteRemove')}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

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
