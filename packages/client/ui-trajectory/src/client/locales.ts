/** `trajectory` namespace dictionaries (view tab label + toolbar strings). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'trajectory'

/** The trajectory dictionary key set (the source of truth for both locales). */
export type TrajectoryKey =
  | `memory.${'title' | 'first' | 'reused' | 'updated' | 'skipped' | 'disabled' | 'session-denied' | 'no-generation' | 'incompatible-generation' | 'budget-too-small' | 'assembly-excluded' | 'unrecorded' | 'legacy-crop' | 'generation' | 'bytes' | 'retained' | 'omitted' | 'header' | 'missing-header' | 'reason'}`
  | 'view.trajectory'
  | 'toolbar.aria'
  | 'toolbar.duration'
  | 'toolbar.useActualDuration'
  | 'toolbar.useEqualWidth'
  | 'toolbar.actualTime'
  | 'toolbar.turns'
  | 'toolbar.expandTurns'
  | 'toolbar.collapseTurns'
  | 'toolbar.calls'
  | 'toolbar.expandCalls'
  | 'toolbar.collapseCalls'
  | 'toolbar.search'
  | 'toolbar.searchPlaceholder'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The trajectory view tab label and toolbar strings. */
    'trajectory': TrajectoryKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<TrajectoryKey, string> = {
  'memory.title': '长期记忆上下文',
  'memory.first': '首次注入',
  'memory.reused': '沿用',
  'memory.updated': '更新',
  'memory.skipped': '未注入',
  'memory.disabled': '功能关闭',
  'memory.session-denied': '会话禁止读取',
  'memory.no-generation': '尚无正式记忆',
  'memory.incompatible-generation': '记忆版本需要重建',
  'memory.budget-too-small': '预算不足以容纳摘要',
  'memory.assembly-excluded': '最终提示词未包含该摘要',
  'memory.unrecorded': '未记录',
  'memory.legacy-crop': '裁剪情况：旧日志未记录',
  'memory.generation': '版本',
  'memory.bytes': '摘要字节',
  'memory.retained': '保留条目',
  'memory.omitted': '省略条目',
  'memory.header': '请求 header',
  'memory.missing-header': '关联的请求 header 不在当前事件窗口中，请加载更早历史。',
  'memory.reason': '未注入原因',
  'view.trajectory': '轨迹',
  'toolbar.aria': '轨迹工具栏',
  'toolbar.duration': 'Duration',
  'toolbar.useActualDuration': 'Use actual duration',
  'toolbar.useEqualWidth': 'Use equal-width operations',
  'toolbar.actualTime': '实际时间',
  'toolbar.turns': 'Turns',
  'toolbar.expandTurns': 'Expand turns',
  'toolbar.collapseTurns': 'Collapse turns',
  'toolbar.calls': 'Calls',
  'toolbar.expandCalls': 'Expand calls',
  'toolbar.collapseCalls': 'Collapse calls',
  'toolbar.search': '搜索轨迹',
  'toolbar.searchPlaceholder': '搜索',
}

/** English dictionary. */
export const en: Record<TrajectoryKey, string> = {
  'memory.title': 'Long-term memory context',
  'memory.first': 'First injection',
  'memory.reused': 'Reused',
  'memory.updated': 'Updated',
  'memory.skipped': 'Not injected',
  'memory.disabled': 'Feature disabled',
  'memory.session-denied': 'Session disallows memory reading',
  'memory.no-generation': 'No published memory',
  'memory.incompatible-generation': 'Memory version requires a rebuild',
  'memory.budget-too-small': 'Summary does not fit the budget',
  'memory.assembly-excluded': 'Final prompt excluded the summary',
  'memory.unrecorded': 'Not recorded',
  'memory.legacy-crop': 'Cropping: not recorded in this older log',
  'memory.generation': 'Generation',
  'memory.bytes': 'Summary bytes',
  'memory.retained': 'Retained items',
  'memory.omitted': 'Omitted items',
  'memory.header': 'Request header',
  'memory.missing-header': 'The associated request header is outside this event window. Load older history.',
  'memory.reason': 'Not injected because',
  'view.trajectory': 'Trajectory',
  'toolbar.aria': 'Trajectory toolbar',
  'toolbar.duration': 'Duration',
  'toolbar.useActualDuration': 'Use actual duration',
  'toolbar.useEqualWidth': 'Use equal-width operations',
  'toolbar.actualTime': 'Actual time',
  'toolbar.turns': 'Turns',
  'toolbar.expandTurns': 'Expand turns',
  'toolbar.collapseTurns': 'Collapse turns',
  'toolbar.calls': 'Calls',
  'toolbar.expandCalls': 'Expand calls',
  'toolbar.collapseCalls': 'Collapse calls',
  'toolbar.search': 'Search trajectory',
  'toolbar.searchPlaceholder': 'Search',
}
