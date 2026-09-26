import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { LockKeyhole, ArrowUpRight } from 'lucide-react';
import { Brand } from './components';
import { Landing, NewRoom, JoinRoom, JoinEntry } from './pages-entry';
import { Summary } from './pages-private';
import { Intake } from './pages-intake';
import { Room, Offers, Proposal, Receipt, Merchant } from './pages-group';
import { Pulse } from './pages-pulse';
import './styles.css';

function App() {
  const location = useLocation();
  const privatePage = location.pathname.includes('/me');
  useEffect(() => { window.scrollTo(0, 0); document.querySelector<HTMLElement>('#main')?.focus(); }, [location.pathname]);
  return <><a href="#main" className="skip-link">Skip to content</a><header className="site-header"><Brand /><nav aria-label="Main navigation">{privatePage ? <span className="private-pill"><LockKeyhole size={14} />Your private space</span> : <><a className="how-link" href="/#how-it-works">How it works</a><Link to="/join" className="nav-join">Join a group <ArrowUpRight size={15} /></Link></>}</nav></header><main id="main" tabIndex={-1}><Routes><Route path="/" element={<Landing />} /><Route path="/rooms/new" element={<NewRoom />} /><Route path="/join" element={<JoinEntry />} /><Route path="/join/:inviteToken" element={<JoinRoom />} /><Route path="/rooms/:roomId" element={<Room />} /><Route path="/rooms/:roomId/offers" element={<Offers />} /><Route path="/rooms/:roomId/me/intake" element={<Intake />} /><Route path="/rooms/:roomId/me/summary" element={<Summary />} /><Route path="/rooms/:roomId/receipt" element={<Receipt />} /><Route path="/proposals/:proposalId" element={<Proposal />} /><Route path="/proposals/:proposalId/me" element={<Proposal privateView />} /><Route path="/demo/merchant" element={<Merchant />} /><Route path="/pulse" element={<Pulse />} /><Route path="*" element={<div className="page narrow"><h1>A little off course.</h1><p>This page doesn’t exist.</p><Link to="/" className="button">Return home</Link></div>} /></Routes></main><footer className="site-footer"><Brand /><span>Good plans start with common ground.</span><Link to="/pulse" className="footer-link">Market pulse</Link><span className="footer-note"><LockKeyhole size={13} />Personal boundaries. Shared possibilities.</span></footer></>;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="page narrow"><h1>We lost our place.</h1><p>Please reload to retrieve the latest state. No payment or booking success has been confirmed.</p><button className="button" onClick={() => window.location.reload()}>Reload Accord</button></div> : this.props.children; }
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><BrowserRouter><App /></BrowserRouter></ErrorBoundary></React.StrictMode>);
