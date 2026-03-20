import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';

interface Props {
  open: boolean;
  onClose: () => void;
}

const LAST_DEVICE_KEY = 'kraki:last-device';
const MODEL_PREF_KEY = 'kraki:last-model';

function getModelPrefs(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(MODEL_PREF_KEY) ?? '{}'); } catch { return {}; }
}

function saveModelPref(deviceId: string, model: string) {
  const prefs = getModelPrefs();
  prefs[deviceId] = model;
  localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(prefs));
}

export function NewSessionDialog({ open, onClose }: Props) {
  const devices = useStore((s) => s.devices);

  const tentacles = [...devices.values()].filter((d) => d.role === 'tentacle' && d.online);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Default to last selected device, or single tentacle
  useEffect(() => {
    if (!open) return;
    const lastId = localStorage.getItem(LAST_DEVICE_KEY);
    const lastOnline = tentacles.find((d) => d.id === lastId);
    if (lastOnline) {
      setSelectedDevice(lastOnline.id);
    } else if (tentacles.length >= 1) {
      setSelectedDevice(tentacles[0].id);
    }
  }, [open, tentacles.length]);

  // Get models from selected tentacle
  const selectedTentacle = tentacles.find((d) => d.id === selectedDevice);
  const models = selectedTentacle?.capabilities?.models ?? [];

  // Restore last model for this device, or auto-select first
  useEffect(() => {
    if (!selectedDevice || models.length === 0) return;
    const prefs = getModelPrefs();
    const lastModel = prefs[selectedDevice];
    if (lastModel && models.includes(lastModel)) {
      setModel(lastModel);
    } else if (!model || !models.includes(model)) {
      setModel(models[0]);
    }
  }, [models, selectedDevice]);

  // Scroll selected model into view
  useEffect(() => {
    if (!model || !listRef.current) return;
    const el = listRef.current.querySelector('[data-selected="true"]') as HTMLElement | null;
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [model, models]);

  const canSubmit = selectedDevice && model;

  const handleSelectDevice = (id: string) => {
    setSelectedDevice(id);
    localStorage.setItem(LAST_DEVICE_KEY, id);
  };

  const handleSelectModel = (m: string) => {
    setModel(m);
    if (selectedDevice) saveModelPref(selectedDevice, m);
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    wsClient.createSession({
      targetDeviceId: selectedDevice,
      model,
      prompt: prompt.trim() || undefined,
    });
    onClose();
    setPrompt('');
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-border-primary bg-surface-primary p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">New Session</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {tentacles.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-text-secondary">No devices online</p>
            <p className="mt-1 text-xs text-text-muted">Connect a tentacle to create sessions</p>
            <code className="mt-3 inline-block rounded bg-surface-tertiary px-2.5 py-1 text-[11px] text-text-secondary">
              npx kraki
            </code>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Device picker — pill buttons */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">Device</label>
              <div className="flex flex-wrap gap-1.5">
                {tentacles.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => handleSelectDevice(d.id)}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      selectedDevice === d.id
                        ? 'bg-kraki-500 text-white'
                        : 'bg-surface-tertiary text-text-secondary hover:bg-surface-tertiary/80 hover:text-text-primary'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${d.online ? 'bg-emerald-400' : 'bg-slate-400'}`} />
                    {d.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Model picker — scrollable list */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">Model</label>
              {models.length > 0 ? (
                <div ref={listRef} className="max-h-40 overflow-y-auto rounded-lg border border-border-primary bg-surface-secondary">
                  {models.map((m) => (
                    <button
                      key={m}
                      data-selected={model === m}
                      onClick={() => handleSelectModel(m)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                        model === m
                          ? 'bg-ocean-500/15 text-ocean-400'
                          : 'text-text-secondary hover:bg-surface-tertiary hover:text-text-primary'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${model === m ? 'bg-ocean-400' : 'bg-transparent'}`} />
                      {m}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. claude-sonnet-4"
                  className="w-full rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-kraki-500"
                />
              )}
            </div>

            {/* Prompt */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                Initial prompt <span className="text-text-muted">(optional)</span>
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should the agent work on?"
                rows={3}
                className="w-full resize-none rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-kraki-500"
              />
            </div>

            {/* Submit */}
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full rounded-lg bg-kraki-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-kraki-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Start Session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
