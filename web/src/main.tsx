import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { NotificationProvider } from './components/GlobalNotifications.js';
import { ThemeProvider } from './theme.js';
import './index.css';
import 'streamdown/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <NotificationProvider>
        <App />
      </NotificationProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
