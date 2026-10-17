package expo.modules.phonecamnative

import android.app.Activity
import android.graphics.Rect
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.MeteringRectangle
import android.os.Build
import android.os.Handler
import android.util.Range
import android.view.Surface
import expo.modules.kotlin.Promise

/**
 * Flashlight, zoom and tap-to-focus for the camera that react-native-webrtc is
 * streaming. WebRTC has no API for these, so we find its live Camera2 session
 * (WebRTCModule -> track -> capturer -> Camera2Session) and replace the
 * repeating capture request with one that includes our settings.
 *
 * Relies on react-native-webrtc / libwebrtc field names, so the app must be
 * built without R8 obfuscation (it is: minify is off). If anything is missing,
 * we report { supported: false } instead of crashing.
 */
object CameraControl {

  private class Session(
    val device: CameraDevice,
    val capture: CameraCaptureSession,
    val surface: Surface,
    val handler: Handler,
    val chars: CameraCharacteristics,
    val fpsRange: Range<Int>?,
    val frontFacing: Boolean,
  )

  fun apply(
    reactContext: Any?,
    activity: Activity?,
    trackId: String,
    torch: Boolean,
    zoom: Double,
    focusX: Double,
    focusY: Double,
    promise: Promise,
  ) {
    val session = try {
      findSession(reactContext, trackId)
    } catch (e: Throwable) {
      null
    }
    if (session == null) {
      promise.resolve(mapOf("supported" to false))
      return
    }

    val displayRotation = activity?.let { rotationDegrees(it) } ?: 90

    session.handler.post {
      try {
        val caps = capabilities(session.chars)
        val builder = session.device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
        builder.addTarget(session.surface)

        // Same base settings WebRTC uses.
        session.fpsRange?.let { builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
        builder.set(CaptureRequest.CONTROL_AE_LOCK, false)

        // Flashlight
        val torchOn = torch && caps.torch
        builder.set(
          CaptureRequest.FLASH_MODE,
          if (torchOn) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF,
        )

        // Zoom
        val z = zoom.coerceIn(1.0, caps.maxZoom.toDouble()).toFloat()
        val active = session.chars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
        var region = active?.let { Rect(0, 0, it.width(), it.height()) }
        if (caps.zoomRatio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          builder.set(CaptureRequest.CONTROL_ZOOM_RATIO, z)
        } else if (active != null) {
          val w = (active.width() / z).toInt()
          val h = (active.height() / z).toInt()
          val left = (active.width() - w) / 2
          val top = (active.height() - h) / 2
          region = Rect(left, top, left + w, top + h)
          builder.set(CaptureRequest.SCALER_CROP_REGION, region)
        }

        // Focus: a point -> focus there once; no point -> continuous autofocus.
        val wantsPoint = focusX >= 0 && focusY >= 0 && caps.focus && region != null
        if (wantsPoint) {
          val (sx, sy) = viewToSensor(focusX, focusY, session, displayRotation)
          val size = (minOf(region!!.width(), region.height()) * 0.12).toInt()
          val cx = region.left + (sx * region.width()).toInt()
          val cy = region.top + (sy * region.height()).toInt()
          val rect = MeteringRectangle(
            (cx - size / 2).coerceAtLeast(region.left),
            (cy - size / 2).coerceAtLeast(region.top),
            size, size, MeteringRectangle.METERING_WEIGHT_MAX - 1,
          )
          builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
          builder.set(CaptureRequest.CONTROL_AF_REGIONS, arrayOf(rect))
          if ((session.chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE) ?: 0) > 0) {
            builder.set(CaptureRequest.CONTROL_AE_REGIONS, arrayOf(rect))
          }
        } else if (caps.continuousVideoAf) {
          builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
        }

        session.capture.setRepeatingRequest(builder.build(), null, session.handler)

        if (wantsPoint) {
          builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
          session.capture.capture(builder.build(), null, session.handler)
        }

        promise.resolve(
          mapOf(
            "supported" to true,
            "torch" to caps.torch,
            "torchOn" to torchOn,
            "maxZoom" to caps.maxZoom.toDouble(),
            "zoom" to z.toDouble(),
            "focus" to caps.focus,
          ),
        )
      } catch (e: Throwable) {
        // Session closed in the meantime (camera switching) — the app retries.
        promise.resolve(mapOf("supported" to false, "error" to (e.message ?: e.javaClass.simpleName)))
      }
    }
  }

