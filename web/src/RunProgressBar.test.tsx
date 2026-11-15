import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunProgressBar } from './RunProgressBar'

afterEach(() => vi.useRealTimers())

describe('Run progress bar', () => {
  it('is indeterminate while the run waits for the board, counting the time it has waited', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 14, 9, 0, 7) })
    render(
      <RunProgressBar
        progress={{ done: 0, total: 0, step: 'Fetching the PrizePicks board', percent: 0 }}
        startedAt={new Date(2026, 10, 14, 9, 0, 0).toISOString()}
      />,
    )
    const bar = screen.getByRole('progressbar', { name: /run progress/i })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for PrizePicks · 0:07')).toBeInTheDocument()
    expect(screen.queryByText(/reading the board/i)).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByText('Waiting for PrizePicks · 0:12')).toBeInTheDocument()
  })

  it('is indeterminate before the first progress arrives', () => {
    render(<RunProgressBar progress={null} />)
    expect(screen.getByRole('progressbar', { name: /run progress/i })).not.toHaveAttribute('aria-valuenow')
    expect(screen.getByText(/waiting for prizepicks · 0:00/i)).toBeInTheDocument()
  })

  // Sprint 11 review: a server clock ahead of this one held the clock at 0:00 until it caught up.
  it("counts from when it appeared when the server's start time is still ahead of this clock", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 14, 9, 0, 0) })
    render(<RunProgressBar progress={null} startedAt={new Date(2026, 10, 14, 9, 1, 0).toISOString()} />)
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByText('Waiting for PrizePicks · 0:05')).toBeInTheDocument()
  })

  it('takes up the server start time once the server names the run', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 14, 9, 0, 10) })
    const { rerender } = render(<RunProgressBar progress={null} />)
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByText('Waiting for PrizePicks · 0:02')).toBeInTheDocument()
    rerender(<RunProgressBar progress={null} startedAt={new Date(2026, 10, 14, 9, 0, 0).toISOString()} />)
    expect(screen.getByText('Waiting for PrizePicks · 0:12')).toBeInTheDocument()
  })

  it('holds at 99% until the report arrives', () => {
    render(<RunProgressBar progress={{ done: 10, total: 10, step: 'Pricing lines and building slips', percent: 100 }} />)
    expect(screen.getByText('99%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: /run progress/i })).toHaveAttribute('aria-valuenow', '99')
    expect(screen.getByText('10 of 10 requests to the sportsbooks')).toBeInTheDocument()
  })
})
