import { useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useLocation, useNavigate } from 'react-router-dom'
import { ACCENT_OPTIONS, DEFAULT_CATEGORIES, NAV_ITEMS } from './lib/constants'
import { hasSupabaseEnv, supabase } from './lib/supabase'
import {
  buildMonthWeeks,
  cn,
  currency,
  estimateMonthsRemaining,
  getCategoryVisual,
  monthLabel,
  normalizeText,
  parseAmount,
  shortDate,
  slugKey,
  startOfMonth,
  today,
  toDateInputValue,
} from './lib/utils'

const DEFAULT_THEME = { theme: 'light', accent_color: 'blue' }

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let isMounted = true

    async function bootstrapAuth() {
      const [
        {
          data: { session: currentSession },
        },
        {
          data: { user: currentUser },
        },
      ] = await Promise.all([supabase.auth.getSession(), supabase.auth.getUser()])

      if (!isMounted) {
        return
      }

      setSession(currentSession)
      setUser(currentUser)
      setLoading(false)
    }

    bootstrapAuth()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession)
      setUser(nextSession?.user ?? null)
      setLoading(false)

      if (event === 'PASSWORD_RECOVERY') {
        navigate('/reset-password', { replace: true })
      }

    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [location.pathname, navigate])

  if (loading) {
    return <LoadingScreen />
  }

  if (location.pathname === '/reset-password') {
    return (
      <ResetPasswordScreen
        canReset={Boolean(session)}
        notice={notice}
        onNotice={setNotice}
        onBack={() => navigate('/', { replace: true })}
      />
    )
  }

  if (!user) {
    return <AuthScreen notice={notice} onNotice={setNotice} />
  }

  return <BudgetApp user={user} onNotice={setNotice} notice={notice} />
}

