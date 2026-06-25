// Android reference for the `com.elpa/native_texture` plugin (see ../README.md).
//
// Allocates an AHardwareBuffer-backed GPU buffer, registers it with Flutter's
// texture registry so the `Texture` widget can composite it, and returns the
// buffer pointer to Dart so Rust can import the SAME memory into wgpu (zero copy).
//
// Drop this into the generated runner (android/app/src/main/kotlin/<pkg>/) and
// register it from your FlutterActivity/Application:
//
//     flutterEngine.plugins.add(ElpaNativeTexturePlugin())
//
// Requires API 26+ (AHardwareBuffer) and the NDK for the JNI helpers that bind an
// AHardwareBuffer to the texture's EGLImage and expose its native pointer. The
// pointer is reinterpreted as an Int64 and handed to the Rust importer
// (`rust/src/import.rs::android`), which imports it via
// `VK_ANDROID_external_memory_android_hardware_buffer`.
//
// NOTE: this is a structured reference, not a drop-in binary — the JNI bridge
// (`nativeBindHardwareBuffer` / `nativeHardwareBufferPtr`) must be supplied by a
// small companion .so. It is documented here so the Kotlin/registry half is
// concrete; build + validate on a real device.

package com.elpa.native_texture

import android.hardware.HardwareBuffer
import android.graphics.SurfaceTexture
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.view.TextureRegistry

class ElpaNativeTexturePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private lateinit var channel: MethodChannel
    private lateinit var textures: TextureRegistry
    private val entries = HashMap<Long, Entry>()

    private class Entry(
        val surfaceEntry: TextureRegistry.SurfaceTextureEntry,
        val buffer: HardwareBuffer,
    )

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        textures = binding.textureRegistry
        channel = MethodChannel(binding.binaryMessenger, "com.elpa/native_texture")
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        for (e in entries.values) {
            e.surfaceEntry.release()
            e.buffer.close()
        }
        entries.clear()
        channel.setMethodCallHandler(null)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "create" -> {
                val width = call.argument<Int>("width") ?: 1
                val height = call.argument<Int>("height") ?: 1

                // A GPU-resident, renderable + sampleable shared buffer.
                val buffer = HardwareBuffer.create(
                    width, height,
                    HardwareBuffer.RGBA_8888, 1,
                    HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or
                        HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE,
                )

                // Register a Flutter texture and bind the buffer to its
                // SurfaceTexture's GL target via an EGLImage (JNI helper).
                val entry = textures.createSurfaceTexture()
                val surfaceTexture: SurfaceTexture = entry.surfaceTexture()
                surfaceTexture.setDefaultBufferSize(width, height)
                nativeBindHardwareBuffer(surfaceTexture, buffer)

                val textureId = entry.id()
                entries[textureId] = Entry(entry, buffer)

                result.success(
                    mapOf(
                        "textureId" to textureId,
                        // The AHardwareBuffer* as an int64 for the Rust importer.
                        "handle" to nativeHardwareBufferPtr(buffer),
                        "rowStride" to 0, // tightly packed; query the buffer if padded
                    ),
                )
            }
            "release" -> {
                val id = (call.argument<Number>("textureId"))?.toLong()
                val e = if (id != null) entries.remove(id) else null
                e?.surfaceEntry?.release()
                e?.buffer?.close()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    // Supplied by a companion NDK library (see ../README.md):
    //  * bind the AHardwareBuffer to `surfaceTexture`'s GL_TEXTURE_EXTERNAL_OES via
    //    eglCreateImageKHR(EGL_NATIVE_BUFFER_ANDROID) + glEGLImageTargetTexture2DOES;
    //  * return AHardwareBuffer_from(buffer) as a jlong for the Rust importer.
    private external fun nativeBindHardwareBuffer(surfaceTexture: SurfaceTexture, buffer: HardwareBuffer)
    private external fun nativeHardwareBufferPtr(buffer: HardwareBuffer): Long

    companion object {
        init {
            // System.loadLibrary("elpa_native_texture") // the companion .so
        }
    }
}
