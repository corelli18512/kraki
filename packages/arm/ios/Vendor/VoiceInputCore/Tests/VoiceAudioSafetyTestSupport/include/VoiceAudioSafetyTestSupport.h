#import <AVFoundation/AVFoundation.h>
NS_ASSUME_NONNULL_BEGIN
/// Test-only Objective-C doubles: never open hardware or a network connection.
FOUNDATION_EXPORT AVAudioEngine *VICMakeTestAudioEngine(NSInteger failureStage);
FOUNDATION_EXPORT NSUInteger VICTestTapRemovals(AVAudioEngine *engine);
FOUNDATION_EXPORT NSUInteger VICTestEngineStops(AVAudioEngine *engine);
FOUNDATION_EXPORT NSUInteger VICTestEngineStarts(AVAudioEngine *engine);
NS_ASSUME_NONNULL_END