function BudgetApp({ user, notice, onNotice }) {
  const [activeView, setActiveView] = useState('dashboard')
  const [transactions, setTransactions] = useState([])
  const [categories, setCategories] = useState([])
  const [goals, setGoals] = useState([])
  const [contributions, setContributions] = useState([])
  const [settings, setSettings] = useState(DEFAULT_THEME)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme ?? 'light'
    document.documentElement.dataset.accent = settings.accent_color ?? 'blue'
  }, [settings.accent_color, settings.theme])

  useEffect(() => {
    let cancelled = false

    async function loadData() {
      if (!hasSupabaseEnv) {
        setLoading(false)
        return
      }

      setLoading(true)

      try {
        const seededCategories = await ensureCategories(user.id)
        const userSettings = await ensureSettings(user.id)

        const [{ data: transactionsData, error: transactionsError }, { data: goalsData, error: goalsError }] =
          await Promise.all([
            supabase
              .from('transactions')
              .select('id, user_id, date, amount, type, category_id, description, created_at')
              .eq('user_id', user.id)
              .order('date', { ascending: false })
              .order('created_at', { ascending: false }),
            supabase
              .from('goals')
              .select('id, user_id, name, target_amount, current_amount, deadline')
              .eq('user_id', user.id)
              .order('deadline', { ascending: true, nullsFirst: false }),
          ])

        if (transactionsError) throw transactionsError
        if (goalsError) throw goalsError

        const goalIds = (goalsData ?? []).map((goal) => goal.id)
        let contributionsData = []

        if (goalIds.length) {
          const { data, error } = await supabase
            .from('goal_contributions')
            .select('id, goal_id, month, year, amount')
            .in('goal_id', goalIds)
            .order('year', { ascending: false })
            .order('month', { ascending: false })

          if (error) throw error
          contributionsData = data ?? []
        }

        if (!cancelled) {
          setCategories(seededCategories)
          setSettings(userSettings)
          setTransactions(transactionsData ?? [])
          setGoals(goalsData ?? [])
          setContributions(contributionsData)
        }
      } catch (error) {
        onNotice(error.message || 'Unable to load your budget data.')
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadData()

    return () => {
      cancelled = true
    }
  }, [onNotice, refreshKey, user.id])

  const categoryMap = useMemo(
    () =>
      categories.reduce((map, category) => {
        map[category.id] = category
        return map
      }, {}),
    [categories],
  )

  const transactionsWithCategory = useMemo(
    () =>
      transactions.map((transaction) => ({
        ...transaction,
        amount: Number(transaction.amount),
        category: categoryMap[transaction.category_id] ?? null,
      })),
    [categoryMap, transactions],
  )

  const dashboardData = useMemo(() => buildDashboardData(transactionsWithCategory), [transactionsWithCategory])
  const enrichedGoals = useMemo(
    () => enrichGoals(goals, contributions),
    [contributions, goals],
  )

  async function refreshData() {
    setRefreshKey((value) => value + 1)
  }

  async function saveTransaction(payload, transactionId = null) {
    setSaving(true)

    try {
      const basePayload = {
        user_id: user.id,
        date: payload.date,
        amount: Number(payload.amount),
        type: payload.type,
        category_id: payload.category_id,
        description: payload.description.trim(),
      }

      const query = transactionId
        ? supabase.from('transactions').update(basePayload).eq('id', transactionId).eq('user_id', user.id)
        : supabase.from('transactions').insert(basePayload)

      const { error } = await query
      if (error) throw error

      onNotice(transactionId ? 'Transaction updated.' : 'Transaction saved.')
      await refreshData()
    } catch (error) {
      onNotice(error.message || 'Unable to save transaction.')
    } finally {
      setSaving(false)
    }
  }

  async function deleteTransaction(transactionId) {
    const { error } = await supabase.from('transactions').delete().eq('id', transactionId).eq('user_id', user.id)

    if (error) {
      onNotice(error.message || 'Unable to delete transaction.')
      return
    }

    onNotice('Transaction deleted.')
    await refreshData()
  }

  async function createCategory(payload) {
    try {
      const { error } = await supabase.from('categories').insert({
        user_id: user.id,
        name: payload.name.trim(),
        color: payload.color.trim(),
        emoji: payload.emoji.trim(),
        type: payload.type,
      })

      if (error) throw error

      onNotice('Category added.')
      await refreshData()
    } catch (error) {
      onNotice(error.message || 'Unable to create category.')
    }
  }

  async function updateCategory(categoryId, payload) {
    try {
      const { error } = await supabase
        .from('categories')
        .update(payload)
        .eq('id', categoryId)
        .eq('user_id', user.id)

      if (error) throw error

      onNotice('Category updated.')
      await refreshData()
    } catch (error) {
      onNotice(error.message || 'Unable to update category.')
    }
  }

  async function removeCategory(category) {
    try {
      const fallbackCategory = categories.find(
        (item) =>
          item.type === category.type &&
          normalizeText(item.name) === (category.type === 'expense' ? 'other' : 'other income'),
      )

      if (fallbackCategory) {
        const { error: transactionError } = await supabase
          .from('transactions')
          .update({ category_id: fallbackCategory.id })
          .eq('user_id', user.id)
          .eq('category_id', category.id)

        if (transactionError) throw transactionError
      }

      const { error } = await supabase.from('categories').delete().eq('id', category.id).eq('user_id', user.id)

      if (error) throw error

      onNotice('Category deleted.')
      await refreshData()
    } catch (error) {
      onNotice(error.message || 'Unable to delete category.')
    }
  }

  async function saveGoal(payload, goalId = null) {
    try {
      const basePayload = {
        user_id: user.id,
        name: payload.name.trim(),
        target_amount: Number(payload.target_amount),
        current_amount: Number(payload.current_amount ?? 0),
        deadline: payload.deadline || null,
      }

      const query = goalId
        ? supabase.from('goals').update(basePayload).eq('id', goalId).eq('user_id', user.id)
        : supabase.from('goals').insert(basePayload)

      const { error } = await query
      if (error) throw error

      onNotice(goalId ? 'Goal updated.' : 'Goal created.')
      await refreshData()
    } catch (error) {
      onNotice(error.message || 'Unable to save goal.')
    }
  }

  async function deleteGoal(goalId) {
    const { error } = await supabase.from('goals').delete().eq('id', goalId).eq('user_id', user.id)

    if (error) {
      onNotice(error.message || 'Unable to delete goal.')
      return
    }

    onNotice('Goal removed.')
    await refreshData()
  }

  async function addGoalContribution(goalId, amount, month, year) {
    try {
      const existingContribution = contributions.find(
        (item) => item.goal_id === goalId && Number(item.month) === Number(month) && Number(item.year) === Number(year),
      )

      if (existingContribution) {
        const { error } = await supabase
          .from('goal_contributions')
          .update({ amount: Number(existingContribution.amount) + Number(amount) })
          .eq('id', existingContribution.id)

        if (error) throw error
      } else {
        const { error } = await supabase.from('goal_contributions').insert({
          goal_id: goalId,
          month,
          year,
          amount: Number(amount),
        })

        if (error) throw error
      }

      const goal = enrichedGoals.find((item) => item.id === goalId)
      const nextCurrentAmount = Number(goal?.current_amount || 0) + Number(amount)

      const { error: goalError } = await supabase
        .from('goals')
        .update({ current_amount: nextCurrentAmount })
        .eq('id', goalId)
        .eq('user_id', user.id)

      if (goalError) throw goalError

      onNotice('Contribution recorded.')
      await refreshData()
    } catch (error) {
      onNotice(error.message || 'Unable to record contribution.')
    }
  }

  async function saveSettings(nextSettings) {
    try {
        const { error } = await supabase.from('settings').upsert(
          {
            user_id: user.id,
            theme: nextSettings.theme,
            accent_color: nextSettings.accent_color,
          },
          { onConflict: 'user_id' },
        )

      if (error) throw error

      setSettings(nextSettings)
      onNotice('Preferences saved.')
    } catch (error) {
      onNotice(error.message || 'Unable to save settings.')
    }
  }

  async function importTransactions(rows) {
    try {
      const existingCategories = [...categories]
      const categoryByName = new Map(
        existingCategories.map((category) => [`${category.type}:${normalizeText(category.name)}`, category]),
      )

      for (const row of rows) {
        const key = `${row.type}:${normalizeText(row.category)}`
        if (!categoryByName.has(key)) {
          const visual = getCategoryVisual(row.category)
          const { data, error } = await supabase
            .from('categories')
            .insert({
              user_id: user.id,
              name: row.category,
              color: visual.color,
              emoji: visual.emoji,
              type: row.type,
            })
            .select()
            .single()

          if (error) throw error
          categoryByName.set(key, data)
          existingCategories.push(data)
        }
      }

      const existingDuplicateKeys = new Set(
        transactions.map((transaction) =>
          `${normalizeText(transaction.description)}|${Number(transaction.amount).toFixed(2)}|${transaction.date}`,
        ),
      )

      const seenImportKeys = new Set()
      const payload = []

      for (const row of rows) {
        const duplicateKey = `${normalizeText(row.description)}|${Number(row.amount).toFixed(2)}|${row.date}`

        if (existingDuplicateKeys.has(duplicateKey) || seenImportKeys.has(duplicateKey)) {
          continue
        }

        seenImportKeys.add(duplicateKey)
        payload.push({
          user_id: user.id,
          date: row.date,
          amount: row.amount,
          type: row.type,
          category_id: categoryByName.get(`${row.type}:${normalizeText(row.category)}`)?.id ?? null,
          description: row.description,
        })
      }

      if (!payload.length) {
        onNotice('No new rows were imported. All selected rows were duplicates.')
        return
      }

      const { error } = await supabase.from('transactions').insert(payload)
      if (error) throw error

      onNotice(`${payload.length} transaction${payload.length === 1 ? '' : 's'} imported.`)
      await refreshData()
    } catch (error) {
      onNotice(error.message || 'Unable to import CSV rows.')
    }
  }

  if (loading) {
    return <LoadingScreen />
  }

  const content = {
    dashboard: (
      <DashboardPage
        dashboardData={dashboardData}
        transactions={transactionsWithCategory}
      />
    ),
    transactions: (
      <TransactionsPage
        categories={categories}
        onDeleteTransaction={deleteTransaction}
        onImportTransactions={importTransactions}
        onSaveTransaction={saveTransaction}
        saving={saving}
        transactions={transactionsWithCategory}
      />
    ),
    goals: (
      <GoalsPage
        goals={enrichedGoals}
        onAddContribution={addGoalContribution}
        onDeleteGoal={deleteGoal}
        onSaveGoal={saveGoal}
      />
    ),
    settings: (
      <SettingsPage
        categories={categories}
        notice={notice}
        onCreateCategory={createCategory}
        onDeleteCategory={removeCategory}
        onSaveSettings={saveSettings}
        onUpdateCategory={updateCategory}
        settings={settings}
      />
    ),
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.85),_transparent_34%),var(--bg-app)] text-[var(--text-primary)] transition-colors">
      {!hasSupabaseEnv && (
        <div className="border-b border-[var(--border-soft)] bg-amber-100 px-4 py-3 text-sm text-amber-950">
          Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to run the live app. The UI is ready, but database calls need your Supabase project.
        </div>
      )}

      <div className="mx-auto flex min-h-screen max-w-7xl flex-col md:flex-row">
        <Sidebar activeView={activeView} onChange={setActiveView} user={user} />
        <main className="flex-1 px-4 pb-28 pt-6 md:px-8 md:pb-8 md:pt-8">
          {notice && (
            <div className="mb-4 rounded-2xl border border-[var(--border-soft)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)] shadow-soft">
              {notice}
            </div>
          )}
          {content[activeView]}
        </main>
      </div>
      <MobileNav activeView={activeView} onChange={setActiveView} />
    </div>
  )
}

