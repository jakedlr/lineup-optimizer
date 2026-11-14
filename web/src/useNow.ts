import { useEffect, useState } from 'react'

/** The time now, re-read every `intervalMs`, so "12 min ago" or an elapsed clock stays true. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
