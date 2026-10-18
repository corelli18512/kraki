import { Bell, Info, Mic, Monitor, MonitorSmartphone, Settings, UserRound } from 'lucide-react';

/** Keep the existing toolbar glyphs outside the Windows category navigation. */
export function SettingsTabIcon({ name, windows = false }: { name: string; windows?: boolean }) {
  if (windows) {
    const Icon = name === 'General' ? Settings : name === 'Account' ? UserRound : name === 'Voice Input' ? Mic
      : name === 'Notifications' ? Bell : name === 'This PC' ? Monitor : name === 'Devices' ? MonitorSmartphone : Info;
    return <Icon size={19} strokeWidth={1.6} aria-hidden="true" />;
  }
  const line = { size: 23, strokeWidth: 1.8, 'aria-hidden': true } as const;
  if (name === 'General') return <svg className="kp-gear-icon" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M21.34 10.47Q21.90 10.61 21.90 11.25L21.90 12.75Q21.90 13.39 21.34 13.53L20.00 13.85Q19.44 13.99 19.26 14.42L18.85 15.42Q18.67 15.85 18.97 16.35L19.68 17.52Q19.99 18.02 19.53 18.47L18.47 19.53Q18.02 19.99 17.52 19.68L16.35 18.97Q15.85 18.67 15.42 18.85L14.42 19.26Q13.99 19.44 13.85 20.00L13.53 21.34Q13.39 21.90 12.75 21.90L11.25 21.90Q10.61 21.90 10.47 21.34L10.15 20.00Q10.01 19.44 9.58 19.26L8.58 18.85Q8.15 18.67 7.65 18.97L6.48 19.68Q5.98 19.99 5.53 19.53L4.47 18.47Q4.01 18.02 4.32 17.52L5.03 16.35Q5.33 15.85 5.15 15.42L4.74 14.42Q4.56 13.99 4.00 13.85L2.66 13.53Q2.10 13.39 2.10 12.75L2.10 11.25Q2.10 10.61 2.66 10.47L4.00 10.15Q4.56 10.01 4.74 9.58L5.15 8.58Q5.33 8.15 5.03 7.65L4.32 6.48Q4.01 5.98 4.47 5.53L5.53 4.47Q5.98 4.01 6.48 4.32L7.65 5.03Q8.15 5.33 8.58 5.15L9.58 4.74Q10.01 4.56 10.15 4.00L10.47 2.66Q10.61 2.10 11.25 2.10L12.75 2.10Q13.39 2.10 13.53 2.66L13.85 4.00Q13.99 4.56 14.42 4.74L15.42 5.15Q15.85 5.33 16.35 5.03L17.52 4.32Q18.02 4.01 18.47 4.47L19.53 5.53Q19.99 5.98 19.68 6.48L18.97 7.65Q18.67 8.15 18.85 8.58L19.26 9.58Q19.44 10.01 20.00 10.15L21.34 10.47Z" /><circle cx="12" cy="12" r="3.4" /></svg>;
  if (name === 'Voice Input') return <Mic {...line} />;
  if (name === 'Notifications') return <Bell {...line} />;
  if (name === 'About') return <Info {...line} />;
  return (
    <svg className={name === 'Devices' ? 'kp-devices-icon' : undefined} width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
