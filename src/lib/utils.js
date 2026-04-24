import { CATEGORY_COLORS, CATEGORY_EMOJIS } from './constants'

export function cn(...classes) {
  return classes.filter(Boolean).join(' ')
}

export function currency(value, currencyCode = 'CAD') {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format(Number(value || 0))
}

export function shortDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00`))
}

export function monthLabel(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

export function today() {
  return new Date().toISOString().slice(0, 10)
}

export function normalizeText(value) {
  return value?.trim().toLowerCase() ?? ''
}

export function slugKey(value) {
  return normalizeText(value).replace(/\s+/g, '-')
}

export function parseAmount(value) {
  const normalized = String(value ?? '').replace(/[^0-9.-]/g, '')
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0
}

export function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function endOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

export function toDateInputValue(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10)
}

export function buildMonthWeeks(date = new Date()) {
  const start = startOfMonth(date)
  const end = endOfMonth(date)
  const weeks = []
  let cursor = new Date(start)

  while (cursor <= end) {
    const weekStart = new Date(cursor)
    const weekEnd = new Date(cursor)
    weekEnd.setDate(cursor.getDate() + 6)
    if (weekEnd > end) {
      weekEnd.setTime(end.getTime())
    }

    weeks.push({
      label: `Week ${weeks.length + 1}`,
      start: toDateInputValue(weekStart),
      end: toDateInputValue(weekEnd),
    })

    cursor.setDate(cursor.getDate() + 7)
  }

  return weeks
}

export function getCategoryVisual(name) {
  const key = normalizeText(name)
  let hash = 0

  for (let index = 0; index < key.length; index += 1) {
    hash = key.charCodeAt(index) + ((hash << 5) - hash)
  }

  return {
    color: CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length],
    emoji: CATEGORY_EMOJIS[Math.abs(hash) % CATEGORY_EMOJIS.length],
  }
}

export function estimateMonthsRemaining(goal) {
  const remaining = Math.max(Number(goal.target_amount) - Number(goal.current_amount || 0), 0)
  const totalContribution = Number(goal.total_contributed || goal.current_amount || 0)
  const activeMonths = Math.max(Number(goal.active_months || 0), 1)
  const averageContribution = totalContribution > 0 ? totalContribution / activeMonths : 0

  if (!remaining) {
    return 'Reached'
  }

  if (!averageContribution) {
    return 'No estimate yet'
  }

  return `${Math.ceil(remaining / averageContribution)} mo left`
}

export function addRecurringInterval(dateValue, frequency) {
  const nextDate = new Date(`${dateValue}T00:00:00`)

  if (frequency === 'daily') {
    nextDate.setDate(nextDate.getDate() + 1)
  } else if (frequency === 'weekly') {
    nextDate.setDate(nextDate.getDate() + 7)
  } else {
    nextDate.setMonth(nextDate.getMonth() + 1)
  }

  return toDateInputValue(nextDate)
}

export function compareDateOnly(left, right) {
  return left.localeCompare(right)
}

export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function getDaysUntil(dateValue) {
  const todayDate = new Date(`${today()}T00:00:00`)
  const targetDate = new Date(`${dateValue}T00:00:00`)
  return Math.round((targetDate.getTime() - todayDate.getTime()) / 86400000)
}
