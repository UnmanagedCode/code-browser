import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createViewerSocket } from './socket';
import './styles.css';

// Standalone only: follow the OS theme. Embedded in cc, the bridge has already set data-cc-theme and owns the dark class.
const root = document.documentElement;
if (!root.hasAttribute('data-cc-theme')) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => root.classList.toggle('dark', mq.matches);
  apply();
  mq.addEventListener('change', apply);
}

// One id per browser tab: control is held by this id, so a reload keeps it.
const VIEWER_KEY = 'code-browser:viewerId';
function viewerId(): string {
  const existing = sessionStorage.getItem(VIEWER_KEY);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16)); // randomUUID needs a secure context; a LAN http page has none
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem(VIEWER_KEY, id);
  return id;
}

const url = new URL('api/ws', location.href);
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = createViewerSocket({ url: url.href, viewerId: viewerId() });

createRoot(document.getElementById('root')!).render(<StrictMode><App socket={socket} /></StrictMode>);
