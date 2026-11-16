'use strict';
// The default render endpoint's master volume on Windows (Core Audio:
// IMMDeviceEnumerator → IMMDevice → IAudioEndpointVolume), the backend of
// voice-volume.cjs. Called in-process through koffi (a prebuilt FFI module,
// no native build chain); the watchdog loads it too. Every call opens the
// endpoint afresh (a few ms), so a switched default endpoint is never stale.

const CLSID_MMDeviceEnumerator = 'BCDE0395-E52F-467C-8E3D-C4579291692E';
const IID_IMMDeviceEnumerator = 'A95664D2-9614-4F35-A746-DE8DB63617E6';
const IID_IAudioEndpointVolume = '5CDF2C82-841E-4546-9722-0CF74078229A';
const CLSCTX_ALL = 0x17;
const COINIT_APARTMENTTHREADED = 0x2;
const E_RENDER = 0;
const E_CONSOLE = 0;
const DEVICE_STATE_ACTIVE = 0x1;

/** COM vtable slots (IUnknown: 0 QueryInterface, 1 AddRef, 2 Release). */
const SLOT = Object.freeze({
  release: 2,
  enumeratorGetDefaultAudioEndpoint: 4,
  enumeratorGetDevice: 5,
  deviceActivate: 3,
  deviceGetId: 5,
  deviceGetState: 6,
  volumeSetMasterScalar: 7,
  volumeGetMasterScalar: 9,
  volumeGetMute: 15,
});

