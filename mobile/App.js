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
  const [pending, setPending] = useState(null); // pairing from a link, awaiting the user's OK

  const connect = (pairing) => {
    setPending(null);
    savePairing(pairing);
    setSaved(pairing);
    setActive(pairing);
  };

  useEffect(() => {
    loadPairing().then(setSaved);
    // Scanning the QR code with the normal camera app opens PhoneCam via
    // phonecam://pair?... Any website could contain such a link, so never start
    // the camera from a link by itself — ask first.
    const fromLink = (url) => {
      const p = parsePairingUrl(url);
      if (p) {
        setActive(null);
        setPending(p);
      }
    };
    Linking.getInitialURL().then(fromLink);
    const sub = Linking.addEventListener('url', ({ url }) => fromLink(url));
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {active ? (
        <StreamScreen key={`${active.host}:${active.port}:${active.key}`} pairing={active} onExit={() => setActive(null)} />
      ) : (
        <PairScreen saved={saved} pending={pending} onPaired={connect} onDismissPending={() => setPending(null)} />
      )}
    </SafeAreaProvider>
  );
}
