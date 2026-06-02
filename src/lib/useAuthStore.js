// Lightweight auth store — no external dependency.
// Swap signIn/signOut for Firebase, Supabase, or a JWT endpoint.
// The user shape and hook API stay the same — nothing else needs to change.

import React, { useState, useCallback, createContext, useContext } from 'react';
import { appendActivity } from './localOs';
import { seedDemoState } from './platformOps';
import { isDemoAuthAllowed, PRE_API_SECURITY_MODE } from './preApiSecurity';

const AuthStoreContext = createContext(null);
const SESSION_KEY = 'av.session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// ── Demo accounts (replace with real auth before production) ──────────────
const DEMO_USERS = {
  'ADMIN':        { role: 'admin',     name: 'Admin',             redirect: '/admin',             status: 'active', canonical: 'ADMIN001' },
  'ADMIN001':     { role: 'admin',     name: 'Admin',             redirect: '/admin',             status: 'active', canonical: 'ADMIN001' },
  'ADMIN0001':    { role: 'admin',     name: 'Admin',             redirect: '/admin',             status: 'active', canonical: 'ADMIN001' },
  'CLIENT':       { role: 'client',    name: 'Sarah',             redirect: '/members/dashboard', status: 'active', canonical: 'CLIENT001' },
  'CLIENT001':    { role: 'client',    name: 'Sarah',             redirect: '/members/dashboard', status: 'active', canonical: 'CLIENT001' },
  'CLIENT0001':   { role: 'client',    name: 'Sarah',             redirect: '/members/dashboard', status: 'active', canonical: 'CLIENT001' },
  'NURSE':        { role: 'provider',  name: 'Stephanie R.',      redirect: '/provider/shift',    status: 'active', canonical: 'NURSE001' },
  'NURSE001':     { role: 'provider',  name: 'Stephanie R.',      redirect: '/provider/shift',    status: 'active', canonical: 'NURSE001' },
  'NURSE0001':    { role: 'provider',  name: 'Stephanie R.',      redirect: '/provider/shift',    status: 'active', canonical: 'NURSE001' },
  'NP':           { role: 'np',        name: 'Mobile GFE NP',     redirect: '/provider/role-os',  status: 'active', canonical: 'NP001' },
  'NP001':        { role: 'np',        name: 'Mobile GFE NP',     redirect: '/provider/role-os',  status: 'active', canonical: 'NP001' },
  'NP0001':       { role: 'np',        name: 'Mobile GFE NP',     redirect: '/provider/role-os',  status: 'active', canonical: 'NP001' },
  'MD':           { role: 'physician', name: 'Medical Director',  redirect: '/provider/role-os',  status: 'active', canonical: 'MD001' },
  'MD001':        { role: 'physician', name: 'Medical Director',  redirect: '/provider/role-os',  status: 'active', canonical: 'MD001' },
  'MD0001':       { role: 'physician', name: 'Medical Director',  redirect: '/provider/role-os',  status: 'active', canonical: 'MD001' },
  'PHYSICIAN':    { role: 'physician', name: 'Medical Director',  redirect: '/provider/role-os',  status: 'active', canonical: 'PHYSICIAN001' },
  'PHYSICIAN001': { role: 'physician', name: 'Medical Director',  redirect: '/provider/role-os',  status: 'active', canonical: 'PHYSICIAN001' },
  'PHYSICIAN0001': { role: 'physician', name: 'Medical Director', redirect: '/provider/role-os',  status: 'active', canonical: 'PHYSICIAN001' },
};
const DEMO_PASSWORD = import.meta.env.VITE_AVALON_DEMO_PASSWORD || '';
// ─────────────────────────────────────────────────────────────────────────

function normalizeLoginIdentifier(value = '') {
  return String(value).trim().replace(/\s+/g, '').toUpperCase();
}

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const session = raw ? JSON.parse(raw) : null;
    if (!session) return null;
    if (session.expiresAt && Date.now() > new Date(session.expiresAt).getTime()) {
      sessionStorage.removeItem(SESSION_KEY);
      appendActivity('Session expired', { role: session.role, username: session.username });
      return null;
    }
    return session;
  } catch { return null; }
}

function writeSession(user) {
  try {
    if (user) sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* private mode — non-fatal */ }
}

function createSessionId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  if (cryptoApi?.getRandomValues) {
    const values = cryptoApi.getRandomValues(new Uint32Array(2));
    const token = Array.from(values, (value) => value.toString(36)).join('');
    return `session-${Date.now()}-${token}`;
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function AuthStoreProvider({ children }) {
  const [user, setUser]       = useState(() => readSession());
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const signIn = useCallback(async ({ email, password }) => {
    setLoading(true);
    setError(null);
    try {
      await new Promise((r) => setTimeout(r, 600)); // simulate network

      if (!isDemoAuthAllowed()) {
        throw new Error('Local demo auth is disabled outside Avalon simulation mode.');
      }
      if (!DEMO_PASSWORD) {
        throw new Error('Demo auth password is not configured. Set VITE_AVALON_DEMO_PASSWORD for local simulation.');
      }

      // Match against demo roster (case-insensitive username)
      const submittedUsername = normalizeLoginIdentifier(email);
      const usernameKey = Object.keys(DEMO_USERS).find(
        (k) => normalizeLoginIdentifier(k) === submittedUsername
      );

      if (!usernameKey || String(password || '').trim() !== DEMO_PASSWORD) {
        throw new Error('Invalid username or password.');
      }

      const profile = DEMO_USERS[usernameKey];
      if (profile.status === 'suspended') throw new Error('Account suspended. Contact support at hello@avalonvitality.co');
      if (profile.status === 'archived') throw new Error('This account is no longer active.');
      const sessionUser = {
        id:       createSessionId(),
        username: usernameKey,
        canonicalUsername: profile.canonical || usernameKey,
        name:     profile.name,
        role:     profile.role,
        redirect: profile.redirect,
        seededAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        authMode: PRE_API_SECURITY_MODE.mode,
        mfa: 'placeholder',
        securityWall: 'pre-api-hard-wall',
      };

      seedDemoState(profile.canonical || usernameKey);
      setUser(sessionUser);
      writeSession(sessionUser);
      appendActivity('Signed in', { role: sessionUser.role, username: usernameKey, authMode: sessionUser.authMode });
      return { ok: true, user: sessionUser };
    } catch (err) {
      const msg = err.message || 'Sign in failed.';
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      setLoading(false);
    }
  }, []);

  const requestPasswordReset = useCallback(async () => {
    setLoading(true);
    try {
      throw new Error('Password reset is not connected yet. Use admin-assisted account recovery until Supabase Auth is live.');
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(() => {
    if (user) appendActivity('Signed out', { role: user.role, username: user.username });
    setUser(null);
    writeSession(null);
  }, [user]);

  return React.createElement(
    AuthStoreContext.Provider,
    { value: { user, loading, error, signIn, signOut, requestPasswordReset } },
    children
  );
}

export function useAuthStore() {
  const ctx = useContext(AuthStoreContext);
  if (!ctx) throw new Error('useAuthStore must be inside AuthStoreProvider');
  return ctx;
}
