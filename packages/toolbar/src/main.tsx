import React from 'react';
import ReactDOM from 'react-dom/client';
import QrWindow from './windows/QrWindow.js';
import './index.css';

// The toolbar has no main window — the tray menu is managed by Rust.
// This React app only renders the QR pairing window, identified by the
// window label set in tauri.conf.json.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QrWindow />
  </React.StrictMode>,
);