  // ---------------------------------------------------------------------------

  private class Caps(
    val torch: Boolean,
    val maxZoom: Float,
    val zoomRatio: Boolean,
    val focus: Boolean,
    val continuousVideoAf: Boolean,
  )

  private fun capabilities(chars: CameraCharacteristics): Caps {
    val torch = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
    var maxZoom = chars.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1f
    var zoomRatio = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val range = chars.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
      if (range != null && range.upper > 1f) {
        maxZoom = range.upper
        zoomRatio = true
      }
    }
    val afModes = chars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: IntArray(0)
    val focus = (chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF) ?: 0) > 0 &&
      afModes.contains(CaptureRequest.CONTROL_AF_MODE_AUTO)
    return Caps(
      torch = torch,
      maxZoom = minOf(maxZoom, 8f), // beyond 8x a phone image is mush
      zoomRatio = zoomRatio,
      focus = focus,
      continuousVideoAf = afModes.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO),
    )
  }

  /** A tap on the (possibly mirrored) preview, 0..1, to 0..1 in sensor coordinates. */
  private fun viewToSensor(x: Double, y: Double, s: Session, displayRotation: Int): Pair<Double, Double> {
    val sensorOrientation = s.chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
    val dx = if (s.frontFacing) 1 - x else x
    val rotation = if (s.frontFacing) (sensorOrientation + displayRotation) % 360
    else (sensorOrientation - displayRotation + 360) % 360
    return when (rotation) {
      90 -> Pair(y, 1 - dx)
      180 -> Pair(1 - dx, 1 - y)
      270 -> Pair(1 - y, dx)
      else -> Pair(dx, y)
    }
  }

  @Suppress("DEPRECATION")
  private fun rotationDegrees(activity: Activity): Int =
    when (activity.windowManager.defaultDisplay.rotation) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }

  // ---- Reflection into react-native-webrtc / libwebrtc ----------------------

  private fun findSession(reactContext: Any?, trackId: String): Session? {
    if (reactContext == null) return null
    val moduleClass = Class.forName("com.oney.WebRTCModule.WebRTCModule")
    val module = reactContext.javaClass.getMethod("getNativeModule", Class::class.java)
      .invoke(reactContext, moduleClass) ?: return null
    val gum = field(module, "getUserMediaImpl") ?: return null
    val tracks = field(gum, "tracks") as? Map<*, *> ?: return null
    val track = tracks[trackId] ?: return null
    val controller = field(track, "videoCaptureController") ?: return null
    val capturer = field(controller, "videoCapturer") ?: return null
    val session = field(capturer, "currentSession") ?: return null
    if (session.javaClass.name != "org.webrtc.Camera2Session") return null

    val format = field(session, "captureFormat")
    val framerate = format?.let { field(it, "framerate") }
    val unit = (field(session, "fpsUnitFactor") as? Int)?.takeIf { it > 0 } ?: 1
    val fpsRange = framerate?.let {
      val min = field(it, "min") as? Int
      val max = field(it, "max") as? Int
      if (min != null && max != null) Range(min / unit, max / unit) else null
    }

    return Session(
      device = field(session, "cameraDevice") as? CameraDevice ?: return null,
      capture = field(session, "captureSession") as? CameraCaptureSession ?: return null,
      surface = field(session, "surface") as? Surface ?: return null,
      handler = field(session, "cameraThreadHandler") as? Handler ?: return null,
      chars = field(session, "cameraCharacteristics") as? CameraCharacteristics ?: return null,
      fpsRange = fpsRange,
      frontFacing = field(session, "isCameraFrontFacing") as? Boolean ?: false,
    )
  }

  private fun field(target: Any, name: String): Any? {
    var cls: Class<*>? = target.javaClass
    while (cls != null) {
      try {
        val f = cls.getDeclaredField(name)
        f.isAccessible = true
        return f.get(target)
      } catch (_: NoSuchFieldException) {
        cls = cls.superclass
      }
    }
    return null
  }
}
