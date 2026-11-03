import type { Shown } from './progress'

export function RunProgressBar({ progress }: { progress: Shown | null }) {
  const percent = progress?.percent ?? 0
  return (
    <div className="run-progress">
      <div className="run-progress-head">
        <span>{progress?.step || 'Starting…'}</span>
        <span className="num">{percent}%</span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label="Run progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="bar-fill" style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
      <p className="muted small">
        {progress && progress.total > 0
          ? `${progress.done} of ${progress.total} requests to the sportsbooks`
          : 'Reading the board…'}
      </p>
    </div>
  )
}
