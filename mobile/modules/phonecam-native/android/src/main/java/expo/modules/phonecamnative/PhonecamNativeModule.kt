package expo.modules.phonecamnative

import android.content.pm.ActivityInfo
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PhonecamNativeModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("PhonecamNative")

    // Ongoing notification that keeps camera + mic alive in the background.
    Function("startService") { title: String, text: String ->
      StreamingService.start(context, title, text)
    }

    Function("stopService") {
      StreamingService.stop(context)
    }

    // Landscape only (either way up) while streaming, so the video never flips.
    Function("lockLandscape") { lock: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      activity.runOnUiThread {
        activity.requestedOrientation = if (lock) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      }
    }

    // Flashlight / zoom / focus point (focusX < 0 = continuous autofocus).
    AsyncFunction("setCameraState") { trackId: String, torch: Boolean, zoom: Double, focusX: Double, focusY: Double, promise: Promise ->
      CameraControl.apply(appContext.reactContext, appContext.currentActivity, trackId, torch, zoom, focusX, focusY, promise)
    }
  }
}
