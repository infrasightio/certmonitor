/**
 * The unacknowledged alert counts, in one place.
 *
 * These used to be fetched twice, independently: the nav badge kept its own
 * copy on a 60-second interval in AppLayout, and the alerts page kept another
 * for its header. Acknowledging refreshed the page's copy and had no way to
 * reach the layout's, so the sidebar went on showing the old number for up to
 * a minute after the alerts had visibly gone - which reads as the
 * acknowledgement not having worked.
 *
 * One source, shared: whoever changes the alerts calls `refresh()` and every
 * reader updates together. The poll stays as a safety net for alerts raised
 * elsewhere, not as the way the UI catches up with itself.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import { alertsApi } from '../lib/api'
import { useAuth } from './useAuth'

const EMPTY = { total: 0 }
const POLL_MS = 60_000

const AlertCountContext = createContext(null)

export function AlertCountProvider({ children }) {
  const { isAuthenticated, user, can } = useAuth()
  const [counts, setCounts] = useState(EMPTY)
  // So a reader can tell "no alerts" from "not asked yet". Without it a
  // header renders a confident "0 unacknowledged" before the first response.
  const [loaded, setLoaded] = useState(false)

  // Every role currently holds alert:read, but a role that did not would
  // otherwise get a 403 every minute for a badge it cannot see.
  const allowed = isAuthenticated && can('alert:read')

  const refresh = useCallback(() => {
    if (!allowed) {
      setCounts(EMPTY)
      return Promise.resolve()
    }
    return alertsApi
      .unacknowledgedCount()
      .then((data) => {
        setCounts(data || EMPTY)
        setLoaded(true)
      })
      .catch(() => {
        // Leave the last known figure. A wrong badge is better than a badge
        // that drops to zero because one request failed.
      })
  }, [allowed])

  useEffect(() => {
    refresh()
    if (!allowed) return undefined
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh, allowed, user?.id])

  const value = useMemo(
    () => ({ counts, total: counts.total || 0, loaded, refresh }),
    [counts, loaded, refresh],
  )
  return (
    <AlertCountContext.Provider value={value}>{children}</AlertCountContext.Provider>
  )
}

export function useAlertCount() {
  return (
    useContext(AlertCountContext) ?? {
      counts: EMPTY,
      total: 0,
      loaded: false,
      refresh: () => Promise.resolve(),
    }
  )
}
