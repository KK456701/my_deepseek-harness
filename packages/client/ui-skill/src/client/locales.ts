/** `skill` namespace dictionaries for the dedicated tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'skill'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.running': '正在加载 skill',
  'row.failed': 'skill 加载失败',
  'row.stopped': 'skill 加载已中止',
  'row.instructions': '说明',
  'menu.userOnly': '仅用户',
  'settings.nav': 'Skill',
  'settings.title': 'Skill',
  'settings.intro': '查看当前会话可用的 Skill。输入 /名称 可在对话中调用。',
  'settings.loading': '正在读取 Skill…',
  'settings.error': 'Skill 列表读取失败。',
  'settings.retry': '重试',
  'settings.noSession': '请先打开一个会话，再查看它可用的 Skill。',
  'settings.searchLabel': '搜索 Skill',
  'settings.searchPlaceholder': '搜索名称、简介或适用场景',
  'settings.catalog': '当前 Skill',
  'settings.count': '{count} 个',
  'settings.empty': '当前会话没有可用的 Skill。',
  'settings.noResults': '没有匹配的 Skill。',
  'settings.modelInvocable': '模型可调用',
  'settings.userOnly': '仅用户调用',
  'settings.whenToUse': '适用场景',
} satisfies Record<string, string>

/** The skill namespace key union. */
export type SkillKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.running': 'Loading skill',
  'row.failed': 'Skill load failed',
  'row.stopped': 'Skill load stopped',
  'row.instructions': 'Instructions',
  'menu.userOnly': 'user-only',
  'settings.nav': 'Skills',
  'settings.title': 'Skills',
  'settings.intro': 'View skills available to the current session. Type /name in the conversation to invoke one.',
  'settings.loading': 'Loading skills…',
  'settings.error': 'Could not load the skill catalog.',
  'settings.retry': 'Retry',
  'settings.noSession': 'Open a session to view its available skills.',
  'settings.searchLabel': 'Search skills',
  'settings.searchPlaceholder': 'Search names, descriptions, or use cases',
  'settings.catalog': 'Current skills',
  'settings.count': '{count}',
  'settings.empty': 'This session has no available skills.',
  'settings.noResults': 'No matching skills.',
  'settings.modelInvocable': 'Model-invocable',
  'settings.userOnly': 'User-only',
  'settings.whenToUse': 'When to use',
} satisfies Record<SkillKey, string>
