import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useFileSystemStore } from '../store/filesystem'
import { initTelegramClient, resetClient } from '../lib/telegram'
import { toast } from 'react-hot-toast'
import {
  Cloud, Lock, Phone, User, ArrowLeft,
  Sparkles, Loader2
} from 'lucide-react'

type Mode = 'choose' | 'tg-signin' | 'tg-signup' | 'otp'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

// ── API helpers ───────────────────────────────────────────────────────────────

/** Fetch admin API_ID and API_HASH from the server */
async function fetchTgCredentials(): Promise<{ apiId: number; apiHash: string }> {
  const res = await fetch(`${API_BASE}/api/tg-credentials`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to fetch credentials')
  return data
}

/** Register a Telegram user profile (userId, apiId, apiHash, phone) */
async function apiTgRegister(userId: string, apiId: number, apiHash: string, phone: string) {
  const res = await fetch(`${API_BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, apiId, apiHash, phone }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Registration failed')
  return data
}

/** Look up a Telegram user's stored profile by userId */
async function apiTgLookup(userId: string): Promise<{ apiId: number; apiHash: string; phone: string } | null> {
  const res = await fetch(`${API_BASE}/api/lookup?userId=${encodeURIComponent(userId)}`)
  if (res.status === 404) return null
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Lookup failed')
  return data
}

// ── Component ─────────────────────────────────────────────────────────────────
export const Login = () => {
  const [mode, setMode] = useState<Mode>('choose')
  const [isLoading, setIsLoading] = useState(false)

  // Telegram auth fields
  const [tgUserId, setTgUserId] = useState('')
  const [phone, setPhone] = useState('')

  // OTP
  const [code, setCode] = useState('')
  const [tgPassword, setTgPassword] = useState('')
  const [needsPassword, setNeedsPassword] = useState(false)
  const [codeResolver, setCodeResolver] = useState<((v: string) => void) | undefined>()
  const [passwordResolver, setPasswordResolver] = useState<((v: string) => void) | undefined>()

  const navigate = useNavigate()
  const { saveProfile, setCredentials, setSessionString } = useAuthStore()
  const { clearForNewSession } = useFileSystemStore()

  // ── Telegram Sign In (returning user — only needs User ID) ──────────────
  const handleTgSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    const uid = tgUserId.trim()
    if (!uid) { toast.error('Enter your User ID'); return }
    setIsLoading(true)
    try {
      const profile = await apiTgLookup(uid)
      if (!profile) { toast.error('User ID not found. Please create an account first.'); setIsLoading(false); return }
      resetClient()
      clearForNewSession()
      setCredentials(profile.apiId, profile.apiHash, profile.phone)
      await startTgAuth(profile.apiId, profile.apiHash, profile.phone, uid)
    } catch (err: any) {
      toast.error(err.message || 'Could not reach server.')
      setIsLoading(false)
    }
  }

  // ── Telegram Sign Up (new user — needs User ID + Phone) ─────────────────
  const handleTgSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    const uid = tgUserId.trim()
    if (!uid || !phone) { toast.error('Please fill in all fields'); return }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(uid)) { toast.error('User ID: 3–20 chars, letters/numbers/underscore only'); return }
    setIsLoading(true)
    try {
      // Fetch admin API credentials from the server (user never sees these)
      const creds = await fetchTgCredentials()
      await apiTgRegister(uid, creds.apiId, creds.apiHash, phone)
      resetClient()
      clearForNewSession()
      setCredentials(creds.apiId, creds.apiHash, phone)
      await startTgAuth(creds.apiId, creds.apiHash, phone, uid)
    } catch (err: any) {
      toast.error(err.message || 'Registration failed')
      setIsLoading(false)
    }
  }

  // ── Core Telegram auth ───────────────────────────────────────────────────
  const startTgAuth = async (aid: number, ahash: string, ph: string, uid: string) => {
    setMode('otp')
    setIsLoading(true)
    try {
      const sessionString = await initTelegramClient(
        aid, ahash, ph,
        () => new Promise<string>(resolve => { setCodeResolver(() => resolve); setIsLoading(false) }),
        () => new Promise<string>(resolve => { setNeedsPassword(true); setPasswordResolver(() => resolve); setIsLoading(false) })
      )
      saveProfile({ userId: uid, apiId: aid, apiHash: ahash, phone: ph, createdAt: Date.now() })
      setSessionString(sessionString)
      toast.success(`Welcome, ${uid}!`)
      navigate('/dashboard', { replace: true })
    } catch (err: any) {
      toast.error(err.message || 'Authentication failed')
      setMode('tg-signin')
    } finally { setIsLoading(false) }
  }

  const handleOtp = (e: React.FormEvent) => {
    e.preventDefault()
    if (needsPassword && passwordResolver) {
      passwordResolver(tgPassword.trim())
      setIsLoading(true)
    } else if (codeResolver) {
      const trimmed = code.trim()
      if (!trimmed) { toast.error('Enter the code from Telegram'); return }
      codeResolver(trimmed)
      setIsLoading(true)
    }
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
        </div>

        <div className="p-8 pt-4">
          <AnimatePresence mode="wait">

            {/* ── CHOOSE ─────────────────────────────────────────────────────── */}
            {mode === 'choose' && (
              <motion.div key="choose" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-3">
                <button onClick={() => setMode('tg-signup')}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/10 hover:border-white/30 hover:bg-white/5 transition-all text-left">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-white/10 border border-white/20">
                    <Sparkles className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <div className="font-semibold text-white text-sm">Create Account</div>
                    <div className="text-xs text-white/40 mt-0.5">Sign up with your phone number — files stored in your Telegram</div>
                  </div>
                </button>

                <button onClick={() => setMode('tg-signin')}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/10 hover:border-white/30 hover:bg-white/5 transition-all text-left">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-white/10 border border-white/20">
                    <User className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <div className="font-semibold text-white text-sm">Sign In</div>
                    <div className="text-xs text-white/40 mt-0.5">Already have an account? Enter your User ID</div>
                  </div>
                </button>
              </motion.div>
            )}

            {/* ── TG SIGN UP (Phone + OTP, no API ID/Hash needed) ──────────── */}
            {mode === 'tg-signup' && (
              <motion.div key="tg-signup" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <button onClick={() => setMode('choose')} className="flex items-center gap-2 text-white/40 hover:text-white text-xs mb-6 transition-colors">
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <h2 className="text-lg font-semibold text-white mb-1">Create your account</h2>
                <p className="text-sm text-white/40 mb-5">Files will be stored securely in your own Telegram account</p>
                <form onSubmit={handleTgSignUp} className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-white/40 mb-1 ml-1">Choose a User ID <span className="text-white/20">(3–20 chars)</span></label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                      <input type="text" value={tgUserId} onChange={e => setTgUserId(e.target.value)} className={inputCls} placeholder="e.g. ayush_123" autoFocus />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-white/40 mb-1 ml-1">Phone Number</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                      <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} className={inputCls} placeholder="+91 9876543210" />
                    </div>
                  </div>
                  <div className="pt-1">
                    <button type="submit" disabled={isLoading} className={primaryBtn}>
                      {isLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating account…</> : 'Create Account →'}
                    </button>
                  </div>
                  <p className="text-xs text-center text-white/25 pt-1">
                    Already have an account?{' '}
                    <button type="button" onClick={() => setMode('tg-signin')} className="text-white hover:text-neutral-300 underline underline-offset-2">Sign in</button>
                  </p>
                </form>
              </motion.div>
            )}

            {/* ── TG SIGN IN ─────────────────────────────────────────────────── */}
            {mode === 'tg-signin' && (
              <motion.div key="tg-signin" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <button onClick={() => setMode('choose')} className="flex items-center gap-2 text-white/40 hover:text-white text-xs mb-6 transition-colors">
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <h2 className="text-lg font-semibold text-white mb-1">Welcome back</h2>
                <p className="text-sm text-white/40 mb-6">Enter your User ID — we'll send an OTP to your Telegram</p>
                <form onSubmit={handleTgSignIn} className="space-y-4">
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                    <input type="text" value={tgUserId} onChange={e => setTgUserId(e.target.value)} className={inputCls} placeholder="Your User ID e.g. ayush_123" autoFocus />
                  </div>
                  <button type="submit" disabled={isLoading} className={primaryBtn}>
                    {isLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Looking up…</> : 'Continue →'}
                  </button>
                </form>
                <p className="text-xs text-center text-white/25 mt-4">
                  New here?{' '}
                  <button onClick={() => setMode('tg-signup')} className="text-white hover:text-neutral-300 underline underline-offset-2">Create account</button>
                </p>
              </motion.div>
            )}

            {/* ── OTP ────────────────────────────────────────────────────────── */}
            {mode === 'otp' && (
              <motion.div key="otp" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <div className="text-center mb-6">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center bg-white/10 border border-white/20">
                    {needsPassword ? <Lock className="w-8 h-8 text-white" /> : <Phone className="w-8 h-8 text-white" />}
                  </div>
                  <h2 className="text-lg font-semibold text-white">{needsPassword ? 'Two-Factor Auth' : 'Check Telegram'}</h2>
                  <p className="text-sm text-white/40 mt-1">
                    {needsPassword ? 'Enter your 2FA password to continue' : 'Enter the code sent to your Telegram app'}
                  </p>
                </div>
                <form onSubmit={handleOtp} className="space-y-4">
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                    {needsPassword
                      ? <input type="password" value={tgPassword} onChange={e => setTgPassword(e.target.value)} className={inputCls} placeholder="2FA Password" autoFocus />
                      : <input type="text" value={code} onChange={e => setCode(e.target.value)} className={inputCls} placeholder="5-digit code" autoFocus inputMode="numeric" maxLength={6} />
                    }
                  </div>
                  <button type="submit" disabled={isLoading} className={primaryBtn}>
                    {isLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Verifying…</> : 'Verify & Sign In →'}
                  </button>
                </form>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </motion.div>

      <div style={{
        position: 'fixed',
        bottom: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        fontFamily: 'monospace',
        fontSize: '11px',
        color: 'rgba(255, 255, 255, 0.8)',
        letterSpacing: '0.15em',
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 50,
        whiteSpace: 'nowrap',
      }}>
        MADE BY AYUSH
      </div>
    </div>
  )
}
