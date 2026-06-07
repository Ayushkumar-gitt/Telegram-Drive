import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useFileSystemStore } from '../store/filesystem'
import { resetClient } from '../lib/telegram'
import { toast } from 'react-hot-toast'
import {
  Cloud, Lock, Mail, User, ArrowLeft,
  LogIn, Loader2, Eye, EyeOff
} from 'lucide-react'

type Mode = 'choose' | 'signup' | 'login'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiSimpleRegister(userId: string, email: string, password: string) {
  const res = await fetch(`${API_BASE}/api/user-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, email, password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Registration failed')
  return data
}

async function apiSimpleLogin(email: string, password: string) {
  const res = await fetch(`${API_BASE}/api/user-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Login failed')
  return data as { userId: string }
}

// ── Component ─────────────────────────────────────────────────────────────────
export const SimpleLogin = () => {
  const [mode, setMode] = useState<Mode>('choose')
  const [isLoading, setIsLoading] = useState(false)
  const [showPass, setShowPass] = useState(false)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newUserId, setNewUserId] = useState('')

  const navigate = useNavigate()
  const { setSimpleSession } = useAuthStore()
  const { clearForNewSession } = useFileSystemStore()

  // ── Simple Sign Up ───────────────────────────────────────────────────────
  const handleSimpleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newUserId.trim() || !email.trim() || !password) { toast.error('Fill in all fields'); return }
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(newUserId.trim())) {
      toast.error('User ID: 3–30 chars, letters/numbers/underscore only'); return
    }
    if (password.length < 6) { toast.error('Password must be at least 6 characters'); return }
    setIsLoading(true)
    try {
      await apiSimpleRegister(newUserId.trim(), email.trim(), password)
      toast.success('Account created! Please sign in.')
      setMode('login')
      setEmail(email.trim())
      setPassword('')
    } catch (err: any) {
      toast.error(err.message || 'Registration failed')
    } finally { setIsLoading(false) }
  }

  // ── Simple Login ─────────────────────────────────────────────────────────
  const handleSimpleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) { toast.error('Enter email and password'); return }
    setIsLoading(true)
    try {
      const data = await apiSimpleLogin(email.trim(), password)
      resetClient()
      clearForNewSession()
      setSimpleSession(data.userId, 0, '', '')
      toast.success(`Welcome back, ${data.userId}!`)
      navigate('/dashboard', { replace: true })
    } catch (err: any) {
      toast.error(err.message || 'Login failed')
    } finally { setIsLoading(false) }
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  const inputCls = 'w-full pl-10 pr-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 transition-all text-sm'
  const primaryBtn = 'w-full py-3 rounded-xl font-semibold bg-white text-black hover:bg-neutral-200 transition-all disabled:opacity-50 flex items-center justify-center gap-2 text-sm shadow-[0_0_20px_rgba(255,255,255,0.1)]'

  const cardStyle = {
    background: 'rgba(255,255,255,0.04)',
    backdropFilter: 'blur(24px)',
    borderRadius: '24px',
    border: '1px solid rgba(255,255,255,0.09)',
    boxShadow: '0 32px 64px rgba(0,0,0,0.55)',
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden" style={{ background: '#050505' }}>
      <div className="absolute top-[-10%] left-[-5%] w-96 h-96 rounded-full blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.07), transparent)' }} />
      <div className="absolute bottom-[-10%] right-[-5%] w-96 h-96 rounded-full blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(120,120,120,0.04), transparent)' }} />

      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}
        className="relative w-full max-w-md" style={cardStyle}>

        {/* Logo */}
        <div className="p-8 pb-4 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center bg-white/10 border border-white/20">
            <Cloud className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">Cloud Space</h1>
          <p className="text-sm text-white/40">Shared storage — invite only</p>
        </div>

        <div className="p-8 pt-4">
          <AnimatePresence mode="wait">

            {/* ── CHOOSE ─────────────────────────────────────────────────────── */}
            {mode === 'choose' && (
              <motion.div key="choose" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-3">
                <button onClick={() => setMode('signup')}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/10 hover:border-white/30 hover:bg-white/5 transition-all text-left">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-white/10 border border-white/20">
                    <Mail className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <div className="font-semibold text-white text-sm">Sign Up with Email</div>
                    <div className="text-xs text-white/40 mt-0.5">No Telegram needed — store on shared cloud</div>
                  </div>
                </button>

                <button onClick={() => setMode('login')}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/10 hover:border-white/30 hover:bg-white/5 transition-all text-left">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-white/10 border border-white/20">
                    <LogIn className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <div className="font-semibold text-white text-sm">Sign In</div>
                    <div className="text-xs text-white/40 mt-0.5">Already have an account? Sign in with email & password</div>
                  </div>
                </button>
              </motion.div>
            )}

            {/* ── SIMPLE SIGN UP ─────────────────────────────────────────────── */}
            {mode === 'signup' && (
              <motion.div key="signup" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <button onClick={() => setMode('choose')} className="flex items-center gap-2 text-white/40 hover:text-white text-xs mb-6 transition-colors">
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <h2 className="text-lg font-semibold text-white mb-1">Create your account</h2>
                <p className="text-sm text-white/40 mb-6">No Telegram needed — get storage instantly</p>
                <form onSubmit={handleSimpleSignup} className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-white/40 mb-1 ml-1">User ID <span className="text-white/20">(3–30 chars, a-z 0-9 _)</span></label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                      <input type="text" value={newUserId} onChange={e => setNewUserId(e.target.value)} className={inputCls} placeholder="e.g. ayush_123" autoFocus />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-white/40 mb-1 ml-1">Email</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                      <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="you@example.com" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-white/40 mb-1 ml-1">Password <span className="text-white/20">(min 6 chars)</span></label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                      <input type={showPass ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className={inputCls + ' pr-10'} placeholder="••••••••" />
                      <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60">
                        {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="pt-1">
                    <button type="submit" disabled={isLoading} className={primaryBtn}>
                      {isLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating account…</> : 'Create Account →'}
                    </button>
                  </div>
                  <p className="text-xs text-center text-white/25 pt-1">
                    Already have an account?{' '}
                    <button type="button" onClick={() => setMode('login')} className="text-white hover:text-neutral-300 underline underline-offset-2">Sign in</button>
                  </p>
                </form>
              </motion.div>
            )}

            {/* ── SIMPLE LOGIN ───────────────────────────────────────────────── */}
            {mode === 'login' && (
              <motion.div key="login" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <button onClick={() => setMode('choose')} className="flex items-center gap-2 text-white/40 hover:text-white text-xs mb-6 transition-colors">
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <h2 className="text-lg font-semibold text-white mb-1">Welcome back</h2>
                <p className="text-sm text-white/40 mb-6">Sign in with your email and password</p>
                <form onSubmit={handleSimpleLogin} className="space-y-3">
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="you@example.com" autoFocus />
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                    <input type={showPass ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className={inputCls + ' pr-10'} placeholder="••••••••" />
                    <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60">
                      {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <div className="pt-1">
                    <button type="submit" disabled={isLoading} className={primaryBtn}>
                      {isLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</> : 'Sign In →'}
                    </button>
                  </div>
                  <p className="text-xs text-center text-white/25 pt-1">
                    New here?{' '}
                    <button type="button" onClick={() => setMode('signup')} className="text-white hover:text-neutral-300 underline underline-offset-2">Create account</button>
                  </p>
                </form>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}
