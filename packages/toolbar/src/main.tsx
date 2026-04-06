import React from 'react';
import ReactDOM from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import QrWindow from './windows/QrWindow.js';
import SetupWindow from './windows/SetupWindow.js';
import './index.css';

// Route by Tauri window label — the toolbar has no main window,
// only purpose-specific windows opened from Rust.
const label = getCurrentWindow().label;

const Window = label === 'setup' ? SetupWindow : QrWindow;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Window />
  </React.StrictMode>,
);