function Sidebar({ activeView, onChange, user }) {
  return (
    <aside className="hidden w-72 shrink-0 border-r border-[var(--border-soft)] bg-[linear-gradient(180deg,var(--surface),rgba(255,255,255,0.3))] px-5 py-6 md:flex md:flex-col">
      <div className="mb-8">
        <p className="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Budget Flow</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">Your money, in motion.</h1>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          Track spending, protect goals, and keep your monthly plan simple.
        </p>
      </div>

      <nav className="space-y-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={cn(
              'flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-sm font-medium transition',
              activeView === item.id
                ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]',
            )}
          >
            <span>{item.label}</span>
            <span className="text-xs uppercase tracking-[0.3em]">{item.id.slice(0, 2)}</span>
          </button>
        ))}
      </nav>

      <div className="mt-auto rounded-3xl border border-[var(--border-soft)] bg-[var(--surface)] p-4 shadow-soft">
        <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Signed in</p>
        <p className="mt-2 text-sm font-medium text-[var(--text-primary)]">{user.email}</p>
      </div>
    </aside>
  )
}

function MobileNav({ activeView, onChange }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-soft)] bg-[rgba(246,248,252,0.92)] p-3 backdrop-blur md:hidden dark:bg-[rgba(13,17,23,0.92)]">
      <div className="mx-auto flex max-w-xl justify-between gap-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={cn(
              'flex min-w-0 flex-1 flex-col items-center rounded-2xl px-2 py-2 text-xs font-medium transition',
              activeView === item.id
                ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                : 'text-[var(--text-secondary)]',
            )}
          >
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

