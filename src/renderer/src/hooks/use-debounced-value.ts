import { useEffect, useState } from 'react'

/** 输入停顿若干毫秒后才把值传给下游，避免每敲一个字就发起一次查询 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])

  return debounced
}
