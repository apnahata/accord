import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Button, ErrorNotice } from './components';
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
  const joining = new URLSearchParams(location.search).get('next')?.startsWith('/join/');
  return <div className="page step-room">
    <header className="step-head"><h1>{mode === 'register' ? (joining ? 'Sign up to join.' : 'Start with your name.') : 'Welcome back.'}</h1></header>
    <section className="step-card">
      <div className="segmented" aria-label="Account action"><button type="button" aria-pressed={mode === 'register'} onClick={() => setMode('register')}>New</button><button type="button" aria-pressed={mode === 'login'} onClick={() => setMode('login')}>I have an account</button></div>
      <form className="form-panel" onSubmit={submit}>
        {mode === 'register' && <><label htmlFor="auth-name">Your name</label><input id="auth-name" name="displayName" autoComplete="name" required maxLength={60} placeholder="Alex" /></>}
        <label htmlFor="auth-email">Email</label><input id="auth-email" name="email" type="email" autoComplete="email" required maxLength={254} />
        <label htmlFor="auth-password">Password</label><input id="auth-password" name="password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={10} maxLength={128} placeholder={mode === 'register' ? 'At least 10 characters' : ''} />
        <Button disabled={action.busy}>{action.busy ? 'Please wait…' : mode === 'register' ? 'Continue' : 'Sign in'}<ArrowRight size={17} /></Button>
      </form>
      <ErrorNotice error={action.error} />
    </section>
  </div>;
}
