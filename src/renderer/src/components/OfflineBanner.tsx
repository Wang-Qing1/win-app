import { Alert } from 'antd'
import { useOnlineStatus } from '../hooks/use-online-status'

/**
 * 离线提示。
 * 本应用是本地优先的，断网不影响数据读写，所以用 warning 而不是 error——
 * 避免让用户误以为应用坏了。
 */
export function OfflineBanner() {
  const online = useOnlineStatus()
  if (online) return null

  return (
    <div className="offline-banner">
      <Alert
        type="warning"
        showIcon
        banner
        message="当前设备已离线"
        description="本地数据仍可正常读写；涉及外部资源的操作会在网络恢复后自动重试。"
      />
    </div>
  )
}
