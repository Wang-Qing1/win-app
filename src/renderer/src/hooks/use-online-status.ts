import { useEffect, useState } from 'react'

/**
 * 在线状态。
 * 本应用虽是本地优先，但运行环境可能处于断网/弱网（例如笔记本切换网络），
 * 前端需要据此给出明确提示，而不是让用户对着一堆失败请求猜原因。
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  )

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return online
}
