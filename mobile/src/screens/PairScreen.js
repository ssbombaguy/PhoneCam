import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { colors } from '../theme';
import { parsePairingUrl, validate } from '../pairing';
import Button from '../components/Button';

export default function PairScreen({ saved, onPaired }) {
  const [mode, setMode] = useState('home'); // home | scan | manual
  if (mode === 'scan') return <Scanner onCancel={() => setMode('home')} onPaired={onPaired} />;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.logo}>
          <View style={styles.logoBody}>
            <View style={styles.logoLens} />
          </View>
        </View>
        <Text style={styles.title}>PhoneCam</Text>
        <Text style={styles.subtitle}>Use this phone as the camera and microphone for Google Meet on your PC.</Text>

        {saved && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Last PC</Text>
            <Text style={styles.cardValue}>{saved.host}:{saved.port}</Text>
            <Button title="Connect" onPress={() => onPaired(saved)} style={styles.mt12} />
          </View>
        )}

        <Button title="Scan QR code" variant={saved ? 'secondary' : 'primary'} onPress={() => setMode('scan')} />
        {mode === 'manual' ? (
          <ManualForm saved={saved} onPaired={onPaired} />
        ) : (
          <Pressable onPress={() => setMode('manual')} style={styles.linkWrap}>
            <Text style={styles.link}>Enter address manually</Text>
          </Pressable>
        )}

        <View style={styles.steps}>
          <Text style={styles.stepsTitle}>Where's the QR code?</Text>
          <Text style={styles.step}>1. On your PC, double-click start.bat in the PhoneCam folder.</Text>
          <Text style={styles.step}>2. The QR code shows in that window, the PhoneCam browser page, and the Chrome extension.</Text>
          <Text style={styles.step}>3. Phone and PC must be on the same Wi-Fi.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Scanner({ onCancel, onPaired }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState('Point at the QR code on your PC');
  const done = useRef(false);

  if (!permission) return <View style={styles.flexBlack} />;
  if (!permission.granted) {
    return (
      <View style={[styles.page, styles.center]}>
        <Text style={styles.title}>Camera access</Text>
        <Text style={styles.subtitle}>PhoneCam needs the camera to scan the pairing code.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
        <Pressable onPress={onCancel} style={styles.linkWrap}><Text style={styles.link}>Back</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.flexBlack}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          const pairing = parsePairingUrl(data);
          if (pairing) {
            done.current = true;
            onPaired(pairing);
          } else {
            setHint('That isn\'t a PhoneCam code — scan the one on your PC');
          }
        }}
      />
      <View style={styles.scanOverlay} pointerEvents="box-none">
        <View style={styles.scanFrame} />
        <Text style={styles.scanHint}>{hint}</Text>
        <Button title="Cancel" variant="secondary" onPress={onCancel} style={styles.mt24} />
      </View>
    </View>
  );
}

function ManualForm({ saved, onPaired }) {
  const [host, setHost] = useState(saved?.host || '');
  const [port, setPort] = useState(String(saved?.port || 8080));
  const [key, setKey] = useState(saved?.key || '');
  const [error, setError] = useState('');

  const submit = () => {
    const pairing = validate({ host, port, key });
    if (!pairing) {
      setError('Check the address, port and key shown on your PC.');
      return;
    }
    onPaired(pairing);
  };

  return (
    <View style={styles.card}>
      <Field label="PC address" value={host} onChangeText={setHost} placeholder="192.168.1.20" keyboardType="numeric" />
      <Field label="Port" value={port} onChangeText={setPort} placeholder="8080" keyboardType="number-pad" />
      <Field label="Key" value={key} onChangeText={setKey} placeholder="from the PC screen" />
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Button title="Connect" onPress={submit} style={styles.mt12} />
    </View>
  );
}

function Field({ label, ...props }) {
  return (
    <View style={styles.field}>
      <Text style={styles.cardLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  flexBlack: { flex: 1, backgroundColor: '#000' },
  page: { flexGrow: 1, padding: 24, paddingTop: 48, gap: 14, backgroundColor: colors.bg },
  center: { justifyContent: 'center' },
  logo: { alignSelf: 'center', width: 84, height: 84, borderRadius: 22, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  logoBody: { width: 52, height: 36, borderRadius: 6, backgroundColor: colors.accentInk, alignItems: 'center', justifyContent: 'center' },
  logoLens: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: colors.muted, fontSize: 15, textAlign: 'center', marginBottom: 10, lineHeight: 21 },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 16 },
  cardLabel: { color: colors.muted, fontSize: 13, marginBottom: 4 },
  cardValue: { color: colors.text, fontSize: 18, fontWeight: '600' },
  mt12: { marginTop: 12 },
  mt24: { marginTop: 24 },
  linkWrap: { alignSelf: 'center', padding: 8 },
  link: { color: colors.muted, textDecorationLine: 'underline', fontSize: 15 },
  steps: { marginTop: 8, gap: 6 },
  stepsTitle: { color: colors.text, fontWeight: '600', fontSize: 15 },
  step: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  field: { marginBottom: 10 },
  input: { color: colors.text, backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  error: { color: colors.danger, marginTop: 4 },
  scanOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 24 },
  scanFrame: { width: 240, height: 240, borderRadius: 20, borderWidth: 3, borderColor: colors.accent },
  scanHint: { color: '#fff', marginTop: 20, fontSize: 16, textAlign: 'center', backgroundColor: colors.overlay, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, overflow: 'hidden' },
});
