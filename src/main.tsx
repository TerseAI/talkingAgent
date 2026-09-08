import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startBrowserLogs } from './browser-logs';
import '@fontsource-variable/manrope';
import './styles.css';

startBrowserLogs();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
