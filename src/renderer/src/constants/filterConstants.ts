import type { FontFormat } from '@shared/types'
import type { FontCategory,InstallStatusFilter,SortMode,TimeSortMode,ViewMode } from '../appTypes'

export const FORMAT_FILTERS: Array<{ id: FontFormat; label: string }> = [
  { id: 'ttf', label: 'TTF' },
  { id: 'otf', label: 'OTF' },
  { id: 'ttc', label: 'TTC' },
  { id: 'otc', label: 'OTC' },
  { id: 'unknown', label: '其他' }
]

export const FONT_CATEGORY_FILTERS: Array<{ id: FontCategory; label: string; keywords: string[] }> = [
  { id: 'all', label: '所有类', keywords: [] },
  { id: 'serif', label: '衬线', keywords: ['serif', 'roman', 'times', 'song', 'songti', 'simsun', 'mincho', 'ming', '宋体', '宋', '明体', '明朝', '仿宋'] },
  { id: 'slabSerif', label: '粗衬线', keywords: ['slab', 'egyptian', 'rockwell', 'clarendon', 'square serif', '粗衬线', '方衬线'] },
  { id: 'sansSerif', label: '无衬线', keywords: ['sans', 'gothic', 'arial', 'helvetica', 'segoe', 'calibri', 'verdana', 'source sans', 'noto sans', '无衬线', '圆体', '雅黑'] },
  { id: 'script', label: '脚本', keywords: ['script', 'cursive', 'calligraphy', 'brush', '书法', '行书', '草书', '隶书', '篆书', '毛笔'] },
  { id: 'monospace', label: '等宽', keywords: ['mono', 'monospace', 'code', 'console', 'consolas', 'courier', 'jetbrains mono', 'source code', '等宽', '代码'] },
  { id: 'handwriting', label: '手写', keywords: ['hand', 'handwriting', 'handwritten', 'marker', 'pen', 'pencil', 'chalk', '手写', '手书', '硬笔', '粉笔'] },
  { id: 'hei', label: '黑体', keywords: ['hei', 'heiti', 'simhei', 'yahei', 'microsoft yahei', 'source han sans', 'noto sans cjk', '黑体', '黑', '思源黑体', '微软雅黑'] },
  { id: 'art', label: '艺术', keywords: ['display', 'decorative', 'poster', 'headline', 'title', 'fantasy', '艺术', '标题', '海报', '装饰', '创意', '卡通'] }
]

export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = Object.fromEntries(
  FONT_CATEGORY_FILTERS.map((item) => [item.id, item.label])
) as Record<FontCategory, string>

export const SCRIPT_LANGUAGE_LABELS: Record<string, string> = {
  chinese: '中文',
  latin: '英文/西文',
  japanese: '日文',
  korean: '韩文',
  symbol: '符号',
  other: '其他语言',
  arabic: '阿拉伯文',
  hebrew: '希伯来文',
  thai: '泰文',
  cyrillic: '西里尔文',
  greek: '希腊文',
  devanagari: '天城文',
  bengali: '孟加拉文',
  tamil: '泰米尔文',
  telugu: '泰卢固文',
  gujarati: '古吉拉特文',
  gurmukhi: '古尔穆基文',
  lao: '老挝文',
  khmer: '高棉文',
  myanmar: '缅甸文',
  ethiopic: '埃塞俄比亚文',
  armenian: '亚美尼亚文',
  georgian: '格鲁吉亚文',
  vietnamese: '越南文'
}

export const SCRIPT_LANGUAGE_ORDER = [
  'chinese',
  'japanese',
  'korean',
  'latin',
  'symbol',
  'other',
  'arabic',
  'hebrew',
  'thai',
  'cyrillic',
  'greek',
  'devanagari',
  'bengali',
  'tamil',
  'telugu',
  'gujarati',
  'gurmukhi',
  'lao',
  'khmer',
  'myanmar',
  'ethiopic',
  'armenian',
  'georgian',
  'vietnamese'
]

export const TIME_SORT_OPTIONS: Array<{ id: TimeSortMode; label: string }> = [
  { id: 'created', label: '创建时间' },
  { id: 'modified', label: '修改时间' },
  { id: 'custom', label: '自定义时间' }
]

export const SORT_OPTIONS: Array<{ id: SortMode; label: string }> = [
  { id: 'smart', label: '智能排序' },
  { id: 'nameAsc', label: '名称 A-Z' },
  { id: 'nameDesc', label: '名称 Z-A' },
  { id: 'createdDesc', label: '创建时间 新-旧' },
  { id: 'createdAsc', label: '创建时间 旧-新' },
  { id: 'modifiedDesc', label: '修改时间 新-旧' },
  { id: 'modifiedAsc', label: '修改时间 旧-新' },
  { id: 'sizeDesc', label: '文件大小 大-小' },
  { id: 'sizeAsc', label: '文件大小 小-大' }
]

export const VIEW_MODE_OPTIONS: Array<{ id: ViewMode; label: string }> = [
  { id: 'compact', label: '紧凑卡片' },
  { id: 'comfortable', label: '标准卡片' },
  { id: 'large', label: '大预览卡片' }
]

export const INSTALL_STATUS_OPTIONS: Array<{ id: InstallStatusFilter; label: string }> = [
  { id: 'all', label: '全部状态' },
  { id: 'installed', label: '已安装' },
  { id: 'notInstalled', label: '未安装' }
]

