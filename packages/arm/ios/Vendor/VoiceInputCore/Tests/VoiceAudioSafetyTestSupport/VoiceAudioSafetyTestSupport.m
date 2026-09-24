#import "VoiceAudioSafetyTestSupport.h"
#import <math.h>

@interface VICTestFormat : NSObject
@property double sampleRate;
@property AVAudioChannelCount channelCount;
@end
@implementation VICTestFormat
@end

static void VICRaiseTestException(void) {
    [NSException raise:NSInvalidArgumentException format:@"synthetic-audio-graph-exception"];
}

// Deliberately use Objective-C message-compatible doubles rather than an
// AVAudioEngine initializer: these tests must never touch actual microphone IO.
@interface VICTestInput : NSObject
@property NSInteger stage;
@property NSUInteger removals;
@end
@implementation VICTestInput
- (AVAudioFormat *)outputFormatForBus:(AVAudioNodeBus)bus {
    if (self.stage == 2) VICRaiseTestException();
    if (self.stage == 7) return nil;
    if (self.stage >= 9) {
        VICTestFormat *format = [VICTestFormat new];
        format.sampleRate = self.stage == 9 ? 0 : self.stage == 11 ? NAN : self.stage == 12 ? 8000 : 48000;
        format.channelCount = self.stage == 10 ? 0 : 1;
        return (AVAudioFormat *)format;
    }
    return [[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:1];
}
- (void)installTapOnBus:(AVAudioNodeBus)bus bufferSize:(AVAudioFrameCount)size
                format:(AVAudioFormat *)format block:(AVAudioNodeTapBlock)block {
    if (self.stage == 3) VICRaiseTestException();
}
- (void)removeTapOnBus:(AVAudioNodeBus)bus {
    self.removals++;
    if (self.stage == 8) VICRaiseTestException();
}
@end

@interface VICTestEngine : NSObject
@property NSInteger stage;
@property VICTestInput *input;
@property NSUInteger starts;
@property NSUInteger stops;
@end
@implementation VICTestEngine
- (AVAudioInputNode *)inputNode {
    if (self.stage == 1) VICRaiseTestException();
    return (AVAudioInputNode *)self.input;
}
- (void)prepare { if (self.stage == 4) VICRaiseTestException(); }
- (BOOL)startAndReturnError:(NSError **)error {
    self.starts++;
    if (self.stage == 5) VICRaiseTestException();
    if (self.stage == 6) {
        if (error) *error = [NSError errorWithDomain:@"synthetic-start-error" code:42 userInfo:nil];
        return NO;
    }
    return YES;
}
- (void)stop {
    self.stops++;
    if (self.stage == 8) VICRaiseTestException();
}
@end

AVAudioEngine *VICMakeTestAudioEngine(NSInteger failureStage) {
    VICTestEngine *engine = [VICTestEngine new];
    engine.stage = failureStage;
    engine.input = [VICTestInput new];
    engine.input.stage = failureStage;
    return (AVAudioEngine *)engine;
}
NSUInteger VICTestTapRemovals(AVAudioEngine *engine) { return ((VICTestEngine *)engine).input.removals; }
NSUInteger VICTestEngineStops(AVAudioEngine *engine) { return ((VICTestEngine *)engine).stops; }
NSUInteger VICTestEngineStarts(AVAudioEngine *engine) { return ((VICTestEngine *)engine).starts; }