function DashboardPage({ dashboardData, transactions }) {
  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Monthly Summary</p>
              <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{monthLabel()}</h2>
            </div>
            <div className="rounded-full bg-[var(--surface-muted)] px-4 py-2 text-sm text-[var(--text-secondary)]">
              Running balance {currency(dashboardData.runningBalance)}
            </div>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <SummaryCard label="Income" value={currency(dashboardData.monthlyIncome)} tone="positive" />
            <SummaryCard label="Expenses" value={currency(dashboardData.monthlyExpenses)} tone="negative" />
            <SummaryCard label="Net" value={currency(dashboardData.netBalance)} tone="neutral" />
          </div>
        </div>

        <div className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
          <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Weekly Recap</p>
          <div className="mt-4 space-y-4">
            {dashboardData.weeklyRecap.map((week) => (
              <div key={week.label} className="rounded-2xl bg-[var(--surface-muted)] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-[var(--text-primary)]">{week.label}</span>
                  <span className="text-sm text-[var(--text-secondary)]">{currency(week.total)}</span>
                </div>
                <div className="mt-3 h-2 rounded-full bg-[var(--border-soft)]">
                  <div
                    className="h-2 rounded-full bg-[var(--accent)]"
                    style={{ width: `${week.percent}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <ChartCard title="Spending by Category" subtitle="Current month expense breakdown">
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={dashboardData.categorySpending}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={74}
                  outerRadius={110}
                  paddingAngle={4}
                >
                  {dashboardData.categorySpending.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => currency(value)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            {dashboardData.categorySpending.map((item) => (
              <span
                key={item.name}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                {item.name}
              </span>
            ))}
          </div>
        </ChartCard>

        <ChartCard title="Weekly Spending" subtitle="Bar chart across this month">
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dashboardData.weeklyBar}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
                <XAxis dataKey="label" stroke="var(--text-muted)" />
                <YAxis stroke="var(--text-muted)" />
                <Tooltip formatter={(value) => currency(value)} />
                <Bar dataKey="total" fill="var(--accent)" radius={[16, 16, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </section>

      <ChartCard title="Running Balance Tracker" subtitle="Income and expenses flowing over time">
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={dashboardData.runningSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
              <XAxis dataKey="label" stroke="var(--text-muted)" />
              <YAxis stroke="var(--text-muted)" />
              <Tooltip formatter={(value) => currency(value)} />
              <Line type="monotone" dataKey="balance" stroke="var(--accent)" strokeWidth={3} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {transactions.slice(0, 3).map((transaction) => (
            <div key={transaction.id} className="rounded-2xl bg-[var(--surface-muted)] p-4">
              <p className="text-sm font-medium text-[var(--text-primary)]">{transaction.description}</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">{shortDate(transaction.date)}</p>
              <p className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
                {transaction.type === 'income' ? '+' : '-'}
                {currency(transaction.amount)}
              </p>
            </div>
          ))}
        </div>
      </ChartCard>
    </div>
  )
}

function TransactionsPage({
  categories,
  onDeleteTransaction,
  onImportTransactions,
  onSaveTransaction,
  saving,
  transactions,
}) {
  const [filters, setFilters] = useState({
    query: '',
    type: 'all',
    category: 'all',
    startDate: '',
    endDate: '',
  })
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({
    date: today(),
    amount: '',
    type: 'expense',
    category_id: '',
    description: '',
  })
  const [importState, setImportState] = useState({
    rows: [],
    assumedMonth: new Date().getMonth(),
    assumedYear: new Date().getFullYear(),
  })

  const filteredCategories = categories.filter((category) => category.type === form.type)
  const selectedCategoryId = form.category_id || filteredCategories[0]?.id || ''

  const visibleTransactions = useMemo(() => {
    return transactions.filter((transaction) => {
      if (filters.type !== 'all' && transaction.type !== filters.type) return false
      if (filters.category !== 'all' && transaction.category_id !== filters.category) return false
      if (filters.startDate && transaction.date < filters.startDate) return false
      if (filters.endDate && transaction.date > filters.endDate) return false
      if (
        filters.query &&
        !`${transaction.description} ${transaction.category?.name ?? ''}`
          .toLowerCase()
          .includes(filters.query.toLowerCase())
      ) {
        return false
      }
      return true
    })
  }, [filters, transactions])

  function handleFormChange(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value }
      if (field === 'type') {
        next.category_id = categories.find((category) => category.type === value)?.id ?? ''
      }
      return next
    })
  }

  function resetForm() {
    setEditingId(null)
    setForm({
      date: today(),
      amount: '',
      type: 'expense',
      category_id: categories.find((category) => category.type === 'expense')?.id ?? '',
      description: '',
    })
  }

  async function submitForm(event) {
    event.preventDefault()
    await onSaveTransaction({ ...form, category_id: selectedCategoryId }, editingId)
    resetForm()
  }

  function startEdit(transaction) {
    setEditingId(transaction.id)
    setForm({
      date: transaction.date,
      amount: transaction.amount,
      type: transaction.type,
      category_id: transaction.category_id,
      description: transaction.description,
    })
  }

  function parseCsv(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data, meta }) => {
        const headers = meta.fields ?? []
        const headerMap = headers.reduce((map, header) => {
          map[normalizeText(header)] = header
          return map
        }, {})

        const parsedRows = data.map((row, index) => {
          const rawDate = row[headerMap['date']] ?? ''
          const rawCategory = row[headerMap['category']] ?? 'Other'
          const rawName = row[headerMap['name']] ?? ''
          const dayOnly = /^\d{1,2}$/.test(String(rawDate).trim())

          return {
            id: `import-${index}`,
            include: true,
            description: String(rawName).trim(),
            amount: parseAmount(row[headerMap['amount']]),
            category: String(rawCategory).trim() || 'Other',
            type: 'expense',
            rawDate: String(rawDate).trim(),
            needsDateContext: dayOnly,
          }
        })

        setImportState((current) => ({ ...current, rows: parsedRows }))
      },
    })
  }

  async function confirmImport() {
    const selectedRows = importState.rows
      .filter((row) => row.include && row.description && row.amount)
      .map((row) => ({
        ...row,
        date: row.needsDateContext
          ? toDateInputValue(new Date(importState.assumedYear, importState.assumedMonth, Number(row.rawDate)))
          : toDateInputValue(new Date(row.rawDate)),
      }))

    await onImportTransactions(selectedRows)
    setImportState((current) => ({ ...current, rows: [] }))
  }

  return (
    <div className="space-y-6">
      <section className="grid gap-6 xl:grid-cols-[1.1fr_1.4fr]">
        <form onSubmit={submitForm} className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Quick Add</p>
              <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">
                {editingId ? 'Edit transaction' : 'Fast transaction entry'}
              </h2>
            </div>
            {editingId && (
              <button type="button" onClick={resetForm} className="text-sm text-[var(--accent-strong)]">
                Cancel edit
              </button>
            )}
          </div>

          <div className="mt-6 grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <select
                value={form.type}
                onChange={(event) => handleFormChange('type', event.target.value)}
                className="field"
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
              <input
                type="date"
                value={form.date}
                onChange={(event) => handleFormChange('date', event.target.value)}
                className="field"
                required
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr]">
              <input
                type="text"
                value={form.description}
                onChange={(event) => handleFormChange('description', event.target.value)}
                placeholder="What was it?"
                className="field"
                required
              />
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(event) => handleFormChange('amount', event.target.value)}
                placeholder="0.00"
                className="field"
                required
              />
            </div>

            <select
              value={selectedCategoryId}
              onChange={(event) => handleFormChange('category_id', event.target.value)}
              className="field"
              required
            >
              {filteredCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.emoji} {category.name}
                </option>
              ))}
            </select>

            <button type="submit" disabled={saving} className="primary-button">
              {saving ? 'Saving...' : editingId ? 'Update transaction' : 'Add transaction'}
            </button>
          </div>
        </form>

        <section className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">CSV Import</p>
              <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">Google Sheets upload</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Expected headers: Name, Amount, Category, Date.
              </p>
            </div>
            <label className="inline-flex cursor-pointer items-center rounded-full bg-[var(--accent-soft)] px-4 py-2 text-sm font-medium text-[var(--accent-strong)]">
              Upload CSV
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) parseCsv(file)
                }}
              />
            </label>
          </div>

          {!importState.rows.length ? (
            <div className="mt-6 rounded-3xl border border-dashed border-[var(--border-soft)] bg-[var(--surface-muted)] p-6 text-sm text-[var(--text-secondary)]">
              Export a Google Sheet as CSV, upload it here, review every row, flip expense/income if needed, and import only the rows you want.
            </div>
          ) : (
            <div className="mt-6 space-y-4">
              {importState.rows.some((row) => row.needsDateContext) && (
                <div className="grid gap-3 rounded-2xl bg-[var(--surface-muted)] p-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm text-[var(--text-secondary)]">
                    <span>Assumed month</span>
                    <select
                      value={importState.assumedMonth}
                      onChange={(event) =>
                        setImportState((current) => ({
                          ...current,
                          assumedMonth: Number(event.target.value),
                        }))
                      }
                      className="field"
                    >
                      {Array.from({ length: 12 }).map((_, monthIndex) => (
                        <option key={monthIndex} value={monthIndex}>
                          {new Date(2026, monthIndex, 1).toLocaleString('en-US', { month: 'long' })}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-2 text-sm text-[var(--text-secondary)]">
                    <span>Assumed year</span>
                    <input
                      type="number"
                      value={importState.assumedYear}
                      onChange={(event) =>
                        setImportState((current) => ({
                          ...current,
                          assumedYear: Number(event.target.value),
                        }))
                      }
                      className="field"
                    />
                  </label>
                </div>
              )}

              <div className="max-h-[26rem] overflow-auto rounded-3xl border border-[var(--border-soft)]">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-[var(--surface-muted)] text-[var(--text-secondary)]">
                    <tr>
                      <th className="px-3 py-3">Include</th>
                      <th className="px-3 py-3">Type</th>
                      <th className="px-3 py-3">Name</th>
                      <th className="px-3 py-3">Category</th>
                      <th className="px-3 py-3">Date</th>
                      <th className="px-3 py-3">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importState.rows.map((row) => (
                      <tr key={row.id} className="border-t border-[var(--border-soft)]">
                        <td className="px-3 py-3">
                          <input
                            type="checkbox"
                            checked={row.include}
                            onChange={(event) =>
                              setImportState((current) => ({
                                ...current,
                                rows: current.rows.map((item) =>
                                  item.id === row.id ? { ...item, include: event.target.checked } : item,
                                ),
                              }))
                            }
                          />
                        </td>
                        <td className="px-3 py-3">
                          <select
                            value={row.type}
                            onChange={(event) =>
                              setImportState((current) => ({
                                ...current,
                                rows: current.rows.map((item) =>
                                  item.id === row.id ? { ...item, type: event.target.value } : item,
                                ),
                              }))
                            }
                            className="field"
                          >
                            <option value="expense">Expense</option>
                            <option value="income">Income</option>
                          </select>
                        </td>
                        <td className="px-3 py-3">{row.description}</td>
                        <td className="px-3 py-3">{row.category}</td>
                        <td className="px-3 py-3">
                          {row.needsDateContext
                            ? `${new Date(importState.assumedYear, importState.assumedMonth, Number(row.rawDate)).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })} (assumed)`
                            : row.rawDate}
                        </td>
                        <td className="px-3 py-3">{currency(row.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button type="button" onClick={confirmImport} className="primary-button">
                Confirm import
              </button>
            </div>
          )}
        </section>
      </section>

      <section className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Transactions</p>
            <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">Search and filter</h2>
          </div>
          <div className="grid w-full gap-3 md:w-auto md:grid-cols-5">
            <input
              type="search"
              value={filters.query}
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
              placeholder="Search"
              className="field"
            />
            <select
              value={filters.type}
              onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value }))}
              className="field"
            >
              <option value="all">All types</option>
              <option value="expense">Expenses</option>
              <option value="income">Income</option>
            </select>
            <select
              value={filters.category}
              onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value }))}
              className="field"
            >
              <option value="all">All categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={filters.startDate}
              onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
              className="field"
            />
            <input
              type="date"
              value={filters.endDate}
              onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
              className="field"
            />
          </div>
        </div>

        <div className="mt-6 overflow-auto rounded-3xl border border-[var(--border-soft)]">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-[var(--surface-muted)] text-[var(--text-secondary)]">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleTransactions.map((transaction) => (
                <tr key={transaction.id} className="border-t border-[var(--border-soft)]">
                  <td className="px-4 py-4">{shortDate(transaction.date)}</td>
                  <td className="px-4 py-4 font-medium text-[var(--text-primary)]">{transaction.description}</td>
                  <td className="px-4 py-4">
                    <span className="inline-flex items-center gap-2 rounded-full bg-[var(--surface-muted)] px-3 py-2">
                      <span>{transaction.category?.emoji ?? '•'}</span>
                      <span>{transaction.category?.name ?? 'Uncategorized'}</span>
                    </span>
                  </td>
                  <td className="px-4 py-4 capitalize">{transaction.type}</td>
                  <td className="px-4 py-4 font-semibold text-[var(--text-primary)]">
                    {transaction.type === 'income' ? '+' : '-'}
                    {currency(transaction.amount)}
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex gap-3">
                      <button type="button" onClick={() => startEdit(transaction)} className="text-[var(--accent-strong)]">
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteTransaction(transaction.id)}
                        className="text-rose-500"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!visibleTransactions.length && (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--text-secondary)]" colSpan="6">
                    No transactions match these filters yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function GoalsPage({ goals, onAddContribution, onDeleteGoal, onSaveGoal }) {
  const [form, setForm] = useState({ name: '', target_amount: '', current_amount: 0, deadline: '' })
  const [editingId, setEditingId] = useState(null)
  const [contributionDrafts, setContributionDrafts] = useState({})
  const now = new Date()

  async function handleSubmit(event) {
    event.preventDefault()
    await onSaveGoal(form, editingId)
    setForm({ name: '', target_amount: '', current_amount: 0, deadline: '' })
    setEditingId(null)
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
        <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Goals</p>
        <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">
          Savings goals with monthly carry-over
        </h2>
        <form onSubmit={handleSubmit} className="mt-6 grid gap-4 lg:grid-cols-[1.3fr_1fr_1fr_auto]">
          <input
            type="text"
            placeholder="Goal name"
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            className="field"
            required
          />
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Target amount"
            value={form.target_amount}
            onChange={(event) => setForm((current) => ({ ...current, target_amount: event.target.value }))}
            className="field"
            required
          />
          <input
            type="date"
            value={form.deadline}
            onChange={(event) => setForm((current) => ({ ...current, deadline: event.target.value }))}
            className="field"
          />
          <button type="submit" className="primary-button">
            {editingId ? 'Update goal' : 'Create goal'}
          </button>
        </form>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        {goals.map((goal) => {
          const draft = contributionDrafts[goal.id] ?? { amount: '', month: now.getMonth() + 1, year: now.getFullYear() }
          const progress = Math.min((Number(goal.current_amount) / Number(goal.target_amount || 1)) * 100, 100)

          return (
            <section key={goal.id} className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold text-[var(--text-primary)]">{goal.name}</h3>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">
                    {currency(goal.current_amount)} saved of {currency(goal.target_amount)}
                  </p>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {currency(Math.max(Number(goal.target_amount) - Number(goal.current_amount), 0))} left •{' '}
                    {estimateMonthsRemaining(goal)}
                  </p>
                </div>
                <div className="flex gap-3 text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(goal.id)
                      setForm({
                        name: goal.name,
                        target_amount: goal.target_amount,
                        current_amount: goal.current_amount,
                        deadline: goal.deadline ?? '',
                      })
                    }}
                    className="text-[var(--accent-strong)]"
                  >
                    Edit
                  </button>
                  <button type="button" onClick={() => onDeleteGoal(goal.id)} className="text-rose-500">
                    Delete
                  </button>
                </div>
              </div>

              <div className="mt-5 h-3 rounded-full bg-[var(--border-soft)]">
                <div className="h-3 rounded-full bg-[var(--accent)]" style={{ width: `${progress}%` }} />
              </div>

              <div className="mt-6 grid gap-3 md:grid-cols-4">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Add amount"
                  value={draft.amount}
                  onChange={(event) =>
                    setContributionDrafts((current) => ({
                      ...current,
                      [goal.id]: { ...draft, amount: event.target.value },
                    }))
                  }
                  className="field"
                />
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={draft.month}
                  onChange={(event) =>
                    setContributionDrafts((current) => ({
                      ...current,
                      [goal.id]: { ...draft, month: Number(event.target.value) },
                    }))
                  }
                  className="field"
                />
                <input
                  type="number"
                  value={draft.year}
                  onChange={(event) =>
                    setContributionDrafts((current) => ({
                      ...current,
                      [goal.id]: { ...draft, year: Number(event.target.value) },
                    }))
                  }
                  className="field"
                />
                <button
                  type="button"
                  onClick={() => onAddContribution(goal.id, draft.amount, draft.month, draft.year)}
                  className="primary-button"
                >
                  Add contribution
                </button>
              </div>

              <div className="mt-5 space-y-3">
                {goal.contributions.slice(0, 4).map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between rounded-2xl bg-[var(--surface-muted)] px-4 py-3 text-sm"
                  >
                    <span className="text-[var(--text-secondary)]">
                      {new Date(entry.year, entry.month - 1, 1).toLocaleString('en-US', {
                        month: 'long',
                        year: 'numeric',
                      })}
                    </span>
                    <span className="font-semibold text-[var(--text-primary)]">{currency(entry.amount)}</span>
                  </div>
                ))}
              </div>
            </section>
          )
        })}

        {!goals.length && (
          <section className="rounded-[2rem] border border-dashed border-[var(--border-soft)] bg-[var(--surface-muted)] p-8 text-center text-[var(--text-secondary)]">
            Create your first savings goal to start tracking monthly progress.
          </section>
        )}
      </div>
    </div>
  )
}

function SettingsPage({
  categories,
  notice,
  onCreateCategory,
  onDeleteCategory,
  onSaveSettings,
  onUpdateCategory,
  settings,
}) {
  const [draft, setDraft] = useState(settings)
  const [categoryForm, setCategoryForm] = useState({
    name: '',
    color: '#2563eb',
    emoji: '✨',
    type: 'expense',
  })

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
        <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Appearance</p>
        <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">Theme and accent</h2>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="rounded-3xl bg-[var(--surface-muted)] p-5">
            <p className="text-sm font-medium text-[var(--text-primary)]">Mode</p>
            <div className="mt-4 flex gap-3">
              {['light', 'dark'].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setDraft((current) => ({ ...current, theme: mode }))}
                  className={cn(
                    'rounded-full px-4 py-2 text-sm capitalize',
                    draft.theme === mode
                      ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                      : 'bg-[var(--surface)] text-[var(--text-secondary)]',
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-3xl bg-[var(--surface-muted)] p-5">
            <p className="text-sm font-medium text-[var(--text-primary)]">Accent</p>
            <div className="mt-4 flex gap-3">
              {ACCENT_OPTIONS.map((accent) => (
                <button
                  key={accent}
                  type="button"
                  onClick={() => setDraft((current) => ({ ...current, accent_color: accent }))}
                    className={cn(
                      'flex items-center gap-2 rounded-full px-4 py-2 text-sm capitalize',
                      draft.accent_color === accent
                        ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                        : 'bg-[var(--surface)] text-[var(--text-secondary)]',
                    )}
                >
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{
                      backgroundColor:
                        accent === 'blue' ? '#2563eb' : accent === 'green' ? '#16a34a' : '#7c3aed',
                    }}
                  />
                  {accent}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button type="button" onClick={() => onSaveSettings(draft)} className="primary-button mt-6">
          Save preferences
        </button>
      </section>

      <section className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
        <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Categories</p>
        <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">Manage custom categories</h2>

        <form
          onSubmit={async (event) => {
            event.preventDefault()
            await onCreateCategory(categoryForm)
            setCategoryForm({ name: '', color: '#2563eb', emoji: '✨', type: 'expense' })
          }}
          className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr_auto]"
        >
          <input
            type="text"
            placeholder="Category name"
            value={categoryForm.name}
            onChange={(event) => setCategoryForm((current) => ({ ...current, name: event.target.value }))}
            className="field"
            required
          />
          <select
            value={categoryForm.type}
            onChange={(event) => setCategoryForm((current) => ({ ...current, type: event.target.value }))}
            className="field"
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
          <input
            type="color"
            value={categoryForm.color}
            onChange={(event) => setCategoryForm((current) => ({ ...current, color: event.target.value }))}
            className="field h-12"
          />
          <input
            type="text"
            maxLength="2"
            value={categoryForm.emoji}
            onChange={(event) => setCategoryForm((current) => ({ ...current, emoji: event.target.value }))}
            className="field"
          />
          <button type="submit" className="primary-button">
            Add category
          </button>
        </form>

        <div className="mt-6 space-y-3">
          {categories.map((category) => {
            const isDefault = DEFAULT_CATEGORIES.some(
              (item) => item.type === category.type && normalizeText(item.name) === normalizeText(category.name),
            )

            return (
              <div
                key={category.id}
                className="grid gap-3 rounded-3xl bg-[var(--surface-muted)] p-4 lg:grid-cols-[1.1fr_0.8fr_0.6fr_auto_auto]"
              >
                <input
                  type="text"
                  defaultValue={category.name}
                  onBlur={(event) => {
                    const nextName = event.target.value.trim()
                    if (nextName && nextName !== category.name) {
                      onUpdateCategory(category.id, { name: nextName })
                    }
                  }}
                  className="field"
                />
                <input
                  type="color"
                  defaultValue={category.color}
                  onBlur={(event) => onUpdateCategory(category.id, { color: event.target.value })}
                  className="field h-12"
                />
                <input
                  type="text"
                  defaultValue={category.emoji}
                  maxLength="2"
                  onBlur={(event) => onUpdateCategory(category.id, { emoji: event.target.value })}
                  className="field"
                />
                <div className="flex items-center text-sm capitalize text-[var(--text-secondary)]">{category.type}</div>
                <button
                  type="button"
                  onClick={() => !isDefault && onDeleteCategory(category)}
                  disabled={isDefault}
                  className={cn('text-sm', isDefault ? 'text-[var(--text-muted)]' : 'text-rose-500')}
                >
                  {isDefault ? 'Default' : 'Delete'}
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <section className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
        <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Session</p>
        <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">Account access</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{notice}</p>
        <button type="button" onClick={() => supabase.auth.signOut()} className="primary-button mt-6">
          Log out
        </button>
      </section>
    </div>
  )
}

function AuthScreen({ notice, onNotice }) {
  const [mode, setMode] = useState('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function handlePasswordAuth(event) {
    event.preventDefault()
    setLoading(true)

    try {
      const response =
        mode === 'sign-in'
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signUp({ email, password })

      if (response.error) throw response.error
      onNotice(mode === 'sign-in' ? 'Signed in successfully.' : 'Check your email to confirm your account.')
    } catch (error) {
      onNotice(error.message || 'Authentication failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handleMagicLink() {
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/` },
      })
      if (error) throw error
      onNotice('Magic link sent. Check your email inbox.')
    } catch (error) {
      onNotice(error.message || 'Unable to send magic link.')
    } finally {
      setLoading(false)
    }
  }

  async function handleForgotPassword() {
    setLoading(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (error) throw error
      onNotice('Password reset email sent.')
    } catch (error) {
      onNotice(error.message || 'Unable to send reset email.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.2),_transparent_30%),var(--bg-app)] px-4 py-12">
      <div className="grid w-full max-w-5xl gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[2.5rem] border border-[var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.65),rgba(255,255,255,0.18))] p-8 shadow-soft dark:bg-[linear-gradient(180deg,rgba(17,24,39,0.85),rgba(17,24,39,0.45))]">
          <p className="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Budget Flow</p>
          <h1 className="mt-4 max-w-lg text-4xl font-semibold tracking-tight text-[var(--text-primary)] md:text-5xl">
            A cleaner way to track every dollar.
          </h1>
          <p className="mt-4 max-w-xl text-base text-[var(--text-secondary)]">
            Sign in with email and password or use a magic link, then land directly on a dashboard built for fast budgeting.
          </p>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <FeatureChip title="Quick add" description="Income and expenses in a few taps." />
            <FeatureChip title="Goal tracking" description="Carry monthly contributions forward." />
            <FeatureChip title="CSV import" description="Preview Google Sheets rows before saving." />
          </div>
        </section>

        <section className="rounded-[2.5rem] border border-[var(--border-soft)] bg-[var(--surface)] p-8 shadow-soft">
          <div className="inline-flex rounded-full bg-[var(--surface-muted)] p-1 text-sm">
            {['sign-in', 'sign-up'].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  'rounded-full px-4 py-2 capitalize transition',
                  mode === value ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)]',
                )}
              >
                {value.replace('-', ' ')}
              </button>
            ))}
          </div>

          <form onSubmit={handlePasswordAuth} className="mt-6 space-y-4">
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email"
              className="field"
              required
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              className="field"
              required
            />
            <button type="submit" disabled={loading} className="primary-button w-full">
              {loading ? 'Working...' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">
            <div className="h-px flex-1 bg-[var(--border-soft)]" />
            <span>or</span>
            <div className="h-px flex-1 bg-[var(--border-soft)]" />
          </div>

          <button type="button" onClick={handleMagicLink} disabled={!email || loading} className="secondary-button w-full">
            Send Magic Link
          </button>

          <button type="button" onClick={handleForgotPassword} disabled={!email || loading} className="mt-4 text-sm text-[var(--accent-strong)]">
            Forgot password?
          </button>

          {notice && <p className="mt-6 text-sm text-[var(--text-secondary)]">{notice}</p>}
        </section>
      </div>
    </div>
  )
}

