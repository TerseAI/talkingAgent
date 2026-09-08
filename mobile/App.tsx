import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Button, KeyboardAvoidingView, Linking, Platform, PlatformColor, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createVoiceSession } from './src/native-runtime';

const color = {
  background: Platform.OS === 'ios' ? PlatformColor('systemGroupedBackground') : '#f2f5f2',
  surface: Platform.OS === 'ios' ? PlatformColor('secondarySystemGroupedBackground') : '#ffffff',
  text: Platform.OS === 'ios' ? PlatformColor('label') : '#172b20',
  secondary: Platform.OS === 'ios' ? PlatformColor('secondaryLabel') : '#59695f',
  separator: Platform.OS === 'ios' ? PlatformColor('separator') : '#c9d0ca',
  tint: Platform.OS === 'ios' ? PlatformColor('systemGreen') : '#267149',
  danger: Platform.OS === 'ios' ? PlatformColor('systemRed') : '#b33631',
};

function VoiceApp() {
  const [session] = useState(createVoiceSession);
  const voice = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [instance, setInstance] = useState(1);
  const [groupCounting, setGroupCounting] = useState(true);
  const [apiUrl, setApiUrl] = useState(process.env.EXPO_PUBLIC_API_URL || (Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000'));
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(Date.now());
  const transcriptRef = useRef<ScrollView>(null);
  const pinned = useRef(true);
  const active = voice.status === 'connected';
  const connecting = voice.status === 'connecting';
  const locked = active || connecting;
  const canSend = active && voice.activity === 'listening';

  useEffect(() => {
    const receiveUrl = (url: string | null) => {
      if (['connected', 'connecting'].includes(session.getSnapshot().status)) return;
      const match = url?.match(/^talkingagent:\/\/instance\/([123])(?:[/?#]|$)/);
      if (match) setInstance(Number(match[1]));
    };
    void Linking.getInitialURL().then(receiveUrl);
    const links = Linking.addEventListener('url', ({ url }) => receiveUrl(url));
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'background' && ['connected', 'connecting'].includes(session.getSnapshot().status)) session.stop();
    });
    return () => { links.remove(); appState.remove(); session.dispose(); };
  }, [session]);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const elapsed = voice.startedAt ? Math.max(0, Math.floor(((voice.endedAt ?? now) - voice.startedAt) / 1000)) : 0;
  const duration = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
  const status = connecting ? 'Connecting…' : active ? voice.activity === 'speaking' ? 'Speaking' : voice.activity === 'thinking' ? 'Thinking…' : voice.muted ? 'Microphone muted' : 'Listening' : voice.status === 'error' ? 'Connection failed' : voice.status === 'ended' ? 'Session ended' : 'Ready to connect';
  const start = () => {
    setDraft('');
    pinned.current = true;
    void session.start({ apiUrl, instance, mode: groupCounting ? 'group-counting' : 'assistant' });
  };

  return <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
    <StatusBar style="auto" />
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">Talking Agent</Text>
        <Text style={styles.subtitle}>Participant {instance} · independent session</Text>
        <View style={styles.group}>
          <View style={styles.row}><Text style={styles.body}>Participant</Text><View style={styles.participants}>{[1, 2, 3].map((number) => <View key={number} style={[styles.participant, instance === number && styles.selected]}><Button title={String(number)} accessibilityLabel={`Participant ${number}${instance === number ? ', selected' : ''}`} disabled={locked} color={color.tint} onPress={() => setInstance(number)} /></View>)}</View></View>
          <View style={[styles.row, styles.separator]}><Text style={styles.body}>Count to 10 as a group</Text><Switch accessibilityLabel="Count to 10 as a group" value={groupCounting} disabled={locked} onValueChange={setGroupCounting} /></View>
          <View style={[styles.serverRow, styles.separator]}><Text style={styles.caption}>Server address</Text><TextInput accessibilityLabel="Server address" style={styles.address} value={apiUrl} onChangeText={setApiUrl} editable={!locked} autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="done" /></View>
        </View>
        <Text style={styles.note}>{groupCounting ? 'Connect all three participants, then say “begin.” Each agent hears its own microphone and speaks one number at a time.' : 'Connect, allow your microphone, and speak naturally.'}</Text>
        <View style={styles.group}>
          <View style={styles.row}><View style={styles.statusRow}>{connecting && <ActivityIndicator />}<Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text></View><Text style={styles.duration}>{duration}</Text></View>
          {voice.error && <Text style={styles.error} accessibilityRole="alert">{voice.error}</Text>}
          <View style={[styles.action, styles.separator]}><Button title={connecting ? 'Cancel connection' : active ? 'End session' : 'Start session'} color={locked ? color.danger : color.tint} onPress={locked ? session.stop : start} /></View>
          {active && <><View style={[styles.row, styles.separator]}><Text style={styles.body}>Microphone</Text><Switch accessibilityLabel="Microphone" value={!voice.muted} onValueChange={session.toggleMute} /></View><View style={[styles.row, styles.separator]}><Text style={styles.body}>Speakerphone</Text><Switch accessibilityLabel="Speakerphone" value={voice.speaker} onValueChange={session.toggleSpeaker} /></View>{voice.activity !== 'listening' && <View style={[styles.action, styles.separator]}><Button title="Stop response" onPress={session.interrupt} color={color.tint} /></View>}</>}
        </View>
        <View style={styles.sectionHeader}><Text style={styles.heading} accessibilityRole="header">Transcript</Text><Button title="Share" disabled={!voice.transcript.length} color={color.tint} onPress={() => void Share.share({ message: voice.transcript.map((entry) => `${entry.role === 'assistant' ? `Participant ${instance}` : 'Heard'}: ${entry.text || '[No transcript]'}${entry.status === 'incomplete' ? ' [Interrupted]' : ''}`).join('\n\n') }).catch(() => {})} /></View>
        <ScrollView ref={transcriptRef} style={styles.transcript} contentContainerStyle={styles.transcriptContent} nestedScrollEnabled onContentSizeChange={() => { if (pinned.current) transcriptRef.current?.scrollToEnd({ animated: false }); }} onScroll={(event) => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; pinned.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 60; }} scrollEventThrottle={100}>
          {voice.transcript.length ? voice.transcript.map((entry) => <View key={entry.id} style={styles.message}><Text style={styles.messageLabel}>{entry.role === 'assistant' ? `Participant ${instance}` : 'Heard'}{entry.status === 'incomplete' ? ' · interrupted' : ''}</Text><Text selectable style={styles.body}>{entry.text || (entry.status === 'in_progress' ? 'Transcribing…' : 'No transcript available.')}</Text></View>) : <Text style={styles.empty}>What this participant hears and says will appear here.</Text>}
        </ScrollView>
        <View style={styles.composer}><TextInput accessibilityLabel="Message this participant" style={styles.input} value={draft} onChangeText={setDraft} editable={active} placeholder="Message this participant" placeholderTextColor={color.secondary} multiline maxLength={2000} /><Button title="Send" disabled={!canSend || !draft.trim()} color={color.tint} onPress={() => { session.send(draft); setDraft(''); pinned.current = true; }} /></View>
        <Text style={styles.note}>Each app connects separately. To hear the group, use a working microphone and speaker setup. Simulator audio input may be unavailable; physical devices are best for the voice experiment.</Text>
        <Text style={styles.note}>AI voice · gpt-realtime-2.1. Audio goes to OpenAI during a session. Ending a session releases the microphone.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

export default function App() { return <SafeAreaProvider><VoiceApp /></SafeAreaProvider>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.background }, flex: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 24, maxWidth: 680, width: '100%', alignSelf: 'center' },
  title: { fontSize: 34, fontWeight: '700', color: color.text, marginBottom: 5 },
  subtitle: { fontSize: 17, color: color.secondary, marginBottom: 24 },
  group: { backgroundColor: color.surface, borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingVertical: 8, flexWrap: 'wrap' },
  body: { fontSize: 17, lineHeight: 24, color: color.text, flexShrink: 1 },
  caption: { fontSize: 13, color: color.secondary },
  participants: { flexDirection: 'row', gap: 3 },
  participant: { minWidth: 44, minHeight: 44, justifyContent: 'center', borderRadius: 8 },
  selected: { backgroundColor: color.background },
  separator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.separator },
  serverRow: { paddingHorizontal: 16, paddingTop: 13, paddingBottom: 6 },
  address: { minHeight: 44, fontSize: 16, color: color.text, paddingVertical: 8 },
  note: { fontSize: 13, lineHeight: 19, color: color.secondary, marginTop: 10, marginBottom: 20, paddingHorizontal: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  status: { fontSize: 17, fontWeight: '600', color: color.text, flexShrink: 1 },
  duration: { fontSize: 15, fontVariant: ['tabular-nums'], color: color.secondary },
  action: { minHeight: 50, justifyContent: 'center' },
  error: { fontSize: 15, lineHeight: 22, color: color.danger, paddingHorizontal: 16, paddingBottom: 16 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24, marginBottom: 8 },
  heading: { fontSize: 22, fontWeight: '700', color: color.text },
  transcript: { maxHeight: 320, height: 240, backgroundColor: color.surface, borderRadius: 12 },
  transcriptContent: { padding: 16, flexGrow: 1 },
  empty: { fontSize: 17, lineHeight: 25, color: color.secondary, marginVertical: 'auto' },
  message: { marginBottom: 20 },
  messageLabel: { fontSize: 13, fontWeight: '600', color: color.secondary, marginBottom: 6 },
  composer: { marginTop: 10, borderRadius: 12, backgroundColor: color.surface, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, minHeight: 52, maxHeight: 120, paddingVertical: 14, fontSize: 17, color: color.text },
});
