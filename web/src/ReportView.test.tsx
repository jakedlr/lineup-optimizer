import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Report } from './api'
import { ReportView } from './ReportView'
import { leg, report } from './test/fixtures'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

function view(r: Report = report, extra: Partial<Parameters<typeof ReportView>[0]> = {}) {
  return render(
    <ReportView report={r} label="Run · 09:53" at={minutesAgo(0)} top={25} slipType="all" slipSize="all" onFilter={() => {}} {...extra} />,
  )
}

const legsRegion = () => screen.getByRole('region', { name: /top legs/i })

describe('Best Slips money', () => {
  it('sets EVs with thousands separators, and never a red signed zero', () => {
    const slips = [
      { ...report.slips[0], ev: 1234.5 },
      { ...report.slips[1], ev: -0.004 },
    ]
    view({ ...report, slips })
    const region = screen.getByRole('region', { name: /best slips/i })
    expect(within(region).getByText('+$1,234.50')).toHaveClass('pos')
    const zero = within(region).getByText('$0.00')
    expect(zero).not.toHaveClass('neg')
    expect(zero).not.toHaveClass('pos')
  })

  it('drops the "one leg per game" helper', () => {
    view()
    expect(screen.queryByText(/one leg per game/i)).not.toBeInTheDocument()
  })
})

describe('Report head', () => {
  it('says "worst-case devig" and leaves out "cash" when there is no promotion', () => {
    view({ ...report, settings: { ...report.settings, devig: 'worst', mode: 'cash', stake: 1000 } })
    const head = screen.getByText(/worst-case devig/)
    expect(head).toHaveTextContent('$1,000 stake · worst-case devig · NFL, NBA, NHL, MLB · next 24 h')
    expect(head).not.toHaveTextContent(/cash/)
  })

  it('names a promotion and any other devig method', () => {
    view({ ...report, settings: { ...report.settings, devig: 'shin', mode: 'bonus' } })
    expect(screen.getByText(/bonus · shin devig/)).toBeInTheDocument()
  })

  it('shows how old the run is, flagged once it is stale', () => {
    const { unmount } = view(report, { at: minutesAgo(12) })
    expect(screen.getByText('12 min ago')).not.toHaveClass('warn')
    unmount()
    view(report, { at: minutesAgo(45) })
    expect(screen.getByText('45 min ago')).toHaveClass('warn')
  })

  it('is dimmed and marked busy while it is no longer the latest word', () => {
    const { container } = view(report, { stale: true, busy: true })
    const root = container.querySelector('.report')!
    expect(root).toHaveAttribute('data-stale')
    expect(root).toHaveAttribute('aria-busy', 'true')
  })

  it('marks the report shown on opening, which arrives without a fade', () => {
    const { container, rerender } = view(report, { opened: true })
    expect(container.querySelector('.report')).toHaveAttribute('data-opened')
    rerender(<ReportView report={report} label="Run · 09:53" at={minutesAgo(0)} top={25} slipType="all" slipSize="all" onFilter={() => {}} />)
    expect(container.querySelector('.report')).not.toHaveAttribute('data-opened')
  })
})