function ResetPasswordScreen({ canReset, notice, onNotice, onBack }) {
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleReset(event) {
    event.preventDefault()
    setLoading(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      onNotice('Password updated. You can sign in now.')
      onBack()
    } catch (error) {
      onNotice(error.message || 'Unable to reset password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-app)] px-4">
      <div className="w-full max-w-md rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-8 shadow-soft">
        <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Reset password</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">Choose a new password</h1>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          {canReset
            ? 'Set your new password below.'
            : 'Open the reset link from your email to create a secure recovery session.'}
        </p>

        <form onSubmit={handleReset} className="mt-6 space-y-4">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="New password"
            className="field"
            required
          />
          <button type="submit" disabled={!canReset || loading} className="primary-button w-full">
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>

        {notice && <p className="mt-4 text-sm text-[var(--text-secondary)]">{notice}</p>}
      </div>
    </div>
  )
}

function SummaryCard({ label, tone, value }) {
  const toneClass =
    tone === 'positive'
      ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
      : tone === 'negative'
        ? 'bg-rose-500/12 text-rose-700 dark:text-rose-300'
        : 'bg-[var(--surface-muted)] text-[var(--text-primary)]'

  return (
    <div className={cn('rounded-3xl p-5', toneClass)}>
      <p className="text-xs uppercase tracking-[0.3em]">{label}</p>
      <p className="mt-4 text-2xl font-semibold">{value}</p>
    </div>
  )
}

function FeatureChip({ description, title }) {
  return (
    <div className="rounded-3xl bg-[var(--surface)]/70 p-5 backdrop-blur">
      <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">{description}</p>
    </div>
  )
}

function ChartCard({ children, subtitle, title }) {
  return (
    <section className="rounded-[2rem] border border-[var(--border-soft)] bg-[var(--surface)] p-6 shadow-soft">
      <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">{title}</p>
      <h2 className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{subtitle}</h2>
      <div className="mt-6">{children}</div>
    </section>
  )
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-app)]">
      <div className="rounded-3xl border border-[var(--border-soft)] bg-[var(--surface)] px-6 py-5 text-sm text-[var(--text-secondary)] shadow-soft">
        Loading your budget workspace...
      </div>
    </div>
  )
}

