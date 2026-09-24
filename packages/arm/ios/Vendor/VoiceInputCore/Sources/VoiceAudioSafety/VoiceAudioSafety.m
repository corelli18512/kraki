#import "VoiceAudioSafety.h"
#import <TargetConditionals.h>
#import <math.h>
#if TARGET_OS_OSX
#import <CoreAudio/CoreAudio.h>
#endif

static NSError *VICUnavailableError(void) {
    return [NSError errorWithDomain:@"VoiceAudioCapture" code:1 userInfo:@{
        NSLocalizedDescriptionKey: @"audio input unavailable; connect a microphone and select it as the input device, then try again"
    }];
}

BOOL VICHasDefaultInputDevice(void) {
#if TARGET_OS_OSX
    AudioDeviceID device = kAudioObjectUnknown;
    UInt32 size = sizeof(device);
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyDefaultInputDevice,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device) != noErr
        || device == kAudioObjectUnknown) return NO;
    UInt32 alive = 0;
    size = sizeof(alive);
    address.mSelector = kAudioDevicePropertyDeviceIsAlive;
    return AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &alive) == noErr && alive != 0;
#else
    // iOS route availability is checked after AVAudioSession activation by
    // the format guard below. Do not require an active route during warmup.
    return YES;
#endif
}

static void VICCleanup(AVAudioEngine *engine, AVAudioNode * _Nullable input, BOOL attemptedTap) {
    if (attemptedTap && input) {
        @try { [input removeTapOnBus:0]; }
        @catch (NSException *exception) { /* Device/graph may already be gone. */ }
    }
    @try { [engine stop]; }
    @catch (NSException *exception) { /* Never let cleanup crash the host. */ }
}

BOOL VICStartAudioEngine(AVAudioEngine *engine, double minimumSampleRate,
                        AVAudioNodeTapBlock tap, NSError **error) {
    AVAudioInputNode *input = nil;
    BOOL attemptedTap = NO;
    @try {
        input = engine.inputNode;
        AVAudioFormat *format = [input outputFormatForBus:0];
        if (!format || !isfinite(format.sampleRate) || format.sampleRate <= 0
            || format.sampleRate < minimumSampleRate || format.channelCount == 0) {
            if (error) *error = VICUnavailableError();
            VICCleanup(engine, input, NO);
            return NO;
        }
        // Mark before installation: an exception may follow partial setup.
        attemptedTap = YES;
        [input installTapOnBus:0 bufferSize:4096 format:format block:tap];
        [engine prepare];
        NSError *startError = nil;
        if (![engine startAndReturnError:&startError]) {
            if (error) *error = startError ?: VICUnavailableError();
            VICCleanup(engine, input, attemptedTap);
            return NO;
        }
        return YES;
    } @catch (NSException *exception) {
        // Do not expose framework assertion internals as user-facing text.
        if (error) *error = VICUnavailableError();
        VICCleanup(engine, input, attemptedTap);
        return NO;
    }
}

void VICStopAudioEngine(AVAudioEngine *engine) {
    AVAudioInputNode *input = nil;
    @try { input = engine.inputNode; }
    @catch (NSException *exception) { /* Input device may have disappeared. */ }
    VICCleanup(engine, input, YES);
}
