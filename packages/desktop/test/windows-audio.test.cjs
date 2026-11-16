// windows-audio.cjs against a fake koffi: COM objects are JS objects whose
// "vtable" maps slots to functions. Checks the slots, HRESULT handling and
// that every COM object is released; marshalling against the real Core Audio
// is verified on Windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindowsAudioBackend, SLOT, guid, IID_IAudioEndpointVolume, CLSID_MMDeviceEnumerator, IID_IMMDeviceEnumerator } = require('../src/windows-audio.cjs');

function fakeCoreAudio({ level = 0.6, muted = 0, state = 1, defaultHr = 0, devices = ['{0.0.0.00000000}.{speakers}'] } = {}) {
  const log = { released: [], freed: [], created: [], coinit: 0, sets: [] };
  const com = (name, slots) => ({ name, vtable: { [SLOT.release]: () => { log.released.push(name); return 0; }, ...slots } });
  const out = (cell, value) => { cell[0] = value; return 0; };
  const makeVolume = () => com('volume', {
    [SLOT.volumeGetMasterScalar]: (self, cell) => out(cell, level),
    [SLOT.volumeSetMasterScalar]: (self, value, context) => { assert.equal(context, null); log.sets.push(value); level = value; return 0; },
    [SLOT.volumeGetMute]: (self, cell) => out(cell, muted),
  });
  const makeDevice = (id) => com('device', {
    [SLOT.deviceGetState]: (self, cell) => out(cell, state),
    [SLOT.deviceActivate]: (self, iid, context, params, cell) => {
      assert.deepEqual(iid, guid(IID_IAudioEndpointVolume));
      assert.equal(params, null);
      return out(cell, makeVolume());
    },
    [SLOT.deviceGetId]: (self, cell) => out(cell, { wide: id }),
  });
  const enumerator = () => com('enumerator', {
    [SLOT.enumeratorGetDefaultAudioEndpoint]: (self, flow, role, cell) => {
      assert.deepEqual([flow, role], [0, 0]); // eRender, eConsole
      return defaultHr < 0 ? defaultHr : out(cell, makeDevice(devices[0]));
    },
    [SLOT.enumeratorGetDevice]: (self, id, cell) => (devices.includes(id) ? out(cell, makeDevice(id)) : -2147023728 /* 0x80070490 E_NOTFOUND */),
  });
  const koffi = {
    struct: () => {}, array: () => {}, proto: (sig) => sig, sizeof: () => 8,
    decode(value, a, b) {
      if (b === undefined && a === 'void *') return value.vtable;
      if (a === 'char16_t') return value.wide;
      return (...args) => value[a / 8](...args); // vtable slot as a function pointer
    },
    call: (fnPointer, _type, ...args) => fnPointer(...args),
  };
  const ole32 = {
    func(sig) {
      const name = /(\w+)\(/.exec(sig)[1];
      return {
        CoInitializeEx: () => { log.coinit++; return 1; },
        CoCreateInstance: (clsid, outer, context, iid, cell) => {
          assert.deepEqual(clsid, guid(CLSID_MMDeviceEnumerator));
          assert.deepEqual(iid, guid(IID_IMMDeviceEnumerator));
          log.created.push('enumerator');
          return out(cell, enumerator());
        },
        CoTaskMemFree: (p) => { log.freed.push(p.wide); },
      }[name];
    },
  };
  return { backend: createWindowsAudioBackend({ koffi, ole32 }), log, get level() { return level; }, set muted(v) { muted = v; } };
}

test('vtable slots are the SDK header order (literal, not the constants under test)', () => {
  assert.deepEqual({ ...SLOT }, {
    release: 2,
    enumeratorGetDefaultAudioEndpoint: 4, enumeratorGetDevice: 5,
    deviceActivate: 3, deviceGetId: 5, deviceGetState: 6,
    volumeSetMasterScalar: 7, volumeGetMasterScalar: 9, volumeGetMute: 15,
  });
});

test('GUIDs are laid out as Windows does', () => {
  assert.deepEqual(guid('5CDF2C82-841E-4546-9722-0CF74078229A'), { Data1: 0x5CDF2C82, Data2: 0x841E, Data3: 0x4546, Data4: [0x97, 0x22, 0x0C, 0xF7, 0x40, 0x78, 0x22, 0x9A] });
});

test('reads and sets the default render endpoint volume, releasing every COM object', () => {
  const fake = fakeCoreAudio();
  const id = fake.backend.defaultDevice();
  assert.equal(id, '{0.0.0.00000000}.{speakers}');
  assert.deepEqual(fake.log.freed, [id], 'the id string is freed with CoTaskMemFree');
  assert.ok(Math.abs(fake.backend.volume(id) - 0.6) < 1e-9);
  assert.equal(fake.backend.isMuted(id), false);
  assert.equal(fake.backend.supportsWritableVolume(id), true);
  fake.backend.setVolume(id, 0.2);
  fake.backend.setVolume(id, 1.7);
  assert.deepEqual(fake.log.sets, [0.2, 1], 'clamped to 0…1');
  fake.muted = 1;
  assert.equal(fake.backend.isMuted(id), true);
  assert.equal(fake.log.coinit, 1, 'COM initialized once');
  const count = (n) => fake.log.released.filter((x) => x === n).length;
  assert.equal(count('enumerator'), fake.log.created.length);
  assert.equal(count('device'), fake.log.created.length);
  assert.equal(count('volume'), fake.log.created.length);
});

test('no output device, an unplugged or inactive endpoint: errors, never a made-up level', () => {
  const none = fakeCoreAudio({ defaultHr: -2147023728 });
  assert.throws(() => none.backend.defaultDevice(), /GetDefaultAudioEndpoint failed \(HRESULT 0x80070490\)/);
  const gone = fakeCoreAudio();
  assert.throws(() => gone.backend.volume('{other}'), /GetDevice failed/);
  assert.equal(gone.backend.supportsWritableVolume('{other}'), false);
  assert.equal(gone.backend.isMuted('{other}'), false);
  const inactive = fakeCoreAudio({ state: 4 });
  assert.throws(() => inactive.backend.volume('{0.0.0.00000000}.{speakers}'), /not active/);
  const count = (n) => inactive.log.released.filter((x) => x === n).length;
  assert.equal(count('device'), 1, 'released on failure too');
  assert.equal(count('enumerator'), 1);
});
