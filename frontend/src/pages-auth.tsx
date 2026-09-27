import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { Button, ErrorNotice, PageHeading, PrivateNote } from './components';
import { post } from './api';
import { useAction } from './hooks';
import type { AccountDTO } from './contracts';

function safeNext(search: string) {
  const value = new URLSearchParams(search).get('next');
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/me';
}

export function Auth() {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const location = useLocation();
  const navigate = useNavigate();
  const action = useAction();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      const body = { email: data.get('email'), password: data.get('password'), ...(mode === 'register' ? { displayName: data.get('displayName') } : {}) };
      await post<AccountDTO>(`/auth/${mode}`, body);
      navigate(safeNext(location.search), { replace: true });
    });
  }
  return <div className="page narrow"><PageHeading eyebrow="Your private Accord account" title={mode === 'register' ? 'Keep every trip in one place.' : 'Welcome back.'} description="Your account links your groups, approvals, bookings, and private payment records across browsers and devices." />
    <section className="panel form-panel">
      <div className="segmented" aria-label="Account action"><button type="button" aria-pressed={mode === 'register'} onClick={() => setMode('register')}>Create account</button><button type="button" aria-pressed={mode === 'login'} onClick={() => setMode('login')}>Sign in</button></div>
      <form onSubmit={submit}>
        {mode === 'register' && <><label htmlFor="auth-name">Display name</label><input id="auth-name" name="displayName" autoComplete="name" required maxLength={60} /></>}
        <label htmlFor="auth-email">Email</label><input id="auth-email" name="email" type="email" autoComplete="email" required maxLength={254} />
        <label htmlFor="auth-password">Password</label><input id="auth-password" name="password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={10} maxLength={128} />
        {mode === 'register' && <p className="field-help">Use at least 10 characters.</p>}
        <Button disabled={action.busy}>{action.busy ? 'Please wait…' : mode === 'register' ? 'Create my account' : 'Sign in'}<ArrowRight size={17} /></Button>
      </form>
      <ErrorNotice error={action.error} />
      <PrivateNote />
      <p className="fine"><LockKeyhole size={13} /> Passwords are salted and hashed. Your private requirements are encrypted before MongoDB storage.</p>
    </section>
    <Link className="text-button" to="/">Back to Accord</Link>
  </div>;
}
