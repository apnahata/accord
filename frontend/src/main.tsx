import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Plus, Users } from 'lucide-react';
import { Brand, Button } from './components';
import { Landing, NewRoom, JoinRoom, JoinEntry } from './pages-entry';
import { Summary } from './pages-private';
import { Intake } from './pages-intake';
import { Room, Offers, Proposal, Receipt, Merchant } from './pages-group';
import { Account } from './pages-account';
import { Auth } from './pages-auth';
import { Pulse } from './pages-pulse';
import { post } from './api';
import { useAction, useResource } from './hooks';
import type { AccountDTO } from './contracts';
import './styles.css';

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const account = useResource<AccountDTO>('/me', location.key);
  const signedIn = account.data?.user.email ? account.data : undefined;
  const signOut = useAction();
  useEffect(() => { window.scrollTo(0, 0); document.querySelector<HTMLElement>('#main')?.focus(); }, [location.pathname]);
  return <>
    <a href="#main" className="skip-link">Skip to content</a>
    <header className="site-header"><Brand /><nav aria-label="Main navigation">
      {signedIn ? <>
        <Link to="/me">Dashboard</Link>
        <Link to="/rooms/new"><Plus size={14} />New group</Link>
        <Link to="/join"><Users size={14} />Join</Link>
        <span className="account-name">{signedIn.user.displayName}</span>
        <Button className="nav-signout" aria-label="Sign out" disabled={signOut.busy} onClick={() => signOut.run(async () => { await post('/logout'); navigate('/auth', { replace: true }); })}><LogOut size={15} /></Button>
      </> : <>
        <a className="how-link" href="/#how-it-works">How it works</a>
        <Link to="/auth?next=%2Fme">Sign in</Link>
        <Link to="/auth?next=%2Frooms%2Fnew" className="nav-join">Create account</Link>
      </>}
    </nav></header>
    <main id="main" tabIndex={-1}><Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/auth" element={<Auth />} />
      <Route path="/me" element={<Account />} />
      <Route path="/rooms/new" element={<NewRoom />} />
      <Route path="/join" element={<JoinEntry />} />
      <Route path="/join/:inviteToken" element={<JoinRoom />} />
      <Route path="/rooms/:roomId" element={<Room />} />
      <Route path="/rooms/:roomId/offers" element={<Offers />} />
      <Route path="/rooms/:roomId/me/intake" element={<Intake />} />
      <Route path="/rooms/:roomId/me/summary" element={<Summary />} />
      <Route path="/rooms/:roomId/receipt" element={<Receipt />} />
      <Route path="/proposals/:proposalId" element={<Proposal />} />
      <Route path="/proposals/:proposalId/me" element={<Proposal privateView />} />
      <Route path="/demo/merchant" element={<Merchant />} />
      <Route path="/rooms/:roomId/demo/merchant" element={<Merchant />} />
      <Route path="/pulse" element={<Pulse />} />
      <Route path="*" element={<div className="page narrow"><h1>A little off course.</h1><p>This page doesn’t exist.</p><Link to="/" className="button">Return home</Link></div>} />
    </Routes></main>
    <footer className="site-footer"><Brand /><span>Good plans start with common ground.</span><Link to="/pulse" className="footer-link">Market pulse</Link><span className="footer-note">Personal boundaries. Shared possibilities.</span></footer>
  </>;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="page narrow"><h1>We lost our place.</h1><p>Please reload to retrieve the latest state. No payment or booking success has been confirmed.</p><button className="button" onClick={() => window.location.reload()}>Reload Accord</button></div> : this.props.children; }
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><BrowserRouter><App /></BrowserRouter></ErrorBoundary></React.StrictMode>);
