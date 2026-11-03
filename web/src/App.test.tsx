import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

function mockHealth(respond: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(respond))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App shell', () => {
  it('names the app', () => {
    mockHealth(() => new Promise(() => {}))
    render(<App />)
    expect(screen.getByRole('heading', { name: /prizepicks ev optimizer/i })).toBeInTheDocument()
  })

  it('reports the engine online when /api/health answers ok', async () => {
    mockHealth(() => Promise.resolve(Response.json({ status: 'ok' })))
    render(<App />)
    expect(await screen.findByText(/engine online/i)).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/health')
  })

  it('reports the engine offline when /api/health fails', async () => {
    mockHealth(() => Promise.reject(new TypeError('network down')))
    render(<App />)
    expect(await screen.findByText(/engine offline/i)).toBeInTheDocument()
  })
})
