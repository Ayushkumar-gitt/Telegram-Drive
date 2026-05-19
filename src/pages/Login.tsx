import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { initTelegramClient } from '../lib/telegram'
import { toast } from 'react-hot-toast'
import { Cloud, Lock, Phone, Key, Hash } from 'lucide-react'

export const Login = () => {
  const [step, setStep] = useState<1 | 2>(1)
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [needsPassword, setNeedsPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const navigate = useNavigate()
  const { setCredentials, setSessionString } = useAuthStore()

  const [codeResolver, setCodeResolver] = useState<(value: string) => void>()
  const [passwordResolver, setPasswordResolver] = useState<(value: string) => void>()

  const handleStep1 = (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiId || !apiHash || !phone) {
      toast.error('Please fill in all fields')
      return
    }

    setCredentials(Number(apiId), apiHash)
    setStep(2)
    startTelegramAuth()
  }

  const startTelegramAuth = async () => {
    setIsLoading(true)
    try {
      const sessionString = await initTelegramClient(
        Number(apiId),
        apiHash,
        phone,
        () => new Promise<string>((resolve) => {
          setCodeResolver(() => resolve)
          setIsLoading(false)
        }),
        () => new Promise<string>((resolve) => {
          setNeedsPassword(true)
          setPasswordResolver(() => resolve)
          setIsLoading(false)
        })
      )

      setSessionString(sessionString)
      toast.success('Successfully authenticated!')
      navigate('/dashboard')
    } catch (error: any) {
      toast.error(error.message || 'Authentication failed')
      setStep(1)
    } finally {
      setIsLoading(false)
    }
  }

  const handleStep2 = (e: React.FormEvent) => {
    e.preventDefault()
    if (needsPassword && passwordResolver) {
      passwordResolver(password)
      setIsLoading(true)
    } else if (codeResolver) {
      codeResolver(code)
      setIsLoading(true)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-white dark:bg-gray-800 rounded-2xl shadow-xl overflow-hidden"
      >
        <div className="p-8 text-center bg-blue-600">
          <Cloud className="w-16 h-16 text-white mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white">Telegram Cloud</h1>
          <p className="text-blue-100 mt-2">Unlimited storage in your browser</p>
        </div>

        <div className="p-8">
          {step === 1 ? (
            <form onSubmit={handleStep1} className="space-y-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API ID</label>
                  <div className="relative">
                    <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      type="text"
                      value={apiId}
                      onChange={(e) => setApiId(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                      placeholder="e.g. 1234567"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Hash</label>
                  <div className="relative">
                    <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      type="password"
                      value={apiHash}
                      onChange={(e) => setApiHash(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                      placeholder="Your API Hash"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Phone Number</label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                      placeholder="+1234567890"
                    />
                  </div>
                </div>
              </div>
              <button
                type="submit"
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 rounded-lg transition-colors"
              >
                Continue
              </button>
              <p className="text-xs text-center text-gray-500 dark:text-gray-400">
                Get your credentials from <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">my.telegram.org</a>
              </p>
            </form>
          ) : (
            <form onSubmit={handleStep2} className="space-y-6">
              <div className="space-y-4">
                {!needsPassword ? (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Verification Code</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <input
                        type="text"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        placeholder="Enter code from Telegram"
                      />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">2FA Password</label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        placeholder="Your 2FA Password"
                      />
                    </div>
                  </div>
                )}
              </div>
              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium py-3 rounded-lg transition-colors"
              >
                {isLoading ? 'Verifying...' : 'Login'}
              </button>
            </form>
          )}
        </div>
      </motion.div>
    </div>
  )
}
