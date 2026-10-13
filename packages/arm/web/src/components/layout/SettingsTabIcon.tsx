import { Bell, Info, Mic, Settings } from 'lucide-react';

/** Settings toolbar glyphs use native-sized ink, independently of tab labels. */
export function SettingsTabIcon({ name }: { name: string }) {
  const line = { size: 23, strokeWidth: 1.8, 'aria-hidden': true } as const;
  if (name === 'General') return <Settings {...line} />;
  if (name === 'Voice Input') return <Mic {...line} />;
  if (name === 'Notifications') return <Bell {...line} />;
  if (name === 'About') return <Info {...line} />;
  return (
    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {name === 'Account' ? <>
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
        <ellipse cx="12" cy="9" rx="3.4" ry="4" fill="currentColor" />
        <path d="M4.5 18.5C5.5 13.5 18.5 13.5 19.5 18.5A10 10 0 0 1 4.5 18.5Z" fill="currentColor" />
      </> : name === 'Devices' ? <>
        <path d="M2 18V4.5Q2 3 3.5 3H18Q19 3 19 4.5M1 19H16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <rect x="17" y="6" width="6" height="14" rx="1" stroke="currentColor" strokeWidth="1.6" />
        <path d="M19 8H21" stroke="currentColor" strokeWidth="1" />
      </> : <>
        <rect x="1" y="3" width="22" height="15" rx="1" stroke="currentColor" strokeWidth="1.7" fill="currentColor" fillOpacity=".25" />
        <path d="M8 18H16V21H18V23H6V21H8Z" fill="currentColor" />
      </>}
    </svg>
  );
}
