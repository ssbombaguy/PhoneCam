import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, PanResponder, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RTCView, mediaDevices } from 'react-native-webrtc';
import { useKeepAwake } from 'expo-keep-awake';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import PhoneCamClient from '../PhoneCamClient';
import { colors } from '../theme';
import Button from '../components/Button';
import { lockLandscape, setCameraState, startStreamingService, stopStreamingService } from '../../modules/phonecam-native';

const QUALITIES = [720, 1080, 480];
const SIZES = { 480: [640, 480], 720: [1280, 720], 1080: [1920, 1080] };

function deviceName() {
  const c = Platform.constants || {};
  const name = [c.Brand, c.Model].filter(Boolean).join(' ');
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Android phone';
}

async function askPermissions() {
  if (Platform.OS !== 'android') return true;
  const wanted = [PermissionsAndroid.PERMISSIONS.CAMERA, PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  // Android 13+: needed to show the "PhoneCam is streaming" notification.
  if (Platform.Version >= 33) wanted.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  const res = await PermissionsAndroid.requestMultiple(wanted);
  return res[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.GRANTED;
}

function constraintsFor(quality, batterySaver) {
  const [width, height] = SIZES[quality];
  return { width, height, frameRate: batterySaver ? 15 : 30 };
}

async function openCamera(facing, quality, batterySaver) {
  return mediaDevices.getUserMedia({
    audio: true,
    video: { facingMode: facing, ...constraintsFor(quality, batterySaver) },
  });
}

export default function StreamScreen({ pairing, onExit }) {
  useKeepAwake();
  const [stream, setStream] = useState(null);
  const [facing, setFacing] = useState('environment');
  const [quality, setQuality] = useState(720);
  const [batterySaver, setBatterySaver] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [status, setStatus] = useState({ server: 'connecting', viewers: 0, error: null });
  const [cameraError, setCameraError] = useState(null);
  const [caps, setCaps] = useState({ torch: false, maxZoom: 1, focus: false });
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoom] = useState(1);
  const client = useRef(null);
  const streamRef = useRef(null);
  const settings = useRef({ facing, quality, micOn, batterySaver });
  settings.current = { facing, quality, micOn, batterySaver };

  // ---- Camera controls (flashlight / zoom / focus) ---------------------------

  const cam = useRef({ torch: false, zoom: 1, focus: null, busy: false, dirty: false, retry: 0 });

  const pushCameraState = useCallback(async () => {
    const c = cam.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    if (c.busy) { c.dirty = true; return; }
    c.busy = true;
    const res = await setCameraState(track.id, { torch: c.torch, zoom: c.zoom, focus: c.focus });
    c.busy = false;
    if (res.supported) {
      c.retry = 0;
      setCaps({ torch: res.torch, maxZoom: res.maxZoom, focus: res.focus });
      setTorchOn(res.torchOn);
    } else if (c.retry < 8) {
      // Camera session still (re)starting — try again shortly.
      c.retry++;
      setTimeout(pushCameraState, 500);
      return;
    }
    if (c.dirty) { c.dirty = false; pushCameraState(); }
  }, []);

  // After the camera restarts (switch, quality change) its session is new: start clean.
  const resetCameraState = useCallback(() => {
    Object.assign(cam.current, { torch: false, zoom: 1, focus: null, retry: 0 });
    setTorchOn(false);
    setZoom(1);
    setTimeout(pushCameraState, 600);
  }, [pushCameraState]);

  // ---- Lifecycle ---------------------------------------------------------------

  const startCamera = useCallback(async () => {
    const { facing: f, quality: q, micOn: m, batterySaver: b } = settings.current;
    const s = await openCamera(f, q, b);
    s.getAudioTracks().forEach((t) => { t.enabled = m; });
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = s;
    setStream(s);
    return s;
  }, []);

  useEffect(() => {
    let cancelled = false;
    lockLandscape(true);
    (async () => {
      if (!(await askPermissions())) {
        setCameraError('Camera permission is needed. Allow it in Android Settings → Apps → PhoneCam → Permissions.');
        return;
      }
      let s;
      try {
        s = await startCamera();
      } catch (err) {
        setCameraError(`Couldn't open the camera: ${err?.message || err}`);
        return;
      }
      if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
      const c = new PhoneCamClient({ ...pairing, name: deviceName(), onChange: setStatus });
      client.current = c;
      c.start(s);
      // Keeps camera + mic running with the screen off or in another app.
      startStreamingService('PhoneCam is streaming', `Camera shared with your PC (${pairing.host})`);
      resetCameraState();
    })();

    return () => {
      cancelled = true;
      stopStreamingService();
      lockLandscape(false);
      client.current?.stop();
      client.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [pairing, startCamera, resetCameraState]);

  // Safety net: if Android still closed the camera while in the background, reopen it.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      if (next !== 'active' || !streamRef.current) return;
      const video = streamRef.current.getVideoTracks()[0];
      if (video && video.readyState !== 'ended') return;
      try {
        const s = await startCamera();
        client.current?.replaceStream(s);
        resetCameraState();
      } catch { /* preview stays black; user can tap Stop and retry */ }
    });
    return () => sub.remove();
  }, [startCamera, resetCameraState]);

  // ---- Buttons -----------------------------------------------------------------

  const videoTrack = () => streamRef.current?.getVideoTracks()[0];

  const switchCamera = async () => {
    const next = facing === 'user' ? 'environment' : 'user';
    const video = videoTrack();
    if (!video) return;
    try {
      await video.applyConstraints({ facingMode: next });
      setFacing(next);
      resetCameraState();
    } catch { /* phone has a single camera */ }
  };

  const toggleMic = () => {
    const next = !micOn;
    streamRef.current?.getAudioTracks().forEach((t) => { t.enabled = next; });
    setMicOn(next);
  };

  const toggleTorch = () => {
    cam.current.torch = !cam.current.torch;
    setTorchOn(cam.current.torch);
    pushCameraState();
  };

  const applyFormat = async (q, saver) => {
    const video = videoTrack();
    if (!video) return false;
    try {
      await video.applyConstraints({ ...constraintsFor(q, saver), facingMode: facing });
      client.current?.setQuality(q, saver);
      resetCameraState();
      return true;
    } catch {
      return false; // not supported by this camera
    }
  };

  const cycleQuality = async () => {
    const next = QUALITIES[(QUALITIES.indexOf(quality) + 1) % QUALITIES.length];
    if (await applyFormat(next, batterySaver)) setQuality(next);
  };

  const toggleBatterySaver = async () => {
    if (await applyFormat(quality, !batterySaver)) setBatterySaver(!batterySaver);
  };

  // ---- Gestures: pinch to zoom, tap to focus, double-tap to reset ---------------

  const layout = useRef({ width: 1, height: 1 });
  const [ring, setRing] = useState(null);
  const ringAnim = useRef(new Animated.Value(0)).current;
  const gesture = useRef({ startDist: 0, startZoom: 1, moved: false, start: 0, lastTap: 0 });

  const focusAt = (x, y) => {
    // Map the tap into the visible video (objectFit "contain" leaves bars).
    const track = videoTrack();
    const { width = 16, height = 9 } = track?.getSettings?.() || {};
    const aspect = Math.max(width, height) / Math.min(width, height);
    const { width: W, height: H } = layout.current;
    let vw = W;
    let vh = W / aspect;
    if (vh > H) { vh = H; vw = H * aspect; }
    const nx = (x - (W - vw) / 2) / vw;
    const ny = (y - (H - vh) / 2) / vh;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    cam.current.focus = { x: nx, y: ny };
    pushCameraState();
    setRing({ x, y });
    ringAnim.setValue(1);
    Animated.timing(ringAnim, { toValue: 0, duration: 900, delay: 300, useNativeDriver: true }).start();
  };

  const resetView = () => {
    Object.assign(cam.current, { zoom: 1, focus: null });
    setZoom(1);
    pushCameraState();
  };

  const distance = (touches) => Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        Object.assign(gesture.current, { startDist: 0, moved: false, start: Date.now() });
      },
      onPanResponderMove: (evt, g) => {
        const touches = evt.nativeEvent.touches;
        if (Math.abs(g.dx) > 10 || Math.abs(g.dy) > 10) gesture.current.moved = true;
        if (touches.length < 2) return;
        gesture.current.moved = true;
        const d = distance(touches);
        if (!gesture.current.startDist) {
          gesture.current.startDist = d;
          gesture.current.startZoom = cam.current.zoom;
          return;
        }
        const max = capsRef.current.maxZoom || 1;
        const z = Math.min(max, Math.max(1, gesture.current.startZoom * (d / gesture.current.startDist)));
        if (Math.abs(z - cam.current.zoom) < 0.03) return;
        cam.current.zoom = z;
        setZoom(z);
        pushCameraState();
      },
      onPanResponderRelease: (evt) => {
        const g = gesture.current;
        if (g.moved || Date.now() - g.start > 350) return;
        const now = Date.now();
        if (now - g.lastTap < 300) { g.lastTap = 0; resetView(); return; }
        g.lastTap = now;
        if (capsRef.current.focus) focusAt(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
      },
    }),
  ).current;

  const capsRef = useRef(caps);
  capsRef.current = caps;

  // ---- Render ------------------------------------------------------------------

  const pill = statusPill(status, cameraError);

  return (
    <View style={styles.root} onLayout={(e) => { layout.current = e.nativeEvent.layout; }}>
      {stream ? (
        <RTCView
          streamURL={stream.toURL()}
          style={StyleSheet.absoluteFill}
          objectFit="contain"
          mirror={facing === 'user'}
          zOrder={0}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text style={styles.muted}>{cameraError || 'Opening camera…'}</Text>
        </View>
      )}

      {/* Gesture layer over the preview */}
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers} />

      {ring && (
        <Animated.View
          pointerEvents="none"
          style={[styles.ring, { left: ring.x - 36, top: ring.y - 36, opacity: ringAnim }]}
        />
      )}

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topRow} pointerEvents="box-none">
          <View style={[styles.pill, { borderColor: pill.color }]}>
            <View style={[styles.dot, { backgroundColor: pill.color }]} />
            <Text style={styles.pillText}>{pill.text}</Text>
          </View>
          {zoom > 1.04 && (
            <Pressable onPress={resetView} style={styles.zoomBadge}>
              <Text style={styles.zoomText}>{zoom.toFixed(1)}×</Text>
            </Pressable>
          )}
        </View>
        {!!pill.hint && <Text style={styles.hint} pointerEvents="none">{pill.hint}</Text>}

        <View style={styles.spacer} pointerEvents="box-none" />

        {status.server === 'replaced' ? (
          <Button title="Back" onPress={onExit} style={styles.wide} />
        ) : (
          <View style={styles.controls}>
            <Control icon="cameraswitch" label="Switch" onPress={switchCamera} />
            <Control icon={micOn ? 'mic' : 'mic-off'} label={micOn ? 'Mic on' : 'Mic off'} onPress={toggleMic} active={!micOn} />
            {caps.torch && (
              <Control icon={torchOn ? 'flashlight-on' : 'flashlight-off'} label="Light" onPress={toggleTorch} active={torchOn} />
            )}
            <Control icon="high-quality" label={`${quality}p`} onPress={cycleQuality} />
            <Control icon="eco" label={batterySaver ? 'Saver on' : 'Saver'} onPress={toggleBatterySaver} active={batterySaver} />
            <Control icon="stop-circle" label="Stop" onPress={onExit} danger />
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

function statusPill(status, cameraError) {
  if (cameraError) return { color: colors.danger, text: 'Camera unavailable' };
  switch (status.server) {
    case 'replaced':
      return { color: colors.danger, text: 'Another phone connected to this PC' };
    case 'connecting':
      return status.error
        ? { color: colors.danger, text: 'Can\'t reach your PC', hint: 'Is PhoneCam running on the PC? Are both on the same Wi-Fi? Retrying…' }
        : { color: colors.warn, text: 'Connecting to PC…' };
    default:
      return status.viewers > 0
        ? { color: colors.accent, text: status.viewers === 1 ? 'Live in your meeting' : `Live in ${status.viewers} tabs` }
        : { color: colors.accent, text: 'Connected', hint: 'In Google Meet: Settings → Video → Camera → PhoneCam' };
  }
}

function Control({ icon, label, onPress, active, danger }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.control, pressed && styles.pressed]}>
      <View style={[styles.controlIcon, active && styles.controlActive, danger && styles.controlDanger]}>
        <MaterialIcons name={icon} size={26} color={danger || active ? '#fff' : colors.text} />
      </View>
      <Text style={styles.controlLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 32 },
  muted: { color: colors.muted, fontSize: 16, textAlign: 'center' },
  overlay: { ...StyleSheet.absoluteFillObject, padding: 12 },
  spacer: { flex: 1 },
  topRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 4 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.overlay, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  pillText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  zoomBadge: { backgroundColor: colors.overlay, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  zoomText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  hint: {
    alignSelf: 'center', color: '#fff', fontSize: 13, marginTop: 8, textAlign: 'center',
    backgroundColor: colors.overlay, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, overflow: 'hidden', maxWidth: 420,
  },
  controls: {
    flexDirection: 'row', justifyContent: 'space-around', alignSelf: 'center', width: '100%', maxWidth: 640,
    backgroundColor: colors.overlay, borderRadius: 24, paddingVertical: 10,
  },
  control: { alignItems: 'center', gap: 4, minWidth: 60 },
  pressed: { opacity: 0.7 },
  controlIcon: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  controlActive: { backgroundColor: colors.warn },
  controlDanger: { backgroundColor: colors.danger },
  controlLabel: { color: '#fff', fontSize: 12 },
  wide: { alignSelf: 'stretch' },
  ring: { position: 'absolute', width: 72, height: 72, borderRadius: 36, borderWidth: 2, borderColor: colors.accent },
});
