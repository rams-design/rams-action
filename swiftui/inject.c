// RAMS-461: loaded into the app in the iOS Simulator via
// SIMCTL_CHILD_DYLD_INSERT_LIBRARIES. When the app first becomes active it
// calls RamsRenderHarness.run(), which the action appended to the app's
// @main file on the runner. Nothing in the customer's project changes.
//
// Why a notification and not a bare dispatch_after from the constructor:
// on the iOS 27 runtime a main-queue block queued this early never ran
// (loop, 10/30); didBecomeActive always arrives once the scene is up.
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <stdio.h>
#include <stdlib.h>

static int started = 0;

static void rams_start(void) {
  const char *delay = getenv("RAMS_START_DELAY_MS");
  long ms = delay ? atol(delay) : 1000;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, ms * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    Class harness = objc_getClass("RamsRenderHarness");
    if (!harness) { fprintf(stderr, "RAMS_RENDER_NO_HARNESS\n"); exit(3); }
    fprintf(stderr, "RAMS_HARNESS_START\n");
    ((void (*)(id, SEL))objc_msgSend)((id)harness, sel_registerName("run"));
  });
}

static void on_active(CFNotificationCenterRef c, void *o, CFNotificationName n, const void *obj, CFDictionaryRef info) {
  if (started) return;
  started = 1;
  rams_start();
}

// Backstop: an app that never reports active (a permission prompt at launch)
// still renders after RAMS_BACKSTOP_MS.
static void backstop(void *ctx) { if (!started) { started = 1; rams_start(); } }

__attribute__((constructor)) static void rams_render_init(void) {
  fprintf(stderr, "RAMS_INJECT_LOADED\n");
  const char *b = getenv("RAMS_BACKSTOP_MS");
  long bms = b ? atol(b) : 8000;
  dispatch_after_f(dispatch_time(DISPATCH_TIME_NOW, bms * NSEC_PER_MSEC), dispatch_get_main_queue(), NULL, backstop);
  CFNotificationCenterAddObserver(CFNotificationCenterGetLocalCenter(), NULL, on_active,
    CFSTR("UIApplicationDidBecomeActiveNotification"), NULL, CFNotificationSuspensionBehaviorDeliverImmediately);
}