function guid(text) {
  const h = text.replace(/-/g, '');
  const bytes = [];
  for (let i = 16; i < 32; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  return { Data1: parseInt(h.slice(0, 8), 16), Data2: parseInt(h.slice(8, 12), 16), Data3: parseInt(h.slice(12, 16), 16), Data4: bytes };
}

/** koffi type names are global: declare them once per koffi instance. */
const declared = new WeakMap();
function typesFor(koffi) {
  if (!declared.has(koffi)) {
    koffi.struct('KrakiGUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) });
    declared.set(koffi, {
      proto: {
        release: koffi.proto('uint32 __stdcall KrakiRelease(void *self)'),
        getDefaultAudioEndpoint: koffi.proto('int32 __stdcall KrakiGetDefaultAudioEndpoint(void *self, int32 flow, int32 role, _Out_ void **device)'),
        getDevice: koffi.proto('int32 __stdcall KrakiGetDevice(void *self, str16 id, _Out_ void **device)'),
        activate: koffi.proto('int32 __stdcall KrakiActivate(void *self, KrakiGUID *iid, uint32 context, void *params, _Out_ void **object)'),
        getId: koffi.proto('int32 __stdcall KrakiGetId(void *self, _Out_ void **id)'),
        getState: koffi.proto('int32 __stdcall KrakiGetState(void *self, _Out_ uint32 *state)'),
        setMasterScalar: koffi.proto('int32 __stdcall KrakiSetMasterVolumeLevelScalar(void *self, float level, KrakiGUID *eventContext)'),
        getMasterScalar: koffi.proto('int32 __stdcall KrakiGetMasterVolumeLevelScalar(void *self, _Out_ float *level)'),
        getMute: koffi.proto('int32 __stdcall KrakiGetMute(void *self, _Out_ int32 *muted)'),
      },
    });
  }
  return declared.get(koffi);
}

function hresultError(what, hr) {
  return new Error(`${what} failed (HRESULT 0x${(hr >>> 0).toString(16).padStart(8, '0')})`);
}

/**
 * @param {{ koffi?: any, ole32?: any }} [deps] koffi and the loaded ole32
 *   library (tests pass a fake one).
 */
function createWindowsAudioBackend(deps = {}) {
  const koffi = deps.koffi ?? require('koffi');
  const ole32 = deps.ole32 ?? koffi.load('ole32.dll');
  const { proto } = typesFor(koffi);
  const fn = {
    CoInitializeEx: ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 coinit)'),
    CoCreateInstance: ole32.func('int32 __stdcall CoCreateInstance(KrakiGUID *clsid, void *outer, uint32 context, KrakiGUID *iid, _Out_ void **object)'),
    CoTaskMemFree: ole32.func('void __stdcall CoTaskMemFree(void *memory)'),
  };
  const pointerSize = koffi.sizeof('void *');
  const ids = { clsid: guid(CLSID_MMDeviceEnumerator), enumerator: guid(IID_IMMDeviceEnumerator), volume: guid(IID_IAudioEndpointVolume) };

  /** Call vtable slot `slot` of COM object `object`. */
  const invoke = (object, slot, type, ...args) => {
    const vtable = koffi.decode(object, 'void *');
    return koffi.call(koffi.decode(vtable, slot * pointerSize, 'void *'), type, object, ...args);
  };
  const check = (what, hr) => { if (hr < 0) throw hresultError(what, hr); };
  const release = (object) => { if (object) invoke(object, SLOT.release, proto.release); };

  let comReady = false;
  function ensureCom() {
    if (comReady) return;
    // The Electron main thread is initialized already (S_FALSE or
    // RPC_E_CHANGED_MODE): either way COM is usable on this thread.
    fn.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
    comReady = true;
  }

  /** Open the endpoint `id` (default render endpoint when null) and its volume. */
  function withEndpoint(id, body) {
    ensureCom();
    const out = [null];
    check('CoCreateInstance(MMDeviceEnumerator)', fn.CoCreateInstance(ids.clsid, null, CLSCTX_ALL, ids.enumerator, out));
    const enumerator = out[0];
    try {
      const deviceOut = [null];
      if (id === null) check('GetDefaultAudioEndpoint', invoke(enumerator, SLOT.enumeratorGetDefaultAudioEndpoint, proto.getDefaultAudioEndpoint, E_RENDER, E_CONSOLE, deviceOut));
      else check('GetDevice', invoke(enumerator, SLOT.enumeratorGetDevice, proto.getDevice, id, deviceOut));
      const device = deviceOut[0];
      try {
        const state = [0];
        check('IMMDevice.GetState', invoke(device, SLOT.deviceGetState, proto.getState, state));
        if (state[0] !== DEVICE_STATE_ACTIVE) throw new Error('the output device is not active');
        const volumeOut = [null];
        check('IMMDevice.Activate(IAudioEndpointVolume)', invoke(device, SLOT.deviceActivate, proto.activate, ids.volume, CLSCTX_ALL, null, volumeOut));
        const volume = volumeOut[0];
        try { return body({ device, volume }); } finally { release(volume); }
      } finally { release(device); }
    } finally { release(enumerator); }
  }

  const readVolume = (volume) => {
    const level = [0];
    check('GetMasterVolumeLevelScalar', invoke(volume, SLOT.volumeGetMasterScalar, proto.getMasterScalar, level));
    return level[0];
  };

  return {
    /** The default render endpoint's id ("{0.0.0.00000000}.{…}"). */
    defaultDevice() {
      return withEndpoint(null, ({ device }) => {
        const out = [null];
        check('IMMDevice.GetId', invoke(device, SLOT.deviceGetId, proto.getId, out));
        try { return koffi.decode(out[0], 'char16_t', -1); } finally { fn.CoTaskMemFree(out[0]); }
      });
    },
    /** Every active endpoint has a master volume (software if not hardware). */
    supportsWritableVolume(id) {
      try { return withEndpoint(id, () => true); } catch { return false; }
    },
    volume(id) { return withEndpoint(id, ({ volume }) => readVolume(volume)); },
    setVolume(id, value) {
      withEndpoint(id, ({ volume }) => {
        check('SetMasterVolumeLevelScalar', invoke(volume, SLOT.volumeSetMasterScalar, proto.setMasterScalar, Math.min(1, Math.max(0, value)), null));
      });
    },
    isMuted(id) {
      try {
        return withEndpoint(id, ({ volume }) => {
          const muted = [0];
          check('GetMute', invoke(volume, SLOT.volumeGetMute, proto.getMute, muted));
          return muted[0] !== 0;
        });
      } catch { return false; }
    },
  };
}

module.exports = { createWindowsAudioBackend, typesFor, SLOT, guid, CLSID_MMDeviceEnumerator, IID_IMMDeviceEnumerator, IID_IAudioEndpointVolume };
