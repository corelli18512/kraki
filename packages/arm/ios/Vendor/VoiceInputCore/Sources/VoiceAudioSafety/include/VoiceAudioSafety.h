#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Read-only default input-device check; does not prompt or start recording.
FOUNDATION_EXPORT BOOL VICHasDefaultInputDevice(void);

/// AVAudioEngine can raise NSException (not Swift Error) during graph setup.
/// Keep that boundary entirely in Objective-C and discard partial tap setup.
FOUNDATION_EXPORT BOOL VICStartAudioEngine(
    AVAudioEngine *engine,
    double minimumSampleRate,
    AVAudioNodeTapBlock tap,
    NSError * _Nullable * _Nullable error
);
FOUNDATION_EXPORT void VICStopAudioEngine(AVAudioEngine *engine);

NS_ASSUME_NONNULL_END