describe('Top Legs', () => {
  const below = leg({ player: 'Rome Odunze', game: 'NFL:CHI-NE', prob: 0.55, edge: -0.024, books: { fanduel: 0.55 } })
  const withBelow: Report = { ...report, legs: [...report.legs, below] }

  it('leads with Edge, then Prob', () => {
    view()
    const headers = within(legsRegion()).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers.slice(0, 2)).toEqual(['Edge', 'Prob'])
  })

  it('says how many legs clear the reference break-even', () => {
    view(withBelow)
    expect(within(legsRegion()).getByText('2 of 3 legs clear the Power 2 break-even (57.4%)')).toBeInTheDocument()
  })

  it('divides the legs above the break-even from those below it', () => {
    view(withBelow)
    const rows = within(legsRegion()).getAllByRole('row')
    expect(rows).toHaveLength(5) // header, 2 above, the divider, 1 below
    expect(rows[3]).toHaveTextContent('Below the Power 2 break-even, 57.4% per leg')
    expect(rows[4]).toHaveTextContent('Rome Odunze')
  })

  // Sprint 11 review: the count and the divider read the raw edge, the edge cell its rounding.
  it('counts a leg whose edge rounds to 0.0% as clearing, above the divider, as its figure says', () => {
    const even = leg({ player: 'Even Steven', game: 'NFL:DAL-NYG', prob: 0.5735, edge: -0.0004, books: { fanduel: 0.57 } })
    view({ ...report, legs: [...report.legs, even, below] })
    expect(within(legsRegion()).getByText('3 of 4 legs clear the Power 2 break-even (57.4%)')).toBeInTheDocument()
    const rows = within(legsRegion()).getAllByRole('row')
    expect(rows[3]).toHaveTextContent('Even Steven')
    expect(within(rows[3]).getByText('0.0%')).not.toHaveClass('muted')
    expect(rows[4]).toHaveTextContent(/^Below the/)
  })

  it('puts a leg with no edge below the divider, uncounted, with a dash for its edge', () => {
    const unknown = leg({ player: 'No Edge', game: 'NFL:DAL-NYG', prob: 0.6, edge: undefined, books: { fanduel: 0.6 } })
    view({ ...report, legs: [...report.legs, unknown] })
    expect(within(legsRegion()).getByText('2 of 3 legs clear the Power 2 break-even (57.4%)')).toBeInTheDocument()
    const rows = within(legsRegion()).getAllByRole('row')
    expect(rows[3]).toHaveTextContent(/^Below the/)
    expect(rows[4]).toHaveTextContent('No Edge')
    expect(rows[4].querySelector('.c-edge')).toHaveTextContent(/^—$/)
  })

  it('has no divider when every leg clears', () => {
    view()
    expect(within(legsRegion()).queryByText(/^below the/i)).not.toBeInTheDocument()
  })

  it('sets a negative edge in grey with its minus, not red', () => {
    view(withBelow)
    const edge = within(legsRegion()).getByText('−2.4%')
    expect(edge).not.toHaveClass('neg')
    expect(edge).toHaveClass('muted')
    expect(within(legsRegion()).getByText('+5.0%')).toHaveClass('pos')
  })

  it('gives each book its own figure in a fixed order, a dash where it has no price', () => {
    view(withBelow)
    const rows = within(legsRegion()).getAllByRole('row')
    const books = (row: HTMLElement) => [...row.querySelectorAll('.c-books .book')].map((b) => b.textContent)
    expect(books(rows[0])).toEqual(['DK', 'FD'])
    expect(books(rows[1])).toEqual(['62.0', '62.6'])
    expect(books(rows[2])).toEqual(['58.1', '–'])
    expect(books(rows[4])).toEqual(['–', '55.0'])
  })

  it('states book disagreement in %', () => {
    view({ ...report, legs: [leg({ edge: 0.05, disagreement: 0.031 })] })
    expect(within(legsRegion()).getAllByText(/books differ 3\.1%/).length).toBeGreaterThan(0)
  })

  it('says so when no leg was priced, with no empty table', () => {
    view({ ...report, legs: [], slips: [] })
    expect(within(legsRegion()).getByText('No legs priced in this window.')).toBeInTheDocument()
    expect(within(legsRegion()).queryByRole('table')).not.toBeInTheDocument()
    expect(within(legsRegion()).queryByText(/0 of 0/)).not.toBeInTheDocument()
  })

  it('carries sport and matchup under the player, and one meta line for a phone card', () => {
    view({ ...report, legs: [leg({ edge: 0.05, same_game: true, books: { draftkings: 0.691 } })] })
    const row = within(legsRegion()).getAllByRole('row')[1]
    expect(row.querySelector('.c-player .sub')).toHaveTextContent('NFL · CHI vs NE')
    expect(row.querySelector('.c-meta')).toHaveTextContent('NFL · CHI vs NE · DK 69.1 · same game')
  })
})