async function ensureCategories(userId) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, user_id, name, color, emoji, type')
    .eq('user_id', userId)
    .order('name')

  if (error) throw error
  if (data?.length) return data

  const { data: inserted, error: insertError } = await supabase
    .from('categories')
    .insert(DEFAULT_CATEGORIES.map((category) => ({ ...category, user_id: userId })))
    .select('id, user_id, name, color, emoji, type')

  if (insertError) throw insertError
  return inserted ?? []
}

async function ensureSettings(userId) {
  const { data, error } = await supabase
    .from('settings')
    .select('id, user_id, theme, accent_color')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (data) return data

  const { data: inserted, error: insertError } = await supabase
    .from('settings')
    .insert({ user_id: userId, ...DEFAULT_THEME })
    .select('id, user_id, theme, accent_color')
    .single()

  if (insertError) throw insertError
  return inserted
}

function buildDashboardData(transactions) {
  const now = new Date()
  const monthStart = toDateInputValue(startOfMonth(now))
  const monthEnd = toDateInputValue(new Date(now.getFullYear(), now.getMonth() + 1, 0))
  const monthTransactions = transactions.filter(
    (transaction) => transaction.date >= monthStart && transaction.date <= monthEnd,
  )
  const monthlyIncome = monthTransactions
    .filter((transaction) => transaction.type === 'income')
    .reduce((sum, transaction) => sum + Number(transaction.amount), 0)
  const monthlyExpenses = monthTransactions
    .filter((transaction) => transaction.type === 'expense')
    .reduce((sum, transaction) => sum + Number(transaction.amount), 0)

  const weeks = buildMonthWeeks(now)
  const weeklyTotals = weeks.map((week) => {
    const total = monthTransactions
      .filter(
        (transaction) =>
          transaction.type === 'expense' && transaction.date >= week.start && transaction.date <= week.end,
      )
      .reduce((sum, transaction) => sum + Number(transaction.amount), 0)

    return { ...week, total }
  })

  const maxWeekly = Math.max(...weeklyTotals.map((week) => week.total), 1)
  const weeklyRecap = weeklyTotals.map((week) => ({
    label: week.label,
    total: week.total,
    percent: Math.max((week.total / maxWeekly) * 100, week.total ? 8 : 0),
  }))

  const categoryMap = new Map()
  monthTransactions
    .filter((transaction) => transaction.type === 'expense')
    .forEach((transaction) => {
      const key = slugKey(transaction.category?.name ?? 'Uncategorized')
      const current = categoryMap.get(key) ?? {
        name: transaction.category?.name ?? 'Uncategorized',
        value: 0,
        color: transaction.category?.color ?? '#64748b',
      }
      current.value += Number(transaction.amount)
      categoryMap.set(key, current)
    })

  const runningSeries = [...transactions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .reduce((series, transaction) => {
      const previousBalance = series.at(-1)?.balance ?? 0
      const delta = transaction.type === 'income' ? Number(transaction.amount) : -Number(transaction.amount)
      series.push({
        label: new Date(`${transaction.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        balance: previousBalance + delta,
      })
      return series
    }, [])

  return {
    monthlyIncome,
    monthlyExpenses,
    netBalance: monthlyIncome - monthlyExpenses,
    runningBalance: runningSeries.at(-1)?.balance ?? 0,
    weeklyRecap,
    weeklyBar: weeklyTotals,
    categorySpending: [...categoryMap.values()],
    runningSeries,
  }
}

function enrichGoals(goals, contributions) {
  return goals.map((goal) => {
    const goalContributions = contributions.filter((entry) => entry.goal_id === goal.id)
    return {
      ...goal,
      current_amount: Number(goal.current_amount || 0),
      target_amount: Number(goal.target_amount || 0),
      contributions: goalContributions,
      total_contributed: goalContributions.reduce((sum, entry) => sum + Number(entry.amount), 0),
      active_months: new Set(goalContributions.map((entry) => `${entry.year}-${entry.month}`)).size,
    }
  })
}

export default App
