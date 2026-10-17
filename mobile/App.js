import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import PairScreen from './src/screens/PairScreen';
import StreamScreen from './src/screens/StreamScreen';
import { loadPairing, parsePairingUrl, savePairing } from './src/pairing';

export default function App() {
  const [saved, setSaved] = useState(null);
  const [active, setActive] = useState(null); // pairing currently streaming to

  const connect = (pairing) => {
    savePairing(pairing);
    setSaved(pairing);
    setActive(pairing);
  };

  useEffect(() => {
    loadPairing().then(setSaved);
    // Scanning the QR code with the normal camera app opens PhoneCam via phonecam://pair?...
    Linking.getInitialURL().then((url) => {
      const p = parsePairingUrl(url);
      if (p) connect(p);
    });
    const sub = Linking.addEventListener('url', ({ url }) => {
      const p = parsePairingUrl(url);
      if (p) connect(p);
    });
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {active ? (
        <StreamScreen key={`${active.host}:${active.port}:${active.key}`} pairing={active} onExit={() => setActive(null)} />
      ) : (
        <PairScreen saved={saved} onPaired={connect} />
      )}
    </SafeAreaProvider>
  );
}
